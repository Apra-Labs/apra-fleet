# Sprint Analysis: feat/v05-m1-console-polish

Scope issue id(s): apra-fleet-i9ag.5, apra-fleet-i9ag.16, apra-fleet-i9ag.20, apra-fleet-i9ag.21.
Base branch: v0.5_dashboard.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [16].
High-water-mark closed count this sprint: 20.
Final closed count: 16.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- FAIL. Build ok; full bounded suite green (TEST_EXIT=0; contract:check/vitest/client/workflow/se/apra-pm all ok; se lane pass=4889 fail=0; vitest 405 files passed).

SCOPE CHECK AGAINST THE REAL DIFF. Local v0.5_dashboard is stale; origin/v0.5_dashboard (546286ca) is an ancestor of the branch, so the net PR diff is 4 commits / 5 files: supervisor/theme.mjs (new), supervisor/dashboard.mjs, registration/project-page.mjs + 2 test files. File hygiene clean, every file justified.

i9ag.20 (Projects page black-on-dark) -- PASS. theme.mjs is a real single source of truth: dashboard.mjs's inline DASHBOARD_CSS is deleted and re-imported, project-page.mjs renders --bg/--text. Tests assert the emitted HTML contains THEME_CSS verbatim and that project-page.mjs declares no tokens itself. theme.mjs does ship (root package.json files[] includes packages/apra-fleet-se/src/; gen-sea-config walks the tree).

i9ag.21 (header counter vs stack) -- PASS. First paint and poll both derive from ONE array: renderIndexPageHtml uses views.length for #running-counter and renderSprintStackHtml(views); poll() sets the counter from the same data.sprints it hands renderSprintStackFromState, which renders one row per element with no filtering. EventSource/heartbeat only call schedulePoll->poll, so there is no second render path. Tests drive the real extracted script.

i9ag.16 -- REOPEN. Defect verifiably persists at branch HEAD. Its REOPENED note (acceptance run on 546286ca) requires the failure reason on the stack row and finished card. dashboard.mjs:276 still reads (isLaunchFailed && run.reason), so an ABORTED run renders reasonHtml='' regardless of reason data -- exactly the observed symptom -- and renderSprintSection surfaces no reason at all. Three P1 children encoding that correction (16.6 terminal-state detection, 16.7 reason on row/card, 16.8 its test) are still OPEN, so per GRAPH-SEMANTICS.md the container is not done. Nothing in this diff touches that code. The close reason's claim that both REOPENED regressions 'are covered by these assertions on this build' is false: the suites it cites were already in 546286ca, the build that reproduced the defect.

i9ag.5 -- REOPEN. Closed on circular evidence, same pattern: all .5 code and the cited i9ag53-console-dashboard-viewer-xlink test landed in df42a0b0 and are present in 546286ca, the binary whose acceptance run reported links=[] on the live viewer and History pages. No code or test landed since, so a passing suite cannot distinguish 'fixed' from 'the test never covered the observed failure mode'. Back-links do exist (proxy.mjs injectLiveViewBackLink; history page 'Back to supervisor'), which makes the untested gap -- most plausibly a viewer reached outside the proxy path -- the thing to pin. i9ag.9, the Windows click-only round-trip acceptance for .5, is itself still OPEN.

No KB promotions: the fleet MCP server failed to connect this session, so no promotion-candidate block was available.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Regression test runner dispatch failed: [Workflow Error] Agent dispatch failed (empty_response): [FAIL] execute_prompt on "fleet-lin1-deploy" exited 0 but produced no parseable output (empty result -- the member CLI likely died mid-turn without printing its result envelope).
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
