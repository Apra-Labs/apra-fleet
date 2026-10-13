# Sprint Analysis: feat/kb-redesign-s5

Scope issue id(s): apra-fleet-b4g.67.1, apra-fleet-b4g.56.8.3, apra-fleet-b4g.56.8.4, apra-fleet-b4g.56.8.5.
Base branch: feat/kb-redesign.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [12].
High-water-mark closed count this sprint: 16.
Final closed count: 12.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Reviewed the net diff feat/kb-redesign..feat/kb-redesign-s5 (18 files). Build OK. npm test: vitest 426 files / 5912 tests passed; apra-fleet-se suites 340 + 3900 + 489 passed, 0 failed. No lint script exists. Working tree clean apart from untracked .claude/skills.

Code: PASS.
- b4g.67.1 / 56.8.3: ensureOnce (src/services/member-fleet-install.ts) retries exactly once with --force-stop-full-install, and only after an E-FULL-INSTALL-RUNNING refusal. The retry is gated on fleetPreviouslyInstalled (fleetInstalledAt) or memberRegistryHoldsId (a direct read of <home>/.apra-fleet/data/registry.json via readMemberJson, safe for both POSIX and PowerShell). A read failure counts as not-owned. probeRemote no longer self-registers into a running full install when the install is refused. tests/member-fleet-install-premarker.test.ts covers: a realistic pre-marker member with no fleetInstalledAt, a human full install never overridden (including after re-probes), Windows/PowerShell, a retry that fails, and no retry on plain install failures.
- 56.8.4: registry.recordFleetMcpStatus carries the stamp forward. On a stale-status clear, compose keeps the stamp by writing an available+unverified status. Covered by tests/compose-engine-robustness.test.ts.
- 56.8.5: the client typedef, api-reference.md and a new parity test against src/types.ts are all present.
- register-member --id now skips compose, with tests.

Docs: FAIL. docs/member-fleet-mcp-wiring.md is correct. CHANGELOG.md still contradicts the delivered behaviour:
(1) Line 7, the stage-5 header, says 'Verdict FAIL overall ... the pre-marker upgrade did not meet its first acceptance criterion ... still need the manual --force-stop-full-install step'. This is stale text from the first-pass harvest commit 10655282.
(2) Line 46 says the retry fires only on fleetInstalledAt and that 'a member with no such record is never overridden and needs the manual command'.
(3) Line 54, the Upgrade line, says 'otherwise run ... by hand' and names only fleetInstalledAt.
All three were added in this sprint and tell users that real pre-marker members still need a manual step, which is the opposite of what shipped. The 56.8.3 task asked for the pre-marker paragraphs to be updated, not appended to. A smaller issue: the src/types.ts fleetInstalledAt JSDoc still calls it the 'sole' ownership signal.

Secondary, non-blocking: the registry-uuid signal assumes a human full install never holds the member uuid. But the base-branch probeRemote (unreleased) self-registered the member into a running full install after a refusal. So a host touched by an earlier feat/kb-redesign build can carry the uuid, and the next upgrade would stop the human's server. Filed as a new task.

KB: the fleet MCP server failed to connect, so no KB calls were made and nothing was promoted.

## Regression pass (once per sprint, informational)

Regression pass: skipped by launch option -- not run this sprint.
