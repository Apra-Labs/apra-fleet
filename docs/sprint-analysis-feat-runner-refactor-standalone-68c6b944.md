# Sprint Analysis: feat/runner-refactor-standalone

Scope issue id(s): apra-fleet-3swo.
Base branch: main.
Cycles run: 10.

## Progress

Closed-bead count history (per cycle evaluation): [160, 162, 164, 165, 168, 168, 170, 172, 172, 174].
High-water-mark closed count this sprint: 180.
Final closed count: 174.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
Integration test failures (1): C3: Integ test runner failed to return a schema-valid report after repair attempts: [Workflow Error] LLM returned non-compliant JSON. Validation failed after 3 attempt(s) (2 repair(s) exhausted): Candidate 1: schema validation failed: data must be object (bugs filed: none)

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- REVIEWED main..feat/runner-refactor-standalone (208 commits, 189 files, +48036/-11171) against epic apra-fleet-3swo and its 70 children (0 open in scope; 0 open at goal priority P1/P2).

GATES RUN MYSELF, NOT TAKEN FROM THE SPRINT'S CLAIM. npm run build -> exit 0. Root `npx vitest run` -> 322 files passed / 6 skipped, 4581 tests passed / 61 skipped, 0 failures, exit 0, 367s. packages/apra-fleet-se `npm test` (node scripts/run-tests.mjs mock) -> # tests 3104, # pass 3100, # fail 0, # skipped 4, duration 198.5s, SUMMARY pass=3571 fail=0, exit 0 -- this includes the long phase4-move-only ANCHOR_DESYNC probe. `git status --porcelain` empty before and after. No `lint` script exists in either package (root scripts: build/test/... only), so lint is not applicable; the repo's equivalent gate, packages/apra-fleet-se/scripts/check-generic-boundary.mjs, I ran directly: 'Scanned 77 engine file(s). OK: no apra-fleet-specific assumptions in LLM-facing engine text.' Root `npm test` is just run-all-tests.mjs -> vitest + the se workspace suite, i.e. exactly the two I ran.

