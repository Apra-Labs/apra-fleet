# Sprint Analysis: feat/v05-m1-console-polish

Scope issue id(s): apra-fleet-i9ag.22, apra-fleet-i9ag.23, apra-fleet-i9ag.24.
Base branch: v0.5_dashboard.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [10].
High-water-mark closed count this sprint: 13.
Final closed count: 10.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Final review of v0.5_dashboard..feat/v05-m1-console-polish (7 commits, 14 files). I read the net diff against the three in-scope beads.

i9ag.22 (themed /ui placeholder): ui-placeholder.mjs now imports THEME_CSS from ../supervisor/theme.mjs and puts it in a <style> block with only a page-local body padding rule. No token declarations are duplicated. supervisor-project-page.test.mjs asserts THEME_CSS and var(--bg)/var(--text) on PLACEHOLDER_HTML and on GET /ui, /ui/sprints and the two-segment /ui/panels/git. Criteria met.

i9ag.23 (counter vs stack): dashboard.mjs poll() now writes #running-counter in its own try/catch before renderSprintStackFromState. Finished-sprints and beads-freshness also each get their own try/catch, and every error is still console.error-logged. The new live-refresh test drives the real embedded script with sprints:[null,null]. It asserts the render threw and the counter reads 2, not the prior 5. Criteria met.

i9ag.24 (viewer back-link outside the proxy): the workflow viewer gains an opt-in opts.backLink. It is validated at construction (absolute http(s) URL only), HTML-escaped and marked with data-viewer-back-link. Without the option the page is byte-identical (tested). cli.mjs adds --viewer-back-url and exits non-zero on a non-http(s) value before connecting. On the serve path, buildServeSpawnerDeps always supplies viewerBackUrlFor, and spawner refuses a launch with no runId rather than starting a viewer with no link. The proxy strips the child's own anchor before injecting the mount-prefixed one. assertViewerBackLink now also fails if a page has more than one link to the same card, so neither the proxy nor the history route can serve two. The tests derive viewer routes from the rendered dashboard rather than a hand-written list, and cover a direct child fetch with one link, the proxied fetch with one link, and a standalone launch unchanged. All spawnSprint callers (api.mjs:778) pass runId. Criteria met.

Tests: npm run build OK. npm test: contract:check, apra-fleet-client (161), apra-fleet-workflow (361), apra-fleet-se (4953), apra-pm (489) all pass. vitest: 7239 pass, 1 fail: tests/sandbox-deploy.test.ts live up/env/teardown (isolation check: supervisor /api/health did not answer). This is not caused by this branch. The same test fails identically on a v0.5_dashboard worktree. Running the same sandbox-deploy up by hand on this branch, from an os.tmpdir() home, passes verify and smoke. It only fails under vitest. Filed as a follow-up.

Hygiene: every changed file maps to the three beads. The untracked backslash-named files in the repo root are not in the diff. They come from an existing test, tests/windows-service-task-xml.test.ts (filed).

Tools: kb used (kb_query, no hits). code: code_impact failed because gitnexus is offline (spawn npx ENOENT), so I traced callers with grep instead. No promotion candidates were supplied.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: Install smoke passed. A fresh install from this checkout into the throwaway HOME succeeded, and the server started on scratch port 18700. server.json confirmed that port, with no silent rebind. Teardown released the lock, stopped the server and deleted the sandbox. The sandbox-deploy sweep for this sprint's id printed 'nothing to tear down' and exited 0. In-sprint smoke: NOT RUN: moved to CI. The playbook defines it as not run in-sprint, so it is reported as passed: false and forces overall passed: false. No bead was filed for it, as the playbook directs. No test failures occurred, so no carry-over beads were filed. This result is informational and does not gate the sprint. Gotcha: an unrelated directory, ~/temp/.apra-fleet-tests-9te45, was left over from some other run. It was not touched, because the playbook's cleanup only targets the exact sandbox path.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-mac1' -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 2: plan-reviewer on member 'fleet-mac1' -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 3: doer on member 'fleet-mac1' [Streak [apra-fleet-i9ag.22.1.1, apra-fleet-i9ag.22.1.2]] -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 4: doer on member 'fleet-mac1' [Streak [apra-fleet-i9ag.24.1.1, apra-fleet-i9ag.24.1.2, apra-fleet-i9ag.24.1.3]] -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 5: doer on member 'fleet-mac1' [Streak [apra-fleet-i9ag.23.1.1, apra-fleet-i9ag.23.1.2]] -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 6: reviewer on member 'fleet-mac1' -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 7: doer on member 'fleet-mac1' [Streak [apra-fleet-i9ag.22.1.2]] -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 8: reviewer on member 'fleet-mac1' -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 9: deployer on member 'fleet-mac1-deploy' -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 10: integ-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 11: reviewer on member 'fleet-mac1' [Final Review] -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).
- Dispatch 12: regression-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: unknown, code_* calls: unknown (unknown: before-snapshot read failed).

Per-member totals:
- member 'fleet-mac1': 9 dispatch(es), kb_* calls: unknown, code_* calls: unknown (9 dispatch(es) with unknown counts).
- member 'fleet-mac1-deploy': 3 dispatch(es), kb_* calls: unknown, code_* calls: unknown (3 dispatch(es) with unknown counts).

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $10.2799.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0347 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 12 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
