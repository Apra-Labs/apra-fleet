# Sprint Analysis: feat/supervisor-backlog-member

Scope issue id(s): apra-fleet-8zr3.1.
Base branch: main.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [9].
High-water-mark closed count this sprint: 12.
Final closed count: 9.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
Integration test failures (1): C1: I ran `npm test` for apra-fleet-8zr3.1 against commit cc321328, which matches the sandbox deploy (MCP_VERSION v0.4.4_cc3213). All the feature's test files passed with no failures: supervisor-backlog-member, supervisor-backlog-pin, supervisor-api, supervisor-backlog, backlog-member-select and backlog-role-alias. I closed the three verify-set beads (8zr3.1.1, 8zr3.1.2, 8zr3.1.3) with that evidence cited. Feature 8zr3.1 itself is left open: `bd close` refused it because the new bug 8zr3.1.4 is an open child, and the dispatch required filing bugs under 8zr3.1. I appended a note saying its own tests pass and it can close once 8zr3.1.4 is resolved or moved. The only failures in the run were outside this work. The two Windows symlink (EPERM) failures in the phase0/phase1 facade falsification tests are already tracked as apra-fleet-9lwv. The KB test timeout had no bead, so I filed 8zr3.1.4 (P3). The sandbox was torn down cleanly. (bugs filed: apra-fleet-8zr3.1.4)

## Reviewer-proposed newTask rejections

None.

## Final verdict

PASS -- Reviewed net diff origin/main...feat/supervisor-backlog-member (7 commits, 16 files). Local main is stale, so I diffed against origin/main; main..branch also pulls in already-merged main commits.

8zr3.1.1 (supervisor owns its backlog member): src/supervisor/backlog-member.mjs ensureOnce. It matches a local member by work folder (case-insensitive on win32, MSYS paths and a trailing .beads accepted) regardless of tags. It adopts that member keeping its name, adding the backlog tag (existing tags kept, since update_member replaces the list) and setting unreservable when missing. Otherwise it registers backlog-<camelCase> with llm_provider none, unreservable and tag backlog. An LLM member at X makes the supervisor refuse to start with exit 1, naming the member and the separate-clone fix. Fleet unreachable puts it in degraded mode with an unref'd background retry. bin/serve.mjs runs the check before the port is bound. Checked against the register_member/update_member/list_members schemas: field names and the unreservable-requires-llm-none rule match.

8zr3.1.2 (hard pin): src/supervisor/api.mjs. A degraded supervisor answers 503 before reading members. If the member list can't be read, the launch gets 503 'cannot verify backlog member'. listFleetMembers now marks an unreadable list with a hidden (non-enumerable) flag, so existing callers keep their { members: [] } contract. The pin is checked after the orchestrator alias is resolved: a missing backlog role is injected into the child roleMap, the same member is accepted, and a different member gets 400 on field roleMap. OpenAPI and the docs are updated.

8zr3.1.3 (direct launch): fleet-sprint/backlog-role.mjs selectBacklogMember is the one selector, used by both runner.js and bin/cli.mjs. Order: explicit backlog, then first member not mapped to any role, then first doer, then first member. It logs 'backlog: X (auto-selected: reason)'. The order and the log line are tested (backlog-member-select, runner-arg-contract).

Tests: supervisor-backlog-member and supervisor-backlog-pin cover every acceptance bullet: adopt, idempotent restart, sanitization including non-ASCII and empty names, wrong kind through the serve path, degraded launch 503 then retry to ready, and inject/accept/400/503. Build passed. apra-fleet-se npm test: 4240 pass, 6 fail. None of the failures come from this diff:
- phase0 and phase1 facade falsification tests: the Windows symlink EPERM problem already tracked as apra-fleet-9lwv.
- sprint-state.test.mjs 'failed to slice resolveSettleShell': the test searches for an LF-only pattern, but this local checkout has CRLF in runner.js even though .gitattributes says eol=lf (the index is LF). This is an artifact of this machine's checkout; filed as P3.
The kb-anchor-never-cwd timeout from apra-fleet-8zr3.1.4 did not reproduce here; that bead stays open at P3, below goal priority. The diff is ASCII-only, has no stray files, and does not touch fleet tools, so the client package needs no update.

Minor: the overlap set (memberUnion) is computed from the roleMap before the backlog member is injected, so the injected member never goes through the overlap/reservation check. That is safe only while it stays unreservable. Filed as P3. Also, a CLI launch prints the auto-select line twice (once from cli.mjs, once from runner.js); harmless.

No KB promotions: the heredoc-backslash entry is plausible (cc321328 fixed the escapes) but I did not independently reproduce the heredoc behaviour.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Informational only: this result does not gate the sprint, and every failure below carries over to a future sprint. Part 1 (real-bd suite) was run fresh at HEAD cc321328 and covered all 285 files. The status file left over from an earlier run was archived to ~/temp/integ-suite-status.stale-0527.json first. Two of my own mistakes affected the run: a background-task kill and a 'timeout 60' wrapper I used when resuming each interrupted it, and 8 files failed with SIGTERM or 61s timeouts as a result. Re-running them in isolation with real bd showed them passing: mock-sprint-exit-stale-approval, finalization-review-retry, integ-infra-dispatch-failure, lane-metadata-grouping, parent-gate-completion, plan-cap-deferral, plan-review-acceptable-alternative and the attempt2-dead-session file. The remaining failures are genuine: golden-transcript (snapshot diverged and non-deterministic); mock-sprint-beads-health-gate-empty-remote (180s timeout); mock-sprint-beads-identity (3 subtests, template prefix instead of the expected one); mock-sprint-parent-child-blocks-cycle-repair (bd dep add rejects blocking a descendant); mock-sprint-regression-failure-never-gates (300s timeout); phase0-seams-facade and phase1-leaf-facade-completeness (EPERM on the Windows symlink step, plus nested golden-transcript failures); phase3-dispatch-engine-completeness; serve-wiring-integration (dashboard render timeout); and vcs-auth-extraction-facade (nested golden-transcript, SIGTERM at 60s). The slow lane (npm run test:slow) exited 1: the watchdog timer-ref test passed, but mock-sprint-planner-dispatch-stalled-session failed at setup with bd init recording drift. Part 2 (smoke test) was NOT run: the auto-mode classifier denied my assembled Setup and Test-scenario script, which includes step 3a (credential provisioning); open bead apra-fleet-j48h already records that block. I did not re-submit it in smaller pieces or work around it, so no sandbox was ever brought up and no Teardown was needed. The leftover sandbox-deploy sweep for this sprint's id reported nothing to tear down, and I removed the Part 1 slow-lane log from ~/temp/.apra-fleet-tests, keeping a copy at ~/temp/test-slow-lane.kept.log. Every genuine failure already matches an open [regression][carry-over] bead, so I filed no new beads and appended recurrence notes to the existing ones: zekq, o4vi, zl0u, vwa2, 0aer, x0mr, 9lwv, 44il, ryk and j48h. The operator needs to resolve the step 3a permission block (via compose_permissions or an equivalent grant) before Part 2 can run. For several of the failures, such as phase0 and phase1, I only matched them to existing beads from the failure messages and did not investigate the root cause.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
