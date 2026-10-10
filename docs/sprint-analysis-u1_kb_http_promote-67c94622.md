# Sprint Analysis: u1_kb_http_promote

Scope issue id(s): my-beads-db-akn.
Base branch: feat/kb-redesign.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [34, 38].
High-water-mark closed count this sprint: 41.
Final closed count: 38.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
Integration test failures (1): C1: No open features were in scope, so nothing was tested there. I ran the full npm test at e24c86d3, the same commit as the sandbox (v0.4.4_e24c86), with BEADS_DIR=/home/umang/my-beads-db/.beads exported, as in the host shell. The vitest suite passed: 504 files and 6922 tests passed, 9 files and 84 tests skipped, 0 failed. tests/smoke-test-flow-e2e-integ.test.ts, the failure in my-beads-db-akn.6, now passes, so I closed .6. The apra-fleet-se suite failed 1 of 5060 tests (pass=5059, fail=1): bd-init-templating.test.mjs sees the real project DB through the leaked BEADS_DIR. The same file passes (1/1) with BEADS_DIR unset. I filed my-beads-db-akn.4.4 for it under .4. I left .4 open because its criterion 3 (full suite green) isn't met here. I did not re-run criteria 1, 2 and 4: earlier notes on .4 say the kb-sprint-path-http-e2e test and the docs how-to were already confirmed. The sandbox was torn down cleanly. (bugs filed: my-beads-db-akn.4.4)

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Reviewed the net diff upstream/feat/kb-redesign...u1_kb_http_promote (39 commits, HEAD 443e2dca; the dispatch's bare base name feat/kb-redesign does not resolve here, so I used upstream/feat/kb-redesign, which equals origin/feat/kb-redesign = 1f034f5a).

BLOCKING: CHANGELOG.md is back on the branch tip. eac27eb0 deleted it, then 11a73fbc (docs: changelog for http KB promote sprint) re-added it with 33 lines. That file is not in the base branch. It carries sprint budget/spend lines and a stale 'Carried forward' list: the smoke-test BEADS_DIR leak and the bible entry_count 0 issue, both fixed later on this branch (4de86a39, 960e1149). This breaks the akn.5 criteria 1 and 2. It would bring back a file upstream deleted on purpose. Reopening akn.5.

Code review (passes):
- http-provider.ts: promote POSTs to /api/kb/promote with {id, reason}. It maps previous_/new_confidence to confidence_before/after. A connection error throws with no fallback, and a malformed response throws. rawRequest now handles 4xx/5xx with a body that is not JSON. discard throws KbHttpUnsupportedError (E-KB-HTTP-UNSUPPORTED).
- kb-promote.ts: an ownerTag goes only to SQLite, so member sessions on http reach the server.
- kb-self.ts getSelfReadKb serverRecall: kb_query, kb_session_prime and kb_context send member reads of every tier to the http provider. kb_list and kb_stats are unchanged.
- kb-bible-commit.ts: on http it returns bible_skipped plus a reason before any KB read or commit. entry_count comes from the parseable bible, and an unreadable bible is logged rather than thrown.
- kb.mjs: commitRound drops the queue with one log line.
- The contract spec, fixtures, taxonomy and client JSDoc were updated in the same change.
- bd-replay execCmd strips BEADS_DIR and BEADS_DB from every bd command (fixes akn.4.4). The smoke-test leak fix and the node-path fix are fine.

Tests (WSL ~/apra-fleet-tests at 443e2dca): npm ci and build OK. vitest on 12 changed/related files: 62/62 passed. node --test bd-init-templating + kb-bible-commit-round with BEADS_DIR exported at a decoy: 44/44 passed. That covers the integ failure akn.4.4 filed at e24c86d3. I did not re-run the full suite.

Secondary: 45a54d9f (pm-kb bible update) gives 86 of the 330 upstream bible entries new ids (titles unchanged), drops 5 entries and adds 9. provenance.branch/commit name the sprint branch (u1_kb_http_promote@83f6376c), not the base branch. Filed as a new task.

KB: promoted 59bd005d. I left 79d3e96a INFERRED: its claim that KB_MAINTAINER_CALL is passed 'only for queue writes' is wrong. kb.mjs:668 also passes it to kb_bible_commit.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: pass).
Carry-over beads filed: none.
Summary: I ran the playbook's Install smoke part. A fresh install into the throwaway HOME succeeded. The server started on scratch port 18700, and both `status` and server.json confirmed it was bound to 18700. Teardown then released the lock, stopped the server and deleted the sandbox, and all of it exited 0. The leftover sandbox-deploy sweep for this sprintId reported 'nothing to tear down', so no isolated test instance was left from this sprint's deploy. The playbook's 'In-sprint smoke' part was NOT RUN: moved to CI. The toy sprint needs an LLM credential an agent cannot provision, and I did not route around that. The real-bd apra-fleet-se suite and its slow lane run nightly in CI and are not run here, so I report Part 1 as not passed (suitePassed false) because it was not run. That is why overall passed is false. No beads were filed. This result is informational: it does not gate the sprint's verdict.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
