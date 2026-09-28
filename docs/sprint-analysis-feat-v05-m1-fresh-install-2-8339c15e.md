# Sprint Analysis: feat/v05-m1-fresh-install-2

Scope issue id(s): apra-fleet-i9ag.12, apra-fleet-i9ag.13.
Base branch: v0.5_dashboard.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [13, 20, 27].
High-water-mark closed count this sprint: 29.
Final closed count: 27.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
Integration test failures (1): C1: No open type=feature beads were in scope this cycle (empty list, normal no-op). For the verify-set bead apra-fleet-i9ag.13, I re-verified against the currently deployed sandbox build (branch feat/v05-m1-fresh-install-2, HEAD 0ace7dce, sandbox-id apra-fleet-i9ag.12-apra-fleet-i9ag.13-06-d8087d9e) and found the fix does not hold: src/cli/beads-install.ts (the release-binary module) does not exist on this branch, src/cli/install.ts still runs the exact pre-fix path (execFileSync('npm', ['install','-g','@beads/bd@1.3.0'], {shell:true}) with a non-fatal 'Beads install skipped' warn on failure), there is no node/npm detect-and-fail-loudly step, exec-bd.mjs (both copies) are still the old npm-shim helpers rather than fleet-bin-directory resolvers, and none of the child tests' expected files (tests/beads-install.test.ts, tests/install-beads.test.ts, tests/bd-release-binary-resolution.test.ts) exist on this branch. The prior closure evidence on i9ag.13 was real but was gathered against a different, non-ancestor sibling branch (feat/v05-m1-fresh-install, HEAD fc681288) that this branch never merged. I reopened apra-fleet-i9ag.13 and filed apra-fleet-i9ag.13.7 (P1) under it with the file/line evidence and repro steps, then tore down the sandbox (exit 0, both sandbox root and env file removed). (bugs filed: apra-fleet-i9ag.13.7)

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed the net diff (20 commits, 26 files). NOTE: local v0.5_dashboard is 51 commits stale; the real base is origin/v0.5_dashboard (2b6cd876) and I reviewed against that.

BUILD+TESTS: npm run build exit 0. Bounded npm test exit 0 -- vitest 390 files pass/5 skip/0 fail, apra-fleet-se pass=4633 fail=0, workflow 322/0, apra-pm 468/0. No lint script configured.

i9ag.12 MET. fleet.key is minted in src/cli/install.ts before every numbered step (getOrCreateKey + new fleetKeyPath export in src/services/jwt.ts), so the key exists before the supervisor service is registered/started (install.ts:1907). serve.mjs's three one-shot 'skipping registration' branches are replaced by startRegistrationConvergence() (packages/apra-fleet-se/src/registration/register.mjs), which re-resolves token+connection+origin every pass -- correct, because an absent fleet.key pins the token source and APRA_FLEET_TRANSPORT unset returns mode 'stdio' instead of throwing. Traced the shutdown/failure path: stop() releases a mid-backoff loop, currentRegistration().unregister() flips the inner loop's stopped flag, and done.catch() prevents an unhandled rejection. Covered by registration-convergence.test.mjs (7 cases, including the stdio-fallback branch a partial fix would miss) and tests/install-fleet-key.test.ts.

i9ag.13 MET, and the C1 integration failure no longer holds. That verification ran at HEAD 0ace7dce; the fix landed in the LATER commits 490ebcd2 / d3d3195b / 501dcbd9. Verified at current HEAD myself: src/cli/fleet-se-prereqs.ts is the single owner of MIN_NODE_VERSION and FLEET_SE_PREREQ_FIX_LINE (numeric version compare, injectable exec+platform); install.ts:1674 gates fleet-se on the prereq and exits 1 with the fix line verbatim before any fleet-se asset extraction; the Beads step is now fatal both on npm failure and on a post-install probeBdVersion()===null (the npm-global-bin-not-on-PATH false success); 'Beads install skipped' is gone, pinned by a grep canary test. Per the owner re-scope, the absence of beads-install.ts is intentional. beads-pin.ts centralises the pin and apra-pm/install.mjs is corrected 1.1.2 -> 1.3.0 and now exits non-zero (i9ag.12.4). status.ts / check-status.ts / Health.tsx report prereqs degrade-safe, and docs/install.md states the prerequisite accurately (I verified the --workflows none claim against the installWorkflows gate at install.ts:1907).

Test quality is genuinely falsifiable, not decorative: revert canaries, version boundary cases, and a non-vacuous win32-vs-POSIX branch assertion.

REOPENED: i9ag.12.6 -- fix demonstrably absent. Four secondary findings filed as newTasks; none block this epic's acceptance criteria.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Ran regression-test-playbook.md Part 1 (real-bd suite, resumed a stale prior run to completion: 290/290 files done, 7 failed) and Part 2 (sandbox smoke test: Setup fully succeeded, but Test scenario step 3a's credential-provisioning commands were denied twice by the auto-mode classifier, so registration/dispatch/canary assertion never ran; Teardown ran to completion after manually confirming a false-positive supervisor-alive report). Every failure found (Part 1: golden-transcript cascade, mock-sprint-beads-identity, mock-sprint-parent-child-blocks-cycle-repair, phase3 budget overrun, slow-lane planner-dispatch-stalled-session recording drift; Part 2: classifier block on step 3a, Teardown identity-check race) is an exact recurrence of an existing open [regression][carry-over] bead (zekq, vwa2, 0aer, ye8j, j48h, 5mu3); each was updated with a dated recurrence note via bd note rather than filed as a new duplicate, so bugsFiled is empty. This result is informational only and does not gate the current sprint's PASS/FAIL verdict; the underlying breakage carries over to a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
