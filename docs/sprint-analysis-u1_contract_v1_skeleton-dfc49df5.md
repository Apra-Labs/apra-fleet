# Sprint Analysis: u1_contract_v1_skeleton

Scope issue id(s): my-beads-db-27m.
Base branch: main.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [21, 27].
High-water-mark closed count this sprint: 27.
Final closed count: 27.
Final open-at-goal-priority count: 8.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Reviewed net diff main..u1_contract_v1_skeleton (87 files, +5717/-250) against epic my-beads-db-27m's own acceptance criteria, not bead counts.

WHAT ACTUALLY LANDED (verified line-by-line): (1) memory-contract/v1 skeleton + README + INVENTORY.md (584 lines) -- bead .3, .2; (2) zod->JSON Schema 2020-12 generation path proven in tests/GENERATOR-DECISION.md + postprocess-2020-12.mjs -- bead .4; (3) contract:generate wired (memory-contract/v1/generate-contract.mjs, package.json:56) emitting 46 schema files for 23 tools with metaschema validation -- I re-ran `npm run contract:generate` after `npm run build` and `git status --porcelain` was empty, so the byte-idempotency claim holds; (4) postprocess fix-2 container-awareness (JSON-Pointer state machine, postprocess-2020-12.mjs:164-182) plus 9 unit tests in tests/memory-contract-postprocess-2020-12.test.ts -- beads .29/.31; (5) a real port bug fixed in src/services/http-transport.ts listenOnPort (close-and-relisten when the OS hands back a fetch-blocked port) -- bead .17; (6) the beads-export shrink guard (packages/apra-fleet-se/apra-pm/lib/export-shrink-guard.mjs + inline copy buildExportShrinkGuardCmd in auto-sprint.js:1280-1336, 253 lines of tests) -- bead .12; I verified the argv fix separately: `node -e "..." "<repo>"` puts the path at process.argv[1], which is what the inline copy reads; (7) apra-pm suite now runs from root npm test (scripts/run-all-tests.mjs:14-18) -- bead .16, confirmed by 456 apra-pm tests executing locally; (8) per-test timeout sizing across register-member, bootstrap-gate, 2cc-win, kb-bible-v2, task-wrapper, relay-queue -- beads .13/.14/.15/.24/.25/.27/.30/.32. Every one of those target tests PASSED in my full run (register-member AC3 39.7s, 2cc-win 16.4s, bootstrap-gate 17.3s, relay-queue depth-cap 14.4s, workspace-isolation local-events 0.37s, zero 'bad port' occurrences in the whole run). No skips, no disabled tests -- the stabilizations are real per-test budgets, and file hygiene is clean (no temp files, no stray tool config; .gitignore /.rev/ is bead .26).

WHY FAIL -- epic AC, four clauses unmet, none of them attributable to host flake:
1. "Round-trip harness green: every inventoried tool validates request and response against the live sqlite provider" -- the epic's own stated EXIT CRITERION. No validator exists in the diff; bead .9 is still open. Nothing in this branch validates a single real response against a schema.
2. "Drift guard live in CI and proven by a deliberate dry-run failure" -- `git diff main..branch --stat -- .github/` is EMPTY. No CI job regenerates schemas or diffs them; bead .10 open. contract:generate exists but nothing enforces it.
3. "Degradation list + fixtures handed to T7" -- memory-contract/v1/fixtures/ contains only .gitkeep; bead .8 open.
4. "All four layers present or explicitly stubbed with a named owner" -- bindings/mcp/ and bindings/openapi/ are .gitkeep only and README.md names no owner for either; taxonomy.json and methods.json do not exist (beads .7, .18, .20 open). Layer 3/4 are unnamed empty dirs, not owned stubs.

Also: the published response schemas are provably wrong against the real envelope. src/services/tool-registry.ts:94-114 (wrapTool) can return up to THREE content blocks, each optionally carrying `annotations`, plus a top-level `structuredContent`; every emitted *.response.json (e.g. memory-contract/v1/schemas/kb_capture.response.json) pins `maxItems: 1`, omits `annotations`, and sets `additionalProperties: false` at the root. A real kb_capture response with a display preamble would fail its own published contract. This is exactly what the missing round-trip validator (.9) would have caught. Bead .33 already tracks it, so no duplicate task filed.

TEST SUITE: TEST_EXIT=1. vitest 2 failed / 296 passed / 8 skipped (4163 tests passed, 2 failed); apra-fleet-se 1926 pass / 0 fail; apra-pm 456 pass / 0 fail. Both failures are 5000ms vitest-default timeouts in files this diff does NOT touch: tests/strategy.test.ts:24 (execCommand runs command locally, 5023ms, plus a cascading EBUSY rmdir in its afterEach at line 21) which is bead .28 -- in_progress, never closed, so correctly NOT in reopenIds; and tests/knowledge/kb-freshness.test.ts:61 which no bead tracks (filed as a newTask). Neither is a regression from this branch, but the suite is red, so the epic cannot pass on the AC's "existing regression still green" clause either.

