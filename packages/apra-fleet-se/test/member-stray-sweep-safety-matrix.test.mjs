import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    ACTION_KILL,
    ACTION_LEAVE,
    ACTION_REPORT_ONLY,
    DEFAULT_MIN_AGE_MS,
    HEALTH_LINE_PREFIX,
    KILL_BEGIN_PREFIX,
    KILL_STATUS_PREFIX,
    LOCALITY_LOCAL,
    LOCALITY_REMOTE,
    StrayProbeError,
    StrayProbeToolMissingError,
    annotateCandidates,
    buildKillCommand,
    buildLivenessProbeCommand,
    buildProbeCommand,
    classifyFleetEvidence,
    computeParentGone,
    decideStrayProcess,
    formatStrayKillLog,
    memberLocality,
    memberShellFamily,
    parseElapsedSeconds,
    parseKillOutput,
    parseLivenessProbeOutput,
    parseProbeOutput,
    sweepMemberStrayProcesses,
} from '../fleet-sprint/member-stray-sweep.mjs';

// =============================================================================
// Stray fleet-process sweep -- the SAFETY MATRIX.
//
// The sweep kills processes on a member, so what has to be proven here is not
// "the code runs" but "each safety predicate independently prevents a kill".
// Every test below therefore asserts a DECISION -- killed / left alone /
// reported only -- rather than a return code or a green suite.
//
// NOTHING REAL IS TOUCHED. Every process is a fabricated record or a
// fabricated line of probe text, and the execution seam is a stub that records
// the command strings it was handed and never runs them. No process is
// started, no process is signalled, and no file is written outside the one
// mkdtemp sandbox the artifact test below creates and removes.
//
// The `sparedReasons` / `action` split under test:
//   ACTION_LEAVE       -- not a stray fleet process, or explicitly protected
//                         by holding a production port.
//   ACTION_REPORT_ONLY -- it IS a stray fleet process, but this sweep may not
//                         act (member not verifiably remote, or the
//                         production-port predicate could not be evaluated).
//   ACTION_KILL        -- every predicate satisfied.
// =============================================================================

/** The member's production fleet and supervisor ports -- the two ports the
 *  sweep must never kill something off. Supplied by the caller in production;
 *  fabricated here. */
const PRODUCTION_FLEET_PORT = 7523;
const PRODUCTION_SUPERVISOR_PORT = 8787;
const PRODUCTION_PORTS = [PRODUCTION_FLEET_PORT, PRODUCTION_SUPERVISOR_PORT];

/**
 * The evidence markers a member-prep caller supplies. Note the deliberate
 * mix: two markers that ARE evidence fleet started a process (a path fleet
 * chose, a flag fleet passed) and one that is only a program NAME, which the
 * sweep must never accept on its own.
 */
const MARKERS = [
    { kind: 'sandbox-supervisor', token: '/opt/fleetwork/sandbox-run1/', evidence: 'path' },
    { kind: 'dispatch-tree', token: '--fleet-run-id', evidence: 'flag' },
    { kind: 'test-runner', token: 'node', evidence: 'name' },
];

const SANDBOX_SUPERVISOR_CMD =
    '/usr/bin/node /opt/fleetwork/sandbox-run1/supervisor.js --listen 18701';
const STALE_PID = 4242;
const DEAD_PARENT_PID = 9999;

/**
 * THE CANONICAL KILLABLE RECORD: a stale sandbox supervisor on a remote
 * member whose parent process is gone. Every scenario below is this exact
 * record with ONE field changed, so each test isolates one predicate rather
 * than comparing two unrelated fixtures.
 */
function staleSandboxSupervisor(overrides = {}) {
    return {
        pid: STALE_PID,
        ppid: DEAD_PARENT_PID,
        startedAtMs: Date.parse('2026-09-22T03:14:15.000Z'),
        commandLine: SANDBOX_SUPERVISOR_CMD,
        parentGone: true,
        listeningPorts: [18701],
        portsKnown: true,
        ...overrides,
    };
}

// The reference "now" every decision-level test in this file is judged
// against, unless a test overrides it. Chosen well after the control
// record's startedAtMs (2026-09-22T03:14:15.000Z) so its age comfortably
// clears DEFAULT_MIN_AGE_MS and the minimum-age predicate (apra-fleet-i4ku.5)
// stays out of every OTHER predicate's test.
const DECISION_NOW_MS = Date.parse('2026-09-22T04:00:00.000Z');

const decideRemote = (record, overrides = {}) => decideStrayProcess({
    locality: LOCALITY_REMOTE, record, productionPorts: PRODUCTION_PORTS, markers: MARKERS, nowMs: DECISION_NOW_MS, ...overrides,
});

// ---------------------------------------------------------------------------
// The control: the record every other scenario mutates MUST be killable, or
// none of the "left alone" assertions below prove anything.
// ---------------------------------------------------------------------------

