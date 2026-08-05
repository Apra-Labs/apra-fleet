# fleet-sprint Per-Issue Phase Routing -- Design Proposal

Status: DRAFT for review. The first review round's open questions have all
been resolved by the repo owner and are incorporated below as decisions
(recorded in section 7). No code has been written against this document.

Scope: `packages/apra-fleet-se/fleet-sprint/runner.js` (the sprint engine),
its vendored agent contracts (`packages/apra-fleet-se/apra-pm/agents/*.md`
and `fleet-sprint/contracts.mjs`), and the dashboard/run-state surface.

The design brief, verbatim from the repo owner:

> "i do not like that flag based approach... if we are able to easily
> identify the issues which need not be sent to planner, so why is the
> workflow sending them to planner? why cant workflow drive what needs to be
> sent to planner, to plan reviewer, to doer, to reviewer, to integration
> tester, why those sets have to be exactly same (and why a null set). what
> we are missing is a genuine thinker."

This document proposes exactly that: a first-class routing step that gives
every issue in a sprint's scope its OWN set of applicable phases, decided
and revised inside the workflow, per issue -- not per sprint, and not via a
flag.

---

## 1. Problem Statement

The current engine runs one lockstep pipeline per cycle -- Plan ->
Develop/Review -> Deploy -> IntegTest -> Cycle Eval, then once per sprint
Final Review -> Regression Test -> Harvest -> Publish PR -- and every phase
operates over the SAME issue scope. There is no mechanism by which the
workflow can say "this issue needs none of Plan/Develop/Review, only
IntegTest" while a sibling issue in the same run gets the full pipeline.
Four real incidents from a single operating session show what this costs.

### Case study 1: the kuh.5 deadlock (SPRINT_PLAN_REJECTED)

A sprint scoped at a grandparent bead (apra-fleet-fyc epic) aborted with
`SprintPlanRejectedError` after 3 planning rounds. One child task
(apra-fleet-kuh.5) had zero remaining implementation work -- its acceptance
criteria were independently verified as already satisfied in the current
codebase. But the Plan phase dispatches the planner over the whole scope and
the plan-reviewer applies uniform plan-quality gates (lane cohesion,
no-duplicate-work, cross-lane dependency rules) to every issue in it. Forced
to produce "a plan" for an issue with no work, the planner invented an
artificial cross-lane blocking edge to defer it; the plan-reviewer correctly
flagged that edge as a violation; three rounds of this exhausted the plan
cap and killed the run. A human had to close kuh.5 and remove the bad edge
out-of-band.

The failure is architectural, not a prompt bug: the engine had all the
information needed to conclude "kuh.5 needs no planner" and no place to act
on it. There is no route by which an issue can be excluded from the Plan
phase while remaining in the sprint.

### Case study 2: all-closed parents are invisible ("Nothing to do")

Launching a sprint scoped directly at a parent bead whose children are ALL
closed aborts immediately in pre-sprint validation: "No
open/in-progress/blocked/deferred beads found... Nothing to do." Mechanism
(from the actual code, see section 2.1): scope discovery collects
descendants of the targets plus childless targets themselves -- a target
WITH children deliberately keeps its own id out of scope. An all-closed
subtree therefore contains zero not-done beads, and validation throws.

But an all-children-closed parent is precisely the item that most needs an
IntegTest-style verification-and-closure pass. The only workaround found was
scoping at a grandparent that happens to have open leaf work elsewhere in
its tree -- an accident of the BFS, not a designed capability.

### Case study 3: evidence-quality inconsistency at closure

In the same run, some beads were closed with real cited evidence (e.g.
apra-fleet-ed4: an integ-test-runner pass citing actual npm test output)
while others closed with a bare "Closed" reason and zero evidence, because a
permission gap silently degraded product-level verification into
doer-self-attestation. Nothing in the engine distinguishes
closure-by-verification from closure-by-implementation, and nothing enforces
a minimum evidence bar for either. The engine already refuses to trust a
doer's *success claim* (`verifyDoerStreakClosed`), but it fully trusts any
closure's *evidence quality*.

### Case study 4: no bulk-verify entrypoint

The triggering use case -- "here are 15 already-implemented, unit-tested,
reviewed parent beads scattered across the backlog; verify each against the
live product and either close it with evidence or file a bug" -- has no
natural expression. Today it requires the grandparent-scope workaround of
case 2, and even then all 15 are dragged through Plan/Develop/Review
lockstep as one undifferentiated batch, exposing each of them to the case-1
failure mode.

### The rejected fix, and why

A `--verify-only` sprint flag was proposed and rejected. A flag is a binary
mode switch over the whole run: it replaces "everything gets all phases"
with "everything gets only IntegTest." Both are the same disease -- phase
applicability decided per SPRINT instead of per ISSUE. The moment one run
contains both a genuinely-unimplemented task and an already-done parent (the
normal case for any real epic), no flag value is correct. This design
contains no sprint-level mode; the one place it brushes against
sprint-level configuration (the existing `--goal` priority filter)
introduces no new special-casing at all -- see section 5.

---

## 2. Current Architecture (as actually implemented)

All references are to `packages/apra-fleet-se/fleet-sprint/runner.js`
(~8,800 lines) at branch `chore/integration-binary-fixes-and-auth-selfheal`.

### 2.1 Scope resolution

Despite the docs describing scope as "`bd list --parent <id>`", the code
(`bdListScoped()`, ~line 5060) does something more capable: one `bd list
--all --limit 0 --json` fetch (cached in `allBeadsSnapshot`, invalidated on
every phase change and every mutating bd command), a locally-built
parent->children map, then a BFS from every `--issue` target to collect
every descendant at any depth, any status. Two properties matter here:

- A target that HAS children keeps its own id out of scope ("a pure
  grouping node is never counted as independently ready work"). Childless
  targets seed themselves.
- `readyLeafBeads()` = scope intersect `--ready`, minus any bead that is
  structurally a parent, then filtered to `issue_type == 'task'` (targets
  exempt) before doer seeding.

Pre-sprint validation requires a non-empty ready set (after self-healing
stale `in_progress` beads and auto-repairing parent-child+blocks cycles);
if the scope has zero not-done beads at all it throws "Nothing to do" --
the case-2 abort.

### 2.2 The cycle loop

`runSprintCycle()` runs `while (cycle <= MAX_CYCLES)` (default 5). Each
cycle is one shared lockstep sequence; phase titles are literal:

```
Sprint Setup (once): Ensure Sprint Branch on all members
per cycle:
  Plan C{n} R{1..3}      planner <-> plan-reviewer, up to 3 rounds
  [Replan C{n} R{k}]     in-cycle scoped replan (reviewer-flagged criteria)
  Develop C{n} R{1..3}   streak grouping -> doer worklists -> dispatch
  Review C{n} R{1..3}    reviewer verdict; orchestrator applies transitions
  Deploy C{n}            iff deploy.md exists
  Integ Test C{n}        iff playbook exists AND deploy succeeded
  [Re-Review C{n}]       iff 0 open at goal but no review ran this cycle
  Cycle Evaluation       goal-priority exit + stall bookkeeping
once, after the loop:
  Final Review C{last} -> Regression Test C{last} -> Harvest C{last}
  -> Publish PR C{last}
```

Key mechanics, phase by phase:

- **Plan**: `buildPlannerPrompt({targetIssues, ...})` always covers the
  whole scope; approval is `verdict === 'APPROVED'` exact-match on the
  schema-validated `planReviewerVerdict`. On cap exhaustion: if the
  CHANGES_NEEDED findings name a proper subset of `taskAssignments`, those
  beads are deferred (`bd update --status=deferred` + a note) and the run
  proceeds; otherwise `SprintPlanRejectedError` (genuine rejection) or
  `PlanReviewDispatchFailedError` (dispatch channel never came back). This
  partial-deferral path is the engine's only existing per-issue divergence
  from lockstep in the Plan phase -- and it is an ABORT-avoidance valve,
  not routing.
- **Develop/Review**: up to 3 `devRounds`. Streak grouping prefers
  deterministic planner lane metadata (`groupStreaksFromLaneMetadata`),
  falling back to an LLM Streak Assignment dispatch validated by
  `selectStreaks()`, falling back to one-bead-per-streak. Doer dispatches
  are wrapped in `withGitSync` brackets (G-pull/D-pull, dispatch,
  G-push/D-push) and strictly serialized through `globalDoerTurn` because
  concurrent writers break the fast-forward-by-construction sync
  invariant. Closures are never trusted from the doer's report:
  `verifyDoerStreakClosed()` re-reads `bd show` after a D-pull. The
  reviewer verdict carries `reopenIds` (orchestrator applies the reopen,
  with a goal-priority allowlist), `replanIds` (triggers the in-cycle
  scoped replan, max once per bead per cycle via `replannedThisCycle`),
  and `newTasks` (validated, allocator-minted `bd create`).
- **Deploy / Integ Test**: file-probe gated (`deploy.md`,
  `integ-test-playbook.md`). The integ prompt names this cycle's open
  features explicitly, and -- notably -- already contains a small,
  hardcoded verification-closure clause: open BUG beads whose task
  children are all closed are handed to the integ runner to "close with a
  note naming the evidence" or leave open with a reason
  (`pendingClosureBugs`, ~line 7579). This is the embryo of per-issue
  routing, implemented as prompt text inside one phase, for one issue
  type.
- **Cycle Evaluation**: completion is "zero NOT_DONE beads in scope at
  goal priority AND a reviewer APPROVED verdict from THIS cycle" (a
  Re-Review is dispatched if the count is zero but no review ran). Stall
  detection is a high-water mark on the scope's closed count:
  `STALL_CYCLE_LIMIT = 2` consecutive non-record cycles throws
  `StalledSprintError`, decorated with reopen-thrash bead ids
  (`REOPEN_THRASH_LIMIT = 3` reopens per bead).
- **Finalization**: `finalVerdict` (PASS/FAIL) drives the return value;
  FAIL findings are persisted as beads. Regression Test is deliberately
  post-verdict and can never gate. Publish PR pushes the branch (failSoft
  with retries; a persistent failure preserves the computed verdict with
  `pushed: false`) and raises a PR; on a non-hosted remote it instead
  closes the target issues directly on a PASS verdict.

### 2.3 Safety nets and persistence

- `isTypedAbortError()` (Stalled/PlanRejected/ReviewerContractViolation/
  git+dolt divergence, etc.) routes through `finalizeAbort()` (branch push
  + idempotent `[ABORTED]` PR iff real commits exist);
  `isTerminalSprintFailure()` (broader: every WorkflowError) gates the
  terminal history record `publishState('terminal', ...)`.
- Run state: `publishState(namespace, data)` feeds the viewer's debounced
  `running/<runId>.json` (moved to `old_runs/<runId>.json` on terminal
  completion) -- namespaces today: `sprint-args`, `beads`
  (sprintTasks/backlogTasks with a computed `ready` badge), `result`,
  `terminal`. This file is OBSERVATIONAL; the engine never resumes from
  it. The authoritative progress record is the beads DB itself.
- Roles are a closed set (`contracts.ROLES`): planner, plan-reviewer,
  doer, reviewer, deployer, integ-test-runner, regression-test-runner,
  ci-watcher, harvester. Each dispatch site carries a fixed model tier and
  a role-specific structured-output schema.

### 2.4 What is already half-built

Worth naming, because the proposal below is a unification, not a
greenfield: the engine already contains at least five implicit, scattered,
phase-local micro-routers --

1. doer seeding filters (leaf-only, task-only) -- "don't send parents/bugs
   to a doer";
2. `pendingClosureBugs` -- "route all-children-closed bugs to
   verification-closure by the integ runner";
3. the open-features list handed to the integ runner -- "route implemented
   features to evidence-based closure";
4. `replanIds` -- "route this bead back to the planner mid-cycle";
5. plan-cap partial deferral -- "route contested beads out of the sprint".

Every one of these is hardcoded, invisible in the run state, and covers
exactly one issue-shape. None can express "this issue needs NO phase before
IntegTest" or "this parent needs ONLY verification." The proposal makes the
routing decision a single explicit, inspectable mechanism instead of five
buried special cases.

---

## 3. Proposed Architecture: the Router and per-issue routes

### 3.1 Core abstractions

**Phase-set.** The canonical routing datum. For each in-scope issue, the
set of engine phases that apply to it this sprint, drawn from
`{Plan, Develop, Review, IntegTest}`. (Deploy, Regression Test, Final
Review, Harvest, Publish are RUN-level phases -- they operate on the run's
artifacts, not on individual issues -- and are not per-issue routable.)
A phase-set may be empty for some phases and non-empty for others; it may
be entirely empty only in combination with an explicit disposition (see
`close`/`defer` below).

**Route.** A named member of a small closed vocabulary, each defined as a
phase-set plus a closure-evidence bar. Free-form phase subsets are
deliberately NOT exposed (decision 2, section 7): most of the 16 subsets
are incoherent (Develop without Review; Plan alone), and a closed
vocabulary is what keeps the routing table legible to a human and
assertable by tests. Naming convention, per the same decision: the
pipeline-entry routes are named after the EARLIEST phase they enter --
`plan`, `develop`, `review` -- while `verify`, `close`, `defer`, and
`hold` are dispositions, not entry points, and keep their own names.
(Routes are written lowercase in backticks; engine phases stay
Capitalized, so "`plan`-routed" and "the Plan phase" stay distinct on the
page.) The vocabulary:

