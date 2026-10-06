# Sprint Analysis: feat/kb-1-value-installs-safety

Scope issue id(s): apra-fleet-b4g.138.
Base branch: feat/kb-redesign.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [43, 49, 51].
High-water-mark closed count this sprint: 65.
Final closed count: 51.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Final review of feat/kb-redesign..feat/kb-1-value-installs-safety (34 commits, 121 files) against the KB-1 epic apra-fleet-b4g.138.

Code: no blocking defects found. Checked: (1) the access secret now required on every non-JWT /mcp request (src/services/http-transport.ts; member-access-secret.ts: 0600 file, wx create, constant-time compare, refuses when the secret is missing). Every non-test HTTP client sends the header (factory.mjs, connectFleetMember, fleet-members.mjs, dolt-settle-integration.mjs, manual scripts). (2) Install user-scope registrations are owner-only with no secret in argv, and other providers' existing http entries are refreshed. (3) ~/.claude.json and the session MCP config never travel on a command line; the inline/base64/chunked fallbacks are gone and missing channels fail loudly. (4) Replace-full is opt-in, refused when the marker probe fails, has a staged installer before anything destructive, and each step has its own rollback that uses the stopped-server data copy. (5) The member MCP port comes from the member's own marker, and port-holder names another user's process. (6) alwaysLoad is gated on CLI >= 2.1.288, and every role prompt now has the rule for loading deferred tools. (7) darwin-x64 matrix, SHA256SUMS and the SEA fuse guard. (8) apra-fleet-client is in sync (fleet_install replace-full, codeIntel). No non-ASCII added. Tree clean.

Local tests (Windows): build OK. npm test exit 0: vitest 460 files passed / 16 skipped, 6466 tests passed. Workspace suites 107/348/489 passed, 0 failed. The two-installs-one-host, cross-install secret, port-held-by-other-user and alwaysLoad tests ran (Claude CLI 2.1.291 present).

Why FAIL: the epic's Live criterion (a sprint on local and remote members shows non-zero, attributed kb/code calls for planner, doer and reviewer) and b4g.127's live criterion are not evidenced. b4g.127 was closed by integ on unit-test results only. Its own notes record the opposite in this sprint: the local Windows doer made 0/0, and planners and plan-reviewers made 0 code calls in all 6 dispatches. Unlike b4g.88 (live part moved to 47uh), it has no recorded move out of scope and no post-fix live evidence. This is not a CI criterion. Reopening b4g.127: either produce post-fix dispatch-accounting evidence, or have the planner move the live part to a live-verification follow-up.

Secondary findings (newTasks): the GET/DELETE /mcp secret check is skipped by any bearer, and that bearer is never JWT-verified; member-init does not name the new 401 (E-MEMBER-SECRET) cause; api-reference.md still documents fleet_install as auto|skip only.

KB: promoted 21d88cb3 (lazy workflow import) and ecd9b9c5 (APRA_TEST_SUITES_JSON inherited by enumeration test). Left 16451fa3 (Claude CLI behaviour, not exercised) and d097ff81 (Python CRLF, not reproduced) as INFERRED.

Tools: kb used (kb_query); code used (code_impact on ensureMemberFleetInstall: CRITICAL, 149 upstream).

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: I ran the regression playbook at branch HEAD (de52b571). All permission prefixes were covered by the merged settings. The leftover sandbox-deploy sweep for this sprint's id exited 0 with 'nothing to tear down'. Install smoke passed. The sandbox lock was acquired, a fresh install into the throwaway HOME succeeded, and port 18700 was confirmed free. The server started and status reported it running on 18700, which the server.json check confirmed. Teardown released the lock, stopped the server and deleted the sandbox directory. In-sprint smoke is NOT RUN: moved to CI. The playbook says to report it as not passed, so overall passed is false for that reason only. No test failed, so no carry-over bead was filed. This result is informational and does not gate the sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB bible

