# Sprint Analysis: feat/backlog-role-rename

Scope issue id(s): apra-fleet-7ova.
Base branch: main.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [11].
High-water-mark closed count this sprint: 13.
Final closed count: 11.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Diff reviewed: origin/main...feat/backlog-role-rename (67 files). Local main is stale; origin/main is the true merge-base.

CODE: meets the epic acceptance.
- One alias module, fleet-sprint/backlog-role.mjs. resolveBacklogRoleAlias folds the deprecated orchestrator key into backlog. Both keys with different values throws.
- CLI: resolveRoleMapWithWarnings prints the warning and forwards roleMapWarnings to the runner.
- Runner: validateArgs re-resolves the map (covers callers that skip the CLI) and logs '[role-map] WARNING: ...' in the run log.
- Supervisor POST /api/sprints: conflicting keys give 400 on field roleMap before any child spawns. The response has a warnings[] array. The original map, alias intact, goes to the child so its run log also warns. A string '@file' roleMap is now a 400 over HTTP.
- Tests cover all of these: backlog-role-alias, runner-arg-contract, supervisor-api.
- Tool descriptions and client JSDoc were updated in the same change.

GREP CHECK (for the PR): test/backlog-role-no-orchestrator-identifiers.test.mjs scans fleet-sprint/, bin/ and src/ (*.js/*.mjs; docs/ excluded). Only backlog-role.mjs is allowlisted. It flags: compound identifiers containing orchestrator, roleMap.orchestrator, roleMap['orchestrator'], 'orchestrator member', and the orchestrator '<name>' label. Engine-sense uses (orchestrator-side, 'the orchestrator applies') are allowed. A repo-wide grep finds no stale identifiers such as getOrchestratorMember.

TAG CLAUSE: no code reads member tags, on main or on this branch. The orchestrator tag alias is therefore documentation only (supervisor-setup-guide says so). No warning can come from it, as 7ova.2's scope note states.

WHY FAIL: 7ova.2's acceptance names both architecture.md files and cli-reference.md, and apra-pm skills. These still use the role-sense 'orchestrator member':
- packages/apra-fleet-se/docs/architecture.md:197, :242, :465 ('orchestrator/doer/reviewer pools')
- docs/architecture.md:183 (same pools wording)
- packages/apra-fleet-se/docs/cli-reference.md:60 (--expect-beads; contradicts the cli.mjs help text this diff changed)
- fleet-sprint/skills/fleet-supervisor/SKILL.md:36 (LLM-facing)
- docs/fleet-sprint-cli-contract.md:86
- fleet-sprint/docs/fleet-sprint-diagram.md:77

TESTS: build OK. generic-boundary OK. apra-pm 489/489. vitest 382 files passed, 1 failed. fleet-se 3610 passed, 3 failed. All failures are this machine, not the branch:
- undici: stale node_modules. Passes after npm install.
- contracts-schema-dist-staleness-guard: stale gitignored dist. Passes after npm run dist-pm.
- phase0-seams-facade and phase1-leaf-facade-completeness: Windows symlink EPERM. These tests exist on main and this diff does not touch them.
The branch changes no package.json and no schema.

KB: no promotion candidates supplied; none promoted.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: apra-fleet-3ty5.
Summary: Regression pass at HEAD f6d1be72. Informational only: it does not gate the sprint, and everything below carries over to a future sprint. The permissions check passed. Part 1 (real-bd): a prior run at this HEAD had crashed with 3 files pending, so I resumed it with --start. All 282 of 282 files are now recorded, with 11 failing: golden-transcript, mock-sprint-beads-health-gate-empty-remote, mock-sprint-beads-identity, mock-sprint-parent-child-blocks-cycle-repair, mock-sprint-plan-review-acceptable-alternative, mock-sprint-regression-failure-never-gates, phase0-seams-facade, phase1-leaf-facade-completeness, phase3-dispatch-engine-completeness, serve-wiring-integration and vcs-auth-extraction-facade. The slow lane (npm run test:slow) exited 1: mock-sprint-planner-dispatch-stalled-session hit bd-replay recording drift, and the other slow test passed. Ten of the 11 failures, plus the slow-lane failure, match existing open carry-over beads (apra-fleet-zekq, zl0u, vwa2, 0aer, o4vi, 9lwv, ryk, 44il, 5jlr; the phase1/phase3/vcs cascades are covered by zekq and 9lwv). I appended a recurrence note to each rather than filing duplicates. One bead is new: apra-fleet-3ty5 (P3, parent-less) for mock-sprint-plan-review-acceptable-alternative, which failed in 8s with no error detail in the full run and passed alone in 68s, so it looks like a load flake. Part 2 (smoke): Setup succeeded (sandbox lock, install, server on 18700, toy clone, isolated beads seed, supervisor up on 18701). The run was then blocked at step 3a: the auto-mode permission classifier denied writing the INTEG-TOY-DOER-TOKEN secret (Secret-Store Writes). This is the same block already tracked in apra-fleet-j48h, so I appended a recurrence note there. I did not work around the denial, and the member registration, canary check and toy sprint did not run, so smokePassed is false. Teardown ran clean: supervisor stopped, lock released, fleet server stopped, no dolt reap needed, sandbox removed, and the leftover sandbox-deploy sweep for this sprintId found nothing to tear down.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
