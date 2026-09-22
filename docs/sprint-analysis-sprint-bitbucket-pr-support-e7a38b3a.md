# Sprint Analysis: sprint/bitbucket-pr-support

Scope issue id(s): apra-fleet-qeq1.
Base branch: main.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [8, 8, 12].
High-water-mark closed count this sprint: 14.
Final closed count: 12.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
Integration test failures (2): C1: Stopped at Step 0a permission preflight before running any tests or bd commands. Mechanically computed the union of permissions.allow across .claude/settings.json and .claude/settings.local.json in this checkout: npm test/npm run (covered by Bash(npm:*)), npx vitest (covered by Bash(npx:*)), and node scripts/sandbox-deploy.mjs (covered explicitly and by Bash(node:*)) are all covered, but the bd command family required throughout integ-test-playbook.md (bd show, bd dep list, bd close, bd create, bd search, bd update) has no covering entry in either file. No open features were in scope this cycle (none to test), but the two verify-set beads apra-fleet-qeq1.6 and apra-fleet-qeq1.5 could not be verified or closed because doing so requires bd. No tests were run, no beads were read/closed/created, and no sandbox teardown was attempted. Please run compose_permissions to add a bd grant (e.g. Bash(bd:*)) to .claude/settings.local.json, or land a team PR adding it to .claude/settings.json, then re-dispatch this cycle's verification. (bugs filed: none) | C2: Stopped at Step 0a before running any tests: integ-test-playbook.md's Permissions section requires the `bd ...` command family (e.g. Bash(bd *)), but the mechanically-computed union of permissions.allow from .claude/settings.json and .claude/settings.local.json contains no entry covering `bd` (no Bash(bd:*), Bash(bd *), or broader Bash(*) wildcard) -- all other required families (npm test/run, npx vitest, node scripts/sandbox-deploy.mjs) are covered. Since the playbook's entire procedure (bd show, bd dep list, bd close, bd create, bd search, bd update) depends on `bd`, no feature testing and no verify-set verification (apra-fleet-qeq1.6, apra-fleet-qeq1.5) could be performed. No beads were read or modified, no sandbox was located or torn down. Missing grant needed: an entry such as Bash(bd:*) added to .claude/settings.local.json via the compose_permissions MCP tool (never hand-edited). (bugs filed: none)

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed the net diff origin/main..sprint/bitbucket-pr-support (22 files, +2668/-52). NOTE: local main is stale at eab8cbd6; the real base is origin/main fa0888f9 -- diffing against local main shows a spurious 855-file delta.

All 9 closed child beads trace to specific lines:
- qeq1.1/.5 vcs_username pair: src/tools/vcs-credential-exec.ts (needsUsername gate, username_empty typed refusal that dispatches nothing, dual-marker redaction) + tests/vcs-credential-exec-username.test.ts. Client JSDoc (packages/apra-fleet-client/src/client/api.mjs) and the tool-registry description are synced, per the repo rule that the client must track tool changes.
- qeq1.2 parseRepoRef/repoRefHint in bitbucket.mjs. Verified by standalone repro: ssh/https/altssh parse correctly, while bitbucket.org.evil.example, github.com, 1- and 3-segment paths and non-strings all return null -- no partial guessing, no host confusion.
- qeq1.3 create-pull-request builder plus the nested links.html.href response mapping; logSafeCommand redacts BOTH credential halves.
- qeq1.4 capabilitiesForHost flip landed LAST (30287ba2 after 278ab83e), exactly as the epic required.
- qeq1.9 buildProvisionArgs/authRemedy plus the new skip:true contract in vcs-auth.mjs.
- qeq1.7 gitignore, qeq1.8 mock harness.

Security: no plaintext credential in any orchestrator-readable field; api_token is always a secret placeholder; the live E2E lane is opt-in with no default secret name.

Tests: packages/apra-fleet-se 3991 pass / 0 fail / 12 skipped. Root vitest 329 files pass, 1 FAIL: tests/integ-test-playbook-reset-portclean.test.ts. That failure is ENVIRONMENTAL, not a regression -- the test binds a hardcoded port 3001 and a foreign process currently holds 3001 on this machine (confirmed via ss); the diff touches neither that test nor integ-test-playbook.md. Build passes; working tree clean.

Gaps filed as newTasks (none defeat a child bead's own criteria): (1) the epic's headline criterion -- a real PR on a real Bitbucket remote -- is still UNVERIFIED; every layer is pinned by mocked tests but the live lane has never run. (2) Bitbucket's push+pr skip makes the reactive PR auth self-heal a no-op that still logs 'self-heal completed' and retries an identical command. (3) The already-exists dialect is deliberately absent (correct per the epic), so a duplicate PR reports as a hard failure. (4)/(5) port-3001 test robustness and the missing bd permission grant that blocked integ verification in 2 of 3 cycles.

KB: promoted 32c38127 and bf9a2665, both independently verified this review. NOT promoting b06081e7 -- the current tree contradicts it: tests/code-intelligence-registry-wiring.test.ts:40 imports registerAllTools from tool-registry.ts, so the handler bodies are no longer unpinned.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Stopped at Step 0 permissions check before running any part of regression-test-playbook.md: the merged effective permission set (union of .claude/settings.json and .claude/settings.local.json permissions.allow) has no entry covering the Bash(kill:*) prefix the playbook's Permissions section requires for the identity-checked supervisor kill -0/kill -9 calls in Setup, Reset, and Teardown. No broader entry in either file (Bash(node:*), Bash(bd:*), etc.) covers kill. Neither Part 1 (real-bd suite) nor Part 2 (smoke test) was run, and no sandbox was ever brought up, so there is nothing to tear down. This result is informational and does not gate the sprint's verdict. Requesting the orchestrator/operator run compose_permissions to add Bash(kill:*) to .claude/settings.local.json, after which this run should be retried.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
