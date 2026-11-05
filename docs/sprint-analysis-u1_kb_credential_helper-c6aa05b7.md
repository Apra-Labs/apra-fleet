# Sprint Analysis: u1_kb_credential_helper

Scope issue id(s): my-beads-db-rug.9, my-beads-db-rug.10.
Base branch: u1_upstream_main_a56ec06.
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

PASS -- Final review of my-beads-db-rug.9 and .10 on u1_kb_credential_helper. The base branch exists only as origin/u1_upstream_main_a56ec06. I read the net diff for both beads (commits 2fce479c..3a62daf5) and checked the file hygiene of the whole 33-file branch. Every file belongs to the credential-helper epic. No temp files or stray config.

.9 (child .9.1 closed): src/utils/find-on-path.ts adds candidateExtensions. On win32 a bare name is now tried only with each PATHEXT extension. A name that already ends in a PATHEXT extension (any case) is tried as-is. POSIX is unchanged. This fixes the case where resolveHelperProgram in credential-store.ts stored an extensionless npm shim instead of foo.cmd.

I checked every direct caller of findExecutableOnPath with code_impact:
- resolveClaudeOnPath is POSIX-only.
- computeServicePathEntries, npxUnavailableReason, codeIntelPathWarning and findOnPath only check whether npx/node exist, and npx.cmd still resolves.
- No caller depended on the old extensionless match.

tests/find-on-path.test.ts covers:
- foo.cmd preferred over foo and foo.ps1
- an extensionless foo in an earlier PATH dir is skipped
- a mixed-case extension already in the name
- npx resolving to npx.cmd
- only an extensionless file present returns null
- POSIX unchanged

.10 (child .10.1 closed): src/tools/execute-command.ts resolveSecretTokens now calls isCredentialHelper before returning the not-found error. It says the name is a server-side credential helper and never points to credential_store_set. tests/secret-helper-cli-e2e.test.ts asserts the new wording. It also asserts that neither credential_store_set nor the helper program path appears in the output. A new test confirms an unregistered name still gets the not-found message.

Tests, run in a separate WSL git worktree because ~/apra-fleet-tests has uncommitted changes I did not touch:
- npm ci and the build passed.
- The targeted files passed: find-on-path, service-path, secret-helper-cli-e2e, install-code-intel-path-warning and code-intelligence (123/123).
- Root vitest: 533 files passed, 9 skipped, 8 failed.
- apra-fleet-se suite: passed (exit 0, 5312 tests). I re-ran it after my first attempt broke because I removed the worktree while it was running.

All 8 vitest failures have one cause: exit 127, '/bin/bash: node: command not found'. The shells LocalStrategy spawns in the non-login ssh session cannot find node. The failing files are agy-project, compose-permissions-agy-delivery, compose-permissions-member-mcp, member-mcp-config-e2e, agy-provider-fixes, relay-executor, spoke-e2e and execute-prompt-max-total-real-timers. The branch changes none of those areas. agy-project still fails alone with node added to PATH, so the cause is the ssh session environment, not this branch. I did not re-run these files on the base branch.

KB: I am promoting the one candidate, ef75ce51, after checking it against candidateExtensions and its tests.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: I ran the Install smoke part: a fresh install into the throwaway HOME, then the fleet server booted on scratch port 18700 and verified bound to it. Teardown then released the lock, stopped the server and removed the sandbox, and all of it passed. The leftover-sandbox sweep for this sprint's id reported 'nothing to tear down'. In-sprint smoke is NOT RUN: moved to CI, because the playbook says it needs an LLM credential an agent cannot provision. As the playbook requires, overall passed is false because of that part; I filed no bead for it. The permissions check passed. This result is informational and does not gate the sprint, and no carry-over bugs were filed.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'repo3-apra-fleet' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'repo3-apra-fleet' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 3: doer on member 'repo3-apra-fleet' [Streak [my-beads-db-rug.9.1.1, my-beads-db-rug.9.1.2]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 4: doer on member 'repo3-apra-fleet' [Streak [my-beads-db-rug.10.1.1, my-beads-db-rug.10.1.2]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 5: reviewer on member 'repo3-apra-fleet' -- kb_* calls: 1, code_* calls: 2.
- Dispatch 6: deployer on member 'dev2-deploy-ubuntu' -- kb_* calls: unknown, code_* calls: unknown (unknown: member tools unavailable: server-status-unreadable -- Exit code: 127 [stderr] bash: line 1: apra-fleet: command not found).
- Dispatch 7: integ-test-runner on member 'dev2-deploy-ubuntu' -- kb_* calls: unknown, code_* calls: unknown (unknown: member tools unavailable: server-status-unreadable -- Exit code: 127 [stderr] bash: line 1: apra-fleet: command not found).
- Dispatch 8: reviewer on member 'repo3-apra-fleet' [Final Review] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 9: regression-test-runner on member 'dev2-deploy-ubuntu' -- kb_* calls: unknown, code_* calls: unknown (unknown: member tools unavailable: server-status-unreadable -- Exit code: 127 [stderr] bash: line 1: apra-fleet: command not found).

Per-member totals:
- member 'repo3-apra-fleet': 6 dispatch(es), kb_* calls: 6, code_* calls: 4.
- member 'dev2-deploy-ubuntu': 3 dispatch(es), kb_* calls: unknown, code_* calls: unknown (3 dispatch(es) with unknown counts) (unknown: member tools unavailable: server-status-unreadable -- Exit code: 127 [stderr] bash: line 1: apra-fleet: command not found).
