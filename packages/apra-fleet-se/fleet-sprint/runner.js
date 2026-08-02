import fs from 'fs/promises';
import { createHash } from 'crypto';
import { AgentOutputError, AgentDispatchError, FleetTransportError, CommandError, WorkflowError, BudgetExceededError, CancelledError } from '@apralabs/apra-fleet-workflow';
import {
    ROLES, normalizeRole, planReviewerVerdict, doerReport, reviewerVerdict, streakAssignment,
    deployerReport, integReport, regressionReport, finalVerdict, harvesterReport, wrapUntrustedBlock,
} from './contracts.mjs';
import { SprintPlanRejectedError, StalledSprintError, ReviewerContractViolationError, GitDivergedError, GitSyncError, DoltDivergedError, DoltSyncError, PostDispatchSyncError, PlanReviewDispatchFailedError, isNonRetryableDispatchError, isAuthDispatchError, isInfraDispatchFailure, isPostDispatchSyncFailure } from './errors.mjs';

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
import { acquireSprintLock } from './sprint-lock.mjs';

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

// Backlog panel (dashboard "Backlog" section): beads the sprint certainly will
// NOT be addressing this run. Excludes 'closed' (done, not backlog) and
// 'in_progress' (actively being worked, possibly by a concurrent sprint -- a
// meaningfully different state from idle backlog). 'blocked' IS included: a
// bead gated on an unresolved dependency is as certainly "not being addressed
// this run" as an untouched 'open' or 'deferred' one. Deliberately
// project-wide (no --parent filter) so the user sees the true state of
// unplanned/idle work, including beads unrelated to the target epic.
// Quoted for the same reason as NOT_DONE_STATUSES above.
const BACKLOG_STATUSES = '"open,deferred,blocked"';

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
                if (!p.doltOk) reasons.push(`bd dolt pull probe failed (${p.doltError})`);
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
                    '. In synced mode every member must report the same origin URL AND pass a `bd dolt pull` probe. ' +
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
                '[Topology] Refusing to start the multi-member sprint: the configured members disagree on their identity ' +
                'signal, so they are NOT operating on a shared workspace. This runner has no cross-member bd/git sync layer ' +
                'this round, so the orchestrator-side beads DB and the sprint git branch would not be visible to the other ' +
                'members (their `bd close`/commits would silently diverge). Per-member signals: ' +
                identities.map((i) => `${i.member}=${i.signal}`).join(', ') +
                '. Supported modes: single-member, or a verified shared-workspace fleet (all members resolve to the same ' +
                'checkout/DB). See docs/architecture.md "Multi-member topology (fleet-sprint)".',
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

// Substrings that mark a git failure as a DIVERGENCE (non-FF / unmerged /
// conflict). Never retried -- see the single-writer stance above.
const GIT_DIVERGED_PATTERNS = [
    /not possible to fast-forward/i,
    /non-fast-forward/i,
    /fast-forwards? are not allowed/i,
    /\[rejected\]/i,
    /failed to push some refs/i,
    /updates were rejected/i,
    /unmerged/i,
    /needs merge/i,
    /would be overwritten/i,
    /^conflict/im,
    /automatic merge failed/i,
    /have diverged/i,
];

// Substrings that mark a git failure as an AUTH (credential) failure -- the
// member's provisioned VCS token/credential has expired or is otherwise
// rejected by the remote. Distinct from 'transient' (network/lock blips a plain
// retry can resolve): retrying an auth failure without re-provisioning
// credentials first can never succeed. Auth is therefore classified BEFORE
// 'transient', so an auth failure is never blindly retried -- but AFTER
// 'diverged', which must never be misclassified.
const GIT_AUTH_PATTERNS = [
    /could not read Username for/i,
    /could not read Password for/i,
    /Authentication failed/i,
    /Permission denied \(publickey\)/i,
    /remote: Invalid username or (token|password)/i,
    /terminal prompts disabled/i,
    /support for password authentication was removed/i,
    /Bad credentials/i,
];

// Substrings that mark a git failure as TRANSIENT (network / lock) -- safe to
// retry a bounded number of times.
const GIT_TRANSIENT_PATTERNS = [
    /could not resolve host/i,
    /unable to access/i,
    /connection (timed out|reset|refused)/i,
    /operation timed out/i,
    /\btimed out\b/i,
    /\btimeout\b/i,
    /temporary failure/i,
    /early eof/i,
    /rpc failed/i,
    /the remote end hung up/i,
    /index\.lock/i,
    /unable to create '.*lock'/i,
    /cannot lock ref/i,
    /ssh_exchange_identification/i,
    // A failSoft command() resolves a FleetTransportError (client <->
    // fleet-server connection blip, e.g. undici 'fetch failed' on a dead
    // pooled socket) into its error string. That is a transient failure of the
    // DISPATCH CHANNEL, not a git failure, and must be retried rather than
    // classified 'unknown' (which is never retried, and is sprint-fatal here).
    /transport failure while executing command/i,
    /fetch failed/i,
];

/**
 * Classify a failed git command's output into the failure classes the sync
 * brackets route differently. Divergence is checked FIRST: a non-FF/unmerged
 * state must never be misread as transient/auth and retried blindly, even if
 * its message also contains a lock/network/credential word. 'auth' is checked
 * NEXT, before 'transient': a credential failure is not a network/lock blip,
 * and retrying it without re-provisioning credentials first cannot succeed.
 *
 * @param {string} output - the raw git stderr/stdout of the failed command
 * @returns {'diverged'|'auth'|'transient'|'unknown'}
 */
