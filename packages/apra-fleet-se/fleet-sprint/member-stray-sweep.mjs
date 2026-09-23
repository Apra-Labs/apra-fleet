// =============================================================================
// Member stray fleet-process sweep -- remote-only, parent-gone, port-safe.
// =============================================================================
//
// WHY THIS EXISTS: a sprint that ended badly (orchestrator killed, machine
// rebooted mid-dispatch, a sandbox supervisor/server pair never torn down)
// leaves processes running on a MEMBER. The next sprint then launches onto a
// member that is already holding ports, locks and memory from the last one.
// Today an operator cleans that up by hand; this module is the product doing
// it instead.
//
// WHY IT IS DANGEROUS AND THEREFORE NARROW: this is a MACHINE-WIDE process
// scan followed by a kill. The whole design is a set of predicates that must
// ALL hold before a single process is killed, and a shape (pure decision
// function + injected execution seam) that lets every one of those predicates
// be tested without a real process existing anywhere. The predicates:
//
//   1. REMOTE MEMBERS ONLY. For anything not verifiably a remote member the
//      sweep may only REPORT candidates -- see memberLocality() for the
//      explicit 'local' / 'relay' / unknown mapping and why.
//   2. Only processes FLEET ITSELF STARTED, identified by more than a process
//      name (see classifyFleetEvidence() -- a name-only match is never
//      sufficient evidence).
//   3. Only when the PARENT PROCESS IS GONE (see computeParentGone()).
//   4. NEVER a process listening on the member's production fleet or
//      supervisor port (the caller passes that port set in; this module
//      hardcodes no port).
//   5. Only when the process is OLDER than a minimum-age bound (see
//      DEFAULT_MIN_AGE_MS and decideStrayProcess() -- a process that is too
//      young, or whose start time could not be established, is reported but
//      never killed. This is what stops the sweep from killing a process a
//      DIFFERENT, concurrently-starting sprint just launched on the same
//      member seconds ago: it can already satisfy every other predicate
//      (daemonized -> ppid 1 -> parentGone true) before it has had time to do
//      anything the next member-prep pass would recognise as itself).
//   6. Every kill is logged with pid, command line, start time and the reason
//      the process was selected (see formatStrayKillLog()).
//
// PRIOR ART this follows deliberately: src/supervisor/dolt-orphan-sweep.mjs
// (same command-builder / output-parser / injected-seam split, same
// machine-wide-kill hazard discipline) and scripts/reap-sandbox-dolt.mjs
// (the process-enumeration portability probe, and its rule that a member with
// NO usable enumeration tool is a LOUD FAILURE, never a clean member).
//
// WHY IT LIVES HERE rather than next to dolt-orphan-sweep.mjs: that module is
// a supervisor timer seam (start()/stop(), an interval, wired into the
// supervisor's seam machinery). This one has no timer and no supervisor
// wiring -- it runs once per member at sprint start and its only caller is
// the sprint's member-prep step in this directory. Living here also puts it
// inside the generic-engine boundary scan and the five mechanical guards,
// which a module that builds member-bound command strings should be inside.
//
// START TIME PORTABILITY (the known trap this module must not repeat):
// scripts/reap-sandbox-dolt.mjs enumerates with `ps -eo pid=,etimes=,args=`,
// and `etimes` is a GNU/Linux procps extension that HARD-FAILS on macOS BSD
// ps. This module uses `etime` instead -- the POSIX-standard elapsed-time
// format keyword, present on Linux procps and macOS/BSD ps alike -- and
// converts `[[dd-]hh:]mm:ss` to an absolute start time in JavaScript against
// an injected clock. Windows takes its start time from
// Win32_Process.CreationDate, converted to epoch seconds on the member. Both
// families therefore report an ABSOLUTE start time, so the record shape is
// one shape and no caller has to know which OS produced it.
//
// GENERIC ENGINE: this module ships to every fleet-sprint target. It knows no
// process names, no paths and no ports of its own -- the evidence markers and
// the production port set are INPUTS supplied by the caller, which is also
// what makes the "never kill by name alone" rule mechanically checkable.
// That is not only a boundary concession: the fleet-owned values that would
// otherwise be the obvious markers (the data-dir env vars) are passed to
// member processes through the ENVIRONMENT and never appear in argv, so a
// command-line sweep could not read them anyway. Only the caller knows which
// paths and flags it actually put on a command line.
//
// KNOWN LIMIT -- opaque Windows command lines. A dispatch to a Windows member
// is frequently delivered as `powershell -EncodedCommand <base64>`, whose
// command line carries none of the tokens that were encoded inside it. Such a
// process matches no marker, so it is LEFT ALONE. That is the fail-safe
// direction (the sweep under-kills rather than over-kills), but it means a
// caller that wants those trees swept must supply a marker that survives the
// encoding -- something on the OUTER command line -- rather than a token from
// the encoded payload.
//
// ASCII only.
// =============================================================================

import { SeWindowsCommands } from './se-windows.mjs';

const seWindows = new SeWindowsCommands();

// ---------------------------------------------------------------------------
// Probe line protocol. One probe dispatch emits BOTH the process table and the
// listening-socket table, each line self-describing, so the parser never has
// to be told which OS family produced the output.
// ---------------------------------------------------------------------------

/** `SWEEP-PROC <pid> <ppid> <etime> <args>` (POSIX). */
export const PROC_LINE_PREFIX = 'SWEEP-PROC';
/**
 * `SWEEP-PROC-WIN <pid>|<ppid>|<epochSeconds>|<commandLine>` (Windows).
 *
 * A SEPARATE tag rather than one shared with the POSIX rows, because the two
 * row formats cannot be told apart by their content: a POSIX command line may
 * itself contain a pipe (`sh -c 'a | b'`), so sniffing for '|' would route
 * that row into the Windows parser, fail to read a pid from it, and DROP the
 * process. A dropped row is not merely a missing candidate -- it also leaves
 * the live-pid set, which is what computeParentGone() consults, so a dropped
 * parent would make its children look orphaned and eligible for killing.
 */
export const PROC_WIN_LINE_PREFIX = 'SWEEP-PROC-WIN';
/** lsof machine-format listening sockets: one pid line ("p" + pid) followed
 *  by one address line ("n" + address) per socket that pid owns. */
export const PORT_LSOF_PREFIX = 'SWEEP-PORT-LSOF';
/** `ss -H -l -t -n -p` rows, used when lsof is absent. */
export const PORT_SS_PREFIX = 'SWEEP-PORT-SS';
/** `SWEEP-PORT-WIN <owningPid>|<localPort>` (Windows). */
export const PORT_WIN_PREFIX = 'SWEEP-PORT-WIN';
/** `SWEEP-NOTOOL <toolName>` -- the member has no usable probe tool. */
export const MISSING_TOOL_PREFIX = 'SWEEP-NOTOOL';