| Route     | Plan | Develop | Review | IntegTest | Meaning                                                          | Evidence bar for closure       |
|-----------|------|---------|--------|-----------|------------------------------------------------------------------|--------------------------------|
| `plan`    | yes  | yes     | yes    | yes*      | genuinely-unimplemented work; enters at Plan (today's pipeline)  | implementation + review        |
| `develop` | no   | yes     | yes    | yes*      | already planned, criteria sound, work remains; enters at Develop | implementation + review        |
| `review`  | no   | no      | yes    | yes*      | implemented on the sprint branch, never reviewer-approved        | implementation + review        |
| `verify`  | no   | no      | no     | yes       | believed done; needs product-level verification and closure      | verification (cited evidence)  |
| `close`   | no   | no      | no     | no        | moot/duplicate/already satisfied; orchestrator closes directly   | triage-rationale               |
| `defer`   | no   | no      | no     | no        | out of this sprint (status=deferred + note)                      | n/a (not closed)               |
| `hold`    | no   | no      | no     | no        | blocked on an unmet dependency; revisit next cycle               | n/a                            |

(*) "IntegTest = yes" carries TWO distinct meanings, and the table marks
them apart because they are easy to conflate. For `verify`, IntegTest
GATES closure: the phase is what produces the verification-bar evidence.
For the entry routes (`plan`/`develop`/`review`), marked `yes*`,
IntegTest means the issue's implemented work is EXERCISED by the cycle's
IntegTest pass for regression/gap detection -- which is exactly the
current engine's behavior (2.2): the integ runner runs the playbook
against the deploy that contains their commits and closes their parent
FEATURES on evidence, while the leaf issues themselves already earned
closure at the implementation + review bar and are NOT re-gated. What
`implementation + review` guarantees is criteria-met on the branch at
review time; it deliberately does NOT claim product-level verification
-- that is what the chk exercise adds. And a chk finding is not
informational: a gap found here MATERIALIZES as a new, goal-visible bug
bead (orchestrator-enforced -- see the materialization rule in 3.3),
never as a reopen of the earned closure and never as a mere log line.

(kuh.5 routes `verify` -- or `close` where the triage rationale alone
suffices (decision 1); `verify` stays the evidence-preferring default for
"believed satisfied" claims. An all-closed parent routes `verify`. A
brand-new feature routes `plan`. Note `verify` has empty
Plan/Develop/Review sets and a non-empty IntegTest set -- the "null set
for some phases, non-empty for others, same issue, same run" requirement
is satisfied by construction.)

**Is `review` a real entry point, or does it collapse into `develop`?**
The renaming surfaced this question and the answer is: real, and worth
naming. The concrete producer of the shape is an interrupted prior run on
the same sprint branch: `finalizeAbort()` pushes the branch with whatever
the doers committed, and a relaunch adopts `origin/<branch>` in Ensure
Sprint Branch -- so a bead whose implementation was committed (and
possibly closed) before the run died ahead of its Review round arrives at
the next launch with code on the branch and no reviewer verdict anywhere.
(The engine already acknowledges this state exists: the Re-Review C{n}
path exists precisely because "done but not reviewed this cycle" is
real.) Routing it `develop` is SAFE but wasteful -- it burns a full doer
dispatch for the doer to discover there is nothing to do -- whereas
`review` enters at exactly the phase that has pending work, and the
dispatch seam already exists (see 3.2). If Review then finds gaps, its
normal CHANGES_NEEDED reopen puts the bead back through the Router, which
routes it `develop` next cycle.

**Routing record.** Per issue:

```
{
  id: "apra-fleet-kuh.5",
  route: "verify",
  evidenceBar: "verification",       // derived from route; stamped on the bead
  rationale: "leaf task, open, acceptance criteria observed satisfied at <sha>; no integ evidence on record",
  decidedBy: "structural-rule:<name>" | "triage-agent" | "triage-override:<disputed rule>",
  cycle: 1, revision: 0,
  history: [ {cycle, from, to, cause} ]   // populated by re-routing
}
```

**The Router.** A new phase, `Route C{n}`, first in every cycle (before
Plan). It owns producing/refreshing the routing table. Two cooperating
layers:

1. **Structural classifier (deterministic, orchestrator-side).** A pure
   function over the beads snapshot `bdListScoped('')` already fetches.
   Facts it computes per issue: is it a leaf or a grouping node; child
   status census; issue_type; status; does it carry a verification
   evidence stamp (see 3.4); was it previously routed (metadata). Rules
   that are decisive route directly, e.g.:
   - grouping node, all children closed, no verification stamp -> `verify`
   - grouping node with open children -> not independently routable
     (its leaves route; it closes when they do, or becomes `verify` later)
   - open leaf task, never planned/no criteria -> `plan`
   - closed leaf -> not routed (done)
2. **Triage agent (LLM, "the genuine thinker").** Dispatched once per
   Route phase over the FULL routable scope: it receives the structural
   layer's proposed table (each proposal tagged with the rule that made
   it) plus the undecided remainder, and it may both (i) decide the
   undecided -- prototypically: an open leaf whose acceptance criteria may
   already be satisfied by the current codebase (the kuh.5 shape is
   exactly this; no structural rule can see it) -- and (ii) OVERRIDE a
   structural proposal (decision 4: "that is a real value for LLM").
   A new vendored role (`triage`, added to `contracts.ROLES`), read-only
   workspace access (like the reviewer), modest turn budget, with a
   `triageDecision` output schema:
   `{routes: [{id, route, rationale, override?: {disputedRule, reason}}], notes}`.
   Overrides carry a deliberately HIGHER rationale bar than gap-filling:
   the `override` object is REQUIRED whenever the route differs from the
   structural proposal, and must name the specific structural rule being
   disputed and the observed evidence against it -- so every override is
   auditable in the routing table (`decidedBy:
   "triage-override:<disputed rule>"`), never silent. Output validation by
   the orchestrator works exactly the way `selectStreaks()` validates
   streak candidates -- unknown ids rejected, every undecided id covered,
   an override missing its `override` object rejected -- and the hard
   invariants bind IDENTICALLY on fresh decisions and on overrides; no
   rationale, however eloquent, can breach them (numbered so the
   walkthrough traces in section 6 can cite them):
   - [inv-1] an issue with open `plan`/`develop`/`review`-routed
     descendants cannot be routed `verify` or `close`;
   - [inv-2] `verify` and `close` require a non-empty rationale citing
     what was observed;
   - [inv-3] the triage agent cannot mutate beads (orchestrator applies
     routes -- including performing `close`-route closures itself, see
     3.2/3.4 -- same contract as reviewer verdicts);
   - [inv-4] an issue that is not bd-READY (it has unmet `blocks`
     dependencies) cannot be routed `verify` or `close`: the closure
     routes require readiness, read from the same `--ready` signal doer
     seeding already trusts. (Added by walkthrough 6.2, which found the
     descendant check alone left dependency-blocked issues exposed to a
     premature-closure override.)
   - [inv-5] `close` may be applied at most once per issue, ever: a
     reopened ex-`close` issue must route `verify` or a pipeline-entry
     route on any later pass -- the stamped route history (3.4) makes
     this mechanically checkable. (Added by walkthrough 6.5.)
   On schema-repair exhaustion or dispatch failure, the fallback is
   deterministic and conservative: the structural table stands as
   proposed, and undecided issues route `plan` -- the current behavior, so
   a broken triage agent degrades to today's engine, never to silently
   skipped work.

This split mirrors the engine's existing and proven pattern (deterministic
lane metadata preferred, LLM fallback validated, deterministic final
fallback), and keeps golden-transcript determinism testable: the structural
layer is a pure function; the triage dispatch is mockable like every other
dispatch.

### 3.2 Phase scoping: every phase reads the routing table

Each downstream phase's issue scope becomes "issues whose route includes
me," and a phase whose set is empty is SKIPPED with a log line -- the
engine already has exactly this shape for empty ready-sets (Develop/Review
skip) and missing runbooks (Deploy/IntegTest skip), so an empty-set skip is
a familiar, well-trodden state, not a new one:

- **Route application (end of the Route phase)**: the orchestrator --
  never the triage agent -- stamps `route`/`evidence_bar` metadata,
  executes `close` closures (decision 1: the rationale note is written
  atomically with the close, see 3.4) and `defer` transitions, and
  D-pushes, following the same orchestrator-mutation pattern as
  reviewer-verdict application. All downstream scope math in the same
  cycle therefore already sees `close`-routed beads as closed.
- **Plan / Plan-Review**: `buildPlannerPrompt` gains the routed plan-set
  (the `replanScope` parameter already proves the prompt can be scoped to a
  subset -- this generalizes it). The plan-reviewer's gates (lane cohesion,
  duplicate-work, dependency edges) bind ONLY over the plan-set. Case 1
  becomes impossible: kuh.5 is simply not in the set the planner is graded
  on. If the plan-set is empty, `Plan C{n}` does not dispatch at all.
