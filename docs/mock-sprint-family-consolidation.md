# Mock-sprint family consolidation: grouping map

Status: authoritative partition for the six mock-sprint fold tasks
(`apra-fleet-j918.8.2`, `.8.3`, `.8.15`, `.8.16`, `.8.17`, `.8.18`).
Produced by `apra-fleet-j918.8.20`. Scope of this document: `packages/apra-fleet-se/test/`.

Each fold task executes exactly one batch below. A batch section names its target
family file and its member files by path, so a fold task needs nothing from this
document except its own batch section plus the two global sections
("Rules every fold must respect" and "Regenerating a bd recording").

---

## 1. The governing constraint: the mock-sprint file-count floor

Read this before touching a batch. It is the reason the batches are as small as
they are.

`packages/apra-fleet-se/test/phase1-leaf-facade-completeness.test.mjs` discovers the
mock-sprint suite by globbing the test directory and then asserts a hard floor:

```js
const mockSprintFiles = fs
    .readdirSync(testDir)
    .filter((name) => name.startsWith('mock-sprint-') && name.endsWith('.test.mjs'))
    .sort();
assert.ok(mockSprintFiles.length >= 50, `expected a substantial mock-sprint test suite, found ${mockSprintFiles.length} file(s)`);
```

There are **67** files matching `test/mock-sprint-*.test.mjs` today, so the
consolidation may delete **at most 17** of them in total before that gate turns
red. The six batches below delete **15**, landing at **52** files, which leaves a
deliberate margin of 2.

Consequences the fold tasks must honour:

- A batch may not exceed its stated removal budget. The budgets are a shared,
  non-negotiable allocation of a fixed 17-file allowance; a batch that "just folds
  one more" spends another batch's headroom.
- The floor is *not* to be raised or edited by a fold task. Changing
  `phase1-leaf-facade-completeness.test.mjs` is outside every fold task's stated
  scope. If a future round wants deeper consolidation, that is a separate bead that
  re-derives the floor first.
- The same file counts feeds `ASSUMED_MOCK_SPRINT_FILE_COUNT` in
  `test/phase3-dispatch-engine-completeness.test.mjs`, but that one is safe at any
  count in this range: the shipped budget is
  `min(1_100_000 * N / 2 * 2, 14_400_000)`, whose raw term only drops below the
  4-hour ceiling at `N <= 13`. At `N = 52` the ceiling still binds and the shipped
  value is unchanged.

---

## 2. Rules every fold must respect

These derive from mechanisms verified in the current tree; each one names the file
that enforces it.

**R1 - No renames, no new filenames.** Every family target keeps its existing path.
Both discovery sites (`phase1-leaf-facade-completeness.test.mjs` and
`phase3-dispatch-engine-completeness.test.mjs`) resolve files by the
`mock-sprint-*.test.mjs` prefix/suffix glob, so a rename inside that shape would be
harmless - but keeping the paths fixed also keeps the prose references in
`docs/` and in other tests' comments accurate, at no cost. A fold deletes member
files and leaves the target path untouched.

**R2 - Scenario tags are the recording key; never change one.**
`test/helpers/bd-replay.mjs` keys a recording off the scenario tempdir name with the
trailing `-<millis>-<pid>` stripped, i.e. off the tag passed to
`setup(tag)` / `setupMinimal(tag, ...)` / `runDevelopLoopScenario(tag, ...)`, not off the
test filename. Moving a test between files therefore does **not** invalidate its
recording under `test/fixtures/bd-recordings/`. Every fold below is tag-preserving
and needs **no** recording regeneration.

**R3 - Keep each scenario's own harness call.** Per-scenario isolation is
established inside the harness entrypoint, not at module scope:
`uniqueMockBranch(tag)` in `test/helpers/mock-sprint-harness.mjs` derives a
pid-suffixed branch per invocation, and `runDevelopLoopScenario` allocates and
restores a private `APRA_FLEET_SPRINT_LOCK_DIR` around each run. A fold that keeps
one `runDevelopLoopScenario(...)` / `setup(...)` call per scenario inherits all of
that unchanged. A fold that tries to hoist a shared setup to module scope, or to
collapse two scenarios onto one tag, destroys it. Do neither.

