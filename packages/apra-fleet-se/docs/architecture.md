# Architecture / Internals

This document describes how `fleet-sprint/runner.js` is put together
internally: the cycle loop, exit condition, stall detection, budget
tracking, multi-member topology, the journal/replay mechanism (as exposed by
the underlying engine), and the dashboard viewer. For the high-level mental
model see `docs/overview.md`; for every CLI flag see `docs/cli-reference.md`.

`runner.js` is a workflow script for `@apralabs/apra-fleet-workflow`'s
`WorkflowEngine`: it exports `async function main(context)`, and the engine
invokes it with a context object exposing `agent`, `command`, `parallel`,
`log`, `phase`, `group`, `endGroup`, `publishState`, `args`, and `budget`.
Every one of the primitives below (`agent()`, `command()`, `parallel()`) is
generic engine machinery documented in
`packages/apra-fleet-workflow/docs/`; this document only covers how
`runner.js` *uses* them.

## Argument contract

`bin/cli.mjs` builds an `args` object and hands it to
`engine.executeFile(scriptPath, args)`; `runner.js`'s `validateArgs(args)` is
the canonical, validated shape of that object and is the single source of
truth for what a caller (the CLI, or a test bypassing the CLI and calling
`executeFile` directly) must provide. It:

- Rejects any key not in `KNOWN_ARG_KEYS` (`target_issues`, `target_issue`
  [legacy single-issue form], `members`, `branch`, `base_branch`, `goal`,
  `max_cycles`, `requirementsFile`, `roleMap`, `budget`).
- Re-validates issue ids and branch names against the same
  `ISSUE_ID_PATTERN`/`BRANCH_NAME_PATTERN` the CLI already checked (A7
  defense-in-depth: a malformed id/branch name can never reach a `command()`
  shell interpolation even if the CLI layer is bypassed).
- Applies defaults: `goal` defaults to `P1/P2`, `max_cycles` defaults to `5`.
- Normalizes every `roleMap` key via `normalizeRole()` (trim + lowercase);
  two input keys that normalize to the same canonical key are rejected as
  ambiguous.
- Validates `budget` is a non-negative finite number if present.

Validation runs to completion, and only then does the very first `command()`
dispatch happen -- a rejected/malformed arg produces zero fleet dispatches.

## Role -> member resolution

Two helpers resolve which physical fleet member(s) a role dispatches to,
built from `validated.members` (the physical member pool) and
`validated.roleMap` (the optional override):

- `getMemberForRole(role)` -- returns a single member: `roleMap[role][0]` if
  configured, else `physicalMembers[0]`.
- `getMembersForRole(role)` -- returns a pool of members: `roleMap[role]` if
  configured, else (for `doer` and `reviewer` specifically) the *entire*
  physical member list (so multiple doers/reviewers genuinely run across
  different members by default), else `[physicalMembers[0]]` for every other
  role.

`doer` and `reviewer` are compared against canonical lowercase constants
(`ROLE_DOER`, `ROLE_REVIEWER`) pulled directly from `contracts.ROLES` via a
`roleConst()` helper that throws at module-load time if the string is ever
not a member of that enum -- this exists specifically to prevent a
casing/typo mismatch from silently collapsing the doer/reviewer pool back to
a single member.

`orchestrator` is a deliberately **non-vendored, application-level
pseudo-role** (the constant `ROLE_ORCHESTRATOR = 'orchestrator'`): it names
which physical member the orchestrating process itself (this script, issuing
every `bd`/`git` command directly) runs as. It has no
`packages/apra-fleet-se/apra-pm/agents/*.md` definition, no schema, and is never passed to
`agent()`. `getMemberForRole(ROLE_ORCHESTRATOR)` resolves the orchestrator
member the same way any other role resolves via `roleMap`/fallback.

## The cycle loop

`main()` runs a `while (cycle <= MAX_CYCLES)` loop. Each iteration:

1. Resets per-cycle review-tracking state (`lastReviewVerdict = null`,
   `reviewedThisCycle = false`).
2. Re-ensures (non-destructively) that every member in the branch-ensure set
   is checked out on the sprint branch (skipped on cycle 1, which does the
   initial `git checkout -B` in Sprint Setup instead).
3. **Plan phase**: alternates `planner` <-> `plan-reviewer` dispatches (up to
   3 rounds) until the plan-reviewer returns `verdict === 'APPROVED'`
   (schema-validated, never substring-matched). If 3 rounds pass without
   approval, throws `SprintPlanRejectedError` and aborts the entire sprint --
   it must never proceed to Develop with an unapproved plan. `cycle > 1`
   frames the planner prompt as a "re-planning pass: address GAPS ONLY",
   per the vendored `planner.md` re-planning-behaviour contract.
4. **Develop & Review phase**: if there are ready beads (`bd list --ready`),
   runs up to 3 develop/review rounds (see "Develop & Review loop" below).
   If there are no ready beads this cycle, the loop is skipped entirely (but
   Deploy/Integration and Cycle Evaluation still run) -- an empty ready list
   is explicitly *not* treated as sprint completion by itself.
5. **Deploy & Integration phase**: conditional on runbook files existing in
   the repo (see "Runbook probes" below).
6. **Cycle Evaluation**: decides whether the loop exits or `cycle++` and
   continues (see "Exit condition" below). This section also runs
   stall-abort bookkeeping.

## Develop & Review loop

Within one cycle, `devRounds` runs up to 3 times. Each round:

1. Fetches the current ready-bead list (`bd list --ready --json`), sorted by
   `(title, id)` for determinism (see "Determinism" below).
2. Dispatches a `planner`-typed "streak assignment" call (schema
   `streakAssignment`) asking the LLM to group ready bead ids into streaks --
   chains that must be worked sequentially by the same doer, versus
   independent beads that become their own (parallelizable) streak.
   `selectStreaks()` validates the candidate: every ready bead id must appear
   in exactly one streak, no unknown/duplicate ids. Any invalid or
   schema-repair-exhausted candidate falls back deterministically to
   **one-bead-per-streak** -- always correct by construction, just less
   parallel.
3. Dispatches each streak to a `doer` (via `parallel()`, `continueOnError:
   true` so one streak's failure/exception cannot abort sibling streaks).
   Streaks round-robin across the doer pool (`doerPool[index %
   doerPool.length]`). A doer dispatch that throws is retried once. **The
   doer's own claimed status is never trusted**: after dispatch, the
   orchestrator runs `bd show <ids> --json` and only counts a bead as closed
   if `status === 'closed'` there -- a doer that reports success but leaves a
   bead open is treated as a failed streak.
4. Dispatches a `reviewer` (`dispatchReview()`, schema `reviewerVerdict`)
   against every bead touched this round, with the full `bd show --json`
   detail and the diff range (`base_branch..branch`) as context. The
   reviewer's prompt explicitly forbids it from mutating beads itself (even
   though the vendored `reviewer.md` prose describes the reviewer running
   `bd update` directly) -- **the orchestrator applies every transition**:
   `bd update <id> --status=open` for each `reopenIds` entry, `bd create` for
   each validated `newTasks` entry. This is the same "structured verdict in,
   orchestrator applies the effect" pattern used everywhere in this runner.
5. Loops back to step 1 unless the ready list is now empty.

### Reviewer contract-violation retry

`dispatchReview()` (used both by the per-round Develop/Review dispatch and
the Cycle Evaluation re-review) detects a specific self-contradictory
verdict: `CHANGES_NEEDED` with both `reopenIds` and `newTasks` empty. That
combination is schema-legal but gives the orchestrator nothing to act on, so
it can never resolve to `APPROVED` and never produces progress -- which would
otherwise be indistinguishable from genuine no-progress by the stall
detector. The dispatch is retried once; if the same contradiction repeats,
`ReviewerContractViolationError` is thrown and the sprint aborts rather than
letting the contradiction silently accumulate toward a stall-abort.

### Per-bead feedback routing

When a bead is reopened, the reviewer's `notes` are recorded in a
`perBeadFeedback` map keyed by that bead's id. The *next* round's doer
prompt for a streak only includes feedback for the bead(s) that streak
actually owns -- never a blanket broadcast of the whole verdict to every
doer.

### Batched bead claiming is a dormant contract, not yet live behavior

