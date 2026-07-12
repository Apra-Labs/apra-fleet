import fs from 'fs/promises';
import { AgentOutputError } from '@apralabs/apra-fleet-workflow';
import {
    ROLES, planReviewerVerdict, doerReport, reviewerVerdict, streakAssignment,
    deployerReport, integReport, finalVerdict, harvesterReport, wrapUntrustedBlock,
} from './contracts.mjs';
import { SprintPlanRejectedError, StalledSprintError } from './errors.mjs';

// ---------------------------------------------------------------------------
// Canonical role-name constants for the Develop/Review loop (apra-fleet-unw.16)
// ---------------------------------------------------------------------------
//
// Root-cause fix for the A2 "Doer/doer casing" pool-collapse bug: before
// this issue, `getMembersForRole` special-cased the CAPITALIZED strings
// 'Doer'/'Reviewer' while every call site below passed the lowercase
// 'doer'/'reviewer' -- so the special case never matched and the doer pool
// silently collapsed to a single member (`[physicalMembers[0]]`), and the
// "multiple members work in parallel" feature the sprint runner advertises
// never actually happened. `roleConst()` below pulls the value straight out
// of `contracts.ROLES` (the single canonical, lowercase role enum) and
// throws at module-load time if it's ever not a member of that enum, so a
// future rename of the enum can't silently reintroduce a casing/typo
// mismatch here.
function roleConst(name) {
    if (!ROLES.includes(name)) {
        throw new Error(`[Role Contract] '${name}' is not a member of contracts.ROLES: ${ROLES.join(', ')}`);
    }
    return name;
}
const ROLE_DOER = roleConst('doer');
const ROLE_REVIEWER = roleConst('reviewer');

export const meta = { name: 'auto-sprint-runner' };

// ---------------------------------------------------------------------------
// bd JSON-parse helper (apra-fleet-unw.17, A5 work item 3)
// ---------------------------------------------------------------------------
//
// Before this issue, every `bd list ... --json` call site did a bare
// `JSON.parse(res || '[]')`. Any noise on stdout ahead of the JSON payload
// (a stray warning line, a deprecation notice, etc. -- anything that isn't
// itself valid JSON) produced a bare `SyntaxError: Unexpected token ...`
// with no indication of which `bd` command produced it, deep inside a
// multi-cycle sprint run. This helper names the offending command and
// includes a snippet of the raw output in the thrown error so a human/CI
// reading the failure can immediately tell what went wrong and why, instead
// of just seeing "SyntaxError" and having to bisect the whole run.
/**
 * @param {string} raw - the raw text returned by `command()`
 * @param {string} commandLabel - the `bd` command that produced `raw`, for diagnostics
 * @returns {any}
 */
export function parseBdJson(raw, commandLabel) {
    const text = raw === undefined || raw === null || raw === '' ? '[]' : raw;
    try {
        return JSON.parse(text);
    } catch (err) {
        const snippet = text.length > 500 ? `${text.slice(0, 500)}... (truncated, ${text.length} chars total)` : text;
        throw new Error(
            `[bd JSON Parse Error] Failed to parse JSON output from '${commandLabel}': ${err.message}. ` +
            `Raw output snippet: ${JSON.stringify(snippet)}`
        );
    }
}

// ---------------------------------------------------------------------------
// Goal-priority helpers (apra-fleet-unw.17, A5 work item 3)
// ---------------------------------------------------------------------------
//
// `validated.goal` is a slash-separated list of priorities (e.g. 'P1',
// 'P1/P2', 'P1/P2/P3'), already validated against GOAL_PATTERN above. The
// sprint's real completion/exit condition (as opposed to "is there ready
// work to dispatch RIGHT NOW", which `--ready` still answers correctly for
// within-cycle dispatch purposes) is: are there any NOT-YET-CLOSED beads in
// scope at or above (numerically <=) the worst priority named in the goal?
// `bd list --priority-max=Pn` is inclusive of Pn, so the "worst" (highest
// numeric) priority in the goal is exactly the right `--priority-max` value.
/**
 * @param {string} goal - e.g. 'P1', 'P1/P2', 'P1/P2/P3'
 * @returns {string} the lowest-priority (highest 'Pn' number) tier named in `goal`, e.g. 'P2'
 */
export function goalPriorityMax(goal) {
    const tiers = goal.split('/').map((p) => Number(p.slice(1)));
    const worst = Math.max(...tiers);
    return `P${worst}`;
}

// Every status that means "not yet done" for exit-condition purposes --
// deliberately NOT `--ready`, which only reflects "dispatchable right now"
// and silently excludes blocked/orphaned in_progress beads (the exact A5
// bug: `bd list --ready == []` used to be misread as "the sprint is done"
// even when a bead was stuck blocked or left in_progress with no doer ever
// finishing it).
const NOT_DONE_STATUSES = 'open,in_progress,blocked';

// We can import standard node modules in workflows if needed, or pass them in context.
// For now, we'll assume we check runbooks via command() since we are in the workflow engine.

// ---------------------------------------------------------------------------
// CLI -> runner argument contract (apra-fleet-unw.14)
// ---------------------------------------------------------------------------
//
// This is the canonical, validated shape of `args` (the `context.args`
// object WorkflowEngine.executeFile()/runWithContext() hands to main()).
// bin/cli.mjs is required to produce args matching this contract; unknown
// keys and missing required keys are both rejected loudly here so a
// CLI/runner drift (a flag added on one side and forgotten on the other)
// fails fast instead of silently no-oping.
//
// Also serves as the A7 defense-in-depth layer: `target_issues`/
// `target_issue`, `branch`, and `base_branch` are all validated against
// shell-injection-safe patterns here, in addition to bin/cli.mjs's own
// validation (which imports validateIssueId/validateBranchName from this
// module -- single source of truth), so a malicious id/branch name can
// never reach a command() interpolation even if the CLI layer is somehow
// bypassed. Validation runs before ANY agent()/command() dispatch below,
// so a rejected arg produces zero fleet dispatches.

const ISSUE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;
const GOAL_PATTERN = /^P[1-3](\/P[1-3]){0,2}$/;

const KNOWN_ARG_KEYS = new Set([
    'target_issues', 'target_issue', 'members', 'branch', 'base_branch',
    'goal', 'max_cycles', 'requirementsFile', 'roleMap',
]);

/**
 * Validates a single issue id against the shell-injection-safe pattern
 * (feedback.md A7). Throws with a clear message on rejection.
 * @param {unknown} id
 * @returns {string}
 */
export function validateIssueId(id) {
    if (typeof id !== 'string' || id.length === 0 || !ISSUE_ID_PATTERN.test(id)) {
        throw new Error(`[Arg Contract] Invalid issue id "${id}": must match ${ISSUE_ID_PATTERN} (letters, digits, '.', '_', '-' only).`);
    }
    return id;
}

/**
 * Validates a git branch name (sprint `branch` / `base_branch`) against a
 * shell-injection-safe pattern before it is ever interpolated into a
 * git/gh command() string.
 * @param {unknown} name
 * @param {string} label - human-readable arg name, used in the error message
 * @returns {string}
 */
export function validateBranchName(name, label) {
    if (typeof name !== 'string' || name.length === 0 || !BRANCH_NAME_PATTERN.test(name)) {
        throw new Error(`[Arg Contract] Invalid ${label} "${name}": must match ${BRANCH_NAME_PATTERN} (letters, digits, '.', '_', '-', '/' only).`);
    }
    return name;
}

