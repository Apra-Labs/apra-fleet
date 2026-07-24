# Changelog

## fix/token-maths -- multi-root scope remediation

Fixes the auto-sprint plan/exit gates that falsely deadlocked a sprint whose goals are
passed as separate roots with cross-root `blocks` edges (e2e s10 regression). See
`docs/multiroot-scope-remediation.md`.

- **plan-reviewer Criterion 9 + planner Step 4 + planner dispatch prompt**: the ready-work
  check is now scoped to the UNION of ready leaf work across all roots, not per root. A
  root legitimately gated by a sibling root is no longer treated as a cycle; only an
  empty union (or a `--parent` self-edge) is a real deadlock. Criterion 9 and the prompts
  now use `bd list --parent <root> --ready --type=task --json` (matches the workflow).
- **plan-reviewer dispatch**: prior-round verdicts are now passed to the reviewer so its
  No-goalpost-moving rule has the binding input it requires; the misleading bare
  `bd ready` instruction was replaced with the scoped per-root union check.
- **plan-reviewer Step 1**: `bd list --status=open` scoped to `--parent <scope>`.
- **exit-check / no-progress (`parseBlockers` leaf mode)**: the sprint done-condition is now
  open leaf work in the subtree (open `type=task`, plus `type=feature` only when integ
  tests run), excluding roots -- roots close only at Harvest, so the old roots-only count
  made `goalMet` unreachable and forced a false "no progress" abort on cycle 2. The 4-arg
  `parseBlockers` form is unchanged. `test/exit-check-roots-scope.test.mjs` was replaced by
  `test/exit-check-leaf-scope.test.mjs`.
- **planDone bypass**: a resumed/pre-planned cycle now still runs one plan-reviewer pass
  (only the planner dispatch is skipped on round 0), so `taskAssignments`/`sprintQuote`
  populate and the quality gate is enforced.

## feat/pm-tag-dispatch -- 2026-07-01 (cycles 3, goal met)

**Sprint goal:** Document tag-based member selection in SKILL.md (apra-pm-g6q Phase 5). Goal met -- all sprint issues closed.

**What was implemented:**

- `skills/pm/SKILL.md`: new "Member selection (fleet mode)" section documenting basic tag queries (`list_members(tags: ['doer'])` / `list_members(tags: ['reviewer'])`), multi-tag capability queries (e.g. `list_members(tags: ['reviewer', 'bitbucket'])`), fall-back behaviour when no member matches a narrow query, and the compose-before-dispatch rule. R9 updated to remove legacy role-param guidance and point exclusively to tag queries.
- `docs/pm-tag-dispatch.md`: updated to reflect all three sprint issues closed (apra-pm-136, apra-pm-jnq, apra-pm-g6q) and added the multi-tag capability dispatch pattern as a durable design section.
- All sprint issues closed: apra-pm-136 (Phase 4a), apra-pm-jnq (Phase 4b), apra-pm-g6q (Phase 5). Test suite: 305 pass, 0 fail.

**Carried forward:** apra-pm-hqg (P2, CI pipeline, orthogonal to tag-dispatch feature scope).

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 1

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |      4,452 |   n/a |   $0.000 |   $0.067 |
| reviewer   |          0 |      6,202 |   n/a |   $0.000 |   $0.093 |
| overhead   |     28,450 |     29,859 |   +5% |   $0.587 |   $0.349 |
| TOTAL      |     28,450 |     40,513 |  +42% |   $0.587 |   $0.509 |
True-cost estimate (output x 4x): $2.349

Outliers (>200% variance): none
Calibration failures (>500%): none

---

## feat/pm-tag-dispatch -- 2026-07-01 (cycles 2)

**Sprint goal:** Tag-based fleet member selection in pm skill docs (apra-pm-136 Phase 4a, apra-pm-jnq Phase 4b). All in-repo implementation and test subtasks closed; work releasable. apra-pm-g6q (Phase 5 documentation) completed in the following cycle.

