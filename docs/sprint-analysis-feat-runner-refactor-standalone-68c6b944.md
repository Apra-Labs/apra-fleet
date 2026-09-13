# Sprint Analysis: feat/runner-refactor-standalone

Scope issue id(s): apra-fleet-3swo.
Base branch: main.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [144].
High-water-mark closed count this sprint: 144.
Final closed count: 144.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- REVIEWED main..feat/runner-refactor-standalone: 175 commits, 169 files, +45402/-10787. Working tree clean before and after the run.

GATES (all run by me, not taken on trust):
- `npm run build` -> BUILD_EXIT=0.
- `npm test` -> TEST_EXIT=0. Root vitest: 322 files passed / 6 skipped, 4578 tests passed, 0 failed (307s). apra-fleet-se workspace: 460 suites, 3055 tests, 3051 pass / 0 fail / 4 skipped. Combined SUMMARY pass=3515 fail=0.
- The prior cycle's FAIL reason (docs/sprint-analysis-...-68c6b944.md: tests/sandbox-deploy.test.ts losing an allocate-then-bind port race under full-suite concurrency) is fixed and green: sandbox-deploy.test.ts passed 23/23 in this same 8-way-concurrent run. I traced the fix rather than pattern-matching it -- scripts/sandbox-deploy.mjs now tags only PROVEN port conflicts (portConflictError + lostPortRace, which polls PORT_RELEASE_GRACE_MS before concluding a foreign holder rather than trusting one probe), retries bounded by MAX_PORT_BIND_ATTEMPTS, re-allocates with exclude-plus-adjacency filtering, and refuses to retry when teardown itself did not fully succeed (up(), lines ~580-615). No blind retry path.
- packages/apra-fleet-se/scripts/check-generic-boundary.mjs: 77 engine files scanned, clean.
- No .only/.skip/xit added anywhere in the diff; no real secrets (the four ghp_ hits are self-labelled fixtures, e.g. ghp_FIXTUREPLAINTEXTPATDONOTLEAK).