**R4 - Folded scenarios now share a process; the sync memos do too.**
`bd-replay.mjs` states its keying assumption explicitly: "`node --test`'s file-level
concurrency runs each test file in its own process, so per-scenario recordings never
contend." Folding breaks the one-file-per-scenario half of that. In practice this is
already exercised - several existing files run three scenarios each - because
`fleet-sprint/dolt-sync.mjs` memoizes `sync.remote` and the last-synced tip **per
member** for the process lifetime, and every mock scenario uses the same member
`'local'`. The second and later scenarios in a folded file therefore run *warm* and
issue a strict subset of the `bd` calls their recording holds. Unconsumed recorded
entries are harmless; only a call with *no* recorded entry fails. So the expected
outcome of a tag-preserving fold is a clean replay run.

If a fold does produce a replay failure, the fix is to reset the memos between
scenarios, **not** to re-record:

```js
import { invalidateSyncRemoteCache, clearLastSyncedTip } from '../fleet-sprint/dolt-sync.mjs';
// between folded scenarios
invalidateSyncRemoteCache();   // no argument == every member; documented as test hygiene
clearLastSyncedTip('local');
```

**R5 - Do not introduce a bare `timeout:` literal into a budgeted subject file.**
`test/scaled-timeout.test.mjs` reads three mock-sprint files by exact filename with
`fs.readFileSync` and asserts that *every* `timeout:` option in them is literally
`scaledTimeout(180000)`:

```js
const BUDGETED_SUBJECT_FILES = [
    'mock-sprint-publish-push-failure.test.mjs',
    'mock-sprint-kb-remote-scope.test.mjs',
    'mock-sprint-member-vcs-provider-threading.test.mjs',
];
```

Deleting or renaming any of the three makes that guard throw `ENOENT`, and folding a
file carrying a bare numeric timeout into one of them makes it fail its assertion.
All three are on the do-not-fold list for exactly this reason, so the rule is
vacuously satisfied by this map - but a future round must re-check it. The six files
that currently carry a bare numeric `timeout:` literal are
`mock-sprint-regression-failure-never-gates`, `mock-sprint-planner-auth-failure-no-retry`,
`mock-sprint-sprint-state-client-hoist`,
`mock-sprint-planner-dispatch-attempt1-clean-fail-attempt2-dead-session`,
`mock-sprint-watchdog-timeout-sync-teardown` and
`mock-sprint-planner-dpush-failure-no-redispatch`; none of them is a fold member here.

**R6 - Module-load state: there is none to preserve, and none may be added.**
The concern that motivated this map (a file setting `process.env.APRA_FLEET_SPRINT_LOCK_DIR`
at module load, as `test/golden-transcript-3bead.test.mjs` does) does **not** occur
anywhere in the mock-sprint partition. `golden-transcript-3bead.test.mjs` is not a
`mock-sprint-*.test.mjs` file and is outside this partition entirely. Verified over all
68 partition files:

```
cd packages/apra-fleet-se
grep -l "^process\.env\.\|^await \|^const .*= await " \
  test/mock-sprint-*.test.mjs test/slow/mock-sprint-*.test.mjs | wc -l
# => 0
```

The only two `process.env` writes anywhere in the partition are inside test bodies with
save/restore around them (`mock-sprint-windows-vcs-credential.test.mjs:440`/`474` and
`mock-sprint-worklist-resume.test.mjs:53`/`97`, both setting
`APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF`); both files are on the do-not-fold list.
A fold must not introduce module-scope `process.env` assignment or top-level `await`
into any target file.

**R7 - Per-batch acceptance.** After executing a batch, the fold task must show:

```
cd packages/apra-fleet-se
ls test/mock-sprint-*.test.mjs | wc -l                      # >= 50, and equals the batch's stated post-count
node scripts/run-tests.mjs mock test/<target-file>          # the folded family passes in replay mode
git status --porcelain -- test/fixtures/bd-recordings       # empty: no recording churn
```

---

## 3. Batch 1 - develop-loop doer outcomes

Removal budget: 3. Files after this batch: 64.

| Role | Path | Lines | Scenario tag(s) |
|---|---|---|---|
| TARGET | `packages/apra-fleet-se/test/mock-sprint-develop-injection.test.mjs` | 118 | `injection` |
| member | `packages/apra-fleet-se/test/mock-sprint-develop-doer-lies.test.mjs` | 41 | `liar` |
| member | `packages/apra-fleet-se/test/mock-sprint-develop-doer-throws.test.mjs` | 81 | `isolation` |
| member | `packages/apra-fleet-se/test/mock-sprint-develop-orphaned.test.mjs` | 56 | `orphaned` |

