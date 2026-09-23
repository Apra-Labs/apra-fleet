# Sprint Analysis: fix/v043-planner-and-member-prep

Scope issue id(s): apra-fleet-i4ku.
Base branch: main.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [32].
High-water-mark closed count this sprint: 36.
Final closed count: 32.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Reviewed the net diff main..fix/v043-planner-and-member-prep (46 commits, 46 files, +9063/-92) against apra-fleet-i4ku and its 24 closed children.

GATES (all run here, not taken on trust): packages/apra-fleet-se npm test -> SUMMARY pass=4148 fail=0, exit 0; root npm run build exit 0; root npm test exit 0 (# tests 3625 plus vitest suites green); scripts/check-generic-boundary.mjs -> OK (84 files scanned); 0 non-ASCII added lines; no secrets in the diff; file hygiene clean (every changed path justified, no temp files or tool config).

VERIFIED IMPLEMENTED (traced to lines, not to bead counts):
- Epic i4ku: phases/replan.mjs sources the triggering findings from perBeadFeedback (written at phases/review.mjs:211 on reopen, threaded at runner.js:2629); prompts.mjs bounds them at REPLAN_FINDINGS_MAX_LENGTH=4000 with a visible truncation marker and wraps them in wrapUntrustedBlock; the 'read the findings below' clause is omitted when findings are blank. All three ACs pinned by test/replan-findings-prompt.test.mjs.
- Stray sweep: failure paths traced rather than pattern-matched. POSIX kill is per-pid with BEGIN/STATUS markers; ESRCH is tolerated, permission-denied and a missing status line stay loud; already-exited pids are split into alreadyGone instead of inflating killed. Covered unit and end-to-end on both shell families.
- Sweep config armed end to end: serve.mjs loadSweepConfig -> spawner buildSprintArgv --sweep-config -> cli.mjs resolveSweepConfig -> runner -> member-prep runSweepStep. Both validator layers reject unknown top-level keys, with a real cross-layer drift test at test/spawner.test.mjs:378.
- shell-command-guard special parameters: verified the regex standalone ($? $! $$ $# $@ $* $0-$9 flagged; ${...}, $5.00, $1234 not).
- The wrapper-role KB contract inversion is a genuine contract change, not a weakened test, and drift fails in the safe direction.

BLOCKING (why FAIL): CHANGELOG.md:38 -- the top [Unreleased] entry still lists three items as 'Carried forward as backlog (deliberately deferred, not blocking)' that were all closed later on this same branch: the garbled --sweep-config help text and undocumented livenessProbe (i4ku.20, ec0c3a37), the loopback-only liveness probe (i4ku.21, aadccc98), and the silently-ignored unknown sweep-config keys (i4ku.22, 01e7a4f7) -- every one of them after the CHANGELOG commit 9e693984. This directly violates apra-fleet-i4ku.19 AC4 ('CHANGELOG.md carries no residual superseded backlog claim'); that bead's close-out only re-checked the OLDER entry at lines 73-84, which was correctly fixed. The same entry also claims 'its 18 closed children' where there are now 24. The release notes shipping in this PR state three already-fixed defects as deferred.

Notable: the i4ku.19 remedy was prompt-only (harvester.md Step 4) and demonstrably did not prevent the very same defect recurring one entry up within this same sprint -- see newTasks for a mechanical close-out check.

KB: the apra-fleet MCP server failed to connect this session, so no promotion candidates were available and nothing was promoted.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran the full regression pass against branch HEAD (d24d99aa11d73e21033c9e2e3926a2a49e85375b). Part 1 (real-bd suite via scripts/run-integ-suites.mjs, resumed one pending file then completed): 276/276 files recorded, 7 failed -- golden-transcript.test.mjs (snapshot divergence + non-determinism) cascading into phase0-seams-facade, phase1-leaf-facade-completeness, phase3-dispatch-engine-completeness, and vcs-auth-extraction-facade, plus mock-sprint-beads-identity.test.mjs and mock-sprint-parent-child-blocks-cycle-repair.test.mjs failing independently; check-integ-suite-budget.mjs also flagged phase3-dispatch-engine-completeness.test.mjs at 547s over its 300s single-file budget. The slow lane (npm run test:slow) ran 2 tests, 1 pass (dispatch-watchdog-timer-ref.test.mjs) and 1 fail (mock-sprint-planner-dispatch-stalled-session.test.mjs, bd-replay recording drift at the bd init step). Part 2 (smoke test): Setup completed cleanly (install, port guards, server start+port verify, toy-repo clone, sandbox-local git mirror, beads seed + isolation verify, supervisor boot with identity-checked readiness), but Test scenario step 3a (seeding the sandbox's persistent secret store from the runner's ambient Claude credential) was denied by the Claude Code auto-mode classifier (Reason: [Secret-Store Writes]) -- a genuine runtime permission block, not a missing settings.json prefix, so per repo policy no workaround was attempted and the scenario could not proceed past step 3a. Teardown ran regardless (supervisor stopped, lock released, server stopped, no stray dolt sql-server processes, sandbox removed) and is confirmed clean. Every failure found (all 6 distinct issues across both parts) was searched against existing '[carry-over]' beads and matched a long-running pre-existing bead (apra-fleet-zekq, apra-fleet-vwa2, apra-fleet-0aer, apra-fleet-hhjh, apra-fleet-5jlr, apra-fleet-j48h); each was updated with a dated recurrence comment instead of filing a duplicate, so bugsFiled is empty this run. This entire result is informational: it does not gate the current sprint's PASS/FAIL verdict, and every failure listed is pre-existing breakage carrying over to a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
