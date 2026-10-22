# Sprint Analysis: fix/member-mixed-tier-reads

Scope issue id(s): apra-fleet-a4cl.
Base branch: main.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [1, 7].
High-water-mark closed count this sprint: 9.
Final closed count: 7.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
Integration test failures (1): C1: Tested apra-fleet-a4cl.1 (member mixed-tier KB reads) at 5e27f182. I ran the five member KB vitest files directly with npx vitest, not through npm test, because the bounded runner takes no file filter. They were kb-member-mixed-tier-reads, kb-member-mixed-tier-non-sqlite, kb-member-own-scope, kb-member-read-routing and member-bible-view. All 5 files and 59 tests passed. They cover the superset, other-member isolation, zero-captures and same-id de-duplication behavior for kb_query, kb_list, kb_session_prime and kb_context. The feature stays open because acceptance criterion 5 is not met. The kb_query, kb_list, kb_session_prime and kb_context descriptions in src/services/tool-registry.ts still describe the old member read scope. The feature commits have no diff to tool-registry.ts or memory-contract, and impl task apra-fleet-a4cl.1.3 (wording) is still open. I filed apra-fleet-a4cl.2 (P2) under apra-fleet-a4cl. The [test] task apra-fleet-a4cl.1.4 is also still open, though its test files already exist and pass. I did not run the revert-check or the FULL-session unchanged check from that task, and I did not run the full npm test suite. The sandbox for this sprint was torn down cleanly. (bugs filed: apra-fleet-a4cl.2)

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Final review of apra-fleet-a4cl on fix/member-mixed-tier-reads. Local main was stale, so I reviewed the net diff against origin/main: 8 sprint commits, 20 files.

What changed: src/services/knowledge/kb-self.ts adds getMemberSplitRead and mergeSplitById. In a member session, a tier list that names CONFIRMED plus another tier is now split. CONFIRMED comes from the checkout bible view plus the untagged global KB. The other tiers come from the per-repo DB and global KB, filtered to member:<uuid>. Results are merged by id and the bible copy wins. kb_query (splitQuery), kb_list, kb_session_prime (primeFrom/mergePrimed) and kb_context (splitContext, which also takes the member default read) all go through it. FULL sessions, explicit-anchor callers, CONFIRMED-only reads and reads naming only non-CONFIRMED tiers keep the old path. A non-sqlite per-repo KB is still refused with a typed error naming the tool.

Epic criteria:
- Superset, other-member isolation, zero captures, same-id de-dup and FULL-session-unchanged are each tested for all 4 tools in kb-member-mixed-tier-reads.test.ts and kb-member-mixed-tier-non-sqlite.test.ts.
- kb-member-read-routing.test.ts used to assert that a mixed kb_query returns []. It now asserts the bible ids, which works as a revert check.
- No input-schema change, so packages/apra-fleet-client is unchanged.
- The integ C1 gap (wording, criterion 5) is closed by 2bed0b53: tool-registry.ts, generate-contract.mjs, the bindings, spec.md, INVENTORY.md and docs/knowledge-layer.md were updated, and kb-member-read-scope-wording.test.ts pins the new wording. A repo-wide grep found no leftover old member-scope wording.
- No fleet-sprint or client caller requests mixed tiers, so the behaviour change only reaches direct member-session tool calls.

Verification: npm run build OK. npm run contract:check OK. npm test: vitest 509 files and 7246 tests passed, 1 failed; all apra-fleet-se node:test suites 0 failed. The failure is tests/windows-hide-spawn-guard.test.ts 'installed MCP SDK stdio transport hides its child on win32'. It is caused by this machine's stale node_modules (installed @modelcontextprotocol/sdk is 1.27.1, the lockfile pins 1.32.1). The branch touches no package files, so it is not caused by this branch.

Non-blocking findings, filed as newTasks:
(1) With a limit, a mixed kb_list re-sorts by id and then limits. It is then not a superset of the CONFIRMED-only list at the same limit. kb_query keeps the bible half first.
(2) A member's own capture promoted to CONFIRMED in the per-repo DB no longer appears in an explicit mixed kb_query/kb_list/kb_session_prime until it reaches the bible. Before this change an explicit [C,I,U] read returned it, and kb_context's default read still counts it.

KB: I promoted 86ae8b43 after reading the test and seeing it pass in this run.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: I ran the playbook's two parts in order. The permissions check found every required prefix covered. The leftover sandbox-deploy sweep for this sprint's id reported nothing to tear down. Install smoke passed: the sandbox lock was acquired, a fresh install into the throwaway HOME succeeded, and port 18700 was confirmed free. The server then started on 18700 (pid 44660), status reported it running on 18700, and server.json confirmed port 18700. Teardown released the lock, stopped the server and deleted the sandbox, so no instance, sandbox or lock is left behind. In-sprint smoke was NOT RUN: moved to CI. The playbook requires it to be reported as passed: false and the overall result to be passed: false, and it says to file no bead. I did not provision credentials or run the toy sprint. The overall false therefore reflects only that mandated NOT RUN, not a failure. No failures were found and no carry-over beads were filed. This result is informational and does not gate the sprint.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-win1' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 3: doer on member 'fleet-win1' [Streak [apra-fleet-a4cl.1.1, apra-fleet-a4cl.1.2]] -- kb_* calls: 3, code_* calls: 5.
- Dispatch 4: reviewer on member 'fleet-win1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 5: deployer on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 6: integ-test-runner on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 7: planner on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 8: plan-reviewer on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 9: planner on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 10: plan-reviewer on member 'fleet-win1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 11: doer on member 'fleet-win1' [Streak [apra-fleet-a4cl.1.2]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 12: reviewer on member 'fleet-win1' -- kb_* calls: 1, code_* calls: 2.
- Dispatch 13: doer on member 'fleet-win1' [Streak [apra-fleet-a4cl.1.3, apra-fleet-a4cl.1.4, apra-fleet-a4cl.2.1]] -- kb_* calls: 1, code_* calls: 0.
- Dispatch 14: reviewer on member 'fleet-win1' -- kb_* calls: 1, code_* calls: 1.
- Dispatch 15: deployer on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 16: integ-test-runner on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 17: reviewer on member 'fleet-win1' [Final Review] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 18: regression-test-runner on member 'fleet-win3' -- kb_* calls: 0, code_* calls: 0.

Per-member totals:
- member 'fleet-win1': 13 dispatch(es), kb_* calls: 11, code_* calls: 11.
- member 'fleet-win3': 5 dispatch(es), kb_* calls: 0, code_* calls: 0.