Why this family: all four are single-test files whose whole body is one
`runDevelopLoopScenario(tag, { doerHandler ... })` call asserting one develop-loop
doer outcome (a lying doer, a throwing doer, an orphaned bead, an injected
instruction). They share the same imports and the same assertion shape.

Preserve when folding:

- Tags `injection`, `liar`, `isolation`, `orphaned` verbatim (R2). Their recordings
  `test/fixtures/bd-recordings/apra-fleet-mock-sprint-{injection,liar,isolation,orphaned}.jsonl`
  stay valid; no regeneration.
- One `runDevelopLoopScenario` call per scenario (R3) - each keeps its own tempdir,
  branch and lock dir.
- Each member's `doerHandler`/`reviewerHandler` closure moves with its own test; these
  handlers are per-scenario and must not be merged into a shared default.

## 4. Batch 2 - sprint-exit verdicts

Removal budget: 3. Files after this batch: 61.

| Role | Path | Lines | Scenario tag(s) |
|---|---|---|---|
| TARGET | `packages/apra-fleet-se/test/mock-sprint-exit-stale-approval.test.mjs` | 96 | `staleapproval` |
| member | `packages/apra-fleet-se/test/mock-sprint-exit-deferred-goalpriority.test.mjs` | 88 | `deferredgoalpriority` |
| member | `packages/apra-fleet-se/test/mock-sprint-exit-explicit-fail.test.mjs` | 60 | `explicitfail` |
| member | `packages/apra-fleet-se/test/mock-sprint-exit-goalpriority-p3.test.mjs` | 55 | `goalpriority` |

Why this family: four single-test `runDevelopLoopScenario` files that all assert on
the sprint's **exit verdict** and the reason string attached to it.

Preserve when folding:

- Tags `staleapproval`, `deferredgoalpriority`, `explicitfail`, `goalpriority` (R2);
  recordings unchanged, no regeneration.
- The goal-priority pair (`goalpriority` / `deferredgoalpriority`) asserts on two
  *different* priority states of the same goal bead; keep them as two separate tests
  with their two separate tags rather than parameterising them onto one scenario.

## 5. Batch 3 - finalization failure modes

Removal budget: 3. Files after this batch: 58.

| Role | Path | Lines | Scenario tag(s) |
|---|---|---|---|
| TARGET | `packages/apra-fleet-se/test/mock-sprint-finalization-review-retry.test.mjs` | 94 | `finalreviewretry`, `finalreviewretryfail` |
| member | `packages/apra-fleet-se/test/mock-sprint-finalization-gh-failure.test.mjs` | 44 | `ghfailure` |
| member | `packages/apra-fleet-se/test/mock-sprint-finalization-probe-failure.test.mjs` | 37 | `probefailure` |
| member | `packages/apra-fleet-se/test/mock-sprint-finalization-pr-injection.test.mjs` | 80 | `prinjection` |

Why this family: every member drives the finalization phase to a distinct failure and
asserts the resulting handling. The target already hosts two tags, so it is the file
best shaped to host more.

Preserve when folding:

- Tags `finalreviewretry`, `finalreviewretryfail`, `ghfailure`, `probefailure`,
  `prinjection` (R2); recordings unchanged, no regeneration.
- `mock-sprint-finalization-idempotent-pr.test.mjs` is deliberately **not** a member -
  see the do-not-fold list.

## 6. Batch 4 - stall detection

Removal budget: 2. Files after this batch: 56.

| Role | Path | Lines | Scenario tag(s) |
|---|---|---|---|
| TARGET | `packages/apra-fleet-se/test/mock-sprint-stall-oscillation.test.mjs` | 158 | `oscillation` |
| member | `packages/apra-fleet-se/test/mock-sprint-stall-contract-violation.test.mjs` | 61 | `contractviolation` |
| member | `packages/apra-fleet-se/test/mock-sprint-stall-zero-progress.test.mjs` | 68 | `stalled` |

Why this family: the three stall-detector triggers (oscillation, contract violation,
zero progress), each a single `runDevelopLoopScenario` test asserting the stall exit.