- **Develop / Review**: doer seeding adds a route filter
  (`plan`/`develop`) on top of the existing leaf/task filters. Reviewer
  round scope is already per-round (`assignedBeadIds`); `review`-routed
  issues are unioned into it. When no develop round ran this cycle but
  the review-set is non-empty, a standalone review is dispatched through
  the existing scope-parameterized `dispatchReview()` seam -- the same
  one the Re-Review C{n} path already uses outside the Develop loop -- so
  the `review` entry route costs no new machinery.
- **IntegTest**: the dispatched scope becomes the union of (a) this
  cycle's implemented open features (today's behavior), (b)
  `pendingClosureBugs` (today's behavior, now expressed as routes instead
  of prompt-local derivation), and (c) all `verify`-routed issues. The
  integ runner's contract extends from "close passing features / file
  bugs" to "for each verify-routed issue: close with cited evidence, or
  report a gap" (see 3.3). Note the two roles this one dispatch plays,
  per the route table's `yes*` footnote (3.1): for set (c) it is the
  closure gate (verification bar); for sets (a)/(b) -- and for the leaf
  work of `plan`/`develop`/`review`-routed issues, which the playbook
  exercises through the deployed build and the parent-feature closure
  checks -- it is regression/gap DETECTION over closures already earned
  at the implementation + review bar. Detection carries a specified,
  enforced consequence: the chk-gap materialization rule (3.3) requires
  every such gap to exist as a goal-visible bug bead, with the
  orchestrator filing a fallback bead whenever the runner reports a
  failure without one. A check whose finding could evaporate into a log
  line would be worse than no check; this rule makes that state
  unrepresentable.
- **Cycle Evaluation / Final Review**: unchanged in shape; `verify`-routed
  issues count in `openAtGoal` like any other not-done bead, so a sprint
  cannot exit "complete" while verification work is still open.

Pre-sprint validation changes from "non-empty ready set" to "non-empty
ROUTABLE set": a scope containing only verify-candidates is a valid sprint
(fixes case 2). Scope discovery adds one rule: a target (or interior
grouping node) whose children are all closed is itself admitted to scope as
a routable item -- the BFS already sees these nodes; today it deliberately
drops them.

Bulk verify (case 4) then falls out with no dedicated feature: `--issue
p1,p2,...,p15` (the flag already accepts a comma list), Router routes all
fifteen `verify`, Plan/Develop/Review phases are empty and skip, IntegTest
receives the batch, closures carry evidence, Final Review judges the run on
that evidence. One workflow, no mode.

### 3.3 Re-routing mid-run (the bounce), without infinite loops

Routes are revised at exactly two kinds of moments, both already
established engine seams:

1. **Every Route C{n}** (cycle boundary): the structural classifier re-runs
   over fresh state -- e.g. a `plan`-routed feature whose tasks all closed
   in cycle 1 becomes `verify`-eligible for its parent in cycle 2's table.
   This forward direction (plan -> verify) is ordinary progress.
2. **IntegTest bounce** (evidence-driven, the direction the brief calls
   out): `integReport` gains an optional `gapsFound: [{id, evidence}]`
   field, structurally parallel to the reviewer's existing
   `reopenIds`/`replanIds`. When the integ runner discovers that a
   `verify`-routed issue actually has real implementation gaps, the
   ORCHESTRATOR (never the agent) applies the bounce: re-route `verify ->
   plan`, attach the cited evidence as a note, and the next cycle's Plan
   phase picks it up -- inside the same run.

Loop-safety, designed to compose with (not around) the existing nets:

- **Bounce cap**: an issue may bounce `verify -> plan` at most once per
  sprint (mirroring `replannedThisCycle`'s max-one-scoped-replan
  precedent). A second gap-finding on the same issue defers it with the
  evidence attached -- filed as next-sprint work, not looped.
- **Route-flip accounting**: `routeChangeCounts` per issue, alongside the
  existing `reopenCounts`; flip counts are surfaced in
  `StalledSprintError` details exactly as thrash ids are today.
- **The stall detector needs no modification to remain sound**: it is a
  high-water mark on the scope's CLOSED count. Verification and `close`
  closures raise it (progress); a verify<->plan oscillation closes
  nothing, sets no new
  high-water mark, and trips `StalledSprintError` after the same
  `STALL_CYCLE_LIMIT = 2` cycles it would today. The bounce cap exists to
  produce a better diagnosis before the stall net fires, not to replace it.
- **Round caps are per-phase-instance and unchanged**: 3 planning rounds
  bind whenever the plan-set is non-empty; 3 dev rounds likewise. A
  bounced issue re-entering Plan next cycle consumes that cycle's normal
  budgets. `MAX_CYCLES` remains the outermost bound on total re-routing.
- **Route-empty exit** (added by walkthrough 6.3): when a Route phase
  yields NO issue with a non-empty phase-set -- everything in scope is
  closed, `defer`red, or `hold`-routed -- and the previous cycle applied
  no bounce or reopen, the cycle loop exits directly to Finalization.
  Without this, a capped-bounce deferral at goal priority (deferred is a
  NOT_DONE status, so `openAtGoal` never reaches zero) leaves the run
  grinding empty cycles into a `StalledSprintError` ABORT; with it, the
  run ends in a clean, evidence-bearing Final Review -- an honest FAIL
  with the gap evidence in front of a human, instead of an ABORTED
  record.

**Not a bounce: the chk-gap materialization rule** (added by walkthrough
6.1b). A gap the IntegTest pass finds in already-closed
`plan`/`develop`/`review`-routed work (the `yes*` chk exercise, 3.1) is
a different shape from a `verify` gap and gets a different mechanism. A
`verify` gap contradicts a claim about a STILL-OPEN issue, so re-routing
that issue is right. A chk gap is a product defect whose attribution is
UNKNOWN at detection time -- it may come from one closed bead, from the
interaction of several, or from pre-existing code the new work merely
exposed -- and the implicated bead's closure was legitimately earned
against its own acceptance criteria at review time. The rule, three
parts:

- **Materialize, never just log.** Every chk gap must exist as a
  goal-visible bug bead under the sprint root -- filed by the integ
  runner per its existing contract, and if the runner's report carries a
  failure with NO corresponding bead (`passed: false` with empty
  `bugsFiled`/`gapsFound`), the ORCHESTRATOR files a fallback bug bead
  from the report's own summary and evidence, the same
  never-lose-a-finding pattern as `persistNewTaskBestEffort` /
  `appendRejectedFindingToParentNotes`. A finding with zero consequence
  is unrepresentable by construction.
- **No reopen of the earned closure.** Deliberately NOT the
  reviewer-reopen path: reopening would assert an attribution the
  evidence usually cannot support, would make the closed count
  non-monotone (re-entangling the high-water stall detector and the
  reopen-thrash counter with post-closure events), and would rewrite an
  honestly-earned closure record. It also matches the current engine,
  where the integ runner files bugs and never reopens tasks.
- **Consequence chain.** The new bug bead, at goal priority when the gap
  is goal-relevant, raises `openAtGoal` -- so the sprint CANNOT exit
  goal-complete past an unaddressed regression. The next cycle's Router
  routes the bug (`plan`: it needs decomposition), the fix flows through
  the full pipeline, and the bug itself closes through the existing
  pending-closure-bugs verification path (2.2). If cycles run out first,
  the open bug plus the recorded `integFailures` land in Final Review's
  evidence and flavor the verdict -- an unfixed chk gap ends as a FAIL a
  human sees, never a silent pass.

### 3.4 Evidence bars, enforced structurally (case 3)

