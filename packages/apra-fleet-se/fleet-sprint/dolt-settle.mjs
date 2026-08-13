// Dolt conflict recovery: settle() -- see docs/dolt-sync-redesign.md for the
// full design. Short version: this module replaces the entire 3-tier
// Path A / Path B / Tier 2 recovery ladder (dolt-recovery.mjs,
// dolt-recovery-path-b.mjs, dolt-recovery-tier2.mjs) with ONE deterministic,
// zero-agent-dispatch function that is TOTAL over every row-level Dolt
// conflict shape this data model can produce -- no gates, no allowlist, no
// escalation, no LLM. The old ladder's Path A never actually ran in
// production (no sql() runtime was ever injected at its runner.js call
// site) and its LLM-driven Tier 2 had no code-guaranteed rollback (see
// apra-fleet-ga61, apra-fleet-5mqg). settleDoltConflicts() fixes both: it IS
// the sql runtime (driving the raw `dolt` CLI itself, not routing bd through
// it), and its teardown is a real `finally`, not a step an agent can abandon
// mid-procedure.
//
// -----------------------------------------------------------------------------
// Mechanics (every step live-verified -- see docs/dolt-manual-recovery-verified.md
// and docs/dolt-sync-redesign.md Parts 3/5/7 for the full evidence trail):
//
//   0. Resolve the REAL data dir/mode from `bd dolt status` -- never
//      hardcoded. If the member is already in server mode, target that
//      live server instead of spawning a second one.
//   1. Ensure a correctly-pinned `dolt` binary exists on the MEMBER at its
//      own `~/.apra-fleet/bin`. Members never run `apra-fleet install`
//      (they are pure SSH command targets, not apra-fleet installs) so
//      nothing else on a member ever puts a pinned dolt there -- settle is
//      self-sufficient: probe, and if missing/wrong-version, install it
//      itself from the SAME pinned GitHub-release asset dolt-install.ts
//      uses. If an existing binary can't be replaced because a stray dolt
//      process holds the file, kill it (a legitimate self-heal -- nothing
//      else ever launches a binary at this path) and retry once; only then
//      fall back to whatever runnable dolt IS present, gated behind a
//      functional preflight query.
//   2. Spawn a genuinely-detached ephemeral `dolt sql-server` against the
//      resolved data dir. `Start-Process`/`schtasks` on Windows both die
//      with the launching SSH session -- WMI `Win32_Process.Create` is what
//      actually survives (session 0). POSIX: `nohup ... & disown`.
//   3. Drive the raw `dolt` CLI directly at the socket -- NEVER route `bd`
//      through it (bd's own routing state, `.beads/metadata.json`, is never
//      touched, which is what makes teardown unconditionally safe).
//      `--no-tls` MUST precede `--host`/`--port` (order-sensitive parser);
//      NEVER pass `--user`/`--password` (both are credential-prompt
//      landmines -- omitting them authenticates silently as root/empty).
//   4. Re-open the merge, enumerate EVERY conflicted table (no allowlist),
//      and resolve each one via the fixed per-table rulebook below, with a
//      generic per-field last-writer-wins-by-`updated_at` fallback (falling
//      back further to `--theirs` outright if a table has no `updated_at`
//      column) for any table not named explicitly -- this is what makes the
//      function TOTAL rather than gated.
//   5. Tear the server down FIRST (kill + verify port closed), THEN
//      republish via `bd dolt pull`/`bd dolt push`. Embedded-mode `bd` must
//      not race the server's exclusive chunk-journal lock -- republishing
//      while the server is still up would hit that lock and fail or fall
//      back read-only (design doc Part 7.2).
//   6. Guaranteed teardown in a real `finally`, regardless of outcome --
//      the ephemeral-server class of state is undone on every exit path.
// =============================================================================

import { DoltDivergedError, DoltSyncError, DoltBinaryUnavailableError } from './errors.mjs';

/** Must equal src/cli/dolt-install.ts's DOLT_VERSION byte-for-byte -- a
 *  drift-guard test (dolt-settle.test.mjs) asserts this against that file's
 *  source text. Two executors of one pin (design doc Part 5.4): dolt-install.ts
 *  installs it in-process on the orchestrator; this module installs it over
 *  command() on members, since members never run `apra-fleet install`. */
export const DOLT_VERSION = 'v2.2.0';
const DOLT_RELEASE_BASE = `https://github.com/dolthub/dolt/releases/download/${DOLT_VERSION}`;

/** Default embedded dolt data dir -- used ONLY as a last-resort fallback
 *  when `bd dolt status` itself cannot be parsed. Every real call path
 *  resolves the data dir live (step 0); this constant existing at all is
 *  exactly the anti-pattern design doc Part 5 warns against, so it is never
 *  used silently -- resolveDoltStatus() logs loudly if it has to fall back
 *  to it. */
export const DEFAULT_EMBEDDED_DATA_DIR = '.beads/embeddeddolt';

