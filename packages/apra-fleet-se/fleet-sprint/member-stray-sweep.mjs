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
//   7. LIVENESS PROBE (apra-fleet-i4ku.17, OPT-IN). Predicate 4 above is only
//      as good as the caller's static `productionPorts` list -- which cannot
//      enumerate a supervisor started on a non-default port, or a sprint
//      child's allocateFreePort() viewer port. Both are daemonized (ppid 1
//      the instant their own parent restarts -- exactly the re-adoption
//      window src/supervisor/readopt.mjs exists for), so predicate 3 is
//      satisfied instantly too, leaving only the port list standing between
//      a live process and a kill. When the caller opts in (`livenessProbe`
//      on sweepMemberStrayProcesses()), every candidate that survived every
//      OTHER predicate gets a SECOND dispatch -- a plain HTTP GET against
//      each port it still holds (buildLivenessProbeCommand()). Answering
//      ANY HTTP status at all is enough to spare it: this predicate asks
//      only "is anything still answering here", never what the response
//      says, so it makes no assumption about a target's own health-endpoint
//      shape. Fail-safe exactly like every predicate above: a probe that
//      could not be run at all (no curl/Invoke-WebRequest on the member, or
//      the second dispatch itself failing) spares the candidate too, rather
//      than silently falling back to killing it -- see
//      parseLivenessProbeOutput()'s `evaluable` and decideStrayProcess()'s
//      `record.liveProbe` handling.
//      WHAT IT CANNOT PROTECT (apra-fleet-i4ku.17): a candidate holding NO
//      listening port. "Is anything still answering here" has no answer for
//      a portless process, so this predicate never applies to one and never
//      changes its fate -- such a candidate is killed on the other six
//      predicates exactly as it was before this predicate existed. That is
//      NOT the fail-safe `unevaluable` case (asked, could not find out ->
//      spare); it is its own `unprobeable` bucket on the result, counted per
//      candidate and never dependent on whether some OTHER candidate in the
//      same pass happened to hold a port. It is a kill that was never
//      checked, so the phase narrates it as one rather than letting it hide
//      inside an otherwise reassuring liveness summary.
//      WHO TURNS IT ON (apra-fleet-i4ku.17): this module stays opt-in --
//      `livenessProbe` defaults to null here, so a direct caller gets the
//      pre-predicate behaviour byte for byte. The SHIPPED sweep path is
//      armed anyway, because phases/member-prep.mjs's runSweepStep() treats
//      an unstated option as ARMED and only an explicit `false` disarms it;
//      that decision, and the rejected alternative, are documented in that
//      file's header ("LIVENESS PROBE: ARMED BY DEFAULT -- DECIDED") and in
//      docs/member-prep-and-stray-sweep.md. The caller-facing option shape
//      is validated in ONE place, normalizeLivenessProbeOption() below,
//      which every config/CLI/args boundary that carries it imports.
//      WHICH ADDRESS IS ASKED (apra-fleet-i4ku.21) -- DECIDED: OPTION (a),
//      PROBE THE ADDRESS THE SOCKET ACTUALLY HOLDS. The probe used to build
//      http://127.0.0.1:<port> for every candidate on both shell families,
//      because the listener table carried only { pid, port } -- the host half
//      of each bound address was read and thrown away. A process bound ONLY
//      to a specific interface (192.168.1.5:8080) answers nothing on
//      loopback, so curl returned its '000' sentinel, the candidate was
//      recorded as `no-response`, no blocker was added, and it was killed as
//      though the predicate had checked it and found it dead. That is the one
//      outcome this fail-safe predicate may never produce: "I asked the wrong
//      address" read as "there is nothing there".
//      The bound host now travels parseProbeOutput() -> listeners ->
//      annotateCandidates() -> buildLivenessProbeCommand() as
//      `probeHost`, and the probe asks THAT host. Option (b) (classify a
//      non-loopback-only candidate as `unprobeable`) was REJECTED:
//      `unprobeable` leaves the other predicates' verdict standing, which for
//      a surviving candidate is a KILL, so option (b) would have kept killing
//      the very live process this bead exists to spare -- it would only have
//      made the counters honest about it. Option (a) also costs nothing at
//      the wire: the host is already in every lsof/ss row, and Windows'
//      Get-NetTCPConnection already has LocalAddress.
//      WILDCARD BINDINGS STILL GO TO LOOPBACK: 0.0.0.0, ::, '*' and an empty
//      host mean "every interface", and loopback is an interface, so those
//      are probed on 127.0.0.1 exactly as before -- see
//      livenessProbeHost().
//      A PORT THAT ACCEPTS TCP BUT NEVER SPEAKS HTTP (apra-fleet-i4ku.24) --
//      DECIDED: TCP-ACCEPTED-BUT-NO-HTTP SPARES; TCP-REFUSED STILL KILLS.
//      "Answering ANY HTTP status at all" above was implemented with curl's
//      '000' sentinel as its whole negative case -- and '000' means only "no
//      HTTP response was received", which curl reports both for a REFUSED
//      connection (exit 7 -- nothing is listening, genuinely dead) and for a
//      connection that was ACCEPTED and then timed out or returned an empty
//      reply (exit 28/52 -- something IS holding the port, it just does not
//      speak HTTP, or not on this path, or not within the timeout). A live
//      non-HTTP listener -- a raw TCP service, a TLS-only port asked over
//      plain HTTP, a process still starting its server -- therefore looked
//      exactly like a dead port and was killed by a predicate whose entire
//      job is to prevent that. The probe wire format now carries a fourth
//      TRANSPORT-STATUS field so the two are different values end to end
//      (HEALTH_LINE_PREFIX, buildLivenessProbeCommand(),
//      parseLivenessProbeOutput()'s three-state outcome).
//      THE REJECTED ALTERNATIVE was to keep the kill and merely COUNT the
//      case honestly -- report "killed, TCP-alive but no HTTP" in the
//      summary. That is the same mistake option (b) made for the wrong-address
//      defect above: an accurate counter changes nothing about the process's
//      fate, so it would have gone on killing the very live process this work
//      exists to spare, while making the report sound rigorous about it. A
//      refusal is the only transport outcome that actually answers "there is
//      nothing there", so it is the only one that may still lead to a kill.
//      AN ADDRESS THIS MODULE CANNOT TURN INTO A URL (a hostname, a
//      zone-scoped link-local, anything that is not a plain IP literal) is
//      NOT silently probed on loopback and is NOT `unprobeable` either: a
//      socket exists, so there IS something to ask, and we merely cannot
//      phrase the question. That is the `unevaluable` case -- it spares. See
//      the `unresolvedSockets` field annotateCandidates() puts on each record
//      and the classification in sweepMemberStrayProcesses().
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
/**
 * `SWEEP-PORT-WIN <owningPid>|<localPort>|<localAddress>` (Windows).
 *
 * apra-fleet-i4ku.21: the third field carries the address the socket is
 * actually bound to, so the liveness probe can ask THAT host rather than
 * assuming loopback. A row with only the first two fields (the pre-i4ku.21
 * shape) still parses -- its port is attributed exactly as before -- but its
 * bound host is UNKNOWN rather than assumed to be loopback, which routes the
 * candidate to the fail-safe `unevaluable` branch instead of letting a probe
 * of the wrong address read as "nothing is there".
 */
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
                // apra-fleet-i4ku.21: LocalAddress is emitted as a third
                // field so the liveness probe can ask the address the socket
                // actually holds. Get-NetTCPConnection reports it as '0.0.0.0'
                // / '::' for a wildcard bind and as the literal interface
                // address otherwise -- exactly the distinction the probe needs.
                + " | ForEach-Object { 'SWEEP-PORT-WIN ' + $_.OwningProcess + '|' + $_.LocalPort + '|' + $_.LocalAddress }" // shell-guard-allow: PowerShell pipeline variable inside this module's own -EncodedCommand payload; see buildProbeCommand's doc comment.
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
// Liveness probe (apra-fleet-i4ku.17) -- the OPT-IN second dispatch that lets
// a candidate that survived every other kill predicate prove it is still a
// live, answering process before it is signalled. See this file's header,
// predicate 7.
// ---------------------------------------------------------------------------

