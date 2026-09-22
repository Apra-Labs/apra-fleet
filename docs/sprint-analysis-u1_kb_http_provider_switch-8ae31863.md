# Sprint Analysis: u1_kb_http_provider_switch

Scope issue id(s): my-beads-db-0cd.
Base branch: main.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [12, 13].
High-water-mark closed count this sprint: 13.
Final closed count: 13.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

Deploy failures (2): C1: Deployer dispatch failed: [Workflow Error] Agent dispatch failed (dispatch_failed): [FAIL] Failed to execute prompt on "repo4-apra-fleet": Command exceeded max total time of 9000000ms | C2: Deployer dispatch failed: [Workflow Error] Agent dispatch failed (dispatch_failed): [FAIL] Failed to execute prompt on "repo4-apra-fleet": Command exceeded max total time of 9000000ms
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- SCOPE: reviewed b80024ad..u1_kb_http_provider_switch (the 16 sprint commits). Literal main..branch is 787 files/101k lines because local main is stale by ~40 merged upstream commits; the real sprint delta is 22 files, 1554 insertions.

my-beads-db-0cd acceptance criteria, all verified in code:
1. getKbProviders selects by config: kb-providers.ts selectProjectProvider() returns HttpKbProvider only for provider='http' with url+token, else the already-built SqliteProvider (kb-providers.ts:53-113). New reader src/services/knowledge/kb-config.ts decrypts token_encrypted and never touches it on the sqlite path.
2. HttpKbProvider is constructed with the project SqliteProvider as explicit fallback (kb-providers.ts:110) -- no new no-arg `new SqliteProvider()`; kb-single-accessor NO_ARG_ALLOWLIST is unchanged (2 entries) and passes.
3/4. Real-implementation tests, no mocks: kb-providers-http-selection (14), kb-sqlite-stock-and-http-guard (13), kb-http-provider-e2e (4, real kb_setup + live node http server), kb-config (75 lines), require-sqlite-project. All green. kb-remote-url-forwarding was correctly converted from object-literal stubs to real SqliteProvider fixtures (instanceof guard would otherwise throw first).

GATES: npm run build exit 0. git status clean. npm test exit 1 -- vitest 4658 pass / 4 fail, apra-fleet-se 4 fail. Every failure is environmental and in files this diff does not touch: symlink EPERM (phase0-seams-facade, phase1-leaf-facade), bd/Dolt init (2cc-win-bd-invocation, check-sandbox-sync-remote), and two 5s-timeout flakes (register-member compose_permissions 5030ms, strategy-process-tree-kill 5158ms). Matches CONFIRMED KB entry ac6e8e9b. No KB test failed.

DEPLOY: failed in BOTH cycles with the same 9000000ms timeout. This branch's f20ee73a routes fleet-sprint's Deploy phase to Sandbox Deploy in deploy.md, but C2 still stalled identically -- the docs-only fix is unvalidated. Filed as a task; it does not gate this bead's criteria, which are fully covered by the local e2e server test.

EVIDENCE CAVEAT: the dispatch block claims '0 beads open at or above P1/P2', but `bd show my-beads-db-0cd` reports it OPEN at P1 and it has no children. The closure summary is not reliable; this verdict rests on the diff and the suite, not the counts.

SECONDARY FINDINGS (filed as newTasks, none block the criteria): user-directive clamp is bypassed over HTTP; `kb serve` now inherits an http project provider; run-all-tests.mjs timeout does not reap the Windows process tree; kb_stats bible is now a union shape.

PROMOTIONS: 1 (the _warnedMalformedKbConfig reset coupling). Deliberately NOT promoted: fe0d4dd7, 40350759, a712a65d -- each describes the pre-fix state this branch repaired and is now false at HEAD.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Halted at Step 0 (permissions check) before running anything: regression-test-playbook.md's ## Permissions section requires Bash(node dist/index.js *), Bash(node:*) (covers scripts/sandbox-lock.mjs, kill-port.mjs, reap-sandbox-dolt.mjs, sandbox-seed-beads.mjs, check-sandbox-sync-remote.mjs, check-toy-doer-credentials.mjs, and scripts/run-integ-suites.mjs), Bash(node scripts/run-integ-suites.mjs *), and Bash(npm run test:slow*) -- none of these are covered by any entry in the merged union of .claude/settings.json and .claude/settings.local.json (the narrow Bash(*apra-fleet* start/run/--version) and Bash(node scripts/preflight-clear-build-locks.mjs*)/Bash(node scripts/sandbox-deploy.mjs *) grants do not match node dist/index.js or the other bare node/npm invocations the playbook needs, and no Bash(node:*) or Bash(npm:*) class entry exists in either file). Additionally, Part 1's own documented command 'npm run test:integration --workspace=@apralabs/apra-fleet-se' is uncovered too (no Bash(npm run test:integration*) or broader npm entry) -- requesting it now avoids a second halt on the next attempt. Per the role contract this is a hard stop: I did not run Part 1 (real-bd suite) or Part 2 (smoke test) setup, so suitePassed and smokePassed are false because nothing executed, not because anything failed. No carry-over bug was filed (a provisioning gap is not a regression finding). Separately, before halting I ran the leftover sandbox-deploy sweep for this sprint's own deploy (permitted via the verbatim Bash(node scripts/sandbox-deploy.mjs *) grant) -- it found and removed real leftovers (C:\Users\ushah\tmp\fleet-sandbox-my-beads-db-0cd-f29e0baf-cf0b-4147-a9d7--9f6b35a7 and its sibling .env marker), so that cleanup is done regardless of this halt. Requesting the orchestrator/operator run compose_permissions to add: Bash(node:*), Bash(npm run test:slow*), and Bash(npm run test:integration*) (or equivalently broader Bash(npm:*)), then re-dispatch. This result is informational only and does not gate the current sprint's verdict.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