test('CONTROL -- remote member, stale sandbox supervisor with a dead parent: KILLED, with pid and command line in the log record', () => {
    const decision = decideRemote(staleSandboxSupervisor());

    assert.equal(decision.action, ACTION_KILL, 'the control record must be killable');
    assert.deepEqual(decision.sparedReasons, []);
    assert.equal(decision.kind, 'sandbox-supervisor');

    // Acceptance criterion 2: pid and command line must appear in the EMITTED
    // log record, not merely in the decision object.
    const logLine = formatStrayKillLog('win-member-7', decision);
    assert.match(logLine, new RegExp(`pid ${STALE_PID}\\b`), `log must carry the pid: ${logLine}`);
    assert.ok(logLine.includes(SANDBOX_SUPERVISOR_CMD), `log must carry the command line: ${logLine}`);
    assert.ok(logLine.includes('2026-09-22T03:14:15.000Z'), `log must carry the start time: ${logLine}`);
    assert.ok(logLine.includes('KILLED'), `log must say what happened: ${logLine}`);
    // The selection reason -- criterion 4's fourth field.
    assert.match(logLine, /reason: fleet-started \(sandbox-supervisor via path marker/);
    assert.match(logLine, /parent pid 9999 is gone/);
});

// ---------------------------------------------------------------------------
// Predicate 1 -- production ports are never killed off.
// ---------------------------------------------------------------------------

test('remote member, process listening on the production FLEET port: LEFT ALONE', () => {
    const decision = decideRemote(staleSandboxSupervisor({ listeningPorts: [PRODUCTION_FLEET_PORT] }));

    assert.equal(decision.action, ACTION_LEAVE, 'a process on the production fleet port must never be killed');
    assert.notEqual(decision.action, ACTION_KILL);
    assert.deepEqual(decision.productionPortHits, [PRODUCTION_FLEET_PORT]);
    assert.match(decision.sparedReasons.join(' '), /listening on production port\(s\) 7523/);
});

test('remote member, process listening on the production SUPERVISOR port: LEFT ALONE', () => {
    const decision = decideRemote(staleSandboxSupervisor({ listeningPorts: [PRODUCTION_SUPERVISOR_PORT] }));

    assert.equal(decision.action, ACTION_LEAVE, 'a process on the production supervisor port must never be killed');
    assert.deepEqual(decision.productionPortHits, [PRODUCTION_SUPERVISOR_PORT]);
    assert.match(decision.sparedReasons.join(' '), /listening on production port\(s\) 8787/);
});

test('a production port is caught even when the process also holds unrelated ports', () => {
    const decision = decideRemote(staleSandboxSupervisor({
        listeningPorts: [18701, PRODUCTION_SUPERVISOR_PORT, 19999],
    }));
    assert.equal(decision.action, ACTION_LEAVE);
    assert.deepEqual(decision.productionPortHits, [PRODUCTION_SUPERVISOR_PORT]);
});

// ---------------------------------------------------------------------------
// Predicate 2 -- the parent must be gone.
// ---------------------------------------------------------------------------

test('remote member, process whose parent is still LIVE: LEFT ALONE', () => {
    const decision = decideRemote(staleSandboxSupervisor({ parentGone: false }));

    assert.equal(decision.action, ACTION_LEAVE, 'a process with a live parent is in use, not stray');
    assert.match(decision.sparedReasons.join(' '), /parent pid 9999 is still alive/);
});

test('computeParentGone resolves every doubtful case toward LEAVING THE PROCESS ALONE', () => {
    const live = new Set([1000, 2000]);
    // Parent absent from the live set -> genuinely gone.
    assert.equal(computeParentGone({ ppid: 3000 }, live), true);
    // Parent still listed -> alive.
    assert.equal(computeParentGone({ ppid: 2000 }, live), false);
    // Reparented to init (POSIX) / idle process (Windows) -> gone.
    assert.equal(computeParentGone({ ppid: 1 }, live), true);
    assert.equal(computeParentGone({ ppid: 0 }, live), true);
    // Unknown ppid -> NOT gone. This is the fail-safe direction: an
    // unparseable row must never become a kill.
    assert.equal(computeParentGone({ ppid: null }, live), false);
    assert.equal(computeParentGone({ ppid: undefined }, live), false);
    assert.equal(computeParentGone({ ppid: NaN }, live), false);
    assert.equal(computeParentGone({}, live), false);
});

// ---------------------------------------------------------------------------
// Predicate 3 -- never by process name alone.
// ---------------------------------------------------------------------------

test('remote member, process matching only a NAME marker with no fleet-started evidence: LEFT ALONE', () => {
    // An operator's own editor/server: it is "node", exactly like the fleet
    // process, and its parent is gone, and it holds no production port. The
    // ONLY thing separating it from the control record is that no path/flag
    // marker matches -- which must be enough to spare it.
    const decision = decideRemote(staleSandboxSupervisor({
        commandLine: '/usr/bin/node /home/dev/my-own-project/server.js',
    }));

    assert.equal(decision.action, ACTION_LEAVE, 'a name match alone must never justify a kill');
    assert.equal(decision.evidence.fleetStarted, false);
    assert.equal(decision.evidence.nameOnly, true, 'the name marker did match -- it just is not evidence');
    assert.match(decision.sparedReasons.join(' '), /matched a process-name marker only/);
});

test('remote member, a process matching NOTHING at all: LEFT ALONE', () => {
    const decision = decideRemote(staleSandboxSupervisor({ commandLine: '/usr/sbin/sshd -D' }));
    assert.equal(decision.action, ACTION_LEAVE);
    assert.equal(decision.evidence.nameOnly, false);
    assert.match(decision.sparedReasons.join(' '), /no evidence that fleet started this process/);
});

test('classifyFleetEvidence requires a path/flag marker; a name marker never promotes a candidate', () => {
    const nameOnly = classifyFleetEvidence({ commandLine: '/usr/bin/node x.js' }, MARKERS);
    assert.equal(nameOnly.fleetStarted, false);
    assert.equal(nameOnly.nameOnly, true);

    const byPath = classifyFleetEvidence({ commandLine: SANDBOX_SUPERVISOR_CMD }, MARKERS);
    assert.equal(byPath.fleetStarted, true);
    assert.equal(byPath.kind, 'sandbox-supervisor');

    const byFlag = classifyFleetEvidence({ commandLine: 'claude --fleet-run-id abc123' }, MARKERS);
    assert.equal(byFlag.fleetStarted, true);
    assert.equal(byFlag.kind, 'dispatch-tree');

    // A marker set containing ONLY name markers can never produce a kill,
    // whatever the command line says.
    const onlyNames = classifyFleetEvidence(
        { commandLine: SANDBOX_SUPERVISOR_CMD },
        [{ kind: 'test-runner', token: 'node', evidence: 'name' }],
    );
    assert.equal(onlyNames.fleetStarted, false);
});

// ---------------------------------------------------------------------------
// Predicate 4 -- remote members only (the local no-kill rule).
// ---------------------------------------------------------------------------

test('LOCAL member, the EXACT record that would be killed on a remote member: NOT killed, reported as a candidate only', () => {
    const record = staleSandboxSupervisor();

    // Same record, same markers, same ports -- only the locality differs.
    const remote = decideStrayProcess({
        locality: LOCALITY_REMOTE, record, productionPorts: PRODUCTION_PORTS, markers: MARKERS, nowMs: DECISION_NOW_MS,
    });
    const local = decideStrayProcess({
        locality: LOCALITY_LOCAL, record, productionPorts: PRODUCTION_PORTS, markers: MARKERS, nowMs: DECISION_NOW_MS,
    });

    assert.equal(remote.action, ACTION_KILL, 'premise: this record IS killable on a remote member');
    assert.equal(local.action, ACTION_REPORT_ONLY, 'the same record on a local member must not be killed');
    assert.notEqual(local.action, ACTION_KILL);
    // Reported as a candidate: it still carries the evidence and the reason,
    // so an operator can act on it by hand.
    assert.equal(local.evidence.fleetStarted, true);
    assert.ok(local.selectionReason, 'a reported candidate still explains why it was selected');
    assert.match(local.sparedReasons.join(' '), /not a verified remote member/);
});

test('memberLocality maps all three registry types explicitly -- only "remote" is killable', () => {
    assert.equal(memberLocality({ type: 'remote' }), LOCALITY_REMOTE);
    assert.equal(memberLocality({ type: 'local' }), LOCALITY_LOCAL);
    // relay is report-only DELIBERATELY: the entry is an addressing alias to a
    // hub-owned member record, so this side cannot establish that the far end
    // is not itself a local machine.
    assert.equal(memberLocality({ type: 'relay' }), LOCALITY_LOCAL);
    // Unknown / absent / future values fail safe the same way.
    assert.equal(memberLocality({ type: 'something-new' }), LOCALITY_LOCAL);
    assert.equal(memberLocality({}), LOCALITY_LOCAL);
    assert.equal(memberLocality({ type: '' }), LOCALITY_LOCAL);
    // The registry field is `type` via list_members, `agentType` on the raw
    // record -- both are accepted.
    assert.equal(memberLocality({ agentType: 'remote' }), LOCALITY_REMOTE);
    // Case and padding do not smuggle a local member into the killable class.
    assert.equal(memberLocality({ type: ' REMOTE ' }), LOCALITY_REMOTE);
});

test('NO input to decideStrayProcess returns ACTION_KILL for a non-remote member', () => {
    // Exhaustive over the record variations this suite uses, for every
    // non-remote locality spelling: the local rule is structural, not a
    // property of one fixture.
    const records = [
        staleSandboxSupervisor(),
        staleSandboxSupervisor({ listeningPorts: [] }),
        staleSandboxSupervisor({ ppid: 1 }),
        staleSandboxSupervisor({ commandLine: 'claude --fleet-run-id abc123' }),
    ];
    for (const locality of [LOCALITY_LOCAL, 'relay', 'unknown', undefined, null]) {
        for (const record of records) {
            const d = decideStrayProcess({
                locality, record, productionPorts: PRODUCTION_PORTS, markers: MARKERS,
            });
            assert.notEqual(d.action, ACTION_KILL, `locality ${JSON.stringify(locality)} must never kill`);
        }
    }
});

// ---------------------------------------------------------------------------
// Predicate 5 -- an unevaluable production-port predicate must not kill.
// ---------------------------------------------------------------------------

test('remote member, listening ports NOT attributable: reported, never killed', () => {
    // Verified on a real Linux host: an unprivileged `ss -ltnp` prints ports
    // but omits the owning pid, and an unprivileged `lsof` printed nothing at
    // all. An empty port list is then absence of evidence, not evidence of
    // absence -- so the production-port predicate has not been satisfied.
    const decision = decideRemote(staleSandboxSupervisor({ listeningPorts: [], portsKnown: false }));

    assert.equal(decision.action, ACTION_REPORT_ONLY);
    assert.notEqual(decision.action, ACTION_KILL);
    assert.match(decision.sparedReasons.join(' '), /production-port predicate could not be evaluated/);

    // Control: the same record with attribution available IS killable, which
    // is what pins the assertion above to portsKnown and nothing else.
    assert.equal(
        decideRemote(staleSandboxSupervisor({ listeningPorts: [], portsKnown: true })).action,
        ACTION_KILL,
    );
});

// ---------------------------------------------------------------------------
// Predicate 6 -- a candidate younger than the minimum-age bound is never
// killed (apra-fleet-i4ku.5). A daemonized process (ppid 1) satisfies the
// parent-gone predicate INSTANTLY, so without this bound a process a
// DIFFERENT, concurrently-starting sprint just launched on this same member
// seconds ago would be indistinguishable from a genuinely stale stray.
// ---------------------------------------------------------------------------

test('remote member, the canonical killable record with a FRESH startedAtMs: reported, never killed', () => {
    // Same record, same markers, same ports as the CONTROL -- only the start
    // time is fresh (well inside DEFAULT_MIN_AGE_MS of "now").
    const freshRecord = staleSandboxSupervisor({ startedAtMs: DECISION_NOW_MS - 5000 });

    const decision = decideRemote(freshRecord);

    assert.equal(decision.action, ACTION_REPORT_ONLY, 'a process seconds old must not be killed');
    assert.notEqual(decision.action, ACTION_KILL);
    assert.match(decision.sparedReasons.join(' '), /younger than the minimum age bound/);
    assert.match(decision.sparedReasons.join(' '), /5s old/);

    // Control: the SAME record aged past the bound (still using the module's
    // own default) IS killable -- pinning the assertion above to age alone.
    assert.equal(
        decideRemote(staleSandboxSupervisor({ startedAtMs: DECISION_NOW_MS - (DEFAULT_MIN_AGE_MS + 1000) })).action,
        ACTION_KILL,
    );
});

test('remote member, a candidate whose start time could not be established: reported, never killed', () => {
    // Neither a malformed `ps` etime nor a null Windows CreationDate can ever
    // produce a confident age -- see parseElapsedSeconds() and
    // apra-fleet-i4ku.4. "Unknown" must resolve the same way "too young" does.
    const decision = decideRemote(staleSandboxSupervisor({ startedAtMs: null }));

    assert.equal(decision.action, ACTION_REPORT_ONLY);
    assert.notEqual(decision.action, ACTION_KILL);
    assert.match(decision.sparedReasons.join(' '), /start time .* is unknown/);
});

test('remote member, a candidate judged with no reference "now" at all: reported, never killed', () => {
    // decideStrayProcess is pure: `nowMs` is an INPUT like productionPorts,
    // never Date.now() read internally. A caller that omits it entirely must
    // not silently disable the minimum-age predicate.
    const decision = decideStrayProcess({
        locality: LOCALITY_REMOTE, record: staleSandboxSupervisor(), productionPorts: PRODUCTION_PORTS, markers: MARKERS,
    });
    assert.equal(decision.action, ACTION_REPORT_ONLY);
    assert.match(decision.sparedReasons.join(' '), /reference clock.*is unknown/);
});

// ---------------------------------------------------------------------------
// Command builders -- BOTH OS families.
// ---------------------------------------------------------------------------

test('the POSIX enumeration command uses POSIX `etime`, never the GNU-only `etimes`', () => {
    const cmd = buildProbeCommand('posix');

    assert.match(cmd, /ps -eo pid=,ppid=,etime=,args=/, 'POSIX process enumeration');
    // The known trap: `etimes` is a GNU/Linux procps extension that hard-fails
    // on macOS BSD ps. A substring test for 'etime' would pass on 'etimes'
    // too, so this asserts the absence of the bad keyword directly.
    assert.doesNotMatch(cmd, /etimes/, 'etimes is GNU-only and must not appear');

    // Both socket tools are attempted and unioned -- not an elif chain that
    // commits to lsof merely because it EXISTS (on a real Linux host lsof
    // exists and prints nothing for an unprivileged user).
    assert.match(cmd, /command -v lsof/);
    assert.match(cmd, /command -v ss/);
    assert.doesNotMatch(cmd, /elif command -v ss/, 'ss must not be gated behind lsof being absent');

    // A missing tool must produce a line, never silence.
    assert.match(cmd, /SWEEP-NOTOOL ps/);
    assert.match(cmd, /SWEEP-NOTOOL lsof/);

    // No shell-level expansion of an orchestrator-side value.
    assert.doesNotMatch(cmd, /\$\(/, 'no POSIX command substitution');
    assert.doesNotMatch(cmd, /\$HOME|\$\{/, 'no variable expansion');
    assert.doesNotMatch(cmd, /~\//, 'no leading tilde path');
});

/** Decode a `powershell -EncodedCommand <base64>` envelope back to the real
 *  UTF-16LE script. Asserting on the opaque base64 blob would prove nothing,
 *  so every Windows assertion in this file goes through here. */
function decodeWinCommand(wrapped) {
    const m = wrapped.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)$/i);
    assert.ok(m, `expected a -EncodedCommand envelope, got: ${wrapped}`);
    return Buffer.from(m[1], 'base64').toString('utf16le');
}

test('the Windows enumeration command is -EncodedCommand wrapped, and its DECODED script enumerates processes and sockets', () => {
    const cmd = buildProbeCommand('win32');

    assert.match(cmd, /^powershell -EncodedCommand [A-Za-z0-9+/=]+$/, 'opaque single-argument envelope');

    const script = decodeWinCommand(cmd);

    // Process enumeration, with a start time that works on Windows.
    assert.match(script, /Get-CimInstance Win32_Process/);
    assert.match(script, /CreationDate/);
    assert.match(script, /ToUnixTimeSeconds/);
    // Listening sockets, for the production-port predicate.
    assert.match(script, /Get-NetTCPConnection -State Listen/);
    assert.match(script, /LocalPort/);
    assert.match(script, /OwningProcess/);
    // Windows rows carry their OWN tag: a POSIX command line may contain a
    // pipe, so the two row formats must not be told apart by content.
    assert.match(script, /SWEEP-PROC-WIN /);
    // A missing cmdlet produces a named line rather than an empty result.
    assert.match(script, /SWEEP-NOTOOL Get-CimInstance/);
    assert.match(script, /SWEEP-NOTOOL Get-NetTCPConnection/);
    // The envelope's own fail-loud machinery survived the wrap.
    assert.match(script, /\$ErrorActionPreference = 'Stop'/);

    // The script must not spell a POSIX command substitution. PowerShell's
    // "$( ... )" subexpression is spelled identically, which is exactly why
    // the builder concatenates strings instead.
    assert.doesNotMatch(script, /\$\(/, 'no "$(" subexpression/command-substitution spelling');
    // It also must not enumerate by process NAME -- the filter-by-name
    // shortcut is the thing the evidence predicate exists to avoid.
    assert.doesNotMatch(script, /-Filter "Name=/, 'the sweep must not select processes by name');
});

test('the kill command targets an explicit pid list in both families, and refuses anything that is not a real pid', () => {
    const posix = buildKillCommand('posix', [11, 22]);
    // Each pid is killed INDIVIDUALLY (apra-fleet-i4ku.3), tagged with its own
    // begin/status markers, never one shared `kill -9 11 22` -- see
    // parseKillOutput() and its tests for why.
    assert.match(posix, /kill -9 11 2>&1/);
    assert.match(posix, /kill -9 22 2>&1/);
    assert.match(posix, new RegExp(`${KILL_BEGIN_PREFIX} 11.*${KILL_BEGIN_PREFIX} 22`));
    assert.match(posix, /\$\?/, 'the shell\'s own exit-status variable is read back, not a JS-side guess');
    // No "$(" command substitution -- shell-command-guard.mjs forbids it in
    // any member-bound command string.
    assert.doesNotMatch(posix, /\$\(/, 'no POSIX command substitution');

    const win = decodeWinCommand(buildKillCommand('win32', [11, 22]));
    assert.match(win, /Stop-Process -Id 11,22 -Force/);

    // No caller can splice text into a dispatched command through this path,
    // and pid 0/1 (idle / init) can never be named.
    for (const bad of [['x'], [0], [1], [-5], [1.5], ['11; rm -rf /'], [null], [undefined]]) {
        assert.throws(() => buildKillCommand('posix', bad), TypeError, `must reject ${JSON.stringify(bad)}`);
    }
    assert.throws(() => buildKillCommand('posix', []), TypeError);
});

// ---------------------------------------------------------------------------
// The kill dispatch's output parser -- the piece that tells "already gone"
// apart from "refused" (apra-fleet-i4ku.3).
// ---------------------------------------------------------------------------

test('parseKillOutput: a clean kill (exit 0, no stderr text) is neither gone nor failed', () => {
    const output = [`${KILL_BEGIN_PREFIX} 111`, `${KILL_STATUS_PREFIX} 111 0`].join('\n');
    const { gone, failed } = parseKillOutput(output, [111]);
    assert.deepEqual(gone, []);
    assert.deepEqual(failed, []);
});

test('parseKillOutput: a pid that already exited (ESRCH text, nonzero exit) is TOLERATED, not a failure', () => {
    const output = [
        `${KILL_BEGIN_PREFIX} 111`,
        'kill: (111): No such process',
        `${KILL_STATUS_PREFIX} 111 1`,
    ].join('\n');
    const { gone, failed } = parseKillOutput(output, [111]);
    assert.deepEqual(gone, [111]);
    assert.deepEqual(failed, []);
});

test('parseKillOutput: a permission failure (nonzero exit, no ESRCH text) STAYS a failure', () => {
    const output = [
        `${KILL_BEGIN_PREFIX} 111`,
        'kill: (111): Operation not permitted',
        `${KILL_STATUS_PREFIX} 111 1`,
    ].join('\n');
    const { gone, failed } = parseKillOutput(output, [111]);
    assert.deepEqual(gone, []);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].pid, 111);
    assert.match(failed[0].detail, /Operation not permitted/);
});

test('parseKillOutput: a mix of one already-gone pid and one genuinely refused pid reports only the refused one as failed', () => {
    const output = [
        `${KILL_BEGIN_PREFIX} 111`,
        'bash: line 1: kill: (111) - No such process',
        `${KILL_STATUS_PREFIX} 111 1`,
        `${KILL_BEGIN_PREFIX} 222`,
        `${KILL_STATUS_PREFIX} 222 0`,
        `${KILL_BEGIN_PREFIX} 333`,
        'kill: (333): Operation not permitted',
        `${KILL_STATUS_PREFIX} 333 1`,
    ].join('\n');
    const { gone, failed } = parseKillOutput(output, [111, 222, 333]);
    assert.deepEqual(gone, [111]);
    assert.deepEqual(failed.map((f) => f.pid), [333]);
});

test('parseKillOutput: a pid with no status line at all is a failure, never a silent success', () => {
    const { gone, failed } = parseKillOutput('', [111]);
    assert.deepEqual(gone, []);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].pid, 111);
});

test('memberShellFamily picks the shell family, and does not mistake darwin for windows', () => {
    assert.equal(memberShellFamily('windows'), 'win32');
    assert.equal(memberShellFamily('win32'), 'win32');
    assert.equal(memberShellFamily('linux'), 'posix');
    // 'darwin' CONTAINS the substring 'win' -- a bare /win/ test is wrong.
    assert.equal(memberShellFamily('darwin'), 'posix');
    assert.equal(memberShellFamily(undefined), 'posix');
});

// ---------------------------------------------------------------------------
// The generated Windows script must be real PowerShell, not plausible text.
// ---------------------------------------------------------------------------

/** Locate a usable PowerShell, preferring cross-platform pwsh. Returns null
 *  when the host has none -- the caller then skips with a VISIBLE reason
 *  rather than degrading to a silent pass. */
function detectPowerShell() {
    for (const bin of ['pwsh', 'powershell.exe', 'powershell']) {
        let probe;
        try {
            probe = spawnSync(bin, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
        } catch {
            continue;
        }
        if (probe && probe.status === 0 && probe.stdout.trim()) return { bin, version: probe.stdout.trim() };
    }
    return null;
}

const POWERSHELL = detectPowerShell();
const POWERSHELL_SKIP = POWERSHELL
    ? false
    : 'DEGRADED: no real PowerShell on PATH (tried pwsh, powershell.exe, powershell), so the generated'
      + ' win32 probe script is only checked as text and its SYNTAX is unverified on this host.'
      + ' Install PowerShell 7 (pwsh) -- it is cross-platform -- to run this test.';

test('the generated win32 probe script PARSES as real PowerShell', { skip: POWERSHELL_SKIP }, () => {
    const script = decodeWinCommand(buildProbeCommand('win32'));
    // Parse only -- never execute. This test must not enumerate or signal
    // anything on the host it runs on.
    const probe = spawnSync(POWERSHELL.bin, ['-NoProfile', '-Command', [
        '$errs = $null',
        '$null = [System.Management.Automation.Language.Parser]::ParseInput($input, [ref]$null, [ref]$errs)',
        'if ($errs.Count -eq 0) { "PARSE-OK" } else { $errs | ForEach-Object { $_.Message } }',
    ].join('; ')], { encoding: 'utf8', input: script });

    assert.equal(probe.status, 0, `powershell exited ${probe.status}: ${probe.stderr}`);
    assert.match(probe.stdout, /PARSE-OK/, `generated script has syntax errors: ${probe.stdout}`);
});

test('the win32 probe script emits EVERY process row, never filtering one out by CreationDate', () => {
    // Regression pin (apra-fleet-i4ku.4): a Where-Object { $_.CreationDate -ne
    // $null } filter used to drop a row entirely, which also removed its pid
    // from the live-pid set computeParentGone() consults -- making that
    // process's children look orphaned and killable. The replacement encodes
    // a null CreationDate as a '-' sentinel INSIDE the row instead of
    // dropping the row.
    const script = decodeWinCommand(buildProbeCommand('win32'));
    assert.doesNotMatch(script, /Where-Object/, 'no row may be filtered out of the process table');
    assert.match(script, /else \{ '-' \}/, 'a null CreationDate must fall back to the "-" sentinel, not be dropped');
});

// ---------------------------------------------------------------------------
// Probe output parsing, including the loud-failure contract.
// ---------------------------------------------------------------------------

test('parseElapsedSeconds reads every POSIX etime shape, and rejects what is not one', () => {
    assert.equal(parseElapsedSeconds('00:10'), 10);
    assert.equal(parseElapsedSeconds('01:30'), 90);
    assert.equal(parseElapsedSeconds('02:03:04'), (2 * 3600) + (3 * 60) + 4);
    assert.equal(parseElapsedSeconds('1-02:03:04'), 86400 + (2 * 3600) + (3 * 60) + 4);
    assert.equal(parseElapsedSeconds('12-00:00:00'), 12 * 86400);
    // Not an elapsed time -> null, so the row becomes "start time unknown"
    // rather than a confidently wrong start time.
    assert.equal(parseElapsedSeconds('?'), null);
    assert.equal(parseElapsedSeconds(''), null);
    assert.equal(parseElapsedSeconds(undefined), null);
});

test('a POSIX command line containing a pipe is parsed intact and stays in the live-pid set', () => {
    // Regression pin. The two row formats used to be told apart by sniffing
    // for a pipe character, so this row was routed into the Windows parser,
    // failed to yield a pid, and was DROPPED -- which also removed it from the
    // live-pid set that the parent-gone predicate consults, making its
    // children look orphaned and killable.
    const output = [
        `SWEEP-PROC   100     1 02:00:00 /bin/sh -c cat foo | grep bar`,
        `SWEEP-PROC   101   100 01:00:00 ${SANDBOX_SUPERVISOR_CMD}`,
        'SWEEP-PORT-SS LISTEN 0 4096 0.0.0.0:18701 0.0.0.0:* users:(("node",pid=101,fd=20))',
    ].join('\n');

    const parsed = parseProbeOutput(output, { nowMs: Date.parse('2026-09-23T12:00:00.000Z') });
    assert.equal(parsed.processes.length, 2, 'the piped row must not be dropped');
    assert.equal(parsed.processes[0].commandLine, '/bin/sh -c cat foo | grep bar');

    const records = annotateCandidates(parsed.processes, parsed.listeners, { portsKnown: parsed.portsKnown });
    const child = records.find((r) => r.pid === 101);
    assert.equal(child.parentGone, false, 'pid 100 is alive, so its child is not an orphan');
    assert.equal(decideRemote(child).action, ACTION_LEAVE, 'and therefore must not be killed');
});

test('a Windows command line containing a pipe survives parsing intact', () => {
    const parsed = parseProbeOutput('SWEEP-PROC-WIN 7|4|1758542400|C:\\x.exe -c "a | b"', {});
    assert.equal(parsed.processes.length, 1);
    assert.equal(parsed.processes[0].commandLine, 'C:\\x.exe -c "a | b"');
    assert.equal(parsed.processes[0].ppid, 4);
    assert.equal(parsed.processes[0].startedAtMs, 1758542400 * 1000);
});

test('a Windows row with an unknown start time ("-" sentinel) still contributes its pid to the live-pid set '
    + 'and still protects its children from being judged orphaned', () => {
    // Regression pin (apra-fleet-i4ku.4). Companion to the POSIX pipe pin
    // above: a Windows process whose CreationDate was null on the member is
    // emitted with the '-' sentinel rather than being dropped from the table
    // entirely, so it must still count as a LIVE parent.
    const output = [
        'SWEEP-PROC-WIN 100|1|-|C:\\Windows\\System32\\some-system-process.exe',
        `SWEEP-PROC-WIN 101|100|1758542400|${SANDBOX_SUPERVISOR_CMD}`,
    ].join('\n');

    const parsed = parseProbeOutput(output, {});
    assert.equal(parsed.processes.length, 2, 'the sentinel row must not be dropped');
    assert.equal(parsed.processes[0].startedAtMs, null, '"-" is not a parseable epoch');
    assert.equal(parsed.processes[0].pid, 100);

    const records = annotateCandidates(parsed.processes, parsed.listeners, { portsKnown: parsed.portsKnown });
    const child = records.find((r) => r.pid === 101);
    assert.equal(child.parentGone, false, 'pid 100 is alive (even with an unknown start time), so its child is not an orphan');
    assert.equal(decideRemote(child).action, ACTION_LEAVE, 'and therefore must not be killed');
});

test('listening sockets are attributed from both lsof and ss output', () => {
    const lsof = parseProbeOutput([
        'SWEEP-PROC 1 0 00:01 /sbin/init',
        'SWEEP-PORT-LSOF p1',
        'SWEEP-PORT-LSOF n0.0.0.0:22',
        'SWEEP-PORT-LSOF n[::1]:631',
    ].join('\n'), {});
    assert.equal(lsof.portsKnown, true);
    // apra-fleet-i4ku.21: each listener carries the probe host its bound
    // address resolves to -- lsof's '*' wildcard and a bracketed IPv6
    // loopback both end up askable on loopback.
    assert.deepEqual(lsof.listeners, [
        { pid: 1, port: 22, probeHost: '127.0.0.1' },
        { pid: 1, port: 631, probeHost: '[::1]' },
    ]);

    const ss = parseProbeOutput([
        'SWEEP-PROC 1 0 00:01 /sbin/init',
        'SWEEP-PORT-SS LISTEN 0 4096 0.0.0.0:8787 0.0.0.0:* users:(("node",pid=55,fd=20))',
    ].join('\n'), {});
    assert.equal(ss.portsKnown, true);
    assert.deepEqual(ss.listeners, [{ pid: 55, port: 8787, probeHost: '127.0.0.1' }]);
});

test('port rows that name no pid are counted as SEEN but NOT attributed', () => {
    // An unprivileged `ss -ltnp` prints the port and omits the owning pid.
    // "I saw sockets but cannot say whose" must not read as "nothing is
    // listening", or the production-port predicate silently becomes vacuous.
    const parsed = parseProbeOutput([
        'SWEEP-PROC 1 0 00:01 /sbin/init',
        'SWEEP-PORT-SS LISTEN 0 4096 127.0.0.1:7523 0.0.0.0:*',
        'SWEEP-PORT-SS LISTEN 0 4096 0.0.0.0:8787 0.0.0.0:*',
    ].join('\n'), {});

    assert.equal(parsed.portRowsSeen, 2, 'the rows were seen');
    assert.equal(parsed.portsKnown, false, 'but none could be attributed to a pid');
    assert.deepEqual(parsed.listeners, []);
});

test('NO supported enumeration tool: a LOUD failure naming the tool, never an empty clean result', () => {
    // The whole point: "I could not look" and "there is nothing there" must
    // not be the same value to a caller.
    assert.throws(
        () => parseProbeOutput('SWEEP-NOTOOL ps', { memberName: 'mac-member-2' }),
        (err) => {
            assert.ok(err instanceof StrayProbeToolMissingError, `expected StrayProbeToolMissingError, got ${err.name}`);
            assert.equal(err.tool, 'ps', 'the missing tool is named on the error');
            assert.match(err.message, /\bps\b/, 'and in the message');
            assert.match(err.message, /mac-member-2/, 'along with the member');
            assert.match(err.message, /Refusing to report a clean member|no supported tool/i);
            return true;
        },
    );

    // Same for the socket probe, which the production-port predicate needs.
    assert.throws(() => parseProbeOutput('SWEEP-NOTOOL lsof', {}), StrayProbeToolMissingError);
    assert.throws(() => parseProbeOutput('SWEEP-NOTOOL Get-CimInstance', {}), StrayProbeToolMissingError);

    // Empty or unrecognisable output is ALSO a failed probe, not a clean
    // member: a working process table always lists at least the probe itself.
    assert.throws(() => parseProbeOutput('', {}), StrayProbeError);
    assert.throws(() => parseProbeOutput('bash: ps: command not found', {}), StrayProbeError);
});

// ---------------------------------------------------------------------------
// End-to-end wiring through the injected seam: the decision must be what is
// actually dispatched, not merely what is computed.
// ---------------------------------------------------------------------------

/** A stub execution seam. It RECORDS command strings and never runs them, so
 *  no process on the host running this suite can be enumerated or signalled. */
/**
 * @param {string} probeOutput
 * @param {{ killOutcomes?: Record<number, 'ok'|'gone'|'denied'> }} [opts]
 *        Per-pid outcome for a POSIX kill dispatch (default 'ok' for every
 *        pid the command names). 'gone' synthesizes the ESRCH ("No such
 *        process") text a real member would print for a pid that already
 *        exited; 'denied' synthesizes a permission failure.
 */
function stubSeam(probeOutput, opts = {}) {
    const killOutcomes = opts.killOutcomes || {};
    const issued = [];
    return {
        issued,
        execCommand: async ({ member, command }) => {
            issued.push({ member, command });
            if (command.includes(KILL_BEGIN_PREFIX)) {
                // A POSIX kill dispatch: synthesize begin/status lines for
                // every pid it names, per killOutcomes (default: success).
                const pids = [...command.matchAll(new RegExp(`${KILL_BEGIN_PREFIX} (\\d+)`, 'g'))].map((m) => Number(m[1]));
                const lines = [];
                for (const pid of pids) {
                    const outcome = killOutcomes[pid] || 'ok';
                    lines.push(`${KILL_BEGIN_PREFIX} ${pid}`);
                    if (outcome === 'ok') {
                        lines.push(`${KILL_STATUS_PREFIX} ${pid} 0`);
                    } else if (outcome === 'gone') {
                        lines.push(`kill: (${pid}): No such process`);
                        lines.push(`${KILL_STATUS_PREFIX} ${pid} 1`);
                    } else {
                        lines.push(`kill: (${pid}): Operation not permitted`);
                        lines.push(`${KILL_STATUS_PREFIX} ${pid} 1`);
                    }
                }
                return { ok: true, output: lines.join('\n') };
            }
            // Only the probe produces output; a Windows kill dispatch (which
            // starts with "powershell") is unparsed by this module and its
            // exact output does not matter to any assertion in this file.
            return { ok: true, output: command.includes('SWEEP-') || command.startsWith('powershell') ? probeOutput : '' };
        },
    };
}

/** The probe output for a member carrying: the killable stale supervisor, a
 *  process on the production supervisor port, a live-parented fleet process,
 *  and a name-only lookalike. Plus their parents where those are alive. */
function scenarioProbeOutput() {
    return [
        // Stale sandbox supervisor, parent 9999 is NOT in the table -> gone.
        `SWEEP-PROC  ${STALE_PID}  ${DEAD_PARENT_PID} 1-02:03:04 ${SANDBOX_SUPERVISOR_CMD}`,
        // A fleet process on the production supervisor port -- protected.
        'SWEEP-PROC  4300     1 2-00:00:00 /usr/bin/node /opt/fleetwork/sandbox-run1/api.js --listen 8787',
        // A fleet dispatch tree whose parent (5000) IS alive -- and 5000's own
        // parent (2000) is alive too, so neither is an orphan. 2000 matches no
        // marker, so it is not a candidate on any axis.
        'SWEEP-PROC  4400  5000 00:30:00 claude --fleet-run-id abc123',
        'SWEEP-PROC  5000  2000 00:31:00 /usr/bin/node /opt/fleetwork/sandbox-run1/dispatcher.js',
        'SWEEP-PROC  2000     1 05:00:00 /usr/lib/systemd/systemd --user',
        // A name-only lookalike with a dead parent -- must be spared.
        'SWEEP-PROC  4500  9998 03:00:00 /usr/bin/node /home/dev/my-own-project/server.js',
        // Socket table, with pid attribution available.
        `SWEEP-PORT-SS LISTEN 0 4096 0.0.0.0:18701 0.0.0.0:* users:(("node",pid=${STALE_PID},fd=20))`,
        'SWEEP-PORT-SS LISTEN 0 4096 0.0.0.0:8787 0.0.0.0:* users:(("node",pid=4300,fd=21))',
    ].join('\n');
}

test('remote member end to end: ONLY the stale supervisor is killed, and the kill dispatch names only its pid', async () => {
    const seam = stubSeam(scenarioProbeOutput());
    const logs = [];
    const result = await sweepMemberStrayProcesses({
        member: { name: 'linux-member-1', os: 'linux', type: 'remote' },
        markers: MARKERS,
        productionPorts: PRODUCTION_PORTS,
        execCommand: seam.execCommand,
        now: () => Date.parse('2026-09-23T12:00:00.000Z'),
        logger: { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    });

    assert.equal(result.locality, LOCALITY_REMOTE);
    assert.equal(result.scanned, 6);
    assert.deepEqual(result.killed.map((k) => k.pid), [STALE_PID], 'exactly one process selected');
    assert.deepEqual(result.reported, []);

    // The kill actually dispatched must name that pid and NOTHING else.
    assert.equal(seam.issued.length, 2, 'one probe dispatch, then one kill dispatch');
    assert.match(seam.issued[1].command, new RegExp(`kill -9 ${STALE_PID} 2>&1`));
    assert.match(seam.issued[1].command, new RegExp(`${KILL_BEGIN_PREFIX} ${STALE_PID}`));
    assert.equal(seam.issued[1].member, 'linux-member-1');
    for (const sparedPid of [4300, 4400, 5000, 4500, 2000]) {
        assert.ok(!seam.issued[1].command.includes(String(sparedPid)), `pid ${sparedPid} must not be in the kill`);
    }

    // And the emitted log carries pid + command line for what was killed.
    const killLog = logs.find((l) => l.includes('KILLED'));
    assert.ok(killLog, `expected a KILLED log line, got: ${JSON.stringify(logs)}`);
    assert.ok(killLog.includes(String(STALE_PID)));
    assert.ok(killLog.includes(SANDBOX_SUPERVISOR_CMD));
});

// ---------------------------------------------------------------------------
// apra-fleet-i4ku.3: a pid that already exited between the probe and the kill
// dispatch (a benign race) must not turn the whole sweep into a loud failure,
// while a genuinely refused kill (e.g. permission denied) still must.
// ---------------------------------------------------------------------------

test('remote member end to end: a selected pid that already exited (ESRCH) is TOLERATED, not a sweep failure', async () => {
    const seam = stubSeam(scenarioProbeOutput(), { killOutcomes: { [STALE_PID]: 'gone' } });
    const logs = [];
    const result = await sweepMemberStrayProcesses({
        member: { name: 'linux-member-1', os: 'linux', type: 'remote' },
        markers: MARKERS,
        productionPorts: PRODUCTION_PORTS,
        execCommand: seam.execCommand,
        now: () => Date.parse('2026-09-23T12:00:00.000Z'),
        logger: { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    });

    // The sweep did not throw, and it still reports the pid as SELECTED --
    // but apra-fleet-i4ku.9: NOT in `killed` (nothing was actually signalled
    // for it), in its own `alreadyGone` bucket instead. Before this bead,
    // `result.killed` still contained this pid, over-reporting the count
    // phases/member-prep.mjs surfaces to the operator as "N killed".
    assert.deepEqual(result.killed, [], 'an already-gone pid must NOT be counted in killed');
    assert.deepEqual(result.alreadyGone.map((k) => k.pid), [STALE_PID], 'it must be pinned in its own alreadyGone bucket');
    // The race is stated, not silent -- and NOT reported as "KILLED", which
    // would misrepresent what actually happened to this pid.
    assert.ok(logs.some((l) => l.includes('already') && l.includes(String(STALE_PID))));
    assert.ok(!logs.some((l) => l.includes('KILLED')), 'an already-gone pid must not be logged as KILLED');
});

test('remote member end to end: a selected pid whose kill is genuinely REFUSED (permission denied) aborts loudly', async () => {
    const seam = stubSeam(scenarioProbeOutput(), { killOutcomes: { [STALE_PID]: 'denied' } });
    await assert.rejects(
        () => sweepMemberStrayProcesses({
            member: { name: 'linux-member-1', os: 'linux', type: 'remote' },
            markers: MARKERS,
            productionPorts: PRODUCTION_PORTS,
            execCommand: seam.execCommand,
            now: () => Date.parse('2026-09-23T12:00:00.000Z'),
            logger: { log: () => {}, error: () => {} },
        }),
        (err) => {
            assert.ok(err instanceof StrayProbeError);
            assert.match(err.message, new RegExp(String(STALE_PID)));
            assert.match(err.message, /Operation not permitted/);
            return true;
        },
    );
});

test('local member end to end: the SAME probe output kills nothing and dispatches no kill command at all', async () => {
    const seam = stubSeam(scenarioProbeOutput());
    const logs = [];
    const result = await sweepMemberStrayProcesses({
        member: { name: 'this-machine', os: 'linux', type: 'local' },
        markers: MARKERS,
        productionPorts: PRODUCTION_PORTS,
        execCommand: seam.execCommand,
        now: () => Date.parse('2026-09-23T12:00:00.000Z'),
        logger: { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    });

    assert.deepEqual(result.killed, [], 'a local member must never have a process killed');
    assert.deepEqual(result.reported.map((r) => r.pid), [STALE_PID], 'the candidate is still reported');

    // THE STRUCTURAL ASSERTION: no kill was even dispatched. Only the probe.
    assert.equal(seam.issued.length, 1, `expected probe only, got: ${JSON.stringify(seam.issued.map((i) => i.command))}`);
    assert.doesNotMatch(seam.issued[0].command, /kill -9|Stop-Process/);

    const reportLog = logs.find((l) => l.includes('REPORTED'));
    assert.ok(reportLog, `expected a REPORTED log line, got: ${JSON.stringify(logs)}`);
    assert.ok(reportLog.includes(String(STALE_PID)));
    assert.ok(!logs.some((l) => l.includes('KILLED')), 'nothing may be logged as killed');
});

test('relay member end to end: treated like local -- reported, never killed', async () => {
    const seam = stubSeam(scenarioProbeOutput());
    const result = await sweepMemberStrayProcesses({
        member: { name: 'relayed-box', os: 'linux', type: 'relay' },
        markers: MARKERS,
        productionPorts: PRODUCTION_PORTS,
        execCommand: seam.execCommand,
        now: () => Date.parse('2026-09-23T12:00:00.000Z'),
        logger: { log: () => {}, error: () => {} },
    });

    assert.deepEqual(result.killed, []);
    assert.deepEqual(result.reported.map((r) => r.pid), [STALE_PID]);
    assert.equal(seam.issued.length, 1, 'no kill dispatch for a relay member');
});

test('a Windows remote member gets the encoded probe and an encoded kill naming only the selected pid', async () => {
    const winProbe = [
        `SWEEP-PROC-WIN ${STALE_PID}|${DEAD_PARENT_PID}|1758503655|C:\\fleetwork\\sandbox-run1\\supervisor.exe --listen 18701`,
        'SWEEP-PROC-WIN 4300|4|1758503655|C:\\fleetwork\\sandbox-run1\\api.exe --listen 8787',
        `SWEEP-PORT-WIN ${STALE_PID}|18701|0.0.0.0`,
        'SWEEP-PORT-WIN 4300|8787|0.0.0.0',
    ].join('\n');
    const seam = stubSeam(winProbe);
    const result = await sweepMemberStrayProcesses({
        member: { name: 'win-member-7', os: 'windows', type: 'remote' },
        // Windows paths are case-insensitive; the sweep lowercases both sides
        // for a win32 member, so a marker cased differently still matches.
        markers: [{ kind: 'sandbox-supervisor', token: 'C:\\FleetWork\\Sandbox-Run1\\', evidence: 'path' }],
        productionPorts: PRODUCTION_PORTS,
        execCommand: seam.execCommand,
        now: () => Date.parse('2026-09-23T12:00:00.000Z'),
        logger: { log: () => {}, error: () => {} },
    });

    assert.deepEqual(result.killed.map((k) => k.pid), [STALE_PID], 'the production-port process (4300) is spared');
    assert.equal(seam.issued.length, 2);
    assert.match(decodeWinCommand(seam.issued[0].command), /Get-CimInstance Win32_Process/);
    const killScript = decodeWinCommand(seam.issued[1].command);
    assert.match(killScript, new RegExp(`Stop-Process -Id ${STALE_PID} -Force`));
    assert.ok(!killScript.includes('4300'), 'the production-port process must not be in the kill');
});

test('a member whose probe cannot run is a LOUD failure, and no kill is attempted', async () => {
    const issued = [];
    const failing = async ({ command }) => {
        issued.push(command);
        return { ok: false, error: 'ssh: connect to host member-9 port 22: Connection refused' };
    };
    await assert.rejects(
        () => sweepMemberStrayProcesses({
            member: { name: 'member-9', os: 'linux', type: 'remote' },
            markers: MARKERS,
            productionPorts: PRODUCTION_PORTS,
            execCommand: failing,
            logger: { log: () => {}, error: () => {} },
        }),
        (err) => {
            assert.ok(err instanceof StrayProbeError);
            assert.match(err.message, /member-9/);
            assert.match(err.message, /Connection refused/);
            return true;
        },
    );
    assert.equal(issued.length, 1, 'the failure must stop before any kill dispatch');

    // A member with no enumeration tool surfaces the same way, naming the tool.
    await assert.rejects(
        () => sweepMemberStrayProcesses({
            member: { name: 'member-10', os: 'linux', type: 'remote' },
            markers: MARKERS,
            productionPorts: PRODUCTION_PORTS,
            execCommand: async () => ({ ok: true, output: 'SWEEP-NOTOOL ps' }),
            logger: { log: () => {}, error: () => {} },
        }),
        (err) => {
            assert.ok(err instanceof StrayProbeToolMissingError);
            assert.equal(err.tool, 'ps');
            return true;
        },
    );
});

test('a member whose sockets cannot be attributed reports rather than kills, and says so', async () => {
    // Same killable supervisor, but the socket table names no pid -- the real
    // unprivileged-`ss` case.
    const probe = [
        `SWEEP-PROC  ${STALE_PID}  ${DEAD_PARENT_PID} 1-02:03:04 ${SANDBOX_SUPERVISOR_CMD}`,
        'SWEEP-PORT-SS LISTEN 0 4096 0.0.0.0:18701 0.0.0.0:*',
    ].join('\n');
    const seam = stubSeam(probe);
    const logs = [];
    const result = await sweepMemberStrayProcesses({
        member: { name: 'unprivileged-member', os: 'linux', type: 'remote' },
        markers: MARKERS,
        productionPorts: PRODUCTION_PORTS,
        execCommand: seam.execCommand,
        now: () => Date.parse('2026-09-23T12:00:00.000Z'),
        logger: { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    });

    assert.deepEqual(result.killed, [], 'an unevaluable safety predicate must not produce a kill');
    assert.deepEqual(result.reported.map((r) => r.pid), [STALE_PID]);
    assert.equal(seam.issued.length, 1, 'no kill dispatch');
    assert.ok(
        logs.some((l) => /could not be attributed/.test(l)),
        `the degradation must be stated, not silent: ${JSON.stringify(logs)}`,
    );
});

// ---------------------------------------------------------------------------
// Predicate 7 (apra-fleet-i4ku.17) -- the OPT-IN liveness probe. A static
// productionPorts list cannot enumerate a supervisor on a non-default port or
// a sprint child's allocateFreePort() viewer port; both are daemonized
// (ppid 1) the instant their own parent restarts, so predicates 2-3 above are
// already satisfied the instant this sweep looks at them. This predicate is
// the backstop: a candidate that still ANSWERS HTTP on a port it holds is
// spared, with a recorded reason -- never silently killed.
// ---------------------------------------------------------------------------

test('decideStrayProcess: a candidate that RESPONDED to the liveness probe is spared, with a recorded reason', () => {
    const decision = decideRemote(staleSandboxSupervisor({ liveProbe: 'responded' }));
    assert.equal(decision.action, ACTION_REPORT_ONLY, 'a responding candidate must never be killed');
    assert.notEqual(decision.action, ACTION_KILL);
    assert.match(decision.sparedReasons.join(' '), /responded to a liveness probe/);
});

test('decideStrayProcess: a candidate whose liveness probe could not be EVALUATED is spared (fail-safe), never killed', () => {
    const decision = decideRemote(staleSandboxSupervisor({ liveProbe: 'unevaluable' }));
    assert.equal(decision.action, ACTION_REPORT_ONLY);
    assert.notEqual(decision.action, ACTION_KILL);
    assert.match(decision.sparedReasons.join(' '), /liveness probe could not be evaluated/);
});

test('decideStrayProcess: a candidate that was probed and got NO response is unaffected -- still killable', () => {
    // Control for the predicate above: "probed, and confirmed silent" must
    // not spare a process, or the stale-sandbox case this sweep exists for
    // would stop working the moment liveness probing is turned on.
    const decision = decideRemote(staleSandboxSupervisor({ liveProbe: 'no-response' }));
    assert.equal(decision.action, ACTION_KILL);
    assert.deepEqual(decision.sparedReasons, []);
});

test('decideStrayProcess: no liveness probe configured/run at all (liveProbe undefined) is unaffected -- unchanged behaviour', () => {
    const decision = decideRemote(staleSandboxSupervisor());
    assert.equal(decision.action, ACTION_KILL, 'the predicate must be a total no-op when liveProbe was never set');
});

test('buildLivenessProbeCommand: POSIX shape -- one curl per candidate, tagged with pid+port, no command substitution', () => {
    const cmd = buildLivenessProbeCommand('posix', [{ pid: 100, port: 9100 }, { pid: 200, port: 8555 }]);

    assert.match(cmd, /command -v curl/);
    assert.match(cmd, /SWEEP-NOTOOL curl/, 'a missing curl must produce a named line, never silence');
    assert.match(cmd, /SWEEP-HEALTH 100 9100 %\{http_code\}/);
    assert.match(cmd, /SWEEP-HEALTH 200 8555 %\{http_code\}/);
    assert.match(cmd, /http:\/\/127\.0\.0\.1:9100\//);
    assert.match(cmd, /http:\/\/127\.0\.0\.1:8555\//);
    assert.match(cmd, /--max-time 2\b/, 'DEFAULT_LIVENESS_PROBE_TIMEOUT_MS (2000ms) rounds up to 2 seconds');

    // No shell-level expansion of an orchestrator-side value -- curl's own -w
    // writes the tagged result directly, so no "$(" capture is ever needed.
    assert.doesNotMatch(cmd, /\$\(/, 'no POSIX command substitution');
    assert.doesNotMatch(cmd, /\$HOME|\$\{/, 'no variable expansion');
});

test('buildLivenessProbeCommand: a custom path and timeout are honoured', () => {
    const cmd = buildLivenessProbeCommand('posix', [{ pid: 100, port: 9100 }], { path: '/api/health', timeoutMs: 500 });
    assert.match(cmd, /http:\/\/127\.0\.0\.1:9100\/api\/health/);
    assert.match(cmd, /--max-time 1\b/, '500ms rounds UP to a whole second, never down to 0');
});

test('buildLivenessProbeCommand: refuses an invalid candidate, an empty list, or a path not starting with "/"', () => {
    assert.throws(() => buildLivenessProbeCommand('posix', []), TypeError);
    assert.throws(() => buildLivenessProbeCommand('posix', [{ pid: 0, port: 80 }]), TypeError);
    assert.throws(() => buildLivenessProbeCommand('posix', [{ pid: 100, port: 0 }]), TypeError);
    assert.throws(() => buildLivenessProbeCommand('posix', [{ pid: 100, port: 70000 }]), TypeError);
    assert.throws(
        () => buildLivenessProbeCommand('posix', [{ pid: 100, port: 80 }], { path: 'no-leading-slash' }),
        TypeError,
    );
});

test('buildLivenessProbeCommand: win32 is -EncodedCommand wrapped and its decoded script probes every candidate', () => {
    const cmd = buildLivenessProbeCommand('win32', [{ pid: 100, port: 9100 }]);
    assert.match(cmd, /^powershell -EncodedCommand [A-Za-z0-9+/=]+$/);
    const script = decodeWinCommand(cmd);
    assert.match(script, /Invoke-WebRequest -Uri 'http:\/\/127\.0\.0\.1:9100\/'/);
    assert.match(script, /SWEEP-HEALTH 100 9100/);
    assert.doesNotMatch(script, /\$\(/, 'no "$(" subexpression/command-substitution spelling');
});

test('the generated win32 liveness-probe script PARSES as real PowerShell', { skip: POWERSHELL_SKIP }, () => {
    const script = decodeWinCommand(buildLivenessProbeCommand('win32', [
        { pid: 100, port: 9100 }, { pid: 200, port: 8555 },
    ]));
    // Parse only -- never execute, matching the equivalent test for
    // buildProbeCommand() above.
    const probe = spawnSync(POWERSHELL.bin, ['-NoProfile', '-Command', [
        '$errs = $null',
        '$null = [System.Management.Automation.Language.Parser]::ParseInput($input, [ref]$null, [ref]$errs)',
        'if ($errs.Count -eq 0) { "PARSE-OK" } else { $errs | ForEach-Object { $_.Message } }',
    ].join('; ')], { encoding: 'utf8', input: script });

    assert.equal(probe.status, 0, `powershell exited ${probe.status}: ${probe.stderr}`);
    assert.match(probe.stdout, /PARSE-OK/, `generated script has syntax errors: ${probe.stdout}`);
});

test('parseLivenessProbeOutput: attributes an HTTP status to its pid:port, and treats curl\'s "000" as no response', () => {
    const output = [
        `${HEALTH_LINE_PREFIX} 100 9100 200`,
        `${HEALTH_LINE_PREFIX} 200 8555 503`,
        `${HEALTH_LINE_PREFIX} 300 18701 000`,
    ].join('\n');
    const { evaluable, byKey } = parseLivenessProbeOutput(output);
    assert.equal(evaluable, true);
    assert.equal(byKey.get('100:9100'), true, 'any HTTP status at all counts as answered');
    assert.equal(byKey.get('200:8555'), true, 'even a 5xx is a real HTTP response');
    assert.equal(byKey.get('300:18701'), false, "curl's 000 sentinel is the only 'no response' outcome");
});

test('parseLivenessProbeOutput: a SWEEP-NOTOOL line marks the whole dispatch unevaluable', () => {
    const { evaluable, byKey } = parseLivenessProbeOutput('SWEEP-NOTOOL curl');
    assert.equal(evaluable, false);
    assert.equal(byKey.size, 0);
});

test('parseLivenessProbeOutput: malformed/unrecognised lines are ignored rather than throwing', () => {
    const { evaluable, byKey } = parseLivenessProbeOutput('garbage\n\nSWEEP-HEALTH not-a-number\n');
    assert.equal(evaluable, true);
    assert.equal(byKey.size, 0);
});

// The three "Done when" scenarios, pinned together in ONE sweep pass so the
// combined matrix -- not just each predicate in isolation -- is proven:
//   - a healthy daemonized supervisor on a NON-DEFAULT port (not in
//     PRODUCTION_PORTS) is SPARED, with a recorded reason;
//   - a live, re-adoptable sprint child (also daemonized, also on a port
//     PRODUCTION_PORTS knows nothing about) is SPARED, with a recorded
//     reason;
//   - the stale-sandbox case (STALE_PID) is STILL KILLED -- turning this
//     predicate on must not disable the sweep for the case it exists for.
const LIVENESS_SUPERVISOR_PID = 6100;
const LIVENESS_SUPERVISOR_PORT = 9100;
const LIVENESS_SUPERVISOR_CMD = '/usr/bin/node /opt/fleetwork/supervisor/serve.mjs --port 9100';
const LIVENESS_SPRINT_CHILD_PID = 6200;
const LIVENESS_SPRINT_CHILD_PORT = 8555;
const LIVENESS_SPRINT_CHILD_CMD = '/usr/bin/node /opt/fleetwork/bin/cli.mjs --fleet-run-id run-789 --viewer-port 8555';
const LIVENESS_MARKERS = [
    ...MARKERS,
    // A non-default-port supervisor's own path marker -- distinct from the
    // sandbox-supervisor marker above, matching the bead's own scenario 1
    // (a supervisor started on a port no static productionPorts list knows
    // about) rather than reusing the sandbox fixture.
    { kind: 'supervisor', token: '/opt/fleetwork/supervisor/', evidence: 'path' },
];

/** Process/port table carrying: the stale sandbox supervisor (still
 *  killable), a healthy non-default-port supervisor, and a live re-adoptable
 *  sprint child -- both of the latter daemonized (ppid 1) exactly like the
 *  bead describes. */
function livenessScenarioProbeOutput() {
    return [
        `SWEEP-PROC  ${STALE_PID}  ${DEAD_PARENT_PID} 1-02:03:04 ${SANDBOX_SUPERVISOR_CMD}`,
        `SWEEP-PROC  ${LIVENESS_SUPERVISOR_PID}     1 2-00:00:00 ${LIVENESS_SUPERVISOR_CMD}`,
        `SWEEP-PROC  ${LIVENESS_SPRINT_CHILD_PID}     1 1-00:00:00 ${LIVENESS_SPRINT_CHILD_CMD}`,
        `SWEEP-PORT-SS LISTEN 0 4096 0.0.0.0:18701 0.0.0.0:* users:(("node",pid=${STALE_PID},fd=20))`,
        `SWEEP-PORT-SS LISTEN 0 4096 0.0.0.0:${LIVENESS_SUPERVISOR_PORT} 0.0.0.0:* users:(("node",pid=${LIVENESS_SUPERVISOR_PID},fd=20))`,
        `SWEEP-PORT-SS LISTEN 0 4096 0.0.0.0:${LIVENESS_SPRINT_CHILD_PORT} 0.0.0.0:* users:(("node",pid=${LIVENESS_SPRINT_CHILD_PID},fd=20))`,
    ].join('\n');
}

/** A bespoke exec seam for the liveness end-to-end tests: unlike stubSeam()
 *  above, it must tell THREE dispatch shapes apart (process probe, liveness
 *  probe, kill) -- stubSeam's own content sniffing (`command.includes('SWEEP-')`)
 *  cannot, since a liveness dispatch's curl -w format string ALSO contains
 *  the literal text "SWEEP-" for the process-probe branch to match. */
function livenessStubSeam(processProbeOutput, healthOutput) {
    const issued = [];
    return {
        issued,
        execCommand: async ({ member, command }) => {
            issued.push({ member, command });
            if (command.includes(KILL_BEGIN_PREFIX)) {
                const pids = [...command.matchAll(new RegExp(`${KILL_BEGIN_PREFIX} (\\d+)`, 'g'))].map((m) => Number(m[1]));
                const lines = [];
                for (const pid of pids) {
                    lines.push(`${KILL_BEGIN_PREFIX} ${pid}`, `${KILL_STATUS_PREFIX} ${pid} 0`);
                }
                return { ok: true, output: lines.join('\n') };
            }
            if (command.includes(HEALTH_LINE_PREFIX)) {
                return { ok: true, output: healthOutput };
            }
            return { ok: true, output: processProbeOutput };
        },
    };
}

test('DONE WHEN (apra-fleet-i4ku.17): a healthy non-default-port supervisor and a live re-adoptable sprint '
    + 'child are both spared with a recorded reason, while the stale-sandbox case is still killed', async () => {
    const healthOutput = [
        `${HEALTH_LINE_PREFIX} ${LIVENESS_SUPERVISOR_PID} ${LIVENESS_SUPERVISOR_PORT} 200`,
        `${HEALTH_LINE_PREFIX} ${LIVENESS_SPRINT_CHILD_PID} ${LIVENESS_SPRINT_CHILD_PORT} 200`,
        `${HEALTH_LINE_PREFIX} ${STALE_PID} 18701 000`,
    ].join('\n');
    const seam = livenessStubSeam(livenessScenarioProbeOutput(), healthOutput);
    const logs = [];
    const result = await sweepMemberStrayProcesses({
        member: { name: 'linux-member-1', os: 'linux', type: 'remote' },
        markers: LIVENESS_MARKERS,
        productionPorts: PRODUCTION_PORTS,
        execCommand: seam.execCommand,
        now: () => Date.parse('2026-09-23T12:00:00.000Z'),
        livenessProbe: true,
        logger: { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    });

    // The stale-sandbox case: STILL KILLED.
    assert.deepEqual(result.killed.map((k) => k.pid), [STALE_PID], 'turning liveness probing on must not disable the sweep');

    // Both liveness-guarded candidates: SPARED, with a recorded reason.
    const reportedPids = result.reported.map((r) => r.pid).sort((a, b) => a - b);
    assert.deepEqual(reportedPids, [LIVENESS_SUPERVISOR_PID, LIVENESS_SPRINT_CHILD_PID].sort((a, b) => a - b));
    const supervisorReport = result.reported.find((r) => r.pid === LIVENESS_SUPERVISOR_PID);
    const childReport = result.reported.find((r) => r.pid === LIVENESS_SPRINT_CHILD_PID);
    assert.match(supervisorReport.sparedReasons.join(' '), /responded to a liveness probe/);
    assert.match(childReport.sparedReasons.join(' '), /responded to a liveness probe/);

    // Exactly three dispatches: process probe, liveness probe, kill.
    assert.equal(seam.issued.length, 3, `expected probe + liveness-probe + kill, got: ${JSON.stringify(seam.issued.map((i) => i.command))}`);
    // The liveness dispatch must have named every provisional candidate,
    // including the one that turned out to still be dead.
    const livenessCmd = seam.issued[1].command;
    assert.ok(livenessCmd.includes(`${LIVENESS_SUPERVISOR_PID} ${LIVENESS_SUPERVISOR_PORT}`));
    assert.ok(livenessCmd.includes(`${LIVENESS_SPRINT_CHILD_PID} ${LIVENESS_SPRINT_CHILD_PORT}`));
    assert.ok(livenessCmd.includes(`${STALE_PID} 18701`));
    // The kill dispatch must name ONLY the still-dead pid.
    const killCmd = seam.issued[2].command;
    assert.match(killCmd, new RegExp(`kill -9 ${STALE_PID} 2>&1`));
    for (const sparedPid of [LIVENESS_SUPERVISOR_PID, LIVENESS_SPRINT_CHILD_PID]) {
        assert.ok(!killCmd.includes(String(sparedPid)), `pid ${sparedPid} must not be in the kill dispatch`);
    }
});

test('liveness probe OFF by default: sweepMemberStrayProcesses dispatches no second probe unless livenessProbe is set', async () => {
    const seam = stubSeam(scenarioProbeOutput());
    const result = await sweepMemberStrayProcesses({
        member: { name: 'linux-member-1', os: 'linux', type: 'remote' },
        markers: MARKERS,
        productionPorts: PRODUCTION_PORTS,
        execCommand: seam.execCommand,
        now: () => Date.parse('2026-09-23T12:00:00.000Z'),
        logger: { log: () => {}, error: () => {} },
    });
    assert.deepEqual(result.killed.map((k) => k.pid), [STALE_PID]);
    assert.equal(seam.issued.length, 2, 'probe + kill only -- no liveness dispatch when the caller never opted in');
});

test('the liveness-probe dispatch itself failing (rejects) spares every provisional candidate, fail-safe', async () => {
    const seam = livenessStubSeam(livenessScenarioProbeOutput(), null);
    const failingExec = async (opts) => {
        if (opts.command.includes(HEALTH_LINE_PREFIX)) throw new Error('ssh: connection reset');
        return seam.execCommand(opts);
    };
    const logs = [];
    const result = await sweepMemberStrayProcesses({
        member: { name: 'linux-member-1', os: 'linux', type: 'remote' },
        markers: LIVENESS_MARKERS,
        productionPorts: PRODUCTION_PORTS,
        execCommand: failingExec,
        now: () => Date.parse('2026-09-23T12:00:00.000Z'),
        livenessProbe: true,
        logger: { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) },
    });

    assert.deepEqual(result.killed, [], 'a failed SECOND dispatch must never fall back to killing');
    assert.deepEqual(
        result.reported.map((r) => r.pid).sort((a, b) => a - b),
        [STALE_PID, LIVENESS_SUPERVISOR_PID, LIVENESS_SPRINT_CHILD_PID].sort((a, b) => a - b),
        'every provisional candidate is spared, including the genuinely stale one',
    );
    for (const r of result.reported) {
        assert.match(r.sparedReasons.join(' '), /liveness probe could not be evaluated/);
    }
    assert.ok(
        logs.some((l) => l.includes('liveness-probe dispatch itself failed')),
        `the degradation must be stated, not silent: ${JSON.stringify(logs)}`,
    );
});

// ---------------------------------------------------------------------------
// Acceptance criterion 4, asserted rather than asserted-about: this suite
// starts and kills no real process and leaves no artifact behind.
// ---------------------------------------------------------------------------

test('the sweep module CANNOT start or signal a process: it has no process-spawning capability at all', () => {
    // The structural guarantee behind every "no real process was touched"
    // claim in this file. Rather than trying to measure a global process
    // table (which churns under unrelated host activity and makes for a flaky
    // assertion), this asserts the module has no way to execute anything: its
    // only route to a member is the command STRING it hands to the injected
    // seam, which every test here stubs.
    const src = fs.readFileSync(
        new URL('../fleet-sprint/member-stray-sweep.mjs', import.meta.url),
        'utf8',
    );
    // Comment prose legitimately discusses ps/kill/Stop-Process, so strip
    // comments before asserting on what the CODE can do.
    const code = src
        .split('\n')
        .filter((line) => {
            const t = line.trim();
            return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
        })
        .join('\n');

    for (const forbidden of ['child_process', 'execSync', 'execFileSync', 'spawnSync', 'spawn(', 'process.kill']) {
        assert.ok(
            !code.includes(forbidden),
            `the sweep module must not be able to execute anything itself, found: ${forbidden}`,
        );
    }
    // The only import is the PowerShell envelope builder.
    const imports = code.match(/^import .*$/gm) ?? [];
    assert.deepEqual(
        imports.map((i) => i.replace(/\s+/g, ' ').trim()),
        ["import { SeWindowsCommands } from './se-windows.mjs';"],
    );
});

test('the suite writes no file outside its own temp sandbox', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'member-stray-sweep-'));
    // Compare the SET of entries, not a count: another process deleting (or
    // creating) an unrelated file under a shared directory during the run
    // must not decide this assertion. What a leak looks like is a NEW entry
    // that is still there afterwards.
    const watched = [process.cwd(), os.tmpdir(), os.homedir()];
    const before = watched.map((dir) => new Set(fs.readdirSync(dir)));

    try {
        // Drive the full sweep again, through the stub seam.
        const seam = stubSeam(scenarioProbeOutput());
        const result = await sweepMemberStrayProcesses({
            member: { name: 'linux-member-1', os: 'linux', type: 'remote' },
            markers: MARKERS,
            productionPorts: PRODUCTION_PORTS,
            execCommand: seam.execCommand,
            now: () => Date.parse('2026-09-23T12:00:00.000Z'),
            logger: { log: () => {}, error: () => {} },
        });
        assert.equal(result.killed.length, 1, 'premise: the sweep really did run and select something');

        // The "kill" was a STRING handed to a stub. Nothing executed it.
        assert.ok(seam.issued.every((i) => typeof i.command === 'string'));

        fs.writeFileSync(path.join(sandbox, 'scratch.txt'), 'only this file, only here', 'utf8');
    } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
    }

    // The sandbox itself must be gone (removed in the finally above, so this
    // holds even when the body throws).
    assert.ok(!fs.existsSync(sandbox), 'the sandbox is removed even on failure (finally)');

    for (let i = 0; i < watched.length; i += 1) {
        const added = fs.readdirSync(watched[i]).filter((entry) => !before[i].has(entry));
        // Nothing this suite could have produced may survive. Entries an
        // unrelated process created during the run are not this test's
        // business, so the assertion names OUR OWN artifacts specifically --
        // including the mkdtemp sandbox above, which is the only thing this
        // file ever writes.
        const ours = added.filter((entry) => /member-stray-sweep|sweep-smoke|SWEEP-/.test(entry));
        assert.deepEqual(ours, [], `this suite leaked artifacts into ${watched[i]}: ${JSON.stringify(ours)}`);
    }
});