Preserve when folding:

- Tags `oscillation`, `contractviolation`, `stalled` (R2); recordings unchanged, no
  regeneration.
- The oscillation scenario is the longest of the three; keep it first in the folded
  file so it is the one that runs cold (R4), matching the state it was recorded in.

## 7. Batch 5 - harness pure-unit helpers

Removal budget: 2. Files after this batch: 54.

| Role | Path | Lines | Scenario tag(s) |
|---|---|---|---|
| TARGET | `packages/apra-fleet-se/test/mock-sprint-harness-network-shaped-command.test.mjs` | 127 | none (pure unit) |
| member | `packages/apra-fleet-se/test/mock-sprint-harness-redact-network-command.test.mjs` | 88 | none (pure unit) |
| member | `packages/apra-fleet-se/test/mock-sprint-harness-vcs-credential-exec.test.mjs` | 265 | none (pure unit) |

Why this family: the lowest-risk batch in the map, and a good one to execute first.
All three import named helpers from `test/helpers/mock-sprint-harness.mjs`
(`isNetworkShapedCommand`, `redactNetworkCommandForLog`, `defaultMockCallTool`,
`buildMockFleetApi`) and assert on them directly. Verified: none of the three creates a
tempdir, runs a sprint, touches `bd-replay.mjs`, or owns a bd recording - the only
`mkdtemp`/`teardown`/`runCmd` occurrences in them are inside comments.

Preserve when folding:

- Nothing scenario-shaped to preserve: no tags, no recordings, no lock dirs, no
  tempdirs. R2/R3/R4 do not apply to this batch.
- Keep the three `describe`/comment blocks intact; each documents a distinct harness
  property (network-shape detection, log redaction, credential-exec simulation).

## 8. Batch 6 - doer max-turns

Removal budget: 2. Files after this batch: 52 (final).

| Role | Path | Lines | Scenario tag(s) |
|---|---|---|---|
| TARGET | `packages/apra-fleet-se/test/mock-sprint-doer-max-turns.test.mjs` | 170 | `doermaxturns`, `doergenericretry`, `doermaxturnsresumeok` |
| member | `packages/apra-fleet-se/test/mock-sprint-doer-max-turns-session-guard.test.mjs` | 78 | `doermaxturnsguard` |
| member | `packages/apra-fleet-se/test/mock-sprint-doer-max-turns-verify-bypass.test.mjs` | 136 | `maxturnsclosed`, `maxturnsopen` |

Why this family: three files, six scenarios, one subject - what the runner does when a
doer dispatch hits its max-turns ceiling. The target already hosts three of the six
tags.

Preserve when folding:

- All six tags verbatim (R2): `doermaxturns`, `doergenericretry`,
  `doermaxturnsresumeok`, `doermaxturnsguard`, `maxturnsclosed`, `maxturnsopen`.
  Recordings unchanged, no regeneration.
- The verify-bypass pair (`maxturnsclosed` / `maxturnsopen`) is a matched
  closed-bead / open-bead contrast; keep both, and keep them adjacent.
- This is the last batch, so it is the one that lands on the 52-file floor margin.
  Re-run the `ls test/mock-sprint-*.test.mjs | wc -l` check from R7 after it.

---

## 9. Do-not-fold list

47 files. Split into two groups: **9A** files that must never be folded (the reason is
a structural property of the file), and **9B** files not folded in this round because
the file-count floor from section 1 is exhausted.

### 9A. Structural - never fold

