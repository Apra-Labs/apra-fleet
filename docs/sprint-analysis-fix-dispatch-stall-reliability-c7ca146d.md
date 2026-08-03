# Sprint Analysis: fix/dispatch-stall-reliability

Scope issue id(s): apra-fleet-l7n.
Base branch: chore/integration-binary-fixes-and-auth-selfheal.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [32, 39].
High-water-mark closed count this sprint: 46.
Final closed count: 39.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

Deploy failures (1): C1: Deploy stopped after a mid-deploy failure per runbook rules (no workaround attempted). npm ci: OK (exit 0, only EBADENGINE warnings). npm run build: OK (exit 0). npm run build:binary: OK (exit 0), produced dist/apra-fleet-installer-linux-x64. Failing command: `dist/apra-fleet-installer-linux-x64 install --force` -> exit 1. Output: 'Stopped running server.' then '[1/13] Installing binary...' then '[fleet:error] cli Install failed: ETXTBSY: text file is busy, copyfile /home/akhil/git/apra-fleet-dev1/dist/apra-fleet-installer-linux-x64 -> /home/akhil/.apra-fleet/bin/apra-fleet'. The installer stopped the old server but then failed the binary copy; ps confirms the old apra-fleet --transport http process (pid 1124907) is still running/listening on 7523, so the singleton is in a stopped-then-still-running inconsistent state (its listener was not actually torn down despite the 'Stopped running server' message -- worth flagging to the team). Smoke test was not run since Deploy did not complete. No fix or workaround was attempted, per rules; not modified deploy.md or source files. Before deploying I checked for other active sprints per deploy.md's caution (GET /api/sprints returned 404; `ss -tlnp` showed no separate supervisor HTTP server listening on any port besides the apra-fleet singleton on 7523), so no evidence of collateral impact to other sprints from the server-stop attempt itself.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Scope epic apra-fleet-l7n (13 children) is fully implemented and the code quality is good: execute-prompt.ts wires a stallAbortController that merges into the dispatch signal so a confirmed stall now cancels the in-flight MCP dispatch (apra-fleet-3c9); adds a shared retryBudget() so the client hard-timeout no longer fires before the server's own retry-and-report (apra-fleet-y8q); gates the exit-0/empty-stdout workspace_not_trusted self-heal to one retry (apra-fleet-6a7); undici pinned to ^7.x tree-wide via overrides for Node 20 (apra-fleet-l7n.1/0v0); SSH pool cleanupEntry guarded against reaping a live channel (apra-fleet-9zz); watchdog reentrancy guard (apra-fleet-eft.4.9); finalizeAbort git-op self-heal (apra-fleet-5d5); cost analysis integ-test-runner row (apra-fleet-nwh). Build passes; full vitest suite passes (207 files / 2892 tests passed, 21 skipped, 0 failed); git tree clean; file hygiene clean (root integ-suite-*.json/.log are gitignored, not committed). BUT the final gate fails: the Deploy phase FAILED and the smoke test never ran, and I confirmed the cause is a genuine defect in the install self-heal path, not merely an environment fluke. In src/cli/install.ts, killApraFleet() (lines 695-702) runs a fire-and-forget `pkill -x apra-fleet`, then runInstall() (lines 909-911) waits a fixed 500ms and unconditionally prints 'Stopped running server.', then copies the new binary over the live path at line 923 (fs.copyFileSync(process.execPath, binaryPath)). There is no verification that the old process actually exited, no poll loop, and no SIGKILL escalation. When the old `apra-fleet --transport http` process does not terminate within 500ms it is still executing ~/.apra-fleet/bin/apra-fleet, so the copy fails with ETXTBSY (text file is busy) and `install --force` exits 1 -- exactly what the deploy evidence shows (pid 1124907 still listening on 7523 after the 'Stopped running server' message). Per the review contract deploy failures are not rubber-stamped, so the sprint is not verifiably deployable. Note install.ts was not modified in this sprint (last touched by 3f238cc/bd01665), so this is a pre-existing latent defect surfaced by deploy, not a regression from l7n -- but it still blocks release and must be tracked.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Stopped at Step 0 (permissions check) before running any part of the regression pass. The playbook's Permissions section requires allowlist coverage for Bash(rm -rf ~/temp/.apra-fleet-tests*), Bash(node dist/index.js *), Bash(git clone *), Bash(git -C ~/temp/.apra-fleet-tests* *), and Bash(node scripts/run-integ-suites.mjs *), none of which are covered by any entry in .claude/settings.json's permissions.allow or .claude/settings.local.json (which has no permissions block at all). Per instructions I did not attempt to add these permissions myself and did not proceed with Part 1 (real-bd suite) or Part 2 (smoke test); no sandbox was ever brought up so no Teardown was required. This result is informational and does not gate the current sprint's verdict -- it reports a blocked run, not a regression finding.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
