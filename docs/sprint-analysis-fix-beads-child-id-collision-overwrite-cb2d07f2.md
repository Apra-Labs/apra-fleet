# Sprint Analysis: fix/beads-child-id-collision-overwrite

Scope issue id(s): apra-fleet-btj9.
Base branch: main.
Cycles run: 5.

## Progress

Closed-bead count history (per cycle evaluation): [3, 7, 7, 9, 11].
High-water-mark closed count this sprint: 12.
Final closed count: 11.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Scope apra-fleet-btj9 (10 children) on fix/beads-child-id-collision-overwrite. Reviewed the net diff, not the bead counts. Note: main..branch also carries upstream commit 6d934001 (#480), which is already on origin/main and is not sprint work; sprint diff is 6d934001..HEAD (30 files).

VERIFIED IN-TREE (not taken on the doer's word):
- Epic AC1/AC2: assertChildIdFree() is called from createChildBeadWithAllocatedId before every explicit-id create (beads-children.mjs:288-294). child-create-collision-guard.test.mjs drives the real seam (re-exported from runner.js) against a fake bd that emulates the silent overwrite, asserting the stored bead is byte-identical after a refusal for CLOSED and OPEN ids, plus a no-false-positive create.
- Epic AC3: computeChildFloor now issues bd list --parent <id> --json --all; sibling bkax.1 is closed; 19o3 integration test asserts a NON-ZERO replayed floor plus absence of the floor-0 fallback log. A full npm test emits NO recording-drift line for the parent-list read (the 8 drift lines present are pre-existing bd dolt status / doermaxturns bd show noise in unrelated scenarios; filed as follow-up).
- btj9.6/2/5: dedicated tests pin fail-closed UNKNOWN, confirm-not-release after a landed create, and the confirm-failure orphan error, with distinct wording and confirm/release call counts.
- btj9.9 falsification independently re-run by me in a scratch worktree at 1f3fbc44: the three phantom-string fixtures and the raw-newline fixture return 0 violations there and exactly 1 each at HEAD, while wrapper-dispatch.mjs returns 1 at both -- so the phantom pins are load-bearing, not wrapper coverage in disguise.
- btj9.10 independently reproduced at the pre-fix revision: unbracketed-push-guard missed a bare doltPushAfter() after a quote-bearing regex, and falsely flagged a sanctioned wrapper whose parameter default held one. Both fixed and pinned. All four maskComments consumers are covered.
- Guard liveness: injecting a real bd create dispatch into abort.mjs (a GUARDED_MODULES member) makes checkExplicitIdCreateModules() report 1 violation, so the CI guard is live rather than fixture-only.
- bd 1.1.0 re-checked locally: bd show <missing> --json exits 1 and prints the no-issues-found JSON on stdout, which is what classifyBdShowProbeError keys on.
- Hygiene: ASCII-only clean across all changed files, no stray/temp files, working tree clean, generic-boundary guard 11/11 pass, no MCP schema change so no apra-fleet-client update was owed.

GATES: packages/apra-fleet-se npm test pass=3657 fail=0 (exit 0); root npm run build exit 0.

SECONDARY FINDINGS (filed as newTasks, none block this epic's criteria): probe classification is brittle at both ends (legacy-server text makes a FREE id fail closed; an exit-0 unrecognized payload is read as free); the best-effort newTask fallback mislabels and duplicates a finding when the create actually landed; plan.mjs still reads children without --all; the new guard is not in the cross-guard coverage matrix; stale recordings elsewhere.

KB: promoted 2 entries I reproduced myself. Also: the CONFIRMED entry claiming scaledTimeout() is inert under npm test is WRONG on this tree -- package.json test is node scripts/run-tests.mjs mock and that script exports APRA_FLEET_TEST_CONCURRENCY (run-tests.mjs:49), so scaledTimeout does scale.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Regression test runner dispatch failed: [Workflow Error] Agent dispatch failed (stalled): [FAIL] execute_prompt on "worker" was aborted after a confirmed stall -- the remote turn made no progress for the stall threshold, its process was killed, and the in-flight dispatch was cancelled immediately rather than waiting out the client timeout.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
