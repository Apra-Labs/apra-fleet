import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
    classifyDoltFailure,
    doltPullBefore,
    doltPushAfter,
    isMemberSyncRemoteConfigured,
    verifyDoerStreakClosed,
} from '../auto-sprint/runner.js';
import { DoltDivergedError, DoltSyncError } from '../auto-sprint/errors.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// apra-fleet-eft.9.1 -- D-pull/D-push bracket helpers and the Plan 3.3 dolt
// insertion points.
//
// Two layers are covered here:
//   1. Behavioural unit tests of the helpers doltPullBefore / doltPushAfter /
//      verifyDoerStreakClosed, injected with a scripted command() mock. The
//      single most important of these proves that verifyDoerStreakClosed's
//      MANDATORY pre-read D-pull is what stops a remote doer's just-pushed
//      close from being falsely reported FAILED (the exact regression this
//      bead exists to prevent).
//   2. A source-level enumeration of the Plan 3.3 dolt bracket insertion
//      points in runner.js, asserting that every beads-MUTATING dispatch role
//      (planner, doer, integ-test-runner, harvester) carries `pushBeads: true`
//      so its beads mutations are D-pushed to the shared remote, while every
//      read-only role does not. A future edit that adds a mutating dispatch
//      without `pushBeads: true` (exactly the integ-test-runner/harvester
//      omission this bead's rework fixed) fails this test instead of silently
//      dropping those beads mutations on the floor.
// =============================================================================

// A tiny scripted command() mock. `script` maps a cmd-substring -> a sequence
// of results consumed one-per-call (the last entry sticks once the queue is
// down to one). A result may be an object ({ ok } or { ok:false, error }) for
// failSoft dolt steps, or a raw string for a non-failSoft read (e.g. bd show
// --json, which returns its raw stdout). Records every call with its opts so
// tests can assert explicit member_name threading (Plan 3.2) and call order.
function makeCommandMock(script) {
    const calls = [];
    const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
    const command = async (cmd, opts = {}) => {
        calls.push({ cmd, opts });
        for (const [key, queue] of queues) {
            if (cmd.includes(key)) {
                const next = queue.length > 1 ? queue.shift() : queue[0];
                return typeof next === 'function' ? next() : next;
            }
        }
        return { ok: true, output: '', error: null };
    };
    return { command, calls };
}

const OK = { ok: true, output: '', error: null };
const fail = (error) => ({ ok: false, output: '', error });

// -----------------------------------------------------------------------------
// classifyDoltFailure: the transient-vs-diverged split the reconcile hinges on.
// -----------------------------------------------------------------------------
test('classifyDoltFailure: conflict / non-fast-forward outputs classify as diverged', () => {
    assert.equal(classifyDoltFailure('cannot fast-forward: divergent branches'), 'diverged');
    assert.equal(classifyDoltFailure('merge conflict detected in table issues'), 'diverged');
    assert.equal(classifyDoltFailure('Updates were rejected because the remote contains work'), 'diverged');
});

test('classifyDoltFailure: network / lock outputs classify as transient', () => {
    assert.equal(classifyDoltFailure('connection refused'), 'transient');
    assert.equal(classifyDoltFailure('could not resolve host: dolthub.com'), 'transient');
});

test('classifyDoltFailure: unclassifiable output is unknown (never silently transient)', () => {
    assert.equal(classifyDoltFailure('some brand-new dolt failure text'), 'unknown');
    assert.equal(classifyDoltFailure(''), 'unknown');
});

// -----------------------------------------------------------------------------
// classifyDoltFailure / doltPullBefore / doltPushAfter -- 'no-remote'
// (apra-fleet-eft.16.1/16.2): a local beads clone with no configured dolt
// remote has nothing to pull/push. This must classify distinctly from
// diverged/transient/unknown and the brackets must skip (not throw) for it,
// while still throwing for every other failure kind (regression guard so the
// skip is not over-broad).
// -----------------------------------------------------------------------------
test("classifyDoltFailure: 'Error 1105: no remote' and 'no remote' fetch text classify as no-remote", () => {
    assert.equal(
        classifyDoltFailure("fetch from origin/main: Error 1105: no remote"),
        'no-remote',
    );
    assert.equal(
        classifyDoltFailure("[Command Failed] Error: fetch from origin/main: Error 1105: no remote"),
        'no-remote',
    );
    assert.equal(classifyDoltFailure('no remote configured for this repository'), 'no-remote');
});