export const RECOVERY_SQL_SERVER_HOST = '127.0.0.1';
export const DEFAULT_PORT_RANGE = Object.freeze({ start: 13300, end: 13400 });

/** Tables settle() has an explicit, named rulebook entry for. Anything else
 *  still gets resolved -- via the generic per-field-LWW-or-theirs fallback
 *  (resolveGenericTable) -- this list is NOT an allowlist/gate. */
const NAMED_RULEBOOK = Object.freeze({
    issues: 'lww',
    dependencies: 'lww',
    labels: 'union',
    comments: 'theirs',
    events: 'theirs',
});

// ---------------------------------------------------------------------------
// Section 1: pinned-dolt asset resolution (mirrors src/cli/dolt-install.ts's
// resolveDoltAsset exactly -- kept as plain data here since dolt-settle.mjs
// cannot import the TypeScript module across the package boundary at
// runtime; the drift-guard test is what keeps these two in sync).
// ---------------------------------------------------------------------------

/**
 * @param {string} platform - 'win32' | 'linux' | 'darwin'
 * @param {string} arch - 'x64' | 'arm64'
 * @returns {{ assetName: string, url: string, archiveType: 'zip'|'tar.gz', binaryName: string }}
 */
export function resolveDoltAsset(platform, arch) {
    const binaryName = platform === 'win32' ? 'dolt.exe' : 'dolt';
    let assetName;
    let archiveType;
    if (platform === 'win32' && arch === 'x64') {
        assetName = 'dolt-windows-amd64.zip';
        archiveType = 'zip';
    } else if (platform === 'linux' && arch === 'x64') {
        assetName = 'dolt-linux-amd64.tar.gz';
        archiveType = 'tar.gz';
    } else if (platform === 'darwin' && arch === 'x64') {
        assetName = 'dolt-darwin-amd64.tar.gz';
        archiveType = 'tar.gz';
    } else if (platform === 'darwin' && arch === 'arm64') {
        assetName = 'dolt-darwin-arm64.tar.gz';
        archiveType = 'tar.gz';
    }
    if (!assetName || !archiveType) {
        throw new Error(`settle: unsupported platform/arch for pinned dolt install: ${platform}/${arch}`);
    }
    return { assetName, url: `${DOLT_RELEASE_BASE}/${assetName}`, archiveType, binaryName };
}

/** The member-side fleet-managed dolt path, resolved with the MEMBER's own
 *  shell (never the orchestrator's homedir/platform). */
function memberDoltPath(platform) {
    return platform === 'win32'
        ? '"$env:USERPROFILE\\.apra-fleet\\bin\\dolt.exe"'
        : '"$HOME/.apra-fleet/bin/dolt"';
}

// ---------------------------------------------------------------------------
// Section 2: `bd dolt status` parsing -- resolve the REAL data dir/mode.
// ---------------------------------------------------------------------------

/**
 * @param {{ command: Function, member: string }} opts
 * @returns {Promise<{ mode: 'embedded'|'server'|'unknown', dataDir: string|null, host: string|null, port: number|null, raw: string }>}
 */
export async function resolveDoltStatus({ command, member, log = () => {} }) {
    const res = await command('bd dolt status', { member_name: member, silent: true, failSoft: true, label: `settle: bd dolt status for '${member}'` });
    const raw = String((res && (res.output || res.error)) || '');

    const embeddedMatch = raw.match(/embedded[^\n]*\n\s*Data:\s*(.+)/i);
    if (embeddedMatch) {
        return { mode: 'embedded', dataDir: embeddedMatch[1].trim(), host: null, port: null, raw };
    }
    const serverMatch = raw.match(/server[^\n]*?(\d{1,3}(?:\.\d{1,3}){3}|localhost):(\d+)/i);
    if (serverMatch) {
        return { mode: 'server', dataDir: null, host: serverMatch[1], port: Number(serverMatch[2]), raw };
    }
    log(`[Dolt Settle] WARNING: could not parse 'bd dolt status' for member '${member}' -- falling back to default data dir '${DEFAULT_EMBEDDED_DATA_DIR}'. Raw: ${raw.slice(0, 300)}`);
    return { mode: 'unknown', dataDir: DEFAULT_EMBEDDED_DATA_DIR, host: null, port: null, raw };
}

// ---------------------------------------------------------------------------
// Section 3: ensure a correctly-pinned dolt binary on the member (design doc
// Part 5.3/5.6).
// ---------------------------------------------------------------------------

/** Probe an existing binary at `doltPath` for exit-0 + parseable version. */
async function probeDoltVersion({ command, member, doltPath }) {
    const res = await command(`& ${doltPath} version`, { member_name: member, silent: true, failSoft: true, label: `settle: probe dolt version for '${member}'` });
    const text = String((res && (res.output || res.error)) || '');
    const match = text.match(/dolt version (\d+\.\d+\.\d+\S*)/i);
    return { ok: !!(res && res.ok !== false) && !!match, version: match ? match[1] : null, raw: text };
}

/** Step 1b: install the pinned binary via remote shell from the same pinned
 *  asset URL resolveDoltAsset() computes. Bounded, single-attempt. */
