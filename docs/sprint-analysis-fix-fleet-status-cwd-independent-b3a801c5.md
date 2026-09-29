# Sprint Analysis: fix/fleet-status-cwd-independent

Scope issue id(s): apra-fleet-b4g.
Base branch: main.
Cycles run: 5.

## Progress

Closed-bead count history (per cycle evaluation): [47, 50, 52, 56, 58].
High-water-mark closed count this sprint: 63.
Final closed count: 58.
Final open-at-goal-priority count: 3.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
Integration test failures (1): C1: Permissions check passed (all required command families covered by .claude/settings.local.json). Both handed features (apra-fleet-b4g.29, apra-fleet-b4g) were inconclusive and left open with notes: b4g.29's own impl/test children (b4g.29.1/.29.2) are still open/unimplemented, and b4g (the epic root) has no test task of its own and multiple children still open, so neither had anything ready to test. Of the three verify-set beads: apra-fleet-b4g.24 (scope-refusal follow-up) verified clean against deployed HEAD 890ed755 -- tests/knowledge/kb-scope-guard.test.ts (26/26) and packages/apra-fleet-se's runner-kb-priming.test.mjs (53/53, including the regression tripwire) both passed via the wall-clock-bounded test runners -- and was closed. apra-fleet-b4g.23 (member-local stdio MCP with kb/code-only tools) also verified clean -- tests/member-mcp-scope.test.ts 54/54 passed and claude.ts no longer contains the old blanket mcpServers.apra-fleet.disabled=true wiring -- and was closed. apra-fleet-9jmc (planner KB contract truthfulness) did NOT hold: its cited fix commits are absent from the deployed branch HEAD, and direct inspection of the five affected role prompts (including this very integ-test-runner.md) shows the pre-fix 'required' KB-Bank language and kb_captures schema field are still live in the deployed build, so it was left open and gap bug apra-fleet-9jmc.3 was filed under it. No out-of-scope test failures were observed during this pass. The sandbox deploy for this sprintId was located (MCP_VERSION v0.4.4_890ed7, matching the verified HEAD) and torn down cleanly at the end. (bugs filed: apra-fleet-9jmc.3)

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Code quality is high and the tree is green, but the epic's defining acceptance was never run.

VERIFIED FIRST-HAND (not trusted):
- Build clean; full npm test exit 0, zero failures (apra-fleet-client 40, apra-fleet-workflow 321, apra-pm 485, plus root vitest and apra-fleet-se).
- 4123edea (fleet-status cwd independence): kb-scopes.ts enumerates scopes on disk; repo_path explicit, server cwd never used. Correct root-cause fix.
- cc712c94 (kb scope refusal): guard applied once at MCP registration; CLI entry points keep cwd behaviour by design; memory-contract/v1 updated in the same change per convention.
- 3009ad05 (PowerShell probe): reproduced against real pwsh. Old try/catch form emitted no sentinel and leaked exit 3; new LASTEXITCODE form emits EXEC_FAILED and exits 0. Claim holds exactly.
- apra-fleet-9jmc: integ cycle C1's finding was a FALSE NEGATIVE from a stale deploy. C1 tested HEAD 890ed755, which PREDATES fixes 7aec7f4e/5fa78db8. At current HEAD all five wrapper prompts are inverted, and that set matches exactly the wrapper + no-kb-apply rows I derived live from role-policies.mjs. The six prompts keeping '(required' legitimately have a kb-apply path. C1's blocker is resolved; 9jmc and 9jmc.3 closures stand.
- Hygiene clean. tests/knowledge/fixtures/kb-http-test-token.txt is a NOT_A_REAL_KEY placeholder, not a secret. llms-full.txt is a pre-existing tracked docs artifact. CLAUDE.md is legitimately tracked here as the source of truth for AGENTS.md.

WHY FAIL:
apra-fleet-b4g is open because apra-fleet-b4g.25 -- the end-to-end acceptance run against a REAL REMOTE member -- was never executed in 5 cycles. The epic exists because of a defect empirically proven on member win-apra-fleet (kb_stats returned 0 entries instead of 35). Everything delivered is validated only by mock and unit tests, so nothing demonstrates the member-local redesign fixes the founding defect. b4g.16 and b4g.16.4 remain open, and b4g.16.4 is by definition the verdict on b4g.25's evidence. An acceptance resting on a run never performed is an unshipped feature, so the epic cannot be declared done.

NOTE ON EVIDENCE: the '3 open at goal priority' figure is accurate under true parentage; the larger open set visible by id prefix was deliberately re-parented to follow-up epic apra-fleet-hn0i. Verified via parent edges, not id prefixes.

No beads reopened: every closure spot-checked (b4g.23, b4g.24, b4g.29, 9jmc, 9jmc.3) holds at current HEAD. No KB promotions -- the fleet MCP server was unreachable, so no candidate block existed.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran regression-test-playbook.md Part 1 (packages/apra-fleet-se real-bd suite, 276 files via scripts/run-integ-suites.mjs, plus the test:slow watchdog lane) and Part 2 (fresh sandbox smoke test: install, server boot, supervisor boot) at branch HEAD 9af81c83. Part 1 required recovering from a stale leftover integ-suite-status.json (pre-existing harness gotcha, tracked on apra-fleet-jl71, recovered via --fresh) then completed pass COMPLETE with 7 failures: golden-transcript.test.mjs divergence/non-determinism cascading into phase0-seams-facade, phase1-leaf-facade-completeness, phase3-dispatch-engine-completeness, and vcs-auth-extraction-facade (tracked on apra-fleet-zekq), mock-sprint-beads-identity.test.mjs bd-prefix mismatch (apra-fleet-vwa2), and mock-sprint-parent-child-blocks-cycle-repair.test.mjs bd-dep-add setup failure (apra-fleet-0aer); the slow lane also failed its bd-replay recording-drift test (apra-fleet-5jlr). All 7+1 failures matched already-open, extensively-tracked [regression][carry-over] bugs from prior sprints' regression runs, so no new bugs were created -- each was updated with a fresh recurrence-confirmation note instead (per the dedupe rule), and phase3's single-file budget overrun was also noted on the related [integ] bug apra-fleet-eft.17. Part 2's Setup fully succeeded (fresh install, fleet server verified bound to port 18700, supervisor verified healthy via identity-checked readiness, sandbox beads DB seeded and isolation-verified), but the Test scenario could not proceed past credential provisioning (step 3a): the Claude Code auto-mode classifier denied the 'node dist/index.js secret --set' write under reason 'Secret-Store Writes', independent of the Bash permissions.allow list. Per this repo's CLAUDE.md, permission blocks must be surfaced, not routed around, so no workaround was attempted; Teardown was run successfully regardless (supervisor stopped at 73s uptime, well under the 5-minute dolt-orphan-sweep tick; lock released; server stopped; dolt reap clean; sandbox removed), and the sprint's own leftover sandbox-deploy sweep found nothing to tear down. This block is a tool-sandbox/environment restriction in this execution environment, not an apra-fleet product defect, so it was recorded via bd remember as an operational gotcha rather than filed as a carry-over bug; the operator should grant secret-store-write permission (via compose_permissions or equivalent) for a future run to complete Part 2's Test scenario. This result is purely informational: it does not gate this sprint's PASS/FAIL verdict, and every filed/updated failure carries over to a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