EPIC ACCEPTANCE (apra-fleet-3swo), verified from source, not from bead counts:
1. Decomposition: runner.js went 11,849 -> 3,118 lines (189KB), with 44 new fleet-sprint modules including all twelve phases/*.mjs and every module the epic description named (vcs-auth, git-sync, coordination, kb, beads-scope, beads-transitions, member-target, role-policies, sprint-args, worklists, prompts, sprint-state). Zero files deleted; runner.js still re-exports the moved symbols as a facade (runner.js:1-180, :311).
2. Dispatch engine: I loaded the real table -- ROLE_POLICIES has 13 roles and migratedRoleNames() returns all 13. inline-ladder-guard.checkModules() scans 57 guarded modules and reports 0 violations, and all 10 remaining `agent(` occurrences in runner.js are comment text, not call sites. The '~13 hand-written ladders collapsed into one engine' claim is real and complete.
3. Move-only discipline: the strongest evidence is test/fixtures/golden-transcript/mock-sprint-happy-path.jsonl -- across the entire 12-phase slice and the 13-role engine migration it changed on exactly 2 of its lines (seq 16 and 26), and only because the plan-reviewer JSON schema gained the intentional `findings` field. Every command and dispatch in the sequence is byte-identical.

FAILURE PATHS I TRACED RATHER THAN PATTERN-MATCHED:
- install --force (src/cli/install.ts:1096-1170): apraFleetPids() snapshots BEFORE the stop, escalates to killApraFleet() only when `stillUp.every(pid => pidsBeforeStop.includes(pid))`, and reports a NEW pid as a supervisor relaunch instead of signalling forever. registeredServiceManager() degrades to the historical kill path on any adapter error. Correct on the already-exited, stop-threw and relaunched branches.
- git-sync.mjs withOpenSyncBracket (lines 166-262): the crossing-close ConcurrentSyncBracketError is now captured and re-thrown AFTER the pause-guard poke, with the bracketed body's own error still attached as `cause`, and the stack splice still runs on both paths. The doc comment honestly records that the poke is currently inert on the crossing path (openSyncBracketCount is provably >= 1 there) and is kept as hardening -- that is accurate, not hand-waving.
- Watchdog budget fix (role-policies.mjs:283-301, 532-585): resolveWatchdogTimeout is applied in BOTH policy() and secondary(), which matters because four secondaries build their own watchdog() and the spread would otherwise replace the already-resolved one. I checked every budgets() row: maxTotalS >= timeoutS everywhere (DISPATCH_TIMEOUT_S for 11 rows, INTEG_MAX_TOTAL_S = 2x and REGRESSION_TEST_MAX_TOTAL_S = 3x for the other two), so `maxTotalS ?? timeoutS` can never shorten a watchdog.
- vcs_credential_exec (src/tools/vcs-credential-exec.ts): the token is read in-process and never placed in any returned field; substitution branches on isPosixShell for the member's own shell; the thrown-dispatch-failure message is redacted on the same footing as stdout/stderr; only the placeholder-bearing log-safe command is logged. Refusing a command with neither placeholder is what keeps this from being a second unguarded execute_command.

SCOPE STATUS: 0 beads open at or above goal priority P1/P2 under apra-fleet-3swo -- I checked the tree directly rather than trusting the summary. The four still-open beads (3swo.7, 7.6, 7.7 deferred, 7.15) are all P3 Phase 5 credential-helper retirement work, correctly left for a later sprint; readMemberVcsCredentialToken is still live with 2 call sites in vcs-auth.mjs as those beads describe. The epic bead itself stays open, which is correct.

KB PROMOTIONS: 2 promoted (38065918 and 64bedb7a), each verified from source this review -- see kb_promotions.

KB ENTRIES THAT ARE NOW STALE -- the code wins, and I did not promote any of them:
- 0b08f92a ('inline-ladder-guard is silently inert for pool-head and runtime member kinds') is FIXED: memberExprFor (inline-ladder-guard.mjs:77-84) resolves role, pool-head and runtime.
- 77194250 ('isAccountedFor reduces paths to path.basename') is FIXED: guarded-modules-coverage.test.mjs:722-726 now asserts phases/index.mjs does NOT ride on vcs-providers/index.mjs.
- 65e6e503 ('fleet-sprint detects provision failures by retired emoji prefixes') is FIXED: vcs-auth.mjs provisionOutcome() (line 162) branches on structuredContent.ok with an ASCII [FAIL] prose fallback.
- 82189e8d ('runner.js's remaining 5323 lines') is WRONG now -- it is 3,118.
- 8fd19801 ('runner.js is 680,963 bytes, above GitNexus's 512KB threshold') is WRONG now -- 189,158 bytes.
- 87463f85 ('phase3 real-bd nested budget is ~19.86 hours') was capped at a stated 4h ceiling by commit ec3e22a6.
- 3d6d4eb4 is partly wrong: runner.js no longer DEFINES syncMemberAfter, it imports it from member-sync.mjs (runner.js:68-70).
- 375f2328 ('background npm test runs should be run synchronously') did not hold here: a backgrounded run with active polling completed cleanly.

NON-BLOCKING FINDINGS, all filed as newTasks below: toolErrorText still reads content[0] and can return an onboarding banner (the half of df009171's fix that was not applied); the vcs_credential_exec tool-level description never mentions {{vcs_token_inline}}; the CHANGELOG Unreleased heading and its runner.js line count are stale; two guarded-modules.mjs comments claim Final Review calls dispatchReview when runner.js:2834 passes it no such helper; and inline-ladder-guard goes silently inert for an unrecognised member kind with no test pinning it.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Regression test runner dispatch failed: [Workflow Error] Agent dispatch failed (stalled): [FAIL] execute_prompt on "worker" was aborted after a confirmed stall -- the remote turn made no progress for the stall threshold, its process was killed, and the in-flight dispatch was cancelled immediately rather than waiting out the client timeout.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
