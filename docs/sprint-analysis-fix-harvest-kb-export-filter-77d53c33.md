# Sprint Analysis: fix/harvest-kb-export-filter

Scope issue id(s): apra-fleet-6ejt.
Base branch: main.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [2, 4].
High-water-mark closed count this sprint: 5.
Final closed count: 4.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed net diff origin/main...fix/harvest-kb-export-filter (3 commits, 15 files; local main was stale so main..branch over-reported 51 commits). Fix lives in the kb_export tool, reached by the sprint via final-review.mjs -> kb.mjs exportBible -> kb_export. New src/services/knowledge/bible-basis-filter.ts qualifiesForProjectBible: CONFIRMED + non-empty source_files + non-empty basis covering every cited file + every basis hash equal to the file's current hash (missing file = mismatch). Project export (src/tools/kb-export.ts exportProjectBible) merges additively: existing bible entries are kept raw, existing wins on an id clash, and when nothing new qualifies it writes nothing and commits nothing. Global scope unchanged, global shrink-guard tests kept (kb-bible-truncation-commit.test.ts). AC coverage: tests/knowledge/kb-export-branch-basis-filter.test.ts covers confirmed+match, stale hash, missing file, inferred, empty basis, partial basis, curated entry kept with its human-edited field, and byte-identical/no-commit; global is unaffected. Bible format and request/response schemas unchanged; only description text moved, in the registry, generate-contract, bindings/mcp/kb_export.json and INVENTORY together. apra-fleet-client does not wrap kb_export. Diff is ASCII-clean; file hygiene OK.
Verification: npm run build OK; npm test exit 0 (vitest 387 files/5540 passed; apra-fleet-se 489/489); check-generic-boundary OK.
Deviations (not blocking): (1) Basis is the per-file source_file_hashes, not KBEntry.content_hash/content_hash_type. That matches the AC wording (recorded per-file basis); content_hash is only set for context-cache entries, so using it would exclude almost everything. (2) Hashes come from files on disk under repo_path, not HEAD blobs, so leftover untracked or ignored files could let an entry qualify. (3) The filter applies to every project kb_export caller, including the reconcile flow. That flow can no longer remove a superseded loser or a pending directive from the bible (documented in kb-reconciler.md and kb-reconcile-architecture.md; the e2e test was updated for it). Follow-ups filed as newTasks.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (Install smoke: pass, In-sprint smoke: fail).
Carry-over beads filed: none.
Summary: Ran the Install smoke part of regression-test-playbook.md at branch HEAD. It passed: the sandbox lock was acquired, a fresh install into the throwaway HOME succeeded, and port 18700 was freed. The server then started on 18700 (version v0.4.4_949cab) and server.json confirmed that port. Teardown released the lock, stopped the server and deleted the sandbox. The leftover sandbox-deploy sweep for this sprint's id reported 'nothing to tear down'. In-sprint smoke was NOT RUN: moved to CI. The playbook requires this to be reported as passed: false with overall passed: false, and no bead is filed for it. The playbook does not run the real-bd apra-fleet-se suite either; that runs nightly in CI. No failures were found, so no carry-over beads were filed. This result is informational and does not gate the sprint's verdict.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