// ---------------------------------------------------------------------------
// Execution-seam dispatch intent (apra-fleet-i4ku.12)
// ---------------------------------------------------------------------------
//
// sweepMemberStrayProcesses() dispatches through ONE injected `execCommand`
// seam twice with very different consequences: a read-only enumeration
// probe, and a kill. Both used to arrive at the adapter carrying only
// `{ member, command }`, which left an adapter no way to tell them apart --
// so the Member Prep adapter in fleet-sprint/runner.js labelled BOTH as a
// probe, and every kill was recorded in the sprint log and ledger as a
// probe. That is exactly the accountability formatStrayKillLog() exists to
// provide, undone one level up.
//
// The seam now carries `kind`, valued with one of the two constants below.
// It is DESCRIPTIVE ONLY: it never changes the `command` string, so the set
// of commands actually executed on a member is byte-identical to before.
// It is also OPTIONAL by contract -- an adapter that destructures only
// `{ member, command }` (every pre-existing caller) keeps working untouched,
// and an adapter that wants the distinction defaults it to EXEC_KIND_PROBE,
// which is the conservative reading of an unlabelled dispatch.

/** A read-only process/socket enumeration dispatch. Kills nothing. */
export const EXEC_KIND_PROBE = 'probe';
/** A dispatch that signals selected pids. Destructive. */
export const EXEC_KIND_KILL = 'kill';

// ---------------------------------------------------------------------------
// Errors. Both are LOUD by construction: the sweep throws rather than
// returning an empty result, because "I could not look" and "there is nothing
// there" must never be the same value to a caller.
// ---------------------------------------------------------------------------

/** Any failure that leaves the sweep unable to establish what is running. */
export class StrayProbeError extends Error {
    constructor(message) {
        super(message);
        this.name = 'StrayProbeError';
    }
}

/** The member has no supported process-enumeration (or listening-socket)
 *  tool. Named separately, and carrying `tool`, so a caller can report WHICH
 *  tool the member is missing instead of a generic probe failure. */
export class StrayProbeToolMissingError extends StrayProbeError {
    constructor(tool, memberName = null) {
        const where = memberName ? ` on member '${memberName}'` : '';
        super(
            `stray-process sweep cannot enumerate processes${where}: no supported tool available `
            + `(missing '${tool}'). Refusing to report a clean member -- install the tool or exclude `
            + 'this member from the sweep.',
        );
        this.name = 'StrayProbeToolMissingError';
        this.tool = tool;
        this.memberName = memberName;
    }
}

// ---------------------------------------------------------------------------
// Member classification
// ---------------------------------------------------------------------------

/** The sweep may kill on this member. */
export const LOCALITY_REMOTE = 'remote';
/** The sweep may only REPORT candidates on this member. */
export const LOCALITY_LOCAL = 'local';

/**
 * Classify a member into the only two classes the kill decision cares about.
 *
 * The registry's own type (core's `Agent.agentType`, surfaced by list_members
 * as `type`) has THREE values, and each is mapped here deliberately -- none
 * falls through a default:
 *
 *   'remote' -> LOCALITY_REMOTE. A machine that is not the orchestrator's,
 *               reached directly. This is the ONLY killable class.
 *   'local'  -> LOCALITY_LOCAL. The orchestrator's own machine: it hosts the
 *               production fleet server, the supervisor, and very likely the
 *               operator's own editor, shell and checkout. Report only.
 *   'relay'  -> LOCALITY_LOCAL. DELIBERATE, and not an oversight: a relay
 *               entry is an ADDRESSING ALIAS (it carries relayMemberId, a
 *               pointer to a member record owned by the hub), so this side
 *               cannot establish what machine is on the far end -- it may be
 *               the hub's own local machine. "Cannot prove it is not local"
 *               must resolve to report-only, because the failure direction of
 *               guessing wrong here is killing an operator's processes.
 *
 * Anything else (missing, empty, an unrecognised future value) is likewise
 * LOCALITY_LOCAL, for the same reason.
 *
 * @param {{ type?: string, agentType?: string }} member
 * @returns {'remote'|'local'}
 */
export function memberLocality(member) {
    const raw = member && (member.type || member.agentType);
    return String(raw || '').trim().toLowerCase() === 'remote' ? LOCALITY_REMOTE : LOCALITY_LOCAL;
}

/**
 * Normalize a member registry `os` value to the shell family the probe must
 * speak. Mirrors dolt-orphan-sweep.mjs's function of the same name, including
 * its note: a bare /win/ test is wrong, because 'darwin' contains 'win'.
 *
 * @param {string} os
 * @returns {'win32'|'posix'}
 */
