# Sprint Analysis: feat/v05-m1-node-path

Scope issue id(s): apra-fleet-i9ag.19.
Base branch: v0.5_dashboard.
Cycles run: 4.

## Progress

Closed-bead count history (per cycle evaluation): [31, 42, 44, 47].
High-water-mark closed count this sprint: 48.
Final closed count: 47.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- PASS. Reviewed the net diff origin/v0.5_dashboard..feat/v05-m1-node-path (40 files, +10247/-264). NOTE: local v0.5_dashboard is 61 commits behind origin; origin/v0.5_dashboard (2dbc93d) IS an ancestor of the branch, so that is the range reviewed.

VERIFIED MYSELF (not from bead counts): npm run build exit 0; full bounded npm test exit 0 -- vitest 406 files/6026 tests passed, apra-fleet-se concurrent lane pass=4920 fail=0, serial lane pass=298 fail=0; tree clean before and after.

The epic's acceptance is genuinely implemented and proven. Install records absolute node/bd paths (fleet-se-prereqs.ts resolveFleetSeToolchainPaths; supervisor.ts seedSupervisorToolchain, atomic and projectDir-preserving); project-config.mjs readToolchainBlock validates nodePath only and degrades totally; node-runner.mjs adds CONFIGURED as tier 2 with hard-error semantics; spawner.mjs + lib/child-path-env.mjs prepend the recorded node dir to the sprint child PATH case-correctly; exec-bd.mjs routes bd through the recorded path. i9ag19-14 spawns a real serve.mjs under a scrubbed PATH (node ENOENT asserted as a premise), asserts the sprint child's OWN execPath is the recorded node, asserts both the supervisor's and the child's bd calls ran under it, and includes a real control proving the shim fails without the fix. All 3 cases passed in my run.

ONE REAL DEFECT -- reopening apra-fleet-i9ag.19.35. node-version.mjs classifyIncompleteProbe keys 'timeout' on err.killed===true only, which is the ASYNC execFile shape (toolchain.mjs). node-runner.mjs defaultExec is execFileSync, whose timeout error is {code:'ETIMEDOUT', killed:undefined}. Confirmed with a standalone repro against the real module: same hanging binary, same {retry:true} -- async exec gives incomplete:'timeout' after 2 attempts; sync exec gives incomplete:null after 1. So the CONFIGURED tier leg-2 probe does not retry and emits the exact 'does not resolve to a usable Node.js runtime' wording that .35 AC2 reserves for a genuinely broken recording. Reachable in production: under the installed SEA binary knownSelfNodeVersion cannot short-circuit, so a startup probe that times out under load leaves nodeOk false, no configuredNodeVersion is passed, and every launch takes leg 2. AC3 still holds (leg 1 covers accepted nodes), so this is wrong-message plus missing-retry, not an epic blocker. Invisible to the suite because every timeout fixture hand-builds {killed:true} (i9ag15-node-runner 653/724/784, i9ag19-16:156, i9ag19-9:358/775).

Hygiene clean: no temp/tool files; no shared-owner file (deploy.md, playbooks, ci.yml, CLAUDE.md) touched; harvester.md change stays target-agnostic; docs/sprint-analysis-* matches 28 siblings. run-tests.mjs's two-phase split shares one deadline (serial lane had 798s of 900s left here) with a loud registry staleness guard. KB/code_* tools unavailable this pass (apra-fleet MCP refused connection), so no promotions.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: apra-fleet-zl0u, apra-fleet-o4vi, apra-fleet-9cok.
Summary: Ran the full regression pass at branch feat/v05-m1-node-path HEAD a8d9d543 (sprint apra-fleet-i9ag.19). Part 1 (real-bd suite, node scripts/run-integ-suites.mjs, resumed a stale prior-session run then completed 314/314 files): 13 test files failed and 45 files exceeded the 300s single-file budget (worst: phase3-dispatch-engine-completeness.test.mjs at 4707s); npm run test:slow additionally failed 1 of 2 tests (bd-replay recording drift). Every one of these failures matches a known, already-open [regression][carry-over] or [integ] bead (golden-transcript cascade, beads-identity, parent-child-cycle-repair, supervisor-guard-e2e, supervisor-lifecycle, serve-wiring flake, the single-file-budget bug, and the planner-dispatch-stalled-session slow-lane drift), so those 8 beads were updated with today's evidence rather than duplicated; 3 files (mock-sprint-beads-health-gate-empty-remote, mock-sprint-regression-failure-never-gates, mock-sprint-sprint-state-client-hoist) had only closed prior beads for the same recurring timeout, so 3 fresh standalone parent-less beads were filed following this repo's established re-recurrence convention. Part 2 (smoke test): Setup fully succeeded (install, server start on port 18700 verified, toy-repo clone, sandbox-local git mirror + beads seed with isolation verified, supervisor boot on port 18701 with identity-checked readiness), but Test scenario step 3a (seeding the toy-doer's LLM credential) was denied by the Claude Code auto-mode classifier ('[Credential Leakage]') -- an already-tracked, known environment blocker (apra-fleet-j48h), so no workaround was attempted per this repo's CLAUDE.md policy and the smoke test could not proceed past step 3a. Teardown ran to completion despite two more already-known environment gotchas along the way (apra-fleet-5mu3's supervisor-stop false-alive race, and apra-fleet-jz2m's macOS ps -eo etimes incompatibility breaking the dolt-sql-server reap) -- both were handled by hand per prior-run precedent and the sandbox was fully removed; the leftover sandbox-deploy sweep for this sprint's own reservation id found nothing to tear down, and a final port check confirmed 18700/18701/3001 are all free.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
