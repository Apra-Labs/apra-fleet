// =============================================================================
// Shared, table-driven suite factory for the handleNestedSuiteSpawnResult unit
// cases, extracted out of phase1-leaf-facade-completeness.test.mjs section (6)
// and phase3-dispatch-engine-completeness.test.mjs section (6b).
//
// Those two files carried the SAME six cases near-verbatim -- byte-identical
// test names, byte-identical assertions -- differing only in the
// (envVarName, budgetSource[, extraTimeoutGuidance]) tuple each gate feeds the
// shared handler in test/helpers/nested-suite-spawn.mjs. phase3's own section
// header admitted it "mirrors phase1 ... section (6)". Two copies of one
// contract is two places to forget: a wording change made on one side could
// silently desynchronize the other while leaving both suites green, which is
// the exact desynchronization the handler extraction itself was meant to end.
//
// This module defines the six cases ONCE and instantiates them twice -- once
// per tuple. Both tuples remain covered: this is a de-duplication, not a
// deletion of one side. Gate-specific cases that are NOT shared (e.g. phase1's
// case (d), which exercises phase1's own resolveNestedSuiteTimeoutMs, and
// phase3's resolveNestedSuiteTimeoutBudget sections) deliberately stay in
// their own files -- only the six genuinely-identical cases live here.
//
// Union-of-both semantics: where one copy asserted something the other did
// not (phase3 pinned that the budget SOURCE reaches both branches' messages;
// phase1 did not), the shared table asserts the union. Every such assertion
// was checked to hold for BOTH tuples, so nothing was weakened to make the
// merge fit.
// =============================================================================

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleNestedSuiteSpawnResult as canonicalHandler } from './nested-suite-spawn.mjs';

/**
 * Registers the six shared handleNestedSuiteSpawnResult cases under one
 * describe() block, bound to a single gate's (envVarName, budgetSource,
 * extraTimeoutGuidance) tuple.
 *
 * The caller passes its OWN imported `handler` binding -- the same reference
 * its runNestedSuite() invokes -- so every case here exercises that file's
 * real call path, and the identity case can prove that binding is the single
 * shared definition rather than a test-only copy.
 *
 * @param {object} opts
 * @param {string} opts.sectionLabel - section prefix for the describe title, e.g. '(6)' or '(6b)'
 * @param {Function} opts.handler - the caller's own imported handleNestedSuiteSpawnResult binding
 * @param {string} opts.envVarName - the gate's timeout override env var, e.g. 'PHASE1_NESTED_SUITE_TIMEOUT_MS'
 * @param {string} opts.budgetSource - the gate's human-readable budget-source string
 * @param {string} [opts.extraTimeoutGuidance] - the gate's extra ETIMEDOUT remediation sentence, if it has one
 */