NO REOPENS. I checked the two closed beads whose correctness I was otherwise taking on faith. Bead .2 (arbiter of tool count): counted the registered surface directly in src/services/tool-registry.ts -- 16 `server.tool('kb_*')` + 7 `server.tool('code_*')` = 23, matching INVENTORY.md section 1 and the generator's EXPECTED_TOOL_COUNT, so 23 stands against the source plan's 24. Bead .17: its stated acceptance (workspace-isolation passes in a loaded full run) is met via the shared http-transport fix even though the named test file is untouched -- legitimate, the root cause was in the transport, not the test. Bead .3 delivered exactly what its narrowed scope asked (directories only, README sole-writer); the README defects are documentation drift caused by later work landing, filed as a newTask rather than a reopen.

KB CORRECTIONS (code wins over the entry): entry a4aa8111 ("Root npm test skips the apra-pm suite; only CI runs those 452 tests") is now FALSE against this tree -- scripts/run-all-tests.mjs:14-18 adds the apra-pm suite and 456 of its tests ran locally in my invocation. Entry ac6e8e9b ("four npm test files fail on a stock Windows host independent of any change") no longer reproduces: eft-41, 2cc-win-bd-invocation-integ, register-member and register-member-bootstrap-gate all passed this run post-stabilization. Both should be re-graded rather than trusted as-is. Entry b3e7d6ae/dc31de24's specific relay-queue numbers did not reproduce either (whole file 15.2s, depth-cap case 14.4s here vs the cited 12.8s/17.4s), so I left those INFERRED rather than promote on a number I measured differently.

PROMOTED (5): kb entries for the wrapTool/response-schema mismatch, contract:generate dist-read + byte-idempotency, the export-guard id-set predicate, the container-aware definitions rename, and the two blocked-port entries' premise -- `netsh int ipv4 show dynamicport tcp` on this host reports Start Port 1024, which genuinely overlaps undici's badPorts (verified 82 entries, max 10080, in node_modules/undici/lib/web/fetch/constants.js), so the retry loop guards a reachable condition, not dead code.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: apra-fleet-jr33, apra-fleet-4qsl, apra-fleet-lnnf, apra-fleet-jtff, apra-fleet-t4x6, apra-fleet-iq3v, apra-fleet-75q4, apra-fleet-req0.
Summary: Ran a full regression pass per regression-test-playbook.md at branch u1_contract_v1_skeleton @ 18323f31. Part 1 (real-bd suite, via scripts/run-integ-suites.mjs against real bd, no fail-fast): all 196 discovered files completed (~29.6 min wall clock); 11 test files failed and 14 files exceeded the 300s single-file duration budget. After deduping against existing [carry-over]/[integ] beads, 3 of the 11 failures plus the budget-overshoot pattern matched pre-existing tracked issues (apra-fleet-w7ee golden-transcript snapshot divergence, apra-fleet-mmxx f34 member_detail MCP adapter gap, apra-fleet-eft.17 single-file budget) and were updated with this cycle's fresh confirmation notes rather than duplicated; 8 new standalone parent-less bugs were filed for the remaining previously-untracked failures (bd-init-templating spawn error, error-classification-routing-table and mock-sprint-watchdog-timeout-sync-teardown post-dispatch-sync-not-run-after-watchdog_timeout, final-review-auth-self-heal and vcs-auth-preflight PostDispatchSyncError/non-JSON dolt-mutex-mcp responses, mock-sprint-doer-max-turns-session-guard missing stop_prompt call, mock-sprint-happy-path non-determinism across runs, mock-sprint-planner-auth-failure-no-retry unexpected real bd dolt pull spawn). Part 2 (sandbox smoke test): Setup completed cleanly (install, server up on scratch port 18700, toy repo clone, git identity seed, sandbox beads seed + isolation guard all passed), but the Test scenario's step 3a (credential provisioning) was denied by the Claude Code auto-mode classifier before any node process ran; per this repo's explicit policy against routing around permission blocks, no workaround was attempted, so steps 1-6 of the Test scenario did not execute this cycle. This exact failure mode is a pre-existing tracked issue (apra-fleet-j48h, updated with this cycle's confirmation), not a new product regression. Teardown ran immediately and unconditionally afterward (server stopped, sandbox directory removed) and was independently verified. This entire result is informational: it does not gate the current sprint's PASS/FAIL verdict, and every filed/updated bug is a pre-existing, parent-less carry-over that will be picked up in a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
</content>
</invoke>
