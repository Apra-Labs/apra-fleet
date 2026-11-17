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

// =============================================================================
// apra-fleet-3swo.26 / apra-fleet-3swo.31 -- a crossing sync-bracket close
// preserves the bracketed body failure.
//
// Before apra-fleet-3swo.26, a CROSSING close (see the OVERLAP case test
// above) always threw a fresh ConcurrentSyncBracketError from the `finally`
// block, which in JS semantics REPLACES any exception already in flight from
// the bracketed body -- so if the body itself had rejected, that original
// (usually more diagnosable) error was silently discarded in favor of the
// crossing-close symptom. The fix attaches the body's own rejection as the
// thrown ConcurrentSyncBracketError's native `cause` when the body threw
// (`undefined` when it did not). The OVERLAP case test above only exercises a
// SUCCESSFUL body racing a crossing close; this block adds the missing
// "body also failed" case, plus a dedicated regression guard for the
// unchanged successful-body shape and the two paths that must NEVER wrap
// (LIFO close, no key at all).
//
// One-line revert used to confirm case (a) fails without the fix (cases (b),
// (c) and (d) keep passing -- verified directly against this file): in
// git-sync.mjs's withOpenSyncBracket(), change the ConcurrentSyncBracketError
// constructor's options argument from
//   { exclusiveKey, closingLabel: token.label, stillOpenLabels, cause: bodyThrew ? bodyError : undefined }
// to
//   { exclusiveKey, closingLabel: token.label, stillOpenLabels }
// =============================================================================
describe('apra-fleet-3swo.26: a crossing sync-bracket close preserves the bracketed body failure', () => {
    test('(a) body rejects and the close is a CROSSING close -- surfaced error is ConcurrentSyncBracketError with cause identity to the body error', async () => {
        const brackets = createSyncBrackets({});
        const gateB = deferred();
        let bOpened = false;
        const bodyErr = new Error('bracket-A body failed');

        const pA = brackets.withOpenSyncBracket(async () => {
            while (!bOpened) await Promise.resolve();
            throw bodyErr;
        }, { exclusiveKey: 'shared-a', label: 'bracket-A' });

        const pB = brackets.withOpenSyncBracket(async () => {
            bOpened = true;
            await gateB.promise;
            return 'b-result';
        }, { exclusiveKey: 'shared-a', label: 'bracket-B' });

        let errA = null;
        try {
            await pA;
        } catch (e) {
            errA = e;
        }
        check(errA instanceof ConcurrentSyncBracketError, `expected ConcurrentSyncBracketError, got ${errA && errA.constructor.name}`);
        assert.strictEqual(errA.cause, bodyErr, 'cause must be the EXACT body error instance, not a re-derived copy or message-only wrapper');
        check(errA.exclusiveKey === 'shared-a', 'error carries the colliding exclusiveKey');
        check(errA.closingLabel === 'bracket-A', 'error names the bracket that was closing');
        check(errA.stillOpenLabels.includes('bracket-B'), `error must name the still-open bracket, got: ${JSON.stringify(errA.stillOpenLabels)}`);

        gateB.resolve();
        const bRes = await pB;
        check(bRes === 'b-result', 'the still-open bracket completes normally once released');
        check(brackets.openBracketCount() === 0, 'both brackets must have closed by the end');
    });

    test('(b) body succeeds and the close crosses -- regression guard: unchanged shape (message, exclusiveKey, closingLabel, stillOpenLabels), cause undefined', async () => {
        const brackets = createSyncBrackets({});
        const gateB = deferred();
        let bOpened = false;

        const pA = brackets.withOpenSyncBracket(async () => {
            while (!bOpened) await Promise.resolve();
            return 'a-result';
        }, { exclusiveKey: 'shared-b', label: 'bracket-A' });

        const pB = brackets.withOpenSyncBracket(async () => {
            bOpened = true;
            await gateB.promise;
            return 'b-result';
        }, { exclusiveKey: 'shared-b', label: 'bracket-B' });

        let errA = null;
        try {
            await pA;
        } catch (e) {
            errA = e;
        }
        check(errA instanceof ConcurrentSyncBracketError, `expected ConcurrentSyncBracketError, got ${errA && errA.constructor.name}`);
        check(
            errA.message ===
                `[Sync] mutual-exclusion violation on key 'shared-b': bracket 'bracket-A' closed while ` +
                `1 other bracket(s) sharing the same key is still open (bracket-B) -- these OVERLAPPED rather than nested, which breaks the ` +
                `fast-forward-by-construction invariant this key protects.`,
            `unexpected message shape: ${errA.message}`,
        );
        check(errA.exclusiveKey === 'shared-b', 'error carries the colliding exclusiveKey');
        check(errA.closingLabel === 'bracket-A', 'error names the bracket that was closing');
        assert.deepEqual(errA.stillOpenLabels, ['bracket-B'], 'error names exactly the still-open bracket');
        assert.strictEqual(errA.cause, undefined, 'cause must be undefined when the bracketed body succeeded -- reshaping the success-body error must fail this');

        gateB.resolve();
        const bRes = await pB;
        check(bRes === 'b-result', 'the still-open bracket completes normally once released');
        check(brackets.openBracketCount() === 0, 'both brackets must have closed by the end');
    });

    test('(c) body rejects and the close is a normal LIFO close -- body error propagates by identity, unwrapped', async () => {
        const brackets = createSyncBrackets({});
        const bodyErr = new Error('nested body failed');
        let caught = null;
        try {
            await brackets.withOpenSyncBracket(async () => {
                await brackets.withOpenSyncBracket(async () => {
                    throw bodyErr;
                }, { exclusiveKey: 'k-lifo', label: 'inner' });
            }, { exclusiveKey: 'k-lifo', label: 'outer' });
        } catch (e) {
            caught = e;
        }
        assert.strictEqual(caught, bodyErr, 'the body error must propagate by identity through a LIFO close, never wrapped in a ConcurrentSyncBracketError');
        check(brackets.openBracketCount() === 0, 'both brackets must have closed cleanly (no leaked bracket after a LIFO close+throw)');
    });

    test('(d) counter integrity across all three paths: openBracketCount() returns to its starting value after each', async () => {
        const brackets = createSyncBrackets({});
        assert.equal(brackets.openBracketCount(), 0, 'starts at zero');

        // Path 1: crossing close, rejecting body (case (a) shape).
        {
            const gateB = deferred();
            let bOpened = false;
            const bodyErr = new Error('d-path1');
            const pA = brackets.withOpenSyncBracket(async () => {
                while (!bOpened) await Promise.resolve();
                throw bodyErr;
            }, { exclusiveKey: 'd-key-1', label: 'A' });
            const pB = brackets.withOpenSyncBracket(async () => {
                bOpened = true;
                await gateB.promise;
                return 'b';
            }, { exclusiveKey: 'd-key-1', label: 'B' });
            await assert.rejects(pA, ConcurrentSyncBracketError);
            gateB.resolve();
            await pB;
            assert.equal(brackets.openBracketCount(), 0, 'count returns to zero after path 1 (crossing close, rejecting body)');
        }

        // Path 2: crossing close, succeeding body (case (b) shape).
        {
            const gateB2 = deferred();
            let bOpened2 = false;
            const pA2 = brackets.withOpenSyncBracket(async () => {
                while (!bOpened2) await Promise.resolve();
                return 'a2';
            }, { exclusiveKey: 'd-key-2', label: 'A2' });
            const pB2 = brackets.withOpenSyncBracket(async () => {
                bOpened2 = true;
                await gateB2.promise;
                return 'b2';
            }, { exclusiveKey: 'd-key-2', label: 'B2' });
            await assert.rejects(pA2, ConcurrentSyncBracketError);
            gateB2.resolve();
            await pB2;
            assert.equal(brackets.openBracketCount(), 0, 'count returns to zero after path 2 (crossing close, succeeding body)');
        }

        // Path 3: normal LIFO close, rejecting body (case (c) shape).
        {
            const bodyErr3 = new Error('d-path3');
            await assert.rejects(
                brackets.withOpenSyncBracket(async () => { throw bodyErr3; }, { exclusiveKey: 'd-key-3', label: 'solo' }),
                (e) => e === bodyErr3,
            );
            assert.equal(brackets.openBracketCount(), 0, 'count returns to zero after path 3 (LIFO close, rejecting body)');
        }
    });
});

