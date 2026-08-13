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

/** How often the sweep runs. Settles take seconds; this is a safety net. */
export const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** A server younger than this is assumed to belong to a settle in progress and
 *  is left alone. Settle's own bounded waits are far shorter than this. */
export const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

/** Settle's ephemeral port range (dolt-settle.mjs DEFAULT_PORT_RANGE). Only a
 *  server bound inside this range can be settle residue. */
export const SETTLE_PORT_RANGE = Object.freeze({ start: 13300, end: 13400 });

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
 * @returns {string}
 */
export function buildSweepCommand(family, maxAgeMs = DEFAULT_MAX_AGE_MS) {
    const maxAgeSeconds = Math.floor(maxAgeMs / 1000);
    if (family === 'win32') {
        return [
            `$cutoff = (Get-Date).AddSeconds(-${maxAgeSeconds})`,
            '$procs = Get-CimInstance Win32_Process -Filter "Name=\'dolt.exe\'" -ErrorAction SilentlyContinue |'
            + ' Where-Object { $_.CommandLine -match \'sql-server\''
            + ` -and $_.CommandLine -match '--port 13[3-9][0-9]'`
            + ' -and $_.CreationDate -lt $cutoff }',
            'foreach ($p in $procs) { Write-Output "ORPHAN:$($p.ProcessId):$($p.CommandLine)"; Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }',
        ].join('; ');
    }
    // POSIX: etimes is the process age in seconds, so no clock skew maths.
    return [
        `ps -eo pid=,etimes=,args= | awk '$2 > ${maxAgeSeconds} && /sql-server/ && /--port 13[3-9][0-9]/ { printf "ORPHAN:%s:", $1; for (i=3; i<=NF; i++) printf "%s ", $i; print "" }'`,
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
        setInterval: setIntervalFn = setInterval,
        clearInterval: clearIntervalFn = clearInterval,
        logger = console,
    } = deps;

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
            const command = buildSweepCommand(family, maxAgeMs);
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
    };
}
