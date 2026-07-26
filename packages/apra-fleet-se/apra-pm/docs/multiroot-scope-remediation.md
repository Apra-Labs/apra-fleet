# Multi-root scope remediation (auto-sprint plan/exit gates)

Status: complete. Merged to apra-pm `main` as `5663c6f`; e2e `s10` re-run green
(run `30042586018`). apra-pm has since moved into the apra-fleet monorepo at
`packages/apra-fleet-se/apra-pm/`, which is now the canonical location.
Branch: `fix/token-maths`
Scope (as authored): the apra-pm sources only.

## Why this exists

The e2e suite `s10` (auto-sprint on the `fleet-e2e-toy` repo) went red on run
`30034160212` (`fix/token-maths`) while the prior run `29613401977`
(`fix/e2e-process-discipline-gate`) was green. The sprint aborted in the PLAN phase,
before any develop work, with `Reason: plan not approved`.

### Root cause (confirmed against the run log)

s10 passes three sprint goals as SEPARATE roots (`issues: [gh-toy-mi2, gh-toy-7rp,
gh-toy-4ef]`, no common parent). The toy seed injects CROSS-ROOT `blocks` edges
(`gh-toy-4ef.1/.2` and `gh-toy-7rp.1` are blocked by `gh-toy-mi2.1`, a child of a
DIFFERENT goal).

Across 3 plan-review rounds the planner was whipsawed between two rules:
- Criterion 11 (lane cohesion) forbids `blocks` edges between open tasks in different
  lanes -> forced the planner to co-lane the cross-root tasks into `mi2-crud`.
- Criterion 9 (ready-work) is run PER ROOT (`bd list --parent gh-toy-4ef --ready`) and
  reads an empty per-root ready-list as "a cycle" -> co-laning left `gh-toy-4ef` with
  zero ready work of its own -> HARD FAILURE -> 3-round cap hit -> abort.

The planner's DAG was actually runnable: acyclic, honored the seed ordering, and the
UNION of ready work across roots was non-empty (`mi2.1` was startable). Criterion 9's
premise -- "empty `--ready` while open tasks remain => cycle" -- is only valid at a scope
CLOSED under `blocks` (the union of all roots). Applied per-root it produces a FALSE
deadlock whenever one root is legitimately gated by another. The prior run passed only
because its branch predated the lane-cohesion commit, so the planner never had to
entangle the roots.

### The general defect

The per-root-vs-union scope split recurs across the orchestration. The DEVELOP phase
already reasons over the UNION of roots (correct, self-healing). The PLAN phase and the
EXIT checks reason per-root / roots-only (wrong). The fix is to make every gate use the
scope the develop phase already uses, and to wire the reviewer inputs its own runbook
declares required.

## Unifying principle for all fixes

