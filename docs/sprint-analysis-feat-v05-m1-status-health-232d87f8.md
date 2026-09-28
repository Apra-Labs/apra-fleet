# Sprint Analysis: feat/v05-m1-status-health

Scope issue id(s): apra-fleet-i9ag.14.
Base branch: v0.5_dashboard.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [7].
High-water-mark closed count this sprint: 8.
Final closed count: 7.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed the net diff for apra-fleet-i9ag.14 + its 6 children. NOTE ON SCOPE: the dispatched range v0.5_dashboard..feat/v05-m1-status-health was misleading -- the LOCAL v0.5_dashboard ref is 51 commits behind origin/v0.5_dashboard, inflating the diff to 578 files/75k lines of other tracks' work. The branch actually forks at 2b6cd876, so I reviewed origin/v0.5_dashboard..HEAD: 6 commits, 11 files, +664/-32.

All acceptance criteria verified against the code, not bead counts:
- .14.1 src/services/service-manager/windows.ts: query() now probes Get-ScheduledTask via -EncodedCommand (utf16le/base64, single-quote escaped, only the fixed ASCII task name interpolated -- matches the CLAUDE.md Windows rule and findWrapperProcessIds precedent) and maps the NUMERIC state enum (4/1/2-3), so it is locale-independent. schtasks CSV remains a fallback that never invents `enabled`.
- .14.2 src/cli/status.ts:69-73: serviceLabelFor() is genuinely three-state; undefined renders "installed" with no enable claim. runStateFor() is now appended to BOTH lines (line 98-99), so it reaches the stopped early-return branch and the running branch. Stale doc comment rewritten.
- .14.4 src/tools/check-status.ts:463,560: dataDir=FLEET_DIR in both json branches including the zero-members early return; logFile untouched; compact output byte-identical. apra-fleet-client JSDoc + docs/api-reference.md updated in the same change per the client-parity rule.
- .14.5/.14.6 Health.tsx:76-80 prefers a non-empty payload.dataDir, keeps deriveDataDir as legacy fallback; api/health.ts comment corrected.
- I verified end-to-end wiring beyond the beads: /api/fleet/status (src/console/routes/fleet.ts:507) uses sendJsonPayload, which re-emits the raw JSON rather than whitelisting fields, so dataDir genuinely reaches the page.

Tests: strong, with literal fixtures rather than expectations computed from production code, and the label matrix run over both runStatus branches via describe.each. CSV-fallback error paths (probe throws, probe unparseable, neither source answers, unrecognized/localized status leaving `enabled` absent via 'enabled' in status) are all covered. No regression in adjacent tests -- cli-verbs.test.ts:390-399 and supervisor-service.test.ts:288 pass explicit enabled values.

Gates: git status clean; npm run build exit 0; npm test exit 0 (root 387 passed/6 skipped, client 95, workflow 322, apra-pm 468, apra-fleet-se all PASS). The four sprint files pass 80/14/4/8. supervisor-guard-e2e.test.mjs, which the closer reported FAILING as a known flake, PASSED in my run -- so nothing real is hiding there. All added lines are ASCII (pre-existing non-ASCII at check-status.ts:502,506,611 is untouched by this diff).

File hygiene: all 11 files justified; no temp files or stray tool config.

Two non-blocking follow-ups filed as newTasks: (1) a real hardening gap in the new probe -- $ErrorActionPreference='SilentlyContinue' makes a missing Get-ScheduledTask cmdlet or an access-denied error indistinguishable from 'task absent', yielding a confident {installed:false} that skips the CSV fallback; (2) the stale-base-ref hazard in the review dispatch.

Minor, no task: the status-label cases at cli-verbs.test.ts:390-399 are now a strict subset of tests/status-service-labels.test.ts.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran the full regression pass against branch HEAD b2a65082a55136c47fc75d48ff22a05602dde55e (feat/v05-m1-status-health). Part 1 (real-bd suite, packages/apra-fleet-se, via scripts/run-integ-suites.mjs --fresh/--start): discarded a stale pre-HEAD status file and ran a fresh 289-file pass to completion (elapsedWall=7870s, cumFileTime=40297s); 12 files failed (golden-transcript.test.mjs, mock-sprint-beads-health-gate-empty-remote.test.mjs, mock-sprint-beads-identity.test.mjs, mock-sprint-parent-child-blocks-cycle-repair.test.mjs, mock-sprint-regression-failure-never-gates.test.mjs, mock-sprint-sprint-state-client-hoist.test.mjs, phase0-seams-facade.test.mjs, phase1-leaf-facade-completeness.test.mjs, phase3-dispatch-engine-completeness.test.mjs, serve-wiring-integration.test.mjs, supervisor-guard-e2e.test.mjs, vcs-auth-extraction-facade.test.mjs); check-integ-suite-budget.mjs also flagged 44/289 files over the 300s single-file budget. Every one of these failures exactly matched an already-open [regression][carry-over] or [integ] bead with an extensive multi-week recurrence history, so no new duplicates were filed -- I added recurrence-confirmation comments to the 9 covering beads (apra-fleet-zekq, pjew, vwa2, 0aer, k83x, b1gw, ryk, 3dk4, eft.17) instead. Part 2 (sandbox smoke test): Setup completed fully and cleanly (install, server start + port-18700 identity verify, toy-repo clone, git identity seed, sandbox-local git-mirror wiring, beads seeded via sandbox-seed-beads.mjs with check-sandbox-sync-remote.mjs confirming full isolation, fleet-sprint supervisor booted with identity-checked readiness on port 18701), but Test scenario step 3a (seeding the sandbox's persistent secret store from the runner's own ambient Claude credential) was denied by the Claude Code auto-mode classifier ('[Secret-Store Writes]') -- the exact same known, recurring block already tracked on apra-fleet-j48h, so per this repo's CLAUDE.md no workaround was attempted; I added a recurrence comment there instead of filing a duplicate. Steps 1-6 of the Test scenario (member registration, canary check, dispatch, and assertion) never ran as a result. Teardown was still run in full: supervisor stopped and verified dead, sandbox lock released, fleet server stopped; scripts/reap-sandbox-dolt.mjs hit its own known macOS-only bug (ps -eo etimes=, tracked on apra-fleet-jz2m, also updated with a recurrence comment) so I manually verified no dolt sql-server process existed for this sandbox before removing it. The sandbox directory intermittently reappeared with stale Jul-28 baked-in timestamps across several later tool calls despite verified removal -- an apparent environment/container-recycling artifact unrelated to any real leftover run; recorded via bd remember since KB tools were unavailable this session (apra-fleet MCP server failed to connect). The sprint's own leftover sandbox-deploy sweep (sprintId apra-fleet-i9ag.14-bc7a66d2-455f-464f-b1a1-58a045e81a96) found nothing to tear down. No new [regression][carry-over] beads were filed this run (all findings matched existing tracked issues). This result is purely informational: it does not gate the current sprint's PASS/FAIL verdict, and both the suite failures and the smoke-test block are pre-existing, already-tracked breakage that carries over to a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
