// CLI -> runner argument contract for fleet-sprint: the shell-injection-safe
// id/branch validators and the validated shape of `args`
// (apra-fleet-3swo.3.3). Moved verbatim out of runner.js -- runner.js
// re-exports every symbol this region previously exported, so existing
// importers of fleet-sprint/runner.js (including bin/cli.mjs) resolve
// unchanged. This is a move-only extraction: behaviour, validation order and
// error message text are all deliberately unchanged from the pre-move code.
import { normalizeRole, validateCredentialStoreName } from './contracts.mjs';

// ---------------------------------------------------------------------------
// CLI -> runner argument contract
// ---------------------------------------------------------------------------
//
// The canonical, validated shape of `args` (the `context.args` object
// WorkflowEngine.executeFile()/runWithContext() hands to main()). bin/cli.mjs
// must produce args matching this contract; unknown keys and missing required
// keys are both rejected loudly here so CLI/runner drift (a flag added on one
// side and forgotten on the other) fails fast instead of silently no-oping.
//
// Defense in depth: `target_issues`/`target_issue`, `branch`, and
// `base_branch` are validated against deliberately restrictive
// shell-injection-safe patterns here as well as in bin/cli.mjs (which imports
// validateIssueId/validateBranchName from this module -- single source of
// truth), so a malicious id or branch name can never reach a command()
// interpolation even if the CLI layer is bypassed. Validation runs before ANY
// agent()/command() dispatch, so a rejected arg produces zero fleet
// dispatches.

const ISSUE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;
const GOAL_PATTERN = /^P[1-3](\/P[1-3]){0,2}$/;

const KNOWN_ARG_KEYS = new Set([
    'target_issues', 'target_issue', 'members', 'branch', 'base_branch',
    'goal', 'max_cycles', 'requirementsFile', 'roleMap', 'budget',
    // Per-dispatch time budget (timeout_s == max_total_s at every dispatch
    // site; integ ceiling = 2x), bounding the cost of a hung dispatch.
    'dispatch_timeout_s',
    // The always-on supervisor's base HTTP URL (e.g. http://127.0.0.1:8787).
    // Set by bin/cli.mjs from the FLEET_SE_SERVICE_URL env var the supervisor's
    // spawner injects into each detached child; absent for supervisor-less
    // (single-process/dev/test) runs. When present it enables the cross-sprint
    // coordination layers: the global dolt push mutex, the child-id allocator,
    // and per-bead work-claiming. All three are no-ops without it -- a lone
    // sprint has no sibling to coordinate with.
    'serviceUrl',
    // apra-fleet-5co8.37: this launch's incarnation-unique run identity -- the
    // SAME string the supervisor's reservation ledger keys this sprint by
    // (bin/cli.mjs forwards the supervisor's --run-id, falling back to the
    // branch name for a direct/standalone launch, which is also what cli.mjs
    // reserves members under). Threaded to the deployer so its active-sprints
    // gate can tell this sprint's OWN reservation from a foreign one.
    'run_id',
    // The assignee identity this sprint claims beads as and filters ready work
    // by (`bd update --claim` / `bd ready --assignee`). Nothing sets this
    // today; the claiming layer stays dormant and bead selection uses the
    // unassigned `bd list --ready`.
    'assignee',
    // Multi-streak worklist dispatch mode when a develop round has more ready
    // streaks than doers. 'resume' (default): per-streak dispatches that resume
    // the SAME doer session by explicit session id (warm-context carryover,
    // every engine checkpoint kept between streaks). 'batch' (config-gated,
    // overhead-dominated scenarios): one dispatch carries a doer's whole
    // ordered worklist, which REQUIRES a tier-homogeneous worklist.
    // No CLI flag sets this today; only test/programmatic callers pass it.
    'doer_worklist_mode',
    // Capability opt-in: the doer pool's provider supports changing model on a
    // RESUMED session. Only then may a resumed-sequence worklist carry mixed
    // tiers, each streak dispatching at its own tier; default false falls back
    // to tier-homogeneous grouping. See resolveWorklistTierPolicy() for the
    // capability-check seam.
    // No CLI flag sets this today; only test/programmatic callers pass it.
    'resume_model_switch',
    // Per-doer effort-point budget for worklist packing (planner.md effort
    // formula units). Default DEFAULT_EFFORT_THRESHOLD.
    // No CLI flag sets this today; only test/programmatic callers pass it.
    'worklist_effort_budget',
    // An optional live `(name, args) => Promise<any>` MCP tool-call function,
    // wired by bin/cli.mjs from its already-connected `mcpClient.callTool`.
    // Consumed by createMemberSessionGuard() to call the fleet's own
    // `stop_prompt` tool before a resume re-dispatch. This is a live function
    // reference, not a JSON-serializable value -- safe only because
    // WorkflowEngine.executeFile() runs runner.js in-process (dynamic
    // `import()`, never across a subprocess boundary). Absent for direct
    // runSprintCycle()/main() test calls, where the guard is a no-op.
    'callTool',
    // Per-sprint override for the Azure DevOps PAT secret name. When provided, this
    // credential store entry name is used instead of the documented default
    // (azdevops_pat). No CLI flag sets this today; only test/programmatic callers
    // pass it.
    'azdevops_pat_secret_name',
]);