/** `SWEEP-HEALTH <pid> <port> <httpStatusOr000> <transportStatus>` -- one
 *  liveness-probe result line. Built and emitted IDENTICALLY for both shell
 *  families (unlike the process/port tables): the value is computed in
 *  JavaScript-authored format strings on both sides, so there is no
 *  OS-specific shape for the parser to tell apart.
 *
 *  THE FOURTH FIELD IS WHY THIS PREDICATE IS HONEST: an HTTP status of
 *  `000` means "no HTTP response was received", which covers BOTH a refused
 *  connection (nothing is listening -- genuinely dead) and a connection that
 *  was ACCEPTED and then timed out or returned an empty reply (a live
 *  listener that does not speak HTTP). Those two were the same value until
 *  this field existed, so a live non-HTTP listener was read as dead and
 *  killed. The transport status separates them; see
 *  parseLivenessProbeOutput(). */
export const HEALTH_LINE_PREFIX = 'SWEEP-HEALTH';

/** The HTTP-status field's value when no HTTP response was received at all
 *  (curl's own sentinel; the win32 branch emits the same three characters so
 *  one parser rule serves both families). */
export const NO_HTTP_RESPONSE_CODE = '000';

/** Transport-status field values, deliberately spelled as CURL'S OWN exit
 *  codes so the POSIX branch can pass `$?` through untouched and the win32
 *  branch has one obvious, already-documented numbering to map its
 *  TcpClient outcome onto:
 *    0  -- the transport did its job (an HTTP response came back, or the TCP
 *          connection was accepted);
 *    7  -- could not connect: the port REFUSED the connection. The only
 *          value that means "nothing is listening here";
 *    28 -- connected far enough to wait, then ran out of time. NOT a refusal,
 *          so it resolves to the sparing outcome, matching this module's
 *          "I could not find out != there is nothing there" discipline. */
export const PROBE_STATUS_OK = '0';
export const PROBE_STATUS_REFUSED = '7';
export const PROBE_STATUS_TIMEOUT = '28';

/** The three-state outcome parseLivenessProbeOutput() reports per
 *  `${pid}:${port}`, most-alive first. The ORDER IS THE PRECEDENCE used when
 *  one pid holds the same port on more than one address: an address that
 *  answered HTTP can never be downgraded by a sibling that did not, and a
 *  TCP-alive result can never be downgraded by a refused sibling. */
export const LIVENESS_ANSWERED = 'answered';
export const LIVENESS_TCP_ALIVE_NO_HTTP = 'tcp-alive-no-http';
export const LIVENESS_REFUSED = 'refused';
const LIVENESS_OUTCOME_RANK = new Map([
    [LIVENESS_REFUSED, 0],
    [LIVENESS_TCP_ALIVE_NO_HTTP, 1],
    [LIVENESS_ANSWERED, 2],
]);

/** Default path requested by the liveness probe. Only whether SOMETHING
 *  answers HTTP here matters -- never the response body -- so a bare `/` is
 *  a safe, target-agnostic default; a caller may override it. */
export const DEFAULT_LIVENESS_PROBE_PATH = '/';

/** The host a WILDCARD-bound socket (0.0.0.0, ::, *) is probed on. Loopback
 *  is one of the interfaces such a socket is listening on, so asking it needs
 *  no assumption about the member's routing or its external address. It is
 *  NOT a default for sockets bound elsewhere -- see livenessProbeHost() and
 *  this file's header, "WHICH ADDRESS IS ASKED". */
export const LOOPBACK_PROBE_HOST = '127.0.0.1';

/** Default per-request timeout. Short and deliberately so: this predicate
 *  only ever runs against candidates already headed for a kill, and a
 *  slow/hanging probe must not stall the whole sweep pass over one of them. */
export const DEFAULT_LIVENESS_PROBE_TIMEOUT_MS = 2000;

/** Upper bound on a caller-supplied liveness-probe timeout. This predicate
 *  runs inline in Member Prep, once per member, before the sprint's first
 *  dispatch -- a multi-minute per-request timeout would stall the whole
 *  sprint start, so an absurd value is rejected at the config boundary
 *  rather than discovered as a hang. */
export const MAX_LIVENESS_PROBE_TIMEOUT_MS = 60000;

/**
 * THE single validator for the caller-facing `livenessProbe` option, shared
 * by every layer that carries it (src/supervisor/sweep-config.mjs,
 * bin/cli.mjs's resolveSweepConfig(), fleet-sprint/sprint-args.mjs's
 * validateArgs()). Those three deliberately re-validate independently, so
 * they must agree on WHAT is valid -- markers/productionPorts prove how
 * easily three hand-copied shape checks drift apart. The semantics belong to
 * this module because buildLivenessProbeCommand() above is what actually
 * consumes `path`/`timeoutMs`.
 *
 * Returns the NORMALIZED option, never a mutated input:
 *   undefined | null -> `undefined` -- "the config said nothing". The caller
 *                       decides what silence means; phases/member-prep.mjs
 *                       reads it as ARMED (see its DEFAULT header section).
 *   true             -> `true`  -- armed, module defaults.
 *   false            -> `false` -- explicitly DISARMED. Distinct from
 *                       `undefined` on purpose: an operator who turned the
 *                       predicate off said so, and the phase reports that
 *                       differently from an armed pass that spared nothing.
 *   { path?, timeoutMs? } -> the same object re-built with only known keys.
 *
 * Anything else THROWS. An unknown key throws too: silently ignoring
 * `{ timeout: 5000 }` (no `Ms`) would leave the operator believing they had
 * configured something they had not -- the exact "implicit environment
 * decides behaviour and failure is silent" trap this repo forbids.
 *
 * @param {unknown} value raw option as it appeared in the config/args
 * @param {string} label message prefix owned by the calling layer, so each
 *   boundary's error text matches the rest of that boundary's errors
 * @returns {true|false|{ path?: string, timeoutMs?: number }|undefined}
 */
