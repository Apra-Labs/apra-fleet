// beads-lock-probe.mjs -- who holds the beads locks on a member?
//
// A `bd dolt pull`/`bd dolt push` that waits on a beads lock prints nothing
// until it gets the lock, so a lock held by some other, long-lived process
// (observed: something left behind by an agent session that had just ended on
// that member) used to look like a silent ~10 minute hang ending in the
// inactivity kill. runDoltStep (dolt-sync.mjs) runs the probe built here once
// per attempt that is still in flight after a watchdog delay, logs the result,
// and fails fast with a typed error naming a FOREIGN holder.
//
// The probe is a separate, short execute_command on the same member while the
// sync command is still in flight. That is allowed: the fleet server takes no
// per-member lock for execute_command (its busy marker only drives the
// statusline), and the workflow engine's command() has no per-member queue.
//
// Probe output is line based and tab separated, the same on every OS:
//   HOLDER<TAB><pid><TAB><age><TAB><lock path><TAB><command line>
//   CANDIDATE<TAB><pid><TAB><age><TAB>-<TAB><command line>
//   NOLOOKUP<TAB><why holders cannot be listed on this member>
// <age> is seconds, or a ps(1) etime string ([[dd-]hh:]mm:ss).
//
// ASCII only.

import { getSeCommands } from './se-os-commands.mjs';
import { normalizeMemberTarget } from './bd-sync-command.mjs';

/**
 * The beads lock files, relative to the member's work folder (where the
 * beads workspace lives). These names are bd implementation details: keep
 * them HERE, in one place, so a bd upgrade that renames them is a one-line
 * change. A `*` segment is a shell glob (the embedded Dolt database
 * directory is named per clone).
 */
export const BEADS_LOCK_FILES = Object.freeze([
    '.beads/embeddeddolt.gate.lock',
    '.beads/dolt.gate.lock',
    '.beads/embeddeddolt/*/.dolt/noms/LOCK',
]);

/** Process image names a Windows candidate listing looks for. */
export const BEADS_LOCK_CANDIDATE_IMAGES = Object.freeze(['bd.exe', 'dolt.exe']);

const POSIX_LOCK_LIST = BEADS_LOCK_FILES.join(' ');

/** Every open file descriptor of the member user's processes (Linux /proc).
 *  A plain string, not inlined in a template: keeps the glob's slash-star
 *  sequences out of template text. */
const PROC_FD_GLOB = '/proc/[0-9]*/fd/*';

/**
 * Linux: walk /proc/<pid>/fd for links to each lock file (no extra package
 * needed; the member's own user's processes are visible, which is the user bd
 * runs as), falling back to lsof when /proc is not readable. Uses only
 * script-local shell variables -- nothing is read from the environment.
 */
function linuxProbe() {
    return [
        `if [ -d /proc/self/fd ]; then`,
        ` for f in ${POSIX_LOCK_LIST}; do [ -e "$f" ] || continue; a=$(readlink -f "$f");`,
        `  for d in ${PROC_FD_GLOB}; do [ "$(readlink "$d" 2>/dev/null)" = "$a" ] || continue; p=$(echo "$d" | cut -d/ -f3);`,
        `   printf 'HOLDER\\t%s\\t%s\\t%s\\t%s\\n' "$p" "$(ps -o etime= -p "$p" | tr -d ' ')" "$f" "$(tr '\\0' ' ' < /proc/$p/cmdline 2>/dev/null)";`,
        `  done; done | sort -u;`,
        `elif command -v lsof >/dev/null 2>&1; then`,
        ` for f in ${POSIX_LOCK_LIST}; do [ -e "$f" ] || continue;`,
        `  for p in $(lsof -t -- "$f" 2>/dev/null | sort -u); do printf 'HOLDER\\t%s\\t%s\\t%s\\t%s\\n' "$p" "$(ps -o etime= -p "$p" | tr -d ' ')" "$f" "$(ps -o args= -p "$p")"; done;`,
        ` done;`,
        `else printf 'NOLOOKUP\\tneither /proc nor lsof is available on this member\\n'; fi`,
    ].join('');
}

/** macOS: lsof ships with the OS; ps etime/command for age and command line. */
function macosProbe() {
    return [
        `if command -v lsof >/dev/null 2>&1; then`,
        ` for f in ${POSIX_LOCK_LIST}; do [ -e "$f" ] || continue;`,
        `  for p in $(lsof -t -- "$f" 2>/dev/null | sort -u); do printf 'HOLDER\\t%s\\t%s\\t%s\\t%s\\n' "$p" "$(ps -o etime= -p "$p" | tr -d ' ')" "$f" "$(ps -o command= -p "$p")"; done;`,
        ` done;`,
        `else printf 'NOLOOKUP\\tlsof is not available on this member\\n'; fi`,
    ].join('');
}

