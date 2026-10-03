// PR-body and cost-report text surface for fleet-sprint (apra-fleet-3swo.6.14).
// Extracted out of runner.js; runner.js re-exports every symbol it previously
// exported from this region, so existing importers of fleet-sprint/runner.js
// resolve unchanged.
//
// This module owns:
//   - sanitizePrText: the PR title/body sanitizer the Publish PR step runs
//     the final verdict's LLM-authored notes through before handing them to
//     VCSModule's create-pull-request command builder.
//   - buildAnalysisText: the Harvester dispatch's `analysisText` block
//     builder (module-private -- it is the body builder buildCostAnalysis
//     and the PR text path share, so it moves with them rather than staying
//     behind).
//   - buildCostAnalysis: the sprint cost block (appended to analysisText and
//     rendered in the PR body), reporting budget/spend honestly from the live
//     `budget` object.
//   - computeBranchSlug: the collision-resistant filesystem slug for
//     `docs/sprint-analysis-<slug>.md`.
//
// sanitizePrText depends on SAFE_TEXT_RE, which moved to newtask-text.mjs
// (apra-fleet-3swo.6.14 Part Two) alongside the newTask-title validation
// surface it also guards -- imported back here rather than duplicated.

import { createHash } from 'crypto';
import { SAFE_TEXT_RE } from './newtask-text.mjs';
import { formatDispatchToolCalls } from './dispatch-accounting.mjs';

// ---------------------------------------------------------------------------
// PR body/title text sanitization. The final reviewer's verdict notes are LLM
// output embedded in the PR title/body that the Publish PR step passes into
// VCSModule's create-pull-request command builder, which JSON-encodes them
// into the curl request payload -- the same injection class SAFE_TEXT_RE
// exists to close for newTask titles, at a different call site.
//
// Unlike validateNewTask(), rejecting is not an option here: the PR must still
// carry the sprint's verdict to a human even when the notes are malformed, and
// failing closed would drop the one thing that human most needs to read. So
// this strips instead: every character outside SAFE_TEXT_RE becomes a space,
// keeping the notes readable while nothing that could break out of the
// shell-quoted command string VCSModule builds around it.
/**
 * Sanitizes LLM-authored free text (e.g. finalVerdictResult.notes) before it
 * is embedded in a VCSModule-built PR title/body and dispatched via
 * `command()`. Replaces every character outside SAFE_TEXT_RE with a space,
 * collapses the resulting whitespace, and returns the readable remainder.
 * @param {unknown} text
 * @returns {string}
 */
export function sanitizePrText(text) {
    const str = String(text ?? '');
    let out = '';
    for (const ch of str) {
        // Newlines and tabs collapse to a space along with every other
        // disallowed character: SAFE_TEXT_RE has no multi-line allowance,
        // because a literal newline inside a double-quoted command-string
        // argument is not reliably safe across mixed POSIX/Windows shells.
        out += SAFE_TEXT_RE.test(ch) ? ch : ' ';
    }
    return out.replace(/\s+/g, ' ').trim();
}

// The Regression Test phase is informational-only and must never gate the
// sprint; packages/apra-fleet-se/test/regression-phase-never-gates.test.mjs
// enforces that.
// ---------------------------------------------------------------------------
// Finalization prompt builders
// ---------------------------------------------------------------------------

/**
 * " (<part>: pass, <part>: fail)" from the playbook-defined `sections`, or
 * from the deprecated two-part fields when an older runner returned those;
 * '' when neither is present. The part names are the target playbook's own.
 * @param {object} r regression-test-runner result
 * @returns {string}
 */
export function formatRegressionParts(r) {
    const pf = (v) => (v === true ? 'pass' : 'fail');
    let parts = [];
    if (Array.isArray(r.sections) && r.sections.length > 0) {
        parts = r.sections.map((s) => `${s.name}: ${pf(s.passed)}`);
    } else {
        if (typeof r.suitePassed === 'boolean') parts.push(`part 1: ${pf(r.suitePassed)}`);
        if (typeof r.smokePassed === 'boolean') parts.push(`part 2: ${pf(r.smokePassed)}`);
    }
    return parts.length ? ` (${parts.join(', ')})` : '';
}

const REGRESSION_VERDICTS = ['PASS', 'FAIL', 'INCONCLUSIVE'];