**What was implemented:**

- `skills/pm/SKILL.md` R9: member selection now specifies `tags: ['doer']` / `tags: ['reviewer']` as the canonical interface. Backward-compatibility note retained for the legacy `role` param during the fleet transition period.
- `skills/pm/fleet-addendum.md`: Permissions section and Doer-reviewer pairing section updated to tag-based selection throughout.
- `skills/pm/doer-reviewer-loop.md`: Continuity, resume rules, and safeguards updated; the resume table now includes an explicit "Tag switch" row (`resume=false` required across any tag change).
- `test/skill-pm-tags-dispatch.test.mjs`: 16 new assertions covering tags-present, role-absent in dispatch/permission contexts, `compose_permissions`-before-dispatch, preserved git identities and section headings, and the tag-switch resume rule.
- Test suite: 305 pass, 0 fail. No build or lint scripts configured (N/A).
- `docs/pm-tag-dispatch.md`: new durable design doc capturing invariants, scope of migration, and what future contributors must preserve.

**Carried forward:** apra-pm-136 and apra-pm-jnq (parent issues, blocked on cross-repo apra-fleet Phase 2); apra-pm-g6q Phase 5 documentation open. Per-phase timing in sprint execution summaries still degrades to "n/a" (known gap from prior sprint).

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |     21,581 |   n/a |   $0.000 |   $0.108 |
| reviewer   |          0 |     11,331 |   n/a |   $0.000 |   $0.170 |
| overhead   |     28,450 |     44,864 |  +58% |   $0.587 |   $0.351 |
| TOTAL      |     28,450 |     77,776 | +173% |   $0.587 |   $0.628 |
True-cost estimate (output x 4x): $2.349

Outliers (>200% variance): none
Calibration failures (>500%): none

---

## feature/enhance_parallelism -- 2026-06-26 (cycle 4)

**Sprint goal:** CI-pipeline dedup guard (apra-pm-gtv). Goal met -- all P1/P2 issues closed.

**What was implemented:**

- `auto-sprint.js` (`not_configured` branch, ~line 1980): runs `bd search "Add CI pipeline" --status=open --json` before `bd create`. Skips creation and logs the existing id when an open match is found. Still creates when only closed matches exist, so a resolved prior CI task never suppresses a fresh one.
- `test/ci-watcher.test.mjs`: new tests assert search-before-create ordering, `--status=open` scoping, and the already-exists branch behaviour.
- Test suite: 284 pass, 0 fail.

**Carried forward:** none.

#### Sprint cost analysis
Calibration: historical (3 sprints)   Cycles: estimated 1.5, actual 1

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |     18,036 |      7,494 |  -58% |   $0.271 |   $0.112 |
| reviewer   |      4,995 |      9,202 |  +84% |   $0.075 |   $0.138 |
| overhead   |      7,150 |     55,810 | +681% |   $0.121 |   $0.844 |
| TOTAL      |     30,181 |     72,506 | +140% |   $0.466 |   $1.095 |
True-cost estimate (output x 4x): $1.865

Outliers (>200% variance): overhead
Calibration failures (>500%): overhead

---

## feature/enhance_parallelism -- 2026-06-26 (cycle 3)

**Sprint goal:** Harvest auto bd dolt push (apra-pm-6pw) and Sprint Execution Summary in .analysis.md (apra-pm-2wz). Goal not met -- root feature issues remain open per sprint convention; all implementation and test subtasks (6pw.1.1, 6pw.1.2, 2wz.1.1, 2wz.1.2, 2wz.1.3) are closed and work is releasable.

**What was implemented:**

