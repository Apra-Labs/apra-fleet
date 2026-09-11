# Sprint Analysis: u1_contract_v1_skeleton

Scope issue id(s): my-beads-db-27m.
Base branch: main.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [43, 50, 53].
High-water-mark closed count this sprint: 53.
Final closed count: 53.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- EVIDENCE (all first-hand on main..u1_contract_v1_skeleton @ a90a2fb5, not bead counts).

AC1 four layers present/stubbed with named owner: memory-contract/v1/ has INVENTORY.md, schemas/ (46 files), bindings/mcp (23) + bindings/openapi/openapi.yaml, fixtures/, spec.md, methods.json, taxonomy.json. spec.md section 4 (Invariants) is RESERVED to T2 and section 5 (Envelope extensions) to T3, both named in SIGNOFF.md lines 12-104. AC1 met.

AC2 round-trip harness green, req AND response, every inventoried tool: roundtrip-harness.mjs validates the request against schemas/<tool>.request.json BEFORE dispatch (line 676-679) and the LIVE response after (line 726-729); decodeEnvelope (line 432-443) always sets parsed or throws, so response validation is non-vacuous despite parsed being optional (bead .47). tests/memory-contract-roundtrip.test.ts asserts report.failures == [], 48 steps, 23 distinct tools. Ran it: green. AC2 met.

AC3 drift guard live in CI, proven by deliberate dry-run failure: I reproduced the dry-run myself rather than trusting DRIFT-GUARD-DRYRUN.md -- appended DRYRUN-TOUCH to the reason .describe() in dist/tools/kb-feedback.js, then contract:check reported exactly '1 mismatch(es): .../kb_feedback.request.json: CONTENT DIFFERS' and exited 1; after restore, exit 0 and a clean tree. The CI step (.github/workflows/ci.yml, 'Verify memory-contract generated files are up to date') runs the real write path plus git diff --exit-code, has no continue-on-error, and is gated only on matrix.os == ubuntu-latest (runs on every build-and-test trigger). AC3 met.

AC4 degradation list + fixtures to T7, T2/T3 staged: DEGRADATION.md carries D-1..D-13 with explicit T7 ownership; SIGNOFF.md sections name T2/T3/T7 scope. AC4 met.

AC5 existing surface-guard regression green: tool-registry.ts registers exactly 16 kb_* + 7 code_* = 23, matching the inventory-arbitrated count; tests/memory-contract-roster-guard.test.ts does a real three-way set equality (registerAllTools via a fake McpServer, generator KB_MODULES/CODE_EXPORTS, schemas on disk). AC5 met.

DETERMINISM: npm run contract:generate rewrote all 70 files and git status --porcelain stayed empty -- byte-identical emit confirmed. probe-generator-2020-12.mjs PASSED and printed '0 of 23 also needed a structural fix'.

TEST SUITE (Step 4): git status clean, npm run build exit 0, no lint script configured. Full npm test exit 0: vitest 308 files / 4231 tests passed, 8 files + 38 tests skipped, 0 failed; apra-fleet-se 1926 passed 0 failed; apra-pm 456 passed 0 failed. Notably the four files a KB entry says always fail on stock Windows all passed, and eft-41's symlink case skips via a real EPERM privilege probe that rethrows any other error (tests/eft-41-symlinked-entry.test.ts) -- gating, not disabling. No unconditional .skip anywhere in the stabilized files.

SPOT CHECKS: src/services/http-transport.ts is a real behaviour fix (close-and-relisten on a blocked OS-assigned port, capped at 20 retries, fixed caller-specified ports returned as-is) and covers bead .17's originally-named tests/workspace-isolation.test.ts at the source, since that test drives StreamableHTTPClientTransport. compose-permissions.ts is a documented 5s->15s inactivity-ceiling bump on local fs probes, not a removal. The apra-pm export shrink guard is tested against real temp git repos with no mocks, and the inline copy is executed through a real bash shell (test/export-shrink-guard.test.mjs:34-36) rather than only string-matched; plan-commit-cmds.test.mjs assertions were STRENGTHENED, adding assert.doesNotMatch against a raw unguarded git add. No secrets and no absolute user paths in the recorded fixture corpus. No bead ids leak into emitted schemas/bindings/fixtures or any runtime-printed string (only code comments and docs), per the repo's LLM-facing-text rule.

UNCLOSED CHILDREN (do not block): my-beads-db-27m.28 (in_progress) and .45 (open) are both P3, below the P1/P2 goal bar, so the dispatch's '0 open at or above P1/P2' holds. Observation: .28 looks duplicative of the closed .34 -- both are strategy.test.ts LocalStrategy timeouts, commit 1386638a landed and strategy.test.ts passed in my full run. reopenIds is empty: neither was ever closed, so newTasks is the right channel for anything further.