/**
 * The regression verdict, or null when the runner reported none. A verdict
 * is copied verbatim from a machine-written verdict file (see
 * agents/regression-test-runner.md), so it outranks the boolean `passed`:
 * INCONCLUSIVE must never be rendered as a failure.
 * @param {object} r regression-test-runner result
 * @returns {'PASS'|'FAIL'|'INCONCLUSIVE'|null}
 */
export function regressionVerdictOf(r) {
    return r && REGRESSION_VERDICTS.includes(r.verdict) ? r.verdict : null;
}

/**
 * One-line headline for a regression result: "Regression: <VERDICT> @ <sha12>
 * (parts) [evidence counts] <runUrl>" when a verdict is present, else the legacy
 * "Regression pass: PASSED|FAILED (parts)". No trailing period.
 * @param {object} r regression-test-runner result
 * @returns {string}
 */
export function formatRegressionHeadline(r) {
    const verdict = regressionVerdictOf(r);
    if (verdict) {
        const sha = typeof r.testedSha === 'string' && r.testedSha ? ` @ ${r.testedSha.slice(0, 12)}` : '';
        const ev = r.evidence && typeof r.evidence === 'object' ? r.evidence : {};
        const counts = [];
        if (Array.isArray(ev.newFailures)) counts.push(`${ev.newFailures.length} new failure(s)`);
        if (Array.isArray(ev.inventoryMissing)) counts.push(`${ev.inventoryMissing.length} inventory missing`);
        const evText = counts.length ? ` [${counts.join(', ')}]` : '';
        const url = typeof ev.runUrl === 'string' && ev.runUrl ? ` ${ev.runUrl}` : '';
        return `Regression: ${verdict}${sha}${formatRegressionParts(r)}${evText}${url}`;
    }
    return `Regression pass: ${r.passed === true ? 'PASSED' : 'FAILED'}${formatRegressionParts(r)}`;
}

/**
 * Assembles the `analysisText` block for the Harvester dispatch from this
 * run's in-memory tracking state: cycle-by-cycle closed-bead progress,
 * deploy/integration outcomes, rejected reviewer newTasks, the final verdict,
 * and the regression pass. Pure formatting -- every value is computed
 * elsewhere. harvester.md requires this content be written verbatim to
 * `analysisArtifactFile`.
 * @param {object} opts
 * @returns {string}
 */
