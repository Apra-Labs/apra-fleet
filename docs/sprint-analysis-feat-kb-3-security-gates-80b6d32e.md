# Sprint Analysis: feat/kb-3-security-gates

Scope issue id(s): apra-fleet-b4g.139.4, apra-fleet-b4g.139.5, apra-fleet-rsd9.1, apra-fleet-b4g.138.6, apra-fleet-b4g.138.7, apra-fleet-b4g.138.4, apra-fleet-b4g.16, apra-fleet-8zyg, apra-fleet-0y1i, apra-fleet-assv.10, apra-fleet-b4g.139.6, apra-fleet-b4g.139.7, apra-fleet-b4g.139.8, apra-fleet-b4g.139.9.
Base branch: feat/kb-redesign.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [35, 41].
High-water-mark closed count this sprint: 53.
Final closed count: 41.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Final review of feat/kb-redesign..feat/kb-3-security-gates (32 commits, 94 files). I reviewed the net diff against each bead in scope. Build is clean. npm test passes: vitest 496 files and 6847 tests pass (83 skipped), and the apra-fleet-se node suites pass 118 + 363 + 489 with 0 failures. CI is out of scope.

Verified per bead:
- b4g.139.4: kb_reconcile_prefilter moved to MEMBER_MAINTAINER_TOOLS (member-tool-allowlist.ts). kb_import with an explicit path other than the session's own bible is refused with E-KB-MAINTAINER-REQUIRED in a member session without the grant (kb-import.ts, through memberLacksKbMaintainer and getSessionKbMaintainer). The reconciler tag profile no longer grants write tools. The client, memory-contract and docs are updated.
- b4g.139.5: kb_invalidate passes keepConfirmed, so SqliteProvider.discard and invalidate leave CONFIRMED entries live and report them in `refused`. Both the ids and files forms are covered.
- b4g.138.6: http-transport stores a SessionOwner at initialize. refuseForeignCaller returns 403 on GET, DELETE and non-initialize POST from another identity. Tests are in http-transport.test.ts block (n).
- b4g.138.7: owner-only-fs.ts makes dirs 0700 and files 0600, and uses icacls on Windows. shortSid is used on every sid= log line and in session-caller.
- rsd9.1: member-align.mjs checks every member's preconditions before moving any member, stashes WIP into a named stash, checks out through decideEnsureBranchAction, and then runs the topology check. Refusals name the member, the cause and the fix. Commands are single git calls safe for PowerShell. The skill docs are updated.
- b4g.138.4, 0y1i, assv.10, 139.6, 139.7 and 139.9 are implemented, each with tests.
- b4g.139.8: there is no diff on this branch because the fix was already on the base (#666 commit 4d2566f5). My full run left no new backslash-named files; the 156 already in the repo root date from 2026-10-06.
- 8zyg and b4g.16 stay open, correctly blocked on the out-of-scope remote acceptance run b4g.25. Their local criteria are pinned by engine-no-bible-export-guard.test.mjs and mock-sprint-kb-write-routing.test.mjs.

Findings that don't block (filed as new tasks):
1. A member session without the grant can still retire a CONFIRMED entry through kb_capture with supersedes. audn.ts makeAudnDecision picks it as the explicit-supersede target, sqlite-provider.ts:799 sets retired_reason='superseded', and the next kb_bible_commit drops the entry from the bible. This is the same removal 139.5 closed for kb_invalidate.
2. kb_import with no path, or the own path, reads the uncommitted .fleet/kb-canonical.json from the work tree. A member agent can edit that file and import CONFIRMED entries without the grant.
3. acquireGitNexusEntry (code-intelligence-gitnexus.ts) loops with no limit if each new gitnexus child is retired before it is acquired, spawning one child per pass.

KB: promoting one entry (dbf606ef) and discarding one (291abbfa); reasons are in kb_promotions and kb_discards. Leaving ec811dd3 as INFERRED; it largely duplicates CONFIRMED entry 39cb4bc6. Tools: kb was used (session_prime, query). code_impact was attempted, but the index was stale and rebuilding, so I traced the diff by reading the code.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: I ran the regression-test-playbook.md at HEAD 0707f2bf1eebe9c67c6a69ca770131c5d4de4027. The playbook's required permission prefixes were all covered by the merged settings. Install smoke passed. Setup acquired the sandbox lock and installed from this checkout into the throwaway HOME. It freed port 18700, started the server, and `status` plus the server.json check confirmed it was bound to 18700. Teardown then released the lock, stopped the server and deleted the sandbox; the port no longer answers and both the sandbox and its lock file are gone. The leftover sandbox-deploy sweep for this sprint's id exited 0 with 'nothing to tear down'. In-sprint smoke: NOT RUN: moved to CI. The playbook says to report this as passed:false, so the overall result is passed:false. No bead was filed for it. No product failures were found and no carry-over beads were filed. This result is informational and does not gate the sprint's verdict.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 1, code_* calls: 0.
- Dispatch 3: doer on member 'fleet-lin1' [Streak [apra-fleet-b4g.139.4.1, apra-fleet-b4g.139.5.1, apra-fleet-b4g.139.4.2, apra-fleet-b4g.139.5.2]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 4: doer on member 'fleet-lin1' [Streak [apra-fleet-b4g.16.5]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 5: doer on member 'fleet-lin1' [Streak [apra-fleet-b4g.138.4.1, apra-fleet-b4g.138.4.2]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 6: doer on member 'fleet-lin1' [Streak [apra-fleet-0y1i.1, apra-fleet-0y1i.2, apra-fleet-assv.10.1, apra-fleet-assv.10.2, apra-fleet-assv.10.3]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 7: doer on member 'fleet-lin1' [Streak [apra-fleet-b4g.139.8.1, apra-fleet-b4g.139.8.2]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 8: reviewer on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 1.
- Dispatch 9: doer on member 'fleet-lin1' [Streak [apra-fleet-rsd9.1.1, apra-fleet-rsd9.1.2]] -- kb_* calls: 2, code_* calls: 1.
- Dispatch 10: doer on member 'fleet-lin1' [Streak [apra-fleet-b4g.139.9.1, apra-fleet-b4g.139.9.2]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 11: reviewer on member 'fleet-lin1' -- kb_* calls: 1, code_* calls: 2.
- Dispatch 12: doer on member 'fleet-lin1' [Streak [apra-fleet-b4g.139.6.1, apra-fleet-b4g.139.6.2, apra-fleet-b4g.139.7.1, apra-fleet-b4g.139.7.2, apra-fleet-8zyg.4]] -- kb_* calls: 3, code_* calls: 3.
- Dispatch 13: reviewer on member 'fleet-lin1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 14: deployer on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 15: integ-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 16: planner on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 17: plan-reviewer on member 'fleet-lin1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 18: doer on member 'fleet-lin1' [Streak [apra-fleet-b4g.138.6.1, apra-fleet-b4g.138.6.2, apra-fleet-b4g.138.7.1, apra-fleet-b4g.138.7.2]] -- kb_* calls: 2, code_* calls: 2.
- Dispatch 19: reviewer on member 'fleet-lin1' -- kb_* calls: 2, code_* calls: 2.
- Dispatch 20: doer on member 'fleet-lin1' [Streak [apra-fleet-b4g.138.7.1]] -- kb_* calls: 0, code_* calls: 0.
- Dispatch 21: reviewer on member 'fleet-lin1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 22: deployer on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 23: integ-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 24: reviewer on member 'fleet-lin1' [Final Review] -- kb_* calls: 2, code_* calls: 2.
- Dispatch 25: regression-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.

Per-member totals:
- member 'fleet-lin1': 20 dispatch(es), kb_* calls: 20, code_* calls: 17.
- member 'fleet-mac1-deploy': 5 dispatch(es), kb_* calls: 0, code_* calls: 0.

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $39.9526.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.4760 across 2 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 25 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
