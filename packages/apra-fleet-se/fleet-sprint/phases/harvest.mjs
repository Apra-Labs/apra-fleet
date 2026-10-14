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
// low-priority backlog confirmation do not write to the repository.
//
// THE NO-WRITE MODES ARE ENFORCED BY THE ENGINE, not only by the prompt.
// 'pr-body-only' and 'off' dispatch through ../role-policies.mjs's
// HARVESTER_NO_WRITE_POLICIES (via dispatchRole's ctx.policies seam), whose
// harvester row never G-pushes code -- beads still D-push. Inside the bracket,
// after the G-pull, this phase records the member's HEAD and working tree;
// after the dispatch returns it records them again. A moved HEAD or a newly
// dirty tree is a violation: it is logged loudly and undone before Publish PR
// pushes the branch -- HEAD with `git reset --keep` (falling back to
// `--soft`, never `--hard`, so edits already on the member survive), paths
// the harvester first touched are restored or removed, and a path that was
// already dirty is left and reported -- and the result is returned as
// harvestWriteCheck so the PR body states the violation, and whether the
// member was fully restored, rather than claiming nothing was written. If
// HEAD cannot be moved back at all the phase throws. When the
// member's HEAD or status cannot be read, the check is 'unverified' and the PR
// body says so -- it never claims an unverified "wrote nothing".
//
// GUARD COVERAGE: registered as 'phases/harvest.mjs' in ../guarded-modules.mjs.
// It took NO member_name-bearing command() call site out of runner.js -- the
// docs commits are made by the DISPATCHED harvester inside its own
// repo, and its pushes are the policy row's bracket -- but it took ONE
// dispatchRole() site (the harvester ladder), which is exactly what
// dispatch-safety-guard and the phase 3 dispatch census read. It has ONE
// command() site of its own, runHarvesterGit() in noWriteGuard() below: the
// no-write check's reads and reset, always on the harvester's member. Both
// baselines are pinned rather than assumed.
// =============================================================================

import { dispatchRole, TURN_BASES } from '../dispatch-role.mjs';
import { buildHarvesterPrompt } from '../prompts.mjs';
import { HARVESTER_NO_WRITE_POLICIES } from '../role-policies.mjs';

/** Harvest modes in which the harvester must not change the target repo. */
export const NO_WRITE_HARVEST_MODES = Object.freeze(['pr-body-only', 'off']);

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
 * @returns {Promise<{ costAnalysis: string, harvestAnalysis: string,
 *   harvestWriteCheck: { status: 'not-applicable'|'clean'|'violation'|'unverified', restored?: boolean, detail: string } }>}
 */