export function normalizeLivenessProbeOption(value, label = 'livenessProbe') {
    if (value === undefined || value === null) return undefined;
    if (value === true || value === false) return value;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(
            `${label} must be true, false, or an object { path?: "/...", timeoutMs?: <integer ms> } `
            + `(got ${JSON.stringify(value)}).`,
        );
    }
    const known = new Set(['path', 'timeoutMs']);
    for (const key of Object.keys(value)) {
        if (!known.has(key)) {
            throw new Error(`${label} has unknown key "${key}": only "path" and "timeoutMs" are supported.`);
        }
    }
    const out = {};
    if (value.path !== undefined) {
        if (typeof value.path !== 'string' || !value.path.startsWith('/')) {
            throw new Error(`${label}.path must be a string starting with "/" (got ${JSON.stringify(value.path)}).`);
        }
        out.path = value.path;
    }
    if (value.timeoutMs !== undefined) {
        if (typeof value.timeoutMs !== 'number' || !Number.isInteger(value.timeoutMs)
            || value.timeoutMs < 1 || value.timeoutMs > MAX_LIVENESS_PROBE_TIMEOUT_MS) {
            throw new Error(
                `${label}.timeoutMs must be an integer in 1..${MAX_LIVENESS_PROBE_TIMEOUT_MS} `
                + `(got ${JSON.stringify(value.timeoutMs)}).`,
            );
        }
        out.timeoutMs = value.timeoutMs;
    }
    return out;
}

/**
 * The bracketed IPv6 form an IPv6 literal must take inside a URL is NOT what
 * a raw socket API accepts as a host, so the win32 branch's TcpClient probe
 * gets the address with its URL brackets stripped. Done in JavaScript, before
 * the value becomes dispatched text, exactly like every other host handling
 * in this module.
 *
 * @param {string} host an already-validated probe host, possibly `[::1]`-style
 * @returns {string}
 */
function rawHostFor(host) {
    return (host.startsWith('[') && host.endsWith(']')) ? host.slice(1, -1) : host;
}

/**
 * The .NET AddressFamily the win32 branch's TcpClient must be CONSTRUCTED
 * with for a given probe host, resolved here in JavaScript rather than left
 * to the socket library to infer on the member.
 *
 * WHY THIS IS NOT OPTIONAL. `New-Object System.Net.Sockets.TcpClient` with no
 * argument is documented as `TcpClient(AddressFamily.InterNetwork)` -- an
 * IPv4-ONLY socket -- under Windows PowerShell 5.1 / .NET Framework, which is
 * exactly what seWindows.wrapForMember() dispatches into (powershell.exe, not
 * pwsh). Connecting that socket to an IPv6 literal THROWS, the throw lands in
 * the probe's own catch, and the candidate would be reported REFUSED: the one
 * transport outcome this module treats as "nothing is listening here", and
 * therefore the only one that can still lead to a kill. A live IPv6-bound
 * listener would be killed as dead -- the precise false-dead this predicate
 * exists to prevent. It hides on a dev box because pwsh 7 / .NET Core made the
 * parameterless ctor family-agnostic, so only the real dispatch shell bites.
 *
 * livenessProbeHost() emits an IPv6 literal ONLY in bracketed form and an IPv4
 * literal only unbracketed, and buildLivenessProbeCommand() re-validates that
 * round trip before calling this, so the brackets are a reliable family tell.
 *
 * @param {string} host an already-validated probe host, possibly `[::1]`-style
 * @returns {'InterNetworkV6'|'InterNetwork'}
 */
function tcpAddressFamilyFor(host) {
    return (host.startsWith('[') && host.endsWith(']')) ? 'InterNetworkV6' : 'InterNetwork';
}

/**
 * Builds the liveness-probe dispatch for a set of already-provisionally-
 * killable `{ pid, port }` candidates: one HTTP GET per candidate port,
 * tagged with pid+port so parseLivenessProbeOutput() can attribute a result
 * back to the exact candidate that requested it (a candidate may hold more
 * than one listening port).
 *
 * THIS PROBE ANSWERS ONE QUESTION ONLY: does *anything* answer HTTP on this
 * port right now? It never inspects the response body or requires a
 * particular status code -- doing so would require knowing what a target's
 * own health endpoint returns, which is exactly the target knowledge this
 * generic module must not hardcode (see this file's GENERIC ENGINE note).
 * Any HTTP status at all (2xx-5xx) counts as "answered".
 *
 * WHEN NOTHING ANSWERS HTTP, THE WIRE FORMAT STILL DISTINGUISHES TWO CASES
 * (see HEALTH_LINE_PREFIX and the PROBE_STATUS_* constants): the HTTP-status
 * field is '000' for both a REFUSED connection and a connection that was
 * ACCEPTED and then stayed silent, so each result line carries a fourth
 * TRANSPORT-STATUS field that tells them apart. POSIX gets it for free --
 * curl's exit status already encodes it -- and the win32 branch asks the
 * same question explicitly with a TcpClient connect inside its own catch
 * block, bounded by the same timeout -- built on an EXPLICIT address family
 * (tcpAddressFamilyFor(), see its header) because the default one is IPv4-only
 * on the PowerShell this payload really runs under.
 *
 * WIN32 WORST-CASE WALL TIME IS 2x THE TIMEOUT PER CANDIDATE, POSIX'S IS 1x.
 * The TCP question is only asked after Invoke-WebRequest has already spent its
 * own -TimeoutSec, so a candidate that hangs at both layers costs
 * timeoutSeconds twice; curl reports its transport status as part of the one
 * request it already made, so POSIX pays once. Both stay bounded by the same
 * opts.timeoutMs-derived value, and the bound is what matters here (this
 * predicate must never stall a sprint start), but the two families are not
 * symmetric in cost -- worth knowing before the default timeout is raised.
 *
 * NO SHELL-LEVEL EXPANSION AND NO COMMAND SUBSTITUTION: curl's `-w` format
 * string writes the tagged result line directly to stdout, so no `$(...)` is
 * needed to capture it -- matching this module's "no orchestrator-side value
 * left for the member shell to expand" discipline (see buildProbeCommand()'s
 * header). The POSIX branch's trailing `echo "$?"` is this function's ONE
 * sanctioned shell-level construct, taken under exactly the same carve-out
 * buildKillCommand() documents for its own kill status: `$?` is the member
 * shell's OWN exit-status variable for the command immediately before it in
 * the same dispatch, never an orchestrator-side value left unexpanded.
 *
 * WHICH HOST IS ASKED (apra-fleet-i4ku.21): each candidate carries the
 * `probeHost` its socket is actually bound to -- resolved by
 * livenessProbeHost(), which maps every wildcard bind to loopback and every
 * specific bind to itself. A candidate with no `probeHost` at all defaults to
 * loopback, which is only correct for a caller that already knows the socket
 * is wildcard-bound; sweepMemberStrayProcesses() never relies on that default
 * and always passes an explicit host. The host is RE-VALIDATED here as a
 * strict IP literal, because this is the last point before it becomes text in
 * a command dispatched to a member.
 *
 * @param {'win32'|'posix'} family
 * @param {Array<{ pid: number, port: number, probeHost?: string }>} candidates
 * @param {{ path?: string, timeoutMs?: number }} [opts]
 * @returns {string}
 */