`claimBeadsBatched()` exists to replace a per-id claim loop with one `bd
update <ids...> --claim --json` call issued by the orchestrator member before
a streak is dispatched, but it only activates when a streak carries an
`assignee` -- which no current caller sets (`validated.assignee` is always
unset), so today it is dead code exercised only by its own unit tests, not a
behavior change. Its claim/skip classification is intentionally naive: an id
counts as claimed only if it comes back in the parsed JSON array from `bd`;
every other id in the batch -- whether genuinely claimed by a different
sprint, or already claimed by this same orchestrator from a prior round -- is
classified identically as "skipped" and dropped from the streak's working set.
The two cases are behaviorally indistinguishable to the caller today. A
command-level failure (member unreachable, transient dispatch fault) degrades
the whole batch to all-skipped rather than throwing, but a malformed-JSON
response from `bd` itself stays fatal -- the failure modes are deliberately
asymmetric because a parse failure means the claim state is truly unknown,
while a thrown `command()` has a well-understood "nothing happened" meaning.
**Before wiring any caller to set `assignee` and make this path live**, the
same-assignee re-claim case must be pinned down first: if `bd`'s `--claim`
JSON array omits ids already owned by the same assignee (an idempotent
re-claim), this classifier would wrongly treat the orchestrator's own beads as
"skipped by another sprint" and prune them from the streak.

### newTask validation (injection defense)

