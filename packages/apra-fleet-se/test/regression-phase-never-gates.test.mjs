import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(__dirname, '..', 'fleet-sprint', 'runner.js');
const runnerSource = fs.readFileSync(RUNNER_PATH, 'utf8');
// apra-fleet-3swo.6.6 sliced BOTH phases out of runner.js into
// fleet-sprint/phases/. What stayed behind is exactly what this file's ordering
// pins need: the "6b. Regression Test" banner, the probeFileExists() that
// produces hasRegressionPlaybook, and the two phase CALL SITES. (Harvest was
// the third landmark until apra-fleet-3swo.6.9 sliced it too, so the Harvest
// anchor below is now its CALL SITE rather than its phase() literal.) So the
// ordering below is still read out of runner.js --
// it is a composition-order fact and runner.js is the composition root -- while
// the phase-body assertions are re-anchored onto the module that now owns the
// body. Scanning runner.js alone for the body would have gone quietly vacuous.
const REGRESSION_PHASE_PATH = path.join(__dirname, '..', 'fleet-sprint', 'phases', 'regression-test.mjs');
const regressionPhaseSource = fs.readFileSync(REGRESSION_PHASE_PATH, 'utf8');
const FINAL_REVIEW_PHASE_PATH = path.join(__dirname, '..', 'fleet-sprint', 'phases', 'final-review.mjs');
const finalReviewPhaseSource = fs.readFileSync(FINAL_REVIEW_PHASE_PATH, 'utf8');

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
    // apra-fleet-3swo.37: the ordering pins below must be anchored to the
    // phase's CALL SITE, not to this banner comment. The banner stays behind
    // in runner.js purely as documentation and does not travel with the phase
    // body (which lives in phases/regression-test.mjs), so a hoist of the
    // call site above Final Review that left the banner in place used to keep
    // `finalVerdictIdx < regressionPhaseIdx` GREEN over a real regression.
    // regressionBannerIdx is kept only as a separate, clearly-labelled
    // documentation pin -- the ordering assertions below use
    // regressionPhaseIdx (the call site) instead.
    const regressionBannerIdx = runnerSource.indexOf('6b. Regression Test (once per sprint, informational -- never a gate)');
    const regressionPhaseIdx = runnerSource.indexOf('await runRegressionTestPhase({');
    // apra-fleet-3swo.6.6: `const finalNewTasks = ...` moved into
    // phases/final-review.mjs, so the runner.js-side landmark for "the final
    // verdict exists by here" is now the Final Review CALL SITE -- and it is a
    // STRONGER landmark than the old one, because it is the destructuring that
    // BINDS finalVerdictResult. Nothing below it can read that binding without
    // it having run first; moving the regression phase above this line is a
    // reference error, not merely a reordered comment.
    const finalVerdictIdx = runnerSource.indexOf('const { finalVerdictResult, finalClosedCount, finalOpenAtGoalCount } = await runFinalReviewPhase({');
    // apra-fleet-3swo.6.9: Harvest moved into phases/harvest.mjs, taking its
    // phase(`Harvest C...`) literal with it, so the old runner.js anchor no
    // longer resolves. Re-anchored onto the Harvest CALL SITE -- the same
    // re-anchoring, and the same strengthening, as the Final Review one above:
    // this is the statement that actually RUNS the harvest, so an ordering
    // assertion against it speaks about execution order rather than about
    // where a comment happens to sit.
    const harvestIdx = runnerSource.indexOf('await runHarvestPhase({');

    test('the phase exists and is anchored by its banner comment', () => {
        assert.ok(
            regressionBannerIdx > 0,
            'expected the "6b. Regression Test" phase banner in runner.js -- if this phase was renamed, retarget the anchors in this file rather than deleting the pins',
        );
    });

    test('runs AFTER the final verdict is computed and its newTasks are persisted', () => {
        assert.ok(finalVerdictIdx > 0, 'expected the Final Review phase call site that binds finalVerdictResult -- re-anchor this pin if the destructuring drifted, never delete it');
        assert.ok(
            regressionPhaseIdx > 0,
            "expected the Regression Test phase call site (await runRegressionTestPhase({) -- re-anchor this pin if the call site drifted, never delete it",
        );
        assert.ok(
            finalVerdictIdx < regressionPhaseIdx,
            'the Regression Test phase MUST come after Final Review has computed finalVerdictResult and persisted its FAIL findings -- the ordering IS the guarantee that a regression result cannot perturb the sprint verdict. Moving it earlier silently re-introduces a regression pass that can gate the sprint.',
        );
        // ...and the newTasks persistence really did move WITH the phase rather
        // than being dropped by the slice: it is the FAIL findings half of the
        // claim above, and a scan of runner.js alone can no longer see it.
        assert.match(
            finalReviewPhaseSource,
            /const finalNewTasks = Array\.isArray\(finalVerdictResult\.newTasks\)/,
            'the Final Review newTasks persistence block must live in phases/final-review.mjs after apra-fleet-3swo.6.6',
        );
        assert.doesNotMatch(
            runnerSource,
            /const finalNewTasks = Array\.isArray\(finalVerdictResult\.newTasks\)/,
            'runner.js must not keep a second copy of the Final Review newTasks block -- two sources of truth would let them drift with both pins green',
        );
        // The two phases must genuinely be separate modules: a single module
        // owning both bodies could reorder them internally with every
        // runner.js-side index above still in the right order. The strongest
        // form of that is structural -- the regression phase is handed no
        // verdict at all, so there is nothing for it to perturb. Checked
        // against CODE only: the module's header and the preserved
        // catch-all-degrade commentary both discuss finalVerdictResult by name,
        // and stripping whole-line `//` comments is what keeps this pin about
        // the code rather than about the prose. (The strip is deliberately
        // conservative: only lines that are ENTIRELY a comment are removed, so
        // it can never silently eat a real statement.)
        const regressionCodeOnly = regressionPhaseSource
            .split('\n')
            .filter((line) => !line.trim().startsWith('//'))
            .join('\n');
        assert.ok(
            regressionCodeOnly.includes("dispatchRole(dispatchCtx, 'regression-test-runner'"),
            'sanity: the comment strip must leave the real dispatch behind -- if this fails the pin below is vacuous',
        );
        assert.doesNotMatch(
            regressionCodeOnly,
            /finalVerdictResult/,
            'phases/regression-test.mjs must not so much as NAME finalVerdictResult in its CODE -- it is handed no verdict, which is why it cannot perturb one',
        );
    });

    test('runs BEFORE Harvest, so its summary can fold into the analysis doc', () => {
        assert.ok(harvestIdx > 0, 'expected the Harvest phase call site -- re-anchor this pin if the call drifted, never delete it');
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
        // apra-fleet-3swo.6.6: the phase BODY is phases/regression-test.mjs now.
        // The old `runnerSource.slice(regressionPhaseIdx, harvestIdx)` would
        // still have produced a non-empty string (the banner, the probe, the
        // call site and the skip branch), so the length/content checks below
        // would have kept passing over a block that no longer contained the
        // phase at all -- exactly the quietly-vacuous outcome this re-anchor
        // avoids.
        const phaseBlock = regressionPhaseSource;
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
            // ...and runner.js kept only the probe + call site, not a copy of
            // the body. dispatchRole is how the body reaches the ladder, so its
            // absence between the banner and Harvest is the sharpest available
            // proof that the body really left.
            const runnerRegion = runnerSource.slice(regressionPhaseIdx, harvestIdx);
            assert.ok(runnerRegion.length > 0, 'sanity: the runner.js banner must still precede Harvest');
            assert.doesNotMatch(
                runnerRegion,
                /dispatchRole\(dispatchCtx, 'regression-test-runner'/,
                'the regression dispatch belongs to phases/regression-test.mjs after apra-fleet-3swo.6.6; a copy left inline would dispatch the pass twice',
            );
            assert.match(
                runnerRegion,
                /await runRegressionTestPhase\(\{/,
                'runner.js must still CALL the sliced phase between the banner and Harvest -- a phase that stopped being called would satisfy every "not inline" assertion above',
            );
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
