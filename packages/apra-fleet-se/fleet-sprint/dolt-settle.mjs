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
// Section 1b: shell dialect. Every command below is dispatched into the
// MEMBER's own shell -- PowerShell (5.1, so no `&&`/`||`) on Windows, bash on
// POSIX -- and the two disagree about things settle depends on. All of this
// was found by running settle against real members, not by reading docs:
//
//   - Invoking a quoted absolute path needs PowerShell's call operator
//     (`& "..."`); a leading `&` in bash is a syntax error outright.
//   - Inside a double-quoted string, bash treats a backtick as command
//     substitution while PowerShell treats it as its escape character, so a
//     SQL identifier quote must be escaped differently for each (and SQL that
//     can avoid backticks entirely simply does).
//   - `cmd 2>$null || fallback` parses in bash but is a hard parse ERROR in
//     PowerShell 5.1, so no single "works everywhere" probe string exists.
// ---------------------------------------------------------------------------

/** Invoke an executable at a quoted path with arguments, in the member's shell. */
function invokeBinary(platform, quotedPath, args) {
    return platform === 'win32' ? `& ${quotedPath} ${args}` : `${quotedPath} ${args}`;
}

/**
 * Escape a SQL string so it survives as ONE double-quoted argument in the
 * member's shell. Backticks and `$` are the dangerous characters in both
 * dialects, for opposite reasons.
 */
