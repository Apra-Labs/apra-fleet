import fs from 'fs/promises';
import { createHash } from 'crypto';
import { AgentOutputError, AgentDispatchError, FleetTransportError, CommandError, WorkflowError, BudgetExceededError, CancelledError } from '@apralabs/apra-fleet-workflow';
import {
    ROLES, normalizeRole, planReviewerVerdict, doerReport, reviewerVerdict, streakAssignment,
    deployerReport, integReport, finalVerdict, harvesterReport, wrapUntrustedBlock,
} from './contracts.mjs';
import { SprintPlanRejectedError, StalledSprintError, ReviewerContractViolationError, GitDivergedError, GitSyncError, DoltDivergedError, DoltSyncError, isNonRetryableDispatchError } from './errors.mjs';
import { parseUnmergedPaths, detectAndAbortRebaseConflict, dispatchConflictResolutionAgent } from './conflict-ladder.mjs';

// apra-fleet-eft.8.12: parseUnmergedPaths is re-exported here (rather than
// only living in conflict-ladder.mjs) so existing imports of it from
// runner.js -- e.g. test/mock-sprint-git-sync-brackets.test.mjs -- keep
// working unchanged; conflict-ladder.mjs is the single source of truth for
// its implementation.
export { parseUnmergedPaths };

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

// ---------------------------------------------------------------------------
// 'orchestrator' pseudo-role (apra-fleet-unw2.11, N15)
// ---------------------------------------------------------------------------
//
// 'orchestrator' is deliberately NOT a member of `contracts.ROLES` and must
// never be added to it: that enum is vendored (it mirrors the `name:`
// frontmatter of vendor/apra-pm/agents/*.md 1:1) and this repo must not
// diverge from it. 'orchestrator' has no vendor/apra-pm/agents/*.md
// definition, no output/input schema, and is never passed to `agent()` --
// it is never dispatched as a fleet agent at all. It exists purely as an
// APPLICATION-LEVEL pseudo-role: a `roleMap` key a caller can use to pin
// which physical fleet member the orchestrating PROCESS ITSELF (this file,
// issuing `bd`/`git` commands directly -- see `orchestratorMember` below and
// the SUPPORTED-TOPOLOGY NOTE) should act as. Because it is not a vendored
// role, it is intentionally NOT passed through `roleConst()`/`ROLES`
// membership checks (doing so would throw) and must never be used as a key
// into a `bd show`-derived model-metadata lookup or any vendored schema
// table. Always reference it via this constant (the canonical lowercase
// form) rather than a literal -- this is the fix for the N15 finding, where
// a stray `getMemberForRole('Orchestrator')` (capitalized) call site meant a
// roleMap author who wrote the natural lowercase `'orchestrator'` key
// silently fell back to `physicalMembers[0]` instead of being honored.
const ROLE_ORCHESTRATOR = 'orchestrator';

// ---------------------------------------------------------------------------
// N10 (apra-fleet-unw2.8) / apra-fleet-dv5.1: fixed-role tier defaults
// ---------------------------------------------------------------------------
//
// Doer dispatches price themselves off the PER-BEAD model tier recorded in
// beads metadata by the planner (N1, apra-fleet-unw2.1's `--metadata
// '{"model": ...}'` convention) -- see the streak model resolution near the
// Develop/Review loop below. The other six roles this runner dispatches
// (planner, plan-reviewer, reviewer, deployer, integ-test-runner,
// harvester) are NOT per-bead: they each run once per cycle/run and have no
// single bead of their own to read a tier from. Per the vendored
// agents/planner.md Step 3 ("Reviewer dispatches always use model: premium
// regardless of the task tier -- this is not configurable by the
// planner"), these roles use a FIXED tier chosen for the nature of the
// work rather than any bead's declared tier. This table is that fixed
// assignment, made explicit (previously these dispatches passed no `model`
// at all, so FleetWorkflow silently used its 'default' bucket, which never
// matches an entry in pricing.mjs and is therefore NEVER priced -- see N10
// in packages/apra-fleet-workflow/docs/feedback-reassessment.md):
//   planner            -> 'premium'  (drafts/redrafts the whole task DAG; highest-stakes single dispatch of a cycle)
//   plan-reviewer      -> 'premium'  (adversarial DAG review; vendor contract treats reviewer-class work as premium-tier)
//   reviewer           -> 'premium'  (both per-round AND final review; vendor contract: "always use model: premium")
//   deployer           -> 'standard' (mostly mechanical: follow deploy.md)
//   integ-test-runner  -> 'standard' (mostly mechanical: follow integ-test-playbook.md)
//   harvester          -> 'standard' (docs/CHANGELOG synthesis, not code-critical)
// These tier keywords ('cheap' | 'standard' | 'premium') are resolved to a
// concrete model PER MEMBER, server-side, by execute-prompt.ts's
// resolveModelForTier() (via each member's registered model_tiers) -- this
// is what makes a mixed-provider fleet (Claude, Gemini, Codex, Copilot,
// OpenCode, ...) work: a fixed 'premium' dispatch resolves to whatever each
// target member's own premium tier is configured to, instead of a
// Claude-specific literal ('opus') being passed through verbatim to a
// non-Claude member where it means nothing. Real per-member cost lookup
// (rather than a tier-band estimate) is available via the
// get_member_model_pricing MCP tool -- see apra-fleet-dv5.5/dv5.6 and
// pricing.mjs.
const FIXED_ROLE_TIER = {
    planner: 'premium',
    'plan-reviewer': 'premium',
    reviewer: 'premium',
    deployer: 'standard',
    'integ-test-runner': 'standard',
    harvester: 'standard',
    // Streak Assignment (runner.js's own ad-hoc "group these ready bead ids"
    // call, no vendored persona -- see the streakAssignment schema comment
    // in contracts.mjs) is a small, fully-specified classification task with
    // no exploration or judgment call beyond what's already in the prompt.
    // It has no business running on the same premium tier as real sprint
    // planning; it previously inherited FIXED_ROLE_TIER.planner only because
    // it borrows the planner MEMBER for routing convenience.
    streakAssignment: 'cheap',
};

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
// Quoted (not a bare comma list): on Windows, commands dispatch via
// `spawn(command, { shell: 'powershell.exe' })` -- PowerShell's own parser
// treats an unquoted comma-separated value as an array literal and
// re-stringifies it space-joined ($OFS) before invoking the native `bd`
// command, silently turning `--status=open,in_progress,blocked,deferred`
// into `--status=open in_progress blocked deferred`, which `bd` then
// rejects as an invalid status. Confirmed via a direct spawn() repro
// against the real bd.cmd shim. MUST be double quotes, not single: this
// same string is also fed to real `bd` via plain `child_process.exec()`
// (cmd.exe as the default shell, e.g. in test mocks) -- cmd.exe has no
// concept of single-quote quoting, so single quotes would pass through
// literally into argv (`invalid status "'open"`); double quotes are
// stripped as real quoting by both PowerShell and cmd.exe, and are a
// harmless no-op under POSIX shells too.
const NOT_DONE_STATUSES = '"open,in_progress,blocked,deferred"';

// Backlog panel (dashboard "Backlog" section): beads the sprint certainly
// will NOT be addressing this run. Excludes 'closed' (done, not backlog)
// and 'in_progress' (actively being worked -- possibly by something else
// entirely, e.g. a concurrent sprint -- a meaningfully different state
// from idle backlog, not lumped in here). 'blocked' IS included: a bead
// gated on an unresolved dependency is just as certainly "not being
// addressed this run" as an untouched 'open' or 'deferred' one. Deliberately
// project-wide (no --parent filter) -- this can and should include beads
// with no relation at all to the current sprint's target epic, so the
// user sees the true state of unplanned/idle work.
// Quoted -- see NOT_DONE_STATUSES above for why (PowerShell comma-array
// mangling on Windows; must be double quotes, not single, so cmd.exe-based
// dispatch strips them correctly too).
const BACKLOG_STATUSES = '"open,deferred,blocked"';

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
    'goal', 'max_cycles', 'requirementsFile', 'roleMap', 'budget',
    // Stabilization Issue 32: per-dispatch time budget (timeout_s ==
    // max_total_s at every dispatch site; integ ceiling = 2x). Lets small
    // runs (sandbox canary sprints) bound the cost of a hung dispatch.
    'dispatch_timeout_s',
    // apra-fleet-eft.9.2 / eft.9.3 / eft.9.7: the always-on supervisor's base
    // HTTP URL (e.g. http://127.0.0.1:8787). Set by bin/cli.mjs from the
    // FLEET_SE_SERVICE_URL env var the supervisor's spawner injects into each
    // detached child; absent for supervisor-less (single-process/dev/test)
    // runs. When present it enables the cross-sprint coordination layers: the
    // global dolt push mutex (9.2), the child-id allocator (9.3), and the
    // per-bead work-claiming (9.7). All three are no-ops without it -- a lone
    // sprint has no sibling to coordinate with.
    'serviceUrl',
    // apra-fleet-eft.9.7: the assignee identity this sprint claims beads as and
    // filters ready work by (`bd update --claim` / `bd ready --assignee`).
    // Optional; when omitted the per-bead work-claiming prevention layer stays
    // dormant and bead selection uses the legacy unassigned `bd list --ready`.
    'assignee',
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

// ---------------------------------------------------------------------------
// Multi-member topology precondition (apra-fleet-unw2.4 / N4)
// ---------------------------------------------------------------------------
//
// This runner has NO cross-member bd/git sync layer this round (deferred --
// see docs/plan.md section 5 and docs/architecture.md "Multi-member
// topology"). Every `bd` command the orchestrator issues in main() runs
// against the ORCHESTRATOR member's beads DB, while each doer's own
// `bd close` runs against ITS member's DB; and the sprint git branch is only
// meaningful if every member operates on the same working state. That whole
// design only coheres when all configured members resolve to the same
// workspace/DB (a "shared-workspace" fleet) -- or when there is a single
// member. On any other topology, non-orchestrator members would silently
// work against a beads DB / git checkout the orchestrator never touches.
//
// So the ONLY currently-supported real-fleet mode is single-member, or a
// verified shared-workspace setup. This function is the enforcement gate for
// that contract: it compares an identity signal (bin/cli.mjs wires it to
// `git rev-parse HEAD`) across every configured member and refuses to start
// when they disagree -- rather than proceeding onto the unsupported,
// silently-diverging path.
//
// Pure/inject-driven (no direct I/O of its own): `getIdentity` is supplied
// by the caller, so cli.mjs can wire it to a live fleet command while the
// mock test supplies per-member signals directly. Single-member trivially
// passes (nothing to compare). For 2+ members, a member whose signal cannot
// be obtained (getIdentity throws) is treated as a REFUSAL -- we cannot
// prove shared state, so we do not silently continue.
//
// Honest limitation (documented, not oversold): matching HEADs at start is a
// best-effort shared-workspace heuristic, NOT a guarantee of ongoing shared
// state -- two independent checkouts that merely happen to sit on the same
// commit right now would pass. Fully validating (and reconciling) per-member
// state across a running sprint needs the deferred cross-member sync layer.
//
// apra-fleet-eft.8.5 (Plan 3.3) -- SYNCED mode. The orchestrator-bracketed git
// sync layer (eft.8.1's G-pull/G-push) removes the "all members must sit on
// the same HEAD" requirement: with per-dispatch sync brackets, members are
// EXPECTED to have different HEADs between brackets and are reconciled by
// fast-forward pull/push, so a shared single workspace is no longer required.
// In synced mode the precondition instead becomes: every member reports the
// SAME `git remote get-url origin` (they push/pull the same remote branch) AND
// passes a working `bd dolt pull` probe (their beads DB can actually sync).
// Legacy shared-workspace mode keeps the same-HEAD identity check unchanged.
//
// Mode selection is EXPLICIT (`opts.mode`), never inferred silently: the
// caller must state which contract it is standing the sprint up under. An
// unknown mode is a hard refusal rather than a silent fallback.
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
    // SYNCED mode (apra-fleet-eft.8.5): same-origin + dolt-probe precondition.
    // HEADs are ALLOWED to differ -- reconciliation is the sync layer's job.
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
                    'See docs/architecture.md "Multi-member topology (auto-sprint)".',
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
                    'See docs/architecture.md "Multi-member topology (auto-sprint)".',
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
    // LEGACY mode: shared-workspace same-HEAD identity check (unchanged).
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
                'checkout/DB); otherwise run single-member. See docs/architecture.md "Multi-member topology (auto-sprint)".',
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
                'checkout/DB). See docs/architecture.md "Multi-member topology (auto-sprint)".',
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
// Orchestrator-bracketed git sync helpers (apra-fleet-eft.8.1, Plan 3.1/3.3)
// ---------------------------------------------------------------------------
//
// Stance: SINGLE-WRITER TOKEN PASSING. The writer pushes, then the next reader
// pulls, so every intra-sprint git merge is fast-forward BY CONSTRUCTION. A
// non-FF result is therefore not a merge to resolve -- it is proof the
// invariant is already broken, so it is a HARD, TYPED error
// (GitDivergedError), never auto-resolved.
//
// risk 2 in the plan: every bracket must fail-soft-with-retry in a way that
// DISTINGUISHES transient-retry (network unreachable, an index/ref lock) from
// diverged-abort (non-FF, unmerged/conflicted paths). A diverged state must
// NEVER be retried blindly. classifyGitFailure() below is that classifier; the
// two failure classes surface as two distinct WorkflowError subclasses
// (GitSyncError vs GitDivergedError) so callers/tests can assert them apart.
//
// (3.2) Every git command is issued via the injected command() with an
// explicit `member_name` -- agents never run sync themselves; the
// orchestrator brackets each dispatch. `command` is dependency-injected (like
// finalizeAbort) so unit tests can drive these helpers with a mock command()
// and no live fleet.

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
    // Stabilization log Issue 13: a failSoft command() resolves a
    // FleetTransportError (client <-> fleet-server connection blip, e.g.
    // undici 'fetch failed' on a dead pooled socket) into its error string.
    // That is a transient infrastructure failure of the DISPATCH CHANNEL,
    // not a git failure at all -- retrying is exactly right, and 'unknown'
    // (never retried, observed sprint-fatal live in run 8) is exactly wrong.
    /transport failure while executing command/i,
    /fetch failed/i,
];

/**
 * Classify a failed git command's output into the two failure classes the
 * sync brackets must route differently (plan risk 2). Divergence is checked
 * FIRST: a non-FF/unmerged state must never be misread as transient and
 * retried blindly, even if its message happens to also contain a lock/network
 * word.
 *
 * @param {string} output - the raw git stderr/stdout of the failed command
 * @returns {'diverged'|'transient'|'unknown'}
 */
export function classifyGitFailure(output) {
    const text = String(output == null ? '' : output);
    for (const re of GIT_DIVERGED_PATTERNS) if (re.test(text)) return 'diverged';
    for (const re of GIT_TRANSIENT_PATTERNS) if (re.test(text)) return 'transient';
    return 'unknown';
}

// apra-fleet-eft.8.12: parseUnmergedPaths and the Tier 1 scripted
// detect-and-abort helper (detectAndAbortRebaseConflict) now live in
// ./conflict-ladder.mjs, alongside the new Tier 2 (agent-with-runbook)
// escalation -- see that module's header comment for the full ladder. Both
// are imported at the top of this file; parseUnmergedPaths is re-exported
// there for backward compatibility.

/**
 * Run a single git command via the injected command() with failSoft, retrying
 * ONLY transient failures up to `maxTransientRetries` times. A diverged (or
 * unknown) failure is returned immediately, never retried.
 *
 * @returns {Promise<{ ok: boolean, output: string, error: string|null, kind?: 'diverged'|'transient'|'unknown' }>}
 */
async function runGitStep({ command, member, cmd, label, log, maxTransientRetries }) {
    let attempt = 0;
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
        return { ok: false, output: res ? res.output : '', error, kind };
    }
}

/**
 * G-pull (Plan 3.1): bring `member` up to the shared branch tip before it does
 * any work -- `git fetch` then `git merge --ff-only`. Because of single-writer
 * token passing this merge is fast-forward by construction; a non-FF result is
 * a distinct typed GitDivergedError (NOT a generic failure), never
 * auto-merged. Transient (network/lock) failures are retried up to
 * `maxTransientRetries`; divergence is never retried.
 *
 * Every git command is issued via the injected command() with an explicit
 * member_name (3.2).
 *
 * @param {string} member
 * @param {{ command: Function, log?: Function, maxTransientRetries?: number, remote?: string, branch?: string }} opts
 * @returns {Promise<{ ok: true, member: string }>}
 */