Reviewer-proposed `newTasks` are LLM output that will be interpolated into a
double-quoted `bd create "..."` shell command. Because sprint members run
mixed shells (POSIX and Windows) with no single reliably-safe escaping
scheme, `validateNewTask()` uses an **allowlist**, not escaping:
`priority` must match `^P[0-4]$`; `title`/`description` must match
`^[A-Za-z0-9 .,:;!?()'_/\[\]-]+$` (notably excluding backtick, `$`, double-quote,
and backslash -- the characters that can break out of or smuggle commands
through a double-quoted shell argument). A rejected `newTask` is logged,
recorded in `rejectedNewTasks` (surfaced later in the final-review prompt and
the harvester's analysis text), and skipped -- never fatal to the sprint.

The same threat model applies to the final reviewer's free-text `notes` when
it is embedded in the PR title/body (`gh pr create --title "..." --body
"..."`): `sanitizePrText()` uses the same allowlist, but **strips** (replaces
with a space) disallowed characters rather than rejecting, because the PR
body must still be published with the verdict visible even when the notes
are malformed.

## Deploy & Integration phase

Runbook presence is checked via `probeFileExists()`, which shells out `node
-e "console.log(require('fs').existsSync('<file>') ? 'found' : 'not
found')"` on the orchestrator member with `failSoft: true` -- a probe failure
(transient error, member-side quirk) is treated as "not found" (skip the
phase) and logged as a warning, never fatal.

- If `deploy.md` exists: dispatch a `deployer` agent (schema
  `deployerReport`). `deployed !== true` records a `deployFailures` entry and
  skips the Integration Test phase for this cycle.
- If `integ-test-playbook.md` also exists **and** deploy succeeded this
  cycle: dispatch an `integ-test-runner` agent (schema `integReport`).
  `passed !== true` records an `integFailures` entry (with any `bugsFiled`)
  regardless of whether bugs were actually filed -- `passed` is checked
  explicitly rather than inferred from `bugsFiled.length`.

Both failure lists are threaded into the Final Review prompt and the
harvester's analysis text, so a deploy/integ failure is never silently
swallowed.

## Exit condition

The cycle loop's completion check is **not** "`bd list --ready` returned
`[]`" -- an empty ready list only means nothing is dispatchable *this cycle*;
it says nothing about beads that are `blocked` or stuck `in_progress`.  The
real check, in Cycle Evaluation, is:

```
0 beads in scope with status in {open, in_progress, blocked}
  at or above (numerically <=) the goal's worst priority tier
AND
the most recent reviewer verdict THIS CYCLE was exactly 'APPROVED'
```

`goalPriorityMax(goal)` computes the "worst" (highest-numbered) `Pn` tier
named in `--goal` (e.g. `P1/P2` -> `P2`); `bd list --priority-max=Pn` is
inclusive of `Pn`, so this is the correct filter.

If the goal-priority count is already 0 but no review actually ran this
cycle (e.g. the Develop/Review loop was skipped because there were no ready
beads), the runner dispatches one fresh **re-review** of the full current
scope before deciding to exit -- it never trusts a stale `APPROVED` verdict
left over from an earlier cycle. `lastReviewVerdict`/`reviewedThisCycle` are
reset at the top of every cycle specifically to make this distinction
possible.

## Stall detection

Tracked across the whole sprint (not reset per cycle):

- `closedCountHistory` -- the total closed-bead count in scope, appended once
  per Cycle Evaluation.
- `highWaterClosedCount` -- the highest closed count ever observed. A cycle
  only counts as progress if it **exceeds** this high-water mark, not merely
  differs from the immediately prior cycle. This is deliberate: a naive
  delta check is defeated by an oscillation pattern (close a bead, reopen it,
  close it again -> `5,4,5,4,...`), where every cycle differs from the one
  before it but the sprint is making no real progress. `staleCycles`
  increments whenever a cycle fails to set a new high-water mark, and resets
  to 0 whenever one is set.
- `STALL_CYCLE_LIMIT = 2` -- once `staleCycles` reaches this, the sprint
  aborts with `StalledSprintError` rather than burning every remaining cycle.
- `reopenCounts` (per bead id) and `REOPEN_THRASH_LIMIT = 3` -- a bead
  reopened more than 3 times is flagged as "thrashing" in the
  `StalledSprintError` message, so a human reading the failure can see
  *which* bead(s) are oscillating, not just that the sprint stalled.

**The closed count fed into `closedCountHistory` must be read fresh, not
reused from an earlier snapshot taken the same cycle.** A cycle's Integ Test
step can itself close verify-routed beads as its very last action; if the
count appended to `closedCountHistory` for that cycle was computed from a
bead-state read taken *before* that step ran, those closures are invisible
to the high-water-mark check even though they are genuine progress -- the
history looks flat across consecutive cycles despite real work landing in
each one, and the sprint can trip `StalledSprintError` while insisting "the
verifier may be failing" when the verifier in fact succeeded every time and
the bookkeeping simply never looked again after it ran. Cycle Evaluation
therefore re-queries live closed-bead state for the scope directly (rather
than reusing whatever the cycle's earlier bead-state fetch already had in
hand) immediately before computing that cycle's entry, so a same-cycle
closure is always credited in the cycle it actually happened.

## Budget tracking

`--budget <usd>` (optional) sets `context.budget.total` before any dispatch;
omitted, it stays `null` (unlimited). The engine's `agent()` already checks
`budget.remaining() <= 0` before every dispatch and throws a budget-exceeded
error -- this runner's only job is to actually set `budget.total` from the
validated arg.

Model-tier pricing for non-doer roles is fixed by `FIXED_ROLE_TIER` (a
runner-owned policy table, not a live read of fleet configuration):

| Role | Tier | Rationale |
|---|---|---|
| `planner` | `premium` | Highest-stakes single dispatch of a cycle |
| `plan-reviewer` | `premium` | Vendored contract treats reviewer-class work as premium |
| `reviewer` | `premium` | Vendored contract: "always use model: premium" |
| `deployer` | `standard` | Mostly mechanical: follow `deploy.md` |
| `integ-test-runner` | `standard` | Mostly mechanical: follow `integ-test-playbook.md` |
| `harvester` | `standard` | Docs/CHANGELOG synthesis, not code-critical |

These tier keywords (`cheap`/`standard`/`premium`) are resolved to a concrete
model **per member, server-side** (`execute-prompt.ts`'s
`resolveModelForTier()`, via each member's registered `model_tiers`) -- this
is what makes a mixed-provider fleet (Claude, AGY, Codex, Copilot,
OpenCode, ...) work correctly. Earlier revisions of this runner hardcoded
Claude-specific literal model names (`opus`/`sonnet`) here instead. That was
a real bug, not a stylistic choice: a fixed `opus` dispatch to a non-Claude
member was passed through verbatim as a literal model ID that meant nothing
to that provider, silently assuming a Claude-only fleet regardless of the
member's actual provider. The fix (apra-fleet-dv5) was to stop emitting
Claude-specific literals here and use the provider-agnostic tier vocabulary
instead.

`doer` dispatches instead price themselves off the **per-bead model tier**
the planner recorded as beads metadata (`bd create ... --metadata
'{"model": "<tier>"}'`, per `planner.md` Step 3 -- this is documented as the
*only* place the tier is recorded). The value is normally one of `cheap` /
`standard` / `premium`, but a literal, provider-specific model ID (e.g. an
OpenCode member's model string) is also a fully legitimate value -- not
deprecated, not rewritten, not warned about -- for a caller who already
knows the target member's provider and wants a specific model family from
it. When a streak spans beads with different declared tiers/models, the
runner picks the first (by streak/bead-id order) and logs the discrepancy
rather than blending. A bead with no `model` metadata resolves to
`undefined`, which the engine treats as "unpriced" -- the dispatch still
runs, it just is not counted toward budget.

**Pricing source**: a dispatch's cost is priced against one of two sources,
in preference order:

1. **Real per-member rates** -- when the dispatch's `opts.model` is a tier
   keyword, the workflow engine calls the `get_member_model_pricing` MCP
   tool (once per member per run, cached for the run's lifetime) to resolve
   that member's tier to its actual concrete model and real `$`/1M-token
   rate, and prices the dispatch against that.
2. **Tier-band/concrete-model fallback estimate** (`pricing.mjs`) -- used
   whenever real pricing isn't available for the dispatch: the tool call
   fails (older fleet server, network/hub-relay error), the member/tier
   combination has no known price, or `opts.model` is a literal model ID
   rather than a tier keyword (concrete IDs are priced via `pricing.mjs`'s
   own model table, matched by substring).

The harvester's `costAnalysis` block (`buildCostAnalysis()`) reports which
of these sourced each run's total -- all real, all fallback, or a mixed
count -- so the CHANGELOG cost note stays honest about precision rather than
implying uniform accuracy. A dispatch using an entirely unpriced model id
(no match in either source) is still excluded from the tracked total, not
backfilled with a fabricated number -- the fleet does not currently echo
back the model it actually resolved/ran with alongside usage, so even the
"real rate" path prices against the model the caller *asked for* (the
resolved tier), not a separately confirmed actual.

## Multi-member topology

Two distinct topology modes are supported, selected explicitly (never
inferred) when the sprint starts:

- **`legacy` mode** -- no cross-member sync layer. Every orchestrator `bd`
  command runs against the orchestrator member's beads DB; a doer's own
  `bd close` runs against its own member's DB; the sprint git branch is only
  coherent if every member operates on the same working state. This mode
  only coheres for **single-member** sprints (one member does everything) or
  a **verified shared-workspace fleet** (every configured member resolves to
  the same checkout/DB -- e.g. several fleet member registrations pointing at
  one physical machine/workspace). Independent, genuinely separate
  per-member checkouts are **not supported** in this mode: a doer's
  `bd close`/commit on its own checkout would silently diverge from what the
  orchestrator (and the eventual PR) sees.
- **`synced` mode** -- orchestrator-bracketed git+Dolt sync (see the two
  sections below). This is what makes genuinely independent per-member
  checkouts safe: every member's git and beads state is explicitly
  reconciled around each dispatch instead of assumed shared.

`checkMemberTopology()` (called from `bin/cli.mjs` before the sprint starts)
enforces the precondition for whichever mode is selected, and refuses to
start rather than silently degrading:

- **`legacy` mode precondition** -- compares an identity signal
  (`git rev-parse HEAD`) across every configured member and refuses to start
  on a mismatch. Single-member sprints trivially pass (nothing to compare). A
  member whose signal cannot be obtained is treated as a refusal, not a
  silent skip. This is a best-effort heuristic checked once at start, not an
  ongoing guarantee: two independent checkouts that merely happen to sit on
  the same commit right now would pass.
- **`synced` mode precondition** -- HEADs are explicitly **allowed** to
  differ (reconciliation is the sync layer's job); instead every member must
  report the same git remote origin URL and pass a `bd dolt pull` probe
  (proving its beads clone can actually reach the shared Dolt remote) before
  the sprint is allowed to start. A member failing either check is named
  explicitly in the refusal message.

**Branch-ensure everywhere** (both modes) -- before the first doer round, the
sprint branch is `git fetch`+`checkout -B`'d on every member in the union of
the orchestrator/doer/reviewer pools (not just the orchestrator). At the top
of every subsequent cycle, a non-destructive `git checkout <branch>`
(`failSoft: true`) re-ensures each member is still on the sprint branch --
deliberately not a `checkout -B ... origin/<base>`, which would discard any
work already committed to the branch.

## VCS provider abstraction (VCSModule)

Git- and Dolt-backed sync both eventually have to interpret a failed shell
command's raw stderr and decide what kind of failure it was. That
interpretation used to live as GitHub-specific regex lists inlined in the
runner itself, which meant every new git host (Azure DevOps, Bitbucket,
GitLab, a self-hosted/generic remote) meant editing the runner's own source.
VCSModule replaces that with a provider-agnostic seam:

- **`classifyFailure(text, provider)`** maps raw command output to a
  provider-neutral `kind` -- the same taxonomy the Dolt sync layer's
  `auth`/divergence split above draws from (`auth`, `transient`,
  `conflict-resolvable`, `conflict-unresolvable`, `unknown`, ...) -- so
  downstream code (self-heal triggers, retry policy, typed error selection)
  never pattern-matches host-specific text itself. Only the raw text is
  host-specific; the `kind` it resolves to never is.
- **A provider registry**, one file per provider (GitHub and a generic-git
  fallback ship built in; Bitbucket/GitLab are structured as drop-in
  additions; Azure DevOps is fully registered, not just structured as one --
  it carries its own host/URL parsing, failure classification, PR/comment
  REST builders and a `capabilities()` table with `canOpenPullRequest: true`),
  each exporting a descriptor of failure-text patterns plus a
  `capabilities()` table declaring which failure kinds that provider can ever
  produce. Adding a provider is adding one file to the registry and
  registering it -- not editing the runner's dispatch/classification logic.
  A synthetic/unregistered provider still classifies correctly through the
  generic-git fallback rather than falling through to `unknown` by default.
  See the repo-root `docs/design-azure-devops-vcs-auth.md` for the Azure DevOps provider's
  own credential-assembly, PR-response-mapping and PAT-lifetime details.
- **The member registry, not a hardcoded literal, decides which provider
  applies.** A member's configured VCS provider is resolved from its
  registration and threaded into every classification and PR-creation call
  site for that member, rather than every call site assuming GitHub.
- **Self-heal is wired at every auth-classified boundary**, not just the
  git-push path: both call sites that create a pull request (the orchestrator
  side, since PR creation is never a server-side act on a repo -- see the
  server/repo-boundary ADR) and the Dolt D-push path above trigger the same
  bounded, one-shot `provision_vcs_auth` re-provisioning callback on an
  `auth`-classified failure before giving up, so a lapsed credential self-
  heals uniformly regardless of which surface first observed it.
- **A classification miss is the failure mode this abstraction exists to
  close**, not a cosmetic one: a git failure that can't be classified falls
  through to `unknown`, and `unknown` at this layer is never retried and never
  self-healed -- it aborts the sprint immediately. Every provider's
  descriptor is therefore reviewed specifically for coverage of that
  provider's real auth-failure text (not just the generic OpenSSH/git text
  that happens to port across hosts), because the cost of a miss is a false
  sprint-fatal abort on what is usually a routine, recoverable token expiry.

## Orchestrator-bracketed git sync (`synced` mode)

In `synced` mode, every dispatch that reads or writes git-tracked state is
wrapped in a git-sync bracket: a pull-equivalent (`syncMemberBefore`) before
the dispatch, and a push-equivalent (`syncMemberAfter`, ordered before the
Dolt push bracket for code-writing roles) after it. This exists because
prevention alone cannot rule out real content conflicts once members
genuinely diverge, so the bracket is layered as an escalation ladder rather
than a single mechanism:

- **Tier 0 (prevention)** -- exclusive per-sprint branch ownership, rebase-
  before-push, and globally sequential doer-streak dispatch (only one doer
  streak's git operations are in flight fleet-wide at a time) keep real
  content conflicts rare in the first place.
- **Tier 1 (scripted detection)** -- confirmed from git's own
  `git status --porcelain` output, never inferred from a failing command's
  exit code or message alone: a failed `git pull --rebase` is checked for
  actual unmerged paths, and if genuinely conflicted, `git rebase --abort`
  restores a clean working tree. No agent is dispatched at this tier.
- **Tier 2 (agent-with-runbook)** -- a git rebase conflict is by construction
  a same-line/same-hunk overlap (git's three-way merge already silently
  resolves every non-overlapping change; conflict markers only appear for the
  remainder a fixed ours/theirs policy cannot arbitrate safely). Tier 1
  finding real unmerged paths is the single documented escalation point to
  dispatch an agent, armed with an explicit runbook naming exactly which
  files are conflicted, to re-attempt the rebase with real judgment. The
  agent's own claim of success is never trusted: the orchestrator
  mechanically re-verifies a clean `git status --porcelain` and a genuinely
  successful re-push before treating Tier 2 as having resolved anything. If
  Tier 2 fails, a typed diverged-sync error aborts the streak rather than
  proceeding on unresolved state.

A member with no genuine content conflict never leaves Tier 0; Tier 2 is a
rare, explicitly-logged escalation, not the common path.

## Dolt sync discipline (`synced` mode)

Because fleet-sprint's beads state lives in a Dolt-backed clone per member,
`synced` mode wraps every dispatch that reads or mutates beads state in an
equivalent bracket: a D-pull (`bd dolt pull`) before the dispatch, and a
D-push (`bd dolt push`) after any beads-mutating step. Three properties of
the underlying Dolt embedded-mode behavior make this load-bearing, not
optional hardening:

- Any concurrent write to the same row hard-conflicts (row-level, not
  cell-level), and one unresolved conflict wedges the entire clone's sync --
  so cross-member Dolt writes must be serialized, not merely retried.
- Two sprints independently creating a child under the same shared parent bead
  each derive the same next child id from their own clone's local view (each
  only sees the siblings it already has), so both mint the same id and their
  D-pushes then hard-conflict on that row.

Two globally-shared coordination primitives address these directly (a
per-sprint-process lock cannot coordinate across independently detached
sprint processes, so both need a process that every sprint can already
reach):

- **A global Dolt push mutex** -- serializes every cross-sprint `bd dolt
  push` so at most one sprint is ever mid-push at a time, granted strictly
  in FIFO order (no starvation).
- **A globally-coordinated child-id allocator** -- mints the next child id
  under a shared parent synchronously (no `await` before the counter
  advances, so two concurrent same-parent creations can never race on the
  same counter read), and hands each creator an explicit, pre-decided,
  distinct id to pass to `bd create` -- so two sprints creating siblings
  under the same parent always target different rows. The `bd` CLI rejects a
  `bd create` invocation that combines `--id` and `--parent` in the same
  call, so the creator issues `--id` alone (the id the allocator already
  decided) and links the bead to its parent with a separate, immediately
  following `bd update <id> --parent <parentId>` call -- two calls, not one,
  are the correct sequence here, not a workaround. If the allocator itself
  returns no id (allocator unreachable/degraded), the creator falls back to
  a plain `bd create --parent <parentId>` (no `--id`) and accepts whatever
  id `bd` assigns, rather than failing the create outright. Either way, the
  child's reported parent is verified against the id that was actually
  requested before the creation is trusted -- a mismatch is treated as a
  failed create, not silently accepted.

### Two coordination hosts, not one -- and why

Both primitives exist in **two independent implementations that must stay
semantically identical**, not because of duplication oversight but because
neither host alone can reach every launch topology:

- The **supervisor** (`fleet-se serve`) hosts the original mutex/allocator
  (`src/supervisor/dolt-mutex.mjs`, `src/supervisor/id-allocator.mjs`) over
  its own HTTP routes, reachable by any sprint launched *through* the
  supervisor via `--service-url`. This covers supervisor-launched sprints
  only.
- The **fleet MCP server** hosts a from-scratch TypeScript re-statement of
  the same semantics (`src/services/sprint-coordination.ts`, exposed as the
  `dolt-push-mutex` and `child-id-allocator` MCP tools). This covers the
  standalone/detached-binary CLI launch path (`packages/apra-fleet-se/
  bin/cli.mjs`), which has no supervisor to reach at all -- but which
  already hard-requires a connection to the shared fleet MCP HTTP singleton
  (it refuses to self-spawn a private stdio server), making that server the
  one genuine cross-process coordination point for that topology.

This is a deliberate, forced trade-off, not an oversight: the fleet server
is TypeScript compiled with `allowJs` off from a `rootDir` that excludes the
supervisor's `.mjs` sources, and the root package's dependency direction
runs the opposite way (through `@apralabs/apra-fleet-client`, never
importing the supervisor directly) -- so importing the supervisor's modules
from the server would introduce a workspace build cycle. Extracting a third
shared workspace package is the architecturally-right end state but is
tracked as separate follow-up work, not bundled into this coordination fix.
**Any behavioral change to the mutex or allocator's semantics (FIFO
ordering, lease/reclaim behavior, synchronous seq assignment, atomic
persistence) must be mirrored in both files by hand** -- there is no shared
module enforcing this today.

The one genuinely new piece in the MCP-hosted copy is the **transport
adaptation**: the supervisor's HTTP acquire route can long-poll (it simply
does not answer until the caller owns the mutex), but an MCP tool call
cannot block indefinitely. The MCP-hosted mutex is therefore **ticketed**:
`acquire` enqueues the real underlying `acquire()` promise exactly once and
parks it server-side under a ticket id, returning `{ granted: false, ticket
}` after a bounded wait; the caller re-polls with that ticket. The
underlying waiter stays enqueued across every poll -- a naive
cancel-and-retry-on-timeout loop would silently send a timed-out waiter to
the back of the FIFO queue and destroy the fairness guarantee this whole
mechanism exists to provide. A ticket whose underlying grant is reclaimed
out from under it (lease expiry or a dead-pid probe, independent of the
ticket's own release/cancel path) is cleaned up via an explicit
`onReclaim()` subscription -- otherwise, on an always-on fleet server,
reclaimed-but-never-cleaned-up ticket entries would accumulate for the
life of the process.

`packages/apra-fleet-se/bin/cli.mjs` threads `--service-url` end-to-end so
the standalone CLI path actually engages this coordination (rather than the
tools existing but going unused): every code-writing dispatch that would
mutate beads or push Dolt state resolves its mutex/allocator client against
that URL, and `packages/apra-fleet-client` (`api.mjs`'s `doltPushMutex()`
and `childIdAllocator()`) is the thin wrapper both the supervisor path and
the standalone path call through -- it is kept in lockstep with the MCP
tool schemas as a hard requirement, not optional cleanup, precisely because
a drifted client would silently give one of these two call sites a stale or
inconsistent view of what the server actually accepts.

**D-push conflict policy is mechanical, not judgment-based**: whichever
D-push loses a race (the remote moved first) reconciles with exactly one
D-pull (ours/theirs, first-successful-pusher-wins) then one re-push --
deliberately not a per-conflict judgment call, since the mutex should make
this rare and mechanical resolution is enough once collisions are already
serialized.

### Fail-closed handling of a remote-less (neutralized) beads clone

A local beads clone with no configured Dolt remote (deliberately neutralized,
e.g. in a sandbox that must never reach a real shared Dolt remote, or
genuinely standalone) has nothing to pull or push -- this is a benign no-op
skip, not a sync failure, and is distinguished from a real divergence at two
independent layers so neither can silently misclassify the other:

- **`classifyDoltFailure()`** pattern-matches a failed `bd dolt` command's raw
  output into `no-remote` / `diverged` / `auth` / `transient` /
  `remote-unreachable` / `unknown`, checking `no-remote` first (a "nothing
  configured" message must never be misread as a retryable transient
  failure), `diverged` next (a real conflict must never be masked by an
  overlapping transient-sounding word in its message), and `auth` as its own
  branch distinct from both (a credential failure -- e.g. "could not read
  Username", "Device not configured" -- must never be folded into `diverged`;
  see "Push failures are classified before they are retried" below for why
  that distinction matters at the D-push terminals specifically).
- **A direct bd-level `sync.remote` check** queries `bd config get
  sync.remote --json` on the member directly, independent of what Dolt's own
  internal remote wiring reports. This closes a gap the stderr-pattern
  classifier alone cannot: a clone whose *Dolt-level* remote got re-wired out
  from under the neutralize step can still attempt a real push and fail with
  a message the classifier has no pattern for (e.g. a credentials error),
  which it correctly reports as `unknown` -- even though the bd-level
  `sync.remote` for that clone is neutralized and nothing was ever supposed
  to be pushed. Consulting the bd-level setting directly catches that case
  regardless of what Dolt's own remote list says.

The bd-level check is **fail-closed by construction**: every inconclusive
outcome -- the query command failing, a `failSoft` error result, or output
that cannot be positively parsed as an empty `{ value: '' }` -- is treated as
"configured" (a real, active remote), never as "neutralized". Only a clean,
positively-parsed empty value is treated as unconfigured. This asymmetry is
deliberate: a false "not configured" here would silently swallow a genuine
D-push failure on a real, actively-synced clone, which is the exact defect
class this check exists to prevent; the safe direction to be wrong in is
treating an ambiguous read as "still connected to something real."

**This mechanism should not be considered fully proven** by the presence of
its fix commits and passing unit tests alone. A neutralized sandbox has been
observed, in end-to-end smoke runs, to still have its Dolt-level remote
re-wired from the member's own git origin and attempt a live push to a real
shared remote -- caught only because the runner's own bd-level check treated
it as configured and the push was separately blocked by missing local
credentials, not because the neutralization held by design. Treat this as an
open verification gap: a green end-to-end smoke run (a real sandboxed
fleet-sprint driving a canary to closure with zero pushes reaching the real
remote) is the only evidence that actually closes it, not passing mocked/unit
coverage of the classifier and the bd-level check in isolation.

### The pre-gate sync.remote probe is cached once per D-push attempt, not re-queried on failure

The bd-level `sync.remote` check described above runs once, as a pre-gate,
before a D-push attempt begins; its result is cached (as
`syncRemoteConfiguredAtPreGate`) and reused on the failure path rather than
re-invoking `checkSyncRemoteConfigured`/`isMemberSyncRemoteConfigured` a
second time. This is deliberately an at-most-once probe per attempt: the
member's `sync.remote` setting is not expected to change mid-attempt, and
re-probing on the failure path would double the bd-level round-trips for no
behavioral gain. The pre-gate's own skip branch (short-circuiting the whole
push when the probe reports "unconfigured") is retained as defense-in-depth
even though it is now logically redundant with the cached value being reused
later -- removing it would require re-proving the whole fail-closed
invariant above, for a saving that doesn't matter at this call frequency.

**Push failures are classified before they are retried, not folded together.**
A D-push rejection reaching this layer is first sorted into a distinct
`kind` -- `auth` (a git-credential failure, e.g. "could not read Username",
"Device not configured", or another credential-shaped error text) versus a
genuine non-fast-forward divergence -- at both terminals where a push can
still fail: the first push attempt, and the re-push that follows the single
reconcile-pull. This classification happens independently at each terminal
because the two failures can occur in either order in the same run (a real
conflict on the first push, then a credential failure on the retry, or vice
versa) and folding both into one "diverged" bucket produces a misleading
abort: nothing to reconcile, but the sprint reports itself as having lost a
data race instead of having a broken credential. An `auth`-classified
failure triggers the same one-shot reactive credential self-heal
(`provision_vcs_auth` for that member) used elsewhere in the sync layer
before the push is retried; a push rejection is only ever treated as a real
divergence -- and only then handed to the reconcile-pull-then-retry path
below -- once the credential path has been ruled out.

**Conflict recovery ladder** (dispatched only when the mutex/allocator still
leave a clone genuinely wedged -- e.g. a conflict introduced before the
serialization primitives existed, or an operational failure). The ladder is
wired directly into the D-push failure path itself -- invoked at both of the
divergence terminals described above (the reconcile-pull discovering the
clone still can't cleanly reconcile, and a re-push still being rejected
after that reconcile) -- rather than existing as a standalone module only
exercised by its own tests. With no recovery hook supplied, a divergence
still surfaces exactly as it did before the ladder was wired in (degraded-by-
default is preserved); the ladder only ever narrows an existing failure into
a resolved one, it never changes behavior when it isn't invoked. The same
composed ladder also backs the sync layer's explicit `repair()` entry point,
so an operator-triggered repair and an in-flight push failure both escalate
through identical stages:

1. **Path A (scripted, resolve-in-place)** -- gated behind two deterministic
   checks (every conflicted table is on an allowlist; exactly one conflicting
   row) -- resolves the single-row conflict via Dolt's SQL conflict-resolution
   surface and re-verifies a clean state and a successful push before
   declaring success. Requires a working, provisioned Dolt CLI binary on the
   member (installed as part of the standard install flow alongside the
   beads CLI) -- Path A cannot run at all without one.
2. **Path B (discard-and-re-bootstrap)** -- the fallback for whatever Path A's
   gates reject (multi-row conflict, a conflict outside the allowlist, or a
   genuine operational failure): discards the wedged clone's local Dolt state
   and re-bootstraps fresh from the shared remote, replaying back the one
   pending mutation that mattered.
3. **Tier 2 (agent-with-runbook, last resort)** -- dispatched only when Path A's
   gate rejected the conflict shape AND Path B itself failed. The agent
   receives a recorded "wedged state" snapshot (which member/clone, the last
   computed conflict shape, the raw failure output, which ladder stage
   produced it) and is instructed never to guess past what that snapshot
   says, to inspect both sides of every conflicting row with real judgment
   (never a blind `--ours`/`--theirs` rule), to verify zero data loss (commits
   from both sides of the original conflict must survive), and to report
   rather than force-push if it cannot resolve confidently. Success is
   decided the same way as the git ladder's Tier 2: a mechanical
   re-verification (clean conflict state, a genuinely successful push), never
   the agent's own claim.

## Run identity: truthful termination classification

Process-liveness signals alone cannot distinguish two genuinely different
situations: "the engine finished and recorded why" versus "something killed
the process before it could record anything." Inferring a sprint's outcome
from PID-liveness alone (PID gone -> assume crashed unless a terminal state
file happened to exist) collapses both into the same generic
CRASHED-sounding classification whenever the terminal-state read races the
process exit, or the two disagree for any other reason -- which is why the
supervisor instead threads one **run-id** from itself into the sprint child's
own engine run-state at spawn time, so the watchdog/dashboard/history layer
can key its own state to the same identity the engine uses internally
across consecutive supervisor-launched sprints (rather than the supervisor
guessing at a mapping). On top of that shared identity:

- The watchdog's FINISHED classification now copies the engine's own
  `terminalReason` (and, where present, `extensions.terminal.verdict`)
  **verbatim** into its log line and the persisted `sprint-history.json`
  FINISHED event, rather than re-deriving or paraphrasing a reason. A
  PID-gone sprint with no persisted terminal state is classified CRASHED,
  carrying a `terminalReason` that says explicitly no terminal state was
  ever persisted -- so an operator reading history can distinguish "the
  engine told us why it stopped" from "we never heard from it again."
- The spawner records the child process's actual exit code, signal, and
  exit time into the ledger the moment the child process exits -- this is
  independent of (and does not wait for) whatever the engine itself
  manages to persist, so even a child that dies before writing any terminal
  state still leaves a mechanically-observed exit record.
- An unmergeable Dolt conflict (`DOLT_DIVERGED`, see "Dolt sync discipline"
  above) is classified as its own terminal state -- `BEADS_SYNC_CONFLICT` --
  distinct from a generic failure, and carries the captured conflict dump
  forward into history rather than discarding it once the sprint aborts.

The throughline is the same "never trust a claim, verify mechanically"
pattern used elsewhere in this runner (see "The doer's own claimed status is
never trusted" above): a sprint's recorded outcome is now built from signals
the supervisor observes or the engine explicitly persists, never inferred
from the absence of a process.

## Per-sprint stdio capture

Each sprint child's stdout/stderr is teed to a per-sprint log file (in
addition to whatever the child would otherwise write), and the supervisor
dashboard serves and links that file per sprint. This exists specifically so
a sprint's raw output is traceable after the fact even when the child never
reaches a point where it can report anything structured back to the
supervisor (e.g. it dies before its first heartbeat) -- previously that
output was only visible if an operator happened to be attached to the
child's own process at the time. A non-zero-exit child is required to still
leave a traceable log/ledger entry rather than vanishing silently; this
invariant is verified end-to-end (not just at the unit level) by the
integration suite.

## newTask allowlist and rejected-task resurfacing

The `validateNewTask()` character allowlist (see "newTask validation
(injection defense)" above) was extended to accept square brackets, so a
reviewer-proposed task titled with the `[test]` convention (see the
graph-semantics doc's "Marking a task as verification work" rule) no longer
gets rejected purely for using the same bracket convention every other
consumer of that prefix relies on.

A newTask can still be rejected for other allowlist violations (backticks,
`$`, quotes, backslash -- the actual injection-relevant characters). Rather
than letting a rejected proposal simply vanish once logged, the runner now
**resurfaces** rejected newTasks into the next planning dispatch, so the
planner gets a chance to either reformulate the proposal in allowlist-safe
terms or explicitly decide not to pursue it -- a rejection is surfaced as
future planning input, not silently dropped. A resurfaced task is cleared
from the pending-resurface set once resubmitted, **title-independently**:
clearing must not require the resubmission to reuse the exact original
title verbatim (a planner reformulating a previously-rejected proposal will
usually change the wording), or a task that already made it back through
would resurface again to a following cycle in error.

## Determinism

`bd list --ready --json` does not guarantee stable ordering across otherwise
identical runs (a `created_at` field with only 1-second resolution ties
easily, and bead `id` carries a random per-scratch-dir suffix that is not a
safe sort key). Every place this runner consumes a ready-bead list, it
re-sorts by `(title, id)` -- the only field combination guaranteed both
present and stable -- so streak-assignment prompts, doer round-robin
assignment, and review-evidence ordering never depend on incidental `bd`
output ordering or on `parallel()`'s genuinely nondeterministic completion
order.

## Finalization

After the cycle loop exits (goal met, or `max_cycles` reached):

1. **Final Review** -- a `reviewer`-typed dispatch (schema `finalVerdict`,
   `PASS`/`FAIL`) is given real evidence: cycles run, closed-bead count,
   still-open-at-goal count, every deploy/integ failure, every rejected
   `newTask`. The prompt explicitly instructs the reviewer to never
   rubber-stamp `PASS` regardless of that evidence.
2. **Harvest** -- a `harvester` dispatch is given five pre-computed,
   verbatim-insert inputs: `analysisArtifactFile` (a deterministic path
   `docs/sprint-analysis-<branchSlug>.md`, where `branchSlug` is
   `computeBranchSlug(branch)` -- a human-readable branch-name prefix plus an
   8-hex-char SHA-256 suffix, so two differently-named branches can never
   collide on slug, and no wall-clock timestamp is embedded so the path is
   stable across idempotent re-runs), `analysisText` (a markdown summary of
   the whole run: progress history, deploy/integ outcomes, rejected
   newTasks, final verdict), and `costAnalysis` (a budget/spend summary,
   honestly reporting "not tracked"/"unlimited" rather than fabricating a
   number when the budget ceiling is unset or spend tracking is
   unavailable). The harvester's own contract (`harvester.md`) says to write
   `analysisText` verbatim and insert `costAnalysis` verbatim -- never
   reformat or recompute either.
3. **Publish PR** -- pushes the sprint branch (`git push -u origin
   <branch>`), then raises (never merges) a PR via `gh pr create`, whose
   title (`Auto-sprint [PASS|FAIL]: <branch>`) and body state the final
   verdict plainly, with the reviewer's (sanitized) notes appended. PR
   creation is idempotent: a `gh pr create` failure whose message matches
   `/already exists/i` is treated as success (the desired end state -- a PR
   is open for this branch -- already holds); any other failure is re-raised
   as a typed `CommandError`.

The run's return value reflects the **final verdict**, not blanket success:
`status: 'success'` only when `finalVerdictResult.verdict === 'PASS'`,
otherwise `status: 'failed'` (while the PR is still published either way, per
the pm skill's "never suppress, never auto-merge" rule).

## The viewer

`bin/cli.mjs` starts a dashboard viewer (`createDashboardViewer` from
`@apralabs/apra-fleet-workflow/viewer`) and extends it with this package's
`beadsExtension` (`fleet-sprint/viewer-extensions.mjs`): a "Beads Tasks" panel
that renders the live beads task tree (parent/child nesting, status color
coding, collapsible descriptions) whenever the runner calls
`publishState('beads', { tasks })` (done after most bead-mutating steps via
`updateDashboard()`). The extension ships its rendering function
(`renderBeadsHtml`) as plain string source embedded into the dashboard page's
`<script>` tag (via `.toString()`), since the browser-side script cannot
`import` this module directly -- the same implementation is unit-tested
directly under Node (no jsdom needed) and reused verbatim in the browser.
Every bead-derived field (`id`, `title`, `description`, `status`) is passed
through `escapeHtml()` before being placed into the HTML string, since bead
content is untrusted (LLM-authored) and the dashboard also exposes a `/stop`
capability -- this closes an XSS path that existed before the fields were
escaped.

## Journal and replay

`WorkflowEngine.executeFile()` supports an opt-in append-only JSONL journal
(`packages/apra-fleet-workflow/src/workflow/journal.mjs`) of every
`agent()`/`command()` call, keyed by a deterministic replay key (call
sequence, type, member, and a hash of the dispatched text). Passing
`resumeJournal: '<path>'` to `executeFile()` replays every call whose key
still matches from that journal instead of re-dispatching it to the fleet,
falling back to live execution from the first mismatch onward (partial
replay, not all-or-nothing). This is generic `apra-fleet-workflow` machinery,
off by default (zero I/O, zero behavior change, unless a caller opts in).

**`fleet-sprint`'s CLI does not currently expose flags for this** --
`bin/cli.mjs`'s call to `engine.executeFile()` passes neither `journal` nor
`resumeJournal`, so every `fleet-se sprint` run today executes live with no
journal written. The mechanism is available to any direct caller of
`engine.executeFile('fleet-sprint/runner.js', args, { journal: true })` (e.g.
a test, or a future CLI flag), and this package's own tests exercise it
(see `packages/apra-fleet-se/test/`), but there is no supported way to
resume a crashed `fleet-se sprint` invocation from the CLI today.

## Supervisor: reservation ledger and scope freshness (apra-fleet-eft.5)

`fleet-se serve` (`bin/serve.mjs`, `src/supervisor/`) is a separate, always-on
process from the per-sprint `bin/cli.mjs` invocation described above. It owns
one combined reservation ledger (`src/supervisor/ledger.mjs`) that claims two
axes per launched sprint in lockstep -- the reserved member set and the
issue-scope root id(s) -- in a single atomic disk write, so both axes always
claim and release together.

**Member-axis overlap** (`src/supervisor/api.mjs`, `defaultMemberOverlapGuard`):
`POST /api/sprints` computes the full member union (`--members` plus every
`roleMap` value, including the orchestrator role) and rejects the whole launch
with a 409 if that union intersects any other active reservation's members,
naming the conflicting sprint id and the specific overlapping member names.
The check runs strictly before `ledger.claim()`, so a rejected launch never
touches the ledger.

**Issue-scope overlap** (`src/supervisor/scope-overlap.mjs`): re-expands each
sprint's live parent-child subtree (via `bd list --parent`, one id at a time,
walked breadth-first) at every launch attempt rather than trusting a
launch-time snapshot, so a bead created mid-sprint under an already-claimed
root is still detected.

**Known best-effort limitation -- scope freshness.** Both overlap checks above
reason over the supervisor process's OWN service-local view of `bd` state.
This is independent of whether an individual sprint runs in `legacy` or
`synced` git/Dolt-sync mode (see "Multi-member topology" below): the
per-sprint sync brackets keep that sprint's own members' beads clones
reconciled with each other and with the shared remote, but they do not by
themselves guarantee the supervisor's own local view has just been refreshed
at the instant it evaluates an overlap. If another member's `bd` writes have
not yet reached the supervisor's local beads DB, an overlap involving that
write can go undetected until the next sync. This is a deliberate, surfaced
(not hidden) limitation -- the
ledger records the timestamp of the last successful sync used for scope
expansion and exposes it, rather than presenting overlap checks as
authoritative:

- `ledger.getScopeFreshness()` returns `{ lastSyncedAt, ageSeconds }`, derived
  from an internally tracked `lastSyncedAt` (updated via
  `ledger.setScopeFreshness()` after a successful sync/pull).
- When no sync has ever happened, `lastSyncedAt` is `null` and `ageSeconds` is
  the literal string `'never-synced'` -- the field is never silently absent.
- `GET /api/backlog` and `GET /api/sprints` both include this as
  `scopeFreshness: { lastSyncedAt, ageSeconds }` on every response, so a
  dashboard/operator can render "last synced N minutes ago" (or
  "never synced") rather than assuming the overlap check just ran against
  live truth.

Server-side enforcement of a guaranteed-fresh, cross-member-authoritative view
is out of scope for v1 and deferred to a later phase; likewise a manual
`bin/cli.mjs` run bypasses the supervisor's ledger entirely (it does not go
through `POST /api/sprints`) -- this is confirmed acceptable for v1, not a
bug.

## Supervisor: process model

`fleet-se serve` boots one always-on process that owns the reservation ledger
and an HTTP API, and never exits because a sprint finished or a sprint's child
process crashed -- it exits only on an explicit shutdown request or signal.
Each sprint runs as the *existing* per-sprint CLI, launched fully detached
(its own process group/session, no parent-child IPC channel, `stdio`
discarded): killing the supervisor leaves already-launched sprints running,
and a crashing/killed sprint never takes down a sibling sprint or the
supervisor. This is a deliberate rejection of an in-process/forked-worker
model -- independent OS-level process isolation is the whole point, so one
sprint's unhandled exception or resource exhaustion cannot cascade.

Because a supervisor restart severs any in-memory bookkeeping about which
children are still alive, two mechanisms make restart survivable:

- **A PID-liveness watchdog** polls every ledger-listed sprint and combines
  two independent signals -- OS-level PID liveness, and the child's own HTTP
  health/state endpoint answering -- into exactly one of four statuses:
  running-healthy, running-unresponsive (PID alive but HTTP silent -- an
  operator-attention signal, never auto-treated as death, and never killed
  by this mechanism), crashed (PID gone, no terminal state was ever
  persisted), or finished (PID gone, a terminal state was persisted). A
  hung-but-alive child is never conflated with a dead one.
- **Restart reconciliation + re-adoption**: on restart, each ledger entry is
  PID-probed. A dead entry releases both reservation axes in one atomic write
  and is recorded as aborted in the durable event history (a small,
  append-only audit log the ledger itself deliberately does not keep, since
  the ledger only ever represents "who holds a reservation right now"). A
  live entry is re-adopted: its externally-visible viewer port -- the one
  piece of state the ledger deliberately does not persist -- is recovered by
  reading the live process's own command line, so the re-adopted child is
  tracked identically to a freshly-spawned one (the watchdog can probe it,
  the sprints API can proxy its live state). Sprints are only expected to
  survive a *supervisor-process* restart, not a full machine restart.

**Manual force-release (operator recovery, no restart required)**: the two
mechanisms above only release a wedged reservation at supervisor *startup*.
Nothing releases a ledger entry during normal runtime -- not even the
watchdog: it is deliberately observe-only and never mutates the ledger on a
`crashed` classification (an operator-attention signal, not an
auto-remediation trigger). So a sprint whose child died (or was killed)
leaves its member(s) and issue-scope root 409-blocked for any new launch
until either the supervisor restarts, or an operator explicitly clears it:

```
POST /api/reservations/:sprintId/force-release
Body (optional): { "by": "<operator/reason tag>", "reason": "<free text>" }
```

- Releases **both ledger axes** (member set + issue-scope root) for that
  sprint id in one call, unconditionally -- no live child or reachable port
  required, unlike `POST /api/sprints/:id/stop` (which proxies to the
  child's own `/stop` and 409s with "no reachable child" if the child is
  already dead -- exactly the case this route exists for).
- Records a `force-released` event in the durable event history (sprint id,
  members, issue roots, `by`, `reason`, timestamp), so a manual recovery is
  auditable after the fact, not silent.
- 404s if the sprint id has no active ledger entry (already released, or
  never claimed).
- **Only touches the supervisor's own local ledger.** It does NOT touch the
  separate, fleet-server-side per-member `reservedBy` field described below
  ("Server-side member reservation") -- that is a different store, keyed
  differently (by branch name, not the ledger's `sprintId`), and requires
  its own recovery call: `mcp__apra-fleet__member_reservation` with
  `action: "force_release"` and the member name. A crashed sprint can leave
  either axis wedged independently of the other -- check both if a relaunch
  still 409s after force-releasing one.

An operator-facing HTTP surface (members with live-reservation overlay,
backlog, sprint CRUD, a proxy for each child's own cooperative stop endpoint)
reuses the same request-validation helpers the CLI path already uses (never a
second copy of the id/branch/member validation logic), so a malformed launch
request is rejected identically regardless of entry point.

## Supervisor: packaging self-containment

The supervisor must run entirely from what an installed `apra-fleet` ships
(npm install or the SEA binary) -- a user must never need a git checkout of
the source repo just to keep it running. This is a standing invariant, not a
one-time fix: `bin/serve.mjs` and everything reachable from it under
`src/supervisor/*` and the `fleet-sprint/*` modules it imports must resolve
entirely inside the packaged `apra-fleet-se` tree.

The packaging boundary that matters is the exclude set applied recursively at
every directory depth when building both the SEA asset tree
(`scripts/gen-sea-config.mjs`) and the `apra-fleet install` tree
(`src/cli/install.ts` `buildDevManifest()` ->
`src/cli/workflow-assets.ts` `extractWorkflowSubsystemAssets()`):
`test`, `docs`, `scripts`, `examples` are never shipped. A supervisor-reachable
module that imports anything under a top-level `scripts/` directory (a
repo-root-relative escape, e.g. `../../../../scripts/lib/foo.mjs`) will resolve
in a dev git checkout but throw `ERR_MODULE_NOT_FOUND` the moment it runs from
an installed tree, because `scripts/` is excluded from what gets shipped. The
fix for a genuinely shared helper is to vendor a verbatim copy inside the
packaged tree (e.g. `src/supervisor/lib/`) rather than reach out of it, and to
mark the copy clearly as vendored (source of truth + why) so it doesn't drift
silently. There is currently no automated guard keeping such a vendored copy
in sync with its canonical source -- that is a known gap, kept in sync by hand
today.

Because this class of bug is easy to reintroduce one file at a time, the
regression guard for it is graph-shaped rather than file-specific: walk the
full static import graph from the installed `bin/serve.mjs` (using the exact
same `buildDevManifest()`/`extractWorkflowSubsystemAssets()` path
`apra-fleet install` itself uses to build the tree under test) and assert
every resolved specifier stays inside the installed tree. That catches a
future out-of-tree import from *any* supervisor-reachable module, not just a
previously-broken file. A narrower test that only pins the previously-broken
import path (boots `serve.mjs` from an installed tree and asserts a specific
old import path is gone) is a useful smoke test but is a strict subset of the
graph-shaped guard and does not substitute for it.

One reachable module deliberately reads a source/build-only path at runtime
without being a hard dependency on it: `fleet-sprint/contracts.mjs`'s schema
loader tries a build artifact directory first, then falls back to the
package-local (shipped) schema directory, then to hand-written literal
schemas. A guarded, falling-back read of a source-only path is fine; an
unguarded import of one is the self-containment bug this invariant exists to
prevent. See `packages/apra-fleet-se/docs/supervisor-selfcontainment-audit.md`
for the full enumerated audit of every supervisor-reachable module.

## Dashboard

The supervisor serves exactly one index page. It renders, in order: one
section per currently-running sprint (branch, goal, the four-status
watchdog badge, live-recomputed claimed scope and member set, a link into
that sprint's live view) -- finished sprints are excluded from this section
entirely and instead live in a separate, process-free History view rendered
straight from each sprint's persisted terminal state (so viewing a finished
sprint's outcome costs zero running processes); then, always last, a
Backlog rendered as a tree (not a flat list) showing the full issue tracker
minus the union of every active sprint's *live-recomputed* claimed subtree --
recomputed at render time (not a launch-time snapshot) so a bead created
mid-sprint under an already-claimed root is claimed the instant it exists and
never leaks into the Backlog. A parent bead with only some children claimed
stays visible in the Backlog showing just its free children, annotated with
which sprint(s) hold the claimed ones, rather than disappearing or
duplicating. A Launch Sprint form (issue picker fed from Backlog rows, member/
role assignment, goal selector, branch naming) submits through the exact same
validated launch endpoint the CLI path uses, so it can never diverge from
server-side validation.

The Backlog's flat task list (`GET /api/backlog/tasks`, distinct from the
tree endpoint above) accepts an optional `sort`/`dir` query-param pair,
applied after the existing type/status/priority/model/q narrowing rather than
before it -- sorting narrows-then-orders the same set the filters already
produced, so `total` (the free/unclaimed count before filtering) is
unaffected by which sort is chosen. Only `created_at` is a supported sort
key today; `dir` is `asc` or `desc` (default `desc`). Rows come straight from
`bd list --json`, where `created_at` is an ISO string -- a missing or
unparseable value must never throw and must always sort last regardless of
direction, since bad/absent timestamps are expected input, not an error
condition. The sort itself is a decorate-sort-undecorate over each row's
original index (not a bare comparator handed to `Array#sort`), because
stability for equal or equally-invalid timestamps is a correctness
requirement, not an incidental nicety, and `Array#sort`'s stability is not
something this codebase wants to depend on across every JS engine it might
run under. Omitting `sort` entirely leaves row order exactly as the
type/status/priority/model/q narrowing produced it -- the sort path is
strictly additive, never a hidden default ordering.

On the client, the sort control is a single `<select>` that must drive two
`currentFilters` keys (`sort` and `dir`) at once, which is why it carries its
own `data-sort-field` attribute rather than reusing the generic
`data-filter-field` wiring the other header selects use (that wiring only
ever sets one `currentFilters` key per control). Choosing the neutral
"Unsorted" option deletes both keys from `currentFilters` rather than setting
them to empty strings, so the resulting query string omits `sort`/`dir`
entirely and the server sees the same "no sort requested" state as an
initial page load.

Each running sprint's live detail view is reached through a path prefixed by
the supervisor's own port (`/sprints/:id/live`, reverse-proxied to that
sprint's own per-sprint viewer) rather than linking a bare child port
directly -- the only externally-visible surface is ever the supervisor's own
port, so nothing leaks the supervisor's internal port allocation or requires
per-sprint firewall holes. Live-streamed updates (Server-Sent Events) are
proxied with no buffering and no compression, so the live view stays live
through the proxy hop.

## Server-side member reservation

Distinct from (and layered underneath) the supervisor's own reservation
ledger described above, the fleet server itself owns a per-member
`reservedBy` field that is enforced at dispatch time, not just at
launch/scheduling time. This closes a gap the ledger alone cannot: the
ledger only governs sprints launched through the supervisor's own `POST
/api/sprints` endpoint, so any dispatch issued another way (a manually
invoked per-sprint CLI, a direct MCP call) bypasses the ledger entirely but
still goes through `execute_prompt` -- which is where this check lives.

- **Ownership record** -- a `reserve` / `release` / `force_release` action
  set mutates a member's `reservedBy` field directly. `reserve` fails if the
  member is already reserved by a *different* sprint id (idempotent/refreshed
  if reserved by the same one); `release` only clears the reservation if the
  caller's sprint id matches the current holder; `force_release` clears it
  unconditionally regardless of current owner, and exists specifically to
  recover a wedged reservation (e.g. a crashed sprint that never released).
- **Dispatch-time enforcement** -- `execute_prompt` checks the target
  member's `reservedBy` before entering busy state: a member reserved by a
  different sprint id rejects the dispatch (naming the owning sprint),
  mirroring the same rejection shape as the pre-existing "already running"
  busy-state check. A dispatch from the owning sprint, or against an
  unreserved member, proceeds unchanged -- so behavior with no reservations
  in play is identical to before this existed.
- **Sprint identity comparison** -- the dispatch-time check needs to compare
  "who is dispatching" against "who holds the reservation" using the *same*
  identity value the reservation was created with. The most robust source is
  an explicit, opaque `sprint_id` passed on the dispatch call itself (the same
  token the caller already passed to the reservation reserve/release calls),
  which is compared directly. A caller that omits it falls back to reading
  the dispatching server process's own environment-stamped sprint id -- but
  that fallback is only correct when the launcher spawns a private
  per-sprint server process and stamps its own environment; it is not
  correct when the CLI instead attaches to an already-running, long-lived
  shared fleet server it did not spawn (and therefore never stamped) -- in
  that topology the environment fallback would see no id (or a stale one
  from an unrelated run) and incorrectly reject a sprint's dispatch against
  its own reservation. Any caller layered on top of a shared/attached fleet
  server should pass its own `sprint_id` explicitly on every dispatch rather
  than relying on the environment-variable fallback.

## Interactive dispatch liveness

A dispatch routed to a member's already-connected, long-lived interactive
session (rather than spawning a fresh subprocess) waits for that session to
call back with a response. That wait is bounded by two independent signals
raced against each other, not by the response timeout alone: the pending-
response wait itself, and a periodic poll confirming the target member's
underlying process is still alive. If the process is confirmed dead while a
response is still outstanding, the wait is aborted immediately with a
distinguishable "session died" error rather than being left to exhaust the
full (potentially very large) response timeout with no further signal ever
arriving. This matters because the member's process can die *after* the
initial pre-dispatch liveness check already passed (e.g. immediately after
the prompt was handed off, mid-turn) -- a single point-in-time liveness check
before dispatch is not sufficient on its own to bound a long-running wait.

**This is a partial mitigation, not a complete fix for orchestrator-side
hangs.** End-to-end smoke runs have shown the *dispatching* side (the
orchestrator waiting on the very first dispatch of a run) can still hang
indefinitely with no error surfaced, which this liveness poll (scoped to the
receiving member's session) does not address by itself. Treat a fix in this
area as verified only once a real end-to-end run completes a dispatch after
a simulated mid-wait process death, not merely once the unit-level liveness
poll test passes in isolation.

## CLI convergence: one shared fleet transport

Every process that talks to the fleet server -- the per-sprint CLI, the
supervisor, and any other internal caller -- resolves its connection through
one shared helper rather than each re-implementing the same
attach-to-a-running-singleton-else-self-spawn logic. This was a deliberate
convergence, not an incidental refactor: two independently-maintained copies
of the same resolution order are guaranteed to drift as the resolution rules
evolve, silently reintroducing the exact "doubled servers, split state"
failure mode a single shared helper exists to prevent.

## Testing convention: proving a mocked fixture spawns no live subprocess

Fixtures for supervisor-facing modules (dashboard, backlog, and similar) take
seams like `listAllBeads`/`driftCheck` specifically so tests can avoid
shelling out to a real `bd`/`git` against the developer's own live DB and
repo. Those seams default to the real subprocess-calling implementation when
omitted, so an incomplete fixture silently falls through to a live spawn
instead of failing loudly -- the failure mode is invisible unless a test
actively checks for it.

**In-process mocking of `node:child_process` (`execFile`/`execFileSync`) does
not reliably catch this.** A helper module that captures its own
`execFile`/`execFileSync` reference via a named import at module-evaluation
time keeps that binding even if a sibling module later mutates
`child_process.execFile` -- the mutation does not redirect the
already-resolved reference. The only technique that reliably intercepts every
invocation shape (`execFile` vs `execFileSync`, with or without `{ shell:
true }`) regardless of which internal helper or call style is used is an
OS-level PATH shim: run the module under test as a real child process with a
directory of fake `bd`/`git` executables prepended to `PATH`, each of which
appends its own invocation to a marker file and exits 0. An empty marker file
after the run proves no live subprocess was spawned; this is POSIX-only
(the shim scripts are bash), gated behind `process.platform !== 'win32'`.

A regression guard built this way should also validate that the child
process it spawned actually exercised meaningful test coverage, not just that
it exited 0 -- a child that spawned zero subtests, or crashed before running
anything, would still report a clean marker file and a zero exit code,
silently passing a vacuous check. Parse the child's own TAP summary line
(`# tests`, `# pass`) and assert it clears a known floor.