test('doltPullBefore: a no-remote failure returns a benign skip, never throws', async () => {
    const { command, calls } = makeCommandMock({
        'bd dolt pull': [fail("fetch from origin/main: Error 1105: no remote")],
    });
    const res = await doltPullBefore('memberA', { command });
    assert.deepEqual(res, { ok: true, member: 'memberA', skipped: true, reason: 'no-remote' });
    assert.equal(calls.filter((c) => c.cmd.includes('bd dolt pull')).length, 1, 'no-remote is not retried');
});

test('doltPullBefore: transient/diverged/unknown failures still throw despite the no-remote skip existing', async () => {
    await assert.rejects(
        () => doltPullBefore('memberA', { command: makeCommandMock({ 'bd dolt pull': [fail('merge conflict detected')] }).command }),
        DoltDivergedError,
        'diverged D-pull failures are not swallowed by the no-remote skip',
    );
    await assert.rejects(
        () => doltPullBefore('memberA', { command: makeCommandMock({ 'bd dolt pull': [fail('connection refused'), fail('connection refused')] }).command }),
        DoltSyncError,
        'transient-exhausted D-pull failures are not swallowed by the no-remote skip',
    );
    await assert.rejects(
        () => doltPullBefore('memberA', { command: makeCommandMock({ 'bd dolt pull': [fail('some brand-new dolt failure text')] }).command }),
        DoltSyncError,
        'unknown D-pull failures are not swallowed by the no-remote skip',
    );
});

test('doltPushAfter: a no-remote failure returns a benign skip, never throws, and issues no reconcile pull', async () => {
    const { command, calls } = makeCommandMock({
        'bd dolt push': [fail("[Command Failed] Error: fetch from origin/main: Error 1105: no remote")],
    });
    const res = await doltPushAfter('memberA', { command });
    assert.deepEqual(res, { ok: true, member: 'memberA', pushed: false, reconciled: false, skipped: true, reason: 'no-remote' });
    assert.equal(calls.filter((c) => c.cmd.includes('bd dolt pull')).length, 0, 'no-remote D-push triggers no reconcile pull');
});

test('doltPushAfter: transient/diverged/unknown failures still throw despite the no-remote skip existing', async () => {
    await assert.rejects(
        () => doltPushAfter('memberA', { command: makeCommandMock({ 'bd dolt push': [fail('cannot fast-forward: divergent branches')], 'bd dolt pull': [OK] }).command }),
        DoltDivergedError,
        'diverged D-push failures are not swallowed by the no-remote skip',
    );
    await assert.rejects(
        () => doltPushAfter('memberA', { command: makeCommandMock({ 'bd dolt push': [fail('connection refused'), fail('connection refused')] }).command }),
        DoltSyncError,
        'transient-exhausted D-push failures are not swallowed by the no-remote skip',
    );
    await assert.rejects(
        () => doltPushAfter('memberA', { command: makeCommandMock({ 'bd dolt push': [fail('some brand-new dolt failure text')] }).command }),
        DoltSyncError,
        'unknown D-push failures are not swallowed by the no-remote skip',
    );
});

// -----------------------------------------------------------------------------
// doltPullBefore (D-pull).
// -----------------------------------------------------------------------------
test('doltPullBefore: happy path runs `bd dolt pull` with an explicit member_name', async () => {
    const { command, calls } = makeCommandMock({ 'bd dolt pull': [OK] });
    const res = await doltPullBefore('memberA', { command });
    assert.deepEqual(res, { ok: true, member: 'memberA' });
    const pull = calls.find((c) => c.cmd.includes('bd dolt pull'));
    assert.ok(pull, 'a bd dolt pull was issued');
    assert.equal(pull.opts.member_name, 'memberA', 'D-pull carries an explicit member_name (3.2)');
});

test('doltPullBefore: a divergence raises a typed DoltDivergedError (never retried blindly)', async () => {
    const { command, calls } = makeCommandMock({ 'bd dolt pull': [fail('merge conflict detected')] });
    await assert.rejects(() => doltPullBefore('memberA', { command }), DoltDivergedError);
    const pulls = calls.filter((c) => c.cmd.includes('bd dolt pull'));
    assert.equal(pulls.length, 1, 'a diverged D-pull is issued exactly once, not retried');
});

