import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(__dirname, '..', 'fleet-sprint', 'runner.js');
const runnerSource = fs.readFileSync(RUNNER_PATH, 'utf8');

// apra-fleet-3swo.5.7: the phase's soft-fail behaviour is now the
// 'regression-test-runner' policy row executed by the dispatchRole engine, so
// the pins below run the real engine instead of scanning a catch block that no
// longer exists. See the "catch block soft-fails" describe for the per-pin
// mapping.
import { policyFor } from '../fleet-sprint/role-policies.mjs';
import { dispatchRole } from '../fleet-sprint/dispatch-role.mjs';
import { regressionReport } from '../fleet-sprint/contracts.mjs';
import {
    createRecordingCtx,
    ROLE_CALL_OPTS,
    schemaError,
    transportError,
    gitSyncError,
    doltSyncError,
    divergedError,
    postDispatchSyncError,
    cancelledError,
    budgetError,
} from './helpers/dispatch-role-harness.mjs';

// The once-per-sprint Regression Test phase has exactly two safety properties,
// and BOTH are structural rather than behavioural -- they hold because of where
// the phase sits in the file and what its catch block does, not because of
// anything an LLM is asked to do. Neither was pinned when the phase landed, and
// the second one was in fact broken on arrival: the catch enumerated three
// dispatch error classes and rethrew everything else, so a GitSyncError /
// DoltSyncError / PostDispatchSyncError out of the phase's own
// withGitSync(pushBeads: true) bracket -- the single most likely failure for a
// phase whose entire job is filing beads -- escaped as a WorkflowError,
// satisfied isTypedAbortError(), and turned an already-PASSing sprint into a
// terminal `verdict: 'ABORTED'` with no Harvest and no PR.
//
// These are source-shape assertions, in the same spirit as
// dispatch-safety-guard.test.mjs. They cannot prove runtime behaviour, but they DO catch the exact
// regressions above: a phase moved before the verdict, or a rethrow added back
// into the catch.
describe('Regression Test phase can never gate or abort the sprint', () => {
    const regressionPhaseIdx = runnerSource.indexOf('6b. Regression Test (once per sprint, informational -- never a gate)');
    const finalVerdictIdx = runnerSource.indexOf('const finalNewTasks = Array.isArray(finalVerdictResult.newTasks)');
    const harvestIdx = runnerSource.indexOf('phase(`Harvest C${finalCycleLabel}`)');

    test('the phase exists and is anchored by its banner comment', () => {
        assert.ok(
            regressionPhaseIdx > 0,
            'expected the "6b. Regression Test" phase banner in runner.js -- if this phase was renamed, retarget the anchors in this file rather than deleting the pins',
        );
    });

    test('runs AFTER the final verdict is computed and its newTasks are persisted', () => {
        assert.ok(finalVerdictIdx > 0, 'expected the Final Review newTasks persistence block');
        assert.ok(
            finalVerdictIdx < regressionPhaseIdx,
            'the Regression Test phase MUST come after Final Review has computed finalVerdictResult and persisted its FAIL findings -- the ordering IS the guarantee that a regression result cannot perturb the sprint verdict. Moving it earlier silently re-introduces a regression pass that can gate the sprint.',
        );
    });

    test('runs BEFORE Harvest, so its summary can fold into the analysis doc', () => {
        assert.ok(harvestIdx > 0, 'expected the Harvest phase call');
        assert.ok(
            regressionPhaseIdx < harvestIdx,
            'the Regression Test phase MUST come before Harvest -- buildAnalysisText() renders regressionResult into the sprint analysis document the harvester writes',
        );
    });

    test('buildAnalysisText renders the regression result as informational, never as a gate', () => {
        assert.match(
            runnerSource,
            /regressionResult = null,/,
            'buildAnalysisText must accept a regressionResult parameter defaulting to null (the not-run case)',
        );
        assert.match(
            runnerSource,
            /Informational only -- this pass ran after the final verdict and did not gate it/,
            'the analysis doc must state plainly that the regression pass did not gate the sprint',
        );
    });

    describe('the catch block soft-fails', () => {
        // apra-fleet-3swo.5.7: the regression ladder moved onto the dispatchRole
        // engine, so its soft-fail is no longer a `catch` block in runner.js to
        // scan -- it is the 'regression-test-runner' row's catch-all degrade,
        // executed by fleet-sprint/dispatch-role.mjs. Every property this block
        // pinned is re-anchored below onto that row AND onto a real run of the
        // engine, which is strictly stronger than the source-shape version: a
        // catch that swallowed an error and then left regressionResult
        // undefined would have satisfied the old regexes and does not satisfy
        // these.
        //
        //   /isPostDispatchSyncFailure\(err\) \|\| err instanceof WorkflowError/
        //        -> degrade.classifiesSyncFailures, and a real WorkflowError
        //           (including a typed sprint abort) really degrades
        //   /} else { log(`... unexpected error/
        //        -> degrade.classifiesUnrecognisedErrors, and an error of no
        //           recognised class really degrades instead of escaping
        //   exactly 2 `throw err;`
        //        -> degrade.rethrowsRunControlSignals is exactly
        //           [CancelledError, BudgetExceededError], and nothing else
        //           propagates
        //   4 schema-shaped `regressionResult = {...}` assignments
        //        -> the four degrade classes each really produce a value
        //           carrying every regressionReport.required field
        const phaseBlock = runnerSource.slice(regressionPhaseIdx, harvestIdx);
        const p = policyFor('regression-test-runner');
        const opts = ROLE_CALL_OPTS['regression-test-runner'];

        /** Runs the ladder to exhaustion against one error, returning its outcome or the throw. */
        const degradeOf = async (make) => {
            const { ctx } = createRecordingCtx({ responses: [make(), make()] });
            try {
                return { outcome: await dispatchRole(ctx, 'regression-test-runner', opts), thrown: null };
            } catch (err) {
                return { outcome: null, thrown: err };
            }
        };

        test('the phase block is non-trivial (the slice actually captured the phase)', () => {
            assert.ok(phaseBlock.length > 2000, `expected a substantial phase block, got ${phaseBlock.length} chars`);
            assert.match(phaseBlock, /getMemberForRole\('regression-test-runner'\)/);
        });

        test('handles git/beads sync failures out of its own withGitSync bracket', async () => {
            assert.strictEqual(
                p.degrade.classifiesSyncFailures,
                true,
                'the degrade MUST classify sync failures (GitSyncError / GitDivergedError / DoltSyncError / DoltDivergedError / PostDispatchSyncError all extend WorkflowError). This phase pushes beads; a push failure here must not abort a sprint whose verdict is already decided.',
            );
            for (const make of [gitSyncError, doltSyncError, divergedError, postDispatchSyncError]) {
                const { outcome, thrown } = await degradeOf(make);
                assert.strictEqual(thrown, null, `a ${make().name} must never escape the regression phase`);
                assert.strictEqual(outcome.degraded, true);
                assert.strictEqual(outcome.value.passed, false);
            }
        });

        test('has a final else branch, so no error class can fall through unhandled', async () => {
            assert.strictEqual(
                p.degrade.classifiesUnrecognisedErrors,
                true,
                'the degrade MUST classify unrecognised errors -- an enumerated-classes-only catch is how this phase silently regained the power to abort the sprint',
            );
            assert.strictEqual(p.degrade.rethrowsUnrecognisedErrors, false);
            const { outcome, thrown } = await degradeOf(() => new TypeError('an error of no recognised class'));
            assert.strictEqual(thrown, null, 'an unrecognised error class must be logged and continued, never rethrown');
            assert.strictEqual(outcome.value.passed, false);
        });

        test('rethrows ONLY the two run-level control signals', async () => {
            assert.deepStrictEqual(
                p.degrade.rethrowsRunControlSignals,
                ['CancelledError', 'BudgetExceededError'],
                'operator cancellation and the hard spend ceiling are run-level signals, not "the regression phase failed"; any OTHER rethrow risks aborting a sprint whose verdict is already decided',
            );
            for (const make of [cancelledError, budgetError]) {
                const { thrown } = await degradeOf(make);
                assert.ok(thrown, `${make().constructor.name} must still propagate`);
                assert.strictEqual(thrown.constructor, make().constructor);
            }
        });

        test('every soft-fail branch produces a schema-shaped regressionResult', async () => {
            // Each degrade class must produce a full regressionReport-shaped
            // object, or buildAnalysisText's `regressionResult.passed === true`
            // read and the harvest handoff below it get an undefined field.
            const makes = [
                schemaError,
                transportError,
                gitSyncError,
                () => new TypeError('an error of no recognised class'),
            ];
            assert.strictEqual(makes.length, p.degrade.paths, 'one soft-fail path per degrade class');
            const seen = new Set();
            for (const make of makes) {
                const { outcome } = await degradeOf(make);
                for (const field of regressionReport.required) {
                    assert.ok(
                        Object.prototype.hasOwnProperty.call(outcome.value, field),
                        `a soft-failed regressionResult must still carry '${field}' -- buildAnalysisText reads it`,
                    );
                }
                assert.strictEqual(outcome.value.passed, false);
                assert.strictEqual(outcome.value.suitePassed, false);
                assert.strictEqual(outcome.value.smokePassed, false);
                assert.deepStrictEqual(outcome.value.bugsFiled, []);
                seen.add(outcome.value.summary);
            }
            assert.strictEqual(
                seen.size,
                makes.length,
                'each soft-fail path must say WHICH failure it was -- four paths collapsing to one summary loses that',
            );
        });
    });

});

