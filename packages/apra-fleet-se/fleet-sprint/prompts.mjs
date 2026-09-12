// The seven dispatch prompt builders for fleet-sprint's Plan/Develop/Review/
// Finalize phases (apra-fleet-3swo.3.4). Moved verbatim out of runner.js --
// runner.js re-exports the five builders it previously exported
// (buildPlannerPrompt, buildDoerPrompt, buildReviewerPrompt,
// buildFinalVerdictPrompt, buildHarvesterPrompt) and imports the other two
// (buildPlanReviewerPrompt, buildStreakAssignmentPrompt, previously
// module-private) for its own in-runner call sites, so behaviour is
// unchanged either way. This is a move-only extraction: every prompt string
// is byte-identical to the pre-move code.
//
// buildRejectedNewTaskResurfaceLines, kbKnowledgeBlock and kbPromotionBlock
// stay in runner.js (out of this bead's scope) and are imported back here;
// the resulting runner.js <-> prompts.mjs cycle is safe because every use is
// inside a function body, never at module-evaluation time.
import { wrapUntrustedBlock } from './contracts.mjs';
import { buildRejectedNewTaskResurfaceLines, kbKnowledgeBlock, kbPromotionBlock } from './runner.js';

/**
 * @param {{
 *   isDeltaCycle: boolean,
 *   targetIssues: string[],
 *   goal: string,
 *   requirementsFile: string|undefined,
 *   requirementsContent: string|null,
 *   feedback: string|null,
 *   replanScope?: string[]|null,
 *   rejectedNewTasksToResubmit?: Array<{title: string, description: string, reason: string, cycle: number|string}>,
 *   verifyExcluded?: string[],
 * }} opts
 * @returns {string}
 */