The router stamps every routed issue with its evidence bar (bead metadata,
e.g. `--metadata evidence_bar=verification`), and closure enforcement moves
to the orchestrator, extending the `verifyDoerStreakClosed` philosophy from
"never trust the claim of closure" to "never trust the quality of
closure":

- A `verification`-bar issue may only be closed by the IntegTest phase (or
  the orchestrator acting on its verdict), and the close must carry a
  structured evidence block (commands run, observed output/SHA -- the
  shape apra-fleet-ed4's good closure already had informally). After the
  IntegTest phase, the orchestrator re-reads each claimed closure; a
  closure missing its required evidence is REOPENED by the orchestrator
  with a note naming the violation -- deterministically, in code, so a
  permission-degraded agent that closed-without-evidence is corrected
  rather than silently accepted. This is the structural guarantee the
  brief asks for: the router's stamp makes no-evidence closure literally
  not stick.
- An `implementation`-bar issue keeps today's contract (doer closes,
  reviewer approves, `verifyDoerStreakClosed` checks status) plus the same
  post-hoc note check at Review time.
- A `triage-rationale`-bar issue (route `close`, decision 1) is closed by
  the ORCHESTRATOR itself during Route application, writing the triage
  rationale note atomically with the close and stamping
  `evidence_bar=triage-rationale`. For this route the rationale text IS
  the evidence bar: there is no dispatch producing cited command/output
  evidence, by design. The post-phase closure audit therefore keys on the
  STAMPED bar, not on which phase closed the bead -- it demands cited
  command/output evidence only from `verification`-bar closures -- so a
  rationale-only `close` closure is never wrongly reopened for "missing
  verification evidence". It also cannot exist without its rationale:
  validation (3.1) rejects any `close` route lacking one before the
  orchestrator ever applies it, so the audit invariant holds by
  construction.

Because the stamp lives in bead metadata (not run-local state), it survives
engine restarts and is visible to `bd show`, to the next sprint, and to
humans -- consistent with "the beads DB is the single source of truth."

### 3.5 Concurrency model: routed lockstep, not per-issue pipelines

The brief asks for honesty here. Two candidate targets:

**A. Fully independent per-issue pipelines** -- each issue an async state
machine walking its own phase-set; the engine becomes a scheduler; issue A
runs Develop while issue B runs IntegTest, concurrently.

**B. Routed lockstep (recommended)** -- keep the per-cycle skeleton; every
phase runs once per cycle over its routed subset (possibly empty). Issues
are at genuinely different pipeline stages (B is in IntegTest in the same
cycle A is in Develop), but there is one shared clock.

Recommendation: **B**, and not merely as the pragmatic first step -- A is
actively wrong for this engine today, for reasons that are invariants, not
implementation debt:

- **Serialized writers are load-bearing.** `globalDoerTurn` serializes all
  doer dispatches because the git/dolt sync brackets depend on
  fast-forward-by-construction; concurrent per-issue pipelines would
  reintroduce exactly the concurrent-writer divergence the brackets exist
  to prevent.
- **There is one deployed artifact.** Deploy is per-cycle and shared; the
  integ runner tests A deployment. Per-issue IntegTest concurrent with
  per-issue Develop means verifying against a moving target, and the
  engine has no per-issue environments to isolate that.
- **Every safety net is cycle-clocked.** Round caps, the closed-count
  high-water mark, `reviewedThisCycle`, per-cycle session freshness
  (`roundSessions` never resumes across cycles) -- all assume a shared
  cycle boundary. A would require re-deriving each of these per pipeline,
  multiplying the state a human must reason about during an incident.
- **Cost shape.** A batches one reviewer dispatch per issue instead of per
  round, one integ dispatch per issue instead of per cycle -- strictly
  more LLM spend for coordination value the routes already deliver.

What B gives up: wall-clock overlap between lanes within one cycle. An
intra-cycle overlap (the `verify` lane's IntegTest running while the
`plan` lane is still in Develop) was considered and is PERMANENTLY out of
scope -- by decision, not deferral (decision 3, section 7). The repo
owner's ruling: "testing only makes sense if it is being tested in the
latest product else we may accept regressions." Overlapped verification
would necessarily test a deploy that predates the cycle's dev commits --
exactly the regression-acceptance hazard the ruling forbids -- so all
`verify`-lane work runs inside the normal post-Deploy IntegTest phase,
always against the current cycle's fresh deploy, and no future revision
of this design should reintroduce the overlap without revisiting that
ruling explicitly.

### 3.6 Run-state and dashboard representation

- New `publishState('routing', { cycle, table: [routing records] })`
  emitted whenever the table is created or revised; the dashboard gains a
  routing panel (via `viewer-extensions.mjs`) showing each issue's route,
  rationale, decider, and flip history. This is the "legible, inspectable
  step" made visible: an operator watching the kuh.5 run would have seen
  `kuh.5 -> verify (triage-agent: criteria observed satisfied)` in cycle
  1 instead of three opaque plan rejections.
- The `beads` namespace rows gain `route` and `evidenceBar` fields
  (sourced from bead metadata during the existing `updateDashboard()`
  fetch -- no new query).
- Authoritative routing state lives in bead metadata; run-state remains
  observational, exactly as today. A crashed-and-relaunched sprint's
  Router re-derives the table from beads, so nothing about crash recovery
  changes.

---

## 4. Alternatives Considered

### 4.1 Fully independent per-issue pipelines

Described and rejected in 3.5. Kept on the record as the long-term shape IF
the fleet ever grows per-issue isolated environments, a
concurrent-writer-safe sync layer, AND a deploy story that satisfies the
verification-freshness ruling (3.5: verification only counts against the
latest product); the routing table proposed here is the substrate such a
scheduler would consume, so B does not foreclose A.

### 4.2 Router-as-partitioner: N parallel lockstep sub-pipelines per cycle

A middle design: the Router partitions scope into lanes and the cycle runs
each lane's pipeline in parallel within the cycle (the `plan` lane doing
Plan->Develop->Review while the `verify` lane does IntegTest). Honest
assessment: this is candidate B plus intra-cycle lane concurrency, and it
inherits a diluted version of every candidate-A problem -- shared beads DB
writes from two lanes' orchestrator transitions interleaving between the
same D-push brackets, the stale-deploy hazard for verify, and two
simultaneously-running phase groups in a viewer whose phase model is
linear. Rejected outright, not merely for v1: its entire payoff was
overlapping verify-lane IntegTest with plan-lane Develop, and that
overlap is permanently foreclosed by the verification-freshness decision
(3.5) -- verify must run against the current cycle's deploy, which does
not exist until the plan lane's work has landed and deployed. With the
payoff gone, what remains is pure interleaving risk for zero benefit.

### 4.3 Smarter planner instead of a router

Teach planner/plan-reviewer contracts to recognize no-work-needed issues
and emit "close it" / "skip it" plans. Rejected: it keeps every issue
flowing THROUGH the planner (kuh.5 still costs planner+plan-reviewer
rounds and still sits inside their quality gates -- the very collision that
deadlocked), it leaves routing invisible (buried in plan prose rather than
a table), it cannot express case 2 at all (the planner is never dispatched
for a scope validation already rejected), and it puts the decision in the
most expensive seat: the planner is graded by an adversarial reviewer, so
uncertainty about an issue's true state turns into plan-rejection churn
rather than an explicit `verify` route that IntegTest settles with
evidence.

### 4.4 Status quo plus more special cases

