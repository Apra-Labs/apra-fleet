# Sprint Analysis: feat/v05-supervisor-loopback-token

Scope issue id(s): apra-fleet-50j6.
Base branch: v0.5_dashboard.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [22].
High-water-mark closed count this sprint: 23.
Final closed count: 22.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Final review of v0.5_dashboard..feat/v05-supervisor-loopback-token (8 commits, 31 files) against the loopback-bearer epic and its 12 closed children.

The net diff matches the beads:
- Cookie harvest closed (criteria-defect bead + its test): GET /, the extra index paths and the /ui project page no longer set se_token. The new src/supervisor/dashboard-session.mjs handles ?token= with a constant-time compare (tokenEquals). A match sets an HMAC-derived cookie (deriveDashboardCookie) and 302s to a token-free, mount-aware URL. A mismatch returns 401 and sets no cookie.
- auth.mjs isAuthorized checks bearer and cookie separately. The raw token is accepted only as a Bearer header; the cookie accepts only the derived value. The harvest test asserts raw-token-as-cookie gets 401.
- Per-sprint viewer (viewer/index.mjs): POST /stop, /pause, /resume and /save_logs require a bearer when a service token is set. The match is exact, the same as the route dispatch, so a query-string variant cannot bypass the check. The viewer ignores cookies.
- The supervisor live proxy strips browser credentials and injects the supervisor bearer. requiresAuth still guards POST /sprints/:id/live/* before the proxy runs, and all proxied GET routes are open on the child anyway.
- The spawned child gets the token through FLEET_SE_SERVICE_TOKEN (cli.mjs).
- sandbox-deploy: a non-2xx health answer from the production supervisor now throws or reports a problem instead of silently skipping the check. Tests cover 401, no listener and 200.
- Docs: supervisor curl examples now authenticate, with a guard test (tests/docs-supervisor-auth-header.test.ts). The harness now cleans up its temp dirs, with a test.
- The token is never logged. The startup line names only the token file, and the supervisor does not log request URLs.

Tests on this checkout: build OK. npm test exit 0: vitest batches 2267, 2614 and 2466 passed, 0 failed; apra-fleet-se 5814 + 300 (serial) passed, 0 failed; node --test suites 161, 367 and 489 passed, 0 failed.

Hygiene: nothing unrelated in the diff. The repo root has 31 untracked backslash-named fleet-wintask files left by earlier runs of tests/windows-service-task-xml.test.ts. That test is not in this diff, and this run created none. They are local leftovers, not part of the branch.

CI was out of scope and not judged.

Tools: kb used (kb_query). The code tool was tried, but code_impact on isAuthorized returned 'not found' because the index was behind HEAD (052ec38e vs 203d4a9e), so callers were traced from the diff and grep instead.

Knowledge bank: promoted the se_token derived-cookie entry. I checked its claims against the code and tests.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: I ran the regression playbook at HEAD e6cbcffc498afa4ef6c616040de4409cad3a4820. Install smoke passed. Every required permission prefix was covered. A fresh install into the throwaway HOME succeeded, and the server booted on scratch port 18700. server.json confirmed it was bound to 18700 with no rebind. Teardown then released the lock, stopped the server and deleted the sandbox. The leftover sandbox-deploy sweep for sprint apra-fleet-50j6-f320d0eb-f43d-485b-a13c-08ba205db50d reported nothing to tear down. In-sprint smoke is NOT RUN: moved to CI. The toy sprint needs an LLM credential an agent cannot provision here, so I did not run it and filed no bead for it. Because of that, overall passed is false. No failures were found and no beads were filed. This result is informational and does not gate the sprint. Any filed bugs would carry over to a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-mac1' -- kb_* calls: 3, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-mac1' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 3: doer on member 'fleet-mac1' [Streak [apra-fleet-50j6.6, apra-fleet-50j6.11, apra-fleet-50j6.10, apra-fleet-50j6.8]] -- kb_* calls: 1, code_* calls: 3.
- Dispatch 4: doer on member 'fleet-mac1' [Streak [apra-fleet-50j6.5]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 5: doer on member 'fleet-mac1' [Streak [apra-fleet-4v8r.1, apra-fleet-4v8r.2]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 6: doer on member 'fleet-mac1' [Streak [apra-fleet-50j6.7]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 7: reviewer on member 'fleet-mac1' -- kb_* calls: 2, code_* calls: 2.
- Dispatch 8: deployer on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 9: integ-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 10: reviewer on member 'fleet-mac1' [Final Review] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 11: regression-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.

Per-member totals:
- member 'fleet-mac1': 8 dispatch(es), kb_* calls: 9, code_* calls: 6.
- member 'fleet-mac1-deploy': 3 dispatch(es), kb_* calls: 0, code_* calls: 0.

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $15.2271.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0301 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 11 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