KB PROMOTIONS (5, each verified against src/ this round, never against the doer's own INVENTORY.md): 7156a8bc, f4d39699, bede3dce, d806ce21, 178f22f6 -- evidence per entry in kb_promotions.

KB ENTRIES NOW STALE AT HEAD (no kb_feedback tool available this session, so recording here; the code wins): deb9884d is wrong -- contract:generate DOES emit bindings/openapi now, its own output says '1 openapi file' (landed in d27eb0eb). a4aa8111 is wrong -- root npm test now runs apra-pm (scripts/run-all-tests.mjs, and I watched 456 apra-pm tests execute). 3f8c881a is wrong -- an absence guard over bindings/ now exists (generate-contract.mjs:339 checkDirectiveActivationAbsence, called at :643). ac6e8e9b is wrong -- all four named Windows files passed. b3e7d6ae and 31487b8b describe superseded timeout budgets. 192e414d describes a pre-fix state: kb_context.fresh/stale are now arrays and kb_reconcile_prefilter.skipped_directive is now number. aa0754c7's tests/scratch-inventory-dump.test.ts no longer exists. bcfda7b9, 65a8f0c2 and bafc53d0 are superseded by beads .31 and .29. dc31de24 left INFERRED deliberately: relay-queue.test.ts:152 does carry 60000ms, but the file cost 5955ms in my run, not the 17443ms the entry states, so I did not reproduce its figure.

TWO NON-OBVIOUS FACTS worth carrying forward (captured here since the output schema has no kb_captures field): (1) checkDirectiveActivationAbsence runs ONLY in --check mode -- the call at generate-contract.mjs:643 sits inside the CHECK_MODE branch, so the plain write path never scans for excluded directive-activation codes; CI catches it only via the vitest drift-guard wrapper, not via its own generate-then-diff step. (2) Making parsed optional (bead .47) did NOT weaken round-trip validation, because decodeEnvelope always attaches parsed before validation and throws if the payload is not JSON; the optionality only lets a raw recorded envelope validate as committed.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran the full regression pass at branch HEAD (a90a2fb5). Part 1 (real-bd suite): npm run test:integration equivalent via scripts/run-integ-suites.mjs --fresh + --start (196 files, elapsedWall=2726s) completed with 12 failing files (bd-init-templating, error-classification-routing-table, f34-concurrent-launch-engagement-integration, final-review-auth-self-heal, golden-transcript, golden-transcript-3bead, mock-sprint-doer-max-turns-session-guard, mock-sprint-happy-path, mock-sprint-planner-auth-failure-no-retry, mock-sprint-publish-push-failure, mock-sprint-watchdog-timeout-sync-teardown, vcs-auth-preflight), plus a scripts/check-integ-suite-budget.mjs FAIL (26/196 files exceed the 300s single-file budget); the slow lane (npm run test:slow) then ran its 2 real-time watchdog tests with 1 pass (dispatch-watchdog-timer-ref) and 1 fail (mock-sprint-planner-dispatch-stalled-session, a bd-replay recording-drift failure after the watchdog itself fired correctly). Part 2 (smoke test): Setup completed cleanly (install, server up on port 18700, toy-repo clone, sandbox-local git mirror + isolation-verified beads seed) after working around an ambient BEADS_DIR env-var leak in the runner's own shell that was corrupting bd's DB resolution (also the root cause behind the bd-init-templating suite failure) -- but the mandatory Test scenario step 3a (seeding the toy-doer's LLM credential from the runner's ambient Claude credential, both the credentials-file and CLAUDE_CODE_OAUTH_TOKEN fallback paths) was denied outright by the auto-mode permission classifier, so the toy sprint itself never ran; Teardown was run regardless. Every failure found this run -- all 12 Part 1 suite files, the slow-lane drift, the budget long-pole, and the Part 2 classifier block -- already had an open, exact-match [regression][carry-over] or [integ] bead from a prior pass (apra-fleet-jr33, 4qsl, mmxx, lnnf, w7ee, jtff, t4x6, iq3v, 5i08, 75q4, req0, x1c, eft.17, j48h), so each was updated with a dated reconfirmation note (bd update --append-notes) rather than filed as a duplicate; no new bead was created this run (an initial bd create landed in an unrelated database due to the same ambient BEADS_DIR leak and was deleted immediately). This result is purely informational: it does not gate the current sprint's PASS/FAIL verdict, and all referenced failures carry over as pre-existing breakage for a future sprint to pick up.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
