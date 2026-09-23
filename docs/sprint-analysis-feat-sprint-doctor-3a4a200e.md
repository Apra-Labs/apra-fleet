# Sprint Analysis: feat/sprint-doctor

Scope issue id(s): apra-fleet-iiny.
Base branch: main.
Cycles run: 3.

## Progress

Closed-bead count history (per cycle evaluation): [18, 24, 33].
High-water-mark closed count this sprint: 38.
Final closed count: 33.
Final open-at-goal-priority count: 2.
No beads were deferred out of scope at/above goal priority this sprint.

## Deploy/Integration outcomes

No deploy failures recorded this sprint.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

None.

## Final verdict

FAIL -- Gates all green: build OK, root suite 327 files passed, packages/apra-fleet-se suite 4287 pass / 0 fail, check-generic-boundary.mjs OK. Security reviewed and clean: doctor-telemetry.mjs has zero network primitives (local-first only), resolveTelemetryMode() fails safe to 'ask', no tracker configured means telemetry is disabled rather than defaulted; no bead ids leaked into any LLM-facing prompt/schema/SKILL text; re-plan bodies go through the staging verb, never inline into a command string. No src/tools/* change, so no apra-fleet-client sync was owed. Closed work verified in the diff, not just by bead count: iiny.3 seeds both epic-mandated incidents (deferred-in-scope-never-dispatched, provider-tool-registry-mismatch); iiny.9 is a real budget-accounting fix with its own test; iiny.4/iiny.6/iiny.7 are wired and tested (packaging tests execute dist-pm.mjs and gen-sea-config.mjs for real). Test edits to existing files are justified, not weakened -- the deferred pin in mock-sprint-exit-stale-approval.test.mjs is deliberately inverted per owner doctrine and strengthened with log + summary assertions, and agent-contracts-kb-wiring.test.ts replaces its scoped-out cases with a positive zero-tool assertion.

FAIL is on scope completion, not code quality:

1. The P1 BLOCKED re-plan lane is not finished. apra-fleet-mduk.2 is still in_progress (lease expired 8h) and apra-fleet-mduk.3 was never started; parent apra-fleet-mduk is P1 and open. Goal priority is P1/P2, so this is in-goal work left open.

2. The shipped P1 integration path has zero coverage. runBlockedReplanPhase (phases/sprint-doctor.mjs:179) and its call site (runner.js ~3587-3680) are exercised by no test -- nothing imports phases/sprint-doctor.mjs, and no test asserts replanConsultedThisCycle. doctor-replan-executor.test.mjs covers the executor with fakes and doctor-blocked-capture.test.mjs covers only the capture half; the wiring that actually invokes the executor in production is untested. That is exactly apra-fleet-mduk.3's five cases, which remain unwritten (its named file doctor-blocked-replan.test.mjs does not exist).

3. Wedge regression risk in the new lane: runner.js:4313 builds blockerIds excluding doctorGrantAwaitingIds but NOT doctorBlockedIds. doctorBlockedIds is sprint-scoped and a bead leaves it only when the executor reports content actually changed (runner.js:3663). So a BLOCKED bead whose re-plan is refused, errors, or produces no change is permanently undispatchable yet still counted as a stall blocker -- SPRINT_STALLED on a bead nobody will ever dispatch again, the same wedge class this epic exists to remove.

No closed bead needs reopening; the closed set holds up against the diff.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Stopped at Step 0 permissions check before running anything: regression-test-playbook.md's Permissions section requires Bash(curl:*) and Bash(kill:*), and neither is covered by the merged effective permission set (.claude/settings.json union .claude/settings.local.json). The only curl grants present (Bash(curl * localhost:8787/api/sprints*) and Bash(curl * localhost:8787/api/reservations/*)) are scoped to port 8787 paths, not the smoke test's scratch supervisor port 18701 (/api/health, /api/members, /api/shutdown, /api/sprints/:id) that ## Setup, ## Test scenario, and ## Teardown all curl against; no kill grant of any form exists. Per Step 0, I did not proceed to Part 1 (real-bd suite) or Part 2 (sandbox smoke test) and never brought the sandbox up, so there is nothing to tear down. This result is informational and does not gate the current sprint's verdict. Please run compose_permissions to add Bash(curl:*) and Bash(kill:*) to .claude/settings.local.json (or broader covering entries) and re-dispatch this run.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
