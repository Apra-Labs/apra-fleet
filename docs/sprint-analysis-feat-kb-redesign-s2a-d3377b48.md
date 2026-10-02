# Sprint Analysis: feat/kb-redesign-s2a

Scope issue id(s): apra-fleet-b4g.59, apra-fleet-b4g.58, apra-fleet-b4g.64.
Base branch: feat/kb-redesign.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [9, 16, 22].
High-water-mark closed count this sprint: 25.
Final closed count: 22.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Reviewed the net diff feat/kb-redesign..feat/kb-redesign-s2a (head b7b88d5e, matches origin). npm run build OK; npm test EXIT=0 (vitest 394 files / 5491 tests passed; apra-fleet-se SUMMARY pass=4208 fail=0; other node suites 0 fail); npm run contract:check OK (24 tools). The file list is clean. rg kb_export|exportBible in fleet-sprint non-test = 0.

PASS on criteria:
- b4g.59: member bible view (member-bible-view.ts). One stat per read, rebuilt when mtime or size changes, verbatim import, a remote variant, and a malformed bible is never cached. Owner-tag scoping covers capture, INFERRED reads, promote and invalidate. kb_feedback returns E-MEMBER-VIEW-READ-ONLY. Covered by the HTTP tests.
- b4g.64: kb_bible_commit merges entries one by one and refuses to overwrite an unreadable bible. kb_export has baseBranch/baseCommit. commitRound does G-pull, commit, G-push, with one retry. seal() runs on a FAIL verdict and on abort. Covered by kb-bible-commit-real-git.test.mjs against a real bare origin.

FAIL - defect in b4g.58 (maintainer selection and write routing):
- runner.js:1986 builds branchEnsureMembers only from the dispatched role pools. A kb_maintainer outside every pool is never put on the sprint branch. Two kinds of member qualify: a role-less member when roleMap maps doer and reviewer, and an explicit roleMap.kb_maintainer member who has no other role. Selection rule (b) in kb-maintainer.mjs prefers exactly those members.
- What breaks on such a maintainer:
  - Every write batch G-pulls it (git fetch origin <sprint>; git merge --ff-only origin/<sprint>) into whatever branch it has checked out.
  - kb_bible_commit commits the bible on that branch.
  - The G-push (git push origin <sprint>) fails.
  - The retry then runs git reset --hard origin/<sprint> on that wrong branch.
- Result: the bible never reaches the sprint branch, and the member's checkout is changed in a way that destroys work. The mock and real-git tests always run with the maintainer already on the sprint branch, so they miss this.

Secondary (newTasks):
- The bible-commit retry's reset --hard drops any unpushed commit or uncommitted change on the maintainer.
- kb_invalidate {ids} reads the session member id directly instead of calling memberOwnerTag(anchor).

KB: no promotions (apra-fleet KB MCP was unavailable).

## Regression pass (once per sprint, informational)

Regression pass: skipped by launch option -- not run this sprint.
