# Sprint Analysis: feat/v05-s8-project-bind-health

Scope issue id(s): apra-fleet-vcnl.
Base branch: v0.5_dashboard.
Cycles run: 5.

## Progress

Closed-bead count history (per cycle evaluation): [10, 15, 16, 22, 26].
High-water-mark closed count this sprint: 31.
Final closed count: 26.
Final open-at-goal-priority count: 2.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
Integration test failures (2): C2: No open type=feature beads were in scope this cycle (empty list, a normal no-op). One verify-set bead, apra-fleet-vcnl.4 (project export/import CLI), was handed for verification-closure with all children now closed. Before running anything, Step 0a's permission check on integ-test-playbook.md's Permissions section found the merged .claude/settings.json + .claude/settings.local.json allowlist covers npm test, npm run, npm run build:ui, npx vitest, bd, and node scripts/sandbox-deploy.mjs, but NOT the required curl family in a form usable against the sandbox: the only curl grants are hardcoded to localhost:8787, the deprecated fixed port the playbook explicitly says never to use, while this cycle's actual sandbox deploy (sprintId apra-fleet-vcnl-b530d55e-89e4-4fc8-94ee-03b3555f8865) was located on OS-assigned ports APRA_FLEET_PORT=56168 / SUPERVISOR_PORT=56170 via `node scripts/sandbox-deploy.mjs env`. Per Step 0a I stopped immediately without running any feature or verify-set tests or filing fabricated results. I still located the sandbox and ran `node scripts/sandbox-deploy.mjs teardown --sprint-id apra-fleet-vcnl-b530d55e-89e4-4fc8-94ee-03b3555f8865` (exit 0, cleanly removed) since the dispatch prompt requires teardown pass-or-fail. apra-fleet-vcnl.4 was left open and untouched (no bug filed, since no evidence of an actual defect was gathered -- this is a tooling/permission block, not a test failure). Recommend the orchestrator/operator run compose_permissions to add a broad curl grant (e.g. Bash(curl *) or Bash(curl:*)) covering arbitrary localhost ports so future cycles can actually exercise the sandbox's HTTP API. (bugs filed: none) | C5: Ran Step 0a permission pre-check on integ-test-playbook.md before touching anything else. Its ## Permissions section requires a generic curl capability (Bash(curl *)) to drive the supervisor's HTTP API against the sandbox deploy, which the playbook states runs on OS-assigned ports and explicitly never 7523/8787. The merged effective permission set (.claude/settings.json union .claude/settings.local.json) only grants Bash(curl * localhost:8787/api/sprints*) and Bash(curl * localhost:8787/api/reservations/*) -- both hard-pinned to production port 8787 and two fixed API paths -- so curl calls against the sandbox's dynamically assigned port have no covering entry in either file. All other required families (npm test, npm run build:ui, npm run, npx vitest, bd, node scripts/sandbox-deploy.mjs) are covered by broad entries (npm:*, npx:*, bd:*, node:*). Per the role contract's Step 0a, this is a hard stop: 0 features were in scope this cycle (nothing to test there), and the verify-set bead apra-fleet-vcnl.17 was left untouched and open rather than verified with fabricated or partial evidence. No sandbox lifecycle command (including teardown) was run, since Step 0a precedes and blocks Step 0b entirely while any required permission is missing -- the sandbox for sprintId apra-fleet-vcnl-b530d55e-89e4-4fc8-94ee-03b3555f8865, if one exists, is still standing and needs teardown once permissions are fixed. No bd close, bd create, or bd update calls were made. The orchestrator/operator needs to add a broader curl grant (e.g. Bash(curl *) or Bash(curl:*)) via compose_permissions before this role can proceed on this playbook. (bugs filed: none)

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed the real net diff. NOTE: local v0.5_dashboard is 43 commits stale; true merge base is cc105c14 (origin/v0.5_dashboard..branch = 22 commits). Sprint diff is 15 files / +6464, all in packages/apra-fleet-se except one tracked exception.

