# Sprint Analysis: fix/agy-prompt-body-toolsearch

Scope issue id(s): apra-fleet-oomh.
Base branch: main.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [8].
High-water-mark closed count this sprint: 8.
Final closed count: 8.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Code half is correct and independently verified; the epic's own acceptance criterion 2 was never executed.

VERIFIED GOOD (not taken on trust). Build passes; all three suites pass (vitest 332 files, apra-fleet-se, apra-pm 453 tests), generic-boundary guard green. I re-ran the transforms over all 32 shipped assets from dist: 0 surviving conditional markers and 0 ToolSearch references on the agy and opencode paths. I also ran packages/apra-fleet-se/apra-pm/install.mjs --llm agy into a throwaway HOME: exit 0, installed tree greps clean for both ToolSearch and if-tool markers, doer.md frontmatter emits only mapped agy tools.

All 8 closed beads are traceable to specific lines: oomh.1 resolveConditionalBody/CONDITIONAL_MARKER_RE plus transformAgentForClaude in src/cli/agent-transform.ts wired at src/cli/install.ts:1541-1549 (the claude path is no longer a passthrough, which was the subtle half); oomh.2 all 11 role prompts gated; oomh.3 tests/agent-transform-body-tools.test.ts, which derives the drop list from the transform's own warnings rather than re-deriving the tool map, and includes a non-vacuity assertion plus an independent line-scanner oracle for the Claude path; oomh.4 copyDirResolved for schemas/ and _shared/; oomh.5 the reviewer.md dangling parenthetical; oomh.6 transformAgentForAgy in install.mjs; oomh.7 the widened keep-in-sync note; oomh.8 the apra-pm suite added to scripts/run-all-tests.mjs. Error-path coverage is good: unclosed, unmatched, mismatched and duplicated markers all throw with the filename. File hygiene is clean - 21 files, all justifiable, no scratch or tool config.

WHY FAIL. apra-fleet-oomh criterion 2 requires an end-to-end proof routed to the integ-test-runner: install --llm agy on the Linux member via sandbox deploy, run a toy sprint on the Antigravity provider, and record the sprint id, verdict and transcript check on the bead. No such evidence exists on the root bead or any child, and no bead was ever created for it. The sprint decomposed into 8 static/impl tasks only. This criterion exists because the prior static-only fix (PR #509) fixed frontmatter and left the bug alive in the prose - approving a second static-only round without real-provider proof repeats exactly that pattern. I cannot run the toy sprint from here, so the criterion stands unproven.

No beads reopened: all 8 closed children are correctly implemented and verified above. oomh.9 (P3) remains open and already tracks the CI step reconciliation.

KB/code_* tools were unavailable this session (apra-fleet and fleet MCP servers both failed to connect), so this review used direct diff reading, dist-level execution and a live installer run instead.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran the full regression pass per regression-test-playbook.md. Part 1 (real-bd suite): recovered from a stale run-integ-suites.mjs status file (known recurring gotcha, apra-fleet-jl71) via --fresh/--start, then ran a full 269-file pass against real bd (elapsedWall=708s) -- 7 failures, all matching already-tracked pre-existing bugs (apra-fleet-zekq's golden-transcript-divergence cascade into phase0-seams-facade/phase1-leaf-facade-completeness/phase3-dispatch-engine-completeness/vcs-auth-extraction-facade, plus apra-fleet-vwa2 and apra-fleet-0aer); also ran the slow lane (npm run test:slow), which failed with a new manifestation of the already-tracked apra-fleet-5jlr bd-replay-drift bug. Part 2 (smoke test): Setup completed fully and cleanly (install, server start with port verification, toy-repo clone, sandbox-local git/dolt isolation, supervisor boot with identity-checked readiness), but Test scenario step 3a (credential provisioning) was denied by the Claude Code auto-mode permission classifier -- the long-recurring, already-tracked apra-fleet-j48h; per this repo's CLAUDE.md policy no workaround was attempted, so steps 1/2/3b/4/5 never ran. Teardown was run regardless and completed cleanly (supervisor stopped, lock released, dolt processes reaped, sandbox removed); the leftover sandbox-deploy sweep for this sprint's reservation id found nothing to tear down. No new carry-over bugs were filed -- every failure found matched an existing open [regression][carry-over] (or, for the golden-transcript root cause, [integ]-tagged eft.17 budget note) bead, which was updated with this run's fresh evidence instead of duplicating. This result is purely informational: it does not gate the current sprint's PASS/FAIL verdict, and all findings are pre-existing breakage carrying over to a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