test('doltPullBefore: a transient failure is retried, then succeeds', async () => {
    const { command, calls } = makeCommandMock({ 'bd dolt pull': [fail('connection refused'), OK] });
    const res = await doltPullBefore('memberA', { command });
    assert.equal(res.ok, true);
    assert.equal(calls.filter((c) => c.cmd.includes('bd dolt pull')).length, 2);
});

test('doltPullBefore: requires an injected command()', async () => {
    await assert.rejects(() => doltPullBefore('memberA', {}), /requires an injected command/);
});

// -----------------------------------------------------------------------------
// doltPushAfter (D-push).
// -----------------------------------------------------------------------------
test('doltPushAfter: clean push publishes with explicit member_name, no reconcile', async () => {
    const { command, calls } = makeCommandMock({ 'bd dolt push': [OK] });
    const res = await doltPushAfter('memberA', { command });
    assert.deepEqual(res, { ok: true, member: 'memberA', pushed: true, reconciled: false });
    const push = calls.find((c) => c.cmd.includes('bd dolt push'));
    assert.equal(push.opts.member_name, 'memberA', 'D-push carries an explicit member_name (3.2)');
    assert.equal(calls.filter((c) => c.cmd.includes('bd dolt pull')).length, 0, 'no reconcile pull on a clean push');
});

test('doltPushAfter: pushBeads:false is a no-op read-only bracket (nothing published)', async () => {
    const { command, calls } = makeCommandMock({ 'bd dolt push': [OK] });
    const res = await doltPushAfter('memberA', { command, pushBeads: false });
    assert.deepEqual(res, { ok: true, member: 'memberA', pushed: false, reconciled: false });
    assert.equal(calls.length, 0, 'pushBeads:false issues no dolt command at all');
});

test('doltPushAfter: push loser reconciles with EXACTLY ONE D-pull then one re-push (first-successful-pusher-wins)', async () => {
    const { command, calls } = makeCommandMock({
        'bd dolt push': [fail('Updates were rejected because the remote contains work'), OK],
        'bd dolt pull': [OK],
    });
    const res = await doltPushAfter('memberA', { command });
    assert.deepEqual(res, { ok: true, member: 'memberA', pushed: true, reconciled: true });
    assert.equal(calls.filter((c) => c.cmd.includes('bd dolt pull')).length, 1, 'exactly one reconcile pull');
    assert.equal(calls.filter((c) => c.cmd.includes('bd dolt push')).length, 2, 'push, reconcile-pull, then re-push');
});

test('doltPushAfter: still rejected after the one reconcile raises typed DoltDivergedError, no further retry', async () => {
    const { command, calls } = makeCommandMock({
        'bd dolt push': [fail('cannot fast-forward: divergent branches')],
        'bd dolt pull': [OK],
    });
    await assert.rejects(() => doltPushAfter('memberA', { command }), DoltDivergedError);
    assert.equal(calls.filter((c) => c.cmd.includes('bd dolt push')).length, 2, 'push then one re-push, never a third');
});

test('doltPushAfter: a transient-exhausted push raises DoltSyncError (not DoltDivergedError), no reconcile', async () => {
    const { command, calls } = makeCommandMock({ 'bd dolt push': [fail('connection refused')] });
    await assert.rejects(() => doltPushAfter('memberA', { command }), DoltSyncError);
    assert.equal(calls.filter((c) => c.cmd.includes('bd dolt pull')).length, 0, 'a non-diverged failure triggers no reconcile pull');
});

