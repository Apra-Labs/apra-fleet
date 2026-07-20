import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import {
    classifyDoltFailure,
    doltPullBefore,
    doltPushAfter,
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
