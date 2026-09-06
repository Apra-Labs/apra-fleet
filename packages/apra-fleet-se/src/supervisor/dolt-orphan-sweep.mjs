// =============================================================================
// Supervisor seam -- orphaned ephemeral `dolt sql-server` sweep
// (docs/dolt-sync-redesign.md Part 3.3)
// =============================================================================
//
// settleDoltConflicts() (fleet-sprint/dolt-settle.mjs) spawns a genuinely
// DETACHED, short-lived `dolt sql-server` on a member and tears it down in a
// real `finally` -- kill the recorded pid, verify the port closed. That
// `finally` covers every throw path inside the orchestrator process.
//
// It cannot cover ONE case: the orchestrator process itself dying mid-settle
// (SIGKILL, machine crash, a supervisor restart while a detached sprint child
// was settling). The server survives -- that is the whole point of the
// detachment -- and then holds Dolt's per-directory exclusive lock on the
// member's beads data dir, wedging every subsequent embedded `bd` command on
// that member. That is exactly the apra-fleet-5mqg damage class.
//
// This sweep is the backstop for that one case, and NOTHING else. If settle's
// `finally` is correct, this sweep should never find anything -- finding
// something is itself a signal worth logging loudly. It only ever kills a
// process that is BOTH a `dolt sql-server` AND listening on a port inside
// settle's own ephemeral range AND older than a generous age threshold, so a
// settle actually in progress is never interrupted and an operator's own
// long-lived dolt server (on any other port) is never touched.
//
// ASCII only.
// =============================================================================

import { DEFAULT_PORT_RANGE } from '../../fleet-sprint/dolt-settle.mjs';
import { SeWindowsCommands } from '../../fleet-sprint/se-windows.mjs';

const seWindows = new SeWindowsCommands();

/** How often the sweep runs. Settles take seconds; this is a safety net. */
export const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** A server younger than this is assumed to belong to a settle in progress and
 *  is left alone. Settle's own bounded waits are far shorter than this. */
export const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

/** Settle's ephemeral port range. Re-exported from dolt-settle.mjs's
 *  DEFAULT_PORT_RANGE -- never re-derive these bounds by hand, so the sweep
 *  can never drift out of sync with the range settle actually uses. Only a
 *  server bound inside this range can be settle residue. */
export const SETTLE_PORT_RANGE = DEFAULT_PORT_RANGE;

/**
 * Owner scope (the cross-instance-kill fix). The probe/kill command below is
 * otherwise a MACHINE-WIDE process scan bounded only by port range and process
 * age -- so an isolated supervisor instance (e.g. the regression playbook's
 * sandbox, whose HOME/FLEET_SE_DATA_DIR point inside the sandbox) could kill an
 * aged ephemeral server belonging to a DIFFERENT, live supervisor on the same
 * machine. Passing an owner data-dir prefix constrains candidates to processes
 * whose `--data-dir` lives under that prefix.
 *
 * This is deliberately OPT-IN, wired at the deps level by bin/serve.mjs from
 * FLEET_SE_SWEEP_OWNER_DATA_DIR: the ephemeral server's `--data-dir` is the
 * MEMBER's beads data dir (dolt-settle.mjs's resolveDoltStatus reads it from
 * `bd dolt status` on the member), which for a remote member has no relation to
 * the sweeping supervisor's own data dir. Deriving the prefix from
 * FLEET_SE_DATA_DIR unconditionally would therefore silently turn the sweep
 * into a no-op for every remote member -- destroying the safety net to fix the
 * isolation problem. An operator/test that KNOWS its members are confined to
 * one root opts in; production keeps the machine-wide default.
 *
 * KNOWN LIMIT: resolveDoltStatus's `unknown` parse fallback yields the
 * RELATIVE default data dir, so such a command line carries no absolute path
 * and is excluded by ANY prefix. That direction is fail-safe (the sweep skips
 * rather than kills a foreign process), but it means an owner-scoped sweep is
 * inert for that fallback -- see scripts/reap-sandbox-dolt.mjs, which covers
 * the same blind spot with a recency bound instead.
 */
export function normalizeOwnerDataDirPrefix(prefix) {
    const text = String(prefix == null ? '' : prefix).trim();
    return text ? text : null;
}

