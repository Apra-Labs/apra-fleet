# Sprint Analysis: fix/v05-m1-sea-and-fresh-clone

Scope issue id(s): apra-fleet-v6t7.21, apra-fleet-v6t7.22.
Base branch: v0.5_dashboard.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [6].
High-water-mark closed count this sprint: 8.
Final closed count: 6.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Final review of v0.5_dashboard..fix/v05-m1-sea-and-fresh-clone (4 commits, 6 files). I reviewed the net diff against both scope beads.

v6t7.21 (SEA staleness guard omits bundled workspace packages): MET. tests/helpers/sea-binary-staleness.ts adds src + package.json for apra-fleet-client, fleet-api-contract and apra-fleet-ui-kit to SEA_RELEVANT_GIT_PATHS. That list feeds both the `git diff` (line 217) and the `git status --porcelain` (line 230) staleness checks. Choosing src+package.json over the whole directory is sound. apra-fleet-client exports raw src/*.mjs. fleet-api-contract exports a gitignored dist built by tsc from src. scripts/build-sea.mjs bundles with bundle:true and only cpu-features external, so both packages are inlined into the binary. tests/sea-binary-staleness.test.ts pins each of the 6 entries and fails if any is removed. It also checks that test/dist paths do not match, and that a client change produces a stale verdict naming the file. docs/npm-packaging.md section 7.1 no longer says ui-kit is missing from the list.

v6t7.22 (fresh clone npm test fails without build:ui): MET. The root pretest is now `build:contract && build:ui:checked`. scripts/build-ui-checked.mjs builds ui-kit and then shell-ui, and exits non-zero if shell-ui/dist/index.html is missing. tests/pretest-builds-ui.test.ts pins three things: the order contract -> UI, that ui-kit builds before shell-ui, and that the stale comment is gone. Both stale ci.yml comments (two jobs) now correctly say the shell-ui dist is in the package.json files list. In my test run, pretest visibly rebuilt both UI workspaces before vitest.

Tests: full `npm test` exit 0. Vitest: 501 files passed, 10 skipped; 7262 tests passed. apra-fleet-client, apra-fleet-workflow and apra-fleet-se: 0 failures.

Hygiene: every changed file maps to the two beads. The working tree has 31 untracked backslash-named files (`\var\folders\...\fleet-wintask-*\apra-fleet-service.js`). They are leftovers from earlier runs (Oct 5, 05:46-10:29) of a launcherPathFor bug, which src/services/service-manager/windows.ts already fixes on the base branch. They are not part of this diff.

Minor follow-ups (filed as newTasks, not blocking):
(a) The staleness list still omits tracked build inputs: the tsconfig.json of fleet-api-contract and ui-kit, and fleet-api-contract/openapi.json.
(b) CI now builds the UI twice: the explicit build:ui step, then again in pretest. That comment block also still says 'until then this is a no-op'.

KB: promoted 1 entry (verified; see kb_promotions). code_impact could not find SEA_RELEVANT_GIT_PATHS: the index was behind HEAD (052ec38e) and the symbol lives in a test helper, so I fell back to reading the code and grep. kb_query was used.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: I ran regression-test-playbook.md at branch HEAD (c25662ff5a78e6c8da955132ec907325bad5b7dc). The permissions check passed: every required prefix is covered by the merged settings.json and settings.local.json. Install smoke passed. Setup acquired the sandbox lock, ran a fresh install into the throwaway HOME, freed port 18700, started the server and confirmed it bound to 18700. Teardown then released the lock, stopped the server and deleted the sandbox. The leftover sandbox-deploy sweep for this sprintId reported nothing to tear down. In-sprint smoke is NOT RUN: moved to CI, so I report it as passed: false per the playbook and filed no bead for it. Overall passed is false because of that part. No failures were found and no beads were filed. This result is informational and does not gate the sprint's verdict. Any failures would have carried over to a future sprint as parent-less beads.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-mac1' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 3: doer on member 'fleet-mac1' [Streak [apra-fleet-v6t7.22.1.1, apra-fleet-v6t7.22.1.2]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 4: doer on member 'fleet-mac1' [Streak [apra-fleet-v6t7.21.1.1, apra-fleet-v6t7.21.1.2]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 5: reviewer on member 'fleet-mac1' -- kb_* calls: 2, code_* calls: 1.
- Dispatch 6: deployer on member 'fleet-mac1-deploy' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 7: integ-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 8: reviewer on member 'fleet-mac1' [Final Review] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 9: regression-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.

Per-member totals:
- member 'fleet-mac1': 6 dispatch(es), kb_* calls: 7, code_* calls: 2.
- member 'fleet-mac1-deploy': 3 dispatch(es), kb_* calls: 1, code_* calls: 0.

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $4.1254.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0284 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 9 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