export function buildLivenessProbeCommand(family, candidates, opts = {}) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new TypeError('buildLivenessProbeCommand(family, candidates): candidates must be a non-empty array');
    }
    const clean = candidates.map(({ pid, port, probeHost } = {}) => {
        const p = Number(pid);
        const prt = Number(port);
        if (!Number.isInteger(p) || p <= 1) {
            throw new TypeError(`buildLivenessProbeCommand: refusing an invalid pid ${JSON.stringify(pid)}`);
        }
        if (!Number.isInteger(prt) || prt <= 0 || prt > 65535) {
            throw new TypeError(`buildLivenessProbeCommand: refusing an invalid port ${JSON.stringify(port)}`);
        }
        const host = probeHost === undefined || probeHost === null ? LOOPBACK_PROBE_HOST : probeHost;
        // Re-validated rather than trusted: livenessProbeHost() already
        // returns only IP literals, but this function is exported and this is
        // the last gate before the value is spliced into a member-bound
        // command string. An address that does not survive the round trip
        // through livenessProbeHost() unchanged is refused outright -- never
        // silently rewritten to loopback, which is the defect this bead fixed.
        if (typeof host !== 'string' || livenessProbeHost(host) !== host) {
            throw new TypeError(
                `buildLivenessProbeCommand: refusing an unprobeable host ${JSON.stringify(probeHost)} `
                + `for pid ${p} port ${prt} -- only a plain IPv4 literal or a bracketed IPv6 literal may be probed`,
            );
        }
        return { pid: p, port: prt, host };
    });
    const reqPath = typeof opts.path === 'string' && opts.path ? opts.path : DEFAULT_LIVENESS_PROBE_PATH;
    if (!reqPath.startsWith('/')) {
        throw new TypeError(`buildLivenessProbeCommand: opts.path must start with '/', got ${JSON.stringify(reqPath)}`);
    }
    const timeoutMs = Number.isInteger(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_LIVENESS_PROBE_TIMEOUT_MS;
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));

    if (family === 'win32') {
        const rawScript = clean.map(({ pid, port, host }) => [
            'try {',
            ` $r = Invoke-WebRequest -Uri 'http://${host}:${port}${reqPath}' -TimeoutSec ${timeoutSeconds}`, // shell-guard-allow: PowerShell local variable ($r, assigned on this same line) inside this module's own -EncodedCommand payload, evaluated by the powershell.exe the envelope explicitly execs -- mirrors buildProbeCommand's own carve-outs; never an orchestrator-side value left for an unknown member shell to expand.
            ' -UseBasicParsing -ErrorAction Stop;',
            ` '${HEALTH_LINE_PREFIX} ${pid} ${port} ' + [int]$r.StatusCode + ' ${PROBE_STATUS_OK}'`, // shell-guard-allow: PowerShell local variable $r assigned two lines above in this same -EncodedCommand payload; see this function's try-block first line.
            ' } catch {',
            // A non-2xx HTTP status still throws under -ErrorAction Stop, but
            // it IS a real HTTP response (the port answered) -- read the
            // status back off the exception's own Response when present,
            // rather than reading it as "no response" (000).
            ` if ($_.Exception.Response) { '${HEALTH_LINE_PREFIX} ${pid} ${port} ' + [int]$_.Exception.Response.StatusCode + ' ${PROBE_STATUS_OK}' }`, // shell-guard-allow: PowerShell's own $_ catch-block variable inside this module's own -EncodedCommand payload, evaluated by the powershell.exe the envelope explicitly execs -- mirrors buildProbeCommand's $_ carve-out.
            // NO HTTP RESPONSE EXISTS AT ALL. Before asserting the one thing
            // this module must never get wrong -- "there is nothing there" --
            // ask the strictly smaller question the transport can still
            // answer: does the TCP port ACCEPT a connection? A live listener
            // that does not speak HTTP accepts and then says nothing; a dead
            // one refuses. The status field carries curl's OWN numbering (0 /
            // 7 / 28) so parseLivenessProbeOutput() needs exactly one rule
            // for both shell families.
            ' else {',
            // THE ADDRESS FAMILY IS EXPLICIT, resolved in JavaScript by
            // tcpAddressFamilyFor() -- see its header. The parameterless
            // TcpClient ctor is IPv4-only on the Windows PowerShell 5.1 this
            // payload actually runs under, so an IPv6 candidate would throw
            // into the catch below and be reported REFUSED, i.e. killed while
            // alive.
            //
            // `New-Object` sits OUTSIDE the inner try ON PURPOSE: if
            // constructing the socket itself fails, $ErrorActionPreference =
            // 'Stop' aborts the whole dispatch, no further candidate emits a
            // line, and every key is therefore absent from the parse -- which
            // the caller already reads as "could not find out" and SPARES. A
            // construction failure that swallowed itself into the catch would
            // instead print REFUSED, the one killable outcome; failing the
            // whole dispatch loudly is the fail-safe direction.
            ` $sweepTcp = New-Object System.Net.Sockets.TcpClient([System.Net.Sockets.AddressFamily]::${tcpAddressFamilyFor(host)});`, // shell-guard-allow: PowerShell local variable ($sweepTcp, assigned on this same line) inside this module's own -EncodedCommand payload, evaluated by the powershell.exe the envelope explicitly execs -- mirrors this function's own $r carve-out above; never an orchestrator-side value left for an unknown member shell to expand.
            ` try { $sweepConn = $sweepTcp.ConnectAsync('${rawHostFor(host)}', ${port});`, // shell-guard-allow: PowerShell local variables ($sweepTcp assigned on the line above, $sweepConn on this one) inside this module's own -EncodedCommand payload; see this function's $r carve-out.
            ` if ($sweepConn.Wait(${timeoutSeconds * 1000}))`, // shell-guard-allow: PowerShell local variable $sweepConn assigned on the line above in this same -EncodedCommand payload; see this function's $r carve-out.
            ` { '${HEALTH_LINE_PREFIX} ${pid} ${port} ${NO_HTTP_RESPONSE_CODE} ${PROBE_STATUS_OK}' }`,
            ` else { '${HEALTH_LINE_PREFIX} ${pid} ${port} ${NO_HTTP_RESPONSE_CODE} ${PROBE_STATUS_TIMEOUT}' } }`,
            ` catch { '${HEALTH_LINE_PREFIX} ${pid} ${port} ${NO_HTTP_RESPONSE_CODE} ${PROBE_STATUS_REFUSED}' }`,
            ` finally { $sweepTcp.Close() } }`, // shell-guard-allow: PowerShell local variable $sweepTcp assigned earlier in this same -EncodedCommand payload; see this function's $r carve-out.
            ' }',
        ].join('')).join('; ');
        return seWindows.wrapForMember(rawScript);
    }
    // POSIX. `command -v curl` checked ONCE up front (a POSIX shell builtin,
    // no external binary needed); every candidate is probed inside the same
    // `if`, so a missing tool produces exactly one SWEEP-NOTOOL line instead
    // of one per candidate.
    //
    // The -w format deliberately ends WITHOUT a newline: the `echo` that
    // follows completes the same line with curl's own exit status, which is
    // the only thing that can tell '000-because-refused' (exit 7) apart from
    // '000-because-it-connected-and-then-said-nothing' (exit 28/52/56). If
    // curl somehow emits no -w output at all, the stray status number lands
    // on a line of its own, fails the parser's shape check, and the candidate
    // resolves unevaluable -- i.e. spared, never killed on a half-read line.
    const probes = clean.map(({ pid, port, host }) => (
        `curl -s -o /dev/null -w '${HEALTH_LINE_PREFIX} ${pid} ${port} %{http_code} ' `
        + `--max-time ${timeoutSeconds} http://${host}:${port}${reqPath} 2>/dev/null; `
        + `echo "$?";` // shell-guard-allow: $? is the invoking POSIX shell's OWN exit-status variable for the `curl` immediately above in this same dispatch, evaluated on the member -- the same carve-out buildKillCommand() takes for its kill status, and the only way a refused connection can be told apart from a connected-but-silent one; never an orchestrator-side value left for an unknown member shell to expand.
    )).join(' ');
    return `if ! command -v curl > /dev/null 2>&1; then echo '${MISSING_TOOL_PREFIX} curl'; else ${probes} fi`;
}

