// =============================================================================
// PHASE MODULE: Harvest (apra-fleet-3swo.6.9).
//
// The ELEVENTH of runSprintCycle's twelve phase() boundaries -- the sprint's
// knowledge-capture step: it builds the sprint-analysis document's text, the
// cost-analysis block and the harvester prompt from real, runner-computed
// values, dispatches the harvester ladder, and reports what came back. Moved
// verbatim out of runner.js: every prompt string, log line and dispatch option
// is byte-identical to the inline version, so the golden transcript is
// unchanged. Move-only, no behaviour change.
//
// WHERE THIS PHASE STARTS AND STOPS. It starts at its own phase() call and
// ends at the last of the three harvest-report log branches. The Regression
// Test call site immediately above it and the `// 7. Publish` section banner
// immediately below it both stay in runner.js, as do group('Finalization')/
// endGroup(), which wrap all four Finalization phases rather than this one.
//
// WHY IT SITS WHERE IT SITS. AFTER Regression Test, because that phase's
// summary is folded into docs/sprint-analysis-<slug>.md through
// buildAnalysisText() -- harvesting first would publish an analysis document
// with a hole where the regression section belongs. BEFORE Publish PR, because
// the harvester is a code-writing role: the docs/sprint-analysis
// commits it makes must be pushed before Publish PR pushes the branch and
// raises the PR a human will read. That ordering is structural here, not a
// comment: ./publish-pr.mjs's call site sits below this one in runner.js and
// this phase's dispatch keeps its own pushCode/pushBeads bracket.
//
// THE HARVESTER'S GIT/BEADS BRACKET IS POLICY, NOT CODE HERE
// (apra-fleet-3swo.5.7). The harvester ladder -- its dispatch, its
// pushCode/pushBeads git-sync bracket, its max_turns-exhaustion resume at
// doubled turns, its one bounded LLM-auth self-heal and its
// proceed-without-a-report degrade -- is the 'harvester' row of
// ../role-policies.mjs, executed by ../dispatch-role.mjs. Do not reintroduce a
// local bracket or retry here: `pushCode: true` (G-pull before, G-push after)
// and `pushBeads: true` (the issue-defer mutations D-pushed alongside) are set
// in that row, and this phase would silently double-push if it added its own.
// What lives in this file is what is genuinely NOT policy: the prompt inputs,
// the presentation labels, and what the caller does with the report.
//
// WHY ITS HELPERS ARE INJECTED RATHER THAN IMPORTED. computeBranchSlug,
// buildAnalysisText and buildCostAnalysis are defined in ../runner.js (the
// middle one is module-private there), so importing them would be a circular
// import back into the file this module was sliced out of -- they are injected
// exactly as ./final-review.mjs injects sanitizePrText. dispatchCtx, budget and
// the evidence arrays are runSprintCycle-scoped locals, so there is nothing to
// import; dispatchRole/TURN_BASES and buildHarvesterPrompt live in real sibling
// modules and are imported directly.
//
// THE COST BLOCK IS ENGINE-RENDERED AND NEVER COMMITTED. It is logged here and
// returned for ./publish-pr.mjs to render in the PR body; it is NOT part of
// the analysisText handed to the harvester, so no file the harvester commits
// carries spend data, in any harvest mode. The harvester no longer writes a
// CHANGELOG entry either: a shared, prepend-only file conflicted on every
// concurrent sprint PR merge.
//
// HARVEST MODE (the harvest_mode launch option, ../sprint-args.mjs) decides
// what the harvester may write into the target repo -- see
// planHarvestOutputs() below. 'full' (the default) and 'docs-dir' hand the
// harvester an artifact path; 'pr-body-only' and 'off' hand it `none` and a
// no-write instruction, and 'pr-body-only' returns the analysis for
// ./publish-pr.mjs to put in the PR body instead. The harvester is still
// dispatched in every mode, because its knowledge-bank capture and
// low-priority backlog confirmation do not write to the repository. The
// no-write modes are enforced through the harvester's prompt and agent
// contract: the policy row's pushCode bracket is unchanged, and with nothing
// committed it has nothing to push.
//
// GUARD COVERAGE: registered as 'phases/harvest.mjs' in ../guarded-modules.mjs.
// It took NO member_name-bearing command() call site out of runner.js -- the
// docs commits are made by the DISPATCHED harvester inside its own
// repo, and its pushes are the policy row's bracket -- but it took ONE
// dispatchRole() site (the harvester ladder), which is exactly what
// dispatch-safety-guard and the phase 3 dispatch census read. Both baselines
// are pinned rather than assumed.
// =============================================================================

