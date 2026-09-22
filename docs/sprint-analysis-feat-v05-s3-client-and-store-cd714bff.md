# Sprint Analysis: feat/v05-s3-client-and-store

Scope issue id(s): apra-fleet-972p.
Base branch: v0.5_dashboard.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [24].
High-water-mark closed count this sprint: 24.
Final closed count: 24.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

1 newTask(s) rejected before reaching bd create: C1: title fails safe-character allowlist /^[A-Za-z0-9 .,:;!?()'_/+[\]-]+$/ (or is empty): "apra-fleet-client exports ./auth/* and ./registration/* resolve to non-existent directories"

## Final verdict

PASS -- Reviewed net diff v0.5_dashboard..feat/v05-s3-client-and-store (20 files, +3859/-28) against apra-fleet-972p and its 23 descendants. Gates: npm run build exit 0; npm test exit 0 (root vitest 4667 pass/0 fail/61 skip; apra-fleet-se node:test SUMMARY pass=4016 fail=0). Working tree clean apart from an untracked .beads.gate.lock (bd runtime lock, not a code artifact).

AC verification:
- 972p.1 (client C1): 7 wrappers in src/client/api.mjs map to real registry tools (tool-registry.ts lines 140/150/152/159/165/241 + revoke-vcs-auth.ts, stop-prompt.ts); each has a fleet-client-api.test.mjs case; doc-parity test pins exactly 32 methods and now also flags stale docs (972p.9 satisfied - the old tautological count assertion is gone, reverse check scoped to the `class ApraFleet` section with vacuity guards). beads/normalize.mjs is a faithful copy of the 5 pure helpers in supervisor/backlog.mjs (verified by comment-stripped diff); subpath resolution is proven from a sibling package (apra-fleet-workflow test), not just relatively.
- 972p.2/.7/.8/.10/.11/.12/.13 (F3 OOB): credentialStoreSet returns {text, structuredContent} which wrapTool already supports (tool-registry.ts:95-116); auth-web TTL_MS exported so expiresAt cannot drift; collectOobUrl has a bounded 5s listen backstop that calls outcome.close() (972p.7), covered by fake-timer tests asserting both the fire and the not-yet-fired case; launchAuthWeb mock now defaults to 'unavailable'. auth-socket.ts and credential-store-set.ts are ASCII-clean and use [FAIL]/[OK]; no new non-ASCII anywhere in the diff.
- 972p.3 (store): db.mjs derives the path from the FLEET_SE_DATA_DIR knob only, sets PRAGMA foreign_keys=ON and WAL, migrations are per-transaction + idempotent; 45 store tests incl. FK rejection, cascade, rollback-on-failing-migration, reopen idempotence.
- 972p.4/.5/.6 (routes): single checkBeadsRemote gate reused by POST and PUT (pinned by a one-call-site assertion), PUT probes only on a genuinely changed non-empty remote and 400s before updateProject, 201/400/404/409 all covered, plus a no-'git remote add'/'git init' invariant and an unmounted guard.

No reopen warranted. Secondary findings raised as newTasks: (1) probeBeadsRemote interpolates the operator-supplied remote unquoted into a shell command run on a member (projects.mjs:62) - must be validated/escaped before the module is mounted; (2) package.json exports ./auth/* and ./registration/* point at directories that do not exist; (3) api-reference.md promises subpath-export docs it does not contain; (4) nothing tracks the supervisor-side import swap, so two copies of the helpers can drift; (5) the unmounted guard scans only src/supervisor/**, not bin/serve.mjs; (6) pre-existing non-ASCII remains in auth-web.ts and tests/auth-socket.test.ts; (7) docs/secret-variables.md still documents credential_store_set as blocking.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Regression run blocked at the Step 0 permissions check before any test code ran. regression-test-playbook.md's ## Permissions section requires Bash(curl:*) (to drive the sandbox supervisor's HTTP API on port 18701 for POST /api/sprints, GET /api/sprints/:id, GET /api/members, POST /api/shutdown, GET /api/health in ## Setup, ## Test scenario, and ## Teardown) and Bash(kill:*) (for the supervisor-boot identity check and stop steps' kill -0/kill -9 calls in ## Setup, ## Reset, and ## Teardown). Neither prefix is covered by the merged permissions.allow set of .claude/settings.json and .claude/settings.local.json: the only curl entries present are narrowly scoped to a different port and paths (localhost:8787/api/reservations/* and localhost:8787/api/sprints*), and no kill entry exists at all. Per the role's instructions, this stops the pass before Part 1 (real-bd suite) or Part 2 (sandbox smoke test) run, and no sandbox was ever brought up so no teardown was needed. This is a blocked/inconclusive run, not a pass or fail verdict, and it remains informational and non-gating for the sprint regardless. The orchestrator/operator should run compose_permissions to grant the missing prefixes (or narrower equivalents covering port 18701 and the documented kill usages) and re-dispatch this role.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