Extend `pendingClosureBugs`-style prompt clauses to features/parents/
tasks. Rejected: this grows the pile of invisible micro-routers (2.4), each
new shape needing its own hardcoded derivation and prompt text, with no
shared evidence-bar enforcement, no revision mechanism, and nothing an
operator can inspect. It also cannot fix case 1: the Plan phase would still
be dispatched over unroutable scope.

---

## 5. Compatibility

- **`SprintPlanRejectedError` / plan caps**: unchanged semantics, now over
  the plan-set only. A rejection can no longer be caused by an issue the
  planner should never have seen. The plan-cap partial-deferral valve
  remains as a second-line defense.
- **`StalledSprintError` / high-water mark**: untouched and still the
  spine (3.3). Verification and `close`-route closures count as progress
  -- correctly, since both are audited, evidence-stamped closures (3.4);
  a routing oscillation that closes nothing sets no new high-water mark
  and trips the unchanged net.
- **`isTypedAbortError` / `finalizeAbort`**: one addition -- a
  `TriageContractViolationError` (triage returns invalid routes twice in a
  row), modeled on `ReviewerContractViolationError` and added to the typed
  abort set. All other error routing is untouched; the Route phase's
  dispatch failures degrade to the conservative structural-table-plus-
  `plan` fallback rather than aborting (3.1), so the new phase adds no
  new abort paths in the common case.
- **Round-session registry, sync brackets, budget, dispatch safety
  guard**: the triage dispatch is one more standard `withGitSync`-bracketed
  read-side dispatch (pushCode false; pushBeads true only for the
  orchestrator's route-stamp writes, which follow the existing
  orchestrator-mutation D-push pattern at ~line 7435).
- **Run-state JSON**: additive namespace only (3.6); no change to the
  `running/<runId>.json` -> `old_runs/` lifecycle.
- **Vendored agent contracts (apra-pm)**: `triage.md` + `triageDecision`
  schema (routes, rationales, and the required `override` records of
  decision 4) are new; `integ-test-runner.md`/`integReport` gain `gapsFound`
  and the verify-closure evidence contract; `plan-reviewer.md` needs one
  scoping sentence (gates bind over the provided plan-set). Per the repo
  convention, `packages/apra-fleet-client` is unaffected unless fleet MCP
  tool schemas change -- none do; this is all workflow-side. The
  contracts.mjs fallback schema literals must be updated in the same
  change as the vendored schemas.
- **Zero-commit runs (pure verify/close) -- SETTLED (decision 5)**: a run
  whose every issue routed `verify`/`close` may produce zero commits
  beyond base, and per the repo owner that is a fully legitimate outcome
  needing no PR: "it can close beads, that is also useful evidence and
  confidence in product." The closed beads, with their stamped evidence,
  ARE the run's deliverable artifact. Mechanically: the hosted-remote
  path gains the same zero-commit check `finalizeAbort` already performs
  and, when there is nothing to publish, closes the target issues
  directly on a PASS verdict -- mirroring the existing non-hosted-remote
  fallback -- instead of attempting an empty-diff `gh pr create`. No
  substitute reviewable artifact is required.
- **Goal priority (settled, no new mechanism)**: routing introduces zero
  goal-priority special-casing. The existing `--goal` machinery
  (`goalPriorityMax`, the `priority-max` filters in Cycle Evaluation and
  the reopen allowlist) already governs which beads are in play for a
  cycle, and routed issues -- `verify` and `close` included -- pass
  through it exactly like any other bead. Goals remain what they are
  today: the spend/quality dial ("keep running cycles till the sprint
  scope has achieved either 0 P1, or 0 P1+P2, or 0 P1+P2+P3").
- **Determinism/testing**: the structural classifier is a pure exported
  function (unit-testable like `decideEnsureBranchAction`/
  `selectStreaks`); the triage dispatch is mockable in the bd-replay
  harness; the routing table sort must be keyed (route, title, id) so
  golden transcripts stay stable.

## 6. Design Walkthroughs (adversarial, in trace notation)

These walkthroughs stress-test the mechanics of sections 3.1-3.4 against
concrete scenarios. Each is a compact trace, then (for the error
scenarios) a short paragraph that attacks the design and either concedes
a real gap or names the specific mechanism that refutes the attack.
Three of the scenarios found genuine gaps, each fixed in the body of the
doc: inv-4 (3.1, from 6.2), the Route-empty exit (3.3, from 6.3), and
the chk-gap materialization rule (3.2/3.3, from 6.1b); 6.5 additionally
hardened close-reuse via inv-5. Each fix is marked "(added by
walkthrough 6.x)" at its site.

### 6.0 Trace notation (legend)

One line per phase, one trace block per scenario. Route names appear
verbatim (`plan`, `develop`, `review`, `verify`, `close`, `defer`,
`hold`).

```
Cn / Rk         cycle n / round k within a phase
x->r(s:RULE)    issue x routed r by structural rule RULE
x->r(t)         routed r by the triage agent (judgment case)
x->r(t!RULE)    triage OVERRIDE of structural rule RULE (override record attached)
REJ[inv-N]      route rejected by orchestrator validation, invariant N (3.1)
r=>r'(cause)    re-route: bounce or revision, with cause
--              phase skipped (routed set empty)
+[impl]         closed at the implementation bar (doer close + reviewer APPR)
+[verif:e]      closed at the verification bar, citing evidence e
+[rat:"..."]    closed at the triage-rationale bar (close route, orchestrator-applied)
chk{..}         exercised by IntegTest for regression/gap detection (the
                `yes*` cell in 3.1's table: no closure gate -- closures
                already earned at the impl bar). A chk GAP must
                materialize as a new bug bead (3.3), traced as bug(b:e)
bug(b:e)        bug bead b filed (or orchestrator-fallback-filed) carrying evidence e
reopen(x)       orchestrator reopened x (reviewer verdict / closure audit / human)
APPR / CN       reviewer APPROVED / CHANGES_NEEDED
Eval line       goal-open=<n> closed=<c> hw=<high-water> stale=<k>
```

### 6.1 Happy path: mixed scope to a clean PASS

Scope (epic `fyc`): `n1`, `n2` open unplanned leaf tasks; `glv` a parent
with all children closed, never verified; `k5` an open leaf task whose
acceptance criteria are already satisfied in the codebase (the kuh.5
shape); `dup` an open leaf duplicating already-shipped work.

```
C1 Route : n1->plan(s:unplanned-leaf) | n2->plan(s:unplanned-leaf)
           glv->verify(s:all-children-closed)
           k5->verify(t) | dup->close(t)
C1 Apply : dup +[rat:"duplicate of x9; shipped in v0.3.2"] ; stamps D-pushed
C1 Plan  : {n1,n2} R1 planner DAG -> plan-review APPR
C1 Dev   : R1 streaks [n1][n2] -> n1 +[impl] , n2 +[impl]
C1 Rev   : R1 APPR (reopen: none)
C1 Deploy: ok
C1 IntegT: {glv,k5} -> glv +[verif:e2e suite log] , k5 +[verif:cmd output @<sha>]
           chk{n1,n2}: playbook pass over the deploy carrying their commits -> no gaps
C1 Eval  : goal-open=0 closed=5 hw=5 stale=0 ; reviewed=yes APPR -> exit loop
Final    : Final Review PASS -> Regression (informational) -> Harvest
           -> Publish PR (commits > 0, PR raised)
```