export function describeHandleNestedSuiteSpawnResultCases({
    sectionLabel,
    handler,
    envVarName,
    budgetSource,
    extraTimeoutGuidance = '',
} = {}) {
    // Fail loudly at registration time rather than registering a set of
    // vacuous cases: a typo in one caller's tuple must not silently turn that
    // instantiation into six assertions about `undefined`.
    assert.equal(typeof sectionLabel, 'string', 'sectionLabel is required');
    assert.equal(typeof handler, 'function', 'handler (the caller\'s own imported binding) is required');
    assert.ok(envVarName, 'envVarName is required');
    assert.ok(budgetSource, 'budgetSource is required');

    describe(`${sectionLabel} the extracted handleNestedSuiteSpawnResult helper converts spawn results to pass/fail`, () => {
        test('case (a): ETIMEDOUT error yields message with suite label and budget', () => {
            const timeoutError = new Error('timeout signal');
            timeoutError.code = 'ETIMEDOUT';
            timeoutError.signal = 'SIGTERM';
            timeoutError.status = null;

            assert.throws(
                () => handler('my-golden-suite', timeoutError, 900_000, budgetSource, envVarName, extraTimeoutGuidance),
                (err) => {
                    const msg = err.message;
                    assert.ok(msg.includes('my-golden-suite'), `message must include suite label; got: ${msg}`);
                    assert.ok(msg.includes('900000'), `message must include budget in ms; got: ${msg}`);
                    assert.ok(msg.includes(budgetSource), `message must include the budget source; got: ${msg}`);
                    assert.ok(
                        msg.includes(envVarName),
                        `message must name the override env var a reader should raise; got: ${msg}`,
                    );
                    if (extraTimeoutGuidance) {
                        assert.ok(
                            msg.includes(extraTimeoutGuidance),
                            `message must carry this gate's extra remediation guidance; got: ${msg}`,
                        );
                    }
                    return true;
                },
            );
        });

        test('case (b): non-zero status wraps with suite label, "budget did not expire", exit status and a bounded excerpt, preserving the original as cause', () => {
            const nonZeroError = new Error('Command failed: node --test failed with exit code 1');
            nonZeroError.status = 1;
            nonZeroError.stdout = 'TAP output line 1\n';
            nonZeroError.stderr = 'stderr line 1\n';

            let caughtErr;
            try {
                handler('my-suite', nonZeroError, 900_000, budgetSource, envVarName, extraTimeoutGuidance);
                assert.fail('should have thrown an error');
            } catch (e) {
                caughtErr = e;
            }

            assert.ok(caughtErr.message.includes('my-suite'), `message must name the outer suite label; got: ${caughtErr.message}`);
            assert.ok(
                caughtErr.message.includes('did NOT expire'),
                `message must explicitly state the outer budget did not expire, to distinguish this from case (a); got: ${caughtErr.message}`,
            );
            assert.ok(caughtErr.message.includes('900000'), `message must include the outer budget in ms; got: ${caughtErr.message}`);
            assert.ok(
                caughtErr.message.includes(budgetSource),
                `message must include the outer budget's source string (the same source the ETIMEDOUT branch carries), so a reader can tell which budget the child ran under; got: ${caughtErr.message}`,
            );
            assert.ok(caughtErr.message.includes('exit status: 1'), `message must include the child exit status; got: ${caughtErr.message}`);
            assert.ok(caughtErr.message.includes('TAP output line 1'), `message must include a tail excerpt of child stdout; got: ${caughtErr.message}`);
            assert.ok(caughtErr.message.includes('stderr line 1'), `message must include a tail excerpt of child stderr; got: ${caughtErr.message}`);

            // apra-fleet-3swo.50: the two failure modes must never share text
            // in the WRAPPER PREFIX -- the portion of the message the wrapper
            // itself authors, before the quoted child stdout/stderr excerpt.
            // The excerpt is arbitrary child output and CAN legitimately
            // contain the substring "timed out" (e.g. an inner per-test
            // timeout, as apra-fleet-80q3's real case did), so asserting the
            // absence of "timed out" over the WHOLE message (including the
            // excerpt) is a false requirement on child output content, not a
            // real guarantee about the wrapper. Pin the distinguishing
            // contract on the prefix, where the wrapper actually enforces it.
            const wrapperPrefix = caughtErr.message.split('child stdout (tail):')[0];
            assert.ok(
                wrapperPrefix.includes('did NOT expire'),
                `wrapper prefix must explicitly state the outer budget did not expire; got: ${wrapperPrefix}`,
            );
            assert.ok(
                !wrapperPrefix.includes('timed out'),
                `wrapper prefix (excluding the quoted child excerpt) must never claim a timeout; got: ${wrapperPrefix}`,
            );

            // Cross-check against the ETIMEDOUT branch: its wrapper prefix
            // never claims the outer budget did NOT expire -- the two wrapper
            // prefixes are mutually exclusive on this marker.
            const crossCheckTimeoutError = new Error('timeout signal');
            crossCheckTimeoutError.code = 'ETIMEDOUT';
            crossCheckTimeoutError.signal = 'SIGTERM';
            let crossCheckTimeoutErr;
            try {
                handler('my-suite', crossCheckTimeoutError, 900_000, budgetSource, envVarName, extraTimeoutGuidance);
                assert.fail('should have thrown an error');
            } catch (e) {
                crossCheckTimeoutErr = e;
            }
            assert.ok(
                !crossCheckTimeoutErr.message.includes('did NOT expire'),
                `ETIMEDOUT wrapper prefix must never claim the outer budget did NOT expire; got: ${crossCheckTimeoutErr.message}`,
            );

            // The original spawn error must still be reachable, unmodified,
            // as `cause` -- no information is lost, only bounded in the
            // message text.
            assert.equal(caughtErr.cause, nonZeroError, 'original spawn error must be reachable as .cause');
            assert.equal(caughtErr.cause.status, 1, 'cause must preserve the original exit status');
            assert.equal(caughtErr.cause.stdout, 'TAP output line 1\n', 'cause must preserve the original stdout verbatim');
            assert.equal(caughtErr.cause.stderr, 'stderr line 1\n', 'cause must preserve the original stderr verbatim');
        });

        test('case (b2): a multi-megabyte child stdout/stderr is length-capped in the wrapped message, not quoted verbatim', () => {
            const hugeError = new Error('Command failed: node --test failed with exit code 1');
            hugeError.status = 1;
            hugeError.stdout = 'x'.repeat(2_000_000);
            hugeError.stderr = 'y'.repeat(2_000_000);

            let caughtErr;
            try {
                handler('huge-suite', hugeError, 900_000, budgetSource, envVarName, extraTimeoutGuidance);
                assert.fail('should have thrown an error');
            } catch (e) {
                caughtErr = e;
            }

            assert.ok(
                caughtErr.message.length < 20_000,
                `wrapped message must be length-capped regardless of a multi-megabyte child output; got length ${caughtErr.message.length}`,
            );
            assert.ok(caughtErr.message.includes('truncated'), `message should note the excerpt was truncated; got a message of length ${caughtErr.message.length}`);
            // The uncapped original is still available via cause, so nothing is lost.
            assert.equal(caughtErr.cause.stdout.length, 2_000_000, 'cause must retain the full, untruncated original stdout');
            assert.equal(caughtErr.cause.stderr.length, 2_000_000, 'cause must retain the full, untruncated original stderr');
        });

        // apra-fleet-3swo.54: the adversarial case apra-fleet-80q3.2's
        // description originally asked for -- a non-ETIMEDOUT-CODED error
        // whose own MESSAGE happens to be the literal raw spawnSync-ETIMEDOUT
        // text. Node's real shapes (verified by standalone repro against
        // execFileSync/stdio pipe) never actually produce this combination: a
        // timeout always sets code='ETIMEDOUT'/status=null/message='spawnSync
        // <file> ETIMEDOUT', while a non-zero exit always sets
        // code=undefined/status=N/message='Command failed: ...', so the two
        // never mix in practice. But nothing else in the shared handler
        // (test/helpers/nested-suite-spawn.mjs) PINS that the branch is chosen
        // by error.code rather than by sniffing error.message for 'ETIMEDOUT'
        // -- a mutation widening the ETIMEDOUT branch's condition to also
        // match /ETIMEDOUT/ on the message would pass every other case here
        // and silently re-create the exact apra-fleet-80q3 misdiagnosis (an
        // inner child failure reported as the gate's own budget expiring).
        // This case makes that mutation observable by constructing the
        // adversarial combination directly.
        test('case (b3): classification is by error.code, not error.message -- a numeric-status error whose message is raw ETIMEDOUT text still reports as an inner child failure', () => {
            const adversarialError = new Error('spawnSync node ETIMEDOUT');
            adversarialError.status = 1;
            adversarialError.stdout = 'inner child stdout\n';
            adversarialError.stderr = 'inner child stderr\n';
            // code is deliberately left undefined -- the real distinguishing
            // signal -- while the message text alone would read as a timeout.

            let caughtErr;
            try {
                handler('adversarial-suite', adversarialError, 900_000, budgetSource, envVarName, extraTimeoutGuidance);
                assert.fail('should have thrown an error');
            } catch (e) {
                caughtErr = e;
            }

            assert.ok(caughtErr.message.includes('adversarial-suite'), `message must name the outer suite label; got: ${caughtErr.message}`);
            assert.ok(caughtErr.message.includes('exit status: 1'), `message must carry the child exit status; got: ${caughtErr.message}`);
            const wrapperPrefix = caughtErr.message.split('child stdout (tail):')[0];
            assert.ok(
                wrapperPrefix.includes('did NOT expire'),
                `wrapper prefix must classify this as an inner child failure despite the adversarial message text; got: ${wrapperPrefix}`,
            );
            assert.ok(
                !wrapperPrefix.includes('timed out') && !wrapperPrefix.includes('exceeded its'),
                `wrapper prefix must never claim a timeout for a non-ETIMEDOUT-coded error, even when its message text says ETIMEDOUT; got: ${wrapperPrefix}`,
            );
            assert.equal(caughtErr.cause, adversarialError, 'original spawn error must be reachable as .cause');
        });

        test('case (c): null error (status 0) yields pass (no throw)', () => {
            // Should not throw or return anything; just complete normally.
            const result = handler('my-suite', null, 900_000, budgetSource, envVarName, extraTimeoutGuidance);
            assert.equal(result, undefined, 'success case should return undefined');
        });

        test('the handler is the same function runNestedSuite uses (single definition, import-proven)', () => {
            // Proof of single-definition identity: the calling gate's
            // runNestedSuite invokes its own module-scope
            // handleNestedSuiteSpawnResult binding directly, and that very
            // binding is what it handed this factory as `handler`. Asserting
            // it is strictly the same reference as this module's own import
            // from helpers/nested-suite-spawn.mjs proves BOTH gates run the
            // one shared definition -- if either had a copied/duplicated
            // test-only handler, a mutation of the shared module would not
            // propagate to its real calls and this equality would fail.
            assert.equal(typeof handler, 'function', 'handleNestedSuiteSpawnResult must be imported at module scope for runNestedSuite to use');
            assert.equal(
                handler,
                canonicalHandler,
                'the gate\'s own binding must be the single shared handleNestedSuiteSpawnResult from helpers/nested-suite-spawn.mjs, not a copy',
            );

            // And it is live: a real ETIMEDOUT-coded error thrown through the
            // gate's own binding still throws.
            const testErrorOk = new Error('test');
            testErrorOk.code = 'ETIMEDOUT';
            testErrorOk.signal = 'SIGTERM';

            let directCallThrew = false;
            try {
                handler('test', testErrorOk, 900_000, budgetSource, envVarName, extraTimeoutGuidance);
            } catch (e) {
                directCallThrew = true;
            }
            assert.ok(directCallThrew, 'direct call must throw on ETIMEDOUT');
        });
    });
}