export function escapeSqlForShell(platform, sql) {
    const bq = String.fromCharCode(96);
    if (platform === 'win32') {
        // PowerShell: ` escapes; a literal backtick is a doubled backtick, a
        // literal quote is `" and a literal $ is `$.
        return String(sql)
            .split(bq).join(bq + bq)
            .replace(/\$/g, `${bq}$`)
            .replace(/"/g, `${bq}"`);
    }
    // bash: backslash escapes inside double quotes.
    return String(sql)
        .replace(/\\/g, '\\\\')
        .split(bq).join('\\' + bq)
        .replace(/\$/g, '\\$')
        .replace(/"/g, '\\"');
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
async function probeDoltVersion({ command, member, doltPath, platform }) {
    const res = await command(invokeBinary(platform, doltPath, 'version'), { member_name: member, silent: true, failSoft: true, label: `settle: probe dolt version for '${member}'` });
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

    const initial = await probeDoltVersion({ command, member, doltPath, platform });
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
            const reprobed = await probeDoltVersion({ command, member, doltPath, platform });
            if (reprobed.ok) return { doltPath, version: reprobed.version, pinned: true, warnings };
        }
        // Still blocked after kill+retry -- warn and fall back (Part 5.6 step 3).
        const fallback = await probeDoltVersion({ command, member, doltPath, platform });
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

    const reprobed = await probeDoltVersion({ command, member, doltPath, platform });
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
        // The command line is assembled in PowerShell, from a DOUBLE-quoted
        // $exe, so `$env:USERPROFILE` actually expands: passing the raw
        // '$env:USERPROFILE\...' text inside WMI's single-quoted argument
        // makes Win32_Process.Create fail with ReturnValue 9 / "path not
        // found" (verified live on fleet-win-dev1). Paths are quoted inside
        // the command line so a space in either survives.
        const script = [
            `$exe = ${doltPath}`,
            `$cl = '"' + $exe + '" sql-server --host ${host} --port ${port} --data-dir ' + '"${dataDir}"'`,
            '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cl }',
            'if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create failed with ReturnValue $($r.ReturnValue) for command line: $cl" }',
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

    // POSIX detachment, every piece of it verified live on fleet-lin-dev1
    // because the obvious form does NOT work under the fleet's own bash
    // wrapper (which backgrounds the command and `wait`s on it):
    //   - `( ... & )` -- a SUBSHELL the dispatching shell never waits on.
    //     A plain `nohup ... & echo PID; disown` left the dispatch hanging
    //     until its 300s inactivity timeout while the server was actually up
    //     and holding the data dir lock: a "spawn failure" that silently
    //     leaves a live orphan behind.
    //   - `setsid` -- own session, so it outlives the SSH session.
    //   - `< /dev/null` -- otherwise the server inherits the dispatch's stdin
    //     and the SSH channel never closes.
    //   - the pid comes from `pgrep` on the port, not `$!`: `$!` belongs to
    //     the subshell, not to the server we must be able to kill.
    const logPath = `/tmp/dolt-settle-${member}-${port}.log`;
    const matcher = `sql-server --host ${host} --port ${port}`;
    // `setsid` does NOT exist on macOS (verified live on fleet-mac: the spawn
    // silently produced no pid), so it is resolved at runtime and simply
    // omitted where absent -- `nohup` inside the detached subshell is what
    // actually keeps the server alive there.
    const script = `SETSID=$(command -v setsid || true); ( $SETSID nohup ${doltPath} sql-server --host ${host} --port ${port} --data-dir ${dataDir} > ${logPath} 2>&1 < /dev/null & ) ; sleep 1; echo "PID:$(pgrep -f '${matcher}' | head -1)"`;
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
export async function waitForServerReady({ command, member, platform, host, port, log = () => {}, attempts = 10, intervalMs = 500 }) {
    for (let i = 0; i < attempts; i += 1) {
        const probe = platformAwareTcpProbe({ command, member, platform, host, port });
        // eslint-disable-next-line no-await-in-loop -- intentional bounded poll
        const res = await probe;
        if (res) return true;
        // eslint-disable-next-line no-await-in-loop -- intentional bounded poll
        await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
    }
    throw new DoltSyncError(`[Dolt Settle] ephemeral sql-server for member '${member}' never became reachable at ${host}:${port} after ${attempts} attempts.`, { member });
}

/**
 * Is something listening on host:port on the member?
 *
 * Done in NODE, not in the member's shell, because no shell one-liner works
 * everywhere -- all of this is live-verified, not assumed:
 *   - `cmd || fallback` is a hard PARSE ERROR in PowerShell 5.1
 *     (fleet-win-dev1), so no single string can cover both families.
 *   - `/dev/tcp` is a BASH feature and fleet-mac's shell is ZSH, where it does
 *     not exist -- the probe silently reported "nothing listening" while the
 *     server was up and logging "Server ready. Accepting connections."
 * Every member necessarily has node (bd is npm-installed), and a single-quoted
 * JS string survives both bash and PowerShell unchanged.
 */
/**
 * Wrap a JS snippet as a `node -e` argument for the member's shell.
 *
 * PowerShell 5.1's native-argument passing STRIPS the double quotes inside a
 * single-quoted string, so `require("net")` arrived at node as
 * `require(net)` and died with a SyntaxError (verified live on
 * fleet-win-dev1). Backslash-escaping them is the documented workaround --
 * and must NOT be applied on POSIX, where the backslashes would survive
 * literally into the JS.
 */
function nodeEval(platform, js) {
    return `node -e '${platform === 'win32' ? js.replace(/"/g, '\\"') : js}'`;
}

function tcpProbeScript(platform, host, port, timeoutMs = 2000) {
    return nodeEval(platform, `const net=require("net");const s=net.connect(${port},"${host}");const done=(v)=>{try{s.destroy()}catch(e){};console.log(v?"PROBE:True":"PROBE:False");process.exit(0)};s.on("connect",()=>done(true));s.on("error",()=>done(false));setTimeout(()=>done(false),${timeoutMs})`);
}

async function platformAwareTcpProbe({ command, member, platform, host, port }) {
    const res = await command(tcpProbeScript(platform, host, port), { member_name: member, silent: true, failSoft: true, label: `settle: TCP probe for '${member}'` });
    return /PROBE:True/i.test(String((res && res.output) || ''));
}

/** Kill the server + verify the port is actually closed. Best-effort by
 *  design (called from the happy path AND the unconditional `finally` --
 *  see settleDoltConflicts). */
async function killServerAndVerify({ command, member, platform, pid, host, port, log = () => {} }) {
    // Kill the recorded pid AND, belt-and-braces, anything still bound to our
    // ephemeral port: the recorded pid is resolved by a pattern match at spawn
    // time, so a mis-resolved pid must not be able to leave the real server
    // running (which would hold the data dir lock and wedge the republish).
    // Both forms are scoped to settle's own port, never to dolt at large.
    const matcher = `sql-server --host ${host} --port ${port}`;
    if (platform === 'win32') {
        await command(
            `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process -Filter "Name='dolt.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match '--port ${port}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
            { member_name: member, silent: true, failSoft: true, label: `settle: kill ephemeral sql-server pid ${pid} on '${member}'` },
        );
    } else {
        await command(`kill ${pid} 2>/dev/null; pkill -f '${matcher}' 2>/dev/null; true`, { member_name: member, silent: true, failSoft: true, label: `settle: kill ephemeral sql-server pid ${pid} on '${member}'` });
    }
    for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- bounded teardown-verify poll
        const stillUp = await platformAwareTcpProbe({ command, member, platform, host, port });
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
export async function runDoltSql({ command, member, platform, doltPath, host, port, query, log = () => {} }) {
    // EVERY invocation is its own SQL SESSION -- `dolt sql -q` connects,
    // runs, and disconnects -- so session-scoped state does NOT carry over
    // between calls. `@@dolt_allow_commit_conflicts` is therefore set on each
    // one, not once up front: without it DOLT_MERGE fails outright with
    // "Merge conflict detected, @autocommit transaction rolled back"
    // (verified live on fleet-lin-dev1). The conflict data itself IS durable
    // -- it lives in the working set -- which is what lets the subsequent
    // resolve/commit statements run in later sessions.
    const preamble = 'USE beads; SET @@dolt_allow_commit_conflicts = 1;';
    const fullQuery = escapeSqlForShell(platform, `${preamble} ${query}`);
    const cmd = invokeBinary(platform, doltPath, `--no-tls --host=${host} --port=${port} sql -r json -q "${fullQuery}"`);
    const res = await command(cmd, { member_name: member, silent: true, failSoft: true, label: `settle: dolt sql for '${member}'` });
    if (res && res.ok === false) {
        throw new DoltSyncError(`[Dolt Settle] dolt sql query failed for member '${member}': ${res.error}\nquery: ${query}`, { member, doltOutput: res.error });
    }
    return parseDoltJsonRows(res && res.output);
}

/**
 * Parse the rows out of a `dolt sql -r json` batch.
 *
 * A multi-statement `-q` emits ONE JSON document PER STATEMENT, concatenated
 * (`{}` for a statement with no result set, `{"rows": [...]}` for a SELECT),
 * so a plain JSON.parse of the whole output throws and silently yielded []
 * -- which made settle believe a genuinely conflicted clone had no conflicted
 * tables at all, and then fail at DOLT_COMMIT with "the table(s) issues are
 * in conflict". Verified live on fleet-lin-dev1. Every settle query carries a
 * `USE beads; SET ...;` preamble, so this is the NORMAL shape, not an edge
 * case: take the last row-bearing document.
 *
 * @param {string|null|undefined} output
 * @returns {object[]}
 */
export function parseDoltJsonRows(output) {
    const raw = String(output || '').trim();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed && parsed.rows)) return parsed.rows;
    } catch { /* the multi-document shape below is the common case */ }

    let rows = [];
    for (const line of raw.split('\n')) {
        const text = line.trim();
        if (!text.startsWith('{')) continue;
        try {
            const doc = JSON.parse(text);
            if (Array.isArray(doc)) rows = doc;
            else if (Array.isArray(doc.rows)) rows = doc.rows;
        } catch { /* not a complete JSON document on this line */ }
    }
    return rows;
}

// ---------------------------------------------------------------------------
// Section 6: the settle rulebook -- TOTAL over every conflicted table.
// ---------------------------------------------------------------------------

async function tableColumns({ command, member, platform, doltPath, host, port, table }) {
    const rows = await runDoltSql({
        command, member, platform, doltPath, host, port,
        query: `SELECT COLUMN_NAME FROM information_schema.columns WHERE TABLE_NAME = '${table}';`,
    });
    return rows.map((r) => r.COLUMN_NAME || r.column_name).filter(Boolean);
}

/** The table's REAL uniqueness key, read live from information_schema -- never
 *  a hardcoded column list. Used by the set-union resolver to decide whether a
 *  `their_*` row is already present on our side. Falls back to the full column
 *  list (whole-row identity) when a table declares no PRIMARY KEY, which is
 *  still a correct -- if conservative -- set-union identity. */
async function tablePrimaryKey({ command, member, platform, doltPath, host, port, table }) {
    const rows = await runDoltSql({
        command, member, platform, doltPath, host, port,
        query: `SELECT COLUMN_NAME FROM information_schema.key_column_usage WHERE TABLE_NAME = '${table}' AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION;`,
    });
    return rows.map((r) => r.COLUMN_NAME || r.column_name).filter(Boolean);
}

/** Generic per-field last-writer-wins-by-updated_at, applicable to ANY table
 *  that has an `updated_at` column -- this is what makes settle TOTAL rather
 *  than gated to a fixed table list. Falls back to a plain `--theirs`
 *  resolve for a table with no `updated_at` column. */
async function resolveLwwTable({ command, member, platform, doltPath, host, port, table, log }) {
    const bq = String.fromCharCode(96); // backtick, built at runtime -- avoids a literal backslash-backtick sequence in source
    const cols = await tableColumns({ command, member, platform, doltPath, host, port, table });
    if (!cols.includes('updated_at')) {
        log(`[Dolt Settle] table '${table}' has no updated_at column -- resolving via plain --theirs (no per-field merge possible).`);
        await runDoltSql({ command, member, platform, doltPath, host, port, query: `CALL DOLT_CONFLICTS_RESOLVE('--theirs', '${table}');` });
        return;
    }
    const pk = cols.includes('id') ? 'id' : cols[0];
    const mutable = cols.filter((c) => c !== pk);
    // TRUE per-field merge, against the BASE row -- not the design doc's
    // original whole-row "recency wins every column" simplification, which the
    // live disjoint-fields scenario disproved on fleet-lin-dev1: with A
    // changing `status` and B changing `priority`, B's row was simply newer,
    // so every column took B's value and A's status change was silently lost.
    //
    // Per field, in order:
    //   1. we did not touch it (ours == base) -> take theirs
    //   2. they did not touch it (theirs == base) -> take ours
    //   3. BOTH changed it -> last-writer-wins on updated_at, tie to theirs
    //      (consistent with first-successful-pusher-wins: the remote already
    //      published)
    // `<=>` is null-safe equality, so a NULL base (add/add, no base row) falls
    // through to the LWW branch rather than matching everything.
    const setClauses = mutable
        .map((c) => `  t.${bq}${c}${bq} = CASE`
            + ` WHEN c.our_${c} <=> c.base_${c} THEN c.their_${c}`
            + ` WHEN c.their_${c} <=> c.base_${c} THEN c.our_${c}`
            + ` WHEN c.their_updated_at >= c.our_updated_at THEN c.their_${c}`
            + ` ELSE c.our_${c} END`)
        .join(',\n    ');
    const updateSql = `
        UPDATE ${bq}${table}${bq} t
        JOIN dolt_conflicts_${table} c ON t.${bq}${pk}${bq} = c.our_${pk}
        SET
    ${setClauses},
        t.updated_at = GREATEST(c.our_updated_at, c.their_updated_at)
        WHERE t.${bq}${pk}${bq} IN (SELECT our_${pk} FROM dolt_conflicts_${table});
    `;
    await runDoltSql({ command, member, platform, doltPath, host, port, query: updateSql });

    // Their-side-only rows (an add they made that we do not have) would be
    // DROPPED by the --ours resolve below, so carry them over first.
    const keyCols = (await tablePrimaryKey({ command, member, platform, doltPath, host, port, table })).length > 0
        ? await tablePrimaryKey({ command, member, platform, doltPath, host, port, table })
        : [pk];
    await runDoltSql({ command, member, platform, doltPath, host, port, query: buildTheirMissingInsert(table, cols, keyCols) });

    // --ours, NOT --theirs. The design doc flagged this as the one step to
    // validate live, and the live run settled it: DOLT_CONFLICTS_RESOLVE
    // rewrites the working-set row from the chosen side, so '--theirs' after
    // the LWW UPDATE CLOBBERS the merged row (verified on fleet-lin-dev1: a
    // row whose later updated_at was ours came back with their older value).
    // '--ours' keeps the row the UPDATE just merged, which is the whole point
    // of computing it.
    await runDoltSql({ command, member, platform, doltPath, host, port, query: `CALL DOLT_CONFLICTS_RESOLVE('--ours', '${table}');` });
}

/**
 * INSERT every `their_*` row from dolt_conflicts_<table> that is not already
 * present on our side, keyed on `keyCols`. Shared by the LWW resolver (where
 * it carries over their-side-only adds before an --ours resolve) and the
 * set-union resolver (where it IS the union).
 */
function buildTheirMissingInsert(table, cols, keyCols) {
    const bq = String.fromCharCode(96);
    const quote = (c) => `${bq}${c}${bq}`;
    const insertCols = cols.map(quote).join(', ');
    const selectCols = cols.map((c) => `c.their_${c}`).join(', ');
    const notNullGuard = keyCols.map((c) => `c.their_${c} IS NOT NULL`).join(' AND ');
    // NOTE: built by concatenation, not a template literal, purely so the
    // source never contains a backtick immediately followed by 't' -- the
    // repo's pre-commit PowerShell-escape guard flags that 2-char sequence.
    const matchOnKey = keyCols.map((c) => 't.' + quote(c) + ` = c.their_${c}`).join(' AND ');
    return `
        INSERT INTO ${quote(table)} (${insertCols})
        SELECT ${selectCols}
        FROM dolt_conflicts_${table} c
        WHERE ${notNullGuard}
          AND NOT EXISTS (
            SELECT 1 FROM ${quote(table)} t WHERE ${matchOnKey}
          );
    `;
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
async function resolveUnionTable({ command, member, platform, doltPath, host, port, table, log }) {
    const cols = await tableColumns({ command, member, platform, doltPath, host, port, table });
    if (cols.length === 0) {
        log(`[Dolt Settle] table '${table}' set-union: could not read its columns from information_schema -- falling back to a plain --theirs resolve.`);
        await runDoltSql({ command, member, platform, doltPath, host, port, query: `CALL DOLT_CONFLICTS_RESOLVE('--theirs', '${table}');` });
        return;
    }

    const pkFromSchema = await tablePrimaryKey({ command, member, platform, doltPath, host, port, table });
    const keyCols = pkFromSchema.length > 0 ? pkFromSchema : cols;
    log(`[Dolt Settle] table '${table}' conflict: resolving as a set-union (both sides' rows kept; identity = ${keyCols.join(' + ')}).`);

    await runDoltSql({ command, member, platform, doltPath, host, port, query: buildTheirMissingInsert(table, cols, keyCols) });
    // --ours, not --theirs (same live finding as resolveLwwTable): the resolve
    // rewrites the working-set row from the chosen side, so --theirs here
    // would undo the union by dropping the rows only WE had. Their rows have
    // just been inserted, so --ours is what actually keeps both sides.
    await runDoltSql({ command, member, platform, doltPath, host, port, query: `CALL DOLT_CONFLICTS_RESOLVE('--ours', '${table}');` });
}

/** Plain theirs -- machine-local/config rows, and append-only tables
 *  (comments/events) where both sides already survive by construction. */
async function resolveTheirsTable({ command, member, platform, doltPath, host, port, table, log }) {
    log(`[Dolt Settle] table '${table}' conflict: resolving --theirs.`);
    await runDoltSql({ command, member, platform, doltPath, host, port, query: `CALL DOLT_CONFLICTS_RESOLVE('--theirs', '${table}');` });
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
            await waitForServerReady({ command, member, platform, host, port, log });
        }

        // If not preflight-validated by the pin ladder, the fallback dolt
        // must pass a harmless functional preflight before any real data is
        // touched (Part 5.6 step 3).
        if (!doltInfo.pinned) {
            const preflight = await runDoltSql({ command, member, platform, doltPath: doltInfo.doltPath, host, port, query: 'SELECT 1;', log });
            if (!Array.isArray(preflight)) {
                throw new DoltBinaryUnavailableError(
                    `[Dolt Settle] fallback dolt ${doltInfo.version} on member '${member}' failed its functional preflight -- refusing to reopen the merge with an unverified client.`,
                    { member, probedPath: doltInfo.doltPath, repairCommand: `manually replace the dolt binary on ${member}` },
                );
            }
        }

        // Step 3/4: re-open the merge, enumerate every conflicted table.
        const ctx = { command, member, platform, doltPath: doltInfo.doltPath, host, port, log };
        await runDoltSql({ ...ctx, query: `CALL DOLT_MERGE('${remote}/${branch}');` });

        // NOTE: `SELECT *`, not a backtick-quoted `table` column -- dolt_conflicts'
        // only other column is num_conflicts, and avoiding the identifier quote
        // keeps this one (very frequently issued) query free of the shell's
        // backtick minefield entirely.
        const conflictRows = await runDoltSql({ ...ctx, query: 'SELECT * FROM dolt_conflicts;' });
        const tables = conflictRows.map((r) => r.table || r.TABLE).filter(Boolean);

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

// ---------------------------------------------------------------------------
// Section 8: the wiring seam -- what dolt-sync.mjs/runner.js actually hold.
// ---------------------------------------------------------------------------

/**
 * Resolve the MEMBER's platform/arch (never the orchestrator's -- see design
 * doc Part 5.3). Callers that already have registry metadata should pass
 * `platform`/`arch` explicitly; this probe is the fallback for callers (like
 * the sprint runner's sync brackets) that only hold a member name and a
 * command(). Members necessarily have node, since `bd` is npm-installed.
 *
 * @returns {Promise<{ platform: 'win32'|'linux'|'darwin', arch: string }>}
 */
export async function detectMemberPlatform({ command, member }) {
    // Quote-free JS on purpose: PowerShell 5.1 mangles quotes inside native
    // arguments, so a snippet with no quotes at all is the one form that
    // survives every member shell unchanged.
    const res = await command("node -e 'console.log(process.platform,process.arch)'", {
        member_name: member, silent: true, failSoft: true, label: `settle: detect platform for '${member}'`,
    });
    const text = String((res && (res.output || res.error)) || '');
    const match = text.match(/\b(win32|linux|darwin)\b\s+(\S+)/);
    if (!match) {
        throw new DoltSyncError(
            `[Dolt Settle] could not detect the platform of member '${member}' -- settle refuses to assume the orchestrator's own platform. Raw: ${text.slice(0, 200)}`,
            { member, doltOutput: text },
        );
    }
    return { platform: match[1], arch: match[2] === 'arm64' ? 'arm64' : 'x64' };
}

/**
 * Build the zero-argument settle callback the sync brackets hold at their
 * divergence terminals (`opts.settle` in dolt-sync.mjs). This is the single
 * seam that REPLACES buildDoltRecoveryLadder(): one deterministic function,
 * no tiers, no agent/model threading, and -- unlike the old ladder -- a
 * resolved promise IS a verified recovery, because settle republishes and
 * verifies before returning.
 *
 * The member's platform is resolved lazily on first invocation (nothing is
 * probed unless a divergence actually happens) and cached for the callback's
 * lifetime.
 *
 * @param {string} member
 * @param {{ command: Function, log?: Function, platform?: string, arch?: string }} opts
 * @returns {() => Promise<{ ok: true, resolvedTables: string[], warnings: string[], doltVersionUsed: string }>}
 */
export function buildSettleCallback(member, opts = {}) {
    const { command, log = () => {}, platform, arch } = opts;
    if (!member) throw new Error('buildSettleCallback requires a member');
    if (typeof command !== 'function') throw new Error('buildSettleCallback requires an injected command() in opts');

    let resolved = platform ? { platform, arch: arch || 'x64' } : null;
    return async () => {
        if (!resolved) resolved = await detectMemberPlatform({ command, member });
        return settleDoltConflicts(member, { command, log, platform: resolved.platform, arch: resolved.arch });
    };
}

/**
 * Ephemeral port selection: find the first port in the range nothing is
 * answering on. Deliberately ONE dispatch that scans member-side rather than
 * one dispatch per candidate port -- a 100-port range would otherwise be 100
 * SSH round trips.
 *
 * A port already answering is NOT reused even though it might be a settle
 * server: per design doc Part 3.5 an already-listening server on our intended
 * port is orphaned residue from an interrupted run, not a legitimate target
 * (the supervisor's orphan sweep is what reaps it).
 */
async function pickFreePort({ command, member, platform, portRangeStart, portRangeEnd }) {
    // Same node-based probe as tcpProbeScript, scanning the range member-side
    // in ONE dispatch: a round trip per candidate port would be 100 SSH
    // sessions, and no shell one-liner is portable across PowerShell 5.1,
    // bash and zsh (see tcpProbeScript for the live evidence).
    const script = nodeEval(platform,
        `const net=require("net");const host="${RECOVERY_SQL_SERVER_HOST}";`
        + 'const free=(p)=>new Promise((r)=>{const s=net.connect(p,host);const done=(v)=>{try{s.destroy()}catch(e){};r(v)};'
        + 's.on("connect",()=>done(false));s.on("error",()=>done(true));setTimeout(()=>done(true),500)});'
        + `(async()=>{for(let p=${portRangeStart};p<${portRangeEnd};p++){if(await free(p)){console.log("FREEPORT:"+p);break}}})()`);
    const res = await command(script, { member_name: member, silent: true, failSoft: true, label: `settle: pick a free ephemeral port for '${member}'` });
    const match = String((res && res.output) || '').match(/FREEPORT:(\d+)/);
    if (!match) {
        throw new DoltSyncError(`[Dolt Settle] no free port in range [${portRangeStart}, ${portRangeEnd}) for member '${member}'.`, { member, doltOutput: (res && (res.output || res.error)) || '' });
    }
    return Number(match[1]);
}