| Path | Reason |
|---|---|
| `packages/apra-fleet-se/test/slow/mock-sprint-planner-dispatch-stalled-session.test.mjs` | Lives in the `test:slow` lane; the default `test/*.test.mjs` glob does not reach it, and it is the only mock-sprint file using `mock.module`. |
| `packages/apra-fleet-se/test/mock-sprint-publish-push-failure.test.mjs` | Read by exact filename in `scaled-timeout.test.mjs`'s `BUDGETED_SUBJECT_FILES` (R5); deleting it throws `ENOENT` there. |
| `packages/apra-fleet-se/test/mock-sprint-kb-remote-scope.test.mjs` | Same `BUDGETED_SUBJECT_FILES` exact-path read (R5). |
| `packages/apra-fleet-se/test/mock-sprint-member-vcs-provider-threading.test.mjs` | Same `BUDGETED_SUBJECT_FILES` exact-path read (R5). |
| `packages/apra-fleet-se/test/mock-sprint-happy-path.test.mjs` | The reference happy-path run; pairs with the committed golden fixture `test/fixtures/golden-transcript/mock-sprint-happy-path.jsonl`, which `phase4-move-only-completeness.test.mjs` asserts is byte-clean. |
| `packages/apra-fleet-se/test/mock-sprint-abort-pr.test.mjs` | Already the largest file in the suite (810 lines, 13 tests); folding into it lengthens the critical path of every gate that spawns the suite. |
| `packages/apra-fleet-se/test/mock-sprint-windows-vcs-credential.test.mjs` | Mutates process-global state in-test (`APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF`, plus `clearMemberOsCache()`); co-tenants would inherit a mutated retry backoff. |
| `packages/apra-fleet-se/test/mock-sprint-worklist-resume.test.mjs` | Same process-global `APRA_FLEET_MOCK_INSTANT_RETRY_BACKOFF` override, around a local scenario runner rather than the shared one. |
| `packages/apra-fleet-se/test/mock-sprint-pure-logic.test.mjs` | Already the suite's pure-logic aggregate (15 tests, no sprint run); it is a fold destination by construction, not a fold input. |
| `packages/apra-fleet-se/test/mock-sprint-retry-resume-remote-tip.test.mjs` | The only `mock-sprint-*` file that does not import the harness at all; it unit-tests `syncMemberBefore`/`syncMemberAfter` and shares nothing with any family. |
| `packages/apra-fleet-se/test/mock-sprint-harness-setup-epic-id-guard.test.mjs` | Deliberately drives the harness `setup()` into its failure paths (`38o8g-initfail`, `38o8g-createfail`); those induced failures would be misread as co-tenant failures in a shared file. |
| `packages/apra-fleet-se/test/mock-sprint-harness-unmocked-network-guard.test.mjs` | Despite the `harness-` prefix it is not a pure-unit file: it drives a real scenario clone via `setup()` and owns the `unmocked-net-guard-bd` recording, so it does not belong in batch 5. |
| `packages/apra-fleet-se/test/mock-sprint-finalization-idempotent-pr.test.mjs` | Its two tags `idempr1`/`idempr2` encode a deliberate re-run pair whose second recording depends on the first having already run; folding risks reordering them. |

### 9B. Round-scope deferrals - floor exhausted

Not folded in this round: the 17-file allowance from section 1 is fully committed to
batches 1-6 (15 used, 2 held in reserve). Each entry notes the family it would join in
a future round, so a later map can pick these up without re-deriving them.