/**
 * Validates a single issue id against the shell-injection-safe pattern.
 * Throws with a clear message on rejection.
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
 *   requirementsFile: string|undefined, roleMap: object|undefined,
 *   budget: number|undefined
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

    // --- goal (optional, default 'P1/P2'; the priority band this sprint aims
    // to clear, consumed by the exit-condition logic) ---
    const goal = args.goal === undefined ? 'P1/P2' : args.goal;
    if (typeof goal !== 'string' || !GOAL_PATTERN.test(goal)) {
        throw new Error(`[Arg Contract] Invalid goal "${goal}": must match ${GOAL_PATTERN} (e.g. 'P1', 'P1/P2', 'P1/P2/P3').`);
    }

    // --- max_cycles (optional, default 5) ---
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
    // This is the SINGLE normalization point for roleMap keys: every key is
    // put through normalizeRole() (trim + lowercase) here, so any casing or
    // whitespace variant resolves to its canonical form and downstream readers
    // (getMemberForRole/getMembersForRole) may assume normalized keys and must
    // never re-read `args.roleMap` directly. Two differently-cased input keys
    // that normalize to the same key are rejected loudly (ambiguous authorial
    // intent) rather than one silently clobbering the other.
    let normalizedRoleMap;
    if (args.roleMap !== undefined) {
        normalizedRoleMap = {};
        for (const [rawKey, value] of Object.entries(args.roleMap)) {
            const key = normalizeRole(rawKey);
            if (Object.prototype.hasOwnProperty.call(normalizedRoleMap, key)) {
                throw new Error(
                    `[Arg Contract] Invalid roleMap: key "${rawKey}" normalizes to "${key}", which collides with ` +
                    `another key already present in roleMap. Use a single casing/whitespace variant per role.`
                );
            }
            normalizedRoleMap[key] = value;
        }
    }

    // --- budget (optional) -----------------------------------------------
    // A USD ceiling for this run's total estimated spend. When provided,
    // main() sets `context.budget.total` to this value BEFORE any dispatch, so
    // `agent()`'s budget-exceeded check can actually fire. Omitted,
    // `context.budget.total` stays `null` (unlimited).
    if (args.budget !== undefined && (typeof args.budget !== 'number' || !Number.isFinite(args.budget) || args.budget < 0)) {
        throw new Error(`[Arg Contract] Invalid budget "${args.budget}": must be a non-negative finite number (USD ceiling).`);
    }

    // --- run_id (optional) -------------------------------------------------
    // Free-form supervisor-generated identity; only its shape is checked here.
    if (args.run_id !== undefined && (typeof args.run_id !== 'string' || args.run_id.length === 0)) {
        throw new Error('[Arg Contract] Invalid run_id: must be a non-empty string.');
    }

    // --- serviceUrl (optional) --------------------------------------------
    // The always-on supervisor's base HTTP URL. Validated as an http(s) URL so
    // a malformed value fails fast rather than silently disabling the
    // cross-sprint coordination layers or, worse, being interpolated somewhere
    // unsafe. Omitted (single-process/dev/test): the coordination layers stay
    // dormant (a lone sprint has no sibling to serialize against).
    if (args.serviceUrl !== undefined) {
        if (typeof args.serviceUrl !== 'string' || args.serviceUrl.length === 0) {
            throw new Error('[Arg Contract] Invalid serviceUrl: must be a non-empty http(s) URL string.');
        }
        let parsed;
        try {
            parsed = new URL(args.serviceUrl);
        } catch {
            throw new Error(`[Arg Contract] Invalid serviceUrl "${args.serviceUrl}": must be a valid http(s) URL.`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(`[Arg Contract] Invalid serviceUrl "${args.serviceUrl}": must use the http: or https: scheme.`);
        }
    }

    // --- assignee (optional) ----------------------------------------------
    // The work-claiming identity. Constrained to a shell-injection-safe pattern
    // because it is interpolated into `bd update --claim` / `bd ready
    // --assignee` command strings, matching the same defense-in-depth posture
    // as issue ids and branch names above.
    if (args.assignee !== undefined) {
        if (typeof args.assignee !== 'string' || args.assignee.length === 0 || !ISSUE_ID_PATTERN.test(args.assignee)) {
            throw new Error(`[Arg Contract] Invalid assignee "${args.assignee}": must match ${ISSUE_ID_PATTERN} (letters, digits, '.', '_', '-' only).`);
        }
    }

    // --- dispatch_timeout_s (optional, default 9000 = 150min/2.5h) ---------
    // Per-dispatch time budget in seconds, applied as BOTH timeout_s and
    // max_total_s on every agent dispatch: `claude -p` emits nothing until the
    // turn completes, so inactivity equals total runtime and the two timers
    // must be equal for the ceiling to be reachable. The integ-test dispatch
    // ceiling is 2x this value and the regression-test ceiling is 3x, since
    // those suites legitimately run past one budget. Raised from the earlier
    // 3600s default: an hour was tight enough to misclassify a slow-but-alive
    // turn (a large diff, a chatty tool loop) as a stall, which is a false
    // positive, not the genuine-hang protection this timer exists for.
    // Lowering it still bounds the cost of a live-but-silent member hang,
    // which no timer can otherwise distinguish from work. Floor 60: below
    // that even healthy dispatches cannot complete a single turn.
    const dispatchTimeoutS = args.dispatch_timeout_s === undefined ? 9000 : args.dispatch_timeout_s;
    if (typeof dispatchTimeoutS !== 'number' || !Number.isInteger(dispatchTimeoutS) || dispatchTimeoutS < 60) {
        throw new Error(`[Arg Contract] Invalid dispatch_timeout_s "${dispatchTimeoutS}": must be an integer >= 60 (seconds).`);
    }

    // --- doer_worklist_mode (optional, default 'resume') -------------------
    // 'resume' walks a doer's worklist as a resumed sequence of dispatches;
    // 'batch' hands the whole ordered worklist over in a single dispatch.
    const doerWorklistMode = args.doer_worklist_mode === undefined ? 'resume' : args.doer_worklist_mode;
    if (doerWorklistMode !== 'resume' && doerWorklistMode !== 'batch') {
        throw new Error(`[Arg Contract] Invalid doer_worklist_mode "${doerWorklistMode}": must be 'resume' (default) or 'batch'.`);
    }

    // --- resume_model_switch (optional, default false) ---------------------
    const resumeModelSwitch = args.resume_model_switch === undefined ? false : args.resume_model_switch;
    if (typeof resumeModelSwitch !== 'boolean') {
        throw new Error(`[Arg Contract] Invalid resume_model_switch "${resumeModelSwitch}": must be a boolean.`);
    }

    // --- worklist_effort_budget (optional) ---------------------------------
    if (args.worklist_effort_budget !== undefined
        && (typeof args.worklist_effort_budget !== 'number'
            || !Number.isFinite(args.worklist_effort_budget)
            || args.worklist_effort_budget <= 0)) {
        throw new Error(`[Arg Contract] Invalid worklist_effort_budget "${args.worklist_effort_budget}": must be a positive finite number (effort points).`);
    }

    // --- azdevops_pat_secret_name (optional) --------------------------------
    // Override for the default Azure DevOps PAT secret name. When provided, this
    // credential store entry name is used instead of the documented default
    // (azdevops_pat). Validated as a credential-store name at contract-validation
    // time, not mid-sprint, so invalid values fail fast and clearly.
    if (args.azdevops_pat_secret_name !== undefined) {
        validateCredentialStoreName(args.azdevops_pat_secret_name, 'azdevops_pat_secret_name');
    }

    return {
        targetIssues,
        members: args.members,
        branch: args.branch,
        baseBranch: args.base_branch,
        goal,
        maxCycles,
        requirementsFile: args.requirementsFile,
        roleMap: normalizedRoleMap,
        budget: args.budget,
        serviceUrl: args.serviceUrl,
        runId: args.run_id,
        assignee: args.assignee,
        dispatchTimeoutS,
        azdevopsPatSecretName: args.azdevops_pat_secret_name,
        doerWorklistMode,
        resumeModelSwitch,
        worklistEffortBudget: args.worklist_effort_budget,
    };
}
