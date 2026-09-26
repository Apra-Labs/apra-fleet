# Sprint Analysis: feat/v05-m1-sprints-in-console

Scope issue id(s): apra-fleet-i9ag.3, apra-fleet-i9ag.5.
Base branch: v0.5_dashboard.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [4, 6, 13].
High-water-mark closed count this sprint: 15.
Final closed count: 13.
Final open-at-goal-priority count: 1.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

1 newTask(s) rejected before reaching bd create: C3: title fails safe-character allowlist /^[A-Za-z0-9 .,:;!?()'_/+[\]-]+$/ (or is empty): "Add the console -> Sprints -> viewer -> card -> /ui click-only round trip to a test playbook"

## Final verdict

PASS -- Reviewed the net diff against origin/v0.5_dashboard (the local v0.5_dashboard ref is stale at 8688e007; origin's tip 2d6d5f31 is the true fork point, so the real sprint diff is 11 commits / 22 files / +2855 -118, not the 538-file range the stale local ref implies).

Gates: git status clean before and after; npm run build exit 0; npm test exit 0 (vitest 376 files passed, 6 skipped, 0 failed; apra-fleet-se SUMMARY pass=4604 fail=0; fleet-sprint 468/468). No lint script exists in this repo.

i9ag.3 -- ACs met. manifest.mjs exports SPRINTS_UI_PATH as the single source and bin/serve.mjs mounts the real dashboard handler there via registerDashboardRoutes({extraIndexPaths}) (registered at serve.mjs:500, ahead of the /ui/:rest placeholder at :652), so the nav path serves the real Sprint Stack rather than the placeholder -- pinned by serve-wiring-integration.test.mjs. The Sprints nav entry is now unscoped, and nav.test.tsx was correctly updated so the fixture no longer hides the project===null case. Verified the AC's 'no se/fleet-supervisor literal under src/' by grep -- clean. Real defect found and fixed along the way: registration previously used connection.url (the /mcp endpoint), POSTing to <origin>/mcp/api/workflow-packages/register, which 404s and is retried forever -- the whole hop was dead. Now derived from new URL(...).origin, resolved once and shared with the dashboard's Console link so the two cannot disagree.

i9ag.5 -- ACs met. renderConsoleLinkHtml takes the origin only from the resolved connection (no hardcoded host/port), HTML-escapes it, renders nothing rather than a dead href when unresolved. sprint-anchor.mjs is the single anchor-id source for both the dashboard card and the injected viewer back-link; i9ag53-console-dashboard-viewer-xlink.test.mjs asserts a genuine round trip off the dashboard's actual rendered output, prefixed and unprefixed.

Security: the mount-path header is a real trust boundary and is handled correctly. src/console/proxy.ts adds it to DROPPED_REQUEST_HEADERS so an inbound client-supplied value is stripped in the header-copy loop before the proxy sets its own computed mountPath -- spoofing is covered by tests/console-proxy.test.ts and the e2e suite (body must not contain /ext/spoofed). mount-prefix.mjs fails closed on a 31-case hostile table (quotes, angle brackets, newline, %2e%2e, //host, schemes, backslash, colon), which is what makes interpolation into single-quoted JS literals and href attributes safe. mountHref is guarded against double-prefixing and pinned as ES5-only since it ships to the browser via toString(). Test quality is high, not redundant: byte-identical-to-serve-direct regression guards, a prefix-applied-exactly-once assertion, and a guard that a row index can never land in the prefix slot via .map arity.

One known gap remains, correctly left open rather than papered over: apra-fleet-i9ag.3.9 (P2, OPEN). history-view.mjs handleGet (~line 261) still calls renderForSprint(sprintId) with no mountPrefix, so the dedicated GET /sprints/:id/history page emits an unprefixed back-link that resolves against the console root when embedded; that route has no test. This does not break either named feature's stated ACs -- the /sprints/:id/live fallthrough surface is fixed and covered both ways -- so it carries forward rather than blocking. No closed bead needs reopening.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: apra-fleet-pjew, apra-fleet-k83x, apra-fleet-b1gw, apra-fleet-ye8j.
Summary: Ran the full regression pass against branch HEAD per regression-test-playbook.md. Part 1 (real-bd functional suite, scripts/run-integ-suites.mjs per INTEG-SUITE.md, 288 files, elapsedWall=7619s/~127min) completed with 12 failures: golden-transcript.test.mjs non-determinism/snapshot-divergence cascading into phase0-seams-facade, phase1-leaf-facade-completeness, phase3-dispatch-engine-completeness, and vcs-auth-extraction-facade; mock-sprint-beads-health-gate-empty-remote.test.mjs and mock-sprint-regression-failure-never-gates.test.mjs timeouts recurring after their prior fixes were closed; mock-sprint-beads-identity.test.mjs expect-beads mismatch; mock-sprint-parent-child-blocks-cycle-repair.test.mjs fixture bd-dep-add errors; mock-sprint-sprint-state-client-hoist.test.mjs timeout; serve-wiring-integration.test.mjs and supervisor-guard-e2e.test.mjs dashboard/health-endpoint timeouts -- plus 43/288 files exceeding the documented 300s single-file budget (worst 4582s, a known ongoing performance issue). The slow lane (npm run test:slow) also failed one of two watchdog tests with a bd-replay recording-drift error occurring immediately at test setup. Part 2 (smoke test) completed Setup successfully -- fresh install, fleet server and supervisor both booted and identity-verified, toy repo cloned and sandbox beads seeded with remote isolation verified -- but was blocked at Test scenario step 3a by a known, already-tracked Claude Code auto-mode permission-classifier denial ('[Secret-Store Writes]') before any member could be registered or a sprint launched, so the toy sprint never ran; per policy the block was surfaced rather than routed around. Teardown completed successfully after working around two other known, already-tracked cosmetic issues (a supervisor-stop identity-check race, and a macOS ps-etimes incompatibility in the dolt-reap step) -- neither blocked final sandbox cleanup, which was verified fully clean (no sandbox dir, lock file, listening ports, or dolt processes remain). Filed 4 new standalone parent-less [regression][carry-over] bugs for failures not already covered by an existing open bead, and appended confirming notes (via bd note, no reopen/close) to 9 other existing beads (some open, some closed-and-recurred) that already covered every remaining observed failure -- avoiding duplicate filings. This entire result is informational: it does not gate the current sprint's PASS/FAIL verdict, and every filed or updated bug carries over to a future sprint for triage.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