/**
 * Parse a liveness-probe dispatch's output (built by
 * buildLivenessProbeCommand()) into a per-`pid:port` outcome.
 *
 * `evaluable` is FALSE when the member had no supported liveness-probe tool
 * (a SWEEP-NOTOOL line) -- the caller must then treat every candidate this
 * dispatch was built for as UNEVALUABLE (fail-safe: report, never kill),
 * matching this module's "I could not look != there is nothing there"
 * discipline everywhere else (StrayProbeToolMissingError, the portsKnown
 * guard).
 *
 * THE OUTCOME IS THREE-STATE, NOT A BOOLEAN. A boolean could only say
 * "answered / did not answer", and "did not answer" silently contained a LIVE
 * process: a listener that accepts the connection and then never speaks HTTP
 * produces the same '000' HTTP status as a port with nothing behind it at
 * all. The transport-status field written by both builders separates them:
 *
 *   'answered'          -- some HTTP status came back (any status at all).
 *   'tcp-alive-no-http' -- no HTTP response, but the TCP connection was
 *                          ACCEPTED (or the attempt ran out of time rather
 *                          than being refused). Something IS holding this
 *                          port.
 *   'refused'           -- the connection was REFUSED. This is the only
 *                          outcome that means "nothing is listening here".
 *
 * A line that does not match the expected shape is SKIPPED, exactly as
 * before, which leaves its key absent from `byKey` -- and an absent key is
 * already read by the caller as "I could not find out" (spare), never as a
 * kill. A SWEEP-NOTOOL line still makes the whole dispatch unevaluable.
 *
 * @param {string} output raw combined stdout/stderr from the liveness-probe dispatch
 * @returns {{ evaluable: boolean, byKey: Map<string, 'answered'|'tcp-alive-no-http'|'refused'> }}
 *   byKey maps `${pid}:${port}` -> its outcome.
 */
export function parseLivenessProbeOutput(output) {
    const byKey = new Map();
    let evaluable = true;
    for (const raw of String(output || '').split('\n')) {
        const line = raw.replace(/\r$/, '').trim();
        if (!line) continue;
        if (line.startsWith(`${MISSING_TOOL_PREFIX} `)) {
            evaluable = false;
            continue;
        }
        if (!line.startsWith(`${HEALTH_LINE_PREFIX} `)) continue;
        const body = line.slice(HEALTH_LINE_PREFIX.length + 1).trim();
        const m = /^(\d+)\s+(\d+)\s+(\d{1,3})\s+(\d{1,3})$/.exec(body);
        if (!m) continue;
        const key = `${m[1]}:${m[2]}`;
        let outcome;
        if (m[3] !== NO_HTTP_RESPONSE_CODE) outcome = LIVENESS_ANSWERED;
        else if (m[4] === PROBE_STATUS_REFUSED) outcome = LIVENESS_REFUSED;
        else outcome = LIVENESS_TCP_ALIVE_NO_HTTP;
        // COMBINED BY PRECEDENCE, never last-wins (apra-fleet-i4ku.21): one
        // pid may hold the same port on more than one address, so the same
        // key can be reported twice in one dispatch. "Alive on ANY address it
        // holds" is what this predicate means, so a more-alive result is
        // never overwritten by a less-alive sibling -- an HTTP answer is not
        // downgraded by a sibling's '000', and a TCP-alive result is not
        // downgraded by a sibling's refusal.
        const prior = byKey.get(key);
        if (prior === undefined || LIVENESS_OUTCOME_RANK.get(outcome) > LIVENESS_OUTCOME_RANK.get(prior)) {
            byKey.set(key, outcome);
        }
    }
    return { evaluable, byKey };
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

/** Record `{ port, probeHost }` against `pid`. Returns true when the row was
 *  attributable (both a real pid and a real port), which is what the caller
 *  counts -- an UNRESOLVED probeHost does not make a row unattributable: the
 *  port itself is still known, and the production-port predicate depends on
 *  that and nothing else. */
function pushPort(map, pid, port, probeHost = null) {
    if (!Number.isInteger(pid) || !Number.isInteger(port)) return false;
    if (!map.has(pid)) map.set(pid, []);
    const list = map.get(pid);
    const existing = list.find((entry) => entry.port === port && entry.probeHost === probeHost);
    if (!existing) list.push({ port, probeHost });
    return true;
}

/**
 * Split a listening socket's address into its host and port halves.
 *
 * Handles every shape the three enumeration tools emit: `0.0.0.0:8787` and
 * `127.0.0.1:8787` (ss, lsof, Get-NetTCPConnection), `[::]:8787` / `[::1]:631`
 * (bracketed IPv6, ss and lsof), `*:22` (lsof's wildcard), and a bare
 * unbracketed IPv6 host, which is why the host half is taken as everything
 * BEFORE the last colon rather than after the first.
 *
 * @param {string} address
 * @returns {{ host: string, port: number }|null} null when no port could be read
 */
function splitListenAddress(address) {
    const text = String(address || '').trim();
    const idx = text.lastIndexOf(':');
    if (idx < 0) return null;
    const port = Number(text.slice(idx + 1));
    if (!Number.isInteger(port)) return null;
    return { host: text.slice(0, idx).trim(), port };
}

/** Every spelling of "bound to every interface". Loopback IS one of those
 *  interfaces, so these are probed on 127.0.0.1 -- unchanged behaviour from
 *  before apra-fleet-i4ku.21, and the case nearly every real fleet process
 *  falls into. */
const WILDCARD_BIND_HOSTS = new Set(['', '*', '0.0.0.0', '::', '[::]', '0', '[::ffff:0.0.0.0]', '::ffff:0.0.0.0']);

/** A dotted-quad with every octet in range. Deliberately strict: this value is
 *  interpolated into a member-bound command string, so "looks roughly like an
 *  IP" is not good enough. */
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** An IPv6 literal's permitted character set. No '%' (a zone id such as
 *  `fe80::1%eth0` is not something this module can reliably fetch from
 *  another host), no letters beyond hex, nothing that could carry shell
 *  meaning. Structure is validated by IPV6_SHAPE_RE below. */