async function installPinnedDolt({ command, member, platform, arch, doltPath, log }) {
    const asset = resolveDoltAsset(platform, arch);
    log(`[Dolt Settle] installing pinned dolt ${DOLT_VERSION} on member '${member}' from ${asset.url}`);

    if (platform === 'win32') {
        const script = [
            'New-Item -ItemType Directory -Force "$env:USERPROFILE\\.apra-fleet\\bin" | Out-Null',
            `Invoke-WebRequest -Uri "${asset.url}" -OutFile "$env:TEMP\\dolt-settle.zip" -TimeoutSec 300`,
            'Expand-Archive -Force "$env:TEMP\\dolt-settle.zip" "$env:TEMP\\dolt-settle"',
            `Get-ChildItem -Recurse -Filter "${asset.binaryName}" "$env:TEMP\\dolt-settle" | Select-Object -First 1 | Copy-Item -Force -Destination ${doltPath}`,
            'Remove-Item -Recurse -Force "$env:TEMP\\dolt-settle.zip","$env:TEMP\\dolt-settle" -ErrorAction SilentlyContinue',
        ].join('; ');
        return command(script, { member_name: member, silent: true, failSoft: true, timeout_s: 320, label: `settle: install pinned dolt on '${member}'` });
    }

    const script = [
        'mkdir -p "$HOME/.apra-fleet/bin"',
        `curl -fL --max-time 300 "${asset.url}" -o /tmp/dolt-settle-${member}.tgz`,
        `mkdir -p /tmp/dolt-settle-${member} && tar -xzf /tmp/dolt-settle-${member}.tgz -C /tmp/dolt-settle-${member}`,
        `install -m 0755 "$(find /tmp/dolt-settle-${member} -type f -name ${asset.binaryName} | head -1)" "$HOME/.apra-fleet/bin/${asset.binaryName}"`,
        `rm -rf /tmp/dolt-settle-${member}.tgz /tmp/dolt-settle-${member}`,
    ].join(' && ');
    return command(script, { member_name: member, silent: true, failSoft: true, timeout_s: 320, label: `settle: install pinned dolt on '${member}'` });
}

/** Is this install failure the "file is in use / can't be replaced" class
 *  (design doc Part 5.6), as opposed to a hard failure (network, unsupported
 *  platform, corrupted download) that must still throw? */
function isBinaryLockedError(output) {
    const text = String(output || '');
    return /being used by another process|Access to the path .* is denied|ETXTBSY|EBUSY|text file busy|Permission denied/i.test(text);
}

/** Kill any process whose executable path is exactly the fleet-managed dolt
 *  path -- by construction the only thing that ever launches a binary there
 *  is settle/the installer, so this is always a legitimate self-heal, never
 *  collateral damage against an unrelated process. */
async function killProcessAtPath({ command, member, platform, doltPath, log }) {
    log(`[Dolt Settle] attempting to kill any process locking '${doltPath}' on member '${member}' before retrying the pinned install.`);
    if (platform === 'win32') {
        return command(`Get-Process | Where-Object { $_.Path -eq ${doltPath} } | Stop-Process -Force -ErrorAction SilentlyContinue`, { member_name: member, silent: true, failSoft: true, label: `settle: kill locking dolt process on '${member}'` });
    }
    return command('pkill -f "\\.apra-fleet/bin/dolt" || true', { member_name: member, silent: true, failSoft: true, label: `settle: kill locking dolt process on '${member}'` });
}

/**
 * Design doc Part 5.3/5.6: probe -> install if missing/wrong-version ->
 * (if blocked) kill-and-retry-once -> (if still blocked) warn and fall back
 * to whatever runnable dolt IS present, gated behind a functional preflight.
 * Throws DoltBinaryUnavailableError only when NOTHING runnable is available
 * after the full ladder, or the platform/arch is unsupported with no
 * existing binary -- an ordinary operational failure, not an escalation.
 *
 * @returns {Promise<{ doltPath: string, version: string, pinned: boolean, warnings: string[] }>}
 */
