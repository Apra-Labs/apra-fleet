# Sprint Analysis: feat/v05-sprint-g

Scope issue id(s): apra-fleet-6gm5.1, apra-fleet-9h9j, apra-fleet-v6t7.21, apra-fleet-q1ku, apra-fleet-ecjf.10, apra-fleet-50j6.12.
Base branch: v0.5_dashboard.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [45, 51, 53].
High-water-mark closed count this sprint: 62.
Final closed count: 53.
Final open-at-goal-priority count: 1.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
Integration test failures (1): C1: No features were in scope this cycle. I ran full `npm test` at 38f230c2 against the sandbox deploy and checked the sandbox supervisor and UI over HTTP. The sandbox was torn down cleanly. Five of the six verify-set beads held and were closed. hwxd: the supervisor-first case in registration-convergence.test.mjs passed; the sandbox supervisor returned 401 without a token and 200 with the private token. I did not test a fleet.key-derived credential live. wgpx: both register-member-git-ownership tests passed. oqk7: install-data-dir and install-non-default-instance-e2e passed. q1ku: non-default-instance-isolation passed. 9h9j: the shell-ui tests and console-routes-fleet passed, and the sandbox returned 200 on /ui/. apra-fleet-v6t7.21 stays open. Its child v6t7.21.3 (commit 3785c147) removed the redundant build:ui step from ci.yml, but tests/ci-build-ui-step.test.ts still expects two such steps and fails 7 tests. I filed apra-fleet-v6t7.21.4 under v6t7.21. Three other failures in the same `npm test` run are not from the handed beads. The dist-staleness and i9ag19-7 failures are already tracked (apra-fleet-b4g.55.5 and apra-fleet-tbup.4). I filed apra-fleet-6gm5.1.2 for the supervisor-stop-restart failure. (bugs filed: apra-fleet-v6t7.21.4, apra-fleet-6gm5.1.2)

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed the net diff v0.5_dashboard..feat/v05-sprint-g (33 commits, 103 files) against the 6 scope beads. Ran npm run build (ok) and the full npm test at 987041a0. Passed: vitest shards 1-3 (2328/2591/2497), apra-fleet-client 167/167, apra-fleet-workflow 367/367, apra-pm, contract:check. apra-fleet-se failed only in i9ag19-7-exec-bd-configured.test.mjs (CONTROL sync, CONTROL async, PATH composition). Cause: this host has node in /usr/bin. This sprint did not touch that file, and the failure is already tracked by the open P2 child of the sprint epic. It is not a sprint regression and is the only open goal-priority bead. Everything else is green, including supervisor-stop-restart and the dashboard integration suites (the 6gm5.1.2 fix: own spawner basePort, waits for the child pid).

Per bead:
- 50j6.12: dashboard-session.mjs adds a same-origin POST /signin. It checks Sec-Fetch-Site and Origin/Host before comparing the token, uses tokenEquals, caps the body at 8 KiB and sanitizes next to a root-relative path. GET ?token= returns 400 and never compares or sets a cookie. Both ?token= instructions are gone from serve.mjs and the docs, and the clipboard examples keep the key out of argv. Tests in supervisor-dashboard-cookie-harvest cover: correct token, wrong/empty token, cross-origin, non-form body, hostile next, and ?token= refused. All criteria met.
- q1ku: the new resolver packages/apra-fleet-client/src/fleet-paths.mjs is used by jwt.ts, local-token.mjs, config.ts, the install.ts code-intelligence step, the code-intelligence tools and id-allocator. The default layout is unchanged; isolation is tested in non-default-instance-isolation.test.ts. Met.
- 9h9j (incl. .7): masked Secrets form with eye toggle, posting to /api/fleet/credential-store-value. The value is never echoed and the route is covered by the console guard plus the SameSite=Strict cookie. Members shows a stale-data notice. Met.
- v6t7.21: staleness paths now include the client, contract and ui-kit packages plus their tsconfigs. The CI test job no longer builds the UI twice; the ci-build-ui-step test was realigned (.21.4). Met.
- ecjf.10: scaledTimeout now falls back to TEST_CONCURRENCY on undefined, empty or garbage input, with tests. Met.
- 6gm5.1 children: hwxd (lazy token re-resolution with a bounded 24h grace for the old token), oqk7 (--data-dir and --mcp-scope; service env written for systemd, launchd and the Windows .bat, with cmdSetLine refusing quotes and newlines), wgpx (register_member refuses a folder git rejects for dubious ownership), ky2l.23/.25, iywi.14-18, 972p.18/19. Code matches.