export function buildAnalysisText({
    targetIssues, branch, baseBranch, cyclesRun,
    closedCountHistory, highWaterClosedCount,
    deployFailures, integFailures, rejectedNewTasks,
    finalVerdictResult, finalClosedCount, finalOpenAtGoalCount,
    // apra-fleet-rp7a.1: the ids excluded from finalOpenAtGoalCount because
    // they are DEFERRED. Reported as their own line rather than folded into
    // the count, so "Final open-at-goal-priority count: 0" can never be read
    // as "nothing was skipped".
    finalDeferredAtGoalIds = [],
    regressionResult = null,
    // Set when the pass was deliberately skipped (e.g. 'launch option'), so the
    // report says so instead of the misleading "no playbook" line.
    regressionSkippedBy = null,
    // Per-dispatch kb_* and code_* call records (sprint state's dispatchToolCalls,
    // from session_stats snapshots). Omitted -> no section; an unknown count
    // is printed as unknown, never 0.
    dispatchToolCalls = null,
    // The KB work client's unpublishedBible(): per repository, confirmations
    // still not in a pushed bible commit. Rendered as a loud section only
    // when any are, so a sprint whose bible was published reads as before.
    kbBibleUnpublished = null,
}) {
    // The once-per-sprint Regression Test phase runs after the final verdict
    // and never gates it. Its failures are filed as parent-less carry-over
    // beads, so they never appear in the open-at-goal count and are reported
    // separately here.
    const regressionLines = regressionSkippedBy
        ? [`Regression pass: skipped by ${regressionSkippedBy} -- not run this sprint.`]
        : regressionResult === null
        ? ['Regression pass: not run this sprint (no regression-test-playbook.md, or the probe failed).']
        : [
            `${formatRegressionHeadline(regressionResult)}.`,
            `Carry-over beads filed: ${(regressionResult.bugsFiled || []).join(', ') || 'none'}.`,
            `Summary: ${regressionResult.summary || '(none reported)'}`,
            'Informational only -- this pass ran after the final verdict and did not gate it; any bead '
            + 'above is parent-less by design and carries over to a future sprint.',
        ];
    const lines = [
        `# Sprint Analysis: ${branch}`,
        '',
        `Scope issue id(s): ${targetIssues.join(', ') || '(none specified)'}.`,
        `Base branch: ${baseBranch}.`,
        `Cycles run: ${cyclesRun}.`,
        '',
        '## Progress',
        '',
        `Closed-bead count history (per cycle evaluation): [${closedCountHistory.join(', ') || 'none recorded'}].`,
        `High-water-mark closed count this sprint: ${highWaterClosedCount}.`,
        `Final closed count: ${finalClosedCount}.`,
        `Final open-at-goal-priority count: ${finalOpenAtGoalCount}.`,
        finalDeferredAtGoalIds.length > 0
            ? `Deferred bead(s) at/above goal priority, excluded from that count and treated as out of scope `
              + `(a deferred bead is never dispatchable, so no cycle could advance it): ${finalDeferredAtGoalIds.join(', ')}.`
            : 'No beads were deferred out of scope at/above goal priority this sprint.',
        '',
        '## Deploy/Integration outcomes',
        '',
        deployFailures.length > 0
            ? `Deploy failures (${deployFailures.length}): ` + deployFailures.map((f) => `C${f.cycle}: ${f.notes}`).join(' | ')
            : 'No deploy failures recorded this sprint.',
        integFailures.length > 0
            ? `Integration test failures (${integFailures.length}): ` + integFailures.map((f) => `C${f.cycle}: ${f.notes} (bugs filed: ${(f.bugsFiled || []).join(', ') || 'none'})`).join(' | ')
            : 'No integration test failures recorded this sprint.',
        '',
        '## Reviewer-proposed newTask rejections',
        '',
        rejectedNewTasks.length > 0
            ? `${rejectedNewTasks.length} newTask(s) rejected before reaching bd create: ` + rejectedNewTasks.map((r) => `C${r.cycle}: ${r.reason}`).join(' | ')
            : 'None.',
        '',
        '## Final verdict',
        '',
        `${finalVerdictResult.verdict}${finalVerdictResult.notes ? ` -- ${finalVerdictResult.notes}` : ''}`,
        '',
        '## Regression pass (once per sprint, informational)',
        '',
        ...regressionLines,
        ...kbBibleLines(kbBibleUnpublished),
    ];
    if (Array.isArray(dispatchToolCalls)) {
        lines.push(
            '',
            '## KB and code tool calls per member per dispatch',
            '',
            "Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.",
            '',
            ...formatDispatchToolCalls(dispatchToolCalls),
        );
    }
    return lines.join('\n');
}

/**
 * The analysis section for KB confirmations that never reached a pushed bible
 * commit (the push kept failing, the maintainer stayed busy or unreachable, or
 * bible commits were sealed). Empty when every confirmation was published.
 * @param {{ repos?: Array<{ repo: string, count: number }>, sealedReason?: string|null }|null} unpublished
 * @returns {string[]}
 */
function kbBibleLines(unpublished) {
    const repos = unpublished && Array.isArray(unpublished.repos) ? unpublished.repos.filter((r) => r && r.count > 0) : [];
    if (repos.length === 0) return [];
    return [
        '',
        '## KB bible',
        '',
        'WARNING: bible not published -- these KB confirmations are not in a pushed bible commit on the sprint branch'
        + ' as of this analysis (the harvest round retries once more after it is written):',
        ...repos.map((r) => `- ${r.repo}: ${r.count} unpublished confirmation(s).`),
        ...(unpublished.sealedReason ? [`Bible commits were sealed: ${unpublished.sealedReason}.`] : []),
    ];
}

/**
 * Builds the sprint cost block (appended to the analysis document and rendered
 * in the PR body) from the live `budget` object. Reports only what is known:
 * an unset ceiling, an absent spent() and an unpriced-model spend gap are each
 * stated as such rather than backfilled with a fabricated number, since the
 * block is published verbatim and never recomputed. The remaining budget is derived from
 * `total` and `spent()`, not read from the budget object.
 * @param {{ total: number|null, spent?: () => number, pricingSummary?: () => { real: number, fallback: number } }} budget
 * @param {{ spend?: number, dispatchCount?: number }} [integTestRunnerStats] -- apra-fleet-nwh.1:
 *   this sprint's own tracked integ-test-runner spend (a before/after
 *   `budget.spent()` delta accumulated by the caller around each Integ Test
 *   phase dispatch, see runSprintCycle's integTestRunnerSpend/
 *   integTestRunnerDispatchCount) and how many times that phase dispatched.
 *   Reported as its OWN line, distinct from doer/reviewer/overhead, instead
 *   of being silently folded into "overhead" -- often the single longest/
 *   most expensive phase (a full playbook run against a real sandbox).
 * @returns {string}
 */
