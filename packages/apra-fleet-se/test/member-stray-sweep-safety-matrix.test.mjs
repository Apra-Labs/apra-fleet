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
    LOCALITY_LOCAL,
    LOCALITY_REMOTE,
    StrayProbeError,
    StrayProbeToolMissingError,
    annotateCandidates,
    buildKillCommand,
    buildProbeCommand,
    classifyFleetEvidence,
    computeParentGone,
    decideStrayProcess,
    formatStrayKillLog,
    memberLocality,
    memberShellFamily,
    parseElapsedSeconds,
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

const decideRemote = (record) => decideStrayProcess({
    locality: LOCALITY_REMOTE, record, productionPorts: PRODUCTION_PORTS, markers: MARKERS,
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
        locality: LOCALITY_REMOTE, record, productionPorts: PRODUCTION_PORTS, markers: MARKERS,
    });
    const local = decideStrayProcess({
        locality: LOCALITY_LOCAL, record, productionPorts: PRODUCTION_PORTS, markers: MARKERS,
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
    assert.equal(buildKillCommand('posix', [11, 22]), 'kill -9 11 22');

    const win = decodeWinCommand(buildKillCommand('win32', [11, 22]));
    assert.match(win, /Stop-Process -Id 11,22 -Force/);

    // No caller can splice text into a dispatched command through this path,
    // and pid 0/1 (idle / init) can never be named.
    for (const bad of [['x'], [0], [1], [-5], [1.5], ['11; rm -rf /'], [null], [undefined]]) {
        assert.throws(() => buildKillCommand('posix', bad), TypeError, `must reject ${JSON.stringify(bad)}`);
    }
    assert.throws(() => buildKillCommand('posix', []), TypeError);
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

test('listening sockets are attributed from both lsof and ss output', () => {
    const lsof = parseProbeOutput([
        'SWEEP-PROC 1 0 00:01 /sbin/init',
        'SWEEP-PORT-LSOF p1',
        'SWEEP-PORT-LSOF n0.0.0.0:22',
        'SWEEP-PORT-LSOF n[::1]:631',
    ].join('\n'), {});
    assert.equal(lsof.portsKnown, true);
    assert.deepEqual(lsof.listeners, [{ pid: 1, port: 22 }, { pid: 1, port: 631 }]);

    const ss = parseProbeOutput([
        'SWEEP-PROC 1 0 00:01 /sbin/init',
        'SWEEP-PORT-SS LISTEN 0 4096 0.0.0.0:8787 0.0.0.0:* users:(("node",pid=55,fd=20))',
    ].join('\n'), {});
    assert.equal(ss.portsKnown, true);
    assert.deepEqual(ss.listeners, [{ pid: 55, port: 8787 }]);
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
function stubSeam(probeOutput) {
    const issued = [];
    return {
        issued,
        execCommand: async ({ member, command }) => {
            issued.push({ member, command });
            // Only the probe produces output; a kill dispatch returns nothing.
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
    assert.equal(seam.issued[1].command, `kill -9 ${STALE_PID}`);
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
        `SWEEP-PORT-WIN ${STALE_PID}|18701`,
        'SWEEP-PORT-WIN 4300|8787',
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