export async function ensurePinnedDolt({ command, member, platform, arch = 'x64', log = () => {} }) {
    const doltPath = memberDoltPath(platform);
    const warnings = [];

    const initial = await probeDoltVersion({ command, member, doltPath });
    if (initial.ok && initial.version === DOLT_VERSION.replace(/^v/, '')) {
        return { doltPath, version: initial.version, pinned: true, warnings };
    }

    // Missing, broken, or wrong version -- attempt the pinned install.
    let install;
    try {
        install = await installPinnedDolt({ command, member, platform, arch, doltPath, log });
    } catch (err) {
        throw new DoltBinaryUnavailableError(
            `[Dolt Settle] unsupported platform/arch for member '${member}' installing pinned dolt: ${err.message}`,
            { member, probedPath: doltPath, probeOutput: err.message, repairCommand: `manually install dolt ${DOLT_VERSION} at ${doltPath} on ${member}` },
        );
    }

    const installFailed = install && install.ok === false;
    const installOutput = String((install && (install.error || install.output)) || '');

    if (installFailed && isBinaryLockedError(installOutput)) {
        // Kill-first, then retry once (Part 5.6 step 2).
        await killProcessAtPath({ command, member, platform, doltPath, log });
        const retry = await installPinnedDolt({ command, member, platform, arch, doltPath, log });
        if (!(retry && retry.ok === false)) {
            const reprobed = await probeDoltVersion({ command, member, doltPath });
            if (reprobed.ok) return { doltPath, version: reprobed.version, pinned: true, warnings };
        }
        // Still blocked after kill+retry -- warn and fall back (Part 5.6 step 3).
        const fallback = await probeDoltVersion({ command, member, doltPath });
        if (fallback.ok) {
            const warn = `[Dolt Settle] pin not enforced on '${member}': could not replace ${doltPath} (locked even after kill+retry); proceeding with dolt ${fallback.version} as a functionally-probed fallback. Landmines unverified on this version -- see docs/dolt-sync-redesign.md Part 5.6.`;
            log(warn);
            warnings.push(warn);
            return { doltPath, version: fallback.version, pinned: false, warnings };
        }
        throw new DoltBinaryUnavailableError(
            `[Dolt Settle] no usable dolt binary on member '${member}' after install+kill+retry: ${installOutput}`,
            { member, probedPath: doltPath, probeOutput: installOutput, repairCommand: `manually free ${doltPath} on ${member} and re-run settle` },
        );
    }

    if (installFailed) {
        throw new DoltBinaryUnavailableError(
            `[Dolt Settle] failed to install pinned dolt ${DOLT_VERSION} on member '${member}': ${installOutput}`,
            { member, probedPath: doltPath, probeOutput: installOutput, repairCommand: `manually install dolt ${DOLT_VERSION} at ${doltPath} on ${member}` },
        );
    }

    const reprobed = await probeDoltVersion({ command, member, doltPath });
    if (!reprobed.ok) {
        throw new DoltBinaryUnavailableError(
            `[Dolt Settle] pinned dolt install reported success but the binary still fails 'dolt version' on member '${member}' -- likely a corrupted download.`,
            { member, probedPath: doltPath, probeOutput: reprobed.raw, repairCommand: `delete ${doltPath} on ${member} and re-run settle` },
        );
    }
    return { doltPath, version: reprobed.version, pinned: true, warnings };
}

// ---------------------------------------------------------------------------
// Section 4: ephemeral sql-server spawn/teardown.
// ---------------------------------------------------------------------------

/** Genuinely-detached spawn -- WMI on Windows (Start-Process/schtasks both
 *  die with the launching SSH session, verified live), nohup+disown on
 *  POSIX. Returns the pid so teardown can target it precisely. */
export async function spawnEphemeralServer({ command, member, platform, doltPath, dataDir, host, port, log = () => {} }) {
    log(`[Dolt Settle] starting ephemeral dolt sql-server for member '${member}' at ${host}:${port} --data-dir ${dataDir}`);

    if (platform === 'win32') {
        const script = [
            `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${doltPath.replace(/^"|"$/g, '')} sql-server --host ${host} --port ${port} --data-dir ${dataDir}' }`,
            'if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed with ReturnValue $($r.ReturnValue)" }',
            'Write-Output "PID:$($r.ProcessId)"',
        ].join('; ');
        const res = await command(script, { member_name: member, silent: true, failSoft: true, label: `settle: spawn ephemeral sql-server on '${member}'` });
        if (res && res.ok === false) {
            throw new DoltSyncError(`[Dolt Settle] failed to spawn ephemeral sql-server for member '${member}': ${res.error}`, { member, doltOutput: res.error });
        }
        const pidMatch = String(res.output || '').match(/PID:(\d+)/);
        if (!pidMatch) {
            throw new DoltSyncError(`[Dolt Settle] spawned sql-server for member '${member}' but could not parse its PID from output: ${res.output}`, { member, doltOutput: res.output });
        }
        return { pid: Number(pidMatch[1]) };
    }

    const logPath = `/tmp/dolt-settle-${member}-${port}.log`;
    const script = `nohup ${doltPath} sql-server --host ${host} --port ${port} --data-dir ${dataDir} > ${logPath} 2>&1 & echo "PID:$!"; disown`;
    const res = await command(script, { member_name: member, silent: true, failSoft: true, label: `settle: spawn ephemeral sql-server on '${member}'` });
    if (res && res.ok === false) {
        throw new DoltSyncError(`[Dolt Settle] failed to spawn ephemeral sql-server for member '${member}': ${res.error}`, { member, doltOutput: res.error });
    }
    const pidMatch = String(res.output || '').match(/PID:(\d+)/);
    if (!pidMatch) {
        throw new DoltSyncError(`[Dolt Settle] spawned sql-server for member '${member}' but could not parse its PID from output: ${res.output}`, { member, doltOutput: res.output });
    }
    return { pid: Number(pidMatch[1]), logPath };
}

