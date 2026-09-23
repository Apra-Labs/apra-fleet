# Sprint Analysis: fix/agy-prompt-body-toolsearch

Scope issue id(s): apra-fleet-oomh.
Base branch: main.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [14, 17, 19].
High-water-mark closed count this sprint: 20.
Final closed count: 18.
Final open-at-goal-priority count: 1.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- FAIL -- acceptance criterion 1 of apra-fleet-oomh is fully met and independently verified; criterion 2 (end-to-end Antigravity proof) was never executed for the second sprint running, and the current decomposition makes it structurally unreachable.

VERIFIED MYSELF (not taken on trust):
- Reviewed the net diff over the real branch point (merge-base with origin/main = 97877f5e; local main is stale, so main..branch also shows 6 already-merged PRs). Sprint net: 32 files, +2937/-35.
- Mechanism: resolveConditionalBody/toolAvailability/transformAgentForClaude in src/cli/agent-transform.ts, wired at src/cli/install.ts:1540-1550 so the Claude path is no longer a passthrough (markers stripped, if-branch kept). Mirrored as resolveAgentConditionals in packages/apra-fleet-se/apra-pm/install.mjs and guarded both as source text and behaviourally by tests/agent-transform-apra-pm-sync.test.ts.
- All 11 role prompts gated; no un-gated ToolSearch prose remains, and no other Claude-only tool name (TodoWrite/WebFetch/Task/MultiEdit) appears in any prompt body.
- Live installs into throwaway HOMEs: apra-pm install.mjs --llm agy exits 0, installed tree greps clean for ToolSearch and for if/else/end-tool markers, doer.md emits only mapped agy tools and Step 0 renders coherent fallback prose; --llm claude keeps the ToolSearch branch with 0 markers.
- Failure paths traced with a standalone repro, not by reading: unclosed, orphan, mismatched and duplicate-else markers all throw with the filename; CRLF sources resolve correctly; copyDirResolved copies non-allowlisted files byte-for-byte with no utf-8 round trip.
- Build green. Full suite green: vitest 335 files passed / 5 skipped, apra-fleet-se 3462 tests 0 fail, apra-pm 456 tests 0 fail; generic-boundary guard and the new ASCII gate both green.
- Hygiene clean: all 32 changed files justifiable, no scratch or tool-config files, no src/tools change so no apra-fleet-client sync owed.

WHY FAIL: AC2 requires a toy sprint on the Antigravity provider with a recorded sprint id, verdict and transcript check. No such evidence exists on the root bead or any child. oomh.10 was closed administratively ("not doer work"), and its replacement oomh.19 stayed open across all 3 cycles. The cause is structural: IntegTest targets come from classifyVerifySet (packages/apra-fleet-se/fleet-sprint/beads-scope.mjs:397-458, consumed at phases/integ-test.mjs:171), which excludes childless beads (rule 3), so leaf .19 can only route to the doer, and excludes any parent with an open child (rule 4), so root oomh cannot be verify-routed while .19 and .20 are open. Filed as a P2 task.

No beads reopened: each of the 18 closed children maps to specific lines in this diff. oomh.10 is the only closure on non-evidence, but oomh.19 already carries that exact work, so reopening .10 would duplicate rather than add signal.

Pre-merge blocker (task filed): the branch conflicts with current origin/main in CHANGELOG.md and scripts/run-all-tests.mjs -- origin/main independently added the identical apra-pm suite entry. Also note no CI run exists for this branch head yet.

No KB promotions: the apra-fleet and fleet MCP servers both failed to connect this session and no promotion-candidate block was supplied.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran regression-test-playbook.md's full pass at branch HEAD c932dd39698a374fee56d5d6d6c3ad45801fbd23. Part 1 (real-bd suite, node scripts/run-integ-suites.mjs) completed 269/269 files in 715s with 7 failures, plus the slow lane (npm run test:slow) failing 1 of 2 tests -- every failure is a long-known, previously-filed recurrence (golden-transcript snapshot divergence cascading into phase0-seams-facade/phase1-leaf-facade-completeness/phase3-dispatch-engine-completeness/vcs-auth-extraction-facade via apra-fleet-zekq, mock-sprint-beads-identity via apra-fleet-vwa2, mock-sprint-parent-child-blocks-cycle-repair via apra-fleet-0aer, the phase3 300s-budget overrun via apra-fleet-eft.17, and the slow-lane bd-replay drift via apra-fleet-5jlr), each updated with today's evidence rather than re-filed. Part 2 (smoke test) Setup completed cleanly (install, server boot+port verification, toy-repo clone, sandbox-local isolation verified, supervisor boot identity-checked), but Test scenario step 3a (seeding the sandbox's Claude credential) was denied by the Claude Code auto-mode permission classifier -- a heavily recurring, previously-filed block (apra-fleet-j48h, reproduced on nearly every regression pass since 2026-08-19); per repo policy no workaround was attempted, so steps 1/2/3b/4/5 (registration, canary check, member auth, sprint launch, closure assertion) never ran. Teardown was executed and verified clean regardless. No new beads were filed -- all findings matched and updated existing standalone, parent-less [regression][carry-over] beads. This result is purely informational: it does not gate the current sprint's PASS/FAIL verdict, and all filed/updated bugs carry over to a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
