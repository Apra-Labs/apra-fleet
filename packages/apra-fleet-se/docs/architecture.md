# Architecture / Internals

This document describes how `auto-sprint/runner.js` is put together
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
`vendor/apra-pm/agents/*.md` definition, no schema, and is never passed to
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

### newTask validation (injection defense)

Reviewer-proposed `newTasks` are LLM output that will be interpolated into a
double-quoted `bd create "..."` shell command. Because sprint members run
mixed shells (POSIX and Windows) with no single reliably-safe escaping
scheme, `validateNewTask()` uses an **allowlist**, not escaping:
`priority` must match `^P[0-4]$`; `title`/`description` must match
`^[A-Za-z0-9 .,:;!?()'_/-]+$` (notably excluding backtick, `$`, double-quote,
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

## Budget tracking

`--budget <usd>` (optional) sets `context.budget.total` before any dispatch;
omitted, it stays `null` (unlimited). The engine's `agent()` already checks
`budget.remaining() <= 0` before every dispatch and throws a budget-exceeded
error -- this runner's only job is to actually set `budget.total` from the
validated arg.

Model-tier pricing for non-doer roles is fixed by `FIXED_ROLE_MODEL` (a
runner-owned policy table, not a live read of fleet configuration):

| Role | Model | Rationale |
|---|---|---|
| `planner` | `opus` | Highest-stakes single dispatch of a cycle |
| `plan-reviewer` | `opus` | Vendored contract treats reviewer-class work as premium |
| `reviewer` | `opus` | Vendored contract: "always use model: premium" |
| `deployer` | `sonnet` | Mostly mechanical: follow `deploy.md` |
| `integ-test-runner` | `sonnet` | Mostly mechanical: follow `integ-test-playbook.md` |
| `harvester` | `sonnet` | Docs/CHANGELOG synthesis, not code-critical |

`doer` dispatches instead price themselves off the **per-bead model tier**
the planner recorded as beads metadata (`bd create ... --metadata
'{"model": "<tier>"}'`, per `planner.md` Step 3 -- this is documented as the
*only* place the tier is recorded). When a streak spans beads with different
declared tiers, the runner picks the first (by streak/bead-id order) and
logs the discrepancy rather than blending. A bead with no `model` metadata
resolves to `undefined`, which the engine treats as "unpriced" -- the
dispatch still runs, it just is not counted toward budget.

**Honesty caveat, stated directly in the code**: this is the model the
*planner asked* the doer to run on, not a verified actual -- the fleet does
not currently echo back the model it actually resolved/ran with alongside
usage. Budget tracking (and the harvester's cost-analysis block) is
explicitly an estimate, not a guaranteed total, and is reported as such
rather than being backfilled with a fabricated number.

## Multi-member topology

This runner has **no cross-member `bd`/git sync layer**. Every orchestrator
`bd` command runs against the orchestrator member's beads DB; a doer's own
`bd close` runs against its own member's DB; the sprint git branch is only
coherent if every member operates on the same working state. That design
only coheres in two supported modes:

- **Single-member** -- one member does everything.
- **Verified shared-workspace fleet** -- every configured member resolves to
  the same checkout/DB (e.g. several fleet member registrations pointing at
  one physical machine/workspace).

Independent, genuinely separate per-member checkouts are **not supported**:
a doer's `bd close`/commit on its own checkout would silently diverge from
what the orchestrator (and the eventual PR) sees. Two mechanisms enforce
this:

1. **`checkMemberTopology()`** (called from `bin/cli.mjs`, before the sprint
   starts) -- compares an identity signal (`git rev-parse HEAD`) across every
   configured member and refuses to start on a mismatch. Single-member
   sprints trivially pass (nothing to compare). A member whose signal cannot
   be obtained is treated as a refusal, not a silent skip -- shared state
   cannot be proven otherwise. This is a best-effort heuristic at start, not
   an ongoing guarantee: two independent checkouts that merely happen to sit
   on the same commit right now would pass.
2. **Branch-ensure everywhere** -- before the first doer round, the sprint
   branch is `git fetch`+`checkout -B`'d on every member in the union of the
   orchestrator/doer/reviewer pools (not just the orchestrator). At the top
   of every subsequent cycle, a non-destructive `git checkout <branch>`
   (`failSoft: true`) re-ensures each member is still on the sprint branch --
   deliberately not a `checkout -B ... origin/<base>`, which would discard
   any work already committed to the branch.

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
`beadsExtension` (`auto-sprint/viewer-extensions.mjs`): a "Beads Tasks" panel
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

**`auto-sprint`'s CLI does not currently expose flags for this** --
`bin/cli.mjs`'s call to `engine.executeFile()` passes neither `journal` nor
`resumeJournal`, so every `fleet-se sprint` run today executes live with no
journal written. The mechanism is available to any direct caller of
`engine.executeFile('auto-sprint/runner.js', args, { journal: true })` (e.g.
a test, or a future CLI flag), and this package's own tests exercise it
(see `packages/apra-fleet-se/test/`), but there is no supported way to
resume a crashed `fleet-se sprint` invocation from the CLI today.