/**
 * Windows: there is no built-in way to ask which process holds a file lock
 * (that needs a handle-enumeration tool that is not part of Windows), so the
 * probe says so explicitly and lists the running bd/dolt processes -- with
 * pid, age and command line -- as CANDIDATES. Run as PowerShell on every
 * Windows member; a Git Bash member gets it through -EncodedCommand (its
 * MSYS `ps` pids are not native Windows pids).
 */
function windowsProbeScript() {
    const filter = BEADS_LOCK_CANDIDATE_IMAGES.map((n) => `Name='${n}'`).join(' OR ');
    return [
        // Progress records (e.g. "Preparing modules for first use") would
        // otherwise be serialized onto the output stream of an encoded run.
        `$ProgressPreference = 'SilentlyContinue';`,
        `Write-Output (@('NOLOOKUP', 'Windows has no built-in lookup of the process holding a file lock; listing running bd/dolt processes as candidates') -join [char]9);`,
        `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { Write-Output (@('CANDIDATE', $_.ProcessId, [int]((Get-Date) - $_.CreationDate).TotalSeconds, '-', $_.CommandLine) -join [char]9) }`,
    ].join(' ');
}

/**
 * The member-bound lock-holder probe command for a member's OS/shell.
 *
 * @param {{ os?: string, shell?: string }|string|null|undefined} target
 * @returns {string}
 */
export function buildLockHolderProbe(target) {
    const { os, shell } = normalizeMemberTarget(target);
    if (os === 'windows') {
        return getSeCommands({ os, shell }).wrapPowerShellScript(windowsProbeScript(), 'beads lock-holder probe');
    }
    if (os === 'darwin' || os === 'macos') return macosProbe();
    return linuxProbe();
}

/**
 * Seconds from a probe age field: plain seconds, or a ps(1) etime string
 * ([[dd-]hh:]mm:ss). Null when unparseable.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function parseProbeAgeSeconds(text) {
    const t = String(text == null ? '' : text).trim();
    if (/^\d+$/.test(t)) return Number(t);
    const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(t);
    if (!m) return null;
    const [, d, h, mi, s] = m;
    return (Number(d || 0) * 86400) + (Number(h || 0) * 3600) + (Number(mi) * 60) + Number(s);
}

/**
 * Parse a probe's output.
 *
 * @param {string} output
 * @returns {{ holders: Array<{ pid: number, ageS: number|null, lock: string, commandLine: string }>, candidates: Array<{ pid: number, ageS: number|null, lock: string, commandLine: string }>, noLookup: string|null }}
 */
export function parseLockHolderProbe(output) {
    const holders = [];
    const candidates = [];
    let noLookup = null;
    const seen = new Set();
    for (const line of String(output == null ? '' : output).split(/\r?\n/)) {
        // A tag is found anywhere on the line: a transport that merges
        // stderr into stdout can glue stray shell output in front of it.
        const at = line.search(/(?:HOLDER|CANDIDATE|NOLOOKUP)\t/);
        if (at < 0) continue;
        const parts = line.slice(at).split('\t');
        const tag = parts[0];
        if (tag === 'NOLOOKUP') {
            noLookup = parts.slice(1).join(' ').trim() || 'holders cannot be listed on this member';
            continue;
        }
        if (tag !== 'HOLDER' && tag !== 'CANDIDATE') continue;
        const pid = Number(String(parts[1] || '').trim());
        if (!Number.isInteger(pid) || pid <= 0) continue;
        const entry = {
            pid,
            ageS: parseProbeAgeSeconds(parts[2]),
            lock: String(parts[3] || '').trim(),
            commandLine: parts.slice(4).join('\t').trim(),
        };
        const key = `${tag}:${pid}:${entry.lock}`;
        if (seen.has(key)) continue;
        seen.add(key);
        (tag === 'HOLDER' ? holders : candidates).push(entry);
    }
    return { holders, candidates, noLookup };
}

/** One human-readable line per process. */
export function describeLockProcess(p) {
    const age = p.ageS == null ? 'age unknown' : `age ${p.ageS}s`;
    const lock = p.lock && p.lock !== '-' ? ` on ${p.lock}` : '';
    return `pid ${p.pid} (${age})${lock}: ${p.commandLine || '(command line unavailable)'}`;
}