THE EPIC'S CENTRAL CLAIMS VERIFIED AT RUNTIME, NOT BY READING THE DIFF:
- runner.js 11,849 lines on main -> 3,118 at tip; 44 new fleet-sprint/*.mjs modules including all 12 phases/*.mjs and every module the epic named. Zero files deleted -- runner.js is a composition root plus facade.
- `migratedRoleNames()` returns all 13 roles. `inline-ladder-guard.checkModules({})` executed live: 57 files scanned, 0 violations. That is the load-bearing proof that no role dispatches twice, and it is a live check now rather than the vacuous `migratedRoles.length === 0` baseline it shipped as.
- Counted 12 `await dispatchRole(` call sites against 13 ROLE_POLICIES rows, and confirmed by object identity in node that ROLE_POLICIES['doer-resume'] === ROLE_POLICIES.doer.secondary -- so 12-vs-13 is correct by design, not a missed migration. The 13th dispatch path (reviewer) routes through runner.js's dispatchReview() helper, which stays in runner.js because it closes over mutable cycle state; review.mjs documents this at line 63.

SECURITY / FAILURE-PATH TRACING (not pattern-matching):
- New `vcs_credential_exec` tool (src/tools/vcs-credential-exec.ts) is sound. The token is read server-side and never enters any returned field; redactToken() scrubs stdout, stderr AND the thrown dispatch error message (which can quote the command); a command carrying neither placeholder is refused so the tool cannot become a second unguarded execute_command; an OS/shell with no credential-read implementation HARD-fails with reason 'unsupported_member_os' rather than warning and proceeding credential-less, per the CLAUDE.md rule. Dialect selection goes through isPosixShell(), so a windows+gitbash member correctly gets POSIX escaping -- covered by tests/vcs-credential-exec-inline-token.test.ts including the both-placeholders-in-one-command and no-plaintext-leak cases.
- The CLAUDE.md client-sync rule is honoured: packages/apra-fleet-client/src/client/api.mjs:661 exposes vcsCredentialExec, and member_reservation/provision_* structured responses are mirrored there too.
- The emoji-prefix false-success defect is genuinely CLOSED end to end, and I traced all three layers rather than trusting the comment: src/tools/provision-auth.ts + provision-vcs-auth.ts emit structuredContent with a boolean ok; tool-registry.ts wrapTool returns `structuredContent ? { content, structuredContent } : { content }`, so it survives the wrapper; vcs-auth.mjs provisionOutcome() branches on structuredContent.ok and only falls back to the ASCII ^\[FAIL\] prose test. I also confirmed the banner hazard is real -- wrapTool pushes `<apra-fleet-display>` preamble content with annotations.audience ['user'] BEFORE the real result, so an unfiltered content[0] read would return the banner; mcp-result.mjs resultText/toolErrorText skip exactly those two markers.
- install --force (src/cli/install.ts): traced the kill path. Stops the registered service first, escalates to killApraFleet() ONLY when every surviving pid was in the pre-stop snapshot (so a supervisor relaunch is reported, not signalled forever), and a ServiceManager.stop() that throws degrades to a warning rather than aborting. A registered service the guard stopped is restarted after the binary copy when nothing later would start it.
- scripts/sandbox-deploy.mjs port race: retries are bounded (MAX_PORT_BIND_ATTEMPTS=3) and gated on a PROVEN conflict (err.portConflict), never a blind retry; every failure path stopPid()s what it started before throwing; a failed teardown propagates rather than reporting a half-up sandbox as success; lostPortRace() polls for the same grace window teardown uses instead of probing once, which correctly distinguishes our own listener outliving its pid from a real foreign winner.
- execute-prompt fork normalisation: the forkRequested/explicitForkId disagreement is genuinely fixed by deriving both from one trimmed value, and the edge cases (fork:'', fork:'   ', padded real id) are each covered in tests/execute-prompt-fork-gates.test.ts.

TEST QUALITY is unusually high: the new guard tests record their own falsification evidence (e.g. inline-ladder-guard.test.mjs case (g) documents the exact mutation applied, the resulting failure, and the byte-for-byte restore), which is what makes the green suite meaningful rather than decorative.

HYGIENE: clean. No temp files, tool config, or unrelated scripts. The only added root-level file is docs/sprint-analysis-feat-runner-refactor-standalone-68c6b944.md, which is engine-written (fleet-sprint/sprint-report.mjs + phases/harvest.mjs own it) and keyed by a hash of the BRANCH name, so it is overwritten per run rather than accumulating. No bead ids leak into LLM-facing text (checked prompts.mjs and newtask-text.mjs); plan-reviewer.md's new `findings` contract uses generic BD-14 placeholders. Exactly one added line carries non-ASCII, and it is a pre-existing line on main merely relocated by a mock refactor (see task D).

WHY THIS IS A PASS DESPITE THE C3 INTEG FAILURE: the C3 failure was the integ-test-runner exhausting schema repair, not a product defect the diff failed to fix. I traced how that outcome is produced -- role-policies.mjs's integ-test-runner row sets degrade.classes ['schema','dispatch'] while only 'infra' maps to the inconclusive record -- and it is deliberate, documented behaviour predating this branch's tip, not a regression introduced here. It is nevertheless a real reporting defect (a schema-invalid report is no more test evidence than an envelope-less one), so it is filed as task A rather than left as prose.

STALE KB ENTRIES -- the code wins, flagging so later sessions do not trust them: (1) CONFIRMED entry 'scaledTimeout() is inert under apra-fleet-se npm test' no longer describes the tree -- package.json's test script is now `node scripts/run-tests.mjs mock`, and run-tests.mjs:49 exports APRA_FLEET_TEST_CONCURRENCY, so scaledTimeout scales as intended. (2) INFERRED 0b08f92a and 18ee0c5d ('inline-ladder-guard is silently inert / would still skip silently') are superseded by 4de91f61 -- the guard now throws. (3) INFERRED 3d6d4eb4 ('no guard scans for a bare push call') is contradicted by fleet-sprint/unbracketed-push-guard.mjs, which scans the shared guarded-module list per call site. (4) INFERRED 6b710fb0's unfalsifiable no-agent()-site case was fixed in apra-fleet-3swo.69. I could not call kb_feedback: no KB/MCP tools were exposed to this session (no ToolSearch, no kb_*, no code_* tools in the available tool set), so Step 0 tool calls were skipped and I worked from the KB entries embedded in the dispatch prompt plus direct verification.

PROMOTED 6 entries, each against evidence I produced this review (details in kb_promotions). Deliberately did NOT promote the four stale entries above, nor 0cc897b2 (its 'proven by mutation' claim needs a mutation run I did not perform), nor 10369c94/6452a7b7/375f2328 (wall-clock/cost claims I did not measure).

Nothing warrants reopening: every named bead is traceable to specific lines in this diff, including the 7.6 credential-read retirement -- readMemberVcsCredentialToken is gone from production entirely, while the documented KEEP buildCredentialReadCommand remains exported and tested.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: apra-fleet-x0mr, apra-fleet-wzmv.
Summary: Ran both parts of regression-test-playbook.md at branch HEAD. Part 1 (real-bd suite via scripts/run-integ-suites.mjs, resumed from a stale prior-session status file per the documented recovery procedure) completed all 261 discovered files with 2 failures -- phase1-leaf-facade-completeness.test.mjs (nested golden-transcript/mock-sprint sub-suites exceeding their 900s budget, a recurrence of the closed apra-fleet-80q3/3yuu bugs, re-filed as apra-fleet-x0mr) and phase4-move-only-completeness.test.mjs (bare 'test failed', filed as apra-fleet-wzmv) -- plus the slow lane (test:slow, 2 real-timer watchdog tests) passed clean (2/2). The suite also still fails its long-pole budget check (33/261 files over 300s), an already-tracked long-running perf issue (apra-fleet-eft.17, updated with today's numbers) rather than a new regression. Part 2 (sandbox smoke test) completed Setup fully (install, server boot on port 18700, toy-repo clone, sandbox-local beads seed and isolation-guard checks, supervisor boot on port 18701, all verified) but was blocked at Test scenario step 3a by the Claude Code auto-mode permission classifier denying the credential-seeding commands -- a known, repeatedly-recurring block (apra-fleet-j48h, updated with today's occurrence, no workaround attempted per this repo's permission-block policy), so steps 1-6 (member registration, canary check, sprint launch, and outcome assertions) never ran and no smokeEvidence could be captured. Teardown was run in full afterward regardless (supervisor stopped cleanly at 66s uptime, lock released, server stopped, sandbox rm -rf'd), working around the also-known macOS ps-etimes failure in the dolt-sql-server reap step (apra-fleet-jz2m, updated) by verifying manually via ps that no stray dolt sql-server processes remained before deleting the sandbox. Both new failures were filed as standalone, parent-less [regression][carry-over] beads (P2) after searching both [carry-over] and [integ] tags for duplicates; four pre-existing carry-over/tracking beads (eft.17, j48h, jz2m, jl71) were updated with fresh evidence rather than duplicated. This entire result is informational and does not gate the current sprint's PASS/FAIL verdict -- all filed/updated bugs carry over to a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