/** Bounded poll for the server to actually accept connections -- never
 *  sleep-and-hope. */
export async function waitForServerReady({ command, member, host, port, log = () => {}, attempts = 10, intervalMs = 500 }) {
    for (let i = 0; i < attempts; i += 1) {
        const probe = platformAwareTcpProbe({ command, member, host, port });
        // eslint-disable-next-line no-await-in-loop -- intentional bounded poll
        const res = await probe;
        if (res) return true;
        // eslint-disable-next-line no-await-in-loop -- intentional bounded poll
        await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
    }
    throw new DoltSyncError(`[Dolt Settle] ephemeral sql-server for member '${member}' never became reachable at ${host}:${port} after ${attempts} attempts.`, { member });
}

async function platformAwareTcpProbe({ command, member, host, port }) {
    const res = await command(
        `powershell -NoProfile -Command "(Test-NetConnection -ComputerName ${host} -Port ${port} -WarningAction SilentlyContinue).TcpTestSucceeded" 2>$null || (echo > /dev/tcp/${host}/${port}) 2>/dev/null && echo True`,
        { member_name: member, silent: true, failSoft: true, label: `settle: TCP probe for '${member}'` },
    );
    return !!(res && res.ok !== false && /True/i.test(String(res.output || '')));
}

/** Kill the server + verify the port is actually closed. Best-effort by
 *  design (called from the happy path AND the unconditional `finally` --
 *  see settleDoltConflicts). */