Contrast with today's engine on the identical scope: `k5` deadlocks the
Plan phase (case 1), `glv` alone would abort pre-sprint as "Nothing to
do" (case 2), and `dup` burns a doer dispatch to hear a refusal. Here
every issue reaches exactly the phases it needs, and all five closures
carry stamped, bar-appropriate evidence. The `chk{n1,n2}: no gaps` line
is the happy path of a check with a REAL failure consequence -- 6.1b
walks what happens when it finds something.

### 6.1b chk{} finds a real regression -- GAP FOUND, fixed by the materialization rule

Variation on 6.1: the playbook pass discovers that `n1`'s change broke
an existing product surface -- AFTER `n1` legitimately closed at the
implementation + review bar.

```
C1 IntegT: {glv,k5} -> +[verif:..] as in 6.1
           chk{n1,n2}: GAP g1 (repro cmd + output, implicates n1's surface)
           bug(b1:g1) filed P1 under fyc, description links n1 ; passed:false
           n1 STAYS +[impl] -- earned closure is not reopened (3.3)
           [if the runner had reported the failure bead-less: orchestrator
            files bug(b1:g1) itself from the report -- fallback rule]
C1 Eval  : goal-open=1 (b1) closed=5 hw=5 stale=0 -> continue (no exit at goal)
C2 Route : b1->plan(s:unplanned-leaf) ; all else closed
C2 Plan  : {b1} R1 -> decomposed to b1.t1 ; APPR
C2 Dev/Rev: b1.t1 +[impl] ; APPR
C2 Deploy: ok
C2 IntegT: b1 pending-closure-bug check -> g1 no longer reproduces
           -> b1 +[verif: g1 repro cmd now passes] ; chk{b1.t1}: no gaps
C2 Eval  : goal-open=0 closed=8 hw=8 stale=0 ; reviewed=yes APPR -> exit
Final    : Final Review weighs integFailures[C1:g1] AGAINST b1's evidenced
           closure -> PASS (gap found, fixed, and re-verified in-run) ; PR
```

Attack: as first drafted, `chk{}` was pure narration -- a found gap had
NO specified consequence, so "no gaps" in a trace read as "verified"
while a real finding would have evaporated into a log line and a
`passed:false` that only Final Review might notice cycles later. A
check with zero consequence is worse than no check. Conceded as the
third genuine gap; fixed by the chk-gap materialization rule (3.3).
Why materialize-as-bug rather than reopen `n1` (the plausible
alternative, mirroring `reopenIds`): (a) attribution -- at detection
time the gap is a product observation, not a proof that n1's
implementation is the cause; reopening asserts what the evidence cannot
support, and a bug bead carries the observation without the claim; (b)
accounting -- reopening a closed bead post-closure makes the closed
count non-monotone, entangling the high-water stall detector and
reopen-thrash counter with events outside the develop/review loop they
were designed for, whereas a new bead keeps progress monotone AND blocks
goal-exit through `openAtGoal`; (c) precedent -- today's integ runner
files bugs and never reopens tasks, so this extends the engine's
existing contract instead of inventing a second reopen authority.
Residual, stated honestly: if the runner mis-reports `passed: true`
while describing a gap only in prose, no mechanism fires -- the
materialization rule keys on the structured `passed`/`gapsFound`/
`bugsFiled` fields, and a schema-level lie is caught only by Final
Review reading the summary. That is the same trust boundary every other
structured verdict in the engine already lives with.

### 6.2 Bad triage override vs the invariants -- GAP FOUND, fixed by inv-4

Variation on 6.1: `glv` has one still-open child `glv.3`; and `k5` has an
unmet `blocks` dependency on `n1` (its criteria depend on n1's behavior).

```
C1 Route : glv.3->plan(s) | glv->(unroutable: open children)
           triage: glv->verify(t!all-children-closed) -> REJ[inv-1]
           triage: k5->verify(t)
             pre-fix : ACCEPTED (!) -- no invariant looked at blocks edges
             post-fix: REJ[inv-4: k5 not bd-ready, blocked by n1] -> k5->hold
```

Attack: the invariants as first drafted checked only DESCENDANTS
(inv-1), so a dependency-blocked leaf had no open children and sailed
through -- triage could route it `verify`, and IntegTest would then
close it against evidence of TODAY'S behavior while its blocker (`n1`)
was still being implemented in the same run and could invalidate that
evidence. That is a premature closure with real-looking citations: worse
than no evidence, because the audit (3.4) would bless it. Conceded as a
genuine hole; fixed by inv-4, which keys closure routes (`verify`,
`close`) on bd-readiness -- the same `--ready` computation doer seeding
already trusts, which also inherits bd's cycle handling for free.
Residual caveat, stated honestly: readiness is read from a snapshot, so
the Route phase must sit behind the same D-pull freshness discipline as
Cycle Evaluation (it does: the phase() wrapper invalidates the beads
cache, and Route runs after the cycle-top pull).

### 6.3 Bounce, bounce cap, and mixed progress -- GAP FOUND, fixed by Route-empty exit

Variation on 6.1: `ftr` is a `verify`-routed feature that is genuinely
broken (the "believed done" belief is wrong), in a P1 scope with other
work that succeeds.

```
C1 IntegT: ftr gap e1 -> gapsFound ; bounce ftr: verify=>plan (flip 1)
           {glv,k5} close as in 6.1 ; chk{n1,n2}: no gaps
C1 Eval  : goal-open=1 closed=4 hw=4 stale=0 -> continue
C2 Route : ftr->plan(s:bounce-history)
C2 Plan  : {ftr} R1 -> decomposed to ftr.t1 ; APPR
C2 Dev/Rev: ftr.t1 +[impl] ; APPR
C2 IntegT: ftr feature-closure check (chk{ftr.t1} exercised) -> gap e2
           flip 2 REFUSED (bounce cap) -> ftr defer + note(e2)
C2 Eval  : goal-open=1 (deferred is NOT_DONE) closed=5 hw=5 stale=0 -> continue
C3 Route : ftr->defer (sticky) ; routable set EMPTY
  pre-fix : C3 and C4 run with every phase `--` ; closed static -> stale=2
            -> StalledSprintError -> ABORTED terminal record + finalizeAbort PR
  post-fix: Route-empty exit -> straight to Finalization
Final    : Final Review sees integFailures[e1,e2] + the deferral note
           -> FAIL with findings persisted as beads ; PR raised [FAIL]
```

Attack 1 -- mixed progress masking: C2 both closed `ftr.t1` AND hit the
bounce cap. Does the closure's high-water bump (stale=0) hide the capped
failure from the stall detector? Yes -- and that is CORRECT: the stall
net exists to catch no-progress loops, and C2 made real progress. The
capped failure is not the stall net's job; it is carried by
`integFailures` + the deferral note into Final Review, which is the
evidence-based gate. Refuted. Attack 2 -- the tail: after the deferral,
`deferred` still counts in `openAtGoal` (NOT_DONE_STATUSES), so goal
completion is permanently unreachable, every subsequent Route yields an
empty table, and the run grinds two empty cycles into a
`StalledSprintError` -- ending a run that produced honest evidence with
an ABORTED verdict instead of a FAIL a human can act on. Conceded as a
genuine gap in the original draft; fixed by the Route-empty exit (3.3),
which turns "nothing left I am allowed to work on" into an immediate,
clean Finalization. Note the guard on that exit ("no bounce/reopen in
the previous cycle") keeps it from firing mid-oscillation.

### 6.4 Triage dispatch dies (the observed 60-minute-timeout shape) -- refuted, with an honest cost

Variation on 6.1: the triage dispatch times out twice (watchdog +
resume, like the real MCP-timeout incident); conservative fallback
engages.

```
C1 Route : structural: n1->plan n2->plan glv->verify(s) ; undecided: {k5,dup}
           triage: TIMEOUT ; resume: TIMEOUT -> fallback
           fallback: structural table STANDS ; k5->plan(fb) dup->plan(fb)
C1 Plan  : {n1,n2,k5,dup} -- planner must now plan two no-work issues
```

Attack: "degrade to `plan` is always safe" is too convenient -- for k5
and dup it recreates case study 1's exact failure mode (a planner forced
to invent work), so the fallback can cost up to 3 plan rounds and, if
the plan-reviewer's findings do not name the specific beads (in the live
kuh.5 incident they did not, reliably), a whole-plan
`SprintPlanRejectedError`. Response, in two parts. Refuted as to SAFETY:
the fallback never closes anything without evidence, never skips a
phase an issue needed, and never discards banked evidence -- route
stamps persist in bead metadata, so any issue triaged in an EARLIER
cycle or run keeps its `verify`/`close` route through the structural
layer's prior-route fact; only never-triaged judgment cases degrade.
Conceded as to COST: for first-contact judgment cases during a triage
outage, the engine regresses to exactly today's behavior, worst case
included. This is accepted as a bounded regression-to-status-quo (the
degraded state is the current production engine, not something worse),
not papered over as harmless. No design change; no new open question.

