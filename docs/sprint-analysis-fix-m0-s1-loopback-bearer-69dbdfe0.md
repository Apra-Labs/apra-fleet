# Sprint Analysis: fix/m0-s1-loopback-bearer

Scope issue id(s): apra-fleet-50j6.
Base branch: main.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [1, 6, 12].
High-water-mark closed count this sprint: 14.
Final closed count: 12.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

Deploy failures (1): C1: Sandbox Deploy mode used (dispatched for integration/regression testing per the task prompt, sprintId apra-fleet-50j6-91648fea-9e67-47d5-b6e6-54e33f442186). Per the Sandbox Deploy section's explicit non-goals, the '## Deploy' active-sprints gate was intentionally SKIPPED -- it protects the shared singleton that only '## Deploy' restarts; the sandbox never stops/restarts anything, so it does not apply.

Step 0a permissions: verified via merged .claude/settings.json + settings.local.json allowlist; all required prefixes present (node scripts/preflight-clear-build-locks.mjs*, npm ci, npm run build, node scripts/sandbox-deploy.mjs *). KB tools unreachable this session (apra-fleet MCP server reported ConnectionRefused) so kb_session_prime/kb_capture were skipped per the fallback instruction; the KB entries supplied in the dispatch prompt were reviewed but none applied to this failure.

Step 1 build: node scripts/preflight-clear-build-locks.mjs (no locks found), npm ci (243 packages, clean), npm run build (tsc, clean) all succeeded.

Step 2 'node scripts/sandbox-deploy.mjs up --sprint-id "apra-fleet-50j6-91648fea-9e67-47d5-b6e6-54e33f442186"' FAILED, exit 1, reproduced twice with different OS-assigned ports/pids (53545/53547 and 53604/53606) -- ruling out a transient port race:
  '[sandbox-deploy] FAILED (sandbox supervisor did not answer /api/health with pid <pid> on <port> (EADDRINUSE, or crashed) -- torn down; see <root>\\supervisor.log)'
The sandbox fleet MCP server itself came up healthy both times (e.g. 'fleet server up: pid=50016 port=53643 version=v0.4.3_bb4aed'); the failure is isolated to the supervisor health probe.

ROOT CAUSE (confirmed by direct reproduction, not speculation): the sandbox supervisor process actually starts and listens fine ('[supervisor] listening on http://localhost:<port> (pid <pid>)' in supervisor.log, plus clean reconcile/readopt lines) -- it is not crashing or racing a port. I manually spawned packages/apra-fleet-se/bin/serve.mjs with the same sandbox env and curled its /api/health directly: it returns HTTP 200 with body {"error":"unauthorized"}, no pid field. packages/apra-fleet-se/src/supervisor/auth.mjs:requiresAuth() guards the ENTIRE /api/ surface by design (no toggle, no loopback exemption despite the server binding 127.0.0.1-only) -- confirmed by reading the function, not inferred. scripts/sandbox-deploy.mjs's getJson() (line 255, called for every /api/health and /api/members check) never attaches an Authorization: Bearer <token> header, so supHealth.pid never matches and the 30s poll times out, reported as 'EADDRINUSE, or crashed' even though the process is healthy and unauthenticated-by-design. git log shows the auth guard commits (4a35811e, 34613769) landed AFTER the Sandbox Deploy runbook section was added (767b9d2e) -- sandbox-deploy.mjs was never updated for the new auth requirement. verify() (line 470) and the isolation-proof /api/members check (line 474) share the same unauthenticated getJson() and would hit the identical 401, so this is not a single-call fix; also worth flagging for whoever fixes it that a 401 body could make the 'members is EMPTY' isolation proof pass spuriously once health is patched, since an empty array is not what a 401 error body contains but a naive fix must guard against that.

Per role rules I did not patch scripts/sandbox-deploy.mjs, auth.mjs, or deploy.md -- this is source-level tooling drift, out of scope for the deployer role, and reported here instead.