/**
 * apra-fleet-5co8.36: Node's `path.resolve()` does NOT understand MSYS-style
 * POSIX paths (e.g. `/c/Users/x/temp` -- what Git Bash reports as `$HOME` on
 * Windows). On win32 it treats a leading `/c/...` as a root-relative path on
 * the CURRENT drive and prefixes it with that drive, producing a nonexistent
 * path like `C:\c\Users\x\temp` rather than `C:\Users\x\temp`. Since
 * `FLEET_SE_SWEEP_OWNER_DATA_DIR` is commonly set from `$HOME` under Git
 * Bash (see regression-test-playbook.md's `## Setup`), that mangling made the
 * owner-scoped sweep match no real `--data-dir` and silently degrade to
 * matching nothing while still logging a confident scope claim.
 *
 * Call this BEFORE `path.resolve()` on a raw env value: it rewrites a
 * `/<drive>/...` MSYS path to its native Windows form (`<DRIVE>:\...`) when
 * `platform` is `'win32'`, and returns the input unchanged for any other
 * platform or any value that does not look like an MSYS path (e.g. one
 * that is already native, like `C:\Users\x` or `C:/Users/x`).
 *
 * @param {string} value
 * @param {string} [platform] defaults to `process.platform` (win32 under
 *        Git Bash even though the invoking shell is POSIX-like -- Node's own
 *        platform, never the shell, decides this).
 * @returns {string}
 */
export function normalizeMsysPathForPlatform(value, platform = process.platform) {
    const text = String(value == null ? '' : value);
    if (platform !== 'win32' || !text) return text;
    const match = /^\/([a-zA-Z])\/(.*)$/.exec(text);
    if (!match) return text;
    const [, drive, rest] = match;
    return `${drive.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`;
}