/**
 * Validates and normalizes the args object passed into main(context).
 * Rejects unknown keys and missing/malformed required keys loudly.
 *
 * @param {any} args
 * @returns {{
 *   targetIssues: string[], members: string[], branch: string,
 *   baseBranch: string, goal: string, maxCycles: number,
 *   requirementsFile: string|undefined, roleMap: object|undefined
 * }}
 */
export function validateArgs(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('[Arg Contract] args must be an object.');
    }

    const unknown = Object.keys(args).filter((k) => !KNOWN_ARG_KEYS.has(k));
    if (unknown.length > 0) {
        throw new Error(`[Arg Contract] Unknown arg(s): ${unknown.join(', ')}. Known args: ${[...KNOWN_ARG_KEYS].join(', ')}.`);
    }

    // --- target issues: target_issues[] (preferred) or legacy single target_issue ---
    let targetIssues;
    if (Array.isArray(args.target_issues)) {
        targetIssues = args.target_issues;
    } else if (typeof args.target_issue === 'string') {
        targetIssues = [args.target_issue];
    } else {
        throw new Error('[Arg Contract] Missing required arg: target_issues (non-empty array) or target_issue (string).');
    }
    if (targetIssues.length === 0) {
        throw new Error('[Arg Contract] target_issues must be a non-empty array.');
    }
    targetIssues.forEach(validateIssueId);

    // --- members ---
    if (!Array.isArray(args.members) || args.members.length === 0) {
        throw new Error('[Arg Contract] Missing required arg: members (non-empty array of member ids/names).');
    }
    args.members.forEach((m) => {
        if (typeof m !== 'string' || m.length === 0) {
            throw new Error(`[Arg Contract] Invalid member entry "${m}": must be a non-empty string.`);
        }
    });

    // --- branch / base_branch (required; also the git/PR target) ---
    if (typeof args.branch !== 'string' || args.branch.length === 0) {
        throw new Error('[Arg Contract] Missing required arg: branch (sprint branch name).');
    }
    validateBranchName(args.branch, 'branch');

    if (typeof args.base_branch !== 'string' || args.base_branch.length === 0) {
        throw new Error('[Arg Contract] Missing required arg: base_branch (branch the sprint branch is created from and the PR targets).');
    }
    validateBranchName(args.base_branch, 'base_branch');

    // --- goal (optional, default 'P1/P2'); threaded through for
    // apra-fleet-unw.17's exit-condition logic to consume later -- this
    // issue only guarantees it reaches the runner and is validated/exposed.
    const goal = args.goal === undefined ? 'P1/P2' : args.goal;
    if (typeof goal !== 'string' || !GOAL_PATTERN.test(goal)) {
        throw new Error(`[Arg Contract] Invalid goal "${goal}": must match ${GOAL_PATTERN} (e.g. 'P1', 'P1/P2', 'P1/P2/P3').`);
    }

    // --- max_cycles (optional, default 5; replaces the old hardcoded constant) ---
    const maxCycles = args.max_cycles === undefined ? 5 : args.max_cycles;
    if (typeof maxCycles !== 'number' || !Number.isInteger(maxCycles) || maxCycles < 1) {
        throw new Error(`[Arg Contract] Invalid max_cycles "${maxCycles}": must be a positive integer.`);
    }

    // --- requirementsFile (optional) ---
    if (args.requirementsFile !== undefined && (typeof args.requirementsFile !== 'string' || args.requirementsFile.length === 0)) {
        throw new Error('[Arg Contract] Invalid requirementsFile: must be a non-empty string path.');
    }

    // --- roleMap (optional; consumed by getMemberForRole/getMembersForRole below) ---
    if (args.roleMap !== undefined && (typeof args.roleMap !== 'object' || args.roleMap === null || Array.isArray(args.roleMap))) {
        throw new Error('[Arg Contract] Invalid roleMap: must be an object mapping role -> member[].');
    }

    return {
        targetIssues,
        members: args.members,
        branch: args.branch,
        baseBranch: args.base_branch,
        goal,
        maxCycles,
        requirementsFile: args.requirementsFile,
        roleMap: args.roleMap,
    };
}

// ---------------------------------------------------------------------------
// Plan phase prompt builder (apra-fleet-unw.15)
// ---------------------------------------------------------------------------
//
// Builds a self-contained planner prompt per the vendored
// vendor/apra-pm/agents/planner.md contract: the planner has no memory of
// this conversation, so every fact it needs (which sprint root issue(s) are
// in scope, the goal priority, the requirements file content, and -- for a
// re-planning cycle -- explicit "gaps only" framing) must be spelled out in
// the prompt text itself rather than assumed.
//
// Model-tier convention: the vendored agents/planner.md Step 3 is the
// authoritative source and states the model tier is set as beads *metadata*
// at creation time via `bd create ... --metadata '{"model": "<tier>"}'` --
// explicitly "the ONLY location the model tier is recorded" and explicitly
// NOT in `--notes`, a METADATA-section comment, or anywhere else. Every
// consumer reads it back from that same metadata field (the `model` key in
// `bd show <id>`): agents/plan-reviewer.md Step 3 reads it from beads
// metadata (`--metadata`), and the orchestrator that dispatches doers does
// likewise. This prompt therefore instructs the planner to use
// `--metadata` and MUST stay aligned with planner.md Step 3.
/**
 * @param {{
 *   isDeltaCycle: boolean,
 *   targetIssues: string[],
 *   goal: string,
 *   requirementsFile: string|undefined,
 *   requirementsContent: string|null,
 *   feedback: string|null,
 * }} opts
 * @returns {string}
 */
