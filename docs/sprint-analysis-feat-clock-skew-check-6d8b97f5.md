# Sprint Analysis: feat/clock-skew-check

Scope issue id(s): apra-fleet-lgz0.
Base branch: main.
Cycles run: 1.

## Progress

Closed-bead count history (per cycle evaluation): [3].
High-water-mark closed count this sprint: 3.
Final closed count: 3.
Final open-at-goal-priority count: 0.

## Deploy/Integration outcomes

Deploy failures (1): C1: Stopped at Step 0 (permission check) -- did not run any deploy commands. deploy.md's ## Permissions section requires `Bash(*apra-fleet* run *)` (used in the Deploy section to launch the server via `nohup "$HOME/.apra-fleet/bin/apra-fleet" run --transport http ...`). The merged effective allowlist (.claude/settings.json has no permissions.allow entries in this repo; .claude/settings.local.json carries the grants) only contains `Bash(*apra-fleet* start)`, which does not cover the `run` subcommand -- start and run are different prefixes and one does not cover the other. All other required prefixes (Bash(*apra-fleet-installer-* install *), Bash(*apra-fleet* --version), Bash(node scripts/preflight-clear-build-locks.mjs), Bash(npm ci), Bash(npm run build), Bash(npm run build:binary), Bash(dist/apra-fleet-installer-* install *), Bash(curl * localhost:8787/api/sprints*)) are present in .claude/settings.local.json. Missing permission: Bash(*apra-fleet* run *). Ask the orchestrator/operator to run compose_permissions with this missing grant, then re-trigger the deploy.
No integration test failures recorded this sprint.

## Reviewer-proposed newTask rejections

1 newTask(s) rejected before reaching bd create: C1: title fails safe-character allowlist /^[A-Za-z0-9 .,:;!?()'_/\[\]-]+$/ (or is empty): "Fix deploy permission-grant drift: allowlist grants 'start' but deploy.md now requires 'apra-fleet run *'"

## Final verdict

PASS -- Clock Skew Check feature (beads lgz0.1.1/.1.2/.1.3) is fully and correctly implemented in packages/apra-fleet-se/fleet-sprint/runner.js. All 6 acceptance criteria of lgz0.1 are met and traceable to the diff: (1) phase('Clock Skew Check') at runner.js:5803 sits inside group('Sprint Setup') (opened 5619) immediately after phase('Ensure Sprint Branch') (5620), iterating branchEnsureMembers; (2) skew via hubT0/hubT1 bracket + member command() probe with in-bracket==0 skew (evaluateClockSkew, 4692); (3) threshold clockSkewThresholdMs derived from STALL_THRESHOLD_MS/4, 120000 default, not hardcoded (4666); (4) advisory-only -- both probes failSoft:true, helpers never throw, no abort on over-threshold/failed/unparsable probe; (5) in-bracket members log nothing; (6) no MCP schema change, apra-fleet-client untouched. Failure paths verified: parseEpochMillis returns null (not NaN) on BSD 'date'/illegal-option/PowerShell-alias output, and the POSIX->Windows probe fallback + both-fail 'could not measure' advisory are exercised. Test coverage is strong and non-redundant: clock-skew-helpers.test.mjs (unit) + lgz0-clock-skew-check.test.mjs (5 mocked-sprint scenarios: healthy/skewed-215s/env-derived-threshold/both-probes-fail/two-member) + a real-shell probe reality-check. Hygiene clean: the four clock-skew commits touch only runner.js, the two test files, golden fixtures, dispatch-safety-guard count (correctly 39->41 for the 2 new probe call sites, both member-scoped so the guard invariant holds), and a test-only commandStdoutOverride harness hook; golden mock-sprint-happy-path.jsonl regenerated coherently (probe at seq 7). Other files in main..feat/clock-skew-check (compose-permissions.ts, stall-poller.ts, deploy.md, docs, ci.yml) come from separately-merged PRs #393/#395/#396 in the diff range, not this sprint's work. Build passes; root vitest 3088 pass / 21 env-skipped / 0 fail; apra-fleet-se 1744 pass / 0 fail. No regressions, no open P1/P2 beads in scope. The only blocker this cycle -- the Deploy phase failing at the Step 0 permission check -- is external to the reviewed code: PR #395 switched deploy.md's launch to 'apra-fleet run' and now requires Bash(*apra-fleet* run *), but the effective allowlist (.claude/settings.local.json) still grants only Bash(*apra-fleet* start). That is a permissions/config drift, not a defect in the clock-skew feature, and is captured below. Note: because Deploy never ran, this cycle produced no server-level validation of the built artifact -- but the clock-skew change is in fleet-sprint's JS orchestration path (not the apra-fleet server binary) and is covered end-to-end by the passing unit+integration suite including a real-shell probe execution.

## Regression pass (once per sprint, informational)

Regression pass: FAILED (real-bd suite: fail, smoke test: fail).
Carry-over beads filed: none.
Summary: Regression test runner dispatch failed: [Workflow Error] Agent dispatch failed (stalled): [FAIL] execute_prompt on "fleet-lin-dev1" was aborted after a confirmed stall -- the remote turn made no progress for the stall threshold, its process was killed, and the in-flight dispatch was cancelled immediately rather than waiting out the client timeout.
Informational only -- this pass ran after the final verdict and did not gate it; any bead above is parent-less by design and carries over to a future sprint.
