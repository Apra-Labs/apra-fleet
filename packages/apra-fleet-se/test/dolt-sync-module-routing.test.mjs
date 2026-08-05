import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    doltPullBefore,
    doltPushAfter,
    preflightBeadsHealthGate,
    syncMemberAfterOrdered,
    finalizeAbort,
} from '../fleet-sprint/runner.js';
import { DoltSync } from '../fleet-sprint/dolt-sync.mjs';
import { checkDoltLiteralPath } from '../fleet-sprint/dolt-literal-guard.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNNER_PATH = path.join(__dirname, '../fleet-sprint/runner.js');

// =============================================================================
// apra-fleet-417.2.4 -- every runner.js dolt call site routes through the
// single sync module (./dolt-sync.mjs), and nowhere else.
//
// doltPullBefore / doltPushAfter / preflightBeadsHealthGate are imported here
// from runner.js's own re-export (apra-fleet-417.2.2's back-compat seam --
// see runner.js's comment immediately above `export { ... } from
// './dolt-sync.mjs'`), which resolves to the SAME dolt-sync.mjs
// implementation syncMemberAfterOrdered's D-push and DoltSync.syncBefore's
// pre-flight both call -- so exercising them here against a fake command()
// is exercising the real sync module, not a raw-string reimplementation.
//
// syncMemberAfterOrdered's D-push and preflightBeadsHealthGate's callers are
// additionally proven to route through the DoltSync module HANDLE (not just
// "the same file") by monkey-patching DoltSync.syncAfter/syncBefore with a
// spy and restoring the original afterward -- "spy on the module, not on raw
// strings" per the bead's own instruction.
// =============================================================================

const check = (cond, msg) => assert.ok(cond, msg);

// A tiny scripted command() mock, matching the style already used by
// dolt-sync-brackets.test.mjs / git-sync-brackets.test.mjs in this suite.
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

/** Monkey-patch a method on the DoltSync module handle with a spy that
 *  records every call and delegates to the original implementation, then
 *  returns a restore() that puts the original back. DoltSync is a plain,
 *  unfrozen object (see dolt-sync.mjs's `export const DoltSync = {...}`), and
 *  runner.js imports the SAME object reference (Node's module cache), so
 *  mutating a property here is visible to runner.js's own
 *  `DoltSync.<method>(...)` call sites without any module-mocking framework. */
function spyOnDoltSync(method) {
    const original = DoltSync[method];
    const calls = [];
    DoltSync[method] = async (...args) => {
        calls.push(args);
        return original.apply(DoltSync, args);
    };
    return { calls, restore: () => { DoltSync[method] = original; } };
}

// -----------------------------------------------------------------------
// Assertion 1: doltPullBefore / doltPushAfter / preflightBeadsHealthGate
// issue their dolt commands via the sync module's real implementation
// (proven by driving them through a fake command() and observing the actual
// 'bd dolt pull'/'bd dolt push' dispatch), and syncMemberAfterOrdered's
// D-push routes through the DoltSync module handle (proven via the spy).
// -----------------------------------------------------------------------

test('doltPullBefore issues its dolt command via the sync module (real dispatch through the injected command())', async () => {
    const { command, calls } = makeCommandMock({ 'bd dolt pull': [OK] });
    const res = await doltPullBefore('m1', { command });
    check(res.ok, `expected doltPullBefore to succeed, got: ${JSON.stringify(res)}`);
    const pullCalls = calls.filter((c) => c.cmd.includes('bd dolt pull'));
    check(pullCalls.length === 1, `expected exactly one real 'bd dolt pull' dispatch, saw ${pullCalls.length}`);
    check(pullCalls[0].opts.member_name === 'm1', 'the dispatched pull carries an explicit member_name');
});