export async function syncMemberBefore(member, opts = {}) {
    const { command, log = () => {}, maxTransientRetries = 1, remote = 'origin', branch } = opts;
    if (typeof command !== 'function') {
        throw new Error("syncMemberBefore requires an injected command() in opts");
    }

    const fetchCmd = branch ? `git fetch ${remote} ${branch}` : `git fetch ${remote}`;
    const fetch = await runGitStep({
        command, member, cmd: fetchCmd,
        label: `G-pull fetch for '${member}'`, log, maxTransientRetries,
    });
    if (!fetch.ok) {
        // A brand-new sprint branch that has not been pushed to the remote
        // yet (created locally from base by Ensure Sprint Branch; first
        // G-push hasn't happened) makes this fetch fail with "couldn't find
        // remote ref <branch>". That is a benign, expected state -- there is
        // nothing on the remote to pull, so the bracket's pull half is a
        // no-op, NOT an error (observed as a real sprint-killing failure in
        // mock-sprint-ensure-branch-fetch-failure before this guard; same
        // exact-match rationale as Ensure Sprint Branch's own fetch
        // fallback: only this precise git message may be treated as
        // branch-doesn't-exist, anything else still surfaces).
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

    const mergeCmd = branch ? `git merge --ff-only ${remote}/${branch}` : 'git merge --ff-only';
    const merge = await runGitStep({
        command, member, cmd: mergeCmd,
        label: `G-pull ff-only merge for '${member}'`, log, maxTransientRetries,
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
 * G-push (Plan 3.3): publish `member`'s committed work to the shared branch
 * after a dispatch -- `git push` with ONE bounded pull-rebase retry. If the
 * push is rejected as non-FF (another writer got there first), do a single
 * `git pull --rebase` and re-push exactly once; if it is STILL rejected, raise
 * a typed GitDivergedError -- the single-writer invariant is violated and the
 * push must never be retried further/blindly. Transient (network/lock)
 * failures are retried up to `maxTransientRetries`; divergence is never
 * retried beyond the one bounded rebase.
 *
 * `pushCode: false` makes this a no-op (a read-only bracket has nothing to
 * publish). Every git command is issued via the injected command() with an
 * explicit member_name (3.2).
 *
 * apra-fleet-eft.8.12 (Tier 2 of the git conflict ladder): when the pull-
 * rebase retry above hits a REAL content conflict (unmerged paths, not just
 * a plain non-FF race), an optional injected `agent()` gets exactly ONE
 * bounded Tier 2 attempt -- a conflict-resolution-runbook dispatch -- before
 * this function gives up and throws the typed GitDivergedError. The agent's
 * own claim of success is never trusted: this function mechanically
 * re-checks `git status --porcelain` for a clean tree and then attempts one
 * real re-push; only that observed outcome decides whether Tier 2 actually
 * resolved the conflict. Omitting `agent` (the default) preserves the exact
 * pre-8.12 Tier-1-only behavior -- every existing caller/test that does not
 * pass `agent` sees the same throws as before.
 *
 * @param {string} member
 * @param {{
 *   command: Function, pushCode?: boolean, log?: Function,
 *   maxTransientRetries?: number, remote?: string, branch?: string,
 *   agent?: Function, resolveConflictModel?: string,
 * }} opts
 * @returns {Promise<{ ok: true, member: string, pushed: boolean, rebased: boolean, tier2Resolved?: boolean }>}
 */
export async function syncMemberAfter(member, opts = {}) {
    const {
        command, pushCode = true, log = () => {}, maxTransientRetries = 1, remote = 'origin', branch,
        agent, resolveConflictModel,
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
        label: `G-push for '${member}'`, log, maxTransientRetries,
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
        label: `G-push pull-rebase retry for '${member}'`, log, maxTransientRetries,
    });
    if (!rebase.ok) {
        // apra-fleet-eft.8.6 (Tier 1 scripted detection): confirm from git's
        // own porcelain status -- not just this failing command's exit
        // code/message classification -- whether the rebase actually left
        // unmerged paths, and if so restore a clean tree via
        // `git rebase --abort` BEFORE the typed divergence error below
        // propagates. See detectAndAbortRebaseConflict()'s own doc comment
        // for why this is the single Tier 1 -> Tier 2 escalation point.
        const unmergedPaths = await detectAndAbortRebaseConflict({ command, member, log, maxTransientRetries, runGitStep });

        // apra-fleet-eft.8.12 (Tier 2): unmergedPaths.length > 0 is exactly
        // the ladder's documented escalation point -- a real content
        // conflict, not just a non-FF race. Attempt exactly ONE bounded
        // Tier 2 agent-with-runbook dispatch (when an agent() was injected)
        // before falling back to the typed GitDivergedError below. Every
        // outcome (agent throws, agent returns, or agent unavailable) is
        // mechanically re-verified against real git state -- never the
        // agent's own claim.
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
                    label: `G-push after Tier 2 conflict resolution for '${member}'`, log, maxTransientRetries,
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
        label: `G-push re-push after rebase for '${member}'`, log, maxTransientRetries,
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
// apra-fleet-eft.9.1 (Plan Part 3.3) -- Dolt sync brackets: D-pull / D-push
// ---------------------------------------------------------------------------
//
// The beads database is a Dolt database that every member syncs through a
// shared remote, orthogonally to the git code branch. Where the git brackets
// (8.1) keep each member's *code checkout* current, these keep each member's
// *beads clone* current: a D-pull before every dispatch/read that consumes
// beads state, and a D-push after every step that mutates it.
//
// THE single most divergence-sensitive read in this whole file is the
// orchestrator's post-streak `bd show` verification (see verifyDoerStreakClosed
// below): a remote doer closes its beads in ITS OWN clone and D-pushes them;
// without an orchestrator-side D-pull immediately before that read, the
// orchestrator reads its own stale (still-open) copy and falsely marks every
// remote doer streak FAILED. That D-pull is the reason this task exists.
//
// Conflict policy (deliberately NOT per-conflict judgment): D-push is
// first-successful-pusher-wins. The first member to push wins; a member whose
// push is rejected is the loser and reconciles MECHANICALLY -- it D-pulls the
// winner's state (ours/theirs fixed by which clone is resolving, never a
// human/LLM decision) then re-pushes exactly once. A divergence that outlives
// that one bounded reconcile is a hard DoltDivergedError, never retried
// blindly -- the exact mirror of the git single-writer stance.
//
// (3.2) Every `bd dolt` command is issued via the injected command() with an
// explicit member_name -- agents never sync beads themselves; the orchestrator
// brackets each dispatch. `command` is dependency-injected so unit tests can
// drive these helpers with a mock command() and no live Dolt server.

// Substrings that mark a `bd dolt` failure as NO-REMOTE (apra-fleet-eft.16.1):
// this local beads clone has no configured dolt remote at all (e.g. a temp
// fixture repo with no 'origin'), so there is nothing to pull or push. This is
// a benign, non-error condition -- distinct from both a genuine divergence and
// a transient network/server hiccup -- and must be checked FIRST so its text
// (which does not collide with the diverged/transient patterns below) always
// wins. A remote that IS configured but unreachable/diverged/auth-failing
// never matches these patterns and still falls through to the existing
// diverged/transient/unknown classification.
const DOLT_NO_REMOTE_PATTERNS = [
    /error 1105.*no remote/i,
    /\bno remote\b/i,
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

/**
 * Classify a failed `bd dolt` command's output into the failure classes the
 * Dolt brackets route differently. no-remote is checked FIRST (apra-fleet-
 * eft.16.1): a local clone with no configured dolt remote has nothing to
 * pull/push, which is a benign skip, never a divergence or a retryable
 * transient failure. Divergence is checked next: a remote-moved/conflict
 * state must never be misread as transient and retried blindly, even if its
 * message also happens to contain a lock/network word.
 *
 * @param {string} output - the raw stderr/stdout of the failed `bd dolt` command
 * @returns {'no-remote'|'diverged'|'transient'|'unknown'}
 */
export function classifyDoltFailure(output) {
    const text = String(output == null ? '' : output);
    for (const re of DOLT_NO_REMOTE_PATTERNS) if (re.test(text)) return 'no-remote';
    for (const re of DOLT_DIVERGED_PATTERNS) if (re.test(text)) return 'diverged';
    for (const re of DOLT_TRANSIENT_PATTERNS) if (re.test(text)) return 'transient';
    return 'unknown';
}

/**
 * apra-fleet-eft.30.2 (defense-in-depth, independent of eft.30.1): query
 * whether `member`'s bd-level `sync.remote` setting -- the exact YAML key
 * the eft.25.1 neutralize step comments out -- is currently configured.
 *
 * This is deliberately independent of Dolt's raw remote wiring /
 * classifyDoltFailure's stderr pattern matching: apra-fleet-eft.30 showed a
 * (mis)wired Dolt-level remote can still make a real `bd dolt push` attempt
 * and fail with a credentials error ('could not read Username for
 * https://github.com') that classifyDoltFailure has no pattern for, so it
 * returns 'unknown' rather than 'no-remote' -- even though the sprint's
 * bd-level sync.remote for this clone IS neutralized and nothing is
 * supposed to be pushed. Consulting the bd-level setting directly closes
 * that gap regardless of what Dolt's own remote list says.
 *
 * Uses `bd config get sync.remote --json` (via the injected command(), with
 * an explicit member_name per 3.2) rather than reading config.yaml off disk
 * directly, since `command()` is the only member-scoped I/O this runner has
 * -- a member's clone is not assumed to be locally readable.
 *
 * Fail-safe by default: a failed command(), a failSoft error result, or
 * output that cannot be positively parsed as `{ value: '' }` is all treated
 * as CONFIGURED (returns true) -- i.e. this only ever reports "not
 * configured" when it can positively confirm an empty `value` from a clean
 * JSON parse. This deliberately does NOT mirror checkSyncRemoteInert's
 * vacuous pass on a missing config.yaml: unlike that read-only sandbox
 * guard, a false positive here (wrongly reporting "not configured") would
 * silently swallow a genuine D-push failure on a real, actively-synced
 * clone -- the exact eft.16.1 regression this must not reintroduce -- so an
 * inconclusive read must fail closed (assume configured, keep throwing),
 * not fail open.
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
        // No output to positively parse (e.g. a no-op/unmocked command()) --
        // fail-safe: cannot confirm sync.remote is absent, so do not treat
        // it as neutralized.
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
 * @returns {Promise<{ ok: boolean, output: string, error: string|null, kind?: 'diverged'|'transient'|'unknown' }>}
 */
async function runDoltStep({ command, member, cmd, label, log, maxTransientRetries }) {
    let attempt = 0;
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
        return { ok: false, output: res ? res.output : '', error, kind };
    }
}

/**
 * D-pull (Plan 3.3): bring `member`'s beads clone up to the shared remote
 * before it reads or is dispatched -- `bd dolt pull`. Transient (network /
 * server / lock) failures are retried up to `maxTransientRetries`; a
 * divergence (a conflict that a plain pull cannot fast-forward) is a distinct
 * typed DoltDivergedError, never retried blindly.
 *
 * Every command is issued via the injected command() with an explicit
 * member_name (3.2).
 *
 * apra-fleet-eft.16.1: a local clone with no configured dolt remote (the
 * 'no-remote' classification) has nothing to pull -- this is a benign no-op
 * skip, not an error, so it returns `{ ok: true, skipped: true, reason:
 * 'no-remote' }` instead of throwing DoltSyncError.
 *
 * apra-fleet-eft.35 (residual after eft.30.1-3): gate the pull BEFORE
 * issuing it, mirroring doltPushAfter's own pre-gate (apra-fleet-eft.30,
 * stabilization log Issue 31). CONFIRMED ROOT CAUSE, candidate (b) from the
 * bug's own diagnosis list: this function previously ran `bd dolt pull`
 * UNCONDITIONALLY on every withGitSync bracket (i.e. before every single
 * role dispatch, every cycle) with no pre-gate at all -- unlike
 * doltPushAfter, which eft.30 already gated. bd auto-provisions a Dolt-level
 * remote from git's own origin as a side effect of a 'bd dolt' invocation
 * that needs one (the same mechanism eft.30's own commit message documents
 * for the push case: "bd auto-provisions a Dolt remote from git origin on
 * the push attempt itself") -- so this UNGATED pull could re-arm the very
 * Dolt-level remote eft.30.1's one-time upfront sandbox disarm had just
 * cleared, on the FIRST dispatch bracket of the sprint, well before any
 * D-push is ever attempted. That re-arming is what let a LATER, correctly
 * pre-gated `doltPushAfter()` call observe a live Dolt-level remote wired to
 * the real fleet-e2e-toy origin and actually attempt `bd dolt push` against
 * it (live recurrence, integ cycle 6: blocked only by missing GitHub
 * credentials, not by design). A one-time upfront disarm (eft.30.1, run
 * once in the playbook's `## Setup`, external to this runner) cannot hold
 * across many per-cycle 'bd dolt' invocations if any of them can silently
 * re-provision the remote -- every 'bd dolt' call site needs the SAME
 * fail-closed gate, not just the push one. Same fail-safe-by-default
 * semantics as doltPushAfter's gate (isMemberSyncRemoteConfigured only ever
 * reports "not configured" on a positively-confirmed empty value; any
 * inconclusive read still fails closed and lets the pull proceed), so a
 * real, actively-synced clone is unaffected -- no eft.16.1 regression.
 * Override the check with `opts.checkSyncRemoteConfigured` (same test hook
 * doltPushAfter exposes).
 *
 * @param {string} member
 * @param {{ command: Function, log?: Function, maxTransientRetries?: number, checkSyncRemoteConfigured?: Function }} opts
 * @returns {Promise<{ ok: true, member: string, skipped?: true, reason?: 'no-remote' }>}
 */
export async function doltPullBefore(member, opts = {}) {
    const { command, log = () => {}, maxTransientRetries = 1, checkSyncRemoteConfigured } = opts;
    if (typeof command !== 'function') {
        throw new Error("doltPullBefore requires an injected command() in opts");
    }

    // apra-fleet-eft.35: gate BEFORE issuing, same fail-closed check as
    // doltPushAfter's pre-gate -- see this function's own doc comment above
    // for the confirmed root cause this closes.
    const preGateCheckFn = checkSyncRemoteConfigured || isMemberSyncRemoteConfigured;
    if (!(await preGateCheckFn(member, { command, log }))) {
        log(`[Dolt] D-pull for member '${member}' skipped pre-attempt: bd-level sync.remote neutralized/absent -- no pull command issued`);
        return { ok: true, member, skipped: true, reason: 'no-remote' };
    }

    const pull = await runDoltStep({
        command, member, cmd: 'bd dolt pull',
        label: `D-pull for '${member}'`, log, maxTransientRetries,
    });
    if (!pull.ok) {
        if (pull.kind === 'no-remote') {
            log(`[Dolt] D-pull for member '${member}' skipped: no dolt remote configured (nothing to pull)`);
            return { ok: true, member, skipped: true, reason: 'no-remote' };
        }
        if (pull.kind === 'diverged') {
            throw new DoltDivergedError(
                `[Dolt] D-pull for member '${member}' hit an unmergeable beads conflict and must not be auto-resolved by judgment: ${pull.error}`,
                { member, doltOutput: pull.error, operation: 'pull' },
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
 * D-push (Plan 3.3): publish `member`'s committed beads changes to the shared
 * remote after a beads-mutating step -- `bd dolt push` with the mechanical,
 * first-successful-pusher-wins reconcile. If the push is rejected because the
 * remote moved first (another writer won the race), do EXACTLY ONE `bd dolt
 * pull` (which reconciles ours/theirs mechanically by which clone resolves --
 * never per-conflict judgment) and re-push once; if it is STILL rejected,
 * raise a typed DoltDivergedError. Transient (network / server / lock)
 * failures are retried up to `maxTransientRetries`; divergence is never
 * retried beyond the one bounded reconcile.
 *
 * `pushBeads: false` makes this a no-op (a read-only bracket -- reviewer,
 * plan-reviewer, deployer -- has nothing to publish). Every command is issued
 * via the injected command() with an explicit member_name (3.2).
 *
 * apra-fleet-eft.9.2 (Plan 3.4): the ACTUAL dolt push is serialized through the
 * supervisor-owned global push mutex. Constraints C.2 (row-level conflicts) and
 * C.3 (one unresolved conflict wedges the entire clone sync) make this a
 * load-bearing v1 requirement: two sprints must NEVER execute a dolt push at the
 * same time. `opts.mutex` is a client with acquire()/release() (see
 * dolt-mutex.mjs nullDoltPushMutexClient for the no-supervisor default). The
 * mutex is acquired before the first push attempt and released in a `finally` on
 * EVERY terminal path -- success, transient-exhaustion, and divergence -- so a
 * failed push can never leak the mutex. A crashed holder is separately reclaimed
 * by the mutex's own lease expiry, so this bracket does not need to.
 *
 * apra-fleet-eft.16.1: a local clone with no configured dolt remote (the
 * 'no-remote' classification) has nothing to push -- this is a benign no-op
 * skip, not an error, so it returns `{ ok: true, pushed: false, reconciled:
 * false, skipped: true, reason: 'no-remote' }` instead of throwing
 * DoltSyncError.
 *
 * apra-fleet-eft.30.2 (defense-in-depth, independent of eft.30.1): a
 * non-diverged push failure that classifyDoltFailure cannot recognize as
 * 'no-remote' from stderr text alone (e.g. a credentials error from a
 * mis-wired Dolt-level remote) is ALSO treated as this same benign
 * no-remote skip -- rather than the fatal DoltSyncError below -- when
 * `member`'s bd-level sync.remote is itself absent/neutralized (see
 * isMemberSyncRemoteConfigured). A clone with an actively configured
 * sync.remote still throws DoltSyncError on such a failure, unchanged from
 * eft.16.1. Override the check with `opts.checkSyncRemoteConfigured` (same
 * `(member, {command, log}) => Promise<boolean>` shape) in tests.
 *
 * @param {string} member
 * @param {{ command: Function, pushBeads?: boolean, log?: Function, maxTransientRetries?: number, mutex?: { acquire: Function, release: Function }, sprintId?: string, checkSyncRemoteConfigured?: Function }} opts
 * @returns {Promise<{ ok: true, member: string, pushed: boolean, reconciled: boolean, skipped?: true, reason?: 'no-remote' }>}
 */
export async function doltPushAfter(member, opts = {}) {
    const { command, pushBeads = true, log = () => {}, maxTransientRetries = 1, mutex, sprintId, checkSyncRemoteConfigured } = opts;
    if (typeof command !== 'function') {
        throw new Error("doltPushAfter requires an injected command() in opts");
    }

    if (!pushBeads) {
        return { ok: true, member, pushed: false, reconciled: false };
    }

    // apra-fleet-eft.30 (stabilization log Issue 31): gate the push BEFORE
    // issuing it. The eft.30.2 failure-path downgrade below stopped the
    // sprint-abort but still let `bd dolt push` be ATTEMPTED -- and bd
    // auto-provisions a Dolt-level remote from git's own origin on that
    // attempt, so on a clone with valid credentials the push would SUCCEED
    // against the real shared remote even though bd-level sync.remote is
    // neutralized (observed live, integ C4/C5: a sandbox reached the real
    // fleet-e2e-toy remote and was blocked only by missing credentials).
    // When the member's own sync.remote is positively confirmed absent,
    // nothing is supposed to leave this clone: skip without issuing any
    // push command at all. isMemberSyncRemoteConfigured fails CLOSED (any
    // inconclusive read reports configured), so a real, actively-synced
    // clone always still pushes -- this gate can only ever suppress a push
    // the eft.25 neutralize step already declared must not happen. The
    // failure-path downgrade below stays as defense-in-depth.
    const preGateCheckFn = checkSyncRemoteConfigured || isMemberSyncRemoteConfigured;
    if (!(await preGateCheckFn(member, { command, log }))) {
        log(`[Dolt] D-push for member '${member}' skipped pre-attempt: bd-level sync.remote neutralized/absent -- no push command issued`);
        return { ok: true, member, pushed: false, reconciled: false, skipped: true, reason: 'no-remote' };
    }

    // apra-fleet-eft.9.2: serialize this push behind the global mutex. Acquire
    // (waiting our FIFO turn) before touching the remote; release on every exit.
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
        label: `D-push for '${member}'`, log, maxTransientRetries,
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
        // reconcile. apra-fleet-eft.30.2: before surfacing this as a fatal
        // sync error, consult the member's OWN bd-level sync.remote setting
        // -- independent of Dolt's raw remote wiring / classifyDoltFailure's
        // stderr pattern matching, which apra-fleet-eft.30 showed can both
        // still misclassify a neutralized-sandbox push failure (e.g. a
        // credentials error) as 'unknown' rather than 'no-remote'. A
        // neutralized/absent sync.remote means nothing is supposed to be
        // pushed from this clone, so treat the failure as the same benign
        // no-remote skip; an actively configured sync.remote still throws
        // DoltSyncError here, unchanged from eft.16.1.
        const checkFn = checkSyncRemoteConfigured || isMemberSyncRemoteConfigured;
        const syncRemoteConfigured = await checkFn(member, { command, log });
        if (!syncRemoteConfigured) {
            log(`[Dolt] D-push for member '${member}' skipped: no dolt remote configured (bd-level sync.remote neutralized/absent; push failure treated as benign: ${push.error})`);
            return { ok: true, member, pushed: false, reconciled: false, skipped: true, reason: 'no-remote' };
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
        label: `D-push reconcile pull for '${member}'`, log, maxTransientRetries,
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
        label: `D-push re-push after reconcile for '${member}'`, log, maxTransientRetries,
    });
    if (push.ok) {
        return { ok: true, member, pushed: true, reconciled: true };
    }

    // Still rejected after the one bounded reconcile -- diverged, never retried further.
    throw new DoltDivergedError(
        `[Dolt] D-push for member '${member}' still rejected after one reconcile pull -- refusing to retry further: ${push.error}`,
        { member, doltOutput: push.error, operation: 'push' },
    );
    } // end doltPushGuarded
}

/**
 * apra-fleet-eft.8.4 (Plan 3.3 push ordering) -- the ordered post-dispatch
 * sync step every withGitSync() bracket's `finally` runs: G-push (code)
 * BEFORE D-push (beads).
 *
 * For the code-writing roles (pushCode:true -- doer, harvester ONLY), G-push
 * MUST succeed before D-push is ever attempted. If G-push cannot be resolved
 * (a typed GitSyncError/GitDivergedError, or any other thrown error),
 * D-push is skipped ENTIRELY and the G-push error is rethrown (never
 * swallowed) -- closing a bead in dolt while the code that justifies that
 * close never left this member's checkout would advertise an UNREACHABLE
 * CLOSE: a reviewer, or the next streak's G-pull, would see the bead as done
 * and find no matching commit on the shared branch. This is exactly the
 * failure this ordering rule prevents.
 *
 * For non-code-writing roles (pushCode:false), syncMemberAfter is a
 * documented no-op that never touches git and cannot throw (see its own
 * pushCode guard), so D-push always still runs unaffected by this ordering
 * rule.
 *
 * apra-fleet-eft.8.12: `agent`/`resolveConflictModel` (both optional) are
 * threaded straight through to syncMemberAfter's Tier 2 conflict-resolution
 * escalation -- see that function's own doc comment. Omitting `agent`
 * preserves the exact pre-8.12 behavior.
 *
 * @param {string} member
 * @param {{
 *   command: Function, pushCode?: boolean, pushBeads?: boolean,
 *   log?: Function, mutex?: { acquire: Function, release: Function },
 *   sprintId?: string, branch?: string, maxTransientRetries?: number,
 *   remote?: string, agent?: Function, resolveConflictModel?: string,
 * }} opts
 * @returns {Promise<{ ok: true, member: string, gPush: object, dPush: object }>}
 */
export async function syncMemberAfterOrdered(member, opts = {}) {
    const {
        command, pushCode = true, pushBeads = true, log = () => {},
        mutex, sprintId, branch, maxTransientRetries = 1, remote = 'origin',
        agent, resolveConflictModel,
    } = opts;

    let gPush;
    try {
        gPush = await syncMemberAfter(member, { command, pushCode, log, branch, maxTransientRetries, remote, agent, resolveConflictModel });
    } catch (gPushErr) {
        log(`[Sync] G-push failed for member '${member}' -- skipping D-push and failing this streak rather than advertising an unreachable close (a beads close whose justifying code never reached the shared branch): ${gPushErr.message}`);
        throw gPushErr;
    }

    const dPush = await doltPushAfter(member, { command, pushBeads, log, mutex, sprintId });
    return { ok: true, member, gPush, dPush };
}

/**
 * apra-fleet-eft.9.2 (Plan 3.4) -- the child-side HTTP client for the
 * supervisor-owned global dolt push mutex (src/supervisor/dolt-mutex.mjs).
 *
 * This is the missing wire that makes the mutex LOAD-BEARING end to end: the
 * mutex object itself lives in the always-on supervisor process, but each
 * detached sprint child runs in its OWN process and can only reach it over
 * HTTP. This client speaks the exact routes registerDoltMutexRoutes() exposes:
 *
 *   POST {serviceUrl}/api/dolt-push-mutex/{sprintId}/acquire  body { pid }
 *   POST {serviceUrl}/api/dolt-push-mutex/{sprintId}/release  body { token }
 *
 * The acquire route long-polls -- it does not answer until this sprint
 * genuinely owns the mutex (FIFO after every earlier waiter) -- so a resolved
 * acquire() means this child now holds it and no sibling sprint is pushing.
 *
 * It is deliberately implemented INLINE here (not imported from
 * src/supervisor/dolt-mutex.mjs) because runner.js is copied verbatim next to
 * the bundle (scripts/bundle-se.mjs) and loaded via engine.executeFile(), never
 * bundled -- a cross-package relative import would not resolve in the shipped
 * layout. The surface it exposes ({ acquire, release }) is exactly what
 * doltPushAfter() calls.
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
 * apra-fleet-eft.9.3 (Plan Part 3.4) -- the child-id allocator HTTP client the
 * orchestrator's bead-creation path uses to reach the supervisor-owned global
 * allocator (src/supervisor/id-allocator.mjs).
 *
 * This is the missing wire that makes the allocator LOAD-BEARING end to end: the
 * allocator lives in the always-on supervisor process, but each detached sprint
 * child runs in its OWN dolt clone and can only reach it over HTTP. Without it,
 * two sprints that each `bd create --parent X` in their own clone independently
 * derive the SAME next child id (PoC constraint C.4) and their D-pushes then
 * hard-conflict. With it, one authority mints an EXPLICIT distinct id per
 * creator, passed to `bd create --id <childId>`, so the two creates target
 * different rows and never collide.
 *
 * This client speaks the exact routes registerIdAllocatorRoutes() exposes:
 *
 *   POST {serviceUrl}/api/child-id-allocator/{parentId}/allocate  body { pid, sprintId, floor }
 *   POST {serviceUrl}/api/child-id-allocator/confirm              body { token }
 *   POST {serviceUrl}/api/child-id-allocator/release              body { token }
 *
 * It is deliberately implemented INLINE here (not imported from
 * src/supervisor/id-allocator.mjs) for the same reason as the dolt push mutex
 * client above: runner.js is copied verbatim next to the bundle and loaded via
 * engine.executeFile(), never bundled -- a cross-package relative import would
 * not resolve in the shipped layout. The surface it exposes
 * ({ allocate, confirm, release }) is exactly what the bead-creation path calls.
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
 * apra-fleet-eft.26.1 (Reservation interop gap, Hole 1) -- reserves and
 * releases every sprint member against the fleet server's OWN per-member
 * reservation record (`member_reservation` tool, apra-fleet-eft.10.1/10.2),
 * so a sprint launched directly via `apra-fleet workflow auto-sprint` / this
 * package's bin/cli.mjs (never routed through the supervisor's
 * POST /api/sprints, and so never seen by src/supervisor/ledger.mjs) still
 * becomes visible to the enforcement every launch path already shares:
 * execute_prompt's dispatch-time reservedBy check (src/tools/execute-prompt.ts,
 * eft.10.3) and, for supervisor-routed launches, the eft.26.2 overlap guard
 * that now also reads this same server-side record.
 *
 * `callTool` is injected (the caller's MCP client, e.g.
 * `fleetApi.mcpClient.callTool`) so this stays transport-agnostic and
 * unit-testable without a live fleet server. This is deliberately NOT built
 * on the supervisor's own HTTP routes (unlike the dolt-mutex/id-allocator
 * clients above): `member_reservation` lives on the fleet MCP server every
 * launch path already connects to, not the (optional, not wired for direct
 * CLI launches) apra-fleet-se supervisor.
 *
 * `sprintId` should be the SAME opaque identity already used for the dolt
 * push mutex / child-id allocator (see `sprintMutexId` in runSprintCycle,
 * currently the sprint's branch name) -- opaque and target-agnostic, no
 * assumption about which repo the sprint develops.
 *
 * Reserve/release are BEST-EFFORT per member: a failure (transport error, or
 * the tool's own "already reserved by X" rejection) is logged and does NOT
 * throw -- matching the release()-is-non-fatal precedent set by the
 * dolt-mutex / id-allocator clients above. This is safe because
 * execute_prompt (eft.10.3) independently rejects any dispatch to a member
 * this sprint failed to actually reserve, so an unreserved member fails
 * loudly at its first dispatch rather than silently interleaving with
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
 * apra-fleet-eft.9.3 -- create a child bead under `parentId` using a
 * supervisor-allocated, collision-free explicit id. This is the single
 * bead-creation seam every reviewer-proposed newTask flows through so that two
 * concurrent sprints never mint the same child id.
 *
 * Sequence (mirrors the allocator's reserve -> confirm/release contract):
 *   1. allocate() reserves the next distinct child id under the shared parent.
 *   2. `bd create` runs with `--id <childId>` (or, under the null client where
 *      childId is null and there is no second sprint, lets bd derive the id).
 *   3. confirm() on success (the id is now durably used) or release() on failure
 *      (the reserved id returns to the pool so it is never a permanent gap).
 *
 * @param {{
 *   command: Function, allocator: { allocate: Function, confirm: Function, release: Function },
 *   member: string, title: string, description: string, priority: string,
 *   parentId: string, sprintId?: string, floor?: number, label?: string,
 *   log?: Function,
 * }} opts
 * @returns {Promise<{ childId: string|null }>}
 */
/**
 * apra-fleet-eft.9.3 -- the count of children a parent ALREADY has, i.e. the
 * highest trailing `.N` segment across its direct children. Passed to the
 * allocator as `floor` so that on its FIRST allocation under a parent it never
 * mints an id colliding with a child created before the allocator existed (or
 * before this supervisor's persisted state was seeded). Best-effort: a failed
 * or unparseable list yields 0 (the allocator's persisted high-water still
 * guards against re-minting within a supervisor's lifetime).
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

export async function createChildBeadWithAllocatedId(opts) {
    const { command, allocator, member, title, description, priority, parentId, sprintId, floor, label, log = () => {} } = opts;
    const grant = await allocator.allocate(parentId, { pid: process.pid, sprintId, floor });
    const idFlag = grant.childId ? ` --id ${grant.childId}` : '';
    try {
        await command(
            `bd create "${title}" -d "${description}" -p "${priority}" --parent ${parentId}${idFlag} --silent`,
            { member_name: member, silent: true, label: label ?? `Create follow-up task: ${title}` }
        );
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
 * apra-fleet-eft.9.1 (Plan Part 3.3) -- the orchestrator's post-streak
 * verification read, with its mandatory D-pull. This is the single most
 * divergence-sensitive read in the file: a remote doer closes its assigned
 * beads in its OWN clone and D-pushes them, so the orchestrator MUST D-pull
 * its own clone here BEFORE the `bd show` -- otherwise it reads stale
 * (still-open) status and every remote doer streak is falsely reported FAILED.
 *
 * Returns the ids that are NOT closed after the D-pull-then-read. An empty
 * array means the streak genuinely closed everything it was assigned.
 *
 * @param {{ command: Function, orchestratorMember: string, beadIds: string[], log?: Function }} opts
 * @returns {Promise<string[]>} the still-unclosed bead ids
 */
export async function verifyDoerStreakClosed({ command, orchestratorMember, beadIds, log = () => {} }) {
    // D-pull FIRST so the orchestrator's clone observes the doer's just-pushed
    // closes -- the whole reason this function (and this task) exists.
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
    // N15 (apra-fleet-unw2.11): normalize EVERY roleMap key via
    // contracts.normalizeRole() (trim + lowercase) HERE, at validateArgs()
    // time -- the single normalization point for this arg. A caller-supplied
    // key of any casing/whitespace variant (e.g. 'Doer', ' doer ', 'DOER',
    // or the 'orchestrator' pseudo-role itself -- see ROLE_ORCHESTRATOR
    // above) resolves identically to its canonical lowercase form, fixing
    // the class of bug where `getMembersForRole`/`getMemberForRole` compared
    // an un-normalized roleMap key against a canonical lowercase role
    // constant and silently missed the match (the concrete instance being
    // the old `getMemberForRole('Orchestrator')` call site below, which
    // never matched a roleMap author's natural lowercase `orchestrator`
    // key). Every downstream reader of `validated.roleMap`
    // (getMemberForRole/getMembersForRole) can assume keys are already
    // normalized -- neither may re-read `args.roleMap` directly. Two
    // differently-cased input keys that normalize to the same key are
    // rejected loudly (ambiguous authorial intent) rather than one silently
    // clobbering the other.
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

    // --- budget (optional; N10, apra-fleet-unw2.8) -----------------------
    // A USD ceiling for this run's total estimated spend. When provided,
    // main() below sets `context.budget.total` to this value BEFORE any
    // dispatch, so `agent()`'s existing (previously unreachable in
    // practice -- see N10 in feedback-reassessment.md) budget-exceeded
    // check can actually fire. Omitted (the default): `context.budget.total`
    // stays `null` (unlimited), identical to every run before this option
    // existed -- this is purely additive. There is currently no CLI flag
    // that sets this (bin/cli.mjs is out of this issue's scope); a caller
    // going through WorkflowEngine.executeFile() directly (as this
    // package's own tests do) can pass `{ ..., budget: 1.23 }`.
    if (args.budget !== undefined && (typeof args.budget !== 'number' || !Number.isFinite(args.budget) || args.budget < 0)) {
        throw new Error(`[Arg Contract] Invalid budget "${args.budget}": must be a non-negative finite number (USD ceiling).`);
    }

    // --- serviceUrl (optional; apra-fleet-eft.9.2/9.3/9.7) ----------------
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

    // --- assignee (optional; apra-fleet-eft.9.7) --------------------------
    // The work-claiming identity. Constrained to a shell-injection-safe pattern
    // because it is interpolated into `bd update --claim` / `bd ready
    // --assignee` command strings, matching the same defense-in-depth posture
    // as issue ids and branch names above.
    if (args.assignee !== undefined) {
        if (typeof args.assignee !== 'string' || args.assignee.length === 0 || !ISSUE_ID_PATTERN.test(args.assignee)) {
            throw new Error(`[Arg Contract] Invalid assignee "${args.assignee}": must match ${ISSUE_ID_PATTERN} (letters, digits, '.', '_', '-' only).`);
        }
    }

    // --- dispatch_timeout_s (optional, default 3600; stabilization Issue 32) --
    // Per-dispatch time budget in seconds, applied as BOTH timeout_s and
    // max_total_s on every agent dispatch (Issue 12: `claude -p` is silent
    // until the turn completes, so inactivity == total runtime and the two
    // timers must be equal for the ceiling to be reachable); the integ-test
    // dispatch ceiling is 2x this value (Issue 30: its real suites + smoke
    // sprint legitimately run past one budget). Lowering it bounds the cost
    // of a live-but-silent member hang (observed run 15 integ C5: PID alive,
    // zero output, no timer able to distinguish hang from work) -- a small
    // sprint (e.g. a sandbox canary) can pass 600-900 so a hang costs
    // minutes, not an hour. Floor 60: below that even healthy dispatches
    // cannot complete a single turn.
    const dispatchTimeoutS = args.dispatch_timeout_s === undefined ? 3600 : args.dispatch_timeout_s;
    if (typeof dispatchTimeoutS !== 'number' || !Number.isInteger(dispatchTimeoutS) || dispatchTimeoutS < 60) {
        throw new Error(`[Arg Contract] Invalid dispatch_timeout_s "${dispatchTimeoutS}": must be an integer >= 60 (seconds).`);
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
            'beyond the original sprint goals and any open bugs/enhancements already in beads. ' +
            // Stabilization log Issue 14 -- see buildPlanReviewerPrompt's matching guard.
            'A feature whose children are ALL closed is pending feature-closure ' +
            '(the integration-test phase closes verified features): leave it exactly as it ' +
            'is -- do not decompose it again and do not create tasks duplicating its closed ' +
            'children, even if review feedback appears to ask for decomposition of such a ' +
            'feature (verify with bd list --parent <feature> --all first).'
        );
        // Stabilization log Issue 33 (run 15 C5): the pending-closure rule
        // has a REGRESSION exception for bugs, or a regressed bug becomes
        // unreachable by every role -- the planner refuses to re-decompose,
        // doers refuse non-task beads, and the integ runner may only
        // verify-and-close. Run 15 burned three full develop rounds (9 doer
        // refusals each) on exactly this state and ended FAIL on two such
        // bugs.
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
        // Stabilization log Issue 21 -- see buildPlanReviewerPrompt's
        // matching criterion. Doers may only claim issue_type=task, so a
        // bug left as a childless leaf is assigned directly and skipped
        // every round (observed run 12 C3: apra-fleet-eft.15 -> BLOCKED).
        'Doers can only claim issue_type=task beads. Any OPEN bug-type bead in scope ' +
        'that has no task-type children yet must be decomposed during planning into ' +
        'one or more task-type children (with acceptance criteria and model metadata, ' +
        'including a [test] task where the fix is testable) -- the bug bead itself is ' +
        'never dispatched directly and stays open as the parent until its children ' +
        'are done and verified.'
    );
    // Issue 29: the old version of this pin spent a sentence warning against
    // '-tier'-suffixed spellings; the engine now normalizes those
    // deterministically (normalizeTierToken), so the prompt carries only the
    // affirmative instruction -- enforce in code, not in prompt legalese.
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
        // Stabilization log Issue 14: mid-sprint, a feature whose children
        // are ALL closed is in the pending-feature-closure state -- feature
        // closure is the integ-test phase's job, not the planner's. Two runs
        // (9 and 10) burned entire 3-round plan phases because a reviewer
        // dispatch read such features as "undecomposed" (its child queries
        // returned only OPEN children) and demanded re-decomposition, which
        // the planner cannot sensibly satisfy without recreating closed
        // work (observed: run 9's planner did exactly that and the NEXT
        // review round correctly rejected the duplicates). Other dispatches
        // of the same reviewer read the same state correctly as
        // "eligible for closure, non-blocking" -- so pin the correct
        // interpretation here.
        'IMPORTANT -- pending-closure features: before flagging any feature as ' +
        'undecomposed (no child tasks / no [test] task) or as missing model metadata, ' +
        'check its CLOSED children too (bd list --parent <feature> --all). A feature ' +
        'whose children are all closed is PENDING FEATURE-CLOSURE housekeeping (the ' +
        'integration-test phase closes verified features) -- it is NOT undecomposed, ' +
        'must NOT fail coverage/decomposition/test-task/model-metadata criteria, and ' +
        'must NOT be re-decomposed. Mention such features as non-blocking notes only. ' +
        'Never ask the planner to create tasks that duplicate closed work.',
        // Stabilization log Issue 21: the C3 plan of run 12 assigned a
        // childless bug-type bead (apra-fleet-eft.15) directly and was
        // approved -- but doers may only claim issue_type=task, so the doer
        // skipped it as BLOCKED and the streak burned. The mirror-image of
        // the pending-closure rule above: bugs must be decomposed before
        // they are dispatchable.
        'DISPATCHABILITY -- doers can only claim issue_type=task beads. If any OPEN ' +
        'bug-type bead in scope is a childless leaf (no task-type children, so it ' +
        'would be dispatched to a doer directly), the plan is NOT approvable: return ' +
        'CHANGES_NEEDED asking the planner to decompose that bug into task-type ' +
        'children. This does not apply to features covered by the pending-closure ' +
        'rule above.',
        // Stabilization log Issue 33 -- see buildPlannerPrompt's matching
        // REGRESSION EXCEPTION. Without this criterion the reviewer reads a
        // regressed bug (children closed, fresh repro evidence) as ordinary
        // pending-closure and approves a plan that gives it no fix work;
        // run 15 C5 ended FAIL on two such bugs.
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
        // Observed live (run 8, Develop C2 R1): the model returned
        // suffix-stripped ids ("8.4" for "apra-fleet-eft.8.4"), which are
        // rejected wholesale and silently cost the entire grouping. Bead ids
        // from different scopes need not share any prefix, so a shortened id
        // is not merely sloppy -- it is ambiguous and unrecoverable.
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
 * beads itself. agents/reviewer.md's own prose (Step 5, Rules) already
 * states this same prohibition -- prose and dispatch prompt agree today --
 * but the schema alone doesn't stop the reviewer from shelling out `bd`
 * commands on the member side regardless of what either document says, so
 * the prohibition is stated here too as defense in depth, not because of
 * any known prose/code divergence.
 * @param {{ beadIds: string[], acceptanceCriteriaJson: string, baseBranch: string, branch: string }} opts
 * @returns {string}
 */
function buildReviewerPrompt({ beadIds, acceptanceCriteriaJson, baseBranch, branch, goal }) {
    return [
        `Review the work just done for the following bead id(s): ${beadIds.join(', ')}.`,
        'Full task detail (including acceptance criteria), from `bd show --json`:',
        wrapUntrustedBlock('bd show --json', acceptanceCriteriaJson),
        `Diff range to review: ${baseBranch}..${branch} (base_branch..branch).`,
        // Stabilization log Issue 17: run 11's cycle-3 reviewer judged the
        // whole epic diff and blocked on the DEFERRED out-of-goal P3
        // features (eft.10/11/12) not being delivered -- work this sprint
        // deliberately does not do. That verdict can never reach APPROVED,
        // which starves the completion gate (zero open goal beads AND an
        // APPROVED verdict). Scope the verdict to the sprint's goal.
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
        '`bd create`. Return ONLY your structured verdict (verdict, notes, reopenIds, ' +
        'newTasks) strictly as the required JSON schema; never touch beads yourself.',
    ].join('\n\n');
}

/**
 * apra-fleet-unw2.6 (N8, work item b): detects the reviewer contract
 * violation described on `ReviewerContractViolationError` -- a
 * `CHANGES_NEEDED` verdict that names nothing to reopen and proposes no new
 * follow-up work is schema-legal but self-contradictory: there is nothing
 * for the orchestrator to act on, so the sprint can never make progress off
 * of it.
 * @param {{ verdict: string, reopenIds?: string[], newTasks?: object[] }} verdict
 * @returns {boolean}
 */
function isReviewerContractViolation(verdict) {
    return verdict.verdict === 'CHANGES_NEEDED'
        && (!verdict.reopenIds || verdict.reopenIds.length === 0)
        && (!verdict.newTasks || verdict.newTasks.length === 0);
}

// ---------------------------------------------------------------------------
// newTasks validation (apra-fleet-unw2.3 / N3): reviewer-authored newTasks
// are LLM output -- and the reviewer's own context includes the diff under
// review, so an adversarial diff/commit could try to steer the reviewer
// into emitting a title/description crafted to break out of the
// double-quoted `bd create "..."` shell command below (backticks and
// `$(...)` both survive inside POSIX double quotes; a trailing backslash
// can neutralize/escape the closing quote). Because sprint members run
// mixed shells (POSIX vs Windows), no single escaping scheme is reliably
// safe across all of them -- so this validates with an ALLOWLIST instead of
// trying to escape: anything outside the allowlist is rejected before it
// ever reaches `command()`, independent of whatever escaping the member
// shell would otherwise need.
//
// SAFE_TEXT_RE deliberately excludes: backtick, `$`, double-quote (the
// command's own quoting delimiter -- allowing it back in would let a
// title/description close the quote early regardless of any other
// restriction), and backslash (blocks a trailing-backslash "escape the
// closing quote" trick as well as any other backslash-based escape
// sequence). The allowed punctuation (`.,:;!?()'-_/` plus space) covers
// realistic task titles/descriptions while remaining inert as shell syntax
// in both POSIX and Windows member shells.
const SAFE_TEXT_RE = /^[A-Za-z0-9 .,:;!?()'_/-]+$/;
const SAFE_PRIORITY_RE = /^P[0-4]$/;

/**
 * Validates one reviewer-authored newTask entry BEFORE it is ever
 * interpolated into a `bd create` command string. Returns either
 * `{ ok: true, title, description, priority }` (safe to interpolate) or
 * `{ ok: false, reason }` (must be rejected -- logged, surfaced in the run
 * summary, and never sent to `command()`; rejection is non-fatal, the
 * sprint continues).
 * @param {{ title: unknown, description: unknown, priority: unknown }} newTask
 * @returns {{ ok: true, title: string, description: string, priority: string } | { ok: false, reason: string }}
 */
// Stabilization log Issue 29: bead model metadata arrives from MANY authors
// (planner runs, out-of-band injections, older sprints), and the
// '-tier'-suffixed forms of the three tier names keep appearing despite the
// planner-prompt pin (the pin exists precisely because agents kept writing
// them). A raw unknown token reaches execute_prompt verbatim and falls
// through the server's tier map as a LITERAL provider model name, failing
// the entire dispatch with a provider 404 -- observed live (run 15 C3 R3):
// metadata {"model": "standard-tier"} -> claude --model standard-tier ->
// api_error_status 404, streak lost. Normalize the unambiguous aliases at
// the single engine read site; every OTHER value passes through untouched so
// an explicit concrete model id in metadata still works deliberately.
/**
 * Normalizes a bead-metadata model value by CONTAINMENT: if the value
 * (case-insensitive) contains exactly ONE of the three tier names --
 * 'cheap', 'standard', 'premium' -- it normalizes to that bare tier name,
 * so 'standard-tier', 'tier-standard', 'Standard (default)' all resolve to
 * 'standard'. A value containing zero tier names (explicit model ids: no
 * mainstream provider id contains these words) or MORE than one (ambiguous,
 * e.g. 'standard-or-premium') passes through unchanged.
 * @param {unknown} raw
 * @returns {unknown}
 */
export function normalizeTierToken(raw) {
    if (typeof raw !== 'string') return raw;
    const lowered = raw.toLowerCase();
    const matches = ['cheap', 'standard', 'premium'].filter((tier) => lowered.includes(tier));
    return matches.length === 1 ? matches[0] : raw;
}

export function validateNewTask(newTask) {
    const priority = String(newTask && newTask.priority);
    if (!SAFE_PRIORITY_RE.test(priority)) {
        return { ok: false, reason: `priority '${priority}' does not match required pattern ${SAFE_PRIORITY_RE}` };
    }
    const title = String(newTask && newTask.title);
    if (!title || !SAFE_TEXT_RE.test(title)) {
        return { ok: false, reason: `title fails safe-character allowlist ${SAFE_TEXT_RE} (or is empty): ${JSON.stringify(title)}` };
    }
    const description = String(newTask && newTask.description);
    if (!description || !SAFE_TEXT_RE.test(description)) {
        return { ok: false, reason: `description fails safe-character allowlist ${SAFE_TEXT_RE} (or is empty): ${JSON.stringify(description)}` };
    }
    return { ok: true, title, description, priority };
}

// ---------------------------------------------------------------------------
// PR body/title text sanitization (apra-fleet-hfs): the final reviewer's
// verdict (finalVerdictResult, produced by the finalVerdict-schema agent
// dispatch below) is LLM output, and its free-text `notes` field is embedded
// directly in the PR title/body string that the Publish PR step interpolates
// into a double-quoted `gh pr create --title "..." --body "..."` command()
// string. That is the exact same injection class as N3 above (backtick and
// `$(...)` command substitution both survive inside POSIX double quotes; a
// trailing backslash can neutralize/escape the closing quote) -- just a
// different call site, first flagged by unw2.9's adversarial reviewer and
// tracked as apra-fleet-hfs.
//
// Unlike validateNewTask() (N3), a rejection is not an option here: the PR
// must still be published with the sprint's verdict visible to a human
// reviewer even when the notes are malformed -- the "fail closed" allowlist
// used for newTasks would mean an adversarial/malformed verdict silently
// drops the ONE thing (verdict notes) a human reviewer most needs to see. So
// this SANITIZES instead of rejecting: every character outside the
// SAFE_TEXT_RE allowlist above (same allowlist, same "strip over escape"
// reasoning -- sprint members run mixed shells and no single escaping scheme
// is reliably safe across all of them) is replaced with a space, so the
// notes remain readable in the PR body rather than being dropped outright,
// while nothing that can break out of the double-quoted command string ever
// reaches `command()`.
/**
 * Sanitizes LLM-authored free text (e.g. finalVerdictResult.notes) before it
 * is interpolated into a double-quoted `gh pr create`/`git` command() string.
 * Strips (does not escape) every character outside SAFE_TEXT_RE, collapses
 * the resulting whitespace, and returns the still-readable remainder -- see
 * the comment above for why stripping is preferred over escaping here.
 * @param {unknown} text
 * @returns {string}
 */
export function sanitizePrText(text) {
    const str = String(text ?? '');
    let out = '';
    for (const ch of str) {
        // Newlines/tabs collapse to a plain space along with every other
        // disallowed character -- SAFE_TEXT_RE intentionally has no
        // multi-line allowance, since a literal newline embedded in a
        // double-quoted command-string argument is not reliably safe across
        // the mixed POSIX/Windows shells sprint members run (see N3 above).
        out += SAFE_TEXT_RE.test(ch) ? ch : ' ';
    }
    return out.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Integ report part-2 (smoke test) SHA-freshness validation (apra-fleet-eft.55.2)
// ---------------------------------------------------------------------------
//
// apra-fleet-eft.55 (run 19 Integ C5): a resumed integ-test-runner session
// reused a part-2 (smoke test) result executed EARLIER in the same session,
// before the cycle's fixes were deployed, then issued verification verdicts
// from that stale evidence. The Integ Test dispatch (runSprintCycle, below)
// hands the runner this cycle's deploy-verified SHA and instructs it to echo
// that SHA back in its report's `summary` using the literal marker
// "PART2_SHA: <sha>" once part 2 has actually run against it (see
// `part2ShaClause`). These two pure functions extract and validate that
// marker; the dispatch call site treats an absent/mismatched SHA as
// INCONCLUSIVE rather than trusting the report's `passed` field.

// Case-insensitive; matches a short or full git SHA following the marker.
const PART2_SHA_MARKER_RE = /PART2_SHA:\s*([0-9a-f]{7,40})/i;

/**
 * Extracts a `PART2_SHA: <sha>` marker from an integ-test-runner report's
 * free-text `summary`, if present.
 * @param {unknown} summary
 * @returns {string|null} the SHA, lowercased, or null if no marker is found.
 */
export function extractPart2Sha(summary) {
    if (typeof summary !== 'string') return null;
    const match = PART2_SHA_MARKER_RE.exec(summary);
    return match ? match[1].toLowerCase() : null;
}

/**
 * Validates that an integ-test-runner report's part-2 (smoke test) evidence
 * is fresh -- i.e. cites THIS cycle's deploy-verified SHA, not a prior
 * deploy's stale result carried over by a resumed session. Pure/testable:
 * takes the already-dispatched integ report and the engine-computed
 * deploy-verified SHA for this cycle; does no I/O itself.
 *
 * A short SHA on either side is accepted as a match via prefix comparison
 * (git's own short-SHA convention), so a runner that only has `git rev-parse
 * --short HEAD` available is not unfairly penalized.
 * @param {{summary?: string}} integResult - the integ-test-runner's report.
 * @param {string|null} deployedSha - this cycle's deploy-verified SHA
 *   (lowercased), or null if the engine could not resolve one this cycle --
 *   in which case there is nothing to validate against, so this always
 *   returns `inconclusive: false` (falls back to plain pass/fail handling).
 * @returns {{ inconclusive: boolean, reason: ('absent'|'mismatched'|null), reportedSha: (string|null) }}
 */
export function validatePart2Evidence(integResult, deployedSha) {
    const reportedSha = extractPart2Sha(integResult && integResult.summary);
    if (!deployedSha) {
        return { inconclusive: false, reason: null, reportedSha };
    }
    if (!reportedSha) {
        return { inconclusive: true, reason: 'absent', reportedSha: null };
    }
    const normalizedDeployed = deployedSha.toLowerCase();
    const matches = normalizedDeployed === reportedSha
        || normalizedDeployed.startsWith(reportedSha)
        || reportedSha.startsWith(normalizedDeployed);
    if (!matches) {
        return { inconclusive: true, reason: 'mismatched', reportedSha };
    }
    return { inconclusive: false, reason: null, reportedSha };
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
        // N3: reviewer-proposed newTasks that failed the pre-interpolation
        // allowlist (see validateNewTask) are non-fatal to the sprint but
        // must be visible to a human -- surfaced here in the same evidence
        // block the final reviewer/human reads.
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
 * Assembles the real `analysisText` block for the Harvester dispatch (N12,
 * apra-fleet-unw2.10) from this run's actual in-memory tracking state --
 * cycle-by-cycle closed-bead progress, deploy/integration outcomes, rejected
 * reviewer newTasks, and the final verdict. Every source here already exists
 * elsewhere in this file (closedCountHistory/highWaterClosedCount from N9's
 * stall detector, deployFailures/integFailures from A4, rejectedNewTasks
 * from N3, finalVerdictResult from A6) -- this just formats them into the
 * verbatim content the harvester writes to `analysisArtifactFile`, per
 * harvester.md Step 1 ("write the analysisText verbatim").
 * @param {object} opts
 * @returns {string}
 */
function buildAnalysisText({
    targetIssues, branch, baseBranch, cyclesRun,
    closedCountHistory, highWaterClosedCount,
    deployFailures, integFailures, rejectedNewTasks,
    finalVerdictResult, finalClosedCount, finalOpenAtGoalCount,
}) {
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
    ];
    return lines.join('\n');
}

/**
 * Builds the `costAnalysis` block for the Harvester dispatch (N12) from the
 * live `budget` object (wired in N10/apra-fleet-unw2.8). Reports only what
 * is actually known -- an unset ceiling or an unpriced-model spend gap is
 * stated as "not tracked"/"unlimited", never backfilled with a fabricated
 * number (per F2's honesty goal and the harvester contract's "insert
 * verbatim, do not recompute" rule).
 * @param {{ total: number|null, spent?: () => number, remaining?: () => number }} budget
 * @returns {string}
 */
function buildCostAnalysis(budget) {
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
    // apra-fleet-dv5.6: reports the SOURCE of each priced dispatch's cost --
    // real per-member rates (get_member_model_pricing) vs. pricing.mjs's
    // tier-band/concrete-model fallback -- so this note stays honest about
    // precision rather than implying every number above is equally exact.
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
 * `docs/sprint-analysis-<slug>.md` (the harvester's `analysisArtifactFile`
 * input). Exported (apra-fleet-unw2.22, N12 follow-up) purely for direct
 * unit testing, per this file's existing convention of exporting otherwise-
 * internal pure helpers (parseBdJson, validateArgs, checkMemberTopology,
 * validateNewTask) for testability.
 *
 * A naive `branch.replace(/[\\/]+/g, '-')` is not collision-free: two
 * differently-named branches that differ only in a `/` vs. a pre-existing
 * `-` at the same position (e.g. `feat/fleet-reorg` and `feat-fleet-reorg`)
 * would otherwise collapse to the identical slug and clobber each other's
 * analysis artifact if both sprints ever ran against the same
 * repo/worktree in overlapping windows. A short content hash of the RAW
 * (pre-replace) branch name is appended to disambiguate -- it stays
 * deterministic per branch (same idempotent-rerun/golden-transcript
 * guarantee the human-readable prefix already provided) while making slug
 * collisions cryptographically negligible.
 * @param {string} branch
 * @returns {string}
 */
export function computeBranchSlug(branch) {
    const humanReadablePrefix = branch.replace(/[\\/]+/g, '-');
    const disambiguatingHash = createHash('sha256').update(branch).digest('hex').slice(0, 8);
    return `${humanReadablePrefix}-${disambiguatingHash}`;
}

/**
 * Builds the self-contained Harvester dispatch prompt, per the vendored
 * harvester.md contract's documented inputs. N12 (apra-fleet-unw2.10): this
 * runner now wires the five required inputs
 * (analysisArtifactFile/analysisText/costAnalysis/base-branch/branch) with
 * real, runner-computed values instead of instructing the harvester to
 * treat them as unavailable -- the prior version of this prompt told a
 * contract-obeying harvester to violate its own contract every sprint (see
 * N12, feedback-reassessment.md). The vendored input schema is intentionally
 * not loosened; the fix is entirely on the caller side. Exported (apra-
 * fleet-unw2.22) so tests can directly build a harvester prompt with
 * forced-blank inputs and assert the hardened mock contract check catches
 * it, without needing to reconstruct this format by hand or spin up a full
 * sprint run.
 * @param {{ branch: string, baseBranch: string, targetIssues: string[], analysisArtifactFile: string, analysisText: string, costAnalysis: string }} opts
 * @returns {string}
 */
export function buildHarvesterPrompt({ branch, baseBranch, targetIssues, analysisArtifactFile, analysisText, costAnalysis }) {
    // analysisText/costAnalysis are orchestrator-computed (this file, from
    // real run state), not another agent's free text -- wrapUntrustedBlock's
    // "untrusted output from another agent" framing does not apply. They
    // still need a collision-safe fence (per-block, sized past the longest
    // backtick run in the content) so a literal ``` line inside either
    // block can never be mistaken for its closing fence.
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
// Typed sprint-abort detection (apra-fleet-eft.1.2)
// ---------------------------------------------------------------------------
//
// The single predicate that decides whether an error thrown out of
// runSprintCycle() (renamed from main() below) is a "sprint-abort" the
// caller should route through finalizeAbort() + a terminal history record,
// as opposed to a genuinely unexpected/untyped failure that must keep
// today's behavior (grace window, exit 1, no PR, no history-record write).
// Covers:
//   - every WorkflowError subclass this runner throws itself
//     (StalledSprintError, SprintPlanRejectedError,
//     ReviewerContractViolationError -- errors.mjs) or that the workflow
//     package throws on its behalf (BudgetExceededError);
//   - the plain `Error` pre-sprint validation failures thrown above (they
//     predate errors.mjs and are not WorkflowError subclasses, but the
//     plan explicitly scopes them as sprint-abort paths too) -- identified
//     by their stable 'Pre-sprint validation failed:' message prefix, the
//     same string every one of those throw sites already uses.
// Deliberately excludes CancelledError: a cooperative /stop-triggered
// cancellation is a normal, requested shutdown, not an aborted sprint, and
// must keep flowing through its own existing 'cancelled' status path
// untouched.
export function isTypedAbortError(err) {
    if (!err || err instanceof CancelledError) return false;
    if (err instanceof WorkflowError) return true;
    return typeof err.message === 'string' && err.message.startsWith('Pre-sprint validation failed:');
}

// ---------------------------------------------------------------------------
// Abort-path PR publish (apra-fleet-eft.1 / eft.1.1)
// ---------------------------------------------------------------------------
//
// Today a PR is only raised on the two "the sprint ran to a final verdict"
// outcomes (PASS/FAIL, see the Publish PR step in main() below). A sprint
// that instead ABORTS by throwing a typed error (StalledSprintError,
// SprintPlanRejectedError, ReviewerContractViolationError, budget-exceeded,
// pre-sprint validation errors -- all extend WorkflowError, see errors.mjs)
// propagates straight to bin/cli.mjs's top-level catch today: grace window,
// exit 1, no branch push, no PR -- so any real work a doer committed before
// the abort is invisible to a human unless they know to go dig through the
// sprint's git history by hand. finalizeAbort() is the fix for that: it is
// called from the typed-abort catch site (apra-fleet-eft.1.2, a separate
// task) with the error that caused the abort, and:
//   1. counts commits on the sprint branch beyond base (this is what decides
//      whether there is anything for a human to look at -- a zero-commit
//      abort has produced no diff, so an [ABORTED] PR for it would be pure
//      noise per the already-resolved zero-commit-abort policy decision);
//   2. iff >=1 commit: pushes the branch and raises an idempotent
//      'Auto-sprint [ABORTED]: <branch>' PR whose body carries the typed
//      error's evidence (code/message/details), sanitized the exact same
//      way the PASS/FAIL Publish PR step below sanitizes reviewer notes
//      (sanitizePrText -- see the comment above its definition: this is
//      LLM/error-surfaced free text landing in a double-quoted `gh pr
//      create` command() string, the same injection class as N11/hfs);
//   3. iff 0 commits: raises no PR at all and says so in the return value,
//      so the caller can still write a terminal history record (eft.1.2)
//      without a dangling/empty-diff PR.
// `command` (and, for logging, `log`) are dependency-injected rather than
// closed over `context` -- this function is called both from main()'s catch
// site (where `context`'s destructured `command`/`log` are already in
// scope) and directly from unit tests (eft.1.3) with a mock `command`, with
// no need to spin up a full sprint run to exercise it either way.
/**
 * @param {{
 *   error: { code?: string, message?: string, details?: unknown },
 *   branch: string,
 *   baseBranch: string,
 *   member: string,
 *   command: (cmd: string, opts: object) => Promise<any>,
 *   log?: (msg: string) => void,
 * }} opts
 * @returns {Promise<{ prUrl: string|null, reason: string, pushed: boolean, commitCount: number }>}
 */
export async function finalizeAbort({ error, branch, baseBranch, member, command, log = () => {} }) {
    // 1. How many commits (if any) does the sprint branch carry beyond base?
    // Every command() call below passes an explicit `member_name: member` --
    // this runner never lets a git/gh dispatch fall back to an implicit/
    // ambient member (see the SUPPORTED-TOPOLOGY NOTE near orchestratorMember
    // above for why that matters in a multi-member fleet).
    //
    // `member` (the abort-path diff runner) is not necessarily the same
    // member that ever created/checked out a LOCAL branch literally named
    // `baseBranch` -- it may only have the sprint branch itself checked out.
    // A bare `git rev-list base..branch` then fails with exit 128 ("unknown
    // revision or path not in the working tree"), observed live on a real
    // abort (apra-fleet-eft). Fetch it and diff against the remote-tracking
    // ref instead, which is always resolvable as long as origin has the
    // branch (true by construction -- baseBranch is the same ref the sprint
    // branch itself was validated/created from).
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
    // Same sanitization rationale as the PASS/FAIL Publish PR step below:
    // the typed error's message/details/code can originate from agent
    // output or other untrusted-ish sources upstream, and this text is
    // interpolated into a double-quoted `gh pr create` command() string.
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
            // N11-style idempotency (see the PASS/FAIL Publish PR step
            // below): the desired end state (a PR is open for this branch)
            // already holds, so this is swallowed rather than thrown. The
            // real `gh`/mock error text carries the existing PR's URL
            // inline (e.g. "... already exists: https://.../pull/1 ...");
            // pull it out so the caller/history record can still surface a
            // usable link rather than just `null`.
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
// Client-side dispatch-timeout watchdog for the interactive Planner path
// (apra-fleet-eft.28.3)
// ---------------------------------------------------------------------------
//
// apra-fleet-eft.28 RECURRED (integ cycle 6) despite eft.28.1's fix (dead-PID
// fast-fail on execute_prompt's interactive-session reuse check, both at
// pre-dispatch time and via the 5s liveness poll racing the response wait --
// src/tools/execute-prompt.ts) and eft.28.2 (proving runner.js's own retry
// loop surfaces that fast-fail as a bounded, logged+persisted terminal
// failure). Both of those only fire when the member's claude PID is actually
// DEAD. The recurrence was a member process that stayed ALIVE but produced
// zero further output after the prompt was delivered -- a frozen-but-alive
// interactive/elicitation session -- which no PID check can ever catch, and
// which is exactly the failure mode `dispatch_timeout_s` exists to bound.
// `timeout_s`/`max_total_s` are already threaded to execute_prompt on every
// dispatch (including the Planner's, see DISPATCH_TIMEOUT_S usage below),
// but the live symptom (state.json frozen for 2m15s+, zero further log
// lines, no watchdog firing) means that server-side enforcement cannot be
// trusted as the ONLY backstop for this specific pre-plan dispatch. This adds
// a second, client-side one that does not depend on the server noticing
// anything at all.
//
// withDispatchWatchdog() races an already-in-flight dispatch promise against
// a LOCAL timer set to `timeoutS` seconds plus a small fixed grace period
// (so the server's own timeout_s-driven rejection -- the normal, already-
// logged/tested path -- gets first refusal at producing a clean error). If
// the dispatch has not settled by the time the local timer fires, this
// rejects with a typed AgentDispatchError (reason: 'watchdog_timeout')
// instead of leaving the caller awaiting silently: the SAME typed-error
// plumbing eft.28.2 already proved flows through runner.js's Planner retry
// loop, isTypedAbortError()'s typed-abort routing in main(), AND (via
// bin/cli.mjs's unconditional catch-block release) the per-sprint member
// reservation release -- so a watchdog-timeout abort is logged, persisted to
// sprint state as a terminal failure, and releases every reserved member,
// exactly like every other typed dispatch failure this file already handles.
// The abandoned underlying dispatch promise is never left dangling
// un-awaited (Promise.race() attaches its own rejection handler to it), so a
// late resolution/rejection after the watchdog has already fired is safely
// dropped rather than becoming an unhandled rejection.
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
        // apra-fleet-eft.50.1: the watchdog timer is deliberately NOT unref'd.
        // Its entire contract (see this function's doc comment) is to guarantee
        // a stalled/dead dispatch is aborted at a bounded, logged budget rather
        // than left "alive-but-silent" -- and an unref'd timer defeats exactly
        // that guarantee whenever it is the ONLY work left on the event loop.
        // A frozen dispatch (a never-settling promise, e.g. a dead persistent
        // interactive session -- the eft.28/eft.50 hang) leaves nothing else
        // scheduled: in production a long-lived server/MCP loop happens to keep
        // the process alive so the unref'd timer still fired, but under
        // node:test's replay-mode harness (no child processes during the wait)
        // the loop drained BEFORE the unref'd timer could fire, so the abort
        // never happened and the run hung silently ("Promise resolution is
        // still pending but the event loop has already resolved") -- the precise
        // silent hang this watchdog exists to prevent, dependent only on which
        // platform/Node build happened to hold the loop open. Keeping the timer
        // ref'd makes the watchdog self-sufficient: the loop stays alive until
        // the abort fires (or the dispatch settles first and clearTimeout() in
        // the finally below releases it, so a normal fast dispatch never delays
        // a clean process exit).
    });
    return Promise.race([dispatchPromise, watchdogPromise]).finally(() => clearTimeout(timer));
}

// Mechanical migration to the WorkflowEngine's ES-module entry-point contract
// (apra-fleet-unw.7): the engine now calls `main(context)` instead of
// injecting bare globals into an AsyncFunction scope. This destructure is the
// only change to this file's wiring -- every name below (agent, command,
// parallel, log, phase, group, endGroup, publishState, args) is the exact
// same binding the old bare-global version referred to; no control-flow or
// dispatch-order changes.
async function runSprintCycle(context) {
    const { agent: agentRaw, command, parallel, log, phase, group, endGroup, publishState, args, budget } = context;

    // A stable per-sprint id for mutex fairness/introspection: the sprint branch
    // is unique per concurrent sprint on the shared remote.
    const sprintMutexId = (args && args.branch) ? String(args.branch) : 'sprint';

    // apra-fleet-eft.29.1: stamp every agent() dispatch below with the SAME
    // opaque sprint-identity token (sprintMutexId) createMemberReservationClient
    // reserves members under (bin/cli.mjs's `sprintId: branchName`), so
    // execute_prompt's dispatch-time reservedBy check (src/tools/execute-prompt.ts)
    // can recognize a dispatch as coming from the reservation's OWNING sprint even
    // when the fleet server it dispatches through is a pre-existing shared HTTP
    // singleton with no per-sprint APRA_FLEET_SPRINT_ID env of its own (root cause
    // of apra-fleet-eft.29). A single wrapper here covers every `agent(...)` call
    // site in this file for free; an explicit `sprintId`/`sprint_id` in an
    // individual call's opts (none today) would still win via the spread order.
    const agent = (prompt, opts = {}) => agentRaw(prompt, { sprint_id: sprintMutexId, ...opts });

    // apra-fleet-eft.9.2 (Plan 3.4): the supervisor-owned global dolt push mutex
    // client. Every D-push below serializes through it so two sprints never push
    // at the same time (constraints C.2/C.3). Three sources, in precedence:
    //   1. `context.doltPushMutex` -- an explicitly-injected client (tests wire
    //      an in-process one here to prove the bracket serializes without HTTP).
    //   2. `args.serviceUrl` present -- the REAL end-to-end path: build an
    //      HTTP-backed client that acquires/releases against the always-on
    //      supervisor's mutex routes, so two independently-detached sprint
    //      children genuinely serialize their pushes through one supervisor.
    //   3. neither -- a no-op client: a lone sprint (single-process/dev/test)
    //      has, by definition, no second sprint to conflict with, so the push
    //      is safely unguarded and the D-push call sites stay uniform (they
    //      always acquire/release; only the wiring differs).
    const doltPushMutex = context.doltPushMutex ?? (
        (args && args.serviceUrl)
            ? createHttpDoltPushMutexClient({ serviceUrl: args.serviceUrl, sprintId: sprintMutexId, log })
            : {
                async acquire() { return { token: null }; },
                async release() { return true; },
            }
    );

    // apra-fleet-eft.9.3 (Plan 3.4): the supervisor-owned global child-id
    // allocator client. Every reviewer-proposed newTask create below mints its
    // id through it so two sprints creating children under the SAME parent never
    // derive the same child id (constraint C.4). Same three-source precedence as
    // the push mutex above:
    //   1. `context.idAllocator` -- an explicitly-injected client (tests wire an
    //      in-process one to prove the create path allocates without HTTP).
    //   2. `args.serviceUrl` present -- the REAL end-to-end path: an HTTP-backed
    //      client that allocates/confirms against the always-on supervisor's
    //      allocator routes, so two detached sprint children genuinely serialize
    //      their id minting through one supervisor authority.
    //   3. neither -- a no-op client: a lone sprint has, by definition, no second
    //      sprint that could mint a colliding id, so bd derives the id itself
    //      (childId null -> no `--id` flag). The create call sites stay uniform.
    const childIdAllocator = context.idAllocator ?? (
        (args && args.serviceUrl)
            ? createHttpChildIdAllocatorClient({ serviceUrl: args.serviceUrl, sprintId: sprintMutexId, log })
            : {
                async allocate() { return { childId: null, token: null }; },
                async confirm() { return true; },
                async release() { return true; },
            }
    );

    // Validate BEFORE any agent()/command() dispatch (apra-fleet-unw.14,
    // A7 defense in depth): a rejected/malformed arg must result in zero
    // fleet dispatches.
    const validated = validateArgs(args);

    // Stabilization Issue 32: the per-dispatch time budget every dispatch
    // site below uses for BOTH timeout_s and max_total_s (Issue 12: silent-
    // until-done CLIs make inactivity == total runtime, so the two must be
    // equal). The integ-test dispatch alone gets a 2x ceiling (Issue 30).
    const DISPATCH_TIMEOUT_S = validated.dispatchTimeoutS;
    const INTEG_MAX_TOTAL_S = DISPATCH_TIMEOUT_S * 2;

    // N10 (apra-fleet-unw2.8): apply the optional `budget` arg ceiling to
    // THIS run's budget object. Every prior version of this runner ignored
    // `context.budget` entirely, so `budget.total` stayed `null` (unlimited)
    // for every run regardless of caller intent -- one of the two reasons
    // (the other being no `opts.model` ever reaching `agent()`, fixed at
    // the doer/fixed-role dispatch sites below) `BudgetExceededError` was
    // unreachable in practice (see N10, feedback-reassessment.md). Setting
    // it here, before any dispatch, is what makes the ceiling enforceable
    // for the whole run -- `agent()` itself already checks
    // `budget.remaining() <= 0` before every dispatch (WF/src/workflow/
    // index.mjs), that mechanism was always correct, just never fed real
    // inputs.
    if (validated.budget !== undefined) {
        budget.total = validated.budget;
    }

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

    // N15 (apra-fleet-unw2.11): must use the canonical lowercase
    // ROLE_ORCHESTRATOR constant, not a literal -- see its doc comment near
    // the top of this file for why 'orchestrator' is an application-level
    // pseudo-role, deliberately outside contracts.ROLES.
    const orchestratorMember = getMemberForRole(ROLE_ORCHESTRATOR);

    // apra-fleet-eft.8.2 + eft.9.1 (Plan 3.3 insertion-point table): ONE shared
    // bracket wrapping EVERY role-identified agent() dispatch below -- planner,
    // plan-reviewer, doer, reviewer, deployer, integ-test-runner, harvester.
    // No phase-based exemptions: a deployer or integ-test-runner running
    // against a stale checkout/beads clone is exactly as damaging as a stale
    // doer/reviewer diff, so every one of the seven is bracketed identically.
    //
    // Two orthogonal sync axes, each pulled before and (optionally) pushed
    // after:
    //   - CODE (git, 8.1): `pushCode` is true ONLY for the code-writing roles
    //     (doer, harvester); every other role is read-side (G-pull before, a
    //     no-op G-push after -- see syncMemberAfter's short-circuit).
    //   - BEADS (dolt, 9.1): `pushBeads` is true for every role that MUTATES
    //     beads -- planner (creates tasks), doer (closes them),
    //     integ-test-runner (closes features / files bugs), harvester (defers
    //     issues). The pure read-side roles (reviewer, plan-reviewer, deployer)
    //     D-pull before and no-op D-push after. Note integ-test-runner is
    //     D-push WITHOUT git push (pushCode:false, pushBeads:true): it never
    //     touches code, only beads.
    //
    // The orchestrator's OWN beads mutations/reads (post-streak verification
    // D-pull, reopen/newTask D-push, cycle-eval/final-review D-pull) are NOT
    // dispatches and are bracketed separately at their own call sites below.
    //
    // Deliberately NOT applied to the Streak Assignment call further below:
    // that dispatch carries no `agentType`/persona of its own (see its own
    // call-site comment) and is not one of the seven dispatch types this
    // bracket covers.
    //
    // apra-fleet-eft.8.12: `agent` (already in scope in this closure, from
    // context) is passed through to syncMemberAfterOrdered so a G-push that
    // hits a real content conflict can attempt exactly one Tier 2
    // agent-with-runbook resolution before failing the streak -- see
    // syncMemberAfter's own doc comment for the full ladder and its
    // mechanical (never agent-trusted) re-verification. This is a no-op for
    // non-code-writing roles (pushCode:false short-circuits before the
    // conflict path is ever reached) and never fires for a plain, non-
    // conflict divergence.
    async function withGitSync(member, pushCode, dispatchFn, { pushBeads = false } = {}) {
        await syncMemberBefore(member, { command, log, branch: validated.branch });
        await doltPullBefore(member, { command, log });
        try {
            return await dispatchFn();
        } finally {
            // apra-fleet-eft.8.4 (Plan 3.3 push ordering): G-push (code)
            // before D-push (beads), for code-writing roles only. See
            // syncMemberAfterOrdered()'s own doc comment for the full
            // rationale (unreachable-close prevention) and unit tests in
            // mock-sprint-git-sync-brackets.test.mjs for the scripted-mock
            // coverage of this ordering.
            await syncMemberAfterOrdered(member, {
                command, pushCode, pushBeads, log, branch: validated.branch,
                mutex: doltPushMutex, sprintId: sprintMutexId, agent,
            });
        }
    }

    // apra-fleet-xbu.C1: `bd list --parent` accepts exactly one id per
    // invocation -- a comma-joined multi-target list (`--parent a,b`) is
    // silently treated as one nonexistent id and returns `[]`.
    //
    // auto-sprint-3: `bd list --parent <id>` is ALSO single-level only -- it
    // returns direct children, never grandchildren. The old implementation
    // (one `bd list --parent <target> <restArgs>` per target issue) could
    // therefore never see a level-3+ descendant (a feature's own task/test
    // children), which fed straight into readyLeafBeads()'s actual dispatch
    // scope, not just the dashboard tree -- confirmed empirically:
    // `bd list --parent <epic>` returns only the epic's direct
    // feature/bug children, never their own task/test children.
    //
    // Fix: pull the full project bead list ONCE per call (`--all` because
    // `bd list` excludes closed issues by default, which would silently drop
    // a closed node's parent link and orphan its whole subtree from
    // discovery -- e.g. a closed feature with still-open children; `--limit
    // 0` because the default 50-row cap could silently truncate a
    // larger-than-50-bead scope), build a parent->children map locally, then
    // BFS from every target issue in memory to find every descendant at any
    // depth, regardless of status. This also naturally subsumes the
    // multi-target union case (the BFS frontier simply starts with all
    // target issues) without a separate code path.
    //
    // Trade-off: this fetches the whole project's beads on every call
    // (373 beads project-wide as of 2026-07-18) rather than just this
    // scope's ~13-60 beads. Correctness for a P1 dispatch-scope bug was
    // judged worth the extra payload.
    //
    // `fetchAllBeadsShared` coalesces concurrent callers onto a single
    // in-flight request instead of letting each fire its own `bd list --all`
    // (the command text is always identical, so N concurrent callers would
    // otherwise issue N indistinguishable commands -- harmless against a
    // real `bd` CLI, but the bd-replay test shim matches recorded responses
    // FIFO per exact command string, and concurrent callers' real
    // completion order during recording is timing-dependent, not the same
    // as replay's queue order. Coalescing means only one command is ever
    // actually issued for a given overlapping window, so there is nothing
    // for the replay queue to misorder.
    let allBeadsInFlight = null;
    async function fetchAllBeadsShared() {
        if (!allBeadsInFlight) {
            const allLabel = 'bd list --all --limit 0 --json';
            allBeadsInFlight = command(allLabel, { member_name: orchestratorMember, silent: true })
                .then((raw) => parseBdJson(raw, allLabel))
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

        // apra-fleet-eft.24.1: seed scopeIds with any target issue that has
        // NO children of its own (a childless leaf target, e.g. a bare
        // issue_type=task with nothing decomposed under it yet). Without
        // this, scopeIds stayed empty for such a target -- the BFS above
        // only ever adds descendants -- which short-circuited this function
        // to `[]` for both the --ready and notDoneBeads queries and tripped
        // the pre-sprint validation hard-fail before the Planner ever ran.
        // Deliberately scoped to childless targets ONLY: a target that DOES
        // have children is left exactly as before (its own id stays out of
        // scopeIds, only its descendants are in scope), preserving prior
        // behaviour bit-for-bit for the already-decomposed case -- including
        // this same pre-sprint validation's earlier '--ready'/notDoneBeads
        // gate above, which would otherwise start counting a purely
        // grouping node (e.g. an epic with no blocking deps of its own) as
        // independently "ready" work even though it is not a real unit of
        // work. See readyLeafBeads()'s decomposed-node guard below
        // (apra-fleet-xbu.C5), which remains unaffected either way: a
        // target WITH children already contributes its own id to
        // `parentIds` via its children's `.parent` field regardless of
        // whether the target itself is in scopeIds.
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
        // apra-fleet-eft.9.7: when assignee is provided, add --assignee flag
        // to the bd command to enable per-bead work-claiming within the
        // brackets. This prevents multiple sprints from selecting the same
        // bead (prevention layer per plan 3.4).
        let filterArgs = rest;
        if (validated.assignee) {
            filterArgs = `${rest} --assignee ${validated.assignee}`;
        }
        const filterLabel = `bd list ${filterArgs} --limit 0`;
        const filterRaw = await command(filterLabel, { member_name: orchestratorMember, silent: true });
        return parseBdJson(filterRaw, filterLabel).filter((b) => b && scopeIds.has(b.id));
    }

    // apra-fleet-xbu.C5: a bead that has been decomposed into subtasks
    // (i.e. it is itself SOMEONE ELSE's `--parent`) must never be dispatched
    // to a doer alongside its own subtasks -- the doer would claim/attempt
    // to close a grouping node, not a leaf unit of work, and (per
    // GRAPH-SEMANTICS.md) that item's "done" status is meant to come from
    // its children closing, never from being worked directly. This is a
    // STRUCTURAL check (does this ready bead have children in scope?), not
    // an issue_type check -- retyping a bead to change its dispatch
    // eligibility does not work (issue_type has no effect on `--ready`
    // inclusion) and was reverted earlier in this remediation (see Phase
    // A2). A bead can be a leaf `type=task` OR a decomposed `type=bug`/
    // `type=feature` parent; only the has-children structure tells them
    // apart.
    async function readyLeafBeads() {
        // Stabilization log Issue 28: the exclusion set must be built from
        // children of ANY status, not just open ones. The previous
        // open-only scope query had a blind spot observed live across run
        // 15 C2: the moment a decomposed bug's task children ALL closed,
        // they vanished from the open-beads list, the parent stopped
        // looking like a parent, and it re-entered doer seeding as a
        // "leaf" -- where every doer correctly refused it as non-task,
        // wasting one full dispatch per bead per round until something
        // closed it. Finishing the work must never re-expose the parent.
        // bdListScoped('') is the no-extra-query path: it returns the
        // already-fetched project-wide ANY-status dump (closed included)
        // filtered to scope -- exactly the child set needed here, with no
        // new bd command issued.
        const [ready, allAnyStatus] = await Promise.all([
            bdListScoped('--ready --json'),
            bdListScoped(''),
        ]);
        const parentIds = new Set(allAnyStatus.filter((b) => b.parent).map((b) => b.parent));
        return ready.filter((b) => !parentIds.has(b.id));
    }

    /**
     * N8 (apra-fleet-unw2.6, work items b/c): dispatches one reviewer round
     * and returns its schema-validated verdict, with the shared
     * contract-violation retry/surface behavior factored out so BOTH the
     * normal per-round Develop/Review dispatch AND the Cycle Evaluation
     * re-review dispatch (work item c) apply the exact same rule: a
     * `CHANGES_NEEDED` verdict with empty `reopenIds` AND empty `newTasks`
     * is schema-legal but self-contradictory (nothing for the orchestrator
     * to act on). The SAME dispatch is retried once; if the contradiction
     * repeats, this throws `ReviewerContractViolationError` rather than
     * returning a verdict that could silently accumulate toward
     * stall-abort as if it were legitimate no-progress.
     * @param {{ beadIds: string[], acceptanceCriteriaJson: string }} opts
     * @returns {Promise<{ verdict: string, notes: string, reopenIds: string[], newTasks: object[] }>}
     */
    async function dispatchReview({ beadIds, acceptanceCriteriaJson }) {
        const reviewerPool = getMembersForRole(ROLE_REVIEWER);
        // Stabilization log Issue 9: a full-cycle review is big -- run 6's
        // reviewer genuinely ran out of the fleet's default turn budget
        // (num_turns=51 after ~12 minutes of legitimate review work), and a
        // fresh retry deterministically hits the same wall. Make the budget
        // explicit and, on max_turns exhaustion, RESUME the same session with
        // a doubled budget (mirrors the doer's resume-and-continue rationale
        // at dispatchDoerResume: the session already holds the full review
        // context, so a short continue-nudge finishes the job instead of
        // restarting it).
        const BASE_REVIEWER_MAX_TURNS = 60;
        const reviewerDispatchOpts = {
            member_name: reviewerPool[0],
            agentType: 'reviewer',
            schema: reviewerVerdict,
            model: FIXED_ROLE_TIER.reviewer,
            // apra-fleet-aw8: reviewer inspects a real diff/branch,
            // not a quick prompt -- same 300s-default gap as doer
            // dispatch, observed live tripping on real review work.
            timeout_s: DISPATCH_TIMEOUT_S,
            max_total_s: DISPATCH_TIMEOUT_S,
            max_turns: BASE_REVIEWER_MAX_TURNS,
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
            // Issue 27 (see the integ resume site): restate the review scope --
            // a resumed dispatch replaces the delivered prompt artifact.
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
                // apra-fleet-eft.8.2: reviewer is a read-side role (pushCode:
                // false) -- G-pull before, no-op G-push after.
                try {
                    verdict = await dispatchReviewerOnce();
                } catch (err) {
                    if (err instanceof AgentDispatchError && err.details?.reason === 'max_turns_exhausted') {
                        log(`Reviewer exhausted its turn limit (max_turns=${BASE_REVIEWER_MAX_TURNS}) -- resuming the same session with max_turns=${BASE_REVIEWER_MAX_TURNS * 2} instead of restarting the review.`);
                        verdict = await dispatchReviewerResume();
                    } else {
                        throw err;
                    }
                }
            } catch (err) {
                // Stabilization log Issue 9: these synthesized verdicts are
                // INFRASTRUCTURE failures, not the reviewer contradicting
                // itself -- mark them dispatchFailed so the contract-violation
                // guard below never mistakes a dispatch failure for a
                // self-contradictory LLM verdict (observed live aborting run 6:
                // max_turns exhaustion + a client timeout were counted as two
                // contract violations and threw ReviewerContractViolationError).
                if (err instanceof AgentOutputError) {
                    log(`Reviewer: schema-repair exhausted, treating round as CHANGES_NEEDED: ${err.message}`);
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
                    // Stabilization log Issue 13: the review's own read-side
                    // sync bracket can fail for the same transient
                    // infrastructure reasons as the dispatch itself (run 8
                    // died on a G-pull GitSyncError wrapping a client
                    // 'fetch failed'). Degrade those identically. A REAL
                    // divergence (GitDivergedError / DoltDivergedError --
                    // separate classes, deliberately NOT listed here) still
                    // propagates: that is a branch integrity problem, not a
                    // blip.
                    || err instanceof GitSyncError
                    || err instanceof DoltSyncError
                ) {
                    // A transport-level failure (e.g. a dropped connection mid-dispatch)
                    // is exactly as transient/non-schema as an AgentDispatchError -- must
                    // not be allowed to propagate and abort the whole sprint (apra-fleet-eft).
                    log(`Reviewer: agent dispatch failed, treating round as CHANGES_NEEDED: ${err.message}`);
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
            log(`Reviewer: ${JSON.stringify(verdict)}`);

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

    // N4 (apra-fleet-unw2.4): the sprint branch must be git-ensured on EVERY
    // member that will operate on it, not just the orchestrator. Doers
    // round-robin across the doer pool and the reviewer runs from the
    // reviewer pool; on a real multi-member fleet each of those members has
    // its own checkout, so the old "ensure on the orchestrator only" left
    // every OTHER member working on whatever branch happened to be checked
    // out (finding N4). Ensure on the UNION of the orchestrator, doer, and
    // reviewer pools before the first doer round.
    //
    // SUPPORTED-TOPOLOGY NOTE: this runner has NO cross-member bd/git sync
    // layer this round (deferred -- docs/plan.md section 5). Every `bd`
    // command below runs against the orchestrator member's beads DB, and a
    // doer's own `bd close` runs against its member's DB; that only coheres
    // when all members share one workspace/DB (or there is a single member).
    // bin/cli.mjs enforces exactly that via checkMemberTopology() BEFORE the
    // sprint starts; the ensure-everywhere below is the git half of the same
    // "every member starts from the same state" guarantee. See
    // docs/architecture.md "Multi-member topology (auto-sprint)".
    const branchEnsureMembers = [...new Set([
        orchestratorMember,
        ...getMembersForRole(ROLE_DOER),
        ...getMembersForRole(ROLE_REVIEWER),
    ])];

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
    // N4: dispatch the fetch + checkout -B to EVERY member in the ensure set
    // (union of orchestrator/doer/reviewer pools), not just the orchestrator.
    // Sequential (not parallel) so the command log stays deterministic and
    // the very first dispatch of the run is still the branch-ensure.
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

        // auto-sprint-9: this phase used to ALWAYS checkout -B from
        // origin/<baseBranch>, regardless of whether origin already had a
        // <branch> with real, pushed sprint work on it -- silently
        // force-resetting the branch to base's tip on every single launch
        // (old commits survive only via reflog/dangling objects, not the
        // ref) and, since the reset start-point was a remote-tracking ref,
        // leaving the local branch's upstream pointed at origin/<baseBranch>
        // instead of origin/<branch>. That's a data-loss risk on every
        // relaunch and, on any member whose local branch predates this run
        // (e.g. a freshly-registered member that has never worked this
        // branch before), leaves it structurally unable to ever see the
        // sprint's own history. Fetching <branch> itself first (failSoft --
        // a brand-new sprint branch legitimately doesn't exist on origin
        // yet, and that must never abort the run) and adopting it as the
        // checkout start-point when it exists fixes both: real origin
        // history is never discarded, and `checkout -B <branch>
        // origin/<branch>` naturally sets up correct tracking. Falls back to
        // origin/<baseBranch> only when the branch is genuinely new.
        const branchFetch = await command(
            `git fetch origin ${validated.branch} --quiet`,
            {
                member_name: member,
                silent: true,
                failSoft: true,
                label: `Fetch existing '${validated.branch}' (if any) on member '${member}'`,
            }
        );
        // A failed fetch is only safe to treat as "branch doesn't exist yet"
        // when git says exactly that (`fatal: couldn't find remote ref
        // <branch>`, exit 128) -- any other failure (network blip, auth
        // token expiry, DNS hiccup) must NOT silently fall back to
        // origin/<baseBranch>, or a transient error would trigger the exact
        // destructive reset this fix exists to prevent, with nothing logged
        // to explain why. Abort loudly instead so the operator can retry.
        if (!branchFetch.ok && !/couldn't find remote ref/i.test(branchFetch.error || '')) {
            throw new Error(
                `Ensure Sprint Branch: fetch of existing branch 'origin/${validated.branch}' on member '${member}' ` +
                `failed for a reason other than "branch doesn't exist" (${branchFetch.error || 'unknown error'}) -- ` +
                `refusing to silently fall back to resetting to base, since the branch may actually exist with real ` +
                `pushed work and this fetch failure could be transient. Investigate and retry.`
            );
        }
        const startPoint = branchFetch.ok
            ? `origin/${validated.branch}`
            : `origin/${validated.baseBranch}`;

        // Stabilization log Issue 11: any infrastructure-killed dispatch
        // (transport drop, timeout, stop_prompt) predictably leaves the
        // member's working tree DIRTY with whatever the agent had in flight,
        // and `checkout -B` then fails with "Your local changes ... would be
        // overwritten" -- observed live killing run 7 at Setup. That orphaned
        // WIP belongs to a bead that is still open (a future streak redoes it
        // properly), so the right move is to PRESERVE it in a named stash and
        // proceed -- not to abort the sprint, and never to discard it. The
        // happy path (clean tree) is unchanged: no extra commands issued.
        const checkoutResult = await command(
            `git checkout -B ${validated.branch} ${startPoint}`,
            {
                member_name: member,
                silent: true,
                failSoft: true,
                label: `Ensure sprint branch '${validated.branch}' from '${startPoint}' on member '${member}'`,
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
                `git stash push -u -m "auto-sprint[${validated.branch}] auto-stash of orphaned WIP blocking branch ensure"`,
                {
                    member_name: member,
                    silent: true,
                    label: `Stash orphaned WIP on member '${member}'`,
                }
            );
            await command(
                `git checkout -B ${validated.branch} ${startPoint}`,
                {
                    member_name: member,
                    silent: true,
                    label: `Ensure sprint branch '${validated.branch}' from '${startPoint}' on member '${member}' (post-stash retry)`,
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

    // N4: NON-DESTRUCTIVE re-ensure of the sprint branch on every member at
    // the top of each subsequent cycle. Purpose: guarantee each member is
    // still ON the sprint branch even if an agent on that member checked
    // something else out between cycles. This deliberately uses a plain
    // `git checkout <branch>` -- NOT the initial `checkout -B <branch>
    // origin/<base>` -- because once doers have committed sprint work to the
    // branch, resetting it to origin/<base> would DISCARD that work (there is
    // no cross-member sync to recover it this round). It is `failSoft` so a
    // member that legitimately can't re-checkout (e.g. a transient state)
    // never kills the sprint. In the supported shared-workspace/single-member
    // mode this is effectively a no-op, but it keeps the "every member on the
    // sprint branch" invariant explicit across reopen/re-plan cycles rather
    // than assumed. A truly divergent multi-member fleet is refused up front
    // by checkMemberTopology() in bin/cli.mjs, which is what makes this cheap
    // guard sufficient (a real reconcile would need the deferred sync layer).
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

    // Helper to keep the dashboard UI updated with real bd data. Publishes
    // two independent sets -- see BACKLOG_STATUSES above:
    //   sprintTasks: everything under this sprint's target scope (re-fetched
    //     fresh every call, so beads added mid-run -- a planner's newTasks,
    //     an integ-test-runner's filed bug -- appear on the very next
    //     refresh with no separate wiring needed).
    //   backlogTasks: open/deferred beads project-wide that are NOT already
    //     in sprintTasks -- beads the sprint certainly is not addressing
    //     this run, which may never have gone through a planning phase at
    //     all and may belong to an entirely unrelated epic.
    async function updateDashboard() {
        let sprintTasks = [];
        try {
            // Stabilization log Issue 16: this used to be
            // bdListScoped('--json'), whose non-empty rest args route through
            // a SECOND `bd list --json` query -- and plain `bd list` defaults
            // to open/in_progress only, so CLOSED beads never reached the
            // dashboard's sprint tree (operator-reported: progress was
            // invisible; the viewer's CLOSED badge/grey rendering existed but
            // never received a closed row). The no-args path returns the
            // shared `bd list --all` fetch filtered to scope -- every status,
            // one query fewer.
            sprintTasks = await bdListScoped('');
            // apra-fleet-xbu.C6: a bead whose stored `status` is 'open' but
            // that is NOT in the scope's `--ready` set is blocked -- but the
            // viewer only ever saw the stored status, so a deadlocked bead
            // rendered identically (OPEN) to a genuinely-ready one, which
            // was exactly the "why does the dashboard say OPEN but nothing
            // is happening" confusion the C1/C4 incident's operator hit.
            // Reuses `--ready` (the same signal dispatch decisions are
            // already based on), so this is not a second source of truth.
            try {
                const readyIds = new Set((await bdListScoped('--ready --json')).map((b) => b.id));
                sprintTasks = sprintTasks.map((t) => ({ ...t, ready: readyIds.has(t.id) }));
            } catch (e) {
                log(`updateDashboard: failed to compute ready/blocked badge data (non-fatal, status badges fall back to stored status): ${e.message}`);
            }
        } catch (e) {
            // apra-fleet-nkg: this used to be a bare `catch (e) {}` -- a
            // failure here (e.g. the orchestrator member transiently
            // unreachable, a `bd list` hiccup) left the dashboard's Beads
            // Tasks panel silently empty/stale with ZERO visible signal
            // anywhere (not the log stream, not the viewer), often for the
            // entire duration of a Plan round (this is only called once per
            // round -- see the call sites above/below). Best-effort dashboard
            // sync must never abort the sprint over a transient blip, so
            // this still doesn't rethrow -- but it must at least be visible
            // so a stale/empty panel is diagnosable instead of silently
            // "just how it looks".
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

    // apra-fleet-eft.55.2: resolves the SHA the sprint branch's HEAD sat at
    // right after a successful deploy this cycle -- the "deploy-verified
    // SHA" the Integ Test phase below hands to the integ-test-runner
    // dispatch and later checks its part-2 (smoke test) evidence against
    // (see validatePart2Evidence). Same failSoft probe idiom as
    // probeFileExists: a transient/portability failure here must never
    // throw and kill the sprint -- it just means part-2 SHA freshness
    // cannot be verified this cycle (validatePart2Evidence treats a null
    // deployedSha as "nothing to validate against", falling back to plain
    // pass/fail).
    async function getDeployedSha() {
        const res = await command('git rev-parse HEAD', {
            member_name: orchestratorMember, silent: true, label: 'Resolve deploy-verified SHA', failSoft: true,
        });
        if (!res.ok) {
            log(`Could not resolve the deploy-verified SHA this cycle (treating as unknown, skipping part-2 SHA freshness validation): ${res.error}`);
            return null;
        }
        const sha = res.output.trim();
        if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
            log(`git rev-parse HEAD returned an unexpected value ("${sha}") -- treating the deploy-verified SHA as unknown, skipping part-2 SHA freshness validation.`);
            return null;
        }
        return sha.toLowerCase();
    }

    // apra-fleet-eft.34: D-pull the orchestrator's OWN beads clone before the
    // very first bd query pre-sprint validation issues (via updateDashboard's
    // bdListScoped('') below, then the initialBeads/notDoneBeads queries).
    // CONFIRMED ROOT CAUSE (candidate (a) from the bug's own diagnosis list):
    // members in this "always-on multi-sprint supervisor" fleet are
    // persistent across sprints, so the orchestrator member's local beads
    // clone can be stale relative to the shared Dolt remote at the exact
    // moment a NEW sprint is dispatched -- e.g. a freshly bd-created
    // childless canary target (created by a separate process/clone just
    // before this sprint was launched) is genuinely invisible to
    // fetchAllBeadsShared()'s 'bd list --all --limit 0 --json' (issued
    // against the orchestrator member, see line ~3048) until that clone
    // pulls it in. eft.24.1's scopeIds seed (the childless-leaf-target BFS
    // seed a few dozen lines above bdListScoped's `if (scopeIds.size === 0)
    // return [];`) is necessary but NOT sufficient on its own: seeding
    // scopeIds with the target's own id only changes the outcome if that
    // target bead is actually PRESENT in the allBeads/filtered-query result
    // being intersected against it -- and on a stale clone it is not,
    // regardless of scopeIds membership, so pre-sprint validation still
    // hard-fails with 'Nothing to do.' eft.24.2's mock-sprint coverage could
    // never catch this: its single-clone record/replay harness has no
    // separate orchestrator-clone-vs-shared-remote drift to reproduce (no
    // dolt remote is configured there at all), so the fix needs live-shaped
    // coverage instead (apra-fleet-eft.36).
    //
    // doltPullBefore() is the same idiomatic, already-established pattern
    // used elsewhere in this file to freshen the orchestrator's clone before
    // an orchestrator-side beads read (see e.g. the Cycle Evaluation D-pull
    // a few hundred lines below) -- it is a benign no-op both when the clone
    // is already current AND when no dolt remote is configured at all (see
    // its own doc comment), so this adds no behavioural risk to an
    // already-decomposed target's validation path; it only ever makes the
    // orchestrator's view of `bd list --all` MORE current, never less.
    await doltPullBefore(orchestratorMember, { command, log });

    await updateDashboard();

    let initialBeads = await bdListScoped('--ready --json');

    if (initialBeads.length === 0) {
        // apra-fleet-h7x: `bd --ready == []` alone used to be an unconditional
        // hard-fail here, indistinguishable from "nothing left to do" -- even
        // when real, unblocked work exists but is deadlocked on a bead stuck
        // in a stale 'in_progress' state (e.g. left behind by a previously
        // interrupted sprint run that never reached `bd close`). `bd --ready`
        // deliberately excludes non-'open' beads, so it cannot itself tell
        // "orphaned" from "actively being worked" -- but a bead whose own
        // 'blocks' dependencies are ALL closed has nothing left to wait on, so
        // a stuck 'in_progress' status is the only thing blocking it. Self-heal
        // that one case (reclaim it back to 'open') instead of requiring a
        // human to notice and run `bd update <id> --status open` by hand.
        const notDoneBeads = await bdListScoped(`--status=${NOT_DONE_STATUSES} --json`);
        const notDoneIds = new Set(notDoneBeads.map((b) => b.id));

        const unmetBlockers = (bead) => (bead.dependencies || [])
            .filter((d) => d.type === 'blocks' && notDoneIds.has(d.depends_on_id))
            .map((d) => d.depends_on_id);

        const staleInProgress = notDoneBeads.filter((b) => b.status === 'in_progress' && unmetBlockers(b).length === 0);

        if (staleInProgress.length > 0) {
            for (const bead of staleInProgress) {
                log(`Pre-sprint self-heal (apra-fleet-h7x): ${bead.id} is stuck 'in_progress' (started_at=${bead.started_at || 'n/a'}) with no unmet blockers -- reclaiming to 'open' so the sprint can dispatch it.`);
                await command(`bd update ${bead.id} --status open`, { member_name: orchestratorMember, silent: true });
            }
            initialBeads = await bdListScoped('--ready --json');
        }

        if (initialBeads.length === 0) {
            if (notDoneBeads.length === 0) {
                throw new Error(`Pre-sprint validation failed: No open/in-progress/blocked/deferred beads found for scope '${sprintFilter}'. Nothing to do.`);
            }

            // apra-fleet-xbu.C4: the specific, self-inflicted deadlock shape
            // this incident traced back to -- a `parent-child` edge one way
            // plus a `blocks` edge the other way between the SAME two beads
            // (see vendor/apra-pm/agents/_shared/GRAPH-SEMANTICS.md). `bd
            // dep cycles` does not detect this shape (it does not walk
            // parent-child edges), so it silently reads as "everything
            // blocked" with no actionable diagnosis. Check for it here,
            // scoped to this sprint's own not-done beads, before falling
            // through to the generic deadlock message below.
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

                // apra-fleet-xbu.2.1: this exact shape is mechanically
                // repairable -- the block above already computed the precise
                // edge(s) to remove, so auto-repair (one pass, no loop, no
                // Planner dispatch) instead of just throwing a diagnosis. If
                // the repair itself fails, fall back to the original throw
                // (never silently swallow a failed repair attempt).
                try {
                    for (const pair of cyclePairs) {
                        await command(`bd dep remove ${pair.blockedIssue} ${pair.blockedBy}`, { member_name: orchestratorMember, silent: true });
                        log(`Pre-sprint auto-repair (apra-fleet-xbu.2.1): removed the 'blocks' edge between ${pair.blockedIssue} and ${pair.blockedBy} (parent-child + blocks cycle) -- auto-removed via bd dep remove.`);
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
    // that made no forward progress -- rather than silently burning every
    // remaining cycle up to max_cycles on a sprint that has stopped making
    // forward progress (e.g. a develop/review loop that keeps reopening and
    // re-failing the exact same bead(s)).
    //
    // N9 (apra-fleet-unw2.7): progress is a HIGH-WATER MARK on the closed
    // count, not a cycle-over-cycle delta. A naive "did the count change
    // since last cycle" check is defeated by an oscillation pattern (close
    // a bead, reopen it next cycle, close it again, ...) whose closed-count
    // sequence looks like 5,4,5,4,... -- every cycle differs from the one
    // before it, so a delta-based check never trips, and the sprint burns
    // all max_cycles doing net-zero work. Tracking the highest closed count
    // ever observed this sprint instead means a cycle only counts as
    // progress when it exceeds every prior cycle, so 5,4,5,4,... is
    // correctly flagged as stalled after STALL_CYCLE_LIMIT non-record
    // cycles.
    const STALL_CYCLE_LIMIT = 2;
    let staleCycles = 0;
    let highWaterClosedCount = 0;
    const closedCountHistory = [];

    // N9 (apra-fleet-unw2.7, work item b): per-bead reopen counts across the
    // whole sprint. A bead reopened more than REOPEN_THRASH_LIMIT times is
    // flagged as "thrash" -- the develop/review loop is oscillating on that
    // specific bead rather than making progress -- and its ID is surfaced in
    // the StalledSprintError so a human can see WHICH bead(s) are thrashing,
    // not just that the sprint stalled.
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

    // Deploy/Integration failure evidence (A4), threaded into the Final
    // Review's evidence-based prompt (A6) below -- never silently swallowed.
    const deployFailures = [];
    const integFailures = [];

    // N3: reviewer newTasks rejected by validateNewTask() before ever
    // reaching `command()` -- threaded into the Final Review's evidence-
    // based prompt below so a rejection is visible to a human, not silently
    // dropped. Rejection is non-fatal: the sprint continues.
    const rejectedNewTasks = [];

    // Populated with the last Develop/Review loop's reviewer verdict for
    // each cycle (A5 work item 3: goal-priority completion requires BOTH
    // zero open goal-priority beads AND an APPROVED last reviewer verdict --
    // a cycle where the ready-bead list happened to empty out while the
    // last review round was still CHANGES_NEEDED must not be read as done).
    //
    // N8 (apra-fleet-unw2.6, work item a): this MUST be reset to `null` at
    // the top of every cycle (see below) -- previously it was declared once,
    // here, and never reset, so an APPROVED verdict from cycle N could still
    // read as "approved" in cycle N+1's Cycle Evaluation even when N+1's
    // Develop/Review loop was skipped entirely (no ready beads -> no fresh
    // review of N+1's actual state). `reviewedThisCycle` tracks whether a
    // review genuinely ran THIS cycle, so the Cycle Evaluation section below
    // can tell "fresh APPROVED" apart from "stale APPROVED left over from an
    // earlier cycle" and dispatch a re-review before ever trusting the
    // latter (work item c).
    let lastReviewVerdict = null;
    let reviewedThisCycle = false;

    while (cycle <= MAX_CYCLES) {
        group(`Sprint Cycle ${cycle}`);

        // N8 (work item a): reset per-cycle review state -- a verdict is
        // only ever trustworthy for THE CYCLE that actually produced it.
        lastReviewVerdict = null;
        reviewedThisCycle = false;

        // N4: after the first cycle, re-ensure (non-destructively) that every
        // member is still on the sprint branch before this cycle's doers run.
        // See reEnsureBranchOnMembers() above for why this never resets.
        if (cycle > 1) {
            await reEnsureBranchOnMembers();
        }

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
            // apra-fleet-eft.8.2: planner is a read-side role (pushCode:
            // false) -- G-pull before, no-op G-push after; each retried
            // attempt gets its own bracket since a retry may follow a
            // meaningful gap.
            // apra-fleet-eft.9.1: planner MUTATES beads (creates the task DAG)
            // -- pushBeads:true so its new tasks are D-pushed to the shared
            // remote for the next dispatch/read to observe. It writes no code
            // (pushCode:false).
            // Stabilization log Issue 25: EVERY dispatch site answers
            // max_turns exhaustion with a same-session resume at doubled
            // turns (operator directive) -- the planner gets the doer-sized
            // base since it builds the whole epic DAG.
            const PLANNER_MAX_TURNS = 100;
            const plannerDispatchOpts = {
                member_name: getMemberForRole('planner'),
                agentType: 'planner',
                model: FIXED_ROLE_TIER.planner,
                // apra-fleet-j6i: plans the entire epic DAG, comparably
                // heavy to a doer streak -- same 300s-default gap.
                timeout_s: DISPATCH_TIMEOUT_S,
                max_total_s: DISPATCH_TIMEOUT_S,
                max_turns: PLANNER_MAX_TURNS,
            };
            // apra-fleet-eft.28.3: every interactive Planner dispatch attempt
            // (the FIRST/pre-plan one included -- withDispatchWatchdog wraps
            // dispatchPlannerOnce() too, not just the resume path) is raced
            // against a client-side dispatch_timeout_s watchdog so a frozen-
            // but-alive member session can never leave this await silently
            // hanging past its configured budget. See withDispatchWatchdog's
            // own doc comment above for why this is needed in addition to
            // (not instead of) the server-side timeout_s/max_total_s already
            // passed via plannerDispatchOpts below.
            const dispatchPlannerOnce = () => withGitSync(getMemberForRole('planner'), false, () => withDispatchWatchdog(
                agent(plannerPrompt, { ...plannerDispatchOpts, member_name: getMemberForRole('planner') }),
                { timeoutS: DISPATCH_TIMEOUT_S, member: getMemberForRole('planner'), label: 'Plan (interactive)', log }
            ), { pushBeads: true });
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
            const dispatchPlanner = async () => {
                try {
                    return await dispatchPlannerOnce();
                } catch (err) {
                    if (err instanceof AgentDispatchError && err.details?.reason === 'max_turns_exhausted') {
                        log(`Planner exhausted its turn limit (max_turns=${PLANNER_MAX_TURNS}) -- resuming the same session with max_turns=${PLANNER_MAX_TURNS * 2}.`);
                        return await dispatchPlannerResume();
                    }
                    throw err;
                }
            };
            // apra-fleet-j6i: unlike every other dispatch site in this file,
            // the Planner call had no error handling at all -- a single
            // AgentDispatchError (e.g. a timeout) propagated uncaught all the
            // way to main() in bin/cli.mjs, killing the whole CLI process
            // (and its dashboard server) instead of failing just this round.
            // Mirror the doer-streak retry-once pattern (line ~1844) as an
            // interim mitigation; apra-fleet-j6i.2/j6i.3 cover the fuller
            // dispatch-vs-schema-error distinction this really deserves.
            //
            // apra-fleet-eft: a single IMMEDIATE blind retry isn't enough for
            // a "busy" AgentDispatchError ("execute_prompt is already running
            // for <member>") -- observed live after a prior round's dispatch
            // hit a transport-level failure: the fleet server's own busy-lock
            // for that member did not clear immediately, so the immediate
            // retry hit the exact same "busy" error with nothing to catch it,
            // and that propagated uncaught and killed the whole sprint. Busy/
            // transport failures are inherently transient given a short wait
            // (unlike a genuine schema or logic error), so retry a few times
            // with a backoff delay before finally giving up.
            //
            // Bumped from [0, 5000, 15000] (3 attempts, ~20s total headroom)
            // after that budget still wasn't enough live: a real busy-lock on
            // fleet-rev outlasted all 3 attempts and re-crashed the sprint,
            // but `fleet_status` moments later showed the member already back
            // to idle -- the lock was genuinely transient, just slower to
            // clear than 20s. Give it real headroom: 5 attempts, ~110s total.
            const PLANNER_DISPATCH_RETRY_DELAYS_MS = [0, 5000, 15000, 30000, 60000];
            let plannerRes;
            let plannerErr = null;
            for (let i = 0; i < PLANNER_DISPATCH_RETRY_DELAYS_MS.length; i++) {
                if (PLANNER_DISPATCH_RETRY_DELAYS_MS[i] > 0) {
                    log(`Planner dispatch: waiting ${PLANNER_DISPATCH_RETRY_DELAYS_MS[i] / 1000}s before retry attempt ${i + 1}/${PLANNER_DISPATCH_RETRY_DELAYS_MS.length}...`);
                    await new Promise((resolve) => setTimeout(resolve, PLANNER_DISPATCH_RETRY_DELAYS_MS[i]));
                }
                try {
                    plannerRes = await dispatchPlanner();
                    plannerErr = null;
                    break;
                } catch (err) {
                    plannerErr = err;
                    // Stabilization Issue 43: auth/workspace-trust failures are
                    // deterministic -- no retry can ever succeed, so abort the
                    // loop immediately instead of burning the remaining
                    // attempts' dispatch budgets reproducing the same failure.
                    if (isNonRetryableDispatchError(err)) {
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
            log(`Planner: ${plannerRes}`);

            let verdict;
            // Stabilization log Issue 25: same-session turn-exhaustion resume
            // for the plan-reviewer (reviewer-sized base).
            const PLAN_REVIEWER_MAX_TURNS = 60;
            const planReviewerDispatchOpts = {
                member_name: getMemberForRole('plan-reviewer'),
                agentType: 'plan-reviewer',
                schema: planReviewerVerdict,
                model: FIXED_ROLE_TIER['plan-reviewer'],
                // apra-fleet-j6i: same 300s-default gap as Planner.
                timeout_s: DISPATCH_TIMEOUT_S,
                max_total_s: DISPATCH_TIMEOUT_S,
                max_turns: PLAN_REVIEWER_MAX_TURNS,
            };
            try {
                // apra-fleet-eft.8.2: plan-reviewer is a read-side role
                // (pushCode: false) -- G-pull before, no-op G-push after.
                try {
                    verdict = await withGitSync(getMemberForRole('plan-reviewer'), false, () => agent(
                        buildPlanReviewerPrompt({ targetIssues, goal: validated.goal }),
                        { ...planReviewerDispatchOpts, member_name: getMemberForRole('plan-reviewer') }
                    ));
                } catch (err) {
                    if (err instanceof AgentDispatchError && err.details?.reason === 'max_turns_exhausted') {
                        log(`Plan Reviewer exhausted its turn limit (max_turns=${PLAN_REVIEWER_MAX_TURNS}) -- resuming the same session with max_turns=${PLAN_REVIEWER_MAX_TURNS * 2}.`);
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
                // Persistent non-JSON/non-schema-compliant output, or a failed
                // dispatch, both FAIL this plan round -- neither must ever be
                // treated as an approval.
                if (err instanceof AgentOutputError) {
                    log(`Plan Reviewer: schema-repair exhausted, treating round as CHANGES_NEEDED: ${err.message}`);
                    verdict = {
                        verdict: 'CHANGES_NEEDED',
                        notes: `Plan reviewer failed to return a schema-valid verdict after repair attempts: ${err.message}`,
                        taskAssignments: [],
                    };
                } else if (err instanceof AgentDispatchError || err instanceof FleetTransportError) {
                    // A transport-level failure (e.g. a dropped connection mid schema-repair
                    // retry) is exactly as transient/non-schema as an AgentDispatchError --
                    // must not be allowed to propagate and abort the whole sprint. Observed
                    // live: the schema-repair loop's resumed retry hit "Transport closed"
                    // and, uncaught here, killed the entire sprint run (apra-fleet-eft).
                    log(`Plan Reviewer: agent dispatch failed, treating round as CHANGES_NEEDED: ${err.message}`);
                    verdict = {
                        verdict: 'CHANGES_NEEDED',
                        notes: `Plan reviewer dispatch failed: ${err.message}`,
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
        // Stabilization log Issue 28 (second half): mirror the doer
        // contract's "only claim issue_type=task" rule at SEEDING time.
        // A non-task bead handed to a doer produces a deterministic,
        // contract-mandated refusal -- paying a full LLM dispatch to hear
        // "this is a bug, not a task" recited back is pure token waste
        // (observed live: 4 of 6 streaks in one round). This deliberately
        // does NOT touch readiness semantics or the xbu.C5 structural
        // parent guard above -- it only mirrors, engine-side, the exact
        // type rule the doer contract already enforces agent-side.
        // Childless non-task beads stay in scope for the PLANNER (whose
        // contract decomposes them into task children); they just never
        // reach a doer streak directly.
        //
        // EXEMPTION -- target issues: a childless leaf TARGET is the
        // eft.24 sprint-on-a-single-issue case; it is deliberately seeded
        // into scope whatever its recorded type, and if planning leaves it
        // childless the direct dispatch is the sprint's only path to it.
        // The filter exists to stop NON-target parents/bugs from wasting
        // doer dispatches, never to make a sprint's own target unreachable.
        const targetIssueSet = new Set(targetIssues);
        const readyBeads = (await readyLeafBeads())
            .filter((b) => targetIssueSet.has(b.id) || !b.issue_type || b.issue_type === 'task')
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
        let lastStillOpenCount = 0;  // Track for round-cap detection at loop exit

        // beadId -> reviewer feedback text for the NEXT round, populated
        // only for beads actually named in a CHANGES_NEEDED verdict's
        // `reopenIds` (Work item 5: per-bead routing, not a blanket
        // broadcast of the whole reviewer verdict to every doer).
        const perBeadFeedback = new Map();

        const doerPool = getMembersForRole(ROLE_DOER);

        while (devRounds < 3) {
            // apra-fleet-unw.19: same non-deterministic-ordering fix as
            // `readyBeads` above -- this is the list that actually feeds the
            // streak-assignment prompt and the doerPool round-robin index
            // below, so an unstable order here was directly observable as
            // prompt drift between two otherwise-identical runs.
            // Stabilization log Issue 34: the Issue 28 doer-dispatchability
            // filter must apply HERE too -- this in-loop list is the one that
            // actually feeds the streak-assignment prompt, and a bug/feature
            // bead created after the plan phase (reviewer newTask, out-of-band
            // filing) otherwise lands in a doer streak and burns a dispatch on
            // a contract-bound refusal (observed live, run 16 C1 R2: bug bead
            // seeded into its own streak). Same target-issue exemption as the
            // pre-loop site (eft.24 childless-leaf-target case).
            const currentReady = (await readyLeafBeads())
                .filter((b) => targetIssueSet.has(b.id) || !b.issue_type || b.issue_type === 'task')
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
                        // No `agentType` here on purpose: this call has no
                        // vendored persona of its own (see the streakAssignment
                        // schema comment in contracts.mjs) and reuses the
                        // planner MEMBER only for its model-tier routing.
                        // Activating the full `planner` agentType/persona
                        // (whose actual system prompt is "read open beads,
                        // build a sprint DAG") on this narrow, fully-specified
                        // grouping task caused the model to go exploring via
                        // its Bash/Read/Grep tools instead of answering
                        // directly from the prompt -- the real cause of this
                        // dispatch intermittently running for many minutes
                        // before the transport timeout fired.
                        member_name: getMemberForRole('planner'),
                        label: 'Streak Assignment',
                        schema: streakAssignment,
                        model: FIXED_ROLE_TIER.streakAssignment,
                    }
                );
                log(`Streak Assignment: ${JSON.stringify(streakCandidate)}`);
            } catch (err) {
                if (err instanceof AgentOutputError) {
                    log(`Streak Assignment: schema-repair exhausted, falling back to one-bead-per-streak: ${err.message}`);
                } else if (err instanceof AgentDispatchError || err instanceof FleetTransportError) {
                    log(`Streak Assignment: agent dispatch failed, falling back to one-bead-per-streak: ${err.message}`);
                } else {
                    throw err;
                }
            }
            let { streaks, usedFallback, reason } = selectStreaks(streakCandidate, currentReady);
            // Semantic-repair re-ask (one bounded attempt): agent()'s own
            // schema-repair only fixes JSON-shape problems -- a candidate can
            // be schema-valid yet semantically invalid (observed live in run
            // 8: suffix-stripped ids like "8.4", rejected wholesale). Losing
            // the whole grouping to the one-bead-per-streak fallback silently
            // discards sequencing intent, which on a multi-doer fleet would
            // PARALLELIZE beads the model said must run sequentially. Re-ask
            // once with the exact validation failure; only then fall back.
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
                    log(`Streak Assignment (semantic repair): ${JSON.stringify(streakCandidate)}`);
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

            // N10 (apra-fleet-unw2.8): beadId -> declared model tier, read
            // straight out of the SAME `bd list --ready --json` response
            // already fetched above to build `currentReady` -- that response
            // is each bead's full record, metadata included, so no extra
            // `bd show` round-trip is needed to recover the `model` key N1
            // (apra-fleet-unw2.1) has the planner record via `--metadata`.
            // See resolveDoerModel() below for how a streak's (possibly
            // multi-bead) model is picked from this map, and the
            // budget-is-estimate-based caveat there.
            // Issue 29: normalizeTierToken() guards this single read site --
            // see its doc comment for the live 404 this prevents.
            const modelByBeadId = new Map(currentReady.map((b) => [b.id, normalizeTierToken(b.metadata && b.metadata.model)]));

            // --- Doer barrier: isolated failures, one retry, verified closes (Work item 3) ---
            // continueOnError: true so one doer streak's exception can never
            // abort sibling streaks mid-flight (the old parallel() call had
            // no such option and one throw killed the whole cycle).
            //
            // Per-member serialization: `doerPool[index % doerPool.length]`
            // round-robins streaks across the doer pool, but when there are
            // fewer members than streaks (most visibly single-member mode,
            // doerPool.length === 1), two or more streaks resolve to the SAME
            // member and `parallel()` below dispatches them concurrently
            // anyway. The fleet server allows only one in-flight
            // execute_prompt per member (inFlightAgents guard) -- every streak
            // but the first to arrive gets rejected instantly with a
            // "busy"/AgentDispatchError, deterministically, every time (not a
            // flaky race).
            //
            // apra-fleet-eft.8.3 (related known-bug context: apra-fleet-qv1):
            // a PER-MEMBER lock chain alone is not enough -- the token-passing
            // stance requires doer streak dispatch to be GLOBALLY sequential
            // across DIFFERENT members too, because concurrent writers (even
            // exactly two, on a heterogeneous x86 + ARM64 hand-off) break the
            // fast-forward-by-construction invariant the git/beads sync
            // brackets depend on. `globalDoerTurn` below is a single
            // process-wide queue (not one per member) that every streak --
            // regardless of which member it's assigned to -- chains onto in
            // dispatch order, so at most one doer streak is ever in flight at
            // a time this devRound. `parallel()` still invokes every streak's
            // callback synchronously up to its first `await` in `streaks`
            // order (see the streak-assignment ordering comments above), so
            // capturing `globalDoerTurn` and immediately replacing it happens
            // deterministically in that same order before any streak's actual
            // work begins. Same-member serialization is trivially still held
            // (a global gate is strictly stronger). The gate is released in
            // the `finally` below on EVERY terminal path -- including a
            // thrown/failed streak -- so a failure can never deadlock the
            // next streak's turn. This is intentionally just a strict FIFO
            // queue, not a merger/parallel-streak mechanism -- true
            // parallel/merger dispatch is explicitly deferred to Phase 3+.
            let globalDoerTurn = Promise.resolve();
            const streakOutcomes = [];
            await parallel(streaks, async (streak, index) => {
                let beadIds = streak.map((b) => b.id);
                const doerMember = doerPool[index % doerPool.length];
                const priorTurn = globalDoerTurn;
                let releaseTurn;
                globalDoerTurn = new Promise((resolve) => { releaseTurn = resolve; });
                await priorTurn;
                try {
                // Setup phase: variables for dispatch
                let actualBeadIds = [...beadIds];  // May be reduced by claiming if assignee is set
                let hasClaimedBeads = false;  // Track whether we've done claiming yet

                // apra-fleet base doer max_turns: made explicit (rather than
                // relying on the fleet's own default of 50) so the
                // max-turns-exhaustion resume path below has a known
                // baseline to escalate from.
                // 50 -> 100 (stabilization log iteration 4): in run 8 EVERY
                // doer streak -- including single-bead ones -- exhausted 50
                // turns and paid a resume round-trip (an extra dispatch plus
                // sync brackets each time). 100 lets the common eft-scale
                // streak finish in one dispatch; resume stays the exception
                // (escalating 200 -> 400).
                const BASE_DOER_MAX_TURNS = 100;
                // Bounded resume-and-continue attempts after a max_turns
                // exhaustion, each doubling the turn budget. A blind
                // identical retry is pointless (the doer would
                // deterministically run out of turns again on the SAME
                // prompt/max_turns) -- but SESSION RESUME is not identical:
                // it continues the SAME session (full context of what was
                // already done) with just a short "continue" nudge and a
                // larger turn budget, which is what actually lets a
                // longer-than-expected streak finish instead of dying every
                // round. Bounded (not unlimited) so a genuinely too-large
                // streak still fails after a few escalations rather than
                // burning unbounded budget.
                const MAX_TURN_RESUME_ATTEMPTS = 2;

                // apra-fleet-eft.8.2: doer is a code-writing role (pushCode:
                // true) -- G-pull before, G-push after every attempt
                // (including the resume-and-continue retry below) so the
                // shared branch always reflects this member's committed work
                // before the next dispatch reads it.
                // apra-fleet-eft.9.1: doer writes BOTH code and beads -- it
                // commits+pushes code (pushCode:true) AND closes its assigned
                // beads, which must be D-pushed (pushBeads:true) so the
                // orchestrator's verification D-pull+bd show below sees the
                // closes instead of falsely reporting the streak FAILED.
                // apra-fleet-eft.9.7 (Plan 3.4): per-bead work-claiming happens
                // INSIDE the D-pull/D-push brackets, immediately after the D-pull
                // brings in the latest state of which beads are already claimed
                // by other sprints. This is the prevention layer that reduces
                // row-level conflicts (C.2) by claiming beads based on the
                // current remote state.
                const dispatchDoer = () => withGitSync(doerMember, true, async () => {
                    // apra-fleet-eft.9.7: per-bead work-claiming inside the brackets,
                    // after D-pull brings in the latest claim state. Only claim once.
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

                    // N10: resolve the model to price this dispatch against.
                    // Beads are normally streaked one-per-model (the planner
                    // assigns tiers per task), but when a streak DOES span
                    // beads with different declared models, this deterministically
                    // picks the first (by streak/bead-id order, not dispatch
                    // completion order) and logs the discrepancy rather than
                    // silently averaging or guessing a blended price. A bead
                    // with no `model` metadata at all (pre-N1 data, or a
                    // planner that forgot the convention) resolves to
                    // `undefined`, which FleetWorkflow treats the same as never
                    // passing `model` -- the dispatch still runs, it is simply not
                    // priced (calculateCost() returns null; see pricing.mjs).
                    // CAVEAT: this is the model the PLANNER ASKED the doer to
                    // run on -- the fleet does not currently echo back the
                    // model it actually resolved/ran with alongside usage, so
                    // this (and therefore budget._spent / BudgetExceededError)
                    // is honestly an ESTIMATE, not a verified actual, until that
                    // server-side echo lands (explicitly descoped -- see
                    // docs/plan.md and the pricing.mjs header comment).
                    const streakModels = [...new Set(actualBeadIds.map((id) => modelByBeadId.get(id)).filter(Boolean))];
                    if (streakModels.length > 1) {
                        log(`Doer streak [${actualBeadIds.join(', ')}] spans beads with different declared models (${streakModels.join(', ')}) -- pricing this dispatch as '${streakModels[0]}'.`);
                    }
                    const doerModel = streakModels[0];

                    return agent(
                        buildDoerPrompt({ beadIds: actualBeadIds, branch: validated.branch, feedback: feedbackForStreak || null }),
                        {
                            member_name: doerMember,
                            agentType: 'doer',
                            label: `Streak [${actualBeadIds.join(', ')}]`,
                            schema: doerReport,
                            model: doerModel,
                            // apra-fleet-aw8: doer streaks run a full impl+test+commit
                            // cycle, categorically heavier than a one-shot prompt --
                            // the fleet generic execute_prompt default (300s) was
                            // observed live tripping repeatedly on real work.
                            // Inactivity == total runtime for a silent-until-done
                            // CLI, so the inactivity timer must match the
                            // max_total_s ceiling (stabilization log Issue 12).
                            timeout_s: DISPATCH_TIMEOUT_S,
                            max_total_s: DISPATCH_TIMEOUT_S,
                            max_turns: BASE_DOER_MAX_TURNS,
                        }
                    );
                }, { pushBeads: true });

                // The resume-and-continue retry is the SAME logical doer
                // streak continuing (same session, same code/bead-writing
                // responsibilities), so it gets the identical git+dolt sync
                // bracket treatment as the original dispatch above.
                const dispatchDoerResume = (maxTurns) => withGitSync(doerMember, true, () => agent(
                    // Issue 27 (see the integ resume site): restate the streak's
                    // scope -- a resumed dispatch replaces the delivered prompt
                    // artifact, and run 15 C1's resumed doer drifted onto a
                    // previously-finished bead when its scope was not restated.
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
                    }
                ), { pushBeads: true });

                let report = null;
                let wasRetried = false;
                let dispatchError = null;
                try {
                    report = await dispatchDoer();
                } catch (err) {
                    if (err instanceof AgentDispatchError && err.details?.reason === 'max_turns_exhausted') {
                        wasRetried = true;
                        let currentMaxTurns = BASE_DOER_MAX_TURNS * 2;
                        let resumeAttempt = 0;
                        dispatchError = err;
                        while (resumeAttempt < MAX_TURN_RESUME_ATTEMPTS) {
                            resumeAttempt += 1;
                            log(`Doer streak [${actualBeadIds.join(', ')}] on member '${doerMember}' exhausted its turn limit (max_turns) -- resuming the same session with max_turns=${currentMaxTurns} (attempt ${resumeAttempt}/${MAX_TURN_RESUME_ATTEMPTS}) instead of giving up or regrouping.`);
                            try {
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
                    } else if (isNonRetryableDispatchError(err)) {
                        // Stabilization Issue 43: auth/trust failures cannot be
                        // fixed by retrying the identical dispatch.
                        log(`Doer streak [${actualBeadIds.join(', ')}] on member '${doerMember}' threw a non-retryable error (auth/trust): ${err.message}. Not retrying.`);
                        dispatchError = err;
                    } else {
                        log(`Doer streak [${actualBeadIds.join(', ')}] on member '${doerMember}' threw: ${err.message}. Retrying once.`);
                        wasRetried = true;
                        try {
                            report = await dispatchDoer();
                        } catch (err2) {
                            dispatchError = err2;
                        }
                    }
                }

                if (dispatchError) {
                    streakOutcomes.push({
                        beadIds: actualBeadIds, doerMember, outcome: 'failed', wasRetried,
                        report: null, unclosedIds: actualBeadIds, error: dispatchError.message,
                    });
                    // Rethrow so parallel()'s continueOnError:true isolates
                    // this failure from sibling streaks (the outcome above
                    // is already recorded via closure, so no information is
                    // lost when parallel() substitutes `null` for this branch).
                    throw dispatchError;
                }

                log(`Doer [${actualBeadIds.join(', ')}] on [${doerMember}]: ${JSON.stringify(report)}`);

                // CRITICAL (Work item 3): never trust the doer's own
                // success claim -- verify via `bd show` that the assigned
                // bead ids are actually closed. A doer that returns
                // success-looking text/report but leaves a bead open is
                // treated as a FAILED streak regardless of what it said.
                //
                // apra-fleet-eft.9.1 (Plan 3.3): verifyDoerStreakClosed()
                // D-pulls the orchestrator's OWN beads clone BEFORE this read.
                // The doer closed its beads in ITS clone and D-pushed them; on
                // a multi-member (remote) sprint the orchestrator's clone is a
                // DIFFERENT clone, so without that D-pull this read sees stale
                // (still-open) status and EVERY remote doer streak is falsely
                // marked FAILED -- the single most divergence-sensitive read in
                // the file.
                const unclosedIds = await verifyDoerStreakClosed({
                    command, orchestratorMember, beadIds: actualBeadIds, log,
                });

                if (unclosedIds.length > 0) {
                    log(`Doer streak [${actualBeadIds.join(', ')}] reported status '${report ? report.status : 'unknown'}' but bead(s) still open: ${unclosedIds.join(', ')} -- treating streak as FAILED.`);
                }

                streakOutcomes.push({
                    beadIds: actualBeadIds, doerMember, wasRetried, report, unclosedIds,
                    outcome: unclosedIds.length > 0 ? 'failed' : (wasRetried ? 'retried' : 'success'),
                });
                await updateDashboard();
                } finally {
                    releaseTurn();
                }
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

            // N8 (work item b): dispatchReview() applies the shared
            // contract-violation retry-once-then-throw rule (see its own doc
            // comment and ReviewerContractViolationError) -- a CHANGES_NEEDED
            // verdict with both reopenIds and newTasks empty is
            // self-contradictory and must never be treated as an ordinary
            // "more work needed" round.
            const verdict = await dispatchReview({ beadIds: assignedBeadIds, acceptanceCriteriaJson });
            // A5: the last reviewer verdict seen THIS cycle feeds the Cycle
            // Evaluation section's completion check below -- goal-priority
            // completion requires this to be exactly 'APPROVED', not just
            // an empty ready-bead list.
            lastReviewVerdict = verdict.verdict;
            // N8 (work item a/c): a review genuinely ran THIS cycle -- the
            // Cycle Evaluation section below only trusts `lastReviewVerdict`
            // when this is true (see `reviewedThisCycle` reset at the top of
            // the cycle loop and the re-review dispatch it guards).
            reviewedThisCycle = true;

            // Orchestrator (this code) -- NOT the LLM -- applies every
            // structured transition: reopenIds via `bd update --status=open`,
            // newTasks via `bd create`. The reviewer's dispatch prompt above
            // explicitly forbade it from mutating beads itself; this is the
            // enforcement side of that contract (V1 resolution, SKILL.md).
            // Stabilization log Issue 17: deterministic goal-scope guard on
            // reopenIds -- the prompt-side instruction (buildReviewerPrompt)
            // asks the reviewer not to reopen below-goal beads, but the
            // orchestrator enforces it: reopening a DEFERRED P3 feature in a
            // P1/P2 sprint injects out-of-scope work and pins the verdict at
            // CHANGES_NEEDED forever (observed live, run 11 cycle 3).
            let reopenAllowlist = null;
            if (verdict.reopenIds.length > 0) {
                try {
                    const inScopeNow = await bdListScoped('');
                    reopenAllowlist = new Map(inScopeNow.map((b) => [b.id, b]));
                } catch {
                    reopenAllowlist = null; // lookup failed -- apply reopens unguarded rather than dropping them
                }
            }
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
                // N9: track per-bead reopen counts for reopen-thrash detection.
                recordReopen(id);
                // Per-bead feedback routing (Work item 5): only beads named
                // in reopenIds carry this round's feedback into the next
                // round's doer prompt -- never a blanket broadcast.
                perBeadFeedback.set(id, verdict.notes);
            }
            for (const newTask of verdict.newTasks) {
                // N3: validate BEFORE interpolation -- see validateNewTask()
                // above for why this is an allowlist, not escaping. A
                // rejection is logged, recorded for the final-review
                // evidence summary, and skipped; it must never abort the
                // sprint over one bad newTask.
                const validation = validateNewTask(newTask);
                if (!validation.ok) {
                    log(`Reviewer newTasks: REJECTED (not sent to bd create) -- ${validation.reason}`);
                    rejectedNewTasks.push({ cycle, reason: validation.reason, raw: newTask });
                    continue;
                }
                const { title, description, priority } = validation;
                // A bead can only have one parent -- see the matching
                // comment on the re-review newTasks site below.
                //
                // apra-fleet-eft.9.3 (Plan 3.4): mint the child id through the
                // supervisor-owned allocator so two concurrent sprints creating
                // follow-up work under the SAME parent never derive the same
                // child id (constraint C.4). Under the null client (lone sprint)
                // childId is null and bd derives the id as before.
                const floor = await computeChildFloor({ command, member: orchestratorMember, parentId: targetIssues[0] });
                await createChildBeadWithAllocatedId({
                    command, allocator: childIdAllocator, member: orchestratorMember,
                    title, description, priority, parentId: targetIssues[0],
                    sprintId: sprintMutexId, floor, log,
                    label: `Create follow-up task from reviewer newTasks: ${title}`,
                });
            }

            // apra-fleet-eft.9.1 (Plan 3.3): the orchestrator just MUTATED
            // beads (reopens + newTask creates) in its own clone -- D-push so
            // members observe them on their next dispatch's D-pull.
            await doltPushAfter(orchestratorMember, { command, pushBeads: true, log, mutex: doltPushMutex, sprintId: sprintMutexId });

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
        let deployedSha = null; // apra-fleet-eft.55.2: this cycle's deploy-verified SHA, set only on a real deploy success

        if (hasDeploy) {
            phase(`Deploy C${cycle}`);
            let deployResult;
            // Stabilization log Issue 25: same-session turn-exhaustion resume
            // for the deployer (a source-build fallback deploy runs npm ci +
            // two builds, comfortably beyond a small default budget).
            const DEPLOYER_MAX_TURNS = 60;
            const deployerDispatchOpts = {
                member_name: getMemberForRole('deployer'),
                agentType: 'deployer',
                schema: deployerReport,
                model: FIXED_ROLE_TIER.deployer,
                // apra-fleet-j6i: runs real deploy commands per a
                // runbook, plausibly long-running.
                timeout_s: DISPATCH_TIMEOUT_S,
                max_total_s: DISPATCH_TIMEOUT_S,
                max_turns: DEPLOYER_MAX_TURNS,
            };
            try {
                // apra-fleet-eft.8.2: deployer is a read-side role (pushCode:
                // false) -- a deployer on a stale checkout is as damaging as
                // a stale reviewer diff, so no phase-based exemption here.
                try {
                    deployResult = await withGitSync(getMemberForRole('deployer'), false, () => agent(
                        'Deploy to test env using deploy.md.',
                        { ...deployerDispatchOpts, member_name: getMemberForRole('deployer') }
                    ));
                } catch (err) {
                    if (err instanceof AgentDispatchError && err.details?.reason === 'max_turns_exhausted') {
                        log(`Deployer exhausted its turn limit (max_turns=${DEPLOYER_MAX_TURNS}) -- resuming the same session with max_turns=${DEPLOYER_MAX_TURNS * 2}.`);
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
                    log(`Deployer: agent dispatch failed, treating as deployed:false: ${err.message}`);
                    deployResult = { deployed: false, notes: `Deployer dispatch failed: ${err.message}` };
                } else {
                    throw err;
                }
            }
            log(`Deployer: ${JSON.stringify(deployResult)}`);
            deployedThisCycle = deployResult.deployed === true;
            if (!deployedThisCycle) {
                deployFailures.push({ cycle, notes: deployResult.notes });
                log(`Deploy FAILED this cycle (C${cycle}): ${deployResult.notes}. Skipping Integration Test phase.`);
            } else {
                // apra-fleet-eft.55.2: resolve THIS cycle's deploy-verified
                // SHA now, right after a real deploy success, so the Integ
                // Test dispatch below can hand it to the runner and later
                // check its part-2 evidence was actually run against it.
                deployedSha = await getDeployedSha();
            }
        } else {
            log('Skipping Deploy Phase (no deploy.md found, or the probe itself failed -- see prior log line)');
        }

        if (hasPlaybook && deployedThisCycle) {
            phase(`Integ Test C${cycle}`);
            let integResult;
            try {
                // apra-fleet-xbu.C3: integ-test-runner.md's own contract
                // requires "an explicit list of feature ids ... already
                // scoped for you by the orchestrator" as a required input,
                // and explicitly forbids the agent from deriving that list
                // itself via a bare, unscoped `bd list --type=feature`. This
                // dispatch used to hand it nothing but a generic instruction
                // string -- the one input its own contract says it must
                // never guess. Fetch the scope's open features here and name
                // them explicitly -- always dispatch (even with zero open
                // features this cycle: deploy succeeded and a playbook
                // exists, so this phase runs regardless, per the fixed
                // per-cycle phase sequence every other cycle-evaluation check
                // in this file assumes).
                const openFeatures = await bdListScoped('--type=feature --status=open --json');
                // Stabilization log Issue 28 (third half): pending-closure
                // BUGS -- open bug-type beads whose task children are all
                // closed -- previously had no closure owner at all: doers
                // refuse them (non-task), reviewers may not close, and this
                // prompt only ever named features. They lingered open at
                // goal priority forever (observed live: run 14's final FAIL
                // cited exactly such beads), re-entering doer seeding every
                // round pre-Issue-28. The integ runner already has
                // bead-closing authority and pushBeads:true, and has closed
                // verified bugs before -- make it their explicit owner.
                // bdListScoped('') = the already-fetched any-status dump
                // filtered to scope; open bugs are derived client-side from
                // the same list -- this whole block issues NO new bd command
                // beyond what the phase already ran (see readyLeafBeads).
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
                // apra-fleet-eft.55.2: hand the runner THIS cycle's
                // deploy-verified SHA and require it to echo the SHA back in
                // its report -- the engine below (validatePart2Evidence)
                // rejects a report with an absent/mismatched SHA as
                // INCONCLUSIVE rather than trusting stale part-2 (smoke
                // test) evidence inherited from a pre-fix run (the eft.55
                // incident). Omitted entirely when deployedSha could not be
                // resolved this cycle (see getDeployedSha) -- nothing to
                // require freshness against.
                const part2ShaClause = deployedSha
                    ? ` This cycle's deploy-verified SHA is ${deployedSha}. Part 2 (the smoke test) MUST be ` +
                      `(re)run fresh against this deployed SHA this cycle -- a part-2 result reused from a ` +
                      `resumed session's earlier, pre-fix run does NOT satisfy this. Record this exact SHA in ` +
                      `your report's summary using the literal marker "PART2_SHA: ${deployedSha}" once part 2 ` +
                      `has actually run against it.`
                    : '';
                const featurePrompt = (openFeatures.length > 0
                    ? `Run tests using integ-test-playbook.md, for these open feature id(s) only: ` +
                      `${openFeatures.map((f) => f.id).join(', ')}. Add bug beads if needed, filed under ` +
                      `--parent ${targetIssues[0]}.`
                    : `Run tests using integ-test-playbook.md. No open type=feature beads are in scope ` +
                      `this cycle -- if the playbook still names concrete checks to run, run them; ` +
                      `otherwise report nothing to test. Add bug beads if needed, filed under ` +
                      `--parent ${targetIssues[0]}.`) + pendingClosureClause + part2ShaClause;
                // apra-fleet-eft.8.2: integ-test-runner does NOT touch code
                // (pushCode: false, no git push) but it DOES mutate beads --
                // it closes passing features and files bug beads. Per Plan 3.3
                // (apra-fleet-eft.9.1) it must therefore D-push those beads
                // mutations to the shared remote (pushBeads: true), a D-push
                // with no git push. G-pull before, no-op G-push after.
                // Stabilization log Issue 24: the integ runner owns the whole
                // sandbox lifecycle plus the real functional suites, so it is
                // at least as turn-hungry as a doer. Give it the doer-sized
                // budget and the same same-session resume-and-continue ladder
                // the reviewer/final-review dispatches already have (observed
                // live, run 13 C2: max_turns_exhausted with no resume path
                // silently cost the cycle's entire feature-closure pass).
                const INTEG_TEST_MAX_TURNS = 100;
                const integDispatchOpts = {
                    member_name: getMemberForRole('integ-test-runner'),
                    agentType: 'integ-test-runner',
                    schema: integReport,
                    model: FIXED_ROLE_TIER['integ-test-runner'],
                    // apra-fleet-j6i: runs a full test suite, plausibly
                    // long-running.
                    //
                    // Stabilization log Issue 30: max_total_s is a HARD kill
                    // at elapsed time regardless of activity, and a timer
                    // kill surfaces as a plain AgentDispatchError -- the
                    // resume ladder below only matches max_turns_exhausted,
                    // so a killed-at-the-ceiling run becomes a FALSE
                    // passed:false with no resume, and two such cycles trip
                    // stall-abort. The integ phase (real suites + a full
                    // sandbox smoke sprint) can legitimately run past 60
                    // minutes, so give the ceiling 2h of headroom while
                    // keeping the 1h INACTIVITY timer: a genuinely hung
                    // runner still dies after 60 min of silence; an active
                    // long pass is never killed mid-progress.
                    timeout_s: DISPATCH_TIMEOUT_S,
                    max_total_s: INTEG_MAX_TOTAL_S,
                    max_turns: INTEG_TEST_MAX_TURNS,
                };
                const dispatchIntegOnce = () => withGitSync(getMemberForRole('integ-test-runner'), false, () => agent(
                    featurePrompt,
                    { ...integDispatchOpts, member_name: getMemberForRole('integ-test-runner') }
                ), { pushBeads: true });
                // Stabilization log Issue 27: a resumed dispatch DELIVERS A NEW
                // PROMPT ARTIFACT to the member (replacing the original one, e.g.
                // .fleet-task.md), so a bare "continue" resume erases the
                // dispatch's scope from the artifact a contract may treat as its
                // scope source of truth. Observed live (run 15 C1): the resumed
                // integ runner found no feature-id list and -- correctly, per its
                // missing-scope contract -- closed nothing. Every resume prompt
                // that carries per-dispatch scope must therefore restate it.
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
                        integResult = await dispatchIntegResume();
                    } else {
                        throw err;
                    }
                }
            } catch (err) {
                if (err instanceof AgentOutputError) {
                    log(`Integ Test Runner: schema-repair exhausted, treating as passed:false: ${err.message}`);
                    integResult = { featuresClosed: 0, issuesCreated: 0, passed: false, bugsFiled: [], summary: `Integ test runner failed to return a schema-valid report after repair attempts: ${err.message}` };
                } else if (err instanceof AgentDispatchError || err instanceof FleetTransportError) {
                    log(`Integ Test Runner: agent dispatch failed, treating as passed:false: ${err.message}`);
                    integResult = { featuresClosed: 0, issuesCreated: 0, passed: false, bugsFiled: [], summary: `Integ test runner dispatch failed: ${err.message}` };
                } else {
                    throw err;
                }
            }
            log(`Integ Test Runner: ${JSON.stringify(integResult)}`);
            // apra-fleet-eft.55.2: before trusting `passed` at all, verify
            // part-2 (smoke test) evidence actually came from THIS cycle's
            // deploy-verified SHA -- see validatePart2Evidence's doc
            // comment for the eft.55 incident this guards against (a
            // resumed session's part-2 result from BEFORE this cycle's
            // fixes were deployed, verification verdicts issued from stale
            // evidence). An absent/mismatched SHA is INCONCLUSIVE, not a
            // pass/fail verdict -- still recorded here so stale evidence can
            // never silently masquerade as a genuine pass, but tagged
            // (`inconclusive: true`) and worded distinctly so the final
            // reviewer/harvester can tell the two apart. A matching SHA (or
            // an unresolvable deployedSha, see getDeployedSha) falls
            // through unchanged to the ordinary pass/fail check below.
            const part2Evidence = validatePart2Evidence(integResult, deployedSha);
            if (part2Evidence.inconclusive) {
                const reasonText = part2Evidence.reason === 'absent'
                    ? 'the report carries no PART2_SHA marker'
                    : `the report's PART2_SHA (${part2Evidence.reportedSha}) does not match this cycle's deploy-verified SHA (${deployedSha})`;
                const inconclusiveNote = `INCONCLUSIVE (part-2/smoke evidence not verified fresh -- ${reasonText}): ${integResult.summary}`;
                integFailures.push({ cycle, notes: inconclusiveNote, bugsFiled: integResult.bugsFiled, inconclusive: true });
                log(`Integration tests INCONCLUSIVE this cycle (C${cycle}): ${reasonText}. Not accepted as pass or fail evidence.`);
            } else if (integResult.passed !== true) {
                // A4: never swallow a failure just because the agent chose
                // to (or didn't) file bugs -- `passed` is the honest source
                // of truth, checked explicitly and propagated below
                // regardless of `bugsFiled.length`.
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
        //
        // apra-fleet-eft.9.1 (Plan 3.3): D-pull the orchestrator's beads clone
        // BEFORE the cycle-evaluation counts so the completion/stall math reads
        // the current cross-member beads state (every member's D-pushed closes)
        // rather than the orchestrator's stale local copy.
        await doltPullBefore(orchestratorMember, { command, log });
        const openAtGoal = await bdListScoped(`--status=${NOT_DONE_STATUSES} --priority-max=${goalMax} --json`);

        // Stall detection: track the closed-bead count for the WHOLE sprint
        // scope (not just goal-priority) so zero forward progress on ANY
        // bead -- not only goal-priority ones -- is caught, per the issue
        // text ("N consecutive iterations making no forward progress on any
        // bead").
        const closedCount = (await bdListScoped('--status=closed --json')).length;
        closedCountHistory.push(closedCount);
        // N9: high-water-mark progress. A cycle only counts as progress when
        // it sets a NEW all-time high for the closed count this sprint --
        // returning to a previously-seen value (even one different from the
        // immediately prior cycle, e.g. 5,4,5,4,...) is not progress.
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

        // N8 (apra-fleet-unw2.6, work item c): the exit decision below must
        // never rely on a verdict from an EARLIER cycle. `lastReviewVerdict`
        // is reset to null at the top of every cycle (work item a) and only
        // set when a review genuinely ran THIS cycle (`reviewedThisCycle`).
        // If the goal-priority bead count already reads 0 but no review ran
        // this cycle (e.g. the Develop/Review loop was skipped because
        // there were no ready beads), dispatch one fresh review of the
        // CURRENT state here, before ever deciding to exit -- rather than
        // either (a, the pre-fix bug) silently exiting on a stale verdict
        // nothing this cycle actually backs, or (b) looping forever with no
        // way to ever confirm completion.
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
                // N9: track per-bead reopen counts for reopen-thrash detection.
                recordReopen(id);
            }
            for (const newTask of reReviewVerdict.newTasks) {
                const validation = validateNewTask(newTask);
                if (!validation.ok) {
                    log(`Re-review newTasks: REJECTED (not sent to bd create) -- ${validation.reason}`);
                    rejectedNewTasks.push({ cycle, reason: validation.reason, raw: newTask });
                    continue;
                }
                const { title, description, priority } = validation;
                // A bead can only have one parent -- when multiple sprint-root
                // target issues are given, file follow-up work under the
                // first one (apra-fleet-xbu.C1: --parent never accepts a
                // comma-joined list, so `targetIssues.join(',')` here was
                // silently creating an unparented/misparented bead).
                //
                // apra-fleet-eft.9.3 (Plan 3.4): same allocator-minted id path
                // as the Develop/Review newTasks site above -- concurrent
                // sprints must never mint the same child id under a shared
                // parent (constraint C.4).
                const floor = await computeChildFloor({ command, member: orchestratorMember, parentId: targetIssues[0] });
                await createChildBeadWithAllocatedId({
                    command, allocator: childIdAllocator, member: orchestratorMember,
                    title, description, priority, parentId: targetIssues[0],
                    sprintId: sprintMutexId, floor, log,
                    label: `Create follow-up task from re-review newTasks: ${title}`,
                });
            }

            // apra-fleet-eft.9.1 (Plan 3.3): D-push the orchestrator's applied
            // re-review reopens/newTask creates, same as the Develop/Review
            // transition site above.
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

    // apra-fleet-eft.9.1 (Plan 3.3): D-pull the orchestrator's beads clone
    // BEFORE the final-review counts so the sprint's closing evidence
    // (finalOpenAtGoal / finalClosedCount) reflects every member's D-pushed
    // beads state, not the orchestrator's stale local copy.
    await doltPullBefore(orchestratorMember, { command, log });
    const finalOpenAtGoal = await bdListScoped(`--status=${NOT_DONE_STATUSES} --priority-max=${goalMax} --json`);
    const finalClosedCount = (await bdListScoped('--status=closed --json')).length;

    let finalVerdictResult;
    // Stabilization log iteration 5: the Final Review covers an entire
    // epic's worth of work -- categorically LARGER than the per-round
    // review that already proved 50 fleet-default turns insufficient (run
    // 6). Explicit budget + the same same-session resume-and-continue
    // treatment as the doer and per-round reviewer; without it, a large
    // sprint's final review deterministically dies at the default turn
    // limit twice and flips the whole sprint to a FAIL whose notes carry
    // no findings at all.
    const FINAL_REVIEW_MAX_TURNS = 60;
    // apra-fleet-eft.8.2: Final Review is the same 'reviewer' role as
    // dispatchReview above (read-side, pushCode: false) -- G-pull before,
    // no-op G-push after every attempt (including the retry below).
    const finalReviewDispatchOpts = {
        member_name: getMemberForRole('reviewer'),
        agentType: 'reviewer',
        schema: finalVerdict,
        label: 'Final Review',
        model: FIXED_ROLE_TIER.reviewer,
        // apra-fleet-j6i: reviews the full diff/evidence across an
        // entire epic's worth of closed tasks -- most costly of the
        // 300s-default gaps since a timeout here flips a whole
        // sprint's outcome to FAIL.
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
                return await dispatchFinalReviewResume();
            }
            throw err;
        }
    };
    // apra-fleet-j6i.2: unlike every other combined-catch dispatch site in
    // this file, Final Review is the LAST dispatch of the sprint -- a
    // single transient AgentDispatchError/AgentOutputError here used to
    // flip an otherwise fully-successful sprint straight to verdict:FAIL
    // with zero retry. Mirror the Planner retry-once wrapper (~line 1717):
    // retry once before falling back to the hardcoded FAIL verdict. The
    // fuller AgentDispatchError-vs-AgentOutputError type distinction is
    // apra-fleet-02s's scope; this only adds the retry.
    try {
        finalVerdictResult = await runFinalReviewAttempt();
    } catch (err) {
        if (isNonRetryableDispatchError(err)) {
            // Stabilization Issue 43: auth/trust failures are deterministic --
            // the retry below would only reproduce them.
            throw err;
        }
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
    log(`Final Verdict: ${JSON.stringify(finalVerdictResult)}`);

    // Stabilization log iteration 5: persist a FAIL's actionable findings
    // to BEADS -- the only artifact the next sprint's planner reads (notes
    // reach only the PR body and the analysis doc). Same orchestrator-
    // applies contract, allowlist validation, and id-allocator path as the
    // per-round reviewer's newTasks; a rejected finding is logged and
    // recorded, never sprint-fatal.
    const finalNewTasks = Array.isArray(finalVerdictResult.newTasks) ? finalVerdictResult.newTasks : [];
    if (finalVerdictResult.verdict === 'FAIL' && finalNewTasks.length > 0) {
        let createdCount = 0;
        for (const newTask of finalNewTasks) {
            const validation = validateNewTask(newTask);
            if (!validation.ok) {
                log(`Final Review newTasks: REJECTED (not sent to bd create) -- ${validation.reason}`);
                rejectedNewTasks.push({ cycle: finalCycleLabel, reason: validation.reason, raw: newTask });
                continue;
            }
            const { title, description, priority } = validation;
            const floor = await computeChildFloor({ command, member: orchestratorMember, parentId: targetIssues[0] });
            await createChildBeadWithAllocatedId({
                command, allocator: childIdAllocator, member: orchestratorMember,
                title, description, priority, parentId: targetIssues[0],
                sprintId: sprintMutexId, floor, log,
                label: `Create follow-up task from Final Review FAIL findings: ${title}`,
            });
            createdCount += 1;
        }
        if (createdCount > 0) {
            log(`Final Review: persisted ${createdCount} FAIL finding(s) to beads as follow-up task(s) under ${targetIssues[0]}.`);
            await doltPushAfter(orchestratorMember, { command, pushBeads: true, log, mutex: doltPushMutex, sprintId: sprintMutexId });
        }
    }

    phase(`Harvest C${finalCycleLabel}`);
    // N12 (apra-fleet-unw2.10): wire the harvester's five vendored-required
    // inputs with real, runner-computed values -- see buildAnalysisText()/
    // buildCostAnalysis() above. `branchSlug` (see computeBranchSlug() below)
    // avoids embedding raw `/` characters from a branch name like
    // `feat/fleet-reorg` in the artifact path, which would otherwise create
    // surprise subdirectories. Note: deliberately no wall-clock timestamp in
    // this path -- it must stay identical for two dispatches of the same
    // branch (idempotent re-runs, and the golden-transcript determinism
    // test), and harvester.md Step 1 already overwrites the file at this
    // path if it exists.
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
    });
    const costAnalysis = buildCostAnalysis(budget);
    const harvesterPrompt = buildHarvesterPrompt({
        branch: validated.branch,
        baseBranch: validated.baseBranch,
        targetIssues,
        analysisArtifactFile,
        analysisText,
        costAnalysis,
    });
    let harvesterResult = null;
    // Stabilization log Issue 25: same-session turn-exhaustion resume for
    // the harvester (writes docs/changelog across the whole epic).
    const HARVESTER_MAX_TURNS = 60;
    const harvesterDispatchOpts = {
        member_name: getMemberForRole('harvester'),
        agentType: 'harvester',
        schema: harvesterReport,
        model: FIXED_ROLE_TIER.harvester,
        // apra-fleet-j6i: writes docs/changelog/sprint-analysis
        // across the whole epic, plausibly long-running.
        timeout_s: DISPATCH_TIMEOUT_S,
        max_total_s: DISPATCH_TIMEOUT_S,
        max_turns: HARVESTER_MAX_TURNS,
    };
    try {
        // apra-fleet-eft.8.2: harvester is a code-writing role (pushCode:
        // true) alongside doer -- G-pull before, G-push after so the docs/
        // changelog/sprint-analysis commits it makes are published before
        // anything downstream (Publish PR, below) reads the branch. It ALSO
        // mutates beads (issue-defer of low-priority items), so per Plan 3.3
        // (apra-fleet-eft.9.1) it must D-push those beads mutations after
        // (pushBeads: true) alongside its git push.
        try {
            harvesterResult = await withGitSync(getMemberForRole('harvester'), true, () => agent(
                harvesterPrompt,
                { ...harvesterDispatchOpts, member_name: getMemberForRole('harvester') }
            ), { pushBeads: true });
        } catch (err) {
            if (err instanceof AgentDispatchError && err.details?.reason === 'max_turns_exhausted') {
                log(`Harvester exhausted its turn limit (max_turns=${HARVESTER_MAX_TURNS}) -- resuming the same session with max_turns=${HARVESTER_MAX_TURNS * 2}.`);
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
        log(`Harvester: ${JSON.stringify(harvesterResult)}`);
        if (harvesterResult.status !== 'OK') {
            log(`Harvester reported FAILED: ${harvesterResult.notes}`);
        }
    } catch (err) {
        if (err instanceof AgentOutputError) {
            log(`Harvester: schema-repair exhausted, proceeding without a validated harvester report: ${err.message}`);
        } else if (err instanceof AgentDispatchError || err instanceof FleetTransportError) {
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
    await command(
        `git push -u origin ${validated.branch}`,
        {
            member_name: orchestratorMember,
            silent: true,
            label: `Push sprint branch '${validated.branch}'`,
        }
    );
    // N11 (apra-fleet-unw2.9): the final verdict is surfaced directly in the
    // PR title and body -- a human reviewer must never have to dig through
    // sprint logs to learn whether the run's own review gate passed. Per
    // plan.md's already-made decision (not re-litigated here): a FAIL
    // verdict still publishes the PR (never suppressed), with the verdict
    // stated plainly so the reviewer can weigh it before merging.
    const finalVerdictLabel = finalVerdictResult.verdict === 'PASS' ? 'PASS' : 'FAIL';
    const prTitle = `Auto-sprint [${finalVerdictLabel}]: ${validated.branch}`;
    // apra-fleet-hfs: finalVerdictResult.notes is LLM-authored free text --
    // sanitize with sanitizePrText() (see comment above its definition)
    // BEFORE it is ever interpolated into the double-quoted `gh pr create`
    // command() string below. validated.goal/validated.branch need no
    // sanitization here: both are already validated against
    // shell-injection-safe patterns (GOAL_PATTERN/BRANCH_NAME_PATTERN) at
    // arg-validation time, well before this point.
    const safeNotes = sanitizePrText(finalVerdictResult.notes);
    const prBody = [
        `Automated apra-fleet-se sprint (goal: ${validated.goal}).`,
        '',
        `Final Verdict: ${finalVerdictLabel}`,
        safeNotes ? `Notes: ${safeNotes}` : null,
        '',
        'Do NOT auto-merge -- see pm skill R12; a human must review and merge this PR.',
    ].filter((line) => line !== null).join('\n');

    // N11: idempotent PR creation. `gh pr create` is dispatched with
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

// ---------------------------------------------------------------------------
// Fatal-diagnostics guard for the doer-dispatch boundary (apra-fleet-eft.20.3)
// ---------------------------------------------------------------------------
//
// apra-fleet-eft.20 (smoke-test sandbox): a doer sub-session died mid-Develop
// with ZERO diagnostic signal -- the fleet server log went silent after the
// doer member's session-registration line, and both the doer and orchestrator
// processes were later found dead with nothing further committed or logged.
// main()'s existing try/catch around runSprintCycle() only ever sees errors
// that propagate up an AWAITED call chain; it can never see (a) a promise
// that rejects without ever being awaited/attached to a .catch (a genuine
// unhandledRejection), or (b) a synchronous throw that somehow escapes every
// awaited frame. Both crash the process by default with Node's own generic
// (and easily-missed) diagnostics -- or, depending on the host's
// unhandledRejection mode, may not even do that. This guard makes that
// failure mode observable: it logs an explicit [FATAL] line (with cause and
// the last phase this run entered) via the run's own log() -- so it lands in
// the SAME fleet server log operators already watch -- and best-effort
// persists the same information into the sprint state file via
// publishState('terminal', ...), which flows through the SAME atomic writer
// every other sprint-state write uses (apra-fleet-eft.20.1), so a reader
// (watchdog, dashboard, or a human) sees a real lastError instead of state
// frozen mid-Develop with no explanation.
//
// This deliberately does NOT attempt to recover or continue the run -- by the
// time either process-level event fires, the process's control flow is
// already in an unspecified state. It only guarantees the death is logged and
// recorded before whatever happens next (Node's own crash, or the process
// exiting via some other path).
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
// Engine entry point + typed-abort routing (apra-fleet-eft.1.2)
// ---------------------------------------------------------------------------
//
// `main()` is the WorkflowEngine entry point (see the "Mechanical migration"
// comment above runSprintCycle()): it simply runs the sprint and, on a typed
// sprint-abort error (isTypedAbortError() -- StalledSprintError,
// SprintPlanRejectedError, ReviewerContractViolationError,
// BudgetExceededError, or a pre-sprint validation Error), routes it through
// finalizeAbort() (push + idempotent [ABORTED] PR iff the branch carries
// real work beyond base) and always writes a terminal history record before
// re-throwing. Re-throwing (rather than swallowing) is deliberate: it keeps
// bin/cli.mjs's existing top-level catch -- console.error, exit code 1, and
// the dashboard grace window -- completely unchanged; this function only
// adds work that happens BEFORE the error reaches that catch, it does not
// change how the error is ultimately handled there.
//
// A genuinely unexpected/untyped error (isTypedAbortError() === false, e.g.
// CancelledError from a cooperative /stop, or any error this runner did not
// anticipate) is re-thrown immediately with no finalizeAbort()/history-record
// side effects, preserving today's behavior for that case exactly.
//
// branch/baseBranch/member are re-derived here (rather than threaded out of
// runSprintCycle(), which may throw before or after computing `validated`)
// by calling the same pure, side-effect-free validateArgs() the sprint
// itself already validated its args with. Some typed-abort paths (a
// pre-sprint validation Error on e.g. an invalid branch name) mean that
// re-validation ALSO throws -- in that case there is no usable branch to
// push or inspect, so finalizeAbort() is skipped entirely and the terminal
// history record is written with a null branch/baseBranch and no PR lookup;
// this is still a "zero-commit-abort"-shaped outcome (prUrl null), just one
// that never had a resolvable branch to count commits on in the first
// place.
export async function main(context) {
    const { command, log = () => {}, publishState, phase: rawPhase } = context;

    // apra-fleet-eft.20.3: track the last phase this run entered (Plan /
    // Develop / Review / Deploy / Test / Harvest / ...) purely by wrapping
    // context.phase locally -- no change to FleetWorkflow's public API --
    // so a fatal diagnostic below can say e.g. "last known phase: Develop"
    // instead of just "somewhere".
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
        if (!isTypedAbortError(err)) {
            throw err;
        }

        let branch = null;
        let baseBranch = null;
        let abortResult = { prUrl: null, reason: 'unresolvable-branch', pushed: false, commitCount: 0 };
        try {
            const validated = validateArgs(context.args);
            branch = validated.branch;
            baseBranch = validated.baseBranch;
            const member = (validated.roleMap && validated.roleMap[ROLE_ORCHESTRATOR] && validated.roleMap[ROLE_ORCHESTRATOR].length > 0)
                ? validated.roleMap[ROLE_ORCHESTRATOR][0]
                : validated.members[0];
            abortResult = await finalizeAbort({ error: err, branch, baseBranch, member, command, log });
        } catch (resolveErr) {
            log(
                `[Terminal History] Could not resolve a branch/member to run finalizeAbort() for this abort ` +
                `(${resolveErr.message}); writing the terminal history record with no PR lookup.`
            );
        }

        // Always write a terminal history record, even for a zero-commit or
        // unresolvable-branch abort (only the PR itself is conditional on
        // there being real work to publish).
        if (typeof publishState === 'function') {
            publishState('terminal', {
                verdict: 'ABORTED',
                terminalReason: (err && (err.code || err.name)) || 'UNKNOWN_ABORT',
                message: (err && err.message) || null,
                branch,
                baseBranch,
                prUrl: abortResult.prUrl,
                pushed: abortResult.pushed,
                commitCount: abortResult.commitCount,
            });
        }

        throw err;
    } finally {
        uninstallFatalGuard();
    }
}