- `auto-sprint.js`: `bd dolt push` dispatch added to Harvest phase, after `beads-export-cleanup` and before PR creation. Non-fatal -- failure logs a warning and does not abort harvest. Covered by `test/harvest-dolt-push.test.mjs` (8 tests: ordering, non-fatal, no-guard assertions).
- `auto-sprint.js`: `buildExecutionSummary(logEntries, opts)` pure function added (inside PURE_FUNCTIONS block). Emits cycles, per-phase token/cost/dispatch table, failures/retries, and remaining risks at close. Wired unconditionally at harvest so the section appears on both the harvester path and the JS fallback path. Works when `goalMet=false`. Covered by `test/sprint-execution-summary.test.mjs` (28 tests).
- Test suite: 281 tests pass.

**Known gap:** per-phase wall-clock timing in the Execution Summary degrades to "n/a (no timestamps)" in production because `dispatchLedger` entries carry no `ts` field. The JSONL log contains `ts` but is not merged into `logEntries` at the callsite. The section is still useful for token/cost data; a follow-up is needed to merge JSONL timestamps.

**Carried forward:** `apra-pm-6pw` and `apra-pm-2wz` (root issues, open per sprint convention); per-phase timing gap (follow-up bead recommended).

Scope reviewed: branch feature/enhance_parallelism vs main, focused on apra-pm-6pw and apra-pm-2wz (subtasks 6pw.1.1/1.2 and 2wz.1.1/1.2/1.3, all closed). Full suite: 281 tests pass (node --test). No build/lint step is configured in package.json (skill repo).

#### Sprint cost analysis
Calibration: historical (2 sprints)   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |     41,250 |     35,173 |  -15% |   $0.701 |   $0.691 |
| reviewer   |     11,145 |     10,218 |   -8% |   $0.189 |   $0.203 |
| overhead   |      7,150 |     75,114 | +951% |   $0.121 |   $1.039 |
| TOTAL      |     59,545 |    120,505 | +102% |   $1.011 |   $1.933 |
True-cost estimate (output x 4x): $4.046

Outliers (>200% variance): overhead
Calibration failures (>500%): overhead

---

## feature/enhance_parallelism -- 2026-06-26 (cycle 2)

**Sprint goal:** Doer context-limit resilience, Develop-phase progress visibility, and exit-check scoping to sprint roots. 3 sprint goals targeted; goal was not met (root feature issues remain open per sprint convention -- subtasks all closed, work is releasable).

**What was implemented:**

- `agents/doer.md` + doer dispatch prompt: JIT task close -- doer must `bd close <id>` immediately after each commit, before claiming the next task.
- `auto-sprint.js`: `truncateStreakToCeiling()` -- truncates a ready streak to the longest prefix whose summed estimated output tokens stays under `calibration.doer_token_ceiling[tier]`. Wired into the develop loop before each doer dispatch.
- `sprint-logs/calibration.json` + `DEFAULT_CALIBRATION`: `doer_token_ceiling` map keyed by tier (`cheap: 40000`, `standard: 80000`, `premium: 150000`).
- `auto-sprint.js`: doer-null recovery -- when doer returns null, orphaned in_progress tasks are reset to open and the loop retries (no abort). `MAX_DEV_ITER=20` bound prevents infinite loops.
- `auto-sprint.js`: `labelTaskIds()` helper (<=3 ids, `+Nmore`); doer/reviewer agent labels carry task ids; structured log() calls before doer dispatch (ids + est USD), at iter entry (ready count), and after reviewer verdict (APPROVED/CHANGES NEEDED + ids).
- `auto-sprint.js` + `parseBlockers()`: optional `rootIds` argument scopes exit-check open-issue counting to sprint roots only; both callsites updated.
- 6 new test files; test suite: 243 pass, 0 fail.

**Carried forward:** `apra-pm-99a` (root), `apra-pm-bdy` (root), `apra-pm-jf9` (root) -- open as feature roots per sprint convention; subtasks all closed.

