Scope reviewed: apra-fleet-iri subtree only (sprint goal = single task "Merge origin/main into feature branch and resolve conflicts", decomposed into 4 features: .1 merge/submodule-retirement, .2 KB priming port, .3 KB Step0 port, .4 path repair + build/test). 13 leaf tasks total (.1.1-.1.4, .2.1-.2.4, .3.1-.3.3, .4.1-.4.2).

PASSING CRITERIA (1-10):
1. Coverage: the single sprint goal is fully decomposed -- merge (.1), KB workflow port (.2), KB agent-doc port (.3), path repair+verification (.4). No gaps.
2. Test tasks: every feature has >=1 [test] task (.1.4, .2.4, .3.3, .4.2). Pass.
3. Acceptance criteria: every one of the 13 leaf tasks has concrete, verifiable acceptance criteria (grep counts, file existence checks, exit codes). Pass.
4. Task size: mostly reasonable (1-3 files). Two tasks are structurally large by nature rather than by poor decomposition: apra-fleet-iri.1.2 (git merge touching ~984 files vs merge-base) and apra-fleet-iri.1.1 (submodule materialize + 5-file snapshot copy, with non-trivial recovery-path design). These are inherent to "resolve one atomic merge" and can't reasonably be split further without breaking atomicity -- flagging for visibility, not blocking.
5. Dependency wiring: all [test] tasks are downstream of their lane's implementation tasks (.1.4 after .1.3, .2.4 after .2.3, .3.3 after .3.2, .4.2 after .2.4/.4.1/.3.3). No test task runs in parallel with its implementation. Pass.
6. No scope creep: every task traces directly to the merge/KB-port/path-repair goal. Pass.
7. No duplicate work: no overlapping tasks found. Pass.
8. Feasibility: ordering is sound -- snapshot (.1.1) precedes merge (.1.2) precedes submodule cleanup (.1.3) precedes verification (.1.4) precedes all three downstream ports, which converge at the final build/test task (.4.2). No task assumes unbuilt state. Pass.
9. Ready-work check: `bd list --parent apra-fleet-iri --ready --json` is non-empty (returns apra-fleet-iri.1, .2, .3, .4, and leaf .1.1) -- no cycle. `bd blocked --parent apra-fleet-iri` confirms a clean linear/converging chain with no deadlock. Pass.
10. Model metadata: every one of the 13 leaf tasks has a `model` key set via beads metadata (verified via `bd show`) -- standard/premium/cheap all present, no fallback needed. Pass.

FAILING CRITERION (11 -- Lane cohesion):
Streak/streakOrder metadata is present on all 13 leaf tasks (four lanes: merge={.1.1..1.4}, kbwf={.2.1..2.4}, kbagents={.3.1..3.3}, paths={.4.1,.4.2}), and each lane is internally cohesive (same file/component per lane; the kbwf lane even explicitly documents its own mutex on auto-sprint.js and correctly keeps all three mutators in one lane). However, ordering ACROSS these four lanes is wired with raw `blocks` edges instead of lane-level sequencing, which is an explicit criterion-11 violation ("no blocks edge exists between an open task in one lane and an open task in a different lane"). Confirmed via `bd blocked --parent apra-fleet-iri`:
  - apra-fleet-iri.1.4 (streak=merge) blocks apra-fleet-iri.2.1 (streak=kbwf)
  - apra-fleet-iri.1.4 (streak=merge) blocks apra-fleet-iri.3.1 (streak=kbagents)
  - apra-fleet-iri.1.4 (streak=merge) blocks apra-fleet-iri.4.1 (streak=paths)
  - apra-fleet-iri.2.4 (streak=kbwf) blocks apra-fleet-iri.4.2 (streak=paths)
  - apra-fleet-iri.3.3 (streak=kbagents) blocks apra-fleet-iri.4.2 (streak=paths)
Fix: either (a) fold merge+kbwf+kbagents+paths into a single streak with one continuous streakOrder (the chain is fully sequential end-to-end -- merge must close before any port work starts, and the final test needs both ports closed), or (b) drop these 5 cross-streak `blocks` edges entirely and let the dispatch/orchestrator layer gate a downstream lane's readiness on the upstream lane's completion (e.g. checking `bd epic status`-equivalent per lane) rather than encoding it as a raw bd dependency edge between two tasks that live in different streaks. Note if option (a) is chosen: recompute the effort formula for the merged lane -- with current buckets/models (iri.1.1=L, iri.1.2=L@premium, iri.1.3=M, iri.1.4=S) the "merge" lane alone is already close to/at the 200 effort ceiling (approx (4+4+2+1)x20=220, using premium as the lane's max model weight from iri.1.2), so folding three more lanes underneath it without re-splitting would likely blow through the threshold and require a deliberate blocks-edge-boundary split per planner.md's splitting math, taking care not to separate the auto-sprint.js mutex trio (iri.2.1/.2.2/.2.3) across that split.

No other criteria failures found. Once criterion 11 is fixed (lane-crossing edges removed/restructured), this plan should be approvable -- the task content, acceptance criteria, and dependency ordering within each lane are solid.