import { dispatchRole, TURN_BASES } from '../dispatch-role.mjs';
import { buildHarvesterPrompt } from '../prompts.mjs';

/**
 * Runs the Harvest phase: assemble the sprint-analysis inputs, dispatch the
 * harvester ladder, and log what it reported.
 *
 * Everything else this phase produces is written to the repo by the dispatched
 * harvester itself (docs, the deferred beads) or already logged here. The
 * values a later phase reads are the cost block and, in harvest mode
 * 'pr-body-only', the sprint analysis; ./publish-pr.mjs renders both in the
 * PR body.
 *
 * @param {object} state Explicit phase state; see this file's header.
 * @returns {Promise<{ costAnalysis: string, harvestAnalysis: string }>}
 */
export async function runHarvestPhase({
    // Presentation + dispatch seams.
    phase,
    log,
    dispatchCtx,
    // Sprint identity/config.
    validated,
    targetIssues,
    finalCycleLabel,
    budget,
    // Evidence the analysis document renders; read-only here.
    closedCountHistory,
    highWaterClosedCount,
    deployFailures,
    integFailures,
    rejectedNewTasks,
    integTestRunnerSpend,
    integTestRunnerDispatchCount,
    // The closing results this phase folds into the analysis document.
    finalVerdictResult,
    finalClosedCount,
    finalOpenAtGoalCount,
    finalDeferredAtGoalIds,
    regressionResult,
    regressionSkippedBy = null,
    // Defined BY runner.js; injected to avoid a circular import (see header).
    computeBranchSlug,
    buildAnalysisText,
    buildCostAnalysis,
}) {
    phase(`Harvest C${finalCycleLabel}`);
    // Wire the harvester's required inputs with real, runner-computed values --
    // see buildAnalysisText()/buildCostAnalysis() in ../runner.js, which
    // injects both (this file's header explains why). `branchSlug` (see
    // computeBranchSlug(), also in ../runner.js) avoids embedding raw `/`
    // characters from a branch name like `feat/fleet-reorg` in the artifact
    // path, which would otherwise create surprise subdirectories. Deliberately
    // no wall-clock timestamp in this path: it must stay identical across two
    // dispatches of the same branch (idempotent re-runs, and the golden-transcript
    // determinism test), and harvester.md Step 1 already overwrites the file at
    // this path if it exists.
    const branchSlug = computeBranchSlug(validated.branch);
    const harvestMode = validated.harvestMode ?? 'full';
    const reportText = buildAnalysisText({
        targetIssues,
        branch: validated.branch,
        baseBranch: validated.baseBranch,
        cyclesRun: finalCycleLabel,
        closedCountHistory,
        highWaterClosedCount,
        deployFailures,
        integFailures,
        rejectedNewTasks,
        finalVerdictResult,
        finalClosedCount,
        finalOpenAtGoalCount,
        finalDeferredAtGoalIds,
        regressionResult,
        regressionSkippedBy,
    });
    const costAnalysis = buildCostAnalysis(budget, {
        spend: integTestRunnerSpend,
        dispatchCount: integTestRunnerDispatchCount,
    });
    const { analysisArtifactFile, harvesterAnalysisText, prAnalysis } = planHarvestOutputs({
        harvestMode,
        harvestDocsDir: validated.harvestDocsDir ?? null,
        branchSlug,
        reportText,
    });
    // The cost block never reaches the harvester (and so never a committed
    // file, in any mode): it is logged here and rendered in the PR body by
    // ./publish-pr.mjs.
    log(`Harvest: sprint cost analysis (PR body and run log only, never committed):\n${costAnalysis}`);
    if (harvestMode !== 'full') {
        log(`Harvest mode ${harvestMode}: ${HARVEST_MODE_SUMMARY[harvestMode]}`);
    }
    if (analysisArtifactFile === null) {
        // No committed copy of the analysis exists in these modes, so the run
        // log carries the full text.
        log(`Harvest: sprint analysis (not committed in harvest mode ${harvestMode}):\n${reportText}`);
    }
    const harvesterPrompt = buildHarvesterPrompt({
        branch: validated.branch,
        baseBranch: validated.baseBranch,
        targetIssues,
        analysisArtifactFile,
        analysisText: harvesterAnalysisText,
        harvestMode,
        harvestDocsDir: validated.harvestDocsDir ?? null,
    });
    // apra-fleet-3swo.5.7: the harvester ladder -- its dispatch, its
    // pushCode/pushBeads git-sync bracket, its max_turns-exhaustion resume at
    // doubled turns, its one bounded LLM-auth self-heal and its
    // proceed-without-a-report degrade -- is now the 'harvester' row of
    // fleet-sprint/role-policies.mjs, executed by dispatchRole. What stays
    // here is what is genuinely NOT policy: the prompts, the presentation
    // labels, and what the caller does with the report.
    //
    // The harvester is a code-writing role (pushCode: true) alongside the doer
    // -- G-pull before, G-push after so the docs/sprint-analysis
    // commits it makes are published before anything downstream (Publish PR,
    // below) reads the branch. It ALSO mutates beads (issue-defer of
    // low-priority items), so it D-pushes those mutations alongside its git
    // push. Both flags live in the policy row now.
    const harvestOutcome = await dispatchRole(dispatchCtx, 'harvester', {
        prompt: harvesterPrompt,
        resumePrompt: 'Continue your harvest exactly where you left off in this same session -- do not redo docs sections already written. Finish the remaining updates, commit them, and return your final report now.',
        roleLabel: 'Harvester',
        resumeLabel: `Harvest (resume, max_turns=${TURN_BASES.HARVESTER_MAX_TURNS * 2})`,
    });
    const harvesterResult = harvestOutcome.value;
    // No duplicate log() dump -- see dispatchReview() for why. The file
    // path itself IS worth a line: it is the durable, committed record of
    // the Final Review verdict (and everything else in analysisText) --
    // unlike the verdict object, it survives after this process exits.
    //
    // A degraded harvest proceeds WITHOUT a validated report (the sprint
    // verdict is already decided by this point), so everything below is
    // gated on actually having one. The report's kb_captures were applied by
    // the policy's 'kb-apply' postResult step, which only runs on success.
    if (!harvestOutcome.ok) {
        log(`Harvester: proceeding without a validated harvester report: ${harvestOutcome.error?.message ?? 'no report'}`);
    } else if (harvesterResult.status !== 'OK') {
        log(`Harvester reported FAILED: ${harvesterResult.notes}`);
    } else if (analysisArtifactFile !== null) {
        log(`Harvester: wrote sprint analysis (including the Final Review verdict) to ${analysisArtifactFile}.`);
    } else {
        log(`Harvester: completed in harvest mode ${harvestMode} (no repository writes requested).`);
    }
    return { costAnalysis, harvestAnalysis: prAnalysis };
}