export function buildPlannerPrompt({ isDeltaCycle, targetIssues, goal, requirementsFile, requirementsContent, feedback, replanScope = null, rejectedNewTasksToResubmit = [], verifyExcluded = [] }) {
    const lines = [];

    // SCOPED in-cycle replan clause: present ONLY when a reviewer flagged
    // beads whose acceptance criteria are themselves defective, and absent
    // from every ordinary full-plan/re-plan dispatch. It narrows the planner to
    // amending just those beads' criteria/decomposition.
    const hasReplanScope = Array.isArray(replanScope) && replanScope.length > 0;
    if (hasReplanScope) {
        lines.push(
            'SCOPED IN-CYCLE REPLAN -- this is a NARROW, targeted re-planning pass, not a full ' +
            'sprint plan. A reviewer flagged the following already-created bead(s) as having ' +
            'DEFECTIVE ACCEPTANCE CRITERIA that cannot be satisfied by re-development as written: ' +
            `${replanScope.join(', ')}. Re-scope ONLY these bead(s): read each one\'s current ` +
            'description and the reviewer feedback below, then correct its acceptance criteria in ' +
            'place (via `bd update`), or -- if it is genuinely too large -- decompose it into ' +
            'task-type children with clear acceptance criteria and model metadata. Do NOT touch, ' +
            'reword, re-decompose, close, or create any bead OUTSIDE this flagged set, and do NOT ' +
            'add scope beyond the original sprint goal. Keep the goalposts fixed: you are fixing a ' +
            'defect in these specific beads, not re-planning the sprint.'
        );
    }

    if (isDeltaCycle) {
        lines.push(
            'This is a RE-PLANNING pass: a prior planning pass for this sprint was already ' +
            'approved and at least one develop/review cycle has since run. Per the ' +
            '"Re-planning behaviour" section of your agent contract: address GAPS ONLY. ' +
            'Do NOT re-plan or recreate issues that are already closed. Do NOT add scope ' +
            'beyond the original sprint goals and any open bugs/enhancements already in beads. ' +
            // Mirrors buildPlanReviewerPrompt's matching guard.
            'A feature whose children are ALL closed is pending feature-closure ' +
            '(the integration-test phase closes verified features): leave it exactly as it ' +
            'is -- do not decompose it again and do not create tasks duplicating its closed ' +
            'children, even if review feedback appears to ask for decomposition of such a ' +
            'feature (verify with bd list --parent <feature> --all first).'
        );
        // The pending-closure rule needs a REGRESSION exception for bugs, or a
        // regressed bug becomes unreachable by every role: the planner refuses
        // to re-decompose it, doers refuse non-task beads, and the integ runner
        // may only verify-and-close.
        lines.push(
            'REGRESSION EXCEPTION -- the leave-it-alone rule above does NOT apply to a ' +
            'regressed bug. An OPEN bug-type bead whose task children are all closed but ' +
            'whose own notes record the defect still reproducing AFTER those children ' +
            'closed (e.g. fresh evidence from a later integration-test run: "recurred", ' +
            '"still reproduces", "fix did not hold") is a REGRESSION, not pending-closure ' +
            'housekeeping. For each such bug: read its latest evidence with bd show, then ' +
            'create NEW task children under it (a fix task targeting the residual ' +
            'mechanism the fresh evidence names -- not a duplicate of the closed fix -- ' +
            'plus a [test] task pinning it), with acceptance criteria and model metadata ' +
            'as for any task. Leave the bug bead itself open as the parent.'
        );
    } else {
        lines.push('Analyze the sprint scope below and build a features+tasks DAG in beads, per your agent contract.');
    }

    lines.push(`Sprint root issue id(s) (--parent scope for this sprint): ${targetIssues.join(', ')}.`);

    // apra-fleet-jfo: authoritative, data-driven verify-route exclusion. This
    // supersedes the generic "pending feature-closure" prose above with an
    // exact id list from classifyVerifySet(), on EVERY cycle (not just delta
    // re-planning passes) and for any issue_type, not just features/bugs.
    if (Array.isArray(verifyExcluded) && verifyExcluded.length > 0) {
        lines.push(
            `VERIFY-ROUTE EXCLUSION -- these bead(s) are implementation-complete (every child ` +
            `closed) and are routed to integration-test verification this cycle, not planning: ` +
            `${verifyExcluded.join(', ')}. Do NOT create tasks for them, do NOT re-decompose them, ` +
            `do NOT treat them as unplanned or unaddressed work, and do NOT let plan-review gates ` +
            `bind over them -- they are out of scope for this planning pass entirely. Only the ` +
            `integration-test phase may close them (or reopen work under them if verification finds ` +
            `a real gap).`
        );
    }
    lines.push(`Goal priority for this sprint: ${goal}.`);
    lines.push(
        // Mirrors buildPlanReviewerPrompt's matching criterion. Doers may only
        // claim issue_type=task, so a bug left as a childless leaf would be
        // assigned directly and skipped every round.
        'Doers can only claim issue_type=task beads. Any OPEN bug-type bead in scope ' +
        'that has no task-type children yet must be decomposed during planning into ' +
        'one or more task-type children (with acceptance criteria and model metadata, ' +
        'including a [test] task where the fix is testable) -- the bug bead itself is ' +
        'never dispatched directly and stays open as the parent until its children ' +
        'are done and verified.'
    );
    // Only the affirmative instruction belongs here: '-tier'-suffixed
    // spellings are normalized deterministically in code (normalizeTierToken),
    // so the prompt does not need to warn against them.
    lines.push(
        'For every task: set clear acceptance criteria in its description, and set its ' +
        'model tier as beads metadata at creation time via ' +
        '`bd create ... --metadata \'{"model": "<tier>"}\'` (tier: cheap, standard, or ' +
        'premium) -- this is the ONLY location the model tier is recorded: do not ' +
        'additionally record it via bd\'s freeform notes field or a METADATA-section ' +
        'comment, per planner.md Step 3.'
    );

    if (requirementsFile && requirementsContent) {
        lines.push(`Requirements file (${requirementsFile}) content, for reference:`);
        lines.push(requirementsContent);
    } else if (requirementsFile && !requirementsContent) {
        lines.push(`Note: a requirementsFile ('${requirementsFile}') was configured for this sprint but could not be read; proceed without it.`);
    }

    // Reviewer-proposed newTasks rejected by validateNewTask() in an earlier
    // cycle resurface here, in the next planning dispatch, rather than
    // dead-ending in root-bead notes (which are still written, for
    // auditability).
    const resurfaceLines = buildRejectedNewTaskResurfaceLines(rejectedNewTasksToResubmit);
    if (resurfaceLines.length > 0) {
        lines.push(resurfaceLines.join('\n\n'));
    }

    if (feedback) {
        lines.push('Feedback from the previous plan-review round -- address every point raised:');
        lines.push(wrapUntrustedBlock('plan-reviewer.notes', feedback));
    }

    return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
//
// Builds the self-contained plan-reviewer dispatch prompt. The vendored
// agents/plan-reviewer.md requires one dispatch input, the sprint root/scope
// to review (its schema declares `required: ["scope"]`, and an unscoped
// dispatch must return verdict CHANGES_NEEDED), plus an OPTIONAL second input:
// prior-round verdicts for the current review cycle, supplied on round N>1 of
// the planner<->plan-reviewer loop so the no-goalpost-moving rule has
// something to bind against. The plan-reviewer has no memory of this
// conversation (dispatches default to `resume: false`), so the sprint root
// issue id(s) and goal priority defining the subtree under review are spelled
// out here; everything else (the DAG, task metadata) it reads from beads.
/**
 * @param {{
 *   targetIssues: string[],
 *   goal: string,
 *   priorRoundVerdicts?: Array<{ round: number, verdict: string, notes: string|null }>,
 *   replanScope?: string[]|null,
 * }} opts
 * @returns {string}
 */
export function buildPlanReviewerPrompt({ targetIssues, goal, priorRoundVerdicts = [], replanScope = null, verifyExcluded = [] }) {
    const hasReplanScope = Array.isArray(replanScope) && replanScope.length > 0;
    const lines = [
        'Review the beads DAG created by the planner for this sprint, per your agent contract.',
        `Sprint root / scope to review (the open beads subtree this review pass covers): ` +
        `sprint root issue id(s) ${targetIssues.join(', ')}, goal priority ${goal}. ` +
        'Review only the features and tasks under this scope.',
    ];

    // apra-fleet-jfo: same authoritative, data-driven verify-route exclusion
    // as buildPlannerPrompt -- the plan-reviewer must not fail the plan for
    // "not decomposing" or "not covering" a bead that is routed to
    // integration-test verification, not planning.
    if (Array.isArray(verifyExcluded) && verifyExcluded.length > 0) {
        lines.push(
            `VERIFY-ROUTE EXCLUSION -- these bead(s) are implementation-complete (every child ` +
            `closed) and routed to integration-test verification this cycle: ${verifyExcluded.join(', ')}. ` +
            `Do not withhold approval on the grounds that they are undecomposed, uncovered, or ` +
            `missing model metadata -- they are out of scope for this plan review entirely.`
        );
    }

    // Present only on a scoped in-cycle replan; an ordinary plan-review
    // dispatch carries no such clause.
    if (hasReplanScope) {
        lines.push(
            'SCOPED IN-CYCLE REPLAN REVIEW -- this pass follows a NARROW, targeted re-plan of ' +
            `specifically flagged bead(s) ${replanScope.join(', ')} whose acceptance criteria a ` +
            'reviewer judged defective. Focus your verdict on whether the planner has now given ' +
            'those bead(s) clear, satisfiable acceptance criteria (and decomposed them into ' +
            'task-type children if they were too large). Approve if the flagged bead(s) are now ' +
            'well-formed; do not withhold approval over unrelated, previously-accepted parts of ' +
            'the DAG, and do not demand new scope beyond fixing the flagged defect.'
        );
    }

    lines.push(
        'IMPORTANT -- pending-closure features: before flagging any feature as ' +
        'undecomposed (no child tasks / no [test] task) or as missing model metadata, ' +
        'check its CLOSED children too (bd list --parent <feature> --all). A feature ' +
        'whose children are all closed is PENDING FEATURE-CLOSURE housekeeping (the ' +
        'integration-test phase closes verified features) -- it is NOT undecomposed, ' +
        'must NOT fail coverage/decomposition/test-task/model-metadata criteria, and ' +
        'must NOT be re-decomposed. Mention such features as non-blocking notes only. ' +
        'Never ask the planner to create tasks that duplicate closed work.',
        'DISPATCHABILITY -- doers can only claim issue_type=task beads. If any OPEN ' +
        'bug-type bead in scope is a childless leaf (no task-type children, so it ' +
        'would be dispatched to a doer directly), the plan is NOT approvable: return ' +
        'CHANGES_NEEDED asking the planner to decompose that bug into task-type ' +
        'children. This does not apply to features covered by the pending-closure ' +
        'rule above.',
        // Mirrors buildPlannerPrompt's REGRESSION EXCEPTION clause; the two
        // must state the same rule or planner and plan-reviewer disagree.
        'REGRESSION EXCEPTION to the pending-closure rule -- for OPEN BUG-type beads ' +
        'only: if a bug\'s task children are all closed but its own notes record the ' +
        'defect still reproducing AFTER those children closed (fresh evidence from a ' +
        'later integration/test run: "recurred", "still reproduces", "fix did not ' +
        'hold"), it is a REGRESSION, not pending-closure housekeeping. Such a bug with ' +
        'no NEW open task children addressing the fresh evidence makes the plan NOT ' +
        'approvable: return CHANGES_NEEDED asking the planner to add a new fix task ' +
        '(targeting the residual mechanism the latest evidence names, never ' +
        'duplicating the closed fix) plus a [test] task. A bug whose notes show no ' +
        'post-closure recurrence stays under the pending-closure rule as before.',
    );

    // Rounds after the first carry every earlier round's verdict for this same
    // scope/cycle so the plan-reviewer can honor plan-reviewer.md's
    // no-goalpost-moving rule. Absent on round 1. Each verdict's notes are the
    // plan-reviewer's own free text, so they are wrapped as untrusted content.
    if (priorRoundVerdicts.length > 0) {
        lines.push(
            'Prior-round verdicts for THIS SAME review cycle (most recent last) -- per the ' +
            'no-goalpost-moving rule in your agent contract, a resolution an earlier round ' +
            'explicitly named acceptable is SETTLED: accept it again this round unless you ' +
            'can name specific NEW evidence, and never re-litigate it with a different ' +
            'demanded resolution.'
        );
        for (const { round, verdict, notes } of priorRoundVerdicts) {
            lines.push(wrapUntrustedBlock(
                `plan-reviewer.round-${round}-verdict`,
                `round ${round} verdict: ${verdict}\nnotes: ${notes || '(no notes)'}`
            ));
        }
    }

    return lines.join('\n\n');
}

/**
 * Builds the self-contained "group ready beads into streaks" prompt.
 * @param {{ readyBeadIds: string[] }} opts
 * @returns {string}
 */
export function buildStreakAssignmentPrompt({ readyBeadIds }) {
    return [
        'Group the following ready beads into logical development streaks ' +
        '(beads that must be worked sequentially by the SAME streak; ' +
        'independent beads should be their own streak so they can be worked ' +
        'in parallel by different doers).',
        `Ready bead ids: ${readyBeadIds.join(', ')}`,
        'Every ready bead id listed above must appear in exactly one streak -- ' +
        'no bead id may be omitted, duplicated, or invented.',
        'Return every bead id EXACTLY as listed above, character for character, ' +
        'including its full prefix. Never shorten, abbreviate, or strip a ' +
        'common-looking prefix: ids from different scopes do not necessarily ' +
        'share one, and any id that does not match the list verbatim is rejected.',
        'This is the complete input. Do not run bd, git, or any other command, ' +
        'and do not read any files to investigate further -- respond immediately ' +
        'using only the schema, based solely on the bead ids given above.',
    ].join('\n\n');
}

/**
 * Builds the self-contained doer dispatch prompt for one streak. `feedback`
 * carries only the bead(s) this streak owns -- never a blanket broadcast of
 * the whole reviewer verdict to every doer -- and is wrapped as untrusted
 * inter-agent content (contracts.mjs `wrapUntrustedBlock`). `branch` is the
 * sprint track branch and is always spelled out: doer.md requires it, and a
 * doer dispatched without one must return "BLOCKED" rather than guess whatever
 * branch happens to be checked out.
 * `kbKnowledge` carries the entries kb_session_prime returned for this member
 * (see kbKnowledgeBlock): the doer cannot read the KB itself on a member
 * dispatch, so this prompt is its only route to prior knowledge.
 * @param {{ beadIds: string[], branch: string, feedback: string|null, kbKnowledge?: object[] }} opts
 * @returns {string}
 */
export function buildDoerPrompt({ beadIds, branch, feedback, kbKnowledge }) {
    const lines = [
        `Sprint track branch to work on: ${branch}. Work on this branch only; do not push to the base branch.`,
        `Assigned bead ids (comma-separated): ${beadIds.join(', ')}`,
        'Work each assigned bead per your agent contract: read `bd show <id>` for its ' +
        'full acceptance criteria, implement and verify the change, then `bd close <id>` ' +
        'once it is done. Return your report strictly as the required JSON schema ' +
        '(status, closedIds, notes).',
        // Stated in the dispatch prompt so CLAUDE.md's permission-block policy
        // travels with every doer regardless of what its agent file says.
        'PERMISSION BLOCKS MUST BE SURFACED, NOT ROUTED AROUND: if any tool or git ' +
        'invocation (e.g. Edit/Write, git push) is blocked by the permission layer, STOP ' +
        'and report the block in your notes with status "BLOCKED" -- do NOT substitute a ' +
        'Bash heredoc/`cat > file`, a wrapper script, an alternate binary, or any other ' +
        'workaround whose purpose is to bypass the block, even for a brand-new file and ' +
        'even if you judge the underlying operation safe. This matches this repo\'s ' +
        'CLAUDE.md permission-block policy.',
        ...kbKnowledgeBlock(kbKnowledge),
    ];
    if (feedback) {
        lines.push(
            'Feedback from the previous review round for these specific bead(s) -- ' +
            'address every point before closing again:'
        );
        lines.push(wrapUntrustedBlock('reviewer.notes', feedback));
    }
    return lines.join('\n\n');
}

export function buildReviewerPrompt({ beadIds, acceptanceCriteriaJson, baseBranch, branch, goal, kbCandidates, kbKnowledge }) {
    const ids = Array.isArray(beadIds) ? beadIds : [];
    const scopeWide = ids.length === 0;
    // Scope-wide re-reviews are fed `bd list --json` (the whole remaining
    // scope); per-bead reviews are fed `bd show --json`. Label the untrusted
    // block with the command that actually produced it.
    const scopeCommand = scopeWide ? 'bd list --json' : 'bd show --json';
    return [
        scopeWide
            ? 'Re-review the CURRENT state of the entire sprint scope. No bead ids are named '
              + 'because no goal-priority beads remain open -- that is precisely the question you '
              + 'are being asked to settle: judge the delivered work as a whole and decide whether '
              + 'this sprint is genuinely complete.'
            : `Review the work just done for the following bead id(s): ${ids.join(', ')}.`,
        scopeWide
            ? 'The full sprint scope, from `bd list --json`:'
            : 'Full task detail (including acceptance criteria), from `bd show --json`:',
        wrapUntrustedBlock(scopeCommand, acceptanceCriteriaJson),
        `Diff range to review: ${baseBranch}..${branch} (base_branch..branch).`,
        // Without an explicit scope clause a reviewer can withhold APPROVED
        // over below-goal work the sprint deliberately defers, which starves
        // the completion gate (zero open goal beads AND an APPROVED verdict).
        ...(goal ? [
            `SPRINT SCOPE: this sprint's goal priority is ${goal}. Judge your verdict ` +
            (scopeWide
                ? `ONLY against work at or above that goal priority. `
                : `ONLY against the named bead id(s) above and other work at or above that `
                  + `goal priority. `) +
            `Features/beads BELOW the goal priority (e.g. P3 when the ` +
            `goal is P1/P2) are DEFERRED BY DESIGN to a later sprint: their absence ` +
            `from the diff is correct, must not block APPROVED, must not appear in ` +
            `reopenIds, and may be mentioned in notes only.`,
        ] : []),
        // apra-fleet-0ef: the reviewer is the ONLY role permitted to mint
        // CONFIRMED, but a KB entry id can only come from the KB, and the
        // reviewer subagent has no apra-fleet MCP tools to look one up. Without
        // this block it could never name an id, so `kb_promotions` came back
        // empty on every round and nothing was ever promoted. The engine reads
        // the candidates and executes; the judgment stays with the reviewer.
        // Prior knowledge FIRST, then the promotion candidates: the reviewer
        // judges the work against what the repo already knows before it decides
        // which of this sprint's captures earned CONFIRMED.
        ...kbKnowledgeBlock(kbKnowledge),
        ...kbPromotionBlock(kbCandidates),
        'Do NOT run any `bd` command yourself and do NOT mutate beads directly in any way ' +
        '(no bd update, bd close, bd create, etc.) -- the orchestrator applies your ' +
        '`reopenIds` via `bd update <id> --status=open` and creates your `newTasks` via ' +
        '`bd create`. Optionally include `replanIds`: a SUBSET of the ids you also named in ' +
        '`reopenIds` above whose acceptance criteria are themselves defective (not fixable by ' +
        're-development) and need a planner pass before the next dispatch, scoped to this ' +
        'cycle. An id you did not also name in `reopenIds` is dropped and never reaches the ' +
        'scoped-replan machinery, so only list ids you are reopening. ' +
        'Return ONLY your structured verdict (verdict, notes, reopenIds, replanIds, ' +
        'newTasks) strictly as the required JSON schema; never touch beads yourself.',
    ].join('\n\n');
}

/**
 * Builds the self-contained Final Review prompt (finalVerdict schema),
 * embedding the evidence the orchestrator gathered over the run -- sprint
 * scope, branch and base branch so the reviewer can diff for itself, and the
 * bead-count / deploy / integ-test outcomes -- so a returned PASS rests on
 * something concrete instead of being a rubber stamp.
 * @param {{
 *   targetIssues: string[], branch: string, baseBranch: string, goal: string,
 *   cyclesRun: number, closedCount: number, openAtGoalCount: number,
 *   deployFailures: Array<{cycle: number, notes: string}>,
 *   integFailures: Array<{cycle: number, notes: string, bugsFiled: string[]}>,
 *   rejectedNewTasks: Array<{cycle: number, reason: string, raw: object}>,
 *   unclosedVerifyIds?: string[],
 * }} opts
 * @returns {string}
 */
export function buildFinalVerdictPrompt({ targetIssues, branch, baseBranch, goal, cyclesRun, closedCount, openAtGoalCount, deployFailures, integFailures, rejectedNewTasks = [], unclosedVerifyIds = [], kbCandidates, kbKnowledge }) {
    const lines = [
        `Final review for sprint scope issue id(s): ${targetIssues.join(', ')}.`,
        `Branch: ${branch} (base: ${baseBranch}). Goal priority: ${goal}. The sprint ran ${cyclesRun} cycle(s).`,
        `Evidence: ${closedCount} bead(s) closed in scope; ${openAtGoalCount} bead(s) still open at or above goal priority ${goal}.`,
        `The evidence above (bead counts, deploy/integ outcomes) is a summary, not proof -- it reflects what the sprint claims, not what the code does. You MUST review the actual net diff yourself before returning PASS; a PASS grounded only in bead-closure counts is not acceptable. Diff range: ${baseBranch}..${branch} (base_branch..branch). Review it as a whole against what closed -- net changes vs. the beads claimed done, not a commit-by-commit walk.`,
    ];
    if (deployFailures.length > 0) {
        lines.push(
            `Deploy phase FAILED in ${deployFailures.length} cycle(s): ` +
            deployFailures.map((d) => `C${d.cycle}: ${d.notes}`).join(' | ')
        );
    }
    if (integFailures.length > 0) {
        lines.push(
            `Integration tests FAILED in ${integFailures.length} cycle(s): ` +
            integFailures.map((d) => `C${d.cycle} (bugsFiled: ${d.bugsFiled.join(', ') || 'none'}): ${d.notes}`).join(' | ')
        );
    }
    if (rejectedNewTasks.length > 0) {
        // newTasks rejected by validateNewTask are non-fatal to the sprint but
        // must still reach a human, so they are surfaced in the same evidence
        // block the final reviewer reads.
        lines.push(
            `${rejectedNewTasks.length} reviewer-proposed newTask(s) were REJECTED (not created via bd create) for failing input validation: ` +
            rejectedNewTasks.map((r) => `C${r.cycle}: ${r.reason}`).join(' | ')
        );
    }
    if (unclosedVerifyIds.length > 0) {
        // apra-fleet-jfo.2: verify-routed beads (implementation-complete,
        // all children closed, awaiting real integration-test
        // re-verification) are decomposed parents, so they are excluded
        // from `openAtGoalCount` above no matter their status -- do not let
        // their absence from that count read as "done".
        lines.push(
            `${unclosedVerifyIds.length} verify-routed bead(s) are STILL OPEN and were never confirmed working ` +
            `against the deployed build this sprint (most likely because Deploy failed before IntegTest could ` +
            `attempt them): ${unclosedVerifyIds.join(', ')}. These do NOT count toward openAtGoalCount above ` +
            `(decomposed-parent beads are excluded from that count), so do not treat 0 open-at-goal as ` +
            `evidence these are done -- treat each one as an open, unverified target when deciding PASS/FAIL.`
        );
    }
    lines.push(
        'Return a PASS/FAIL verdict per your agent contract, grounded in the evidence above -- ' +
        'never rubber-stamp PASS regardless of open goal-priority beads or deploy/integration failures.'
    );
    lines.push(
        'Return any actionable findings as `newTasks` (title, description, priority each) so they ' +
        'persist in beads for the next sprint -- notes alone do not reach the backlog. This applies ' +
        'on BOTH verdicts, not just FAIL: a PASS can still have real secondary findings (a defect that ' +
        'does not block this epic\'s own acceptance criteria, a missing test, a follow-up worth tracking) ' +
        'that would otherwise be lost prose with no way for a future sprint to act on them. One task per ' +
        'distinct finding; reference concrete files/tests in each description. Omit newTasks or return ' +
        '[] only when you have nothing further to flag.'
    );
    lines.push(
        'If any ALREADY-CLOSED bead should be reopened -- e.g. it was closed on insufficient evidence, ' +
        'or a defect remains in work already marked done -- return it in `reopenIds` as ' +
        '`{ id, reason }`. Every entry needs its OWN specific reason (not a shared blanket note): the ' +
        'orchestrator appends `reason` verbatim as a durable note on that exact bead, so a vague or ' +
        'missing reason is useless to whoever reads it later. Do not use reopenIds for beads that were ' +
        'never closed -- that is what `newTasks` is for.'
    );
    lines.push(
        'NEVER touch beads yourself (no bd create/update/reopen) -- the orchestrator applies your ' +
        'newTasks and reopenIds.'
    );
    // apra-fleet-nx7: the Final Review is the best-positioned promoter in the
    // whole run -- it has read the entire diff, run the full suite and judged the
    // sprint as a whole, which is exactly the evidence standard reviewer.md
    // demands before minting CONFIRMED. It used to receive no candidate block at
    // all (0ef wired kbCandidates through buildReviewerPrompt only), so anything
    // captured in a sprint's LAST round reached this reviewer and nobody else,
    // and was stranded at INFERRED forever.
    lines.push(...kbKnowledgeBlock(kbKnowledge));
    lines.push(...kbPromotionBlock(kbCandidates));
    return lines.join('\n\n');
}

/**
 * Builds the self-contained Harvester dispatch prompt, wiring the five inputs
 * harvester.md requires -- analysisArtifactFile, analysisText, costAnalysis,
 * baseBranch and branch -- with real, runner-computed values. The vendored
 * input schema is deliberately not loosened to accommodate missing values;
 * supplying them is the caller's job.
 * @param {{ branch: string, baseBranch: string, targetIssues: string[], analysisArtifactFile: string, analysisText: string, costAnalysis: string }} opts
 * @returns {string}
 */
export function buildHarvesterPrompt({ branch, baseBranch, targetIssues, analysisArtifactFile, analysisText, costAnalysis }) {
    // analysisText/costAnalysis are orchestrator-computed, not another agent's
    // output, so wrapUntrustedBlock does not apply. Each still gets its own
    // fence sized past the longest backtick run in that block, so a literal
    // fence line inside the content cannot terminate it early.
    const fence = (content) => '`'.repeat(Math.max(3, (content.match(/`+/g) || []).reduce((m, r) => Math.max(m, r.length), 0) + 1));
    const analysisFence = fence(analysisText);
    const costFence = fence(costAnalysis);
    return [
        `Harvest durable knowledge for sprint scope issue id(s): ${targetIssues.join(', ')}.`,
        `Branch: ${branch} (base: ${baseBranch}).`,
        'Update docs/, README/CHANGELOG (including a cost-analysis block), and defer low-priority issues, per your agent contract.',
        `analysisArtifactFile: ${analysisArtifactFile}`,
        `analysisText (pre-computed by the orchestrator -- write verbatim to analysisArtifactFile, per Step 1 of your contract):\n${analysisFence}\n${analysisText}\n${analysisFence}`,
        `costAnalysis (pre-computed by the orchestrator -- insert verbatim into the CHANGELOG entry, per Step 4 of your contract):\n${costFence}\n${costAnalysis}\n${costFence}`,
    ].join('\n\n');
}