export function memberShellFamily(os) {
    const text = String(os || '').toLowerCase();
    return (text.startsWith('win') || text.includes('windows')) ? 'win32' : 'posix';
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

/**
 * The single probe command, per shell family. It enumerates EVERY process
 * (the full table is required: the parent-liveness predicate needs the set of
 * live pids, not just the candidates) and every listening TCP socket, and it
 * emits a `SWEEP-NOTOOL <tool>` line instead of silence when the member has
 * no tool to do so.
 *
 * It kills nothing. Killing is a separate dispatch built by buildKillCommand()
 * from an explicit pid list that has already survived every predicate -- so
 * the selection logic lives in JavaScript, where it is testable, and never
 * inside an opaque one-liner running on the member.
 *
 * NO SHELL-LEVEL EXPANSION in either branch: the POSIX branch interpolates
 * nothing at all, and the Windows branch is wrapped as an opaque
 * `powershell -EncodedCommand <base64>` string (a single argument to whatever
 * outer shell the member actually runs -- bash.exe, cmd.exe or powershell).
 * The `$_` / `$procTool` tokens inside the encoded payload are PowerShell's
 * own pipeline and local variables, evaluated by the powershell.exe this
 * command explicitly execs -- they are never an orchestrator-side value left
 * for an unknown member shell to expand, which is what that rule forbids.
 *
 * @param {'win32'|'posix'} family
 * @returns {string}
 */
export function buildProbeCommand(family) {
    if (family === 'win32') {
        const rawScript = [
            // Get-Command, not a try/catch: an absent cmdlet must produce the
            // SWEEP-NOTOOL line, which is a RESULT, not an error to swallow.
            '$procTool = Get-Command Get-CimInstance -ErrorAction SilentlyContinue', // shell-guard-allow: PowerShell local variable inside this module's own -EncodedCommand payload, evaluated by the powershell.exe the envelope explicitly execs -- not an orchestrator-side value left for an unknown member shell to expand.
            'if ($procTool) {'
                + ' Get-CimInstance Win32_Process -ErrorAction Stop'
                // NO Where-Object filter here (apra-fleet-i4ku.4): EVERY row
                // is emitted, including one with a null CreationDate (a few
                // system processes). Dropping such a row would also drop its
                // pid from the live-pid set annotateCandidates() builds from
                // this table, making computeParentGone() treat its CHILDREN
                // as orphaned -- the exact dropped-row hazard this module's
                // header already documents for the pipe-sniffing case.
                // String concatenation rather than "$( ... )" subexpressions:
                // a PowerShell subexpression and a POSIX command substitution
                // are spelled identically, and this command string must stay
                // free of the latter's spelling.
                + ' | ForEach-Object {' // shell-guard-allow: PowerShell pipeline stage inside this module's own -EncodedCommand payload; see buildProbeCommand's doc comment.
                // A null CreationDate would throw calling .ToUniversalTime()
                // under the envelope's $ErrorActionPreference = 'Stop', so
                // that call only ever runs in the branch that already proved
                // CreationDate is not null; the other branch emits the '-'
                // sentinel parseProbeOutput() reads back as "start time
                // unknown" (Number('-') is NaN -> startedAtMs: null).
                + ' $sweepTs = if ($_.CreationDate -ne $null)' // shell-guard-allow: PowerShell pipeline variable inside this module's own -EncodedCommand payload; see buildProbeCommand's doc comment.
                + ' { [long]([DateTimeOffset]$_.CreationDate.ToUniversalTime()).ToUnixTimeSeconds() }' // shell-guard-allow: PowerShell pipeline variable inside this module's own -EncodedCommand payload; see buildProbeCommand's doc comment.
                + " else { '-' };"
                + " 'SWEEP-PROC-WIN ' + $_.ProcessId + '|' + $_.ParentProcessId + '|' + $sweepTs + '|' + $_.CommandLine" // shell-guard-allow: PowerShell pipeline variable and local variable inside this module's own -EncodedCommand payload; see buildProbeCommand's doc comment.
                + ' }'
                + " } else { 'SWEEP-NOTOOL Get-CimInstance' }",
            '$portTool = Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue', // shell-guard-allow: PowerShell local variable inside this module's own -EncodedCommand payload; see buildProbeCommand's doc comment.
            'if ($portTool) {' // shell-guard-allow: PowerShell local variable inside this module's own -EncodedCommand payload; see buildProbeCommand's doc comment.
                + ' Get-NetTCPConnection -State Listen -ErrorAction Stop'
                + " | ForEach-Object { 'SWEEP-PORT-WIN ' + $_.OwningProcess + '|' + $_.LocalPort }" // shell-guard-allow: PowerShell pipeline variable inside this module's own -EncodedCommand payload; see buildProbeCommand's doc comment.
                + " } else { 'SWEEP-NOTOOL Get-NetTCPConnection' }",
        ].join('; ');
        return seWindows.wrapForMember(rawScript);
    }
    // POSIX. `etime` (POSIX standard) and NOT `etimes` (GNU/Linux only) -- see
    // this file's START TIME PORTABILITY note. `command -v` is a POSIX shell
    // builtin, so tool detection needs no external binary and no command
    // substitution. Each table is tagged with sed rather than a subshell.
    return [
        `if command -v ps > /dev/null 2>&1; then ps -eo pid=,ppid=,etime=,args= | sed -e 's/^/${PROC_LINE_PREFIX} /';`,
        `else echo '${MISSING_TOOL_PREFIX} ps'; fi;`,
        // BOTH socket tools are run when present, and their rows are unioned
        // by the parser -- deliberately NOT lsof-then-elif-ss.
        //
        // Verified on a real Linux host while building this: `lsof` EXISTS
        // (so a `command -v lsof` test passes and an elif chain commits to
        // it) but prints NOTHING for an unprivileged user, while `ss` on the
        // same host prints every listening socket. An elif chain therefore
        // produced an EMPTY port table from a tool that was "available",
        // which would silently make the production-port predicate vacuous --
        // the precise "implicit environment decides behaviour, failure is
        // silent" shape this module must not have. Running both and unioning
        // removes the guess.
        //
        // Only when NEITHER tool exists is this a missing-tool failure.
        `if command -v lsof > /dev/null 2>&1; then lsof -nP -iTCP -sTCP:LISTEN -Fpn | sed -e 's/^/${PORT_LSOF_PREFIX} /'; fi;`,
        `if command -v ss > /dev/null 2>&1; then ss -H -l -t -n -p | sed -e 's/^/${PORT_SS_PREFIX} /'; fi;`,
        `if ! command -v lsof > /dev/null 2>&1 && ! command -v ss > /dev/null 2>&1; then echo '${MISSING_TOOL_PREFIX} lsof'; fi`,
    ].join(' ');
}

/** Marks the start of one pid's POSIX kill attempt in the kill dispatch's
 *  output: `SWEEP-KILL-BEGIN <pid>`. Any line between this and the matching
 *  `SWEEP-KILL-STATUS` line is that pid's `kill` stderr text, if any. */
export const KILL_BEGIN_PREFIX = 'SWEEP-KILL-BEGIN';
/** Reports one pid's POSIX kill exit status: `SWEEP-KILL-STATUS <pid> <code>`. */
export const KILL_STATUS_PREFIX = 'SWEEP-KILL-STATUS';

/** The standard POSIX strerror(ESRCH) text ("No such process"), which `kill`
 *  prints -- via bash's builtin, POSIX kill(1), BSD kill, or busybox ash, all
 *  of which agree on this exact phrase -- when a pid it was asked to signal
 *  no longer exists. Matched case-insensitively for portability across shells
 *  that vary only in surrounding punctuation ("kill: (PID): No such process"
 *  vs "bash: line 1: kill: (PID) - No such process" vs "kill: PID: No such
 *  process" on BSD/macOS). */
const ESRCH_TEXT_RE = /no such process/i;

/**
 * The kill command for an EXPLICIT list of pids that has already survived
 * every safety predicate. Every pid is validated as a positive integer before
 * it is allowed anywhere near a command string, so no caller can splice text
 * into the dispatched command through this path.
 *
 * POSIX kills EACH PID INDIVIDUALLY and reports its own exit status, rather
 * than one shared `kill -9 <pids>` -- apra-fleet-i4ku.3: a shared invocation
 * fails as a WHOLE the instant any single pid has already exited (a benign
 * race -- the process could have died between the probe dispatch and this
 * kill dispatch, which is exactly the outcome the sweep wanted), turning that
 * race into a loud member-prep failure. Per-pid begin/status markers let
 * parseKillOutput() tell "already gone" (tolerate) apart from "refused"
 * (permission denied -- must stay loud) without any command substitution
 * ("$(" is forbidden in a member-bound command string -- see
 * shell-command-guard.mjs): `$?` is the invoking shell's OWN exit-status
 * variable, evaluated on the member exactly like PowerShell's `$_` is in the
 * win32 probe branch, never an orchestrator-side value left for the member
 * shell to expand.
 *
 * win32 already tolerates an already-gone pid via `-ErrorAction
 * SilentlyContinue` and needs no equivalent change.
 *
 * @param {'win32'|'posix'} family
 * @param {number[]} pids
 * @returns {string}
 */
export function buildKillCommand(family, pids) {
    if (!Array.isArray(pids) || pids.length === 0) {
        throw new TypeError('buildKillCommand(family, pids): pids must be a non-empty array');
    }
    const clean = pids.map((pid) => {
        const n = Number(pid);
        if (!Number.isInteger(n) || n <= 1) {
            throw new TypeError(`buildKillCommand: refusing to build a kill command for pid ${JSON.stringify(pid)}`);
        }
        return n;
    });
    if (family === 'win32') {
        return seWindows.wrapForMember(`Stop-Process -Id ${clean.join(',')} -Force -ErrorAction SilentlyContinue`);
    }
    return clean.map((pid) => [
        `echo '${KILL_BEGIN_PREFIX} ${pid}'`,
        // stderr redirected onto stdout with a plain "2>&1" -- not captured
        // via "$(...)" -- so any "No such process" / "Operation not
        // permitted" text simply appears in the dispatch's combined output
        // between this pid's BEGIN and STATUS lines.
        `kill -9 ${pid} 2>&1`,
        `echo "${KILL_STATUS_PREFIX} ${pid} $?"`, // shell-guard-allow: $? is the invoking POSIX shell's OWN exit-status variable for the `kill -9 ${pid} 2>&1` immediately above in this same dispatch, evaluated on the member -- mirrors buildProbeCommand's PowerShell $_ carve-out just above in this file; never an orchestrator-side value left for an unknown member shell to expand. See this function's own doc comment.
    ].join('; ')).join('; ');
}

/**
 * Parse a POSIX kill dispatch's output (built by buildKillCommand()) into
 * which selected pids had ALREADY EXITED before this dispatch ran (tolerate)
 * versus which ones this sweep genuinely failed to kill (stay loud).
 *
 * A pid with no STATUS line at all (a truncated or malformed dispatch output)
 * is treated as a failure, never a silent success -- the same "I could not
 * tell" -> "do not report clean" discipline this module uses everywhere else.
 *
 * @param {string} output raw combined stdout/stderr from the kill dispatch
 * @param {number[]} pids the pids this dispatch was built for
 * @returns {{ gone: number[], failed: Array<{ pid: number, detail: string }> }}
 */
export function parseKillOutput(output, pids) {
    const detailByPid = new Map();
    const statusByPid = new Map();
    let currentPid = null;
    let detailLines = [];
    const flush = () => {
        if (currentPid != null) detailByPid.set(currentPid, detailLines.join(' ').trim());
    };

    for (const raw of String(output || '').split('\n')) {
        const line = raw.replace(/\r$/, '');
        if (line.startsWith(`${KILL_BEGIN_PREFIX} `)) {
            flush();
            currentPid = Number(line.slice(KILL_BEGIN_PREFIX.length + 1).trim());
            detailLines = [];
            continue;
        }
        if (line.startsWith(`${KILL_STATUS_PREFIX} `)) {
            const [pidText, codeText] = line.slice(KILL_STATUS_PREFIX.length + 1).trim().split(/\s+/);
            const pid = Number(pidText);
            if (pid === currentPid) flush();
            statusByPid.set(pid, Number(codeText));
            currentPid = null;
            detailLines = [];
            continue;
        }
        if (currentPid != null && line.trim()) detailLines.push(line.trim());
    }

    const gone = [];
    const failed = [];
    for (const pid of pids) {
        const code = statusByPid.get(pid);
        if (code === 0) continue;
        const detail = detailByPid.get(pid) || '';
        if (code === undefined) {
            failed.push({ pid, detail: detail || '(no kill status reported for this pid)' });
        } else if (ESRCH_TEXT_RE.test(detail)) {
            gone.push(pid);
        } else {
            failed.push({ pid, detail: detail || `kill exited ${code}` });
        }
    }
    return { gone, failed };
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/**
 * Convert a POSIX `ps` etime field (`[[dd-]hh:]mm:ss`) to seconds. Returns
 * null when the field is not an elapsed time at all, so a malformed row
 * becomes a record with an unknown start time rather than a confident wrong
 * one.
 *
 * @param {string} etime
 * @returns {number|null}
 */
export function parseElapsedSeconds(etime) {
    const text = String(etime == null ? '' : etime).trim();
    if (!text) return null;
    const dashIdx = text.indexOf('-');
    let days = 0;
    let rest = text;
    if (dashIdx >= 0) {
        days = Number(text.slice(0, dashIdx));
        rest = text.slice(dashIdx + 1);
        if (!Number.isFinite(days)) return null;
    }
    const parts = rest.split(':');
    if (parts.length < 2 || parts.length > 3) return null;
    const nums = parts.map((p) => Number(p));
    if (nums.some((n) => !Number.isFinite(n))) return null;
    const [h, m, s] = parts.length === 3 ? nums : [0, nums[0], nums[1]];
    return (((days * 24) + h) * 60 + m) * 60 + s;
}

/** Record `port` against `pid`. Returns true when the row was attributable
 *  (both a real pid and a real port), which is what the caller counts. */
function pushPort(map, pid, port) {
    if (!Number.isInteger(pid) || !Number.isInteger(port)) return false;
    if (!map.has(pid)) map.set(pid, []);
    const list = map.get(pid);
    if (!list.includes(port)) list.push(port);
    return true;
}

/** Pull the port out of a `host:port` / `[::1]:port` / `*:port` address. */
function portFromAddress(address) {
    const text = String(address || '').trim();
    const idx = text.lastIndexOf(':');
    if (idx < 0) return null;
    const port = Number(text.slice(idx + 1));
    return Number.isInteger(port) ? port : null;
}

/**
 * Parse one probe dispatch's output into `{ processes, listeners }`.
 *
 * THROWS rather than returning an empty result when the member could not be
 * enumerated -- a `SWEEP-NOTOOL` line, or output with no process rows at all
 * (a working `ps` always reports at least itself, so zero rows means the probe
 * did not run, not that the member is clean).
 *
 * It ALSO reports whether listening sockets could be attributed to pids at
 * all (`portsKnown`) -- see the PORT ATTRIBUTION note below.
 *
 * @param {string} output raw combined stdout/stderr from the probe dispatch
 * @param {{ nowMs?: number, memberName?: string|null }} [opts]
 * @returns {{ processes: Array<object>, listeners: Array<{pid:number, port:number}>,
 *             portsKnown: boolean, portRowsSeen: number }}
 */
export function parseProbeOutput(output, opts = {}) {
    const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    const memberName = opts.memberName ?? null;
    const processes = [];
    const portsByPid = new Map();
    let lsofPid = null;
    // PORT ATTRIBUTION. Counted separately from the ports themselves because
    // "no process is listening" and "I am not allowed to see who is
    // listening" are different facts with opposite safety consequences.
    // Verified on a real Linux host: an unprivileged `ss -ltnp` prints every
    // listening PORT but omits the `users:((...pid=N...))` column for
    // processes owned by other users, and an unprivileged `lsof` printed
    // nothing at all. Treating either as "this process is not on a
    // production port" would be a false negative on a SAFETY predicate.
    let portRowsSeen = 0;
    let portRowsAttributed = 0;

    for (const raw of String(output || '').split('\n')) {
        const line = raw.replace(/\r$/, '');
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith(`${MISSING_TOOL_PREFIX} `)) {
            throw new StrayProbeToolMissingError(trimmed.slice(MISSING_TOOL_PREFIX.length + 1).trim(), memberName);
        }

        if (trimmed.startsWith(`${PROC_WIN_LINE_PREFIX} `)) {
            // Windows: pid|ppid|epochSeconds|commandLine. Only the first
            // three fields are positional; the command line is whatever
            // remains, rejoined, so a pipe inside it survives intact.
            // apra-fleet-i4ku.4: startText is the literal sentinel '-' for a
            // process whose CreationDate was null on the member (a few
            // system processes) -- Number('-') is NaN, so it falls through to
            // startedAtMs: null below exactly like any other unparseable
            // value. The row's pid/ppid are NOT dropped, unlike the old
            // Where-Object filter this replaced: this pid still contributes
            // to the live-pid set computeParentGone() consults, so its
            // children are not wrongly judged orphaned.
            const body = trimmed.slice(PROC_WIN_LINE_PREFIX.length + 1).trim();
            const [pidText, ppidText, startText, ...cmdParts] = body.split('|');
            const pid = Number(pidText);
            if (!Number.isInteger(pid)) continue;
            const startedAtSec = Number(startText);
            processes.push({
                pid,
                ppid: Number.isInteger(Number(ppidText)) ? Number(ppidText) : null,
                startedAtMs: Number.isFinite(startedAtSec) ? startedAtSec * 1000 : null,
                commandLine: cmdParts.join('|').trim(),
            });
            continue;
        }

        if (trimmed.startsWith(`${PROC_LINE_PREFIX} `)) {
            const body = trimmed.slice(PROC_LINE_PREFIX.length + 1).trim();
            // POSIX: pid ppid etime args...
            const m = /^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(body);
            if (!m) continue;
            const elapsed = parseElapsedSeconds(m[3]);
            processes.push({
                pid: Number(m[1]),
                ppid: Number(m[2]),
                startedAtMs: elapsed == null ? null : nowMs - (elapsed * 1000),
                commandLine: m[4].trim(),
            });
            continue;
        }

        if (trimmed.startsWith(`${PORT_WIN_PREFIX} `)) {
            const [pidText, portText] = trimmed.slice(PORT_WIN_PREFIX.length + 1).trim().split('|');
            portRowsSeen += 1;
            if (pushPort(portsByPid, Number(pidText), Number(portText))) portRowsAttributed += 1;
            continue;
        }

        if (trimmed.startsWith(`${PORT_LSOF_PREFIX} `)) {
            // lsof -F emits a pid line ("p" + pid) followed by one address
            // line ("n" + address) per socket owned by that pid, so the pid
            // is carried forward across the address lines that follow it.
            const body = trimmed.slice(PORT_LSOF_PREFIX.length + 1).trim();
            if (body.startsWith('p')) {
                const pid = Number(body.slice(1));
                lsofPid = Number.isInteger(pid) ? pid : null;
            } else if (body.startsWith('n')) {
                portRowsSeen += 1;
                if (lsofPid != null && pushPort(portsByPid, lsofPid, portFromAddress(body.slice(1)))) {
                    portRowsAttributed += 1;
                }
            }
            continue;
        }

        if (trimmed.startsWith(`${PORT_SS_PREFIX} `)) {
            // ss -H -l -t -n -p row:
            //   LISTEN 0 4096 0.0.0.0:8787 0.0.0.0:* users:(("node",pid=12,fd=20))
            const body = trimmed.slice(PORT_SS_PREFIX.length + 1).trim();
            const fields = body.split(/\s+/);
            const port = portFromAddress(fields[3]);
            if (port == null) continue;
            portRowsSeen += 1;
            // An unprivileged ss omits the users:((...pid=N...)) column, so
            // this loop legitimately runs zero times -- which is what makes
            // the seen/attributed split load-bearing rather than cosmetic.
            for (const pidMatch of body.matchAll(/pid=(\d+)/g)) {
                if (pushPort(portsByPid, Number(pidMatch[1]), port)) portRowsAttributed += 1;
            }
            continue;
        }
    }

    if (processes.length === 0) {
        // NOTE: built by concatenation rather than a nested template literal
        // on purpose -- shell-command-guard.mjs's segmenter is deliberately
        // single-line, so an inner backtick closes the outer template segment
        // and its `${...}` is then misread as a braced expansion surviving
        // into a dispatched command string. This is an error message, not a
        // command, so the clearer fix is to not nest rather than to suppress.
        const where = memberName ? ` for member '${memberName}'` : '';
        throw new StrayProbeError(
            `stray-process sweep probe returned no process rows${where}. `
            + 'A working process table always lists at least the probe itself, so this is a failed probe, '
            + 'not a clean member. Refusing to report the member as clean.',
        );
    }

    const listeners = [];
    for (const [pid, ports] of portsByPid) {
        for (const port of ports) listeners.push({ pid, port });
    }
    // portsKnown is FALSE both when the port table was empty and when it had
    // rows none of which named a pid. Only an actually-attributed table lets
    // the production-port predicate mean anything.
    return {
        processes, listeners, portsKnown: portRowsAttributed > 0, portRowsSeen,
    };
}

/**
 * Is `record`'s parent process gone?
 *
 * Every direction of doubt resolves to "the parent is still alive", because
 * that direction leaves the process alone.
 *
 *  - an unknown/absent ppid -> NOT gone;
 *  - ppid <= 1 -> gone: the process has been reparented to init (POSIX), and
 *    on Windows pid 0 is the idle process, which is never a real parent;
 *  - otherwise gone only when the ppid is absent from the LIVE pid set the
 *    same probe enumerated. Pid reuse can make a dead parent's id look live,
 *    which again errs toward leaving the process alone.
 *
 * @param {{ ppid: number|null }} record
 * @param {Set<number>} livePids
 * @returns {boolean}
 */
export function computeParentGone(record, livePids) {
    const ppid = record && record.ppid;
    if (!Number.isInteger(ppid)) return false;
    if (ppid <= 1) return true;
    return !livePids.has(ppid);
}

/**
 * Join the probe's two tables into the candidate records the decision
 * function consumes: each process annotated with whether its parent is gone
 * and which TCP ports it is listening on.
 *
 * `portsKnown` is carried onto every record rather than passed separately to
 * the decision, so the kill decision stays a function of exactly the three
 * things it is specified to depend on -- member locality, ONE candidate
 * record, and the production port set -- with "were listening ports
 * observable at all?" being part of what the record says about itself.
 *
 * @param {Array<object>} processes
 * @param {Array<{pid:number, port:number}>} listeners
 * @param {{ portsKnown?: boolean }} [opts]
 * @returns {Array<object>}
 */
export function annotateCandidates(processes, listeners = [], opts = {}) {
    const portsKnown = opts.portsKnown === true;
    const livePids = new Set(processes.map((p) => p.pid));
    const portsByPid = new Map();
    for (const l of listeners) {
        if (!portsByPid.has(l.pid)) portsByPid.set(l.pid, []);
        if (!portsByPid.get(l.pid).includes(l.port)) portsByPid.get(l.pid).push(l.port);
    }
    return processes.map((p) => ({
        ...p,
        parentGone: computeParentGone(p, livePids),
        listeningPorts: portsByPid.get(p.pid) ?? [],
        portsKnown,
    }));
}

// ---------------------------------------------------------------------------
// The safety predicates
// ---------------------------------------------------------------------------

/**
 * Marker evidence classes. A marker describes something FLEET ITSELF put on
 * the command line of a process it started.
 *
 *   'path'  -- a member-scoped path fleet chose (a work folder, a data dir, a
 *              sandbox root). Strong evidence: an unrelated process does not
 *              carry fleet's own paths by coincidence.
 *   'flag'  -- an argument or token fleet passed (a run id, a sprint-scoped
 *              flag). Strong evidence for the same reason.
 *   'name'  -- a bare program/process name. NEVER sufficient on its own: an
 *              operator's own editor, shell or language runtime shares it.
 *              A name marker can label what a candidate IS, but only a
 *              'path'/'flag' marker can establish that fleet started it.
 */
export const MARKER_EVIDENCE_PATH = 'path';
export const MARKER_EVIDENCE_FLAG = 'flag';
export const MARKER_EVIDENCE_NAME = 'name';

const STRONG_EVIDENCE = new Set([MARKER_EVIDENCE_PATH, MARKER_EVIDENCE_FLAG]);

function markerHit(commandLine, token, caseInsensitive) {
    const hay = caseInsensitive ? commandLine.toLowerCase() : commandLine;
    const needle = caseInsensitive ? String(token).toLowerCase() : String(token);
    return needle.length > 0 && hay.includes(needle);
}

/**
 * Decide whether a candidate is a process FLEET started, and on what
 * evidence.
 *
 * THE RULE THIS ENCODES: never by process name alone. A candidate is
 * fleet-started only when at least one 'path'/'flag' marker matches its
 * command line. A 'name'-only match is reported (`nameOnly: true`) so a
 * caller can see what was considered and rejected, but it is not evidence.
 *
 * @param {{ commandLine: string }} record
 * @param {Array<{ kind: string, token: string, evidence: string }>} markers
 * @param {{ caseInsensitive?: boolean }} [opts] Windows command lines and
 *        paths are case-insensitive; POSIX ones are not.
 * @returns {{ fleetStarted: boolean, kind: string|null, nameOnly: boolean,
 *             matched: Array<object> }}
 */
export function classifyFleetEvidence(record, markers = [], opts = {}) {
    const caseInsensitive = opts.caseInsensitive === true;
    const commandLine = String((record && record.commandLine) || '');
    const matched = (Array.isArray(markers) ? markers : []).filter(
        (m) => m && markerHit(commandLine, m.token, caseInsensitive),
    );
    const strong = matched.filter((m) => STRONG_EVIDENCE.has(m.evidence));
    return {
        fleetStarted: strong.length > 0,
        kind: (strong[0] && strong[0].kind) || (matched[0] && matched[0].kind) || null,
        nameOnly: strong.length === 0 && matched.length > 0,
        matched,
    };
}

/** Kill. Only ever returned for a remote member. */
export const ACTION_KILL = 'kill';
/** Do not kill; surface as a candidate an operator may want to look at. */
export const ACTION_REPORT_ONLY = 'report-only';
/** Not a candidate at all. */
export const ACTION_LEAVE = 'leave';

/**
 * A candidate younger than this is reported, never killed, even when every
 * other predicate says "stray". WHY 60s rather than something shorter: the
 * hazard this guards against (apra-fleet-i4ku.5) is a daemonized fleet
 * process -- ppid 1, so computeParentGone() is true INSTANTLY -- started by a
 * DIFFERENT, concurrently-starting sprint sharing this member mere seconds
 * before this sweep's probe dispatch ran. A one-shot spawn+immediate-exit
 * race is sub-second; 60s leaves comfortable headroom over that without
 * meaningfully delaying the cleanup of a process that really is stale (a
 * stray left behind by a PRIOR sprint is, by definition, at least as old as
 * the time between that sprint ending and this one's member-prep running,
 * which is minutes at the very least).
 */
export const DEFAULT_MIN_AGE_MS = 60 * 1000;

/**
 * THE KILL DECISION. Pure: a function of member locality, one candidate
 * process record, the production port set, a minimum-age bound and the
 * caller's own notion of "now" (`nowMs`). It reads no clock of its own, no
 * environment and no filesystem, and it executes nothing -- which is what
 * makes every predicate below directly assertable without a process existing.
 * `nowMs` is an ordinary input like `productionPorts`, never `Date.now()`
 * read from inside this function.
 *
 * A candidate is killed only when ALL of these hold:
 *   - the member is remote (memberLocality());
 *   - fleet started the process, on more than a name (classifyFleetEvidence());
 *   - its parent process is gone (computeParentGone(), via annotateCandidates);
 *   - it is listening on NONE of the caller's production ports, AND its
 *     listening ports were actually observable (`record.portsKnown`);
 *   - its age (nowMs - record.startedAtMs) is known AND at least `minAgeMs`.
 *
 * Two levels of "no":
 *   ACTION_LEAVE       -- not a stray fleet process at all, or explicitly
 *                         protected by holding a production port.
 *   ACTION_REPORT_ONLY -- it IS a stray fleet process, but this sweep is not
 *                         allowed to act: the member is not verifiably remote,
 *                         the production-port predicate could not be
 *                         evaluated, or the process is too young (or its start
 *                         time is unknown) to trust the parent-gone race has
 *                         actually settled. `sparedReasons` says which.
 *
 * For a LOCAL member (which, per memberLocality(), also covers relay and
 * unknown types) a would-be kill is downgraded to ACTION_REPORT_ONLY. There is
 * no input to this function that makes it return ACTION_KILL for a
 * non-remote member.
 *
 * @param {{
 *   locality: 'remote'|'local',
 *   record: object,
 *   productionPorts?: Array<number>,
 *   markers?: Array<object>,
 *   caseInsensitive?: boolean,
 *   minAgeMs?: number,
 *   nowMs?: number,
 * }} input
 * @returns {{ pid, commandLine, startedAtMs, startTime, action, kind,
 *             parentGone, listeningPorts, productionPortHits, selectionReason,
 *             sparedReasons }}
 */
export function decideStrayProcess(input = {}) {
    const {
        locality, record = {}, productionPorts = [], markers = [], caseInsensitive = false,
        minAgeMs = DEFAULT_MIN_AGE_MS, nowMs,
    } = input;

    const evidence = classifyFleetEvidence(record, markers, { caseInsensitive });
    const listeningPorts = Array.isArray(record.listeningPorts) ? record.listeningPorts : [];
    const productionPortSet = new Set(
        (Array.isArray(productionPorts) ? productionPorts : []).map((p) => Number(p)).filter(Number.isInteger),
    );
    const productionPortHits = listeningPorts.filter((p) => productionPortSet.has(Number(p)));
    const parentGone = record.parentGone === true;

    // CANDIDACY predicates -- "is this a stray fleet process at all?". Failing
    // either means the process is not ours to touch and is LEFT ALONE, with
    // no candidate reported.
    const sparedReasons = [];
    if (!evidence.fleetStarted) {
        sparedReasons.push(evidence.nameOnly
            ? 'matched a process-name marker only, which is never evidence that fleet started it'
            : 'no evidence that fleet started this process');
    }
    if (!parentGone) sparedReasons.push(`parent pid ${record.ppid == null ? 'unknown' : record.ppid} is still alive`);
    // The production-port guard is also LEAVE, not report-only: a process
    // holding a production port is explicitly protected, not a candidate an
    // operator should be nudged to reap.
    if (productionPortHits.length > 0) {
        sparedReasons.push(`listening on production port(s) ${productionPortHits.join(', ')}`);
    }

    const startedAtMs = Number.isFinite(record.startedAtMs) ? record.startedAtMs : null;
    const base = {
        pid: record.pid,
        ppid: record.ppid ?? null,
        commandLine: String(record.commandLine || ''),
        startedAtMs,
        startTime: startedAtMs == null ? 'unknown' : new Date(startedAtMs).toISOString(),
        kind: evidence.kind,
        parentGone,
        listeningPorts,
        productionPortHits,
        evidence,
    };

    if (sparedReasons.length > 0) {
        return { ...base, action: ACTION_LEAVE, selectionReason: null, sparedReasons };
    }

    const matchedTokens = evidence.matched
        .filter((m) => STRONG_EVIDENCE.has(m.evidence))
        .map((m) => `${m.kind} via ${m.evidence} marker '${m.token}'`)
        .join('; ');
    const selectionReason = `fleet-started (${matchedTokens}); `
        + `parent pid ${record.ppid == null ? 'unknown' : record.ppid} is gone; `
        + `not listening on any production port (listening: ${listeningPorts.length ? listeningPorts.join(', ') : 'none'})`;

    // It IS a stray fleet process. Now the KILL-SAFETY predicates decide
    // whether this sweep is allowed to act on it or may only report it.
    const blockers = [];
    if (locality !== LOCALITY_REMOTE) {
        blockers.push('member is not a verified remote member, so the sweep reports rather than kills');
    }
    if (record.portsKnown !== true) {
        // "No production-port hit" only means something if listening ports
        // were observable at all. When they were not, an empty hit list is
        // absence of evidence, not evidence of absence -- so the
        // production-port predicate has NOT been satisfied and this stays a
        // report.
        blockers.push(
            'listening ports could not be attributed to processes on this member (the socket probe needs '
            + 'elevated privileges to name the owning process), so the production-port predicate could not '
            + 'be evaluated',
        );
    }
    // Minimum-age guard: a process whose start time is unknown, or that is
    // younger than minAgeMs, might be a fresh process a DIFFERENT,
    // concurrently-starting sprint just launched on this same member -- see
    // DEFAULT_MIN_AGE_MS. Every direction of doubt (unknown startedAtMs,
    // unknown nowMs) resolves to "too young to trust", matching this
    // module's fail-safe convention elsewhere.
    const ageMs = (startedAtMs != null && Number.isFinite(nowMs)) ? (nowMs - startedAtMs) : null;
    if (ageMs == null) {
        blockers.push(
            'process start time (or the sweep\'s reference clock) is unknown, so the minimum-age safety '
            + 'predicate could not be evaluated',
        );
    } else if (ageMs < minAgeMs) {
        blockers.push(
            `process is younger than the minimum age bound (${Math.floor(ageMs / 1000)}s old, `
            + `bound ${Math.floor(minAgeMs / 1000)}s) -- it may belong to a different, still-starting sprint `
            + 'on this same member',
        );
    }

    return {
        ...base,
        action: blockers.length === 0 ? ACTION_KILL : ACTION_REPORT_ONLY,
        selectionReason,
        sparedReasons: blockers,
    };
}

/**
 * The kill log line. Carries pid, command line, start time and the selection
 * reason, so a killed process is always accountable after the fact.
 *
 * @param {string} memberName
 * @param {object} decision as returned by decideStrayProcess()
 * @returns {string}
 */
export function formatStrayKillLog(memberName, decision) {
    return `[member-stray-sweep] KILLED a stray fleet process on member '${memberName}' `
        + `(pid ${decision.pid}, started ${decision.startTime}, `
        + `reason: ${decision.selectionReason}, cmd: ${decision.commandLine})`;
}

// ---------------------------------------------------------------------------
// Orchestration (the only part that touches the injected execution seam)
// ---------------------------------------------------------------------------

/**
 * Sweep ONE member. Probe, decide, then kill only the pids that survived
 * every predicate.
 *
 * Everything that could be a judgement call is an INPUT: `markers` (what
 * counts as a fleet-started process on this target), `productionPorts` (the
 * member's production fleet/supervisor ports) and `execCommand` (the
 * execution seam). Nothing here is hardcoded, which is what lets the whole
 * safety matrix be driven from a test with no process anywhere.
 *
 * It THROWS on any probe failure -- a member it could not look at is never
 * reported as clean.
 *
 * @param {{
 *   member: { name?: string, id?: string, os?: string, type?: string, agentType?: string },
 *   markers?: Array<{ kind: string, token: string, evidence: string }>,
 *   productionPorts?: Array<number>,
 *   minAgeMs?: number,
 *   execCommand: (opts: { member: string, command: string, kind: 'probe'|'kill' }) => Promise<{ ok?: boolean, output?: string, error?: string }>,
 *   now?: () => number,
 *   logger?: { log?: Function, error?: Function },
 * }} deps
 */
export async function sweepMemberStrayProcesses(deps = {}) {
    const {
        member = {}, markers = [], productionPorts = [], minAgeMs = DEFAULT_MIN_AGE_MS, execCommand,
        now = () => Date.now(), logger = console,
    } = deps;

    if (typeof execCommand !== 'function') {
        throw new TypeError('sweepMemberStrayProcesses: execCommand seam is required');
    }
    const name = member.name || member.id;
    if (!name) throw new TypeError('sweepMemberStrayProcesses: member must carry a name or id');

    const log = (...a) => (logger.log ?? (() => {}))(...a);
    const logError = (...a) => (logger.error ?? logger.log ?? (() => {}))(...a);

    const family = memberShellFamily(member.os);
    const locality = memberLocality(member);
    const caseInsensitive = family === 'win32';

    let probe;
    try {
        // `kind` (apra-fleet-i4ku.12) carries the dispatch INTENT through the
        // seam so an adapter can label/audit a read-only probe and a kill
        // differently. It is PURELY descriptive: the `command` string is
        // unchanged, so what actually runs on the member is byte-identical.
        // Optional by contract -- an adapter that ignores it behaves exactly
        // as before.
        probe = await execCommand({ member: name, command: buildProbeCommand(family), kind: EXEC_KIND_PROBE });
    } catch (err) {
        throw new StrayProbeError(
            `stray-process sweep probe could not run on member '${name}': ${err && err.message ? err.message : err}`,
        );
    }
    if (probe && probe.ok === false) {
        throw new StrayProbeError(`stray-process sweep probe failed on member '${name}': ${probe.error}`);
    }

    // Captured ONCE and reused for both the probe's etime->startedAtMs
    // conversion and the minimum-age decision below, so every record in this
    // pass is judged against the same reference instant.
    const nowMs = now();
    const { processes, listeners, portsKnown } = parseProbeOutput(probe && (probe.output || probe.error), {
        nowMs,
        memberName: name,
    });
    if (!portsKnown) {
        logError(
            `[member-stray-sweep] member '${name}': listening sockets could not be attributed to processes `
            + '(the socket probe needs elevated privileges to name the owning process). The production-port '
            + 'safety predicate cannot be evaluated, so this pass will REPORT candidates and kill nothing.',
        );
    }
    const records = annotateCandidates(processes, listeners, { portsKnown });
    const decisions = records.map((record) => decideStrayProcess({
        locality, record, productionPorts, markers, caseInsensitive, minAgeMs, nowMs,
    }));

    const toKill = decisions.filter((d) => d.action === ACTION_KILL);
    const reported = decisions.filter((d) => d.action === ACTION_REPORT_ONLY);

    let killed = [];
    // Selected pids that turned out to have ALREADY EXITED before the kill
    // dispatch ran (apra-fleet-i4ku.3's benign probe/kill race) -- reported
    // separately from `killed`, never folded into it. Before apra-fleet-
    // i4ku.9, `killed` was set to the FULL `toKill` list regardless of this
    // set, so `result.killed.length` over-reported: the per-pid LOG lines
    // already skipped an already-gone pid (see the loop below), but the
    // returned count did not, contradicting its own log output and whatever
    // summary a caller (phases/member-prep.mjs) built from it.
    let alreadyGone = [];
    if (toKill.length > 0) {
        const killPids = toKill.map((d) => d.pid);
        const killCommand = buildKillCommand(family, killPids);
        let res;
        try {
            // kind: 'kill' -- the accountability this dispatch needs. Before
            // apra-fleet-i4ku.12 this arrived at the same adapter as the probe
            // above with no way to tell the two apart, so a kill was recorded
            // in the sprint log and ledger as a probe. Descriptive only:
            // `killCommand` is unchanged.
            res = await execCommand({ member: name, command: killCommand, kind: EXEC_KIND_KILL });
        } catch (err) {
            throw new StrayProbeError(
                `stray-process sweep could not kill ${toKill.length} selected process(es) on member '${name}': `
                + `${err && err.message ? err.message : err}`,
            );
        }
        if (res && res.ok === false) {
            throw new StrayProbeError(
                `stray-process sweep could not kill ${toKill.length} selected process(es) on member '${name}': ${res.error}`,
            );
        }
        // POSIX only: tell a pid that had ALREADY EXITED before this dispatch
        // ran (a benign probe/kill race -- apra-fleet-i4ku.3) apart from a
        // pid this sweep genuinely failed to kill (e.g. permission denied),
        // which must still abort loudly. win32's Stop-Process is already
        // tolerant of the same race via -ErrorAction SilentlyContinue and
        // needs no equivalent parse.
        let goneSet = new Set();
        if (family === 'posix') {
            const { gone, failed } = parseKillOutput(res && (res.output || res.error), killPids);
            if (failed.length > 0) {
                throw new StrayProbeError(
                    `stray-process sweep could not kill ${failed.length} of ${toKill.length} selected process(es) `
                    + `on member '${name}': ${failed.map((f) => `pid ${f.pid} (${f.detail})`).join('; ')}`,
                );
            }
            if (gone.length > 0) {
                goneSet = new Set(gone);
                logError(
                    `[member-stray-sweep] member '${name}': ${gone.length} selected process(es) had already `
                    + `exited before the kill dispatch ran (benign race) and needed no signal: pid(s) ${gone.join(', ')}`,
                );
            }
        }
        // Split, not filtered-then-discarded: an already-gone pid is real
        // information about what this pass found (it WAS a selected stray
        // candidate), just not something this dispatch had to signal --
        // apra-fleet-i4ku.9 pulls it out of `killed` into its own bucket
        // rather than dropping it, so a caller can still account for it.
        killed = toKill.filter((d) => !goneSet.has(d.pid));
        alreadyGone = toKill.filter((d) => goneSet.has(d.pid));
        // A pid the tolerant path above already logged as "already exited"
        // is not ALSO logged as KILLED -- the two lines would contradict each
        // other about what actually happened to that pid. `killed` no longer
        // contains it at all, so this loop needs no goneSet re-check.
        for (const decision of killed) {
            logError(formatStrayKillLog(name, decision));
        }
    }

    if (reported.length > 0) {
        logError(
            `[member-stray-sweep] member '${name}': ${reported.length} stray fleet process(es) were REPORTED `
            + 'and NOT killed: '
            + reported.map((d) => `pid ${d.pid}, started ${d.startTime} (${d.commandLine}) -- `
                + `${d.sparedReasons.join('; ')}`).join(' | '),
        );
    }
    if (killed.length === 0 && reported.length === 0 && alreadyGone.length === 0) {
        log(`[member-stray-sweep] member '${name}': ${records.length} process(es) scanned, no stray fleet processes found.`);
    }

    return {
        member: name,
        locality,
        family,
        scanned: records.length,
        candidates: decisions,
        killed,
        alreadyGone,
        reported,
    };
}
