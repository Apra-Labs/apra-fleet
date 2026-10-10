# Sprint Analysis: feat/sprint-robustness-cli-and-hosts

Scope issue id(s): apra-fleet-xx7x, apra-fleet-d3z0, apra-fleet-fqkr.
Base branch: feat/kb-redesign.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [14, 21].
High-water-mark closed count this sprint: 27.
Final closed count: 21.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Net diff reviewed: origin/feat/kb-redesign...HEAD (81 files; local feat/kb-redesign ref was stale). npm run build OK; npm test OK -- vitest 7065 pass/0 fail, client 122, workflow 366, apra-fleet-se 4453, apra-pm 489; tree clean; check-generic-boundary OK; no non-ASCII added; no hygiene issues.

xx7x (shell-loop refusals): dispatch-role.mjs judgeRefusalByImpact accepts a refused dispatch only when the server flags replyComplete and the reply validates against the dispatch schema (+opts.validate), logging a warning; else heal path. member-provisioning.mjs splits refused compound Bash calls with unbash (shell-commands.mjs, fails closed on unmodelled syntax) and, when every inner command is within the composed policy, resumes the SAME session with a run-separately nudge (PERMISSION_NUDGE_CAP=2); isCompoundShellGrant filters Bash(for:*)/while/do/(..) grants -- verified by standalone repro. unbash shipped in install + SEA (gen-sea-config guard extended). All role prompts carry the no-loops rule (enforcing test). Canary script + regression-playbook section with loud NOT RUN; verdict logic unit-tested on recorded 2.1.296 output. Client wrapper updated (replyComplete, llm_cli_not_found, LlmCliNotFound). Live 'Proof' criterion (KB-4c on Docker member) not checkable here.

d3z0 (standalone member server): installer prints MEMBER-STANDALONE instead of failing; probeRemote runs the member's apra-fleet start --autostart --pidfile under nohup (PowerShell-encoded on Windows); later probes restart only when the call failure matches SERVER_DOWN_RE; a user stop is respected; failures report member-server-not-running with log tail + fix. apra-fleet call passes clientExpectedVersion, fixing AUTOSTART_VERSION_UNKNOWN. Docs include the no-restart-on-reboot warning. Live container check left to operator.

fqkr (LLM CLI path): llm-cli-resolver.ts resolves once, stores Agent.llmCli, invokes the quoted absolute path with its dir prepended (POSIX) / & '<path>' (PowerShell) in execute_prompt, provision_llm_auth, update_llm_cli; not-found lists probed locations + fix; probe exec failure -> dispatch_failed, stored path kept; update_member clears the stored path on provider/host/user/shell change.

Follow-ups (newTasks): default-path probe now outranks the old ~/.local/bin PATH prepend; live container verification of standalone mode; permissionWarnings not surfaced beyond the log.

Tools: kb used (kb_session_prime, kb_query); code used (code_impact on healPermissionDenial; index was 1 commit behind, cross-checked by reading the diff). KB: promoted 2 candidates (evidence in kb_promotions).

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail, Claude CLI loop canary: pass).
Carry-over beads filed: none.
Summary: I ran the regression playbook at branch HEAD (325cc1a1). Install smoke passed, with Setup and Teardown both exiting 0. The Claude CLI loop canary passed: CLI 2.1.296 refused the shell loop, and the engine continued with a recorded permission warning. In-sprint smoke is NOT RUN: moved to CI, as the playbook specifies, so overall passed is false. I filed no bead for it. The leftover sandbox-deploy sweep for sprint apra-fleet-xx7x-3-e80ba0-24517542 found nothing to tear down. This result is informational and does not gate the sprint's verdict. No carry-over bugs were filed, so nothing carries over to a future sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-mac1' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 3: doer on member 'fleet-mac1' [Streak [apra-fleet-xx7x.1.1, apra-fleet-xx7x.1.2, apra-fleet-xx7x.1.3]] -- kb_* calls: 3, code_* calls: 2.
- Dispatch 4: doer on member 'fleet-mac1' [Streak [apra-fleet-xx7x.2.1, apra-fleet-xx7x.2.2]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 5: reviewer on member 'fleet-mac1' -- kb_* calls: 3, code_* calls: 6.
- Dispatch 6: doer on member 'fleet-mac1' [Streak [apra-fleet-xx7x.1.3]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 7: doer on member 'fleet-mac1' [Streak [apra-fleet-fqkr.1.1, apra-fleet-fqkr.1.2, apra-fleet-fqkr.1.3]] -- kb_* calls: 1, code_* calls: 2.
- Dispatch 8: reviewer on member 'fleet-mac1' -- kb_* calls: 1, code_* calls: 2.
- Dispatch 9: member 'fleet-mac1' [Streak Assignment] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 10: doer on member 'fleet-mac1' [Streak [apra-fleet-d3z0.1.1, apra-fleet-d3z0.1.2, apra-fleet-d3z0.1.3, apra-fleet-d3z0.1.4]] -- kb_* calls: 3, code_* calls: 5.
- Dispatch 11: doer on member 'fleet-mac1' [Streak [apra-fleet-xx7x.4]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 12: reviewer on member 'fleet-mac1' -- kb_* calls: 1, code_* calls: 3.
- Dispatch 13: deployer on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 14: integ-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 15: planner on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 16: plan-reviewer on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 17: doer on member 'fleet-mac1' [Streak [apra-fleet-xx7x.3.1, apra-fleet-xx7x.3.2]] -- kb_* calls: 2, code_* calls: 1.
- Dispatch 18: reviewer on member 'fleet-mac1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 19: doer on member 'fleet-mac1' [Streak [apra-fleet-fqkr.1.1, apra-fleet-fqkr.1.2]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 20: reviewer on member 'fleet-mac1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 21: doer on member 'fleet-mac1' [Streak [apra-fleet-fqkr.1.1, apra-fleet-fqkr.1.2]] -- kb_* calls: 1, code_* calls: 2.
- Dispatch 22: reviewer on member 'fleet-mac1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 23: deployer on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 24: integ-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 25: reviewer on member 'fleet-mac1' [Final Review] -- kb_* calls: 2, code_* calls: 1.
- Dispatch 26: regression-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.

Per-member totals:
- member 'fleet-mac1': 21 dispatch(es), kb_* calls: 25, code_* calls: 28.
- member 'fleet-mac1-deploy': 5 dispatch(es), kb_* calls: 0, code_* calls: 0.

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $95.7588.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.4825 across 2 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 26 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
