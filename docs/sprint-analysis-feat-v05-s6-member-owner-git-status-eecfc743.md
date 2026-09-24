# Sprint Analysis: feat/v05-s6-member-owner-git-status

Scope issue id(s): apra-fleet-4qtu.
Base branch: v0.5_dashboard.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [3, 10].
High-water-mark closed count this sprint: 13.
Final closed count: 10.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Verified the net diff v0.5_dashboard..feat/v05-s6-member-owner-git-status (24 files, +2872/-7) against all three child features, not bead counts.

What landed, with lines: registry fields owner/env/llmAuthExpiresAt (src/types.ts:66-83) wired through register-member.ts (schema +owner/env/llm_auth_expires_at, env validated via src/utils/env-map-validation.ts), update-member.ts (same, plus a member-held refusal at :120 so update_member cannot bypass member_owner), list-members.ts:119-127/:168 and member-detail.ts:62-71/:293. member_owner (src/tools/member-owner.ts) with a single exported memberHeldRefusal() and member-held refusal on BOTH set and clear. member_git_status (src/tools/member-git-status.ts + src/services/git-status-probe.ts) with the 6-probe ordered sequence, porcelain-v2/worktree parsers and origin-slug normaliser. Both tools registered (tool-registry.ts:130-131) and mirrored in packages/apra-fleet-client (wrappers, typedefs, api-reference rows, method count 32 -> 34).

Failure paths traced, not pattern-matched: strategy.execCommand resolves with {code,stdout} rather than throwing on non-zero exit, so git rev-parse's exit 128 on a non-git folder legitimately reaches isInsideWorkTree() and yields outcome no_checkout / checkout:null with ok:true and no error -- confirmed live on Windows by tests/integration/member-git-status-integration.test.ts, not only by a mock. Command strings resolve every path in JS (git -C <literal>, no cd prelude, no $VAR/~/backticks); PowerShell probes go through wrapPowerShellEncoded and are asserted decoded. Parsers strip \r, so CRLF output from a Windows member parses correctly.

Verification run: npm run build OK; npm test green (vitest 347 passed / 8 skipped; apra-fleet-se pass=4213 fail=0; node --test 468 pass) with TEST_EXIT=0. IMPORTANT: root npm test does NOT run packages/apra-fleet-client -- scripts/run-all-tests.mjs only runs vitest, apra-fleet-se and apra-pm. The "npm test green" criterion on 4qtu.1.1/2.1/3.2 therefore does not by itself cover the client parity and method-count assertions those same criteria require, so I ran that suite separately: 71 pass / 0 fail, including MemberGitStatusResult parity, the api-reference method-doc parity, and the memberOwner/memberGitStatus wrapper cases.

File hygiene clean -- every changed file maps to a named bead; no temp files or stray tool config.

One secondary defect (does not block this epic's criteria, filed as a task): register_member and update_member accept owner with only z.string().min(1), skipping the OWNER_PACKAGE_PATTERN/OWNER_REF_PATTERN checks member_owner enforces. The member-held refusal was deliberately duplicated into update_member so it "cannot be used to bypass" member_owner; the format check was not, so the same bypass shape remains half-open -- and a value with a newline or | corrupts the owner=pkg@ref compact chip that the criterion-(3) test pins.

KB: promoted 61c07eec (root npm test skips the client package) -- verified empirically this pass. Near-duplicate 9e6585c4 left INFERRED deliberately.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: apra-fleet-2a71.
Summary: Ran both parts of regression-test-playbook.md at branch HEAD a9e7bb7f6ac048a22a194c207c6c98fafb423448. Permissions check passed (all required prefixes covered by the merged settings). Part 1a (real-bd suite via scripts/run-integ-suites.mjs) found a stale 7-hour-old status file (269/279 files already recorded by an unrelated prior session, 10 pending) -- recovered per INTEG-SUITE.md by resuming with --start (recurrence noted on apra-fleet-jl71); the resumed 10 files completed in 25s and the full run reached 'pass COMPLETE' with 9 failing files, all of them recurrences of already-open [regression][carry-over]/[integ] bugs (apra-fleet-zekq, -x0mr, -hhjh, -y0zz, -vwa2, -0aer, -ae2i, -eft.17) that were updated with today's evidence rather than duplicated -- note most of the 269 inherited results predate this session's own HEAD, though the failure set is identical across runs per those bugs' recurrence trails. Part 1b (npm run test:slow) ran fresh this session: 1 pass / 1 fail, the failure being a further recurrence of already-open apra-fleet-5jlr (bd-replay recording drift), noted with today's evidence. Part 2 (smoke test): Setup's install/server-start/toy-repo-clone/beads-seed/isolation-verify steps all passed, but the supervisor boot step's verbatim jwt-mint command failed on Windows Git Bash due to MSYS path-rewriting (ERR_MODULE_NOT_FOUND), which I worked around locally (cygpath -m + file:// URL, NOT committed to the playbook) to get the supervisor up for the purposes of exercising the rest of Setup and Teardown; filed this as new standalone bug apra-fleet-2a71 since no existing bead covered it. Test scenario step 3a (credential provisioning) was then denied outright by the Claude Code auto-mode classifier ('[Secret-Store Writes]') -- a recurrence of already-open apra-fleet-j48h, noted with today's evidence -- so steps 1/2/3b/4/5 never ran and smokeEvidence cannot be populated. Teardown's own supervisor-stop identity check false-reported 'still alive' due to a timing race (recurrence of already-open apra-fleet-5mu3, noted); I manually verified the supervisor was actually already dead (no process, port closed) and completed Teardown's remaining steps, confirming the sandbox and lock file are fully removed and the repo tree is clean. The leftover sandbox-deploy sweep for this sprint's own reservation id found nothing to tear down (normal). Also flag for the next runner: my step-3a Bash call did not re-export REAL_HOME (irrelevant here since the classifier blocked the call before execution, but a future runner re-running that block standalone should re-export it to avoid mis-filing the resulting 'no ambient credential' error as apra-fleet-xuo.13 instead of this classifier block). This entire result is informational: it does not gate the current sprint's verdict, and every filed/updated bug carries over to a future sprint as parent-less, standalone work.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
