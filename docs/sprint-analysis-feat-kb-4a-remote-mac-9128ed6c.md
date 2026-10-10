# Sprint Analysis: feat/kb-4a-remote-mac

Scope issue id(s): apra-fleet-srzk, apra-fleet-vutd.
Base branch: feat/kb-redesign.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [7].
High-water-mark closed count this sprint: 9.
Final closed count: 7.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed the net diff origin/feat/kb-redesign..feat/kb-4a-remote-mac: 5 commits, 22 files. The local feat/kb-redesign ref was behind origin, so diffing against it showed 88 unrelated commits; I used the origin ref instead.

apra-fleet-srzk (trust anchor for no-grant kb_import): all criteria met.
- The hub-side table trusted_bible_blobs is added in sqlite-provider.ts (recordTrustedBibleBlob / isTrustedBibleBlob).
- kb-import.ts reads the HEAD blob id and its bytes as one object (bible-blob-id.ts readCommittedBibleBlob). It refuses an unrecorded blob with E-KB-MAINTAINER-REQUIRED before importBibleEntries runs, so nothing is written. It refuses rather than clamping confidence, so no row is left behind that could block the real entry's id later.
- Only FULL or kb_maintainer sessions record a blob: kb_bible_commit after it writes the bible, and kb_import after a grant import. Sessions without the grant only read the record.
- The engine's priming import (fleet-sprint/kb.mjs) now runs with KB_MAINTAINER_CALL on the maintainer, which seeds the record on a fresh hub.
- Tests in tests/member-session-scope.test.ts cover the attack (commit, import, reset: nothing lands and nothing is recorded), the maintainer flow, a fresh-clone import, seeding, and a FULL-session explicit-path import.
- docs/kb-trust-model.md, knowledge-layer.md and spec.md are corrected, and the client JSDoc and api-reference are updated in the same change. memory-contract got a new refusal fixture plus a SCENARIO step and step-count bump.

apra-fleet-vutd (reconcilePrefilter): all criteria met. sqlite-provider.ts now sends a pair to left_for_agent whenever the side that would lose is CONFIRMED. kb-reconcile.test.ts tests both orientations, plus regressions showing INFERRED/UNVERIFIED pairs are still resolved mechanically and directive pairs are still skipped.

Tests:
- Build OK. Full npm test: every suite passed except one test in vitest shard 3, tests/windows-hide-spawn-guard.test.ts ('installed MCP SDK stdio transport hides its child on win32'). The cause is the local machine, not this diff: node_modules has @modelcontextprotocol/sdk 1.27.1 while package-lock pins 1.32.1, and this diff touches neither package files nor that test.
- Re-ran the in-scope tests: kb-reconcile, member-session-scope and memory-contract-roundtrip pass 64/64; apra-fleet-se kb-maintainer-grant passes 4/4. Working tree clean.

Residual risk (documented in the code and spec): whatever bible sits in the kb_maintainer's work tree at a grant import becomes trusted for every member. Filed as a P3 follow-up.

KB: I verified half of the INFERRED candidate 9419e346 (the windows-hide guard fails because of a stale local SDK). I could not check the contracts-schema half because that suite passed here, so the entry stays INFERRED.

toolUse: kb used (kb_query); code used (code_impact on reconcilePrefilter: LOW, 1 caller, kbReconcilePrefilter). The code index was one commit behind HEAD, so I read the remaining changed files directly from the diff.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: I ran the Install smoke part. Before it, the leftover sandbox-deploy sweep for sprint apra-fleet-srzk-2-5fb9d2-a1d86d98 found nothing to tear down. Setup then acquired the sandbox lock, installed from the checkout at 88cefad into a throwaway HOME, started the server and confirmed it was bound to 18700. Teardown ran afterwards: it released the lock, stopped the server and removed the sandbox. The In-sprint smoke part is NOT RUN: moved to CI. The playbook requires it to be reported as passed: false, so the overall result is passed: false for that reason alone. No beads were filed, because no failures occurred and the playbook says to file none for In-sprint smoke. This result is informational and does not gate the sprint's verdict.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.

## KB bible

WARNING: bible not published -- these KB confirmations are not in a pushed bible commit on the sprint branch as of this analysis (the harvest round retries once more after it is written):
- github.com/apra-labs/apra-fleet: 1 unpublished confirmation(s).

## KB and code tool calls per member per dispatch

Counted by each member's own fleet server (session_stats before/after each dispatch; the engine's own reads are excluded). 'unknown' means the count could not be read -- it is not zero.

- Dispatch 1: planner on member 'fleet-mac1' -- kb_* calls: 2, code_* calls: 0.
- Dispatch 2: plan-reviewer on member 'fleet-mac1' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 3: doer on member 'fleet-mac1' [Streak [apra-fleet-srzk.1, apra-fleet-srzk.2, apra-fleet-srzk.3]] -- kb_* calls: 2, code_* calls: 3.
- Dispatch 4: doer on member 'fleet-mac1' [Streak [apra-fleet-vutd.1, apra-fleet-vutd.2]] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 5: reviewer on member 'fleet-mac1' -- kb_* calls: 2, code_* calls: 2.
- Dispatch 6: deployer on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 7: integ-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.
- Dispatch 8: reviewer on member 'fleet-mac1' [Final Review] -- kb_* calls: 1, code_* calls: 1.
- Dispatch 9: regression-test-runner on member 'fleet-mac1-deploy' -- kb_* calls: 0, code_* calls: 0.

Per-member totals:
- member 'fleet-mac1': 6 dispatch(es), kb_* calls: 8, code_* calls: 7.
- member 'fleet-mac1-deploy': 3 dispatch(es), kb_* calls: 0, code_* calls: 0.

## Cost

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $11.2488.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.1978 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 9 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```