export function buildCostAnalysis(budget, integTestRunnerStats = {}) {
    const total = budget && budget.total;
    const spent = budget && typeof budget.spent === 'function' ? budget.spent() : null;
    const lines = [
        total !== null && total !== undefined
            ? `Budget ceiling: $${total.toFixed(4)}.`
            : 'Budget ceiling: not set (no --budget flag) -- unlimited for this run.',
        typeof spent === 'number'
            ? `Tracked spend (priced dispatches only): $${spent.toFixed(4)}.`
            : 'Tracked spend: not tracked -- the budget object did not expose spent() for this run.',
    ];
    if (total !== null && total !== undefined && typeof spent === 'number') {
        lines.push(`Remaining budget: $${(total - spent).toFixed(4)}.`);
    } else {
        lines.push('Remaining budget: unknown/unbounded.');
    }
    // apra-fleet-nwh.1: an explicit integ-test-runner spend line, broken out
    // of the totals above (it is a SUBSET of `spent`, not additional spend)
    // so this often-longest phase is never silently bucketed into
    // "overhead" by a reader of this block. Honest about all three states:
    // the phase never dispatched this run, it dispatched but spend was not
    // trackable (same `spent()`-unavailable case as above), or a real
    // tracked figure.
    const integDispatchCount = Number.isInteger(integTestRunnerStats.dispatchCount) ? integTestRunnerStats.dispatchCount : 0;
    if (integDispatchCount === 0) {
        lines.push('Integ-test-runner spend: $0.0000 -- no integ-test-runner dispatch ran this sprint (no playbook found, or deploy never succeeded).');
    } else if (typeof spent !== 'number') {
        lines.push(`Integ-test-runner spend: not tracked -- ${integDispatchCount} dispatch(es) ran but the budget object did not expose spent() for this run.`);
    } else {
        const integSpend = typeof integTestRunnerStats.spend === 'number' ? integTestRunnerStats.spend : 0;
        lines.push(`Integ-test-runner spend: $${integSpend.toFixed(4)} across ${integDispatchCount} dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).`);
    }
    // Report the SOURCE of each priced dispatch's cost -- real per-member
    // rates vs. pricing.mjs's tier-band fallback -- so the figures above are
    // not read as uniformly exact.
    const summary = budget && typeof budget.pricingSummary === 'function' ? budget.pricingSummary() : null;
    if (summary) {
        const { real, fallback } = summary;
        if (real === 0 && fallback === 0) {
            lines.push('Pricing source: no dispatch was priced this run.');
        } else if (real > 0 && fallback === 0) {
            lines.push(`Pricing source: all ${real} priced dispatch(es) used real per-member rates (get_member_model_pricing).`);
        } else if (real === 0 && fallback > 0) {
            lines.push(`Pricing source: all ${fallback} priced dispatch(es) used the tier-band/concrete-model fallback estimate (real per-member pricing was unavailable) -- see pricing.mjs.`);
        } else {
            lines.push(`Pricing source: mixed -- ${real} dispatch(es) priced via real per-member rates, ${fallback} via the tier-band/concrete-model fallback estimate.`);
        }
    }
    lines.push(
        'Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- '
        + 'this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.'
    );
    return lines.join('\n');
}

/**
 * Computes the collision-resistant filesystem slug used for
 * `docs/sprint-analysis-<slug>.md`, the harvester's `analysisArtifactFile`
 * input.
 *
 * Replacing separators alone is not collision-free: two branches differing
 * only in a `/` versus a pre-existing `-` at the same position (e.g.
 * `feat/fleet-reorg` and `feat-fleet-reorg`) would collapse to the same slug
 * and clobber each other's artifact. Appending a short hash of the RAW branch
 * name disambiguates them while staying deterministic per branch, so reruns
 * still produce the same slug.
 * @param {string} branch
 * @returns {string}
 */
export function computeBranchSlug(branch) {
    const humanReadablePrefix = branch.replace(/[\\/]+/g, '-');
    const disambiguatingHash = createHash('sha256').update(branch).digest('hex').slice(0, 8);
    return `${humanReadablePrefix}-${disambiguatingHash}`;
}
