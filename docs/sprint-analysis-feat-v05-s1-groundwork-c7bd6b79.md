# Sprint Analysis: feat/v05-s1-groundwork

Scope issue id(s): apra-fleet-ky2l.
Base branch: v0.5_dashboard.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [36, 37].
High-water-mark closed count this sprint: 38.
Final closed count: 37.
Final open-at-goal-priority count: 2.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- FAIL: the epic cannot merge and two P1 children are open.

1) CI has never been green on feat/v05-s1-groundwork (3 runs, all failed). Latest run 35707319899 at HEAD 2da3ebf5: ubuntu+macos pass, windows-latest FAILS -- a required check under the v0.5_dashboard ruleset, so PR #510 is unmergeable. Open P1 beads: apra-fleet-ky2l.17 (17.2 in progress) and apra-fleet-ky2l.18.

2) Both Windows failures are in tests THIS sprint added, not pre-existing flakes: packages/apra-fleet-se/test/integration-gate-status.test.mjs (ky2l.6) and test/supervisor-guard-e2e.test.mjs (ky2l.1.3). Root cause for the first is confirmed by reading the script: scripts/integration-gate-status.mjs:224 guards main() with `import.meta.url === \`file://${process.argv[1]}\``; on win32 argv[1] is `D:\a\...\x.mjs` while import.meta.url is `file:///D:/a/...`, so main() never runs -> 0 output lines, exit 0 (exactly the two assertion failures). Fix: `process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href`, the pattern every scripts/*.mjs in this repo already uses. The guard-e2e 5s HTTP timeout after the listening line is not root-caused from Linux.

3) apra-fleet-ky2l.2 was closed with its own AC unmet: deploy.md:123 (`curl -s -X POST .../api/reservations/<id>/force-release`) and deploy.md:163 (`curl -s .../api/sprints`) still hit the production supervisor with no bearer. bin/serve.mjs always resolves a token now, so :123 will 401 for the operator. tests/regression-playbook-sandbox-lifecycle.test.ts only scans regression-test-playbook.md, which is why this slipped. Reopened.

4) apra-fleet-ky2l.5's AC says 'CI run on the sprint PR passes'; it never has. Its own test (ci-build-ui-step) now passes 17/17 on windows after ky2l.17.1, so the gap is tracked by ky2l.17/18 rather than reopening.

Verified OK: local build + full bounded npm test green (vitest 328 files/4725 tests; node:test 3609 pass 0 fail; SUMMARY pass=4165 fail=0); generic-boundary check OK (85 files); auth.mjs is sound (timingSafeEqual, torn-write race handling, requiresAuth normalizes identically to the router so //api/x and /../api/x cannot bypass); loopback bind 127.0.0.1; sync forwarding (ky2l.3) validates boolean, emits --sync only on true, documented in fleet-supervisor SKILL table; sandbox-deploy start() and the spawned child resolve fleet.key from the same real HOME; check-foreign-sprints turns 401 into exit 1 not 'no sprints'; fleet-integrator SKILL has no target branch/check names/bead ids; list-members json envelope fix + docs consistent; no sprint-introduced non-ASCII; no stray files. Known: GET / hands the token to any loopback caller via Set-Cookie -- acknowledged in docs and already tracked as open P1 apra-fleet-50j6.6, no new task filed. No KB promotion candidates were supplied; MCP KB server unreachable this session.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: apra-fleet-5mu3.
Summary: Ran the full regression pass per regression-test-playbook.md. Part 1 (real-bd suite, node scripts/run-integ-suites.mjs, resumed a stale prior-session status file then completed fresh): 279 files discovered, 7 failed (golden-transcript.test.mjs and its four cascade dependents phase0-seams-facade/phase1-leaf-facade-completeness/phase3-dispatch-engine-completeness/vcs-auth-extraction-facade, plus mock-sprint-beads-identity.test.mjs and mock-sprint-parent-child-blocks-cycle-repair.test.mjs), and check-integ-suite-budget.mjs flagged 1 file over the 300s single-file budget (phase3-dispatch-engine-completeness at 525s); the slow lane (npm run test:slow) also failed 1/2 (mock-sprint-planner-dispatch-stalled-session.test.mjs, bd-replay recording drift). Every one of these failures exactly matched a pre-existing open [regression][carry-over]/[integ] bead with a long recurrence history (apra-fleet-zekq, apra-fleet-vwa2, apra-fleet-0aer, apra-fleet-eft.17, apra-fleet-5jlr), so each was updated with this run's fresh evidence rather than duplicated -- suitePassed=false. Part 2 (smoke test): Setup fully succeeded (fresh install, server on port 18700, toy-repo clone + sandbox-local seed + isolation verified, supervisor boot identity-checked on port 18701), but the Test scenario was blocked at step 3a (credential provisioning) by the Claude Code auto-mode permission classifier denying the secret-store write -- an extensively documented, long-recurring environment gotcha (apra-fleet-j48h), updated with this run's evidence rather than duplicated; steps 1/2/3b/4/5/6 never executed, so no canary/version/toyRepoHeadSha evidence was collected -- smokePassed=false. Teardown ran fully afterward regardless (supervisor stopped, lock released, server stopped, dolt reap clean, sandbox removed); it hit one small new wrinkle -- the supervisor-stop identity check briefly false-reported 'still alive' for a process that a moment later was confirmed fully stopped -- filed as a new standalone, parent-less carry-over bead (apra-fleet-5mu3) since no prior bead covered that exact race. The sprint's own leftover sandbox-deploy sweep (sprintId apra-fleet-ky2l-a18c7a23-edf7-41a0-8449-44e077e71e4f) found nothing to tear down. This entire result is informational: it does not gate the current sprint's verdict, and the one new bug plus all the updated recurring bugs carry over to a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
