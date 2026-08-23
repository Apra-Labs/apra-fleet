# Sprint Analysis: fix/fable-audit-test-bd-volume-cleanup

Scope issue id(s): apra-fleet-7h6n.
Base branch: main.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [10].
High-water-mark closed count this sprint: 11.
Final closed count: 10.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed net diff main..fix/fable-audit-test-bd-volume-cleanup against epic apra-fleet-7h6n (9 children, all closed). The epic's own commits (33aae6ca..HEAD) are scoped entirely to packages/apra-fleet-se and touch zero src/ files. Verified each child against acceptance criteria: (7h6n.5) dolt-sync.mjs caches the pre-gate probe in syncRemoteConfiguredAtPreGate and reuses it on the failure path, retaining the skip branch as defense-in-depth -- behavior-preserving, at-most-once probe; (7h6n.7) claimBeadsBatched reads success off the parsed JSON array rather than throw-inference, degrades a thrown command() to all-skipped, keeps malformed-JSON fatal via parseBdJson, and the claim layer remains dormant (validated.assignee unset) so no live behavior change -- backed by 7 focused unit tests in claim-beads-batched.test.mjs; (7h6n.1/.8) supervisor-dashboard-backlog-no-live-spawn.test.mjs runs both fixtures under a PATH-shimmed bd/git spy, asserts an empty spawn marker + exit 0 + runtime <5s, AND parses the child's TAP '# tests'/'# pass' summary (KNOWN_MINIMUM_TESTS=40) to kill the vacuous-zero-tests failure mode, POSIX-gated per repo convention; (7h6n.2/.4/.6/.3) duplicate files deleted and merged counterparts present (installed-supervisor.test.mjs 519 lines, parameterized 0j1-watchdog-reservation-release, shared balanced-call-scanner.mjs helper), fyc3 untouched. Build (npm run build) exit 0; full apra-fleet-se suite SUMMARY pass=2384 fail=0, exit 0; the k7b8-dolt-diverged-conflict STDERR is that test's own simulated scenario output (test passes). Working-tree cruft (tmp-integ-verify/, .beads.stuck-bak-*, deleted .beads/issues.jsonl) is uncommitted local integ-runner artifact, not in the branch diff. NON-BLOCKING OBSERVATION: the branch also carries three base commits (#448/#450/#451: fleet-sprint non-exclusive-orchestrator / member-reservation work in src/tools/*.ts, src/types.ts, viewer-extensions.mjs, supervisor/api.mjs) that are on this branch but not main and lie outside this epic's declared scope -- merging this branch to main would co-merge that unrelated PR work. Filed as a follow-up so it is verified/rebased deliberately rather than riding along silently. Epic acceptance is fully met independent of that.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Stopped at Step 0 (permission check) before running anything: regression-test-playbook.md's ## Permissions section requires Bash(mkdir *), Bash(rm -rf ~/temp/.apra-fleet-tests*), Bash(node dist/index.js *), and Bash(node scripts/run-integ-suites.mjs *), and none of these four prefixes is covered by the merged union of permissions.allow from .claude/settings.json and .claude/settings.local.json (verified mechanically, not by eye). Bash(node dist/index.js *) is needed throughout Setup/Test scenario/Teardown (install, start, status, register-member, secret, auth, workflow fleet-sprint, stop); Bash(node scripts/run-integ-suites.mjs *) is needed for Part 1's real-bd suite per packages/apra-fleet-se/test/INTEG-SUITE.md; Bash(mkdir *) and the Teardown rm -rf are needed for the smoke-test sandbox lifecycle. Neither Part 1 (real-bd suite) nor Part 2 (smoke test) was run, and the sandbox was never brought up so no Teardown was needed. This is informational and not a sprint gate; the orchestrator/operator should run compose_permissions to grant the four missing prefixes above (into .claude/settings.local.json) before this role can be re-dispatched.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