// -----------------------------------------------------------------------------
// apra-fleet-eft.30.2/30.3 + stabilization Issue 31 -- neutralized-sandbox
// D-push isolation, two layers: (1) PRE-GATE: when bd-level sync.remote is
// positively absent, no `bd dolt push` is issued at all (run 15 final review:
// bd auto-provisions a Dolt remote from git origin on the attempt, so a
// credentialed clone would reach the real shared remote); (2) failure-path
// downgrade as defense-in-depth if a push does fire and fail.
//
// A misconfigured/mis-wired Dolt-level remote in a neutralized sandbox can
// make a real 'bd dolt push' attempt and fail with a credentials-style error
// (e.g. 'could not read Username for https://github.com') that
// classifyDoltFailure has no pattern for and so classifies as 'unknown' --
// NOT 'no-remote'. doltPushAfter must still treat this as a benign
// no-remote skip when the member's bd-level sync.remote is itself
// neutralized/absent (checked via isMemberSyncRemoteConfigured /
// opts.checkSyncRemoteConfigured), and must still raise DoltSyncError,
// unchanged from eft.16.1, when sync.remote IS actively configured (the
// negative control). Hermetic: command() is always a scripted mock here --
// no real bd/dolt process and no network I/O.
// -----------------------------------------------------------------------------
const CREDENTIALS_ERROR = 'could not read Username for https://github.com: terminal prompts disabled';

test('doltPushAfter: PRE-GATE (stabilization Issue 31) -- with bd-level sync.remote absent, NO bd dolt push command is issued at all', async () => {
    // The safety-critical assertion from run 15's final review: it is not
    // enough that a neutralized-sandbox push FAILURE is downgraded to a
    // benign skip -- the push must never be ATTEMPTED, because bd
    // auto-provisions a Dolt remote from git origin on the attempt and a
    // credentialed clone would push to the real shared remote successfully.
    const logs = [];
    const log = (msg) => logs.push(msg);
    const { command, calls } = makeCommandMock({ 'bd dolt push': [fail(CREDENTIALS_ERROR)] });
    const checkSyncRemoteConfigured = async () => false; // simulates a neutralized/absent bd-level sync.remote

    const res = await doltPushAfter('memberA', { command, log, checkSyncRemoteConfigured });

    assert.deepEqual(res, { ok: true, member: 'memberA', pushed: false, reconciled: false, skipped: true, reason: 'no-remote' });
    assert.equal(calls.filter((c) => c.cmd.includes('bd dolt push')).length, 0, 'no bd dolt push command is ISSUED when sync.remote is absent (pre-gate, not failure downgrade)');
    assert.equal(calls.filter((c) => c.cmd.includes('bd dolt pull')).length, 0, 'no reconcile pull is issued either');
    assert.ok(
        logs.some((l) => l.includes("skipped pre-attempt") && l.includes('no push command issued')),
        `expected a 'skipped pre-attempt ... no push command issued' log line, got: ${JSON.stringify(logs)}`,
    );
});

test('doltPushAfter: failure-path downgrade (eft.30.2 defense-in-depth) still covered -- pre-gate passes, push fails, then sync.remote reads absent', async () => {
    // Stateful stub: the pre-gate read reports CONFIGURED (so the push is
    // attempted, preserving eft.16.1 semantics for real clones), the push
    // fails with an unclassifiable credentials error, and the failure-path
    // re-check reports absent -- the downgrade branch must then turn the
    // failure into the same benign no-remote skip instead of DoltSyncError.
    const logs = [];
    const log = (msg) => logs.push(msg);
    const { command, calls } = makeCommandMock({ 'bd dolt push': [fail(CREDENTIALS_ERROR)] });
    const answers = [true, false];
    const checkSyncRemoteConfigured = async () => (answers.length > 1 ? answers.shift() : answers[0]);

    const res = await doltPushAfter('memberA', { command, log, checkSyncRemoteConfigured });

    assert.deepEqual(res, { ok: true, member: 'memberA', pushed: false, reconciled: false, skipped: true, reason: 'no-remote' });
    assert.equal(calls.filter((c) => c.cmd.includes('bd dolt push')).length, 1, 'the push WAS attempted (pre-gate saw configured)');
    assert.equal(calls.filter((c) => c.cmd.includes('bd dolt pull')).length, 0, 'no reconcile pull is issued for this benign skip');
    assert.ok(
        logs.some((l) => l.includes("[Dolt] D-push for member 'memberA' skipped: no dolt remote configured")),
        `expected a 'skipped: no dolt remote configured' log line, got: ${JSON.stringify(logs)}`,
    );
});

test('doltPushAfter: negative control -- with an active configured sync.remote, the same non-diverged failure still throws DoltSyncError (eft.16.1 semantics preserved)', async () => {
    const { command, calls } = makeCommandMock({ 'bd dolt push': [fail(CREDENTIALS_ERROR)] });
    const checkSyncRemoteConfigured = async () => true; // simulates an actively configured bd-level sync.remote

    await assert.rejects(() => doltPushAfter('memberA', { command, checkSyncRemoteConfigured }), DoltSyncError);
    assert.equal(calls.filter((c) => c.cmd.includes('bd dolt pull')).length, 0, 'a non-diverged failure triggers no reconcile pull');
});