// =============================================================================
// apra-fleet-3swo.43 / apra-fleet-3swo.47 -- crossing-close pause-guard poke
// timing.
//
// 0b928181 (apra-fleet-3swo.43) hoisted the finally block's pause-guard poke
// ahead of the crossing-close throw, so the poke is EVALUATED even on a
// crossing close instead of being skipped by an early throw. apra-fleet-
// 3swo.47's review found the ORIGINALLY planned assertion for this
// ("setPauseGuard is still called when the closing bracket was the last open
// one, on a CROSSING close") describes a state that cannot occur: a crossing
// close is only ever entered while another bracket sharing the same
// exclusiveKey is still open (that is what makes it crossing rather than
// nesting), and that other bracket has not yet decremented -- so
// openSyncBracketCount is provably >= 1 immediately after our own decrement,
// and the poke's `=== 0` guard can never be true there. Confirmed
// empirically (apra-fleet-3swo.47): a standalone driver against
// createSyncBrackets shows an IDENTICAL setPauseGuard call trace with and
// without the 0b928181 hoist (0 calls at the crossing close, 1 call at the
// later LIFO close, either way) -- so this specific reordering is NOT
// revert-falsifiable, by design; it is kept only as defensive hardening (see
// the comment in git-sync.mjs above the poke). The tests below therefore pin
// the actual, reachable behavior instead: the poke does NOT fire at the
// crossing close, the crossing error still propagates, and it is the
// SUBSEQUENT LIFO close of the last remaining bracket that (re-)registers
// the guard -- so a pause requested while sync brackets were open is never
// permanently stranded, just not engaged at the instant of the crossing
// close itself.
// =============================================================================
describe('apra-fleet-3swo.43/47: crossing-close pause-guard poke timing', () => {
    test('a crossing close does NOT fire the poke (openBracketCount() >= 1 there); the crossing error still propagates; the poke fires only when the LAST bracket closes via the normal LIFO path', async () => {
        let pokeCalls = 0;
        let guard = null;
        const setPauseGuard = (fn) => { pokeCalls += 1; guard = fn; };
        const brackets = createSyncBrackets({ setPauseGuard });
        pokeCalls = 0; // ignore the constructor-time initial registration above

        const gateInner = deferred();
        let innerOpened = false;

        // outer opens first, inner opens second (sharing the same key), and
        // outer resolves/closes FIRST while inner is still open -- a crossing
        // (non-LIFO) close of outer.
        const pOuter = brackets.withOpenSyncBracket(async () => {
            while (!innerOpened) await Promise.resolve();
            return 'outer-result';
        }, { exclusiveKey: 'poke-timing', label: 'outer' });

        const pInner = brackets.withOpenSyncBracket(async () => {
            innerOpened = true;
            await gateInner.promise;
            return 'inner-result';
        }, { exclusiveKey: 'poke-timing', label: 'inner' });

        let errOuter = null;
        try {
            await pOuter;
        } catch (e) {
            errOuter = e;
        }
        check(errOuter instanceof ConcurrentSyncBracketError, `outer's crossing close must still throw ConcurrentSyncBracketError, got ${errOuter && errOuter.constructor.name}`);
        check(brackets.openBracketCount() >= 1, 'invariant: a crossing close implies at least one other bracket (here, inner) is still open');
        check(pokeCalls === 0, `the poke must NOT fire at the crossing close (count is still >= 1 there) -- got ${pokeCalls} call(s)`);

        gateInner.resolve();
        const innerRes = await pInner;
        check(innerRes === 'inner-result', 'the still-open inner bracket completes normally once released');
        check(brackets.openBracketCount() === 0, 'both brackets have closed by the end');
        check(pokeCalls === 1, `the poke must fire exactly once, at the LAST (inner) bracket's normal LIFO close -- got ${pokeCalls} call(s)`);
        check(guard() === true, 'the re-registered guard predicate must read true once every bracket is closed');
    });

    test('the poke does NOT fire on a nested close that leaves other brackets open (same === 0 gate, exercised without any crossing)', async () => {
        let pokeCalls = 0;
        const setPauseGuard = () => { pokeCalls += 1; };
        const brackets = createSyncBrackets({ setPauseGuard });
        pokeCalls = 0; // ignore the constructor-time initial registration above

        await brackets.withOpenSyncBracket(async () => {
            await brackets.withOpenSyncBracket(async () => {
                check(pokeCalls === 0, 'sanity: no close has happened yet');
            }, { exclusiveKey: 'nested-poke', label: 'inner' });
            // Inner has just closed LIFO (openBracketCount() is now 1, outer
            // still open) -- the poke must not have fired for it.
            check(pokeCalls === 0, `the poke must not fire when the inner close leaves the outer bracket open -- got ${pokeCalls} call(s)`);
        }, { exclusiveKey: 'nested-poke', label: 'outer' });
        check(pokeCalls === 1, `the poke must fire exactly once, when the outer (last) bracket closes -- got ${pokeCalls} call(s)`);
        check(brackets.openBracketCount() === 0);
    });
});