const IPV6_CHARS_RE = /^[0-9A-Fa-f:.]+$/;
/** Rejects the shapes IPV6_CHARS_RE alone would let through: no colon at all,
 *  or three-or-more consecutive colons. */
const IPV6_SHAPE_RE = /^(?!.*:::)(?=.*:)[0-9A-Fa-f:.]+$/;

/**
 * Resolve the bound host of a listening socket to the host the liveness probe
 * should actually ask, or null when this module cannot turn it into a URL.
 *
 * apra-fleet-i4ku.21. THE THREE OUTCOMES, and why each is what it is:
 *
 *   - a WILDCARD bind ('0.0.0.0', '::', '*', empty) -> '127.0.0.1'. The socket
 *     is on every interface, loopback included, so loopback is the cheapest
 *     correct address to ask and needs no assumption about the member's
 *     routing. This is the pre-i4ku.21 behaviour, preserved exactly.
 *   - a SPECIFIC IP literal -> that address, bracketed when it is IPv6 so it
 *     is a legal URL authority. This is the case the old code got wrong: it
 *     asked loopback, got nothing, and read that as a dead process.
 *   - ANYTHING ELSE (a hostname, a zone-scoped link-local, an unparseable
 *     string) -> null. NOT quietly downgraded to loopback, which is the exact
 *     bug being fixed, and NOT treated as "no socket" either -- the caller
 *     turns a null into the fail-safe `unevaluable` outcome (spare), because
 *     a socket demonstrably exists and only the question is unformable.
 *
 * The return value is also the SANITISER for a value that reaches a
 * member-bound command string: only a strict IP literal is ever returned, so
 * no text a member's own socket table produced can splice into the dispatch.
 *
 * @param {string} boundHost host half of a listening address, as enumerated
 * @returns {string|null} a URL-safe host, or null when it cannot be asked
 */