### 6.5 A `close` rationale that turns out to be wrong -- partially conceded, mitigated by inv-5

Variation on 6.1: `dup`'s rationale ("duplicate of x9") is wrong -- x9
covered only half the scope. A human reopens `dup` weeks later; a later
sprint picks it up.

```
S1 C1 Route: dup->close(t) ; Apply: dup +[rat:"duplicate of x9"]
   ...weeks later: human reopen(dup) "x9 covered half of this"
S2 C1 Route: dup open ; stamps: route-history=[close@S1], bar=triage-rationale
           triage: dup->close(t) -> REJ[inv-5: close already used on dup]
           -> dup->develop(t) (or verify; any evidence-producing route)
```

Attack: is a wrong `close` any different from today's status quo of a
human or permission-degraded agent closing something wrongly -- or did
decision 1 just relocate the same risk? Honest answer: AT THE MOMENT OF
CLOSURE, no different -- a wrong rationale closes a bead wrongly, and
nothing in this design prevents that; decision 1 explicitly accepted it.
What IS structurally different is everything after that moment: (a)
provenance -- the closure carries `decidedBy`, the rationale text, and
the `triage-rationale` bar stamp, so rationale-only closures are
queryable in bulk and can never masquerade as evidence-backed ones,
which was case study 3's precise complaint; (b) non-recurrence -- inv-5
forbids a second `close` on the same issue, so the identical wrong
rationale cannot re-close it on the next pass; it must escalate to an
evidence-producing route. So: first-closure risk unchanged (conceded),
blast radius and repeatability genuinely reduced (refuted that nothing
changed).

---

## 7. Design Decisions (resolved with the repo owner)

The first review round posed six open questions; the repo owner answered
all six. They are recorded here as decisions, each with a pointer to
where it is incorporated in the body of the design.

1. **Administrative closure: allowed.** "Administrative closure is
   acceptable." The vocabulary carries a real `close` route: the
   orchestrator closes the bead directly on triage rationale, with no
   verification dispatch. It composes with the evidence-bar mechanism via
   its own distinct `triage-rationale` bar -- the rationale text IS the
   evidence for this route, and the closure audit keys on the stamped bar
   so it never wrongly reopens a rationale-only closure. (3.1, 3.2, 3.4;
   sequencing step 3.)
2. **Fixed vocabulary, entry routes named after phases.** Closed
   vocabulary confirmed; "finish" judged confusing and replaced by naming
   each pipeline-entry route after the earliest phase it enters: `plan`,
   `develop`, `review`. The renaming surfaced `review` as a genuine entry
   point (implemented on the sprint branch, never reviewer-approved --
   the interrupted-prior-run shape), argued for and adopted in 3.1.
   `verify`/`close`/`defer`/`hold` are dispositions, not entry points,
   and keep their names.
3. **Verification freshness is absolute.** "Testing only makes sense if
   it is being tested in the latest product else we may accept
   regressions." All `verify`-lane work runs against the current cycle's
   fresh deploy, inside the normal post-Deploy IntegTest phase. This
   permanently forecloses the intra-cycle lane-overlap optimization --
   removed from consideration in 3.5 and 4.2, not deferred.
4. **Triage may override structural decisions.** "Triager should be
   allowed to switch route, that is a real value for LLM." The triage
   agent sees the full structural proposal table and may override it --
   subject to a stronger, auditable rationale bar (the `override` object
   naming the disputed rule and the evidence against it) and to the same
   hard invariants as fresh decisions, which no override can breach.
   (3.1; contracts note in section 5.)
5. **No PR required for zero-commit runs.** "It is OK if a sprint does
   not create a PR, it can close beads, that is also useful evidence and
   confidence in product." Direct target-issue closure with stamped
   evidence is the deliverable for pure verify/close runs; no substitute
   artifact. (Section 5, "Zero-commit runs".)
6. **Goal priority: nothing new to decide.** Goals stay the existing
   spend/quality dial; routed issues pass through the existing `--goal`
   priority filtering exactly like any other bead, and routing adds no
   goal-priority special-casing of any kind. (Section 5, "Goal
   priority".)

## 8. Implementation Sequencing (incremental, individually shippable)

Each step is independently valuable and lands with its own tests; none
requires the later steps.

1. **Evidence-bar enforcement (fixes case 3 standalone).** Orchestrator
   post-phase closure audit: closures claimed by integ/doer dispatches are
   re-read and reopened if the required evidence block is absent. No
   routing yet -- the bar is derived from today's implicit rules (integ
   closures = verification bar). Small, self-contained, immediately stops
   bare-"Closed" closures.
2. **Routable scope + structural routing (fixes cases 2 and 4 minimally,
   and the structural half of case 1).** Admit all-children-closed
   grouping nodes into scope; add the deterministic structural classifier
   and the routing table (no LLM); scope Plan/Develop by route; empty-set
   phase skips; route verify-set into the existing IntegTest dispatch
   alongside `pendingClosureBugs` (which this step absorbs). Pre-sprint
   validation switches to "routable set non-empty". After this step, a
   bulk-verify run of all-closed parents works end to end.
3. **Triage agent (completes case 1).** New vendored role + schema +
   validation + conservative-fallback, including structural-override
   support (decision 4), the `close` route with orchestrator-applied
   administrative closure and its `triage-rationale` bar (decision 1),
   and the `review` entry route (decision 2); routing table, rationales,
   and override records published to run-state/dashboard; route stamps in
   bead metadata.
4. **IntegTest bounce + chk-gap materialization.** `gapsFound` in
   `integReport`, orchestrator-applied `verify -> plan` re-route, bounce
   cap, route-flip accounting in stall diagnostics,
   `TriageContractViolationError`; plus the chk-gap materialization
   rule's orchestrator side (a reported failure arriving bead-less gets a
   fallback bug bead filed from the report evidence, walkthrough 6.1b).

(There is no step 5: the intra-cycle lane-overlap optimization that
previously occupied it is permanently out of scope per decision 3.)

Steps 1-2 are pure engine + prompt-derivation changes; step 3 is the first
apra-pm contract addition; step 4 touches one existing contract. At every
intermediate point the engine still runs today's sprints unchanged: an
all-`plan` routing table reproduces current behavior exactly, which is
also the regression assertion for step 2's golden transcripts.