function buildPlannerPrompt({ isDeltaCycle, targetIssues, goal, requirementsFile, requirementsContent, feedback }) {
    const lines = [];

    if (isDeltaCycle) {
        lines.push(
            'This is a RE-PLANNING pass: a prior planning pass for this sprint was already ' +
            'approved and at least one develop/review cycle has since run. Per the ' +
            '"Re-planning behaviour" section of your agent contract: address GAPS ONLY. ' +
            'Do NOT re-plan or recreate issues that are already closed. Do NOT add scope ' +
            'beyond the original sprint goals and any open bugs/enhancements already in beads.'
        );
    } else {
        lines.push('Analyze the sprint scope below and build a features+tasks DAG in beads, per your agent contract.');
    }

    lines.push(`Sprint root issue id(s) (--parent scope for this sprint): ${targetIssues.join(', ')}.`);
    lines.push(`Goal priority for this sprint: ${goal}.`);
    lines.push(
        'For every task: set clear acceptance criteria in its description, and set its ' +
        'model tier as beads metadata at creation time via ' +
        '`bd create ... --metadata \'{"model": "<tier>"}\'` (tier is one of ' +
        'cheap-tier, standard-tier, premium-tier) -- this is the ONLY location the model ' +
        'tier is recorded (not --notes, not a METADATA-section comment), per planner.md Step 3.'
    );

    if (requirementsFile && requirementsContent) {
        lines.push(`Requirements file (${requirementsFile}) content, for reference:`);
        lines.push(requirementsContent);
    } else if (requirementsFile && !requirementsContent) {
        lines.push(`Note: a requirementsFile ('${requirementsFile}') was configured for this sprint but could not be read; proceed without it.`);
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
// agents/plan-reviewer.md Inputs section requires exactly one dispatch input:
// "The sprint root / scope to review (required)". Its
// agents/schemas/plan-reviewer-input.json declares `required: ["scope"]`, and
// plan-reviewer.md's missing-input behavior says an unscoped dispatch must
// return verdict CHANGES_NEEDED. The plan-reviewer has no memory of this
// conversation (apra-fleet-unw.3's `resume: false` default), so the sprint
// root issue id(s) and goal priority that define the subtree under review are
// spelled out here rather than assumed. Everything else (the DAG, task
// metadata) the reviewer reads from beads itself in its Step 1.
/**
 * @param {{ targetIssues: string[], goal: string }} opts
 * @returns {string}
 */
function buildPlanReviewerPrompt({ targetIssues, goal }) {
    return [
        'Review the beads DAG created by the planner for this sprint, per your agent contract.',
        `Sprint root / scope to review (the open beads subtree this review pass covers): ` +
        `sprint root issue id(s) ${targetIssues.join(', ')}, goal priority ${goal}. ` +
        'Review only the features and tasks under this scope.',
    ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Develop/Review loop prompt builders + pure helpers (apra-fleet-unw.16)
// ---------------------------------------------------------------------------

/**
 * Builds the self-contained "group ready beads into streaks" prompt.
 * @param {{ readyBeadIds: string[] }} opts
 * @returns {string}
 */
function buildStreakAssignmentPrompt({ readyBeadIds }) {
    return [
        'Group the following ready beads into logical development streaks ' +
        '(beads that must be worked sequentially by the SAME streak; ' +
        'independent beads should be their own streak so they can be worked ' +
        'in parallel by different doers).',
        `Ready bead ids: ${readyBeadIds.join(', ')}`,
        'Every ready bead id listed above must appear in exactly one streak -- ' +
        'no bead id may be omitted, duplicated, or invented.',
    ].join('\n\n');
}

/**
 * Validates a streak-assignment agent() result against the set of currently
 * ready bead objects and returns the resolved streaks (arrays of the
 * original bead objects, not just ids). Falls back to one-bead-per-streak
 * (the previous, always-correct-by-construction behavior) whenever the
 * candidate doesn't cover every ready bead id EXACTLY once -- this is the
 * safety net called for by apra-fleet-unw.16 Work item 2(a): a real LLM
 * result is consumed when valid, but an invalid one can never drop or
 * duplicate a bead's assignment.
 *
 * Pure function: no I/O, no agent() calls -- easy to unit test directly and
 * to reason about independently of the schema-repair loop that produces
 * `candidate`.
 * @param {{streaks: string[][]}|null|undefined} candidate
 * @param {Array<{id: string}>} currentReady
 * @returns {{ streaks: Array<Array<{id: string}>>, usedFallback: boolean, reason: string|null }}
 */
function selectStreaks(candidate, currentReady) {
    const fallback = () => ({
        streaks: currentReady.map((b) => [b]),
        usedFallback: true,
    });

    if (!candidate || !Array.isArray(candidate.streaks)) {
        return { ...fallback(), reason: 'no candidate or candidate.streaks was not an array' };
    }

    const byId = new Map(currentReady.map((b) => [b.id, b]));
    const readyIds = currentReady.map((b) => b.id);
    const seen = new Set();
    const resolvedStreaks = [];

    for (const streakIds of candidate.streaks) {
        if (!Array.isArray(streakIds) || streakIds.length === 0) {
            return { ...fallback(), reason: 'a streak entry was not a non-empty array' };
        }
        const resolvedStreak = [];
        for (const id of streakIds) {
            if (!byId.has(id)) {
                return { ...fallback(), reason: `streak referenced unknown/non-ready bead id '${id}'` };
            }
            if (seen.has(id)) {
                return { ...fallback(), reason: `bead id '${id}' appeared in more than one streak` };
            }
            seen.add(id);
            resolvedStreak.push(byId.get(id));
        }
        resolvedStreaks.push(resolvedStreak);
    }

    if (seen.size !== readyIds.length) {
        return { ...fallback(), reason: `candidate covered ${seen.size} of ${readyIds.length} ready bead id(s)` };
    }

    return { streaks: resolvedStreaks, usedFallback: false, reason: null };
}

/**
 * Builds the self-contained doer dispatch prompt for one streak. Per-bead
 * feedback (apra-fleet-unw.16 Work item 5) is routed here ONLY for the
 * bead(s) this streak actually owns -- never a blanket broadcast of the
 * entire reviewer verdict to every doer -- and is wrapped as untrusted
 * inter-agent content (feedback.md A7, contracts.mjs `wrapUntrustedBlock`).
 * The `branch` is the sprint track branch to work on -- required by the
 * vendored agents/doer.md Inputs section (and agents/schemas/doer-input.json,
 * whose only required key is "branch"). Per doer.md's missing-input behavior,
 * a doer dispatched without a branch must return status "BLOCKED" rather than
 * guessing whatever branch happens to be checked out, so it is always spelled
 * out here.
 * @param {{ beadIds: string[], branch: string, feedback: string|null }} opts
 * @returns {string}
 */
function buildDoerPrompt({ beadIds, branch, feedback }) {
    const lines = [
        `Sprint track branch to work on: ${branch}. Work on this branch only; do not push to the base branch.`,
        `Assigned bead ids (comma-separated): ${beadIds.join(', ')}`,
        'Work each assigned bead per your agent contract: read `bd show <id>` for its ' +
        'full acceptance criteria, implement and verify the change, then `bd close <id>` ' +
        'once it is done. Return your report strictly as the required JSON schema ' +
        '(status, closedIds, notes).',
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

/**
 * Builds the self-contained reviewer dispatch prompt (apra-fleet-unw.16
 * Work item 4). Self-contained per apra-fleet-unw.3's `resume: false`
 * default: the reviewer has no memory of this conversation, so the exact
 * bead ids just worked, their full `bd show` detail (acceptance criteria),
 * and the diff range are all spelled out here rather than assumed.
 *
 * CRITICAL: explicitly, redundantly forbids the reviewer from mutating
 * beads itself (contradicts the vendored agents/reviewer.md Step 5 prose,
 * which tells the reviewer to run `bd update` itself -- see contracts.mjs's
 * DIVERGENCE NOTE above `reviewerVerdict`). Per this issue's instructions,
 * the dispatch-prompt text is what's authoritative/validated today (the
 * schema alone doesn't stop the reviewer from ALSO shelling out `bd`
 * commands on the member side), so the prohibition must be stated here too.
 * @param {{ beadIds: string[], acceptanceCriteriaJson: string, baseBranch: string, branch: string }} opts
 * @returns {string}
 */
function buildReviewerPrompt({ beadIds, acceptanceCriteriaJson, baseBranch, branch }) {
    return [
        `Review the work just done for the following bead id(s): ${beadIds.join(', ')}.`,
        'Full task detail (including acceptance criteria), from `bd show --json`:',
        acceptanceCriteriaJson,
        `Diff range to review: ${baseBranch}..${branch} (base_branch..branch).`,
        'Do NOT run any `bd` command yourself and do NOT mutate beads directly in any way ' +
        '(no bd update, bd close, bd create, etc.) -- the orchestrator applies your ' +
        '`reopenIds` via `bd update <id> --status=open` and creates your `newTasks` via ' +
        '`bd create`. Return ONLY your structured verdict (verdict, notes, reopenIds, ' +
        'newTasks) strictly as the required JSON schema; never touch beads yourself.',
    ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Finalization prompt builders (apra-fleet-unw.17, A6)
// ---------------------------------------------------------------------------

/**
 * Builds the self-contained Final Review prompt (finalVerdict schema). Per
 * the A6 finding, the old prompt was the literal string 'Pass or Fail?' with
 * no context at all -- the reviewer had nothing to actually evaluate, so its
 * answer was necessarily a rubber stamp. This prompt instead embeds the real
 * evidence gathered by the orchestrator over the run: the sprint scope,
 * branch/base-branch (so the reviewer can diff for itself), and the actual
 * bead-count / deploy / integ-test evidence -- so a returned PASS reflects
 * something concrete rather than being unconditionally assumed.
 * @param {{
 *   targetIssues: string[], branch: string, baseBranch: string, goal: string,
 *   cyclesRun: number, closedCount: number, openAtGoalCount: number,
 *   deployFailures: Array<{cycle: number, notes: string}>,
 *   integFailures: Array<{cycle: number, notes: string, bugsFiled: string[]}>,
 * }} opts
 * @returns {string}
 */
function buildFinalVerdictPrompt({ targetIssues, branch, baseBranch, goal, cyclesRun, closedCount, openAtGoalCount, deployFailures, integFailures }) {
    const lines = [
        `Final review for sprint scope issue id(s): ${targetIssues.join(', ')}.`,
        `Branch: ${branch} (base: ${baseBranch}). Goal priority: ${goal}. The sprint ran ${cyclesRun} cycle(s).`,
        `Evidence: ${closedCount} bead(s) closed in scope; ${openAtGoalCount} bead(s) still open at or above goal priority ${goal}.`,
        `Diff range to review if useful: ${baseBranch}..${branch} (base_branch..branch).`,
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
    lines.push(
        'Return a PASS/FAIL verdict per your agent contract, grounded in the evidence above -- ' +
        'never rubber-stamp PASS regardless of open goal-priority beads or deploy/integration failures.'
    );
    return lines.join('\n\n');
}

/**
 * Builds the self-contained Harvester dispatch prompt, per the vendored
 * harvester.md contract's documented inputs (branch/base-branch). This
 * runner does not currently wire real per-run journal/cost-accounting data
 * into the dispatch (that would require threading FleetWorkflow's budget
 * object and journal state through to this prompt, out of scope for this
 * issue) -- rather than fabricate an analysisText/costAnalysis, the prompt
 * explicitly tells the harvester those inputs are unavailable so it marks
 * the steps that depend on them as skipped instead of inventing numbers.
 * @param {{ branch: string, baseBranch: string, targetIssues: string[] }} opts
 * @returns {string}
 */
function buildHarvesterPrompt({ branch, baseBranch, targetIssues }) {
    return [
        `Harvest durable knowledge for sprint scope issue id(s): ${targetIssues.join(', ')}.`,
        `Branch: ${branch} (base: ${baseBranch}).`,
        'Update docs/, README/CHANGELOG (including a cost-analysis block), and defer low-priority issues, per your agent contract.',
        'This run did not wire real per-run journal/cost-accounting data into this dispatch: treat analysisText/costAnalysis ' +
        'inputs as UNAVAILABLE, and explicitly mark any harvester step that depends on them as skipped rather than fabricating figures.',
    ].join('\n\n');
}

// Mechanical migration to the WorkflowEngine's ES-module entry-point contract
// (apra-fleet-unw.7): the engine now calls `main(context)` instead of
// injecting bare globals into an AsyncFunction scope. This destructure is the
// only change to this file's wiring -- every name below (agent, command,
// parallel, log, phase, group, endGroup, publishState, args) is the exact
// same binding the old bare-global version referred to; no control-flow or
// dispatch-order changes.
export async function main(context) {
    const { agent, command, parallel, log, phase, group, endGroup, publishState, args } = context;

    // Validate BEFORE any agent()/command() dispatch (apra-fleet-unw.14,
    // A7 defense in depth): a rejected/malformed arg must result in zero
    // fleet dispatches.
    const validated = validateArgs(args);

    let cycle = 1;
    const MAX_CYCLES = validated.maxCycles;

    const targetIssues = validated.targetIssues;
    const sprintFilter = targetIssues.length > 0 ? `--parent ${targetIssues.join(',')}` : '';

    // Member mapping resolution
    const physicalMembers = validated.members;
    const getMemberForRole = (role) => {
        if (validated.roleMap && validated.roleMap[role] && validated.roleMap[role].length > 0) {
            return validated.roleMap[role][0];
        }
        return physicalMembers[0];
    };

    const getMembersForRole = (role) => {
        if (validated.roleMap && validated.roleMap[role]) {
            return validated.roleMap[role];
        }
        // apra-fleet-unw.16: keys here MUST be the canonical lowercase
        // contracts.ROLES strings (ROLE_DOER/ROLE_REVIEWER, both === the
        // exact 'doer'/'reviewer' values every call site below already
        // passes) -- see the roleConst() comment above for why the old
        // 'Doer'/'Reviewer' capitalized special-case never matched.
        if (role === ROLE_DOER || role === ROLE_REVIEWER) {
            return physicalMembers; // All members act as Doers/Reviewers by default
        }
        return [physicalMembers[0]];
    };

    const orchestratorMember = getMemberForRole('Orchestrator');

    // Read the requirementsFile (if any) once, up front, so its content can
    // be threaded into every Plan-phase planner prompt (apra-fleet-unw.15).
    // A missing/unreadable file is a warning, not a fatal error -- the
    // planner prompt notes the omission and the sprint proceeds without it.
    let requirementsContent = null;
    if (validated.requirementsFile) {
        try {
            requirementsContent = await fs.readFile(validated.requirementsFile, 'utf-8');
        } catch (err) {
            log(`Warning: could not read requirementsFile '${validated.requirementsFile}': ${err.message}`);
            requirementsContent = null;
        }
    }

    // =======================
    // 0. Git Setup: ensure the sprint branch exists off base_branch
    // =======================
    // First fleet dispatch of the run -- runs before any bd/agent activity
    // so the whole sprint develops on `branch`, branched from `base_branch`.
    group('Sprint Setup');
    phase('Ensure Sprint Branch');
    await command(
        `git fetch origin ${validated.baseBranch} --quiet && git checkout -B ${validated.branch} origin/${validated.baseBranch}`,
        {
            member_name: orchestratorMember,
            silent: true,
            label: `Ensure sprint branch '${validated.branch}' from '${validated.baseBranch}'`,
        }
    );
    publishState('sprint-args', {
        branch: validated.branch,
        baseBranch: validated.baseBranch,
        goal: validated.goal,
        maxCycles: validated.maxCycles,
        requirementsFile: validated.requirementsFile || null,
    });
    endGroup();

    // Helper to keep the dashboard UI updated with real bd data
    async function updateDashboard() {
        try {
            const listRes = await command(`bd list ${sprintFilter} --json`, { member_name: orchestratorMember, silent: true });
            const tasks = parseBdJson(listRes, `bd list ${sprintFilter} --json`);
            if (typeof publishState === 'function') {
                publishState('beads', { tasks });
            }
        } catch (e) {
            // ignore
        }
    }

    // Runbook-file probe (apra-fleet-unw.17, A4): a single, platform-
    // agnostic probe -- one `node -e` invocation with plain, non-nested
    // single-quoted JS string literals inside a double-quoted shell
    // argument (no backslash-escaped-quote-inside-quote traps), dispatched
    // via `command(..., { failSoft: true })` so a probe failure (transient
    // error, a member-side portability quirk, etc.) can NEVER throw and
    // kill the sprint -- it just means "skip the dependent phase", logged
    // as a warning. A first-class fileExists fleet API is descoped
    // (server-side change; see docs/plan.md) -- this is the client-side
    // best-effort substitute.
    async function probeFileExists(filename) {
        const res = await command(
            `node -e "console.log(require('fs').existsSync('${filename}') ? 'found' : 'not found')"`,
            { member_name: orchestratorMember, silent: true, label: `Probe for '${filename}'`, failSoft: true }
        );
        if (!res.ok) {
            log(`Probe for '${filename}' failed (treating as not-found, skipping the dependent phase): ${res.error}`);
            return false;
        }
        return res.output.trim() === 'found';
    }

    await updateDashboard();

    const initialList = await command(`bd list ${sprintFilter} --ready --json`, { member_name: orchestratorMember, silent: true });
    const initialBeads = parseBdJson(initialList, `bd list ${sprintFilter} --ready --json`);
    if (initialBeads.length === 0) {
        throw new Error(`Pre-sprint validation failed: No ready beads found for scope '${sprintFilter}'. Ensure beads are in 'open' or 'ready' status.`);
    }

    // =======================
    // A5: goal-priority exit condition + stall-abort bookkeeping
    // =======================
    //
    // `goalMax` is the worst ('Pn' with the highest n) priority tier named
    // in the sprint's `goal` -- the real completion check below is "zero
    // NOT_DONE_STATUSES beads in scope at or above (numerically <=) this
    // priority", NOT "bd list --ready returned []" (see NOT_DONE_STATUSES
    // comment above and the Cycle Evaluation section below).
    const goalMax = goalPriorityMax(validated.goal);

    // Stall detection: per the pm skill mandate cited in the issue text,
    // abort with a typed StalledSprintError after two consecutive cycles
    // that closed zero net NEW beads in scope -- rather than silently
    // burning every remaining cycle up to max_cycles on a sprint that has
    // stopped making forward progress (e.g. a develop/review loop that
    // keeps reopening and re-failing the exact same bead(s)).
    const STALL_CYCLE_LIMIT = 2;
    let staleCycles = 0;
    let lastClosedCount = null;
    const closedCountHistory = [];

    // Deploy/Integration failure evidence (A4), threaded into the Final
    // Review's evidence-based prompt (A6) below -- never silently swallowed.
    const deployFailures = [];
    const integFailures = [];

    // Populated with the last Develop/Review loop's reviewer verdict for
    // each cycle (A5 work item 3: goal-priority completion requires BOTH
    // zero open goal-priority beads AND an APPROVED last reviewer verdict --
    // a cycle where the ready-bead list happened to empty out while the
    // last review round was still CHANGES_NEEDED must not be read as done).
    let lastReviewVerdict = null;

    while (cycle <= MAX_CYCLES) {
        group(`Sprint Cycle ${cycle}`);

        // =======================
        // 1. Planning Loop
        // =======================
        // apra-fleet-unw.15: approval is `verdict === 'APPROVED'` EXACTLY,
        // decided from the plan-reviewer's schema-validated structured
        // output (contracts.mjs `planReviewerVerdict`) -- no substring
        // matching anywhere in this phase, so free text like "This can NOT
        // be APPROVED" can never be misread as an approval. If the
        // plan-reviewer persistently fails to return schema-valid JSON
        // (agent()'s own bounded schema-repair loop, apra-fleet-unw.8,
        // already retried and gave up), that is treated as a failed
        // (CHANGES_NEEDED-equivalent) round rather than an approval.
        //
        // `cycle > 1` means this Plan phase is a RE-PLANNING pass after an
        // earlier Develop/Review cycle needed more work -- distinct from
        // `planningRounds`, which counts rounds *within* one Plan phase's
        // planner<->plan-reviewer approval loop. Only the outer `cycle`
        // controls the delta-vs-full prompt framing.
        const isDeltaCycle = cycle > 1;

        let planApproved = false;
        let planningRounds = 0;
        let plannerFeedback = null;
        let lastVerdict = null;

        while (!planApproved && planningRounds < 3) {
            planningRounds++;
            phase(`Plan C${cycle} R${planningRounds}`);

            const plannerPrompt = buildPlannerPrompt({
                isDeltaCycle,
                targetIssues,
                goal: validated.goal,
                requirementsFile: validated.requirementsFile,
                requirementsContent,
                feedback: plannerFeedback,
            });
            const plannerRes = await agent(
                plannerPrompt,
                { member_name: getMemberForRole('planner'), agentType: 'planner' }
            );
            log(`Planner: ${plannerRes}`);

            let verdict;
            try {
                verdict = await agent(
                    buildPlanReviewerPrompt({ targetIssues, goal: validated.goal }),
                    {
                        member_name: getMemberForRole('plan-reviewer'),
                        agentType: 'plan-reviewer',
                        schema: planReviewerVerdict,
                    }
                );
            } catch (err) {
                if (err instanceof AgentOutputError) {
                    // Persistent non-JSON/non-schema-compliant output FAILS
                    // this plan round -- it must never be treated as an
                    // approval.
                    log(`Plan Reviewer: schema-repair exhausted, treating round as CHANGES_NEEDED: ${err.message}`);
                    verdict = {
                        verdict: 'CHANGES_NEEDED',
                        notes: `Plan reviewer failed to return a schema-valid verdict after repair attempts: ${err.message}`,
                        taskAssignments: [],
                    };
                } else {
                    throw err;
                }
            }
            lastVerdict = verdict;
            log(`Plan Reviewer: ${JSON.stringify(verdict)}`);

            if (verdict.verdict === 'APPROVED') {
                planApproved = true;
            } else {
                plannerFeedback = verdict.notes; // Pass textual feedback to planner, wrapped as untrusted by buildPlannerPrompt
            }
            await updateDashboard();
        }

        if (!planApproved) {
            throw new SprintPlanRejectedError(
                `Plan phase for cycle ${cycle} was not approved after ${planningRounds} round(s). ` +
                'Refusing to proceed to Develop with an unapproved plan.',
                {
                    notes: lastVerdict ? lastVerdict.notes : null,
                    cycle,
                    planningRounds,
                }
            );
        }

        // =======================
        // 2. Execution Prep
        // =======================
        const listRes = await command(`bd list ${sprintFilter} --ready --json`, { member_name: orchestratorMember, silent: true });
        // apra-fleet-unw.19: `bd list --ready --json` does not guarantee a
        // stable ordering. It appears to return beads by `created_at`
        // descending, but `created_at` only has 1-SECOND resolution -- two
        // beads created within the same second (routine for a fast
        // planner/doer pass, and for the deterministic mock fleet used in
        // this package's own tests) tie, and the tie-break order is not
        // reproducible run-to-run. Bead `id` is also not a safe sort key: it
        // carries a random per-scratch-dir suffix. `title` is the only
        // field guaranteed both present and stable, so it is used here as a
        // deterministic tie-break/ordering key (with `id` as a final
        // tie-break for the (rare) case of two identical titles), so this
        // run's dispatch order -- and, further down, which physical doer
        // member each streak round-robins to -- never depends on incidental
        // `bd` output ordering. Root-caused via the new golden-transcript
        // test, which caught this exact class of drift (identical inputs,
        // different streak-assignment prompt text between two runs) that
        // the older agentType-only sequence comparison in
        // test/advanced-mock-runner-test.mjs could not see.
        const readyBeads = parseBdJson(listRes, `bd list ${sprintFilter} --ready --json`)
            .slice().sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

        // A5: an empty `--ready` list is NOT, by itself, evidence the sprint
        // is complete -- it only means there's nothing dispatchable to a
        // doer THIS cycle (e.g. everything is currently blocked or
        // in_progress). The real completion decision happens in the Cycle
        // Evaluation section below, using the goal-priority `--status`
        // check. Here we simply skip the Develop/Review loop for this cycle
        // when there's nothing ready, and still run Deploy/Integration +
        // Cycle Evaluation so a permanently-blocked bead is surfaced by the
        // stall-abort / final-verdict evidence rather than by this loop
        // silently `break`-ing out and being mistaken for success.
        if (readyBeads.length === 0) {
            log('No ready beads to dispatch this cycle (may be blocked/in_progress work remaining) -- skipping Develop/Review loop for this cycle.');
        } else {
        // =======================
        // 3. Develop & Review Loop (apra-fleet-unw.16)
        // =======================
        //
        // Every agent() dispatch below is consumed by the orchestrator --
        // no result is ever logged-and-discarded. Role-casing is fixed at
        // the source (getMembersForRole above), so `doerPool` genuinely
        // contains every configured member when more than one is
        // registered, and each parallel() doer branch below round-robins
        // across the full pool instead of collapsing to member #1.
        let devRounds = 0;

        // beadId -> reviewer feedback text for the NEXT round, populated
        // only for beads actually named in a CHANGES_NEEDED verdict's
        // `reopenIds` (Work item 5: per-bead routing, not a blanket
        // broadcast of the whole reviewer verdict to every doer).
        const perBeadFeedback = new Map();

        const doerPool = getMembersForRole(ROLE_DOER);
        const reviewerPool = getMembersForRole(ROLE_REVIEWER);

        while (devRounds < 3) {
            const currentListRes = await command(`bd list ${sprintFilter} --ready --json`, { member_name: orchestratorMember, silent: true });
            // apra-fleet-unw.19: same non-deterministic-ordering fix as
            // `readyBeads` above -- this is the list that actually feeds the
            // streak-assignment prompt and the doerPool round-robin index
            // below, so an unstable order here was directly observable as
            // prompt drift between two otherwise-identical runs.
            const currentReady = parseBdJson(currentListRes, `bd list ${sprintFilter} --ready --json`)
                .slice().sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

            if (currentReady.length === 0) break;

            devRounds++;
            phase(`Develop C${cycle} R${devRounds}`);

            // --- Streak assignment: consumed for real (Work item 2a) -----
            // Schema-validated {streaks: string[][]}; falls back to
            // deterministic one-bead-per-streak whenever the candidate
            // doesn't cover every ready bead id exactly once (invalid
            // output, or agent()'s own bounded schema-repair loop was
            // exhausted) -- see selectStreaks() above.
            let streakCandidate = null;
            try {
                streakCandidate = await agent(
                    buildStreakAssignmentPrompt({ readyBeadIds: currentReady.map((b) => b.id) }),
                    {
                        member_name: getMemberForRole('planner'),
                        agentType: 'planner',
                        label: 'Streak Assignment',
                        schema: streakAssignment,
                    }
                );
                log(`Streak Assignment: ${JSON.stringify(streakCandidate)}`);
            } catch (err) {
                if (err instanceof AgentOutputError) {
                    log(`Streak Assignment: schema-repair exhausted, falling back to one-bead-per-streak: ${err.message}`);
                } else {
                    throw err;
                }
            }
            const { streaks, usedFallback, reason } = selectStreaks(streakCandidate, currentReady);
            if (usedFallback) {
                log(`Streak Assignment: using one-bead-per-streak fallback (${reason}).`);
            }
            // apra-fleet-unw.19: title lookup for the assignedBeadIds sort
            // below -- streaks/doer dispatches themselves run in `parallel`,
            // and the ORDER their outcomes are recorded in is completion-
            // order (genuinely, correctly non-deterministic -- that's what
            // "parallel" means). But the Review phase's `bd show` evidence
            // command and reviewer prompt below must not inherit that race
            // as prompt drift; see the readyBeads/currentReady sort-by-title
            // comment above for why `title` (not `id`, not arrival order) is
            // the only field that's both present and stable across runs.
            const readyTitleById = new Map(currentReady.map((b) => [b.id, b.title]));

            // --- Doer barrier: isolated failures, one retry, verified closes (Work item 3) ---
            // continueOnError: true so one doer streak's exception can never
            // abort sibling streaks mid-flight (the old parallel() call had
            // no such option and one throw killed the whole cycle).
            const streakOutcomes = [];
            await parallel(streaks, async (streak, index) => {
                const beadIds = streak.map((b) => b.id);
                const doerMember = doerPool[index % doerPool.length];
                const feedbackForStreak = beadIds
                    .map((id) => perBeadFeedback.get(id))
                    .filter(Boolean)
                    .join('\n\n');

                const dispatchDoer = () => agent(
                    buildDoerPrompt({ beadIds, branch: validated.branch, feedback: feedbackForStreak || null }),
                    {
                        member_name: doerMember,
                        agentType: 'doer',
                        label: `Streak [${beadIds.join(', ')}]`,
                        schema: doerReport,
                    }
                );

                let report = null;
                let wasRetried = false;
                let dispatchError = null;
                try {
                    report = await dispatchDoer();
                } catch (err) {
                    log(`Doer streak [${beadIds.join(', ')}] on member '${doerMember}' threw: ${err.message}. Retrying once.`);
                    wasRetried = true;
                    try {
                        report = await dispatchDoer();
                    } catch (err2) {
                        dispatchError = err2;
                    }
                }

                if (dispatchError) {
                    streakOutcomes.push({
                        beadIds, doerMember, outcome: 'failed', wasRetried,
                        report: null, unclosedIds: beadIds, error: dispatchError.message,
                    });
                    // Rethrow so parallel()'s continueOnError:true isolates
                    // this failure from sibling streaks (the outcome above
                    // is already recorded via closure, so no information is
                    // lost when parallel() substitutes `null` for this branch).
                    throw dispatchError;
                }

                log(`Doer [${beadIds.join(', ')}] on [${doerMember}]: ${JSON.stringify(report)}`);

                // CRITICAL (Work item 3): never trust the doer's own
                // success claim -- verify via `bd show` that the assigned
                // bead ids are actually closed. A doer that returns
                // success-looking text/report but leaves a bead open is
                // treated as a FAILED streak regardless of what it said.
                const showRes = await command(`bd show ${beadIds.join(' ')} --json`, { member_name: orchestratorMember, silent: true });
                const showBeads = parseBdJson(showRes, `bd show ${beadIds.join(' ')} --json`);
                const statusById = new Map(showBeads.map((b) => [b.id, b.status]));
                const unclosedIds = beadIds.filter((id) => statusById.get(id) !== 'closed');

                if (unclosedIds.length > 0) {
                    log(`Doer streak [${beadIds.join(', ')}] reported status '${report ? report.status : 'unknown'}' but bead(s) still open: ${unclosedIds.join(', ')} -- treating streak as FAILED.`);
                }

                streakOutcomes.push({
                    beadIds, doerMember, wasRetried, report, unclosedIds,
                    outcome: unclosedIds.length > 0 ? 'failed' : (wasRetried ? 'retried' : 'success'),
                });
                await updateDashboard();
            }, { continueOnError: true });

            log(`Develop C${cycle} R${devRounds} streak outcomes: ${JSON.stringify(streakOutcomes.map((o) => ({ beadIds: o.beadIds, outcome: o.outcome })))}`);

            // --- Review (Work item 4): self-contained, schema-validated, orchestrator-applied ---
            phase(`Review C${cycle} R${devRounds}`);
            // apra-fleet-unw.19: sort by (title, id) -- not raw completion
            // order -- so this evidence-gathering step is deterministic even
            // though the doer streaks it aggregates ran concurrently. See
            // the readyTitleById comment just above.
            const assignedBeadIds = streakOutcomes.flatMap((o) => o.beadIds)
                .slice().sort((a, b) => {
                    const ta = readyTitleById.get(a) || a;
                    const tb = readyTitleById.get(b) || b;
                    return ta.localeCompare(tb) || a.localeCompare(b);
                });
            const acceptanceCriteriaJson = assignedBeadIds.length > 0
                ? await command(`bd show ${assignedBeadIds.join(' ')} --json`, { member_name: orchestratorMember, silent: true })
                : '[]';

            let verdict;
            try {
                verdict = await agent(
                    buildReviewerPrompt({
                        beadIds: assignedBeadIds,
                        acceptanceCriteriaJson,
                        baseBranch: validated.baseBranch,
                        branch: validated.branch,
                    }),
                    {
                        member_name: reviewerPool[0],
                        agentType: 'reviewer',
                        schema: reviewerVerdict,
                    }
                );
            } catch (err) {
                if (err instanceof AgentOutputError) {
                    log(`Reviewer: schema-repair exhausted, treating round as CHANGES_NEEDED: ${err.message}`);
                    verdict = {
                        verdict: 'CHANGES_NEEDED',
                        notes: `Reviewer failed to return a schema-valid verdict after repair attempts: ${err.message}`,
                        reopenIds: [],
                        newTasks: [],
                    };
                } else {
                    throw err;
                }
            }
            log(`Reviewer: ${JSON.stringify(verdict)}`);
            // A5: the last reviewer verdict seen THIS cycle feeds the Cycle
            // Evaluation section's completion check below -- goal-priority
            // completion requires this to be exactly 'APPROVED', not just
            // an empty ready-bead list.
            lastReviewVerdict = verdict.verdict;

            // Orchestrator (this code) -- NOT the LLM -- applies every
            // structured transition: reopenIds via `bd update --status=open`,
            // newTasks via `bd create`. The reviewer's dispatch prompt above
            // explicitly forbade it from mutating beads itself; this is the
            // enforcement side of that contract (V1 resolution, SKILL.md).
            for (const id of verdict.reopenIds) {
                await command(
                    `bd update ${id} --status=open`,
                    { member_name: orchestratorMember, silent: true, label: `Reopen ${id} per reviewer verdict` }
                );
                // Per-bead feedback routing (Work item 5): only beads named
                // in reopenIds carry this round's feedback into the next
                // round's doer prompt -- never a blanket broadcast.
                perBeadFeedback.set(id, verdict.notes);
            }
            for (const newTask of verdict.newTasks) {
                const title = String(newTask.title).replace(/"/g, '\\"');
                const description = String(newTask.description).replace(/"/g, '\\"');
                const priority = String(newTask.priority).replace(/"/g, '\\"');
                await command(
                    `bd create "${title}" -d "${description}" -p "${priority}" --parent ${targetIssues.join(',')} --silent`,
                    { member_name: orchestratorMember, silent: true, label: `Create follow-up task from reviewer newTasks: ${newTask.title}` }
                );
            }

            await updateDashboard();

            const checkRes = await command(`bd list ${sprintFilter} --ready --json`, { member_name: orchestratorMember, silent: true });
            const stillOpen = parseBdJson(checkRes, `bd list ${sprintFilter} --ready --json`);

            if (stillOpen.length === 0) {
                break;
            } else {
                log(`System found ${stillOpen.length} beads still open/ready. Looping back to develop.`);
            }
        }
        } // end Develop & Review loop (skipped when readyBeads.length === 0)

        // =======================
        // 4. Deploy & Integration (A4: real dispatch, honest propagation)
        // =======================
        //
        // Runbook probes (feedback.md A4): a single platform-agnostic probe
        // helper, dispatched via `command(..., { failSoft: true })`. A probe
        // failure (transient error, portability quirk on a given member,
        // etc.) SKIPS the dependent phase with a logged warning -- it must
        // never throw and kill the sprint (that was the old behavior: a
        // transient probe hiccup took down the whole run). A first-class
        // fileExists fleet API is descoped (server-side; see docs/plan.md).
        const hasDeploy = await probeFileExists('deploy.md');
        const hasPlaybook = await probeFileExists('integ-test-playbook.md');

        let deployedThisCycle = hasDeploy ? null : false; // null = not attempted yet

        if (hasDeploy) {
            phase(`Deploy C${cycle}`);
            let deployResult;
            try {
                deployResult = await agent(
                    'Deploy to test env using deploy.md.',
                    { member_name: getMemberForRole('deployer'), agentType: 'deployer', schema: deployerReport }
                );
            } catch (err) {
                if (err instanceof AgentOutputError) {
                    log(`Deployer: schema-repair exhausted, treating as deployed:false: ${err.message}`);
                    deployResult = { deployed: false, notes: `Deployer failed to return a schema-valid report after repair attempts: ${err.message}` };
                } else {
                    throw err;
                }
            }
            log(`Deployer: ${JSON.stringify(deployResult)}`);
            deployedThisCycle = deployResult.deployed === true;
            if (!deployedThisCycle) {
                deployFailures.push({ cycle, notes: deployResult.notes });
                log(`Deploy FAILED this cycle (C${cycle}): ${deployResult.notes}. Skipping Integration Test phase.`);
            }
        } else {
            log('Skipping Deploy Phase (no deploy.md found, or the probe itself failed -- see prior log line)');
        }

        if (hasPlaybook && deployedThisCycle) {
            phase(`Integ Test C${cycle}`);
            let integResult;
            try {
                integResult = await agent(
                    'Run tests using integ-test-playbook.md. Add bug beads if needed.',
                    { member_name: getMemberForRole('integ-test-runner'), agentType: 'integ-test-runner', schema: integReport }
                );
            } catch (err) {
                if (err instanceof AgentOutputError) {
                    log(`Integ Test Runner: schema-repair exhausted, treating as passed:false: ${err.message}`);
                    integResult = { featuresClosed: 0, issuesCreated: 0, passed: false, bugsFiled: [], summary: `Integ test runner failed to return a schema-valid report after repair attempts: ${err.message}` };
                } else {
                    throw err;
                }
            }
            log(`Integ Test Runner: ${JSON.stringify(integResult)}`);
            // A4: never swallow a failure just because the agent chose to
            // (or didn't) file bugs -- `passed` is the honest source of
            // truth, checked explicitly and propagated below regardless of
            // `bugsFiled.length`.
            if (integResult.passed !== true) {
                integFailures.push({ cycle, notes: integResult.summary, bugsFiled: integResult.bugsFiled });
                log(`Integration tests FAILED this cycle (C${cycle}, bugsFiled: ${integResult.bugsFiled.join(', ') || 'none'}): ${integResult.summary}`);
            }
            await updateDashboard();
        } else if (hasPlaybook && !deployedThisCycle) {
            log('Skipping Integration Test Phase (deploy did not succeed this cycle, or no deploy.md was present to attempt)');
        } else {
            log('Skipping Integration Test Phase (no playbook found, or the probe itself failed -- see prior log line)');
        }

        // =======================
        // 5. Cycle Evaluation (A5: goal-priority exit + stall-abort)
        // =======================
        //
        // Real completion is "zero NOT_DONE_STATUSES beads in scope at or
        // above the goal priority AND the last reviewer verdict this cycle
        // was APPROVED" -- deliberately NOT `bd list --ready == []`, which
        // reads a permanently-blocked or orphaned in_progress bead as
        // success (A5 bug). See goalPriorityMax()/NOT_DONE_STATUSES above.
        const openAtGoalRes = await command(
            `bd list ${sprintFilter} --status=${NOT_DONE_STATUSES} --priority-max=${goalMax} --json`,
            { member_name: orchestratorMember, silent: true, label: `Goal-priority open-bead check (<=${goalMax})` }
        );
        const openAtGoal = parseBdJson(openAtGoalRes, `bd list ${sprintFilter} --status=${NOT_DONE_STATUSES} --priority-max=${goalMax} --json`);

        // Stall detection: track the closed-bead count for the WHOLE sprint
        // scope (not just goal-priority) so zero forward progress on ANY
        // bead -- not only goal-priority ones -- is caught, per the issue
        // text ("N consecutive iterations making no forward progress on any
        // bead").
        const closedRes = await command(
            `bd list ${sprintFilter} --status=closed --json`,
            { member_name: orchestratorMember, silent: true, label: 'Closed-bead count for stall detection' }
        );
        const closedCount = parseBdJson(closedRes, `bd list ${sprintFilter} --status=closed --json`).length;
        closedCountHistory.push(closedCount);
        if (lastClosedCount !== null && closedCount === lastClosedCount) {
            staleCycles++;
        } else {
            staleCycles = 0;
        }
        lastClosedCount = closedCount;

        if (staleCycles >= STALL_CYCLE_LIMIT) {
            throw new StalledSprintError(
                `Sprint stalled: ${staleCycles} consecutive cycle(s) closed zero net new bead(s) in scope '${sprintFilter}'. ` +
                `Closed-count history: [${closedCountHistory.join(', ')}]. Aborting rather than burning the remaining cycles.`,
                { staleCycles, closedCountHistory, cycle }
            );
        }

        if (openAtGoal.length === 0 && lastReviewVerdict === 'APPROVED') {
            log(`Goal priority ${validated.goal} (<=${goalMax}) satisfied: 0 open bead(s) in scope and last reviewer verdict was APPROVED. Exiting cycle loop.`);
            endGroup();
            break;
        }

        log(`Cycle ${cycle} evaluation: ${openAtGoal.length} bead(s) still open at/above goal priority ${goalMax}, last reviewer verdict: ${lastReviewVerdict ?? '(none this cycle)'}. Continuing.`);

        cycle++;
        endGroup();
    }

    // A5: fix the cycle-label off-by-one -- when the loop exits because
    // `cycle` exceeded MAX_CYCLES (rather than via an early `break`),
    // `cycle` is MAX_CYCLES + 1 at this point; the labels below should
    // report the last cycle actually run.
    const finalCycleLabel = Math.min(cycle, MAX_CYCLES);

    // =======================
    // 6. Finalization (A6: evidence-based final verdict drives the return value)
    // =======================
    group('Finalization');
    phase(`Final Review C${finalCycleLabel}`);

    const finalOpenAtGoalRes = await command(
        `bd list ${sprintFilter} --status=${NOT_DONE_STATUSES} --priority-max=${goalMax} --json`,
        { member_name: orchestratorMember, silent: true, label: `Final goal-priority open-bead check (<=${goalMax})` }
    );
    const finalOpenAtGoal = parseBdJson(finalOpenAtGoalRes, `bd list ${sprintFilter} --status=${NOT_DONE_STATUSES} --priority-max=${goalMax} --json`);
    const finalClosedRes = await command(
        `bd list ${sprintFilter} --status=closed --json`,
        { member_name: orchestratorMember, silent: true, label: 'Final closed-bead count' }
    );
    const finalClosedCount = parseBdJson(finalClosedRes, `bd list ${sprintFilter} --status=closed --json`).length;

    let finalVerdictResult;
    try {
        finalVerdictResult = await agent(
            buildFinalVerdictPrompt({
                targetIssues,
                branch: validated.branch,
                baseBranch: validated.baseBranch,
                goal: validated.goal,
                cyclesRun: finalCycleLabel,
                closedCount: finalClosedCount,
                openAtGoalCount: finalOpenAtGoal.length,
                deployFailures,
                integFailures,
            }),
            { member_name: getMemberForRole('reviewer'), agentType: 'reviewer', schema: finalVerdict, label: 'Final Review' }
        );
    } catch (err) {
        if (err instanceof AgentOutputError) {
            log(`Final Review: schema-repair exhausted, treating as FAIL: ${err.message}`);
            finalVerdictResult = { verdict: 'FAIL', notes: `Final reviewer failed to return a schema-valid verdict after repair attempts: ${err.message}` };
        } else {
            throw err;
        }
    }
    log(`Final Verdict: ${JSON.stringify(finalVerdictResult)}`);

    phase(`Harvest C${finalCycleLabel}`);
    const harvesterPrompt = buildHarvesterPrompt({ branch: validated.branch, baseBranch: validated.baseBranch, targetIssues });
    let harvesterResult = null;
    try {
        harvesterResult = await agent(
            harvesterPrompt,
            { member_name: getMemberForRole('harvester'), agentType: 'harvester', schema: harvesterReport }
        );
        log(`Harvester: ${JSON.stringify(harvesterResult)}`);
        if (harvesterResult.status !== 'OK') {
            log(`Harvester reported FAILED: ${harvesterResult.notes}`);
        }
    } catch (err) {
        if (err instanceof AgentOutputError) {
            log(`Harvester: schema-repair exhausted, proceeding without a validated harvester report: ${err.message}`);
        } else {
            throw err;
        }
    }

    // =======================
    // 7. Publish: push the sprint branch and raise (but do NOT merge) a PR
    // =======================
    // Per the pm skill's R12 rule (never auto-merge), this only pushes and
    // opens the PR -- a human (or a later, explicitly-scoped issue) must
    // review and merge it.
    phase(`Publish PR C${finalCycleLabel}`);
    await command(
        `git push -u origin ${validated.branch}`,
        {
            member_name: orchestratorMember,
            silent: true,
            label: `Push sprint branch '${validated.branch}'`,
        }
    );
    const prTitle = `Auto-sprint: ${validated.branch}`;
    const prBody = `Automated apra-fleet-se sprint (goal: ${validated.goal}). Do NOT auto-merge -- see pm skill R12; a human must review and merge this PR.`;
    await command(
        `gh pr create --base "${validated.baseBranch}" --head "${validated.branch}" --title "${prTitle}" --body "${prBody}"`,
        {
            member_name: orchestratorMember,
            silent: true,
            label: `Raise PR to '${validated.baseBranch}' (not merged)`,
        }
    );

    endGroup();

    // A6: the final verdict -- not a blanket, unconditional 'success' --
    // drives the return value. A downstream caller (CLI, CI, a human
    // reading the run) can now tell a genuinely-passing sprint from one
    // that ran to completion but left goal-priority work open, a deploy
    // failing, or integration tests red.
    return {
        status: finalVerdictResult.verdict === 'PASS' ? 'success' : 'failed',
        verdict: finalVerdictResult.verdict,
        notes: finalVerdictResult.notes,
        branch: validated.branch,
        baseBranch: validated.baseBranch,
        goal: validated.goal,
        maxCycles: validated.maxCycles,
    };
}