// -----------------------------------------------------------------------------
// apra-fleet-eft.31: prove D-push isolation holds structurally, not just
// because the real fleet-e2e-toy remote happened to be unreachable without
// GitHub credentials. C4/C5's "stop" was an accident of the test machine
// lacking credentials, not the neutralization actually working -- the
// pre-attempt gate (eft.30/eft.30.2 above) had not landed yet at that point
// and check-sandbox-sync-remote.mjs reported clean beforehand regardless.
// This test uses a REAL, fully local, credential-free "hazard" remote (a
// bare git repo whose path carries the fleet-e2e-toy identity, reachable via
// a plain filesystem path -- no GitHub auth involved at all) so that if the
// pre-gate did NOT hold, the push below would simply succeed and land on it.
// Asserting it never does, with a remote that WOULD happily accept the push,
// is what proves isolation does not depend on missing credentials.
// -----------------------------------------------------------------------------
test('(eft.31) D-push never reaches a fake/local hazard remote even when it is fully reachable with no credentials required', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eft31-hazard-remote-'));
    try {
        // A REAL, local, credential-free stand-in for the actual fleet-e2e-toy
        // Dolt remote from C4/C5.
        const hazardRemote = path.join(tmpDir, 'fleet-e2e-toy.git');
        execFileSync('git', ['init', '--bare', '-b', 'main', hazardRemote]);

        const workDir = path.join(tmpDir, 'work');
        fs.mkdirSync(workDir);
        execFileSync('git', ['init', '-b', 'main'], { cwd: workDir });
        execFileSync('git', ['config', 'user.email', 'eft31@test.local'], { cwd: workDir });
        execFileSync('git', ['config', 'user.name', 'eft-31-test'], { cwd: workDir });
        fs.writeFileSync(path.join(workDir, 'README.md'), 'seed\n', 'utf-8');
        execFileSync('git', ['add', 'README.md'], { cwd: workDir });
        execFileSync('git', ['commit', '-m', 'seed'], { cwd: workDir });
        execFileSync('git', ['remote', 'add', 'origin', hazardRemote], { cwd: workDir });

        // Sanity: this hazard remote genuinely accepts a push with ZERO
        // credentials -- unlike the real fleet-e2e-toy remote, nothing here
        // would ever block an actually-issued push.
        execFileSync('git', ['push', 'origin', 'main'], { cwd: workDir });

        let pushAttempted = false;
        const command = async (cmd) => {
            if (cmd.includes('bd dolt push')) {
                pushAttempted = true;
                // If this ever runs, it is a REAL push to the reachable
                // hazard remote -- it would succeed outright.
                execFileSync('git', ['push', 'origin', 'main'], { cwd: workDir });
                return { ok: true, output: '', error: null };
            }
            return { ok: true, output: '', error: null };
        };
        const checkSyncRemoteConfigured = async () => false; // neutralized sandbox (eft.25.1)

        const res = await doltPushAfter('sandbox-member', { command, checkSyncRemoteConfigured });

        assert.equal(pushAttempted, false, 'no `bd dolt push` command was ever ISSUED against the reachable hazard remote');
        assert.deepEqual(
            res,
            { ok: true, member: 'sandbox-member', pushed: false, reconciled: false, skipped: true, reason: 'no-remote' },
            'the D-push bracket reports a benign no-remote skip, not a push',
        );

        // Confirm nothing actually reached the hazard remote: it still has
        // exactly the one seed commit, nothing added by a D-push attempt.
        const remoteLog = execFileSync('git', ['log', '--oneline', 'main'], { cwd: hazardRemote, encoding: 'utf-8' })
            .trim().split('\n').filter(Boolean);
        assert.equal(remoteLog.length, 1, 'the hazard remote received exactly the one seed push and nothing from a D-push attempt');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('doltPushAfter: default isMemberSyncRemoteConfigured check (no override) is exercised end-to-end -- absent sync.remote skips, configured sync.remote throws', async () => {
    const absent = makeCommandMock({
        'bd dolt push': [fail(CREDENTIALS_ERROR)],
        'bd config get sync.remote': [{ ok: true, output: JSON.stringify({ value: '' }), error: null }],
    });
    const resAbsent = await doltPushAfter('memberA', { command: absent.command });
    assert.deepEqual(resAbsent, { ok: true, member: 'memberA', pushed: false, reconciled: false, skipped: true, reason: 'no-remote' });
    const configCallAbsent = absent.calls.find((c) => c.cmd.includes('bd config get sync.remote'));
    assert.ok(configCallAbsent, 'doltPushAfter consulted bd-level sync.remote via command()');
    assert.equal(configCallAbsent.opts.member_name, 'memberA', 'sync.remote query carries an explicit member_name (3.2)');

    const configured = makeCommandMock({
        'bd dolt push': [fail(CREDENTIALS_ERROR)],
        'bd config get sync.remote': [{ ok: true, output: JSON.stringify({ value: 'git+https://github.com/Apra-Labs/fleet-e2e-toy' }), error: null }],
    });
    await assert.rejects(() => doltPushAfter('memberA', { command: configured.command }), DoltSyncError);
});

test('isMemberSyncRemoteConfigured: fail-safe -- an unparsable / errored / missing-output query is treated as CONFIGURED', async () => {
    const errored = await isMemberSyncRemoteConfigured('memberA', {
        command: async () => ({ ok: false, error: 'boom' }),
    });
    assert.equal(errored, true, 'a failSoft error result fails safe (configured)');

    const unparsable = await isMemberSyncRemoteConfigured('memberA', {
        command: async () => ({ ok: true, output: 'not json', error: null }),
    });
    assert.equal(unparsable, true, 'unparsable JSON fails safe (configured)');

    const emptyOutput = await isMemberSyncRemoteConfigured('memberA', {
        command: async () => ({ ok: true, output: '', error: null }),
    });
    assert.equal(emptyOutput, true, 'no output to positively parse fails safe (configured)');

    const positivelyAbsent = await isMemberSyncRemoteConfigured('memberA', {
        command: async () => ({ ok: true, output: JSON.stringify({ value: '' }), error: null }),
    });
    assert.equal(positivelyAbsent, false, 'a clean parse of an empty value is the only "not configured" case');
});

// apra-fleet-eft.32: the try/catch around the injected command() call itself
// (a thrown exception, as opposed to a failSoft `{ ok: false }` result) is a
// distinct fail-closed branch from the three above and was previously
// unexercised.
test('isMemberSyncRemoteConfigured: fail-safe -- a thrown command() exception is treated as CONFIGURED', async () => {
    const thrown = await isMemberSyncRemoteConfigured('memberA', {
        command: async () => { throw new Error('ECONNRESET'); },
    });
    assert.equal(thrown, true, 'a thrown command() exception fails safe (configured)');
});

// apra-fleet-eft.32: end-to-end proof (via doltPushAfter's default
// isMemberSyncRemoteConfigured check, no override) that every one of the four
// fail-closed sync.remote query outcomes -- command() throwing, a failSoft
// error result, unparseable output, and empty output -- is treated as
// CONFIGURED and so a non-diverged 'bd dolt push' failure still raises
// DoltSyncError instead of being downgraded to a benign no-remote skip. This
// is the safety-critical default (eft.16.1): an inconclusive sync.remote read
// must never silently swallow a real push failure.
test('doltPushAfter: every fail-closed isMemberSyncRemoteConfigured path (command() throws, failSoft error, unparseable output, empty output) still throws DoltSyncError on a non-diverged push failure', async () => {
    const scenarios = [
        { name: 'command() throws', configHandler: async () => { throw new Error('ECONNRESET'); } },
        { name: 'failSoft error result', configHandler: async () => ({ ok: false, output: '', error: 'boom' }) },
        { name: 'unparseable output', configHandler: async () => ({ ok: true, output: 'not json', error: null }) },
        { name: 'empty output', configHandler: async () => ({ ok: true, output: '', error: null }) },
    ];

    for (const { name, configHandler } of scenarios) {
        const command = async (cmd) => {
            if (cmd.includes('bd config get sync.remote')) return configHandler();
            if (cmd.includes('bd dolt push')) return fail(CREDENTIALS_ERROR);
            return OK;
        };
        await assert.rejects(
            () => doltPushAfter('memberA', { command }),
            DoltSyncError,
            `fail-closed path '${name}' must still throw DoltSyncError (member treated as configured, no silent no-remote skip)`,
        );
    }
});

// -----------------------------------------------------------------------------
// verifyDoerStreakClosed -- the single most divergence-sensitive read.
//
// This is the whole reason apra-fleet-eft.9.1 exists: a remote doer closes its
// assigned beads in ITS OWN clone and D-pushes them. The orchestrator reads a
// DIFFERENT clone, so it MUST D-pull first, or it observes stale (still-open)
// status and falsely reports the streak FAILED.
// -----------------------------------------------------------------------------
test('verifyDoerStreakClosed: D-pulls BEFORE the bd show read, so a remote doer close is NOT falsely reported FAILED', async () => {
    // Model the two-clone reality: the orchestrator clone shows the beads as
    // still OPEN until it D-pulls, at which point it observes the doer's
    // just-pushed closes. If verifyDoerStreakClosed read WITHOUT pulling first,
    // it would see the open snapshot and wrongly return [BD-1, BD-2] (FAILED).
    let pulled = false;
    const openSnapshot = JSON.stringify([
        { id: 'BD-1', status: 'open' },
        { id: 'BD-2', status: 'open' },
    ]);
    const closedSnapshot = JSON.stringify([
        { id: 'BD-1', status: 'closed' },
        { id: 'BD-2', status: 'closed' },
    ]);
    const calls = [];
    const command = async (cmd, opts = {}) => {
        calls.push({ cmd, opts });
        if (cmd.includes('bd dolt pull')) {
            pulled = true;
            return OK;
        }
        if (cmd.includes('bd show')) {
            // Return the freshly-pulled snapshot only if the D-pull ran first.
            return pulled ? closedSnapshot : openSnapshot;
        }
        return OK;
    };

    const unclosed = await verifyDoerStreakClosed({
        command,
        orchestratorMember: 'orchestrator',
        beadIds: ['BD-1', 'BD-2'],
    });

    assert.deepEqual(unclosed, [], 'after the mandatory D-pull the just-pushed closes are visible: streak passes, not FAILED');

    // Structural proof the pull HAPPENED and happened BEFORE the read.
    const pullIdx = calls.findIndex((c) => c.cmd.includes('bd dolt pull'));
    const showIdx = calls.findIndex((c) => c.cmd.includes('bd show'));
    assert.ok(pullIdx !== -1, 'a D-pull was issued');
    assert.ok(showIdx !== -1, 'a bd show verification read was issued');
    assert.ok(pullIdx < showIdx, 'the D-pull runs strictly BEFORE the bd show verification read');
    assert.equal(calls[pullIdx].opts.member_name, 'orchestrator', 'the D-pull runs on the orchestrator clone (3.2 explicit member)');
    assert.equal(calls[showIdx].opts.member_name, 'orchestrator', 'the verification read runs on the orchestrator clone');
});

test('verifyDoerStreakClosed: genuinely-unclosed beads are still reported after a successful D-pull', async () => {
    const snapshot = JSON.stringify([
        { id: 'BD-1', status: 'closed' },
        { id: 'BD-2', status: 'in_progress' },
    ]);
    const { command } = makeCommandMock({
        'bd dolt pull': [OK],
        'bd show': [snapshot],
    });
    const unclosed = await verifyDoerStreakClosed({
        command,
        orchestratorMember: 'orchestrator',
        beadIds: ['BD-1', 'BD-2'],
    });
    assert.deepEqual(unclosed, ['BD-2'], 'a genuinely-open bead is correctly reported as unclosed');
});

test('verifyDoerStreakClosed: a diverged D-pull propagates the typed error (not swallowed into a false PASS)', async () => {
    const { command } = makeCommandMock({ 'bd dolt pull': [fail('merge conflict detected')] });
    await assert.rejects(
        () => verifyDoerStreakClosed({ command, orchestratorMember: 'orchestrator', beadIds: ['BD-1'] }),
        DoltDivergedError,
    );
});

// -----------------------------------------------------------------------------
// Plan 3.3 dolt bracket INSERTION POINTS (source-level enumeration).
//
// Every beads-MUTATING dispatch role must carry `pushBeads: true` so its
// mutations are D-pushed to the shared remote; every read-only role must not.
// This locks in the integ-test-runner/harvester D-push that this bead's rework
// added, and fails if a future mutating dispatch omits it.
// -----------------------------------------------------------------------------
const RUNNER_PATH = path.join(__dirname, '../auto-sprint/runner.js');

/** Given the index of an opening '(' returns the index of its matching ')', skipping string/template contents. */
function balancedClose(src, openParenIdx) {
    let depth = 0;
    for (let i = openParenIdx; i < src.length; i++) {
        const ch = src[i];
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) return i; }
        else if (ch === '"' || ch === "'" || ch === '`') {
            for (i++; i < src.length; i++) {
                if (src[i] === '\\') { i++; continue; }
                if (src[i] === ch) break;
            }
        }
    }
    return src.length;
}