export function classifyGitFailure(output) {
    const text = String(output == null ? '' : output);
    for (const re of GIT_DIVERGED_PATTERNS) if (re.test(text)) return 'diverged';
    for (const re of GIT_AUTH_PATTERNS) if (re.test(text)) return 'auth';
    for (const re of GIT_TRANSIENT_PATTERNS) if (re.test(text)) return 'transient';
    return 'unknown';
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
 * @returns {Promise<{ ok: boolean, output: string, error: string|null, kind?: 'diverged'|'auth'|'transient'|'unknown' }>}
 */
async function runGitStep({ command, member, cmd, label, log, maxTransientRetries, onAuthFailure }) {
    let attempt = 0;
    let authHealAttempted = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const res = await command(cmd, { member_name: member, silent: true, failSoft: true, label });
        if (res && res.ok) return res;
        const error = res ? res.error : 'unknown command failure';
        const kind = classifyGitFailure(error);
        if (kind === 'transient' && attempt < maxTransientRetries) {
            attempt += 1;
            log(`[Sync] transient git failure for member '${member}' (${label}); retry ${attempt}/${maxTransientRetries}: ${error}`);
            continue;
        }
        if (kind === 'auth' && typeof onAuthFailure === 'function' && !authHealAttempted) {
            authHealAttempted = true;
            log(`[Sync] auth git failure for member '${member}' (${label}); invoking self-heal (provision_vcs_auth) once before a single bounded retry: ${error}`);
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
 * @param {string} member
 * @param {{ command: Function, log?: Function, maxTransientRetries?: number, remote?: string, branch?: string, onAuthFailure?: Function, resetToRemoteTip?: boolean }} opts
 * @returns {Promise<{ ok: true, member: string }>}
 */
export async function syncMemberBefore(member, opts = {}) {
    const { command, log = () => {}, maxTransientRetries = 1, remote = 'origin', branch, onAuthFailure, resetToRemoteTip = false } = opts;
    if (typeof command !== 'function') {
        throw new Error("syncMemberBefore requires an injected command() in opts");
    }

    const fetchCmd = branch ? `git fetch ${remote} ${branch}` : `git fetch ${remote}`;
    const fetch = await runGitStep({
        command, member, cmd: fetchCmd,
        label: `G-pull fetch for '${member}'`, log, maxTransientRetries, onAuthFailure,
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
            label: `G-pull reset-to-remote-tip for '${member}'`, log, maxTransientRetries, onAuthFailure,
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
        label: `G-pull ff-only merge for '${member}'`, log, maxTransientRetries, onAuthFailure,
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
 * @param {string} member
 * @param {{
 *   command: Function, pushCode?: boolean, log?: Function,
 *   maxTransientRetries?: number, remote?: string, branch?: string,
 *   agent?: Function, resolveConflictModel?: string, onAuthFailure?: Function,
 * }} opts
 * @returns {Promise<{ ok: true, member: string, pushed: boolean, rebased: boolean, tier2Resolved?: boolean }>}
 */
export async function syncMemberAfter(member, opts = {}) {
    const {
        command, pushCode = true, log = () => {}, maxTransientRetries = 1, remote = 'origin', branch,
        agent, resolveConflictModel, onAuthFailure,
    } = opts;
    if (typeof command !== 'function') {
        throw new Error("syncMemberAfter requires an injected command() in opts");
    }

    if (!pushCode) {
        return { ok: true, member, pushed: false, rebased: false };
    }

    const pushCmd = branch ? `git push ${remote} ${branch}` : 'git push';

    let push = await runGitStep({
        command, member, cmd: pushCmd,
        label: `G-push for '${member}'`, log, maxTransientRetries, onAuthFailure,
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
        label: `G-push pull-rebase retry for '${member}'`, log, maxTransientRetries, onAuthFailure,
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
                    label: `G-push after Tier 2 conflict resolution for '${member}'`, log, maxTransientRetries, onAuthFailure,
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
        label: `G-push re-push after rebase for '${member}'`, log, maxTransientRetries, onAuthFailure,
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
// Dolt sync brackets: D-pull / D-push
// ---------------------------------------------------------------------------
//
// The beads database is a Dolt database that every member syncs through a
// shared remote, orthogonally to the git code branch. Where the git brackets
// keep each member's *code checkout* current, these keep each member's *beads
// clone* current: a D-pull before every dispatch/read that consumes beads
// state, and a D-push after every step that mutates it.
//
// The most divergence-sensitive read in this file is the orchestrator's
// post-streak `bd show` verification (see verifyDoerStreakClosed below): a
// remote doer closes its beads in ITS OWN clone and D-pushes them, so without
// an orchestrator-side D-pull immediately before that read the orchestrator
// reads its own stale (still-open) copy and falsely marks every remote doer
// streak FAILED.
//
// Conflict policy, deliberately NOT per-conflict judgment: D-push is
// first-successful-pusher-wins. A member whose push is rejected is the loser
// and reconciles MECHANICALLY -- it D-pulls the winner's state (ours/theirs
// fixed by which clone is resolving, never a human/LLM decision) then re-pushes
// exactly once. A divergence that outlives that one bounded reconcile is a hard
// DoltDivergedError, never retried blindly -- the mirror of the git
// single-writer stance.
//
// Every `bd dolt` command is issued via the injected command() with an explicit
// member_name -- agents never sync beads themselves; the orchestrator brackets
// each dispatch. `command` is dependency-injected so unit tests can drive these
// helpers with a mock command() and no live Dolt server.

// Substrings that mark a `bd dolt` failure as NO-REMOTE: this local beads clone
// has no configured dolt remote at all (e.g. a temp fixture repo with no
// 'origin'), so there is nothing to pull or push. This is a benign, non-error
// condition -- distinct from both a genuine divergence and a transient
// network/server hiccup -- and is checked FIRST so its text always wins. A
// remote that IS configured but unreachable/diverged/auth-failing never matches
// these patterns and still falls through to the diverged/transient/unknown
// classification.
const DOLT_NO_REMOTE_PATTERNS = [
    /error 1105.*no remote/i,
    /\bno remote\b/i,
];

// Substrings that mark a `bd dolt pull` failure as an EMPTY-REMOTE: the
// sync.remote IS configured (unlike no-remote above) but has never had anything
// pushed into it -- e.g. a sync.remote derived from a bare git-only mirror that
// Dolt itself has never pushed a branch into. Distinct from BOTH no-remote
// (nothing configured at all) and a genuine divergence/conflict (something IS
// there, but disagrees with the local clone): a remote with zero branches has
// nothing to reconcile, so pulling it is a benign no-op, not a fatal sync
// failure. Matched on Dolt's specific Error 1105 wording so it can never
// swallow a real pull failure that merely mentions "remote", and checked before
// the diverged/transient patterns for the same reason as
// DOLT_NO_REMOTE_PATTERNS.
const DOLT_EMPTY_REMOTE_PATTERNS = [
    /error 1105.*no branches found in remote/i,
    /no branches found in remote/i,
];

// Substrings that mark a `bd dolt` failure as a DIVERGENCE (the remote moved
// under us / a data or merge conflict). Reconciled once by the push loser, or
// surfaced as DoltDivergedError -- never retried blindly.
const DOLT_DIVERGED_PATTERNS = [
    /conflict/i,
    /would (be )?overwrit/i,
    /cannot fast[- ]forward/i,
    /not possible to fast[- ]forward/i,
    /non-fast-forward/i,
    /\[rejected\]/i,
    /failed to push/i,
    /updates were rejected/i,
    /remote (is )?ahead/i,
    /behind the remote/i,
    /not up[- ]to[- ]date/i,
    /have diverged/i,
    /merge (is )?required/i,
    /working set (is )?not clean/i,
];

// Substrings that mark a `bd dolt` failure as an AUTH (credential) failure --
// mirrors GIT_AUTH_PATTERNS above. `bd dolt push` shells out to git under the
// hood, so it surfaces the same credential-prompt text a plain git push does.
// Checked after 'diverged' (which must never be misclassified) but before
// 'transient', so an auth failure is never blindly retried without
// re-provisioning credentials first.
const DOLT_AUTH_PATTERNS = [
    /could not read Username for/i,
    /could not read Password for/i,
    /Authentication failed/i,
    /Permission denied \(publickey\)/i,
    /remote: Invalid username or (token|password)/i,
    /terminal prompts disabled/i,
    /support for password authentication was removed/i,
    /Bad credentials/i,
];

// Substrings that mark a `bd dolt` failure as TRANSIENT (network / server /
// lock) -- safe to retry a bounded number of times.
const DOLT_TRANSIENT_PATTERNS = [
    /could not resolve host/i,
    /unable to (access|connect)/i,
    /connection (timed out|reset|refused)/i,
    /operation timed out/i,
    /\btimed out\b/i,
    /\btimeout\b/i,
    /temporary failure/i,
    /early eof/i,
    /rpc failed/i,
    /the remote end hung up/i,
    /server (is )?(starting|not ready|unavailable)/i,
    /connection refused/i,
    /dial tcp/i,
    /i\/o timeout/i,
    /database is locked/i,
    /lock/i,
];

// Substrings that mark a `bd dolt` failure as REMOTE-UNREACHABLE: the
// configured sync remote itself cannot be opened (deleted directory behind a
// file:// remote, dead path, missing remote db). Distinct from 'transient'
// (retrying cannot help: the target is gone, not busy) and from 'no-remote'
// (here a remote IS configured, it just points at nothing). Checked before
// 'diverged'/'transient' so a stat/open failure is never misread as a conflict
// or retried blindly.
const DOLT_REMOTE_UNREACHABLE_PATTERNS = [
    /could not be accessed/i,
    /failed to get remote db/i,
    /stat [^:]+: no such file or directory/i,
];

/**
 * Best-effort extraction of the remote URL named in a remote-unreachable
 * `bd dolt` failure, for the named diagnosis message. Returns null when the
 * output carries no recognizable URL.
 *
 * @param {string} output - the raw stderr/stdout of the failed `bd dolt` command
 * @returns {string|null}
 */
export function extractDoltRemoteUrl(output) {
    const text = String(output == null ? '' : output);
    const quoted = text.match(/the remote: \S+ '([^']+)' could not be accessed/i);
    if (quoted) return quoted[1];
    const scheme = text.match(/(?:file|https?|git\+https?|ssh):\/\/[^\s'"]+/i);
    if (scheme) return scheme[0];
    return null;
}

/**
 * Classify a failed `bd dolt` command's output into the failure classes the
 * Dolt brackets route differently. no-remote is checked FIRST: a local clone
 * with no configured dolt remote has nothing to pull/push, which is a benign
 * skip, never a divergence or a retryable transient failure. empty-remote (a
 * configured sync.remote with zero branches ever pushed into it) and
 * remote-unreachable (a configured remote that cannot be opened at all) are
 * checked next, for the same reason. Divergence follows: a remote-moved/conflict state
 * must never be misread as transient and retried blindly, even if its message
 * also contains a lock/network word. 'auth' is checked after 'diverged' but
 * before 'transient', same ordering rationale as classifyGitFailure -- a
 * credential failure must never be misread as a conflict, and retrying it
 * without re-provisioning credentials cannot succeed.
 *
 * @param {string} output - the raw stderr/stdout of the failed `bd dolt` command
 * @returns {'no-remote'|'empty-remote'|'remote-unreachable'|'diverged'|'auth'|'transient'|'unknown'}
 */
export function classifyDoltFailure(output) {
    const text = String(output == null ? '' : output);
    for (const re of DOLT_NO_REMOTE_PATTERNS) if (re.test(text)) return 'no-remote';
    for (const re of DOLT_EMPTY_REMOTE_PATTERNS) if (re.test(text)) return 'empty-remote';
    for (const re of DOLT_REMOTE_UNREACHABLE_PATTERNS) if (re.test(text)) return 'remote-unreachable';
    for (const re of DOLT_DIVERGED_PATTERNS) if (re.test(text)) return 'diverged';
    for (const re of DOLT_AUTH_PATTERNS) if (re.test(text)) return 'auth';
    for (const re of DOLT_TRANSIENT_PATTERNS) if (re.test(text)) return 'transient';
    return 'unknown';
}

/**
 * Query whether `member`'s bd-level `sync.remote` setting is currently
 * configured.
 *
 * Deliberately independent of Dolt's raw remote wiring and of
 * classifyDoltFailure's stderr pattern matching: a miswired Dolt-level remote
 * can still make a real `bd dolt push` attempt and fail with a credentials
 * error that classifies as 'auth' rather than 'no-remote', even when the
 * bd-level sync.remote for this clone is neutralized and nothing is supposed to
 * be pushed. Consulting the bd-level setting directly closes that gap
 * regardless of what Dolt's own remote list says.
 *
 * Uses `bd config get sync.remote --json` via the injected command() with an
 * explicit member_name, rather than reading config.yaml off disk, because
 * command() is the only member-scoped I/O this runner has -- a member's clone
 * is not assumed to be locally readable.
 *
 * Fails CLOSED: a failed command(), a failSoft error result, or output that
 * cannot be positively parsed as `{ value: '' }` is all treated as CONFIGURED
 * (returns true). "Not configured" is only ever reported on a positively
 * confirmed empty `value` from a clean JSON parse, because a false positive
 * here would silently swallow a genuine D-push failure on a real,
 * actively-synced clone.
 *
 * @param {string} member
 * @param {{ command: Function, log?: Function }} opts
 * @returns {Promise<boolean>}
 */
export async function isMemberSyncRemoteConfigured(member, opts) {
    const { command, log = () => {} } = opts;
    let res;
    try {
        res = await command('bd config get sync.remote --json', { member_name: member, silent: true, failSoft: true });
    } catch (err) {
        log(`[Dolt] could not query bd-level sync.remote for member '${member}' (fail-safe: treating as configured): ${err.message}`);
        return true;
    }
    if (res && typeof res === 'object' && res.ok === false) {
        log(`[Dolt] 'bd config get sync.remote' failed for member '${member}' (fail-safe: treating as configured): ${res.error}`);
        return true;
    }
    const output = res && typeof res === 'object' ? res.output : res;
    if (!output) {
        // No output to positively parse (e.g. a no-op/unmocked command()):
        // sync.remote cannot be confirmed absent, so do not treat it as
        // neutralized.
        return true;
    }
    try {
        const parsed = JSON.parse(output);
        return !(typeof parsed.value === 'string' && parsed.value.trim().length === 0);
    } catch (err) {
        log(`[Dolt] could not parse 'bd config get sync.remote --json' output for member '${member}' (fail-safe: treating as configured): ${err.message}`);
        return true;
    }
}

/**
 * Run a single `bd dolt` command via the injected command() with failSoft,
 * retrying ONLY transient failures up to `maxTransientRetries` times. A
 * diverged (or unknown) failure is returned immediately, never retried.
 *
 * AUTH SELF-HEAL CONTRACT (the optional `onAuthFailure` param, threaded
 * through by every caller below): a DISTINCT, bounded one-shot path, never
 * folded into the `maxTransientRetries` loop. On an 'auth' classification (see
 * classifyDoltFailure), `onAuthFailure` is called at most ONCE, and if it
 * resolves without throwing the same `bd dolt` command is retried exactly once
 * more. If `onAuthFailure` throws, or is omitted, the failed result is
 * returned to the caller as-is.
 *
 * @returns {Promise<{ ok: boolean, output: string, error: string|null, kind?: 'no-remote'|'empty-remote'|'remote-unreachable'|'diverged'|'auth'|'transient'|'unknown' }>}
 */
async function runDoltStep({ command, member, cmd, label, log, maxTransientRetries, onAuthFailure }) {
    let attempt = 0;
    let authHealAttempted = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const res = await command(cmd, { member_name: member, silent: true, failSoft: true, label });
        if (res && res.ok) return res;
        const error = res ? res.error : 'unknown command failure';
        const kind = classifyDoltFailure(error);
        if (kind === 'transient' && attempt < maxTransientRetries) {
            attempt += 1;
            log(`[Dolt] transient failure for member '${member}' (${label}); retry ${attempt}/${maxTransientRetries}: ${error}`);
            continue;
        }
        if (kind === 'auth' && typeof onAuthFailure === 'function' && !authHealAttempted) {
            authHealAttempted = true;
            log(`[Dolt] auth failure for member '${member}' (${label}); invoking self-heal (provision_vcs_auth) once before a single bounded retry: ${error}`);
            try {
                await onAuthFailure({ member, label, cmd, error, kind: 'dolt' });
            } catch (healErr) {
                log(`[Dolt] self-heal for member '${member}' (${label}) failed; not retrying further: ${healErr.message}`);
                return { ok: false, output: res ? res.output : '', error, kind };
            }
            log(`[Dolt] self-heal for member '${member}' (${label}) completed; retrying the failed dolt command once.`);
            continue;
        }
        return { ok: false, output: res ? res.output : '', error, kind };
    }
}

/**
 * D-pull: bring `member`'s beads clone up to the shared remote before it reads
 * or is dispatched -- `bd dolt pull`. Transient (network / server / lock)
 * failures are retried up to `maxTransientRetries`; a divergence (a conflict
 * that a plain pull cannot fast-forward) is a distinct typed
 * DoltDivergedError, never retried blindly. Every command is issued via the
 * injected command() with an explicit member_name.
 *
 * The pull is PRE-GATED on the member's own bd-level `sync.remote`: a clone
 * whose sync.remote is positively confirmed absent issues no `bd dolt`
 * command at all, because bd auto-provisions a Dolt-level remote from git's
 * own origin as a side effect of any `bd dolt` invocation that needs one --
 * an ungated pull would therefore re-arm a remote a sandbox had deliberately
 * neutralized. The gate fails CLOSED (isMemberSyncRemoteConfigured reports
 * "not configured" only on a positively-confirmed empty value; any
 * inconclusive read lets the pull proceed), so a real, actively-synced clone
 * is never suppressed. Override the check with
 * `opts.checkSyncRemoteConfigured` (same test hook doltPushAfter exposes).
 *
 * Two distinct benign no-op skips return `{ ok: true, skipped: true }` rather
 * than throwing: `reason: 'no-remote'` (no dolt remote configured -- nothing
 * to pull) and `reason: 'empty-remote'` (a configured remote that has never
 * had anything pushed into it, i.e. Dolt's "no branches found in remote"
 * Error 1105 -- nothing to reconcile). `skipPull: true` skips the actual `bd
 * dolt pull` spawn while still running the sync.remote pre-gate probe, and
 * returns `reason: 'already-fresh'`; callers may only set it where the
 * clone's freshness is already established, since it trades a redundant (and,
 * against a slow or unreachable remote, hang-prone) pull for that assumption.
 *
 * `onAuthFailure` is threaded through to runDoltStep -- see its AUTH SELF-HEAL
 * CONTRACT.
 *
 * @param {string} member
 * @param {{ command: Function, log?: Function, maxTransientRetries?: number, checkSyncRemoteConfigured?: Function, skipPull?: boolean, onAuthFailure?: Function }} opts
 * @returns {Promise<{ ok: true, member: string, skipped?: true, reason?: 'no-remote'|'empty-remote'|'already-fresh' }>}
 */
export async function doltPullBefore(member, opts = {}) {
    const { command, log = () => {}, maxTransientRetries = 1, checkSyncRemoteConfigured, skipPull = false, onAuthFailure } = opts;
    if (typeof command !== 'function') {
        throw new Error("doltPullBefore requires an injected command() in opts");
    }

    // Gate BEFORE issuing, so a neutralized clone never lets `bd dolt` re-arm
    // a Dolt-level remote as a side effect (see the doc comment above).
    const preGateCheckFn = checkSyncRemoteConfigured || isMemberSyncRemoteConfigured;
    if (!(await preGateCheckFn(member, { command, log }))) {
        log(`[Dolt] D-pull for member '${member}' skipped pre-attempt: bd-level sync.remote neutralized/absent -- no pull command issued`);
        return { ok: true, member, skipped: true, reason: 'no-remote' };
    }

    // skipPull suppresses only the `bd dolt pull` SPAWN; the pre-gate probe
    // above still runs, so a sync.remote-absent clone issues an identical
    // command sequence with or without this flag.
    if (skipPull) {
        log(`[Dolt] D-pull for member '${member}': skipping the 'bd dolt pull' spawn (beads clone already freshened by the orchestrator's pre-sprint D-pull, nothing mutated since -- first Planner dispatch).`);
        return { ok: true, member, skipped: true, reason: 'already-fresh' };
    }

    const pull = await runDoltStep({
        command, member, cmd: 'bd dolt pull',
        label: `D-pull for '${member}'`, log, maxTransientRetries, onAuthFailure,
    });
    if (!pull.ok) {
        if (pull.kind === 'no-remote') {
            log(`[Dolt] D-pull for member '${member}' skipped: no dolt remote configured (nothing to pull)`);
            return { ok: true, member, skipped: true, reason: 'no-remote' };
        }
        if (pull.kind === 'empty-remote') {
            // sync.remote IS configured but has never had anything pushed
            // into it -- nothing to reconcile, so this is a benign no-op, not
            // a divergence. Genuine conflicts still fall through to the
            // DoltDivergedError branch below.
            log(`[Dolt] D-pull for member '${member}' skipped: dolt remote has zero branches (nothing pushed yet, nothing to pull)`);
            return { ok: true, member, skipped: true, reason: 'empty-remote' };
        }
        if (pull.kind === 'diverged') {
            throw new DoltDivergedError(
                `[Dolt] D-pull for member '${member}' hit an unmergeable beads conflict and must not be auto-resolved by judgment: ${pull.error}`,
                { member, doltOutput: pull.error, operation: 'pull' },
            );
        }
        if (pull.kind === 'remote-unreachable') {
            const url = extractDoltRemoteUrl(pull.error);
            throw new DoltSyncError(
                `[Dolt] member '${member}' beads sync remote is unreachable/misconfigured${url ? ` (${url})` : ''} -- the clone's sync.remote points at a path or URL that cannot be opened (e.g. a deleted test sandbox). Repair the member's .beads sync remote before re-running; retrying cannot succeed. Raw: ${pull.error}`,
                { member, doltOutput: pull.error, remoteUrl: url },
            );
        }
        throw new DoltSyncError(
            `[Dolt] D-pull failed for member '${member}': ${pull.error}`,
            { member, doltOutput: pull.error },
        );
    }

    return { ok: true, member };
}

/**
 * Best-effort extraction of the beads/dolt table name(s) implicated in a
 * diverged `bd dolt pull`'s raw output, for preflightBeadsHealthGate()'s
 * one-line cause. Dolt's conflict text has no single stable grammar (it
 * varies with the conflict kind -- schema vs data, pull vs merge), so this
 * matches several shapes (`table <name>`, `` `<name>` table``, `conflict in
 * <name>`) rather than assuming a canonical format. Never throws; an output
 * with no recognizable table name returns `[]` so the caller can say
 * 'unknown' explicitly rather than silently omit the field.
 *
 * @param {string|null|undefined} doltOutput
 * @returns {string[]}
 */
export function extractConflictingTables(doltOutput) {
    const text = String(doltOutput == null ? '' : doltOutput);
    const tables = new Set();
    const patterns = [
        /\btables?\s+`?([A-Za-z_][\w.]*)`?/gi,
        /`([A-Za-z_][\w.]*)`\s+table/gi,
        /conflict(?:s|ed)? in\s+`?([A-Za-z_][\w.]*)`?/gi,
    ];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(text)) !== null) {
            tables.add(m[1]);
        }
    }
    return [...tables];
}

/**
 * Pre-flight beads-health gate: the same D-pull probe as doltPullBefore(),
 * run before a sprint issues any mutating git or PR command, so a diverged
 * beads clone aborts the run before setup has changed anything.
 *
 * On divergence it composes and logs a single actionable line matching
 * /beads DB diverged/ naming the workspace path (a best-effort `pwd` probe on
 * `member`, falling back to the member id -- diagnostics must never block the
 * abort or throw a second, different error), the conflicting table(s) from
 * extractConflictingTables() (or 'unknown'), and the remediation text. That
 * composed string becomes the re-thrown DoltDivergedError's `.message`, which
 * the typed-abort handling persists verbatim, so one string reaches both the
 * main log and the dashboard.
 *
 * Any non-divergence outcome (DoltSyncError, or a benign skip) is passed
 * through unchanged -- it already carries doltPullBefore()'s own message.
 *
 * @param {string} member
 * @param {{ command: Function, log?: Function, maxTransientRetries?: number, checkSyncRemoteConfigured?: Function }} opts
 * @returns {Promise<{ ok: true, member: string, skipped?: true, reason?: 'no-remote'|'empty-remote'|'already-fresh' }>}
 */
export async function preflightBeadsHealthGate(member, opts = {}) {
    const { command, log = () => {} } = opts;
    try {
        return await doltPullBefore(member, opts);
    } catch (err) {
        if (!(err instanceof DoltDivergedError)) {
            throw err;
        }
        let workspace = member;
        try {
            const pwdRes = await command('pwd', {
                member_name: member,
                silent: true,
                failSoft: true,
                label: `Resolve workspace path for member '${member}' (beads-health gate diagnostics)`,
            });
            if (pwdRes && pwdRes.ok && String(pwdRes.output || '').trim()) {
                workspace = String(pwdRes.output).trim();
            }
        } catch (pwdErr) {
            log(`[Beads Health] could not resolve workspace path for member '${member}' (falling back to member id): ${(pwdErr && pwdErr.message) || pwdErr}`);
        }
        const tables = extractConflictingTables(err.doltOutput);
        const tablesText = tables.length > 0 ? tables.join(', ') : 'unknown';
        const cause =
            `[Beads Health] beads DB diverged from the shared Dolt remote (member '${member}', workspace: ${workspace}; ` +
            `conflicting table(s): ${tablesText}) -- local beads DB diverged from remote; resolve or re-init from the ` +
            `shared remote, then relaunch.`;
        log(cause);
        throw new DoltDivergedError(cause, { member, doltOutput: err.doltOutput, operation: err.operation });
    }
}

/**
 * D-push: publish `member`'s committed beads changes to the shared remote
 * after a beads-mutating step -- `bd dolt push` with a mechanical,
 * first-successful-pusher-wins reconcile. If the push is rejected because the
 * remote moved first, do EXACTLY ONE `bd dolt pull` (reconciling ours/theirs
 * by which clone resolves -- never per-conflict judgment) and re-push once; if
 * that is still rejected, raise a typed DoltDivergedError. Transient (network
 * / server / lock) failures are retried up to `maxTransientRetries`; a
 * divergence is never retried beyond the one bounded reconcile.
 *
 * `pushBeads: false` makes this a no-op (a read-only bracket has nothing to
 * publish). Every command is issued via the injected command() with an
 * explicit member_name.
 *
 * The actual push is serialized behind a GLOBAL push mutex because two
 * concurrent dolt pushes can produce row-level conflicts, and a single
 * unresolved conflict wedges an entire clone's sync. `opts.mutex` is a client
 * with acquire()/release(); it is acquired before the first push attempt and
 * released in a `finally` on EVERY terminal path -- success, transient
 * exhaustion, and divergence -- so a failed push can never leak it. A crashed
 * holder is reclaimed by the mutex's own lease expiry, not by this bracket.
 *
 * Two paths return the benign `{ ok: true, pushed: false, reconciled: false,
 * skipped: true, reason: 'no-remote' }` instead of throwing: a 'no-remote'
 * classification, and -- defense in depth -- any non-diverged failure
 * classifyDoltFailure cannot recognize as 'no-remote' from stderr alone (e.g.
 * a credentials error from a mis-wired Dolt-level remote) when `member`'s
 * bd-level sync.remote is itself absent/neutralized, since nothing is
 * supposed to leave such a clone. A clone with an actively configured
 * sync.remote still throws DoltSyncError on that failure. Override the check
 * with `opts.checkSyncRemoteConfigured` (same `(member, {command, log}) =>
 * Promise<boolean>` shape) in tests.
 *
 * `onAuthFailure` is threaded through to every runDoltStep call below
 * (including the reconcile/re-push) -- see runDoltStep's AUTH SELF-HEAL
 * CONTRACT.
 *
 * @param {string} member
 * @param {{ command: Function, pushBeads?: boolean, log?: Function, maxTransientRetries?: number, mutex?: { acquire: Function, release: Function }, sprintId?: string, checkSyncRemoteConfigured?: Function, onAuthFailure?: Function }} opts
 * @returns {Promise<{ ok: true, member: string, pushed: boolean, reconciled: boolean, skipped?: true, reason?: 'no-remote' }>}
 */
export async function doltPushAfter(member, opts = {}) {
    const { command, pushBeads = true, log = () => {}, maxTransientRetries = 1, mutex, sprintId, checkSyncRemoteConfigured, onAuthFailure } = opts;
    if (typeof command !== 'function') {
        throw new Error("doltPushAfter requires an injected command() in opts");
    }

    if (!pushBeads) {
        return { ok: true, member, pushed: false, reconciled: false };
    }

    // Gate BEFORE issuing: bd auto-provisions a Dolt-level remote from git's
    // own origin on the push attempt itself, so merely ATTEMPTING the push on
    // a clone with valid credentials can succeed against the real shared
    // remote even though bd-level sync.remote is neutralized. The check fails
    // CLOSED (any inconclusive read reports configured), so it can only ever
    // suppress a push that was already declared must not happen. The
    // failure-path downgrade below stays as defense in depth.
    const preGateCheckFn = checkSyncRemoteConfigured || isMemberSyncRemoteConfigured;
    if (!(await preGateCheckFn(member, { command, log }))) {
        log(`[Dolt] D-push for member '${member}' skipped pre-attempt: bd-level sync.remote neutralized/absent -- no push command issued`);
        return { ok: true, member, pushed: false, reconciled: false, skipped: true, reason: 'no-remote' };
    }

    // Serialize this push behind the global mutex: acquire (waiting our FIFO
    // turn) before touching the remote; release on every exit.
    let grant = null;
    if (mutex && typeof mutex.acquire === 'function') {
        grant = await mutex.acquire(sprintId || member, { pid: process.pid });
    }
    try {
        return await doltPushGuarded();
    } finally {
        if (grant && mutex && typeof mutex.release === 'function') {
            try {
                await mutex.release(grant.token);
            } catch (relErr) {
                log(`[Dolt] mutex release after D-push for member '${member}' failed (non-fatal; lease will expire): ${relErr.message}`);
            }
        }
    }

    async function doltPushGuarded() {
    let push = await runDoltStep({
        command, member, cmd: 'bd dolt push',
        label: `D-push for '${member}'`, log, maxTransientRetries, onAuthFailure,
    });
    if (push.ok) {
        return { ok: true, member, pushed: true, reconciled: false };
    }

    if (push.kind === 'no-remote') {
        log(`[Dolt] D-push for member '${member}' skipped: no dolt remote configured (nothing to push)`);
        return { ok: true, member, pushed: false, reconciled: false, skipped: true, reason: 'no-remote' };
    }

    if (push.kind !== 'diverged') {
        // Transient-exhausted or unknown failure -- not a divergence, so no
        // reconcile. Before surfacing it as fatal, consult the member's OWN
        // bd-level sync.remote, independent of Dolt's raw remote wiring and
        // of classifyDoltFailure's stderr pattern matching (which can
        // misclassify a neutralized-sandbox failure as 'unknown'). An
        // absent sync.remote means nothing is supposed to be pushed from this
        // clone, so the failure is the same benign no-remote skip.
        const checkFn = checkSyncRemoteConfigured || isMemberSyncRemoteConfigured;
        const syncRemoteConfigured = await checkFn(member, { command, log });
        if (!syncRemoteConfigured) {
            log(`[Dolt] D-push for member '${member}' skipped: no dolt remote configured (bd-level sync.remote neutralized/absent; push failure treated as benign: ${push.error})`);
            return { ok: true, member, pushed: false, reconciled: false, skipped: true, reason: 'no-remote' };
        }
        if (push.kind === 'remote-unreachable') {
            const url = extractDoltRemoteUrl(push.error);
            throw new DoltSyncError(
                `[Dolt] member '${member}' beads sync remote is unreachable/misconfigured${url ? ` (${url})` : ''} -- the clone's sync.remote points at a path or URL that cannot be opened (e.g. a deleted test sandbox). Repair the member's .beads sync remote before re-running; retrying cannot succeed. Raw: ${push.error}`,
                { member, doltOutput: push.error, remoteUrl: url },
            );
        }
        throw new DoltSyncError(
            `[Dolt] D-push for member '${member}' failed: ${push.error}`,
            { member, doltOutput: push.error },
        );
    }

    // Push loser: reconcile MECHANICALLY with EXACTLY ONE D-pull (ours/theirs
    // fixed by which clone resolves -- first-successful-pusher-wins), then one
    // re-push.
    log(`[Dolt] D-push for member '${member}' was rejected (another writer pushed first); reconciling with a single D-pull then one re-push (first-successful-pusher-wins).`);
    const reconcile = await runDoltStep({
        command, member, cmd: 'bd dolt pull',
        label: `D-push reconcile pull for '${member}'`, log, maxTransientRetries, onAuthFailure,
    });
    if (!reconcile.ok) {
        if (reconcile.kind === 'diverged') {
            throw new DoltDivergedError(
                `[Dolt] D-push reconcile pull for member '${member}' hit an unmergeable beads conflict -- must not be retried blindly: ${reconcile.error}`,
                { member, doltOutput: reconcile.error, operation: 'push-reconcile' },
            );
        }
        throw new DoltSyncError(
            `[Dolt] D-push reconcile pull for member '${member}' failed: ${reconcile.error}`,
            { member, doltOutput: reconcile.error },
        );
    }

    push = await runDoltStep({
        command, member, cmd: 'bd dolt push',
        label: `D-push re-push after reconcile for '${member}'`, log, maxTransientRetries, onAuthFailure,
    });
    if (push.ok) {
        return { ok: true, member, pushed: true, reconciled: true };
    }

    // Still rejected after the one bounded reconcile.
    throw new DoltDivergedError(
        `[Dolt] D-push for member '${member}' still rejected after one reconcile pull -- refusing to retry further: ${push.error}`,
        { member, doltOutput: push.error, operation: 'push' },
    );
    } // end doltPushGuarded
}

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
 * }} opts
 * @returns {Promise<{ ok: true, member: string, gPush: object, dPush: object }>}
 */
export async function syncMemberAfterOrdered(member, opts = {}) {
    const {
        command, pushCode = true, pushBeads = true, log = () => {},
        mutex, sprintId, branch, maxTransientRetries = 1, remote = 'origin',
        agent, resolveConflictModel, onAuthFailure,
    } = opts;

    let gPush;
    try {
        gPush = await syncMemberAfter(member, { command, pushCode, log, branch, maxTransientRetries, remote, agent, resolveConflictModel, onAuthFailure });
    } catch (gPushErr) {
        log(`[Sync] G-push failed for member '${member}' -- skipping D-push and failing this streak rather than advertising an unreachable close (a beads close whose justifying code never reached the shared branch): ${gPushErr.message}`);
        throw gPushErr;
    }

    const dPush = await doltPushAfter(member, { command, pushBeads, log, mutex, sprintId, onAuthFailure });
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
// @param {{ fleetApi: object, command: Function, member: string, log?: Function, logPrefix: string }} opts
// @returns {Promise<{ expiresAt: Date|null }>}
async function provisionVcsAuthForMember({ fleetApi, command, member, log = () => {}, logPrefix }) {
    let repos;
    try {
        const remoteRes = await command('git remote get-url origin', { member_name: member, silent: true, failSoft: true });
        const url = remoteRes && remoteRes.ok ? String(remoteRes.output || '').trim() : '';
        const repo = parseOwnerRepoFromRemoteUrl(url);
        if (repo) {
            repos = [repo];
        } else {
            log(`${logPrefix}: could not derive an owner/repo from member '${member}' git remote (raw: '${url}'); calling provision_vcs_auth without an explicit repos scope.`);
        }
    } catch (remoteErr) {
        log(`${logPrefix}: failed to read member '${member}' git remote to derive 'repos' (continuing without an explicit repos scope): ${remoteErr.message}`);
    }

    // TODO: derive provider/github_mode from the member's persisted
    // vcsProvider instead of hardcoding GitHub App mode.
    const provisionRes = await fleetApi.provisionVcsAuth({
        member_name: member,
        provider: 'github',
        github_mode: 'github-app',
        git_access: 'push',
        ...(repos ? { repos } : {}),
    });
    const provisionText = selfHealResultText(provisionRes);
    // provision_vcs_auth NEVER throws on failure -- it returns a string
    // starting with the failure emoji. A failed provision must never be
    // allowed to report success: doing so burns the one-shot self-heal and
    // logs a lie.
    if ((provisionRes && provisionRes.isError) || /^❌/.test(provisionText.trim())) {
        throw new Error(`provision_vcs_auth failed for member '${member}': ${provisionText || '(no detail)'}`);
    }

    return { expiresAt: parseExpiresAtFromProvisionText(provisionText) };
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

        if (/^⏭/.test(text)) {
            // Skip marker (local member): provision_llm_auth is a no-op here,
            // so retrying would just reproduce the same failure.
            log(`[Dispatch] self-heal: provision_llm_auth skipped for local member '${member}': ${text || '(no detail)'}. This member's credentials can only be refreshed via an interactive /login on this machine.`);
            return false;
        }

        if ((provisionRes && provisionRes.isError) || /^❌/.test(text)) {
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
        await createFn();
        return true;
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
    // closes.
    await doltPullBefore(orchestratorMember, { command, log });
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

    // --- dispatch_timeout_s (optional, default 3600) -----------------------
    // Per-dispatch time budget in seconds, applied as BOTH timeout_s and
    // max_total_s on every agent dispatch: `claude -p` emits nothing until the
    // turn completes, so inactivity equals total runtime and the two timers
    // must be equal for the ceiling to be reachable. The integ-test dispatch
    // ceiling is 2x this value, since its suites legitimately run past one
    // budget. Lowering it bounds the cost of a live-but-silent member hang,
    // which no timer can otherwise distinguish from work. Floor 60: below that
    // even healthy dispatches cannot complete a single turn.
    const dispatchTimeoutS = args.dispatch_timeout_s === undefined ? 3600 : args.dispatch_timeout_s;
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
 * @param {{
 *   isDeltaCycle: boolean,
 *   targetIssues: string[],
 *   goal: string,
 *   requirementsFile: string|undefined,
 *   requirementsContent: string|null,
 *   feedback: string|null,
 *   replanScope?: string[]|null,
 *   rejectedNewTasksToResubmit?: Array<{title: string, description: string, reason: string, cycle: number|string}>,
 * }} opts
 * @returns {string}
 */
export function buildPlannerPrompt({ isDeltaCycle, targetIssues, goal, requirementsFile, requirementsContent, feedback, replanScope = null, rejectedNewTasksToResubmit = [] }) {
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
function buildPlanReviewerPrompt({ targetIssues, goal, priorRoundVerdicts = [], replanScope = null }) {
    const hasReplanScope = Array.isArray(replanScope) && replanScope.length > 0;
    const lines = [
        'Review the beads DAG created by the planner for this sprint, per your agent contract.',
        `Sprint root / scope to review (the open beads subtree this review pass covers): ` +
        `sprint root issue id(s) ${targetIssues.join(', ')}, goal priority ${goal}. ` +
        'Review only the features and tasks under this scope.',
    ];

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
 * @param {{ beadIds: string[], branch: string, feedback: string|null }} opts
 * @returns {string}
 */
export function buildDoerPrompt({ beadIds, branch, feedback }) {
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
 * The prohibition on the reviewer mutating beads itself is stated here as well
 * as in reviewer.md: nothing but the prompt stops the reviewer from shelling
 * out `bd` commands on the member side, so it is repeated as defense in depth.
 * @param {{ beadIds: string[], acceptanceCriteriaJson: string, baseBranch: string, branch: string, goal?: string }} opts
 * @returns {string}
 */
export function buildReviewerPrompt({ beadIds, acceptanceCriteriaJson, baseBranch, branch, goal }) {
    return [
        `Review the work just done for the following bead id(s): ${beadIds.join(', ')}.`,
        'Full task detail (including acceptance criteria), from `bd show --json`:',
        wrapUntrustedBlock('bd show --json', acceptanceCriteriaJson),
        `Diff range to review: ${baseBranch}..${branch} (base_branch..branch).`,
        // Without an explicit scope clause a reviewer can withhold APPROVED
        // over below-goal work the sprint deliberately defers, which starves
        // the completion gate (zero open goal beads AND an APPROVED verdict).
        ...(goal ? [
            `SPRINT SCOPE: this sprint's goal priority is ${goal}. Judge your verdict ` +
            `ONLY against the named bead id(s) above and other work at or above that ` +
            `goal priority. Features/beads BELOW the goal priority (e.g. P3 when the ` +
            `goal is P1/P2) are DEFERRED BY DESIGN to a later sprint: their absence ` +
            `from the diff is correct, must not block APPROVED, must not appear in ` +
            `reopenIds, and may be mentioned in notes only.`,
        ] : []),
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
// SAFE_TEXT_RE is the shell-safety boundary for `title`, which
// createChildBeadWithAllocatedId() interpolates inline into a double-quoted
// `bd create "..."` command. Sprint members run mixed POSIX and Windows
// shells, and no single escaping scheme is reliably safe across all of them,
// so title is validated against an allowlist instead of escaped: anything
// outside it is rejected before reaching `command()`.
//
// SAFE_TEXT_RE admits letters, digits, space, and the punctuation
// `. , : ; ! ? ( ) ' _ / [ ] -` and nothing else. In particular it excludes
// backtick and `$` (command substitution survives inside POSIX double
// quotes), the double-quote itself (a title could otherwise close the
// command's quoting early), and backslash (which could escape the closing
// quote or start any other escape sequence). What remains covers realistic
// task titles while staying inert as shell syntax in both shell families.
//
// `description` carries no such risk: createChildBeadWithAllocatedId() stages
// it to a member-local temp file and passes that path to `bd create
// --body-file`, never interpolating it into a command string. So
// SAFE_DESCRIPTION_RE enforces only non-emptiness and the repo's ASCII
// convention -- tab, newline, carriage return, and printable ASCII -- which
// admits technical characters that SAFE_TEXT_RE rejects ('=', '&', '+', '"',
// '%', '#', '$', backtick and backslash as text).
const SAFE_TEXT_RE = /^[A-Za-z0-9 .,:;!?()'_/\[\]-]+$/;
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
 * still a hard rejection. Deliberately scoped to description only -- title
 * stays on the tighter SAFE_TEXT_RE shell-safety allowlist.
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
    const title = String(newTask && newTask.title);
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
// output embedded in the PR title/body that the Publish PR step interpolates
// into a double-quoted `gh pr create --title "..." --body "..."` command()
// string -- the same injection class SAFE_TEXT_RE exists to close for newTask
// titles, at a different call site.
//
// Unlike validateNewTask(), rejecting is not an option here: the PR must still
// carry the sprint's verdict to a human even when the notes are malformed, and
// failing closed would drop the one thing that human most needs to read. So
// this strips instead: every character outside SAFE_TEXT_RE becomes a space,
// keeping the notes readable while nothing that could break out of the
// double-quoted command string reaches `command()`.
/**
 * Sanitizes LLM-authored free text (e.g. finalVerdictResult.notes) before it
 * is interpolated into a double-quoted `gh pr create`/`git` command() string.
 * Replaces every character outside SAFE_TEXT_RE with a space, collapses the
 * resulting whitespace, and returns the readable remainder.
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

// ---------------------------------------------------------------------------
// Non-hosted git remote detection for Harvest/Publish
// ---------------------------------------------------------------------------
//
// A sprint can run against an origin with no hosting API behind it -- e.g. a
// sandbox wired to a plain `file://` bare mirror, which has no `gh` credential
// either. `gh pr create` cannot work there, so the Publish PR step uses this
// classifier to detect the case up front and take the non-PR-gated closure
// path instead, rather than failing the whole sprint on `gh` auth.
/**
 * Returns true when `remoteUrl` looks like a GitHub remote `gh pr create`
 * can actually open a PR against (an `https://github.com/...` or
 * `git@github.com:...`/`ssh://git@github.com/...` URL) -- as opposed to a
 * non-hosted remote (a plain `file://` bare mirror, or any other host `gh`
 * has no hosting API for). A missing/empty/unresolvable URL is treated as
 * non-hosted (fails closed toward the safer "skip PR creation" path rather
 * than attempting a `gh pr create` that would just fail on auth).
 * @param {string} remoteUrl
 * @returns {boolean}
 */
export function isHostedGithubRemote(remoteUrl) {
    const url = String(remoteUrl ?? '').trim();
    if (!url) return false;
    if (/^file:\/\//i.test(url)) return false;
    return /^(https?:\/\/([^/@\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i.test(url);
}

// ---------------------------------------------------------------------------
// Server-side PR creation (apra-fleet-6bu)
// ---------------------------------------------------------------------------
//
// Both PR call sites below (the PASS/FAIL Publish PR step and the abort-path
// finalizeAbort()) historically dispatched `gh pr create` to a member via
// execute_command. That can only work on a member carrying a MANUAL
// `gh auth login`: the fleet's own provision_vcs_auth deploys a GitHub App
// INSTALLATION token (`ghs_...`), and `gh auth login --with-token` rejects
// installation tokens outright (401 -- it requires a user-context token).
//
// The fleet server's `create_pull_request` tool (src/tools/create-pull-request.ts)
// closes that gap: it mints its OWN short-lived installation token with
// pull_requests:write and POSTs to the GitHub REST API directly, so no
// member-side `gh` auth is involved at all. These two helpers let both call
// sites PREFER that tool and fall back to the unchanged `gh pr create`
// dispatch whenever it is unavailable (older fleet server without the tool,
// no GitHub App configured, PAT-only setup, mint failure, ...).

/**
 * Builds the `createPullRequest(payload)` function the PR call sites prefer,
 * bound to the caller's already-connected MCP client. Returns null when there
 * is no MCP connection to call through, which the call sites read as "use the
 * `gh pr create` fallback".
 *
 * @param {{ callTool?: (name: string, args: object) => Promise<any>, log?: Function }} opts
 * @returns {((payload: object) => Promise<any>) | null}
 */
export function createServerSidePrCreator(opts = {}) {
    const { callTool } = opts;
    if (typeof callTool !== 'function') return null;
    const fleetApi = new ApraFleet({ callTool });
    return async (payload) => (
        typeof fleetApi.createPullRequest === 'function'
            ? fleetApi.createPullRequest(payload)
            : callTool('create_pull_request', payload)
    );
}

/**
 * Attempts server-side PR creation through the `create_pull_request` tool.
 *
 * Returns null whenever the caller should FALL BACK to `gh pr create` -- no
 * tool wired, no derivable owner/repo, the tool call threw (older server: no
 * such tool), or the tool answered with its "ERROR:" marker (no GitHub App
 * configured, mint failure, API rejection). Falling back on ANY tool failure
 * (rather than only on a curated subset) is deliberate: the `gh` path is the
 * pre-existing behavior, so a fallback can never be worse than not having
 * this feature, and a genuine GitHub rejection still surfaces -- `gh` will
 * report the same rejection and the existing throw/idempotency handling
 * applies to it unchanged.
 *
 * On success returns `{ ok: true, alreadyExists, prUrl, text }`, where
 * `alreadyExists` marks the idempotent "a PR for this head is already open"
 * outcome the call sites already treat as success.
 *
 * @param {{
 *   createPullRequest?: ((payload: object) => Promise<any>) | null,
 *   repo?: string|null, base: string, head: string, title: string, body?: string,
 *   log?: Function, logPrefix?: string,
 * }} opts
 * @returns {Promise<{ ok: true, alreadyExists: boolean, prUrl: string|null, text: string }|null>}
 */
export async function attemptServerSidePrCreate({
    createPullRequest, repo, base, head, title, body, log = () => {}, logPrefix = 'Publish PR',
}) {
    if (typeof createPullRequest !== 'function') return null;
    if (!repo) {
        log(`${logPrefix}: could not derive an owner/repo from the origin remote -- falling back to 'gh pr create'.`);
        return null;
    }

    let res;
    try {
        res = await createPullRequest({ repo, base, head, title, ...(body !== undefined ? { body } : {}) });
    } catch (err) {
        log(`${logPrefix}: create_pull_request is unavailable on this fleet server (${err && err.message}) -- falling back to 'gh pr create'.`);
        return null;
    }

    const text = selfHealResultText(res);
    const firstUrl = (t) => {
        const m = /https?:\/\/\S+/.exec(t || '');
        return m ? m[0].replace(/[.,)]+$/, '') : null;
    };

    if (/already exists/i.test(text)) {
        log(`${logPrefix}: create_pull_request reports a PR for head '${head}' already exists -- treating as idempotent success.`);
        return { ok: true, alreadyExists: true, prUrl: firstUrl(text), text };
    }
    if ((res && res.isError) || /^ERROR:/m.test(text.trim()) || !/Created pull request/i.test(text)) {
        log(`${logPrefix}: create_pull_request did not create the PR (${(text || '(no detail)').split('\n')[0]}) -- falling back to 'gh pr create'.`);
        return null;
    }

    const prUrl = firstUrl(text);
    log(`${logPrefix}: PR created server-side via create_pull_request (no member-side gh auth needed): ${prUrl || text.split('\n')[0]}`);
    return { ok: true, alreadyExists: false, prUrl, text };
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
 * }} opts
 * @returns {string}
 */
function buildFinalVerdictPrompt({ targetIssues, branch, baseBranch, goal, cyclesRun, closedCount, openAtGoalCount, deployFailures, integFailures, rejectedNewTasks = [] }) {
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
    if (rejectedNewTasks.length > 0) {
        // newTasks rejected by validateNewTask are non-fatal to the sprint but
        // must still reach a human, so they are surfaced in the same evidence
        // block the final reviewer reads.
        lines.push(
            `${rejectedNewTasks.length} reviewer-proposed newTask(s) were REJECTED (not created via bd create) for failing input validation: ` +
            rejectedNewTasks.map((r) => `C${r.cycle}: ${r.reason}`).join(' | ')
        );
    }
    lines.push(
        'Return a PASS/FAIL verdict per your agent contract, grounded in the evidence above -- ' +
        'never rubber-stamp PASS regardless of open goal-priority beads or deploy/integration failures.'
    );
    lines.push(
        'If your verdict is FAIL: also return your actionable findings as `newTasks` ' +
        '(title, description, priority each) so they persist in beads for the next sprint -- ' +
        'notes alone do not reach the backlog. One task per distinct finding; reference ' +
        'concrete files/tests in each description. NEVER touch beads yourself (no bd create/update); ' +
        'the orchestrator applies your newTasks. On PASS, omit newTasks or return [].'
    );
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
 *   createPullRequest?: ((payload: object) => Promise<any>) | null,
 * }} opts
 * @returns {Promise<{ prUrl: string|null, reason: string, pushed: boolean, commitCount: number }>}
 */
export async function finalizeAbort({ error, branch, baseBranch, member, command, log = () => {}, createPullRequest = null }) {
    // 1. How many commits (if any) does the sprint branch carry beyond base?
    // Every command() call below passes an explicit `member_name` -- this
    // runner never lets a git/gh dispatch fall back to an ambient member.
    //
    // `member` need not be a member that ever checked out a LOCAL branch named
    // `baseBranch`; it may only have the sprint branch. A bare
    // `git rev-list base..branch` would then fail with "unknown revision", so
    // fetch first and diff against the remote-tracking ref, which is always
    // resolvable: baseBranch is the ref the sprint branch was created from.
    await command(
        `git fetch origin ${baseBranch}`,
        { member_name: member, silent: true, label: `Fetch base branch '${baseBranch}' for abort-path diff` }
    );
    const revListRaw = await command(
        `git rev-list --count origin/${baseBranch}..${branch}`,
        { member_name: member, silent: true, label: `Count commits beyond base for abort-path branch '${branch}'` }
    );
    const commitCount = parseInt(String(revListRaw).trim(), 10) || 0;

    if (commitCount < 1) {
        log(`finalizeAbort: branch '${branch}' has 0 commits beyond '${baseBranch}' -- no [ABORTED] PR raised (zero-commit-abort policy).`);
        return { prUrl: null, reason: 'zero-commit-abort', pushed: false, commitCount };
    }

    // 2. There is real work on the branch -- publish it and raise the PR.
    await command(
        `git push -u origin ${branch}`,
        { member_name: member, silent: true, label: `Push abort-path sprint branch '${branch}'` }
    );

    const prTitle = `Auto-sprint [ABORTED]: ${branch}`;
    // The error's code/message/details can originate from agent output, and
    // this text is interpolated into a double-quoted `gh pr create` command()
    // string -- same sanitization rationale as the PASS/FAIL Publish PR step.
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

    // apra-fleet-6bu: prefer the fleet server's own `create_pull_request` tool
    // (no member-side `gh` auth required) and fall back to the `gh pr create`
    // dispatch below whenever it is unwired/unavailable. The origin-remote
    // probe is only dispatched when a tool is actually wired, so a caller that
    // does not inject one (e.g. the direct-unit-test call sites) dispatches
    // exactly the same commands as before this feature existed.
    if (typeof createPullRequest === 'function') {
        const originRes = await command('git remote get-url origin', {
            member_name: member,
            silent: true,
            failSoft: true,
            label: 'Resolve origin remote URL for server-side PR creation',
        });
        const originUrl = originRes && originRes.ok ? String(originRes.output || '').trim() : '';
        const toolRes = await attemptServerSidePrCreate({
            createPullRequest,
            repo: parseOwnerRepoFromRemoteUrl(originUrl),
            base: baseBranch,
            head: branch,
            title: prTitle,
            body: prBody,
            log,
            logPrefix: 'finalizeAbort',
        });
        if (toolRes) {
            return {
                prUrl: toolRes.prUrl,
                reason: toolRes.alreadyExists ? 'already-exists' : 'aborted-pr-created',
                pushed: true,
                commitCount,
            };
        }
    }

    const prCreateRes = await command(
        `gh pr create --base "${baseBranch}" --head "${branch}" --title "${prTitle}" --body "${prBody}"`,
        {
            member_name: member,
            silent: true,
            failSoft: true,
            label: `Raise [ABORTED] PR to '${baseBranch}' (not merged)`,
        }
    );

    if (!prCreateRes.ok) {
        if (/already exists/i.test(prCreateRes.error || '')) {
            // Idempotent: the desired end state -- a PR open for this branch
            // -- already holds, so this is swallowed rather than thrown. The
            // error text carries the existing PR's URL inline, so extract it
            // and return a usable link rather than `null`.
            const urlMatch = /https?:\/\/\S+/.exec(prCreateRes.error || '');
            const existingUrl = urlMatch ? urlMatch[0].replace(/[.,)]+$/, '') : null;
            log(`finalizeAbort: an [ABORTED] PR for branch '${branch}' already exists -- treating as idempotent success (${prCreateRes.error}).`);
            return { prUrl: existingUrl, reason: 'already-exists', pushed: true, commitCount };
        }
        throw new CommandError(
            `[Publish Abort PR Failed] gh pr create failed for branch '${branch}' -> '${baseBranch}': ${prCreateRes.error}`,
            { details: { branch, baseBranch, error: prCreateRes.error } }
        );
    }

    const createdUrl = String(prCreateRes.output || '').trim().split('\n').pop() || null;
    return { prUrl: createdUrl, reason: 'aborted-pr-created', pushed: true, commitCount };
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
    const { agent: agentRaw, command: rawCommand, parallel, log, phase: rawPhase, group, endGroup, publishState, args, budget } = context;

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
    const agent = (prompt, opts = {}) => agentRaw(prompt, { sprint_id: sprintMutexId, ...opts });

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

    // apra-fleet-6bu: the server-side PR creator the Publish PR step prefers
    // over `gh pr create`. Same precedence shape as the callbacks above:
    //   1. `context.createPullRequest` -- explicitly injected (tests wire an
    //      in-process one to prove the tool path is taken without a live
    //      fleet server).
    //   2. `args.callTool` -- bin/cli.mjs's already-connected
    //      `mcpClient.callTool`, routed through the client's
    //      `createPullRequest` wrapper.
    //   3. neither -- null: the Publish PR step uses `gh pr create` exactly as
    //      it always did.
    const createPullRequestTool = context.createPullRequest ?? createServerSidePrCreator({
        callTool: (args && typeof args.callTool === 'function') ? args.callTool : undefined,
        log,
    });

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
        // Role keys MUST be the canonical lowercase contracts.ROLES strings
        // (ROLE_DOER/ROLE_REVIEWER), which is exactly what every call site
        // passes -- a capitalized literal here would silently never match.
        if (role === ROLE_DOER || role === ROLE_REVIEWER) {
            return physicalMembers; // All members act as Doers/Reviewers by default
        }
        return [physicalMembers[0]];
    };

    // Uses the canonical ROLE_ORCHESTRATOR constant, not a literal -- see its
    // doc comment for why 'orchestrator' is an application-level pseudo-role
    // deliberately outside contracts.ROLES.
    const orchestratorMember = getMemberForRole(ROLE_ORCHESTRATOR);

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
    async function withGitSync(member, pushCode, dispatchFn, { pushBeads = false, skipPreDispatchSync = false, skipPreDispatchDoltPull = false, resumeOntoRemoteTip = false } = {}) {
        if (skipPreDispatchSync) {
            log(`[Sync] Skipping pre-dispatch G-pull/D-pull for member '${member}' on a retry after a terminal no-mutation dispatch failure (prior attempt published nothing -- workspace unchanged since the last pull).`);
        } else {
            // Proactively refresh this member's VCS credentials before the
            // G-pull, gated to code-writing roles: read-only roles never `git
            // push`, so there is nothing to preflight. ensureVcsAuthFresh is
            // itself a no-op when a still-fresh credential is cached.
            if (pushCode) {
                await ensureVcsAuthFresh(member);
            }
            await syncMemberBefore(member, { command, log, branch: validated.branch, onAuthFailure, resetToRemoteTip: resumeOntoRemoteTip });
            await doltPullBefore(member, { command, log, skipPull: skipPreDispatchDoltPull, onAuthFailure });
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

        // Seed scopeIds with any target issue that has NO children of its own
        // (a childless leaf target -- a sprint aimed at a single undecomposed
        // issue). The BFS above only ever adds descendants, so without this the
        // scope would be empty and every query would short-circuit to `[]`.
        // Deliberately scoped to childless targets ONLY: a target that DOES
        // have children keeps its own id out of scopeIds, so a pure grouping
        // node is never counted as independently ready work. readyLeafBeads()'s
        // decomposed-node guard is unaffected either way -- a target with
        // children already appears in `parentIds` via its children's `.parent`.
        for (const id of targetIssues) {
            if (!childrenOf.has(id) || childrenOf.get(id).length === 0) {
                scopeIds.add(id);
            }
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

    // Returns this scope's ready beads minus any that have been decomposed into
    // subtasks (i.e. are themselves someone else's `--parent`). A decomposed
    // bead is a grouping node, not a leaf unit of work: per GRAPH-SEMANTICS.md
    // its "done" status comes from its children closing, never from being
    // worked directly. The check is STRUCTURAL (does this ready bead have
    // children?), not an issue_type check -- issue_type has no effect on
    // `--ready` inclusion, and a bead can be a leaf `type=task` or a decomposed
    // `type=bug`/`type=feature` parent, so only the has-children structure
    // tells them apart. The child set is scope-filtered, so a child outside the
    // sprint scope does not mark its parent as decomposed.
    async function readyLeafBeads() {
        // The exclusion set must be built from children of ANY status, not just
        // open ones: once a decomposed bead's children all close they vanish
        // from an open-only list, the parent stops looking like a parent, and it
        // re-enters doer seeding as a "leaf". bdListScoped('') is the
        // no-extra-query path -- the already-fetched project-wide any-status
        // dump filtered to scope, with no new bd command issued.
        const [ready, allAnyStatus] = await Promise.all([
            bdListScoped('--ready --json'),
            bdListScoped(''),
        ]);
        const parentIds = new Set(allAnyStatus.filter((b) => b.parent).map((b) => b.parent));
        return ready.filter((b) => !parentIds.has(b.id));
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
        // A full-cycle review can genuinely exhaust the fleet's default turn
        // budget, and a fresh retry deterministically hits the same wall. Make
        // the budget explicit and, on max_turns exhaustion, RESUME the same
        // session at a doubled budget: the session already holds the full
        // review context, so a continue-nudge finishes the job instead of
        // restarting it.
        const BASE_REVIEWER_MAX_TURNS = 60;
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
            `Your scope, restated so a resumed dispatch never loses it: bead id(s) under review ${beadIds.join(', ')} on branch ${validated.branch} against base ${validated.baseBranch}. ` +
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
    // on it, not just the orchestrator: doers round-robin across the doer pool
    // and the reviewer runs from the reviewer pool, and on a real multi-member
    // fleet each has its own checkout. Ensure on the UNION of the orchestrator,
    // doer, and reviewer pools before the first doer round.
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
    await preflightBeadsHealthGate(orchestratorMember, { command, log });

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

    // Keeps the dashboard UI updated with real bd data. One publishState call
    // carries two sets -- see BACKLOG_STATUSES above:
    //   sprintTasks: everything under this sprint's target scope, re-fetched
    //     fresh every call, so beads added mid-run appear on the next refresh
    //     with no separate wiring.
    //   backlogTasks: open/deferred beads project-wide that are NOT in
    //     sprintTasks -- beads this run is not addressing, which may never have
    //     gone through a planning phase and may belong to an unrelated epic.
    // The sets are NOT published independently: a failed sprint-tree query
    // returns early and publishes nothing at all, backlog included. Only a
    // failed BACKLOG query degrades gracefully (an empty backlog is published
    // alongside the sprint tree).
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

        // Backlog fetch is independently resilient: a failure here must
        // never suppress the (already-successful) sprint-tree publish above.
        let backlogTasks = [];
        try {
            const backlogRes = await command(`bd list --status=${BACKLOG_STATUSES} --json`, { member_name: orchestratorMember, silent: true });
            const allBacklogCandidates = parseBdJson(backlogRes, `bd list --status=${BACKLOG_STATUSES} --json`);
            const sprintIds = new Set(sprintTasks.map((t) => t.id));
            backlogTasks = allBacklogCandidates.filter((t) => !sprintIds.has(t.id));
        } catch (e) {
            log(`updateDashboard: failed to refresh backlog panel (non-fatal, will retry next update): ${e.message}`);
        }

        if (typeof publishState === 'function') {
            publishState('beads', { sprintTasks, backlogTasks });
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
    // doltPullBefore() is a benign no-op when the clone is current and when no
    // dolt remote is configured at all.
    await doltPullBefore(orchestratorMember, { command, log });

    await updateDashboard();

    let initialBeads = await bdListScoped('--ready --json');

    if (initialBeads.length === 0) {
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

        const staleInProgress = notDoneBeads.filter((b) => b.status === 'in_progress' && unmetBlockers(b).length === 0);

        if (staleInProgress.length > 0) {
            for (const bead of staleInProgress) {
                log(`Pre-sprint self-heal: ${bead.id} is stuck 'in_progress' (started_at=${bead.started_at || 'n/a'}) with no unmet blockers -- reclaiming to 'open' so the sprint can dispatch it.`);
                await command(`bd update ${bead.id} --status open`, { member_name: orchestratorMember, silent: true });
            }
            initialBeads = await bdListScoped('--ready --json');
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

                initialBeads = await bdListScoped('--ready --json');
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
            });
            // The planner writes no code but MUTATES beads (it creates the task
            // DAG), so it is bracketed pushCode:false / pushBeads:true -- its
            // new tasks are D-pushed for the next dispatch to observe. Each
            // retried attempt gets its own bracket, since a retry may follow a
            // meaningful gap. Like every dispatch site, max_turns exhaustion is
            // answered with a same-session resume at doubled turns; the planner
            // gets a doer-sized base because it builds the whole epic DAG.
            const PLANNER_MAX_TURNS = 100;
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
            const PLAN_REVIEWER_MAX_TURNS = 60;
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
                            buildPlanReviewerPrompt({ targetIssues, goal: validated.goal, priorRoundVerdicts: priorPlanRoundVerdicts }),
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
            await doltPushAfter(orchestratorMember, { command, pushBeads: true, log, mutex: doltPushMutex, sprintId: sprintMutexId });
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
        const readyBeads = (await readyLeafBeads())
            .filter((b) => targetIssueSet.has(b.id) || !b.issue_type || b.issue_type === 'task')
            .slice().sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

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
                const SCOPED_REPLAN_PLANNER_MAX_TURNS = 100;
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
                    const SCOPED_REPLAN_REVIEWER_MAX_TURNS = 60;
                    try {
                        const scopedVerdict = await withGitSync(getMemberForRole('plan-reviewer'), false, () => agent(
                            buildPlanReviewerPrompt({ targetIssues, goal: validated.goal, replanScope: replanScopeIds }),
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
                await doltPushAfter(orchestratorMember, { command, pushBeads: true, log, mutex: doltPushMutex, sprintId: sprintMutexId });
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
                const BASE_DOER_MAX_TURNS = 100;
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

                    const basePrompt = buildDoerPrompt({ beadIds: actualBeadIds, branch: validated.branch, feedback: feedbackForStreak || null });
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
                        const preResumeUnclosed = await verifyDoerStreakClosed({
                            command, orchestratorMember, beadIds: actualBeadIds, log,
                        });
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
                    const unclosedIds = await verifyDoerStreakClosed({
                        command, orchestratorMember, beadIds: actualBeadIds, log,
                    });
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
                const unclosedIds = await verifyDoerStreakClosed({
                    command, orchestratorMember, beadIds: actualBeadIds, log,
                });
                const closedIds = actualBeadIds.filter((id) => !unclosedIds.includes(id));

                // Per-bead attribution is emitted always (not only when something
                // failed) so every streak leaves an audit trail of exactly which
                // beads closed vs which stayed open. Closed beads stay closed
                // regardless of a sibling bead in the same streak being refused;
                // only the still-open ones are eligible for re-laning next round
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
            // The last reviewer verdict seen THIS cycle feeds the Cycle
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
            await doltPushAfter(orchestratorMember, { command, pushBeads: true, log, mutex: doltPushMutex, sprintId: sprintMutexId });
            } // end assignedBeadIds.length > 0 (Review dispatch + orchestrator-applied transitions)

            await updateDashboard();

            const stillOpen = await bdListScoped('--ready --json');
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
            let deployResult;
            // Turn budget for the deployer, with the same-session
            // turn-exhaustion resume below: a source-build fallback deploy runs
            // npm ci plus two builds, comfortably beyond a small default budget.
            const DEPLOYER_MAX_TURNS = 60;
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

        if (hasPlaybook && deployedThisCycle) {
            phase(`Integ Test C${cycle}`);
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
                // Pending-closure BUGS -- open bug-type beads whose task children
                // are all closed -- have no other closure owner: doers refuse
                // them (non-task), reviewers may not close, and the feature
                // prompt below only names features, so they would linger open at
                // goal priority forever. The integ runner has bead-closing
                // authority and pushBeads: true, so it owns them.
                // At most one `bd list --all` is issued for this whole block; the
                // open-bug derivation reuses the shared snapshot.
                const allForClosure = await bdListScoped('');
                const openBugs = allForClosure.filter((b) => b.issue_type === 'bug' && b.status === 'open');
                const childrenByParent = new Map();
                for (const b of allForClosure) {
                    if (!b.parent) continue;
                    if (!childrenByParent.has(b.parent)) childrenByParent.set(b.parent, []);
                    childrenByParent.get(b.parent).push(b);
                }
                const pendingClosureBugs = openBugs.filter((bug) => {
                    const kids = childrenByParent.get(bug.id) || [];
                    return kids.length > 0 && kids.every((k) => k.status === 'closed');
                });
                const pendingClosureClause = pendingClosureBugs.length > 0
                    ? ` Additionally, these open bug bead(s) have ALL their task children closed and await ` +
                      `verification-closure: ${pendingClosureBugs.map((b) => b.id).join(', ')}. For each, if ` +
                      `your pass shows the underlying defect no longer reproduces, close it (bd close) with a ` +
                      `note naming the evidence; if it still reproduces, leave it open and say why.`
                    : '';
                // The per-cycle Integ Test phase is FEATURE CLOSURE ONLY:
                // integ-test-playbook.md owns no sandbox, no smoke test, and no
                // real-bd suite -- those belong to regression-test-playbook.md,
                // dispatched once per sprint in Finalization below.
                const featurePrompt = (openFeatures.length > 0
                    ? `Run tests using integ-test-playbook.md, for these open feature id(s) only: ` +
                      `${openFeatures.map((f) => f.id).join(', ')}. Add bug beads if needed, filed under ` +
                      `--parent ${targetIssues[0]}.`
                    : `Run tests using integ-test-playbook.md. No open type=feature beads are in scope ` +
                      `this cycle -- report nothing to test. Add bug beads if needed, filed under ` +
                      `--parent ${targetIssues[0]}.`) + pendingClosureClause;
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
                const INTEG_TEST_MAX_TURNS = 300;
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
        await doltPullBefore(orchestratorMember, { command, log });
        const openAtGoal = await bdListScoped(`--status=${NOT_DONE_STATUSES} --priority-max=${goalMax} --json`);

        // Stall detection: track the closed-bead count for the WHOLE sprint
        // scope (not just goal-priority) so zero forward progress on ANY bead
        // is caught.
        const closedCount = (await bdListScoped('--status=closed --json')).length;
        closedCountHistory.push(closedCount);
        // High-water-mark progress. A cycle only counts as progress when it sets
        // a NEW all-time high for the closed count this sprint -- returning to a
        // previously-seen value (even one different from the immediately prior
        // cycle, e.g. 5,4,5,4,...) is not progress.
        if (closedCount > highWaterClosedCount) {
            highWaterClosedCount = closedCount;
            staleCycles = 0;
        } else {
            staleCycles++;
        }

        if (staleCycles >= STALL_CYCLE_LIMIT) {
            const thrashIds = thrashingBeadIds();
            const thrashSuffix = thrashIds.length > 0
                ? ` Reopen-thrash detected on bead(s) [${thrashIds.join(', ')}] (reopened more than ${REOPEN_THRASH_LIMIT} times) -- ` +
                  `likely cause of the oscillation.`
                : '';
            throw new StalledSprintError(
                `Sprint stalled: ${staleCycles} consecutive cycle(s) made no new high-water-mark progress on closed beads ` +
                `in scope '${sprintFilter}'. Closed-count history: [${closedCountHistory.join(', ')}] (high-water mark: ${highWaterClosedCount}).` +
                thrashSuffix +
                ` Aborting rather than burning the remaining cycles.`,
                { staleCycles, closedCountHistory, highWaterClosedCount, thrashIds, reopenCounts: Object.fromEntries(reopenCounts), cycle }
            );
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
            const reReviewVerdict = await dispatchReview({ beadIds: [], acceptanceCriteriaJson: JSON.stringify(reReviewScope) });
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
            await doltPushAfter(orchestratorMember, { command, pushBeads: true, log, mutex: doltPushMutex, sprintId: sprintMutexId });
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
    await doltPullBefore(orchestratorMember, { command, log });
    const finalOpenAtGoal = await bdListScoped(`--status=${NOT_DONE_STATUSES} --priority-max=${goalMax} --json`);
    const finalClosedCount = (await bdListScoped('--status=closed --json')).length;

    let finalVerdictResult;
    // The Final Review covers an entire epic's worth of work, categorically
    // LARGER than a per-round review, so it gets an explicit budget plus the
    // same same-session resume-and-continue treatment as the doer and per-round
    // reviewer. Without it a large sprint's final review dies at the default
    // turn limit and flips the whole sprint to a FAIL whose notes carry no
    // findings at all.
    const FINAL_REVIEW_MAX_TURNS = 60;
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

    // Persist a FAIL's actionable findings to BEADS -- the only artifact the
    // next sprint's planner reads (notes reach only the PR body and the
    // analysis doc). Same orchestrator-applies contract, allowlist validation,
    // and id-allocator path as the per-round reviewer's newTasks; a rejected
    // finding is logged and recorded, never sprint-fatal.
    const finalNewTasks = Array.isArray(finalVerdictResult.newTasks) ? finalVerdictResult.newTasks : [];
    if (finalVerdictResult.verdict === 'FAIL' && finalNewTasks.length > 0) {
        let createdCount = 0;
        for (const newTask of finalNewTasks) {
            const validation = validateNewTask(newTask);
            if (!validation.ok) {
                log(`Final Review newTasks: REJECTED (not sent to bd create) -- ${validation.reason}`);
                rejectedNewTasks.push({ cycle: finalCycleLabel, reason: validation.reason, raw: newTask });
                // Never let a rejected finding vanish -- persist it verbatim to
                // the parent bead's notes as a fallback. This is the
                // highest-stakes site of the three: Final Review's FAIL findings
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
                    await createChildBeadWithAllocatedId({
                        command, allocator: childIdAllocator, member: orchestratorMember,
                        title, description, priority, parentId: targetIssues[0],
                        sprintId: sprintMutexId, floor, log,
                        label: `Create follow-up task from Final Review FAIL findings: ${title}`,
                    });
                },
            });
            if (created) createdCount += 1;
        }
        if (createdCount > 0) {
            log(`Final Review: persisted ${createdCount} FAIL finding(s) to beads as follow-up task(s) under ${targetIssues[0]}.`);
            await doltPushAfter(orchestratorMember, { command, pushBeads: true, log, mutex: doltPushMutex, sprintId: sprintMutexId });
        }
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
        // The real functional suite alone spends roughly one turn per liveness
        // poll for the better part of an hour, and this single dispatch carries
        // both it and the sandbox smoke sprint -- hence the large turn budget
        // and the wider hard ceiling.
        const REGRESSION_TEST_MAX_TURNS = 200;
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
    const HARVESTER_MAX_TURNS = 60;
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
        // No duplicate log() dump -- see dispatchReview() for why.
        if (harvesterResult.status !== 'OK') {
            log(`Harvester reported FAILED: ${harvesterResult.notes}`);
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

    // Resolve the sprint's own git 'origin' remote and classify it (see
    // isHostedGithubRemote() above) BEFORE ever attempting `gh pr create`. A
    // non-hosted remote (a file:// bare mirror, or any other host `gh` has no
    // hosting API for) means PR creation can never succeed, and attempting it
    // anyway throws a hard 'gh auth login required' CommandError that would
    // fail the whole sprint. Resolving the remote is itself failSoft -- an
    // unresolvable remote is treated as non-hosted, per isHostedGithubRemote()'s
    // fail-closed default -- so a probe hiccup here can never kill the sprint.
    const originUrlRes = await command('git remote get-url origin', {
        member_name: orchestratorMember,
        silent: true,
        failSoft: true,
        label: 'Resolve origin remote URL',
    });
    const originUrl = originUrlRes.ok ? originUrlRes.output.trim() : '';
    const hostedRemote = isHostedGithubRemote(originUrl);

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
            await doltPushAfter(orchestratorMember, { command, pushBeads: true, log, mutex: doltPushMutex, sprintId: sprintMutexId });
        } else {
            log('Publish PR: final verdict is FAIL -- leaving target issue(s) open (not closing on a non-PASS verdict).');
        }
    } else {
        // finalVerdictResult.notes is LLM-authored free text -- sanitize with
        // sanitizePrText() (see the comment above its definition) BEFORE it is
        // ever interpolated into the double-quoted `gh pr create` command()
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

        // Idempotent PR creation. `gh pr create` is dispatched with
        // `failSoft: true` (rather than the default throw-on-isError behaviour)
        // so a re-run of finalization against a branch that ALREADY has an open
        // PR from a prior, otherwise-successful run can be told apart from a
        // genuine gh/git failure. `gh pr create` fails with an "already exists"
        // message in that case -- that specific failure is swallowed (logged,
        // not thrown) because it means the desired end state (a PR is open for
        // this branch) already holds. Any OTHER failure (auth, network, a real
        // API error, the injectable mock failure below) is NOT swallowed -- it
        // is re-raised as a typed CommandError so it surfaces clearly rather
        // than being silently invisible.
        // apra-fleet-6bu: prefer the fleet server's own `create_pull_request`
        // tool -- it mints its own GitHub App installation token with
        // pull_requests:write and calls the REST API directly, so this path no
        // longer depends on a member-side `gh auth login` (which can never
        // accept the `ghs_` installation tokens provision_vcs_auth deploys).
        // A null result means "not available / did not create it": fall
        // through to the UNCHANGED `gh pr create` dispatch below.
        const serverSidePr = await attemptServerSidePrCreate({
            createPullRequest: createPullRequestTool,
            repo: parseOwnerRepoFromRemoteUrl(originUrl),
            base: validated.baseBranch,
            head: validated.branch,
            title: prTitle,
            body: prBody,
            log,
            logPrefix: 'Publish PR',
        });

        if (!serverSidePr) {
            const prCreateRes = await command(
                `gh pr create --base "${validated.baseBranch}" --head "${validated.branch}" --title "${prTitle}" --body "${prBody}"`,
                {
                    member_name: orchestratorMember,
                    silent: true,
                    failSoft: true,
                    label: `Raise PR to '${validated.baseBranch}' (not merged)`,
                }
            );
            if (!prCreateRes.ok) {
                if (/already exists/i.test(prCreateRes.error || '')) {
                    log(`Publish PR: a PR for branch '${validated.branch}' already exists -- treating as idempotent success (${prCreateRes.error}).`);
                } else {
                    throw new CommandError(
                        `[Publish PR Failed] gh pr create failed for branch '${validated.branch}' -> '${validated.baseBranch}': ${prCreateRes.error}`,
                        { details: { branch: validated.branch, baseBranch: validated.baseBranch, error: prCreateRes.error } }
                    );
                }
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
                // apra-fleet-6bu: same server-side PR creator precedence as
                // runSprintCycle's Publish PR step (see createPullRequestTool
                // there) -- the [ABORTED] PR must not depend on member-side
                // `gh` auth either. Null falls back to `gh pr create`.
                const abortPrCreator = context.createPullRequest ?? createServerSidePrCreator({
                    callTool: (args && typeof args.callTool === 'function') ? args.callTool : undefined,
                    log,
                });
                abortResult = await finalizeAbort({
                    error: err, branch, baseBranch, member, command, log,
                    createPullRequest: abortPrCreator,
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