WARNING: bible not published -- these KB confirmations are not in a pushed bible commit on the sprint branch as of this analysis (the harvest round retries once more after it is written):
- github.com/apra-labs/apra-fleet: 2 unpublished confirmation(s).
Bible commits were sealed: final review verdict FAIL.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-win1' -- kb_* calls: 4, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-win1' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 3: planner on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 4: plan-reviewer on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 5: doer on member 'fleet-win1' [Streak [apra-fleet-b4g.130.1, apra-fleet-b4g.130.2, apra-fleet-b4g.121.1, apra-fleet-b4g.121.2, apra-fleet-b4g.121.3]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 6: doer on member 'fleet-win1' [Streak [apra-fleet-b4g.127.1, apra-fleet-b4g.127.2]] -- kb_* calls: 2, code_* calls: 2.
- Dispatch 7: doer on member 'fleet-win1' [Streak [apra-fleet-b4g.100.1, apra-fleet-b4g.100.2, apra-fleet-b4g.101.1, apra-fleet-b4g.101.2]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 8: doer on member 'fleet-win1' [Streak [apra-fleet-b4g.115.1, apra-fleet-b4g.115.2]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 9: reviewer on member 'fleet-win1' -- kb_* calls: 1, code_* calls: 8.
- Dispatch 10: doer on member 'fleet-win1' [Streak [apra-fleet-b4g.71.1, apra-fleet-b4g.71.2, apra-fleet-b4g.71.3, apra-fleet-b4g.116.1, apra-fleet-b4g.116.2, apra-fleet-b4g.120.1]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 11: reviewer on member 'fleet-win1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 12: doer on member 'fleet-win1' [Streak [apra-fleet-b4g.88.1, apra-fleet-b4g.136.1, apra-fleet-b4g.136.2, apra-fleet-b4g.136.3]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 13: doer on member 'fleet-win1' [Streak [apra-fleet-b4g.122.1, apra-fleet-b4g.122.2, apra-fleet-b4g.122.3]] -- kb_* calls: 5, code_* calls: 3.
- Dispatch 14: doer on member 'fleet-win1' [Streak [apra-fleet-b4g.116.1, apra-fleet-b4g.116.2]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 15: reviewer on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 1.
- Dispatch 16: deployer on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 17: integ-test-runner on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 18: planner on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 19: plan-reviewer on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 20: doer on member 'fleet-win1' [Streak [apra-fleet-b4g.122.4, apra-fleet-b4g.122.5]] -- kb_* calls: 2, code_* calls: 3.
- Dispatch 21: reviewer on member 'fleet-win1' -- kb_* calls: 1, code_* calls: 2.
- Dispatch 22: member 'fleet-win1' [Streak Assignment] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 23: doer on member 'fleet-win1' [Streak [apra-fleet-b4g.120.2, apra-fleet-b4g.120.3]] -- kb_* calls: 1, code_* calls: 3.
- Dispatch 24: doer on member 'fleet-win1' [Streak [apra-fleet-b4g.138.1]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 25: reviewer on member 'fleet-win1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 26: member 'fleet-win1' [Streak Assignment] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 27: doer on member 'fleet-win1' [Streak [apra-fleet-b4g.138.1, apra-fleet-b4g.138.2]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 28: doer on member 'fleet-win1' [Streak [apra-fleet-b4g.120.3]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 29: reviewer on member 'fleet-win1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 30: deployer on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 31: integ-test-runner on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 32: planner on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 33: plan-reviewer on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 34: doer on member 'fleet-win1' [Streak [apra-fleet-b4g.138.1]] -- kb_* calls: 1, code_* calls: 2.
- Dispatch 35: reviewer on member 'fleet-win1' -- kb_* calls: 1, code_* calls: 2.
- Dispatch 36: deployer on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 37: integ-test-runner on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 38: reviewer on member 'fleet-win1' [Final Review] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 39: regression-test-runner on member 'fleet-win3' -- kb_* calls: 1, code_* calls: 0.

Per-member totals:
- member 'fleet-win1': 32 dispatch(es), kb_* calls: 25, code_* calls: 30.
- member 'fleet-win3': 7 dispatch(es), kb_* calls: 1, code_* calls: 0.

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $50.4886.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.1563 across 3 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 37 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