/** Non-comment, non-string call sites of `withGitSync(` with their balanced call text. */
function withGitSyncCallTexts(src) {
    const re = /(?<![.\w])withGitSync\(/g;
    const texts = [];
    let m;
    while ((m = re.exec(src)) !== null) {
        const openIdx = m.index + m[0].length - 1;
        // Skip the function DECLARATION line (`async function withGitSync(`).
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        const lineText = src.slice(lineStart, src.indexOf('\n', m.index));
        if (/^(async\s+)?function\b/.test(lineText.trim())) continue;
        if (lineText.trim().startsWith('//') || lineText.trim().startsWith('*')) continue;
        const end = balancedClose(src, openIdx);
        texts.push(src.slice(openIdx, end + 1));
    }
    return texts;
}

test('Plan 3.3: every beads-mutating dispatch role sets pushBeads:true; read-only roles do not', () => {
    const src = fs.readFileSync(RUNNER_PATH, 'utf8');
    const sites = withGitSyncCallTexts(src);

    // Baseline: nine bracketed dispatches (kept in step with
    // dispatch-sync-bracket-coverage.test.mjs's EXPECTED_WITHGITSYNC_CALL_COUNT).
    // Bumped 8 -> 9 (2026-07-19): the doer max_turns-exhaustion resume path
    // (dispatchDoerResume) is the same logical doer streak continuing, so it
    // gets its own withGitSync(...) bracket identical in shape to the
    // original dispatchDoer.
    // Bumped 9 -> 10 (2026-07-19, stabilization log Issue 9): the reviewer
    // gained the same max_turns-exhaustion resume path
    // (dispatchReviewerResume) -- a READ-side bracket (pushCode: false, no
    // pushBeads), so the pushBeads count below is unchanged.
    // 10 -> 11 (stabilization log iteration 5): Final Review resume bracket
    // (read-side, no pushBeads -- pushBeads count below unchanged).
    assert.equal(sites.length, 16, `expected 16 withGitSync(...) dispatch brackets, found ${sites.length}`);

    const hasPushBeads = (t) => /\{\s*pushBeads:\s*true\s*\}/.test(t);
    const pushBeadsSites = sites.filter(hasPushBeads);

    // Four roles mutate beads: planner (new tasks), doer (closes),
    // integ-test-runner (feature-close + bug-file), harvester (issue-defer).
    // Doer and integ-test-runner each have TWO pushBeads:true sites
    // (dispatch + same-session turn-exhaustion resume), so 8 sites total.
    assert.equal(
        pushBeadsSites.length,
        8,
        `expected exactly 8 withGitSync(...) brackets with pushBeads:true (planner+resume, doer+resume, integ+resume, harvester+resume), found ${pushBeadsSites.length}`,
    );

    const roleMarkers = [
        { name: 'planner', re: /getMemberForRole\('planner'\)|agentType:\s*'planner'/ },
        { name: 'doer', re: /agentType:\s*'doer'/ },
        { name: 'integ-test-runner', re: /getMemberForRole\('integ-test-runner'\)|agentType:\s*'integ-test-runner'/ },
        { name: 'harvester', re: /getMemberForRole\('harvester'\)|agentType:\s*'harvester'/ },
    ];
    for (const { name, re } of roleMarkers) {
        assert.ok(
            pushBeadsSites.some((t) => re.test(t)),
            `the ${name} dispatch must be one of the pushBeads:true brackets (its beads mutations must be D-pushed)`,
        );
    }
});
