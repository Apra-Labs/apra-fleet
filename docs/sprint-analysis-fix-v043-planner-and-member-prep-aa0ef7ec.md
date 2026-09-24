# Sprint Analysis: fix/v043-planner-and-member-prep

Scope issue id(s): apra-fleet-i4ku.24.
Base branch: main.
Cycles run: 2.

## Progress

Closed-bead count history (per cycle evaluation): [2, 11].
High-water-mark closed count this sprint: 13.
Final closed count: 11.
Final open-at-goal-priority count: 0.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Engineering scope (apra-fleet-i4ku.24 + 10 children) is CORRECT and well tested. Verified against the net diff, not bead counts.

WHAT IS RIGHT. member-stray-sweep.mjs now carries a 4th TRANSPORT-STATUS field on SWEEP-HEALTH, so curl's '000' splits into refused (exit 7 -> still killable, unchanged) vs tcp-alive-no-http (accepted/timeout/empty-reply -> SPARED). parseLivenessProbeOutput() combines siblings by rank (answered > tcp-alive > refused), never last-wins. Classification is per candidate and sits AFTER the existing partial-coverage guards, so coverage gaps still resolve to unevaluable. New liveness.tcpAliveNoHttp bucket is counted INSTEAD OF unevaluable (no double count) and decideStrayProcess() emits a distinct blocker. win32 asks the TCP question with an EXPLICIT AddressFamily (tcpAddressFamilyFor) - a real fix, the parameterless TcpClient ctor is IPv4-only on PS 5.1 and an IPv6 candidate would have been reported REFUSED, i.e. killed while alive. member-prep.mjs adds the summary clause (both branches) and a dedicated 'LIVENESS TCP-ALIVE-NO-HTTP' per-member line. Tests are strong and non-redundant: safety-matrix CASE1-4 (POSIX spare, refused-still-killed regression guard, mixed sockets, win32 parity), a REAL-curl test against a real silent socket vs a closed port, rank-order tests in both input orders, malformed-3-field-line -> key absent -> spare. Build clean; root vitest 4844 pass/0 fail, apra-fleet-se 3642 (3638 pass/0 fail/4 skip), apra-pm 468 pass/0 fail; git status clean; ASCII clean on all changed lines; bead ids only in code comments; no stray/temp files.

WHY FAIL. The branch ships release notes that are false about its own code. CHANGELOG.md lines 38-45 (top [Unreleased] entry) still list as open backlog: 'the liveness probe assumes every candidate speaks HTTP ... so a live non-HTTP listener on a target-declared killable port is still killed and counted as "checked"'. That is exactly what this round fixed - the shipped code now spares it. No CHANGELOG entry was written for this round at all (git log 55a256cb..HEAD -- CHANGELOG.md is empty) despite 11 closed beads and a user-visible safety-behaviour change. This is the SECOND occurrence of the identical defect on this branch: the previous round returned FAIL for precisely this and recorded 'a release note asserting already-fixed defects as still-open backlog is a defect in its own right'. The guard added then (harvester.md Step 4, commit b66ff055) is a prompt instruction only - harvester-release-notes-freshness.test.mjs asserts the PROMPT TEXT, nothing mechanical - and it did not hold. Misleading operators in the unsafe direction about a kill/spare predicate is not cosmetic.

No closed bead's acceptance criteria cover CHANGELOG.md (i4ku.24.2 AC3 scopes docs to the module header, docs/member-prep-and-stray-sweep.md and cli-reference.md, all three done correctly), so nothing is reopened; the fix is carried as newTasks.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Stopped at the mandatory Step 0 permissions check before running any part of the regression pass: the merged effective permission set (union of .claude/settings.json and .claude/settings.local.json permissions.allow) does not cover two command prefixes regression-test-playbook.md's Permissions section requires -- Bash(curl:*) (needed to drive the sandbox supervisor's HTTP API on ports 18700/18701 across Setup, Test scenario, and Teardown; the only existing curl grants are scoped to an unrelated host:port/path) and Bash(kill:*) (needed for the supervisor readiness/stop kill -0/-9 calls). Per the role contract this is a hard stop: no sandbox was ever brought up (so no Teardown is owed), no suite or smoke test was run, and no permissions were added by this agent since that requires either a team PR to .claude/settings.json or the compose_permissions MCP tool (unavailable this session -- the apra-fleet MCP server failed to connect). This result is informational and does not gate the sprint; the orchestrator/operator needs to run compose_permissions to grant Bash(curl:*) and Bash(kill:*) (or equivalent covering prefixes) before a regression pass can execute.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
</content>
