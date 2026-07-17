import fs from 'fs/promises';
import { createHash } from 'crypto';
import { AgentOutputError, AgentDispatchError, CommandError } from '@apralabs/apra-fleet-workflow';
import {
    ROLES, normalizeRole, planReviewerVerdict, doerReport, reviewerVerdict, streakAssignment,
    deployerReport, integReport, finalVerdict, harvesterReport, wrapUntrustedBlock,
} from './contracts.mjs';
import { SprintPlanRejectedError, StalledSprintError, ReviewerContractViolationError } from './errors.mjs';

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
/**
 * @param {{ members: string[], getIdentity: (member: string) => Promise<string> }} opts
 * @returns {Promise<{ ok: boolean, singleMember: boolean, identities: Array<{member: string, signal: string|null, error: string|null}>, message: string }>}
 */
export async function checkMemberTopology({ members, getIdentity }) {
    if (!Array.isArray(members) || members.length === 0) {
        return { ok: false, singleMember: false, identities: [], message: '[Topology] Refusing to start: no members configured.' };
    }

    if (members.length === 1) {
        return {
            ok: true,
            singleMember: true,
            identities: [{ member: members[0], signal: null, error: null }],
            message: `[Topology] Single-member sprint ('${members[0]}') -- shared-state precondition trivially satisfied (nothing to compare).`,
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
        identities,
        message: `[Topology] All ${members.length} configured members share the same identity signal (${distinct[0]}) -- shared-state precondition satisfied.`,
    };
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
        '`bd create ... --metadata \'{"model": "<tier>"}\'` (tier is EXACTLY one of ' +
        '\'cheap\', \'standard\', \'premium\' -- these three literal strings, not ' +
        '"cheap-tier"/"standard-tier"/"premium-tier") -- this is the ONLY location the model ' +
        'tier is recorded: do not additionally record it via bd\'s freeform notes field or ' +
        'a METADATA-section comment, per planner.md Step 3.'
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
function buildReviewerPrompt({ beadIds, acceptanceCriteriaJson, baseBranch, branch }) {
    return [
        `Review the work just done for the following bead id(s): ${beadIds.join(', ')}.`,
        'Full task detail (including acceptance criteria), from `bd show --json`:',
        wrapUntrustedBlock('bd show --json', acceptanceCriteriaJson),
        `Diff range to review: ${baseBranch}..${branch} (base_branch..branch).`,
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

// Mechanical migration to the WorkflowEngine's ES-module entry-point contract
// (apra-fleet-unw.7): the engine now calls `main(context)` instead of
// injecting bare globals into an AsyncFunction scope. This destructure is the
// only change to this file's wiring -- every name below (agent, command,
// parallel, log, phase, group, endGroup, publishState, args) is the exact
// same binding the old bare-global version referred to; no control-flow or
// dispatch-order changes.
export async function main(context) {
    const { agent, command, parallel, log, phase, group, endGroup, publishState, args, budget } = context;

    // Validate BEFORE any agent()/command() dispatch (apra-fleet-unw.14,
    // A7 defense in depth): a rejected/malformed arg must result in zero
    // fleet dispatches.
    const validated = validateArgs(args);

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

    // apra-fleet-xbu.C1: `bd list --parent` accepts exactly one id per
    // invocation -- a comma-joined multi-target list (`--parent a,b`) is
    // silently treated as one nonexistent id and returns `[]`, which used
    // to be masked because this sprint only ever had one target issue in
    // practice. This helper is the general fix: for a single target it
    // behaves identically to the old string-interpolated call; for multiple
    // targets it issues one `bd list --parent <id> <restArgs>` per target
    // and unions the results by `id` (a bead cannot have more than one
    // parent, so no id can appear under two different targets).
    async function bdListScoped(restArgs) {
        const rest = restArgs ? restArgs.trim() : '';
        if (targetIssues.length <= 1) {
            const filter = targetIssues.length === 1 ? `--parent ${targetIssues[0]}` : '';
            const label = [`bd list`, filter, rest].filter(Boolean).join(' ');
            const raw = await command(label, { member_name: orchestratorMember, silent: true });
            return parseBdJson(raw, label);
        }
        const merged = new Map();
        for (const id of targetIssues) {
            const label = [`bd list`, `--parent ${id}`, rest].filter(Boolean).join(' ');
            const raw = await command(label, { member_name: orchestratorMember, silent: true });
            for (const item of parseBdJson(raw, label)) {
                if (item && item.id !== undefined) merged.set(item.id, item);
            }
        }
        return [...merged.values()];
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
        const [ready, allInScope] = await Promise.all([
            bdListScoped('--ready --json'),
            bdListScoped('--json'),
        ]);
        const parentIds = new Set(allInScope.filter((b) => b.parent).map((b) => b.parent));
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
        let verdict;
        for (let reviewAttempt = 1; reviewAttempt <= 2; reviewAttempt++) {
            try {
                verdict = await agent(
                    buildReviewerPrompt({
                        beadIds,
                        acceptanceCriteriaJson,
                        baseBranch: validated.baseBranch,
                        branch: validated.branch,
                    }),
                    {
                        member_name: reviewerPool[0],
                        agentType: 'reviewer',
                        schema: reviewerVerdict,
                        model: FIXED_ROLE_TIER.reviewer,
                        // apra-fleet-aw8: reviewer inspects a real diff/branch,
                        // not a quick prompt -- same 300s-default gap as doer
                        // dispatch, observed live tripping on real review work.
                        timeout_s: 900,
                        max_total_s: 3600,
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
                } else if (err instanceof AgentDispatchError) {
                    log(`Reviewer: agent dispatch failed, treating round as CHANGES_NEEDED: ${err.message}`);
                    verdict = {
                        verdict: 'CHANGES_NEEDED',
                        notes: `Reviewer dispatch failed: ${err.message}`,
                        reopenIds: [],
                        newTasks: [],
                    };
                } else {
                    throw err;
                }
            }
            log(`Reviewer: ${JSON.stringify(verdict)}`);

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
        await command(
            `git checkout -B ${validated.branch} origin/${validated.baseBranch}`,
            {
                member_name: member,
                silent: true,
                label: `Ensure sprint branch '${validated.branch}' from '${validated.baseBranch}' on member '${member}'`,
            }
        );
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
            sprintTasks = await bdListScoped('--json');
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
            const dispatchPlanner = () => agent(
                plannerPrompt,
                {
                    member_name: getMemberForRole('planner'),
                    agentType: 'planner',
                    model: FIXED_ROLE_TIER.planner,
                    // apra-fleet-j6i: plans the entire epic DAG, comparably
                    // heavy to a doer streak -- same 300s-default gap.
                    timeout_s: 900,
                }
            );
            // apra-fleet-j6i: unlike every other dispatch site in this file,
            // the Planner call had no error handling at all -- a single
            // AgentDispatchError (e.g. a timeout) propagated uncaught all the
            // way to main() in bin/cli.mjs, killing the whole CLI process
            // (and its dashboard server) instead of failing just this round.
            // Mirror the doer-streak retry-once pattern (line ~1844) as an
            // interim mitigation; apra-fleet-j6i.2/j6i.3 cover the fuller
            // dispatch-vs-schema-error distinction this really deserves.
            let plannerRes;
            try {
                plannerRes = await dispatchPlanner();
            } catch (err) {
                log(`Planner dispatch threw: ${err.message}. Retrying once.`);
                plannerRes = await dispatchPlanner();
            }
            log(`Planner: ${plannerRes}`);

            let verdict;
            try {
                verdict = await agent(
                    buildPlanReviewerPrompt({ targetIssues, goal: validated.goal }),
                    {
                        member_name: getMemberForRole('plan-reviewer'),
                        agentType: 'plan-reviewer',
                        schema: planReviewerVerdict,
                        model: FIXED_ROLE_TIER['plan-reviewer'],
                        // apra-fleet-j6i: same 300s-default gap as Planner.
                        timeout_s: 900,
                    }
                );
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
                } else if (err instanceof AgentDispatchError) {
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
        const readyBeads = (await readyLeafBeads())
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
            const currentReady = (await readyLeafBeads())
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
                } else if (err instanceof AgentDispatchError) {
                    log(`Streak Assignment: agent dispatch failed, falling back to one-bead-per-streak: ${err.message}`);
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

            // N10 (apra-fleet-unw2.8): beadId -> declared model tier, read
            // straight out of the SAME `bd list --ready --json` response
            // already fetched above to build `currentReady` -- that response
            // is each bead's full record, metadata included, so no extra
            // `bd show` round-trip is needed to recover the `model` key N1
            // (apra-fleet-unw2.1) has the planner record via `--metadata`.
            // See resolveDoerModel() below for how a streak's (possibly
            // multi-bead) model is picked from this map, and the
            // budget-is-estimate-based caveat there.
            const modelByBeadId = new Map(currentReady.map((b) => [b.id, b.metadata && b.metadata.model]));

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
            // flaky race). memberLocks below chains same-member dispatches
            // into a queue (one in flight at a time per member) while leaving
            // streaks assigned to DIFFERENT members fully concurrent -- true
            // multi-member fleets see no behavior change since their locks
            // are never contended.
            const memberLocks = new Map();
            const streakOutcomes = [];
            await parallel(streaks, async (streak, index) => {
                const beadIds = streak.map((b) => b.id);
                const doerMember = doerPool[index % doerPool.length];
                const priorTurn = memberLocks.get(doerMember) || Promise.resolve();
                let releaseTurn;
                memberLocks.set(doerMember, new Promise((resolve) => { releaseTurn = resolve; }));
                await priorTurn;
                try {
                const feedbackForStreak = beadIds
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
                // passing `model` -- the dispatch still runs, it's just not
                // priced (calculateCost() returns null; see pricing.mjs).
                // CAVEAT: this is the model the PLANNER ASKED the doer to
                // run on -- the fleet does not currently echo back the
                // model it actually resolved/ran with alongside usage, so
                // this (and therefore budget._spent / BudgetExceededError)
                // is honestly an ESTIMATE, not a verified actual, until that
                // server-side echo lands (explicitly descoped -- see
                // docs/plan.md and the pricing.mjs header comment).
                const streakModels = [...new Set(beadIds.map((id) => modelByBeadId.get(id)).filter(Boolean))];
                if (streakModels.length > 1) {
                    log(`Doer streak [${beadIds.join(', ')}] spans beads with different declared models (${streakModels.join(', ')}) -- pricing this dispatch as '${streakModels[0]}'.`);
                }
                const doerModel = streakModels[0];

                const dispatchDoer = () => agent(
                    buildDoerPrompt({ beadIds, branch: validated.branch, feedback: feedbackForStreak || null }),
                    {
                        member_name: doerMember,
                        agentType: 'doer',
                        label: `Streak [${beadIds.join(', ')}]`,
                        schema: doerReport,
                        model: doerModel,
                        // apra-fleet-aw8: doer streaks run a full impl+test+commit
                        // cycle, categorically heavier than a one-shot prompt --
                        // the fleet's generic execute_prompt default (300s) was
                        // observed live tripping repeatedly on real work.
                        timeout_s: 900,
                        max_total_s: 3600,
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
            for (const id of verdict.reopenIds) {
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
                await command(
                    `bd create "${title}" -d "${description}" -p "${priority}" --parent ${targetIssues[0]} --silent`,
                    { member_name: orchestratorMember, silent: true, label: `Create follow-up task from reviewer newTasks: ${title}` }
                );
            }

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

        if (hasDeploy) {
            phase(`Deploy C${cycle}`);
            let deployResult;
            try {
                deployResult = await agent(
                    'Deploy to test env using deploy.md.',
                    {
                        member_name: getMemberForRole('deployer'),
                        agentType: 'deployer',
                        schema: deployerReport,
                        model: FIXED_ROLE_TIER.deployer,
                        // apra-fleet-j6i: runs real deploy commands per a
                        // runbook, plausibly long-running.
                        timeout_s: 900,
                    }
                );
            } catch (err) {
                if (err instanceof AgentOutputError) {
                    log(`Deployer: schema-repair exhausted, treating as deployed:false: ${err.message}`);
                    deployResult = { deployed: false, notes: `Deployer failed to return a schema-valid report after repair attempts: ${err.message}` };
                } else if (err instanceof AgentDispatchError) {
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
                const featurePrompt = openFeatures.length > 0
                    ? `Run tests using integ-test-playbook.md, for these open feature id(s) only: ` +
                      `${openFeatures.map((f) => f.id).join(', ')}. Add bug beads if needed, filed under ` +
                      `--parent ${targetIssues[0]}.`
                    : `Run tests using integ-test-playbook.md. No open type=feature beads are in scope ` +
                      `this cycle -- if the playbook still names concrete checks to run, run them; ` +
                      `otherwise report nothing to test. Add bug beads if needed, filed under ` +
                      `--parent ${targetIssues[0]}.`;
                integResult = await agent(
                    featurePrompt,
                    {
                        member_name: getMemberForRole('integ-test-runner'),
                        agentType: 'integ-test-runner',
                        schema: integReport,
                        model: FIXED_ROLE_TIER['integ-test-runner'],
                        // apra-fleet-j6i: runs a full test suite, plausibly
                        // long-running.
                        timeout_s: 900,
                        max_total_s: 3600,
                    }
                );
            } catch (err) {
                if (err instanceof AgentOutputError) {
                    log(`Integ Test Runner: schema-repair exhausted, treating as passed:false: ${err.message}`);
                    integResult = { featuresClosed: 0, issuesCreated: 0, passed: false, bugsFiled: [], summary: `Integ test runner failed to return a schema-valid report after repair attempts: ${err.message}` };
                } else if (err instanceof AgentDispatchError) {
                    log(`Integ Test Runner: agent dispatch failed, treating as passed:false: ${err.message}`);
                    integResult = { featuresClosed: 0, issuesCreated: 0, passed: false, bugsFiled: [], summary: `Integ test runner dispatch failed: ${err.message}` };
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
                await command(
                    `bd create "${title}" -d "${description}" -p "${priority}" --parent ${targetIssues[0]} --silent`,
                    { member_name: orchestratorMember, silent: true, label: `Create follow-up task from re-review newTasks: ${title}` }
                );
            }
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

    const finalOpenAtGoal = await bdListScoped(`--status=${NOT_DONE_STATUSES} --priority-max=${goalMax} --json`);
    const finalClosedCount = (await bdListScoped('--status=closed --json')).length;

    let finalVerdictResult;
    const dispatchFinalReview = () => agent(
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
        {
            member_name: getMemberForRole('reviewer'),
            agentType: 'reviewer',
            schema: finalVerdict,
            label: 'Final Review',
            model: FIXED_ROLE_TIER.reviewer,
            // apra-fleet-j6i: reviews the full diff/evidence across an
            // entire epic's worth of closed tasks -- most costly of the
            // 300s-default gaps since a timeout here flips a whole
            // sprint's outcome to FAIL.
            timeout_s: 900,
            max_total_s: 3600,
        }
    );
    // apra-fleet-j6i.2: unlike every other combined-catch dispatch site in
    // this file, Final Review is the LAST dispatch of the sprint -- a
    // single transient AgentDispatchError/AgentOutputError here used to
    // flip an otherwise fully-successful sprint straight to verdict:FAIL
    // with zero retry. Mirror the Planner retry-once wrapper (~line 1717):
    // retry once before falling back to the hardcoded FAIL verdict. The
    // fuller AgentDispatchError-vs-AgentOutputError type distinction is
    // apra-fleet-02s's scope; this only adds the retry.
    try {
        finalVerdictResult = await dispatchFinalReview();
    } catch (err) {
        if (err instanceof AgentOutputError) {
            log(`Final Review: dispatch failed (schema-repair exhausted: ${err.message}). Retrying once.`);
        } else if (err instanceof AgentDispatchError) {
            log(`Final Review: dispatch failed (agent dispatch error: ${err.message}). Retrying once.`);
        } else {
            throw err;
        }
        try {
            finalVerdictResult = await dispatchFinalReview();
        } catch (retryErr) {
            if (retryErr instanceof AgentOutputError) {
                log(`Final Review: schema-repair exhausted after retry, treating as FAIL: ${retryErr.message}`);
                finalVerdictResult = { verdict: 'FAIL', notes: `Final reviewer failed to return a schema-valid verdict after repair attempts (including one retry): ${retryErr.message}` };
            } else if (retryErr instanceof AgentDispatchError) {
                log(`Final Review: agent dispatch failed after retry, treating as FAIL: ${retryErr.message}`);
                finalVerdictResult = { verdict: 'FAIL', notes: `Final reviewer dispatch failed after repair attempts (including one retry): ${retryErr.message}` };
            } else {
                throw retryErr;
            }
        }
    }
    log(`Final Verdict: ${JSON.stringify(finalVerdictResult)}`);

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
    try {
        harvesterResult = await agent(
            harvesterPrompt,
            {
                member_name: getMemberForRole('harvester'),
                agentType: 'harvester',
                schema: harvesterReport,
                model: FIXED_ROLE_TIER.harvester,
                // apra-fleet-j6i: writes docs/changelog/sprint-analysis
                // across the whole epic, plausibly long-running.
                timeout_s: 900,
            }
        );
        log(`Harvester: ${JSON.stringify(harvesterResult)}`);
        if (harvesterResult.status !== 'OK') {
            log(`Harvester reported FAILED: ${harvesterResult.notes}`);
        }
    } catch (err) {
        if (err instanceof AgentOutputError) {
            log(`Harvester: schema-repair exhausted, proceeding without a validated harvester report: ${err.message}`);
        } else if (err instanceof AgentDispatchError) {
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
