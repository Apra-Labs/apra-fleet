# Sprint Analysis: u1_kb_demote_loop

Scope issue id(s): my-beads-db-bq4.
Base branch: u1_upstream_main_cbe7a39.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [6].
High-water-mark closed count this sprint: 7.
Final closed count: 6.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Final review of epic my-beads-db-bq4 at e56b52ee, net diff u1_upstream_main_cbe7a39..u1_kb_demote_loop (48 files). I re-ran the checks on the WSL test clone with BEADS_DIR unset. npm ci and build: OK. contract:check: OK, 27 tools, all match. apra-fleet-se npm test: pass=5425, fail=0. vitest on tests/knowledge plus the memory-contract roundtrip, fixture-schema and kb-wiring tests: 1135 passed, 1 skipped. That skip was already there before this sprint; the diff adds no skip, only or todo.

Per bead:
- bq4.1 (merge): the merge commit 66d7d7ec has cbe7a39 as its second parent. No conflict markers. EXPECTED_COMMAND_COUNT is 13, and its comment chain adds up (4+2+4+2+1). The net diff lists only #767's own files. kb-member-own-scope.test.ts pins own_scope as the own half of the #777 split read: the own CONFIRMED row appears once, as the member-tagged copy, and the bible-only row is excluded. spec.md documents this.
- bq4.2 (off switch): the kb_demotion_loop arg (CLI --kb-demotion-loop) defaults to on. Any value other than on or off fails loudly, both in validateArgs and in createKbWorkClient. With off, demotionCandidates returns [] with no kb_query and a log naming the setting, and apply() drops demotions. The fresh-look limit is documented in reviewer.md and in docs/kb-member-view-and-maintainer.md. llms-full.txt needs no regeneration because that doc is not linked from llms.txt.
- bq4.3 (guard robustness): all three changes are in. First, a WARN naming the member and the command at every silent-failure site in runner.js. Second, lastSha now advances only when the diff succeeds. Third, demotionCandidates takes the isBusy/inFlight bracket, with the body moved into readDemotionCandidates. kb-demotion-guard-robustness.test.mjs tests these against real git repos and real failing commands, including a dispatch that starts mid-read.
- bq4.4 (tests): a no-flip-cap ping-pong pin; Windows PowerShell and cmd.exe cases in runner-current-file-hashes.test.mjs, with no OS skip; a happy-own-scope contract fixture checked by assertOwnConfirmedRow; a mock-sprint demote path asserted from the ordered event transcript (kb_demote, then kb_bible_commit with demoted_ids); and a tombstone test for 'A demotes, B re-promotes, A commits'.
- bq4.5 (nits): the fleetTooOld branch now returns totalPending(); the contracts.mjs and dispatch-safety comments are fixed; methods.json makes evidenceFiles required, and the regenerated INVENTORY.md matches.

Caveats:
- The Windows shell cases in runner-current-file-hashes run only on win32. They did not run on WSL, so that criterion of bq4.4 is unverified here.
- The inFlight map holds one entry per member. Overlapping kbWork operations on the same maintainer overwrite and delete each other's entries. This pattern existed before the sprint and the bead asked for it to be mirrored; there is a follow-up task.

KB: the one promotion candidate is a claim about a merge procedure (26 conflicts down to 10). I cannot check that against code or tests, so it stays INFERRED.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: I ran the Install smoke part as the playbook defines it. The permissions check passed. Setup took the sandbox lock, ran a fresh install into the throwaway HOME, freed port 18700 and started the server. status reported it running on 18700, and server.json confirmed that port. Teardown released the lock, stopped the server and deleted the sandbox. I confirmed no sandbox directory remains and port 18700 is free. The sweep `sandbox-deploy.mjs teardown --sprint-id my-beads-db-bq4-1-83fa24-96f52347` exited 0 with 'nothing to tear down'. In-sprint smoke is NOT RUN: moved to CI. The playbook requires reporting it as failed, so overall passed is false. I filed no bead for it, as the playbook instructs. This result is informational and does not gate the sprint. No bugs were found, so none carry over. One gotcha: each Bash call is a fresh shell, so the lock was acquired in one call and Setup ran in the next. release still succeeded, so this caused no problem.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'repo3-apra-fleet' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'repo3-apra-fleet' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 3: doer on member 'repo3-apra-fleet' [Streak [my-beads-db-bq4.1]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 4: reviewer on member 'repo3-apra-fleet' -- kb_* calls: 1, code_* calls: 3.
- Dispatch 5: doer on member 'repo3-apra-fleet' [Streak [my-beads-db-bq4.2, my-beads-db-bq4.5]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 6: doer on member 'repo3-apra-fleet' [Streak [my-beads-db-bq4.3, my-beads-db-bq4.4]] -- kb_* calls: 3, code_* calls: 2.
- Dispatch 7: reviewer on member 'repo3-apra-fleet' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 8: deployer on member 'dev2-deploy-ubuntu' -- kb_* calls: unknown, code_* calls: unknown (unknown: member tools unavailable: server-status-unreadable -- Exit code: 127 [stderr] bash: line 1: apra-fleet: command not found).
- Dispatch 9: integ-test-runner on member 'dev2-deploy-ubuntu' -- kb_* calls: unknown, code_* calls: unknown (unknown: member tools unavailable: server-status-unreadable -- Exit code: 127 [stderr] bash: line 1: apra-fleet: command not found).
- Dispatch 10: reviewer on member 'repo3-apra-fleet' [Final Review] -- kb_* calls: 1, code_* calls: 2.
- Dispatch 11: regression-test-runner on member 'dev2-deploy-ubuntu' -- kb_* calls: unknown, code_* calls: unknown (unknown: member tools unavailable: server-status-unreadable -- Exit code: 127 [stderr] bash: line 1: apra-fleet: command not found).

Per-member totals:
- member 'repo3-apra-fleet': 8 dispatch(es), kb_* calls: 10, code_* calls: 9.
- member 'dev2-deploy-ubuntu': 3 dispatch(es), kb_* calls: unknown, code_* calls: unknown (3 dispatch(es) with unknown counts) (unknown: member tools unavailable: server-status-unreadable -- Exit code: 127 [stderr] bash: line 1: apra-fleet: command not found).
