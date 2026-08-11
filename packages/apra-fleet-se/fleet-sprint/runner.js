import fs from 'fs/promises';
import { createHash } from 'crypto';
import { AgentOutputError, AgentDispatchError, FleetTransportError, CommandError, WorkflowError, BudgetExceededError, CancelledError } from '@apralabs/apra-fleet-workflow';
import {
    ROLES, normalizeRole, planReviewerVerdict, doerReport, reviewerVerdict, streakAssignment,
    deployerReport, integReport, regressionReport, finalVerdict, harvesterReport, wrapUntrustedBlock,
} from './contracts.mjs';
import { SprintPlanRejectedError, StalledSprintError, ReviewerContractViolationError, GitDivergedError, GitSyncError, DoltDivergedError, DoltSyncError, PostDispatchSyncError, PlanReviewDispatchFailedError, isNonRetryableDispatchError, isAuthDispatchError, isInfraDispatchFailure, isPostDispatchSyncFailure } from './errors.mjs';
// The ONLY dolt command surface in fleet-sprint (apra-fleet-417.2.1). Every
// runner.js call site uses the purpose-based entry points on DoltSync
// (apra-fleet-417.2.2); the named primitives are imported here only to be
// re-exported below for the existing unit suites that drive them directly.
import { DoltSync, doltPullBefore, doltPushAfter, preflightBeadsHealthGate } from './dolt-sync.mjs';

// Backoff for retrying ONLY the post-dispatch sync step of a bracket whose
// dispatch already completed. Short and bounded: this is a git/dolt push round
// trip, not an LLM turn, and letting the failure escape the bracket would
// redispatch the whole turn.
const POST_DISPATCH_SYNC_RETRY_DELAYS_MS = [0, 5000, 15000];

/** True when the hermetic mock harness has opted into zero-wait backoffs
 *  (APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF=1, set by mock-sprint-harness.mjs).
 *  Production behavior -- real timed sleeps -- is unaffected. */
const mockInstantRetryBackoff = () => process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF === '1';
import { ApraFleet } from '@apralabs/apra-fleet-client';
import { parseUnmergedPaths, detectAndAbortRebaseConflict, dispatchConflictResolutionAgent } from './conflict-ladder.mjs';
// The deterministic dolt conflict settlement callback (docs/dolt-sync-
// redesign.md). It REPLACES the retired Path A -> Path B -> Tier 2 ladder at
// BOTH divergence terminals: the post-dispatch D-push bracket
// (syncMemberAfterOrdered) and the pre-dispatch D-pull / readiness gate, so a
// wedged beads clone self-heals instead of surfacing BEADS_SYNC_CONFLICT or
// hard-aborting the run at its readiness gate.
import { buildSettleCallback } from './dolt-settle.mjs';
import { acquireSprintLock } from './sprint-lock.mjs';
import { buildCreatePrCommand, resolveProvider, capabilities as vcsCapabilities, classifyFailure, toGitVerdict } from './vcs-module.mjs';

// Re-exported so importers of parseUnmergedPaths from runner.js keep working;
// conflict-ladder.mjs is the single source of truth for its implementation.
export { parseUnmergedPaths };

// ---------------------------------------------------------------------------
// Canonical role-name constants for the Develop/Review loop
// ---------------------------------------------------------------------------
//
// Role names must come from `contracts.ROLES` (the single canonical, lowercase
// role enum) rather than string literals: roleConst() throws at module-load
// time if a name is not a member of that enum, so a rename or casing/typo
// mismatch cannot silently collapse a role's member pool at runtime.
function roleConst(name) {
    if (!ROLES.includes(name)) {
        throw new Error(`[Role Contract] '${name}' is not a member of contracts.ROLES: ${ROLES.join(', ')}`);
    }
    return name;
}
const ROLE_DOER = roleConst('doer');
const ROLE_REVIEWER = roleConst('reviewer');

// ---------------------------------------------------------------------------
// 'orchestrator' pseudo-role
// ---------------------------------------------------------------------------
//
// 'orchestrator' is deliberately NOT a member of `contracts.ROLES` and must
// never be added to it: that enum is vendored (it mirrors the `name:`
// frontmatter of packages/apra-fleet-se/apra-pm/agents/*.md 1:1) and this repo
// must not diverge from it. 'orchestrator' has no agent definition, no
// input/output schema, and is never passed to `agent()` -- it is never
// dispatched as a fleet agent at all. It is an APPLICATION-LEVEL pseudo-role:
// a `roleMap` key pinning which physical fleet member the orchestrating
// PROCESS ITSELF (this file, issuing `bd`/`git` commands directly) acts as.
// Being non-vendored, it must not be passed through `roleConst()`/`ROLES`
// membership checks (that would throw), and must never be used as a key into
// a `bd show`-derived model-metadata lookup or any vendored schema table.
// Always reference it via this constant (the canonical lowercase form) rather
// than a literal, so a roleMap author's lowercase key is always honored.
const ROLE_ORCHESTRATOR = 'orchestrator';

// ---------------------------------------------------------------------------
// Fixed-role tier defaults
// ---------------------------------------------------------------------------
//
// Doer dispatches price themselves off the PER-BEAD model tier the planner
// records in beads metadata (see the streak model resolution near the
// Develop/Review loop below). The other roles this runner dispatches each run
// once per cycle/run and have no bead of their own to read a tier from, so
// they use a FIXED tier chosen for the nature of the work. Passing no `model`
// is not an option: FleetWorkflow would fall back to a 'default' bucket that
// matches no entry in pricing.mjs and is therefore never priced.
//   planner            -> 'premium'  (drafts/redrafts the whole task DAG; highest-stakes single dispatch of a cycle)
//   plan-reviewer      -> 'premium'  (adversarial DAG review; vendor contract treats reviewer-class work as premium-tier)
//   reviewer           -> 'premium'  (both per-round AND final review; vendor contract: "always use model: premium")
//   deployer           -> 'standard' (mostly mechanical: follow deploy.md)
//   integ-test-runner  -> 'standard' (mostly mechanical: follow integ-test-playbook.md)
//   regression-test-runner -> 'standard' (mostly mechanical: follow regression-test-playbook.md)
//   harvester          -> 'standard' (docs/CHANGELOG synthesis, not code-critical)
// These tier keywords ('cheap' | 'standard' | 'premium') are resolved to a
// concrete model PER MEMBER, server-side, by execute-prompt.ts's
// resolveModelForTier() (via each member's registered model_tiers). That is
// what makes a mixed-provider fleet work: a fixed 'premium' dispatch resolves
// to whatever each target member's own premium tier is configured to, instead
// of a provider-specific model literal being passed verbatim to a member where
// it means nothing. Real per-member cost lookup (rather than a tier-band
// estimate) is available via the get_member_model_pricing MCP tool; see
// pricing.mjs.
const FIXED_ROLE_TIER = {
    planner: 'premium',
    'plan-reviewer': 'premium',
    reviewer: 'premium',
    deployer: 'standard',
    'integ-test-runner': 'standard',
    'regression-test-runner': 'standard',
    harvester: 'standard',
    // Streak Assignment is this runner's own ad-hoc "group these ready bead
    // ids" call (no vendored persona): a small, fully-specified classification
    // task with no exploration or judgment beyond what the prompt already
    // states, so it gets 'cheap' even though it borrows the planner MEMBER for
    // routing convenience.
    streakAssignment: 'cheap',
};

export const meta = { name: 'fleet-sprint-runner' };

// ---------------------------------------------------------------------------
// bd JSON-parse helper
// ---------------------------------------------------------------------------
//
// All `bd ... --json` output must be parsed through this rather than a bare
// JSON.parse: non-JSON noise on stdout (a warning or deprecation line) would
// otherwise raise an anonymous SyntaxError deep inside a multi-cycle run. This
// names the offending command and includes a snippet of the raw output.
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
// Goal-priority helpers
// ---------------------------------------------------------------------------
//
// `validated.goal` is a slash-separated priority list (e.g. 'P1', 'P1/P2'),
// already validated against GOAL_PATTERN above. The sprint's exit condition
// (distinct from "is there work dispatchable right now", which `--ready`
// answers) is: are there any NOT-YET-CLOSED beads in scope at or above
// (numerically <=) the worst priority named in the goal? `bd list
// --priority-max=Pn` is inclusive of Pn, so the worst (highest numeric)
// priority in the goal is exactly the right `--priority-max` value.
/**
 * @param {string} goal - e.g. 'P1', 'P1/P2', 'P1/P2/P3'
 * @returns {string} the lowest-priority (highest 'Pn' number) tier named in `goal`, e.g. 'P2'
 */
export function goalPriorityMax(goal) {
    const tiers = goal.split('/').map((p) => Number(p.slice(1)));
    const worst = Math.max(...tiers);
    return `P${worst}`;
}

// apra-fleet-eft.52.1.3: server-side goal-membership placement for the
// fleet-sprint dashboard's Sprint vs Backlog split. The viewer must NOT
// decide this itself (no CSS display:none hiding in the browser, no
// priority-only guess): goal membership is graph knowledge -- it needs the
// full dependency edge set to honor the blocks-edge exception below -- so it
// is computed here, in the state payload, and every task is returned tagged
// with a `placement` field ('sprint' | 'backlog') the viewer consumes
// verbatim.
//
// Rules, applied to TOP-LEVEL items only (an item whose `parent` points at no
// other item in the dataset -- same "only an in-dataset parent nests" rule
// the viewer's containment tree uses; descendants inherit their root's
// placement):
//
//   - A top-level item is a SPRINT item unless it is DEFINITIVELY below the
//     sprint's goal band -- i.e. it has a finite numeric priority strictly
//     greater (numerically) than goalPriorityMax(goal). An item with no /
//     non-numeric priority is NOT demoted (it is in-scope sprint work of
//     unknown rank, not deliberately-deferred backlog).
//   - EXCEPTION (visual continuity): a below-goal top-level item connected to
//     an in-goal top-level item by a 'blocks'-type dependency edge (in either
//     direction) stays a SPRINT item, so it renders alongside the sprint
//     subtree it blocks / is blocked by rather than being split off into the
//     Backlog section.
//
// Descendants of a top-level item always inherit that item's placement, so a
// whole subtree lands in one section.
/**
 * @param {Array<{id: (string|number), parent?: (string|number), priority?: number, dependencies?: Array<{depends_on_id: (string|number), type: string}>}>} tasks - scoped bead objects
 * @param {string} goal - sprint goal band, e.g. 'P1/P2'
 * @returns {{ sprintTasks: object[], backlogTasks: object[] }} the same tasks, each tagged with a `placement` field, partitioned by section
 */
export function partitionByGoalMembership(tasks, goal) {
    const list = Array.isArray(tasks) ? tasks : [];
    const byId = new Map();
    list.forEach((t) => {
        if (t && t.id !== undefined && t.id !== null) byId.set(String(t.id), t);
    });

    const hasInDatasetParent = (t) => {
        const p = t && t.parent;
        return p !== undefined && p !== null && byId.has(String(p));
    };

    // Walk `parent` up to the top-level in-dataset ancestor (cycle-guarded).
    const rootOf = (t) => {
        let cur = t;
        const seen = new Set();
        while (hasInDatasetParent(cur) && !seen.has(String(cur.id))) {
            seen.add(String(cur.id));
            cur = byId.get(String(cur.parent));
        }
        return cur;
    };

    const goalMaxNum = Number(goalPriorityMax(goal).slice(1));
    const isBelowGoal = (t) =>
        typeof t.priority === 'number' && Number.isFinite(t.priority) && t.priority > goalMaxNum;

    const topLevel = list.filter((t) => t && !hasInDatasetParent(t));
    // In-goal top-level items: everything not definitively below the goal band.
    const inGoalTopIds = new Set(
        topLevel.filter((t) => !isBelowGoal(t)).map((t) => String(t.id))
    );

    // Sprint set starts as the in-goal top-levels, then absorbs below-goal
    // top-levels connected to an in-goal top-level by a 'blocks' edge, in
    // either direction.
    const sprintTopIds = new Set(inGoalTopIds);
    topLevel.forEach((t) => {
        const id = String(t.id);
        if (sprintTopIds.has(id)) return;
        // Outgoing: this below-goal top-level depends_on (is blocked by) an
        // in-goal top-level -> keep it in Sprint.
        const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
        if (deps.some((d) => d && d.type === 'blocks' && inGoalTopIds.has(String(d.depends_on_id)))) {
            sprintTopIds.add(id);
        }
    });
    // Incoming: an in-goal top-level depends_on (is blocked by) a below-goal
    // top-level -> keep that below-goal item in Sprint too.
    topLevel.forEach((t) => {
        if (!inGoalTopIds.has(String(t.id))) return;
        const deps = Array.isArray(t.dependencies) ? t.dependencies : [];
        deps.forEach((d) => {
            if (!d || d.type !== 'blocks') return;
            const other = byId.get(String(d.depends_on_id));
            if (other && !hasInDatasetParent(other)) sprintTopIds.add(String(other.id));
        });
    });

    const sprintTasks = [];
    const backlogTasks = [];
    list.forEach((t) => {
        if (!t) return;
        const root = rootOf(t);
        const placement = sprintTopIds.has(String(root.id)) ? 'sprint' : 'backlog';
        const tagged = { ...t, placement };
        if (placement === 'backlog') backlogTasks.push(tagged);
        else sprintTasks.push(tagged);
    });
    return { sprintTasks, backlogTasks };
}

// Every status that means "not yet done" for exit-condition purposes --
// deliberately NOT `--ready`, which only reflects "dispatchable right now" and
// silently excludes blocked and orphaned in_progress beads, so an empty
// `--ready` list must never be read as "the sprint is done".
// The value is quoted, not a bare comma list: on Windows commands dispatch via
// `spawn(command, { shell: 'powershell.exe' })`, and PowerShell's parser treats
// an unquoted comma-separated value as an array literal, re-stringifying it
// space-joined ($OFS) so `bd` receives an invalid status. The quotes MUST be
// double, not single: the same string also reaches `bd` through
// `child_process.exec()` under cmd.exe, which has no single-quote quoting and
// would pass them literally into argv. Double quotes are stripped as real
// quoting by PowerShell and cmd.exe alike, and are a harmless no-op under POSIX
// shells.
const NOT_DONE_STATUSES = '"open,in_progress,blocked,deferred"';

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

// ---------------------------------------------------------------------------
// Multi-member topology precondition
// ---------------------------------------------------------------------------
//
// A sprint stands up under one of two topology contracts, and this function is
// the gate that refuses to start when the fleet does not satisfy the one the
// caller named. Mode selection is EXPLICIT (`opts.mode`), never inferred: an
// unknown mode is a hard refusal, not a silent fallback.
//
// LEGACY (shared-workspace): there is no cross-member sync layer, so every
// member must resolve to the same checkout/DB. The orchestrator's `bd`
// commands run against ITS member's beads DB while each doer's `bd close`
// runs against its own, and the sprint git branch is only meaningful if all
// members share working state. Enforced by comparing an identity signal
// (cli.mjs wires it to `git rev-parse HEAD`) across members. Matching HEADs
// at start is a best-effort heuristic, not a guarantee of ongoing shared
// state: two independent checkouts sitting on the same commit would pass.
//
// SYNCED: the orchestrator-bracketed G-pull/G-push layer reconciles members by
// fast-forward pull/push, so differing HEADs between brackets are EXPECTED and
// a shared workspace is not required. The precondition instead becomes: every
// member reports the SAME `git remote get-url origin` (they push/pull the same
// remote branch) AND passes a `bd dolt pull` probe (their beads DB can sync).
//
// Inject-driven, with no direct I/O of its own, so cli.mjs can wire the probes
// to live fleet commands while tests supply per-member signals directly. A
// single member trivially passes. For 2+ members, a member whose signal cannot
// be obtained is a REFUSAL: shared state cannot be proven, so the sprint must
// not silently continue.
/**
 * @param {{
 *   members: string[],
 *   getIdentity?: (member: string) => Promise<string>,
 *   mode?: 'legacy'|'synced',
 *   getOriginUrl?: (member: string) => Promise<string>,
 *   doltProbe?: (member: string) => Promise<unknown>,
 * }} opts
 * @returns {Promise<{ ok: boolean, singleMember: boolean, mode: string, identities?: Array<object>, probes?: Array<object>, message: string }>}
 */
export async function checkMemberTopology({ members, getIdentity, mode = 'legacy', getOriginUrl, doltProbe }) {
    if (!Array.isArray(members) || members.length === 0) {
        return { ok: false, singleMember: false, mode, identities: [], message: '[Topology] Refusing to start: no members configured.' };
    }

    if (mode !== 'legacy' && mode !== 'synced') {
        return {
            ok: false,
            singleMember: members.length === 1,
            mode,
            message: `[Topology] Refusing to start: unknown topology mode '${mode}'. Mode must be selected explicitly as 'legacy' (shared-workspace, same-HEAD) or 'synced' (orchestrator-bracketed git sync, same-origin + dolt probe).`,
        };
    }

    if (members.length === 1) {
        return {
            ok: true,
            singleMember: true,
            mode,
            identities: [{ member: members[0], signal: null, error: null }],
            message: `[Topology] Single-member ${mode} sprint ('${members[0]}') -- shared-state precondition trivially satisfied (nothing to compare).`,
        };
    }

    // -----------------------------------------------------------------------
    // SYNCED mode: same-origin + dolt-probe precondition. HEADs are ALLOWED to
    // differ -- reconciliation is the sync layer's job.
    // -----------------------------------------------------------------------
    if (mode === 'synced') {
        if (typeof getOriginUrl !== 'function' || typeof doltProbe !== 'function') {
            return {
                ok: false,
                singleMember: false,
                mode,
                message: '[Topology] Refusing to start the synced-mode sprint: getOriginUrl and doltProbe must both be provided so the same-origin and dolt-pull preconditions can be checked.',
            };
        }

        const probes = [];
        for (const member of members) {
            let originUrl = null;
            let originError = null;
            let doltOk = false;
            let doltError = null;
            try {
                const raw = await getOriginUrl(member);
                const url = (typeof raw === 'string' ? raw : String(raw)).trim();
                if (url) originUrl = url; else originError = 'empty origin URL';
            } catch (err) {
                originError = (err && err.message) ? err.message : String(err);
            }
            try {
                await doltProbe(member);
                doltOk = true;
            } catch (err) {
                doltError = (err && err.message) ? err.message : String(err);
            }
            probes.push({ member, originUrl, originError, doltOk, doltError });
        }

        // A member that failed EITHER precondition (origin URL unavailable, or
        // a failing dolt probe) is rejected, naming the member and which
        // precondition failed.
        const failedPrecondition = probes.filter((p) => p.originError !== null || !p.doltOk);
        if (failedPrecondition.length > 0) {
            const detail = failedPrecondition.map((p) => {
                const reasons = [];
                if (p.originError !== null) reasons.push(`origin URL unavailable (${p.originError})`);
                // "dolt pull probe" (not "bd dolt pull") deliberately -- this is
                // prose describing what doltProbe() checks, not a literal
                // command; keeping the exact 'bd dolt pull'/'bd dolt push' tokens
                // out of message text keeps this file clean for the
                // dolt-literal-guard.mjs mechanical scan (apra-fleet-417.2.3),
                // which flags any such literal outside a comment/import as a
                // reintroduced direct dolt command.
                if (!p.doltOk) reasons.push(`dolt pull probe failed (${p.doltError})`);
                return `${p.member}: ${reasons.join('; ')}`;
            }).join(', ');
            return {
                ok: false,
                singleMember: false,
                mode,
                probes,
                message:
                    '[Topology] Refusing to start the synced-mode sprint: one or more members failed a sync precondition -- ' +
                    detail +
                    '. In synced mode every member must report the same origin URL AND pass a dolt-pull sync probe. ' +
                    'See docs/architecture.md "Multi-member topology (fleet-sprint)".',
            };
        }

        // All members pass the dolt probe -- now they must share ONE origin.
        const distinctOrigins = [...new Set(probes.map((p) => p.originUrl))];
        if (distinctOrigins.length > 1) {
            return {
                ok: false,
                singleMember: false,
                mode,
                probes,
                message:
                    '[Topology] Refusing to start the synced-mode sprint: the configured members report DIVERGENT origin URLs, so ' +
                    'they do not push/pull the same remote branch and the git sync layer cannot reconcile them. Per-member origins: ' +
                    probes.map((p) => `${p.member}=${p.originUrl}`).join(', ') +
                    '. Every member must report the same `git remote get-url origin`. ' +
                    'See docs/architecture.md "Multi-member topology (fleet-sprint)".',
            };
        }

        return {
            ok: true,
            singleMember: false,
            mode,
            probes,
            message: `[Topology] Synced mode: all ${members.length} configured members share origin '${distinctOrigins[0]}' and passed the dolt-pull probe -- differing HEADs are reconciled by the git sync layer.`,
        };
    }

    // -----------------------------------------------------------------------
    // LEGACY mode: shared-workspace same-HEAD identity check.
    // -----------------------------------------------------------------------
    if (typeof getIdentity !== 'function') {
        return {
            ok: false,
            singleMember: false,
            mode,
            message: '[Topology] Refusing to start the legacy-mode sprint: getIdentity must be provided so the same-HEAD precondition can be checked.',
        };
    }

    const identities = [];
    for (const member of members) {
        try {
            const raw = await getIdentity(member);
            const signal = (typeof raw === 'string' ? raw : String(raw)).trim();
            identities.push({ member, signal: signal || null, error: signal ? null : 'empty identity signal' });
        } catch (err) {
            identities.push({ member, signal: null, error: (err && err.message) ? err.message : String(err) });
        }
    }

    const unresolved = identities.filter((i) => i.error !== null);
    if (unresolved.length > 0) {
        return {
            ok: false,
            singleMember: false,
            mode,
            identities,
            message:
                '[Topology] Refusing to start the multi-member sprint: could not obtain an identity signal from every ' +
                'configured member, so a shared-workspace setup cannot be verified. Per-member results: ' +
                identities.map((i) => `${i.member}=${i.error ? `ERROR(${i.error})` : i.signal}`).join(', ') +
                '. The only supported multi-member mode is a verified shared workspace (all members resolve to the same ' +
                'checkout/DB); otherwise run single-member. See docs/architecture.md "Multi-member topology (fleet-sprint)".',
        };
    }

    const distinct = [...new Set(identities.map((i) => i.signal))];
    if (distinct.length > 1) {
        return {
            ok: false,
            singleMember: false,
            mode,
            identities,
            message:
                '[Topology] Refusing to start the multi-member sprint in legacy mode: the configured members disagree on ' +
                'their identity signals (are on differing HEADs). Re-run with --sync to enable cross-member sync mode, which ' +
                'tolerates differing HEADs and uses orchestrator-bracketed git sync to reconcile them. Per-member signals: ' +
                identities.map((i) => `${i.member}=${i.signal}`).join(', ') +
                '. See docs/architecture.md "Multi-member topology (fleet-sprint)" for details.',
        };
    }

    return {
        ok: true,
        singleMember: false,
        mode,
        identities,
        message: `[Topology] All ${members.length} configured members share the same identity signal (${distinct[0]}) -- shared-state precondition satisfied.`,
    };
}

// ---------------------------------------------------------------------------
// Orchestrator-bracketed git sync helpers
// ---------------------------------------------------------------------------
//
// Stance: SINGLE-WRITER TOKEN PASSING. The writer pushes, then the next reader
// pulls, so every intra-sprint git merge is fast-forward BY CONSTRUCTION. A
// non-FF result is therefore not a merge to resolve -- it is proof the
// invariant is already broken, so it is a HARD, TYPED error
// (GitDivergedError), never auto-resolved.
//
// Every bracket must fail-soft-with-retry in a way that DISTINGUISHES
// transient-retry (network unreachable, an index/ref lock) from diverged-abort
// (non-FF, unmerged/conflicted paths). A diverged state must NEVER be retried
// blindly. classifyGitFailure() below is that classifier; the two failure
// classes surface as two distinct WorkflowError subclasses (GitSyncError vs
// GitDivergedError) so callers and tests can assert them apart.
//
// Every git command is issued via the injected command() with an explicit
// `member_name` -- agents never run sync themselves; the orchestrator brackets
// each dispatch. `command` is dependency-injected so unit tests can drive these
// helpers with a mock command() and no live fleet.

// apra-fleet-647.1.3.2: the git stderr/stdout pattern lists that used to live
// here (GIT_DIVERGED_PATTERNS, GIT_AUTH_PATTERNS, GIT_TRANSIENT_PATTERNS) are
// GONE -- classifyGitFailure() below delegates to VCSModule.classifyFailure(),
// the ONE place VCS stderr is parsed (vcs-module.mjs's own header comment).
// The default 'github' provider chain (GitHubVCS -> GenericGitVCS, see
// ./vcs-providers/github.mjs and ./generic-git.mjs) reproduces every pattern
// that lived in the three deleted lists verbatim -- built for exactly this
// migration in apra-fleet-647.1.3.1 -- so this is a delegation, not a
// behavior change.

/**
 * Classify a failed git command's output into the failure classes the sync
 * brackets route differently. Thin adapter over VCSModule.classifyFailure()
 * + toGitVerdict(), mapping the neutral kind taxonomy onto this module's
 * legacy verdict vocabulary with NO verdict change from the deleted
 * pattern-list classifier.
 *
 * apra-fleet-417.7: `provider` is optional and, when supplied, selects the
 * member's own resolved VCS provider chain (e.g. 'azure-devops',
 * 'bitbucket') instead of the default 'github' chain -- this is what makes
 * azure-devops.mjs's TF401019 and bitbucket.mjs's app-password rules
 * reachable at runtime; they are NOT inherited by the default chain (see
 * vcs-nongithub-auth-selfheal.test.mjs). Omitting it (every call site that
 * cannot resolve a provider) reproduces the prior provider-agnostic default
 * exactly -- NO verdict change for GitHub members or any caller that does
 * not pass one.
 *
 * @param {string} output - the raw git stderr/stdout of the failed command
 * @param {string} [provider] - the member's resolved VCS provider; falls back
 *   to VCSModule's default ('github') chain when omitted/falsy.
 * @returns {'diverged'|'auth'|'transient'|'unknown'}
 */
export function classifyGitFailure(output, provider) {
    return toGitVerdict(classifyFailure(output, provider ? { provider } : undefined).kind);
}

/**
 * Run a single git command via the injected command() with failSoft, retrying
 * ONLY transient failures up to `maxTransientRetries` times. A diverged (or
 * unknown) failure is returned immediately, never retried.
 *
 * An optional injected `onAuthFailure` async callback adds a DISTINCT, bounded
 * one-shot self-heal path, deliberately NOT folded into the
 * `maxTransientRetries` loop. When a command fails with an 'auth'
 * classification (see classifyGitFailure) and `onAuthFailure` is provided, it
 * is called EXACTLY ONCE (never in a loop, even if the retry fails with 'auth'
 * again); if it resolves without throwing, the SAME command is retried exactly
 * once more. If `onAuthFailure` throws, or is omitted, the failed result is
 * returned as-is for the caller to turn into its typed
 * GitSyncError/GitDivergedError.
 *
 * apra-fleet-647.1.3.3: an 'unknown' classification (any provider auth/failure
 * text classifyGitFailure could not otherwise recognize) gets the SAME bounded
 * one-shot self-heal + single retry as 'auth', rather than failing immediately
 * -- an unrecognized provider auth string is far more likely to be a stale
 * credential than a genuinely fatal condition, and one bounded self-heal
 * attempt is cheap. This shares the single `authHealAttempted` latch with the
 * 'auth' path, so the self-heal still fires AT MOST ONCE per runGitStep call
 * regardless of whether it was triggered by 'auth' or 'unknown'. A 'diverged'
 * classification is excluded from this and is still returned immediately,
 * never retried -- see the module header's SINGLE-WRITER TOKEN PASSING stance.
 *
 * apra-fleet-417.7: an optional `provider` (the member's own resolved VCS
 * provider, e.g. from VCSModule.resolveProvider()) is threaded straight into
 * classifyGitFailure() so a vendor-specific AUTH rule (azure-devops.mjs's
 * TF401019, bitbucket.mjs's app-password literal) is reachable here, not just
 * from a caller that names the provider directly against classifyFailure().
 * Omitting it (unresolvable/absent provider) falls back to today's default
 * 'github' chain -- no throw, no new failure mode, no verdict change for
 * GitHub members.
 *
 * @returns {Promise<{ ok: boolean, output: string, error: string|null, kind?: 'diverged'|'auth'|'transient'|'unknown' }>}
 */
async function runGitStep({ command, member, cmd, label, log, maxTransientRetries, onAuthFailure, provider }) {
    let attempt = 0;
    let authHealAttempted = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const res = await command(cmd, { member_name: member, silent: true, failSoft: true, label });
        if (res && res.ok) return res;
        const error = res ? res.error : 'unknown command failure';
        const kind = classifyGitFailure(error, provider);
        if (kind === 'transient' && attempt < maxTransientRetries) {
            attempt += 1;
            log(`[Sync] transient git failure for member '${member}' (${label}); retry ${attempt}/${maxTransientRetries}: ${error}`);
            continue;
        }
        if ((kind === 'auth' || kind === 'unknown') && typeof onAuthFailure === 'function' && !authHealAttempted) {
            authHealAttempted = true;
            log(`[Sync] ${kind} git failure for member '${member}' (${label}); invoking self-heal (provision_vcs_auth) once before a single bounded retry: ${error}`);
            try {
                await onAuthFailure({ member, label, cmd, error, kind: 'git' });
            } catch (healErr) {
                log(`[Sync] self-heal for member '${member}' (${label}) failed; not retrying further: ${healErr.message}`);
                return { ok: false, output: res ? res.output : '', error, kind };
            }
            log(`[Sync] self-heal for member '${member}' (${label}) completed; retrying the failed git command once.`);
            continue;
        }
        return { ok: false, output: res ? res.output : '', error, kind };
    }
}

/**
 * Resolve `member`'s VCS provider via an injected `resolveMemberProvider`
 * (see createMemberVcsProviderResolver below) for threading into
 * classifyGitFailure(), failing CLOSED to `undefined` (today's default
 * 'github' chain) on any error or when no resolver was injected -- this must
 * never throw, since a provider-resolution hiccup must never abort a sync
 * bracket that would otherwise succeed on the default chain.
 *
 * @param {((member: string) => Promise<string|undefined>)|undefined} resolveMemberProvider
 * @param {string} member
 * @param {Function} log
 * @returns {Promise<string|undefined>}
 */
async function resolveGitProviderForClassification(resolveMemberProvider, member, log) {
    if (typeof resolveMemberProvider !== 'function') return undefined;
    try {
        return await resolveMemberProvider(member);
    } catch (err) {
        log(`[Sync] could not resolve member '${member}'s VCS provider for git-failure classification (falling back to the default provider chain, no verdict change for GitHub members): ${err.message}`);
        return undefined;
    }
}

/**
 * G-pull: bring `member` up to the shared branch tip before it does any work --
 * `git fetch` then `git merge --ff-only`. Because of single-writer token
 * passing this merge is fast-forward by construction; a non-FF result is a
 * distinct typed GitDivergedError (NOT a generic failure), never auto-merged.
 * Transient (network/lock) failures are retried up to `maxTransientRetries`;
 * divergence is never retried.
 *
 * Every git command is issued via the injected command() with an explicit
 * member_name.
 *
 * An optional injected `onAuthFailure` is threaded through to runGitStep's
 * bounded one-shot self-heal, since a stale token can break a pull as easily as
 * a push.
 *
 * An optional `resetToRemoteTip` (default false) changes the pull half from
 * `git merge --ff-only` to `git reset --hard <remote>/<branch>` so a RETRIED
 * doer dispatch resumes on the published tip instead of failing on (or
 * re-committing over) a divergence its own prior attempt left behind. It must
 * only be set on a retry that may have mutated state (withGitSync's
 * resumeOntoRemoteTip); omitting it keeps the ff-only-merge behaviour for every
 * first attempt.
 *
 * apra-fleet-417.7: an optional injected `resolveMemberProvider` (see
 * createMemberVcsProviderResolver) is resolved ONCE at the top of this call
 * and threaded into every runGitStep call below, so a G-pull auth failure for
 * a non-GitHub member classifies via that member's own provider chain.
 *
 * @param {string} member
 * @param {{ command: Function, log?: Function, maxTransientRetries?: number, remote?: string, branch?: string, onAuthFailure?: Function, resetToRemoteTip?: boolean, resolveMemberProvider?: (member: string) => Promise<string|undefined> }} opts
 * @returns {Promise<{ ok: true, member: string }>}
 */
export async function syncMemberBefore(member, opts = {}) {
    const { command, log = () => {}, maxTransientRetries = 1, remote = 'origin', branch, onAuthFailure, resetToRemoteTip = false, resolveMemberProvider } = opts;
    if (typeof command !== 'function') {
        throw new Error("syncMemberBefore requires an injected command() in opts");
    }
    const provider = await resolveGitProviderForClassification(resolveMemberProvider, member, log);

    const fetchCmd = branch ? `git fetch ${remote} ${branch}` : `git fetch ${remote}`;
    const fetch = await runGitStep({
        command, member, cmd: fetchCmd,
        label: `G-pull fetch for '${member}'`, log, maxTransientRetries, onAuthFailure, provider,
    });
    if (!fetch.ok) {
        // A brand-new sprint branch created locally from base, before its
        // first G-push, makes this fetch fail with "couldn't find remote ref
        // <branch>". That is a benign, expected state: there is nothing on the
        // remote to pull, so the bracket's pull half is a no-op, not an error.
        // Only this precise git message may be treated as
        // branch-doesn't-exist; anything else must still surface.
        if (/couldn't find remote ref/i.test(fetch.error || '')) {
            log(`[Sync] G-pull for member '${member}': branch '${branch}' does not exist on '${remote}' yet (not pushed); skipping pull (nothing to sync down).`);
            return { ok: true, member };
        }
        // A fetch cannot "diverge" -- any failure here is transient-exhausted
        // or unknown; surface it as a (non-diverged) sync error.
        throw new GitSyncError(
            `[Sync] G-pull fetch failed for member '${member}': ${fetch.error}`,
            { member, gitOutput: fetch.error },
        );
    }

    // On a RETRIED dispatch whose prior attempt was not provably a no-mutation
    // failure (it may have committed and/or pushed its streak), `git merge
    // --ff-only` is the wrong recovery: if the prior attempt pushed and the
    // local tip then diverged with a re-implemented duplicate commit, the
    // ff-only merge raises GitDivergedError and the streak can NEVER resume,
    // because every subsequent push/merge fails non-fast-forward. Hard-resetting
    // onto the freshly fetched remote tip makes the retry resume ON TOP of
    // already-published work instead of re-committing it. Only the code checkout
    // is touched (beads live in a separate Dolt clone); a local commit that was
    // never published is intentionally dropped and simply re-done by the retry,
    // which is what prevents the divergent duplicate commit. A concrete branch
    // is required to name a remote tip; without one this falls through to the
    // ff-only merge below.
    if (resetToRemoteTip && branch) {
        const resetTarget = `${remote}/${branch}`;
        const reset = await runGitStep({
            command, member, cmd: `git reset --hard ${resetTarget}`,
            label: `G-pull reset-to-remote-tip for '${member}'`, log, maxTransientRetries, onAuthFailure, provider,
        });
        if (!reset.ok) {
            throw new GitSyncError(
                `[Sync] G-pull reset-to-remote-tip failed for member '${member}': ${reset.error}`,
                { member, gitOutput: reset.error },
            );
        }
        log(`[Sync] G-pull for member '${member}': hard-reset local branch onto '${resetTarget}' so a retried dispatch resumes on the published tip instead of re-committing.`);
        return { ok: true, member };
    }

    const mergeCmd = branch ? `git merge --ff-only ${remote}/${branch}` : 'git merge --ff-only';
    const merge = await runGitStep({
        command, member, cmd: mergeCmd,
        label: `G-pull ff-only merge for '${member}'`, log, maxTransientRetries, onAuthFailure, provider,
    });
    if (!merge.ok) {
        if (merge.kind === 'diverged') {
            throw new GitDivergedError(
                `[Sync] G-pull for member '${member}' could not fast-forward -- it has DIVERGED from the shared branch and must not be auto-merged: ${merge.error}`,
                { member, gitOutput: merge.error, operation: 'pull' },
            );
        }
        throw new GitSyncError(
            `[Sync] G-pull ff-only merge failed for member '${member}': ${merge.error}`,
            { member, gitOutput: merge.error },
        );
    }

    return { ok: true, member };
}

/**
 * G-push: publish `member`'s committed work to the shared branch after a
 * dispatch -- `git push` with ONE bounded pull-rebase retry. If the
 * push is rejected as non-FF (another writer got there first), do a single
 * `git pull --rebase` and re-push exactly once; if it is STILL rejected, raise
 * a typed GitDivergedError -- the single-writer invariant is violated and the
 * push must never be retried further/blindly. Transient (network/lock)
 * failures are retried up to `maxTransientRetries`; divergence is never
 * retried beyond the one bounded rebase.
 *
 * `pushCode: false` makes this a no-op (a read-only bracket has nothing to
 * publish). Every git command is issued via the injected command() with an
 * explicit member_name.
 *
 * Tier 2 of the git conflict ladder: when the pull-rebase retry hits a REAL
 * content conflict (unmerged paths, not just a plain non-FF race), an optional
 * injected `agent()` gets exactly ONE bounded conflict-resolution-runbook
 * dispatch before this function gives up and throws the typed
 * GitDivergedError. The agent's own claim of success is never trusted: this
 * function mechanically re-checks `git status --porcelain` for a clean tree and
 * then attempts one real re-push; only that observed outcome decides whether
 * Tier 2 resolved the conflict. Omitting `agent` leaves Tier 1 only.
 *
 * An optional injected `onAuthFailure` is threaded through to every runGitStep
 * call below for a bounded one-shot self-heal (call it once, retry the same
 * command once) whenever a step is classified 'auth'.
 *
 * apra-fleet-417.7: an optional injected `resolveMemberProvider` (see
 * createMemberVcsProviderResolver) is resolved ONCE at the top of this call
 * and threaded into every runGitStep call below, so a G-push auth failure for
 * a non-GitHub member classifies via that member's own provider chain.
 *
 * @param {string} member
 * @param {{
 *   command: Function, pushCode?: boolean, log?: Function,
 *   maxTransientRetries?: number, remote?: string, branch?: string,
 *   agent?: Function, resolveConflictModel?: string, onAuthFailure?: Function,
 *   resolveMemberProvider?: (member: string) => Promise<string|undefined>,
 * }} opts
 * @returns {Promise<{ ok: true, member: string, pushed: boolean, rebased: boolean, tier2Resolved?: boolean }>}
 */
export async function syncMemberAfter(member, opts = {}) {
    const {
        command, pushCode = true, log = () => {}, maxTransientRetries = 1, remote = 'origin', branch,
        agent, resolveConflictModel, onAuthFailure, resolveMemberProvider,
    } = opts;
    if (typeof command !== 'function') {
        throw new Error("syncMemberAfter requires an injected command() in opts");
    }

    if (!pushCode) {
        return { ok: true, member, pushed: false, rebased: false };
    }
    const provider = await resolveGitProviderForClassification(resolveMemberProvider, member, log);

    const pushCmd = branch ? `git push ${remote} ${branch}` : 'git push';

    let push = await runGitStep({
        command, member, cmd: pushCmd,
        label: `G-push for '${member}'`, log, maxTransientRetries, onAuthFailure, provider,
    });
    if (push.ok) {
        return { ok: true, member, pushed: true, rebased: false };
    }

    if (push.kind !== 'diverged') {
        // Transient-exhausted or unknown non-FF failure -- not a divergence,
        // so no rebase retry; surface the (non-diverged) sync error.
        throw new GitSyncError(
            `[Sync] G-push for member '${member}' failed: ${push.error}`,
            { member, gitOutput: push.error },
        );
    }

    // Non-FF push: attempt EXACTLY ONE pull --rebase then re-push.
    log(`[Sync] G-push for member '${member}' was rejected as non-fast-forward; attempting a single pull --rebase then one re-push.`);
    const rebaseCmd = branch ? `git pull --rebase ${remote} ${branch}` : 'git pull --rebase';
    const rebase = await runGitStep({
        command, member, cmd: rebaseCmd,
        label: `G-push pull-rebase retry for '${member}'`, log, maxTransientRetries, onAuthFailure, provider,
    });
    if (!rebase.ok) {
        // Tier 1 scripted detection: confirm from git's own porcelain status --
        // not from this failing command's exit code/message classification --
        // whether the rebase actually left unmerged paths, and if so restore a
        // clean tree via `git rebase --abort` BEFORE the typed divergence error
        // below propagates. This is the single Tier 1 -> Tier 2 escalation
        // point.
        const unmergedPaths = await detectAndAbortRebaseConflict({ command, member, log, maxTransientRetries, runGitStep });

        // Tier 2: unmergedPaths.length > 0 means a real content conflict, not
        // just a non-FF race. Attempt exactly ONE bounded agent-with-runbook
        // dispatch (when an agent() was injected) before falling back to the
        // typed GitDivergedError below. Every outcome (agent throws, agent
        // returns, or agent unavailable) is mechanically re-verified against
        // real git state -- never the agent's own claim.
        if (unmergedPaths.length > 0 && typeof agent === 'function') {
            try {
                await dispatchConflictResolutionAgent({
                    agent, member, branch, unmergedPaths, log, model: resolveConflictModel, remote,
                });
            } catch (tier2Err) {
                log(`[Sync] Tier 2 conflict-resolution dispatch for member '${member}' threw and will not be retried (script-first: no further escalation): ${tier2Err.message}`);
            }

            const postTier2Status = await command('git status --porcelain', { member_name: member, silent: true, failSoft: true, label: `Tier 2 post-resolution clean-state check for '${member}'` });
            const stillUnmerged = parseUnmergedPaths(postTier2Status && postTier2Status.output ? postTier2Status.output : '');
            if (stillUnmerged.length === 0) {
                const rePush = await runGitStep({
                    command, member, cmd: pushCmd,
                    label: `G-push after Tier 2 conflict resolution for '${member}'`, log, maxTransientRetries, onAuthFailure, provider,
                });
                if (rePush.ok) {
                    log(`[Sync] Tier 2 conflict resolution for member '${member}' succeeded -- working tree clean and the resolved code was pushed.`);
                    return { ok: true, member, pushed: true, rebased: true, tier2Resolved: true };
                }
                log(`[Sync] Tier 2 conflict resolution for member '${member}' left a clean tree but the re-push still failed: ${rePush.error}`);
            } else {
                log(`[Sync] Tier 2 conflict resolution for member '${member}' did not fully resolve -- porcelain still shows unmerged path(s): ${stillUnmerged.join(', ')}. Restoring a clean tree before failing this streak.`);
                await detectAndAbortRebaseConflict({ command, member, log, maxTransientRetries, runGitStep });
            }
        }

        if (rebase.kind === 'diverged' || unmergedPaths.length > 0) {
            throw new GitDivergedError(
                `[Sync] G-push pull-rebase for member '${member}' hit unmergeable divergence (conflict) -- must not be retried blindly: ${rebase.error}`,
                { member, gitOutput: rebase.error, operation: 'push-rebase', details: { unmergedPaths } },
            );
        }
        throw new GitSyncError(
            `[Sync] G-push pull-rebase for member '${member}' failed: ${rebase.error}`,
            { member, gitOutput: rebase.error },
        );
    }

    push = await runGitStep({
        command, member, cmd: pushCmd,
        label: `G-push re-push after rebase for '${member}'`, log, maxTransientRetries, onAuthFailure, provider,
    });
    if (push.ok) {
        return { ok: true, member, pushed: true, rebased: true };
    }

    // Still rejected after the one bounded rebase -- diverged, never retried further.
    throw new GitDivergedError(
        `[Sync] G-push for member '${member}' still rejected after one pull-rebase retry -- the single-writer token invariant is violated; refusing to retry further: ${push.error}`,
        { member, gitOutput: push.error, operation: 'push' },
    );
}

// ---------------------------------------------------------------------------
// Dolt sync brackets: D-pull / D-push -- MOVED to ./dolt-sync.mjs
// ---------------------------------------------------------------------------
//
// apra-fleet-417.2.1: every `bd dolt pull` / `bd dolt push` spawn, its failure
// classification, its retry/auth self-heal, its sync.remote gating and its
// conflict handling now live in ONE module -- ./dolt-sync.mjs -- which is the
// only permitted dolt command surface in fleet-sprint. Do NOT re-inline a
// `bd dolt ...` command here or anywhere else: add to DoltSync instead.
//
// runner.js calls the purpose-based entry points DoltSync.syncBefore() /
// DoltSync.syncAfter() / DoltSync.status() at every call site (apra-fleet-
// 417.2.2 migrated the last direct doltPullBefore()/doltPushAfter() callers).
// The lower-level primitives are re-exported below UNCHANGED so the existing
// unit suites (which import them directly from runner.js) keep working; they
// are IMPLEMENTATION DETAIL of the purpose-based API, not a second supported
// call surface for new code.
//
// apra-fleet-417.3.1 -- DEGRADED BY DEFAULT. DoltSync.syncBefore/syncAfter now
// return a structured outcome and do NOT throw on an unresolved sync failure;
// they log loudly, record the failure (DoltSync.getDegradedSyncRecords()) and
// let the sprint continue, because a beads-sync hiccup during concurrent
// multi-agent pushing is a NORMAL condition and must not fail an otherwise
// healthy sprint. Every call site below that must STILL hard-abort says so
// explicitly with `fatal: true`, and only these four classes do:
//   - the post-dispatch sync bracket (syncMemberAfterOrdered): a degraded
//     D-push there would advertise an unreachable close;
//   - the pre-dispatch D-pull: a degraded pull hands the agent a stale clone;
//   - the orchestrator's read-freshness D-pulls before streak verification,
//     cycle-evaluation counts and final-review counts: a stale read misreports
//     every remote member's work as unfinished;
//   - the pre-flight beads-health gate (`readinessGate: true`, the
//     apra-fleet-417.5 rename of `healthGate`, which implies fatal): its
//     entire purpose is to stop the run before anything mutates.
// The orchestrator's post-mutation D-pushes are deliberately NOT fatal: those
// beads writes are already committed in the orchestrator's local clone, so an
// unresolved push is a publication delay, not data loss, and the next D-push
// bracket is its queued retry.
export {
    extractDoltRemoteUrl,
    classifyDoltFailure,
    isMemberSyncRemoteConfigured,
    doltPullBefore,
    extractConflictingTables,
    preflightBeadsHealthGate,
    doltPushAfter,
} from './dolt-sync.mjs';

/**
 * The ordered post-dispatch sync step every withGitSync() bracket's `finally`
 * runs: G-push (code) BEFORE D-push (beads).
 *
 * For code-writing roles (pushCode:true), G-push MUST succeed before D-push is
 * attempted. If G-push throws at all, D-push is skipped ENTIRELY and the error
 * is rethrown, never swallowed -- closing a bead in dolt while the code that
 * justifies the close never left this member's checkout would advertise an
 * UNREACHABLE CLOSE: a reviewer, or the next streak's G-pull, would see the
 * bead done and find no matching commit on the shared branch.
 *
 * With pushCode:false, syncMemberAfter never touches git and cannot throw, so
 * D-push always still runs.
 *
 * `agent`/`resolveConflictModel` are threaded through to syncMemberAfter's
 * conflict-resolution escalation; `onAuthFailure` is threaded through to BOTH
 * syncMemberAfter and doltPushAfter for their bounded one-shot self-heal.
 *
 * @param {string} member
 * @param {{
 *   command: Function, pushCode?: boolean, pushBeads?: boolean,
 *   log?: Function, mutex?: { acquire: Function, release: Function },
 *   sprintId?: string, branch?: string, maxTransientRetries?: number,
 *   remote?: string, agent?: Function, resolveConflictModel?: string,
 *   onAuthFailure?: Function,
 *   resolveMemberProvider?: (member: string) => Promise<string|undefined>,
 * }} opts
 * @returns {Promise<{ ok: true, member: string, gPush: object, dPush: object }>}
 */
export async function syncMemberAfterOrdered(member, opts = {}) {
    const {
        command, pushCode = true, pushBeads = true, log = () => {},
        mutex, sprintId, branch, maxTransientRetries = 1, remote = 'origin',
        agent, resolveConflictModel, onAuthFailure, resolveMemberProvider,
    } = opts;

    let gPush;
    try {
        gPush = await syncMemberAfter(member, { command, pushCode, log, branch, maxTransientRetries, remote, agent, resolveConflictModel, onAuthFailure, resolveMemberProvider });
    } catch (gPushErr) {
        log(`[Sync] G-push failed for member '${member}' -- skipping D-push and failing this streak rather than advertising an unreachable close (a beads close whose justifying code never reached the shared branch): ${gPushErr.message}`);
        throw gPushErr;
    }

    // EXPLICITLY FATAL (apra-fleet-417.3.1): DoltSync.syncAfter is degraded by
    // default, but this is the post-dispatch bracket -- the member's beads
    // closes must reach the shared remote or the orchestrator's next read sees
    // a bead this streak believes it closed. A silent degrade here would
    // advertise an unreachable close, exactly what the G-push-before-D-push
    // ordering above exists to prevent, and would erase the
    // BEADS_SYNC_CONFLICT terminal reason the dashboard reports.
    //
    // Before that fatal divergence surfaces, run the deterministic settle
    // (settleDoltConflicts, dolt-settle.mjs). It is TOTAL over row-level
    // conflicts -- no gates, no allowlist, no LLM escalation -- and a resolved
    // settle is a VERIFIED recovery, because settle republishes (bd dolt pull
    // + push) and checks the push actually landed before returning. The streak
    // only fails (DoltDivergedError -> BEADS_SYNC_CONFLICT) when settle itself
    // hits an operational failure (no usable dolt binary, the ephemeral server
    // would not start, a SQL statement errored).
    //
    // Notably, the data-loss hazard that forced the old ladder's Path B to be
    // disabled at THIS call site does not exist for settle: it never discards
    // and re-bootstraps a clone, so an arbitrary multi-command dispatch's bead
    // mutations cannot be silently thrown away here. There is no pendingMutation
    // to capture and replay because nothing is ever dropped.
    const settle = buildSettleCallback(member, { command, log });
    const dPush = await DoltSync.syncAfter(member, { command, pushBeads, log, mutex, sprintId, onAuthFailure, fatal: true, settle });
    return { ok: true, member, gPush, dPush };
}

/**
 * Child-side HTTP client for the supervisor-owned global dolt push mutex
 * (src/supervisor/dolt-mutex.mjs). The mutex object lives in the always-on
 * supervisor process, but each detached sprint child runs in its OWN process
 * and can only reach it over HTTP. Speaks the routes
 * registerDoltMutexRoutes() exposes:
 *
 *   POST {serviceUrl}/api/dolt-push-mutex/{sprintId}/acquire  body { pid }
 *   POST {serviceUrl}/api/dolt-push-mutex/{sprintId}/release  body { token }
 *
 * The acquire route long-polls -- it does not answer until this sprint
 * genuinely owns the mutex (FIFO after every earlier waiter) -- so a resolved
 * acquire() means this child holds it and no sibling sprint is pushing.
 *
 * Implemented INLINE rather than imported from src/supervisor/dolt-mutex.mjs
 * because runner.js is copied verbatim next to the bundle and loaded via
 * engine.executeFile(), never bundled -- a cross-package relative import would
 * not resolve in the shipped layout. The { acquire, release } surface is
 * exactly what doltPushAfter() calls.
 *
 * @param {{ serviceUrl: string, sprintId: string, fetch?: typeof fetch, log?: Function }} opts
 * @returns {{ acquire: (sprintId: string, o?: { pid?: number|null }) => Promise<{ token: string|null }>, release: (token: string|null) => Promise<boolean> }}
 */
export function createHttpDoltPushMutexClient(opts = {}) {
    const base = String(opts.serviceUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('createHttpDoltPushMutexClient requires a serviceUrl');
    const boundSprintId = opts.sprintId;
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new Error('createHttpDoltPushMutexClient requires a fetch implementation (Node >=18 global fetch or an injected one)');
    }
    const log = opts.log ?? (() => {});
    const routeFor = (sprintId, action) =>
        `${base}/api/dolt-push-mutex/${encodeURIComponent(sprintId)}/${action}`;

    async function postJson(url, body) {
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
        });
        if (!res || !res.ok) {
            const status = res ? res.status : 'no-response';
            throw new Error(`[dolt-mutex] ${url} returned HTTP ${status}`);
        }
        return res.json();
    }

    return {
        async acquire(sprintId, o = {}) {
            const id = sprintId || boundSprintId;
            if (!id) throw new Error('[dolt-mutex] acquire requires a sprintId');
            const payload = await postJson(routeFor(id, 'acquire'), { pid: o.pid ?? null });
            return { token: payload.token ?? null, sprintId: payload.sprintId, expiresAt: payload.expiresAt };
        },
        async release(token) {
            if (token == null) return true;
            const id = boundSprintId;
            if (!id) throw new Error('[dolt-mutex] release requires a bound sprintId');
            try {
                const payload = await postJson(routeFor(id, 'release'), { token });
                return Boolean(payload.released);
            } catch (err) {
                // Non-fatal: the holder's lease expiry will reclaim the mutex
                // even if this release never lands. Surface it for diagnostics.
                log(`[dolt-mutex] release failed (non-fatal; lease will expire): ${err.message}`);
                return false;
            }
        },
        // Lease renewal (docs/dolt-sync-redesign.md Part 3.4): doltPushAfter()
        // renews on an interval while it holds the mutex, so a legitimately
        // long hold (push + reconcile + settle) is never force-evicted by the
        // supervisor's 60s lease expiry while this sprint is still pushing.
        async renew(token) {
            if (token == null) return false;
            const id = boundSprintId;
            if (!id) throw new Error('[dolt-mutex] renew requires a bound sprintId');
            try {
                const payload = await postJson(routeFor(id, 'renew'), { token });
                return Boolean(payload.renewed);
            } catch (err) {
                log(`[dolt-mutex] renew failed (non-fatal; the lease may expire): ${err.message}`);
                return false;
            }
        },
    };
}

/**
 * Child-side HTTP client for the supervisor-owned global child-id allocator
 * (src/supervisor/id-allocator.mjs), used by the orchestrator's bead-creation
 * path. Without a single minting authority, two sprints that each `bd create
 * --parent X` in their own dolt clone independently derive the SAME next child
 * id and their D-pushes hard-conflict; with it, each creator gets an EXPLICIT
 * distinct id passed to `bd create --id <childId>`, so the creates target
 * different rows. Speaks the routes registerIdAllocatorRoutes() exposes:
 *
 *   POST {serviceUrl}/api/child-id-allocator/{parentId}/allocate  body { pid, sprintId, floor }
 *   POST {serviceUrl}/api/child-id-allocator/confirm              body { token }
 *   POST {serviceUrl}/api/child-id-allocator/release              body { token }
 *
 * Implemented INLINE for the same shipped-layout reason as the dolt push mutex
 * client above. The { allocate, confirm, release } surface is exactly what the
 * bead-creation path calls.
 *
 * @param {{ serviceUrl: string, sprintId?: string, fetch?: typeof fetch, log?: Function }} opts
 * @returns {{ allocate: Function, confirm: Function, release: Function }}
 */
export function createHttpChildIdAllocatorClient(opts = {}) {
    const base = String(opts.serviceUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('createHttpChildIdAllocatorClient requires a serviceUrl');
    const boundSprintId = opts.sprintId;
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new Error('createHttpChildIdAllocatorClient requires a fetch implementation (Node >=18 global fetch or an injected one)');
    }
    const log = opts.log ?? (() => {});

    async function postJson(url, body) {
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
        });
        if (!res || !res.ok) {
            const status = res ? res.status : 'no-response';
            throw new Error(`[id-allocator] ${url} returned HTTP ${status}`);
        }
        return res.json();
    }

    return {
        async allocate(parentId, o = {}) {
            if (!parentId) throw new Error('[id-allocator] allocate requires a parentId');
            const url = `${base}/api/child-id-allocator/${encodeURIComponent(parentId)}/allocate`;
            const payload = await postJson(url, {
                pid: o.pid ?? null,
                sprintId: o.sprintId ?? boundSprintId ?? null,
                floor: o.floor,
            });
            return { childId: payload.childId ?? null, seq: payload.seq, token: payload.token ?? null, expiresAt: payload.expiresAt };
        },
        async confirm(token) {
            if (token == null) return true;
            try {
                const payload = await postJson(`${base}/api/child-id-allocator/confirm`, { token });
                return Boolean(payload.confirmed);
            } catch (err) {
                // Non-fatal: the reservation's lease expiry reclaims it even if
                // this confirm never lands. Surface it for diagnostics.
                log(`[id-allocator] confirm failed (non-fatal; lease will expire): ${err.message}`);
                return false;
            }
        },
        async release(token) {
            if (token == null) return true;
            try {
                const payload = await postJson(`${base}/api/child-id-allocator/release`, { token });
                return Boolean(payload.released);
            } catch (err) {
                log(`[id-allocator] release failed (non-fatal; lease will expire): ${err.message}`);
                return false;
            }
        },
    };
}

/**
 * Shared MCP tool-result-to-JSON parser for the two fleet-MCP-hosted
 * coordination clients below. Tool handlers return a JSON STRING wrapped in
 * the standard content[] envelope, so both clients need the same
 * extract-then-parse step.
 * @param {any} result
 * @param {string} label
 * @returns {object}
 */
function parseCoordinationToolResult(result, label) {
    let text = result;
    if (typeof text !== 'string') {
        text = (result && Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string')
            ? result.content[0].text
            : '';
    }
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        throw new Error(`${label} returned a non-JSON response: ${String(text).slice(0, 200) || '(empty)'}`);
    }
    if (payload && payload.error) throw new Error(`${label} error: ${payload.error}`);
    return payload ?? {};
}

/**
 * MCP-transport counterpart to createHttpDoltPushMutexClient above, for the
 * SUPERVISOR-LESS topology: a standalone/detached-binary CLI launch has no
 * supervisor to reach, so `--service-url` is absent and the HTTP client cannot
 * be built, but the launcher always holds a connected MCP client to the shared
 * fleet HTTP singleton, making the fleet server's own `dolt_push_mutex` tool
 * (src/tools/dolt-push-mutex.ts) the reachable coordination point.
 *
 * Ticketed acquire, not long-poll: an MCP tool call cannot block indefinitely,
 * so `acquire` waits a bounded slice per call and then RE-POLLS the same
 * ticket. The server keeps the waiter enqueued across polls, preserving FIFO
 * order (a cancel-and-retry loop would send every timed-out waiter to the back
 * of the queue). The caller's real pid is threaded through so a crashed holder
 * is reclaimed by the server's dead-pid probe rather than wedging the mutex.
 *
 * Implemented INLINE for the same shipped-layout reason as the HTTP clients
 * above.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, sprintId?: string, waitMs?: number, timeoutMs?: number, log?: Function }} opts
 * @returns {{ acquire: Function, release: Function }}
 */
export function createMcpDoltPushMutexClient(opts = {}) {
    const { callTool, sprintId: boundSprintId, log = () => {} } = opts;
    if (typeof callTool !== 'function') throw new Error('createMcpDoltPushMutexClient requires a callTool function');
    const waitMs = Number.isFinite(opts.waitMs) && opts.waitMs > 0 ? opts.waitMs : 5000;
    // Overall ceiling on how long a single acquire may keep re-polling before
    // giving up (a wedged peer is bounded by the server-side lease anyway).
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 15 * 60 * 1000;

    async function call(args) {
        return parseCoordinationToolResult(await callTool('dolt_push_mutex', args), '[dolt-mutex/mcp]');
    }

    return {
        async acquire(sprintId, o = {}) {
            const id = sprintId || boundSprintId;
            if (!id) throw new Error('[dolt-mutex/mcp] acquire requires a sprintId');
            const deadline = Date.now() + timeoutMs;
            let payload = await call({ action: 'acquire', sprint_id: id, pid: o.pid ?? undefined, wait_ms: waitMs });
            while (!payload.granted) {
                if (Date.now() >= deadline) {
                    try { await call({ action: 'cancel', ticket: payload.ticket }); } catch { /* best effort */ }
                    throw new Error(`[dolt-mutex/mcp] timed out after ${timeoutMs} ms waiting for the push mutex (sprint '${id}')`);
                }
                log(`[dolt-mutex/mcp] waiting for the global push mutex (sprint '${id}', ticket ${payload.ticket})`);
                payload = await call({ action: 'poll', ticket: payload.ticket, wait_ms: waitMs });
            }
            return { token: payload.token ?? null, sprintId: id, expiresAt: payload.expiresAt };
        },
        async release(token) {
            if (token == null) return true;
            try {
                const payload = await call({ action: 'release', token });
                return Boolean(payload.released);
            } catch (err) {
                // Non-fatal: the holder's lease expiry reclaims the mutex even
                // if this release never lands (same posture as the HTTP client).
                log(`[dolt-mutex/mcp] release failed (non-fatal; lease will expire): ${err.message}`);
                return false;
            }
        },
        // Same lease-renewal contract as the HTTP client above (design doc
        // Part 3.4); the fleet tool exposes action 'renew'.
        async renew(token) {
            if (token == null) return false;
            try {
                const payload = await call({ action: 'renew', token });
                return Boolean(payload.renewed);
            } catch (err) {
                log(`[dolt-mutex/mcp] renew failed (non-fatal; the lease may expire): ${err.message}`);
                return false;
            }
        },
    };
}

/**
 * MCP-transport counterpart to createHttpChildIdAllocatorClient above, for the
 * SUPERVISOR-LESS topology. Speaks the fleet server's own
 * `child_id_allocator` tool (src/tools/child-id-allocator.ts); same rationale,
 * same inline-implementation constraint, and the same { allocate, confirm,
 * release } surface the bead-creation path already calls.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, sprintId?: string, log?: Function }} opts
 * @returns {{ allocate: Function, confirm: Function, release: Function }}
 */
export function createMcpChildIdAllocatorClient(opts = {}) {
    const { callTool, sprintId: boundSprintId, log = () => {} } = opts;
    if (typeof callTool !== 'function') throw new Error('createMcpChildIdAllocatorClient requires a callTool function');

    async function call(args) {
        return parseCoordinationToolResult(await callTool('child_id_allocator', args), '[id-allocator/mcp]');
    }

    return {
        async allocate(parentId, o = {}) {
            if (!parentId) throw new Error('[id-allocator/mcp] allocate requires a parentId');
            const payload = await call({
                action: 'allocate',
                parent_id: parentId,
                pid: o.pid ?? undefined,
                sprint_id: o.sprintId ?? boundSprintId ?? undefined,
                floor: o.floor,
            });
            return { childId: payload.childId ?? null, seq: payload.seq, token: payload.token ?? null, expiresAt: payload.expiresAt };
        },
        async confirm(token) {
            if (token == null) return true;
            try {
                const payload = await call({ action: 'confirm', token });
                return Boolean(payload.confirmed);
            } catch (err) {
                log(`[id-allocator/mcp] confirm failed (non-fatal; lease will expire): ${err.message}`);
                return false;
            }
        },
        async release(token) {
            if (token == null) return true;
            try {
                const payload = await call({ action: 'release', token });
                return Boolean(payload.released);
            } catch (err) {
                log(`[id-allocator/mcp] release failed (non-fatal; lease will expire): ${err.message}`);
                return false;
            }
        },
    };
}

/**
 * Reserves and releases every sprint member against the fleet server's OWN
 * per-member reservation record (the `member_reservation` tool), so that a
 * sprint launched directly from the CLI -- never routed through the
 * supervisor, and so absent from its ledger -- is still visible to
 * execute_prompt's dispatch-time reservedBy check and to the supervisor's
 * overlap guard.
 *
 * `callTool` is injected (the caller's MCP client) so this stays
 * transport-agnostic and unit-testable without a live fleet server.
 * Deliberately NOT built on the supervisor's HTTP routes, unlike the
 * dolt-mutex/id-allocator clients above: `member_reservation` lives on the
 * fleet MCP server every launch path already connects to, whereas the
 * supervisor is optional and unwired for direct CLI launches.
 *
 * `sprintId` should be the SAME opaque identity used for the dolt push mutex
 * and child-id allocator -- opaque and target-agnostic, with no assumption
 * about which repo the sprint develops.
 *
 * Reserve/release are BEST-EFFORT per member: a failure (transport error, or
 * the tool's own "already reserved by X" rejection) is logged and does NOT
 * throw. That is safe because execute_prompt independently rejects any
 * dispatch to a member this sprint failed to reserve, so an unreserved member
 * fails loudly at its first dispatch rather than silently interleaving with
 * another sprint.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, members?: string[], sprintId?: string, log?: Function }} opts
 * @returns {{ reserveAll: () => Promise<void>, releaseAll: () => Promise<void> }}
 */
/**
 * apra-fleet-e28 / KB trust pipeline Phase 2: KB priming for the fleet-sprint
 * engine, which had none -- it lived only in the Claude workflow copy.
 *
 * `callTool` is injected exactly like `createMemberReservationClient`'s, so this
 * stays transport-agnostic and unit-testable without a live fleet server.
 *
 * WHY PER MEMBER, NOT PER SPRINT: this engine has no repo path of its own. It
 * coordinates members by name and branch; the repo lives on each member's side,
 * possibly on a different host at a different path. `kb_session_prime` selects
 * WHICH project KB is read from its `repo_path`, and omitting that argument
 * falls back to the fleet server's own cwd -- collapsing every member's
 * knowledge into whichever repo the server happens to sit in, which is exactly
 * the apra-fleet-tm7 / apra-fleet-3zl repo-blindness defect. So the work folder
 * is resolved per member via `member_detail` (which reports it as `folder`) and
 * each member is primed against its own repo.
 *
 * Best-effort throughout, matching the reservation client's precedent: a member
 * whose folder cannot be resolved, or whose prime call fails, is logged and
 * skipped. A sprint must not fail because the KB is cold -- priming is an
 * optimisation, and every role contract's Step 0 already degrades gracefully
 * when the KB tools are unavailable.
 *
 * @param {{ callTool?: (name: string, args: object) => Promise<any>, members?: string[], log?: Function }} opts
 * @returns {{ primeAll: () => Promise<{primed: number, skipped: number}> }}
 */
/**
 * Cap on primed entries carried into a dispatch prompt. kb_session_prime can
 * return up to ~28 (10 direct FTS hits + 3 global + 5 graph-neighbour + 5
 * project-bible + 5 global-bible); a dispatch prompt is not a place to spend
 * that much budget on context the role may not need, and the entries are
 * already returned in relevance order.
 */
export const KB_MAX_KNOWLEDGE_ENTRIES = 12;

/**
 * The URL-based KB scope selector, spread into a kb_* call's arguments.
 *
 * repo_path alone is only sufficient for a LOCAL member: resolveProjectSlug
 * (src/services/knowledge/project-slug.ts) runs git in that directory to derive
 * the project slug. A remote member's work folder is a path on another host, so
 * both git probes fail and the slug degrades to 'default' -- collapsing every
 * remote member's knowledge into one shared KB. repo_remote_url selects the DB
 * directly (apra-fleet-b4g.1) and is what makes a sprint's kb_* calls land in
 * the member's own project KB.
 *
 * Absent when no URL is known: an omitted scope is the honest pre-existing
 * degradation, while a fabricated one routes writes into a slug that does not
 * match the repo's real local-clone slug. The engine never derives a URL -- it
 * forwards only what member_detail reports (knownRepoRemoteUrl's rule).
 */
function kbScope(remoteUrl) {
    return (typeof remoteUrl === 'string' && remoteUrl.length > 0) ? { repo_remote_url: remoteUrl } : {};
}

export function createKbPrimingClient(opts = {}) {
    const { callTool, members = [], log = () => {} } = opts;
    const active = typeof callTool === 'function' && members.length > 0;

    function parseResult(result) {
        if (result && typeof result === 'string') { try { return JSON.parse(result); } catch { return null; } }
        if (result && Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string') {
            try { return JSON.parse(result.content[0].text); } catch { return null; }
        }
        return (result && typeof result === 'object') ? result : null;
    }

    async function scopeFor(member) {
        // apra-fleet-n78: format:'json' is REQUIRED. member_detail defaults to
        // 'compact', whose renderer emits no folder at all -- `folder` is set only
        // on the json path (src/tools/member-detail.ts). Omitting it made this
        // return null for every member, so the KB was never primed for anyone.
        const detail = parseResult(await callTool('member_detail', { member_name: member, format: 'json' }));
        // member_detail reports the work folder as `folder` and the repo origin
        // URL as `repo_remote_url` (src/tools/member-detail.ts). The URL is
        // reported only when the member's registration record proves it, so an
        // absent one is normal and must stay absent rather than be derived here.
        const folder = detail && (detail.folder || (detail.member && detail.member.folder));
        const url = detail && (detail.repo_remote_url || (detail.member && detail.member.repo_remote_url));
        return {
            folder: (typeof folder === 'string' && folder.length > 0) ? folder : null,
            remoteUrl: (typeof url === 'string' && url.length > 0) ? url : null,
        };
    }

    // member -> work folder, populated by primeAll(). createKbWorkClient reads
    // it so a capture lands in the repo the member actually worked in, rather
    // than being resolved against the fleet server's cwd.
    const folders = new Map();

    // member -> the repo origin URL member_detail reported for it, when it
    // reported one. This is what scopes a REMOTE member's kb_* calls to its own
    // project KB instead of the shared 'default' one (see kbScope).
    const remoteUrls = new Map();

    // work folder -> that folder's origin URL, or CONFLICTING_URL when two
    // members claim the same path string for DIFFERENT repos. The work client
    // resolves its scope through this map rather than taking the URL as an
    // extra argument at each of its nine call sites: threading the repo path is
    // then the same act as threading the scope, so a site cannot forget one
    // while remembering the other.
    const urlByFolder = new Map();
    const CONFLICTING_URL = Symbol('conflicting-remote-url');

    // member -> the entries kb_session_prime returned for that member.
    //
    // KB audit 2026-08-11: primeAll() used to `await callTool(...)` and throw
    // the result away, on the assumption that priming "warms" something the
    // role's own Step 0 would later read. It does not: prime is a pure read,
    // and the role CANNOT repeat it -- a member-dispatched subagent has the
    // fleet MCP server disabled (src/providers/claude.ts
    // composePermissionConfig), so every contract's Step 0 kb_session_prime is
    // unreachable there. Nothing consumed the knowledge and nothing could, which
    // is why six sprints retrieved zero entries. Retaining the result is what
    // lets kbKnowledgeBlock() hand it to the role in its dispatch prompt --
    // the same shape of fix that made kb_promotions reachable.
    const knowledge = new Map();

    return {
        folderOf(member) {
            return folders.get(member) || null;
        },
        remoteUrlOf(member) {
            return remoteUrls.get(member) || null;
        },
        /**
         * The URL scoping kb_* calls made against `repoPath`, or null.
         *
         * Null for an unknown path, for a local member (no URL was reported),
         * and for a path two members claim with different URLs. Members on
         * different hosts can share a work-folder path string while being
         * clones of different repos; picking either URL there would route one
         * member's captures into the other's KB, which is strictly worse than
         * the 'default' degradation this scoping exists to remove. Refusing
         * leaves that case exactly as it was before.
         */
        remoteUrlForPath(repoPath) {
            if (typeof repoPath !== 'string' || repoPath.length === 0) return null;
            const url = urlByFolder.get(repoPath);
            return (typeof url === 'string') ? url : null;
        },
        knowledgeOf(member) {
            return knowledge.get(member) || [];
        },
        async primeAll() {
            if (!active) return { primed: 0, skipped: members.length };
            let primed = 0;
            let skipped = 0;
            for (const member of members) {
                try {
                    const { folder: repoPath, remoteUrl } = await scopeFor(member);
                    if (repoPath) folders.set(member, repoPath);
                    if (remoteUrl) remoteUrls.set(member, remoteUrl);
                    if (repoPath && remoteUrl) {
                        const known = urlByFolder.get(repoPath);
                        if (known !== undefined && known !== remoteUrl) {
                            urlByFolder.set(repoPath, CONFLICTING_URL);
                            log(`[kb-prime] work folder ${repoPath} is claimed by two different repos -- KB calls for it stay unscoped`);
                        } else {
                            urlByFolder.set(repoPath, remoteUrl);
                        }
                    }
                    if (!repoPath) {
                        // No folder means no repo to scope the KB to. Priming without
                        // one would read the fleet server's own KB, so skip instead.
                        log(`[kb-prime] no work folder for member '${member}' -- skipping (KB stays cold)`);
                        skipped++;
                        continue;
                    }
                    // Land the committed bible in the WARM KB before priming.
                    //
                    // Without this the bible is reachable only through
                    // kb_session_prime's cold-seed, which reads it as a FILE
                    // and caps at 5 entries -- apra-fleet's own bible holds 17,
                    // so a sprint could see at most 5 arbitrary ones and FTS
                    // could rank none of them, because they were never rows.
                    // Importing first is what gives the per-dispatch kb_query
                    // (see relevantKnowledge) anything to match against.
                    // Idempotent by id, and best-effort: a repo with no bible,
                    // or an import that rejects every entry, must not stop the
                    // prime it was meant to feed.
                    //
                    // skip_sweep IS LOAD-BEARING (audit 2026-08-12, caught by a
                    // live sprint). kb_import's post-import freshnessSweep
                    // re-judges the ENTIRE KB against this member's worktree. At
                    // sprint start that staled 16 of 17 CONFIRMED entries purely
                    // because the repo had moved on since capture, and the
                    // damage cascaded: retrieval fell to one matchable entry,
                    // kb_export attempted a 17 -> 9 bible truncation, and
                    // kb_list (stale=0) returned an EMPTY promotion candidate
                    // list -- reinstating apra-fleet-0ef, "kb_promote can never
                    // fire". This import exists to WARM the KB, never to audit
                    // it; prime()'s own bounded checkFreshness still guards each
                    // entry it actually returns.
                    try {
                        const imported = parseResult(await callTool('kb_import', { repo_path: repoPath, ...kbScope(remoteUrl), skip_sweep: true }));
                        if (imported && typeof imported.imported === 'number' && imported.imported > 0) {
                            log(`[kb-prime] imported ${imported.imported} bible entr(ies) into the warm KB for ${repoPath}`);
                        }
                    } catch (err) {
                        log(`[kb-prime] kb_import skipped for ${repoPath} (non-fatal): ${err.message}`);
                    }

                    const primeResult = parseResult(await callTool('kb_session_prime', { repo_path: repoPath, ...kbScope(remoteUrl) }));
                    const entries = (primeResult && Array.isArray(primeResult.top_entries))
                        ? primeResult.top_entries.filter((e) => e && typeof e.id === 'string')
                        : [];
                    if (entries.length > 0) knowledge.set(member, entries.slice(0, KB_MAX_KNOWLEDGE_ENTRIES));
                    primed++;
                } catch (err) {
                    log(`[kb-prime] failed for member '${member}' (non-fatal): ${err.message}`);
                    skipped++;
                }
            }
            if (primed > 0) log(`[kb-prime] primed ${primed} member repo(s)`);
            return { primed, skipped };
        },
    };
}

/**
 * KB trust pipeline Phase 2, execution half for this engine.
 *
 * The role output schemas are SHARED with apra-pm (contracts.mjs loads them from
 * apra-pm/agents/schemas), so every role dispatched here is now asked for
 * kb_captures, and the reviewer for kb_promotions. Without a consumer those
 * fields would be silently dropped -- the knowledge would be gathered and
 * thrown away. This is that consumer.
 *
 * Unlike apra-pm's auto-sprint.js -- a Claude Workflow script with no tool
 * access, which must hand its vetted payload to an executor subagent -- this
 * engine runs in-process with an injected callTool, so it makes the kb_capture
 * and kb_promote calls DIRECTLY. Judgment still belongs to the role; execution
 * belongs here.
 *
 * Validation mirrors lib/vet-kb-work.mjs in apra-pm and the provider invariants
 * it reflects: a capture must cite at least one source file (SqliteProvider
 * rejects an entry the freshness sweep can never stale), a promotion needs a
 * recorded evidence string, and kb_promotions is refused from any role other
 * than reviewer -- widening capture to four roles must not widen promotion.
 *
 * @param {{ callTool?: (name: string, args: object) => Promise<any>, log?: Function }} opts
 * @returns {{ apply: (role: string, repoPath: string, result: any) => Promise<{captured: number, promoted: number, refused: number}> }}
 */
export const KB_PROMOTER_ROLES = Object.freeze(new Set([ROLE_REVIEWER]));
export const KB_MIN_PROMOTE_REASON = 20;
export const KB_CAPTURE_TYPES = Object.freeze(['knowledge', 'learning', 'runbook']);

/**
 * True when an MCP tool result represents a tool-level failure. The MCP client
 * resolves such results instead of throwing (apra-fleet-23c), so callers that
 * only catch exceptions silently treat failures as successes.
 */
function isToolError(res) {
    return !!(res && typeof res === 'object' && res.isError === true);
}

/** Best-effort human-readable text out of an MCP error result, for logging. */
function toolErrorText(res) {
    const first = res && Array.isArray(res.content) ? res.content[0] : null;
    return (first && typeof first.text === 'string' && first.text) || 'no error text returned';
}

export function vetKbWork(role, result) {
    const captures = [];
    const promotions = [];
    const refused = [];

    const rawCaptures = (result && Array.isArray(result.kb_captures)) ? result.kb_captures : [];
    for (const c of rawCaptures) {
        if (!c || typeof c.title !== 'string' || typeof c.summary !== 'string') {
            refused.push(`${role}: capture missing title/summary`);
            continue;
        }
        if (!Array.isArray(c.source_files) || c.source_files.length === 0) {
            refused.push(`${role}: capture "${c.title}" cites no source files`);
            continue;
        }
        if (!KB_CAPTURE_TYPES.includes(c.type)) {
            refused.push(`${role}: capture "${c.title}" has unsupported type ${String(c.type)}`);
            continue;
        }
        // apra-fleet-23c: kbCaptureSchema requires content (z.string().min(1)).
        // Omitting it here meant every kb_capture the engine sent failed zod
        // validation at the MCP boundary and persisted nothing.
        if (typeof c.content !== 'string' || c.content.trim().length === 0) {
            refused.push(`${role}: capture "${c.title}" has no content`);
            continue;
        }
        captures.push({
            type: c.type,
            title: c.title,
            summary: c.summary,
            content: c.content,
            source_files: c.source_files,
            symbols: Array.isArray(c.symbols) ? c.symbols : [],
        });
    }

    const rawPromotions = (result && Array.isArray(result.kb_promotions)) ? result.kb_promotions : [];
    if (rawPromotions.length > 0 && !KB_PROMOTER_ROLES.has(role)) {
        refused.push(`${role}: kb_promotions refused -- promotion is reviewer-only`);
    } else {
        for (const p of rawPromotions) {
            if (!p || typeof p.id !== 'string' || p.id.length === 0) {
                refused.push(`${role}: promotion missing id`);
                continue;
            }
            if (typeof p.reason !== 'string' || p.reason.trim().length < KB_MIN_PROMOTE_REASON) {
                refused.push(`${role}: promotion ${p.id} has no recorded evidence`);
                continue;
            }
            promotions.push({ id: p.id, reason: p.reason.trim() });
        }
    }

    return { captures, promotions, refused };
}

/** Max promotion candidates offered to one reviewer, so the prompt stays bounded. */
export const KB_MAX_PROMOTION_CANDIDATES = 40;

export function createKbWorkClient(opts = {}) {
    const { callTool, log = () => {}, remoteUrlFor } = opts;
    const active = typeof callTool === 'function';

    /**
     * The URL-based KB scope for a repo path, resolved through the injected
     * lookup (createKbPrimingClient's remoteUrlForPath). Deliberately NOT an
     * extra parameter on the methods below: they are called from nine places
     * across runSprintCycle/finalReview/harvest, and an omitted argument is
     * indistinguishable from "no URL known" -- it would silently reinstate the
     * repo-blindness this exists to fix. With no lookup injected (every
     * construction site predating this, and direct unit calls) the scope is
     * absent and behaviour is exactly as before.
     */
    function scopeOf(repoPath) {
        return kbScope(typeof remoteUrlFor === 'function' ? remoteUrlFor(repoPath) : null);
    }

    /** Best-effort JSON out of an MCP result (string, content-block, or plain object). */
    function parseResult(result) {
        if (typeof result === 'string') { try { return JSON.parse(result); } catch { return null; } }
        if (result && Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string') {
            try { return JSON.parse(result.content[0].text); } catch { return null; }
        }
        return (result && typeof result === 'object') ? result : null;
    }

    return {
        /**
         * apra-fleet-0ef: the INFERRED entries this reviewer may promote.
         *
         * The engine's contract is "judgment belongs to the role, execution
         * belongs here" -- the reviewer returns `kb_promotions:[{id, reason}]`
         * and `apply()` calls kb_promote. But an entry id exists only inside
         * the KB, and the reviewer subagent has no apra-fleet MCP tools to
         * look one up, so it could never name an id: `kb_promotions` was
         * structurally always empty and nothing was ever promoted. (kb_captures
         * worked only because a capture needs no pre-existing id.) This is the
         * missing input: the engine reads the candidates and hands them to the
         * reviewer in its prompt.
         *
         * Best-effort by design -- a cold or unreachable KB must degrade to
         * "nothing to promote", never fail the review dispatch.
         */
        async promotionCandidates(repoPath) {
            // Without a repo path kb_list would resolve against the fleet
            // server's cwd and offer entries from an unrelated project's KB
            // (the apra-fleet-tm7 repo-blindness class). Refuse rather than guess.
            if (!active || !repoPath) return [];
            try {
                const parsed = parseResult(await callTool('kb_list', {
                    repo_path: repoPath,
                    ...scopeOf(repoPath),
                    confidence: 'INFERRED',
                    limit: KB_MAX_PROMOTION_CANDIDATES,
                }));
                const results = parsed && Array.isArray(parsed.results) ? parsed.results : [];
                return results
                    // promote() refuses type='user-directive' outright (activation
                    // is human-terminal, CLI-only), so offering one as a candidate
                    // can only produce a guaranteed refusal.
                    .filter((e) => e && typeof e.id === 'string' && e.type !== 'user-directive')
                    .slice(0, KB_MAX_PROMOTION_CANDIDATES);
            } catch (err) {
                log(`[kb-work] could not list promotion candidates for ${repoPath} (non-fatal): ${err.message}`);
                return [];
            }
        },
        /**
         * KB audit follow-up: the per-dispatch, relevance-ranked read.
         *
         * primeAll() runs ONCE per member at sprint start with no hints, so
         * every role received the same handful of entries no matter what it was
         * about to work on -- and kb_query went unused by this engine entirely.
         * This asks the KB what it knows about THIS dispatch, using the terms
         * the engine already holds (bead ids and their titles).
         *
         * `expand_related` is what finally reads the KB's own graph. The KB has
         * been writing `refines` and `contradiction_of` edges since AUDN
         * shipped and traversing none of them: 554 edges, 0 reads. A role about
         * to act on an entry is precisely who needs to know that entry has a
         * newer framing or a standing dispute -- especially since confidence
         * tier does NOT track correctness across a contradiction chain (the
         * warehouse chain-A shape, where the incorrect entry outranks both of
         * its corrections).
         *
         * Best-effort, like every other KB read here: no repo path, no terms, a
         * cold KB or an unreachable one all degrade to "no knowledge", never to
         * a failed dispatch.
         */
        async relevantKnowledge(repoPath, terms) {
            if (!active || !repoPath || !Array.isArray(terms) || terms.length === 0) return [];
            const query = terms.filter((t) => typeof t === 'string' && t.trim()).join(' ');
            if (!query) return [];
            try {
                const parsed = parseResult(await callTool('kb_query', {
                    repo_path: repoPath,
                    ...scopeOf(repoPath),
                    query,
                    limit: KB_MAX_KNOWLEDGE_ENTRIES,
                    expand_related: true,
                }));
                if (!parsed) return [];
                const hits = Array.isArray(parsed.l1_results) ? parsed.l1_results : [];
                const related = Array.isArray(parsed.related_claims) ? parsed.related_claims : [];
                const seen = new Set();
                const out = [];
                for (const e of hits) {
                    if (!e || typeof e.id !== 'string' || seen.has(e.id)) continue;
                    seen.add(e.id);
                    out.push(e);
                }
                // Related claims sit BELOW every direct hit and carry a marker,
                // so a role can tell "the KB matched this" from "the KB says
                // something about what it matched".
                for (const e of related) {
                    if (!e || typeof e.id !== 'string' || seen.has(e.id)) continue;
                    seen.add(e.id);
                    out.push({ ...e, via: 'kb-graph' });
                }
                return out.slice(0, KB_MAX_KNOWLEDGE_ENTRIES);
            } catch (err) {
                log(`[kb-work] kb_query failed for ${repoPath} (non-fatal): ${err.message}`);
                return [];
            }
        },
        async apply(role, repoPath, result) {
            const { captures, promotions, refused } = vetKbWork(role, result);

            for (const r of refused) log(`[kb-work] refused -- ${r}`);
            // Log every promotion with its stated evidence BEFORE attempting it.
            // This log is the audit trail the bible never had.
            for (const p of promotions) log(`[kb-work] promote ${p.id} (${role}): ${p.reason}`);

            // Without a repo path a capture would land in whichever KB the fleet
            // server's cwd resolves to -- the tm7 defect. Refuse rather than guess.
            if (!active || !repoPath) {
                if ((captures.length || promotions.length) && !repoPath) {
                    log(`[kb-work] no repo path for ${role} -- ${captures.length} capture(s) and ${promotions.length} promotion(s) dropped`);
                }
                return { captured: 0, promoted: 0, refused: refused.length };
            }

            let captured = 0;
            let promoted = 0;
            for (const c of captures) {
                try {
                    const res = await callTool('kb_capture', { ...c, repo_path: repoPath, ...scopeOf(repoPath) });
                    // apra-fleet-23c: an MCP client RESOLVES with {isError:true} on a
                    // tool-level failure rather than throwing, so counting every
                    // non-throwing call as a success reported captures that never
                    // persisted ("captured 3" against a KB that stayed empty).
                    if (isToolError(res)) {
                        log(`[kb-work] kb_capture rejected for "${c.title}" (non-fatal): ${toolErrorText(res)}`);
                        continue;
                    }
                    captured++;
                } catch (err) {
                    log(`[kb-work] kb_capture failed for "${c.title}" (non-fatal): ${err.message}`);
                }
            }
            for (const p of promotions) {
                try {
                    // apra-fleet-0ef: repo_path is REQUIRED here, exactly as on
                    // the kb_capture call above. Omitting it resolved the
                    // promotion against the fleet server's cwd -- a different
                    // project's KB, where the id does not exist -- so every
                    // promotion would have failed "Entry not found" (the
                    // apra-fleet-tm7 repo-blindness class, fixed for capture
                    // but missed here).
                    const res = await callTool('kb_promote', { id: p.id, reason: p.reason, repo_path: repoPath, ...scopeOf(repoPath) });
                    if (isToolError(res)) {
                        log(`[kb-work] kb_promote rejected for ${p.id} (non-fatal): ${toolErrorText(res)}`);
                        continue;
                    }
                    promoted++;
                } catch (err) {
                    log(`[kb-work] kb_promote failed for ${p.id} (non-fatal): ${err.message}`);
                }
            }
            if (captured || promoted) log(`[kb-work] ${role}: captured ${captured}, promoted ${promoted}`);
            return { captured, promoted, refused: refused.length };
        },

        /**
         * KB audit 2026-08-11: publish this repo's CONFIRMED set to its
         * canonical bible (<repo>/.fleet/kb-canonical.json).
         *
         * Nothing in the pipeline had ever called kb_export, so a bible existed
         * only where an operator had run the tool by hand -- 1 of 17 repos on
         * the audited machine. Promotion therefore ended at the local sqlite
         * store: a teammate, a fresh clone, or a member on another host saw
         * none of it, and kb_session_prime's cold-seed (which reads exactly
         * this file) had nothing to fall back on. Promotion is the sprint's
         * work; publishing it is the step that makes the work leave the
         * machine.
         *
         * Called once, AFTER the final review's promotions have been applied,
         * so the bible reflects everything this sprint confirmed. Best-effort
         * like every other KB call here: a sprint must never fail over an
         * export, and the tool itself is a no-op when the entry set is
         * unchanged. Committing/pushing the file stays a separate, opt-in
         * decision (kb_export's own autoCommit config) -- this does not widen
         * the engine's git authority.
         */
        async exportBible(repoPath) {
            // Same repo-blindness guard as every other call here: without a
            // path kb_export would resolve against the fleet server's cwd and
            // write an unrelated project's bible.
            if (!active || !repoPath) return false;
            try {
                const res = await callTool('kb_export', { repo_path: repoPath, ...scopeOf(repoPath) });
                if (isToolError(res)) {
                    log(`[kb-work] kb_export rejected for ${repoPath} (non-fatal): ${toolErrorText(res)}`);
                    return false;
                }
                log(`[kb-work] exported the canonical bible for ${repoPath}`);
                return true;
            } catch (err) {
                log(`[kb-work] kb_export failed for ${repoPath} (non-fatal): ${err.message}`);
                return false;
            }
        },
    };
}

export function createMemberReservationClient(opts = {}) {
    const { callTool, members = [], sprintId, log = () => {} } = opts;
    const active = typeof callTool === 'function' && typeof sprintId === 'string' && sprintId.length > 0 && members.length > 0;

    function resultText(result) {
        if (typeof result === 'string') return result;
        if (result && Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string') {
            return result.content[0].text;
        }
        return '';
    }

    async function callFor(action, member) {
        try {
            const result = await callTool('member_reservation', { member_name: member, action, sprint_id: sprintId });
            const text = resultText(result);
            if ((result && result.isError) || text.startsWith('[-]')) {
                log(`[member-reservation] ${action} rejected for member '${member}': ${text || '(no detail)'}`);
            }
        } catch (err) {
            log(`[member-reservation] ${action} failed for member '${member}' (non-fatal; execute_prompt's dispatch-time reservedBy check still applies): ${err.message}`);
        }
    }

    return {
        async reserveAll() {
            if (!active) return;
            for (const member of members) await callFor('reserve', member);
        },
        async releaseAll() {
            if (!active) return;
            for (const member of members) await callFor('release', member);
        },
    };
}

/**
 * Guards every "resume" re-dispatch below against spawning a second
 * concurrent session on a member whose PRIOR process for that same logical
 * dispatch is presumed dead or timed out but may still be alive -- two live
 * sessions for one dispatch duplicate whatever side effects the orphaned one
 * performs.
 *
 * Before firing a resume, call the fleet's own `stop_prompt` tool
 * (src/tools/stop-prompt.ts) for that member: it kills whatever process is
 * still on record and is a no-op when nothing is running, so pid liveness is
 * never reimplemented here.
 *
 * `callTool` is injected (the caller's MCP client), so this stays
 * transport-agnostic and unit-testable without a live fleet server. When it
 * is omitted, `killIfAlive()` is a no-op -- there is no live fleet connection
 * to guard against, matching every other best-effort client in this file when
 * its transport is absent.
 *
 * Best-effort by design: a `stop_prompt` failure is logged and swallowed
 * rather than blocking the resume -- the resume is what the sprint needs to
 * make progress, and this guard REDUCES rather than gates the chance of a
 * duplicate concurrent session.
 *
 * @param {{ callTool?: (name: string, args: object) => Promise<any>, log?: Function }} opts
 * @returns {{ killIfAlive: (member: string) => Promise<void> }}
 */
export function createMemberSessionGuard(opts = {}) {
    const { callTool, log = () => {} } = opts;
    const active = typeof callTool === 'function';

    function resultText(result) {
        if (typeof result === 'string') return result;
        if (result && Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string') {
            return result.content[0].text;
        }
        return '';
    }

    return {
        async killIfAlive(member) {
            if (!active || !member) return;
            try {
                const result = await callTool('stop_prompt', { member_name: member });
                log(`[member-session-guard] pre-resume stop_prompt for '${member}': ${resultText(result) || '(no detail)'}`);
            } catch (err) {
                log(`[member-session-guard] pre-resume stop_prompt for '${member}' failed (non-fatal; resume proceeds): ${err.message}`);
            }
        },
    };
}

/**
 * Best-effort, GENERIC extraction of an "owner/repo" string from a git remote
 * URL (https, scp-like git@host:owner/repo(.git), or ssh://). Deliberately
 * target-agnostic: fleet-sprint develops many different repos, so the `repos`
 * argument passed to provision_vcs_auth must be DERIVED at runtime from the
 * member's own git remote, never hardcoded to a literal repo name. Returns
 * null on anything unrecognized so the caller can omit `repos` (optional
 * server-side) rather than guess.
 *
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
export function parseOwnerRepoFromRemoteUrl(url) {
    const text = String(url == null ? '' : url).trim();
    if (!text) return null;
    let m = text.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+?)(\.git)?\/?$/i);
    if (m) return `${m[1]}/${m[2]}`;
    m = text.match(/^ssh:\/\/[^@/]+@[^/]+\/([^/]+)\/([^/]+?)(\.git)?\/?$/i);
    if (m) return `${m[1]}/${m[2]}`;
    // scp-like syntax, e.g. git@github.com:owner/repo.git
    m = text.match(/^[\w.-]+@[^:]+:([^/]+)\/([^/]+?)(\.git)?\/?$/i);
    if (m) return `${m[1]}/${m[2]}`;
    return null;
}

// Shared MCP tool-result-to-text extractor for the self-heal callbacks below.
// The provision_* tools do not throw on failure: they return plain
// human-readable text with a leading status emoji (check mark = success,
// warning sign = warning, cross mark = failure), and some failure strings
// carry no prefix at all -- so the callbacks must inspect the text.
function selfHealResultText(result) {
    if (typeof result === 'string') return result;
    if (result && Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string') {
        return result.content[0].text;
    }
    return '';
}

// Shared provisioning core used by BOTH the REACTIVE onAuthFailure self-heal
// (createVcsAuthSelfHealCallback) and the PROACTIVE preflight
// (createVcsAuthPreflightCallback) -- one call shape, one owner/repo
// derivation, one success/failure text-parsing rule, so the two paths can
// never drift on what "provisioned" means.
//
// Returns the newly-provisioned credential's `expiresAt` (a Date, or null
// when the response carries no expiry metadata -- PAT-mode credentials never
// expire) so a caller can cache it and skip a future redundant call.
//
// `gitAccess` defaults to 'push' -- the shared self-heal/preflight callers
// below NEVER override it. The only callers permitted to pass a higher
// level ('push+pr') are the two PR-raising call sites (Publish PR,
// finalizeAbort), each via provisionPrCapableAuthForMember, invoked
// immediately before their PR-creation dispatch -- never at sprint setup,
// never from this shared self-heal/preflight path. See apra-fleet-tfx.8 and
// the just-in-time credential-scoping ADR (docs/adr-server-never-acts-on-repo.md)
// for the rogue-dispatch blast-radius rationale: widening this default would
// give every member standing pull_requests:write for the whole sprint.
// @param {{ fleetApi: object, command: Function, member: string, log?: Function, logPrefix: string, gitAccess?: string }} opts
// @returns {Promise<{ expiresAt: Date|null, repo: string|null }>}
async function provisionVcsAuthForMember({ fleetApi, command, member, log = () => {}, logPrefix, gitAccess = 'push' }) {
    let repos;
    let derivedRepo = null;
    try {
        const remoteRes = await command('git remote get-url origin', { member_name: member, silent: true, failSoft: true });
        const url = remoteRes && remoteRes.ok ? String(remoteRes.output || '').trim() : '';
        const repo = parseOwnerRepoFromRemoteUrl(url);
        if (repo) {
            repos = [repo];
            derivedRepo = repo;
        } else {
            log(`${logPrefix}: could not derive an owner/repo from member '${member}' git remote (raw: '${url}'); calling provision_vcs_auth without an explicit repos scope.`);
        }
    } catch (remoteErr) {
        log(`${logPrefix}: failed to read member '${member}' git remote to derive 'repos' (continuing without an explicit repos scope): ${remoteErr.message}`);
    }

    // apra-fleet-647.1.2.1: provider and auth-mode are resolved from the
    // member's own persisted vcsProvider (VCSModule.resolveProvider), never
    // hardcoded here -- resolveProvider throws its own typed "ERROR:" for a
    // member with no registered provider rather than silently defaulting to
    // GitHub. `authMode` is provider-owned (github: 'github-app'; other
    // providers: null, no separate mode axis) and is only forwarded as
    // `<provider>_mode` when non-null, matching provision_vcs_auth's own
    // `github_mode` field name for the one provider that has one today.
    const { provider, authMode } = await resolveProvider(member, { fleetApi });
    const provisionRes = await fleetApi.provisionVcsAuth({
        member_name: member,
        provider,
        ...(authMode ? { [`${provider}_mode`]: authMode } : {}),
        git_access: gitAccess,
        ...(repos ? { repos } : {}),
    });
    const provisionText = selfHealResultText(provisionRes);
    // provision_vcs_auth NEVER throws on failure -- it returns a string
    // starting with the failure emoji. A failed provision must never be
    // allowed to report success: doing so burns the one-shot self-heal and
    // logs a lie.
    if ((provisionRes && provisionRes.isError) || /^âŒ/.test(provisionText.trim())) {
        throw new Error(`provision_vcs_auth failed for member '${member}': ${provisionText || '(no detail)'}`);
    }

    return { expiresAt: parseExpiresAtFromProvisionText(provisionText), repo: derivedRepo };
}

// Narrowly-scoped, PR-capable provisioning. This is the ONLY call path in
// runner.js permitted to request git_access: 'push+pr' -- callers must be
// exactly the two PR-raising call sites (Publish PR, finalizeAbort), invoked
// immediately before their PR-creation dispatch, never at sprint setup and
// never from the shared self-heal/preflight path above (which always stays
// on 'push'). See the just-in-time credential-scoping rationale on
// provisionVcsAuthForMember above.
//
// Also returns the 'owner/repo' this call derived from the member's own git
// remote (same derivation provisionVcsAuthForMember already performs to
// scope the mint) -- reusing it here means the PR-raising call sites never
// need a SECOND `git remote get-url origin` dispatch of their own just to
// learn the repo VCSModule needs to build the PR-creation command.
// @param {{ fleetApi: object, command: Function, member: string, log?: Function, logPrefix: string }} opts
// @returns {Promise<{ expiresAt: Date|null, repo: string|null }>}
async function provisionPrCapableAuthForMember({ fleetApi, command, member, log = () => {}, logPrefix }) {
    return provisionVcsAuthForMember({ fleetApi, command, member, log, logPrefix, gitAccess: 'push+pr' });
}

// Default credential label provision_vcs_auth deploys under when no explicit
// `label` is passed (src/tools/provision-vcs-auth.ts: `label = input.label ??
// input.provider`) -- the PR-raising call sites never pass a label either, so
// the deployed git-credential-helper file is always
// $HOME/.fleet-git-credential-github for the 'github' provider on POSIX
// (src/os/linux.ts gitCredentialHelperWrite), and
// $env:USERPROFILE\.fleet-git-credential-github.bat on Windows
// (src/os/windows.ts:279-294).
const GITHUB_VCS_CREDENTIAL_LABEL = 'github';

// Typed marker returned by finalizeAbort() (and logged by the Publish PR step)
// when the callTool-absent graceful-degradation path is taken: PR creation was
// intentionally skipped because no MCP client was wired to mint the push+pr
// credential VCSModule needs, NOT because a PR-creation attempt failed. Callers
// (and tests) can discriminate this benign skip from a genuine PR failure by
// this exact reason string. See apra-fleet-tfx.8.1.
const PR_SKIPPED_NO_MCP_CLIENT = 'pr-skipped-no-mcp-client';

// memberName -> resolved target OS ('windows' | 'linux' | 'darwin' | ...),
// cached for the lifetime of the runner process: a member's OS never changes
// mid-sprint, and member_detail performs a live connectivity check, so this
// must not be re-dispatched per credential read (raiseVcsPrForMember can call
// it twice on the auth-retry path alone).
const memberOsCache = new Map();

// Test seam: the OS cache is process-lifetime state, so a test exercising two
// different member OSes for the same member name must be able to clear it.
export function clearMemberOsCache() {
    memberOsCache.clear();
}

// Resolves `member`'s OS from the fleet member registry via
// fleetApi.memberDetail() ('member_detail' is the only MCP surface exposing
// Agent.os -- src/tools/member-detail.ts:40; it does NOT expose a homeDir).
// Mirrors VCSModule.resolveProvider()'s member_detail JSON-parsing shape.
//
// Unlike resolveProvider, an unresolvable OS is NOT a hard error here: the
// ONLY behavioral difference it drives is which shell string the credential
// read is built as, and the historical (POSIX) string must stay byte-identical
// for every non-Windows member and for any caller that has no memberDetail
// wired. So a missing/unparseable/absent-`os` response degrades to 'linux'
// (the pre-existing behavior) and is logged, never thrown.
// @param {{ fleetApi?: object, member: string, log?: Function }} opts
// @returns {Promise<string>}
export async function resolveMemberOs({ fleetApi, member, log = () => {} }) {
    if (memberOsCache.has(member)) return memberOsCache.get(member);
    try {
        if (!fleetApi || typeof fleetApi.memberDetail !== 'function') {
            throw new Error('no fleetApi.memberDetail() injected');
        }
        const res = await fleetApi.memberDetail({ member_name: member, format: 'json' });
        const text = typeof res === 'string'
            ? res
            : (res && Array.isArray(res.content) && res.content[0] && typeof res.content[0].text === 'string')
                ? res.content[0].text
                : '';
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed.os === 'string' && parsed.os.trim()) {
            const os = parsed.os.trim().toLowerCase();
            // Only a genuine member_detail-derived OS is cached. Caching the
            // 'linux' fallback below would permanently pin a member that hit a
            // transient failure (asleep, flaky SSH, MCP hiccup) to POSIX
            // command construction for the rest of the runner process --
            // including the auth-retry credential read at raiseVcsPrForMember,
            // whose entire purpose is to recover from exactly this kind of
            // transient failure. See apra-fleet-ot2z.13.
            memberOsCache.set(member, os);
            return os;
        }
        throw new Error('member_detail response carried no "os" field');
    } catch (err) {
        log(`Could not resolve OS for member '${member}' from member_detail (${err && err.message ? err.message : err}); assuming POSIX ('linux') for member-bound command construction.`);
        return 'linux';
    }
}

// Wraps a PowerShell script the same way src/os/windows.ts
// wrapPowerShellEncoded() does: the guard clause makes a non-terminating
// PowerShell failure surface as a non-zero exit (apra-fleet-ot2z.9's fix),
// -EncodedCommand (base64 UTF-16LE) removes every quoting question about
// which shell the transport hands the string to, and the $LASTEXITCODE check
// before the trailing `exit 0` preserves a native command's exit code (e.g.
// this file's own credential-read `& "<helper>.bat"` invocation below) that
// would otherwise be masked -- without it, a broken credential-helper .bat
// silently reports success with no `password=` line. runner.js is a separate
// package and cannot import src/os/windows.ts, so the shape is mirrored
// here, not reused.
// @param {string} psScript
// @returns {string}
function wrapPowerShellEncodedForMember(psScript) {
    const guarded = `$ErrorActionPreference = 'Stop'; try { ${psScript}; if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 0 } catch { Write-Error $_; exit 1 }`;
    return `powershell -EncodedCommand ${Buffer.from(guarded, 'utf16le').toString('base64')}`;
}

// Builds the member-bound command that RUNS the deployed git-credential-helper
// and the human-readable descriptor used in this function's error messages
// (the descriptor must stay readable -- the Windows command itself is an
// opaque base64 blob).
//
// SHELL CONTRACT (confirmed, not assumed -- apra-fleet-ot2z.1):
//   execute_command hands the caller's string to
//   cmds.wrapPidCapture(cmds.wrapInWorkFolder(folder, cmd)) and then straight
//   to the strategy's execCommand (src/tools/execute-command.ts:273 ->
//   src/services/ssh.ts execCommand, which does NO shell branching of its
//   own). wrapInWorkFolder/wrapPidCapture (src/os/windows.ts:328-335) still
//   emit RAW PowerShell text (`Set-Location "<folder>"; ...`,
//   `Write-Output "FLEET_PID:$pid"; ...`), NOT shell-normalized/encoded --
//   they are NOT wrapped with -EncodedCommand, so on a Windows member whose
//   sshd default shell is cmd.exe (not PowerShell) that outer wrapping is
//   still garbage regardless of what this function returns. This function's
//   own return value (the inner payload wrapPidCapture/wrapInWorkFolder wrap
//   around) IS explicitly -EncodedCommand and is valid to launch from either
//   PowerShell or cmd.exe on its own -- but that only protects the inner
//   payload, not the outer Set-Location/Write-Output wrapper the codebase
//   composes around it. Correctness end-to-end still depends on the target
//   member's default shell being PowerShell.
//   TODO: normalize wrapInWorkFolder/wrapPidCapture (and
//   gitCredentialHelperWrite/gitCredentialHelperRemove/deploySSHPublicKey,
//   which have the same raw-PowerShell issue on the write side) through a
//   single shell-detecting wrapper so the whole composite string -- not just
//   this function's inner payload -- is shell-agnostic.
//
// WHY $env:USERPROFILE AND NOT A JS-RESOLVED HOME PATH: the WRITE side
// (src/os/windows.ts:289 gitCredentialHelperWrite) writes the helper to
// `"$env:USERPROFILE\.fleet-git-credential-<label>.bat"` -- expanded ON THE
// MEMBER at write time. The read must resolve the home directory the same way
// the write did, or an independently-probed home could point somewhere the
// file was never written. This mirrors member-home.ts probeCommandFor(), which
// likewise resolves the OS in JS and interpolates a shell-appropriate string
// that still contains $env:USERPROFILE.
// RUNNER-WIDE POSIX-EXPANSION SWEEP (apra-fleet-ot2z.1, WORK item 2): every
// runner.js string passed to command()/execute_command was audited for `$VAR`,
// `~/`, backticks, `$( )` and POSIX-only shell plumbing (`&&`/`||` chains,
// `2>/dev/null`, `test -f`, pipes). Result: the credential read below was the
// ONLY member-bound string carrying a shell expansion. The surviving `$`
// occurrences in this file are all justified in place --
//   - NOT_DONE_STATUSES (~line 278): quoting note about PowerShell's $OFS, a
//     comment, not an expansion in the dispatched string;
//   - wrapPowerShellEncodedForMember (~line 1761) and the Windows branch
//     below: deliberately PowerShell, base64-encoded so no host shell ever
//     re-parses them;
//   - the POSIX branch below: `$HOME` expanded by the POSIX member's own
//     shell, matching what src/os/linux.ts wrote.
// Everything else dispatched to a member is plain `git`/`bd`/`node -e`
// argv-shaped text (see stageCommandBodyMemberSide ~line 2195 and the
// two-sequential-calls note at ~line 5685, which already document why they
// avoid `&&` and `$`), inert across POSIX, PowerShell and cmd.exe.
// @param {string} os
// @param {string} label
// @returns {{ command: string, descriptor: string }}
export function buildCredentialReadCommand(os, label) {
    if (os === 'windows') {
        // The label is interpolated into a PowerShell double-quoted string and
        // a filename; the POSIX branch below is unvalidated for byte-identical
        // back-compat, but there is no reason to admit shell metacharacters on
        // the branch being introduced here.
        if (!/^[A-Za-z0-9._-]+$/.test(String(label))) {
            throw new Error(`Refusing to build a Windows credential-read command for unsafe VCS credential label '${label}' (allowed: letters, digits, '.', '_', '-').`);
        }
        const descriptor = `$env:USERPROFILE\\.fleet-git-credential-${label}.bat`;
        // `& "<path>"` -- the call operator, so PowerShell EXECUTES the batch
        // file (and its "password=<token>" line reaches stdout) instead of
        // echoing the path as a string.
        return { command: wrapPowerShellEncodedForMember(`& "$env:USERPROFILE\\.fleet-git-credential-${label}.bat"`), descriptor };
    }
    // POSIX (linux/darwin): byte-identical to the pre-apra-fleet-ot2z.1
    // string. $HOME (not `~`) matches what src/os/linux.ts
    // gitCredentialHelperWrite() wrote and chmod +x'd.
    const credFile = `$HOME/.fleet-git-credential-${label}`;
    return { command: credFile, descriptor: credFile };
}

// Reads the raw token back out of the git-credential-helper script
// provision_vcs_auth just deployed onto `member`'s filesystem
// ($HOME/.fleet-git-credential-<label> on POSIX, or
// $env:USERPROFILE\.fleet-git-credential-<label>.bat on Windows -- see
// buildCredentialReadCommand above; an executable script that PRINTS
// "protocol=...\nhost=...\nusername=...\npassword=<token>\n" when run -- see
// src/os/linux.ts gitCredentialHelperWrite()/src/os/windows.ts). This is the
// ONLY way an orchestrator-side caller (VCSModule's runner.js callers) can
// ever learn the actual token value: provision_vcs_auth's own MCP response
// never carries it (src/tools/provision-vcs-auth.ts masks it to
// "<first 4 chars>****" in its metadata) -- the server deploys the credential
// DIRECTLY onto the member, it never round-trips the plaintext back through
// the MCP response. Dispatched with `silent: true` so the extraction command
// itself is never logged/echoed anywhere (the token value briefly transits
// this one command's captured stdout, held only in-process, and is used
// immediately to build the VCSModule command).
// Both the POSIX helper script and the Windows .bat print the same
// "password=<token>" line, so the extraction regex below is OS-independent.
// @param {{ command: Function, member: string, label?: string, fleetApi?: object, log?: Function }} opts
// @returns {Promise<string>}
async function readMemberVcsCredentialToken({ command, member, label = GITHUB_VCS_CREDENTIAL_LABEL, fleetApi, log = () => {} }) {
    const os = await resolveMemberOs({ fleetApi, member, log });
    const { command: credCommand, descriptor: credFile } = buildCredentialReadCommand(os, label);
    const res = await command(credCommand, {
        member_name: member,
        silent: true,
        failSoft: true,
        label: 'Read just-provisioned VCS credential token for PR creation',
    });
    if (!res || !res.ok) {
        throw new Error(`Failed to read VCS credential token for member '${member}' from '${credFile}': ${res ? res.error : '(no result)'}`);
    }
    const m = /^password=(.*)$/m.exec(String(res.output || ''));
    const token = m ? m[1].trim() : '';
    if (!token) {
        throw new Error(`VCS credential token for member '${member}' was empty/unreadable after provisioning (expected a 'password=' line from '${credFile}').`);
    }
    return token;
}

// Splits a VCSModule create-pull-request curl result's captured stdout into
// its HTTP status code and JSON body. VCSModule's buildCreatePrCommand always
// appends `-w '\n%{http_code}'`, so curl's own stdout is "<json body>\n<status>".
// @param {string} output
// @returns {{ status: number|null, body: unknown }}
function parseVcsCurlOutput(output) {
    const text = String(output || '');
    const lines = text.split('\n');
    const statusLine = lines.length ? lines[lines.length - 1].trim() : '';
    const status = /^\d+$/.test(statusLine) ? parseInt(statusLine, 10) : null;
    const bodyText = (status !== null ? lines.slice(0, -1) : lines).join('\n').trim();
    let body = null;
    if (bodyText) {
        try {
            body = JSON.parse(bodyText);
        } catch {
            body = null;
        }
    }
    return { status, body, bodyText };
}

// A PR-creation response is REACTIVE-auth-classified (as opposed to a
// generic failure) when the token that raised it is stale/expired (401),
// lacks the scope/permission GitHub requires (403), or -- because GitHub
// sometimes answers a scope refusal with 404 instead of 403, to avoid
// leaking whether a private repo exists to a token that cannot see it -- a
// 404 whose body text itself names a scope/permission/authentication
// refusal. Anything else (422 already-exists, 5xx, malformed body, a bare
// 404 with no such text) is left exactly as it classified before this bead:
// a plain failure, never retried.
// @param {number|null} status
// @param {string} errorText
// @returns {boolean}
const PR_AUTH_404_TEXT_RE = /not accessible by (this )?(integration|token|personal access token)|requires (authentication|additional scopes?)|insufficient (scope|permission)/i;
function isPrAuthFailure(status, errorText) {
    if (status === 401 || status === 403) return true;
    if (status === 404 && PR_AUTH_404_TEXT_RE.test(String(errorText || ''))) return true;
    return false;
}

// Mints a just-in-time push+pr credential for `member`, reads back the token
// it deployed, builds the create-pull-request command through VCSModule (the
// orchestrator-side command builder, apra-fleet-tfx.7), and dispatches it via
// `command()` -- `member` is a dumb executor of a command this function (and
// VCSModule) decided, never `gh`, never a server-side fallback. Returns the
// same shape both PR-raising call sites need: { ok, alreadyExists, prUrl,
// error, authFailure }, mirroring the interpretation contract the reverted
// server-side create-pull-request.ts tool used (2xx -> success; 422 "already
// exists" -> idempotent success; anything else -> error).
//
// REACTIVE auth self-heal (apra-fleet-647.1.1.1): on an auth-classified
// response (see isPrAuthFailure above), this re-provisions a push+pr
// credential via provisionPrCapableAuthForMember, re-reads the token, and
// retries the SAME PR-creation command exactly once -- bounded one-shot
// semantics mirroring runGitStep/runDoltStep's onAuthFailure loop. If the
// retry still fails, the failure (auth or not) is returned as-is; the raw
// token is never logged, only `built.logSafeCommand`.
// @param {{ fleetApi: object, command: Function, member: string, base: string, head: string, title: string, body?: string, log?: Function, logPrefix: string }} opts
// @returns {Promise<{ ok: boolean, alreadyExists: boolean, prUrl: string|null, error: string|null, authFailure: boolean }>}
async function raiseVcsPrForMember({ fleetApi, command, member, base, head, title, body, log = () => {}, logPrefix }) {
    let { repo } = await provisionPrCapableAuthForMember({ fleetApi, command, member, log, logPrefix });
    if (!repo) {
        throw new Error(`Could not derive an owner/repo from member '${member}' git remote -- cannot build a VCSModule create-pull-request command without one.`);
    }
    let token = await readMemberVcsCredentialToken({ command, member, fleetApi, log });
    const os = await resolveMemberOs({ fleetApi, member, log });

    let authHealAttempted = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const built = buildCreatePrCommand({ provider: 'github', repo, base, head, title, body, token, os });

        const res = await command(built.command, {
            member_name: member,
            silent: true,
            failSoft: true,
            label: `Raise PR to '${base}' via VCSModule (not merged)`,
        });
        if (!res || !res.ok) {
            return { ok: false, alreadyExists: false, prUrl: null, error: (res && res.error) || 'execute_command failed', authFailure: false };
        }

        const { status, body: respBody, bodyText } = parseVcsCurlOutput(res.output);
        const [lo, hi] = built.interpret.successStatusRange;
        if (status !== null && status >= lo && status <= hi) {
            const prUrl = respBody && typeof respBody.html_url === 'string' ? respBody.html_url : null;
            return { ok: true, alreadyExists: false, prUrl, error: null, authFailure: false };
        }

        const errorMessages = [];
        if (respBody && typeof respBody.message === 'string') errorMessages.push(respBody.message);
        if (respBody && Array.isArray(respBody.errors)) {
            for (const e of respBody.errors) {
                if (e && typeof e.message === 'string') errorMessages.push(e.message);
            }
        }
        const errorText = errorMessages.join('; ') || bodyText || `HTTP ${status ?? '(unknown)'}`;

        if (status === built.interpret.alreadyExistsStatus && new RegExp(built.interpret.alreadyExistsPattern, 'i').test(errorText)) {
            const urlMatch = /https?:\/\/\S+/.exec(errorText);
            const existingUrl = urlMatch ? urlMatch[0].replace(/[.,)]+$/, '') : null;
            return { ok: true, alreadyExists: true, prUrl: existingUrl, error: null, authFailure: false };
        }

        if (isPrAuthFailure(status, errorText) && !authHealAttempted) {
            authHealAttempted = true;
            log(`${logPrefix}: PR creation returned an auth-classified failure (HTTP ${status ?? '(unknown)'}) for member '${member}'; re-provisioning a push+pr credential and retrying once (command: ${built.logSafeCommand}): ${errorText}`);
            try {
                const reprov = await provisionPrCapableAuthForMember({ fleetApi, command, member, log, logPrefix });
                if (reprov.repo) repo = reprov.repo;
                token = await readMemberVcsCredentialToken({ command, member, fleetApi, log });
            } catch (healErr) {
                log(`${logPrefix}: PR auth self-heal failed for member '${member}'; not retrying further: ${healErr.message}`);
                return { ok: false, alreadyExists: false, prUrl: null, error: `HTTP ${status ?? '(unknown)'}: ${errorText}`, authFailure: true };
            }
            log(`${logPrefix}: PR auth self-heal completed for member '${member}'; retrying PR creation once.`);
            continue;
        }

        return { ok: false, alreadyExists: false, prUrl: null, error: `HTTP ${status ?? '(unknown)'}: ${errorText}`, authFailure: isPrAuthFailure(status, errorText) };
    }
}

// provision_vcs_auth returns plain human-readable text with no structured
// response shape, so there is no field to read directly. The GitHub App path
// renders its metadata as one '  <key>: <value>' line per entry, so this
// extracts the `expiresAt` line. PAT-mode credentials carry no expiry line,
// and null here means "no expiry tracked -> OK", the same reading applied
// server-side by checkVcsTokenExpiry.
// @param {string} text
// @returns {Date|null}
function parseExpiresAtFromProvisionText(text) {
    const m = /^\s*expiresAt:\s*(\S+)\s*$/m.exec(text || '');
    if (!m) return null;
    const d = new Date(m[1]);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * apra-fleet-417.7: builds the `resolveMemberProvider(member)` callback
 * threaded through syncMemberBefore/syncMemberAfter/finalizeAbort into
 * runGitStep, so classifyGitFailure() classifies a git failure via the
 * member's OWN resolved VCS provider chain (VCSModule.resolveProvider())
 * instead of always falling back to the default 'github' chain -- this is
 * what makes azure-devops.mjs's TF401019 -> AUTH_DENIED and bitbucket.mjs's
 * app-password -> AUTH_EXPIRED rules reachable at runtime, not just from a
 * caller that names the provider directly against classifyFailure().
 *
 * The resolution is cached per member for the lifetime of the returned
 * callback (a member's registered VCS provider does not change mid-sprint),
 * so a member whose provider fails to resolve (fleet unreachable, no
 * registered provider) is not re-queried on every subsequent git failure --
 * it fails closed to `undefined` (today's default chain) exactly once per
 * member, then reuses that cached `undefined`.
 *
 * `callTool` is injected (the caller's MCP client), so this stays
 * transport-agnostic and unit-testable without a live fleet server.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, log?: Function }} opts
 * @returns {(member: string) => Promise<string|undefined>}
 */
export function createMemberVcsProviderResolver(opts = {}) {
    const { callTool, log = () => {} } = opts;
    const fleetApi = new ApraFleet({ callTool });
    /** @type {Map<string, string|undefined>} member -> resolved provider (or undefined if unresolvable). */
    const cache = new Map();

    return async function resolveMemberProvider(member) {
        if (cache.has(member)) return cache.get(member);
        try {
            const { provider } = await resolveProvider(member, { fleetApi });
            cache.set(member, provider);
            return provider;
        } catch (err) {
            log(`[Sync] could not resolve member '${member}'s VCS provider for git-failure classification (falling back to the default provider chain, no verdict change for GitHub members): ${err.message}`);
            cache.set(member, undefined);
            return undefined;
        }
    };
}

/**
 * Best-effort provisions a member for unattended execution (`unattended:
 * 'auto'`) before dispatching it as deployer, integ-test-runner, or
 * regression-test-runner -- roles that run real deploy commands and test
 * suites via a runbook and must never stall on an interactive permission
 * prompt. Provisioning is a one-way member-registration change and is
 * deliberately NOT reverted after the dispatch: `unattended` lives on the
 * member (update_member), not on the dispatch, so there is nothing to revert
 * to without also clobbering whatever the user set intentionally. In a
 * single-member sprint the same member also plays doer/reviewer/etc, so it
 * ends up unattended='auto' too -- accepted, not a bug.
 *
 * Cached per member for the lifetime of the returned function, so a sprint
 * with many deploy/integ/regression dispatches across cycles calls
 * update_member at most once per member. A failure (fleet unreachable,
 * member not found) is logged and swallowed -- exactly like
 * createMemberVcsProviderResolver above -- so a provisioning hiccup degrades
 * to whatever permission mode the member already had, rather than aborting
 * the phase.
 *
 * `callTool` is injected (the caller's MCP client), so this stays
 * transport-agnostic and unit-testable without a live fleet server.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, log?: Function }} opts
 * @returns {(member: string) => Promise<void>}
 */
export function createUnattendedAutoProvisioner(opts = {}) {
    const { callTool, log = () => {} } = opts;
    const fleetApi = new ApraFleet({ callTool });
    /** @type {Set<string>} members already confirmed unattended='auto' this run. */
    const provisioned = new Set();

    return async function ensureUnattendedAuto(member) {
        if (provisioned.has(member)) return;
        try {
            await fleetApi.updateMember({ member_name: member, unattended: 'auto' });
            provisioned.add(member);
            log(`[unattended] member '${member}' set to unattended='auto' for this dispatch.`);
        } catch (err) {
            log(`[unattended] could not set unattended='auto' on member '${member}' (continuing with its existing permission mode): ${err.message}`);
        }
    };
}

/**
 * Best-effort, self-heals the "Missing permission" class of deploy/integ/
 * regression-test failure BEFORE it happens: reads deploy.md's own
 * `## Permissions` section -- the exact list the deployer/integ-test-runner/
 * regression-test-runner agent prompts already cross-check at their own
 * Step 0a/0 -- and proactively grants every listed prefix to the target
 * member via compose_permissions. Without this, a runbook permissions
 * change (e.g. the `apra-fleet start` -> `apra-fleet run` swap, #395) only
 * gets noticed when a dispatch fails, and only gets fixed once an operator
 * greps deploy.md by hand and runs compose_permissions manually -- exactly
 * the failure mode this closes the loop on.
 *
 * Reads deploy.md via `command()` against the ORCHESTRATOR member (its own
 * checkout is the source of truth for what is about to be dispatched) and
 * caches the parsed prefix list for the lifetime of the returned function --
 * one read per sprint run, since deploy.md does not change mid-run on a
 * healthy pipeline. Also caches per TARGET member, like
 * createUnattendedAutoProvisioner above, so repeat cycles don't re-grant.
 *
 * Failure at any step (probe fails, deploy.md missing/unparseable,
 * compose_permissions unreachable, a listed prefix hitting the
 * NEVER_AUTO_GRANT denylist) is logged and swallowed. This is pure
 * best-effort acceleration -- the deployer's own Step 0a check remains the
 * authoritative, fail-closed backstop regardless of whether this succeeds.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, command: Function, orchestratorMember: string, log?: Function }} opts
 * @returns {(member: string) => Promise<void>}
 */
export function createDeployPermissionsProvisioner(opts = {}) {
    const { callTool, command, orchestratorMember, log = () => {} } = opts;
    const fleetApi = new ApraFleet({ callTool });
    /** @type {Set<string>} members already granted deploy.md's permissions this run. */
    const provisioned = new Set();
    /** @type {string[] | null | undefined} undefined = not yet attempted. */
    let cachedPrefixes;

    async function loadRequiredPrefixes() {
        if (cachedPrefixes !== undefined) return cachedPrefixes;
        try {
            const res = await command(
                `node -e "const fs=require('fs'); if(fs.existsSync('deploy.md')) process.stdout.write(fs.readFileSync('deploy.md','utf8'))"`,
                { member_name: orchestratorMember, silent: true, label: `Read deploy.md permissions`, failSoft: true },
            );
            if (!res.ok || !res.output) {
                cachedPrefixes = null;
            } else {
                const section = res.output.split(/^## Permissions/m)[1]?.split(/^## /m)[0] ?? '';
                const prefixes = [...section.matchAll(/^-\s*`([^`]+)`/gm)].map(m => m[1]);
                cachedPrefixes = prefixes.length ? prefixes : null;
            }
        } catch (err) {
            log(`[deploy-permissions] could not read deploy.md's Permissions section (continuing without auto-provisioning): ${err.message}`);
            cachedPrefixes = null;
        }
        return cachedPrefixes;
    }

    return async function ensureDeployPermissions(member) {
        if (!member || provisioned.has(member)) return;
        const prefixes = await loadRequiredPrefixes();
        if (!prefixes) return;
        try {
            const result = await fleetApi.composePermissions({
                member_name: member,
                role: 'doer',
                grant: prefixes,
                grant_reason: "deploy.md's declared Permissions section, auto-provisioned before dispatch",
            });
            provisioned.add(member);
            log(`[deploy-permissions] ensured deploy.md's required permissions on '${member}': ${result}`);
        } catch (err) {
            log(`[deploy-permissions] could not auto-provision deploy.md permissions on '${member}' (continuing -- the deployer's own Step 0a check remains the backstop): ${err.message}`);
        }
    };
}

/**
 * Builds the REACTIVE `onAuthFailure` self-heal callback runGitStep and
 * runDoltStep invoke on an 'auth' classification: re-provisions the failing
 * member's VCS credentials via provisionVcsAuthForMember (whose owner/repo is
 * derived from the member's own git remote, never hardcoded). Logs both the
 * attempt and its outcome, so a self-heal is never silent. Any failure
 * propagates as a thrown error, which is how runGitStep/runDoltStep recognize
 * "self-heal failed" and stop retrying.
 *
 * `callTool` is injected (the caller's MCP client), so this stays
 * transport-agnostic and unit-testable without a live fleet server.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, command: Function, log?: Function }} opts
 * @returns {(info: { member: string, label: string, cmd?: string, error: string, kind: 'git'|'dolt' }) => Promise<void>}
 */
export function createVcsAuthSelfHealCallback(opts = {}) {
    const { callTool, command, log = () => {} } = opts;
    const fleetApi = new ApraFleet({ callTool });

    return async function onAuthFailure({ member, label, error }) {
        log(`[Sync] self-heal: auth failure detected for member '${member}' (${label}); calling provision_vcs_auth to re-provision credentials: ${error}`);

        await provisionVcsAuthForMember({ fleetApi, command, member, log, logPrefix: '[Sync] self-heal' });

        log(`[Sync] self-heal: provision_vcs_auth succeeded for member '${member}' (${label}); the failed command will be retried once.`);
    };
}

// How far ahead of a credential's known expiry the preflight treats it as
// "expiring soon" and re-provisions early, rather than letting it lapse
// mid-dispatch. Mirrors the server's own EXPIRY_WARNING_MS threshold
// (checkVcsTokenExpiry) so the two "about to expire?" judgments never
// disagree.
const VCS_AUTH_EXPIRY_PREFLIGHT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Proactive VCS-auth PREFLIGHT. Unlike createVcsAuthSelfHealCallback above,
 * which is REACTIVE (it fires only after a git/dolt command has already failed
 * with an 'auth' classification), this runs BEFORE a dispatch's git commands
 * and calls provision_vcs_auth only when this member's last-known credential
 * is missing, unknown, or expiring within VCS_AUTH_EXPIRY_PREFLIGHT_MS. It
 * closes the gap a reactive self-heal alone leaves: a credential that lapses
 * BETWEEN dispatches is refreshed before the next dispatch instead of after a
 * command fails.
 *
 * The freshness cache is scoped to the callback instance returned here, so
 * each member's first call always provisions (no cache entry yet) and later
 * calls are skipped until the cached expiry approaches. A response carrying no
 * expiry (PAT mode, which never expires) is cached as "known-good, never needs
 * refresh".
 *
 * NEVER throws: a preflight failure (fleet unreachable, provision_vcs_auth
 * itself failing) is logged and swallowed so it can never abort a dispatch
 * that would have succeeded on its still-valid existing credential. The
 * reactive self-heal remains the actual safety net if the credential is
 * genuinely stale.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, command: Function, log?: Function, now?: () => number }} opts
 * @returns {(member: string) => Promise<void>}
 */
export function createVcsAuthPreflightCallback(opts = {}) {
    const { callTool, command, log = () => {}, now = () => Date.now() } = opts;
    const fleetApi = new ApraFleet({ callTool });
    /** @type {Map<string, Date|null>} member -> last-known expiresAt (null = no expiry tracked, e.g. PAT mode). */
    const knownGoodUntil = new Map();

    return async function ensureVcsAuthFresh(member) {
        if (knownGoodUntil.has(member)) {
            const expiresAt = knownGoodUntil.get(member);
            if (expiresAt === null || expiresAt.getTime() - now() > VCS_AUTH_EXPIRY_PREFLIGHT_MS) {
                // Still fresh (or a no-expiry credential type) -- skip, so
                // this is not an unconditional provisioning call on every
                // dispatch.
                return;
            }
        }
        log(`[Sync] preflight: ensuring member '${member}' has a fresh VCS credential before dispatch; calling provision_vcs_auth.`);
        try {
            const { expiresAt } = await provisionVcsAuthForMember({ fleetApi, command, member, log, logPrefix: '[Sync] preflight' });
            knownGoodUntil.set(member, expiresAt);
            log(`[Sync] preflight: provision_vcs_auth succeeded for member '${member}'${expiresAt ? ` (expires ${expiresAt.toISOString()})` : ''}.`);
        } catch (err) {
            log(`[Sync] preflight: provision_vcs_auth failed for member '${member}' (continuing -- the existing credential may still be valid; the reactive self-heal will fire if a git/dolt command actually fails): ${err.message}`);
        }
    };
}

/**
 * LLM-auth counterpart to createVcsAuthSelfHealCallback, invoked by a
 * dispatch-site catch handler on an auth dispatch error: re-provisions LLM
 * credentials for the failing member via provision_llm_auth, after which the
 * caller retries its own dispatch once. Never throws -- every failure path
 * returns false ("do not retry"). A local member returns false without
 * retrying, because provision_llm_auth is a no-op for local members: they
 * share the operator's host credentials, and only an interactive `/login` on
 * that machine can fix an expired local session.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, log?: Function }} opts
 * @returns {(info: { member: string, label: string, error: string }) => Promise<boolean>} resolves true if healed (retry), false if not (do not retry)
 */
export function createLlmAuthSelfHealCallback(opts = {}) {
    const { callTool, log = () => {} } = opts;
    const fleetApi = new ApraFleet({ callTool });

    return async function onLlmAuthFailure({ member, label, error }) {
        log(`[Dispatch] self-heal: LLM auth failure detected for member '${member}' (${label}); calling provision_llm_auth to re-provision credentials: ${error}`);

        let provisionRes;
        try {
            provisionRes = await fleetApi.provisionLlmAuth({ member_name: member });
        } catch (callErr) {
            log(`[Dispatch] self-heal: provision_llm_auth call failed for member '${member}': ${callErr.message}. Not retrying -- fix credentials manually and re-run.`);
            return false;
        }

        const text = selfHealResultText(provisionRes).trim();

        if (/^â­/.test(text)) {
            // Skip marker (local member): provision_llm_auth is a no-op here,
            // so retrying would just reproduce the same failure.
            log(`[Dispatch] self-heal: provision_llm_auth skipped for local member '${member}': ${text || '(no detail)'}. This member's credentials can only be refreshed via an interactive /login on this machine.`);
            return false;
        }

        if ((provisionRes && provisionRes.isError) || /^âŒ/.test(text)) {
            log(`[Dispatch] self-heal: provision_llm_auth failed for member '${member}': ${text || '(no detail)'}. Not retrying.`);
            return false;
        }

        log(`[Dispatch] self-heal: provision_llm_auth succeeded for member '${member}' (${label}); the failed dispatch will be retried once.`);
        return true;
    };
}

/**
 * Stage `content` to a fresh temp file ON THE MEMBER that will run the
 * subsequent `bd` command, and return that MEMBER-LOCAL absolute path.
 * `command()` may dispatch `bd` to a different machine than the workflow
 * engine runs on, so a body file written to the engine host's own tmpdir
 * would not exist where `bd --body-file` reads it. Staging via `command()`
 * (member_name: member) guarantees the file lands on the SAME filesystem.
 *
 * The write is performed by a member-side `node` one-liner -- `node` is
 * present on every fleet member -- and the recipe is shell-agnostic: it
 * contains no `$`-expansion, backticks, template literals, or `%`-vars, so it
 * is inert as syntax in POSIX shells, PowerShell, and cmd.exe alike.
 * `content` is base64-encoded and passed as a SINGLE argv token whose
 * alphabet (A-Za-z0-9+/=) is likewise inert in all of those shells, and node
 * decodes it back to the exact literal bytes. This is the injection-safety
 * property: caller-supplied free text is NEVER interpolated into the shell
 * command string. The staged file is a member-side OS temp file the member's
 * OS reaps on its own.
 * @param {{ command: Function, member: string, content: string, label?: string }} opts
 * @returns {Promise<string>} the MEMBER-LOCAL temp file path
 */
async function stageCommandBodyMemberSide({ command, member, content, label }) {
    const b64 = Buffer.from(content, 'utf-8').toString('base64');
    // No backticks / no `$` / no template literals: inert across POSIX,
    // PowerShell, and cmd.exe. Reads the base64 body from argv[1] (the first
    // arg after the `-e` script), decodes it to raw bytes, writes them to a
    // fresh member-local temp file, and prints ONLY that path to stdout.
    const stageScript =
        "const os=require('os'),p=require('path'),fs=require('fs');" +
        "const f=p.join(os.tmpdir(),'fleet-sprint-body-'+process.pid+'-'+Date.now()+'-'+Math.random().toString(36).slice(2)+'.txt');" +
        "fs.writeFileSync(f,Buffer.from(process.argv[1],'base64'));process.stdout.write(f)";
    const out = await command(
        `node -e "${stageScript}" "${b64}"`,
        { member_name: member, silent: true, label: label ?? 'Stage bd body file member-side' }
    );
    const staged = String(out ?? '').trim();
    if (!staged) throw new Error('member-side body staging returned an empty path');
    return staged;
}

/**
 * The count of children a parent ALREADY has, i.e. the highest trailing `.N`
 * segment across its direct children. Passed to the allocator as `floor` so
 * that on its FIRST allocation under a parent it never mints an id colliding
 * with a child created before the allocator's persisted state was seeded.
 * Best-effort: a failed or unparseable list yields 0 (the allocator's own
 * persisted high-water still guards against re-minting after that).
 *
 * @param {{ command: Function, member: string, parentId: string }} opts
 * @returns {Promise<number>}
 */
export async function computeChildFloor({ command, member, parentId }) {
    try {
        const label = `bd list --parent ${parentId} --json`;
        const raw = await command(label, { member_name: member, silent: true });
        const beads = parseBdJson(raw, label);
        let max = 0;
        const prefix = `${parentId}.`;
        for (const b of beads) {
            if (!b || typeof b.id !== 'string' || !b.id.startsWith(prefix)) continue;
            const tail = b.id.slice(prefix.length);
            // Only a DIRECT child (single trailing numeric segment) counts.
            if (!/^\d+$/.test(tail)) continue;
            const n = Number(tail);
            if (Number.isInteger(n) && n > max) max = n;
        }
        return max;
    } catch {
        return 0;
    }
}

/**
 * Create a child bead under `parentId` using an allocator-minted,
 * collision-free explicit id. This is the single bead-creation seam every
 * proposed newTask flows through, so that two concurrent sprints never mint
 * the same child id.
 *
 * Sequence (mirrors the allocator's reserve -> confirm/release contract):
 *   1. allocate() reserves the next distinct child id under the shared parent.
 *   2. `bd create` runs with `--id <childId>` (or, under the null client where
 *      childId is null, lets bd derive the id from `--parent`).
 *   3. On the explicit-id path only, a follow-up `bd update <childId> --parent
 *      <parentId>` establishes the real parent edge.
 *   4. confirm() on success (the id is now durably used) or release() on
 *      failure (the reserved id returns to the pool, never a permanent gap).
 *
 * `bd create` REJECTS `--id` and `--parent` together, so on the explicit-id
 * path `--parent` must be dropped: the allocator's `${parentId}.${seq}` id
 * shape already encodes the hierarchy. A dotted id alone does NOT record the
 * explicit parent edge, which is what the separate `bd update --parent`
 * supplies; that link step is deliberately NOT best-effort -- a failure
 * throws, releases the reservation, and degrades loudly rather than leaving
 * an edgeless child.
 *
 * @param {{
 *   command: Function, allocator: { allocate: Function, confirm: Function, release: Function },
 *   member: string, title: string, description: string, priority: string,
 *   parentId: string, sprintId?: string, floor?: number, label?: string,
 *   log?: Function,
 * }} opts
 * @returns {Promise<{ childId: string|null }>}
 */
export async function createChildBeadWithAllocatedId(opts) {
    const { command, allocator, member, title, description, priority, parentId, sprintId, floor, label, log = () => {} } = opts;
    const grant = await allocator.allocate(parentId, { pid: process.pid, sprintId, floor });
    // The explicit-id path relies on the allocator's `${parentId}.${seq}` id
    // shape to carry the hierarchy that `--parent` can no longer carry
    // alongside `--id` (see the doc comment above). Fail loudly rather than
    // create a child whose id does not place it under this parent at all.
    if (grant.childId && !String(grant.childId).startsWith(`${parentId}.`)) {
        await allocator.release(grant.token);
        throw new Error(
            `[id-allocator] allocated child id '${grant.childId}' is not a child of parent '${parentId}' ` +
            '(expected the `<parentId>.<seq>` shape); released the reservation rather than creating an unparented bead',
        );
    }
    // `bd create` refuses `--id` together with `--parent`: carry EITHER the
    // allocator-minted explicit id (hierarchy encoded in the id, parent edge
    // linked immediately after the create) OR `--parent` and let bd derive the
    // id (null-allocator path).
    const parentageFlags = grant.childId ? `--id ${grant.childId}` : `--parent ${parentId}`;
    // The description is LLM-authored free text: stage it to a member-local
    // temp file (see stageCommandBodyMemberSide) and hand THAT path to `bd
    // create --body-file` rather than interpolating it into the shell command
    // string. Only `title` (short, allowlist-validated by validateNewTask)
    // remains inline.
    try {
        const descriptionFile = await stageCommandBodyMemberSide({
            command, member, content: description,
            label: `Stage newTask description for '${title}'`,
        });
        await command(
            `bd create "${title}" --body-file "${descriptionFile}" -p "${priority}" ${parentageFlags} --silent`,
            { member_name: member, silent: true, label: label ?? `Create follow-up task: ${title}` }
        );
        // Explicit-id path only: record the real parent edge that `--parent`
        // would have recorded, had bd allowed it on the same create.
        if (grant.childId) {
            await command(
                `bd update ${grant.childId} --parent ${parentId}`,
                { member_name: member, silent: true, label: `Link follow-up task ${grant.childId} under ${parentId}` }
            );
        }
    } catch (err) {
        // The create did NOT land -- return the reserved id to the pool so the
        // next allocation reuses it (no permanent gap), then re-throw.
        await allocator.release(grant.token);
        log(`[id-allocator] bd create failed for '${grant.childId ?? '(bd-derived)'}'; released reservation: ${err.message}`);
        throw err;
    }
    // The create landed locally -- durably commit the id BEFORE the D-push, so a
    // crash after this point can never reclaim an id that now genuinely exists.
    await allocator.confirm(grant.token);
    return { childId: grant.childId ?? null };
}

/**
 * Follow-up-task persistence is bookkeeping -- it must NEVER abort the sprint.
 * Every persistence path degrades instead of throwing: bd create ->
 * parent-bead notes -> this run log, in that order.
 */
export async function persistNewTaskBestEffort({ createFn, command, member, parentId, newTask, cycle, log = () => {}, stage }) {
    try {
        // createFn's return value (when it forwards createChildBeadWithAllocatedId's
        // { childId }) lets callers log exactly which bead id was created, not just
        // a count. Existing callers that ignore the return value are unaffected --
        // this is still truthy either way.
        const result = await createFn();
        return result ?? true;
    } catch (err) {
        log(`[fleet-sprint] newTask bd create FAILED (non-fatal, ${stage}): ${err.message} -- falling back to parent-bead notes.`);
        try {
            await appendRejectedFindingToParentNotes({
                command, member, parentId, newTask,
                reason: `bd create failed (${stage}): ${err.message}`, cycle, log,
            });
        } catch (err2) {
            log(`[fleet-sprint] newTask persistence FAILED at every level (non-fatal, ${stage}); finding preserved VERBATIM in this run log: ${JSON.stringify(newTask)} -- last error: ${err2.message}`);
        }
        return false;
    }
}

/**
 * The orchestrator's post-streak verification read, with its mandatory
 * D-pull. A remote doer closes its assigned beads in its OWN clone and
 * D-pushes them, so the orchestrator MUST D-pull its own clone BEFORE the `bd
 * show` -- otherwise it reads stale (still-open) status and falsely reports
 * every remote doer streak as FAILED.
 *
 * Returns the ids that are NOT closed after the D-pull-then-read. An empty
 * array means the streak genuinely closed everything it was assigned.
 *
 * @param {{ command: Function, orchestratorMember: string, beadIds: string[], log?: Function }} opts
 * @returns {Promise<string[]>} the still-unclosed bead ids
 */
export async function verifyDoerStreakClosed({ command, orchestratorMember, beadIds, log = () => {} }) {
    // D-pull FIRST so the orchestrator's clone observes the doer's just-pushed
    // closes. Routed through the single dolt-sync module's purpose-based BEFORE
    // bracket (apra-fleet-417.2.1); behavior is identical to the previous
    // direct doltPullBefore() call.
    await DoltSync.syncBefore(orchestratorMember, { command, log, fatal: true, settle: buildSettleCallback(orchestratorMember, { command, log }) });
    const label = `bd show ${beadIds.join(' ')} --json`;
    const showRes = await command(label, { member_name: orchestratorMember, silent: true });
    const showBeads = parseBdJson(showRes, label);
    const statusById = new Map(showBeads.map((b) => [b.id, b.status]));
    return beadIds.filter((id) => statusById.get(id) !== 'closed');
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
        assignee: args.assignee,
        dispatchTimeoutS,
        doerWorklistMode,
        resumeModelSwitch,
        worklistEffortBudget: args.worklist_effort_budget,
    };
}

// ---------------------------------------------------------------------------
// Plan phase prompt builder
// ---------------------------------------------------------------------------
//
// Builds a self-contained planner prompt per the vendored
// apra-pm/agents/planner.md contract: the planner has no memory of this
// conversation, so every fact it needs (which sprint root issue(s) are in
// scope, the goal priority, the requirements file content, and -- for a
// re-planning cycle -- explicit "gaps only" framing) must be spelled out in
// the prompt text rather than assumed.
//
// Model-tier convention: planner.md Step 3 is the authoritative source and
// makes beads *metadata* set at creation time (`bd create ... --metadata
// '{"model": "<tier>"}'`) the ONLY location the model tier is recorded --
// never `--notes` or a METADATA-section comment. Every consumer (the
// plan-reviewer, and the orchestrator that dispatches doers) reads it back
// from that same field, so this prompt's instruction MUST stay aligned with
// planner.md Step 3.
/**
 * Classify beads whose every child is closed as ready for the `verify` route
 * (apra-fleet-jfo): implementation-complete parents that must be excluded
 * from Plan/Develop/Review and verified against the live deployed product,
 * never administratively closed on child-closure alone -- see
 * docs/fleet-sprint-phase-routing-design.md and apra-fleet-jfo for the design.
 *
 * Pure: derives the verify set fresh from `allBeads` on every call. There is
 * no persisted list -- callers re-invoke this at each classification point
 * (pre-sprint validation, cycle top, IntegTest dispatch) rather than caching,
 * so a crash-restart re-derives it for free and nothing can drift out of sync
 * with the beads DB.
 *
 * Eligibility (a bead qualifies iff ALL of):
 *   1. in scope: is itself one of `targetIssues`, or is a BFS descendant of
 *      one (same discovery rule bdListScoped uses).
 *   2. status is 'open' or 'in_progress' (not already closed/deferred).
 *   3. has at least one child. Childless beads are leaves -- they route
 *      through the normal Plan/Develop pipeline, never verify. A parent with
 *      NO children is never eligible, regardless of anything else.
 *   4. EVERY child (any issue_type) has status 'closed', checked against the
 *      FULL unfiltered `allBeads` list, not a scope-filtered subset -- an
 *      out-of-scope open child must still block eligibility. Partial closure
 *      never qualifies.
 *   5. no unmet 'blocks' dependency (apra-fleet inv-4): a parent whose
 *      blocker is still being implemented in this same run must not be
 *      verified against today's incomplete state.
 *
 * @param {Array<object>} allBeads - the FULL, unfiltered project bead list.
 * @param {string[]} targetIssues - the sprint's target issue root id(s).
 * @returns {{ verifyIds: string[], ineligible: Array<{id: string, reason: string}> }}
 */
export function classifyVerifySet(allBeads, targetIssues) {
    const byId = new Map((allBeads || []).map((b) => [b.id, b]));
    const childrenOf = new Map();
    for (const b of (allBeads || [])) {
        if (b && b.parent) {
            if (!childrenOf.has(b.parent)) childrenOf.set(b.parent, []);
            childrenOf.get(b.parent).push(b);
        }
    }

    // Same BFS discovery bdListScoped uses (module-scoped, ~line 5099), kept
    // as a standalone copy here since this function must stay pure/testable
    // independent of the closure state bdListScoped lives inside.
    const scopeIds = new Set();
    const frontier = [...(targetIssues || [])];
    while (frontier.length > 0) {
        const id = frontier.shift();
        for (const child of (childrenOf.get(id) || [])) {
            if (!scopeIds.has(child.id)) {
                scopeIds.add(child.id);
                frontier.push(child.id);
            }
        }
    }
    for (const id of (targetIssues || [])) scopeIds.add(id);

    const verifyIds = [];
    const ineligible = [];
    for (const id of scopeIds) {
        const bead = byId.get(id);
        if (!bead) continue;
        if (bead.status !== 'open' && bead.status !== 'in_progress') continue;

        const kids = childrenOf.get(id) || [];
        if (kids.length === 0) continue; // leaf -- normal pipeline, not eligible

        if (!kids.every((k) => k.status === 'closed')) continue; // partial closure never qualifies

        const unmetBlockerIds = (bead.dependencies || [])
            .filter((d) => d.type === 'blocks')
            .map((d) => d.depends_on_id)
            .filter((depId) => {
                const dep = byId.get(depId);
                return dep && dep.status !== 'closed';
            });
        if (unmetBlockerIds.length > 0) {
            ineligible.push({ id, reason: `unmet blocker(s): ${unmetBlockerIds.join(', ')}` });
            continue;
        }

        verifyIds.push(id);
    }

    return { verifyIds, ineligible };
}

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
function buildPlanReviewerPrompt({ targetIssues, goal, priorRoundVerdicts = [], replanScope = null, verifyExcluded = [] }) {
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

// ---------------------------------------------------------------------------
// Develop/Review loop prompt builders + pure helpers
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
 * Validates a streak-assignment agent() result against the set of currently
 * ready bead objects and returns the resolved streaks (arrays of the original
 * bead objects, not just ids). Falls back to one-bead-per-streak -- which is
 * correct by construction -- whenever the candidate does not cover every ready
 * bead id EXACTLY once, so a malformed result can never drop or duplicate a
 * bead's assignment.
 *
 * Pure: no I/O, no agent() calls.
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
 * Deterministic streak grouping from planner-emitted lane metadata (`streak` /
 * `streakOrder`, recorded by planner.md through the same beads `--metadata`
 * channel as `model`), intersected with the CURRENT ready set. When every ready
 * bead is laned the grouping is fully determined by the plan and no agent()
 * call is needed.
 *
 * Contract (mirrors selectStreaks' return shape, so the two are interchangeable
 * at the call site):
 * - Returns `null` when ANY ready bead is missing a non-empty
 *   `metadata.streak`. A partly-laned plan counts as "no lane metadata" so the
 *   caller falls back to the LLM assignment path; a plan must never be grouped
 *   by a mix of the two mechanisms.
 * - Otherwise returns `{ streaks, reason: null }`, arrays of the ORIGINAL bead
 *   objects grouped by `streak` id.
 *
 * Ordering is total and stable: within a lane by numeric `streakOrder`
 * ascending (missing/non-numeric last), then `title`, then `id`; lanes by their
 * minimum `streakOrder`, then `streak` id. Members of a ready set are mutually
 * unblocked by definition (a `blocks` edge would keep the blocked side out of
 * the set), so `streakOrder` alone cannot violate a blocks edge and the
 * title/id tiebreak only separates otherwise-equal peers.
 *
 * Pure: no I/O, no agent() calls.
 * @param {Array<{id: string, title?: string, metadata?: {streak?: string, streakOrder?: number|string}}>} currentReady
 * @returns {{ streaks: Array<Array<object>>, reason: null } | null}
 */
export function groupStreaksFromLaneMetadata(currentReady) {
    if (!Array.isArray(currentReady) || currentReady.length === 0) {
        return null;
    }
    // A single un-laned bead disqualifies the whole deterministic path.
    for (const b of currentReady) {
        const streakId = b && b.metadata && b.metadata.streak;
        if (typeof streakId !== 'string' || streakId.trim() === '') {
            return null;
        }
    }

    const orderOf = (b) => {
        const raw = b.metadata.streakOrder;
        const n = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
        return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
    };
    const withinLane = (a, b) =>
        orderOf(a) - orderOf(b)
        || String(a.title || '').localeCompare(String(b.title || ''))
        || String(a.id).localeCompare(String(b.id));

    const lanes = new Map();
    for (const b of currentReady) {
        const streakId = b.metadata.streak;
        if (!lanes.has(streakId)) lanes.set(streakId, []);
        lanes.get(streakId).push(b);
    }

    const laneEntries = [...lanes.entries()].map(([streakId, beads]) => {
        const sorted = beads.slice().sort(withinLane);
        const minOrder = Math.min(...sorted.map(orderOf));
        return { streakId, sorted, minOrder };
    });
    laneEntries.sort((x, y) =>
        x.minOrder - y.minOrder
        || String(x.streakId).localeCompare(String(y.streakId)));

    return { streaks: laneEntries.map((e) => e.sorted), reason: null };
}

export const SIZE_POINTS = Object.freeze({ S: 1, M: 2, L: 4 });
export const MODEL_WEIGHT = Object.freeze({ cheap: 1, standard: 10, premium: 20 });
export const DEFAULT_EFFORT_THRESHOLD = 200;

/**
 * Effort formula shared with planner.md: `effort = (sum of per-task size
 * points) x (max model weight across the lane)`. planner.md documents the
 * same formula as design-time math the planner applies when authoring lane
 * metadata; this is the executable reference the runtime effort budget and
 * the unit tests use.
 * @param {Array<{size: 'S'|'M'|'L', model: 'cheap'|'standard'|'premium'}>} tasks
 * @returns {number}
 */
export function computeLaneEffort(tasks) {
    const sizeSum = tasks.reduce((acc, t) => acc + (SIZE_POINTS[t.size] || 0), 0);
    const maxWeight = tasks.reduce((acc, t) => Math.max(acc, MODEL_WEIGHT[t.model] || 0), 0);
    return sizeSum * maxWeight;
}

// Ceiling, in estimated tokens, above which a resumed session is treated as
// near its context window (see createRoundSessionRegistry).
export const DEFAULT_CONTEXT_CEILING = 150000;

/**
 * Per-role, per-cycle session registry driving "round resume": within ONE
 * sprint cycle's approval loop a role (planner, reviewer, ...) resumes its OWN
 * prior-round session by explicit session id, so a re-plan / re-review keeps
 * the context it already built. The session id comes from agent()'s
 * onSessionId callback (packages/apra-fleet-workflow).
 *
 * Guards, all enforced here so the call sites stay tiny:
 *   - NEVER resume across cycles (fresh eyes): an entry is keyed to the cycle
 *     it was recorded in; asking for another cycle yields a fresh session.
 *   - A failed/timed-out round resumes nothing: its call site invokes
 *     clear(role), so a broken partial context is never carried forward.
 *   - An entry whose recorded usage was at/above `ceilingFraction` of
 *     `contextCeiling` yields a fresh session, since resuming a session near
 *     its window limit starts the next round out of room. This only bites when
 *     the provider actually reported usage: with no usage number the entry is
 *     never flagged near-ceiling and resume proceeds.
 *   - Resume support is detected by CAPABILITY, not provider name: a provider
 *     that cannot resume returns no session id, record() stores nothing, and
 *     resumeArgFor() yields `false`. There is deliberately no
 *     `provider === 'claude'`-style name test anywhere.
 *
 * @param {{ log?: (msg: string) => void, contextCeiling?: number, ceilingFraction?: number }} [opts]
 */
export function createRoundSessionRegistry(opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const contextCeiling = typeof opts.contextCeiling === 'number' && opts.contextCeiling > 0
        ? opts.contextCeiling
        : DEFAULT_CONTEXT_CEILING;
    const ceilingFraction = typeof opts.ceilingFraction === 'number' && opts.ceilingFraction > 0
        ? opts.ceilingFraction
        : 0.9;
    // role -> { cycle: number, sessionId: string, nearCeiling: boolean }
    const byRole = new Map();

    /**
     * Record the session id a dispatch of `role` returned during `cycle`.
     * A no-op for a missing/empty id (e.g. a provider that does not support
     * resume) so the next round stays fresh.
     */
    function record(role, cycle, sessionId, meta = {}) {
        if (!role || typeof sessionId !== 'string' || sessionId === '') {
            return;
        }
        const totalTokens = meta && meta.usage && typeof meta.usage.total_tokens === 'number'
            ? meta.usage.total_tokens
            : null;
        const nearCeiling = totalTokens !== null && totalTokens >= contextCeiling * ceilingFraction;
        byRole.set(role, { cycle, sessionId, nearCeiling });
        if (nearCeiling) {
            log(`[round-resume] ${role} session recorded near the context ceiling ` +
                `(~${totalTokens} tokens >= ${Math.round(contextCeiling * ceilingFraction)}); ` +
                `the next round in this cycle will start a FRESH session.`);
        }
    }

    /**
     * The `resume` argument the NEXT dispatch of `role` in `cycle` should carry:
     * the stored session id (a string) to resume that same session, or `false`
     * to start fresh. Fresh whenever there is no prior round, the prior round
     * was in a different cycle, the prior round ended near the context ceiling,
     * or no session id was ever captured (provider without resume support).
     */
    function resumeArgFor(role, cycle) {
        const entry = byRole.get(role);
        if (!entry) return false;                 // no prior round -> fresh (R1)
        if (entry.cycle !== cycle) return false;  // never resume across cycles
        if (entry.nearCeiling) return false;      // near context ceiling -> fresh
        if (!entry.sessionId) return false;       // no captured id -> fresh
        return entry.sessionId;                   // resume THAT session explicitly
    }

    /**
     * Drop any stored session for `role` so its next round starts fresh. Called
     * by a dispatch site when the just-run round failed/timed out -- resuming a
     * failed session would carry a broken/partial context forward.
     */
    function clear(role) {
        byRole.delete(role);
    }

    return { record, resumeArgFor, clear };
}

// ---------------------------------------------------------------------------
// Multi-streak assignment per doer (ordered worklists)
// ---------------------------------------------------------------------------
//
// When a develop round has more ready streaks than doers, these functions pack
// them into PER-DOER ORDERED WORKLISTS so one doer can work several streaks
// back to back -- resuming its own session between them (mode ii, default) or
// carrying the whole worklist in a single batched dispatch (mode i,
// config-gated) -- instead of re-paying the fixed dispatch overhead per streak.
//
// The assignment/ordering decision is deterministic and makes no LLM call.

// Tier-grouping key for a streak with no model metadata at all. Such a streak
// gets its own group rather than being folded into a real tier, which would
// either under-run required work or silently upgrade cheap work.
const UNSPECIFIED_TIER_KEY = 'unspecified';

/**
 * A streak's REQUIRED model tier: the maximum (most-capable) tier across its
 * member beads' `metadata.model`, per planner.md's "max model weight in the
 * lane" formula. A streak must never execute on a tier below this. Beads whose
 * model metadata is missing or is not one of the three tier names contribute
 * nothing; a streak where no bead names a tier returns `null`, and the
 * dispatch runs untiered.
 * @param {Array<{metadata?: {model?: unknown}}>} streak
 * @returns {'cheap'|'standard'|'premium'|null}
 */
export function streakRequiredTier(streak) {
    let best = null;
    for (const bead of streak || []) {
        const tier = normalizeTierToken(bead && bead.metadata && bead.metadata.model);
        if (typeof tier === 'string' && MODEL_WEIGHT[tier] && (!best || MODEL_WEIGHT[tier] > MODEL_WEIGHT[best])) {
            best = tier;
        }
    }
    return best;
}

/**
 * A streak's priority: the MINIMUM (i.e. most urgent) numeric priority among
 * its member beads (bd's `priority` field, where 0 = P0). Beads without a
 * numeric priority contribute nothing; a streak with none at all returns
 * POSITIVE_INFINITY so it sorts after every priority-carrying streak and falls
 * through to the deterministic tie-break.
 * @param {Array<{priority?: unknown}>} streak
 * @returns {number}
 */
export function streakMinPriority(streak) {
    let min = Number.POSITIVE_INFINITY;
    for (const bead of streak || []) {
        const p = bead ? bead.priority : undefined;
        if (typeof p === 'number' && Number.isFinite(p) && p < min) {
            min = p;
        }
    }
    return min;
}

/**
 * A streak's effort-point total, computed with the shared planner.md formula
 * (computeLaneEffort: sum of size points x max model weight). planner.md only
 * mandates `model`/`streak`/`streakOrder` metadata, so a bead usually carries
 * no size: a bead without a usable `metadata.size` (S/M/L) defaults to 'M',
 * the middle of the scale, and a bead without a tier-shaped model defaults to
 * 'standard' for the WEIGHT term only. The defaults feed budget arithmetic and
 * never affect which model a dispatch runs on -- streakRequiredTier decides
 * that.
 * @param {Array<{metadata?: {size?: unknown, model?: unknown}}>} streak
 * @returns {number}
 */
export function streakEffortPoints(streak) {
    const tasks = (streak || []).map((bead) => {
        const rawSize = bead && bead.metadata ? bead.metadata.size : undefined;
        const size = typeof rawSize === 'string' && SIZE_POINTS[rawSize.trim().toUpperCase()]
            ? rawSize.trim().toUpperCase()
            : 'M';
        const tier = normalizeTierToken(bead && bead.metadata && bead.metadata.model);
        const model = typeof tier === 'string' && MODEL_WEIGHT[tier] ? tier : 'standard';
        return { size, model };
    });
    return computeLaneEffort(tasks);
}

/**
 * The ids a bead declares a `blocks`-type dependency on, i.e. beads that must
 * finish BEFORE it. Accepts either shape a dependency entry can take: a full
 * object carrying `dependency_type` (as `bd show --json` emits) or a plain id
 * string. Entries of any other dependency type are not ordering constraints
 * and are ignored.
 * @param {{dependencies?: Array<string|{id?: string, depends_on_id?: string, dependency_type?: string}>}} bead
 * @returns {string[]}
 */
export function beadBlocksDependencyIds(bead) {
    const out = [];
    const deps = bead && Array.isArray(bead.dependencies) ? bead.dependencies : [];
    for (const dep of deps) {
        if (typeof dep === 'string' && dep) {
            out.push(dep);
        } else if (dep && typeof dep === 'object') {
            if (dep.dependency_type && dep.dependency_type !== 'blocks') continue;
            const id = dep.depends_on_id || dep.id;
            if (typeof id === 'string' && id) out.push(id);
        }
    }
    return out;
}

/**
 * The tier policy for this round's worklist assignment, and the single place
 * the "provider supports model-switch-on-resume" capability check is made.
 * Mode (i) BATCH is one dispatch and therefore one model, so it ALWAYS
 * requires a tier-homogeneous worklist; a mixed batch is rejected at
 * assignment time rather than resolved by running everything at max tier. Mode
 * (ii) RESUMED SEQUENCE may carry mixed tiers only when the provider can
 * change model on a resumed session, signalled by `resumeModelSwitch`, whose
 * default of false is the safe fallback to tier-homogeneous grouping.
 * @param {{ mode: 'resume'|'batch', resumeModelSwitch?: boolean }} opts
 * @returns {{ tierHomogeneous: boolean }}
 */
export function resolveWorklistTierPolicy({ mode, resumeModelSwitch = false }) {
    if (mode === 'batch') return { tierHomogeneous: true };
    return { tierHomogeneous: !resumeModelSwitch };
}

/**
 * Whether the last dispatch's reported usage leaves enough context headroom to
 * RESUME that session for the next streak. Mirrors createRoundSessionRegistry's
 * near-ceiling rule: admission fails when the reported total_tokens is at or
 * above `ceilingFraction` of `contextCeiling`. Unknown usage admits, the same
 * stance the registry takes. On refusal the caller must fall back to a FRESH
 * session carrying the FULL prompt -- never a delta prompt into a fresh
 * session, since a delta only makes sense against a resumed session id.
 * @param {{total_tokens?: number}|null|undefined} usage
 * @param {{ contextCeiling?: number, ceilingFraction?: number }} [opts]
 * @returns {boolean}
 */
export function hasContextHeadroomForResume(usage, opts = {}) {
    const contextCeiling = typeof opts.contextCeiling === 'number' && opts.contextCeiling > 0
        ? opts.contextCeiling
        : DEFAULT_CONTEXT_CEILING;
    const ceilingFraction = typeof opts.ceilingFraction === 'number' && opts.ceilingFraction > 0
        ? opts.ceilingFraction
        : 0.9;
    const totalTokens = usage && typeof usage.total_tokens === 'number' ? usage.total_tokens : null;
    if (totalTokens === null) return true;
    return totalTokens < contextCeiling * ceilingFraction;
}

/**
 * Packs this round's streaks (as produced by groupStreaksFromLaneMetadata or
 * selectStreaks) into per-doer ORDERED worklists.
 *
 * Pass-through: when `streaks.length <= doerCount` there is nothing to pack --
 * every doer gets exactly one streak in the exact input order, with no
 * re-sorting, no budget, and no tier logic.
 *
 * Packing path (`streaks.length > doerCount`) orders streaks by, in strict
 * precedence:
 *  1. `blocks`-edge constraints between streaks, which are HARD: a streak
 *     depending on beads in another streak of this round is placed in the SAME
 *     worklist AFTER that streak, co-location being the only arrangement that
 *     guarantees order under the global FIFO dispatch gate, or overflows if
 *     that is impossible. A streak whose in-round dependency overflowed
 *     overflows too. Lane formation normally prevents such edges between ready
 *     streaks, but one that exists is never violated.
 *  2. Priority: among streaks with no dependency relationship,
 *     streakMinPriority ascending, so a P3 streak never occupies a doer ahead
 *     of an equally-ready P0 streak.
 *  3. Input index, which is itself already a deterministic order (lane
 *     minOrder, then streakId/title/id on the lane-metadata path), so the
 *     tie-break adds no nondeterminism.
 *
 * Grouping rules:
 *  - TIER-OUTLIER ISOLATION: streaks are PARTITIONED BY TIER FIRST, before any
 *    priority/effort-budget packing, and each partition packs independently
 *    into its own slot(s). A minority-tier outlier is never folded into a
 *    majority-tier worklist just because effort-budget headroom allows it,
 *    which is what keeps tier homogeneity from silently escalating cheaper
 *    work to a costlier tier. Slots round-robin over the doer pool at the
 *    dispatch site, so under a homogeneous tier policy more partitions than
 *    doers still dispatch this round, each as its own tier-pure worklist on a
 *    shared doer; a mixed worklist is never built. When mixed tiers are
 *    allowed, whole partitions merge into at most doerCount worklists, each
 *    appended as its own CONTIGUOUS run, never interleaved with another tier's
 *    streaks.
 *  - Effort budget (opts.effortBudget, default DEFAULT_EFFORT_THRESHOLD, in
 *    the planner.md effort points): a streak joins a non-empty worklist only
 *    if the running total stays within budget, otherwise it queues to the next
 *    round via `overflow`. An EMPTY worklist always accepts, so a single
 *    over-budget streak still dispatches rather than starving forever.
 *
 * @param {Array<Array<object>>} streaks - arrays of ORIGINAL bead objects
 * @param {number} doerCount
 * @param {{ effortBudget?: number, tierHomogeneous?: boolean }} [opts]
 * @returns {{
 *   worklists: Array<Array<Array<object>>>,  // worklists[doerIndex] = ordered streak list
 *   overflow: Array<Array<object>>,          // streaks queued to the next round
 *   packed: boolean,                          // false = pass-through (no packing needed)
 * }}
 */
export function assignDoerWorklists(streaks, doerCount, opts = {}) {
    if (!Array.isArray(streaks) || streaks.length === 0
        || !Number.isInteger(doerCount) || doerCount < 1) {
        return { worklists: [], overflow: [], packed: false };
    }
    if (streaks.length <= doerCount) {
        return { worklists: streaks.map((s) => [s]), overflow: [], packed: false };
    }

    const effortBudget = typeof opts.effortBudget === 'number' && opts.effortBudget > 0
        ? opts.effortBudget
        : DEFAULT_EFFORT_THRESHOLD;
    const tierHomogeneous = opts.tierHomogeneous === true;

    // --- Descriptors -------------------------------------------------------
    const descs = streaks.map((streak, index) => ({
        streak,
        index,
        priority: streakMinPriority(streak),
        tierKey: streakRequiredTier(streak) || UNSPECIFIED_TIER_KEY,
        effort: streakEffortPoints(streak),
        beadIds: new Set(streak.map((b) => String(b && b.id))),
        depIndexes: new Set(),
    }));
    const descByBeadId = new Map();
    for (const d of descs) {
        for (const id of d.beadIds) descByBeadId.set(id, d);
    }
    for (const d of descs) {
        for (const bead of d.streak) {
            for (const depId of beadBlocksDependencyIds(bead)) {
                const other = descByBeadId.get(String(depId));
                if (other && other !== d) d.depIndexes.add(other.index);
            }
        }
    }

    // --- Global order: dependency (hard) -> priority -> input index --------
    // Kahn-style topological pass that, among the currently-unblocked streaks,
    // always picks the (priority, index)-minimal one, so dependency order wins
    // over priority and priority only orders mutually-independent streaks.
    const order = [];
    const remaining = new Set(descs.map((d) => d.index));
    while (remaining.size > 0) {
        let ready = [...remaining]
            .map((i) => descs[i])
            .filter((d) => [...d.depIndexes].every((di) => !remaining.has(di)));
        if (ready.length === 0) {
            // Dependency cycle between streaks (cannot happen for genuinely
            // ready beads; defensive) -- fall back to (priority, index) order
            // for the remainder rather than looping forever.
            ready = [...remaining].map((i) => descs[i]);
        }
        ready.sort((a, b) => a.priority - b.priority || a.index - b.index);
        const next = ready[0];
        order.push(next);
        remaining.delete(next.index);
    }

    // --- Packing: TIER-OUTLIER ISOLATION (partition-first) ------------------
    // Streaks are partitioned by tier before any priority/effort-budget
    // packing, and each partition's slot(s) pack independently, so a
    // minority-tier outlier is never folded into a majority-tier worklist and
    // silently escalated to that tier's cost. The global topo+priority order
    // applies WITHIN a partition; partitions are claimed in order of their
    // first appearance in that order, so the highest-priority work claims
    // slots first.
    //
    // A SLOT is not a doer: the returned worklists round-robin over the doer
    // pool at the dispatch site (worklists[i] -> doerPool[i % N]), so more
    // partitions than doers still all dispatch this round, sequentially on a
    // shared doer via the global FIFO gate. Sessions never carry across
    // worklists, so a shared doer's second worklist is tier-pure by
    // construction.
    const overflow = [];
    const overflowed = new Set();
    const slots = []; // { items: desc[], effort: number }
    const slotOfDesc = new Map(); // desc.index -> slot object

    const newSlot = () => {
        const slot = { items: [], effort: 0 };
        slots.push(slot);
        return slot;
    };
    const fits = (slot, d) => slot.items.length === 0 || slot.effort + d.effort <= effortBudget;
    const place = (slot, d) => {
        slot.items.push(d);
        slot.effort += d.effort;
        slotOfDesc.set(d.index, slot);
    };
    const spill = (d) => {
        overflow.push(d.streak);
        overflowed.add(d.index);
    };

    // Tier partitions, in order of each tier's first appearance in the global
    // order; members stay in global (topo -> priority -> tie-break) order.
    const partitions = [];
    const partitionByTier = new Map();
    for (const d of order) {
        if (!partitionByTier.has(d.tierKey)) {
            const p = { tierKey: d.tierKey, members: [], slots: [] };
            partitionByTier.set(d.tierKey, p);
            partitions.push(p);
        }
        partitionByTier.get(d.tierKey).members.push(d);
    }

    // Slot allocation. Every partition gets AT LEAST one dedicated slot
    // (outlier isolation: a 1-streak minority partition gets a whole slot of
    // its own before any majority partition gets a second one) -- EXCEPT in
    // the mixed-tiers-allowed case below when partitions outnumber doers.
    // When there are FEWER partitions than doers, the spare doer capacity is
    // handed out one slot at a time to the partition with the highest
    // per-slot load (ties: earliest partition), so e.g. 4 same-tier streaks
    // over 2 doers still split 2/2. Deterministic throughout.
    if (!tierHomogeneous && partitions.length > doerCount) {
        // Mixed tiers allowed and more partitions than doers: merge WHOLE
        // partitions into doerCount slots, each appended as its own contiguous
        // run so no tier's streaks interleave with another's. Each partition
        // joins the slot with the fewest streaks claimed so far, ties broken by
        // creation order. Claims are whole partitions, so balance on claimed
        // member counts rather than on items already placed.
        for (let i = 0; i < doerCount; i++) newSlot();
        const claimedCount = new Map(slots.map((s) => [s, 0]));
        for (const p of partitions) {
            const host = slots
                .map((slot, si) => ({ slot, si }))
                .sort((a, b) => claimedCount.get(a.slot) - claimedCount.get(b.slot) || a.si - b.si)[0].slot;
            p.slots = [host];
            claimedCount.set(host, claimedCount.get(host) + p.members.length);
        }
    } else {
        for (const p of partitions) {
            p.slots = [newSlot()];
        }
        let spare = doerCount - partitions.length;
        while (spare > 0) {
            let target = null;
            for (const p of partitions) {
                const load = p.members.length / p.slots.length;
                if (!target || load > target.members.length / target.slots.length) target = p;
            }
            if (!target) break;
            target.slots.push(newSlot());
            spare--;
        }
    }

    // Dependency gate: a streak whose in-round `blocks` dependency
    // overflowed, is not placed yet (cross-partition edges are placed in
    // partition order, and slots interleave at dispatch time, so order across
    // slots is never guaranteed), or whose placed dependencies span slots the
    // candidate set cannot honor, overflows to the next round (its dependency
    // closes first). Returns the single slot all placed deps share, `null`
    // for "no in-round dependency constraint", or `false` for "cannot place".
    const depSlotFor = (d) => {
        if (d.depIndexes.size === 0) return null;
        const depSlots = new Set();
        for (const di of d.depIndexes) {
            if (overflowed.has(di)) return false;
            if (!slotOfDesc.has(di)) return false; // not placed (yet) -> no order guarantee
            depSlots.add(slotOfDesc.get(di));
        }
        return depSlots.size === 1 ? [...depSlots][0] : false;
    };

    for (const p of partitions) {
        for (const d of p.members) {
            const depSlot = depSlotFor(d);
            if (depSlot === false) { spill(d); continue; }
            // Dependency co-location: the dependent must land in the SAME
            // slot AFTER its dependency -- but only if that slot is one this
            // partition may use (tier purity is never sacrificed for a
            // dependency; a cross-tier in-round edge overflows instead).
            const candidates = (depSlot !== null ? [depSlot] : p.slots)
                .filter((slot) => (depSlot === null || p.slots.includes(slot)) && fits(slot, d))
                .sort((a, b) => a.items.length - b.items.length || slots.indexOf(a) - slots.indexOf(b));
            if (candidates.length === 0) spill(d);
            else place(candidates[0], d);
        }
    }

    // Drop slots that ended up empty (a mixed-merge pre-created slot no
    // partition landed on, or a partition slot whose members all spilled).
    const worklists = slots
        .filter((slot) => slot.items.length > 0)
        // Worklist order within each slot = insertion order: contiguous tier
        // blocks (partition-by-partition placement), and inside each block
        // the global topo -> priority -> tie-break order (partition members
        // were placed in that order).
        .map((slot) => slot.items.map((d) => d.streak));

    return { worklists, overflow, packed: true };
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

/**
 * Builds the self-contained reviewer dispatch prompt. The reviewer is
 * dispatched without resume and so has no memory of this run: the exact bead
 * ids just worked, their full `bd show` detail (acceptance criteria), the diff
 * range, and the sprint goal priority are all spelled out rather than assumed.
 *
 * CRITICAL: explicitly, redundantly forbids the reviewer from mutating
 * beads itself. agents/reviewer.md's own prose (Step 5, Rules) already
 * states this same prohibition -- prose and dispatch prompt agree today --
 * but the schema alone doesn't stop the reviewer from shelling out `bd`
 * commands on the member side regardless of what either document says, so
 * the prohibition is stated here too as defense in depth, not because of
 * any known prose/code divergence.
 * apra-fleet-s6d: `beadIds` may legitimately be EMPTY. The Cycle Evaluation
 * re-review asks a scope-wide question ("no goal-priority beads are open --
 * is the sprint actually done?"), so it has no bead ids to name. Rendering
 * the per-bead framing anyway produced the literal dangling sentence
 * "...for the following bead id(s): ." plus a SPRINT SCOPE block ordering the
 * reviewer to judge "ONLY against the named bead id(s) above" -- against an
 * empty set. The reviewer answered honestly (CHANGES_NEEDED with nothing to
 * reopen and nothing to create), which is exactly what
 * isReviewerContractViolation flags; the retry re-sent the identical
 * incoherent prompt, so the sprint aborted on ReviewerContractViolationError.
 * The empty case therefore gets its own coherent scope-wide framing.
 *
 * @param {{ beadIds: string[], acceptanceCriteriaJson: string, baseBranch: string, branch: string, goal?: string, kbCandidates?: object[] }} opts
 * @returns {string}
 */
/**
 * apra-fleet-0ef / apra-fleet-nx7: the "KNOWLEDGE BANK -- promotion candidates"
 * block, shared verbatim by the per-round reviewer prompt and the Final Review
 * prompt.
 *
 * It lives in one function because the two prompts must state the SAME evidence
 * bar. Duplicating the text invites them to drift, and a drifted bar is
 * invisible: both sides would still "work", just to different standards, and the
 * only symptom would be inconsistent CONFIRMED quality months later.
 *
 * Returns a single-element array (or an empty one) so callers can spread it into
 * their prompt-section list.
 *
 * @param {object[]|undefined} kbCandidates
 * @returns {string[]}
 */
/**
 * KB audit 2026-08-11: the "KNOWLEDGE BANK -- what this repo already knows"
 * block, shared by the doer and reviewer dispatch prompts.
 *
 * WHY THIS EXISTS AT ALL. Every role contract's Step 0 tells the role to call
 * kb_session_prime itself. On a fleet-member dispatch it cannot: the member's
 * composed permission config disables the apra-fleet MCP server outright
 * (src/providers/claude.ts composePermissionConfig), so the tool is not merely
 * unlisted, it is unreachable. That is the same wall kb_promotions hit, and
 * this is the same fix -- the engine performs the read and hands the result
 * over as prompt content. Step 0 stays correct for the OTHER execution path
 * (an apra-pm orchestrator session running these contracts as local subagents,
 * where the MCP server is present), so both paths now get knowledge.
 *
 * The trust ladder is restated here rather than assumed: these entries are
 * agent-authored claims from earlier sprints, and CONFIRMED means a reviewer
 * verified the claim, not that it is currently true of this branch's tree.
 *
 * Returns a single-element array (or an empty one) so callers can spread it
 * into their prompt-section list, matching kbPromotionBlock.
 *
 * @param {object[]|undefined} entries
 * @returns {string[]}
 */
/**
 * Roles whose prompt BUILDER places the knowledge block itself, at a position
 * that carries meaning. Everything else receives it from the agent() wrapper.
 * Listing them here (rather than inside the wrapper) keeps the two halves of
 * that split visible from the block's own definition -- a role added to one
 * side and forgotten on the other either gets the block twice or never.
 */
export const KB_SELF_INJECTING_ROLES = Object.freeze(new Set([ROLE_DOER, ROLE_REVIEWER]));

/**
 * FTS terms for a dispatch's kb_query, drawn from what the engine already
 * holds: the beads being worked and their ids.
 *
 * Bead TITLES are the useful half -- they are prose about the change ("stop
 * collapsing unknown_zone into unbound_roi"), which is what matches an entry's
 * title/summary/content. Ids are included because a bead id occasionally
 * appears verbatim in a captured entry, and query() OR-joins its terms, so a
 * term that matches nothing costs a little ranking noise rather than filtering
 * the result to empty. Non-string and blank values are dropped so a partially
 * populated bead cannot produce a malformed query.
 *
 * @param {Array<{id?: string, title?: string}>} beads
 * @param {string[]} beadIds
 * @returns {string[]}
 */
export function kbQueryTerms(beads, beadIds) {
    const terms = [];
    for (const b of Array.isArray(beads) ? beads : []) {
        if (b && typeof b.title === 'string' && b.title.trim()) terms.push(b.title.trim());
    }
    for (const id of Array.isArray(beadIds) ? beadIds : []) {
        if (typeof id === 'string' && id.trim()) terms.push(id.trim());
    }
    return terms;
}

export function kbKnowledgeBlock(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return [];
    return [
        'KNOWLEDGE BANK -- what this repo already knows. These entries were captured and '
        + 'verified during earlier work on this repository, and are provided so you do not '
        + 'rediscover them the hard way. Read them BEFORE you start.\n'
        + 'CONFIRMED entries were independently verified by a reviewer: trust them. INFERRED '
        + 'entries are unverified hints: treat them as leads to check, not as facts. An entry '
        + 'describes the tree it was captured against, so if one contradicts what you actually '
        + 'observe in the code right now, the code wins -- say so in your notes rather than '
        + 'bending your work to fit the entry.\n'
        + 'You do not need to call any kb_* tool to read these. If you discover something '
        + 'non-obvious and durable while working, report it in the `kb_captures` field of your '
        + 'structured output and the orchestrator will record it.\n'
        + wrapUntrustedBlock('kb_session_prime --top_entries', JSON.stringify(
            entries.map((e) => ({
                confidence: e.confidence,
                title: e.title,
                summary: e.summary,
                source_files: e.source_files,
            })),
            null,
            2
        )),
    ];
}

export function kbPromotionBlock(kbCandidates) {
    if (!Array.isArray(kbCandidates) || kbCandidates.length === 0) return [];
    return [
        'KNOWLEDGE BANK -- promotion candidates. These entries were captured during this '
        + 'sprint and sit at INFERRED. You are the only role that can promote them to '
        + 'CONFIRMED. Do NOT call any kb_* tool yourself: return your decisions in the '
        + '`kb_promotions` field of your structured output as [{id, reason}] and the '
        + 'orchestrator executes them.\n'
        + 'Promote ONLY entries whose claim you independently verified during THIS review '
        + '-- by reading the diff, running the tests, or checking the cited files yourself. '
        + 'The `reason` must state that evidence (at least 20 characters, e.g. "verified '
        + 'against server/transit.js:88 and the reopen test"). Evidence, not plausibility: '
        + 'if an entry merely looks correct, leave it INFERRED -- that is a perfectly good '
        + 'resting state, and a wrong CONFIRMED entry is worse than no entry. Never '
        + 'blanket-promote, and never promote by module, tag or timestamp. Promoting '
        + 'nothing is a valid outcome; return [] in that case.\n'
        + wrapUntrustedBlock('kb_list --confidence INFERRED', JSON.stringify(
            kbCandidates.map((e) => ({
                id: e.id,
                title: e.title,
                summary: e.summary,
                source_files: e.source_files,
            })),
            null,
            2
        )),
    ];
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
 * Detects the reviewer contract violation described on
 * `ReviewerContractViolationError`: a `CHANGES_NEEDED` verdict naming nothing
 * to reopen, proposing no follow-up work, AND naming no scoped-replan targets
 * is schema-legal but self-contradictory -- the orchestrator has nothing to
 * act on, so the sprint cannot make progress off of it. A non-empty
 * `replanIds` exempts the verdict from that hard abort even with empty
 * reopenIds/newTasks -- NOT because the field is guaranteed to be consumed
 * (the scoped-replan machinery below only acts on replanIds entries ALSO
 * named in reopenIds this round; see buildReviewerPrompt and the fold-in
 * loop around the `replanIds: DROPPED` log line), but because a verdict that
 * names a genuine replan intent in `notes` still represents real reviewer
 * signal worth an ordinary next-round retry rather than a hard sprint abort.
 * @param {{ verdict: string, reopenIds?: string[], replanIds?: string[], newTasks?: object[] }} verdict
 * @returns {boolean}
 */
export function isReviewerContractViolation(verdict) {
    return verdict.verdict === 'CHANGES_NEEDED'
        && (!verdict.reopenIds || verdict.reopenIds.length === 0)
        && (!verdict.newTasks || verdict.newTasks.length === 0)
        && (!verdict.replanIds || verdict.replanIds.length === 0);
}

/**
 * Determines whether a plan-reviewer verdict is CONFINED to specific beads
 * rather than spanning the whole plan. plan-reviewer.md carries no structured
 * per-bead findings field -- `notes` is free text that names the offending
 * bead ids -- so this scans `notes` for literal occurrences of each id already
 * known to be in scope via `taskAssignments`, which plan-reviewer.md requires
 * to be populated on every round including CHANGES_NEEDED.
 *
 * An id matches only at a non-identifier-character boundary (or the string
 * start/end), so a shorter id cannot false-positive inside a longer one that
 * merely extends it.
 *
 * @param {{ notes?: string, taskAssignments?: Array<{ id?: string }> }} verdict
 * @returns {string[]} the subset of taskAssignments ids that notes calls out by name
 */
export function extractContestedBeadIds(verdict) {
    if (!verdict || typeof verdict.notes !== 'string' || !Array.isArray(verdict.taskAssignments)) {
        return [];
    }
    const notes = verdict.notes;
    const allIds = verdict.taskAssignments
        .map((a) => a && a.id)
        .filter((id) => typeof id === 'string' && id.length > 0);
    return allIds.filter((id) => {
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const boundary = '(?:^|[^A-Za-z0-9_-])';
        const endBoundary = '(?:$|[^A-Za-z0-9_-])';
        const re = new RegExp(`${boundary}${escaped}${endBoundary}`);
        return re.test(notes);
    });
}

// ---------------------------------------------------------------------------
// newTasks validation. Reviewer-authored newTasks are LLM output, and the
// reviewer's context includes the diff under review, so an adversarial
// diff/commit could try to steer it into emitting text crafted to break out of
// a shell command.
//
// SAFE_TEXT_RE (title only) deliberately excludes: backtick, `$`,
// double-quote (the command's own quoting delimiter -- allowing it back in
// would let a title close the quote early regardless of any other
// restriction), and backslash (blocks a trailing-backslash "escape the
// closing quote" trick as well as any other backslash-based escape
// sequence). The allowed punctuation (`.,:;!?()'-_/+[]` plus space) covers
// realistic task titles while remaining inert as shell syntax in both POSIX
// and Windows member shells.
//
// apra-fleet-v75: `[`, `]` and `+` are allowed. The title is interpolated as
// `bd create "${title}"` -- inside double quotes, brackets never glob and `+`
// has no meaning, in POSIX shells or PowerShell. Excluding them rejected this
// project's own bead-title convention ([bug]/[epic]/[test] prefixes), which
// `bd create` itself accepts; a real reviewer follow-up was dropped mid-sprint
// on exactly that. The characters that ARE live inside double quotes --
// `"`, `\`, backtick, `$` -- remain excluded, which is what this guard is for.
//
// `description` no longer reaches this shell-interpolation risk at all
// (apra-fleet-eft.56.1, transport hardened in eft.73.1):
// createChildBeadWithAllocatedId() stages it to a member-local temp file
// (base64-carried, member-side) and hands that path to `bd create
// --body-file`, never interpolating it into a command string. That removed
// the injection
// surface SAFE_TEXT_RE existed to close for descriptions, so
// SAFE_DESCRIPTION_RE only enforces the repo's own ASCII-only convention
// (plus non-empty) -- legitimate technical characters ('=', '&', '+', '"',
// backticks-as-text, '%', '#', '[', ']', etc.) are allowed again.
const SAFE_TEXT_RE = /^[A-Za-z0-9 .,:;!?()'_/+[\]-]+$/;
const SAFE_DESCRIPTION_RE = /^[\t\n\r\x20-\x7E]+$/;
const SAFE_PRIORITY_RE = /^P[0-4]$/;

/**
 * Normalizes a bead-metadata model value by CONTAINMENT: a value that
 * (case-insensitively) contains exactly ONE of the three tier names --
 * 'cheap', 'standard', 'premium' -- becomes that bare tier name, so
 * 'standard-tier', 'tier-standard' and 'Standard (default)' all resolve to
 * 'standard'. A value containing zero tier names (an explicit provider model
 * id) or more than one (ambiguous) passes through unchanged. This is the
 * single read site for that metadata: an un-normalized alias would reach the
 * dispatch as a literal provider model name and fail it outright.
 * @param {unknown} raw
 * @returns {unknown}
 */
export function normalizeTierToken(raw) {
    if (typeof raw !== 'string') return raw;
    const lowered = raw.toLowerCase();
    const matches = ['cheap', 'standard', 'premium'].filter((tier) => lowered.includes(tier));
    return matches.length === 1 ? matches[0] : raw;
}

/**
 * Rewrites the handful of common non-ASCII punctuation characters LLM
 * reviewers routinely emit in newTask descriptions -- em/en dashes, curly
 * quotes, ellipsis -- to ASCII equivalents before SAFE_DESCRIPTION_RE
 * validation, so a description is not rejected wholesale over characters that
 * lose no meaning when normalized. This is a fixed substitution table, not a
 * general Unicode stripper: anything still outside the allowlist afterwards is
 * still a hard rejection. See sanitizeNewTaskTitle() below for title's own,
 * stricter table.
 * @param {string} description
 * @returns {string}
 */
export function sanitizeNewTaskDescription(description) {
    return String(description ?? '')
        .replace(/[\u2014\u2013]/g, '--') // em dash (\u2014), en dash (\u2013)
        .replace(/[\u2018\u2019]/g, "'") // curly single quotes (\u2018 \u2019)
        .replace(/[\u201C\u201D]/g, '"') // curly double quotes (\u201C \u201D)
        .replace(/\u2026/g, '...'); // horizontal ellipsis (\u2026)
}

/**
 * Same idea as sanitizeNewTaskDescription() above, for title -- but with a
 * STRICTER substitution table, since title still has to pass the tighter
 * SAFE_TEXT_RE shell-safety allowlist afterwards (it is interpolated inline
 * into a `bd create "..."` command; description is not). Every substitution
 * here maps to a character SAFE_TEXT_RE already admits, so this never
 * reopens the injection surface that allowlist exists to close -- it only
 * rescues titles that would otherwise be needlessly rejected over benign,
 * common LLM punctuation choices. Observed live (apra-fleet-vk0a's sibling
 * finding): a reviewer wrote a title referencing a CLI command in backticks
 * (`` `apra-fleet status` ``, ordinary Markdown inline-code style), which
 * SAFE_TEXT_RE rejects outright (backtick is excluded as a POSIX
 * command-substitution risk) -- the finding was then silently demoted to a
 * freetext note on the parent bead instead of becoming its own actionable
 * task. Backtick has no special meaning in a bd title (bd has no
 * code-formatting concept), so it is rewritten to a single quote here rather
 * than dropped or preserved. A literal `"`/`$`/backslash in a title is NOT
 * rewritten (there is no safe ASCII stand-in that preserves meaning without
 * reopening the injection question) -- those still hard-reject via
 * SAFE_TEXT_RE below, exactly as before this function existed.
 * @param {string} title
 * @returns {string}
 */
export function sanitizeNewTaskTitle(title) {
    return String(title ?? '')
        .replace(/[\u2014\u2013]/g, '--') // em dash (\u2014), en dash (\u2013)
        .replace(/[\u2018\u2019]/g, "'") // curly single quotes (\u2018 \u2019)
        .replace(/[\u201C\u201D]/g, "'") // curly double quotes -> single quote (a literal `"` stays disallowed in title, unlike description)
        .replace(/\u2026/g, '...') // horizontal ellipsis (\u2026)
        .replace(/`/g, "'"); // backtick (Markdown inline-code marker) -> single quote
}

/**
 * Validates one reviewer-authored newTask entry. `title` is checked against
 * SAFE_TEXT_RE because it is interpolated inline into a `bd create` command
 * string; `description` is checked against the more permissive
 * SAFE_DESCRIPTION_RE because it travels via `bd create --body-file` and is
 * never shell-interpolated (see createChildBeadWithAllocatedId). Returns
 * either `{ ok: true, title, description, priority }` (safe to use) or
 * `{ ok: false, reason }`. A rejected entry must never reach `command()` as a
 * `bd create` interpolation; rejection is non-fatal and the sprint continues.
 * @param {{ title: unknown, description: unknown, priority: unknown }} newTask
 * @returns {{ ok: true, title: string, description: string, priority: string } | { ok: false, reason: string }}
 */
export function validateNewTask(newTask) {
    const priority = String(newTask && newTask.priority);
    if (!SAFE_PRIORITY_RE.test(priority)) {
        return { ok: false, reason: `priority '${priority}' does not match required pattern ${SAFE_PRIORITY_RE}` };
    }
    const title = sanitizeNewTaskTitle(newTask && newTask.title);
    if (!title || !SAFE_TEXT_RE.test(title)) {
        return { ok: false, reason: `title fails safe-character allowlist ${SAFE_TEXT_RE} (or is empty): ${JSON.stringify(title)}` };
    }
    const description = sanitizeNewTaskDescription(newTask && newTask.description);
    if (!description || !SAFE_DESCRIPTION_RE.test(description)) {
        return { ok: false, reason: `description fails ASCII-printable validation ${SAFE_DESCRIPTION_RE} (or is empty): ${JSON.stringify(description)}` };
    }
    return { ok: true, title, description, priority };
}

/**
 * Persists a newTask that failed validateNewTask() into the parent bead's
 * notes, raw and unmodified (title/description/priority plus the rejection
 * reason), so a rejected finding is still recoverable by a human or the next
 * planner even though it was not filed as its own child bead. The note body
 * goes through the same member-side staging seam as the description path
 * (stageCommandBodyMemberSide) and is never interpolated into a shell string.
 *
 * A failure to append is logged AND re-thrown. Every call site wraps this in
 * its own try/catch whose purpose is to log the raw finding verbatim as the
 * last fallback rung; swallowing the failure here would make that rung
 * unreachable on exactly the path it exists to cover. Re-throwing is still
 * non-fatal to the sprint -- the caller's catch is what contains it.
 * @param {{ command: Function, member: string, parentId: string, newTask: unknown, reason: string, cycle?: string|number, log?: Function }} opts
 */
export async function appendRejectedFindingToParentNotes({ command, member, parentId, newTask, reason, cycle, log = () => {} }) {
    const raw = {
        cycle,
        rejectionReason: reason,
        title: newTask && newTask.title,
        description: newTask && newTask.description,
        priority: newTask && newTask.priority,
    };
    const noteBody = `[fleet-sprint newTask REJECTED -- residual validation failure, appended verbatim]\n${JSON.stringify(raw, null, 2)}`;
    try {
        const noteFile = await stageCommandBodyMemberSide({
            command, member, content: noteBody,
            label: `Stage rejected newTask finding for ${parentId} notes`,
        });
        await command(
            `bd note ${parentId} --file "${noteFile}"`,
            { member_name: member, silent: true, label: `Append rejected newTask finding to ${parentId} notes` }
        );
        log(`Rejected newTask finding appended verbatim to '${parentId}' notes (residual validation failure: ${reason}).`);
    } catch (err) {
        log(`[newTask notes-fallback] FAILED to append rejected finding to '${parentId}' notes: ${err.message}`);
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Resurfacing rejected newTasks into the next planning dispatch
// ---------------------------------------------------------------------------
//
// A note appended by appendRejectedFindingToParentNotes() is readable by a
// human but invisible to the planner, which is dispatched without resume and
// never reads bead notes. These helpers instead track the current set of
// not-yet-resubmitted rejected newTasks in run state so the planner prompt can
// carry them as explicit "previously rejected, fix and resubmit" items, and
// drop each one once resubmitted so the list cannot grow without bound. All
// are pure: the caller owns the array and none of these mutate it in place.

/**
 * Records a newly-rejected newTask into the pending resurface list, keyed by
 * title -- a newTask rejected twice under the same title keeps only the
 * LATEST rejection reason/cycle (dedup by title), so a repeatedly-resubmitted-
 * and-repeatedly-rejected item cannot grow the list unboundedly.
 * @param {Array<{title: string, description: string, reason: string, cycle: number|string}>} pending
 * @param {{title: unknown, description: unknown, reason: string, cycle: number|string}} rejected
 * @returns {Array<{title: string, description: string, reason: string, cycle: number|string}>} a NEW array
 */
export function trackRejectedNewTaskForResurfacing(pending, rejected) {
    const title = String((rejected && rejected.title) || '(untitled)');
    const description = String((rejected && rejected.description) || '');
    const entry = { title, description, reason: String(rejected && rejected.reason), cycle: rejected && rejected.cycle };
    const withoutDup = (Array.isArray(pending) ? pending : []).filter((p) => p.title !== title);
    return [...withoutDup, entry];
}

/**
 * Drops any pending rejected-newTask entries matching a newTask that has now
 * been successfully created.
 *
 * `resubmitted` may be a bare title string (title-only match) or a
 * `{title, description}` object, in which case a match on EITHER the title OR
 * a non-empty description clears the entry. Description matching is what
 * clears a resubmission whose title was corrected in response to the
 * rejection reason -- title-only matching would leave such an item pending
 * forever.
 * @param {Array<{title: string, description?: string}>} pending
 * @param {string|{title?: string, description?: string}} resubmitted
 * @returns {Array<{title: string}>} a NEW array
 */
export function clearResubmittedNewTask(pending, resubmitted) {
    const list = Array.isArray(pending) ? pending : [];
    const title = typeof resubmitted === 'string' ? resubmitted : String((resubmitted && resubmitted.title) || '');
    const description = (resubmitted && typeof resubmitted === 'object' && resubmitted.description)
        ? String(resubmitted.description) : '';
    return list.filter((p) => {
        const titleMatches = p.title === title;
        const descriptionMatches = description.length > 0 && String((p && p.description) || '') === description;
        return !(titleMatches || descriptionMatches);
    });
}

/**
 * Reconciles the pending resurface list against the parent bead's CURRENT
 * children, matching purely on description and ignoring titles. The planner
 * resubmits a corrected finding directly via `bd create` and never calls
 * clearResubmittedNewTask(), so without this pass a planner resubmission would
 * stay pending and reappear in every later planning prompt of the run. Call it
 * after any phase that may have created children under the parent (chiefly the
 * Plan phase), passing the live child list.
 * @param {Array<{title: string, description?: string}>} pending
 * @param {Array<{description?: string}>} currentChildren
 * @returns {Array<{title: string, description?: string}>} a NEW array
 */
export function reconcilePendingRejectedNewTasks(pending, currentChildren) {
    const list = Array.isArray(pending) ? pending : [];
    if (list.length === 0) return list;
    const children = Array.isArray(currentChildren) ? currentChildren : [];
    const childDescriptions = new Set(
        children
            .map((c) => String((c && c.description) || '').trim())
            .filter((d) => d.length > 0)
    );
    if (childDescriptions.size === 0) return list;
    return list.filter((p) => {
        const description = String((p && p.description) || '').trim();
        return description.length === 0 || !childDescriptions.has(description);
    });
}

/**
 * Formats the pending rejected-newTask items as explicit "previously rejected,
 * fix and resubmit" prompt lines for the planner prompt. Returns `[]` when
 * nothing is pending, so the prompt is unchanged in that case.
 * @param {Array<{title: string, description: string, reason: string, cycle: number|string}>} pending
 * @returns {string[]}
 */
export function buildRejectedNewTaskResurfaceLines(pending) {
    if (!Array.isArray(pending) || pending.length === 0) return [];
    const lines = [
        `${pending.length} previously REJECTED newTask(s) from an earlier round must be fixed and ` +
        're-submitted this planning pass. Verbatim title/description below, plus why each was ' +
        'rejected -- correct the stated defect (do not just resend the item unchanged), then create ' +
        'it via bd create as normal:',
    ];
    pending.forEach((r, i) => {
        lines.push(`${i + 1}. Title: "${r.title}"\nDescription: ${r.description}\nRejected because: ${r.reason} (cycle ${r.cycle})`);
    });
    return lines;
}

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
 * Assembles the `analysisText` block for the Harvester dispatch from this
 * run's in-memory tracking state: cycle-by-cycle closed-bead progress,
 * deploy/integration outcomes, rejected reviewer newTasks, the final verdict,
 * and the regression pass. Pure formatting -- every value is computed
 * elsewhere. harvester.md requires this content be written verbatim to
 * `analysisArtifactFile`.
 * @param {object} opts
 * @returns {string}
 */
function buildAnalysisText({
    targetIssues, branch, baseBranch, cyclesRun,
    closedCountHistory, highWaterClosedCount,
    deployFailures, integFailures, rejectedNewTasks,
    finalVerdictResult, finalClosedCount, finalOpenAtGoalCount,
    regressionResult = null,
}) {
    // The once-per-sprint Regression Test phase runs after the final verdict
    // and never gates it. Its failures are filed as parent-less carry-over
    // beads, so they never appear in the open-at-goal count and are reported
    // separately here.
    const regressionLines = regressionResult === null
        ? ['Regression pass: not run this sprint (no regression-test-playbook.md, or the probe failed).']
        : [
            `Regression pass: ${regressionResult.passed === true ? 'PASSED' : 'FAILED'} `
            + `(real-bd suite: ${regressionResult.suitePassed === true ? 'pass' : 'fail'}, `
            + `smoke test: ${regressionResult.smokePassed === true ? 'pass' : 'fail'}).`,
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
    ];
    return lines.join('\n');
}

/**
 * Builds the `costAnalysis` block for the Harvester dispatch from the live
 * `budget` object. Reports only what is known: an unset ceiling, an absent
 * spent() and an unpriced-model spend gap are each stated as such rather than
 * backfilled with a fabricated number, since harvester.md inserts this block
 * verbatim and never recomputes it. The remaining budget is derived from
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

// ---------------------------------------------------------------------------
// Typed sprint-abort detection
// ---------------------------------------------------------------------------
//
// The single predicate deciding whether an error thrown out of
// runSprintCycle() is a "sprint-abort" the caller routes through
// finalizeAbort() plus a terminal history record, as opposed to an unexpected
// failure that keeps the plain grace-window/exit-1 path with no PR and no
// history record. The intended set is:
//   - StalledSprintError, SprintPlanRejectedError and
//     ReviewerContractViolationError (errors.mjs), which this runner throws
//     itself, plus BudgetExceededError, which the workflow package throws on
//     its behalf;
//   - GitDivergedError and DoltDivergedError, the state-integrity divergences.
//     A divergence means the single-writer invariant this engine relies on is
//     already violated (or the shared beads DB genuinely cannot be
//     fast-forwarded), so no retry or later phase can recover the run -- it
//     must terminate with an operator-visible record. A DoltDivergedError also
//     arrives WRAPPED one level down inside a PostDispatchSyncError (the D-push
//     bracket's shape), so membership is decided by findDoltDivergedCause()
//     walking the cause chain rather than by the outermost class. That the
//     divergences belong in this set is not an inference: main()'s typed-abort
//     catch below already calls resolveTerminalReason()/captureDoltConflictDump()
//     precisely to report them as the distinct BEADS_SYNC_CONFLICT terminal
//     state, which is dead code unless they reach it;
//   - the plain `Error` pre-sprint validation failures, which are not
//     WorkflowError subclasses and are identified by the stable
//     'Pre-sprint validation failed:' message prefix every such throw site
//     uses.
//
// Everything else is deliberately EXCLUDED, and the check is an explicit class
// list rather than the blanket `instanceof WorkflowError` it used to be --
// which swept in every routine, non-terminal failure and turned it into a
// spurious `verdict: 'ABORTED'`:
//   - CancelledError: a cooperative cancellation is a requested shutdown, not
//     an aborted sprint, and must keep flowing through its own 'cancelled'
//     status path;
//   - AgentOutputError, AgentDispatchError, FleetTransportError, CommandError:
//     dispatch-level failures each phase's own retry/soft-fail policy owns;
//   - GitSyncError, DoltSyncError, and a PostDispatchSyncError whose cause
//     chain carries NO divergence: transient sync failures that are retried in
//     place and, if they still surface, are ordinary run failures rather than
//     sprint aborts;
//   - SprintLockHeldError: structurally unreachable here. acquireSprintLock()
//     runs in main() BEFORE its try block, so a held lock never reaches this
//     predicate; there is also no sprint of our own to finalize when another
//     engine already owns the branch.
export function isTypedAbortError(err) {
    if (!err || err instanceof CancelledError) return false;
    if (err instanceof StalledSprintError) return true;
    if (err instanceof SprintPlanRejectedError) return true;
    if (err instanceof ReviewerContractViolationError) return true;
    if (err instanceof BudgetExceededError) return true;
    if (err instanceof GitDivergedError) return true;
    // Bare DoltDivergedError, or one wrapped inside a PostDispatchSyncError.
    if (findDoltDivergedCause(err)) return true;
    return typeof err.message === 'string' && err.message.startsWith('Pre-sprint validation failed:');
}

// Deliberately BROADER than isTypedAbortError(): every terminal WorkflowError
// except a cooperative cancellation. The two predicates answer two different
// questions in main()'s catch and must not be collapsed:
//   - isTerminalSprintFailure() gates the terminal run-state record, which
//     exists so the supervisor watchdog can classify a run whose PID is gone as
//     FINISHED-with-a-reason rather than CRASHED. EVERY terminal typed failure
//     needs that, not just the aborts -- e.g. a Planner AgentDispatchError from
//     a dead interactive session must surface a reason, not look like a crash.
//   - isTypedAbortError() gates finalizeAbort()'s branch push + [ABORTED] PR,
//     which is only worth doing where there is a genuine sprint abort whose
//     partial work a human should look at.
// An untyped throw (a plain Error/TypeError -- i.e. a real bug) is deliberately
// NOT terminal here: it keeps flowing to the CLI's top-level catch with no
// record, so the watchdog still reports it as CRASHED.
export function isTerminalSprintFailure(err) {
    if (!err || err instanceof CancelledError) return false;
    return err instanceof WorkflowError || isTypedAbortError(err);
}

// AgentDispatchError reasons that mean the agent PROVABLY RAN before the
// dispatch failed, so its (possibly partial) code/beads work still has to be
// published and its teardown must run normally:
//   - 'max_turns_exhausted': the resumable partial-work case -- the agent hit
//     its turn ceiling after doing real work;
//   - 'watchdog_timeout': withDispatchWatchdog() fired locally on an
//     already-in-flight dispatch. The prompt was DELIVERED and the member is
//     alive-but-silent, so the turn may have run to completion (a stalled
//     planner can have created the whole DAG) with only the RESULT lost. The
//     watchdog abandons the dispatch promise, not the member's work.
const AGENT_RAN_DISPATCH_REASONS = new Set(['max_turns_exhausted', 'watchdog_timeout']);

// True when a thrown dispatch error means the dispatch delivered no usable
// result and therefore produced no code/beads mutation to publish: a failed
// agent dispatch (AgentDispatchError, minus the AGENT_RAN_DISPATCH_REASONS
// above), a dispatch-channel transport failure (FleetTransportError), or a
// PRE-dispatch typed sprint abort. The orchestrator's post-dispatch sync
// teardown is then wasted work and is skipped (see withGitSync).
//
// Deliberately EXCLUDED:
//   - AgentOutputError: the LLM RESPONDED and only its output was
//     empty/unparseable/schema-invalid. A schema-invalid response routinely
//     follows real committed work (the agent did the job, then botched the
//     report), so its teardown must run. This is the status quo -- the class
//     was never named here and, post-apra-fleet-9ta.1, isTypedAbortError() is
//     false for it -- pinned explicitly so a future edit cannot silently
//     re-sweep it in;
//   - every POST-dispatch typed abort. The predicate used to fold in the whole
//     of isTypedAbortError(), but only errors thrown from INSIDE withGitSync's
//     `dispatchFn` can ever reach it, and the curated abort set is dominated by
//     aborts the runner raises AFTER a dispatch already returned and mutated
//     beads (SprintPlanRejectedError, ReviewerContractViolationError,
//     StalledSprintError) or by divergences the SYNC brackets themselves throw
//     (GitDivergedError/DoltDivergedError), none of which are reachable here.
//     BudgetExceededError is the one genuinely pre-dispatch member: agent()/
//     command() throw it from inside the dispatch closure BEFORE any dispatch
//     is issued (packages/apra-fleet-workflow/src/workflow/errors.mjs), so it
//     alone provably mutated nothing.
export function isNoMutationDispatchFailure(err) {
    if (!err) return false;
    if (err instanceof AgentOutputError) return false;
    if (err instanceof AgentDispatchError && err.details && AGENT_RAN_DISPATCH_REASONS.has(err.details.reason)) {
        return false;
    }
    return err instanceof AgentDispatchError || err instanceof FleetTransportError || err instanceof BudgetExceededError;
}

// ---------------------------------------------------------------------------
// Abort-path PR publish
// ---------------------------------------------------------------------------
//
// The ordinary Publish PR step only runs when the sprint reaches a final
// PASS/FAIL verdict. A sprint that instead aborts by throwing a typed error
// would otherwise propagate straight to the CLI's top-level catch with no
// branch push and no PR, leaving any work a doer already committed visible
// only to someone willing to dig through git history. Called from the
// typed-abort catch site with the causing error, finalizeAbort():
//   1. counts commits on the sprint branch beyond base, which decides whether
//      there is anything for a human to look at;
//   2. with >=1 commit, pushes the branch and raises an idempotent
//      'Auto-sprint [ABORTED]: <branch>' PR whose body carries the error's
//      code/message/details, sanitized by sanitizePrText for the same reason
//      the PASS/FAIL step sanitizes reviewer notes;
//   3. with 0 commits, raises no PR -- there is no diff, so the PR would be
//      noise -- and reports that in its return value, so the caller can still
//      write a terminal history record.
// `command` and `log` are dependency-injected rather than closed over
// `context`, so this is callable both from the catch site and directly from
// unit tests with a mock `command`.
/**
 * @param {{
 *   error: { code?: string, message?: string, details?: unknown },
 *   branch: string,
 *   baseBranch: string,
 *   member: string,
 *   command: (cmd: string, opts: object) => Promise<any>,
 *   log?: (msg: string) => void,
 *   onAuthFailure?: (info: { member: string, label: string, cmd?: string, error: string, kind: 'git'|'dolt' }) => Promise<void>,
 *   callTool?: (name: string, args: object) => Promise<any>,
 * }} opts
 * @returns {Promise<{ prUrl: string|null, reason: string, pushed: boolean, commitCount: number }>}
 */
export async function finalizeAbort({ error, branch, baseBranch, member, command, log = () => {}, onAuthFailure, callTool }) {
    // Built up-front (not just at the PR-creation step further down) so the
    // SAME ApraFleet client can also resolve `member`'s VCS provider
    // (apra-fleet-417.7) for the runGitStep calls below -- avoids
    // constructing a second client just for that lookup. `null` when no
    // callTool is wired (e.g. a mock-sprint scenario with no MCP client);
    // every downstream use already guards on this being non-null.
    const fleetApi = typeof callTool === 'function' ? new ApraFleet({ callTool }) : null;

    // apra-fleet-417.7: resolve `member`'s VCS provider ONCE up-front so the
    // git failures below (fetch/rev-list/push) classify via that member's own
    // provider chain, not just the default 'github' one. Fails closed to
    // `undefined` (today's default chain) on any error -- a provider-
    // resolution hiccup here must never abort an otherwise-recoverable abort
    // finalization.
    let provider;
    if (fleetApi) {
        try {
            ({ provider } = await resolveProvider(member, { fleetApi }));
        } catch (err) {
            log(`finalizeAbort: could not resolve member '${member}'s VCS provider for git-failure classification (falling back to the default provider chain, no verdict change for GitHub members): ${err.message}`);
        }
    }

    // 1. How many commits (if any) does the sprint branch carry beyond base?
    // Every command() call below passes an explicit `member_name` -- this
    // runner never lets a git/gh dispatch fall back to an ambient member.
    //
    // `member` need not be a member that ever checked out a LOCAL branch named
    // `baseBranch`; it may only have the sprint branch. A bare
    // `git rev-list base..branch` would then fail with "unknown revision", so
    // fetch first and diff against the remote-tracking ref, which is always
    // resolvable: baseBranch is the ref the sprint branch was created from.
    //
    // apra-fleet-5d5.1: these three git calls now go through runGitStep()
    // (the same helper the main withGitSync dispatch bracket uses) instead of
    // calling `command()` directly, so a git-auth failure here gets the SAME
    // provision_vcs_auth self-heal-and-retry-once treatment instead of being
    // silently swallowed (live: apra-fleet-l7n Cycle 3 abort hit exactly this
    // -- "Authentication failed ... Password authentication is not
    // supported" while writing the terminal history record, with no self-heal
    // available). runGitStep never throws; a non-ok result here is re-thrown
    // as a CommandError so finalizeAbort()'s own external throw-on-failure
    // contract (see main()'s catch site, which falls back to "no PR lookup"
    // on any thrown error) is unchanged for callers.
    const fetchRes = await runGitStep({
        command, member, cmd: `git fetch origin ${baseBranch}`,
        label: `Fetch base branch '${baseBranch}' for abort-path diff`,
        log, maxTransientRetries: 1, onAuthFailure, provider,
    });
    if (!fetchRes.ok) {
        throw new CommandError(
            `[Abort Finalize Failed] git fetch origin ${baseBranch} failed: ${fetchRes.error}`,
            { details: { branch, baseBranch, error: fetchRes.error, kind: fetchRes.kind } }
        );
    }
    const revListRes = await runGitStep({
        command, member, cmd: `git rev-list --count origin/${baseBranch}..${branch}`,
        label: `Count commits beyond base for abort-path branch '${branch}'`,
        log, maxTransientRetries: 1, onAuthFailure, provider,
    });
    if (!revListRes.ok) {
        throw new CommandError(
            `[Abort Finalize Failed] git rev-list --count origin/${baseBranch}..${branch} failed: ${revListRes.error}`,
            { details: { branch, baseBranch, error: revListRes.error, kind: revListRes.kind } }
        );
    }
    const commitCount = parseInt(String(revListRes.output).trim(), 10) || 0;

    if (commitCount < 1) {
        log(`finalizeAbort: branch '${branch}' has 0 commits beyond '${baseBranch}' -- no [ABORTED] PR raised (zero-commit-abort policy).`);
        return { prUrl: null, reason: 'zero-commit-abort', pushed: false, commitCount };
    }

    // 2. There is real work on the branch -- publish it and raise the PR.
    const pushRes = await runGitStep({
        command, member, cmd: `git push -u origin ${branch}`,
        label: `Push abort-path sprint branch '${branch}'`,
        log, maxTransientRetries: 1, onAuthFailure, provider,
    });
    if (!pushRes.ok) {
        throw new CommandError(
            `[Abort Finalize Failed] git push -u origin ${branch} failed: ${pushRes.error}`,
            { details: { branch, baseBranch, error: pushRes.error, kind: pushRes.kind } }
        );
    }

    // Same origin-remote gate as the Publish PR step, via
    // VCSModule.capabilities(): a remote whose provider cannot open a PR (a
    // file:// bare mirror, or any other host with no hosting API support)
    // must never hit raiseVcsPrForMember()'s doomed REST call, which would
    // surface as a hard-to-diagnose failure while the sprint is already
    // aborting. Resolving the remote is itself failSoft -- an unresolvable
    // remote fails closed to canOpenPullRequest:false -- so a probe hiccup
    // here degrades to "PR skipped", never a thrown error. The branch above
    // is already pushed either way.
    const originUrlRes = await command('git remote get-url origin', {
        member_name: member,
        silent: true,
        failSoft: true,
        label: 'Resolve origin remote URL for abort-path PR gate',
    });
    const originUrl = originUrlRes.ok ? originUrlRes.output.trim() : '';
    const abortPathCapabilities = vcsCapabilities(originUrl);
    if (!abortPathCapabilities.canOpenPullRequest) {
        log(`finalizeAbort: origin remote '${originUrl || '(unresolved)'}' cannot open a pull request (host: ${abortPathCapabilities.host || 'unknown'}) -- skipping [ABORTED] PR creation; branch '${branch}' is still pushed.`);
        return { prUrl: null, reason: 'non-hosted-remote', pushed: true, commitCount };
    }

    const prTitle = `Auto-sprint [ABORTED]: ${branch}`;
    // The error's code/message/details can originate from agent output, and
    // this text is embedded in a VCSModule-built PR body -- same sanitization
    // rationale as the PASS/FAIL Publish PR step.
    const safeCode = sanitizePrText(error && error.code);
    const safeMessage = sanitizePrText(error && error.message);
    const safeDetails = sanitizePrText(
        error && error.details !== undefined ? JSON.stringify(error.details) : ''
    );
    const prBody = [
        `Automated apra-fleet-se sprint ABORTED before reaching a final PASS/FAIL verdict.`,
        '',
        safeCode ? `Error code: ${safeCode}` : null,
        safeMessage ? `Error message: ${safeMessage}` : null,
        safeDetails ? `Error details: ${safeDetails}` : null,
        '',
        'Do NOT auto-merge -- see pm skill R12; a human must review and merge this PR.',
    ].filter((line) => line !== null).join('\n');

    // The reverted gh-based PR creation is gone (apra-fleet-tfx.8): raise the [ABORTED] PR via
    // VCSModule's orchestrator-built curl command, dispatched to `member`
    // through execute_command, using a push+pr credential minted
    // just-in-time immediately before this one call (never at sprint setup).
    // (fleetApi is built at the top of this function, above.)
    if (!fleetApi) {
        // Graceful degradation (apra-fleet-tfx.8.1): raising the [ABORTED] PR
        // needs an MCP client to mint a just-in-time push+pr credential on
        // `member`. When no callTool is wired (e.g. a mock-sprint scenario
        // that never opted into an MCP client), the abort-path branch is
        // ALREADY pushed above -- so instead of an unconditional hard-throw
        // that would break every such pre-existing scenario, this degrades to
        // a typed 'pr-skipped-no-mcp-client' outcome: a clear log line, the
        // pushed branch still returned to the caller, only the auto-raised PR
        // skipped. In production callTool is always wired (bin/cli.mjs), so
        // this branch never runs there; it exists purely so PR creation is not
        // a hard MCP dependency for callers that legitimately have none.
        log(`[Publish Abort PR Skipped] no MCP callTool available to mint a push+pr credential for member '${member}' -- branch '${branch}' is pushed but the [ABORTED] PR was not raised.`);
        return { prUrl: null, reason: PR_SKIPPED_NO_MCP_CLIENT, pushed: true, commitCount };
    }
    const prResult = await raiseVcsPrForMember({
        fleetApi,
        command,
        member,
        base: baseBranch,
        head: branch,
        title: prTitle,
        body: prBody,
        log,
        logPrefix: '[Publish Abort PR]',
    });

    if (!prResult.ok) {
        if (prResult.authFailure) {
            // apra-fleet-647.1.1.1: a PR auth failure survives the reactive
            // one-shot self-heal+retry inside raiseVcsPrForMember (i.e. the
            // credential is still no good after re-provisioning) -- degrade
            // to a logged, non-throwing outcome instead of a CommandError, so
            // finalizeAbort() -- whose whole job is to record a sprint abort
            // -- can never itself be killed by the very auth failure it is
            // trying to report. The branch is still pushed (`pushed: true`)
            // even though the [ABORTED] PR could not be raised.
            log(`finalizeAbort: [Publish Abort PR] failed with an auth failure that survived the reactive self-heal retry for branch '${branch}' -> '${baseBranch}': ${prResult.error} -- degrading (not throwing) so the abort can still be recorded.`);
            return { prUrl: null, reason: 'pr-auth-failed', pushed: true, commitCount };
        }
        throw new CommandError(
            `[Publish Abort PR Failed] VCSModule create-pull-request failed for branch '${branch}' -> '${baseBranch}': ${prResult.error}`,
            { details: { branch, baseBranch, error: prResult.error } }
        );
    }
    if (prResult.alreadyExists) {
        // Idempotent: the desired end state -- a PR open for this branch --
        // already holds, so this is swallowed rather than thrown.
        log(`finalizeAbort: an [ABORTED] PR for branch '${branch}' already exists -- treating as idempotent success.`);
        return { prUrl: prResult.prUrl, reason: 'already-exists', pushed: true, commitCount };
    }

    return { prUrl: prResult.prUrl, reason: 'aborted-pr-created', pushed: true, commitCount };
}

// ---------------------------------------------------------------------------
// Client-side dispatch watchdog
// ---------------------------------------------------------------------------
//
// A member process can stay alive while producing no further output after a
// prompt is delivered -- a state no liveness check detects. `timeout_s` is
// threaded to execute_prompt on every dispatch, but server-side enforcement
// cannot be the only guard against an alive-but-silent orchestrator, so this
// adds a client-side backstop that depends on nothing the server does.
//
// withDispatchWatchdog() races an already-in-flight dispatch promise against a
// local timer of `timeoutS` plus this grace period, the grace existing so the
// server's own timeout gets first refusal at producing a clean error. If the
// dispatch has not settled by then, the race rejects with a typed
// AgentDispatchError (reason 'watchdog_timeout') rather than leaving the caller
// awaiting silently, and that typed error follows the same abort routing as
// every other typed dispatch failure here. Promise.race() attaches its own
// handler to the abandoned dispatch promise, so a late settlement after the
// watchdog fired is dropped rather than becoming an unhandled rejection.
const DISPATCH_WATCHDOG_GRACE_S = 30;

/**
 * @param {Promise<any>} dispatchPromise - an ALREADY-STARTED dispatch (e.g. an agent() call).
 * @param {{ timeoutS: number, member?: string, label?: string, log?: (msg: string) => void }} opts
 * @returns {Promise<any>}
 */
export function withDispatchWatchdog(dispatchPromise, opts = {}) {
    const { timeoutS, member = 'unknown', label = 'dispatch', log = () => {} } = opts;
    const budgetMs = (timeoutS + DISPATCH_WATCHDOG_GRACE_S) * 1000;
    let timer;
    const watchdogPromise = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            const message = `[dispatch-watchdog] ${label} to member '${member}' produced no result within ${timeoutS}s (+${DISPATCH_WATCHDOG_GRACE_S}s grace) -- treating this attempt as a stalled/dead session and aborting it (no code path may leave this orchestrator alive-but-silent past its configured dispatch_timeout_s).`;
            log(message);
            reject(new AgentDispatchError(
                `[Workflow Error] ${label} timed out (watchdog): no response from '${member}' within ${timeoutS}s (+${DISPATCH_WATCHDOG_GRACE_S}s grace).`,
                { details: { reason: 'watchdog_timeout', member, timeoutS, graceS: DISPATCH_WATCHDOG_GRACE_S } }
            ));
        }, budgetMs);
        // The timer is deliberately NOT unref'd. A never-settling dispatch can
        // leave this timer as the only work on the event loop; an unref'd timer
        // would then let the loop drain before it fires, so the abort would
        // never happen and the process would hang -- exactly what this watchdog
        // exists to prevent. Keeping it ref'd holds the loop open until the
        // abort fires; a dispatch that settles first is released by the
        // clearTimeout() below, so a fast dispatch never delays process exit.
    });
    return Promise.race([dispatchPromise, watchdogPromise]).finally(() => clearTimeout(timer));
}

// Pure branch-selection decision for the Ensure Sprint Branch phase. Given the
// outcomes of the probes that phase issues -- a soft-failed
// `git fetch origin/<branch>` and, when that reports the ref is missing, a
// local-branch existence probe -- this decides which checkout command to run,
// or that the phase must abort rather than touch git at all. No I/O of its
// own; the caller still issues the command() calls and does the logging.
//
// Returns one of:
//   { action: 'abort', message } -- the fetch failed for a reason other than
//     "branch doesn't exist yet", or local and origin have diverged. The
//     caller must throw and never attempt a checkout: a transient fetch
//     failure misread as "new branch" would reset the branch to base and
//     destroy pushed work.
//   { action: 'checkout', reused: true, command } -- reuse an existing local
//     branch as-is (plain `git checkout`, no reset), preserving commits that
//     exist only locally.
//   { action: 'checkout', reused: false, command, startPoint } -- normal
//     `git checkout -B <branch> <startPoint>`, where startPoint is
//     `origin/<branch>` when the fetch succeeded and `origin/<baseBranch>`
//     when the branch is genuinely new.
//
// When the fetch succeeds and a local branch also exists, the two tips can
// still disagree, because a doer may have committed without its push
// succeeding. `localTipStatus` -- the caller's comparison of the two tips via
// `git merge-base --is-ancestor` in both directions -- resolves that:
//   'behind-or-equal' -- local holds nothing origin does not; safe to reset.
//   'ahead'           -- local holds commits origin does not and origin holds
//                        none local does not; reuse the local branch so those
//                        commits survive.
//   'diverged'        -- neither tip is an ancestor of the other; abort rather
//                        than attempt any automatic merge or rebase, since
//                        either direction could discard real commits.
export function decideEnsureBranchAction({ branch, baseBranch, branchFetchOk, branchFetchError, localBranchExists, localTipStatus }) {
    // A failed fetch is only safe to read as "branch doesn't exist yet" when
    // git says exactly that. Any other failure -- network blip, auth expiry,
    // DNS hiccup -- must not fall back to origin/<baseBranch>, or a transient
    // error would silently reset the branch to base.
    if (!branchFetchOk && !/couldn't find remote ref/i.test(branchFetchError || '')) {
        return {
            action: 'abort',
            message:
                `Ensure Sprint Branch: fetch of existing branch 'origin/${branch}' ` +
                `failed for a reason other than "branch doesn't exist" (${branchFetchError || 'unknown error'}) -- ` +
                `refusing to silently fall back to resetting to base, since the branch may actually exist with real ` +
                `pushed work and this fetch failure could be transient. Investigate and retry.`,
        };
    }

    // Both refs exist and neither tip is an ancestor of the other: never
    // attempt an automatic merge or rebase, abort and let a human reconcile.
    if (branchFetchOk && localBranchExists && localTipStatus === 'diverged') {
        return {
            action: 'abort',
            message:
                `Ensure Sprint Branch: local branch '${branch}' has diverged from 'origin/${branch}' ` +
                `(neither is an ancestor of the other) -- refusing to reset or auto-merge, since either direction ` +
                `could silently discard real commits. A human needs to investigate and reconcile the two branches ` +
                `manually before this sprint can safely proceed.`,
        };
    }

    const startPoint = branchFetchOk ? `origin/${branch}` : `origin/${baseBranch}`;
    // Reuse the local branch as-is (no reset) whenever the remote ref is
    // missing entirely, or it exists but the local branch is strictly ahead of
    // it -- resetting would discard committed-but-unpushed local work.
    const reuseLocalBranch =
        (!branchFetchOk && !!localBranchExists) ||
        (branchFetchOk && !!localBranchExists && localTipStatus === 'ahead');

    if (reuseLocalBranch) {
        return {
            action: 'checkout',
            reused: true,
            command: `git checkout ${branch}`,
        };
    }

    return {
        action: 'checkout',
        reused: false,
        command: `git checkout -B ${branch} ${startPoint}`,
        startPoint,
    };
}

async function runSprintCycle(context) {
    const { agent: agentRaw, command: rawCommand, parallel, log, phase: rawPhase, group, endGroup, publishState, args, budget, setPauseGuard } = context;

    // (apra-fleet-p2to.4.1) Clean-state pause guard: this is runner.js's OWN
    // pause-awareness -- the engine's cooperative pause primitive
    // (apra-fleet-p2to.1's requestPause()/setPauseGuard()) only ever engages
    // a pending pause at a zero-in-flight-activity boundary that ALSO passes
    // this predicate, so registering it here is what keeps a pause from
    // landing mid-git/mid-dolt-sync (e.g. between a pull and its matching
    // push, or mid-D-push) and leaving the workspace/beads clone in an
    // inconsistent state to resume from. `openSyncBracketCount` counts every
    // currently-open "bracket": withGitSync()'s FULL body (pre-dispatch sync
    // through post-dispatch sync, wrapped as a single bracket below) and
    // every standalone DoltSync.syncBefore()/syncAfter() call elsewhere in
    // this file that is NOT already nested inside a withGitSync bracket (a
    // nested one is harmless double-counting, never a leak, since
    // withOpenSyncBracket()'s increment/decrement is always paired). The
    // guard itself is trivial and adds NO behavior when no pause is pending
    // -- the engine only ever consults it while a pause is deferred (see
    // FleetWorkflow._guardPermitsPause(), packages/apra-fleet-workflow/src/
    // workflow/index.mjs), so a clean run with setPauseGuard registered but
    // no pause ever requested behaves identically to one with no guard at
    // all. `setPauseGuard` is only present on `context` when this script
    // runs through WorkflowEngine.executeFile() (see that module's
    // _bindPrimitives()) -- guarded so direct/legacy callers of
    // runSprintCycle() that never go through the engine (existing tests)
    // keep working unchanged.
    let openSyncBracketCount = 0;
    if (typeof setPauseGuard === 'function') {
        setPauseGuard(() => openSyncBracketCount === 0);
    }
    /**
     * Runs `fn` with the open-sync-bracket counter incremented for its
     * duration, decrementing again on EVERY exit path (success or throw) via
     * `finally` -- never leaves a stale increment behind on an error.
     * @template T
     * @param {() => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async function withOpenSyncBracket(fn) {
        openSyncBracketCount += 1;
        try {
            return await fn();
        } finally {
            openSyncBracketCount -= 1;
        }
    }

    // The shared full-DB beads snapshot served by fetchAllBeadsShared(), plus
    // the two choke points that keep it correct. Both wrappers are installed
    // HERE, before any other statement in this function uses either name, so
    // every direct `command(...)`/`phase(...)` call below -- and every helper
    // (doltPullBefore, persistNewTaskBestEffort, withGitSync, ...) that
    // receives `command` via an options object built from this closure
    // variable -- transparently goes through the wrapped version.
    //
    // The snapshot MUST be invalidated the instant the underlying data can
    // have changed, so invalidation fires on BOTH:
    //   1. every `phase()` call -- a new step must never inherit a stale view
    //      from the step before it, and
    //   2. every bd command that is not a known read (list/show/ready/config).
    //      Update/create/close/note/dep/dolt-pull are all mutations, and an
    //      unrecognized bd subcommand is conservatively assumed to mutate: the
    //      failure mode is a redundant full fetch, never silently stale data.
    //      Non-bd commands (git, node probes) never touch beads state.
    let allBeadsSnapshot = null; // { beads } -- cleared by invalidateAllBeadsCache()
    function invalidateAllBeadsCache() { allBeadsSnapshot = null; }
    const BD_READ_ONLY_RE = /^bd\s+(list|show|ready|config)\b/i;
    const command = async (cmdStr, opts) => {
        const result = await rawCommand(cmdStr, opts);
        if (typeof cmdStr === 'string') {
            const trimmed = cmdStr.trim();
            if (/^bd\b/i.test(trimmed) && !BD_READ_ONLY_RE.test(trimmed)) {
                invalidateAllBeadsCache();
            }
        }
        return result;
    };
    const phase = (title) => {
        invalidateAllBeadsCache();
        return rawPhase(title);
    };

    // A stable per-sprint id for mutex fairness/introspection: the sprint branch
    // is unique per concurrent sprint on the shared remote.
    const sprintMutexId = (args && args.branch) ? String(args.branch) : 'sprint';

    // Every agent() dispatch carries sprint_id -- the same opaque sprint-identity
    // token members are reserved under (bin/cli.mjs) -- so the server can
    // serialize cross-sprint member access and recognize a dispatch as coming
    // from the reservation's OWNING sprint, even when it dispatches through a
    // shared fleet HTTP singleton with no per-sprint identity of its own. One
    // wrapper covers every call site in this file; an explicit `sprint_id` in an
    // individual call's opts wins via the spread order.
    //
    // KB audit follow-up: this wrapper is also where the KNOWLEDGE BANK block
    // reaches the roles whose prompt builders do not place it themselves.
    //
    // Every one of the ten role contracts carries a Step 0 telling it to call
    // kb_session_prime, and on a member dispatch NONE of them can (the fleet MCP
    // server is disabled there) -- so the engine has to hand the knowledge over
    // as prompt text. buildDoerPrompt / buildReviewerPrompt / buildFinalVerdict-
    // Prompt already do that at a position that matters (the reviewer's block
    // must precede its promotion candidates), so those roles are excluded here
    // and handled there. Everyone else -- planner, plan-reviewer, deployer, the
    // two test runners, harvester -- got nothing at all until now, which is
    // exactly the population most likely to benefit from a `runbook` entry.
    const agent = (prompt, opts = {}) => {
        let finalPrompt = prompt;
        if (opts.agentType && !KB_SELF_INJECTING_ROLES.has(opts.agentType) && opts.member_name) {
            const [block] = kbKnowledgeBlock(kbPriming.knowledgeOf(opts.member_name));
            if (block) finalPrompt = prompt + '\n\n' + block;
        }
        return agentRaw(finalPrompt, { sprint_id: sprintMutexId, ...opts });
    };

    // The global dolt push mutex client. Every D-push below serializes through
    // it so two sprints never push at the same time. Four sources, in
    // precedence:
    //   1. `context.doltPushMutex` -- an explicitly-injected client (tests wire
    //      an in-process one here to prove the bracket serializes without HTTP).
    //   2. `args.serviceUrl` present -- an HTTP-backed client acquiring against
    //      the always-on supervisor's mutex routes, so two independently-
    //      detached sprint children serialize through one supervisor.
    //   3. `args.callTool` present -- the SUPERVISOR-LESS path: a standalone /
    //      detached-binary launch has no supervisor to reach but always holds a
    //      connected MCP client to the shared fleet HTTP singleton, so that
    //      server's own `dolt_push_mutex` tool coordinates the topology.
    //   4. none of the above -- a no-op client: a lone sprint has, by
    //      definition, no second sprint to conflict with, so the push is
    //      unguarded and the D-push call sites stay uniform (they always
    //      acquire/release; only the wiring differs). This is a real
    //      DEGRADATION whenever a second sprint could exist, so it is logged
    //      rather than taken silently.
    const doltPushMutex = context.doltPushMutex ?? (() => {
        if (args && args.serviceUrl) {
            return createHttpDoltPushMutexClient({ serviceUrl: args.serviceUrl, sprintId: sprintMutexId, log });
        }
        if (args && typeof args.callTool === 'function') {
            log(`[dolt-mutex] no supervisor serviceUrl; coordinating the global push mutex through the fleet MCP server's dolt_push_mutex tool (sprint '${sprintMutexId}').`);
            return createMcpDoltPushMutexClient({ callTool: args.callTool, sprintId: sprintMutexId, log });
        }
        log('[dolt-mutex] DEGRADED: no supervisor serviceUrl and no fleet MCP connection -- falling back to an UNGUARDED no-op push mutex. Concurrent sprints could push dolt at the same time and hard-conflict (PoC constraints C.2/C.3).');
        return {
            async acquire() { return { token: null }; },
            async release() { return true; },
        };
    })();

    // The global child-id allocator client. Every reviewer-proposed newTask
    // create below mints its id through it so two sprints creating children
    // under the SAME parent never derive the same child id. Same four-source
    // precedence as the push mutex above:
    //   1. `context.idAllocator` -- an explicitly-injected client (tests wire an
    //      in-process one to prove the create path allocates without HTTP).
    //   2. `args.serviceUrl` present -- an HTTP-backed client allocating and
    //      confirming against the supervisor's allocator routes, so two
    //      detached sprint children serialize id minting through one authority.
    //   3. `args.callTool` present -- the SUPERVISOR-LESS path: the fleet
    //      server's own `child_id_allocator` tool, over the MCP connection
    //      every standalone launch already holds.
    //   4. none of the above -- a no-op client: a lone sprint has no second
    //      sprint that could mint a colliding id, so bd derives the id itself
    //      (childId null -> no `--id` flag) and the create call sites stay
    //      uniform. Logged, not silent: a real degradation whenever a second
    //      sprint could exist.
    const childIdAllocator = context.idAllocator ?? (() => {
        if (args && args.serviceUrl) {
            return createHttpChildIdAllocatorClient({ serviceUrl: args.serviceUrl, sprintId: sprintMutexId, log });
        }
        if (args && typeof args.callTool === 'function') {
            log(`[id-allocator] no supervisor serviceUrl; minting child ids through the fleet MCP server's child_id_allocator tool (sprint '${sprintMutexId}').`);
            return createMcpChildIdAllocatorClient({ callTool: args.callTool, sprintId: sprintMutexId, log });
        }
        log('[id-allocator] DEGRADED: no supervisor serviceUrl and no fleet MCP connection -- falling back to a no-op allocator; bd derives child ids locally, so two concurrent sprints under the same parent could mint the SAME child id (PoC constraint C.4).');
        return {
            async allocate() { return { childId: null, token: null }; },
            async confirm() { return true; },
            async release() { return true; },
        };
    })();

    // Guards every resume re-dispatch below against spawning a second
    // concurrent session on top of a prior one that is presumed dead/timed out
    // but may still be alive (see createMemberSessionGuard's doc comment).
    // There is no supervisor-HTTP source here: `stop_prompt` lives on the fleet
    // MCP server every launch path already connects to.
    //   1. `context.memberSessionGuard` -- an explicitly-injected guard (tests
    //      wire an in-process one to prove the pre-resume kill fires without a
    //      live fleet server).
    //   2. `args.callTool` -- bin/cli.mjs's already-connected
    //      `mcpClient.callTool`, so a resume can call `stop_prompt`.
    //   3. neither -- a no-op guard: nothing to call `stop_prompt` against, so
    //      every resume proceeds unguarded.
    const memberSessionGuard = context.memberSessionGuard ?? createMemberSessionGuard({
        callTool: (args && typeof args.callTool === 'function') ? args.callTool : undefined,
        log,
    });

    // The REACTIVE git/dolt credential self-heal callback every withGitSync
    // bracket passes to syncMemberBefore/doltPullBefore (G-pull/D-pull) and
    // syncMemberAfterOrdered (G-push/D-push) as `onAuthFailure`. Same
    // precedence shape as memberSessionGuard above:
    //   1. `context.onAuthFailure` -- an explicitly-injected callback (tests
    //      wire an in-process one to prove the self-heal fires without a live
    //      fleet server).
    //   2. `args.callTool` -- the real provision_vcs_auth self-heal via
    //      createVcsAuthSelfHealCallback (packages/apra-fleet-client).
    //   3. neither -- undefined: an 'auth'-classified git/dolt failure falls
    //      straight through to the GitSyncError/DoltSyncError throw. Every
    //      dispatch site therefore guards with `typeof onAuthFailure ===
    //      'function'`.
    const onAuthFailure = context.onAuthFailure ?? (
        (args && typeof args.callTool === 'function')
            ? createVcsAuthSelfHealCallback({ callTool: args.callTool, command, log })
            : undefined
    );

    // apra-fleet-417.7: the member-provider resolver every withGitSync bracket
    // passes to syncMemberBefore (G-pull) and syncMemberAfterOrdered (G-push)
    // as `resolveMemberProvider`, so a git failure classifies via that
    // member's OWN resolved VCS provider chain instead of always falling back
    // to the default 'github' chain -- what makes azure-devops.mjs's
    // TF401019 and bitbucket.mjs's app-password AUTH rules reachable at
    // runtime. Same precedence shape as onAuthFailure above:
    //   1. `context.resolveMemberVcsProvider` -- an explicitly-injected
    //      resolver. NOT reachable through the production entry point:
    //      every real caller (bin/cli.mjs, and every mock-sprint scenario)
    //      drives this file via `WorkflowEngine.executeFile()`, whose
    //      `runWithContext()` always builds `context` as `{
    //      ...this._bindPrimitives(), args, budget }` (apra-fleet-workflow/
    //      src/workflow/index.mjs) -- there is no key through which an
    //      `executeFile()` caller can set `context.resolveMemberVcsProvider`
    //      (or its onAuthFailure/memberSessionGuard/ensureVcsAuthFresh/
    //      onLlmAuthFailure siblings above/below). This tier only exists for
    //      a direct `main()`/`runSprintCycle()` call built by hand (e.g. via
    //      `FleetWorkflow.createContext()`), which nothing in this codebase
    //      does today (apra-fleet-417.9) -- kept for parity with its
    //      siblings' shape, not because it is exercised.
    //   2. `args.callTool` -- the real VCSModule.resolveProvider() lookup via
    //      createMemberVcsProviderResolver (this file). THIS is the tier
    //      every real caller and every mock-sprint scenario reaches (see
    //      mock-sprint-member-vcs-provider-threading.test.mjs, apra-fleet-
    //      417.9, for end-to-end coverage of a non-GitHub member's G-push
    //      auth failure classifying via this exact wiring).
    //   3. neither -- undefined: every runGitStep call below falls back to
    //      the default 'github' chain, exactly as before this bead.
    const resolveMemberVcsProvider = context.resolveMemberVcsProvider ?? (
        (args && typeof args.callTool === 'function')
            ? createMemberVcsProviderResolver({ callTool: args.callTool, log })
            : undefined
    );

    // The PROACTIVE counterpart to onAuthFailure above. Unlike onAuthFailure,
    // this defaults to a callable async no-op rather than undefined, so
    // withGitSync's pre-dispatch bracket can call it unconditionally (gated
    // only on `pushCode`, never on whether it was wired).
    //   1. `context.ensureVcsAuthFresh` -- an explicitly-injected callback
    //      (tests wire an in-process one to prove the preflight fires/skips
    //      without a live fleet server).
    //   2. `args.callTool` -- createVcsAuthPreflightCallback (this file).
    //   3. neither -- a no-op: no proactive provision_vcs_auth call is ever
    //      made and the reactive onAuthFailure self-heal is the only
    //      auth-recovery path.
    const ensureVcsAuthFresh = context.ensureVcsAuthFresh ?? (
        (args && typeof args.callTool === 'function')
            ? createVcsAuthPreflightCallback({ callTool: args.callTool, command, log })
            : async () => {}
    );

    // LLM-auth counterpart to onAuthFailure above, same precedence shape.
    // Dispatch-site catch handlers call this (via isAuthDispatchError(err))
    // before deciding whether to retry an otherwise non-retryable dispatch
    // failure; it resolves true ("healed, retry once") or false ("not healed,
    // abort").
    const onLlmAuthFailure = context.onLlmAuthFailure ?? (
        (args && typeof args.callTool === 'function')
            ? createLlmAuthSelfHealCallback({ callTool: args.callTool, log })
            : undefined
    );

    // Provisions a member unattended='auto' right before its deployer /
    // integ-test-runner / regression-test-runner dispatch, so those
    // real-command/real-suite roles never stall on an interactive permission
    // prompt. See createUnattendedAutoProvisioner's doc comment for why this
    // is one-way (never reverted) and safe in a single-member sprint.
    //   1. `context.ensureUnattendedAuto` -- an explicitly-injected function
    //      (tests wire an in-process one to prove the call site fires
    //      without a live fleet server).
    //   2. `args.callTool` -- the real update_member call via
    //      createUnattendedAutoProvisioner (this file).
    //   3. neither -- a no-op: no provisioning call is made and the member
    //      dispatches under whatever permission mode it already has.
    const ensureUnattendedAuto = context.ensureUnattendedAuto ?? (
        (args && typeof args.callTool === 'function')
            ? createUnattendedAutoProvisioner({ callTool: args.callTool, log })
            : async () => {}
    );

    // Validate BEFORE any agent()/command() dispatch: a rejected/malformed arg
    // must result in zero fleet dispatches.
    const validated = validateArgs(args);

    // The per-dispatch time budget used for BOTH timeout_s and max_total_s:
    // silent-until-done CLIs make inactivity indistinguishable from total
    // runtime, so the two must be equal. The integ-test dispatch alone gets a
    // 2x ceiling.
    const DISPATCH_TIMEOUT_S = validated.dispatchTimeoutS;
    const INTEG_MAX_TOTAL_S = DISPATCH_TIMEOUT_S * 2;

    // Apply the optional `budget` arg ceiling to THIS run's budget object.
    // Setting it here, before any dispatch, is what makes the ceiling
    // enforceable for the whole run: agent() checks `budget.remaining() <= 0`
    // before every dispatch, but a `budget.total` left null means unlimited.
    if (validated.budget !== undefined) {
        budget.total = validated.budget;
    }

    let cycle = 1;
    const MAX_CYCLES = validated.maxCycles;

    // Per-(role, cycle) session registry: a role's session is resumed across
    // ROUNDS within one cycle via an explicit session id, but NEVER across
    // cycles (fresh eyes), and falls back to a fresh session on a prior-round
    // dispatch error/timeout or near the context ceiling. The session id comes
    // from execute_prompt's structuredContent.sessionId, captured via agent()'s
    // onSessionId callback; a provider that does not support resume returns
    // none, so nothing is recorded and the next round is fresh -- a capability
    // signal, not a provider-name check. See createRoundSessionRegistry.
    const roundSessions = createRoundSessionRegistry({ log });

    const targetIssues = validated.targetIssues;
    const sprintFilter = targetIssues.length > 0 ? `--parent ${targetIssues.join(',')}` : '';

    // Member mapping resolution
    const physicalMembers = validated.members;

    // apra-fleet-e28: prime each member's own project KB before any dispatch, so
    // the Step 0 Knowledge Bank block in every role contract has something warm
    // to read. This engine had no KB priming at all -- it lived only in the
    // Claude workflow copy. Best-effort: a cold KB never fails a sprint.
    const kbPriming = context.kbPriming ?? createKbPrimingClient({
        callTool: (args && typeof args.callTool === 'function') ? args.callTool : undefined,
        members: physicalMembers,
        log,
    });
    await kbPriming.primeAll();

    // The role output schemas are shared with apra-pm, so every role dispatched
    // below is now asked for kb_captures (and the reviewer for kb_promotions).
    // This is the consumer: without it those fields would be gathered and
    // silently dropped. Unlike apra-pm's workflow script, this engine has a real
    // callTool, so the kb_capture/kb_promote calls are made directly.
    const kbWork = context.kbWork ?? createKbWorkClient({
        callTool: (args && typeof args.callTool === 'function') ? args.callTool : undefined,
        log,
        // Scope every kb_* call below to the member's OWN project KB. The repo
        // path each call site already threads is a path on the MEMBER's host,
        // so the server cannot derive a slug from it -- without this lookup a
        // remote member's reads and writes all land in the shared 'default' KB
        // (apra-fleet-b4g.15). Resolved through the path rather than passed
        // per call site so no site can thread the path and forget the scope.
        // context.kbPriming above is an injection seam; a stub that predates
        // remoteUrlForPath degrades to no scope rather than crashing a sprint.
        remoteUrlFor: (repoPath) => (typeof kbPriming.remoteUrlForPath === 'function' ? kbPriming.remoteUrlForPath(repoPath) : null),
    });
    // A member named in ANY roleMap value is a "specialist" for whatever
    // role(s) named it -- e.g. a member pinned to roleMap.reviewer has been
    // deliberately reserved for review. Without this, a role the caller left
    // UNMAPPED falls back to raw array position (physicalMembers[0], or "all
    // members" for doer/reviewer), which can silently hand that specialist's
    // dedicated machine an unrelated role (or vice versa) purely because of
    // where it happens to sit in `members` -- not because anyone intended it.
    // Members named in NO roleMap value ("generalists") are therefore the
    // correct default pool for any unmapped role: they are, by construction,
    // the members nobody has already committed to something specific.
    // If every member is a specialist (no generalists exist), there is no
    // safer pool to prefer, so this degrades to the original physicalMembers
    // fallback -- unchanged behavior in that case, and also unchanged
    // whenever roleMap is absent entirely (every member is a generalist).
    const roleMapSpecialists = new Set();
    if (validated.roleMap) {
        for (const list of Object.values(validated.roleMap)) {
            if (Array.isArray(list)) for (const m of list) roleMapSpecialists.add(m);
        }
    }
    const unmappedRoleFallbackPool = (() => {
        const generalists = physicalMembers.filter((m) => !roleMapSpecialists.has(m));
        return generalists.length > 0 ? generalists : physicalMembers;
    })();

    const getMemberForRole = (role) => {
        if (validated.roleMap && validated.roleMap[role] && validated.roleMap[role].length > 0) {
            return validated.roleMap[role][0];
        }
        return unmappedRoleFallbackPool[0];
    };

    const getMembersForRole = (role) => {
        if (validated.roleMap && validated.roleMap[role]) {
            return validated.roleMap[role];
        }
        // Role keys MUST be the canonical lowercase contracts.ROLES strings
        // (ROLE_DOER/ROLE_REVIEWER), which is exactly what every call site
        // passes -- a capitalized literal here would silently never match.
        if (role === ROLE_DOER || role === ROLE_REVIEWER) {
            return unmappedRoleFallbackPool; // generalists act as Doers/Reviewers by default
        }
        return [unmappedRoleFallbackPool[0]];
    };

    // Uses the canonical ROLE_ORCHESTRATOR constant, not a literal -- see its
    // doc comment for why 'orchestrator' is an application-level pseudo-role
    // deliberately outside contracts.ROLES.
    const orchestratorMember = getMemberForRole(ROLE_ORCHESTRATOR);

    // Self-heals deploy.md's declared Permissions onto the deployer /
    // integ-test-runner / regression-test-runner member before each of
    // those dispatches -- see createDeployPermissionsProvisioner's doc
    // comment. Same three-way precedence shape as ensureUnattendedAuto
    // above: an explicitly-injected `context.ensureDeployPermissions` (for
    // tests), else the real compose_permissions-backed provisioner built
    // from `args.callTool`, else a no-op when neither is available.
    const ensureDeployPermissions = context.ensureDeployPermissions ?? (
        (args && typeof args.callTool === 'function')
            ? createDeployPermissionsProvisioner({ callTool: args.callTool, command, orchestratorMember, log })
            : async () => {}
    );

    // ONE shared bracket wrapping EVERY role-identified agent() dispatch below
    // -- planner, plan-reviewer, doer, reviewer, deployer, integ-test-runner,
    // harvester. No phase-based exemptions: a deployer or integ-test-runner
    // running against a stale checkout/beads clone is exactly as damaging as a
    // stale doer/reviewer diff. Bracket order: VCS-auth preflight gate, G-pull,
    // D-pull, dispatch, G-push, D-push.
    //
    // Two orthogonal sync axes, each pulled before and (optionally) pushed
    // after:
    //   - CODE (git): `pushCode` is true ONLY for the code-writing roles (doer,
    //     harvester); every other role is read-side (G-pull before, a no-op
    //     G-push after -- see syncMemberAfter's short-circuit).
    //   - BEADS (dolt): `pushBeads` is true for every role that MUTATES beads
    //     -- planner (creates tasks), doer (closes them), integ-test-runner
    //     (closes features / files bugs), harvester (defers issues). The pure
    //     read-side roles (reviewer, plan-reviewer, deployer) D-pull before and
    //     no-op D-push after. integ-test-runner D-pushes WITHOUT a git push: it
    //     never touches code, only beads.
    //
    // The orchestrator's OWN beads mutations/reads are NOT dispatches and are
    // bracketed separately at their own call sites below. Deliberately NOT
    // applied to the Streak Assignment call: that dispatch carries no
    // `agentType`/persona of its own and is not one of the seven types.
    //
    // Option flags:
    //   - needsVcsAuth: gates the proactive ensureVcsAuthFresh preflight,
    //     independently of `pushCode` (apra-fleet-647.1.1.2). Defaults to
    //     `pushCode || pushBeads`: a code-writing role always needed it
    //     already, and this extends the same proactive preflight to read-side
    //     roles whose bracket still D-pushes beads (planner, integ-test-
    //     runner, regression-test-runner) -- `bd dolt push` hits the same
    //     credential surface as `git push`. Explicitly pass `needsVcsAuth:
    //     true` for a bracket that will raise a PR (or otherwise needs a
    //     fresh credential) even with pushCode:false and pushBeads:false.
    //   - skipPreDispatchSync: the prior attempt failed TERMINALLY with nothing
    //     published, so the local G/D workspace is unchanged since that
    //     attempt's pull -- skip the pre-dispatch sync entirely.
    //   - skipPreDispatchDoltPull: skip only the `bd dolt pull` spawn while
    //     still running doltPullBefore's sync.remote pre-gate probe and the
    //     G-side pull; for a dispatch whose beads clone was provably just
    //     freshened.
    //   - resumeOntoRemoteTip: the prior attempt was NOT provably a no-mutation
    //     failure (it may have committed and/or pushed), so run the full
    //     pre-dispatch sync in syncMemberBefore's resetToRemoteTip mode -- fetch
    //     and reset onto the remote tip BEFORE the doer can commit, resuming on
    //     published work instead of re-implementing it and diverging.
    //   skipPreDispatchSync and resumeOntoRemoteTip encode opposite assumptions
    //   about whether the prior attempt published anything and MUST never be
    //   passed together. Nothing in the code enforces this today.
    //
    // Post-dispatch: when the dispatch COMPLETED, only the SYNC step is retried
    // on failure -- the turn is never re-dispatched. A push failure is
    // frequently transient (a racing writer, a momentarily unreachable remote,
    // a credential refresh in flight) and re-running the sync costs nothing,
    // whereas re-running the LLM turn costs a full dispatch and risks duplicate
    // beads/commit mutations. `agent` is threaded to syncMemberAfterOrdered so
    // a G-push hitting a real content conflict can attempt exactly one
    // agent-with-runbook resolution before failing the streak (a no-op for
    // non-code-writing roles; never fires for a plain divergence).
    async function withGitSync(member, pushCode, dispatchFn, { pushBeads = false, needsVcsAuth = pushCode || pushBeads, skipPreDispatchSync = false, skipPreDispatchDoltPull = false, resumeOntoRemoteTip = false } = {}) {
      // (apra-fleet-p2to.4.1) The WHOLE withGitSync bracket -- pre-dispatch
      // G-pull/D-pull, the dispatch itself, and post-dispatch G-push/D-push
      // -- counts as ONE open sync bracket for the clean-state pause guard
      // above: a pause must never land between, say, a pre-dispatch pull and
      // its matching post-dispatch push, which would leave the workspace/
      // beads clone mid-cycle. `finally` guarantees the decrement fires on
      // every exit path (the normal return, or any of the throws below),
      // never leaving a stale increment behind.
      openSyncBracketCount += 1;
      try {
        if (skipPreDispatchSync) {
            log(`[Sync] Skipping pre-dispatch G-pull/D-pull for member '${member}' on a retry after a terminal no-mutation dispatch failure (prior attempt published nothing -- workspace unchanged since the last pull).`);
        } else {
            // Proactively refresh this member's VCS credentials before the
            // G-pull/D-push, gated on `needsVcsAuth` rather than directly on
            // `pushCode`: a code-writing role always needs it (pushCode implies
            // needsVcsAuth by the default above), but so does any read-side
            // role whose bracket still D-pushes beads (planner, integ-test-
            // runner, regression-test-runner) or will raise a PR -- `bd dolt
            // push` shells out to git under the hood and hits the exact same
            // credential surface a `git push` does (apra-fleet-647.1.1.2). A
            // pure read-only role (reviewer, plan-reviewer, deployer -- no
            // push of either kind) passes needsVcsAuth:false (the computed
            // default) and gets no preflight, since it has nothing to
            // preflight for. ensureVcsAuthFresh is itself a no-op when a
            // still-fresh credential is cached, and NEVER throws -- a
            // preflight failure degrades silently and never aborts a
            // dispatch.
            if (needsVcsAuth) {
                log(`[Sync] preflight: member '${member}' needs a fresh VCS credential before this dispatch (pushCode=${pushCode}, pushBeads=${pushBeads}, needsVcsAuth=${needsVcsAuth}).`);
                await ensureVcsAuthFresh(member);
            }
            await syncMemberBefore(member, { command, log, branch: validated.branch, onAuthFailure, resetToRemoteTip: resumeOntoRemoteTip, resolveMemberProvider: resolveMemberVcsProvider });
            // EXPLICITLY FATAL (apra-fleet-417.3.1): a pre-dispatch D-pull that
            // silently degraded would hand the agent a STALE beads clone and
            // let it act on it -- worse than not dispatching at all.
            await DoltSync.syncBefore(member, { command, log, skipRefresh: skipPreDispatchDoltPull, onAuthFailure, fatal: true, settle: buildSettleCallback(member, { command, log }) });
        }
        // The teardown is deliberately NOT a `finally`. A throw out of a
        // `finally` replaces the (successful) dispatch result and is
        // indistinguishable, to the caller's retry ladder, from "the dispatch
        // itself failed" -- which would let a pure sync failure trigger a brand
        // new LLM turn over work already committed locally. Splitting the two
        // lets the sync be retried on its own and, if it still fails, surfaced
        // as a typed PostDispatchSyncError no retry caller may answer by
        // redispatching.
        let dispatchThrew = null;
        let dispatchResult;
        try {
            dispatchResult = await dispatchFn();
        } catch (err) {
            dispatchThrew = err;
        }
        {
            // On a TERMINAL dispatch failure the agent never delivered a usable
            // result, so there is provably nothing new to publish -- skip the
            // G-push/D-push teardown entirely. This deliberately EXCLUDES
            // every case where the agent DID run and may have committed code/
            // beads that still must be published: max_turns_exhausted and
            // watchdog_timeout dispatch failures, and an AgentOutputError
            // (the LLM answered, only its output was unusable).
            if (dispatchThrew && isNoMutationDispatchFailure(dispatchThrew)) {
                log(`[Sync] Skipping post-dispatch G-push/D-push for member '${member}' after a terminal dispatch failure (nothing to publish): ${dispatchThrew.message}`);
            } else {
                // G-push (code) before D-push (beads) -- see
                // syncMemberAfterOrdered() for the unreachable-close rationale
                // behind that ordering. When the dispatch already threw, the
                // teardown keeps a single-attempt shape: the dispatch error is
                // what surfaces either way, so retrying the sync buys nothing.
                const syncAttemptDelaysMs = dispatchThrew ? [0] : POST_DISPATCH_SYNC_RETRY_DELAYS_MS;
                let syncErr = null;
                for (let attempt = 0; attempt < syncAttemptDelaysMs.length; attempt++) {
                    if (syncAttemptDelaysMs[attempt] > 0) {
                        log(`[Sync] Post-dispatch sync for member '${member}' failed; retrying ONLY the sync step in ${syncAttemptDelaysMs[attempt] / 1000}s (attempt ${attempt + 1}/${syncAttemptDelaysMs.length}) -- the dispatch already completed and must NOT be re-run.`);
                        if (!mockInstantRetryBackoff()) {
                            await new Promise((resolve) => setTimeout(resolve, syncAttemptDelaysMs[attempt]));
                        }
                    }
                    try {
                        await syncMemberAfterOrdered(member, {
                            command, pushCode, pushBeads, log, branch: validated.branch,
                            mutex: doltPushMutex, sprintId: sprintMutexId, agent, onAuthFailure,
                            resolveMemberProvider: resolveMemberVcsProvider,
                        });
                        syncErr = null;
                        break;
                    } catch (err) {
                        syncErr = err;
                    }
                }
                if (syncErr) {
                    // A dispatch error always wins over a sync error: it is the
                    // more fundamental failure.
                    if (dispatchThrew) throw dispatchThrew;
                    throw new PostDispatchSyncError(
                        `Post-dispatch sync (G-push/D-push) failed for member '${member}' AFTER the dispatch completed successfully: ${syncErr.message}. The dispatch's work is already committed locally -- it must NOT be re-dispatched; fix the sync (credentials/remote) and re-run.`,
                        { member, dispatchResult, syncAttempts: syncAttemptDelaysMs.length, cause: syncErr },
                    );
                }
            }
        }
        if (dispatchThrew) throw dispatchThrew;
        return dispatchResult;
      } finally {
        openSyncBracketCount -= 1;
      }
    }

    // Scope discovery cannot be built on `bd list --parent`: it accepts exactly
    // one id per invocation (a comma-joined list is treated as one nonexistent
    // id and returns `[]`) and is single-level only -- direct children, never
    // grandchildren -- so a level-3+ descendant would be invisible to the
    // dispatch scope, not just the dashboard tree.
    //
    // Instead, pull the full project bead list ONCE per call (`--all` because
    // `bd list` excludes closed issues by default, which would drop a closed
    // node's parent link and orphan its whole subtree from discovery; `--limit
    // 0` because the default row cap could silently truncate a larger scope),
    // build a parent->children map locally, then BFS from every target issue in
    // memory to find every descendant at any depth, regardless of status. This
    // subsumes the multi-target union case without a separate code path, at the
    // cost of fetching the whole project's beads rather than just the scope's.
    //
    // fetchAllBeadsShared() serves that fetch from `allBeadsSnapshot` whenever
    // one is still valid -- the snapshot survives across separate,
    // non-overlapping calls (see the command/phase wrappers above for what
    // invalidates it) -- and otherwise coalesces concurrent callers onto a
    // single in-flight request. Coalescing matters beyond saving a round trip:
    // the command text is identical for every caller, and the bd-replay test
    // shim matches recorded responses FIFO per exact command string, so N
    // indistinguishable concurrent commands have no reliable replay order.
    let allBeadsInFlight = null;
    async function fetchAllBeadsShared() {
        if (allBeadsSnapshot) return allBeadsSnapshot.beads;
        if (!allBeadsInFlight) {
            const allLabel = 'bd list --all --limit 0 --json';
            allBeadsInFlight = command(allLabel, { member_name: orchestratorMember, silent: true })
                .then((raw) => parseBdJson(raw, allLabel))
                .then((beads) => {
                    allBeadsSnapshot = { beads };
                    return beads;
                })
                .finally(() => { allBeadsInFlight = null; });
        }
        return allBeadsInFlight;
    }

    async function bdListScoped(restArgs) {
        const rest = restArgs ? restArgs.trim() : '';

        const allBeads = await fetchAllBeadsShared();

        const childrenOf = new Map();
        for (const b of allBeads) {
            if (b && b.parent !== undefined && b.parent !== null && b.parent !== '') {
                if (!childrenOf.has(b.parent)) childrenOf.set(b.parent, []);
                childrenOf.get(b.parent).push(b);
            }
        }

        const scopeIds = new Set();
        const frontier = [...targetIssues];
        while (frontier.length > 0) {
            const id = frontier.shift();
            for (const child of (childrenOf.get(id) || [])) {
                if (!scopeIds.has(child.id)) {
                    scopeIds.add(child.id);
                    frontier.push(child.id);
                }
            }
        }

        // Seed scopeIds with every target issue's OWN id, unconditionally --
        // the BFS above only ever adds descendants, so without this a
        // childless leaf target's scope would be empty and every query would
        // short-circuit to `[]`. This used to be conditional on the target
        // having no children, on the theory that a target WITH children is a
        // pure grouping node whose own status never matters -- but that is
        // false: a target with pre-existing children (a verify-routed parent
        // like the eft.52/vak shape, or this sprint's own apra-fleet-66u) can
        // itself transition open->closed, and status-counting queries
        // (closedCount) need to see that transition. Excluding it silently
        // dropped the parent's own closure from the stall-detection progress
        // score -- apra-fleet-66u.1's root cause: closedCountHistory stayed
        // flat across the cycles where eft.52 and vak (both targets WITH
        // children) closed for real, because their ids were never in
        // scopeIds to begin with, so `bdListScoped('--status=closed --json')`
        // could never count them no matter how fresh the read. This now
        // matches classifyVerifySet()'s own (already-unconditional) BFS seed
        // a few hundred lines up.
        //
        // A childful target is STILL excluded from dispatch (readyLeafBeads())
        // and from the exit-gate open-at-goal counts (openAtGoal/stillOpen/
        // finalOpenAtGoal, all post-filtered via decomposedParentIds() -- see
        // below) -- both use the same structural "is this someone's .parent"
        // check, independent of scopeIds membership, so widening scope here
        // does not let a still-open childful target masquerade as done, and
        // does not let it block dispatch as if it were a leaf. Whether it
        // still needs to close before the sprint may exit is owned entirely
        // by the separate, scope-independent stillOpenVerifyIds/verifyEverIds
        // mechanism (apra-fleet-jfo) further down.
        for (const id of targetIssues) {
            scopeIds.add(id);
        }

        if (scopeIds.size === 0) return [];

        if (!rest) {
            return allBeads.filter((b) => b && scopeIds.has(b.id));
        }

        // The caller's filter flags (--ready/--status/--type/--priority-max/
        // etc) express bd-side computed properties -- readiness in
        // particular -- that a plain in-memory filter over `allBeads` cannot
        // reliably replicate. Issue a second project-wide query with those
        // flags, then intersect with the structurally-discovered scope.
        // When an assignee is configured, `--assignee` narrows that query to
        // this sprint's claimed beads so two sprints never select the same one.
        let filterArgs = rest;
        if (validated.assignee) {
            filterArgs = `${rest} --assignee ${validated.assignee}`;
        }
        const filterLabel = `bd list ${filterArgs} --limit 0`;
        const filterRaw = await command(filterLabel, { member_name: orchestratorMember, silent: true });
        return parseBdJson(filterRaw, filterLabel).filter((b) => b && scopeIds.has(b.id));
    }

    // The set of scope-member ids that are themselves someone else's
    // `--parent` -- i.e. decomposed grouping nodes, not leaf units of work.
    // Built from children of ANY status, not just open ones: once a decomposed
    // bead's children all close they vanish from an open-only list, the parent
    // stops looking like a parent, and it would wrongly re-enter leaf/ready
    // treatment. bdListScoped('') is the no-extra-query path -- the
    // already-fetched project-wide any-status dump filtered to scope, with no
    // new bd command issued.
    async function decomposedParentIds() {
        const allAnyStatus = await bdListScoped('');
        return new Set(allAnyStatus.filter((b) => b.parent).map((b) => b.parent));
    }

    // Returns this scope's ready beads minus any decomposed parent (see
    // decomposedParentIds() above). Per GRAPH-SEMANTICS.md a decomposed bead's
    // "done" status comes from its children closing, never from being worked
    // directly, so it must never be seeded to a doer even when bd's own
    // `--ready` reports it. The check is STRUCTURAL (does this ready bead have
    // children?), not an issue_type check -- issue_type has no effect on
    // `--ready` inclusion, and a bead can be a leaf `type=task` or a decomposed
    // `type=bug`/`type=feature` parent, so only the has-children structure
    // tells them apart.
    async function readyLeafBeads() {
        const [ready, parentIds] = await Promise.all([
            bdListScoped('--ready --json'),
            decomposedParentIds(),
        ]);
        return ready.filter((b) => !parentIds.has(b.id));
    }

    // How many times a given bead has already been auto-reclaimed this sprint
    // (see reclaimStaleInProgress below). Keyed by bead id, lives for the
    // whole sprint process so the bounce cap accumulates across cycles, not
    // just within one call.
    const staleInProgressReclaimCounts = new Map();
    const STALE_IN_PROGRESS_RECLAIM_LIMIT = 2;
    // Stamped once, on the FIRST call to reclaimStaleInProgress (the
    // pre-sprint one) -- runSprintCycle's `context` carries no injected clock,
    // so this is a plain Date.now(), same as the other direct call sites
    // already in this file. Declared here (not at the capture site) so its
    // TDZ covers every call to reclaimStaleInProgress, including the
    // pre-sprint one.
    let sprintLaunchTime = null;

    /**
     * Reclaims 'in_progress' beads that are safe to redispatch to 'open':
     * no unmet `blocks` dependencies (nothing left to wait on) AND claimed
     * BEFORE this sprint incarnation's own launch time -- so a genuinely
     * live claim, including this very sprint's own in-flight work from an
     * earlier point in the SAME cycle, is never touched. A bead with no
     * parseable `started_at` is treated as predating this sprint (`bd
     * update --claim` always stamps `started_at`, so a bead claimed by
     * THIS sprint always has one -- an unparseable/absent value can only
     * mean orphaned state from something else).
     *
     * Bounded per bead via staleInProgressReclaimCounts: a bead that keeps
     * landing back in 'in_progress' (a doer repeatedly failing on it
     * specifically, not a one-off orphaned claim) stops being silently
     * reclaimed after STALE_IN_PROGRESS_RECLAIM_LIMIT attempts and is
     * surfaced as needing human investigation instead -- the same
     * bounce-cap precedent already used for the verify-route gap counter
     * (VERIFY_GAP_LIMIT) elsewhere in this file, applied to this failure
     * mode.
     *
     * Originally this reclaim only ran ONCE, as a pre-sprint gate, and only
     * when the pre-sprint ready set was empty -- a bead orphaned mid-sprint
     * (a crashed doer, a killed dispatch, or -- as observed in practice --
     * a prior aborted sprint incarnation whose claims were still in_progress
     * on relaunch) was invisible to every later cycle, so the sprint just
     * spun Plan-finds-nothing -> Deploy forever until the stall detector
     * eventually gave up, burning cycles/cost for zero progress. This is
     * now also called at the top of every cycle's readiness check, so an
     * orphaned claim self-heals on the very next cycle instead of silently
     * persisting for the rest of the run.
     * @param {{ notDoneBeads: object[], reasonTag: string }} opts
     * @returns {Promise<{ reclaimedIds: string[], cappedIds: string[] }>}
     */
    async function reclaimStaleInProgress({ notDoneBeads, reasonTag }) {
        if (sprintLaunchTime === null) sprintLaunchTime = Date.now();
        const notDoneIds = new Set(notDoneBeads.map((b) => b.id));
        const unmetBlockers = (bead) => (bead.dependencies || [])
            .filter((d) => d.type === 'blocks' && notDoneIds.has(d.depends_on_id))
            .map((d) => d.depends_on_id);

        const candidates = notDoneBeads.filter((b) => {
            if (b.status !== 'in_progress') return false;
            if (unmetBlockers(b).length > 0) return false;
            const startedAtMs = b.started_at ? Date.parse(b.started_at) : NaN;
            return Number.isNaN(startedAtMs) || startedAtMs < sprintLaunchTime;
        });

        const reclaimedIds = [];
        const cappedIds = [];
        for (const bead of candidates) {
            const priorAttempts = staleInProgressReclaimCounts.get(bead.id) ?? 0;
            if (priorAttempts >= STALE_IN_PROGRESS_RECLAIM_LIMIT) {
                cappedIds.push(bead.id);
                continue;
            }
            staleInProgressReclaimCounts.set(bead.id, priorAttempts + 1);
            log(`${reasonTag}: ${bead.id} is stuck 'in_progress' (started_at=${bead.started_at || 'n/a'}) with no unmet blockers and predates this sprint's launch -- reclaiming to 'open' so the sprint can dispatch it (attempt ${priorAttempts + 1}/${STALE_IN_PROGRESS_RECLAIM_LIMIT}).`);
            await command(`bd update ${bead.id} --status open`, { member_name: orchestratorMember, silent: true });
            reclaimedIds.push(bead.id);
        }
        if (cappedIds.length > 0) {
            log(`${reasonTag}: ${cappedIds.length} bead(s) hit the stale-in_progress reclaim bounce cap (limit ${STALE_IN_PROGRESS_RECLAIM_LIMIT}) and were left 'in_progress' rather than reclaimed again -- needs human investigation: ${cappedIds.join(', ')}.`);
        }
        return { reclaimedIds, cappedIds };
    }

    /**
     * Dispatches one reviewer round and returns its schema-validated verdict.
     * Shared by the per-round Develop/Review dispatch and the Cycle Evaluation
     * re-review so both apply the same contract rule: a `CHANGES_NEEDED`
     * verdict with empty `reopenIds` AND empty `newTasks` is schema-legal but
     * self-contradictory (nothing for the orchestrator to act on). The SAME
     * dispatch is retried once; if the contradiction repeats this throws
     * `ReviewerContractViolationError` rather than returning a verdict that
     * would silently accumulate toward stall-abort as legitimate no-progress.
     * @param {{ beadIds: string[], acceptanceCriteriaJson: string }} opts
     * @returns {Promise<{ verdict: string, notes: string, reopenIds: string[], replanIds?: string[], newTasks: object[] }>}
     */
    async function dispatchReview({ beadIds, acceptanceCriteriaJson }) {
        const reviewerPool = getMembersForRole(ROLE_REVIEWER);
        // apra-fleet-0ef: fetch the INFERRED entries this reviewer may promote
        // and hand them to it in the prompt. The reviewer has no MCP kb_* tools
        // of its own, so without this it can never name an entry id and
        // `kb_promotions` comes back empty every round -- which is exactly why
        // kb_promote had never once fired. Scoped to the reviewer's OWN work
        // folder (same source kbWork.apply uses to route the writes), and
        // best-effort: a cold KB must not fail the review.
        const reviewerRepoPath = kbPriming.folderOf(reviewerPool[0]);
        const kbCandidates = await kbWork.promotionCandidates(reviewerRepoPath);
        if (kbCandidates.length > 0) {
            log(`[kb-work] offering ${kbCandidates.length} INFERRED entr(ies) to the reviewer for promotion.`);
        }
        // What the KB knows about the beads UNDER REVIEW, not just whatever the
        // sprint-start prime happened to surface. Falls back to the primed set
        // when the query returns nothing (a KB with no matching rows yet).
        const reviewerQueried = await kbWork.relevantKnowledge(reviewerRepoPath, kbQueryTerms([], beadIds));
        const reviewerKnowledge = reviewerQueried.length > 0
            ? reviewerQueried
            : kbPriming.knowledgeOf(reviewerPool[0]);
        // A full-cycle review can genuinely exhaust the fleet's default turn
        // budget, and a fresh retry deterministically hits the same wall. Make
        // the budget explicit and, on max_turns exhaustion, RESUME the same
        // session at a doubled budget: the session already holds the full
        // review context, so a continue-nudge finishes the job instead of
        // restarting it.
        const BASE_REVIEWER_MAX_TURNS = 500;
        const reviewerDispatchOpts = {
            member_name: reviewerPool[0],
            agentType: 'reviewer',
            schema: reviewerVerdict,
            model: FIXED_ROLE_TIER.reviewer,
            // The reviewer inspects a real diff/branch, not a quick prompt, so
            // it needs the sprint's dispatch budget rather than the default.
            timeout_s: DISPATCH_TIMEOUT_S,
            max_total_s: DISPATCH_TIMEOUT_S,
            max_turns: BASE_REVIEWER_MAX_TURNS,
            // Within THIS cycle's develop-review loop, resume the reviewer's own
            // prior-round session by explicit session id so a re-review of the
            // next round's fixes keeps the diff/context it already built. False
            // on the first round of any cycle (roundSessions never resumes
            // across cycles) and cleared on a failed round below. The
            // max_turns-exhaustion resume overrides this to `resume: true`,
            // which is an in-dispatch continuation, not a cross-round one.
            resume: roundSessions.resumeArgFor('reviewer', cycle),
            onSessionId: (id, meta) => roundSessions.record('reviewer', cycle, id, meta),
        };
        const dispatchReviewerOnce = () => withGitSync(reviewerPool[0], false, () => agent(
            buildReviewerPrompt({
                beadIds,
                acceptanceCriteriaJson,
                baseBranch: validated.baseBranch,
                branch: validated.branch,
                goal: validated.goal,
                kbCandidates,
                kbKnowledge: reviewerKnowledge,
            }),
            // member_name is repeated literally here -- not only via the
            // shared opts object -- so the source-level call-site parse in
            // dispatch-safety-guard can verify it.
            { ...reviewerDispatchOpts, member_name: reviewerPool[0] }
        ));
        const dispatchReviewerResume = () => withGitSync(reviewerPool[0], false, () => agent(
            // Restate the review scope: a resumed dispatch replaces the
            // delivered prompt artifact, so the scope must be repeated inline.
            'Continue your review exactly where you left off in this same session -- do not restart or re-read the diff from scratch. ' +
            // apra-fleet-s6d: same empty-beadIds case as buildReviewerPrompt --
            // a scope-wide re-review has no ids to restate, and "bead id(s)
            // under review  on branch..." reads as a dropped value.
            `Your scope, restated so a resumed dispatch never loses it: `
            + (Array.isArray(beadIds) && beadIds.length > 0
                ? `bead id(s) under review ${beadIds.join(', ')} `
                : `the entire sprint scope (no individual bead ids -- you are judging whether the sprint as a whole is complete) `)
            + `on branch ${validated.branch} against base ${validated.baseBranch}. ` +
            'Finish evaluating the remaining acceptance criteria and return your final verdict now.',
            {
                ...reviewerDispatchOpts,
                member_name: reviewerPool[0],
                label: `Review (resume, max_turns=${BASE_REVIEWER_MAX_TURNS * 2})`,
                resume: true,
                max_turns: BASE_REVIEWER_MAX_TURNS * 2,
            }
        ));
        let verdict;
        for (let reviewAttempt = 1; reviewAttempt <= 2; reviewAttempt++) {
            try {
                try {
                    verdict = await dispatchReviewerOnce();
                } catch (err) {
                    if (err instanceof AgentDispatchError && err.details?.reason === 'max_turns_exhausted') {
                        log(`Reviewer exhausted its turn limit (max_turns=${BASE_REVIEWER_MAX_TURNS}) -- resuming the same session with max_turns=${BASE_REVIEWER_MAX_TURNS * 2} instead of restarting the review.`);
                        await memberSessionGuard.killIfAlive(reviewerPool[0]);
                        verdict = await dispatchReviewerResume();
                    } else {
                        throw err;
                    }
                }
            } catch (err) {
                // The retry-once loop below blind-retries an AgentDispatchError,
                // and an LLM-auth failure reproduces deterministically on an
                // unhealed retry -- one self-heal attempt gives that retry a
                // real chance to succeed.
                if (isAuthDispatchError(err) && typeof onLlmAuthFailure === 'function') {
                    await onLlmAuthFailure({ member: reviewerPool[0], label: 'Reviewer dispatch', error: err.message });
                }
                // The verdicts synthesized below stand for INFRASTRUCTURE
                // failures, not the reviewer contradicting itself -- they are
                // marked dispatchFailed so the contract-violation guard further
                // down never mistakes a dispatch failure for a self-
                // contradictory LLM verdict.
                if (err instanceof AgentOutputError) {
                    log(`Reviewer: schema-repair exhausted, treating round as CHANGES_NEEDED: ${err.message}`);
                    // A failed round's session must not be resumed by the next
                    // round -- drop it so the next review starts fresh.
                    roundSessions.clear('reviewer');
                    verdict = {
                        verdict: 'CHANGES_NEEDED',
                        notes: `Reviewer failed to return a schema-valid verdict after repair attempts: ${err.message}`,
                        reopenIds: [],
                        newTasks: [],
                        dispatchFailed: true,
                    };
                } else if (
                    err instanceof AgentDispatchError
                    || err instanceof FleetTransportError
                    // The review's own read-side sync bracket can fail for the
                    // same transient infrastructure reasons as the dispatch, so
                    // it degrades identically. A REAL divergence
                    // (GitDivergedError / DoltDivergedError -- separate classes,
                    // deliberately NOT listed here) still propagates: that is a
                    // branch integrity problem, not a blip.
                    || err instanceof GitSyncError
                    || err instanceof DoltSyncError
                ) {
                    // A transport-level failure (e.g. a dropped connection
                    // mid-dispatch) is exactly as transient and non-schema as an
                    // AgentDispatchError; neither may abort the whole sprint.
                    log(`Reviewer: agent dispatch failed, treating round as CHANGES_NEEDED: ${err.message}`);
                    roundSessions.clear('reviewer');
                    verdict = {
                        verdict: 'CHANGES_NEEDED',
                        notes: `Reviewer dispatch failed: ${err.message}`,
                        reopenIds: [],
                        newTasks: [],
                        dispatchFailed: true,
                    };
                } else {
                    throw err;
                }
            }
            // Deliberately NO log() dump of `verdict` here. Every path that
            // reaches this line already produced an activity row with the
            // identical content: agent() emits the schema-validated output
            // verbatim on the standard AGENT row (src/viewer/index.mjs), and
            // each failure fallback logs next to where `verdict` is built. A
            // second log() would render a duplicate row. The same rule holds at
            // every post-dispatch site in this file, so every agent dispatch
            // renders uniformly through its one AGENT row.

            if (verdict.dispatchFailed) {
                if (reviewAttempt < 2) {
                    // One more infrastructure attempt (transport blips and
                    // orphaned-lock busy waits are transient), then degrade.
                    log(`Reviewer: dispatch-level failure on attempt ${reviewAttempt} of 2 -- retrying the review once before degrading the round.`);
                    continue;
                }
                // A degraded round counts toward the bounded stall-abort
                // budget like every other role's dispatch failure -- it is
                // NOT a reviewer contract violation.
                return verdict;
            }
            if (!isReviewerContractViolation(verdict)) {
                return verdict;
            }
            if (reviewAttempt < 2) {
                log(
                    `Reviewer: CHANGES_NEEDED verdict with empty reopenIds AND empty newTasks is a ` +
                    `contract violation (nothing for the orchestrator to act on) -- retrying the review ` +
                    `once (attempt ${reviewAttempt} of 2) before treating this as a distinct failure.`
                );
            } else {
                throw new ReviewerContractViolationError(
                    `Reviewer returned CHANGES_NEEDED with empty reopenIds AND empty newTasks twice in a ` +
                    `row (cycle ${cycle}) -- a self-contradictory verdict with nothing for the ` +
                    `orchestrator to act on. Refusing to let this silently accumulate toward stall-abort.`,
                    { cycle, notes: verdict.notes }
                );
            }
        }
        // Unreachable (the loop above always returns or throws), but keeps
        // this function's return type honest for static analysis.
        return verdict;
    }

    // The sprint branch must be git-ensured on EVERY member that will operate
    // on it, not just the orchestrator: doers round-robin across the doer pool,
    // the reviewer runs from the reviewer pool, and every other role dispatched
    // through withGitSync's shared bracket (planner, plan-reviewer, deployer,
    // integ-test-runner, regression-test-runner, harvester -- see that bracket's
    // own doc comment a few hundred lines up) gets a pre-dispatch G-pull that
    // ASSUMES the correct branch is already checked out. On a real multi-member
    // fleet each role can resolve to its own independent checkout, so ensure on
    // the union of every role's member pool before the first doer round -- not
    // just doer/reviewer.
    //
    // Without this, a role pinned via roleMap to a member that was never
    // branch-ensured (e.g. deployer isolated onto its own machine, per the
    // fleet-supervisor skill's own recommended layout) can pass its G-pull's
    // `git merge --ff-only origin/<branch>` silently: a fast-forward merge does
    // not care what branch HEAD is currently on, only that HEAD is an ancestor
    // of the fetched tip. If that member happens to be sitting on a branch
    // (e.g. main) that is still fast-forward-compatible with the sprint branch,
    // the merge succeeds and silently advances THAT branch's pointer instead of
    // checking out/creating a correctly-named local branch -- the deploy/test
    // dispatch still gets the right code, but the member's local branch bookkeeping
    // ends up mislabeled. See apra-fleet-ivxi/u1qw/69pp sprint run
    // (fleet-sprint/ivxi-u1qw-69pp), where fleet-win-deploy's local `main`
    // silently absorbed the sprint branch's commits this way.
    //
    // SUPPORTED-TOPOLOGY NOTE: there is no cross-member bd/git sync layer here.
    // Every `bd` command below runs against the orchestrator member's beads DB
    // and a doer's own `bd close` runs against its member's DB, which only
    // coheres when all members share one workspace/DB (or there is a single
    // member). bin/cli.mjs enforces that via checkMemberTopology() before the
    // sprint starts; this ensure-everywhere is the git half of the same "every
    // member starts from the same state" guarantee. See docs/architecture.md
    // "Multi-member topology (fleet-sprint)".
    const branchEnsureMembers = [...new Set([
        orchestratorMember,
        ...getMembersForRole(ROLE_DOER),
        ...getMembersForRole(ROLE_REVIEWER),
        ...getMembersForRole('planner'),
        ...getMembersForRole('plan-reviewer'),
        ...getMembersForRole('deployer'),
        ...getMembersForRole('integ-test-runner'),
        ...getMembersForRole('regression-test-runner'),
        ...getMembersForRole('harvester'),
    ])];

    // Read the requirementsFile (if any) once, up front, so its content can
    // be threaded into every Plan-phase planner prompt.
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

    // Pre-flight beads-health gate: runs the D-pull probe BEFORE any setup
    // mutation (the branch-ensure loop's fetch/checkout just below), so a
    // diverged orchestrator beads clone is caught and reported -- naming the
    // workspace path, conflicting table(s), and remediation -- while the sprint
    // has still mutated nothing. This is the first fleet dispatch of the run.
    // Routed through the single dolt-sync module (apra-fleet-417.2.1):
    // readinessGate (apra-fleet-417.5 rename of healthGate) selects the
    // pre-flight variant of the BEFORE bracket.
    // (apra-fleet-p2to.4.1) standalone sync bracket -- see openSyncBracketCount's doc comment above.
    await withOpenSyncBracket(() => DoltSync.syncBefore(orchestratorMember, { command, log, readinessGate: true, settle: buildSettleCallback(orchestratorMember, { command, log }) }));

    // =======================
    // 0. Git Setup: ensure the sprint branch exists off base_branch
    // =======================
    // First GIT dispatch of the run -- runs before any bd/agent activity so
    // the whole sprint develops on `branch`, branched from `base_branch`.
    group('Sprint Setup');
    phase('Ensure Sprint Branch');
    // Dispatch the fetch + checkout to EVERY member in the ensure set, not just
    // the orchestrator. Sequential (not parallel) so the command log stays
    // deterministic.
    for (const member of branchEnsureMembers) {
        // Two sequential command() calls, not a single `a && b` shell string:
        // `&&` is a bash-ism that PowerShell 5.1 (Windows' default, pre-7.0)
        // rejects outright ("The token '&&' is not a valid statement
        // separator in this version"), breaking this phase on any Windows
        // member. command() already throws on a non-zero exit by default (no
        // failSoft here), so awaiting the fetch before the checkout
        // reproduces `&&`'s fail-fast semantics -- if the fetch fails, the
        // checkout is never attempted, on every OS/shell.
        await command(
            `git fetch origin ${validated.baseBranch} --quiet`,
            {
                member_name: member,
                silent: true,
                label: `Fetch '${validated.baseBranch}' on member '${member}'`,
            }
        );

        // Fetch <branch> itself before deciding the checkout start-point:
        // adopting origin/<branch> when it exists keeps real pushed sprint
        // history from being force-reset to base's tip on a relaunch, and makes
        // `checkout -B <branch> origin/<branch>` set up correct upstream
        // tracking. failSoft because a brand-new sprint branch legitimately
        // does not exist on origin yet, and that must never abort the run;
        // origin/<baseBranch> is the fallback only when it is genuinely new.
        const branchFetch = await command(
            `git fetch origin ${validated.branch} --quiet`,
            {
                member_name: member,
                silent: true,
                failSoft: true,
                label: `Fetch existing '${validated.branch}' (if any) on member '${member}'`,
            }
        );
        // Probe for a pre-existing local branch. When the remote ref is
        // missing, the naive fallback would force-reset that local branch to
        // base's tip, discarding commits that closed beads but were never
        // pushed and leaving beads and the git tree disagreeing. The probe also
        // runs when the fetch SUCCEEDED, because a successful fetch alone does
        // not make origin/<branch> authoritative if the local branch has
        // committed work origin does not (see the tip comparison below).
        const localProbe = await command(
            `git rev-parse --verify --quiet refs/heads/${validated.branch}`,
            {
                member_name: member,
                silent: true,
                failSoft: true,
                label: `Probe for pre-existing local branch '${validated.branch}' on member '${member}'`,
            }
        );
        const localBranchExists = localProbe.ok;

        // When both origin/<branch> and a local <branch> exist, compare their
        // tips with two `git merge-base --is-ancestor` checks (one each
        // direction) so decideEnsureBranchAction() never has to assume a
        // successful fetch means "safe to reset" -- see that function for the
        // ahead/behind/diverged case breakdown this feeds.
        let localTipStatus;
        if (branchFetch.ok && localBranchExists) {
            const localIsAncestorOfRemote = await command(
                `git merge-base --is-ancestor ${validated.branch} origin/${validated.branch}`,
                {
                    member_name: member,
                    silent: true,
                    failSoft: true,
                    label: `Check whether local '${validated.branch}' is an ancestor of 'origin/${validated.branch}' on member '${member}'`,
                }
            );
            const remoteIsAncestorOfLocal = await command(
                `git merge-base --is-ancestor origin/${validated.branch} ${validated.branch}`,
                {
                    member_name: member,
                    silent: true,
                    failSoft: true,
                    label: `Check whether 'origin/${validated.branch}' is an ancestor of local '${validated.branch}' on member '${member}'`,
                }
            );
            if (localIsAncestorOfRemote.ok && remoteIsAncestorOfLocal.ok) {
                localTipStatus = 'behind-or-equal'; // tips are equal
            } else if (localIsAncestorOfRemote.ok) {
                localTipStatus = 'behind-or-equal'; // local is a strict ancestor of origin
            } else if (remoteIsAncestorOfLocal.ok) {
                localTipStatus = 'ahead';
            } else {
                localTipStatus = 'diverged';
            }
        }

        // The fetch-outcome / local-probe / tip-comparison -> checkout-command
        // decision lives in the pure decideEnsureBranchAction() helper above;
        // this call site only turns that decision into a command()/log()
        // dispatch.
        const decision = decideEnsureBranchAction({
            branch: validated.branch,
            baseBranch: validated.baseBranch,
            branchFetchOk: branchFetch.ok,
            branchFetchError: branchFetch.error,
            localBranchExists,
            localTipStatus,
        });
        if (decision.action === 'abort') {
            throw new Error(`${decision.message} (member '${member}')`);
        }
        if (decision.reused) {
            if (branchFetch.ok) {
                log(
                    `Ensure Sprint Branch: local branch '${validated.branch}' on member '${member}' is AHEAD of ` +
                    `'origin/${validated.branch}' (has committed, unpushed work) -- reusing it as-is instead of ` +
                    `resetting to origin, to avoid discarding local-only commits.`
                );
            } else {
                log(
                    `Ensure Sprint Branch: remote ref for '${validated.branch}' is missing on member '${member}' ` +
                    `but a local branch of that name already exists -- reusing it as-is instead of resetting to base, ` +
                    `to avoid discarding local-only commits.`
                );
            }
        }
        const checkoutCommand = decision.command;
        const checkoutLabel = decision.reused
            ? (branchFetch.ok
                ? `Reuse existing local sprint branch '${validated.branch}' on member '${member}' (local ahead of origin)`
                : `Reuse existing local sprint branch '${validated.branch}' on member '${member}' (remote ref missing)`)
            : `Ensure sprint branch '${validated.branch}' from '${decision.startPoint}' on member '${member}'`;

        // An infrastructure-killed dispatch (transport drop, timeout,
        // stop_prompt) leaves the member's working tree DIRTY with whatever the
        // agent had in flight, and the checkout then fails with "Your local
        // changes ... would be overwritten". That orphaned WIP belongs to a
        // bead that is still open (a future streak redoes it properly), so
        // preserve it in a named stash and proceed -- never abort the sprint
        // over it, and never discard it. A clean tree issues no extra commands.
        const checkoutResult = await command(
            checkoutCommand,
            {
                member_name: member,
                silent: true,
                failSoft: true,
                label: checkoutLabel,
            }
        );
        if (!checkoutResult.ok) {
            if (!/would be overwritten/i.test(checkoutResult.error || '')) {
                throw new Error(
                    `Ensure Sprint Branch: checkout of '${validated.branch}' on member '${member}' failed for a ` +
                    `reason other than a dirty working tree (${checkoutResult.error || 'unknown error'}) -- aborting.`
                );
            }
            log(
                `Ensure Sprint Branch: member '${member}' has uncommitted changes (likely orphaned WIP from an ` +
                `interrupted prior dispatch) blocking checkout -- preserving them in a named stash and retrying.`
            );
            await command(
                `git stash push -u -m "fleet-sprint[${validated.branch}] auto-stash of orphaned WIP blocking branch ensure"`,
                {
                    member_name: member,
                    silent: true,
                    label: `Stash orphaned WIP on member '${member}'`,
                }
            );
            await command(
                checkoutCommand,
                {
                    member_name: member,
                    silent: true,
                    label: `${checkoutLabel} (post-stash retry)`,
                }
            );
        }
    }
    publishState('sprint-args', {
        branch: validated.branch,
        baseBranch: validated.baseBranch,
        goal: validated.goal,
        maxCycles: validated.maxCycles,
        requirementsFile: validated.requirementsFile || null,
    });
    endGroup();

    // NON-DESTRUCTIVE re-ensure of the sprint branch on every member: an agent
    // on any member can check something else out between cycles, so the "every
    // member is on the sprint branch" invariant has to be re-asserted rather
    // than assumed. Deliberately a plain `git checkout <branch>`, NOT the
    // initial `checkout -B <branch> origin/<base>`: once doers have committed
    // sprint work, resetting to base would discard it. failSoft, so a member
    // that cannot re-checkout never kills the sprint. A truly divergent
    // multi-member fleet is refused up front by checkMemberTopology() in
    // bin/cli.mjs, which is what makes this cheap guard sufficient.
    async function reEnsureBranchOnMembers() {
        for (const member of branchEnsureMembers) {
            await command(
                `git checkout ${validated.branch}`,
                {
                    member_name: member,
                    silent: true,
                    failSoft: true,
                    label: `Re-ensure sprint branch '${validated.branch}' checked out on member '${member}'`,
                }
            );
        }
    }

    // Keeps the dashboard UI updated with real bd data. publishState carries
    // sprintTasks only -- everything under this sprint's target scope,
    // re-fetched fresh every call, so beads added mid-run appear on the next
    // refresh with no separate wiring. The per-sprint fleet-sprint viewer
    // shows sprint progress only; project-wide backlog exploration is the
    // supervisor UX's job, not this one's (apra-fleet-eft.89.2). A failed
    // sprint-tree query returns early and publishes nothing at all this
    // round.
    async function updateDashboard() {
        let sprintTasks = [];
        try {
            // The no-args path is required here: any non-empty rest args route
            // through a second `bd list` query, and plain `bd list` defaults to
            // open/in_progress only, so CLOSED beads would never reach the
            // dashboard's sprint tree. No-args returns the shared `bd list
            // --all` fetch filtered to scope -- every status, one query fewer.
            sprintTasks = await bdListScoped('');
            // A bead whose stored `status` is 'open' but which is NOT in the
            // scope's `--ready` set is blocked. The viewer only sees stored
            // status, so without this flag a deadlocked bead renders
            // identically to a genuinely-ready one. Reuses `--ready` -- the
            // same signal dispatch decisions are based on -- rather than
            // introducing a second source of truth.
            try {
                const readyIds = new Set((await bdListScoped('--ready --json')).map((b) => b.id));
                sprintTasks = sprintTasks.map((t) => ({ ...t, ready: readyIds.has(t.id) }));
            } catch (e) {
                log(`updateDashboard: failed to compute ready/blocked badge data (non-fatal, status badges fall back to stored status): ${e.message}`);
            }
        } catch (e) {
            // Best-effort dashboard sync must never abort the sprint over a
            // transient blip, so this does not rethrow -- but it must be
            // LOGGED, or a stale/empty Beads Tasks panel is indistinguishable
            // from "just how it looks" for the whole round.
            log(`updateDashboard: failed to refresh sprint-tree panel (non-fatal, will retry next update): ${e.message}`);
            return; // sprintTasks fetch failed -- nothing to publish this round
        }

        if (typeof publishState === 'function') {
            // apra-fleet-eft.52.1.3: split the scoped tree into Sprint vs
            // Backlog SERVER-SIDE by goal membership (goal-priority band + a
            // blocks-edge exception for below-goal items wired to in-goal
            // ones). Each task carries a `placement` flag the viewer consumes
            // verbatim -- placement is never a browser-side CSS/priority
            // guess. `backlogTasks` is only added to the payload when a
            // below-goal item actually exists in scope, so a sprint whose
            // whole tree is in-goal keeps publishing sprintTasks alone (the
            // viewer/detailLookup both tolerate a missing backlogTasks key).
            const { sprintTasks: sprintPlaced, backlogTasks } = partitionByGoalMembership(sprintTasks, validated.goal);
            const payload = { sprintTasks: sprintPlaced };
            if (backlogTasks.length > 0) payload.backlogTasks = backlogTasks;
            // apra-fleet-x8r.4: plumbs the SAME two axes runner.js's own
            // completion gate (~line 8134: bdListScoped(--priority-max=
            // goalMax) MINUS decomposedParentIds()) filters on, so the
            // viewer's computeSprintProgress() required/closed counts match
            // what actually gates sprint exit -- never re-derived
            // client-side. Not `const goalMax` from the outer closure: this
            // function's FIRST call happens before that `const` initializes
            // (TDZ), so the numeric max is derived fresh here instead, from
            // the same pure goalPriorityMax() helper.
            payload.goalMax = Number(goalPriorityMax(validated.goal).slice(1));
            // sprintTasks is already this cycle's `bdListScoped('')` result
            // (any status, full scope) -- decomposedParentIds() re-derives
            // from that same no-args query, so building the set directly off
            // sprintTasks here is identical output with no extra `bd` call.
            payload.decomposedParentIds = [...new Set(
                sprintTasks.filter((b) => b && b.parent).map((b) => b.parent)
            )];
            publishState('beads', payload);
        }
    }

    // Platform-agnostic existence probe, standing in for a first-class
    // fileExists fleet API. One `node -e` invocation with plain, non-nested
    // single-quoted JS literals inside a double-quoted shell argument (no
    // escaped-quote-inside-quote traps). failSoft, so a probe failure can never
    // throw and kill the sprint -- it just means "skip the dependent phase".
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

    // Defense in depth: the pre-sprint health gate above already pulled this
    // clone, but a stale orchestrator clone here would misreport every remote
    // doer's work, so pull again immediately before the verification read.
    // DoltSync.syncBefore() is a benign no-op when the clone is current and
    // when no dolt remote is configured at all.
    // (apra-fleet-p2to.4.1) standalone sync bracket -- see openSyncBracketCount's doc comment above.
    await withOpenSyncBracket(() => DoltSync.syncBefore(orchestratorMember, { command, log, fatal: true, settle: buildSettleCallback(orchestratorMember, { command, log }) }));

    await updateDashboard();

    // readyLeafBeads(), not raw bdListScoped('--ready --json'): bd's own
    // `--ready` reports a decomposed childful target (e.g. this sprint's own
    // --issue target once it has children) as ready too, which would make
    // this pre-sprint gate never see an empty ready-set for the extremely
    // common case of "open childful target, no blockers" -- silently
    // disabling the stale-in_progress reclaim, the parent-child+blocks
    // deadlock detector/auto-repair, and the "nothing to do" hard-fail below.
    let initialBeads = await readyLeafBeads();

    // apra-fleet-jfo: a sprint whose scope has zero ready leaf work can still
    // be legitimate -- a pure-verify sprint aimed at an already-implemented
    // parent (or a target bead that is itself all-children-closed). Computed
    // once here and reused below so the "nothing to do" diagnostics never
    // misreport this as a deadlock.
    const preSprintVerifyIds = initialBeads.length === 0
        ? classifyVerifySet(await fetchAllBeadsShared(), targetIssues).verifyIds
        : [];
    if (preSprintVerifyIds.length > 0) {
        log(`Pre-sprint validation: no ready leaf beads, but ${preSprintVerifyIds.length} bead(s) are implementation-complete and routed to verify: ${preSprintVerifyIds.join(', ')}. Proceeding as a verify-only sprint.`);
    }

    if (initialBeads.length === 0 && preSprintVerifyIds.length === 0) {
        // An empty `--ready` set is not by itself "nothing left to do": real
        // unblocked work can be deadlocked on a bead stuck in a stale
        // 'in_progress' state left by an interrupted run that never reached `bd
        // close`. `bd --ready` excludes non-'open' beads, so it cannot tell
        // "orphaned" from "actively being worked" -- but a bead whose 'blocks'
        // dependencies are ALL closed has nothing left to wait on, so its
        // status is the only thing blocking it. Reclaim exactly that case to
        // 'open' rather than requiring a manual `bd update`.
        const notDoneBeads = await bdListScoped(`--status=${NOT_DONE_STATUSES} --json`);
        const notDoneIds = new Set(notDoneBeads.map((b) => b.id));

        const unmetBlockers = (bead) => (bead.dependencies || [])
            .filter((d) => d.type === 'blocks' && notDoneIds.has(d.depends_on_id))
            .map((d) => d.depends_on_id);

        const { reclaimedIds: preSprintReclaimedIds } = await reclaimStaleInProgress({
            notDoneBeads,
            reasonTag: 'Pre-sprint self-heal',
        });
        if (preSprintReclaimedIds.length > 0) {
            initialBeads = await readyLeafBeads();
        }

        if (initialBeads.length === 0) {
            if (notDoneBeads.length === 0) {
                throw new Error(`Pre-sprint validation failed: No open/in-progress/blocked/deferred beads found for scope '${sprintFilter}'. Nothing to do.`);
            }

            // A specific deadlock shape: a `parent-child` edge one way plus a
            // `blocks` edge the other way between the SAME two beads (see
            // packages/apra-fleet-se/apra-pm/agents/_shared/GRAPH-SEMANTICS.md).
            // `bd dep cycles` does not detect it -- it does not walk
            // parent-child edges -- so it reads as "everything blocked" with no
            // actionable diagnosis. Check for it here, scoped to this sprint's
            // own not-done beads, before the generic deadlock message below.
            const byId = new Map(notDoneBeads.map((b) => [b.id, b]));
            const cyclePairs = [];
            for (const bead of notDoneBeads) {
                for (const dep of bead.dependencies || []) {
                    if (dep.type !== 'blocks') continue;
                    const other = byId.get(dep.depends_on_id);
                    const isParentChildPair = bead.parent === dep.depends_on_id
                        || (other && other.parent === bead.id);
                    if (isParentChildPair) {
                        cyclePairs.push({ blockedIssue: bead.id, blockedBy: dep.depends_on_id });
                    }
                }
            }
            if (cyclePairs.length > 0) {
                const fixCommands = cyclePairs.map((p) => `  bd dep remove ${p.blockedIssue} ${p.blockedBy}`);
                const cycleMessage =
                    `Pre-sprint validation failed: scope '${sprintFilter}' is deadlocked by ${cyclePairs.length} ` +
                    `parent-child + blocks cycle(s) (a bead has a 'blocks' dependency on its own --parent ` +
                    `ancestor/descendant, which fully blocks both beads even though 'bd dep cycles' will not ` +
                    `flag it). Fix by removing the offending 'blocks' edge(s):\n${fixCommands.join('\n')}`;

                // This shape is mechanically repairable -- the block above
                // already computed the precise edge(s) to remove -- so
                // auto-repair (one pass, no loop, no Planner dispatch) instead
                // of only throwing a diagnosis. A failed repair falls back to
                // the throw; it is never silently swallowed.
                try {
                    for (const pair of cyclePairs) {
                        await command(`bd dep remove ${pair.blockedIssue} ${pair.blockedBy}`, { member_name: orchestratorMember, silent: true });
                        log(`Pre-sprint auto-repair: removed the 'blocks' edge between ${pair.blockedIssue} and ${pair.blockedBy} (parent-child + blocks cycle) -- auto-removed via bd dep remove.`);
                    }
                } catch (repairErr) {
                    throw new Error(`${cycleMessage}\n\n(Auto-repair attempt itself failed: ${repairErr.message})`);
                }

                initialBeads = await readyLeafBeads();
                // Repair didn't unblock anything further -- one pass only, so
                // fall through to the existing generic deadlock diagnostics
                // below (do not loop, do not repair twice) when still empty.
                // Otherwise the sprint continues normally with the now-ready
                // beads, skipping the generic diagnostics entirely.
            }

            if (initialBeads.length === 0) {
                const diagnostics = notDoneBeads.map((b) => {
                    const blockers = unmetBlockers(b);
                    return blockers.length > 0
                        ? `  - ${b.id} [${b.status}] -- blocked by: ${blockers.join(', ')}`
                        : `  - ${b.id} [${b.status}] -- unblocked but status excludes it from --ready`;
                });
                throw new Error(
                    `Pre-sprint validation failed: No ready beads found for scope '${sprintFilter}', and ${notDoneBeads.length} ` +
                    `not-done bead(s) remain deadlocked:\n${diagnostics.join('\n')}`
                );
            }
        }
    }

    // =======================
    // Goal-priority exit condition + stall-abort bookkeeping
    // =======================
    //
    // `goalMax` is the worst ('Pn' with the highest n) priority tier named in
    // the sprint's `goal`. The real completion check below is "zero
    // NOT_DONE_STATUSES beads in scope at or above (numerically <=) this
    // priority", NOT "bd list --ready returned []".
    const goalMax = goalPriorityMax(validated.goal);

    // Stall detection: abort with a typed StalledSprintError after two
    // consecutive cycles that made no forward progress, rather than burning
    // every remaining cycle on a develop/review loop that keeps reopening and
    // re-failing the same bead(s).
    //
    // Progress is a HIGH-WATER MARK on the closed count, not a cycle-over-cycle
    // delta. A delta check is defeated by an oscillation (close a bead, reopen
    // it, close it again) whose closed-count sequence is 5,4,5,4,...: every
    // cycle differs from the one before, so the check never trips. Requiring a
    // cycle to exceed every prior cycle flags that correctly after
    // STALL_CYCLE_LIMIT non-record cycles.
    const STALL_CYCLE_LIMIT = 2;
    let staleCycles = 0;
    let highWaterClosedCount = 0;
    const closedCountHistory = [];

    // Per-bead reopen counts across the whole sprint. A bead reopened more than
    // REOPEN_THRASH_LIMIT times is flagged as thrashing -- the develop/review
    // loop is oscillating on that specific bead -- and its id is surfaced in
    // the StalledSprintError so a human sees WHICH beads are thrashing, not
    // just that the sprint stalled.
    const REOPEN_THRASH_LIMIT = 3;
    const reopenCounts = new Map();
    function recordReopen(id) {
        reopenCounts.set(id, (reopenCounts.get(id) ?? 0) + 1);
    }
    function thrashingBeadIds() {
        return [...reopenCounts.entries()]
            .filter(([, count]) => count > REOPEN_THRASH_LIMIT)
            .map(([id]) => id);
    }

    // apra-fleet-jfo: every bead id ever classified into the verify set this
    // sprint, monotone (added at classification, never removed -- even after
    // a bounce or eventual closure). Feeds the stall-detector's progress
    // score below: a bead cannot re-earn classification credit by
    // oscillating in and out of eligibility.
    const verifyEverIds = new Set();

    // apra-fleet-66u.2: separate two different facts the stall-abort message
    // used to conflate -- "closed count did not increase across N cycles"
    // (a progress fact) versus "verify-routed beads were dispatched to Integ
    // Test N times and produced ZERO closures" (a verifier fact). Only the
    // second condition licenses the "the verifier may be failing" wording.
    // verifyDispatchAttempts counts cycles where Integ Test was actually
    // handed a non-empty verify set; verifyDispatchClosures counts how many
    // of those cycles closed at least one of the beads it was handed (set at
    // Cycle Evaluation, once `stillOpenVerifyIds` -- computed on live,
    // correctly-scoped state per apra-fleet-66u.1's fix -- is available).
    let verifyDispatchAttempts = 0;
    let verifyDispatchClosures = 0;

    // apra-fleet-jfo D6: per-parent count of verify-fail bounces this sprint
    // (a gap bug filed under the parent, making it ineligible again). Capped
    // at VERIFY_GAP_LIMIT -- a parent that keeps failing verification is
    // deferred rather than bounced forever.
    const VERIFY_GAP_LIMIT = 2;
    const verifyGapCounts = new Map();

    // Deploy/Integration failure evidence, threaded into the Final Review's
    // evidence-based prompt below -- never silently swallowed.
    const deployFailures = [];
    const integFailures = [];

    // apra-fleet-nwh.1: integ-test-runner's own tracked spend, broken out of
    // the harvester's cost block so it is never silently folded into
    // "overhead" -- often the single longest/most expensive phase (a full
    // playbook run against a real sandbox). `budget` (destructured from
    // `context` above) exposes only a running total via spent(), not a
    // per-role breakdown, so this is derived here as a before/after delta
    // around each Integ Test phase dispatch (see the Integ Test Phase block
    // below) and fed into buildCostAnalysis() at Harvest time.
    // integTestRunnerDispatchCount stays 0 when the phase never dispatches
    // this run (no playbook, or deploy never succeeded), so buildCostAnalysis
    // can report that honestly instead of a fabricated/omitted line.
    let integTestRunnerSpend = 0;
    let integTestRunnerDispatchCount = 0;

    // Reviewer newTasks rejected by validateNewTask() before ever reaching
    // `command()`, threaded into the Final Review prompt so a rejection is
    // visible to a human rather than silently dropped. Rejection is non-fatal.
    // This is a cumulative AUDIT TRAIL -- every rejection ever seen this run,
    // never cleared -- distinct from pendingRejectedNewTasks below.
    const rejectedNewTasks = [];

    // The CURRENT set of not-yet-resubmitted rejected newTasks, resurfaced
    // verbatim into the next planning dispatch (buildPlannerPrompt's
    // rejectedNewTasksToResubmit) instead of dead-ending in root-bead notes.
    // Reassigned, never mutated in place, via the pure
    // trackRejectedNewTaskForResurfacing()/clearResubmittedNewTask() helpers.
    // Unlike `rejectedNewTasks`, an entry is DROPPED once resubmitted: it must
    // not accumulate forever.
    let pendingRejectedNewTasks = [];

    // The last Develop/Review loop's reviewer verdict for this cycle.
    // Goal-priority completion requires BOTH zero open goal-priority beads AND
    // an APPROVED last verdict -- a cycle whose ready-bead list emptied out
    // while the last review round was still CHANGES_NEEDED is not done.
    //
    // Both MUST be reset at the top of every cycle: an APPROVED verdict from
    // one cycle must never read as approved in the next, whose Develop/Review
    // loop may have been skipped entirely (no ready beads -> no fresh review).
    // `reviewedThisCycle` records whether a review genuinely ran THIS cycle, so
    // Cycle Evaluation can tell a fresh APPROVED from a stale one and dispatch
    // a re-review before trusting the latter.
    let lastReviewVerdict = null;
    let reviewedThisCycle = false;

    while (cycle <= MAX_CYCLES) {
        group(`Sprint Cycle ${cycle}`);

        // Reset per-cycle review state -- a verdict is only ever trustworthy
        // for the cycle that actually produced it.
        lastReviewVerdict = null;
        reviewedThisCycle = false;

        // After the first cycle, re-ensure (non-destructively) that every
        // member is still on the sprint branch before this cycle's doers run.
        // See reEnsureBranchOnMembers() above for why this never resets.
        if (cycle > 1) {
            await reEnsureBranchOnMembers();
        }

        // =======================
        // apra-fleet-jfo: Route -- classify verify-set beads BEFORE Plan
        // =======================
        // A bead whose every child is closed is implementation-complete and
        // must not be re-planned/re-decomposed -- it needs real integration-
        // test verification, not another Plan/Develop pass. Recomputed fresh
        // every cycle (no persisted list); classification itself counts as
        // sprint progress (see the stall-detector high-water-mark change
        // below), which is the actual fix for tonight's false-stall bug.
        const { verifyIds: verifySetThisCycle } = classifyVerifySet(await fetchAllBeadsShared(), targetIssues);
        for (const id of verifySetThisCycle) verifyEverIds.add(id);
        if (verifySetThisCycle.length > 0) {
            log(`Route C${cycle}: ${verifySetThisCycle.length} bead(s) implementation-complete, routed to verify (excluded from Plan/Develop): ${verifySetThisCycle.join(', ')}`);
        }

        // =======================
        // 1. Planning Loop
        // =======================
        // Approval is `verdict === 'APPROVED'` EXACTLY, read from the
        // plan-reviewer's schema-validated structured output (contracts.mjs
        // `planReviewerVerdict`). No substring matching anywhere in this phase,
        // so free text like "This can NOT be APPROVED" can never be misread as
        // an approval. A plan-reviewer that persistently fails to return
        // schema-valid JSON (after agent()'s own bounded schema-repair loop) is
        // a failed, CHANGES_NEEDED-equivalent round, never an approval.
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
        // Every earlier round's verdict for THIS cycle's plan-review loop,
        // oldest first -- fed to buildPlanReviewerPrompt from round 2 on, so
        // the no-goalpost-moving rule (plan-reviewer.md) has prior-round
        // rulings to bind against. Scoped to the cycle, like lastReviewVerdict.
        const priorPlanRoundVerdicts = [];

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
                rejectedNewTasksToResubmit: pendingRejectedNewTasks,
                verifyExcluded: verifySetThisCycle,
            });
            // The planner writes no code but MUTATES beads (it creates the task
            // DAG), so it is bracketed pushCode:false / pushBeads:true -- its
            // new tasks are D-pushed for the next dispatch to observe. Each
            // retried attempt gets its own bracket, since a retry may follow a
            // meaningful gap. Like every dispatch site, max_turns exhaustion is
            // answered with a same-session resume at doubled turns; the planner
            // gets a doer-sized base because it builds the whole epic DAG.
            const PLANNER_MAX_TURNS = 500;
            const plannerDispatchOpts = {
                member_name: getMemberForRole('planner'),
                agentType: 'planner',
                model: FIXED_ROLE_TIER.planner,
                // Planning the entire epic DAG is comparably heavy to a doer
                // streak, so it needs the sprint budget, not the default.
                timeout_s: DISPATCH_TIMEOUT_S,
                max_total_s: DISPATCH_TIMEOUT_S,
                max_turns: PLANNER_MAX_TURNS,
                // Within THIS cycle's plan-review loop, resume the planner's own
                // prior-round session by explicit session id so a re-plan keeps
                // warm context. False on the first round of any cycle
                // (roundSessions never resumes across cycles). The
                // max_turns-exhaustion path overrides this to `resume: true` via
                // spread order -- an in-dispatch continuation of the session
                // just run, orthogonal to cross-round resume.
                resume: roundSessions.resumeArgFor('planner', cycle),
                onSessionId: (id, meta) => roundSessions.record('planner', cycle, id, meta),
            };
            // Every interactive Planner dispatch attempt -- the first as well as
            // the resume -- is raced against a client-side watchdog so a
            // frozen-but-alive member session can never leave this await
            // silently hanging past its budget. See withDispatchWatchdog for
            // why this is needed in addition to, not instead of, the
            // server-side timeout_s/max_total_s passed below.
            const dispatchPlannerOnce = ({ skipPreDispatchSync = false, skipPreDispatchDoltPull = false } = {}) => withGitSync(getMemberForRole('planner'), false, () => withDispatchWatchdog(
                agent(plannerPrompt, { ...plannerDispatchOpts, member_name: getMemberForRole('planner') }),
                { timeoutS: DISPATCH_TIMEOUT_S, member: getMemberForRole('planner'), label: 'Plan (interactive)', log }
            ), { pushBeads: true, skipPreDispatchSync, skipPreDispatchDoltPull });
            const dispatchPlannerResume = () => withGitSync(getMemberForRole('planner'), false, () => withDispatchWatchdog(
                agent(
                    'Continue your planning pass exactly where you left off in this same session -- do not restart or re-derive the DAG from scratch. Finish creating/updating the remaining beads and return your final summary now.',
                    {
                        ...plannerDispatchOpts,
                        member_name: getMemberForRole('planner'),
                        label: `Plan (resume, max_turns=${PLANNER_MAX_TURNS * 2})`,
                        resume: true,
                        max_turns: PLANNER_MAX_TURNS * 2,
                    }
                ),
                { timeoutS: DISPATCH_TIMEOUT_S, member: getMemberForRole('planner'), label: `Plan (resume, max_turns=${PLANNER_MAX_TURNS * 2})`, log }
            ), { pushBeads: true });
            const dispatchPlanner = async ({ skipPreDispatchSync = false, skipPreDispatchDoltPull = false } = {}) => {
                try {
                    return await dispatchPlannerOnce({ skipPreDispatchSync, skipPreDispatchDoltPull });
                } catch (err) {
                    if (err instanceof AgentDispatchError && err.details?.reason === 'max_turns_exhausted') {
                        log(`Planner exhausted its turn limit (max_turns=${PLANNER_MAX_TURNS}) -- resuming the same session with max_turns=${PLANNER_MAX_TURNS * 2}.`);
                        // A resume follows an agent that DID run (max_turns_exhausted
                        // is a resumable partial-work case, not a no-mutation
                        // failure) -- so it always runs the full pre-dispatch sync.
                        await memberSessionGuard.killIfAlive(getMemberForRole('planner'));
                        return await dispatchPlannerResume();
                    }
                    throw err;
                }
            };
            // A bounded backoff ladder rather than a single immediate retry: the
            // dominant transient failure is a "busy" AgentDispatchError
            // ("execute_prompt is already running for <member>"), and a fleet
            // member's busy-lock can take considerably longer than a few seconds
            // to clear. An immediate blind retry reproduces the same error and,
            // uncaught, would kill the whole sprint. The ladder's total headroom
            // is sized for a real busy-lock, not for a schema or logic error --
            // those are caught by the non-retryable checks in the loop body.
            const PLANNER_DISPATCH_RETRY_DELAYS_MS = [0, 5000, 15000, 30000, 60000];
            let plannerErr = null;
            // When the previous attempt failed terminally with nothing to
            // publish, its pre-dispatch G-pull/D-pull is still fresh, so the next
            // attempt skips re-running them. See withGitSync's
            // skipPreDispatchSync.
            let skipPreDispatchSyncNext = false;
            // The sprint's FIRST Planner dispatch reads/mutates the SAME beads
            // clone the orchestrator's pre-sprint doltPullBefore just freshened,
            // with only non-mutating `bd list` reads in between, so its own
            // pre-dispatch `bd dolt pull` is redundant. Skipping it also keeps
            // the terminal auth-abort path from hanging on that bracket. Scoped
            // out -- all keeping the full D-pull -- are: a later cycle (a re-plan
            // follows real beads mutation), a later planning round (round 1's
            // planner already mutated beads), any retry attempt, and a planner on
            // a DISTINCT clone from the orchestrator (never freshened by the
            // setup pull).
            const plannerSharesOrchestratorClone = getMemberForRole('planner') === orchestratorMember;
            // The ladder's real timed sleeps exist purely for production
            // busy-lock resilience; a hermetic mock run has no busy-lock to wait
            // out, so the harness sets this flag to exercise the full ladder
            // LOGIC with zero wall-clock. The delay values and the "waiting Ns"
            // log line are unchanged either way, so observable behavior matches.
            const instantRetryBackoff = process.env.APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF === '1';
            for (let i = 0; i < PLANNER_DISPATCH_RETRY_DELAYS_MS.length; i++) {
                if (PLANNER_DISPATCH_RETRY_DELAYS_MS[i] > 0) {
                    log(`Planner dispatch: waiting ${PLANNER_DISPATCH_RETRY_DELAYS_MS[i] / 1000}s before retry attempt ${i + 1}/${PLANNER_DISPATCH_RETRY_DELAYS_MS.length}...`);
                    if (!instantRetryBackoff) {
                        await new Promise((resolve) => setTimeout(resolve, PLANNER_DISPATCH_RETRY_DELAYS_MS[i]));
                    }
                }
                try {
                    const skipPreDispatchDoltPull =
                        i === 0 && cycle === 1 && planningRounds === 1 && plannerSharesOrchestratorClone;
                    await dispatchPlanner({ skipPreDispatchSync: skipPreDispatchSyncNext, skipPreDispatchDoltPull });
                    plannerErr = null;
                    break;
                } catch (err) {
                    plannerErr = err;
                    // The Planner turn ALREADY RAN and its output is committed in
                    // the member's local beads clone -- only the post-dispatch
                    // sync failed, and withGitSync already retried that step on
                    // its own. Redispatching would spawn a second Planner session
                    // for the same phase on top of completed work, so abort the
                    // ladder and surface the sync failure.
                    if (isPostDispatchSyncFailure(err)) {
                        log(`Planner dispatch COMPLETED but its post-dispatch sync failed: ${err.message} Aborting retries WITHOUT re-dispatching -- the planning turn already ran and its beads writes are local; fix the sync and re-run.`);
                        break;
                    }
                    // Only a no-mutation dispatch failure leaves the workspace
                    // provably unchanged, so only then may the next attempt skip
                    // its pre-dispatch sync. Any other error re-arms it.
                    skipPreDispatchSyncNext = isNoMutationDispatchFailure(err);
                    // Auth/workspace-trust failures are deterministic -- no retry
                    // can succeed -- so abort immediately rather than burning the
                    // remaining attempts reproducing the same failure.
                    if (isNonRetryableDispatchError(err)) {
                        // An LLM-auth failure (unlike workspace-trust, which
                        // self-heal cannot fix) gets one bounded self-heal
                        // attempt before the loop gives up.
                        if (isAuthDispatchError(err) && typeof onLlmAuthFailure === 'function') {
                            const healed = await onLlmAuthFailure({ member: getMemberForRole('planner'), label: 'Planner dispatch', error: err.message });
                            if (healed) {
                                log(`Planner dispatch: LLM auth self-heal succeeded -- retrying.`);
                                continue;
                            }
                        }
                        log(`Planner dispatch threw a non-retryable error (auth/trust): ${err.message}. Aborting retries -- fix the member's credentials/trust and re-run.`);
                        break;
                    }
                    const isLastAttempt = i === PLANNER_DISPATCH_RETRY_DELAYS_MS.length - 1;
                    log(`Planner dispatch threw: ${err.message}.${isLastAttempt ? ' Retries exhausted.' : ' Retrying.'}`);
                }
            }
            if (plannerErr) {
                throw plannerErr;
            }
            // The planner resubmits a corrected rejected finding directly via
            // `bd create`, never through
            // persistNewTaskBestEffort/clearResubmittedNewTask -- and correcting
            // the stated defect usually means changing the title, so a
            // title-keyed pending entry would stay stuck and reappear in every
            // later planning prompt this run. Reconcile against what now exists
            // as a child of each target parent, matching on description
            // (title-independent); see reconcilePendingRejectedNewTasks().
            // Best-effort: a listing failure leaves the pending list as-is, so
            // the worst case is one more resurfacing, never a sprint abort.
            if (pendingRejectedNewTasks.length > 0) {
                for (const parentId of targetIssues) {
                    try {
                        const label = `bd list --parent ${parentId} --json`;
                        const raw = await command(label, { member_name: orchestratorMember, silent: true });
                        const children = parseBdJson(raw, label);
                        pendingRejectedNewTasks = reconcilePendingRejectedNewTasks(pendingRejectedNewTasks, children);
                    } catch (err) {
                        log(`[fleet-sprint] pending-rejected-newTask reconciliation against '${parentId}' children FAILED (non-fatal, list stays as-is): ${err.message}`);
                    }
                }
            }
            // Deliberately no log() dump of the planner's response here: the
            // agent() call inside dispatchPlanner() already emits it as the
            // dispatch's own AGENT activity row, so logging it again would
            // render a duplicate row in the viewer. The same rule applies at
            // every role's dispatch site in this file.

            let verdict;
            // Reviewer-sized turn base, with the same same-session
            // turn-exhaustion resume every dispatch site uses.
            const PLAN_REVIEWER_MAX_TURNS = 500;
            const planReviewerDispatchOpts = {
                member_name: getMemberForRole('plan-reviewer'),
                agentType: 'plan-reviewer',
                schema: planReviewerVerdict,
                model: FIXED_ROLE_TIER['plan-reviewer'],
                // Needs the sprint dispatch budget, like the Planner.
                timeout_s: DISPATCH_TIMEOUT_S,
                max_total_s: DISPATCH_TIMEOUT_S,
                max_turns: PLAN_REVIEWER_MAX_TURNS,
            };
            // Mirrors dispatchReview()'s reviewAttempt ladder: an
            // infrastructure dispatch failure (schema-repair exhaustion, a
            // dropped transport) gets exactly one extra attempt WITHIN this
            // same planning round -- it does not consume a second round out
            // of the 3-round planningRounds cap -- before the round is
            // recorded as a dispatch-level failure. Every synthesized
            // fallback verdict below carries `dispatchFailed: true` so the
            // plan-cap exhaustion check after this loop can tell "the
            // plan-reviewer's dispatch channel never came back" apart from
            // "the reviewer genuinely rejected the plan" and throw the
            // correctly-flavored error for each (apra-fleet-9ta.4).
            for (let planReviewAttempt = 1; planReviewAttempt <= 2; planReviewAttempt++) {
                try {
                    try {
                        verdict = await withGitSync(getMemberForRole('plan-reviewer'), false, () => agent(
                            buildPlanReviewerPrompt({ targetIssues, goal: validated.goal, priorRoundVerdicts: priorPlanRoundVerdicts, verifyExcluded: verifySetThisCycle }),
                            { ...planReviewerDispatchOpts, member_name: getMemberForRole('plan-reviewer') }
                        ));
                    } catch (err) {
                        if (err instanceof AgentDispatchError && err.details?.reason === 'max_turns_exhausted') {
                            log(`Plan Reviewer exhausted its turn limit (max_turns=${PLAN_REVIEWER_MAX_TURNS}) -- resuming the same session with max_turns=${PLAN_REVIEWER_MAX_TURNS * 2}.`);
                            await memberSessionGuard.killIfAlive(getMemberForRole('plan-reviewer'));
                            verdict = await withGitSync(getMemberForRole('plan-reviewer'), false, () => agent(
                                'Continue your plan review exactly where you left off in this same session -- do not restart or re-read the DAG from scratch. Finish the remaining criteria and return your final verdict now.',
                                {
                                    ...planReviewerDispatchOpts,
                                    member_name: getMemberForRole('plan-reviewer'),
                                    label: `Plan Review (resume, max_turns=${PLAN_REVIEWER_MAX_TURNS * 2})`,
                                    resume: true,
                                    max_turns: PLAN_REVIEWER_MAX_TURNS * 2,
                                }
                            ));
                        } else {
                            throw err;
                        }
                    }
                } catch (err) {
                    // An unhealed LLM-auth failure here reproduces identically on
                    // every remaining planning round. One self-heal attempt gives
                    // the next round a real chance to succeed.
                    if (isAuthDispatchError(err) && typeof onLlmAuthFailure === 'function') {
                        await onLlmAuthFailure({ member: getMemberForRole('plan-reviewer'), label: 'Plan Reviewer dispatch', error: err.message });
                    }
                    // Persistent non-JSON/non-schema-compliant output, or a failed
                    // dispatch, both FAIL this plan round -- neither must ever be
                    // treated as an approval, and both are marked dispatchFailed
                    // so they are never mistaken for a genuine reviewer rejection.
                    if (err instanceof AgentOutputError) {
                        log(`Plan Reviewer: schema-repair exhausted, treating round as CHANGES_NEEDED: ${err.message}`);
                        verdict = {
                            verdict: 'CHANGES_NEEDED',
                            notes: `Plan reviewer failed to return a schema-valid verdict after repair attempts: ${err.message}`,
                            taskAssignments: [],
                            dispatchFailed: true,
                        };
                    } else if (err instanceof AgentDispatchError || err instanceof FleetTransportError) {
                        // A transport-level failure (e.g. a connection dropped
                        // mid-schema-repair-retry) is exactly as transient and
                        // non-schema as an AgentDispatchError -- neither may
                        // propagate and abort the whole sprint.
                        log(`Plan Reviewer: agent dispatch failed, treating round as CHANGES_NEEDED: ${err.message}`);
                        verdict = {
                            verdict: 'CHANGES_NEEDED',
                            notes: `Plan reviewer dispatch failed: ${err.message}`,
                            taskAssignments: [],
                            dispatchFailed: true,
                        };
                    } else {
                        throw err;
                    }
                }
                if (verdict.dispatchFailed && planReviewAttempt < 2) {
                    log(`Plan Reviewer: dispatch-level failure on attempt ${planReviewAttempt} of 2 -- retrying the plan review once before recording this round as a dispatch failure.`);
                    continue;
                }
                break;
            }
            lastVerdict = verdict;
            // No duplicate log() dump -- see dispatchReview() for why.
            // This round's verdict is recorded AFTER the dispatch that consumed
            // the accumulated prior rounds, so a round never sees its own
            // not-yet-returned verdict.
            priorPlanRoundVerdicts.push({ round: planningRounds, verdict: verdict.verdict, notes: verdict.notes });

            if (verdict.verdict === 'APPROVED') {
                planApproved = true;
            } else {
                plannerFeedback = verdict.notes; // Pass textual feedback to planner, wrapped as untrusted by buildPlannerPrompt
            }
            await updateDashboard();
        }

        // Plan-cap exhaustion (every round CHANGES_NEEDED, never an APPROVED)
        // does not necessarily condemn the whole plan: one bead's unresolved
        // finding can pin the verdict while the rest of the task set is clean.
        // When the last verdict's findings name specific beads, defer just
        // those (status=deferred plus the finding attached as a note) and
        // proceed to Develop with the remaining approved set. Abort only when
        // the contested set is the whole plan, or when deferring it would leave
        // nothing ready to dispatch (checked once readyBeads is computed).
        let planCapDeferredIds = [];
        if (!planApproved) {
            const allTaskIds = (lastVerdict && Array.isArray(lastVerdict.taskAssignments))
                ? lastVerdict.taskAssignments.map((a) => a && a.id).filter((id) => typeof id === 'string' && id.length > 0)
                : [];
            const contestedIds = extractContestedBeadIds(lastVerdict);
            const wholePlanContested = allTaskIds.length === 0
                || contestedIds.length === 0
                || contestedIds.length >= allTaskIds.length;

            if (wholePlanContested) {
                // apra-fleet-9ta.4: a `dispatchFailed` last verdict means the
                // plan-reviewer's dispatch channel never came back with a real
                // verdict (schema-repair exhaustion / transport failure, even
                // after the one same-round retry above) -- the plan was never
                // actually reviewed, so this must NOT be misreported as
                // SprintPlanRejectedError (which asserts a genuine rejection).
                if (lastVerdict && lastVerdict.dispatchFailed) {
                    throw new PlanReviewDispatchFailedError(
                        `Plan phase for cycle ${cycle} exhausted ${planningRounds} plan round(s) without a usable ` +
                        'plan-reviewer verdict -- the last round\'s verdict was synthesized from a dispatch failure, ' +
                        'not a genuine review. The plan was never actually reviewed; re-run the sprint once the ' +
                        'plan-reviewer dispatch channel recovers.',
                        {
                            notes: lastVerdict ? lastVerdict.notes : null,
                            cycle,
                            planningRounds,
                        }
                    );
                }
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

            log(`[fleet-sprint] plan-cap deferral: cycle ${cycle} exhausted ${planningRounds} plan round(s) with ` +
                `CHANGES_NEEDED confined to bead(s) [${contestedIds.join(', ')}] -- deferring ${contestedIds.length === 1 ? 'it' : 'them'} ` +
                `and proceeding to Develop with the remaining approved task set.`);

            for (const id of contestedIds) {
                await command(
                    `bd update ${id} --status=deferred`,
                    { member_name: orchestratorMember, silent: true, label: `Defer contested bead ${id} per plan-cap exhaustion` }
                );
                // Stage the deferral note member-side: the orchestrator member
                // can itself be remote, so a host-local body-file path would be
                // unreachable to `bd note`.
                const noteFile = await stageCommandBodyMemberSide({
                    command, member: orchestratorMember,
                    content:
                        `[fleet-sprint plan-cap deferral] Deferred after ${planningRounds} plan round(s) of CHANGES_NEEDED ` +
                        `confined to this bead (cycle ${cycle}). Plan reviewer finding:\n${lastVerdict.notes}`,
                    label: `Stage plan-cap deferral finding for ${id}`,
                });
                await command(
                    `bd note ${id} --file "${noteFile}"`,
                    { member_name: orchestratorMember, silent: true, label: `Attach plan-cap deferral finding to ${id}` }
                );
            }
            // (apra-fleet-p2to.4.1) standalone sync bracket -- see openSyncBracketCount's doc comment above.
            await withOpenSyncBracket(() => DoltSync.syncAfter(orchestratorMember, { command, pushBeads: true, log, mutex: doltPushMutex, sprintId: sprintMutexId }));
            planCapDeferredIds = contestedIds;
        }

        // =======================
        // 2. Execution Prep
        // =======================
        // `bd list --ready --json` does not guarantee a stable ordering: it
        // returns beads by `created_at` descending, but `created_at` has only
        // 1-second resolution, so beads created within the same second tie with
        // no reproducible tie-break. Bead `id` is not a safe sort key either --
        // it carries a random per-scratch-dir suffix. `title` is the only field
        // both guaranteed present and stable across runs, so it orders here
        // (with `id` as a final tie-break for identical titles). Without this,
        // dispatch order -- and which physical doer member each streak
        // round-robins to -- would vary between two otherwise-identical runs.
        //
        // The type filter mirrors, engine-side, the doer contract's "only claim
        // issue_type=task" rule at SEEDING time: a non-task bead handed to a
        // doer produces a deterministic contract-mandated refusal, so paying a
        // full LLM dispatch to hear it back is pure token waste. It touches
        // neither readiness semantics nor readyLeafBeads()'s structural parent
        // guard. Childless non-task beads stay in scope for the PLANNER, whose
        // contract decomposes them into task children; they just never reach a
        // doer streak directly.
        //
        // EXEMPTION -- target issues: a childless leaf TARGET is seeded into
        // scope whatever its recorded type, because if planning leaves it
        // childless, direct dispatch is the sprint's only path to it. The
        // filter exists to stop NON-target parents/bugs from wasting doer
        // dispatches, never to make a sprint's own target unreachable.
        const targetIssueSet = new Set(targetIssues);
        let readyBeads = (await readyLeafBeads())
            .filter((b) => targetIssueSet.has(b.id) || !b.issue_type || b.issue_type === 'task')
            .slice().sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

        // Per-cycle self-heal (not just pre-sprint, see reclaimStaleInProgress's
        // doc comment): only when THIS cycle's ready set is otherwise empty --
        // mirrors the pre-sprint gate exactly, and keeps the common case (real
        // ready work every cycle) issuing zero extra `bd` calls, unlike an
        // unconditional per-cycle check. Reclaim any bead orphaned in_progress
        // since before this sprint launched, then recompute readiness, so a
        // claim orphaned mid-run (or reused from a prior aborted incarnation on
        // relaunch) self-heals on the very next cycle instead of silently
        // blocking every cycle after it for the rest of the sprint.
        if (readyBeads.length === 0) {
            const notDoneBeadsThisCycle = await bdListScoped(`--status=${NOT_DONE_STATUSES} --json`);
            const { reclaimedIds: cycleReclaimedIds } = await reclaimStaleInProgress({
                notDoneBeads: notDoneBeadsThisCycle,
                reasonTag: `Cycle ${cycle} self-heal`,
            });
            if (cycleReclaimedIds.length > 0) {
                log(`Cycle ${cycle} self-heal: reclaimed ${cycleReclaimedIds.length} orphaned bead(s), re-checking readiness: ${cycleReclaimedIds.join(', ')}.`);
                readyBeads = (await readyLeafBeads())
                    .filter((b) => targetIssueSet.has(b.id) || !b.issue_type || b.issue_type === 'task')
                    .slice().sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
            }
        }

        // The second plan-cap-deferral abort condition: deferring the contested
        // beads must never silently leave nothing dispatchable. An empty
        // readyBeads list is not normally an abort signal (Cycle Evaluation
        // decides completion), but immediately after a deferral it means the
        // approved remainder was empty all along, which is the same failure as
        // a whole-plan-contested exhaustion.
        if (planCapDeferredIds.length > 0 && readyBeads.length === 0) {
            throw new SprintPlanRejectedError(
                `Plan phase for cycle ${cycle}: after deferring contested bead(s) ` +
                `[${planCapDeferredIds.join(', ')}] per plan-cap exhaustion, the resulting ready set is empty. ` +
                'Refusing to proceed to Develop with nothing dispatchable.',
                {
                    notes: lastVerdict ? lastVerdict.notes : null,
                    cycle,
                    planningRounds,
                }
            );
        }

        // An empty `--ready` list is NOT, by itself, evidence the sprint
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
        // 3. Develop & Review Loop
        // =======================
        //
        // Every agent() dispatch below is consumed by the orchestrator -- no
        // result is ever logged-and-discarded. `doerPool` contains every
        // configured member, and each doer branch round-robins across the full
        // pool rather than collapsing onto one member.
        let devRounds = 0;
        let lastStillOpenCount = 0;  // Track for round-cap detection at loop exit

        // beadId -> reviewer feedback text for the NEXT round, populated only
        // for beads actually named in a CHANGES_NEEDED verdict's `reopenIds`:
        // per-bead routing, not a blanket broadcast of the whole verdict to
        // every doer.
        const perBeadFeedback = new Map();

        // Union of every bead id a reviewer verdict THIS cycle flagged via the
        // optional `replanIds` field: the bead was reopened, but its ACCEPTANCE
        // CRITERIA are themselves defective and can only be corrected by a
        // planner, not by re-development. Scoped to the cycle -- a defect
        // flagged here is re-scoped by this cycle's own handoff and must not
        // leak into the next. Populated after each round's reopenIds are
        // applied; consulted at the top of the next iteration.
        const replanIds = new Set();

        // Loop guard for the in-cycle scoped replan: bead ids that have ALREADY
        // been through one scoped planner+plan-review pass THIS cycle. Enforces
        // max one scoped replan per bead per cycle -- a bead flagged a second
        // time is refused at the reviewer fold-in below rather than re-planned,
        // so a defective bead can never ping-pong replan<->develop endlessly
        // within a cycle. Scoped to the cycle, like replanIds.
        const replannedThisCycle = new Set();

        const doerPool = getMembersForRole(ROLE_DOER);

        while (devRounds < 3) {
            // Same stable ordering and doer-dispatchability filter as
            // `readyBeads` above, and both must apply HERE too: this in-loop
            // list is the one that actually feeds the streak-assignment prompt
            // and the doerPool round-robin index. A bug/feature bead created
            // after the plan phase (a reviewer newTask, an out-of-band filing)
            // would otherwise land in a doer streak and burn a dispatch on a
            // contract-bound refusal. Same target-issue exemption as above.
            const currentReadyAll = (await readyLeafBeads())
                .filter((b) => targetIssueSet.has(b.id) || !b.issue_type || b.issue_type === 'task')
                .slice().sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

            if (currentReadyAll.length === 0) break;

            // In-cycle SCOPED replan, taken on a bead's FIRST replan flag: when
            // a reviewer flags a still-ready bead via `replanIds` -- its
            // acceptance criteria are defective and cannot be satisfied by
            // re-development -- dispatch a scoped planner pass over exactly
            // those beads' subtree plus a scoped plan-review of the result,
            // within this same cycle, then resume develop rounds so the amended
            // bead is re-dispatched to a doer now rather than waiting on the
            // next cycle's full planner. `replannedThisCycle` makes this fire at
            // most once per bead per cycle: a second flag is refused at the
            // reviewer fold-in and falls through to the exclude/break
            // short-circuit below instead. A scoped replan pass consumes one
            // develop round, so a replan<->develop ping-pong cannot outrun the
            // round cap.
            const eligibleReplan = currentReadyAll.filter((b) => replanIds.has(b.id) && !replannedThisCycle.has(b.id));
            if (eligibleReplan.length > 0) {
                const replanScopeIds = eligibleReplan.map((b) => b.id);
                devRounds++;
                phase(`Replan C${cycle} R${devRounds}`);
                log(
                    `[fleet-sprint] in-cycle scoped replan: reviewer flagged bead(s) ${replanScopeIds.join(', ')} as ` +
                    `having defective acceptance criteria -- dispatching a SCOPED planner + plan-review pass for their ` +
                    `subtree THIS cycle (replan round R${devRounds}) instead of deferring to the next cycle, then ` +
                    `resuming develop rounds.`
                );
                // Guard: mark up front so a SECOND replan flag for the same bead
                // this cycle is refused (see the reviewer fold-in below), whatever
                // the outcome of this pass.
                for (const id of replanScopeIds) replannedThisCycle.add(id);

                // --- Scoped planner pass ---
                const SCOPED_REPLAN_PLANNER_MAX_TURNS = 500;
                let scopedPlannerOk = true;
                try {
                    const scopedPlannerRes = await withGitSync(getMemberForRole('planner'), false, () => withDispatchWatchdog(
                        agent(
                            buildPlannerPrompt({
                                isDeltaCycle: true,
                                targetIssues,
                                goal: validated.goal,
                                requirementsFile: validated.requirementsFile,
                                requirementsContent,
                                feedback: null,
                                replanScope: replanScopeIds,
                                // The scoped replan is a real planner dispatch
                                // like the main Plan phase, so a pending
                                // rejected newTask must resurface here too.
                                rejectedNewTasksToResubmit: pendingRejectedNewTasks,
                                verifyExcluded: verifySetThisCycle,
                            }),
                            {
                                member_name: getMemberForRole('planner'),
                                agentType: 'planner',
                                model: FIXED_ROLE_TIER.planner,
                                timeout_s: DISPATCH_TIMEOUT_S,
                                max_total_s: DISPATCH_TIMEOUT_S,
                                max_turns: SCOPED_REPLAN_PLANNER_MAX_TURNS,
                                label: 'Scoped Replan Plan (interactive)',
                            }
                        ),
                        { timeoutS: DISPATCH_TIMEOUT_S, member: getMemberForRole('planner'), label: 'Scoped Replan Plan (interactive)', log }
                    ), { pushBeads: true });
                    log(`Scoped Replan Planner: ${scopedPlannerRes}`);
                } catch (err) {
                    scopedPlannerOk = false;
                    // Self-heal an LLM-auth failure so the next cycle's planner
                    // -- which this bead is deferred to below -- does not hit
                    // the identical wall.
                    if (isAuthDispatchError(err) && typeof onLlmAuthFailure === 'function') {
                        await onLlmAuthFailure({ member: getMemberForRole('planner'), label: 'Scoped Replan Plan dispatch', error: err.message });
                    }
                    log(`[fleet-sprint] in-cycle scoped replan: planner dispatch failed (${err.message}) -- leaving bead(s) ${replanScopeIds.join(', ')} flagged for the next cycle's planner.`);
                }

                // --- Scoped plan-review pass ---
                let scopedReplanApproved = false;
                if (scopedPlannerOk) {
                    const SCOPED_REPLAN_REVIEWER_MAX_TURNS = 500;
                    try {
                        const scopedVerdict = await withGitSync(getMemberForRole('plan-reviewer'), false, () => agent(
                            buildPlanReviewerPrompt({ targetIssues, goal: validated.goal, replanScope: replanScopeIds, verifyExcluded: verifySetThisCycle }),
                            {
                                member_name: getMemberForRole('plan-reviewer'),
                                agentType: 'plan-reviewer',
                                schema: planReviewerVerdict,
                                model: FIXED_ROLE_TIER['plan-reviewer'],
                                timeout_s: DISPATCH_TIMEOUT_S,
                                max_total_s: DISPATCH_TIMEOUT_S,
                                max_turns: SCOPED_REPLAN_REVIEWER_MAX_TURNS,
                                label: 'Scoped Replan Review',
                            }
                        ));
                        log(`Scoped Replan Reviewer: ${JSON.stringify(scopedVerdict)}`);
                        scopedReplanApproved = scopedVerdict.verdict === 'APPROVED';
                    } catch (err) {
                        // Same rationale as the scoped planner catch above:
                        // self-heal before deferring to the next cycle's
                        // planner/plan-reviewer pass.
                        if (isAuthDispatchError(err) && typeof onLlmAuthFailure === 'function') {
                            await onLlmAuthFailure({ member: getMemberForRole('plan-reviewer'), label: 'Scoped Replan Review dispatch', error: err.message });
                        }
                        // A schema-repair-exhausted or dispatch failure is a
                        // FAILED scoped review (never an approval), same
                        // discipline as the main plan loop above.
                        log(`[fleet-sprint] in-cycle scoped replan: plan-review dispatch failed (${err.message}) -- treating the scoped replan as NOT approved; bead(s) ${replanScopeIds.join(', ')} handed to the next cycle's planner.`);
                    }
                }

                if (scopedReplanApproved) {
                    // The planner re-scoped the flagged bead(s) and the
                    // plan-reviewer approved the amendment -- clear them from
                    // replanIds so the NEXT loop iteration re-dispatches them to a
                    // doer IN THIS SAME cycle.
                    for (const id of replanScopeIds) replanIds.delete(id);
                    log(`[fleet-sprint] in-cycle scoped replan: plan-review APPROVED the amendment for ${replanScopeIds.join(', ')} -- resuming develop rounds; the re-scoped bead(s) are re-dispatchable to a doer this cycle.`);
                } else {
                    // Not approved (or the planner/reviewer dispatch failed): the
                    // bead(s) stay in replanIds AND are now marked
                    // replannedThisCycle, so the next iteration's exclude/break
                    // short-circuit defers them to the next cycle's planner.
                    log(`[fleet-sprint] in-cycle scoped replan: the scoped replan of ${replanScopeIds.join(', ')} was not approved -- they stay excluded from this cycle's develop rounds (deferred to the next cycle's planner).`);
                }

                // The scoped planner just MUTATED beads in this clone -- D-push
                // and refresh the dashboard before re-evaluating the loop top.
                // Routed through the single dolt-sync module's AFTER bracket
                // (apra-fleet-417.2.1); behavior is identical.
                // (apra-fleet-p2to.4.1) standalone sync bracket -- see openSyncBracketCount's doc comment above.
                await withOpenSyncBracket(() => DoltSync.syncAfter(orchestratorMember, { command, pushBeads: true, log, mutex: doltPushMutex, sprintId: sprintMutexId }));
                await updateDashboard();
                continue;
            }

            // Replan short-circuit for beads whose scoped replan did not land.
            // Re-dispatching a replan-flagged bead to a doer is a predictably
            // wasted round: it is reopened, but its acceptance criteria are
            // defective. If EVERY still-ready bead this round is flagged, skip
            // all further develop/review rounds this cycle and let Cycle Eval
            // hand off to the next cycle's planner, which re-reads bead comments
            // and can re-scope. A MIX still runs a round with only the flagged
            // beads excluded from streak assignment, so real dev work is never
            // blocked on a defect in an unrelated bead's criteria. An empty
            // `replanIds` makes this a no-op.
            const currentReady = currentReadyAll.filter((b) => !replanIds.has(b.id));
            if (currentReady.length === 0) {
                log(
                    `[fleet-sprint] replan short-circuit: all ${currentReadyAll.length} still-ready bead(s) this cycle ` +
                    `are replan-flagged (${currentReadyAll.map((b) => b.id).join(', ')}) -- their acceptance criteria ` +
                    `need planner correction, not re-development. Skipping remaining develop/review rounds this cycle ` +
                    `and proceeding to Cycle Eval.`
                );
                break;
            }
            if (currentReady.length < currentReadyAll.length) {
                const excludedIds = currentReadyAll.filter((b) => replanIds.has(b.id)).map((b) => b.id);
                log(
                    `[fleet-sprint] replan short-circuit: excluding replan-flagged bead(s) ${excludedIds.join(', ')} from ` +
                    `this round's streak assignment (acceptance criteria defect flagged by reviewer; will be re-scoped ` +
                    `by the next cycle's planner) -- the remaining ${currentReady.length} bead(s) still run this round.`
                );
            }

            devRounds++;
            phase(`Develop C${cycle} R${devRounds}`);

            // --- Streak grouping ------------------------------------------
            // PREFER deterministic grouping straight from the planner's lane
            // metadata (`streak`/`streakOrder`, emitted per planner.md through
            // the same `--metadata` channel as `model`), intersected with THIS
            // round's ready set. When every ready bead carries a `streak` id the
            // grouping is fully determined by the plan, so the runtime "Streak
            // Assignment" LLM dispatch is skipped entirely -- deterministic,
            // zero prompt drift, one fewer agent round-trip. The LLM path below
            // is retained ONLY as a fallback for plans that lack lane metadata;
            // see groupStreaksFromLaneMetadata() for the all-or-nothing rule.
            let streaks, usedFallback, reason;
            const laneGrouping = groupStreaksFromLaneMetadata(currentReady);
            if (laneGrouping) {
                ({ streaks, reason } = laneGrouping);
                usedFallback = false;
                log(
                    `Streak grouping: deterministic from lane metadata -- ${laneGrouping.streaks.length} streak(s), ` +
                    `no Streak Assignment dispatch (${laneGrouping.streaks.map((s) => `[${s.map((b) => b.id).join(', ')}]`).join(' ')}).`
                );
            } else {
            // --- Streak assignment (FALLBACK) ---------------------------------
            // Reached only when the plan lacks lane metadata (see above).
            // Schema-validated {streaks: string[][]}; falls back to a
            // deterministic one-bead-per-streak grouping whenever the candidate
            // does not cover every ready bead id exactly once -- invalid output,
            // or agent()'s own bounded schema-repair loop exhausted. See
            // selectStreaks().
            log('Streak grouping: no lane metadata on this round\'s ready beads -- falling back to LLM Streak Assignment dispatch (back-compat with pre-eft.76 plans).');
            let streakCandidate = null;
            try {
                streakCandidate = await agent(
                    buildStreakAssignmentPrompt({ readyBeadIds: currentReady.map((b) => b.id) }),
                    {
                        // No `agentType` here on purpose: this call has no
                        // vendored persona of its own (see the streakAssignment
                        // schema comment in contracts.mjs) and reuses the
                        // planner MEMBER only for its model-tier routing.
                        // Activating the full `planner` persona -- whose system
                        // prompt is "read open beads, build a sprint DAG" -- on
                        // this narrow, fully-specified grouping task makes the
                        // model go exploring with its Bash/Read/Grep tools
                        // instead of answering directly from the prompt, which
                        // can run long enough to hit the transport timeout.
                        member_name: getMemberForRole('planner'),
                        label: 'Streak Assignment',
                        schema: streakAssignment,
                        model: FIXED_ROLE_TIER.streakAssignment,
                    }
                );
                // No duplicate log() dump -- see dispatchReview() for why. The
                // standard AGENT row (label 'Streak Assignment', above) already
                // renders through the same generic path as every other dispatch.
            } catch (err) {
                if (err instanceof AgentOutputError) {
                    log(`Streak Assignment: schema-repair exhausted, falling back to one-bead-per-streak: ${err.message}`);
                } else if (err instanceof AgentDispatchError || err instanceof FleetTransportError) {
                    // Self-heal now so the SAME member's next dispatch this
                    // cycle -- it reuses the planner member -- does not walk
                    // into the identical unhealed auth failure.
                    if (isAuthDispatchError(err) && typeof onLlmAuthFailure === 'function') {
                        await onLlmAuthFailure({ member: getMemberForRole('planner'), label: 'Streak Assignment dispatch', error: err.message });
                    }
                    log(`Streak Assignment: agent dispatch failed, falling back to one-bead-per-streak: ${err.message}`);
                } else {
                    throw err;
                }
            }
            ({ streaks, usedFallback, reason } = selectStreaks(streakCandidate, currentReady));
            // Semantic-repair re-ask, one bounded attempt: agent()'s own
            // schema-repair only fixes JSON-shape problems, so a candidate can
            // be schema-valid yet semantically invalid (e.g. bead ids returned
            // with their prefix stripped). Dropping the whole grouping to the
            // one-bead-per-streak fallback silently discards sequencing intent,
            // which on a multi-doer fleet would PARALLELIZE beads the model said
            // must run sequentially. Re-ask once with the exact validation
            // failure; only then fall back.
            if (usedFallback && streakCandidate) {
                log(`Streak Assignment: candidate rejected (${reason}) -- re-asking once with the validation failure before falling back.`);
                try {
                    streakCandidate = await agent(
                        buildStreakAssignmentPrompt({ readyBeadIds: currentReady.map((b) => b.id) })
                        + `\n\nYour previous answer was REJECTED: ${reason}. `
                        + 'Return the bead ids exactly as listed -- verbatim, full prefix included.',
                        {
                            member_name: getMemberForRole('planner'),
                            label: 'Streak Assignment (semantic repair)',
                            schema: streakAssignment,
                            model: FIXED_ROLE_TIER.streakAssignment,
                        }
                    );
                    // No duplicate log() dump -- see dispatchReview().
                    ({ streaks, usedFallback, reason } = selectStreaks(streakCandidate, currentReady));
                } catch (repairErr) {
                    if (repairErr instanceof AgentOutputError || repairErr instanceof AgentDispatchError || repairErr instanceof FleetTransportError) {
                        log(`Streak Assignment (semantic repair): dispatch failed (${repairErr.message}) -- falling back.`);
                    } else {
                        throw repairErr;
                    }
                }
            }
            if (usedFallback) {
                log(`Streak Assignment: using one-bead-per-streak fallback (${reason}).`);
            }
            } // end LLM-fallback branch (no lane metadata)
            // Title lookup for the assignedBeadIds sort below. Doer dispatches
            // run in `parallel`, so the order their outcomes are recorded in is
            // completion order -- correctly non-deterministic. The Review
            // phase's `bd show` evidence command and reviewer prompt must not
            // inherit that race as prompt drift; see the sort-by-title comment
            // above for why `title` is the only stable key.
            const readyTitleById = new Map(currentReady.map((b) => [b.id, b.title]));

            // beadId -> declared model tier, read out of the SAME `bd list
            // --ready --json` response already fetched to build `currentReady`:
            // that response carries each bead's full record including metadata,
            // so no extra `bd show` round-trip is needed to recover the `model`
            // key the planner records via `--metadata`. See resolveDoerModel()
            // for how a possibly-multi-bead streak's model is picked from this
            // map. normalizeTierToken() guards this single read site -- see its
            // doc comment.
            const modelByBeadId = new Map(currentReady.map((b) => [b.id, normalizeTierToken(b.metadata && b.metadata.model)]));

            // --- Doer barrier: serialized turns, isolated failures ---
            // Streak turns are strictly serialized through `globalDoerTurn`: a
            // promise chain each turn awaits before doing any work and releases
            // in a `finally`, so at most one doer dispatch is ever in flight and
            // a thrown streak can never deadlock the next one. Serialization is
            // required because concurrent writers break the
            // fast-forward-by-construction invariant the git/beads sync brackets
            // depend on. parallel() with continueOnError is retained only for
            // per-worklist failure isolation and outcome accounting.
            let globalDoerTurn = Promise.resolve();
            const streakOutcomes = [];

            // --- Per-doer ORDERED WORKLISTS -----------------------------------
            // When this round has more ready streaks than doers, pack them into
            // per-doer ordered worklists (dependency order -> priority -> the
            // existing tie-break, plus tier grouping and an effort budget -- see
            // assignDoerWorklists) instead of feeding one streak per doer. Each
            // doer then works its worklist back to back: mode 'resume' (the
            // default) re-dispatches per streak, resuming the SAME doer session
            // by explicit session id so warm context carries across streaks
            // while every engine checkpoint (sync bracket, per-streak failure
            // attribution) is kept BETWEEN streaks; mode 'batch' sends one
            // dispatch carrying the whole ordered worklist. When streaks <=
            // doers, assignDoerWorklists is a pass-through.
            const worklistMode = validated.doerWorklistMode || 'resume';
            const { tierHomogeneous } = resolveWorklistTierPolicy({
                mode: worklistMode,
                resumeModelSwitch: validated.resumeModelSwitch === true,
            });
            const worklistPacking = assignDoerWorklists(streaks, doerPool.length, {
                effortBudget: validated.worklistEffortBudget,
                tierHomogeneous,
            });
            if (worklistPacking.packed) {
                const fmtStreak = (s) => `(${s.map((b) => b.id).join(', ')})`;
                const fmtWorklist = (wl) => `[${wl.map(fmtStreak).join(' -> ')}]`;
                log(
                    `Doer worklists: ${streaks.length} ready streak(s) > ${doerPool.length} doer(s) -- ` +
                    `packed into per-doer ordered worklists (mode: ${worklistMode}, ` +
                    `${tierHomogeneous ? 'tier-homogeneous' : 'mixed tiers allowed (resume_model_switch)'}): ` +
                    worklistPacking.worklists.map((wl, i) => `doer '${doerPool[i % doerPool.length]}': ${fmtWorklist(wl)}`).join('; ') +
                    (worklistPacking.overflow.length > 0
                        ? `; overflow queued to the next round (effort budget/tier grouping): ${worklistPacking.overflow.map(fmtStreak).join(' ')}`
                        : '')
                );
            }

            // One streak's full dispatch turn (claim -> dispatch -> verify ->
            // attribute), run once per streak of a worklist. Each call captures
            // and replaces the global gate synchronously, before its first
            // `await`, so the FIRST turn of each worklist enqueues in
            // deterministic worklist order; subsequent turns of a worklist
            // enqueue as their predecessors complete.
            // `worklistCtx` carries the doer's session id + last reported usage
            // across the streaks of ONE worklist (never across worklists/doers);
            // `batchStreaks` (mode 'batch') is the ordered list of sub-streaks a
            // single merged dispatch carries, for per-streak outcome
            // attribution.
            const runStreakTurn = async ({ streak, doerMember, worklistCtx, worklistPosition = 0, worklistLength = 1, packed = false, batchStreaks = null }) => {
                const priorTurn = globalDoerTurn;
                let releaseTurn;
                globalDoerTurn = new Promise((resolve) => { releaseTurn = resolve; });
                await priorTurn;
                try {
                let actualBeadIds = streak.map((b) => b.id);  // May be reduced by claiming if assignee is set
                let hasClaimedBeads = false;  // Track whether we've done claiming yet

                // Explicit base turn budget (rather than the fleet's own
                // default) so the max-turns-exhaustion resume path below has a
                // known baseline to escalate from. Sized so a typical streak
                // finishes in one dispatch and resume stays the exception.
                const BASE_DOER_MAX_TURNS = 500;
                // Bounded resume-and-continue attempts after a max_turns
                // exhaustion, each doubling the turn budget. An identical retry
                // is pointless (the doer would deterministically run out of
                // turns again on the same prompt), but a SESSION RESUME
                // continues the same context with a larger budget, which is what
                // lets a longer-than-expected streak finish. Bounded so a
                // genuinely too-large streak still fails after a few escalations
                // rather than burning unbounded budget.
                const MAX_TURN_RESUME_ATTEMPTS = 2;

                // The doer is a code-writing role (pushCode: true) -- G-pull
                // before, G-push after every attempt (including the
                // resume-and-continue retry below) so the shared branch always
                // reflects this member's committed work before the next dispatch
                // reads it. It also writes BEADS: it closes its assigned beads,
                // which must be D-pushed (pushBeads: true) so the orchestrator's
                // verification D-pull + `bd show` below sees the closes instead
                // of falsely reporting the streak FAILED. Per-bead claiming
                // happens INSIDE the brackets, right after the D-pull brings in
                // which beads other sprints already claimed, so claims are made
                // against current remote state.
                // `syncOpts` lets a RETRY re-dispatch ask for resumeOntoRemoteTip
                // so the pre-dispatch sync resets the local branch onto the
                // streak branch's remote tip before the doer commits again. The
                // FIRST attempt passes nothing and keeps plain ff-only
                // pre-dispatch sync.
                const dispatchDoer = (syncOpts = {}) => withGitSync(doerMember, true, async () => {
                    // Claim once per streak turn, after the D-pull.
                    if (!hasClaimedBeads) {
                        hasClaimedBeads = true;
                        if (validated.assignee) {
                            const claimedBeadIds = [];
                            const skippedBeadIds = [];
                            for (const beadId of actualBeadIds) {
                                try {
                                    const claimLabel = `bd update ${beadId} --claim`;
                                    await command(claimLabel, { member_name: orchestratorMember, silent: true });
                                    claimedBeadIds.push(beadId);
                                } catch (claimErr) {
                                    // A claim can fail if the bead is already claimed by another
                                    // sprint/assignee. Skip this bead instead of crashing.
                                    skippedBeadIds.push(beadId);
                                    log(`Doer streak: bead ${beadId} already claimed (skipping): ${claimErr.message}`);
                                }
                            }
                            if (claimedBeadIds.length === 0) {
                                // All beads in this streak are already claimed by other sprints.
                                // Skip this streak entirely.
                                log(`Doer streak: all beads [${actualBeadIds.join(', ')}] are already claimed by other sprints -- skipping this streak.`);
                                throw new WorkflowError(
                                    `All beads already claimed by other sprints`,
                                    { beadIds: actualBeadIds, reason: 'all-beads-already-claimed' }
                                );
                            }
                            if (skippedBeadIds.length > 0) {
                                log(`Doer streak: claimed ${claimedBeadIds.length} bead(s) [${claimedBeadIds.join(', ')}]; skipped ${skippedBeadIds.length} already-claimed bead(s) [${skippedBeadIds.join(', ')}].`);
                                actualBeadIds = claimedBeadIds; // Update to only the successfully claimed ones
                            }
                        }
                    }

                    const feedbackForStreak = actualBeadIds
                        .map((id) => perBeadFeedback.get(id))
                        .filter(Boolean)
                        .join('\n\n');

                    // Resolve the model to price this dispatch against. Beads are
                    // normally streaked one-per-model, but when a streak DOES
                    // span beads with different declared models this
                    // deterministically picks the first (by bead-id order, not
                    // dispatch completion order) and logs the discrepancy rather
                    // than guessing a blended price. A bead with no `model`
                    // metadata resolves to `undefined`, which FleetWorkflow
                    // treats the same as never passing `model` -- the dispatch
                    // still runs, it is simply not priced (calculateCost()
                    // returns null; see pricing.mjs).
                    // CAVEAT: this is the model the PLANNER ASKED the doer to run
                    // on. The fleet does not echo back the model it actually
                    // resolved/ran with, so this -- and therefore budget._spent /
                    // BudgetExceededError -- is an ESTIMATE, not a verified
                    // actual.
                    const streakModels = [...new Set(actualBeadIds.map((id) => modelByBeadId.get(id)).filter(Boolean))];
                    let doerModel = streakModels[0];
                    // In a PACKED worklist round a streak must never dispatch
                    // below its REQUIRED tier (the max of its beads' declared
                    // models) -- override the first-bead pick with that tier. The
                    // non-packed (streaks <= doers) path keeps the first-bead
                    // behavior.
                    if (packed) {
                        const requiredTier = streakRequiredTier(streak);
                        if (requiredTier) doerModel = requiredTier;
                    }
                    if (streakModels.length > 1) {
                        log(`Doer streak [${actualBeadIds.join(', ')}] spans beads with different declared models (${streakModels.join(', ')}) -- pricing this dispatch as '${doerModel}'.`);
                    }

                    // Mode (ii) RESUMED SEQUENCE: resume the doer's OWN
                    // prior-streak session by EXPLICIT session id when one was
                    // captured for this worklist and hasContextHeadroomForResume()
                    // passes. On refusal, or when no session id exists (first
                    // streak of the worklist, provider without resume support,
                    // prior streak failed), fall back to a FRESH session carrying
                    // the FULL prompt -- never a delta prompt into a fresh
                    // session.
                    let worklistResumeArg = false;
                    if (worklistCtx && worklistCtx.sessionId) {
                        if (hasContextHeadroomForResume(worklistCtx.usage)) {
                            worklistResumeArg = worklistCtx.sessionId;
                        } else {
                            log(
                                `Doer worklist on '${doerMember}': context headroom insufficient to resume session ` +
                                `'${worklistCtx.sessionId}' for streak ${worklistPosition + 1}/${worklistLength} ` +
                                `[${actualBeadIds.join(', ')}] -- starting a FRESH session with the full prompt instead.`
                            );
                            worklistCtx.sessionId = null;
                            worklistCtx.usage = null;
                        }
                    }
                    if (worklistResumeArg) {
                        log(
                            `Doer worklist on '${doerMember}': dispatching streak ${worklistPosition + 1}/${worklistLength} ` +
                            `[${actualBeadIds.join(', ')}] as a RESUME of session '${worklistResumeArg}'` +
                            `${doerModel ? ` (model=${doerModel})` : ''} -- warm context carries over.`
                        );
                    }

                    // The doer cannot read the KB itself (the member's composed
                    // permission config disables the fleet MCP server), so the
                    // entries primed for THIS member travel in its prompt.
                    // Relevance-ranked read for THESE beads, falling back to the
                    // sprint-start primed set when the query returns nothing.
                    // The query terms are the bead ids and titles the engine
                    // already holds; expand_related on that call is what
                    // traverses the refines/contradiction_of edges.
                    const doerRepoPath = kbPriming.folderOf(doerMember);
                    const doerKnowledge = await kbWork.relevantKnowledge(doerRepoPath, kbQueryTerms(streak, actualBeadIds));
                    const basePrompt = buildDoerPrompt({
                        beadIds: actualBeadIds,
                        branch: validated.branch,
                        feedback: feedbackForStreak || null,
                        kbKnowledge: doerKnowledge.length > 0 ? doerKnowledge : kbPriming.knowledgeOf(doerMember),
                    });
                    let doerPrompt = basePrompt;
                    if (batchStreaks) {
                        // Mode (i) BATCH: one dispatch carries the whole ordered
                        // worklist. The prompt names each streak boundary and
                        // mandates strict in-order completion.
                        doerPrompt =
                            'ORDERED MULTI-STREAK WORKLIST (single batched dispatch): your assigned beads below form ' +
                            `${batchStreaks.length} streak(s). Work them strictly in this order, fully completing each ` +
                            'streak (implement, verify, `bd close` its beads) before starting the next: ' +
                            batchStreaks.map((s, i) => `streak ${i + 1}: [${s.map((b) => b.id).join(', ')}]`).join('; ') +
                            '.\n\n' + basePrompt;
                    } else if (worklistResumeArg) {
                        // A resumed dispatch restates its FULL scope (the entire
                        // buildDoerPrompt output), never a bare "continue" delta
                        // -- the preamble only tells the session it may reuse its
                        // warm context.
                        doerPrompt =
                            'WORKLIST CONTINUATION: you are the same doer session that just completed the previous ' +
                            'streak of your worklist. Your warm context (repository layout, conventions, files already ' +
                            'read) carries over -- do not re-explore the repository from scratch. Your NEXT assigned ' +
                            'streak follows, with its scope restated in full.\n\n' + basePrompt;
                    }

                    return agent(
                        doerPrompt,
                        {
                            member_name: doerMember,
                            agentType: 'doer',
                            label: `Streak [${actualBeadIds.join(', ')}]`,
                            schema: doerReport,
                            model: doerModel,
                            resume: worklistResumeArg,
                            // Capture this dispatch's session id + usage so the
                            // NEXT streak in this worklist can resume the same
                            // session (warm-context carryover). A provider
                            // without resume support never reports a session id,
                            // so the callback simply never fires and every streak
                            // stays fresh (capability signal, not a
                            // provider-name check).
                            onSessionId: (id, meta) => {
                                if (!worklistCtx) return;
                                worklistCtx.sessionId = id;
                                worklistCtx.usage = meta && meta.usage ? meta.usage : null;
                            },
                            // Doer streaks run a full impl+test+commit cycle,
                            // categorically heavier than a one-shot prompt, so the
                            // generic execute_prompt timeout default is too short.
                            // For a silent-until-done CLI inactivity equals total
                            // runtime, so the inactivity timer must match the
                            // max_total_s ceiling.
                            timeout_s: DISPATCH_TIMEOUT_S,
                            max_total_s: DISPATCH_TIMEOUT_S,
                            max_turns: BASE_DOER_MAX_TURNS,
                        }
                    );
                }, { pushBeads: true, ...syncOpts });

                // The resume-and-continue retry is the SAME logical doer
                // streak continuing (same session, same code/bead-writing
                // responsibilities), so it gets the identical git+dolt sync
                // bracket treatment as the original dispatch above.
                const dispatchDoerResume = (maxTurns) => withGitSync(doerMember, true, () => agent(
                    // Restate the streak's scope: a resumed dispatch replaces the
                    // delivered prompt artifact, so a bare "continue" leaves the
                    // session with no record of what it was asked to do.
                    'Continue exactly where you left off from this same session -- do not restart, re-read from scratch, or re-plan. ' +
                    `Your scope, restated so a resumed dispatch never loses it: assigned bead id(s) ${actualBeadIds.join(', ')} on sprint branch ${validated.branch}. ` +
                    'Pick up from your last action on those bead(s) and proceed to the VERIFY checkpoint.',
                    {
                        member_name: doerMember,
                        agentType: 'doer',
                        label: `Streak [${actualBeadIds.join(', ')}] (resume, max_turns=${maxTurns})`,
                        schema: doerReport,
                        model: undefined,  // Model is resolved in main dispatch
                        timeout_s: DISPATCH_TIMEOUT_S,
                        max_total_s: DISPATCH_TIMEOUT_S,
                        resume: true,
                        max_turns: maxTurns,
                        // A successful max-turns ladder resume leaves the session
                        // valid for the worklist's NEXT streak -- re-record its
                        // id + latest usage so the next streak's headroom
                        // admission judges the CURRENT session size.
                        onSessionId: (id, meta) => {
                            if (!worklistCtx) return;
                            worklistCtx.sessionId = id;
                            worklistCtx.usage = meta && meta.usage ? meta.usage : null;
                        },
                    }
                ), { pushBeads: true });

                let report = null;
                let wasRetried = false;
                let dispatchError = null;
                try {
                    report = await dispatchDoer();
                } catch (err) {
                    // A dispatch-level failure means this worklist's captured
                    // session can no longer be trusted (the failed attempt may
                    // have run partial turns in it) -- clear it so every in-body
                    // retry below AND the worklist's next streak start from a
                    // FRESH session with the full prompt, mirroring
                    // createRoundSessionRegistry's clear-on-failure rule. (The
                    // max-turns ladder is unaffected: it resumes the member's
                    // last session via `resume: true`, not this id.)
                    if (worklistCtx) {
                        worklistCtx.sessionId = null;
                        worklistCtx.usage = null;
                    }
                    if (err instanceof AgentDispatchError && err.details?.reason === 'max_turns_exhausted') {
                        // Before resuming (or ultimately failing) a turn-exhausted
                        // streak, check whether every assigned bead id is ALREADY
                        // closed -- verifyDoerStreakClosed() does the mandatory
                        // D-pull-then-read (see its doc comment). A doer that closes
                        // its last bead and then keeps running past the VERIFY
                        // checkpoint until it hits max_turns has genuinely
                        // SUCCEEDED: resuming it wastes a dispatch on a session with
                        // nothing left to do, and classifying it 'failed' would
                        // falsely re-lane already-completed work.
                        // (apra-fleet-p2to.4.1) verifyDoerStreakClosed() D-pulls internally
                        // (DoltSync.syncBefore) -- treat the whole call as one sync bracket.
                        const preResumeUnclosed = await withOpenSyncBracket(() => verifyDoerStreakClosed({
                            command, orchestratorMember, beadIds: actualBeadIds, log,
                        }));
                        if (preResumeUnclosed.length === 0) {
                            log(`Doer streak [${actualBeadIds.join(', ')}] on member '${doerMember}' exhausted its turn limit (max_turns), but all assigned bead id(s) are already closed -- WARNING: the doer missed the VERIFY checkpoint (kept running after its last bd close instead of stopping). Treating this streak as a successful completion, not a failure; issuing NO resume dispatch.`);
                            dispatchError = null;
                        } else {
                            wasRetried = true;
                            let currentMaxTurns = BASE_DOER_MAX_TURNS * 2;
                            let resumeAttempt = 0;
                            dispatchError = err;
                            while (resumeAttempt < MAX_TURN_RESUME_ATTEMPTS) {
                                resumeAttempt += 1;
                                log(`Doer streak [${actualBeadIds.join(', ')}] on member '${doerMember}' exhausted its turn limit (max_turns) -- resuming the same session with max_turns=${currentMaxTurns} (attempt ${resumeAttempt}/${MAX_TURN_RESUME_ATTEMPTS}) instead of giving up or regrouping.`);
                                try {
                                    await memberSessionGuard.killIfAlive(doerMember);
                                    report = await dispatchDoerResume(currentMaxTurns);
                                    dispatchError = null;
                                    break;
                                } catch (resumeErr) {
                                    dispatchError = resumeErr;
                                    if (resumeErr instanceof AgentDispatchError && resumeErr.details?.reason === 'max_turns_exhausted') {
                                        currentMaxTurns *= 2;
                                        continue;
                                    }
                                    // A non-max_turns failure on resume (e.g. stale
                                    // session, transport error) isn't something
                                    // more turns can fix -- stop escalating.
                                    break;
                                }
                            }
                            if (dispatchError) {
                                log(`Doer streak [${actualBeadIds.join(', ')}] on member '${doerMember}' still failing after ${resumeAttempt} resume attempt(s) (last: ${dispatchError.message}) -- flagging as too-complex-for-one-streak.`);
                            }
                        }
                    } else if (isPostDispatchSyncFailure(err)) {
                        // The doer turn itself COMPLETED -- only its
                        // post-dispatch G-push/D-push failed, and withGitSync
                        // already retried that step on its own. Re-running the
                        // streak would redo an LLM turn whose commits/bead closes
                        // already exist locally. The per-bead attribution pass
                        // below still runs, so any bead this streak really did
                        // close is credited.
                        log(`Doer streak [${actualBeadIds.join(', ')}] on member '${doerMember}' COMPLETED but its post-dispatch sync failed: ${err.message} Not re-dispatching -- the work is already committed locally.`);
                        dispatchError = err;
                    } else if (isNonRetryableDispatchError(err)) {
                        // Auth/trust failures cannot be fixed by retrying the
                        // identical dispatch. An LLM-auth (not workspace-trust)
                        // failure gets one self-heal attempt plus one bounded
                        // retry first.
                        let healedAndRetried = false;
                        if (isAuthDispatchError(err) && typeof onLlmAuthFailure === 'function') {
                            const healed = await onLlmAuthFailure({ member: doerMember, label: `Doer streak [${actualBeadIds.join(', ')}]`, error: err.message });
                            if (healed) {
                                try {
                                    log(`Doer streak [${actualBeadIds.join(', ')}] on member '${doerMember}': LLM auth self-heal succeeded -- retrying once.`);
                                    report = await dispatchDoer();
                                    dispatchError = null;
                                    healedAndRetried = true;
                                } catch (retryErr) {
                                    dispatchError = retryErr;
                                    healedAndRetried = true;
                                }
                            }
                        }
                        if (!healedAndRetried) {
                            log(`Doer streak [${actualBeadIds.join(', ')}] on member '${doerMember}' threw a non-retryable error (auth/trust): ${err.message}. Not retrying.`);
                            dispatchError = err;
                        }
                    } else {
                        log(`Doer streak [${actualBeadIds.join(', ')}] on member '${doerMember}' threw: ${err.message}. Retrying once.`);
                        wasRetried = true;
                        try {
                            // This retry's prior attempt was NOT a provable
                            // no-mutation failure (a generic throw -- it may have
                            // committed and/or pushed its streak before failing).
                            // Resume onto the streak branch's remote tip so the
                            // retry builds on any already-published work instead
                            // of re-implementing the task as a divergent,
                            // content-identical duplicate commit that can never
                            // fast-forward.
                            report = await dispatchDoer({ resumeOntoRemoteTip: true });
                        } catch (err2) {
                            dispatchError = err2;
                        }
                    }
                }

                if (dispatchError) {
                    // Per-bead failure attribution: a dispatch-level throw
                    // (crash, transport error, exhausted resumes) does NOT mean
                    // none of this streak's beads closed -- a doer can close bead
                    // 1 of 2, then error out on bead 2. Verify via `bd show`
                    // (same D-pull-then-read as the happy path below) rather than
                    // assuming every bead in the streak is still open, so
                    // completed work is never discarded because a sibling in the
                    // same streak was never reached.
                    // (apra-fleet-p2to.4.1) verifyDoerStreakClosed() D-pulls internally
                    // (DoltSync.syncBefore) -- treat the whole call as one sync bracket.
                    const unclosedIds = await withOpenSyncBracket(() => verifyDoerStreakClosed({
                        command, orchestratorMember, beadIds: actualBeadIds, log,
                    }));
                    const closedIds = actualBeadIds.filter((id) => !unclosedIds.includes(id));
                    log(`Doer streak attribution [${actualBeadIds.join(', ')}]: closed=[${closedIds.join(', ')}] failed=[${unclosedIds.join(', ')}] (dispatch error: ${dispatchError.message}).`);
                    if (batchStreaks) {
                        // Mode (i): PER-STREAK attribution for a failed batch
                        // dispatch -- a sub-streak whose beads all verifiably
                        // closed before the failure keeps its work (outcome
                        // 'success', its closes stand and go to review); only
                        // sub-streaks with still-open beads are 'failed' and
                        // re-lane next round.
                        for (const sub of batchStreaks) {
                            const subIds = sub.map((b) => b.id).filter((id) => actualBeadIds.includes(id));
                            if (subIds.length === 0) continue;
                            const subUnclosed = subIds.filter((id) => unclosedIds.includes(id));
                            const subClosed = subIds.filter((id) => !subUnclosed.includes(id));
                            streakOutcomes.push({
                                beadIds: subIds, doerMember, wasRetried, report: null,
                                unclosedIds: subUnclosed, closedIds: subClosed,
                                outcome: subUnclosed.length > 0 ? 'failed' : 'success',
                                ...(subUnclosed.length > 0 ? { error: dispatchError.message } : {}),
                            });
                        }
                    } else {
                        streakOutcomes.push({
                            beadIds: actualBeadIds, doerMember, outcome: 'failed', wasRetried,
                            report: null, unclosedIds, closedIds, error: dispatchError.message,
                        });
                    }
                    // Rethrow so parallel()'s continueOnError:true isolates
                    // this failure from sibling streaks (the outcome above
                    // is already recorded via closure, so no information is
                    // lost when parallel() substitutes `null` for this branch).
                    throw dispatchError;
                }

                // No duplicate log() dump of `report` here -- see dispatchReview()
                // for why. The doer streak's own AGENT row already carries this
                // verbatim as its `output`, and its label names the bead ids.

                // CRITICAL: never trust the doer's own success claim -- verify
                // via `bd show` that the assigned bead ids are actually closed. A
                // doer that returns a success-looking report but leaves a bead
                // open is treated as a FAILED streak regardless of what it said.
                //
                // verifyDoerStreakClosed() D-pulls the orchestrator's OWN beads
                // clone BEFORE this read. The doer closed its beads in ITS clone
                // and D-pushed them; on a multi-member (remote) sprint the
                // orchestrator's clone is a DIFFERENT clone, so without that
                // D-pull this read sees stale (still-open) status and EVERY
                // remote doer streak is falsely marked FAILED -- the single most
                // divergence-sensitive read in the file.
                // (apra-fleet-p2to.4.1) verifyDoerStreakClosed() D-pulls internally
                // (DoltSync.syncBefore) -- treat the whole call as one sync bracket.
                const unclosedIds = await withOpenSyncBracket(() => verifyDoerStreakClosed({
                    command, orchestratorMember, beadIds: actualBeadIds, log,
                }));
                const closedIds = actualBeadIds.filter((id) => !unclosedIds.includes(id));

                // KB trust pipeline Phase 2: the doer decides what to capture,
                // the engine executes it against the repo THAT doer worked in.
                // Captures are honoured regardless of the streak outcome -- a
                // gotcha found on the way to a failed streak is still true.
                await kbWork.apply(ROLE_DOER, kbPriming.folderOf(doerMember), report);

                // apra-fleet-eft.76.4: per-bead failure attribution -- always
                // emitted (not only when something failed) so every streak's
                // report leaves an audit trail of exactly which beads closed
                // vs which stayed open. Closed beads stay closed regardless
                // of a sibling bead in the same streak being refused; only
                // the still-open ones are eligible for re-laning next round
                // (the next dev round's `currentReady` query naturally omits
                // whatever already closed here).
                log(`Doer streak attribution [${actualBeadIds.join(', ')}]: closed=[${closedIds.join(', ')}] failed=[${unclosedIds.join(', ')}].`);

                if (unclosedIds.length > 0) {
                    log(`Doer streak [${actualBeadIds.join(', ')}] reported status '${report ? report.status : 'unknown'}' but bead(s) still open: ${unclosedIds.join(', ')} -- treating streak as FAILED.`);
                }

                if (batchStreaks) {
                    // Mode (i): PER-STREAK outcome attribution for the batch
                    // dispatch -- one outcome per sub-streak, so review scope and
                    // re-laning stay per-streak exactly as in mode (ii).
                    for (const sub of batchStreaks) {
                        const subIds = sub.map((b) => b.id).filter((id) => actualBeadIds.includes(id));
                        if (subIds.length === 0) continue;
                        const subUnclosed = subIds.filter((id) => unclosedIds.includes(id));
                        const subClosed = subIds.filter((id) => !subUnclosed.includes(id));
                        streakOutcomes.push({
                            beadIds: subIds, doerMember, wasRetried, report,
                            unclosedIds: subUnclosed, closedIds: subClosed,
                            outcome: subUnclosed.length > 0 ? 'failed' : (wasRetried ? 'retried' : 'success'),
                        });
                    }
                } else {
                    streakOutcomes.push({
                        beadIds: actualBeadIds, doerMember, wasRetried, report, unclosedIds, closedIds,
                        outcome: unclosedIds.length > 0 ? 'failed' : (wasRetried ? 'retried' : 'success'),
                    });
                }
                await updateDashboard();
                } finally {
                    releaseTurn();
                }
            };

            await parallel(worklistPacking.worklists, async (worklist, index) => {
                if (!worklist || worklist.length === 0) return;  // a packed round can leave a doer idle
                const doerMember = doerPool[index % doerPool.length];
                // Per-worklist session context: the doer's captured session id +
                // last reported usage, carried across the streaks of THIS
                // worklist only -- never across doers or rounds.
                const worklistCtx = { sessionId: null, usage: null };

                if (worklistMode === 'batch' && worklist.length > 1) {
                    // Mode (i) BATCH: one dispatch carries the whole ordered
                    // worklist (assignDoerWorklists guarantees it is
                    // tier-homogeneous). Per-streak outcomes are attributed
                    // after the fact via `batchStreaks`.
                    await runStreakTurn({
                        streak: worklist.flat(),
                        doerMember,
                        worklistCtx,
                        packed: worklistPacking.packed,
                        batchStreaks: worklist,
                    });
                    return;
                }

                // Mode (ii) RESUMED SEQUENCE (default): one dispatch per streak,
                // in worklist order, each going through the SAME global FIFO
                // gate (runStreakTurn acquires it per streak) and the same
                // git/dolt sync brackets -- so every engine checkpoint is kept
                // BETWEEN streaks. A failure in streak N is recorded and
                // isolated: streaks 1..N-1's closes already stand (per-bead
                // attribution), and N+1.. still dispatch (fresh session -- the
                // catch clears the worklist session so a broken session is
                // never resumed).
                let firstError = null;
                for (let wIdx = 0; wIdx < worklist.length; wIdx++) {
                    try {
                        await runStreakTurn({
                            streak: worklist[wIdx],
                            doerMember,
                            worklistCtx,
                            worklistPosition: wIdx,
                            worklistLength: worklist.length,
                            packed: worklistPacking.packed,
                        });
                    } catch (err) {
                        firstError = firstError || err;
                        worklistCtx.sessionId = null;
                        worklistCtx.usage = null;
                    }
                }
                // Rethrow (after ALL streaks ran) so parallel()'s
                // continueOnError:true accounting records this worklist's
                // failure.
                if (firstError) throw firstError;
            }, { continueOnError: true });

            log(`Develop C${cycle} R${devRounds} streak outcomes: ${JSON.stringify(streakOutcomes.map((o) => ({ beadIds: o.beadIds, outcome: o.outcome })))}`);

            // --- Review: self-contained, schema-validated, orchestrator-applied ---
            phase(`Review C${cycle} R${devRounds}`);
            // Sort by (title, id) -- not raw outcome-recording order -- so this
            // evidence-gathering step is deterministic. See the readyTitleById
            // comment just above.
            // Failed streaks' beadIds are excluded from this round's review
            // scope.
            const assignedBeadIds = streakOutcomes.filter((o) => o.outcome !== 'failed').flatMap((o) => o.beadIds)
                .slice().sort((a, b) => {
                    const ta = readyTitleById.get(a) || a;
                    const tb = readyTitleById.get(b) || b;
                    return ta.localeCompare(tb) || a.localeCompare(b);
                });
            const acceptanceCriteriaJson = assignedBeadIds.length > 0
                ? await command(`bd show ${assignedBeadIds.join(' ')} --json`, { member_name: orchestratorMember, silent: true })
                : '[]';

            // Empty-guard: when EVERY streak this round failed, assignedBeadIds
            // is [] and there is nothing for the Reviewer to look at. Skip the
            // dispatch entirely rather than sending an empty-scope review: an
            // empty review is prone to returning CHANGES_NEEDED with empty
            // reopenIds+newTasks, which trips the contract-violation check below
            // and, after the retry-once path, throws
            // ReviewerContractViolationError -- a hard sprint abort over a round
            // where no work happened at all. The `stillOpen` check just below
            // still runs, so the loop correctly continues instead of prematurely
            // treating the cycle as organically complete.
            if (assignedBeadIds.length === 0) {
                log(`Develop C${cycle} R${devRounds}: all streaks this round failed with no beadIds assigned -- skipping Review dispatch (nothing to review). Failed-streak beads remain ready for the next Develop round.`);
            } else {
            // dispatchReview() applies the shared contract-violation
            // retry-once-then-throw rule (see its own doc comment and
            // ReviewerContractViolationError) -- a CHANGES_NEEDED verdict with
            // both reopenIds and newTasks empty is self-contradictory and must
            // never be treated as an ordinary "more work needed" round.
            const verdict = await dispatchReview({ beadIds: assignedBeadIds, acceptanceCriteriaJson });
            // KB trust pipeline Phase 2: the reviewer decides, the engine executes.
            // Reviewer is the ONLY role whose kb_promotions are honoured.
            await kbWork.apply(ROLE_REVIEWER, kbPriming.folderOf(getMembersForRole(ROLE_REVIEWER)[0]), verdict);
            // A5: the last reviewer verdict seen THIS cycle feeds the Cycle
            // Evaluation section's completion check below -- goal-priority
            // completion requires this to be exactly 'APPROVED', not just
            // an empty ready-bead list.
            lastReviewVerdict = verdict.verdict;
            // A review genuinely ran THIS cycle -- the Cycle Evaluation section
            // below only trusts `lastReviewVerdict` when this is true (see the
            // `reviewedThisCycle` reset at the top of the cycle loop and the
            // re-review dispatch it guards).
            reviewedThisCycle = true;

            // Orchestrator (this code) -- NOT the LLM -- applies every
            // structured transition: reopenIds via `bd update --status=open`,
            // newTasks via `bd create`. The reviewer's dispatch prompt above
            // explicitly forbade it from mutating beads itself; this is the
            // enforcement side of that contract (SKILL.md).
            // Deterministic goal-scope guard on reopenIds: the prompt-side
            // instruction (buildReviewerPrompt) asks the reviewer not to reopen
            // below-goal beads, but the orchestrator enforces it -- reopening a
            // DEFERRED P3 feature in a P1/P2 sprint injects out-of-scope work and
            // pins the verdict at CHANGES_NEEDED forever.
            let reopenAllowlist = null;
            if (verdict.reopenIds.length > 0) {
                try {
                    const inScopeNow = await bdListScoped('');
                    reopenAllowlist = new Map(inScopeNow.map((b) => [b.id, b]));
                } catch {
                    reopenAllowlist = null; // lookup failed -- apply reopens unguarded rather than dropping them
                }
            }
            // Ids actually reopened this round (survived the goal-scope
            // allowlist above) -- gates which `replanIds` entries below are
            // trusted, so a reviewer naming a replanIds id that was never really
            // reopened (out of scope, or simply absent from reopenIds) can never
            // short-circuit the loop.
            const reopenedIds = new Set();
            for (const id of verdict.reopenIds) {
                const bead = reopenAllowlist ? reopenAllowlist.get(id) : null;
                if (reopenAllowlist && bead && typeof bead.priority === 'number' && bead.priority > goalMax) {
                    log(`Reviewer reopenIds: SKIPPED '${id}' (priority P${bead.priority} is below this sprint's goal ${validated.goal} -- deferred scope, not reopened).`);
                    continue;
                }
                await command(
                    `bd update ${id} --status=open`,
                    { member_name: orchestratorMember, silent: true, label: `Reopen ${id} per reviewer verdict` }
                );
                // Track per-bead reopen counts for reopen-thrash detection.
                recordReopen(id);
                // Per-bead feedback routing: only beads named in reopenIds carry
                // this round's feedback into the next round's doer prompt --
                // never a blanket broadcast.
                perBeadFeedback.set(id, verdict.notes);
                reopenedIds.add(id);
            }
            // Fold this round's reviewer `replanIds` (absent/undefined on
            // verdicts that do not use it, so a no-op then) into the cycle's
            // running union, consulted at the top of the next iteration's
            // currentReady computation above. Only ids that were ACTUALLY
            // reopened this round are tracked -- an id the reviewer named in
            // replanIds without ALSO naming it in reopenIds (contrary to the
            // buildReviewerPrompt instruction above) is dropped rather than
            // silently ignored: logged here so the drop is visible in the run
            // log instead of vanishing with no trace.
            // This is the replan loop guard's single enforcement point. A bead
            // that has ALREADY been through one in-cycle scoped replan this cycle
            // (replannedThisCycle) is refused a SECOND: it stays reopened (real
            // dev feedback still applies) but is NOT re-added to replanIds, so
            // the develop loop above never dispatches a second scoped planner
            // pass for it -- it is handed to the next cycle's planner instead.
            // This is what makes "max one scoped replan per bead per cycle" hold
            // regardless of the round budget.
            for (const id of (verdict.replanIds || [])) {
                if (!reopenedIds.has(id)) {
                    log(
                        `[fleet-sprint] replanIds: DROPPED '${id}' -- not also named in this round's reopenIds ` +
                        `(reviewer prompt requires replanIds to be a subset of reopenIds), so it never reaches the ` +
                        `scoped-replan machinery.`
                    );
                    continue;
                }
                if (replannedThisCycle.has(id)) {
                    log(
                        `[fleet-sprint] replan loop guard: bead ${id} was already scoped-replanned once this cycle ` +
                        `(C${cycle}) and a reviewer has flagged it for replan AGAIN -- refusing a second in-cycle scoped ` +
                        `replan (max one per bead per cycle). It stays reopened and is handed off to the next cycle's ` +
                        `planner rather than re-planned again now.`
                    );
                    continue;
                }
                replanIds.add(id);
            }
            for (const newTask of verdict.newTasks) {
                // Validate BEFORE interpolation -- see validateNewTask() above
                // for why this is an allowlist, not escaping. A rejection is
                // logged, recorded for the final-review evidence summary, and
                // skipped; it must never abort the sprint over one bad newTask.
                const validation = validateNewTask(newTask);
                if (!validation.ok) {
                    log(`Reviewer newTasks: REJECTED (not sent to bd create) -- ${validation.reason}`);
                    rejectedNewTasks.push({ cycle, reason: validation.reason, raw: newTask });
                    // Track it for resurfacing into the NEXT planning-phase
                    // dispatch too -- see trackRejectedNewTaskForResurfacing()'s
                    // doc comment.
                    pendingRejectedNewTasks = trackRejectedNewTaskForResurfacing(pendingRejectedNewTasks, {
                        title: newTask && newTask.title, description: newTask && newTask.description,
                        reason: validation.reason, cycle,
                    });
                    // A rejected finding must never simply vanish -- persist it
                    // verbatim to the parent bead's notes as a fallback (itself
                    // non-fatal: a notes write failure degrades to the run log,
                    // never an abort).
                    try {
                        await appendRejectedFindingToParentNotes({
                            command, member: orchestratorMember, parentId: targetIssues[0],
                            newTask, reason: validation.reason, cycle, log,
                        });
                    } catch (noteErr) {
                        log(`[fleet-sprint] rejected-finding notes fallback FAILED (non-fatal): ${noteErr.message}; finding preserved VERBATIM in this run log: ${JSON.stringify(newTask)}`);
                    }
                    continue;
                }
                const { title, description, priority } = validation;
                // A bead can only have one parent -- see the matching
                // comment on the re-review newTasks site below.
                //
                // Mint the child id through the supervisor-owned allocator so two
                // concurrent sprints creating follow-up work under the SAME
                // parent never derive the same child id. Under the null client
                // (lone sprint) childId is null and bd derives the id as before.
                const persisted = await persistNewTaskBestEffort({
                    command, member: orchestratorMember, parentId: targetIssues[0],
                    newTask, cycle, log, stage: 'develop-review',
                    createFn: async () => {
                        const floor = await computeChildFloor({ command, member: orchestratorMember, parentId: targetIssues[0] });
                        await createChildBeadWithAllocatedId({
                            command, allocator: childIdAllocator, member: orchestratorMember,
                            title, description, priority, parentId: targetIssues[0],
                            sprintId: sprintMutexId, floor, log,
                            label: `Create follow-up task from reviewer newTasks: ${title}`,
                        });
                    },
                });
                // This title just landed as a real bead -- if it was a
                // resubmission of an earlier rejected item, drop it from the
                // pending resurface list so it stops reappearing in future
                // planning prompts. Pass title+description (not just title) so a
                // resubmission that also corrected its title still clears via its
                // unchanged description.
                if (persisted) {
                    pendingRejectedNewTasks = clearResubmittedNewTask(pendingRejectedNewTasks, { title, description });
                }
            }

            // The orchestrator just MUTATED beads (reopens + newTask creates) in
            // its own clone -- D-push so members observe them on their next
            // dispatch's D-pull.
            // (apra-fleet-p2to.4.1) standalone sync bracket -- see openSyncBracketCount's doc comment above.
            await withOpenSyncBracket(() => DoltSync.syncAfter(orchestratorMember, { command, pushBeads: true, log, mutex: doltPushMutex, sprintId: sprintMutexId }));
            } // end assignedBeadIds.length > 0 (Review dispatch + orchestrator-applied transitions)

            await updateDashboard();

            // readyLeafBeads(), not raw bdListScoped('--ready --json'): a
            // childful --issue target that is still "ready" per bd's own
            // definition (e.g. before its children exist yet, or between
            // children closing and the next Route step routing it to verify)
            // must not read as "work still pending" here -- it is never a
            // dispatchable leaf, so it must not keep this loop from
            // organically completing (apra-fleet-66u.1/66u.2 rework).
            const stillOpen = await readyLeafBeads();
            lastStillOpenCount = stillOpen.length;  // Track for post-loop round-cap detection

            if (stillOpen.length === 0) {
                log('All beads processed this cycle -- cycle organically complete.');
                break;
            } else {
                log(`System found ${stillOpen.length} beads still open/ready. Looping back to develop.`);
            }
        }

        // Check if we exited due to round cap (devRounds === 3) with work still pending
        if (devRounds === 3 && lastStillOpenCount > 0) {
            log(`Develop/Review round cap (3) reached this cycle with ${lastStillOpenCount} bead(s) still open/reopened -- deferring to next cycle.`);
        }
        } // end Develop & Review loop (skipped when readyBeads.length === 0)

        // =======================
        // 4. Deploy & Integration
        // =======================
        //
        // Runbook probes: a single platform-agnostic probe helper, dispatched
        // via `command(..., { failSoft: true })`. A probe failure (transient
        // error, portability quirk on a given member, etc.) SKIPS the dependent
        // phase with a logged warning -- it must never throw and kill the
        // sprint.
        const hasDeploy = await probeFileExists('deploy.md');
        const hasPlaybook = await probeFileExists('integ-test-playbook.md');

        let deployedThisCycle = false;

        if (hasDeploy) {
            phase(`Deploy C${cycle}`);
            await ensureUnattendedAuto(getMemberForRole('deployer'));
            await ensureDeployPermissions(getMemberForRole('deployer'));
            let deployResult;
            // Turn budget for the deployer, with the same-session
            // turn-exhaustion resume below: a source-build fallback deploy runs
            // npm ci plus two builds, comfortably beyond a small default budget.
            const DEPLOYER_MAX_TURNS = 500;
            const deployerDispatchOpts = {
                member_name: getMemberForRole('deployer'),
                agentType: 'deployer',
                schema: deployerReport,
                model: FIXED_ROLE_TIER.deployer,
                // Runs real deploy commands per a runbook, plausibly
                // long-running.
                timeout_s: DISPATCH_TIMEOUT_S,
                max_total_s: DISPATCH_TIMEOUT_S,
                max_turns: DEPLOYER_MAX_TURNS,
            };
            try {
                // The deployer is a read-side role (pushCode: false) -- but a
                // deployer on a stale checkout is as damaging as a stale reviewer
                // diff, so it still gets the pre-dispatch G-pull.
                try {
                    deployResult = await withGitSync(getMemberForRole('deployer'), false, () => agent(
                        'Deploy to test env using deploy.md.',
                        { ...deployerDispatchOpts, member_name: getMemberForRole('deployer') }
                    ));
                } catch (err) {
                    if (err instanceof AgentDispatchError && err.details?.reason === 'max_turns_exhausted') {
                        log(`Deployer exhausted its turn limit (max_turns=${DEPLOYER_MAX_TURNS}) -- resuming the same session with max_turns=${DEPLOYER_MAX_TURNS * 2}.`);
                        await memberSessionGuard.killIfAlive(getMemberForRole('deployer'));
                        deployResult = await withGitSync(getMemberForRole('deployer'), false, () => agent(
                            'Continue the deploy exactly where you left off in this same session -- do not restart deploy.md from the top if steps already completed. Finish the remaining steps and the smoke test, and return your final report now.',
                            {
                                ...deployerDispatchOpts,
                                member_name: getMemberForRole('deployer'),
                                label: `Deploy (resume, max_turns=${DEPLOYER_MAX_TURNS * 2})`,
                                resume: true,
                                max_turns: DEPLOYER_MAX_TURNS * 2,
                            }
                        ));
                    } else {
                        throw err;
                    }
                }
            } catch (err) {
                if (err instanceof AgentOutputError) {
                    log(`Deployer: schema-repair exhausted, treating as deployed:false: ${err.message}`);
                    deployResult = { deployed: false, notes: `Deployer failed to return a schema-valid report after repair attempts: ${err.message}` };
                } else if (err instanceof AgentDispatchError || err instanceof FleetTransportError) {
                    // Self-heal now so the next cycle's Deployer dispatch on this
                    // same member isn't walking into the identical unhealed auth
                    // failure.
                    if (isAuthDispatchError(err) && typeof onLlmAuthFailure === 'function') {
                        await onLlmAuthFailure({ member: getMemberForRole('deployer'), label: 'Deployer dispatch', error: err.message });
                    }
                    log(`Deployer: agent dispatch failed, treating as deployed:false: ${err.message}`);
                    deployResult = { deployed: false, notes: `Deployer dispatch failed: ${err.message}` };
                } else {
                    throw err;
                }
            }
            // No duplicate log() dump -- see dispatchReview() for why.
            deployedThisCycle = deployResult.deployed === true;
            if (!deployedThisCycle) {
                deployFailures.push({ cycle, notes: deployResult.notes });
                log(`Deploy FAILED this cycle (C${cycle}): ${deployResult.notes}. Skipping Integration Test phase.`);
            }
        } else {
            log('Skipping Deploy Phase (no deploy.md found, or the probe itself failed -- see prior log line)');
        }

        // apra-fleet-66u.2: declared here, OUTSIDE the `if (hasPlaybook &&
        // deployedThisCycle)` block below, so Cycle Evaluation's
        // verifyDispatchAttempts/verifyDispatchClosures tracking can see it
        // regardless of whether Integ Test actually ran this cycle -- an
        // in-block `let` is unreachable once that block's scope ends, which
        // is exactly what threw a ReferenceError here before this hoist.
        // Defaults to empty so a cycle where Integ Test never dispatched (no
        // playbook, or Deploy failed) correctly counts as "no verify
        // dispatch attempt", not a crash.
        let verifySetForIntegTest = [];
        if (hasPlaybook && deployedThisCycle) {
            phase(`Integ Test C${cycle}`);
            await ensureUnattendedAuto(getMemberForRole('integ-test-runner'));
            await ensureDeployPermissions(getMemberForRole('integ-test-runner'));
            // apra-fleet-nwh.1: snapshot the running total BEFORE this
            // cycle's Integ Test dispatch(es) so the delta after (below) is
            // this phase's own spend, not the whole run's. budget.spent()
            // may be absent on an injected test double; that degrades to
            // "not tracked" exactly like buildCostAnalysis()'s own total
            // spend line already does, never a thrown error.
            const integSpendBefore = typeof budget?.spent === 'function' ? budget.spent() : null;
            integTestRunnerDispatchCount += 1;
            let integResult;
            // Set when the integ dispatch failed for an INFRASTRUCTURE reason
            // (empty_response / inactivity timeout / orphan-recovery timeout)
            // rather than producing a real pass/fail verdict -- recorded as
            // INCONCLUSIVE below instead of a false passed:false FAIL. Carries
            // {reason, message} for the note.
            let integInfraInconclusive = null;
            // apra-fleet-jfo: verifySetForIntegTest is now declared at the
            // outer per-cycle scope (apra-fleet-66u.2, just above this `if`
            // block) rather than here, so the bounce-cap logic after the
            // try/catch AND Cycle Evaluation's dispatch-outcome tracking can
            // both still see it even when the try block throws early or
            // never runs at all. Reset to empty at the top of every dispatch
            // attempt regardless -- an early-thrown dispatch simply skips the
            // bounce-cap block below (its `verifySetForIntegTest.length > 0`
            // guard short-circuits).
            verifySetForIntegTest = [];
            let verifySetIdSet = new Set();
            try {
                // integ-test-runner.md's contract requires "an explicit list of
                // feature ids ... already scoped for you by the orchestrator" as
                // a required input, and forbids the agent from deriving that list
                // itself via a bare, unscoped `bd list --type=feature`. Fetch the
                // scope's open features here and name them explicitly -- always
                // dispatch, even with zero open features this cycle: deploy
                // succeeded and a playbook exists, so this phase runs regardless,
                // per the fixed per-cycle phase sequence every other
                // cycle-evaluation check in this file assumes.
                const openFeatures = await bdListScoped('--type=feature --status=open --json');
                // apra-fleet-jfo: replaces the old bug-only pendingClosureBugs
                // derivation. Any issue_type qualifies (bug, feature, task-parent,
                // epic); classified against the FULL unfiltered project bead list
                // (fetchAllBeadsShared, not a scope-filtered subset) so an
                // out-of-scope open child still blocks eligibility. These beads
                // have no other closure owner: doers refuse non-task beads,
                // reviewers may not close, and the plain feature prompt below only
                // names features -- without this they would linger open at goal
                // priority forever. The integ runner has bead-closing authority
                // and pushBeads: true, so it owns verify-set closure.
                ({ verifyIds: verifySetForIntegTest } = classifyVerifySet(await fetchAllBeadsShared(), targetIssues));
                // apra-fleet-66u.2: a bead can become verify-eligible AFTER
                // this cycle's Route step already ran (e.g. its last child
                // closes during THIS cycle's own Develop/Review, before
                // Deploy/IntegTest) -- this classifyVerifySet call, not the
                // Route step's, is what first discovers it. Feed it into
                // verifyEverIds here too so the exit-gate's
                // stillOpenVerifyIds safety net (further down) never has a
                // same-cycle blind spot for a bead that was genuinely just
                // dispatched to verify but not yet closed.
                for (const id of verifySetForIntegTest) verifyEverIds.add(id);
                verifySetIdSet = new Set(verifySetForIntegTest);
                // Dedupe: a feature already in the verify set gets the stronger
                // verify clause below (real evidence, gap filed under itself), not
                // also the generic "run tests for this feature" line.
                const openFeaturesNotInVerifySet = openFeatures.filter((f) => !verifySetIdSet.has(f.id));
                const verifyClause = verifySetForIntegTest.length > 0
                    ? ` Additionally, these bead(s) have ALL their children closed and await ` +
                      `verification-closure: ${verifySetForIntegTest.join(', ')}. For each, verify against the ` +
                      `deployed build per the playbook. If your pass shows the underlying work holds (the ` +
                      `defect no longer reproduces, or the feature behaves as specified), close it (bd close) ` +
                      `with a note citing the commands run and the observed output. If it does NOT hold, leave ` +
                      `it open and file a bug describing the gap with evidence, parented under THAT bead ` +
                      `specifically (--parent <that bead's own id>, NOT ${targetIssues[0]}) -- filing it under ` +
                      `the right parent is required so the gap is correctly attributed and that parent is ` +
                      `re-routed to development next cycle instead of staying stuck in verify.`
                    : '';
                // The per-cycle Integ Test phase is FEATURE CLOSURE ONLY:
                // integ-test-playbook.md owns no sandbox, no smoke test, and no
                // real-bd suite -- those belong to regression-test-playbook.md,
                // dispatched once per sprint in Finalization below.
                const featurePrompt = (openFeaturesNotInVerifySet.length > 0
                    ? `Run tests using integ-test-playbook.md, for these open feature id(s) only: ` +
                      `${openFeaturesNotInVerifySet.map((f) => f.id).join(', ')}. Add bug beads if needed, filed under ` +
                      `--parent ${targetIssues[0]}.`
                    : `Run tests using integ-test-playbook.md. No open type=feature beads are in scope ` +
                      `this cycle -- report nothing to test. Add bug beads if needed, filed under ` +
                      `--parent ${targetIssues[0]}.`) + verifyClause;
                // integ-test-runner does NOT touch code (pushCode: false, no git
                // push) but it DOES mutate beads -- it closes passing features
                // and files bug beads -- so it must D-push those mutations
                // (pushBeads: true), a D-push with no git push. G-pull before,
                // no-op G-push after.
                // apra-fleet-63x.3: sizing the integ turn ceiling so it is NOT
                // the routinely-binding constraint.
                //
                // Intended design: on a run that is actually making progress the
                // WALL-CLOCK ceiling (max_total_s == INTEG_MAX_TOTAL_S, up to 2h
                // at the default) should be what bounds the dispatch, never the
                // turn count. A compliant runner spends ~1 turn per liveness poll
                // (integ-test-runner.md caps polling at ~1 per 2 min), but a real
                // per-feature pass also spends fast, sub-poll turns -- bd show /
                // bd dep list, reading test output, re-checking a backgrounded
                // suite -- so the true turn-spend rate over a multi-feature cycle
                // is several times the poll floor. At 200 (the pre-fix value)
                // those chatty-but-legitimate runs exhausted max_turns before the
                // time budget, the false exhaustion apra-fleet-63x tracks (4/4
                // historical runs). 300 gives the wall-clock ceiling the headroom
                // to bind first on any progressing run, so a max_turns exhaustion
                // now signals genuine runaway scope rather than a normal long
                // cycle. Paired with the tightened scope/turn-economy guidance in
                // integ-test-runner.md (one feature at a time, no redundant suite
                // re-runs, respect the poll cadence) a normal cycle needs far
                // fewer than 300 turns. The resume ladder below still doubles from
                // here (to 600) when a run legitimately needs more.
                const INTEG_TEST_MAX_TURNS = 500;
                const integDispatchOpts = {
                    member_name: getMemberForRole('integ-test-runner'),
                    agentType: 'integ-test-runner',
                    schema: integReport,
                    model: FIXED_ROLE_TIER['integ-test-runner'],
                    // Runs a full test suite, plausibly long-running.
                    //
                    // max_total_s is a HARD kill at elapsed time regardless of
                    // activity, and a timer kill surfaces as a plain
                    // AgentDispatchError -- the resume ladder below only matches
                    // max_turns_exhausted, so a killed-at-the-ceiling run becomes
                    // a FALSE passed:false with no resume. Give the ceiling real
                    // headroom while keeping the shorter INACTIVITY timer: a
                    // genuinely hung runner still dies on silence; an active long
                    // pass is never killed mid-progress.
                    timeout_s: DISPATCH_TIMEOUT_S,
                    max_total_s: INTEG_MAX_TOTAL_S,
                    max_turns: INTEG_TEST_MAX_TURNS,
                };
                const dispatchIntegOnce = () => withGitSync(getMemberForRole('integ-test-runner'), false, () => agent(
                    featurePrompt,
                    { ...integDispatchOpts, member_name: getMemberForRole('integ-test-runner') }
                ), { pushBeads: true });
                // A resumed dispatch DELIVERS A NEW PROMPT ARTIFACT to the member
                // (replacing the original one, e.g. .fleet-task.md), so a bare
                // "continue" resume erases the dispatch's scope from the artifact
                // a contract may treat as its scope source of truth. Every resume
                // prompt that carries per-dispatch scope must restate it.
                const dispatchIntegResume = () => withGitSync(getMemberForRole('integ-test-runner'), false, () => agent(
                    'Continue the integration test run exactly where you left off in this same session -- do not restart the playbook or rebuild the sandbox if it is already up. Finish the remaining suites, close passing features / file bugs per your contract, and return your final report now. ' +
                    'Your original scope, restated so a resumed dispatch never loses it: ' + featurePrompt,
                    {
                        ...integDispatchOpts,
                        member_name: getMemberForRole('integ-test-runner'),
                        label: `Integ Test (resume, max_turns=${INTEG_TEST_MAX_TURNS * 2})`,
                        resume: true,
                        max_turns: INTEG_TEST_MAX_TURNS * 2,
                    }
                ), { pushBeads: true });
                try {
                    integResult = await dispatchIntegOnce();
                } catch (err) {
                    if (err instanceof AgentDispatchError && err.details?.reason === 'max_turns_exhausted') {
                        log(`Integ Test Runner exhausted its turn limit (max_turns=${INTEG_TEST_MAX_TURNS}) -- resuming the same session with max_turns=${INTEG_TEST_MAX_TURNS * 2} instead of restarting the run.`);
                        await memberSessionGuard.killIfAlive(getMemberForRole('integ-test-runner'));
                        integResult = await dispatchIntegResume();
                    } else if (err instanceof AgentDispatchError && isInfraDispatchFailure(err)) {
                        // An INFRA dispatch failure (empty_response / inactivity
                        // timeout / orphan-recovery timeout) is NOT a test
                        // verdict: the runner's CLI died mid-turn or lost its
                        // result envelope without ever reporting pass or fail.
                        // Retry ONCE by resuming the same session -- the run may
                        // have made real progress and merely lost its envelope,
                        // and the resume ladder already restates the full scope.
                        // If the resume ALSO fails for an infra reason, let it
                        // propagate to the outer catch, which records the cycle as
                        // INCONCLUSIVE (never a false passed:false FAIL) so the
                        // infra fault stays distinguishable from a genuine test
                        // failure.
                        log(`Integ Test Runner: infrastructure dispatch failure (${err.details?.reason}) -- the member CLI produced no test verdict (no result envelope). This is NOT a test failure; resuming the same session once to recover before recording anything.`);
                        await memberSessionGuard.killIfAlive(getMemberForRole('integ-test-runner'));
                        integResult = await dispatchIntegResume();
                    } else {
                        throw err;
                    }
                }
            } catch (err) {
                if (err instanceof AgentOutputError) {
                    log(`Integ Test Runner: schema-repair exhausted, treating as passed:false: ${err.message}`);
                    integResult = { featuresClosed: 0, issuesCreated: 0, passed: false, bugsFiled: [], summary: `Integ test runner failed to return a schema-valid report after repair attempts: ${err.message}` };
                } else if (err instanceof AgentDispatchError && isInfraDispatchFailure(err)) {
                    // The dispatch failed for an INFRASTRUCTURE reason even after
                    // the single resume retry above -- the member CLI never
                    // delivered a test verdict. Record it as INCONCLUSIVE below,
                    // NOT as a genuine passed:false FAIL: an infra fault must
                    // never masquerade as a real test failure and block the
                    // sprint's confidence check. integResult is stubbed only so
                    // downstream references stay defined; the
                    // integInfraInconclusive branch below owns what gets recorded.
                    integInfraInconclusive = { reason: err.details?.reason ?? 'unknown', message: err.message };
                    log(`Integ Test Runner: infrastructure dispatch failure (${integInfraInconclusive.reason}) persisted after a resume retry -- recording INCONCLUSIVE, NOT a test FAIL: ${err.message}`);
                    integResult = { featuresClosed: 0, issuesCreated: 0, passed: false, bugsFiled: [], summary: `Integ test runner infra dispatch failure (${integInfraInconclusive.reason}): ${err.message}` };
                } else if (err instanceof AgentDispatchError || err instanceof FleetTransportError) {
                    // Self-heal now so the next cycle's Integ Test Runner dispatch
                    // on this same member isn't walking into the identical
                    // unhealed auth failure.
                    if (isAuthDispatchError(err) && typeof onLlmAuthFailure === 'function') {
                        await onLlmAuthFailure({ member: getMemberForRole('integ-test-runner'), label: 'Integ Test Runner dispatch', error: err.message });
                    }
                    log(`Integ Test Runner: agent dispatch failed, treating as passed:false: ${err.message}`);
                    integResult = { featuresClosed: 0, issuesCreated: 0, passed: false, bugsFiled: [], summary: `Integ test runner dispatch failed: ${err.message}` };
                } else {
                    throw err;
                }
            }
            // No duplicate log() dump -- see dispatchReview() for why.
            //
            // Feature closure is judged against the features' own `[test]` tasks
            // in the branch working tree, which is inherently current, so no
            // SHA-freshness gate is needed here.
            //
            // An infra dispatch failure (empty_response / inactivity timeout /
            // orphan-recovery timeout) produced no test verdict at all, and must
            // be recorded INCONCLUSIVE -- tagged and worded distinctly -- so the
            // final reviewer/harvester can tell an infra fault apart from real
            // test evidence, and it is never counted as a genuine pass or fail.
            // Checked BEFORE `passed` because the stubbed integResult carries no
            // meaningful verdict.
            if (integInfraInconclusive) {
                const inconclusiveNote = `INCONCLUSIVE (infra dispatch failure -- ${integInfraInconclusive.reason}; the member CLI produced no test verdict): ${integInfraInconclusive.message}`;
                integFailures.push({ cycle, notes: inconclusiveNote, bugsFiled: [], inconclusive: true });
                log(`Integration tests INCONCLUSIVE this cycle (C${cycle}): infra dispatch failure (${integInfraInconclusive.reason}) -- not accepted as pass or fail evidence.`);
            } else if (integResult.passed !== true) {
                // Never swallow a failure just because the agent chose to (or
                // didn't) file bugs -- `passed` is the source of truth, checked
                // explicitly and propagated below regardless of
                // `bugsFiled.length`.
                integFailures.push({ cycle, notes: integResult.summary, bugsFiled: integResult.bugsFiled });
                log(`Integration tests FAILED this cycle (C${cycle}, bugsFiled: ${integResult.bugsFiled.join(', ') || 'none'}): ${integResult.summary}`);
            } else {
                // apra-fleet-4bg: a successful/no-op cycle previously produced NO
                // log line at all, making it indistinguishable from a silent
                // contract violation (an agent that never touched its scope but
                // still reported passed:true). Log every outcome, not just
                // failures.
                log(`Integration tests PASSED this cycle (C${cycle}): ${integResult.featuresClosed} feature(s) closed, ${integResult.issuesCreated} bug(s) filed. ${integResult.summary}`);
            }
            // apra-fleet: Step 1c in integ-test-runner.md requires out-of-scope
            // failures observed during verification to be cross-linked or filed,
            // not silently dropped just because the cycle otherwise passed.
            if (Array.isArray(integResult.observedFailures) && integResult.observedFailures.length > 0) {
                log(`Integration tests C${cycle}: ${integResult.observedFailures.length} out-of-scope failure(s) observed and tracked -- ` +
                    integResult.observedFailures.map((f) => `${f.test} (${f.cause}) -> ${f.beadId}`).join(' | '));
            }
            // apra-fleet-jfo D6: verify-fail bounce cap. A gap bug filed under a
            // verify-set parent makes that parent structurally ineligible again
            // at next classification (its child count now includes an open bug)
            // -- no sticky "bounced" flag is needed for the round-trip itself.
            // This only tracks HOW MANY TIMES a given parent has bounced, so a
            // parent that keeps failing verification is deferred rather than
            // looping forever.
            if (Array.isArray(integResult.bugsFiled) && integResult.bugsFiled.length > 0 && verifySetForIntegTest.length > 0) {
                for (const bugId of integResult.bugsFiled) {
                    try {
                        const bugShowRaw = await command(`bd show ${bugId} --json`, { member_name: orchestratorMember, silent: true });
                        const bugBeads = parseBdJson(bugShowRaw, `bd show ${bugId} --json`);
                        const parentId = Array.isArray(bugBeads) ? bugBeads[0]?.parent : bugBeads?.parent;
                        if (!parentId || !verifySetIdSet.has(parentId)) continue;
                        const gapCount = (verifyGapCounts.get(parentId) ?? 0) + 1;
                        verifyGapCounts.set(parentId, gapCount);
                        if (gapCount > VERIFY_GAP_LIMIT) {
                            log(`Verify-route bounce cap: ${parentId} has failed verification ${gapCount} time(s) this sprint (limit ${VERIFY_GAP_LIMIT}) -- deferring rather than bouncing again.`);
                            await command(
                                `bd update ${parentId} --status=deferred --append-notes "Deferred by the verify-route bounce cap: failed integration-test verification ${gapCount} times this sprint (limit ${VERIFY_GAP_LIMIT}). Latest gap: ${bugId}."`,
                                { member_name: orchestratorMember, silent: true }
                            );
                        } else {
                            log(`Verify-route bounce: ${parentId} failed verification (gap bug ${bugId} filed), attempt ${gapCount}/${VERIFY_GAP_LIMIT} -- will re-route to plan/develop once ${bugId} closes.`);
                        }
                    } catch (bugLookupErr) {
                        log(`Verify-route bounce-cap lookup for ${bugId} failed (non-fatal, cap tracking skipped for this bug): ${bugLookupErr.message}`);
                    }
                }
            }
            // apra-fleet-nwh.1: fold this cycle's Integ Test spend (dispatch
            // plus any resume/retry inside the try/catch above) into the
            // running total buildCostAnalysis() reports at Harvest time. A
            // negative/NaN delta (a test double whose spent() does not
            // monotonically increase) is clamped to 0 rather than corrupting
            // the accumulator.
            if (integSpendBefore !== null && typeof budget?.spent === 'function') {
                const delta = budget.spent() - integSpendBefore;
                if (Number.isFinite(delta) && delta > 0) integTestRunnerSpend += delta;
            }
            await updateDashboard();
        } else if (hasPlaybook && !deployedThisCycle) {
            log('Skipping Integration Test Phase (deploy did not succeed this cycle, or no deploy.md was present to attempt)');
        } else {
            log('Skipping Integration Test Phase (no playbook found, or the probe itself failed -- see prior log line)');
        }

        // =======================
        // 5. Cycle Evaluation: goal-priority exit + stall-abort
        // =======================
        //
        // Real completion is "zero NOT_DONE_STATUSES beads in scope at or
        // above the goal priority AND the last reviewer verdict this cycle
        // was APPROVED" -- deliberately NOT `bd list --ready == []`, which
        // reads a permanently-blocked or orphaned in_progress bead as
        // success. See goalPriorityMax()/NOT_DONE_STATUSES above.
        //
        // D-pull the orchestrator's beads clone BEFORE the cycle-evaluation
        // counts so the completion/stall math reads the current cross-member
        // beads state (every member's D-pushed closes) rather than the
        // orchestrator's stale local copy.
        // (apra-fleet-p2to.4.1) standalone sync bracket -- see openSyncBracketCount's doc comment above.
        await withOpenSyncBracket(() => DoltSync.syncBefore(orchestratorMember, { command, log, fatal: true, settle: buildSettleCallback(orchestratorMember, { command, log }) }));
        // A decomposed parent (any bead that is itself someone's --parent,
        // including a childful --issue target) is excluded here the same way
        // readyLeafBeads() excludes it from dispatch: its own "done" status
        // comes from its children/verify-closure, never from being an
        // undispatchable leaf sitting open at goal priority forever. Whether
        // it must still close before the sprint may exit is owned entirely by
        // the separate stillOpenVerifyIds/verifyEverIds mechanism below, which
        // is scope- and structure-independent and does not have this blind
        // spot for the child-not-yet-verify-routed case in between.
        const [openAtGoalRaw, openAtGoalParentIds] = await Promise.all([
            bdListScoped(`--status=${NOT_DONE_STATUSES} --priority-max=${goalMax} --json`),
            decomposedParentIds(),
        ]);
        const openAtGoal = openAtGoalRaw.filter((b) => !openAtGoalParentIds.has(b.id));

        // Stall detection: track the closed-bead count for the WHOLE sprint
        // scope (not just goal-priority) so zero forward progress on ANY bead
        // is caught. `closedBeadsNow` is a genuinely fresh, correctly-scoped
        // `bd list --status=closed` read (bdListScoped always issues a real
        // command when a filter is passed) -- reused below instead of
        // fetchAllBeadsShared()'s snapshot, which is NOT refreshed by this
        // (or any other) bdListScoped call and can be stale by a full cycle
        // in a topology with no dolt sync remote (doltPullBefore/After are
        // both benign no-ops there, so nothing invalidates it): the integ
        // runner's own `bd close` happens inside an agent() dispatch, never
        // through the cache-invalidating command() wrapper.
        const closedBeadsNow = await bdListScoped('--status=closed --json');
        const closedIdsNow = new Set(closedBeadsNow.map((b) => b.id));
        const closedCount = closedBeadsNow.length;
        closedCountHistory.push(closedCount);

        // apra-fleet-66u.2: track whether THIS cycle's Integ Test dispatch (if
        // any verify-routed beads were handed to it) actually closed any of
        // them, on the same live, correctly-scoped state closedCount above
        // just read. Feeds the stall-abort message below: "the verifier may
        // be failing" is only warranted when it NEVER once closed anything it
        // was asked to verify, not merely when the sprint later stalls for an
        // unrelated reason.
        if (verifySetForIntegTest.length > 0) {
            verifyDispatchAttempts++;
            const closedThisDispatch = verifySetForIntegTest.some((id) => closedIdsNow.has(id));
            if (closedThisDispatch) verifyDispatchClosures++;
        }

        // apra-fleet-jfo: a bead classified into the verify set this cycle is
        // real progress too -- it was implementation-complete work correctly
        // excluded from Plan/Develop, now awaiting real integration-test
        // verification (which cannot happen until IntegTest actually runs).
        // Without this, a cycle that closes every leaf bead under several
        // parents -- but closes none of the parents themselves, since only
        // IntegTest may do that -- reads as zero progress and stalls the
        // sprint, exactly what happened live 2026-08-02 on apra-fleet-l7n and
        // apra-fleet-2sn. `verifyEverIds` is monotone (only ever grows), so a
        // bead cannot re-earn credit by oscillating in and out of
        // eligibility -- the high-water-mark oscillation-proofing survives.
        const progressScore = closedCount + verifyEverIds.size;
        // High-water-mark progress. A cycle only counts as progress when it sets
        // a NEW all-time high for this sprint -- returning to a previously-seen
        // value (even one different from the immediately prior cycle, e.g.
        // 5,4,5,4,...) is not progress.
        if (progressScore > highWaterClosedCount) {
            highWaterClosedCount = progressScore;
            staleCycles = 0;
        } else {
            staleCycles++;
        }

        if (staleCycles >= STALL_CYCLE_LIMIT) {
            const thrashIds = thrashingBeadIds();
            // apra-fleet-mjo: counts alone ("history: [9, 14, 14, 14]") do not
            // tell an operator WHAT is holding the sprint open, which is
            // precisely what they need to intervene. Name the blocking beads.
            const blockerIds = openAtGoal.map((b) => b.id);
            const blockerSuffix = blockerIds.length > 0
                ? ` Still open at/above goal priority ${goalMax}: [${blockerIds.join(', ')}].`
                : ' No beads remain open at/above goal priority -- the stall is in closing out the sprint, not in the work itself.';
            const thrashSuffix = thrashIds.length > 0
                ? ` Reopen-thrash detected on bead(s) [${thrashIds.join(', ')}] (reopened more than ${REOPEN_THRASH_LIMIT} times) -- ` +
                  `likely cause of the oscillation.`
                : '';
            // apra-fleet-66u.2: report only the STILL-open verify-routed
            // beads (verifyEverIds is monotone and never drops an id once
            // closed, so dumping it directly names beads that may have
            // closed cycles ago -- the exact wording that shipped in the
            // real 2026-08-02 incident, which named apra-fleet-33c/jfo/gd0 as
            // "never closed" when all three had closed back in Cycle 1). And
            // only claim "the verifier may be failing" when Integ Test
            // dispatches actually happened against a verify set and NEVER
            // once closed anything -- if it closed something at some point,
            // the stall has some other cause and the verifier-blame wording
            // is actively misleading.
            let verifySuffix = '';
            if (verifyEverIds.size > 0) {
                const stillOpenVerifyIdsForAbort = [...verifyEverIds].filter((id) => !closedIdsNow.has(id));
                if (stillOpenVerifyIdsForAbort.length > 0) {
                    verifySuffix = (verifyDispatchAttempts > 0 && verifyDispatchClosures === 0)
                        ? ` ${stillOpenVerifyIdsForAbort.length} bead(s) were routed to verify this sprint but never closed -- the ` +
                          `verifier may be failing rather than the sprint being genuinely out of work: ${stillOpenVerifyIdsForAbort.join(', ')}.`
                        : ` ${stillOpenVerifyIdsForAbort.length} verify-routed bead(s) remain unclosed: ${stillOpenVerifyIdsForAbort.join(', ')}.`;
                }
            }
            throw new StalledSprintError(
                `Sprint stalled: ${staleCycles} consecutive cycle(s) made no new high-water-mark progress ` +
                `(closed beads + verify-routed beads) in scope '${sprintFilter}'. Closed-count history: ` +
                `[${closedCountHistory.join(', ')}] (high-water mark on progress score: ${highWaterClosedCount}).` +
                blockerSuffix + thrashSuffix + verifySuffix +
                ` Aborting rather than burning the remaining cycles.`,
                { staleCycles, closedCountHistory, highWaterClosedCount, blockerIds, thrashIds, reopenCounts: Object.fromEntries(reopenCounts), verifyEverIds: [...verifyEverIds], cycle }
            );
        }

        // apra-fleet-jfo D5: if the ONLY open-at-goal beads remaining are
        // verify-routed and no playbook exists to verify them, no further
        // cycle can make progress by construction -- exit to Finalization
        // directly rather than let the stall net eventually convert
        // "finished but unverifiable" into an ABORT.
        if (!hasPlaybook && openAtGoal.length > 0 && openAtGoal.every((b) => verifyEverIds.has(b.id))) {
            log(`Cycle ${cycle}: all ${openAtGoal.length} remaining open-at-goal bead(s) are verify-routed (${openAtGoal.map((b) => b.id).join(', ')}) and no integ-test-playbook.md exists to verify them -- exiting cycle loop, cannot make further progress by construction.`);
            endGroup();
            break;
        }

        // The exit decision below must never rely on a verdict from an EARLIER
        // cycle. `lastReviewVerdict` is reset to null at the top of every cycle
        // and only set when a review genuinely ran THIS cycle
        // (`reviewedThisCycle`). If the goal-priority bead count already reads 0
        // but no review ran this cycle (e.g. the Develop/Review loop was skipped
        // because there were no ready beads), dispatch one fresh review of the
        // CURRENT state here, before ever deciding to exit -- rather than either
        // silently exiting on a stale verdict nothing this cycle backs, or
        // looping forever with no way to confirm completion.
        if (openAtGoal.length === 0 && !reviewedThisCycle) {
            phase(`Re-Review C${cycle}`);
            log(
                `Cycle ${cycle}: 0 open goal-priority bead(s) but no review ran THIS cycle (Develop/Review ` +
                `loop was skipped) -- dispatching a fresh re-review of the current state before deciding ` +
                `whether to exit, rather than trusting a verdict from an earlier cycle.`
            );
            const reReviewScope = await bdListScoped('--json');
            // apra-fleet-jfo.3: this call passed beadIds: [] unconditionally,
            // which buildReviewerPrompt renders as "Review the work just done
            // for the following bead id(s): ." -- no ids to review. The
            // reviewer correctly treats that as missing required input and
            // refuses (a CHANGES_NEEDED-shaped response with empty
            // reopenIds/newTasks), which after one retry throws
            // ReviewerContractViolationError and aborts the WHOLE sprint --
            // hit live 2026-08-02 on apra-fleet-l7n-style sprints (Deploy
            // fails on cycle 1 -> IntegTest skipped -> openAtGoal reads 0 ->
            // this branch -> crash, before the sprint ever gets a real
            // chance). The sprint's own root issue id(s) are always a valid,
            // in-scope target for "review the current state" -- pass them as
            // beadIds so the reviewer has something concrete to ground its
            // verdict in; acceptanceCriteriaJson still carries the full scope
            // for context.
            const reReviewVerdict = await dispatchReview({ beadIds: targetIssues, acceptanceCriteriaJson: JSON.stringify(reReviewScope) });
            await kbWork.apply(ROLE_REVIEWER, kbPriming.folderOf(getMembersForRole(ROLE_REVIEWER)[0]), reReviewVerdict);
            lastReviewVerdict = reReviewVerdict.verdict;
            reviewedThisCycle = true;

            // Same orchestrator-applies-the-transition contract as the
            // regular Develop/Review dispatch above: a re-review that
            // reopens beads or proposes follow-up work must have those
            // effects actually applied, not silently discarded just because
            // this dispatch happened outside the normal Develop loop.
            for (const id of reReviewVerdict.reopenIds) {
                await command(
                    `bd update ${id} --status=open`,
                    { member_name: orchestratorMember, silent: true, label: `Reopen ${id} per re-review verdict` }
                );
                // Track per-bead reopen counts for reopen-thrash detection.
                recordReopen(id);
            }
            for (const newTask of reReviewVerdict.newTasks) {
                const validation = validateNewTask(newTask);
                if (!validation.ok) {
                    log(`Re-review newTasks: REJECTED (not sent to bd create) -- ${validation.reason}`);
                    rejectedNewTasks.push({ cycle, reason: validation.reason, raw: newTask });
                    // Track it for resurfacing into the NEXT planning-phase
                    // dispatch too -- see trackRejectedNewTaskForResurfacing()'s
                    // doc comment.
                    pendingRejectedNewTasks = trackRejectedNewTaskForResurfacing(pendingRejectedNewTasks, {
                        title: newTask && newTask.title, description: newTask && newTask.description,
                        reason: validation.reason, cycle,
                    });
                    // Never let a rejected finding vanish -- persist it verbatim
                    // to the parent bead's notes as a fallback (non-fatal;
                    // degrades to the run log).
                    try {
                        await appendRejectedFindingToParentNotes({
                            command, member: orchestratorMember, parentId: targetIssues[0],
                            newTask, reason: validation.reason, cycle, log,
                        });
                    } catch (noteErr) {
                        log(`[fleet-sprint] rejected-finding notes fallback FAILED (non-fatal): ${noteErr.message}; finding preserved VERBATIM in this run log: ${JSON.stringify(newTask)}`);
                    }
                    continue;
                }
                const { title, description, priority } = validation;
                // A bead can only have one parent -- when multiple sprint-root
                // target issues are given, file follow-up work under the first
                // one. `--parent` never accepts a comma-joined list; passing one
                // silently creates an unparented/misparented bead.
                //
                // Same allocator-minted id path as the Develop/Review newTasks
                // site above -- concurrent sprints must never mint the same child
                // id under a shared parent.
                const persisted = await persistNewTaskBestEffort({
                    command, member: orchestratorMember, parentId: targetIssues[0],
                    newTask, cycle, log, stage: 're-review',
                    createFn: async () => {
                        const floor = await computeChildFloor({ command, member: orchestratorMember, parentId: targetIssues[0] });
                        await createChildBeadWithAllocatedId({
                            command, allocator: childIdAllocator, member: orchestratorMember,
                            title, description, priority, parentId: targetIssues[0],
                            sprintId: sprintMutexId, floor, log,
                            label: `Create follow-up task from re-review newTasks: ${title}`,
                        });
                    },
                });
                // Same resurface-list bookkeeping (title+description) as the
                // Develop/Review newTasks site above.
                if (persisted) {
                    pendingRejectedNewTasks = clearResubmittedNewTask(pendingRejectedNewTasks, { title, description });
                }
            }

            // D-push the orchestrator's applied re-review reopens/newTask
            // creates, same as the Develop/Review transition site above.
            // (apra-fleet-p2to.4.1) standalone sync bracket -- see openSyncBracketCount's doc comment above.
            await withOpenSyncBracket(() => DoltSync.syncAfter(orchestratorMember, { command, pushBeads: true, log, mutex: doltPushMutex, sprintId: sprintMutexId }));
        }

        // apra-fleet-jfo.2: verify-routed beads are decomposed parents, so
        // `openAtGoal` above (post-filtered via decomposedParentIds()) never
        // includes them no matter their status -- a cycle where Deploy fails
        // (skipping IntegTest entirely, so no verify-routed bead ever gets a
        // chance to close) can therefore still read `openAtGoal.length === 0`
        // and exit here with those beads never actually re-verified. Check
        // their live status independently before allowing the count-based
        // exit to fire. Guarded on `verifyEverIds.size > 0` so a sprint that
        // never routed any bead to verify (the common case) pays no extra
        // `bd list` dispatch here at all. Uses a fresh scoped closed-list
        // (apra-fleet-66u.2), not fetchAllBeadsShared()'s cache, which can be
        // stale here for the same reason noted at the closedBeadsNow read
        // above -- this check runs after the Re-Review block may have pushed
        // further mutations this cycle.
        let stillOpenVerifyIds = [];
        if (verifyEverIds.size > 0) {
            const closedIdsForExitCheck = new Set((await bdListScoped('--status=closed --json')).map((b) => b.id));
            stillOpenVerifyIds = [...verifyEverIds].filter((id) => !closedIdsForExitCheck.has(id));
        }

        if (openAtGoal.length === 0 && lastReviewVerdict === 'APPROVED' && stillOpenVerifyIds.length === 0) {
            log(`Goal priority ${validated.goal} (<=${goalMax}) satisfied: 0 open bead(s) in scope and last reviewer verdict was APPROVED. Exiting cycle loop.`);
            endGroup();
            break;
        }

        log(
            `Cycle ${cycle} evaluation: ${openAtGoal.length} bead(s) still open at/above goal priority ${goalMax}, ` +
            `last reviewer verdict: ${lastReviewVerdict ?? '(none this cycle)'}` +
            (stillOpenVerifyIds.length > 0
                ? `, ${stillOpenVerifyIds.length} verify-routed bead(s) still open and unverified ` +
                  `(${stillOpenVerifyIds.join(', ')}) -- not exiting on goal-priority count alone until these ` +
                  `close or a future cycle's IntegTest genuinely attempts them`
                : '') +
            `. Continuing.`
        );

        cycle++;
        endGroup();
    }

    // When the loop exits because `cycle` exceeded MAX_CYCLES (rather than via
    // an early `break`), `cycle` is MAX_CYCLES + 1 at this point; the labels
    // below must report the last cycle actually run.
    const finalCycleLabel = Math.min(cycle, MAX_CYCLES);

    // =======================
    // 6. Finalization: the evidence-based final verdict drives the return value
    // =======================
    group('Finalization');
    phase(`Final Review C${finalCycleLabel}`);

    // D-pull the orchestrator's beads clone BEFORE the final-review counts so
    // the sprint's closing evidence (finalOpenAtGoal / finalClosedCount)
    // reflects every member's D-pushed beads state, not the orchestrator's
    // stale local copy.
    // (apra-fleet-p2to.4.1) standalone sync bracket -- see openSyncBracketCount's doc comment above.
    await withOpenSyncBracket(() => DoltSync.syncBefore(orchestratorMember, { command, log, fatal: true, settle: buildSettleCallback(orchestratorMember, { command, log }) }));
    const [finalOpenAtGoalRaw, finalOpenAtGoalParentIds, finalClosedBeads] = await Promise.all([
        bdListScoped(`--status=${NOT_DONE_STATUSES} --priority-max=${goalMax} --json`),
        decomposedParentIds(),
        bdListScoped('--status=closed --json'),
    ]);
    const finalOpenAtGoal = finalOpenAtGoalRaw.filter((b) => !finalOpenAtGoalParentIds.has(b.id));
    const finalClosedCount = finalClosedBeads.length;
    // apra-fleet-jfo.2: same structural blind spot as the per-cycle exit
    // check -- verify-routed beads are decomposed parents, so they never
    // appear in finalOpenAtGoal (post-filtered via decomposedParentIds()),
    // so a sprint that exhausted MAX_CYCLES with Deploy failing every time
    // could otherwise reach Final Review reporting "0 open bead(s)" while
    // the verify-routed targets were never actually re-verified. Surface it
    // as explicit evidence rather than leaving the Final Review to
    // rubber-stamp PASS on an incomplete count. Guarded on
    // `verifyEverIds.size > 0` -- see the per-cycle check above for why.
    // Uses the same fresh finalClosedBeads read as finalClosedCount above,
    // not fetchAllBeadsShared()'s cache (apra-fleet-66u.2).
    let finalUnclosedVerifyIds = [];
    if (verifyEverIds.size > 0) {
        const finalClosedIds = new Set(finalClosedBeads.map((b) => b.id));
        finalUnclosedVerifyIds = [...verifyEverIds].filter((id) => !finalClosedIds.has(id));
    }

    let finalVerdictResult;
    // The Final Review covers an entire epic's worth of work, categorically
    // LARGER than a per-round review, so it gets an explicit budget plus the
    // same same-session resume-and-continue treatment as the doer and per-round
    // reviewer. Without it a large sprint's final review dies at the default
    // turn limit and flips the whole sprint to a FAIL whose notes carry no
    // findings at all.
    const FINAL_REVIEW_MAX_TURNS = 500;
    // Final Review is the same 'reviewer' role as dispatchReview above
    // (read-side, pushCode: false) -- G-pull before, no-op G-push after every
    // attempt (including the retry below).
    const finalReviewDispatchOpts = {
        member_name: getMemberForRole('reviewer'),
        agentType: 'reviewer',
        schema: finalVerdict,
        label: 'Final Review',
        model: FIXED_ROLE_TIER.reviewer,
        // Reviews the full diff/evidence across an entire epic's worth of
        // closed tasks -- a timeout here flips a whole sprint's outcome to
        // FAIL.
        timeout_s: DISPATCH_TIMEOUT_S,
        max_total_s: DISPATCH_TIMEOUT_S,
        max_turns: FINAL_REVIEW_MAX_TURNS,
    };
    // apra-fleet-nx7: offer the final reviewer the same INFERRED candidates a
    // per-round reviewer gets. Fetched once, before the dispatch, so the retry
    // and resume paths below reuse the identical block rather than re-querying a
    // KB that its own earlier promotions may have already changed.
    const finalReviewRepoPath = kbPriming.folderOf(getMemberForRole('reviewer'));
    const finalKbCandidates = await kbWork.promotionCandidates(finalReviewRepoPath);
    if (finalKbCandidates.length > 0) {
        log(`[kb-work] offering ${finalKbCandidates.length} INFERRED entr(ies) to the final reviewer for promotion.`);
    }
    const dispatchFinalReview = () => withGitSync(getMemberForRole('reviewer'), false, () => agent(
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
            rejectedNewTasks,
            unclosedVerifyIds: finalUnclosedVerifyIds,
            kbCandidates: finalKbCandidates,
            kbKnowledge: kbPriming.knowledgeOf(getMemberForRole('reviewer')),
        }),
        // member_name is repeated literally here -- not only via the
        // shared opts object -- so the source-level call-site parse in
        // dispatch-safety-guard can verify it.
        { ...finalReviewDispatchOpts, member_name: getMemberForRole('reviewer') }
    ));
    const dispatchFinalReviewResume = () => withGitSync(getMemberForRole('reviewer'), false, () => agent(
        'Continue your final review exactly where you left off in this same session -- do not restart or re-read the diff from scratch. Weigh the remaining evidence and return your final PASS/FAIL verdict now (with newTasks findings if FAIL).',
        {
            ...finalReviewDispatchOpts,
            member_name: getMemberForRole('reviewer'),
            label: `Final Review (resume, max_turns=${FINAL_REVIEW_MAX_TURNS * 2})`,
            resume: true,
            max_turns: FINAL_REVIEW_MAX_TURNS * 2,
        }
    ));
    // One logical final-review attempt: on max_turns exhaustion, resume the
    // SAME session with a doubled budget instead of restarting (a fresh
    // retry would deterministically die at the same limit).
    const runFinalReviewAttempt = async () => {
        try {
            return await dispatchFinalReview();
        } catch (err) {
            if (err instanceof AgentDispatchError && err.details?.reason === 'max_turns_exhausted') {
                log(`Final Review exhausted its turn limit (max_turns=${FINAL_REVIEW_MAX_TURNS}) -- resuming the same session with max_turns=${FINAL_REVIEW_MAX_TURNS * 2} instead of restarting the review.`);
                await memberSessionGuard.killIfAlive(getMemberForRole('reviewer'));
                return await dispatchFinalReviewResume();
            }
            throw err;
        }
    };
    // Final Review is the LAST dispatch of the sprint, so a single transient
    // AgentDispatchError/AgentOutputError here would otherwise flip an
    // otherwise fully-successful sprint straight to verdict:FAIL with zero
    // retry. Mirrors dispatchPlanner()'s retry-once wrapper: retry once before
    // falling back to the hardcoded FAIL verdict.
    try {
        finalVerdictResult = await runFinalReviewAttempt();
    } catch (err) {
        // Auth/trust failures are deterministic -- the generic retry-once
        // ladder below would only reproduce them. LLM-auth failures instead
        // get exactly ONE self-heal attempt: on success the healed verdict is
        // authoritative and MUST short-circuit here -- falling through to the
        // generic ladder below would fire a SECOND full Final Review (the
        // most expensive dispatch in the sprint), silently discarding the
        // healed verdict (a PASS could become a FAIL) and doubling cost. If
        // the heal itself succeeds but the heal-retry dispatch throws, that
        // throw is caught here too and degraded through the same FAIL
        // fallback as an ordinary retry failure below -- it must never escape
        // this catch and abort the whole sprint.
        let handledByAuthSelfHeal = false;
        if (isNonRetryableDispatchError(err)) {
            let healedByLlmAuthSelfHeal = false;
            if (isAuthDispatchError(err) && typeof onLlmAuthFailure === 'function') {
                const healed = await onLlmAuthFailure({ member: getMemberForRole('reviewer'), label: 'Final Review dispatch', error: err.message });
                if (healed) {
                    log(`Final Review: LLM auth self-heal succeeded -- retrying once.`);
                    try {
                        finalVerdictResult = await runFinalReviewAttempt();
                    } catch (healRetryErr) {
                        if (healRetryErr instanceof AgentOutputError) {
                            log(`Final Review: heal-retry schema-repair exhausted, treating as FAIL: ${healRetryErr.message}`);
                            finalVerdictResult = { verdict: 'FAIL', notes: `Final reviewer failed to return a schema-valid verdict after an LLM-auth self-heal retry: ${healRetryErr.message}` };
                        } else if (healRetryErr instanceof AgentDispatchError || healRetryErr instanceof FleetTransportError) {
                            log(`Final Review: heal-retry agent dispatch failed, treating as FAIL: ${healRetryErr.message}`);
                            finalVerdictResult = { verdict: 'FAIL', notes: `Final reviewer dispatch failed after an LLM-auth self-heal retry: ${healRetryErr.message}` };
                        } else {
                            throw healRetryErr;
                        }
                    }
                    healedByLlmAuthSelfHeal = true;
                }
            }
            if (!healedByLlmAuthSelfHeal) throw err;
            handledByAuthSelfHeal = true;
        }
        if (!handledByAuthSelfHeal) {
            if (err instanceof AgentOutputError) {
                log(`Final Review: dispatch failed (schema-repair exhausted: ${err.message}). Retrying once.`);
            } else if (err instanceof AgentDispatchError || err instanceof FleetTransportError) {
                log(`Final Review: dispatch failed (agent dispatch error: ${err.message}). Retrying once.`);
            } else {
                throw err;
            }
            try {
                finalVerdictResult = await runFinalReviewAttempt();
            } catch (retryErr) {
                if (retryErr instanceof AgentOutputError) {
                    log(`Final Review: schema-repair exhausted after retry, treating as FAIL: ${retryErr.message}`);
                    finalVerdictResult = { verdict: 'FAIL', notes: `Final reviewer failed to return a schema-valid verdict after repair attempts (including one retry): ${retryErr.message}` };
                } else if (retryErr instanceof AgentDispatchError || retryErr instanceof FleetTransportError) {
                    log(`Final Review: agent dispatch failed after retry, treating as FAIL: ${retryErr.message}`);
                    finalVerdictResult = { verdict: 'FAIL', notes: `Final reviewer dispatch failed after repair attempts (including one retry): ${retryErr.message}` };
                } else {
                    throw retryErr;
                }
            }
        }
    }
    // No duplicate log() dump -- see dispatchReview() for why.
    // `finalVerdictResult.verdict` also surfaces via the generic,
    // workflow-agnostic Result strip in the dashboard header (state.result --
    // see src/viewer/index.mjs), a second independent reason a raw JSON
    // re-print here would be redundant.

    // apra-fleet-nx7: execute the final reviewer's KB decisions through the same
    // path every per-round review uses. Deliberately NOT gated on the verdict --
    // a fact can be verified even when the sprint as a whole fails, and reviewer
    // contract already says as much ("Not tied to the verdict"). Placed before
    // the beads/PR work below and kept non-fatal by kbWork.apply itself, so a KB
    // problem can never change a sprint's outcome.
    await kbWork.apply(ROLE_REVIEWER, finalReviewRepoPath, finalVerdictResult);

    // Publish what this sprint confirmed. Immediately after the LAST promotion
    // of the run, so the bible carries every CONFIRMED entry including the ones
    // minted a line above. Without this the sprint's knowledge never left the
    // member's local sqlite store -- see createKbWorkClient.exportBible.
    await kbWork.exportBible(finalReviewRepoPath);

    // Persist the Final Review's actionable findings to BEADS -- the only
    // artifact the next sprint's planner reads (notes reach only the PR body
    // and the analysis doc). NOT gated to FAIL: a PASS can still surface real
    // secondary findings (defects that don't block this epic's own
    // acceptance criteria) that would otherwise be lost prose with no
    // follow-up mechanism. Same orchestrator-applies contract, allowlist
    // validation, and id-allocator path as the per-round reviewer's
    // newTasks; a rejected finding is logged and recorded, never sprint-fatal.
    const finalNewTasks = Array.isArray(finalVerdictResult.newTasks) ? finalVerdictResult.newTasks : [];
    let dPushNeededAfterFinalFindings = false;
    if (finalNewTasks.length > 0) {
        const createdIds = [];
        let createdCountUnknownId = 0;
        for (const newTask of finalNewTasks) {
            const validation = validateNewTask(newTask);
            if (!validation.ok) {
                log(`Final Review newTasks: REJECTED (not sent to bd create) -- ${validation.reason}`);
                rejectedNewTasks.push({ cycle: finalCycleLabel, reason: validation.reason, raw: newTask });
                // Never let a rejected finding vanish -- persist it verbatim to
                // the parent bead's notes as a fallback. This is the
                // highest-stakes site of the three: Final Review's findings
                // are the handoff to the next sprint's planner. Non-fatal;
                // degrades to the run log.
                try {
                    await appendRejectedFindingToParentNotes({
                        command, member: orchestratorMember, parentId: targetIssues[0],
                        newTask, reason: validation.reason, cycle: finalCycleLabel, log,
                    });
                } catch (noteErr) {
                    log(`[fleet-sprint] rejected-finding notes fallback FAILED (non-fatal): ${noteErr.message}; finding preserved VERBATIM in this run log: ${JSON.stringify(newTask)}`);
                }
                continue;
            }
            const { title, description, priority } = validation;
            const created = await persistNewTaskBestEffort({
                command, member: orchestratorMember, parentId: targetIssues[0],
                newTask, cycle: finalCycleLabel, log, stage: 'final-review',
                createFn: async () => {
                    const floor = await computeChildFloor({ command, member: orchestratorMember, parentId: targetIssues[0] });
                    return createChildBeadWithAllocatedId({
                        command, allocator: childIdAllocator, member: orchestratorMember,
                        title, description, priority, parentId: targetIssues[0],
                        sprintId: sprintMutexId, floor, log,
                        label: `Create follow-up task from Final Review findings: ${title}`,
                    });
                },
            });
            if (created) {
                dPushNeededAfterFinalFindings = true;
                if (created.childId) {
                    createdIds.push(created.childId);
                    log(`Final Review newTasks: created ${created.childId} ("${title}") under ${targetIssues[0]}.`);
                } else {
                    createdCountUnknownId += 1;
                    log(`Final Review newTasks: created a follow-up task ("${title}") under ${targetIssues[0]} (bd-derived id, not tracked by the allocator).`);
                }
            }
        }
        if (createdIds.length > 0 || createdCountUnknownId > 0) {
            log(`Final Review: persisted ${createdIds.length + createdCountUnknownId} finding(s) to beads as follow-up task(s) under ${targetIssues[0]}${createdIds.length > 0 ? `: ${createdIds.join(', ')}` : ''}.`);
        }
    }

    // Beads the Final Review flagged for reopening -- each with its OWN
    // reason (unlike the per-round reviewer's reopenIds, which shares one
    // blanket `notes` string across every id this round). Same goal-scope
    // guard as the per-round reviewer: never reopen a below-goal-priority
    // bead into scope this sprint no longer targets. Reason is appended
    // (never overwritten) via --append-notes so it never clobbers the
    // bead's existing notes.
    const finalReopenIds = Array.isArray(finalVerdictResult.reopenIds) ? finalVerdictResult.reopenIds : [];
    if (finalReopenIds.length > 0) {
        let reopenAllowlist = null;
        try {
            const inScopeNow = await bdListScoped('');
            reopenAllowlist = new Map(inScopeNow.map((b) => [b.id, b]));
        } catch {
            reopenAllowlist = null; // lookup failed -- apply reopens unguarded rather than dropping them
        }
        const reopenedIds = [];
        for (const entry of finalReopenIds) {
            const id = entry && typeof entry.id === 'string' ? entry.id.trim() : '';
            const reason = entry && typeof entry.reason === 'string' ? entry.reason.trim() : '';
            if (!id || !reason) {
                log(`Final Review reopenIds: SKIPPED a malformed entry (both id and reason are required) -- ${JSON.stringify(entry)}`);
                continue;
            }
            const bead = reopenAllowlist ? reopenAllowlist.get(id) : null;
            if (reopenAllowlist && bead && typeof bead.priority === 'number' && bead.priority > goalMax) {
                log(`Final Review reopenIds: SKIPPED '${id}' (priority P${bead.priority} is below this sprint's goal ${validated.goal} -- deferred scope, not reopened).`);
                continue;
            }
            try {
                // bd update has no --append-notes-file / --stdin equivalent for
                // notes (only --body-file/--stdin, and only for description) --
                // --append-notes only accepts an inline string. reason is
                // LLM-authored free text, so it must go through the same
                // flatten-to-single-line, shell-injection-safe sanitizer used
                // for the PR body's notes, never interpolated raw.
                const safeReason = sanitizePrText(reason);
                if (!safeReason) {
                    log(`Final Review reopenIds: SKIPPED '${id}' (reason sanitized to empty -- nothing safe to record).`);
                    continue;
                }
                await command(
                    `bd update ${id} --status=open --append-notes "[Final Review C${finalCycleLabel}] Reopened -- ${safeReason}"`,
                    { member_name: orchestratorMember, silent: true, label: `Reopen ${id} per Final Review verdict` }
                );
                reopenedIds.push(id);
                dPushNeededAfterFinalFindings = true;
                log(`Final Review reopenIds: reopened ${id} -- ${safeReason}`);
            } catch (reopenErr) {
                log(`[fleet-sprint] Final Review reopen FAILED (non-fatal) for '${id}': ${reopenErr.message} -- reason preserved verbatim in this run log: ${reason}`);
            }
        }
        if (reopenedIds.length > 0) {
            log(`Final Review: reopened ${reopenedIds.length} bead(s): ${reopenedIds.join(', ')}.`);
        }
    }
    if (dPushNeededAfterFinalFindings) {
        await doltPushAfter(orchestratorMember, { command, pushBeads: true, log, mutex: doltPushMutex, sprintId: sprintMutexId });
    }

    // =======================
    // 6b. Regression Test (once per sprint, informational -- never a gate)
    // =======================
    //
    // Sits deliberately BETWEEN Final Review and Harvest.
    //
    // After Final Review, because `finalVerdictResult` is already computed by
    // the time this runs -- so a regression failure structurally CANNOT
    // perturb the sprint's verdict. No LLM-trusted "please ignore this"
    // instruction is needed; the ordering is the guarantee.
    //
    // Before Harvest, because the harvester writes
    // docs/sprint-analysis-<slug>.md and this phase's summary is folded into
    // that document (informational section, see buildAnalysisText).
    //
    // This is the sprint's standing confidence check: it proves EXISTING
    // functionality still works, which is why it runs once per sprint rather
    // than once per cycle, and why its failures are filed as STANDALONE,
    // PARENT-LESS `[regression][carry-over]` beads. `bdListScoped()` builds
    // the sprint's scope tree by walking `.parent` edges only, so a
    // parent-less bead is mechanically invisible to `openAtGoal` /
    // `finalOpenAtGoal` -- a regression failure therefore carries over to a
    // future sprint (the planner discovers them with `bd search
    // "[carry-over]"`) instead of retroactively blocking the sprint that
    // happened to find it.
    //
    // No deployedSha handoff: part 1 runs against branch HEAD directly and
    // part 2 provisions its own fresh sandbox install, so neither depends on
    // the per-cycle Deploy target.
    let regressionResult = null;
    const hasRegressionPlaybook = await probeFileExists('regression-test-playbook.md');
    if (hasRegressionPlaybook) {
        phase(`Regression Test C${finalCycleLabel}`);
        await ensureUnattendedAuto(getMemberForRole('regression-test-runner'));
        await ensureDeployPermissions(getMemberForRole('regression-test-runner'));
        // The real functional suite alone spends roughly one turn per liveness
        // poll for the better part of an hour, and this single dispatch carries
        // both it and the sandbox smoke sprint -- hence the large turn budget
        // and the wider hard ceiling.
        const REGRESSION_TEST_MAX_TURNS = 500;
        const REGRESSION_TEST_MAX_TOTAL_S = DISPATCH_TIMEOUT_S * 3;
        const regressionPrompt =
            `Run the full regression pass using regression-test-playbook.md at the repo root: part 1 ` +
            `(the real functional suite) and part 2 (the sandbox smoke test), then ALWAYS run the ` +
            `playbook's Teardown before returning, pass or fail. ` +
            `File every failure you find as a STANDALONE bead: run bd create WITHOUT any --parent flag ` +
            `and do NOT bd dep add it to any sprint bead, titled "[regression][carry-over] <description>". ` +
            `Search bd for "[carry-over]" first and update an existing bead rather than filing a duplicate. ` +
            `Filing these parent-less is what makes them carry over to a future sprint instead of blocking ` +
            `this one -- do not "helpfully" parent them under a sprint bead. ` +
            `This sprint's verdict has already been decided and your result is informational: report it ` +
            `honestly, and never soften a failure because the sprint has otherwise passed.`;
        const regressionDispatchOpts = {
            member_name: getMemberForRole('regression-test-runner'),
            agentType: 'regression-test-runner',
            schema: regressionReport,
            model: FIXED_ROLE_TIER['regression-test-runner'],
            // Same shape as the integ dispatch: keep the shorter INACTIVITY
            // timer (a genuinely hung runner still dies) while giving the HARD
            // elapsed-time ceiling real headroom, since a max_total_s kill
            // surfaces as a plain AgentDispatchError that the max_turns resume
            // ladder below cannot catch.
            timeout_s: DISPATCH_TIMEOUT_S,
            max_total_s: REGRESSION_TEST_MAX_TOTAL_S,
            max_turns: REGRESSION_TEST_MAX_TURNS,
        };
        try {
            // Mutates beads (files carry-over bugs) but never touches code:
            // pushCode false / pushBeads true, exactly like the integ runner.
            try {
                regressionResult = await withGitSync(getMemberForRole('regression-test-runner'), false, () => agent(
                    regressionPrompt,
                    { ...regressionDispatchOpts, member_name: getMemberForRole('regression-test-runner') }
                ), { pushBeads: true });
            } catch (err) {
                if (err instanceof AgentDispatchError && err.details?.reason === 'max_turns_exhausted') {
                    log(`Regression Test Runner exhausted its turn limit (max_turns=${REGRESSION_TEST_MAX_TURNS}) -- resuming the same session with max_turns=${REGRESSION_TEST_MAX_TURNS * 2} instead of restarting the pass.`);
                    await memberSessionGuard.killIfAlive(getMemberForRole('regression-test-runner'));
                    // A resume DELIVERS A NEW prompt artifact, so restate the
                    // dispatch's scope/filing rules -- a bare "continue" would
                    // lose the parent-less filing rule, which is the whole point
                    // of this phase.
                    regressionResult = await withGitSync(getMemberForRole('regression-test-runner'), false, () => agent(
                        'Continue the regression pass exactly where you left off in this same session -- do not restart the playbook or rebuild the sandbox if it is already up. Finish the remaining work, run Teardown, and return your final report now. ' +
                        'Your original instructions, restated so a resumed dispatch never loses them: ' + regressionPrompt,
                        {
                            ...regressionDispatchOpts,
                            member_name: getMemberForRole('regression-test-runner'),
                            label: `Regression Test (resume, max_turns=${REGRESSION_TEST_MAX_TURNS * 2})`,
                            resume: true,
                            max_turns: REGRESSION_TEST_MAX_TURNS * 2,
                        }
                    ), { pushBeads: true });
                } else {
                    throw err;
                }
            }
            if (regressionResult.passed !== true) {
                log(`Regression pass reported FAILURES (carry-over beads: ${(regressionResult.bugsFiled || []).join(', ') || 'none'}): ${regressionResult.summary}`);
            } else {
                log(`Regression pass PASSED (suite: ${regressionResult.suitePassed}, smoke: ${regressionResult.smokePassed}).`);
            }
        } catch (err) {
            // A regression-phase infrastructure failure must never abort the
            // sprint. Hence deliberately NO outer retry-once wrapper and
            // deliberately a CATCH-ALL: unlike Final Review -- whose failure
            // legitimately fails the whole sprint -- ANY failure of this phase
            // must soft-fail and log. It can never abort the run, gate the
            // verdict, or block Harvest.
            //
            // The catch-all is load-bearing, not defensive sloppiness. The
            // dispatch above is wrapped in withGitSync(..., { pushBeads: true }),
            // whose pre-dispatch G-pull/D-pull and post-dispatch G-push/D-push
            // can throw GitSyncError / GitDivergedError / DoltSyncError /
            // DoltDivergedError / PostDispatchSyncError -- and this is the ONE
            // phase whose whole job is mutating beads (filing carry-over bugs),
            // so a D-push failure here is a routine outcome, not an exotic one.
            // The divergence classes among them (GitDivergedError, and a
            // DoltDivergedError bare or wrapped in a PostDispatchSyncError) are
            // typed sprint aborts -- isTypedAbortError() returns true for them --
            // so without this catch-all the top-level handler
            // in this file's exported entry point would turn the throw into a
            // terminal `verdict: 'ABORTED'` record -- skipping Harvest AND
            // Publish PR, and discarding the already-computed
            // finalVerdictResult, which is only published after Harvest. A green
            // sprint would be reported as ABORTED because an informational pass
            // could not push a bug bead. Catch broadly; record the failure in the
            // summary instead.
            //
            // Two deliberate exceptions, both RUN-level control signals rather
            // than "the regression phase failed":
            //   - CancelledError: the operator/supervisor cancelled the run.
            //     Honouring cancellation outranks finishing an informational
            //     phase (and isTypedAbortError() already excludes it, so it is
            //     not a spurious ABORT).
            //   - BudgetExceededError: the sprint's hard spend ceiling is
            //     blown. Swallowing it here would let Harvest keep spending
            //     past a limit the operator set. Same treatment it gets at
            //     every other dispatch site in this file.
            if (err instanceof CancelledError || err instanceof BudgetExceededError) {
                throw err;
            }
            if (err instanceof AgentOutputError) {
                log(`Regression Test Runner: schema-repair exhausted, continuing without a regression result: ${err.message}`);
                regressionResult = { passed: false, suitePassed: false, smokePassed: false, bugsFiled: [], summary: `Regression test runner failed to return a schema-valid report after repair attempts: ${err.message}` };
            } else if (err instanceof AgentDispatchError || err instanceof FleetTransportError) {
                log(`Regression Test Runner: agent dispatch failed, continuing without a regression result: ${err.message}`);
                regressionResult = { passed: false, suitePassed: false, smokePassed: false, bugsFiled: [], summary: `Regression test runner dispatch failed: ${err.message}` };
            } else if (isPostDispatchSyncFailure(err) || err instanceof WorkflowError) {
                // Sync/publish failure around an informational phase. The
                // carry-over beads may or may not have reached the shared
                // remote, so say so honestly in the summary rather than
                // reporting a clean "the pass failed", and let the sprint
                // finish normally.
                log(`Regression Test Runner: git/beads sync around the regression dispatch FAILED (${err.name}: ${err.message}). Continuing to Harvest -- this phase is informational and never aborts the sprint. Any carry-over beads it filed may still be local-only; re-check with: bd search "[carry-over]"`);
                regressionResult = { passed: false, suitePassed: false, smokePassed: false, bugsFiled: [], summary: `Regression pass could not be completed: git/beads sync around the dispatch failed (${err.name}: ${err.message}). Any carry-over beads filed may not have reached the shared remote.` };
            } else {
                log(`Regression Test Runner: unexpected error, continuing without a regression result (this phase never aborts the sprint): ${err && err.stack ? err.stack : err}`);
                regressionResult = { passed: false, suitePassed: false, smokePassed: false, bugsFiled: [], summary: `Regression test runner failed with an unexpected error: ${err && err.message ? err.message : String(err)}` };
            }
        }
        await updateDashboard();
    } else {
        log('Skipping Regression Test Phase (no regression-test-playbook.md found, or the probe itself failed -- see prior log line)');
    }

    phase(`Harvest C${finalCycleLabel}`);
    // Wire the harvester's required inputs with real, runner-computed values --
    // see buildAnalysisText()/buildCostAnalysis() above. `branchSlug` (see
    // computeBranchSlug() below) avoids embedding raw `/` characters from a
    // branch name like `feat/fleet-reorg` in the artifact path, which would
    // otherwise create surprise subdirectories. Deliberately no wall-clock
    // timestamp in this path: it must stay identical across two dispatches of
    // the same branch (idempotent re-runs, and the golden-transcript
    // determinism test), and harvester.md Step 1 already overwrites the file at
    // this path if it exists.
    const branchSlug = computeBranchSlug(validated.branch);
    const analysisArtifactFile = `docs/sprint-analysis-${branchSlug}.md`;
    const analysisText = buildAnalysisText({
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
        finalOpenAtGoalCount: finalOpenAtGoal.length,
        regressionResult,
    });
    const costAnalysis = buildCostAnalysis(budget, {
        spend: integTestRunnerSpend,
        dispatchCount: integTestRunnerDispatchCount,
    });
    const harvesterPrompt = buildHarvesterPrompt({
        branch: validated.branch,
        baseBranch: validated.baseBranch,
        targetIssues,
        analysisArtifactFile,
        analysisText,
        costAnalysis,
    });
    let harvesterResult = null;
    // Turn budget for the harvester, with the same-session turn-exhaustion
    // resume below: it writes docs/changelog across the whole epic.
    const HARVESTER_MAX_TURNS = 500;
    const harvesterDispatchOpts = {
        member_name: getMemberForRole('harvester'),
        agentType: 'harvester',
        schema: harvesterReport,
        model: FIXED_ROLE_TIER.harvester,
        // Writes docs/changelog/sprint-analysis across the whole epic,
        // plausibly long-running.
        timeout_s: DISPATCH_TIMEOUT_S,
        max_total_s: DISPATCH_TIMEOUT_S,
        max_turns: HARVESTER_MAX_TURNS,
    };
    try {
        // The harvester is a code-writing role (pushCode: true) alongside the
        // doer -- G-pull before, G-push after so the docs/changelog/
        // sprint-analysis commits it makes are published before anything
        // downstream (Publish PR, below) reads the branch. It ALSO mutates beads
        // (issue-defer of low-priority items), so it must D-push those mutations
        // (pushBeads: true) alongside its git push.
        try {
            harvesterResult = await withGitSync(getMemberForRole('harvester'), true, () => agent(
                harvesterPrompt,
                { ...harvesterDispatchOpts, member_name: getMemberForRole('harvester') }
            ), { pushBeads: true });
        } catch (err) {
            if (err instanceof AgentDispatchError && err.details?.reason === 'max_turns_exhausted') {
                log(`Harvester exhausted its turn limit (max_turns=${HARVESTER_MAX_TURNS}) -- resuming the same session with max_turns=${HARVESTER_MAX_TURNS * 2}.`);
                await memberSessionGuard.killIfAlive(getMemberForRole('harvester'));
                harvesterResult = await withGitSync(getMemberForRole('harvester'), true, () => agent(
                    'Continue your harvest exactly where you left off in this same session -- do not redo docs or changelog sections already written. Finish the remaining updates, commit them, and return your final report now.',
                    {
                        ...harvesterDispatchOpts,
                        member_name: getMemberForRole('harvester'),
                        label: `Harvest (resume, max_turns=${HARVESTER_MAX_TURNS * 2})`,
                        resume: true,
                        max_turns: HARVESTER_MAX_TURNS * 2,
                    }
                ), { pushBeads: true });
            } else {
                throw err;
            }
        }
        // No duplicate log() dump -- see dispatchReview() for why. The file
        // path itself IS worth a line: it is the durable, committed record of
        // the Final Review verdict (and everything else in analysisText) --
        // unlike the verdict object, it survives after this process exits.
        // harvester-output.json declares kb_captures, and until now nothing
        // consumed it: the harvester filled the field and the engine dropped it
        // -- the same "gathered and thrown away" shape kbWork was built to fix
        // for the doer and reviewer. The harvester is a good capturer precisely
        // because it has just read the whole sprint's evidence. Capture only:
        // vetKbWork refuses kb_promotions from any role but the reviewer.
        await kbWork.apply('harvester', kbPriming.folderOf(getMemberForRole('harvester')), harvesterResult);
        if (harvesterResult.status !== 'OK') {
            log(`Harvester reported FAILED: ${harvesterResult.notes}`);
        } else {
            log(`Harvester: wrote sprint analysis (including the Final Review verdict) to ${analysisArtifactFile}.`);
        }
    } catch (err) {
        if (err instanceof AgentOutputError) {
            log(`Harvester: schema-repair exhausted, proceeding without a validated harvester report: ${err.message}`);
        } else if (err instanceof AgentDispatchError || err instanceof FleetTransportError) {
            // Self-heal now: the harvester is the run's last dispatch, but the
            // SAME member/credentials get reused by the next sprint, so an
            // unhealed auth failure here just reproduces there.
            if (isAuthDispatchError(err) && typeof onLlmAuthFailure === 'function') {
                await onLlmAuthFailure({ member: getMemberForRole('harvester'), label: 'Harvester dispatch', error: err.message });
            }
            log(`Harvester: agent dispatch failed, proceeding without a validated harvester report: ${err.message}`);
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
    // The branch push is the LAST step of a sprint that has already done all of
    // its work and computed a final verdict. A transient push failure (a racing
    // writer, a momentarily unreachable remote, a credential refresh in flight)
    // used to throw a CommandError from here, which converted a computed PASS
    // into `verdict: 'ABORTED'` and discarded the whole run's conclusion over a
    // network hiccup at the very end. So: failSoft plus the same short, bounded
    // sync backoff every other push round trip uses, and -- if it STILL will not
    // go through -- log loudly and return the COMPUTED verdict with
    // `pushed: false` rather than destroying it.
    //
    // A persistent failure also skips everything downstream of the push (PR
    // creation on a hosted remote; direct target-issue closure + D-push on a
    // non-hosted one). None of that may run against a branch whose commits
    // never reached the remote: a PR cannot be raised for unpushed work, and
    // closing the sprint's target issue would advertise a completion nobody can
    // see. This is the deliberately MINIMAL hardening -- the pluggable-publish
    // restructure is apra-fleet-647.2, which supersedes it.
    let pushed = false;
    let lastPushError = '';
    for (let attempt = 0; attempt < POST_DISPATCH_SYNC_RETRY_DELAYS_MS.length; attempt++) {
        if (POST_DISPATCH_SYNC_RETRY_DELAYS_MS[attempt] > 0) {
            log(`Publish PR: pushing sprint branch '${validated.branch}' failed; retrying in ${POST_DISPATCH_SYNC_RETRY_DELAYS_MS[attempt] / 1000}s (attempt ${attempt + 1}/${POST_DISPATCH_SYNC_RETRY_DELAYS_MS.length}): ${lastPushError}`);
            if (!mockInstantRetryBackoff()) {
                await new Promise((resolve) => setTimeout(resolve, POST_DISPATCH_SYNC_RETRY_DELAYS_MS[attempt]));
            }
        }
        const pushRes = await command(
            `git push -u origin ${validated.branch}`,
            {
                member_name: orchestratorMember,
                silent: true,
                failSoft: true,
                label: `Push sprint branch '${validated.branch}'`,
            }
        );
        if (pushRes.ok) {
            pushed = true;
            break;
        }
        lastPushError = pushRes.error;
    }
    if (!pushed) {
        log(`[Publish Push Failed] Could not push sprint branch '${validated.branch}' to origin after ${POST_DISPATCH_SYNC_RETRY_DELAYS_MS.length} attempts -- the sprint's work is COMMITTED LOCALLY ONLY and is NOT on the remote. Skipping PR creation and target-issue closure (neither is meaningful for an unpushed branch); the sprint's own computed verdict (${finalVerdictResult.verdict}) is preserved and returned with pushed:false. Push the branch by hand and raise the PR, or re-run finalization once the remote is reachable. Last error: ${lastPushError}`);
        endGroup();
        return {
            status: finalVerdictResult.verdict === 'PASS' ? 'success' : 'failed',
            verdict: finalVerdictResult.verdict,
            notes: finalVerdictResult.notes,
            branch: validated.branch,
            baseBranch: validated.baseBranch,
            goal: validated.goal,
            maxCycles: validated.maxCycles,
            pushed: false,
        };
    }
    // The final verdict is surfaced directly in the PR title and body -- a
    // human reviewer must never have to dig through sprint logs to learn
    // whether the run's own review gate passed. A FAIL verdict still publishes
    // the PR (never suppressed), with the verdict stated plainly so the
    // reviewer can weigh it before merging.
    const finalVerdictLabel = finalVerdictResult.verdict === 'PASS' ? 'PASS' : 'FAIL';

    // Resolve the sprint's own git 'origin' remote and classify it via
    // VCSModule.capabilities() BEFORE ever attempting the VCSModule REST
    // create-pull-request call. A remote whose provider cannot open a PR (a
    // file:// bare mirror, or any other host with no hosting API support)
    // means PR creation can never succeed, and attempting it anyway throws a
    // hard 'gh auth login required'-shaped CommandError that would fail the
    // whole sprint. Resolving the remote is itself failSoft -- an
    // unresolvable remote fails closed to canOpenPullRequest:false, per
    // capabilities()'s own contract -- so a probe hiccup here can never kill
    // the sprint.
    const originUrlRes = await command('git remote get-url origin', {
        member_name: orchestratorMember,
        silent: true,
        failSoft: true,
        label: 'Resolve origin remote URL',
    });
    const originUrl = originUrlRes.ok ? originUrlRes.output.trim() : '';
    const hostedRemote = vcsCapabilities(originUrl).canOpenPullRequest;

    if (!hostedRemote) {
        log(`Publish PR: origin remote '${originUrl || '(unresolved)'}' is not a gh-hostable GitHub remote -- ` +
            'skipping PR creation entirely (no dependency on gh auth / GH_TOKEN for this path).');
        // A non-hosted remote can never complete PR creation, so target-issue
        // closure cannot be gated on it -- close the target issue(s) directly,
        // but only when the sprint's own final verdict actually passed. A FAIL
        // verdict must never be masked by closing the issue anyway; it still
        // ends the sprint 'failed' via the return value below, same as the
        // hosted-remote path.
        if (finalVerdictResult.verdict === 'PASS') {
            for (const id of targetIssues) {
                const closeRes = await command(`bd close ${id}`, {
                    member_name: orchestratorMember,
                    silent: true,
                    failSoft: true,
                    label: `Close target issue '${id}' directly (non-hosted remote, no PR gate)`,
                });
                if (closeRes.ok) {
                    log(`Publish PR: closed target issue '${id}' directly (non-hosted remote, PASS verdict).`);
                } else {
                    log(`Publish PR: failed to close target issue '${id}' directly (non-fatal, continuing): ${closeRes.error}`);
                }
            }
            // (apra-fleet-p2to.4.1) standalone sync bracket -- see openSyncBracketCount's doc comment above.
            await withOpenSyncBracket(() => DoltSync.syncAfter(orchestratorMember, { command, pushBeads: true, log, mutex: doltPushMutex, sprintId: sprintMutexId }));
        } else {
            log('Publish PR: final verdict is FAIL -- leaving target issue(s) open (not closing on a non-PASS verdict).');
        }
    } else {
        // finalVerdictResult.notes is LLM-authored free text -- sanitize with
        // sanitizePrText() (see the comment above its definition) BEFORE it is
        // ever embedded in the VCSModule-built create-pull-request command()
        // string below. validated.goal/validated.branch need no sanitization
        // here: both are already validated against shell-injection-safe patterns
        // (GOAL_PATTERN/BRANCH_NAME_PATTERN) at arg-validation time.
        const prTitle = `Auto-sprint [${finalVerdictLabel}]: ${validated.branch}`;
        const safeNotes = sanitizePrText(finalVerdictResult.notes);
        const prBody = [
            `Automated apra-fleet-se sprint (goal: ${validated.goal}).`,
            '',
            `Final Verdict: ${finalVerdictLabel}`,
            safeNotes ? `Notes: ${safeNotes}` : null,
            '',
            'Do NOT auto-merge -- see pm skill R12; a human must review and merge this PR.',
        ].filter((line) => line !== null).join('\n');

        // Idempotent PR creation via VCSModule (apra-fleet-tfx.8: the reverted
        // gh-based path is gone). A push+pr credential is minted just-in-time immediately
        // before this one call (never at sprint setup, never for any other
        // phase), VCSModule builds the orchestrator-side curl command, and
        // `orchestratorMember` dispatches it via execute_command -- no gh, no
        // server-side fallback. A re-run of finalization against a branch
        // that ALREADY has an open PR from a prior, otherwise-successful run
        // can be told apart from a genuine failure: the REST create-PR call
        // returns 422 "already exists" in that case -- that specific outcome
        // is swallowed (logged, not thrown) because it means the desired end
        // state (a PR is open for this branch) already holds. Any OTHER
        // failure (auth, network, a real API error, the injectable mock
        // failure below) is NOT swallowed -- it is re-raised as a typed
        // CommandError so it surfaces clearly rather than being silently
        // invisible.
        const fleetApiForPr = (args && typeof args.callTool === 'function') ? new ApraFleet({ callTool: args.callTool }) : null;
        if (!fleetApiForPr) {
            // Graceful degradation (apra-fleet-tfx.8.1): minting the push+pr
            // credential VCSModule needs to raise this PR requires an MCP
            // client. When no callTool is wired (e.g. a mock-sprint scenario
            // that never opted into an MCP client), the sprint branch is
            // already pushed by the withGitSync bracket -- so rather than an
            // unconditional hard-throw that would fail every such pre-existing
            // scenario at the very last step, this degrades to a clear,
            // skipped-PR log and lets the sprint report its real verdict. In
            // production callTool is always wired (bin/cli.mjs), so this branch
            // never runs there; it exists purely so PR creation is not a hard
            // MCP dependency for callers that legitimately have none. A genuine
            // PR-creation FAILURE (auth, network, a real API error) still
            // throws below -- only the callTool-absent case is degraded.
            log(`[Publish PR Skipped] no MCP callTool available to mint a push+pr credential for member '${orchestratorMember}' -- branch '${validated.branch}' is pushed but the PR was not raised.`);
        } else {
            const prResult = await raiseVcsPrForMember({
                fleetApi: fleetApiForPr,
                command,
                member: orchestratorMember,
                base: validated.baseBranch,
                head: validated.branch,
                title: prTitle,
                body: prBody,
                log,
                logPrefix: '[Publish PR]',
            });
            if (!prResult.ok) {
                throw new CommandError(
                    `[Publish PR Failed] VCSModule create-pull-request failed for branch '${validated.branch}' -> '${validated.baseBranch}': ${prResult.error}`,
                    { details: { branch: validated.branch, baseBranch: validated.baseBranch, error: prResult.error } }
                );
            }
            if (prResult.alreadyExists) {
                log(`Publish PR: a PR for branch '${validated.branch}' already exists -- treating as idempotent success.`);
            }
        }
    }

    endGroup();

    // The final verdict -- not a blanket, unconditional 'success' -- drives the
    // return value, so a downstream caller (CLI, CI, a human reading the run)
    // can tell a genuinely-passing sprint from one that ran to completion but
    // left goal-priority work open, a deploy failing, or integration tests red.
    return {
        status: finalVerdictResult.verdict === 'PASS' ? 'success' : 'failed',
        verdict: finalVerdictResult.verdict,
        notes: finalVerdictResult.notes,
        branch: validated.branch,
        baseBranch: validated.baseBranch,
        goal: validated.goal,
        maxCycles: validated.maxCycles,
        pushed: true,
    };
}

// ---------------------------------------------------------------------------
// Fatal-diagnostics guard
// ---------------------------------------------------------------------------
//
// main()'s try/catch around runSprintCycle() only ever sees errors that
// propagate up an AWAITED call chain: it can never see a promise that rejects
// with nothing awaiting it, or a synchronous throw that escapes every awaited
// frame. Without this guard such a failure ends the run with no usable signal.
// The guard makes it observable: an explicit [FATAL] line (cause + the last
// phase this run entered) through the run's own log(), plus a best-effort
// publishState('terminal', ...) so a watchdog, dashboard, or human sees a real
// lastError instead of state frozen mid-run with no explanation.
//
// It deliberately does not attempt to recover or continue -- by the time either
// process-level event fires the process's control flow is in an unspecified
// state.
/**
 * @param {{ log?: (msg: string) => void, publishState?: (namespace: string, data: any) => void, phaseOf?: () => string|null }} deps
 * @returns {() => void} uninstall() -- removes both listeners.
 */
export function installFatalDiagnosticsGuard(deps = {}) {
    const log = typeof deps.log === 'function' ? deps.log : () => {};
    const publishState = typeof deps.publishState === 'function' ? deps.publishState : null;
    const phaseOf = typeof deps.phaseOf === 'function' ? deps.phaseOf : () => null;

    const handle = (kind) => (err) => {
        const message = (err && err.message) || String(err);
        const stack = (err && err.stack) || null;
        const phase = phaseOf();
        log(`[FATAL] ${kind} (last known phase: ${phase ?? 'unknown'}): ${message}${stack ? `\n${stack}` : ''}`);
        if (publishState) {
            try {
                publishState('terminal', {
                    verdict: 'ABORTED',
                    failed: true,
                    terminalReason: kind,
                    lastError: { message, stack, phase, kind, at: new Date().toISOString() },
                });
            } catch (publishErr) {
                // Diagnostics reporting itself must never crash harder than the
                // failure it is trying to record -- log and move on.
                log(`[FATAL] ${kind}: failed to persist terminal error state: ${(publishErr && publishErr.message) || publishErr}`);
            }
        }
    };

    const onUnhandledRejection = handle('unhandledRejection');
    const onUncaughtException = handle('uncaughtException');
    process.on('unhandledRejection', onUnhandledRejection);
    process.on('uncaughtException', onUncaughtException);

    return function uninstall() {
        process.off('unhandledRejection', onUnhandledRejection);
        process.off('uncaughtException', onUncaughtException);
    };
}

// ---------------------------------------------------------------------------
// Classify an unmergeable Dolt conflict as its own terminal state
// (BEADS_SYNC_CONFLICT), not the generic wrapper/UNKNOWN bucket -- and
// best-effort carry forward the raw conflict diagnostics an operator would
// otherwise have to re-derive by hand.
// ---------------------------------------------------------------------------

/**
 * Walks a thrown error's `.cause` chain (bounded, so a pathological circular
 * cause can never loop forever) looking for a DoltDivergedError -- either
 * the error itself, or wrapped one level down inside a PostDispatchSyncError
 * (withGitSync's post-dispatch D-push bracket wraps a diverged sync failure
 * this way; see PostDispatchSyncError's own doc comment in errors.mjs). A
 * plain `bd dolt pull` divergence (preflightBeadsHealthGate / doltPullBefore,
 * before any dispatch ever ran) throws DoltDivergedError directly, with no
 * wrapper -- also matched here.
 * @param {unknown} err
 * @returns {import('./errors.mjs').DoltDivergedError|null}
 */
export function findDoltDivergedCause(err) {
    let cur = err;
    for (let depth = 0; cur && depth < 5; depth += 1) {
        if (cur instanceof DoltDivergedError) return cur;
        cur = cur.cause;
    }
    return null;
}

/**
 * The terminal-state `terminalReason` main()'s typed-abort catch persists. A
 * genuinely unmergeable Dolt conflict -- surfaced either directly (a
 * pre-dispatch `bd dolt pull` divergence) or wrapped inside a
 * PostDispatchSyncError (a D-push divergence discovered AFTER a dispatch
 * already completed) -- is reported as the distinct 'BEADS_SYNC_CONFLICT', so
 * the supervisor/dashboard shows "beads sync conflict, needs operator
 * resolution" instead of collapsing it into the same generic bucket as every
 * other termination reason. Every other error keeps the
 * `err.code || err.name || 'UNKNOWN_ABORT'` behavior.
 * @param {unknown} err
 * @returns {string}
 */
export function resolveTerminalReason(err) {
    if (findDoltDivergedCause(err)) return 'BEADS_SYNC_CONFLICT';
    return (err && (err.code || err.name)) || 'UNKNOWN_ABORT';
}

/**
 * Best-effort diagnostics for a BEADS_SYNC_CONFLICT terminal state -- the raw
 * `bd dolt pull`/`bd dolt push` stderr
 * (DoltDivergedError.doltOutput) that proved the divergence, captured at the
 * moment `runDoltStep()` observed the failure (i.e. BEFORE any later `bd`
 * invocation's own safe-abort/cleanup could discard whatever state it was
 * describing) and carried on the error object ever since. This is pure
 * plumbing of already-captured data through to the terminal state -- no new
 * `bd`/SQL command is issued here -- so a human resolving the conflict later
 * starts with the actual rejection text in hand instead of having to
 * reproduce it by re-running `bd dolt pull`/`dolt merge --no-commit`
 * themselves. Returns `null` (never throws) when `err` carries no
 * DoltDivergedError cause.
 * @param {unknown} err
 * @returns {{ member: string|null, operation: string|null, doltOutput: string|null }|null}
 */
export function captureDoltConflictDump(err) {
    const diverged = findDoltDivergedCause(err);
    if (!diverged) return null;
    return {
        member: diverged.member ?? null,
        operation: diverged.operation ?? null,
        doltOutput: diverged.doltOutput ?? null,
    };
}

// ---------------------------------------------------------------------------
// Engine entry point + typed-abort routing
// ---------------------------------------------------------------------------
//
// `main()` is the WorkflowEngine entry point: it runs the sprint and routes a
// failure through TWO independent decisions (see isTerminalSprintFailure() vs
// isTypedAbortError() above for why they are not the same question):
//   - isTerminalSprintFailure(): write a terminal history record, so the
//     supervisor watchdog reports the run as FINISHED-with-a-reason rather
//     than CRASHED;
//   - isTypedAbortError(): additionally route through finalizeAbort() (push +
//     idempotent [ABORTED] PR iff the branch carries real work beyond base).
// Re-throwing (rather than swallowing) is deliberate: it keeps
// bin/cli.mjs's top-level catch -- console.error, exit code 1, and the
// dashboard grace window -- unchanged; this function only adds work that
// happens BEFORE the error reaches that catch.
//
// A non-terminal error (isTerminalSprintFailure() === false: CancelledError
// from a cooperative /stop, or an untyped Error/TypeError -- a real bug) is
// re-thrown immediately with no finalizeAbort()/history-record side effects.
export async function main(context) {
    const { command, log = () => {}, publishState, phase: rawPhase, args } = context;

    // Validate args and acquire a machine-local pidfile lock keyed on
    // (branch, members) BEFORE any dispatch -- a duplicate concurrent engine
    // start for the SAME sprint must fail fast with a named
    // SprintLockHeldError instead of silently running two engines against
    // the same shared git branch/beads DB. validateArgs() is pure, so
    // running it here ahead of runSprintCycle()'s own call changes nothing
    // for invalid args except failing one call frame higher.
    const validatedForLock = validateArgs(args);
    const sprintLock = acquireSprintLock({ branch: validatedForLock.branch, members: validatedForLock.members });

    // apra-fleet-5d5.1: the SAME reactive git/dolt credential self-heal
    // callback runSprintCycle wires into every withGitSync bracket (see its
    // own onAuthFailure precedence comment above) -- computed here too so
    // finalizeAbort()'s own git ops (fetch/rev-list/push, ~line 4562) get the
    // identical provision_vcs_auth self-heal-and-retry-once treatment instead
    // of silently swallowing a mid-abort auth failure with no self-heal.
    //   1. `context.onAuthFailure` -- an explicitly-injected callback (tests
    //      wire an in-process one to prove the self-heal fires without a live
    //      fleet server).
    //   2. `args.callTool` -- the real provision_vcs_auth self-heal via
    //      createVcsAuthSelfHealCallback.
    //   3. neither -- undefined: an 'auth'-classified failure falls straight
    //      through to finalizeAbort()'s existing throw-and-fall-back path.
    const abortOnAuthFailure = context.onAuthFailure ?? (
        (args && typeof args.callTool === 'function')
            ? createVcsAuthSelfHealCallback({ callTool: args.callTool, command, log })
            : undefined
    );

    // Track the last phase this run entered by wrapping context.phase, so a
    // fatal diagnostic can name the phase instead of just "somewhere".
    let lastPhaseTitle = null;
    const phase = typeof rawPhase === 'function'
        ? (title) => { lastPhaseTitle = title; return rawPhase(title); }
        : rawPhase;
    const runContext = { ...context, phase };

    const uninstallFatalGuard = installFatalDiagnosticsGuard({
        log,
        publishState,
        phaseOf: () => lastPhaseTitle,
    });

    try {
        return await runSprintCycle(runContext);
    } catch (err) {
        if (!isTerminalSprintFailure(err)) {
            throw err;
        }

        // Args were already validated at entry (validatedForLock), so the
        // branch/baseBranch/member for the abort record are always
        // resolvable; only finalizeAbort() itself can still fail here.
        const branch = validatedForLock.branch;
        const baseBranch = validatedForLock.baseBranch;
        let abortResult = { prUrl: null, pushed: false, commitCount: 0 };
        // Only a typed sprint ABORT earns the branch push + [ABORTED] PR. The
        // discriminator is RECOVERABILITY, not whether there is work to show
        // (finalizeAbort already publishes nothing at zero commits beyond
        // base): a dispatch failure or a sync failure that outlived its retries
        // is fixed by re-running the sprint, which pushes any local work then,
        // whereas a stall / budget / reviewer-contract / unmergeable-divergence
        // abort will never self-resolve, so the [ABORTED] PR is the only
        // artifact a human gets. Both still get the terminal record below --
        // the watchdog needs a reason either way.
        if (isTypedAbortError(err)) {
            try {
                const member = (validatedForLock.roleMap && validatedForLock.roleMap[ROLE_ORCHESTRATOR] && validatedForLock.roleMap[ROLE_ORCHESTRATOR].length > 0)
                    ? validatedForLock.roleMap[ROLE_ORCHESTRATOR][0]
                    : validatedForLock.members[0];
                abortResult = await finalizeAbort({
                    error: err,
                    branch,
                    baseBranch,
                    member,
                    command,
                    log,
                    onAuthFailure: abortOnAuthFailure,
                    callTool: (args && typeof args.callTool === 'function') ? args.callTool : undefined,
                });
            } catch (finalizeErr) {
                log(
                    `[Terminal History] finalizeAbort() failed for this abort ` +
                    `(${finalizeErr.message}); writing the terminal history record with no PR lookup.`
                );
            }
        }

        // Always write a terminal history record, even for a zero-commit
        // abort (only the PR itself is conditional on there being real work
        // to publish).
        if (typeof publishState === 'function') {
            // An unmergeable Dolt conflict is reported as its own distinct
            // BEADS_SYNC_CONFLICT terminal state (not the generic
            // wrapper/UNKNOWN bucket), with the raw conflict diagnostics already
            // captured on the error carried alongside it so an operator
            // resolving it starts with the actual rejection text in hand -- see
            // resolveTerminalReason()/captureDoltConflictDump() above.
            const conflictDump = captureDoltConflictDump(err);
            publishState('terminal', {
                verdict: 'ABORTED',
                terminalReason: resolveTerminalReason(err),
                message: (err && err.message) || null,
                branch,
                baseBranch,
                prUrl: abortResult.prUrl,
                pushed: abortResult.pushed,
                commitCount: abortResult.commitCount,
                ...(conflictDump ? { conflictDump } : {}),
            });
        }

        throw err;
    } finally {
        uninstallFatalGuard();
        // Always release the sprint lock, on every exit path (success, typed
        // abort, or an untyped re-thrown error) -- a lock never released here
        // would falsely block every future launch of this exact sprint
        // (branch+members) until acquireSprintLock()'s own dead-pid reclaim
        // kicks in on a LATER attempt.
        sprintLock.release();
    }
}