VERIFIED AGAINST EPIC ACCEPTANCE CRITERIA (read the code, not the bead counts):
- W2 overview derivable from buildOverview (projects.mjs:512) - groups by origin_slug, noCheckout, backlog member always present, degrades to null live columns on listMembers failure.
- All 8 doc s3.1 S5 health checks exist as named exports in health.mjs (doltDataReachable, backlogCloneStatus, groupHasCodeMember, bibleInSync, beadsDirSyncRemote, memberDirty, vcsExpiry, staleProbe) with 43 OK/WARN/FAIL unit tests.
- se.mjs export/import round-trips incl. createdAt; live-run refusal covers members bound in the TARGET store, not only those named in the payload (se.mjs:139-161); exit codes 1/2/3 pinned.
- A10 honored exactly: cloneStep refuses a dirty or foreign-origin checkout and never touches it (checkout.mjs:533-539); re-run reports every step skipped with zero mutating calls.
- W3 git drawer returns every specified field; no-checkout returns {checkout:null,'no git checkout',workFolder,vcs}.
- registerGitRoutes is mounted from registerProjectRoutes (routes/projects.mjs:495), so routes are live with no serve.mjs edit.

SECURITY (real fix, not cosmetic): probeBeadsRemote previously interpolated `git ls-remote ${remote}` raw - an injection vector. Now screened via shellMetaCharError then quoted via quoteArg, with POSIX ('\'') vs PowerShell ('') branching that faithfully mirrors isPosixShell in src/utils/agent-helpers.ts:60. POST /api/projects strips client-supplied createdAt so the new store param cannot be spoofed (routes/projects.mjs:262, pinned by a test).

GATES: build exit 0; bounded runner npm test exit 0 - vitest 353 files / 5064 passed / 0 failed, apra-fleet-se SUMMARY pass=4443 fail=0; all 309 S8 cases PASS; git status clean.

HYGIENE: no temp files, no secrets, ASCII-only (CROSS_MARK built from code point), no bead ids in runtime strings. Every 'in particular' prohibition in the epic is honored - serve.mjs, src/registration/**, src/console/**, src/tools/**, src/types.ts, apra-fleet-client/**, shell-ui/**, ui-kit/** all untouched. package.json adds exactly one bin entry.

RESIDUALS (tracked, not blocking): (1) tests/knowledge/kb-remote-anchor-freshness.test.ts is still out of declared scope - deliberately sequenced, owned by open vcnl.16, blocked on apra-fleet-ivnk whose PR was never opened. Merging S8 lands the flake fix anyway, so this is scope purity, not correctness - but it needs post-merge reconciliation (newTask). (2) vcnl.17 open/unverified - a follow-up product gap, not this epic's deliverable. (3) Integ tests were blocked in 2/5 cycles by a missing curl grant, so the new HTTP routes were verified at unit level only, never over HTTP against a deployed sandbox; the permission gap is already tracked as apra-fleet-v6t7.12 (P1), the route-verification follow-through is not (newTask). (4) OWNER_PACKAGE='fleet-sprint' matches workflow.json with a drift guard, but the code itself flags re-verification once S7's manifest lands.

No reopens: I checked each closed bead's close reason against the code and the claims hold.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Stopped at Step 0 (permissions check) before bringing up any sandbox or running either part of the regression pass: regression-test-playbook.md's ## Permissions section requires Bash(curl:*) and Bash(kill:*) coverage, and neither is satisfied by the merged union of .claude/settings.json and .claude/settings.local.json -- the only curl entries present are narrowly scoped to 'localhost:8787/api/sprints*' and 'localhost:8787/api/reservations/*', which do not cover the playbook's actual calls to the sandbox supervisor on port 18701 (/api/health, /api/shutdown, /api/sprints, /api/sprints/:id, /api/members), and there is no kill entry at all to cover the supervisor readiness/stop kill -0/-9 calls. Per the role contract this requires an immediate stop with no test execution and no Teardown (nothing was ever brought up). Asking the orchestrator/operator to run compose_permissions to add Bash(curl:*) and Bash(kill:*) (or equivalently broadened entries) to .claude/settings.local.json before re-dispatching. This result is informational and does not gate the current sprint's verdict.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