"The sprint's startable work" = the UNION of ready leaf work across ALL roots. A single
root having no ready work of its own is normal when it is gated by another root. A true
deadlock is ONLY: union-of-ready empty while open work remains, or a self-cycle (a
`blocks` edge to a bead's own `--parent` ancestor/descendant).

## Findings and dispositions

| ID | Summary | File(s) | Disposition |
|----|---------|---------|-------------|
| F1 | Planner dispatch prompt hard-codes per-root "empty ready => cycle" + wrong remedy | auto-sprint.js:2194-2197 | FIX |
| C9 | plan-reviewer Criterion 9 per-root ready-work false deadlock | plan-reviewer.md:73-87 | FIX |
| S4 | planner Step 4 self-check per-root/singular ready invariant | planner.md:145-160 | FIX |
| F2 | plan-reviewer dispatch never passes prior-round verdicts (No-goalpost rule inert) | auto-sprint.js:2167-2169, 2231-2252 | FIX |
| F3 | reviewer dispatch orders bare `bd ready`, contradicting the runbook | auto-sprint.js:2239 | FIX |
| F5 | exit-check + no-progress are roots-only -> goalMet unreachable, cycle-2 false abort | auto-sprint.js:651-663,1643-1649,2781-2825; test | FIX |
| F6 | planDone bypasses plan review -> taskAssignments/sprintQuote null, gates skipped | auto-sprint.js:743-760,2151-2159,2254-2262 | FIX |
| F7 | C9 `--ready` lacks `--type=task`; workflow uses `--type=task` -> approve-then-deadlock | plan-reviewer.md:76 | FIX (folded into C9) |
| F8 | plan-reviewer Step 1 unscoped `bd list --status=open` vs "these goals ONLY" | plan-reviewer.md:57-59 | FIX |
| F4 | plan loop aborts on 3rd rejection with no proceed path | auto-sprint.js:2153,2211-2215 | NO CHANGE (root cause removed by F1/C9/S4/F2; abort is correct for a truly unapprovable plan) |
| F9 | leaf/dispatch filter relies on dotted-ID `<parent>.<n>` convention | auto-sprint.js:700-703,1635 | NO CHANGE (verified-safe invariant, documented at 1622-1625) |

## Fix specifications

### C9 -- plan-reviewer.md:73-87 (replaces the whole Criterion 9 block; folds in F7)

Replace with union-scoped semantics: run `bd list --parent <scope> --ready --type=task
--json` per root and reason over the COMBINED result; a single empty-ready root gated by
another root is legitimate; hard-fail only on empty-union-while-open OR a self-cycle.
(Exact replacement text is applied in the edit; keep the epic-status paragraph.)

### S4 -- planner.md Step 4 (item 1, ~145-160)

Same union correction to the planner's own acyclicity self-check: the ready invariant is
on the union across roots, not each root; a root gated by a sibling root is not a cycle.

### F1 -- auto-sprint.js:2194-2197 (planner dispatch VERIFY block)

Rewrite so the planner verifies the UNION across goals is non-empty; a goal with no ready
work of its own is fine when gated by another goal; only remove a `blocks` edge when it
points at the bead's own `--parent` ancestor/descendant (a real self-cycle). Add
`--type=task` to the command.

### F3 -- auto-sprint.js:2239 (reviewer dispatch)

Replace `Run: bd ready -- this is your FIRST correctness check.` with the scoped per-root
`bd list --parent <root> --ready --type=task --json` union check from Criterion 9; state
that bare `bd ready` is project-wide and must NOT be used.

### F2 -- auto-sprint.js plan loop (~2159-2252)

Accumulate prior-round verdicts+notes for the current cycle into an array; inject them
into the plan-reviewer dispatch prompt under a "Prior-round verdicts for this cycle"
heading (the binding input plan-reviewer.md Inputs/No-goalpost-moving rule requires).
Currently `planFeedback` reaches only the planner (2167-2169); the reviewer must also see
the prior verdicts so it does not move goalposts round to round.

### F5 -- auto-sprint.js exit signal (651-663, 1643-1649, 2781-2825) + test

Change the exit/no-progress signal from ROOTS-ONLY to SUBTREE LEAF-SCOPED:
- Count open `type=task` under the subtree at priority <= threshold, EXCLUDING roots.
- Also count open `type=feature` under the subtree ONLY when `integTestEnabled` (only
  then does anything close features in-loop; otherwise counting them re-breaks
  reachability).
- Add `issue_type` (`t`) to the exit-check open extract (2781) and the `countBeadsBlockers`
  extract (1643). Implement the leaf-aware counter so `parseBlockers` is not left as dead
  code (generalize it or replace both call sites and migrate its tests). Roots still close
  at Harvest (2969-2972); `goalMet` now becomes reachable when the last leaf closes, and
  `prevOpenIds`/`currentOpenIds` shrink cycle-to-cycle so the no-progress guard is a real
  deadlock detector again.
- Rewrite `test/exit-check-roots-scope.test.mjs` to the inverted (leaf/subtree) semantics:
  roots excluded; open non-root task counts as a blocker; feature counted only when
  includeFeatures=true. Keep `shell-dispatch.test.mjs` / `merged-parser-index.test.mjs`
  green.
- Fix the stale header comment at 88-89 to match (it already says "subtree").

### F6 -- auto-sprint.js planDone wiring (2151-2159)

Stop seeding `planApproved` from `planDone`. Use `cycleState.planDone` only to skip the
PLANNER dispatch on round 0 (`pi === 0 && planDone`), while STILL running the
plan-reviewer dispatch so the run routes through `if (approved(planReview))` and
populates `taskAssignments`/`sprintQuote` and writes the plan snapshot. A CHANGES_NEEDED
verdict on a planDone cycle must still re-enable the planner on later rounds. Leave
`parseCycleState` (743-760) and its pure-fn tests unchanged.

## Execution plan (checkout-safe partition)

Fixes land in one shared apra-pm checkout, so agents are partitioned by FILE (no overlap):
- auto-sprint.js (F1, F2, F3, F5, F6) + `test/exit-check-roots-scope.test.mjs`: owned by
  ONE worker (this is the risky, cross-cutting file; do F6 wiring, then F5 exit signal).
- plan-reviewer.md (C9 union rewrite + F7 type filter + F8 Step-1 scope): separate worker.
- planner.md (S4 union rewrite): separate worker.

## Validation

1. `npm test` (`node --test test/**/*.test.mjs`) -> all green, including the rewritten
   `exit-check-roots-scope` and the untouched `shell-dispatch` / `merged-parser-index` /
   `sprint-cost` suites.
2. Manual re-read of the plan/develop/exit call sequence for scope consistency.
3. Final gate (on request): re-run e2e `s10` via workflow_dispatch and confirm green.

## Out of scope at authoring time (since done)

- Propagating the fixed apra-pm into apra-fleet's `packages/apra-fleet-se/apra-pm/`.
  Done as a separate follow-up; that path is now the canonical home for apra-pm.