test('doltPushAfter issues its dolt command via the sync module (real dispatch through the injected command())', async () => {
    const { command, calls } = makeCommandMock({ 'bd dolt push': [OK] });
    const res = await doltPushAfter('m1', { command, pushBeads: true });
    check(res.ok, `expected doltPushAfter to succeed, got: ${JSON.stringify(res)}`);
    const pushCalls = calls.filter((c) => c.cmd.includes('bd dolt push'));
    check(pushCalls.length === 1, `expected exactly one real 'bd dolt push' dispatch, saw ${pushCalls.length}`);
    check(pushCalls[0].opts.member_name === 'm1', 'the dispatched push carries an explicit member_name');
});

test('preflightBeadsHealthGate issues its dolt command via the sync module (real dispatch through the injected command())', async () => {
    const { command, calls } = makeCommandMock({ 'bd dolt pull': [OK] });
    const res = await preflightBeadsHealthGate('m1', { command });
    check(res.ok, `expected preflightBeadsHealthGate to succeed, got: ${JSON.stringify(res)}`);
    const pullCalls = calls.filter((c) => c.cmd.includes('bd dolt pull'));
    check(pullCalls.length === 1, `expected exactly one real 'bd dolt pull' dispatch (the health-gate probe), saw ${pullCalls.length}`);
});

test('syncMemberAfterOrdered routes its D-push through the DoltSync module handle (spied, not a raw-string check)', async () => {
    const spy = spyOnDoltSync('syncAfter');
    try {
        const { command } = makeCommandMock({
            'git push': [OK],
            'git status --porcelain': [OK],
            'bd dolt push': [OK],
            'bd config get sync.remote --json': ['{"value":"origin"}'],
        });
        await syncMemberAfterOrdered('m1', { command, pushCode: true, pushBeads: true });
        check(spy.calls.length === 1, `expected DoltSync.syncAfter to be called exactly once, saw ${spy.calls.length}`);
        check(spy.calls[0][0] === 'm1', 'DoltSync.syncAfter is called with the right member');
        check(spy.calls[0][1].pushBeads === true, 'DoltSync.syncAfter receives pushBeads:true from syncMemberAfterOrdered');
    } finally {
        spy.restore();
    }
});

// -----------------------------------------------------------------------
// Assertion 2: preserved behavior.
// -----------------------------------------------------------------------

test('preserved behavior: skipRefresh suppresses only the pull spawn -- the sync.remote pre-gate probe still runs', async () => {
    const { command, calls } = makeCommandMock({
        'bd config get sync.remote --json': ['{"value":"origin"}'],
        'bd dolt pull': [OK],
    });
    const res = await DoltSync.syncBefore('m1', { command, skipRefresh: true });
    check(res.ok && res.kind === 'already-fresh', `expected a benign already-fresh skip, got: ${JSON.stringify(res)}`);
    const gateCalls = calls.filter((c) => c.cmd.includes('bd config get sync.remote'));
    check(gateCalls.length === 1, `expected the sync.remote pre-gate probe to still run once, saw ${gateCalls.length}`);
    const pullCalls = calls.filter((c) => c.cmd.includes('bd dolt pull'));
    check(pullCalls.length === 0, `expected the 'bd dolt pull' spawn itself to be suppressed, saw ${pullCalls.length}`);
});

test('preserved behavior: the D-push mutex is still acquired/released around doltPushAfter', async () => {
    const { command } = makeCommandMock({ 'bd dolt push': [OK] });
    const mutexCalls = [];
    const mutex = {
        acquire: async (id) => { mutexCalls.push(['acquire', id]); return { token: 'tok-1' }; },
        release: async (token) => { mutexCalls.push(['release', token]); },
    };
    const res = await doltPushAfter('m1', { command, pushBeads: true, mutex, sprintId: 'sprint-1' });
    check(res.ok, `expected doltPushAfter to succeed, got: ${JSON.stringify(res)}`);
    check(mutexCalls.some((c) => c[0] === 'acquire' && c[1] === 'sprint-1'), `expected mutex.acquire('sprint-1'), saw: ${JSON.stringify(mutexCalls)}`);
    check(mutexCalls.some((c) => c[0] === 'release' && c[1] === 'tok-1'), `expected mutex.release('tok-1'), saw: ${JSON.stringify(mutexCalls)}`);
});

