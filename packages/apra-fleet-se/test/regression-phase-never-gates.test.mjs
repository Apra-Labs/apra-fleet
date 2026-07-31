import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(__dirname, '..', 'fleet-sprint', 'runner.js');
const runnerSource = fs.readFileSync(RUNNER_PATH, 'utf8');

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
        // Slice from the phase banner to the Harvest call: everything the
        // Regression Test phase owns, and nothing else.
        const phaseBlock = runnerSource.slice(regressionPhaseIdx, harvestIdx);

        test('the phase block is non-trivial (the slice actually captured the phase)', () => {
            assert.ok(phaseBlock.length > 2000, `expected a substantial phase block, got ${phaseBlock.length} chars`);
            assert.match(phaseBlock, /getMemberForRole\('regression-test-runner'\)/);
        });

        test('handles git/beads sync failures out of its own withGitSync bracket', () => {
            assert.match(
                phaseBlock,
                /isPostDispatchSyncFailure\(err\)\s*\|\|\s*err instanceof WorkflowError/,
                'the catch MUST handle WorkflowError (GitSyncError / GitDivergedError / DoltSyncError / DoltDivergedError / PostDispatchSyncError all extend it). This phase pushes beads; a push failure here must not abort a sprint whose verdict is already decided.',
            );
        });

        test('has a final else branch, so no error class can fall through unhandled', () => {
            assert.match(
                phaseBlock,
                /\} else \{\s*\n\s*log\(`Regression Test Runner: unexpected error/,
                'the catch MUST end in a catch-all else that logs and continues -- an enumerated-classes-only catch is how this phase silently regained the power to abort the sprint',
            );
        });

        test('rethrows ONLY the two run-level control signals', () => {
            const throws = phaseBlock.match(/throw err;/g) || [];
            assert.strictEqual(
                throws.length,
                2,
                `expected exactly 2 "throw err;" in the Regression Test phase (the max_turns resume ladder's non-matching branch, and the CancelledError/BudgetExceededError guard), found ${throws.length}. Any additional rethrow risks aborting a sprint whose verdict is already decided.`,
            );
            assert.match(
                phaseBlock,
                /if \(err instanceof CancelledError \|\| err instanceof BudgetExceededError\) \{\s*\n\s*throw err;/,
                'the only error-class rethrow in the catch must be the explicit CancelledError/BudgetExceededError guard (operator cancellation and the hard spend ceiling are run-level signals, not "the regression phase failed")',
            );
        });

        test('every soft-fail branch produces a schema-shaped regressionResult', () => {
            // Each branch must assign a full regressionReport-shaped object, or
            // buildAnalysisText's `regressionResult.passed === true` read and
            // the harvest handoff below it get an undefined field.
            const assignments = phaseBlock.match(/regressionResult = \{ passed: false, suitePassed: false, smokePassed: false, bugsFiled: \[\], summary:/g) || [];
            assert.strictEqual(
                assignments.length,
                4,
                `expected 4 soft-fail regressionResult assignments (schema-repair exhausted, dispatch failed, sync failed, unexpected), found ${assignments.length}`,
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