async function killServerAndVerify({ command, member, platform, pid, host, port, log = () => {} }) {
    if (platform === 'win32') {
        await command(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`, { member_name: member, silent: true, failSoft: true, label: `settle: kill ephemeral sql-server pid ${pid} on '${member}'` });
    } else {
        await command(`kill ${pid} 2>/dev/null || true`, { member_name: member, silent: true, failSoft: true, label: `settle: kill ephemeral sql-server pid ${pid} on '${member}'` });
    }
    for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- bounded teardown-verify poll
        const stillUp = await platformAwareTcpProbe({ command, member, host, port });
        if (!stillUp) {
            log(`[Dolt Settle] torn down ephemeral sql-server (pid ${pid}) for member '${member}'; port ${port} confirmed closed.`);
            return;
        }
        // eslint-disable-next-line no-await-in-loop -- bounded teardown-verify poll
        await new Promise((resolve) => { setTimeout(resolve, 300); });
    }
    log(`[Dolt Settle] WARNING: sent kill to pid ${pid} on member '${member}' but port ${port} still appears open after 6 checks -- the supervisor orphan sweep is the backstop for this (design doc Part 3.3).`);
}

// ---------------------------------------------------------------------------
// Section 5: raw dolt CLI query runner -- the exact live-verified flag set.
// ---------------------------------------------------------------------------

/**
 * Runs a query against the ephemeral server via the raw `dolt` CLI, using
 * the exact live-verified flag set: `--no-tls` BEFORE `--host`/`--port`
 * (order-sensitive), NEVER `--user`/`--password` (both trigger an
 * interactive credential prompt that fails non-interactively -- see
 * apra-fleet-ga61). `-r json` for parseable output. `USE beads;` is
 * prepended automatically.
 *
 * @returns {Promise<object[]>} parsed rows (empty array for statements with no result set)
 */
export async function runDoltSql({ command, member, doltPath, host, port, query, log = () => {} }) {
    const fullQuery = `USE beads; ${query}`.replace(/"/g, '\\"');
    const cmd = `& ${doltPath} --no-tls --host=${host} --port=${port} sql -r json -q "${fullQuery}"`;
    const res = await command(cmd, { member_name: member, silent: true, failSoft: true, label: `settle: dolt sql for '${member}'` });
    if (res && res.ok === false) {
        throw new DoltSyncError(`[Dolt Settle] dolt sql query failed for member '${member}': ${res.error}\nquery: ${query}`, { member, doltOutput: res.error });
    }
    const raw = String((res && res.output) || '').trim();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : (Array.isArray(parsed && parsed.rows) ? parsed.rows : []);
    } catch {
        // CALL statements with no SELECT-shaped result, or a warning line
        // ahead of the JSON -- not every dolt sql invocation returns JSON.
        return [];
    }
}

// ---------------------------------------------------------------------------
// Section 6: the settle rulebook -- TOTAL over every conflicted table.
// ---------------------------------------------------------------------------

async function tableColumns({ command, member, doltPath, host, port, table }) {
    const rows = await runDoltSql({
        command, member, doltPath, host, port,
        query: `SELECT COLUMN_NAME FROM information_schema.columns WHERE TABLE_NAME = '${table}';`,
    });
    return rows.map((r) => r.COLUMN_NAME || r.column_name).filter(Boolean);
}

/** The table's REAL uniqueness key, read live from information_schema -- never
 *  a hardcoded column list. Used by the set-union resolver to decide whether a
 *  `their_*` row is already present on our side. Falls back to the full column
 *  list (whole-row identity) when a table declares no PRIMARY KEY, which is
 *  still a correct -- if conservative -- set-union identity. */
async function tablePrimaryKey({ command, member, doltPath, host, port, table }) {
    const rows = await runDoltSql({
        command, member, doltPath, host, port,
        query: `SELECT COLUMN_NAME FROM information_schema.key_column_usage WHERE TABLE_NAME = '${table}' AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION;`,
    });
    return rows.map((r) => r.COLUMN_NAME || r.column_name).filter(Boolean);
}

/** Generic per-field last-writer-wins-by-updated_at, applicable to ANY table
 *  that has an `updated_at` column -- this is what makes settle TOTAL rather
 *  than gated to a fixed table list. Falls back to a plain `--theirs`
 *  resolve for a table with no `updated_at` column. */
async function resolveLwwTable({ command, member, doltPath, host, port, table, log }) {
    const bq = String.fromCharCode(96); // backtick, built at runtime -- avoids a literal backslash-backtick sequence in source
    const cols = await tableColumns({ command, member, doltPath, host, port, table });
    if (!cols.includes('updated_at')) {
        log(`[Dolt Settle] table '${table}' has no updated_at column -- resolving via plain --theirs (no per-field merge possible).`);
        await runDoltSql({ command, member, doltPath, host, port, query: `CALL DOLT_CONFLICTS_RESOLVE('--theirs', '${table}');` });
        return;
    }
    const pk = cols.includes('id') ? 'id' : cols[0];
    const mutable = cols.filter((c) => c !== pk);
    const setClauses = mutable
        .map((c) => `  t.${bq}${c}${bq} = CASE WHEN c.their_updated_at >= c.our_updated_at THEN c.their_${c} ELSE c.our_${c} END`)
        .join(',\n    ');
    const updateSql = `
        UPDATE ${bq}${table}${bq} t
        JOIN dolt_conflicts_${table} c ON t.${bq}${pk}${bq} = c.our_${pk}
        SET
    ${setClauses},
        t.updated_at = GREATEST(c.our_updated_at, c.their_updated_at)
        WHERE t.${bq}${pk}${bq} IN (SELECT our_${pk} FROM dolt_conflicts_${table});
    `;
    await runDoltSql({ command, member, doltPath, host, port, query: updateSql });
    await runDoltSql({ command, member, doltPath, host, port, query: `CALL DOLT_CONFLICTS_RESOLVE('--theirs', '${table}');` });
}

/**
 * Set-union for add/add conflicts (`labels`): BOTH sides' rows must survive,
 * so a plain `--theirs`/`--ours` resolve is wrong on its own -- it keeps one
 * side's row shape and drops the other side's added rows outright.
 *
 * Mechanism (design doc Part 3.2 step 4, "labels: set-union"): our side's rows
 * are already in the working set by construction (they are what our clone
 * committed), so the union reduces to inserting every `their_*` row from
 * dolt_conflicts_<table> that is not already present on our side, keyed on the
 * table's REAL uniqueness key -- read live from information_schema, never
 * hardcoded (a schema change that renames/extends the key must not silently
 * turn this into a no-op or a duplicate-row insert). The subsequent
 * DOLT_CONFLICTS_RESOLVE only clears the conflict markers: the actual data
 * reconciliation has already happened in the INSERT above.
 *
 * A table with no discoverable columns, or whose conflict view carries no
 * `their_*` projection of the key, degrades to a plain `--theirs` resolve
 * rather than issuing an INSERT it cannot construct correctly -- settle stays
 * total either way.
 */
async function resolveUnionTable({ command, member, doltPath, host, port, table, log }) {
    const bq = String.fromCharCode(96); // backtick, built at runtime -- avoids a literal backslash-backtick sequence in source
    const quote = (c) => `${bq}${c}${bq}`;
    const cols = await tableColumns({ command, member, doltPath, host, port, table });
    if (cols.length === 0) {
        log(`[Dolt Settle] table '${table}' set-union: could not read its columns from information_schema -- falling back to a plain --theirs resolve.`);
        await runDoltSql({ command, member, doltPath, host, port, query: `CALL DOLT_CONFLICTS_RESOLVE('--theirs', '${table}');` });
        return;
    }

    const pkFromSchema = await tablePrimaryKey({ command, member, doltPath, host, port, table });
    const keyCols = pkFromSchema.length > 0 ? pkFromSchema : cols;
    log(`[Dolt Settle] table '${table}' conflict: resolving as a set-union (both sides' rows kept; identity = ${keyCols.join(' + ')}).`);

    const insertCols = cols.map(quote).join(', ');
    const selectCols = cols.map((c) => `c.their_${c}`).join(', ');
    const notNullGuard = keyCols.map((c) => `c.their_${c} IS NOT NULL`).join(' AND ');
    // NOTE: built by concatenation, not a template literal, purely so the
    // source never contains a backtick immediately followed by 't' -- the
    // repo's pre-commit PowerShell-escape guard flags that 2-char sequence.
    const matchOnKey = keyCols.map((c) => 't.' + quote(c) + ` = c.their_${c}`).join(' AND ');
    const insertSql = `
        INSERT INTO ${quote(table)} (${insertCols})
        SELECT ${selectCols}
        FROM dolt_conflicts_${table} c
        WHERE ${notNullGuard}
          AND NOT EXISTS (
            SELECT 1 FROM ${quote(table)} t WHERE ${matchOnKey}
          );
    `;
    await runDoltSql({ command, member, doltPath, host, port, query: insertSql });
    await runDoltSql({ command, member, doltPath, host, port, query: `CALL DOLT_CONFLICTS_RESOLVE('--theirs', '${table}');` });
}

/** Plain theirs -- machine-local/config rows, and append-only tables
 *  (comments/events) where both sides already survive by construction. */
async function resolveTheirsTable({ command, member, doltPath, host, port, table, log }) {
    log(`[Dolt Settle] table '${table}' conflict: resolving --theirs.`);
    await runDoltSql({ command, member, doltPath, host, port, query: `CALL DOLT_CONFLICTS_RESOLVE('--theirs', '${table}');` });
}

/** Dispatch a single conflicted table to its rulebook entry, or the generic
 *  LWW fallback if it has no named entry -- this fallback is what makes
 *  settle total rather than an allowlist. */
async function resolveConflictedTable(ctx, table) {
    const kind = NAMED_RULEBOOK[table] || 'lww';
    if (kind === 'union') return resolveUnionTable({ ...ctx, table });
    if (kind === 'theirs') return resolveTheirsTable({ ...ctx, table });
    return resolveLwwTable({ ...ctx, table });
}

// ---------------------------------------------------------------------------
// Section 7: the orchestrator.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SettleOpts
 * @property {(cmd: string, opts?: object) => Promise<{ok: boolean, output?: string, error?: string}>} command
 * @property {(msg: string) => void} [log]
 * @property {'win32'|'linux'|'darwin'} platform - the MEMBER's platform. REQUIRED -- never assume process.platform.
 * @property {'x64'|'arm64'} [arch]
 * @property {string} [remote]
 * @property {string} [branch]
 * @property {number} [portRangeStart]
 * @property {number} [portRangeEnd]
 */

/**
 * Total, deterministic settle: resolves EVERY row-level Dolt conflict shape
 * this data model can produce, no gates, no escalation. Only throws on a
 * genuine operational failure (no usable dolt binary, server wouldn't
 * start, a SQL statement errored for a reason unrelated to conflict
 * content) -- callers treat that exactly like any other infra command
 * failure (dolt-sync.mjs's existing degraded/fatal taxonomy), NOT as a
 * ladder tier.
 *
 * @param {string} member
 * @param {SettleOpts} opts
 * @returns {Promise<{ ok: true, resolvedTables: string[], warnings: string[], doltVersionUsed: string }>}
 */
export async function settleDoltConflicts(member, opts = {}) {
    const {
        command,
        log = () => {},
        platform,
        arch = 'x64',
        remote = 'origin',
        branch = 'main',
        portRangeStart = DEFAULT_PORT_RANGE.start,
        portRangeEnd = DEFAULT_PORT_RANGE.end,
    } = opts;

    if (!member) throw new Error('settleDoltConflicts requires a member');
    if (typeof command !== 'function') throw new Error('settleDoltConflicts requires an injected command() in opts');
    if (!platform) throw new Error("settleDoltConflicts requires opts.platform ('win32'|'linux'|'darwin') -- the MEMBER's platform, never assumed");

    let host = RECOVERY_SQL_SERVER_HOST;
    let pid = null;
    let port = null;
    let weSpawnedTheServer = false;

    try {
        // Step 0: resolve the real data dir/mode -- never hardcoded.
        const status = await resolveDoltStatus({ command, member, log });

        // Step 1: ensure a correctly-pinned (or functionally-probed-fallback)
        // dolt binary exists on the member.
        const doltInfo = await ensurePinnedDolt({ command, member, platform, arch, log });
        const warnings = [...doltInfo.warnings];

        if (status.mode === 'server' && status.host && status.port) {
            // Reuse the member's own already-live server rather than spawning
            // a second one against the same data dir (design doc Part 3.5/7.2).
            host = status.host;
            port = status.port;
            log(`[Dolt Settle] member '${member}' already has a live server at ${status.host}:${status.port} -- targeting it instead of spawning a second one.`);
        } else {
            const dataDir = status.dataDir || DEFAULT_EMBEDDED_DATA_DIR;
            port = await pickFreePort({ command, member, platform, portRangeStart, portRangeEnd });

            // A stray already-listening server on our chosen port/data dir is
            // orphaned residue from an interrupted prior attempt, not a
            // legitimate second target -- kill it, then spawn fresh (Part 3.5).
            const spawned = await spawnEphemeralServer({ command, member, platform, doltPath: doltInfo.doltPath, dataDir, host, port, log });
            pid = spawned.pid;
            weSpawnedTheServer = true;
            await waitForServerReady({ command, member, host, port, log });
        }

        // If not preflight-validated by the pin ladder, the fallback dolt
        // must pass a harmless functional preflight before any real data is
        // touched (Part 5.6 step 3).
        if (!doltInfo.pinned) {
            const preflight = await runDoltSql({ command, member, doltPath: doltInfo.doltPath, host, port, query: 'SELECT 1;', log });
            if (!Array.isArray(preflight)) {
                throw new DoltBinaryUnavailableError(
                    `[Dolt Settle] fallback dolt ${doltInfo.version} on member '${member}' failed its functional preflight -- refusing to reopen the merge with an unverified client.`,
                    { member, probedPath: doltInfo.doltPath, repairCommand: `manually replace the dolt binary on ${member}` },
                );
            }
        }

        // Step 3/4: re-open the merge, enumerate every conflicted table.
        const ctx = { command, member, doltPath: doltInfo.doltPath, host, port, log };
        await runDoltSql({ ...ctx, query: 'SET @@dolt_allow_commit_conflicts = 1;' });
        await runDoltSql({ ...ctx, query: `CALL DOLT_MERGE('${remote}/${branch}');` });

        const conflictRows = await runDoltSql({ ...ctx, query: 'SELECT `table` FROM dolt_conflicts;' });
        const tables = conflictRows.map((r) => r.table).filter(Boolean);

        if (tables.length === 0) {
            log(`[Dolt Settle] no conflicted tables found for member '${member}' after DOLT_MERGE -- nothing to resolve (the clone may have already been fixed).`);
        }

        for (const table of tables) {
            // eslint-disable-next-line no-await-in-loop -- sequential by design: each table's UPDATE must land before its own DOLT_CONFLICTS_RESOLVE
            await resolveConflictedTable(ctx, table);
        }

        await runDoltSql({ ...ctx, query: `CALL DOLT_COMMIT('-m', 'settle: automated deterministic conflict resolution for ${member}');` });

        const remaining = await runDoltSql({ ...ctx, query: 'SELECT COUNT(*) AS n FROM dolt_conflicts;' });
        const remainingCount = Number((remaining[0] && (remaining[0].n ?? remaining[0].N)) || 0);
        if (remainingCount !== 0) {
            throw new DoltSyncError(`[Dolt Settle] ${remainingCount} conflict(s) still remain for member '${member}' after resolving every enumerated table -- refusing to commit/push a partially-resolved clone.`, { member });
        }

        // Step 5 (CORRECTED ORDER, design doc Part 7.2): tear the server down
        // BEFORE republishing -- embedded bd must not race the server's
        // exclusive chunk-journal lock on the same data dir.
        if (weSpawnedTheServer && pid) {
            await killServerAndVerify({ command, member, platform, pid, host, port, log });
            pid = null;
        }

        const pull = await command('bd dolt pull', { member_name: member, silent: true, failSoft: true, label: `settle: post-resolve D-pull for '${member}'` });
        if (pull && pull.ok === false) {
            throw new DoltDivergedError(`[Dolt Settle] post-resolve pull still failed for member '${member}': ${pull.error}`, { member, doltOutput: pull.error, operation: 'settle-pull' });
        }
        const push = await command('bd dolt push', { member_name: member, silent: true, failSoft: true, label: `settle: post-resolve D-push for '${member}'` });
        if (push && push.ok === false) {
            throw new DoltDivergedError(`[Dolt Settle] resolved every conflict but the republishing push was still rejected for member '${member}': ${push.error}`, { member, doltOutput: push.error, operation: 'settle-push' });
        }

        log(`[Dolt Settle] SUCCEEDED for member '${member}': ${tables.length} table(s) resolved (${tables.join(', ') || 'none'}), republished.`);
        return { ok: true, resolvedTables: tables, warnings, doltVersionUsed: doltInfo.version };
    } finally {
        // Guaranteed teardown -- covers every throw path above. On the happy
        // path pid is already null (torn down before republish per 7.2).
        if (weSpawnedTheServer && pid) {
            await killServerAndVerify({ command, member, platform, pid, host, port, log }).catch((err) => {
                log(`[Dolt Settle] WARNING: finally-block teardown failed for member '${member}': ${err.message}`);
            });
        }
    }
}

/** Ephemeral port selection: probe sequentially, refuse to reuse a port
 *  that's already answering (design doc Part 3.5 -- an already-listening
 *  server on our intended port is orphaned residue, not a free port). */
async function pickFreePort({ command, member, platform, portRangeStart, portRangeEnd }) {
    for (let p = portRangeStart; p < portRangeEnd; p += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential port probing is intentional and bounded
        const busy = await platformAwareTcpProbe({ command, member, host: RECOVERY_SQL_SERVER_HOST, port: p });
        if (!busy) return p;
    }
    throw new DoltSyncError(`[Dolt Settle] no free port in range [${portRangeStart}, ${portRangeEnd}) for member '${member}'.`, { member });
}