// Relocated from the deleted part2-sha-freshness.test.mjs. That file existed to
// pin the eft.55.2/eft.66.1 part-2 SHA-freshness handoff, and mostly unit-tested
// `extractPart2Sha` / `validatePart2Evidence`. The integ/regression split retired
// the handoff and both helpers have now been removed (they had no engine consumer
// once getDeployedSha() went), so those unit tests went with them -- but THIS
// assertion is independent of the helpers and still earns its keep: it catches a
// re-introduction of the dead SHA threading into the per-cycle Integ Test
// dispatch, which is what would quietly resurrect the retired coupling.
describe('the part-2 deployedSha handoff stays retired', () => {
    test('runner.js does not thread a part-2 SHA clause into the Integ Test dispatch', () => {
        assert.doesNotMatch(runnerSource, /const part2ShaClause/);
        assert.doesNotMatch(runnerSource, /your report's "deployedSha" output field/);
    });

    test('the removed helpers are really gone (no dangling exports)', () => {
        assert.doesNotMatch(
            runnerSource,
            /export function (extractPart2Sha|validatePart2Evidence)\b/,
            'extractPart2Sha/validatePart2Evidence were removed as consumer-less dead code; re-exporting either without an engine call site re-creates the tested-but-dead state this cleanup resolved',
        );
    });

    test('the vendored integ-test-runner schema still declares deployedSha (optional, backward compatible)', () => {
        const schemaPath = path.join(
            __dirname, '..', 'apra-pm', 'agents', 'schemas', 'integ-test-runner-output.json',
        );
        const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
        assert.ok(
            schema.properties && schema.properties.deployedSha,
            'the field stays in the vendored schema for pre-split agent builds that still emit it; it is simply no longer read',
        );
        assert.ok(
            !(schema.required || []).includes('deployedSha'),
            'deployedSha must stay OPTIONAL -- nothing produces it any more',
        );
    });
});
