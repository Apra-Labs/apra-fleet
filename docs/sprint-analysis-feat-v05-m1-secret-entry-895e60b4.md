# Sprint Analysis: feat/v05-m1-secret-entry

Scope issue id(s): apra-fleet-i9ag.11.
Base branch: v0.5_dashboard.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [22].
High-water-mark closed count this sprint: 23.
Final closed count: 22.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed the net diff, not bead counts. NOTE ON BASE REF: local v0.5_dashboard was 51 commits stale; the true integration tip is origin/v0.5_dashboard (2b6cd876). Reviewed origin/v0.5_dashboard..HEAD = 21 commits / 24 files / +2575-203 (a naive diff vs the stale local ref shows a misleading 585 files).

VERIFIED: build exit 0; npm test (bounded runner) 389 files / 5749 tests passed, 0 failed; apra-fleet-se 468/468; git status clean; no lint script configured. The supervisor-guard-e2e flake cited in the close note did NOT recur.

The parent bug is genuinely fixed, not worked around. collectOobUrl (src/services/auth-socket.ts) no longer calls launchAuthWeb: it registers a console-hosted entry and returns the relative path /ui/#/secret-entry/<token> -- no scheme/host/port. Secrets.tsx:106 window.open(result.url) resolves that against the browser's own origin, which is exactly what makes it work off-box. The loopback server is correctly retained for the blocking on-box path only; no dangling refs to the removed OOB_URL_LISTEN_TIMEOUT_MS export.

Acceptance is pinned by a real test, not a mock: tests/secret-entry-offbox-e2e.test.ts drives a real http.Server delegating to handleConsoleRequest with a foreign non-loopback Host throughout, asserts the url has no '://', no 127.0.0.1/localhost and no :<port>, resolves prompt+submit, proves single-use (2nd submit 404), proves list has no 'value' key, sweeps the sentinel out of all bodies and logs, and asserts 401 without a credential. It includes explicit anti-vacuity assertions so the leak sweep cannot pass trivially.

Security is above bar: constant-time token lookup via crypto.timingSafeEqual; unknown/expired/consumed all answer a byte-identical 404 (no oracle, pinned by test); token in the URL fragment so it never reaches an access log or Referer; 64KB body cap; a throwing onSubmit yields a fixed 500 and never echoes its message (value-derived leak closed by i9ag.11.14). Docs are honest rather than flattering -- adr-oob-password.md and console-architecture.md both state the console cookie is CSRF/same-site protection, NOT network auth, and that console-port reachability is the real trust boundary.

Error/edge paths are covered, not just happy paths: TTL expiry, malformed JSON, non-hex and oversized tokens (400 not 500), empty value, 422 retry, 405/404 method+path, sub-path base join, trailing-slash idempotence, malformed and non-http base URL failing loudly. joinConsoleUrl correctly avoids new URL(rel, base) dropping a reverse-proxy sub-path. apra-fleet-client typedefs/JSDoc were updated in the same change per the CLAUDE.md client-parity rule. The i9ag.11.16 flake fix makes a precondition deterministic rather than weakening the assertion.

File hygiene clean: all 24 files justify against the scope; no temp files, scaffold or stray tool config. The only non-ASCII hits (tests/auth-socket.test.ts) are pre-existing and were reduced, not added, by this branch.

No reopens. Four non-blocking follow-ups filed as newTasks.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran the full regression pass against branch HEAD (6cff690e, feat/v05-m1-secret-entry). Part 1 (real-bd suite, node scripts/run-integ-suites.mjs --fresh/--start): 289/289 files completed, 12 failed (golden-transcript.test.mjs snapshot-divergence/non-determinism, which cascades into phase0-seams-facade, phase1-leaf-facade-completeness, phase3-dispatch-engine-completeness, and vcs-auth-extraction-facade; plus mock-sprint-beads-health-gate-empty-remote, mock-sprint-beads-identity, mock-sprint-parent-child-blocks-cycle-repair, mock-sprint-regression-failure-never-gates, mock-sprint-sprint-state-client-hoist, serve-wiring-integration, and supervisor-guard-e2e), elapsedWall=7583s. The slow lane (npm run test:slow) also ran and recorded 1 failure (mock-sprint-planner-dispatch-stalled-session.test.mjs: bd-replay recording drift). Every one of these 13 failures exactly matched an already-open [regression][carry-over] or related bead from prior regression passes, so no new bugs were filed -- each existing bead was updated with this run's fresh evidence instead (zekq, pjew, vwa2, 0aer, k83x, b1gw, 3dk4, x0mr, ryk, ye8j). Part 2 (smoke test): Setup completed fully (install, server boot + port verification, toy-repo clone, sandbox beads seed + isolation checks, supervisor boot with identity-checked readiness), but the Test scenario was blocked at step 3a -- the Claude Code auto-mode permission classifier denied the credential-provisioning command ('Reason: [Credential Leakage]') even though static permissions coverage was already verified present, a known recurring block tracked on apra-fleet-j48h (updated with fresh evidence, no workaround attempted per this repo's CLAUDE.md policy). Steps 1-2 and 3b-6 (member registration, canary verification, sprint launch, closure assertion) never ran. Teardown was still run to completion (individually, since scripts/reap-sandbox-dolt.mjs's known macOS ps-etimes incompatibility, tracked on apra-fleet-jz2m, also reproduced and was updated with fresh evidence) -- server stopped, supervisor stopped (one transient stop-race false-alarm, confirmed actually down per the known KB pattern), lock released, sandbox removed, ports 18700/18701 confirmed free. This result is entirely informational: it does not gate the current sprint's PASS/FAIL verdict, and all findings carry over to a future sprint via the parent-less beads updated above.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