Cleanup: after diagnosis I killed the manually-spawned diagnostic supervisor process and ran 'node scripts/sandbox-deploy.mjs teardown --sprint-id ...', which exited 0 with 'torn down: <root> removed, <values file> removed' and printed NO production-drift warnings (teardown re-checks production's fleet-server pid/port and supervisor uptime against the init-time snapshot and warns on any change) -- confirms production was never touched and no sandbox processes/files remain. git status is clean (no source files modified). No isolated test instance is left running for a subsequent integration-test phase to find, because none could be brought up.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed the net diff main..fix/m0-s1-loopback-bearer (25 files, +2808/-138) against all 12 closed beads; each maps to concrete lines.

Verified: auth.mjs (new) mints via exclusive 'wx', unlinks ONLY a torn (blank) file, re-asserts 0600 on POSIX / reports aclVerified=false on Windows, compares with timingSafeEqual, parses the cookie by exact name; token never in logs or error text. server.mjs listens on 127.0.0.1 and answers 401 + WWW-Authenticate: Bearer BEFORE route dispatch. I traced the bypass classes myself rather than trusting the diff: dot segments (/foo/../api/health), '//api/health' (protocol-relative -> /health, router agrees), '/%61pi/health' (guard open, router equally unrouted) -- no guard/router divergence. Dashboard GET / sets se_token HttpOnly SameSite=Strict; spawner passes the token in env only (never argv); coordination.mjs sends Bearer on both clients; SKILL.md has bash+PowerShell twins. check-foreign-sprints.mjs turns 401 into exit 1 with an actionable hint and never 'no live sprints' (covered by tests/check-foreign-sprints.test.ts: missing token, stale token, authorized, unreachable). check-sandbox-sync-remote.test.ts: the old 'if (i===attempts-1) throw err' is gone, 4 bare fs.rmSync(tmpDir) sites replaced, and all teardowns now call the shared non-throwing safeRmDir (lines 216/319/515/568/600/626) plus 3 direct helper tests.

The C1 deploy failure root cause is genuinely fixed: sandbox-deploy.mjs sends the token on EVERY /api call including verify() and the /api/members isolation proof, and a 401 makes getJson() return null -> an explicit 'unreadable'/pid-mismatch problem, never a spurious empty-members pass. tests/sandbox-deploy.test.ts live up/env/verify/teardown: 23/23 green on this machine.

Suites run as 4 separate phases, no pipes: root build (tsc) OK; root vitest all green; apra-fleet-se 3327 pass / 0 fail / 21 skipped; apra-fleet-client 36/36. Working tree clean (only an untracked .beads.gate.lock). Diff is ASCII-clean; repo-root src/ and api.mjs untouched, as the epic scoped.

Five secondary findings filed as newTasks; none violate this epic's written criteria. The most important is that criteria (1)+(3) together require GET / to be open AND to hand out the token, so any loopback caller can harvest it -- that is a criteria defect for a planner, not a dashboard.mjs patch.

KB: promoted 2 (details in kb_promotions). Note that INFERRED entry 1a0c8acc is now STALE -- its 'still throws through the OLD single-site retry loop's call site until inlined' caveat no longer holds; this diff inlined it. Left unpromoted rather than promoting a claim the code now contradicts.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: apra-fleet-zekq, apra-fleet-y0zz, apra-fleet-0aer, apra-fleet-ae2i, apra-fleet-hzb2.
Summary: Ran a full regression pass at branch HEAD 8d85c6b3fa05b300a15ffd87b643ea5465c075dc. Part 1 (real-bd suite): recovered a stale integ-suite-status.json via --fresh (known recurring issue, noted on existing apra-fleet-jl71), then ran the full 268-file real-bd suite to 'pass COMPLETE' with 8 failures (elapsedWall=6644s); filed apra-fleet-zekq for a golden-transcript snapshot-divergence/non-determinism regression that cascades into phase0-seams-facade.test.mjs, phase3-dispatch-engine-completeness.test.mjs (the long pole at 4110s), and vcs-auth-extraction-facade.test.mjs (all four share one root cause -- one bead, not four), plus standalone apra-fleet-y0zz (mock-sprint-beads-health-gate-empty-remote timeout), apra-fleet-0aer (mock-sprint-parent-child-blocks-cycle-repair bd-dep-add failure), and apra-fleet-ae2i (mock-sprint-regression-failure-never-gates timeout); phase1-leaf-facade-completeness.test.mjs failed with a different signature than open apra-fleet-x0mr, noted there rather than duplicated. 32 files exceeded the 300s single-file budget (check-integ-suite-budget.mjs) -- reported here as a number, no bead filed for slowness alone. The slow lane (npm run test:slow) then ran to completion: 1 pass, 1 fail, matching the exact known signature already tracked by open apra-fleet-5jlr (bd-replay recording drift for the stalled-session scenario), updated with today's recurrence rather than duplicated. Part 2 (smoke test): Setup completed install, server start+port verification, toy-repo clone, git identity seed, and sandbox beads seeding/isolation-guard successfully, but failed at the supervisor-boot identity-checked readiness step -- GET /api/health now returns 401 Unauthorized because a new loopback-bearer-auth guard (packages/apra-fleet-se/src/supervisor/auth.mjs's requiresAuth()) covers the ENTIRE /api/ prefix with no carve-out for health, breaking every unauthenticated /api/ curl the playbook documents (Setup's readiness loop, Test scenario's sprint launch/poll, Reset/Teardown's shutdown call, and Teardown's own liveness re-check, which fails silently under the new guard). Filed as apra-fleet-hzb2 (reproduced twice). Per the Setup-verify-failure protocol, did not proceed to the Test scenario -- steps 1-5 never ran this cycle, so no smokeEvidence is available. Ran Teardown: its supervisor-stop block was skipped because both marker files had already been removed by Setup's own failure path, so port 18701 was cleared directly via the playbook's own kill-port.mjs; lock released cleanly, 'node dist/index.js stop' succeeded ('Server stopped.'), the dolt reap found nothing to clean, and rm -rf removed the sandbox -- verified afterward that the sandbox path and its .lock file are both gone and ports 18700/18701 are free. Also ran the leftover sandbox-deploy sweep for this sprint's own reservation id (apra-fleet-50j6-91648fea-9e67-47d5-b6e6-54e33f442186): 'nothing to tear down', the normal result. This entire result is informational: it does not gate the current sprint's PASS/FAIL verdict, and every filed bug carries over parent-less for a future sprint to pick up.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
