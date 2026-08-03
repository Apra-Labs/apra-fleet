# Sprint Analysis: fix/dispatch-stall-reliability

Scope issue id(s): apra-fleet-l7n.
Base branch: chore/integration-binary-fixes-and-auth-selfheal.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [45].
High-water-mark closed count this sprint: 45.
Final closed count: 45.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- All 15 apra-fleet-l7n children are implemented and tested against their acceptance criteria. Verified: install.ts bounded-poll+SIGKILL escalation and confirmed-termination gating of 'Stopped running server.' (l7n.2/l7n.3); ssh.ts activeChannels live-channel guard + keepalive (9zz/107); execute-prompt.ts stall-abort of in-flight dispatch, exit-0/empty-stdout trust self-heal (one-shot), shared retryBudget deadline, and partial-usage attachment on max_turns (3c9/6a7/y8q/63x); watchdog.mjs classifyAll reentrancy guard (eft.4.9); runner.js all-beads-closed max_turns success + finalizeAbort self-heal + integ cost line (33c/5d5/nwh); doer.md VERIFY stop-rule (gd0); undici pinned ^7.29.0 for Node 20 (0v0/l7n.1). Gates: npm run build passes; git status clean; root vitest 207 files / 2895 passed, 0 failed; workspace node:test suites 0 failures; apra-pm 418/418 passed. 0 beads open at goal priority P1/P2. CI is Node 22.x and green -- the newly-added 'Run apra-pm test suite' CI step was reproduced under Node 22 (sh -c 'node --test test/**/*.test.mjs') and exits 0 because Node 22's test runner natively expands the ** glob. File hygiene clean: CLAUDE.md is the tracked source-of-truth doc; packages/apra-fleet-se/apra-pm/.claude/ is shipped PM-skill content (already tracked, installed by install.mjs); the 19 deletions are the tfx server-side-PR reverts. Non-blocking observation (pre-existing, not a sprint regression): apra-pm's npm test script uses a ** glob that only works on Node 21+, so on the project's pinned local Node 20.20.2 it errors 'Could not find' and skips all 418 tests locally; CI (Node 22) is unaffected. Worth a future one-line fix (e.g. list dirs or use a Node-20-safe pattern) but not blocking.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Stopped at Step 0 (permissions check) before running any part of regression-test-playbook.md: the playbook's Permissions section requires Bash prefixes for rm -rf ~/temp/.apra-fleet-tests*, node dist/index.js *, git clone *, git -C ~/temp/.apra-fleet-tests* *, and node scripts/run-integ-suites.mjs *, none of which have a covering entry in .claude/settings.json or .claude/settings.local.json's permissions.allow (only bd *, bd:*, npm test*, npm run *, npx vitest *, gh run *, gh release *, mkdir *, rm -rf /tmp/fleet-deploy*, chmod +x /tmp/fleet-deploy*, *apra-fleet-installer-* install *, *apra-fleet* --version, npm ci, and dist/apra-fleet-installer-* install * are present). No sandbox was ever brought up, so no Teardown was needed; neither Part 1 (real-bd suite) nor Part 2 (smoke test) was attempted, and no bugs were filed. This result is informational and does not gate the current sprint's verdict; the permissions gap must be resolved (by an operator, not by this role) before a regression pass can be attempted.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
