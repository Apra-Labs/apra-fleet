# Sprint Analysis: feat/v05-m1-supervisor-project

Scope issue id(s): apra-fleet-i9ag.17.
Base branch: v0.5_dashboard.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [15].
High-water-mark closed count this sprint: 19.
Final closed count: 15.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed the NET diff at the true merge-base: the local v0.5_dashboard ref was stale, so the real range is origin/v0.5_dashboard(9a6bed7c)..HEAD(f962dd42) = 12 commits, 25 files, +3121/-78. Everything in it is attributable to i9ag.17.1-.4.

VERIFICATION: npm run build exit 0. Full bounded npm test exit 0 across all five suites: root vitest 403 files/5942 tests 0 fail (shell-ui health.test.tsx DOES run here, via vitest.config.ts `projects`), apra-fleet-client 95, apra-fleet-workflow 322, apra-fleet-se 4747 pass/0 fail (incl. all 67 new supervisor-project-* cases), apra-pm 468. No lint script exists in this repo.

CRITERIA, each pointed at code: .1 project-config.mjs is the sole owner of supervisor.config.json (total non-throwing reader; atomic temp+rename via renameWithRetry, matching ledger/history); serve.mjs:288-318 resolves flag>config>walk-up and logs the winning source; the typo-fatal/staleness-tolerant asymmetry is implemented AND tested, and an unusable config deliberately does not fall back to the walk-up. .2 guarded GET/POST /api/project (401 tests for both verbs) writes only through that module; /ui/projects serves a real page and serve-wiring-integration.test.mjs's old placeholder assertion was correctly INVERTED, not left stale; /api/projects (M2) untouched and pinned. .3 Health renders folder+source, an explicit not-configured state, and an unknown state, with an isolation test proving a supervisor outage degrades only that row. .4 --project-dir is added to BOTH knownFlagPrefixes and knownFlagExact, seeds before service registration (ordering asserted via invocationCallOrder), and the parity test imports the REAL apra-fleet-se reader rather than restating the shape. Docs/CHANGELOG/llms-full.txt/install-help.txt fixture all updated; the 'known gap' text is gone from install.md and project-model.md.

The strongest evidence the original bug is fixed is supervisor-project-round-trip.test.mjs's 'survives restart': it boots real supervisor processes and deliberately points boot #2's cwd at a walk-up trap that HAS its own .beads, then asserts the persisted config still wins.

SECURITY/HYGIENE: /api/project is auth-guarded by the /api/ prefix rule. The page does not embed the token; it reuses the pre-existing HttpOnly se_token cookie mechanism dashboard.mjs GET / already established on a loopback-bound server, so this is not new exposure. Client state renders via textContent, and the one interpolated value is allowlisted mountHref output. No temp/scratch files, no tool config, no CLAUDE.md, zero non-ASCII added.

No bead needs reopening. Six non-blocking follow-ups are filed as newTasks; the most concrete is that install's seedSupervisorProjectDir destroys unknown top-level keys and is non-atomic, diverging from writeSupervisorConfig's explicitly documented preserve-unknown-keys invariant -- I confirmed this with a standalone repro (futureKey survives the .mjs writer, is dropped by the install writer), and the parity test cannot catch it since it only checks the reader accepts the writer's output. Harmless today (one key exists), latent tomorrow. Note the container bead apra-fleet-i9ag.17 itself still shows OPEN while all four children are closed.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran the full regression pass (Part 1 real-bd suite + slow lane, Part 2 sandbox smoke test) against apra-fleet-deploy branch feat/v05-m1-supervisor-project at HEAD f962dd42. Part 1: main lane completed 298/298 files with 7 failures (golden-transcript.test.mjs and its documented cascade into phase0-seams-facade/phase1-leaf-facade-completeness/phase3-dispatch-engine-completeness/vcs-auth-extraction-facade, plus mock-sprint-beads-identity.test.mjs and mock-sprint-parent-child-blocks-cycle-repair.test.mjs), and the 300s single-file budget check flagged phase3-dispatch-engine-completeness.test.mjs (545s); the slow lane added 1 more failure (mock-sprint-planner-dispatch-stalled-session.test.mjs, bd-replay recording drift). Part 2: Setup succeeded fully (install, server, toy-repo clone, beads seed/isolation, supervisor boot), but Test scenario step 3a's credential-provisioning command was denied by the Claude Code auto-mode classifier, blocking the rest of the smoke test; no workaround was attempted per repo policy. Teardown ran to completion in both cases (Part 2's Teardown hit a known racy false-positive on the supervisor stop check, manually verified as already-stopped, then completed cleanly). All 8 distinct failures/blockers found this run exactly matched already-open [regression][carry-over]/[integ] beads (apra-fleet-zekq, vwa2, 0aer, eft.17, ye8j, j48h, 5mu3) and were updated with fresh confirmation notes rather than filed as new duplicates -- no new beads were created. This result is purely informational and does not gate this sprint's PASS/FAIL verdict; all findings are pre-existing breakage carrying over to a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
