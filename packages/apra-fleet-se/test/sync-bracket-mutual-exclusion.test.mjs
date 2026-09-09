import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSyncBrackets, createGitSync, CODE_WRITE_BRACKET_KEY } from '../fleet-sprint/git-sync.mjs';
import { ConcurrentSyncBracketError } from '../fleet-sprint/errors.mjs';
import { doltPushAfter, clearDegradedSyncRecords, getDegradedSyncRecords } from '../fleet-sprint/dolt-sync.mjs';
import { syncMemberBefore, syncMemberAfter, syncMemberAfterOrdered, isNoMutationDispatchFailure } from '../fleet-sprint/runner.js';

// withGitSync's ctx needs every one of these threaded through exactly like
// runner.js's own createGitSync({...}) call does (see runner.js's own
// createGitSync call site) -- git-sync.mjs never imports runner.js back, so
// its own sync helpers are always dependency-injected, never imported by
// git-sync.mjs itself.
function makeWithGitSyncDeps({ brackets, command, log = () => {} }) {
    return {
        brackets, command, log, branch: 'feat/3swo-4-9', agent: undefined,
        doltPushMutex: undefined, sprintId: 'sprint-3swo-4-9',
        onAuthFailure: undefined, resolveMemberProvider: undefined,
        ensureVcsAuthFresh: async () => {},
        syncMemberBefore, syncMemberAfter, syncMemberAfterOrdered, isNoMutationDispatchFailure,
    };
}

const check = (cond, msg) => assert.ok(cond, msg);

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

