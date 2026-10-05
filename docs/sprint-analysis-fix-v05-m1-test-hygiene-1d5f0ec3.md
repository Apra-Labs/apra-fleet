# Sprint Analysis: fix/v05-m1-test-hygiene

Scope issue id(s): apra-fleet-i9ag.22.2, apra-fleet-i9ag.22.3.
Base branch: v0.5_dashboard.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [6].
High-water-mark closed count this sprint: 8.
Final closed count: 6.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Net diff v0.5_dashboard..fix/v05-m1-test-hygiene (4 commits, 4 files) reviewed against apra-fleet-i9ag.22.2 and i9ag.22.3.

i9ag.22.2 (sandbox-deploy verify): root cause fixed in scripts/sandbox-deploy.mjs. start() now writes SUPERVISOR_TOKEN_PATH, the path of the token it proved against /api/health (never the secret itself). verify() and teardown() reuse that token through sandboxSupervisorToken() instead of calling tryLoadToken again. The re-resolve could pick up a fleet.key minted after startup, which caused the 401. The token is checked against the same 64-hex pattern as local-token.mjs TOKEN_PATTERN, and it falls back to the read-only resolver for older values files. verify() switched to the new probeJson() and describeProbeFailure(), so a 401/403 is reported as 'HTTP 401 (bearer token rejected)' and a genuine no-answer keeps its own wording. getJson keeps its null-on-anything contract for existing callers. New tests use an in-process fake supervisor to cover the 401 wording, the no-answer wording and reuse of the recorded token path (nothing is minted). The previously failing live up/env/teardown test ran (dist present) and passed under npm test on macOS.

i9ag.22.3 (windows-service stray files): launcherPathFor() in src/services/service-manager/windows.ts now only swaps the .bat extension, so on POSIX the launcher lands next to the wrapper instead of in a backslash-named file in the cwd. Windows paths map the same as before, including the case-insensitive .BAT. All 3 callers (register, uninstall unlink, Run-key start) are consistent. Tests cover POSIX and Windows mapping, plus a lifecycle guard that fails if new backslash-named files appear in the cwd (skipped on win32).

Verification: npm run build ok. npm test ok: vitest 500 files / 7249 tests passed; client, workflow, fleet-se (5753 concurrent + serial lane), apra-pm and contract:check all ok. The count of backslash-named untracked files in the repo root was 31 before and after the full run, so the suite no longer creates them. All 31 existing ones are dated no later than 10:29:25, before the fix commit at 10:29:30 (the last batch is presumably the doer's pre-fix red run). They are local leftovers, not part of the diff, and the operator can delete them.

Minor: sandbox-deploy.mjs teardown has 'const h =await' (missing space). teardown still uses the status-blind getJson for its graceful-shutdown health probe (follow-up filed).

Tooling: kb_query was used (no relevant entries). code_impact was unavailable (gitnexus offline: spawn npx ENOENT), so I checked launcherPathFor callers by grep instead. CI is out of scope.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: Install smoke passed. I took the sandbox lock, ran a fresh install into the throwaway HOME (~/temp/.apra-fleet-tests), and started the server. `status` reported running on port 18700, and server.json confirmed that port. Teardown then released the lock, stopped the server and deleted the sandbox and lock file. The leftover sandbox-deploy sweep for this sprintId exited 0 with 'nothing to tear down'. In-sprint smoke was not run, as the playbook directs: NOT RUN: moved to CI. It is reported as passed: false and no bead was filed for it. Overall passed is false only because of that NOT RUN section. No test failures occurred, so no carry-over beads were filed. This result is informational and does not gate the current sprint's verdict.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-mac1' -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 2: plan-reviewer on member 'fleet-mac1' -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 3: doer on member 'fleet-mac1' [Streak [apra-fleet-i9ag.22.2.1.1, apra-fleet-i9ag.22.2.1.2]] -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 4: doer on member 'fleet-mac1' [Streak [apra-fleet-i9ag.22.3.1.1, apra-fleet-i9ag.22.3.1.2]] -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 5: reviewer on member 'fleet-mac1' -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 6: deployer on member 'fleet-mac1-deploy' -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 7: integ-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 8: reviewer on member 'fleet-mac1' [Final Review] -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 9: regression-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).

Per-member totals:
- member 'fleet-mac1': 6 dispatch(es), kb_* calls: unknown, code_* calls: unknown (6 dispatch(es) with unknown counts).
- member 'fleet-mac1-deploy': 3 dispatch(es), kb_* calls: unknown, code_* calls: unknown (3 dispatch(es) with unknown counts).

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $3.6119.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.1048 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 10 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