Reviewed feature/enhance_parallelism against the three sprint goals (apra-pm-99a, apra-pm-bdy, apra-pm-jf9). All implementation and test subtasks are closed; the three root features remain OPEN, which is correct for an early-ended sprint (roots are type=feature and are closed by the workflow's close-sprint-goals step at sprint end, never by the doer/reviewer). Test suite: 243 pass, 0 fail. The completed work is releasable and ready to harvest.

#### Sprint cost analysis
Calibration: historical (1 sprint)   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |     20,400 |     56,496 | +177% |   $0.330 |   $0.891 |
| reviewer   |      4,634 |     17,676 | +281% |   $0.079 |   $0.361 |
| overhead   |      7,150 |    105,718 | +1379% |   $0.121 |   $1.433 |
| TOTAL      |     32,184 |    179,890 | +459% |   $0.530 |   $2.684 |
True-cost estimate (output x 4x): $2.119

Outliers (>200% variance): reviewer, overhead
Calibration failures (>500%): overhead

---

## feature/enhance_parallelism -- 2026-06-26

**Sprint goal:** Reduce workflow overhead by consolidating agent dispatches, introducing parallelism at cycle boundaries, and making write-only dispatches fire-and-forget. 12 sprint goals targeted; goal was not met (one P1 epic remains open -- `apra-pm-8aq` CI-watcher parent, subtasks closed).

**What was implemented:**

- `auto-sprint.js`: Fire-and-forget `appendNewEntries` and dev-loop `commitFeedback` -- both write to disk only; all git index operations deferred to `beads-export-cleanup`.
- `auto-sprint.js`: Orphaned in-progress task resets merged into a single `dispatchShell` at cycle start.
- `auto-sprint.js`: `write-quote` + `plan-commit` replaced by one `dispatchShell` with a pre-built command list and a fixed `maxTurns` formula.
- `auto-sprint.js`: `push` + `head-sha` merged into a single `dispatchShell`; SHA addressed by fixed output index.
- `auto-sprint.js`: Cycle-start per-cycle checkpoint write and `checkCycleState` run concurrently via `parallel()`.
- `auto-sprint.js`: `calibration-update` and `close-sprint-goals` run concurrently via `parallel()` at sprint end.
- `auto-sprint.js`: `parseBlockers` / `parseReadyStreaks` given explicit `index` parameters; exit-check merged into one `dispatchShell` with fallback.
- `auto-sprint.js`: Deterministic setup steps converted to a single `dispatchShell`; free-form setup agent capped at `maxTurns: 20`.
- `auto-sprint.js`: `ci-watcher` dispatch moved post-PR; annotates PR body via `gh pr comment` when CI is not green.
- `agents/ci-watcher.md`: Reclassifies "runs exist but SHA unmatched" as `pending`, not `not_configured`.
- `agents/harvester.md`: Harvester writes sprint analysis artifact as Step 1; JS fallback writes it when harvester returns null.
- `install.mjs`: `Bash(*)` added as the first entry in `claudeOnlyPermissions()`; fire-and-forget dependency documented. Installer now exports its functions and guards `main()` with an `import.meta.url` check for testability.
- 11 new test files covering all dispatch consolidations (209 tests pass).

**Carried forward:** `apra-pm-8aq` (CI-watcher parent epic), `apra-pm-99a` (doer context-limit resilience), `apra-pm-bdy` (progress log() calls in Develop), CI pipeline issues (`apra-pm-4qg`, `apra-pm-5mk`, `apra-pm-efq`), pm-skill taxonomy epics (`apra-pm-06d`, `apra-pm-bgo`).

#### Sprint cost analysis
Calibration: defaults   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |    157,553 |   n/a |   $0.000 |   $2.118 |
| reviewer   |          0 |     35,842 |   n/a |   $0.000 |   $0.538 |
| overhead   |      7,150 |    132,681 | +1756% |   $0.121 |   $1.976 |
| TOTAL      |      7,150 |    326,076 | +4461% |   $0.121 |   $4.633 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): overhead