| Path | Reason |
|---|---|
| `packages/apra-fleet-se/test/mock-sprint-develop-reopen.test.mjs` | Floor exhausted; natural future member of batch 1's develop-loop family (tag `reopen`). |
| `packages/apra-fleet-se/test/mock-sprint-all-streaks-failed-no-review.test.mjs` | Floor exhausted; natural future member of batch 2's exit-verdict family (tag `allfail`). |
| `packages/apra-fleet-se/test/mock-sprint-azure-devops-vcs-preflight.test.mjs` | Floor exhausted; heads a future VCS-provider family (tags `5co82_2ado_ok`, `5co82_2ado_nosec`, `5co82_2gh_ok`). |
| `packages/apra-fleet-se/test/mock-sprint-azure-devops-vcs-publish.test.mjs` | Floor exhausted; future VCS-provider family member, and pure-unit (no tags) so it is cheap to fold later. |
| `packages/apra-fleet-se/test/mock-sprint-vcs-selfheal-remedy.test.mjs` | Floor exhausted; future VCS-provider family member (tags `5co843_ado_remedy`, `5co843_gh_remedy`). |
| `packages/apra-fleet-se/test/mock-sprint-beads-health-gate-diverged.test.mjs` | Floor exhausted; future beads-health-gate family (tag `healthgatediverged`). |
| `packages/apra-fleet-se/test/mock-sprint-beads-health-gate-empty-remote.test.mjs` | Floor exhausted; future beads-health-gate family head (tags `emptyremotegate`, `emptyremotegateneg`). |
| `packages/apra-fleet-se/test/mock-sprint-ensure-branch-fetch-failure.test.mjs` | Floor exhausted; future branch-preflight family (tags `branchfetcherr`, `branchfreshlocal`, `branchnotexist`). |
| `packages/apra-fleet-se/test/mock-sprint-childless-target-scope.test.mjs` | Floor exhausted; future target-scope family head (tags `childless-a/-b/-c`); uses a local scenario runner, so a later fold must re-check R3. |
| `packages/apra-fleet-se/test/mock-sprint-flat-leaf-scope.test.mjs` | Floor exhausted; future target-scope family member (tag `flat-leaf-inv`); local scenario runner, R3 applies. |
| `packages/apra-fleet-se/test/mock-sprint-parent-gate-completion.test.mjs` | Floor exhausted; future target-scope family member (tag `parentgate`). |
| `packages/apra-fleet-se/test/mock-sprint-parent-child-blocks-cycle-repair.test.mjs` | Floor exhausted; future target-scope family member (tags `xbucyclerepair`, `xbucyclenorepairwork`); local scenario runner, R3 applies. |
| `packages/apra-fleet-se/test/mock-sprint-integ-infra-dispatch-failure.test.mjs` | Floor exhausted; future integ-phase family head (tags `integfail`, `integinconc`, `integrecover`). |
| `packages/apra-fleet-se/test/mock-sprint-integ-passed-summary-log.test.mjs` | Floor exhausted; future integ-phase family member (tag `integpass`). |
| `packages/apra-fleet-se/test/mock-sprint-regression-failure-never-gates.test.mjs` | Floor exhausted; future integ-phase family member (tags `regressiongreen`, `regressionred`); carries a bare numeric `timeout:` literal, so R5 applies to any future target. |
| `packages/apra-fleet-se/test/mock-sprint-plan-cap-deferral.test.mjs` | Floor exhausted; future plan-review family head (tags `plancapscoped`, `plancapwhole`). |
| `packages/apra-fleet-se/test/mock-sprint-plan-contracts.test.mjs` | Floor exhausted; future plan-review family member; the only user of `runRejectedPlanScenario` besides the marker-verdict file (tag `rejected`). |
| `packages/apra-fleet-se/test/mock-sprint-plan-review-acceptable-alternative.test.mjs` | Floor exhausted; future plan-review family member (tag `planrelitigate`). |
| `packages/apra-fleet-se/test/mock-sprint-replan-short-circuit.test.mjs` | Floor exhausted; future plan-review family member (tags `replanguard`, `replansc`, `replansctrl`). |
| `packages/apra-fleet-se/test/mock-sprint-planner-auth-failure-no-retry.test.mjs` | Floor exhausted; future planner-dispatch family head (tag `plannerauthnoretry`); uses `scaledTimeout(180000)` already, so R5 is satisfied but must be re-checked on any fold. |
| `packages/apra-fleet-se/test/mock-sprint-planner-dispatch-attempt1-clean-fail-attempt2-dead-session.test.mjs` | Floor exhausted; future planner-dispatch family member (tag `planner502ordering`); carries a bare numeric `timeout:`, R5 applies. |
| `packages/apra-fleet-se/test/mock-sprint-planner-dpush-failure-no-redispatch.test.mjs` | Floor exhausted; future planner-dispatch family member (tag `plannerdpushfail`); carries a bare numeric `timeout:`, R5 applies. |
| `packages/apra-fleet-se/test/mock-sprint-watchdog-timeout-sync-teardown.test.mjs` | Floor exhausted; future planner-dispatch family member (tag `plannerwatchdogsync`); carries a bare numeric `timeout:`, R5 applies. |
| `packages/apra-fleet-se/test/mock-sprint-review-scope-excludes-failed-streak.test.mjs` | Floor exhausted; future review-scope family head (tag `review-scope`). |
| `packages/apra-fleet-se/test/mock-sprint-reviewer-dispatch-error.test.mjs` | Floor exhausted; future review-scope family member (tags `reviewerdispatcherr`, `reviewerschemaerr`). |
| `packages/apra-fleet-se/test/mock-sprint-re-review-goal-scope-guard.test.mjs` | Floor exhausted; future review-scope family member (tag `rereviewguard`). |
| `packages/apra-fleet-se/test/mock-sprint-scenario-marker-verdict.test.mjs` | Floor exhausted; future review-scope family member (tags `markerverdict`, `markerverdictrej`); mixes both scenario runners, so a later fold must re-check R3. |
| `packages/apra-fleet-se/test/mock-sprint-streak-assignment-no-duplicate-row.test.mjs` | Floor exhausted; future streak/lane family head (tag `streak-nodup-log`). |
| `packages/apra-fleet-se/test/mock-sprint-streak-partial-failure-attribution.test.mjs` | Floor exhausted; future streak/lane family member (tag `streak-attr`). |
| `packages/apra-fleet-se/test/mock-sprint-lane-metadata-grouping.test.mjs` | Floor exhausted; future streak/lane family member (tags `lane-metadata`, `no-lane-metadata`). |
| `packages/apra-fleet-se/test/mock-sprint-worklist-batch.test.mjs` | Floor exhausted; future worklist family head (tags `wlbatch`, `wlbatchtier`, `wldefault`). |
| `packages/apra-fleet-se/test/mock-sprint-worklist-failure-isolation.test.mjs` | Floor exhausted; future worklist family member (tag `wlfailiso`). |
| `packages/apra-fleet-se/test/mock-sprint-round-resume.test.mjs` | Floor exhausted; future round/state family head (tags `roundresumesnf`, `roundresumewarm`) - note the warm/cold pair interacts with R4, so a later fold must order them deliberately. |
| `packages/apra-fleet-se/test/mock-sprint-sprint-state-client-hoist.test.mjs` | Floor exhausted; future round/state family member (tag `3swo61sprintstate`); carries a bare numeric `timeout:`, R5 applies. |