export async function runHarvestPhase({
    // Presentation + dispatch seams.
    phase,
    log,
    dispatchCtx,
    // Member-bound command seam: the no-write modes' HEAD/tree check and reset.
    command,
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
    // Sprint state's per-dispatch kb_* and code_* call records (dispatch-accounting.mjs).
    dispatchToolCalls = null,
    // The KB work client: the harvest round's bible commit runs through it.
    kbWork = null,
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
        dispatchToolCalls,
        // Confirmations the final review round's bible commit could not
        // publish -- persisted here so the warning outlives the live log.
        kbBibleUnpublished: kbWork && typeof kbWork.unpublishedBible === 'function' ? kbWork.unpublishedBible() : null,
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
    //
    // In the no-write modes the row is swapped for the no-push variant and the
    // member's HEAD/tree is snapshotted inside the bracket (prepare runs after
    // the G-pull), once -- a resume keeps the original snapshot.
    const noWrite = NO_WRITE_HARVEST_MODES.includes(harvestMode);
    let guard = null;
    let preSnapshot = null;
    if (noWrite) {
        if (typeof command !== 'function') {
            throw new Error(`runHarvestPhase: harvest mode "${harvestMode}" requires the command seam to verify the harvester's member`);
        }
        guard = noWriteGuard({ command, member: dispatchCtx.getMemberForRole('harvester'), log, harvestMode });
    }
    const harvestOutcome = await dispatchRole(
        noWrite ? { ...dispatchCtx, policies: HARVESTER_NO_WRITE_POLICIES } : dispatchCtx,
        'harvester',
        {
            prompt: harvesterPrompt,
            resumePrompt: harvesterResumePrompt(harvestMode),
            roleLabel: 'Harvester',
            resumeLabel: `Harvest (resume, max_turns=${TURN_BASES.HARVESTER_MAX_TURNS * 2})`,
            ...(noWrite ? {
                prepare: async () => {
                    if (preSnapshot === null) preSnapshot = await guard.snapshot();
                    return {};
                },
            } : {}),
        }
    );
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
    const harvestWriteCheck = noWrite
        ? await guard.verify(preSnapshot)
        : { status: 'not-applicable', detail: `harvest mode ${harvestMode} permits repository writes` };

    // The harvest round's bible commit: confirmations still pending (a
    // maintainer that was busy or whose push failed in an earlier round) go
    // to the bible on each repository's kb_maintainer -- G-pull,
    // kb_bible_commit, G-push. A no-op after a FAIL verdict or with nothing
    // pending. Runs after the harvester's own G-push, so its commits are on
    // the branch the bible commit lands on -- and after the no-write check,
    // so the engine's own bible commit is never mistaken for a harvester
    // write.
    if (kbWork && typeof kbWork.commitRound === 'function') {
        await kbWork.commitRound('harvest');
        if (typeof kbWork.warnPending === 'function') kbWork.warnPending();
    }
    return { costAnalysis, harvestAnalysis: prAnalysis, harvestWriteCheck };
}

/**
 * The max_turns resume prompt. Its leading sentence is the 'harvester'
 * secondary row's ladderAnchor and must stay byte-identical; the rest follows
 * the harvest mode, so a no-write harvest is never told to commit.
 */
export function harvesterResumePrompt(harvestMode) {
    const head = 'Continue your harvest exactly where you left off in this same session';
    if (NO_WRITE_HARVEST_MODES.includes(harvestMode)) {
        return `${head} -- harvest mode is ${harvestMode}: do not create, edit or commit any repository file. Finish the remaining knowledge-bank captures and backlog confirmation, and return your final report now.`;
    }
    return `${head} -- do not redo docs sections already written. Finish the remaining updates, commit them, and return your final report now.`;
}

const SHA_RE = /^[0-9a-f]{7,64}$/;
// A `git status --porcelain` (v1) line: two status characters, a space, a path.
const PORCELAIN_LINE_RE = /^[ MTADRCU?!]{2} (.+)$/;
// Paths `git clean` may be handed verbatim on any member shell.
const CLEANABLE_PATH_RE = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

/**
 * Parses `git status --porcelain` output into entries, or null when the
 * output is not porcelain at all (an unreadable status is never "clean").
 * .beads/ paths are dropped: bd's passive export changes there whenever the
 * backlog confirmation mutates beads, which the no-write modes permit.
 * @param {unknown} output
 * @returns {Array<{ code: string, path: string, line: string }>|null}
 */
export function parsePorcelainStatus(output) {
    const entries = [];
    for (const line of String(output ?? '').split(/\r?\n/)) {
        if (line.trim() === '') continue;
        const m = PORCELAIN_LINE_RE.exec(line);
        if (!m) return null;
        let p = m[1];
        const arrow = p.indexOf(' -> ');
        if (arrow !== -1) p = p.slice(arrow + 4);
        if (p === '.beads' || p.startsWith('.beads/')) continue;
        entries.push({ code: line.slice(0, 2), path: p, line });
    }
    return entries;
}

/**
 * The no-write harvest check on the harvester's member. snapshot() records
 * HEAD and the working tree; verify(pre) compares them after the dispatch
 * and, on a violation, undoes only the harvester's changes (see verify) and
 * re-reads both to report whether the member matches its pre-harvest state
 * exactly. Every command is a plain git invocation whose arguments the engine
 * has validated (a hex sha, a `:/`-prefixed [A-Za-z0-9._/-] path), so it is
 * shell-neutral on any member shell.
 */
function noWriteGuard({ command, member, log, harvestMode }) {
    const runHarvesterGit = (cmd, label) => command(cmd, {
        member_name: member, silent: true, failSoft: true, label,
    });
    const snapshot = async () => {
        const headRes = await runHarvesterGit('git rev-parse HEAD', `harvest no-write check: read HEAD on '${member}'`);
        const statusRes = await runHarvesterGit('git status --porcelain', `harvest no-write check: read working tree on '${member}'`);
        const rawHead = headRes && headRes.ok ? String(headRes.output ?? '').trim() : '';
        const head = SHA_RE.test(rawHead) ? rawHead : null;
        const entries = statusRes && statusRes.ok ? parsePorcelainStatus(statusRes.output) : null;
        let error = null;
        if (head === null) {
            error = `could not read HEAD on member '${member}'${headRes && headRes.error ? ` (${headRes.error})` : ''}`;
        } else if (entries === null) {
            error = `could not read the working tree status on member '${member}'${statusRes && statusRes.error ? ` (${statusRes.error})` : ''}`;
        }
        return { head, entries, error };
    };
    const unverified = (detail) => {
        log(`[Harvest Write Check Unverified] harvest mode ${harvestMode}: ${detail} -- the engine cannot confirm the harvester left the repository unchanged.`);
        return { status: 'unverified', detail };
    };
    const verify = async (pre) => {
        if (!pre) return unverified(`no pre-dispatch snapshot of member '${member}' was taken`);
        if (pre.error) return unverified(`${pre.error} before the dispatch`);
        const post = await snapshot();
        if (post.error) return unverified(`${post.error} after the dispatch`);
        const preLines = new Set(pre.entries.map((e) => e.line));
        const prePaths = new Set(pre.entries.map((e) => e.path));
        const postLines = new Set(post.entries.map((e) => e.line));
        const postPaths = new Set(post.entries.map((e) => e.path));
        const newEntries = post.entries.filter((e) => !preLines.has(e.line));
        // Pre-existing changes the harvester removed outright (reverted or
        // committed); a pre-existing path it changed further is in newEntries.
        const lostEntries = pre.entries.filter((e) => !postLines.has(e.line) && !postPaths.has(e.path));
        const headMoved = post.head !== pre.head;
        if (!headMoved && newEntries.length === 0 && lostEntries.length === 0) {
            log(`Harvest mode ${harvestMode}: verified the harvester left member '${member}' unchanged (HEAD ${pre.head}, no new working-tree changes).`);
            return { status: 'clean', detail: `HEAD ${pre.head} unchanged and no new working-tree changes` };
        }
        const parts = [];
        if (headMoved) parts.push(`HEAD moved from ${pre.head} to ${post.head}`);
        if (newEntries.length > 0) parts.push(`working tree changed: ${newEntries.map((e) => e.path).join(', ')}`);
        if (lostEntries.length > 0) parts.push(`pre-existing working-tree changes removed: ${lostEntries.map((e) => e.path).join(', ')}`);
        log(`[Harvest Write Violation] harvest mode ${harvestMode}: the harvester changed the repository on member '${member}' despite the no-write mode -- ${parts.join('; ')}. Restoring the member to its pre-harvest state; the engine pushes nothing from this harvest.`);

        // Restore without ever discarding work that was on the member before
        // the dispatch (the G-pull is a fast-forward, which succeeds on a
        // dirty tree, so a member may carry uncommitted edits of its own):
        //   - HEAD: `git reset --keep`, which refuses rather than overwrite a
        //     local change. If it refuses, `git reset --soft` still takes the
        //     harvester's commit off the branch (Publish PR must never push
        //     it) while keeping every byte in the index and working tree, and
        //     path restores are skipped -- the member is reported NOT restored.
        //   - a tracked path first changed by the harvester: restored from the
        //     pre-harvest HEAD (or removed, when the harvester added it);
        //   - a new untracked path: removed;
        //   - a path that was already dirty before the dispatch, a rename/copy,
        //     or a name that is not a plain [A-Za-z0-9._/-] path: left alone
        //     and reported, since restoring it could destroy pre-existing work.
        // Pathspecs carry the `:/` prefix: porcelain paths are relative to the
        // repository root, which the member's working directory need not be.
        const notes = [];
        let restorePaths = true;
        if (headMoved) {
            const keepRes = await runHarvesterGit(`git reset --keep ${pre.head}`, `harvest no-write check: move '${member}' back to ${pre.head} keeping local changes`);
            if (!keepRes || !keepRes.ok) {
                restorePaths = false;
                notes.push(`git reset --keep ${pre.head} refused (local changes overlap the harvester's commit)`);
                log(`[Harvest Write Violation] harvest mode ${harvestMode}: git reset --keep ${pre.head} refused on member '${member}'${keepRes && keepRes.error ? ` (${keepRes.error})` : ''}; moving HEAD back with git reset --soft so the harvester's commit is never pushed, and leaving the working tree untouched.`);
                await runHarvesterGit(`git reset --soft ${pre.head}`, `harvest no-write check: move '${member}' HEAD back to ${pre.head} without touching files`);
            }
        }
        if (restorePaths) {
            for (const e of newEntries) {
                if (prePaths.has(e.path)) {
                    notes.push(`'${e.path}' was already modified before the harvest and was changed again; left as is`);
                } else if (!CLEANABLE_PATH_RE.test(e.path) || e.code[0] === 'R' || e.code[0] === 'C') {
                    notes.push(`'${e.path}' cannot be restored safely; left as is`);
                } else if (e.code === '??') {
                    await runHarvesterGit(`git clean -f -d -- :/${e.path}`, `harvest no-write check: remove untracked '${e.path}' on '${member}'`);
                } else if (e.code[0] === 'A') {
                    await runHarvesterGit(`git rm -f -q -- :/${e.path}`, `harvest no-write check: remove added '${e.path}' on '${member}'`);
                } else {
                    await runHarvesterGit(`git checkout ${pre.head} -- :/${e.path}`, `harvest no-write check: restore '${e.path}' on '${member}' from ${pre.head}`);
                }
            }
        }
        const after = await snapshot();
        let residual = [];
        if (after.error === null) {
            const afterLines = new Set(after.entries.map((e) => e.line));
            residual = [...new Set([
                ...after.entries.filter((e) => !preLines.has(e.line)).map((e) => e.path),
                ...pre.entries.filter((e) => !afterLines.has(e.line)).map((e) => e.path),
            ])];
        }
        // Restored means the SAME set of working-tree entries as before the
        // dispatch (not a subset: a missing entry is lost pre-existing work).
        const restored = after.error === null && after.head === pre.head && residual.length === 0;
        if (restored) {
            log(`Harvest mode ${harvestMode}: member '${member}' reset to ${pre.head}; the harvester's changes were discarded and the working tree matches its pre-harvest state.`);
            return { status: 'violation', restored: true, detail: `${parts.join('; ')}; member reset to ${pre.head}` };
        }
        const why = [
            ...(after.error ? [after.error] : []),
            ...(after.error === null && after.head !== pre.head ? [`HEAD is still ${after.head}`] : []),
            ...(residual.length > 0 ? [`residual paths: ${residual.join(', ')}`] : []),
            ...notes,
        ].join('; ');
        log(`[Harvest Write Violation] harvest mode ${harvestMode}: member '${member}' was NOT restored to its pre-harvest state (HEAD ${pre.head}) -- ${why} -- inspect the member before reusing it.`);
        if (after.error === null && after.head !== pre.head) {
            // The branch still carries the harvester's commit, so Publish PR
            // would push it: stop the sprint loudly instead.
            throw new Error(`harvest mode ${harvestMode}: the harvester committed on member '${member}' despite the no-write mode and the engine could not move HEAD back to ${pre.head} (${why}); refusing to continue to Publish PR.`);
        }
        return { status: 'violation', restored: false, detail: `${parts.join('; ')}; member NOT restored to its pre-harvest state (${why})` };
    };
    return { snapshot, verify };
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