// =============================================================================
// apra-fleet-3swo.4.9 part (a) -- mutual-exclusion throw.
//
// INVESTIGATION FINDING (recorded on the bead, restated here): the codebase
// has NO call site today where a bracketed helper is invoked from INSIDE a
// withGitSync() dispatch thunk for the same member -- so no same-owner LIFO
// nesting currently exists in runner.js. What DOES legitimately happen is
// CROSS-member/cross-operation overlap (e.g. different D-push brackets
// serialized by their own dolt push mutex, not by this counter), and doer/
// harvester (pushCode:true) G-push brackets are additionally kept from ever
// overlapping AT ALL by runner.js's own `globalDoerTurn` FIFO gate (see
// git-sync-brackets.test.mjs test (b), which asserts maxActive <= 1 across
// two different members). A naive "throw whenever more than one bracket is
// open" would therefore have been a REGRESSION: it would fire on legitimate
// cross-member concurrency the fleet relies on for parallel dispatch.
//
// The fix implemented here is the "owner token" distinction the bead itself
// suggested: `exclusiveKey` opts a bracket into a per-key STACK. Brackets
// sharing a key may nest to any depth (LIFO close, never throws) but a
// CROSSING close (the bracket that opened FIRST closing while one opened
// LATER, sharing the same key, is still open) throws ConcurrentSyncBracket
// Error naming both. withGitSync() opts every pushCode:true bracket into the
// SAME shared key (CODE_WRITE_BRACKET_KEY) regardless of member, because the
// resource mutual exclusion protects is the shared git branch, not any one
// member -- this is a defense-in-depth safety net for exactly the invariant
// globalDoerTurn already enforces, catching a regression in that external
// gate rather than being relied on to permit new concurrency.
// =============================================================================
describe('apra-fleet-3swo.4.9 (a): mutual-exclusion tracking on createSyncBrackets()', () => {
    test('NESTING case: two brackets sharing the same exclusiveKey that close LIFO (inner closes before outer) never throw, at any depth', async () => {
        const brackets = createSyncBrackets();
        const order = [];
        await brackets.withOpenSyncBracket(async () => {
            order.push('outer-open');
            await brackets.withOpenSyncBracket(async () => {
                order.push('inner-open');
                await brackets.withOpenSyncBracket(async () => {
                    order.push('innermost-open');
                }, { exclusiveKey: 'k', label: 'innermost' });
                order.push('inner-close');
            }, { exclusiveKey: 'k', label: 'inner' });
            order.push('outer-close');
        }, { exclusiveKey: 'k', label: 'outer' });
        check(brackets.openBracketCount() === 0, 'all three brackets must have closed cleanly');
        assert.deepEqual(order, ['outer-open', 'inner-open', 'innermost-open', 'inner-close', 'outer-close']);
    });

    test('OVERLAP case: the FIRST-opened bracket closing while a LATER-opened bracket sharing its key is still open throws ConcurrentSyncBracketError naming both', async () => {
        const brackets = createSyncBrackets();
        const gateB = deferred();
        let bOpened = false;

        // A opens first, then starts an independent (not-awaited-inline) async
        // chain B that also opens under the SAME key while A is still open.
        // A resolves and CLOSES before B does -- a crossing, non-LIFO close.
        const pA = brackets.withOpenSyncBracket(async () => {
            // Give B a chance to open before A tries to close.
            while (!bOpened) await Promise.resolve();
            return 'a-result';
        }, { exclusiveKey: 'shared', label: 'bracket-A' });

        const pB = brackets.withOpenSyncBracket(async () => {
            bOpened = true;
            await gateB.promise;
            return 'b-result';
        }, { exclusiveKey: 'shared', label: 'bracket-B' });

        let errA = null;
        try {
            await pA;
        } catch (e) {
            errA = e;
        }
        check(errA instanceof ConcurrentSyncBracketError, `expected ConcurrentSyncBracketError, got ${errA && errA.constructor.name}`);
        check(errA.exclusiveKey === 'shared', 'error carries the colliding exclusiveKey');
        check(errA.closingLabel === 'bracket-A', 'error names the bracket that was closing');
        check(errA.stillOpenLabels.includes('bracket-B'), `error must name the still-open bracket, got: ${JSON.stringify(errA.stillOpenLabels)}`);

        // Let B finish so the test doesn't leave a dangling promise; B itself
        // completes normally (it is the one still open, not the violator).
        gateB.resolve();
        const bRes = await pB;
        check(bRes === 'b-result', 'the still-open bracket completes normally once released');
        check(brackets.openBracketCount() === 0, 'both brackets must have closed by the end');
    });

    test('different exclusiveKeys (or no key at all) never throw on overlap -- this is the legitimate cross-member/cross-operation concurrency that must be preserved', async () => {
        const brackets = createSyncBrackets();
        const gate1 = deferred();
        const gate2 = deferred();

        const p1 = brackets.withOpenSyncBracket(async () => { await gate1.promise; return 1; }, { exclusiveKey: 'member-x86', label: 'x86' });
        const p2 = brackets.withOpenSyncBracket(async () => { await gate2.promise; return 2; }, { exclusiveKey: 'member-arm64', label: 'arm64' });
        const p3 = brackets.withOpenSyncBracket(async () => 3); // no key at all

        check(brackets.openBracketCount() >= 2, 'multiple brackets are genuinely open concurrently');
        // Resolve out of open order (2 closes before 1, which opened first) --
        // this is exactly the "crossing" shape that WOULD throw under a shared
        // key, and must NOT throw here because the keys differ.
        gate2.resolve();
        const r2 = await p2;
        gate1.resolve();
        const r1 = await p1;
        const r3 = await p3;
        check(r1 === 1 && r2 === 2 && r3 === 3, 'all three brackets resolve their own values with no interference');
        check(brackets.openBracketCount() === 0, 'all brackets closed cleanly');
    });

    test('withGitSync(pushCode:true) for two DIFFERENT members opts into the SAME exclusiveKey (CODE_WRITE_BRACKET_KEY) and a crossing overlap throws', async () => {
        const brackets = createSyncBrackets();
        const OK = { ok: true, output: '', error: null };
        const command = async () => OK;
        const gitSync = createGitSync(makeWithGitSyncDeps({ brackets, command }));

        const gateB = deferred();
        let bOpened = false;

        const pA = gitSync.withGitSync('member-a', true, async () => {
            while (!bOpened) await Promise.resolve();
            return 'a-dispatch-result';
        }, { pushBeads: false });

        const pB = gitSync.withGitSync('member-b', true, async () => {
            bOpened = true;
            await gateB.promise;
            return 'b-dispatch-result';
        }, { pushBeads: false });

        let errA = null;
        try {
            await pA;
        } catch (e) {
            errA = e;
        }
        check(errA instanceof ConcurrentSyncBracketError, `expected ConcurrentSyncBracketError from the pushCode:true bracket that closed first, got ${errA && errA.constructor.name}`);
        check(errA.exclusiveKey === CODE_WRITE_BRACKET_KEY, 'both code-writing brackets must share the module-level CODE_WRITE_BRACKET_KEY regardless of member');

        gateB.resolve();
        await pB; // the still-open bracket completes normally
    });

    test('withGitSync(pushCode:false) never opts into CODE_WRITE_BRACKET_KEY -- two overlapping read-only brackets for different members never throw', async () => {
        const brackets = createSyncBrackets();
        const OK = { ok: true, output: '', error: null };
        const command = async () => OK;
        const gitSync = createGitSync(makeWithGitSyncDeps({ brackets, command }));

        const gate2 = deferred();
        let opened2 = false;

        const p1 = gitSync.withGitSync('planner-1', false, async () => {
            while (!opened2) await Promise.resolve();
            return 'r1';
        }, {});
        const p2 = gitSync.withGitSync('planner-2', false, async () => {
            opened2 = true;
            await gate2.promise;
            return 'r2';
        }, {});

        // p1 (opened first) will resolve and close BEFORE p2 -- a crossing
        // shape -- but since pushCode:false never assigns an exclusiveKey,
        // this must complete cleanly with no throw.
        const r1 = await p1;
        check(r1 === 'r1', 'pushCode:false brackets complete normally even overlapping in crossing order');
        gate2.resolve();
        const r2 = await p2;
        check(r2 === 'r2');
        check(brackets.openBracketCount() === 0);
    });
});