---

## 10. Regenerating a bd recording

No fold in this map requires it (R2). If a future change does:

```
cd packages/apra-fleet-se
node scripts/run-tests.mjs record test/<the-file>.test.mjs
```

**The file argument is mandatory.** `scripts/run-tests.mjs` passes through extra args
but otherwise defaults its `node --test` target to `test/*.test.mjs`, a non-recursive
glob. So a bare `npm run test:record` exits 0 while silently regenerating nothing under
`test/slow/` - the command succeeds and the fixture is unchanged. Any recording for
`test/slow/mock-sprint-planner-dispatch-stalled-session.test.mjs` (tag
`plannerstalledsession`) must name that path explicitly. Commit the refreshed
`test/fixtures/bd-recordings/*.jsonl` with the change that caused it;
`phase4-move-only-completeness.test.mjs` asserts the golden-transcript fixtures are
git-clean, so stray fixture churn is a red gate.

---

## 11. Partition proof

Enumeration and partition check, run against the tree this map was written on.

```
cd packages/apra-fleet-se
ls test/mock-sprint-*.test.mjs test/slow/mock-sprint-*.test.mjs | sort > /tmp/all.txt
wc -l < /tmp/all.txt                 # 68  (67 top-level + 1 under test/slow)

# /tmp/batched.txt = the 21 paths in sections 3-8; /tmp/donotfold.txt = the 47 in section 9
sort /tmp/batched.txt | uniq -d | wc -l                                # 0  -> no file in two batches
comm -12 <(sort /tmp/batched.txt) <(sort /tmp/donotfold.txt) | wc -l   # 0  -> batches and do-not-fold are disjoint
comm -23 /tmp/all.txt <(cat /tmp/batched.txt /tmp/donotfold.txt | sort) | wc -l  # 0  -> no file omitted
comm -13 /tmp/all.txt <(cat /tmp/batched.txt /tmp/donotfold.txt | sort) | wc -l  # 0  -> no path invented
```

Result: 21 + 47 = 68 = every mock-sprint test file, each appearing exactly once.

Removal arithmetic:

| Batch | Files in batch | Removals | Top-level count after |
|---|---|---|---|
| (start) | - | - | 67 |
| 1 | 4 | 3 | 64 |
| 2 | 4 | 3 | 61 |
| 3 | 4 | 3 | 58 |
| 4 | 3 | 2 | 56 |
| 5 | 3 | 2 | 54 |
| 6 | 3 | 2 | 52 |
| total | 21 | 15 | 52 (floor 50, margin 2) |

Batches are independent and may be executed in any order; only the running
`ls test/mock-sprint-*.test.mjs | wc -l` figure depends on ordering, and the final 52
does not.