test('preserved behavior: onAuthFailure is threaded through doltPullBefore and doltPushAfter for the one-shot self-heal', async () => {
    let healPullCalls = 0;
    const pullMock = makeCommandMock({
        'bd dolt pull': [fail('fatal: could not read Username for \'https://github.com\': Device not configured'), OK],
    });
    const pullRes = await doltPullBefore('m1', {
        command: pullMock.command,
        onAuthFailure: async () => { healPullCalls += 1; },
    });
    check(pullRes.ok, `expected the pull to recover after the self-heal retry, got: ${JSON.stringify(pullRes)}`);
    check(healPullCalls === 1, `expected onAuthFailure to be invoked exactly once for the pull, saw ${healPullCalls}`);

    let healPushCalls = 0;
    const pushMock = makeCommandMock({
        'bd dolt push': [fail('remote: Bad credentials'), OK],
    });
    const pushRes = await doltPushAfter('m1', {
        command: pushMock.command,
        pushBeads: true,
        onAuthFailure: async () => { healPushCalls += 1; },
    });
    check(pushRes.ok, `expected the push to recover after the self-heal retry, got: ${JSON.stringify(pushRes)}`);
    check(healPushCalls === 1, `expected onAuthFailure to be invoked exactly once for the push, saw ${healPushCalls}`);
});

// -----------------------------------------------------------------------
// finalizeAbort: it must issue ZERO dolt commands of its own (it is a
// git-only + PR-raise path -- see runner.js's finalizeAbort, which never
// mentions dolt at all) -- proven both by watching DoltSync's methods for
// zero calls and by scanning the raw command() log for zero 'bd dolt'
// dispatches, so a future edit that inlines a dolt call into finalizeAbort
// (instead of routing it through DoltSync) fails this test.
// -----------------------------------------------------------------------

test('finalizeAbort issues zero dolt commands -- it is a git-only path and never calls DoltSync', async () => {
    const spyBefore = spyOnDoltSync('syncBefore');
    const spyAfter = spyOnDoltSync('syncAfter');
    try {
        const { command, calls } = makeCommandMock({
            'git fetch origin': [OK],
            'git rev-list --count': [{ ok: true, output: '0', error: null }],
        });
        const res = await finalizeAbort({
            error: new Error('typed abort'),
            branch: 'sprint/x',
            baseBranch: 'main',
            member: 'm1',
            command,
            log: () => {},
        });
        check(res.reason === 'zero-commit-abort', `expected the zero-commit-abort short-circuit, got: ${JSON.stringify(res)}`);
        const doltCalls = calls.filter((c) => c.cmd.includes('bd dolt'));
        check(doltCalls.length === 0, `expected zero raw 'bd dolt' dispatches from finalizeAbort, saw ${JSON.stringify(doltCalls)}`);
        check(spyBefore.calls.length === 0 && spyAfter.calls.length === 0, 'expected DoltSync.syncBefore/syncAfter to never be called by finalizeAbort');
    } finally {
        spyBefore.restore();
        spyAfter.restore();
    }
});

// -----------------------------------------------------------------------
// Assertion 3: the apra-fleet-417.2.3 mechanical guard is wired into this
// test run -- both by living under test/*.test.mjs (npm test's own glob,
// see dolt-literal-guard.test.mjs) and, redundantly, by being importable and
// green from within this file too.
// -----------------------------------------------------------------------

test('the apra-fleet-417.2.3 dolt-literal guard is wired into this test run and passes on runner.js', () => {
    const { violations } = checkDoltLiteralPath(RUNNER_PATH);
    check(violations.length === 0, `expected zero direct dolt-literal violations in runner.js, got: ${JSON.stringify(violations)}`);
});