// =============================================================================
// apra-fleet-3swo.4.9 part (b) -- the Final Review findings D-push
// (gitSync.pushBeadsAfter) now routes through DoltSync.syncAfter() instead of
// calling doltPushAfter() bare, so it DEGRADES (returns a structured, non-
// throwing outcome) on an unresolved failure exactly like its sibling
// syncBeadsAfter(), rather than always throwing. This directly compares the
// OLD primitive (bare doltPushAfter, imported straight from dolt-sync.mjs) to
// the NEW wrapper (gitSync.pushBeadsAfter) against the IDENTICAL failing
// command, in the same test, so the comparison itself proves the change: if
// pushBeadsAfter regressed back to calling doltPushAfter() bare, this test
// would fail the same way the falsified assertion below documents.
// =============================================================================
describe('apra-fleet-3swo.4.9 (b): gitSync.pushBeadsAfter() inherits DoltSync.syncAfter()\'s degrade-by-default tolerance', () => {
    function makeFailingCommand() {
        const calls = [];
        const command = async (cmd, opts = {}) => {
            calls.push({ cmd, opts });
            if (cmd.includes('bd config get sync.remote')) {
                // Pre-gate probe: report configured so the push is actually attempted.
                return { ok: true, output: 'https://example.invalid/beads-remote', error: null };
            }
            if (cmd.includes('bd dolt push')) {
                return { ok: false, output: '', error: 'some totally novel unrecoverable dolt push failure' };
            }
            if (cmd.includes('bd dolt pull')) {
                return { ok: false, output: '', error: 'some totally novel unrecoverable dolt pull failure' };
            }
            return { ok: true, output: '', error: null };
        };
        return { command, calls };
    }

    test('BASELINE: the OLD primitive (bare doltPushAfter) still throws on an unresolved failure -- proves the failing fixture is real', async () => {
        const { command } = makeFailingCommand();
        let err = null;
        try {
            await doltPushAfter('memberX', { command, log: () => {}, maxTransientRetries: 0 });
        } catch (e) {
            err = e;
        }
        check(err !== null, 'bare doltPushAfter must still throw on an unresolved failure (pre-existing, unchanged behavior)');
    });

    test('NEW: gitSync.pushBeadsAfter() does NOT throw on the SAME unresolved failure -- it degrades, logs, and records it', async () => {
        clearDegradedSyncRecords('memberX');
        const { command } = makeFailingCommand();
        const logs = [];
        const brackets = createSyncBrackets();
        const gitSync = createGitSync({ brackets, command, log: (m) => logs.push(m), doltPushMutex: undefined, sprintId: 'sprint-3swo-4-9-b' });

        let threw = null;
        let res;
        try {
            res = await gitSync.pushBeadsAfter('memberX', { pushBeads: true, maxTransientRetries: 0 });
        } catch (e) {
            threw = e;
        }
        check(threw === null, `gitSync.pushBeadsAfter must NOT throw on an unresolved failure (must degrade instead), but it threw: ${threw && threw.message}`);
        check(res.ok === false && res.degraded === true, `expected a degraded structured outcome, got: ${JSON.stringify(res)}`);
        check(logs.some((m) => /DEGRADED \(non-fatal\)/.test(m)), 'a DEGRADED log line must be emitted');
        const records = getDegradedSyncRecords({ member: 'memberX' });
        check(records.length > 0, 'the degraded failure must be recorded via DoltSync.getDegradedSyncRecords()');
        check(brackets.openBracketCount() === 0, 'the bracket must still close cleanly even though the underlying push degraded rather than threw');

        clearDegradedSyncRecords('memberX');
    });

    test('gitSync.pushBeadsAfter() retries a TRANSIENT failure at this call site and succeeds without throwing (locks in the literal "transient failure is retried" acceptance bullet for THIS call site, which had no dedicated regression test before)', async () => {
        const calls = [];
        let pushAttempts = 0;
        const command = async (cmd) => {
            calls.push(cmd);
            if (cmd.includes('bd config get sync.remote')) return { ok: true, output: 'https://example.invalid/beads-remote', error: null };
            if (cmd.includes('bd dolt push')) {
                pushAttempts += 1;
                if (pushAttempts === 1) return { ok: false, output: '', error: 'connection refused' };
                return { ok: true, output: '', error: null };
            }
            return { ok: true, output: '', error: null };
        };
        const brackets = createSyncBrackets();
        const gitSync = createGitSync({ brackets, command, log: () => {}, doltPushMutex: undefined, sprintId: 'sprint-3swo-4-9-transient' });

        const res = await gitSync.pushBeadsAfter('memberT', { pushBeads: true });
        check(res.ok === true && res.pushed === true, `expected the transient failure to be retried to a successful push, got: ${JSON.stringify(res)}`);
        check(pushAttempts === 2, `expected exactly 2 'bd dolt push' attempts (1 failure + 1 retry), saw ${pushAttempts}`);
    });

    test('gitSync.pushBeadsAfter() still supports fatal:true to opt back into the old throwing behavior at this call site', async () => {
        const { command } = makeFailingCommand();
        const brackets = createSyncBrackets();
        const gitSync = createGitSync({ brackets, command, log: () => {}, doltPushMutex: undefined, sprintId: 'sprint-3swo-4-9-fatal' });

        let err = null;
        try {
            await gitSync.pushBeadsAfter('memberY', { pushBeads: true, maxTransientRetries: 0, fatal: true });
        } catch (e) {
            err = e;
        }
        check(err !== null, 'fatal:true must still throw, preserving an explicit escape hatch back to hard-abort behavior');
        check(brackets.openBracketCount() === 0, 'the bracket must still close cleanly on the fatal throw path');
    });

    test('gitSync.pushBeadsAfter() on a SUCCESSFUL push still reports ok:true/pushed:true (unchanged happy-path contract)', async () => {
        const calls = [];
        const command = async (cmd) => {
            calls.push(cmd);
            return { ok: true, output: '', error: null };
        };
        const brackets = createSyncBrackets();
        const gitSync = createGitSync({ brackets, command, log: () => {}, doltPushMutex: undefined, sprintId: 'sprint-3swo-4-9-happy' });

        const res = await gitSync.pushBeadsAfter('memberZ', { pushBeads: true });
        check(res.ok === true && res.pushed === true, `expected a successful push, got: ${JSON.stringify(res)}`);
        check(calls.some((c) => c.includes('bd dolt push')), 'a bd dolt push command must actually have been issued');
    });
});