export function livenessProbeHost(boundHost) {
    const raw = String(boundHost == null ? '' : boundHost).trim();
    if (WILDCARD_BIND_HOSTS.has(raw) || WILDCARD_BIND_HOSTS.has(raw.toLowerCase())) return LOOPBACK_PROBE_HOST;
    const unbracketed = (raw.startsWith('[') && raw.endsWith(']')) ? raw.slice(1, -1).trim() : raw;
    if (WILDCARD_BIND_HOSTS.has(unbracketed.toLowerCase())) return LOOPBACK_PROBE_HOST;
    const v4 = IPV4_RE.exec(unbracketed);
    if (v4) {
        return v4.slice(1).every((octet) => Number(octet) <= 255 && !(octet.length > 1 && octet.startsWith('0')))
            ? unbracketed
            : null;
    }
    if (IPV6_CHARS_RE.test(unbracketed) && IPV6_SHAPE_RE.test(unbracketed)) return `[${unbracketed}]`;
    return null;
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
 * @returns {{ processes: Array<object>,
 *             listeners: Array<{pid:number, port:number, probeHost:string|null}>,
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
            const [pidText, portText, addrText] = trimmed.slice(PORT_WIN_PREFIX.length + 1).trim().split('|');
            portRowsSeen += 1;
            // apra-fleet-i4ku.21: a row with no third field is the pre-i4ku.21
            // shape -- the bound host is UNKNOWN, not loopback. undefined ->
            // probeHost null (fail-safe unevaluable), whereas an EMPTY third
            // field is Get-NetTCPConnection reporting a wildcard bind and does
            // resolve to loopback.
            const probeHost = addrText === undefined ? null : livenessProbeHost(addrText);
            if (pushPort(portsByPid, Number(pidText), Number(portText), probeHost)) portRowsAttributed += 1;
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
                // apra-fleet-i4ku.21: the host half of the SAME address line
                // the port is read from -- lsof prints '*:22' for a wildcard
                // bind and '127.0.0.1:631' / '[::1]:631' / '10.0.0.4:8080'
                // for a specific one.
                const split = splitListenAddress(body.slice(1));
                const attributed = lsofPid != null && split != null
                    && pushPort(portsByPid, lsofPid, split.port, livenessProbeHost(split.host));
                if (attributed) portRowsAttributed += 1;
            }
            continue;
        }

        if (trimmed.startsWith(`${PORT_SS_PREFIX} `)) {
            // ss -H -l -t -n -p row:
            //   LISTEN 0 4096 0.0.0.0:8787 0.0.0.0:* users:(("node",pid=12,fd=20))
            const body = trimmed.slice(PORT_SS_PREFIX.length + 1).trim();
            const fields = body.split(/\s+/);
            const split = splitListenAddress(fields[3]);
            if (split == null) continue;
            const { port } = split;
            // apra-fleet-i4ku.21: ss's local-address column carries the bound
            // host ('0.0.0.0:8787' wildcard vs '192.168.1.5:8787' specific) --
            // the half this module used to read and discard.
            const probeHost = livenessProbeHost(split.host);
            portRowsSeen += 1;
            // An unprivileged ss omits the users:((...pid=N...)) column, so
            // this loop legitimately runs zero times -- which is what makes
            // the seen/attributed split load-bearing rather than cosmetic.
            for (const pidMatch of body.matchAll(/pid=(\d+)/g)) {
                if (pushPort(portsByPid, Number(pidMatch[1]), port, probeHost)) portRowsAttributed += 1;
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
    for (const [pid, sockets] of portsByPid) {
        // apra-fleet-i4ku.21: each listener now carries `probeHost` -- the
        // URL-safe host the liveness probe must ask for THIS socket, or null
        // when the bound address is not something this module can turn into a
        // URL. Null is deliberately not loopback: see livenessProbeHost().
        for (const { port, probeHost } of sockets) listeners.push({ pid, port, probeHost });
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
 * apra-fleet-i4ku.21 adds two more fields, both about the LIVENESS predicate
 * only -- `listeningPorts` keeps its exact previous shape (a deduplicated
 * array of port NUMBERS), because that is what the production-port predicate
 * consumes and that predicate's behaviour is unchanged:
 *
 *   - `probeTargets`: one `{ port, probeHost }` per port this pid holds that
 *     CAN be asked, at most one entry per port. When a pid holds the same port
 *     on several addresses, ONE is chosen (loopback-reachable first), so the
 *     dispatch stays one probe per `pid:port` -- which is also the key
 *     parseLivenessProbeOutput() attributes results by.
 *   - `unresolvedSockets`: how many of this pid's ports have NO askable
 *     address at all. Non-zero means the liveness answer for this candidate is
 *     incomplete, which the caller must resolve fail-safe rather than read as
 *     "nothing answered".
 *
 * @param {Array<object>} processes
 * @param {Array<{pid:number, port:number, probeHost?:string|null}>} listeners
 * @param {{ portsKnown?: boolean }} [opts]
 * @returns {Array<object>}
 */
export function annotateCandidates(processes, listeners = [], opts = {}) {
    const portsKnown = opts.portsKnown === true;
    const livePids = new Set(processes.map((p) => p.pid));
    // pid -> (port -> { probeHost: string|null }). Keyed by PORT rather than
    // by port+address so that one pid:port yields exactly one probe.
    const socketsByPid = new Map();
    for (const l of listeners) {
        if (!Number.isInteger(l.pid) || !Number.isInteger(l.port)) continue;
        if (!socketsByPid.has(l.pid)) socketsByPid.set(l.pid, new Map());
        const byPort = socketsByPid.get(l.pid);
        const probeHost = typeof l.probeHost === 'string' ? l.probeHost : null;
        const existing = byPort.get(l.port);
        if (existing === undefined) {
            byPort.set(l.port, { probeHost });
            continue;
        }
        // Same pid:port on a second address. Prefer an askable host over an
        // unaskable one, and prefer LOOPBACK over a specific interface when
        // both are held -- a process bound to both 127.0.0.1:8080 and
        // 10.0.0.4:8080 is reachable on loopback, which needs no assumption
        // about the member's routing.
        if (existing.probeHost === LOOPBACK_PROBE_HOST) continue;
        if (probeHost === LOOPBACK_PROBE_HOST || existing.probeHost === null) {
            byPort.set(l.port, { probeHost: probeHost ?? existing.probeHost });
        }
    }
    return processes.map((p) => {
        const byPort = socketsByPid.get(p.pid) ?? new Map();
        const probeTargets = [];
        let unresolvedSockets = 0;
        for (const [port, { probeHost }] of byPort) {
            if (probeHost === null) unresolvedSockets += 1;
            else probeTargets.push({ port, probeHost });
        }
        return {
            ...p,
            parentGone: computeParentGone(p, livePids),
            listeningPorts: [...byPort.keys()],
            probeTargets,
            unresolvedSockets,
            portsKnown,
        };
    });
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
    // Liveness probe (apra-fleet-i4ku.17, this file's header predicate 7),
    // OPT-IN: sweepMemberStrayProcesses() sets `record.liveProbe` from a
    // SECOND dispatch run only against candidates that already survived
    // every predicate above. Every other value (including undefined, when no
    // liveness probe was configured or run at all) leaves this predicate a
    // no-op -- unchanged behaviour from before this predicate existed.
    if (record.liveProbe === 'responded') {
        blockers.push(
            'responded to a liveness probe on a port it holds, so it may be a live fleet process a static '
            + 'production-port list does not know about (a supervisor on a non-default port, or a sprint '
            + "child's allocateFreePort() viewer port) -- see member-stray-sweep.mjs's liveness predicate",
        );
    } else if (record.liveProbe === 'unevaluable') {
        blockers.push(
            'the liveness probe could not be evaluated for this candidate (no supported probe tool on the '
            + 'member, or the probe dispatch itself failed), so the liveness predicate could not be applied',
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
 *   livenessProbe?: true|{ path?: string, timeoutMs?: number },
 * }} deps
 */
export async function sweepMemberStrayProcesses(deps = {}) {
    const {
        member = {}, markers = [], productionPorts = [], minAgeMs = DEFAULT_MIN_AGE_MS, execCommand,
        now = () => Date.now(), logger = console,
        // apra-fleet-i4ku.17, header predicate 7: OPT-IN, exactly like
        // markers/productionPorts. `undefined`/`null` (the default) runs this
        // sweep pass byte-for-byte as before this predicate existed -- no
        // second dispatch, no candidate ever gains a `liveProbe` field.
        livenessProbe = null,
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
    const decideAll = () => records.map((record) => decideStrayProcess({
        locality, record, productionPorts, markers, caseInsensitive, minAgeMs, nowMs,
    }));
    let decisions = decideAll();

    // Liveness probe (apra-fleet-i4ku.17, header predicate 7), OPT-IN: a
    // SECOND dispatch, run only against candidates that already survived
    // EVERY other predicate (never the full process table -- probing every
    // listening port on the member is both wasteful and a needless side
    // effect against services this sweep has no business touching).
    // `record.liveProbe` is mutated onto the SAME record objects `decideAll`
    // above already closed over, so re-running it recomputes only what the
    // new field can change; every record this pass never touches gets the
    // identical decision as before.
    // apra-fleet-i4ku.17: ACCOUNTING ONLY -- no predicate reads this object,
    // so nothing here can turn an unevaluable or unrun probe into a kill. It
    // exists so a caller can tell the outcomes apart on the RESULT rather
    // than by parsing log prose: never armed; armed but no candidate ever
    // reached it; armed-and-ran-and-spared-nothing; and armed-but-this
    // candidate-had-no-port-to-ask (`unprobeable`, which is a kill that was
    // never checked and so must never read like a checked one). Before this,
    // they produced a byte-identical result object, so a phase summary built
    // from it could not report "not armed" honestly.
    const liveness = {
        armed: Boolean(livenessProbe),
        dispatched: false,
        checked: 0,
        spared: 0,
        unevaluable: 0,
        // apra-fleet-i4ku.17 rework: candidates this predicate CANNOT ask a
        // question of, because they hold no listening port. Counted whether
        // or not any dispatch was issued -- see the classification below.
        unprobeable: 0,
    };
    if (livenessProbe) {
        const provisionalToKill = decisions.filter((d) => d.action === ACTION_KILL);
        // CLASSIFIED PER CANDIDATE, NEVER PER PASS (apra-fleet-i4ku.17
        // rework). A candidate holding NO listening port has nothing this
        // predicate can ask -- "did anything answer HTTP here" is not a
        // question a portless process has an answer to. It is therefore
        // `unprobeable`, which is DISTINCT from `unevaluable` ("we asked and
        // could not find out"): unevaluable spares fail-safe, unprobeable
        // leaves the other predicates' verdict exactly as it stood before
        // this predicate existed, which for a candidate that survived all of
        // them is a kill.
        //
        // WHY THE SPLIT EXISTS AT ALL: before this rework the whole block was
        // guarded by `candidates.length > 0`, built from the ports of ALL
        // provisional candidates. A portless stray was therefore killed when
        // it was alone in the pass, but SPARED as `unevaluable` when some
        // unrelated ported sibling happened to be swept alongside it -- an
        // identical process, opposite fate, decided by another process. That
        // is the "implicit environment decides behaviour and failure is
        // silent" shape this repo forbids, and it also made the result lie:
        // the pass reported `checked: 0` next to a kill. Splitting the set
        // here makes each candidate's outcome depend only on that candidate.
        //
        // apra-fleet-i4ku.21 adds the THIRD outcome this split has to carry.
        // A candidate can hold listening sockets whose bound address this
        // module cannot turn into a URL (a hostname, a zone-scoped
        // link-local). That is neither `unprobeable` (there IS a socket to
        // ask) nor a legitimate loopback probe (asking the wrong address and
        // reading silence as death is the whole defect this bead fixed) -- it
        // is `unevaluable`: we could not phrase the question, so the
        // candidate is SPARED. It is classified here, OUTSIDE the dispatch
        // block below, because no dispatch is ever built for it and it must
        // not depend on whether some OTHER candidate happened to be askable.
        const recordFor = (d) => records.find((r) => r.pid === d.pid);
        const portless = [];
        const unaskable = [];
        const probeable = [];
        for (const d of provisionalToKill) {
            const record = recordFor(d);
            const targets = (record && record.probeTargets) || [];
            if (targets.length > 0) probeable.push(d);
            else if (record && record.listeningPorts.length > 0) unaskable.push(d);
            else portless.push(d);
        }
        liveness.unprobeable = portless.length;
        for (const d of unaskable) {
            const record = recordFor(d);
            if (!record) continue;
            // NOT counted as `checked`: no probe was ever dispatched for this
            // candidate, and the result object exists precisely so a caller
            // can tell an unasked candidate from an asked one.
            record.liveProbe = 'unevaluable';
            liveness.unevaluable += 1;
            logError(
                `[member-stray-sweep] member '${name}': pid ${record.pid} holds listening port(s) `
                + `${record.listeningPorts.join(', ')} whose bound address could not be resolved to a probeable `
                + 'host, so the liveness probe could not be asked for it -- it is SPARED rather than killed.',
            );
        }
        const candidates = [];
        for (const d of probeable) {
            const record = recordFor(d);
            for (const { port, probeHost } of record.probeTargets) candidates.push({ pid: d.pid, port, probeHost });
        }
        if (unaskable.length > 0) decisions = decideAll();
        if (candidates.length > 0) {
            const livenessOpts = livenessProbe === true ? {} : livenessProbe;
            let livenessRes;
            let dispatchFailed = false;
            // Recorded BEFORE the attempt: a dispatch that was issued and
            // then failed is still a dispatch that happened, and the
            // fail-safe spare below is only honest if the result says the
            // probe was actually attempted.
            liveness.dispatched = true;
            try {
                livenessRes = await execCommand({
                    member: name,
                    command: buildLivenessProbeCommand(family, candidates, livenessOpts),
                    kind: EXEC_KIND_PROBE,
                });
            } catch (err) {
                // The SECOND dispatch itself could not run at all -- fail-safe:
                // every provisional candidate becomes 'unevaluable' below,
                // never silently killed because this extra dispatch happened
                // to fail. Not a StrayProbeError: this predicate is opt-in
                // hygiene layered on top of an already-successful probe, not
                // the sweep's core "I could not look at this member" failure.
                dispatchFailed = true;
                logError(
                    `[member-stray-sweep] member '${name}': the liveness-probe dispatch itself failed `
                    + `(${err && err.message ? err.message : err}) -- every candidate it would have checked `
                    + 'is spared rather than killed.',
                );
            }
            const failedResult = !dispatchFailed && livenessRes && livenessRes.ok === false;
            if (failedResult) {
                logError(
                    `[member-stray-sweep] member '${name}': the liveness-probe dispatch failed (${livenessRes.error}) `
                    + '-- every candidate it would have checked is spared rather than killed.',
                );
            }
            const { evaluable, byKey } = (!dispatchFailed && !failedResult)
                ? parseLivenessProbeOutput(livenessRes && (livenessRes.output || livenessRes.error))
                : { evaluable: false, byKey: new Map() };

            for (const d of probeable) {
                const record = records.find((r) => r.pid === d.pid);
                if (!record) continue;
                liveness.checked += 1;
                if (!evaluable) {
                    record.liveProbe = 'unevaluable';
                    liveness.unevaluable += 1;
                    continue;
                }
                const askedPorts = record.probeTargets.map((t) => t.port);
                const checkedPorts = askedPorts.filter((port) => byKey.has(`${record.pid}:${port}`));
                // Only 'answered' spares here TODAY -- the decision-path
                // mapping for 'tcp-alive-no-http' is the next task in this
                // lane, and this task deliberately changes the WIRE FORMAT
                // only, leaving every candidate's fate byte-for-byte as it
                // was.
                if (checkedPorts.some((port) => byKey.get(`${record.pid}:${port}`) === LIVENESS_ANSWERED)) {
                    record.liveProbe = 'responded';
                    liveness.spared += 1;
                } else if (checkedPorts.length === 0) {
                    record.liveProbe = 'unevaluable';
                    liveness.unevaluable += 1;
                } else if (checkedPorts.length < askedPorts.length || record.unresolvedSockets > 0) {
                    // apra-fleet-i4ku.21: some of this candidate's sockets
                    // were never actually asked -- either the dispatch
                    // returned no line for them, or their bound address was
                    // not resolvable to a URL in the first place. "Everything
                    // I managed to ask said no" is NOT "nothing is there"
                    // while a socket remains unasked, so this resolves
                    // fail-safe rather than falling through to the kill.
                    record.liveProbe = 'unevaluable';
                    liveness.unevaluable += 1;
                } else {
                    record.liveProbe = 'no-response';
                }
            }
            decisions = decideAll();
        }
    }

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
        liveness,
    };
}
