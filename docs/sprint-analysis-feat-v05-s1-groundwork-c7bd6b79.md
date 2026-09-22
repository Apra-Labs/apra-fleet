# Sprint Analysis: feat/v05-s1-groundwork

Scope issue id(s): apra-fleet-ky2l.
Base branch: v0.5_dashboard.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [44, 46].
High-water-mark closed count this sprint: 49.
Final closed count: 46.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed the net diff, not the bead counts. NOTE on baseline: the local v0.5_dashboard ref is stale (8688e00); origin/v0.5_dashboard is ab6a5b1a (PR #506, the s3 client/store work). Reviewed against origin/v0.5_dashboard -- the true PR diff is 75 files, +6401/-179. The ~4.3k lines of projects-store/beads-normalize code that appear in a v0.5_dashboard..HEAD diff are already on the integration branch and are NOT this sprint's work.

VERIFIED MYSELF (not taken from the close reasons):
- npm run build OK. npm test green: vitest 328 files / 4730 passed, 0 failed; node:test bounded runner 3606 pass, fail=0, SUMMARY fail=0; runner exit 0. Working tree clean of tracked changes.
- check-generic-boundary.mjs -> 'Scanned 85 engine file(s). OK', exit 0. The guard now also scans fleet-sprint/skills/**.md for tracker-id leaks (bead-id rule only, documented in docs/generic-engine-boundary.md); I grepped deploy.md, both playbooks and both SKILL.md files -- no bead ids.
- integration-gate-status.mjs runs offline against its fixture and emits correct merge/repair/wait/skip lines; exit 0. fleet-integrator/SKILL.md is genuinely generic (no 8787, no repo-specific paths, parameters are placeholders).
- npm run build:ui --if-present exits 0 in a project with no such script (repro in a temp dir), so both new ci.yml steps are no-ops until the UI sprint lands.
- Auth guard: all mutating routes are under /api/ or POST /sprints/:id/live/*, both guarded pre-dispatch in server.mjs; requiresAuth normalizes through new URL() so /foo/../api/health cannot bypass; tokensMatch is length-checked + timingSafeEqual; cookie is HttpOnly + SameSite=Strict; token is never logged. Tests cover the torn-write, EEXIST-race, malformed-key, path-traversal and cookie-suffix cases.
- ky2l.15 criterion holds: root package.json is absent from the diff and still ends in a newline.
- Windows fixes are real root-cause fixes (pathToFileURL main-guard; marker script no longer embeds a backslash path in a JS string literal), and supervisor-guard-e2e hardening weakens no assertion and skips nothing on win32.

Three secondary findings filed as newTasks; none block this epic's acceptance criteria. Nothing to reopen -- every closed bead is traceable to specific lines in this diff.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran the full regression pass per regression-test-playbook.md at branch HEAD 624039589f9c9d3c6d8502790701c5690cb80349. Part 1 (real-bd suite via scripts/run-integ-suites.mjs --fresh/--start, 279 files, elapsedWall=692s): 7 files failed (golden-transcript.test.mjs and its cascade into phase0-seams-facade, phase1-leaf-facade-completeness, phase3-dispatch-engine-completeness, vcs-auth-extraction-facade.test.mjs; plus mock-sprint-beads-identity.test.mjs and mock-sprint-parent-child-blocks-cycle-repair.test.mjs) -- also confirmed phase3-dispatch-engine-completeness.test.mjs exceeds the 300s single-file budget (519s) via check-integ-suite-budget.mjs. The slow lane (npm run test:slow) also failed 1 of 2 tests (mock-sprint-planner-dispatch-stalled-session.test.mjs, bd-replay recording drift). Every one of these failures reproduces the exact signature of an already-open, parent-less [regression][carry-over] bead (apra-fleet-zekq, apra-fleet-vwa2, apra-fleet-0aer, apra-fleet-5jlr) -- each was updated with a recurrence note (this run's branch HEAD and evidence) rather than filed as a duplicate, so bugsFiled is empty. Part 2 (sandbox smoke test): Setup completed cleanly (install, server start on port 18700 verified, toy-repo clone, sandbox-local git mirror + beads seed with isolation guard passing, supervisor boot on port 18701 identity-checked) but Test scenario step 3a (seeding the sandbox's persistent secret store from the runner's own ambient Claude credential) was denied by the Claude Code auto-mode classifier ('[Secret-Store Writes]') before it could run -- an extensively-documented, recurring environment gotcha (apra-fleet-j48h), not a product regression; per this repo's CLAUDE.md policy, no workaround was attempted, so steps 1/2/3b/4/5 never executed. Teardown was run regardless: the supervisor-stop identity check false-reported 'still alive' immediately after a clean shutdown (confirmed dead via out-of-band ps/port check moments later) -- an exact recurrence of the already-open apra-fleet-5mu3 timing-race bead, noted rather than duplicated -- then lock release, fleet-server stop, dolt-sql-server reap, and sandbox rm -rf all completed successfully with no leftover processes/ports. The leftover sandbox-deploy sweep for this sprint's id found nothing to tear down. This entire result is informational: it does not gate the current sprint's PASS/FAIL verdict, and every failure identified is pre-existing breakage that carries over to a future sprint via its existing open carry-over bead.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