Follow-ups (filed as new tasks, none blocking):
1) Existing APRA_FLEET_DATA_DIR installs silently move to a newly minted <D>/fleet.key on upgrade, with no warning or upgrade note.
2) Four CONFIRMED KB entries are now contradicted by this sprint.
3) Two small code-quality nits.

KB: no candidates promoted or discarded. Neither was independently tested in isolation this round, so both stay INFERRED. CI was not judged (out of scope).

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: I ran the playbook's two parts in order. Install smoke passed: a fresh install into the throwaway HOME succeeded and the server bound to scratch port 18700. Teardown then released the lock, stopped the server and removed ~/temp/.apra-fleet-tests. The leftover sandbox-deploy sweep for this sprintId exited 0 with 'nothing to tear down'. In-sprint smoke is NOT RUN: moved to CI. The playbook says to report it as passed: false and return overall passed: false, so overall passed is false for that reason alone. No bead was filed for it, and no other failures were found, so no carry-over beads were filed. The permissions check found every required prefix covered. This result is informational and does not gate the sprint's verdict.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-lin1' -- kb_* calls: 5, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 3: planner on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 4: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 5: doer on member 'fleet-lin1' [Streak [apra-fleet-q1ku.1, apra-fleet-ky2l.23, apra-fleet-q1ku.2]] -- kb_* calls: 2, code_* calls: 3.
- Dispatch 6: doer on member 'fleet-lin1' [Streak [apra-fleet-9h9j.7, apra-fleet-972p.19, apra-fleet-9h9j.5, apra-fleet-9h9j.6, apra-fleet-972p.18]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 7: doer on member 'fleet-lin1' [Streak [apra-fleet-iywi.16, apra-fleet-iywi.14, apra-fleet-iywi.18, apra-fleet-iywi.17, apra-fleet-iywi.15]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 8: reviewer on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 3.
- Dispatch 9: doer on member 'fleet-lin1' [Streak [apra-fleet-hwxd.1, apra-fleet-ky2l.25, apra-fleet-hwxd.2]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 10: doer on member 'fleet-lin1' [Streak [apra-fleet-oqk7.1, apra-fleet-oqk7.2, apra-fleet-oqk7.3]] -- kb_* calls: 2, code_* calls: 1.
- Dispatch 11: doer on member 'fleet-lin1' [Streak [apra-fleet-ecjf.10, apra-fleet-v6t7.21.2, apra-fleet-v6t7.21.3]] -- kb_* calls: 2, code_* calls: 1.
- Dispatch 12: doer on member 'fleet-lin1' [Streak [apra-fleet-wgpx.1, apra-fleet-wgpx.2]] -- kb_* calls: 2, code_* calls: 0.
- Dispatch 13: reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 14: doer on member 'fleet-lin1' [Streak [apra-fleet-50j6.12]] -- kb_* calls: 1, code_* calls: 2.
- Dispatch 15: doer on member 'fleet-lin1' [Streak [apra-fleet-oqk7.2, apra-fleet-oqk7.3]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 16: reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 17: deployer on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 18: integ-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 19: planner on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 20: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 21: doer on member 'fleet-lin1' [Streak [apra-fleet-v6t7.21.4.1]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 22: doer on member 'fleet-lin1' [Streak [apra-fleet-6gm5.1.1, apra-fleet-6gm5.1.2.1, apra-fleet-6gm5.1.2.2]] -- kb_* calls: 3, code_* calls: 1.
- Dispatch 23: reviewer on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 1.
- Dispatch 24: deployer on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 25: integ-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 26: planner on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 27: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 28: deployer on member 'fleet-lin1-deploy' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 29: integ-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 30: reviewer on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 2.
- Dispatch 31: reviewer on member 'fleet-lin1' [Final Review] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 32: regression-test-runner on member 'fleet-lin1-deploy' -- kb_* calls: 0, code_* calls: 0.

Per-member totals:
- member 'fleet-lin1': 25 dispatch(es), kb_* calls: 26, code_* calls: 16.
- member 'fleet-lin1-deploy': 7 dispatch(es), kb_* calls: 1, code_* calls: 0.

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $29.9693.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.1689 across 3 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 32 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
