# Sprint Analysis: feat/v05-s2-ui-shell-members

Scope issue id(s): apra-fleet-v6t7.
Base branch: v0.5_dashboard.
Cycles run: 5.

## Progress

Closed-bead count history (per cycle evaluation): [4, 10, 11, 12, 12].
High-water-mark closed count this sprint: 13.
Final closed count: 12.
Final open-at-goal-priority count: 5.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
Integration test failures (2): C2: Blocked at Step 0a's mandatory permission gate before any feature or verify-set work began: integ-test-playbook.md's Permissions section requires a general `curl ...` command family (e.g. Bash(curl *)), but the merged effective permission set (union of .claude/settings.json and .claude/settings.local.json permissions.allow) only grants two narrow, path-and-port-specific entries -- Bash(curl * localhost:8787/api/sprints*) and Bash(curl * localhost:8787/api/reservations/*) -- neither of which is a broader-prefix match. Both are hardcoded to production's port 8787, which the playbook explicitly says never to use for sandbox testing (the sandbox deploy uses OS-assigned ports located via `node scripts/sandbox-deploy.mjs env --sprint-id`; this run's sandbox was on APRA_FLEET_PORT=61881 / SUPERVISOR_PORT=61883). No entry in either file covers a curl call to any sandbox endpoint at all. Per Step 0a I did not proceed with any test execution and did not touch apra-fleet-v6t7.3, apra-fleet-v6t7.2, or the verify-set bead apra-fleet-v6t7.1 -- all left untouched/open. I did locate and tear down this cycle's sandbox deploy (node scripts/sandbox-deploy.mjs env/teardown --sprint-id apra-fleet-v6t7-f038e3aa-f2f1-4c08-b9df-a9acb8390330), which succeeded cleanly, since that command family is fully covered and independent of the missing curl grant. The orchestrator/operator needs to run compose_permissions to add a broad curl grant (e.g. Bash(curl *) or Bash(curl:*)) covering arbitrary localhost ports/paths before this cycle's integration testing can proceed; I did not add it myself per the NEVER-self-grant rule. (bugs filed: none) | C4: Blocked at Step 0a before running anything: integ-test-playbook.md's Permissions section requires generic `curl ...` access to drive the sandbox supervisor's HTTP API, but the only curl entries in .claude/settings.json / .claude/settings.local.json (`Bash(curl * localhost:8787/api/sprints*)`, `Bash(curl * localhost:8787/api/reservations/*)`) are narrowly pinned to production port 8787, which the playbook explicitly forbids using for the sandbox deploy (sandbox uses its own OS-assigned APRA_FLEET_PORT/SUPERVISOR_PORT instead). No broader curl allow entry exists to cover the sandbox's ports. All other required prefixes (npm test, npm run build:ui, npm run, npx vitest, bd, node scripts/sandbox-deploy.mjs) are already covered by existing broader entries. Per the integ-test-runner contract, stopped immediately without testing feature apra-fleet-v6t7.2 or apra-fleet-v6t7.3, without closing or filing bugs against either, and without locating or tearing down the sandbox for sprintId apra-fleet-v6t7-f038e3aa-f2f1-4c08-b9df-a9acb8390330 -- an operator must add a curl allowlist entry broad enough to cover arbitrary host:port before this run can proceed. (bugs filed: none)

## Reviewer-proposed newTask rejections

1 newTask(s) rejected before reaching bd create: C5: title fails safe-character allowlist /^[A-Za-z0-9 .,:;!?()'_/+[\]-]+$/ (or is empty): "Console /ui and /api/fleet/* bypass all auth and are exposed when APRA_FLEET_HOST is non-loopback"

## Final verdict

FAIL -- Diff reviewed as a whole vs the true fork point (local v0.5_dashboard ref was stale at 8688e007; origin/v0.5_dashboard=cecd3e07 is the real base -- 16 commits, 32 files, +3232/-41). Gates: git status clean, npm run build exit 0, npm test exit 0 (vitest 348 files passed/6 skipped incl. apra-fleet-shell-ui test/app.test.tsx; apra-fleet-se 468/468; apra-pm pass=4227 fail=0).

What genuinely landed and is good: src/console/{server,static,local-api,routes/fleet}.ts implement the seam cleanly -- explicit ROUTE_MODULES list (no glob, SEA-safe), one delegation line in src/services/http-transport.ts:191 before the /mcp 404, and the interim inline route is fully gone (grep for serveUiAsset|uiContentType|resolveDefaultShellDistDir in http-transport.ts returns nothing; the only index.html-serving code in src/ is console/static.ts). /api/fleet/members is produced in-process via listMembers (no HTTP self-call). Traversal guard runs pre-lookup and is tested for ../, encoded ../, C:\, UNC and //server shapes; asset-vs-route split (404 for /ui/assets/missing-hash.js, index.html for client routes) is covered in tests/console-static.test.ts and tests/console-server.test.ts. dist-pm prune (apra-fleet-v6t7.4) and the supervisor budget/diagnostic work (v6t7.7/.8/.9) match their criteria. UI packages are ASCII-clean, no cloud/tenant/auth-provider identifiers, vite base '/ui/', dist ignored, no stray lockfile.

Why FAIL:
1. apra-fleet-v6t7.3 (P1) is entirely unimplemented. scripts/gen-sea-config.mjs still has no ui/ asset section (no collectPackageTree over packages/apra-fleet-shell-ui/dist), src/cli/install.ts is untouched, tests/sea-http-verify.test.ts unextended, no binary smoke transcript. src/console/static.ts has a SEA reader path but nothing ever packs ui/ assets, so the binary can never serve /ui. The epic's headline criterion ('apra-fleet run ... from the SEA binary answers GET /ui 200') is unmet.
2. apra-fleet-v6t7.2 is still OPEN: child .2.2 IN_PROGRESS (lease expired) and the [test] child .2.3 OPEN, even though the static impl and tests/console-server.test.ts are on disk and green -- the implementation looks complete; the beads were simply never closed with evidence.
3. apra-fleet-v6t7.5 (P1) OPEN: the post-migration sandbox-deploy /ui smoke reconcile was never performed. Only the 404 self-diagnosing message (scripts/sandbox-deploy.mjs:564) landed; no run proving smoke reports ui=ok against the migrated seam.
4. No integration evidence: 2 of 5 cycles aborted at the permission gate (playbook needs generic curl; only port-8787-pinned grants exist), so /ui has never been exercised against a real sandbox deploy.

No already-closed bead showed a defect, so reopenIds is empty; secondary findings are filed as newTasks.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Stopped at Step 0 (permissions check) before running any part of the regression pass, per the playbook's Permissions section and dispatch instructions to STOP if any required command prefix is uncovered. The merged effective permission set (.claude/settings.json union .claude/settings.local.json) is missing coverage for two required prefixes: Bash(curl:*) (only narrow grants exist for localhost:8787 /api/sprints* and /api/reservations/*, which do not cover the smoke test's SUPERVISOR_PORT 18701 endpoints /api/health, /api/shutdown, /api/sprints/:id, /api/members needed in Setup, Test scenario, and Teardown), and Bash(kill:*) (no entry at all, needed for the supervisor readiness loop's kill -0/kill -9 calls in Setup, Reset, and Teardown). No sandbox was ever brought up, so no Teardown was needed. This is informational only and never gates the current sprint; the orchestrator/operator should run compose_permissions to grant Bash(curl:*) and Bash(kill:*) so a future run can proceed. Note: the apra-fleet MCP server was unreachable this session (ConnectionRefused), which also blocked the Step 0 Knowledge Bank priming and would block compose_permissions itself -- that connectivity issue should be resolved first.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