/** One-line, log/PR-facing description of each non-default harvest mode. */
export const HARVEST_MODE_SUMMARY = Object.freeze({
    'docs-dir': 'the harvester writes the sprint analysis and durable docs only under the configured docs directory, with no README edits.',
    'pr-body-only': 'no harvester commits; the sprint analysis is published in the PR body.',
    off: 'the harvester writes nothing to the repository; knowledge-bank capture and backlog confirmation still run.',
});

/**
 * Pure plan of what the harvester may write for a harvest mode (see the
 * harvest_mode launch option in ../sprint-args.mjs):
 *   - analysisArtifactFile: where the harvester writes the sprint analysis --
 *     docs/ for 'full', harvestDocsDir for 'docs-dir', null (no file) for
 *     'pr-body-only' and 'off';
 *   - harvesterAnalysisText: the analysis handed to the harvester -- the
 *     report text only, never the cost block, so no committed file carries
 *     spend data in any mode;
 *   - prAnalysis: the analysis ./publish-pr.mjs renders in the PR body --
 *     the report text for 'pr-body-only', '' otherwise.
 * An unknown mode throws: harvest output is never decided by a silent default.
 *
 * @param {{ harvestMode: string, harvestDocsDir: string|null, branchSlug: string, reportText: string }} opts
 * @returns {{ analysisArtifactFile: string|null, harvesterAnalysisText: string, prAnalysis: string }}
 */
export function planHarvestOutputs({ harvestMode, harvestDocsDir, branchSlug, reportText }) {
    const fileName = `sprint-analysis-${branchSlug}.md`;
    switch (harvestMode) {
        case 'full':
            return { analysisArtifactFile: `docs/${fileName}`, harvesterAnalysisText: reportText, prAnalysis: '' };
        case 'docs-dir':
            if (!harvestDocsDir) throw new Error('planHarvestOutputs: harvest mode "docs-dir" requires harvestDocsDir');
            return { analysisArtifactFile: `${harvestDocsDir}/${fileName}`, harvesterAnalysisText: reportText, prAnalysis: '' };
        case 'pr-body-only':
            return { analysisArtifactFile: null, harvesterAnalysisText: reportText, prAnalysis: reportText };
        case 'off':
            return { analysisArtifactFile: null, harvesterAnalysisText: reportText, prAnalysis: '' };
        default:
            throw new Error(`planHarvestOutputs: unknown harvest mode "${harvestMode}"`);
    }
}