/** Quote a value for embedding in a PowerShell single-quoted string literal. */
function psQuote(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

/** Escape PowerShell -like wildcard metacharacters so a path is matched
 *  LITERALLY. -like (not -match) is used deliberately: a regex operator would
 *  clobber $Matches, which the port-range bound above reads, and a Windows
 *  path's backslashes would be read as regex escapes. */
function psLikeEscape(value) {
    return String(value).replace(/([*?[\]`])/g, '`$1');
}

/** Quote a value for embedding in a POSIX shell single-quoted word. awk's -v
 *  ALSO processes backslash escapes in the assigned value, so backslashes are
 *  doubled first -- otherwise a `\U`/`\x` in a path would be mangled. */
function awkVarQuote(value) {
    const escaped = String(value).replace(/\\/g, '\\\\');
    return `'${escaped.replace(/'/g, "'\\''")}'`;
}

/** Normalize a member registry `os` value to the shell family we must speak. */
export function memberShellFamily(os) {
    // NOTE: a bare /win/ test is wrong -- 'darwin' contains 'win'.
    const text = String(os || '').toLowerCase();
    return (text.startsWith('win') || text.includes('windows')) ? 'win32' : 'posix';
}

/**
 * The probe-and-kill command, per shell family. One command does both: it
 * enumerates candidates, prints what it is about to kill (so the sweep can log
 * evidence rather than a silent body count), and kills only those.
 *
 * @param {'win32'|'posix'} family
 * @param {number} maxAgeMs
 * @param {string|null} [ownerDataDirPrefix] when set, only a process whose
 *        command line carries a `--data-dir` under this prefix is a candidate
 *        (see normalizeOwnerDataDirPrefix above). Omitted -> machine-wide.
 * @returns {string}
 */
export function buildSweepCommand(family, maxAgeMs = DEFAULT_MAX_AGE_MS, ownerDataDirPrefix = null) {
    const maxAgeSeconds = Math.floor(maxAgeMs / 1000);
    const owner = normalizeOwnerDataDirPrefix(ownerDataDirPrefix);
    // Exact numeric bounds, never a hand-derived digit-prefix regex: matching
    // must be EXACT on [SETTLE_PORT_RANGE.start, SETTLE_PORT_RANGE.end) so an
    // operator's own long-lived server (e.g. --port 1337, or ANY 4-digit port,
    // or a 5-digit port merely starting with the same leading digits like
    // --port 13400) is never a false positive -- see the module doc above.
    const portLo = SETTLE_PORT_RANGE.start;
    const portHi = SETTLE_PORT_RANGE.end - 1; // inclusive upper bound
    if (family === 'win32') {
        // The registered `shell` for a win32 member can be real PowerShell OR
        // gitbash (bash.exe) -- and MSYS `ps` cannot support the POSIX branch
        // below (no -o/etimes support, confirmed live). Rather than add a
        // third shell-family branch, wrap this script as an opaque
        // `powershell -EncodedCommand <blob>` invocation via the same
        // wrapForMember() envelope se-windows.mjs uses for its own member
        // dispatch. That string is a single shell-agnostic argument to any
        // OUTER shell (bash.exe, cmd.exe, powershell.exe) -- it always execs
        // the literal powershell.exe binary regardless of which one the
        // receiving member actually runs.
        const rawScript = [
            `$cutoff = (Get-Date).AddSeconds(-${maxAgeSeconds})`,
            '$procs = Get-CimInstance Win32_Process -Filter "Name=\'dolt.exe\'" -ErrorAction SilentlyContinue |'
            + ' Where-Object { $_.CommandLine -match \'sql-server\''
            + ` -and $_.CommandLine -match '--port (\\d+)' -and [int]$Matches[1] -ge ${portLo} -and [int]$Matches[1] -le ${portHi}`
            + ' -and $_.CreationDate -lt $cutoff'
            // Owner clause LAST, and -like rather than -match: $Matches still
            // holds the --port capture the bound above compares, so any regex
            // operator inserted here would silently break the port range.
            + (owner ? ` -and $_.CommandLine -like ${psQuote(`*--data-dir*${psLikeEscape(owner)}*`)}` : '')
            + ' }',
            'foreach ($p in $procs) { Write-Output "ORPHAN:$($p.ProcessId):$($p.CommandLine)"; Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }',
        ].join('; ');
        return seWindows.wrapForMember(rawScript);
    }
    // POSIX: etimes is the process age in seconds, so no clock skew maths.
    // awk has no lookahead, so the port bound is an actual numeric range
    // check (match() + substr() to pull the digits, then compare) rather than
    // a digit-prefix regex -- exact, not "harmlessly overbroad".
    // The owner clause is a literal SUBSTRING test (index()), never a regex:
    // a path may contain regex metacharacters, and awk has no literal-match
    // operator. The value is passed via -v so it is never spliced into the
    // program text.
    const ownerVar = owner ? `-v owner=${awkVarQuote(owner)} ` : '';
    const ownerClause = owner ? ' && /--data-dir/ && index($0, owner) > 0' : '';
    return [
        `ps -eo pid=,etimes=,args= | awk ${ownerVar}-v lo=${portLo} -v hi=${portHi} '$2 > ${maxAgeSeconds} && /sql-server/${ownerClause} && match($0, /--port [0-9]+/) {`
        + ' port = substr($0, RSTART + 7, RLENGTH - 7) + 0;'
        + ' if (port >= lo && port <= hi) { printf "ORPHAN:%s:", $1; for (i=3; i<=NF; i++) printf "%s ", $i; print "" }'
        + " }'",
        '| tee /dev/stderr',
        "| sed -n 's/^ORPHAN:\\([0-9]*\\):.*/\\1/p'",
        '| xargs -r kill -9',
    ].join(' ');
}

/** Parse the ORPHAN: lines a sweep command emits. */
export function parseSweepOutput(output) {
    const found = [];
    for (const line of String(output || '').split('\n')) {
        const match = line.match(/ORPHAN:(\d+):(.*)$/);
        if (match) found.push({ pid: Number(match[1]), commandLine: match[2].trim() });
    }
    return found;
}

/**
 * Create the sweep seam. Shape matches the supervisor's other timer-driven
 * seams (dolt-mutex.mjs, id-allocator.mjs): construct, then start()/stop() is
 * driven by the seam machinery in server.mjs.
 *
 * @param {{
 *   listMembers: () => Promise<{ members: Array<object> }>,
 *   execCommand: (opts: { member: string, command: string }) => Promise<{ ok: boolean, output?: string, error?: string }>,
 *   intervalMs?: number,
 *   maxAgeMs?: number,
 *   ownerDataDirPrefix?: string|null,
 *   setInterval?: Function,
 *   clearInterval?: Function,
 *   logger?: { log?: Function, error?: Function },
 * }} deps
 */
export function createDoltOrphanSweep(deps = {}) {
    const {
        listMembers,
        execCommand,
        intervalMs = DEFAULT_SWEEP_INTERVAL_MS,
        maxAgeMs = DEFAULT_MAX_AGE_MS,
        ownerDataDirPrefix = null,
        setInterval: setIntervalFn = setInterval,
        clearInterval: clearIntervalFn = clearInterval,
        logger = console,
    } = deps;

    const owner = normalizeOwnerDataDirPrefix(ownerDataDirPrefix);

    const log = (...a) => (logger.log ?? (() => {}))(...a);
    const logError = (...a) => (logger.error ?? logger.log ?? (() => {}))(...a);

    let timer = null;
    let inFlight = false;

    /**
     * One sweep pass across every registered member. Never throws: this is a
     * safety net, and a safety net that can take the supervisor down is worse
     * than the leak it guards against.
     *
     * @returns {Promise<{ swept: number, killed: Array<{ member: string, pid: number, commandLine: string }>, errors: number }>}
     */
    async function sweepOnce() {
        const killed = [];
        let swept = 0;
        let errors = 0;

        let members = [];
        try {
            const listed = await listMembers();
            members = (listed && Array.isArray(listed.members)) ? listed.members : [];
        } catch (err) {
            logError('[dolt-orphan-sweep] could not list fleet members (skipping this pass):', err);
            return { swept, killed, errors: 1 };
        }

        for (const member of members) {
            const name = member && (member.name || member.id);
            if (!name) continue;
            const family = memberShellFamily(member && member.os);
            const command = buildSweepCommand(family, maxAgeMs, owner);
            swept += 1;
            let res;
            try {
                // eslint-disable-next-line no-await-in-loop -- deliberately sequential: a safety net must not fan out N SSH sessions at once
                res = await execCommand({ member: name, command });
            } catch (err) {
                errors += 1;
                logError(`[dolt-orphan-sweep] probe failed for member '${name}':`, err && err.message ? err.message : err);
                continue;
            }
            if (res && res.ok === false) {
                errors += 1;
                logError(`[dolt-orphan-sweep] probe failed for member '${name}': ${res.error}`);
                continue;
            }
            for (const orphan of parseSweepOutput(res && (res.output || res.error))) {
                killed.push({ member: name, pid: orphan.pid, commandLine: orphan.commandLine });
                logError(
                    `[dolt-orphan-sweep] KILLED an orphaned ephemeral dolt sql-server on member '${name}' `
                    + `(pid ${orphan.pid}, older than ${Math.floor(maxAgeMs / 1000)}s, cmd: ${orphan.commandLine}). `
                    + "This should be impossible if settle's own finally-block teardown ran -- it means an orchestrator "
                    + 'process died mid-settle (docs/dolt-sync-redesign.md Part 3.3). Investigate the sprint that was settling.',
                );
            }
        }

        if (killed.length === 0) log(`[dolt-orphan-sweep] pass complete: ${swept} member(s) probed, no orphaned settle servers found.`);
        return { swept, killed, errors };
    }

    return {
        name: 'dolt-orphan-sweep',
        sweepOnce,
        start() {
            if (timer) return;
            timer = setIntervalFn(() => {
                // Skip a tick rather than stacking passes if the previous one
                // is still walking members over SSH (same reentrancy posture
                // as the watchdog's interval).
                if (inFlight) return;
                inFlight = true;
                Promise.resolve()
                    .then(sweepOnce)
                    .catch((err) => logError('[dolt-orphan-sweep] sweep pass failed:', err))
                    .finally(() => { inFlight = false; });
            }, intervalMs);
            if (timer && typeof timer.unref === 'function') timer.unref();
        },
        stop() {
            if (!timer) return;
            clearIntervalFn(timer);
            timer = null;
        },
        get intervalMs() { return intervalMs; },
        get maxAgeMs() { return maxAgeMs; },
        get ownerDataDirPrefix() { return owner; },
    };
}
