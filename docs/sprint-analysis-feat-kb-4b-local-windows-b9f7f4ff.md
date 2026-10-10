# Sprint Analysis: feat/kb-4b-local-windows

Scope issue id(s): apra-fleet-b4g.140, apra-fleet-b4g.141, apra-fleet-b4g.142.
Base branch: feat/kb-redesign.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [11].
High-water-mark closed count this sprint: 14.
Final closed count: 11.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Final review of feat/kb-4b-local-windows vs origin/feat/kb-redesign (10 commits, 12 files). Read the whole diff.

b4g.140 (kb-maintainer flag on older member installs): member-call.mjs probes 'apra-fleet call --help' on the member before the first kbMaintainer call to a remote member, and caches the answer per member. The probe relies on the usage text. I checked src/cli/call.ts at fd86d099^: the older usage prints 'apra-fleet call --member' without --kb-maintainer. When the member's install is too old, the call throws E-MEMBER-FLEET-TOO-OLD before any exclude, send_files or call runs, so no args file is delivered. If the probe gives no answer and the call then rejects the flag, the error is the same and the args-file delete still runs. kb.mjs keeps the promote batch and the bible-commit ids queued and logs one WARNING with the update_member fix. member-init-probe.mjs adds a member-fleet-outdated warning that never blocks a sprint (step 'install' is not a gating step). It fires when the member's version is older than member_detail server_version, or when a remote kb_maintainer lacks the flag. Local members are never probed. Tests cover all of these paths.

b4g.141 (gitnexus id check): stripIdTags only treats '#<arity>' as a tag in the last path segment, at the end of the id or before '~'/'$'. It also drops '@row:col' suffixes from the symbol part. Tests use real 1.6.12 id shapes: local callables, #12 directories, @scope directories, and real mismatches that must still be flagged. code_impact on stripIdTags: LOW risk, 3 callers, all in code-intelligence-gitnexus.ts.

b4g.142 (embeddings doc): docs/code-intelligence-embeddings.md now matches GITNEXUS_ANALYZE_ARGS and the MCP child spec ('-y', GITNEXUS_PACKAGE_SPEC, 'mcp'). A new drift test pins the doc to those constants. The PM skill's --index-only lines match packages/apra-fleet-se/apra-pm/skills/pm/index.md.

Tests (full npm test, local): apra-fleet-se 4382/0 and 489/0. Vitest: 6893 passed, 1 failed. The failure is tests/windows-hide-spawn-guard.test.ts 'installed MCP SDK stdio transport hides its child on win32'. It comes from stale local node_modules: @modelcontextprotocol/sdk 1.27.1 is installed but package.json requires ^1.32.1, and this diff does not touch package.json or that test. Not caused by this branch. CI was not considered.

The file changes are all justified by the beads; the .fleet/kb-canonical.json changes are bible commits made by the workflow.

KB: I left the backfill-flake candidate INFERRED. The cause it names is plausible (the afterEach at kb-bible-backfill.test.ts:110 compares the whole os.tmpdir() listing), but the test passed in my full run, so I did not see the flake myself.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: Ran the playbook at branch HEAD. Install smoke passed: a fresh install into the throwaway HOME succeeded, the fleet server came up on scratch port 18700, and Teardown ran and exited 0. The leftover sandbox-deploy sweep for this sprint's id (apra-fleet-b4g.140-3-1b697f-ba8d0c98) exited 0 with 'nothing to tear down'. In-sprint smoke was NOT RUN: moved to CI, as the playbook specifies. Because of that, overall passed is false by the playbook's definition, not because of a product failure. No bead was filed for it. This result is informational and does not gate the sprint. No failures were found, so there are no carry-over beads.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-win1' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 3: doer on member 'fleet-win1' [Streak [apra-fleet-b4g.140.1, apra-fleet-b4g.140.2, apra-fleet-b4g.140.3, apra-fleet-b4g.140.4]] -- kb_* calls: 1, code_* calls: 4.
- Dispatch 4: reviewer on member 'fleet-win1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 5: doer on member 'fleet-win1' [Streak [apra-fleet-b4g.141.1, apra-fleet-b4g.141.2, apra-fleet-b4g.142.1, apra-fleet-b4g.142.2]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 6: reviewer on member 'fleet-win1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 7: deployer on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 8: integ-test-runner on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 9: reviewer on member 'fleet-win1' [Final Review] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 10: regression-test-runner on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.

Per-member totals:
- member 'fleet-win1': 7 dispatch(es), kb_* calls: 7, code_* calls: 8.
- member 'fleet-win3': 3 dispatch(es), kb_* calls: 0, code_* calls: 0.

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $33.5413.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.2667 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 10 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
