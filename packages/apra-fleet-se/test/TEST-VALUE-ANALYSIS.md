# Test Suite Value Analysis -- packages/apra-fleet-se

> **Point-in-time analysis artifact (2026-07-16). NOT committed, NOT a code change.**
> Ground truth: the TAP timing log from the verified clean run of
> `node --test --test-concurrency=4 test/*.test.mjs` (268 tests / 64 suites / 0 fail,
> wall clock 16m01s, exit 0). All durations below are the real `duration_ms` values
> from that log. Every one of the 25 test files and the shared harness
> (`test/helpers/mock-sprint-harness.mjs`) was read in full for this analysis, along
> with the relevant source under test (runner.js seams, contracts.mjs, cli.mjs,
> viewer-extensions.mjs) as needed.

## 0. What "64 suites" actually is (row-count correction)

Node's summary line `# suites 64` does NOT mean 64 top-level test groupings. The real
structure of the run is:

- **75 top-level run units**: 44 top-level `describe()` suites + 31 top-level bare
  `test()` calls (all the slow mock-sprint / golden-transcript / stall tests are bare
  `test()`s, which node counts under `tests`, not `suites`).
- The reported **64 suites** = those 44 top-level describes + **20 nested describes**
  (9 per-schema groups inside `contracts.test.mjs`'s "verdict schemas", 8 per-role
  groups inside the runner role-input tripwire, 1 `validateRoleInput (AC5)` group,
  and 2 "AC:" groups in the vendor-consistency file).

A 64-row table would therefore either double-count nested describes or omit every
slow test. The honest unit of analysis is the **75 top-level run units**, and that is
what the table in section 3 enumerates (nested describes are covered inside their
parent's row). Stated explicitly per the task instruction: the true top-level count
is 75, not 64.

## 1. Headline numbers

| Metric | Value |
|---|---|
| Wall clock (concurrency 4) | 16m 01s (958.8s) |
| Cumulative top-level test time | 48.1 min (2,886s) |
| Effective parallelism | 3.01x of the configured 4 |
| Slow units (>30s each) | 25 of 75 (33%) = 2,884.5s = **99.94% of all runtime** |
| Fast units | 50 of 75 (67%) = **~1.6s total** |

**The suite is not slow because it has too many tests. It is slow because 25 tests
each drive a full mock sprint against a REAL `bd` (Dolt-backed) CLI database.**
The proof is already inside the suite: `runner-arg-contract.test.mjs`'s
"runner.js mock-level execution" suite drives the complete runner.js sprint loop
(plan -> develop -> review -> deploy -> integ -> final review -> harvest -> PR)
in **163 ms** using a spy fleetApi with canned `bd` responses. The same loop against
a real `bd init` scratch DB takes 48-66s (budget-live's minimal 1-bead scenarios).
So >99% of each slow test's duration is `bd` child-process time (dozens of
`bd init/create/list/show/update/close/link` invocations at roughly 1-3s each on
Windows), not the logic under test.

(Attempted to directly benchmark raw `bd init`/`bd create` in a scratch dir to pin
the per-call cost; the permission layer blocked `bd init` -- surfaced per project
policy, not worked around. The inference above rests on the TAP durations of
scenarios with known bd-call counts, which is sufficient.)

## 2. Pareto analysis (the user's "99% value for 10% of tests?" question)

Honest answer first: **99% of protection at 10% of runtime is not achievable by
test selection alone**, because ~90% of the runtime sits in 25 tests that each guard
a DISTINCT, real, previously-observed regression class (N1, N3, N8, N9, N10, N11,
N12, A5, A6, pool-collapse, prompt drift...). Deleting time means deleting distinct
coverage -- until the `bd` cost itself is attacked (section 4, mechanism 2), which
DOES get you ~95%+ of protection at <15% of today's wall time.

Concrete cutoffs (cumulative test time; wall time estimated at concurrency 4):

| Profile | What runs | Cumulative time | Est. wall | Protection kept | What you give up detecting |
|---|---|---|---|---|---|
| A. Fast lane | The 50 fast units only | ~1.6s | **~5-10s** | ~50% of regression classes | ALL end-to-end orchestration: stall/oscillation aborts, budget accrual, exit-condition bugs (orphaned/deferred/stale-verdict), doer-failure isolation, PR idempotency, golden prompt drift |
| B. Smoke profile | Fast 50 + 6 representatives: golden main (84s), happy-path (240s), doer-lies (86s), plan-reject (48s), zero-progress stall (141s), budget-trip (35s) | ~634s (22% of total) | **~5-6 min** | ~85-90% | Oscillation/thrash variant of stall, stale-verdict re-review, deferred/orphaned exit variants, PR-injection wiring, git/gh failure surfacing, multi-member pool, per-member pricing |
| C. Drop redundant only | Everything except: 3 determinism second-runs (golden det, 3bead det, happy-path run2), git-push-failure test (folded into gh-failure), duplicate resolveSchemasDir precedence suite | saves ~490s cumulative | **~12-13 min** | ~100% (determinism proofs demoted to nightly, not deleted) | Nothing per-commit; determinism regressions caught nightly instead of per-push |
| D. Scheduling only (recommended first) | Everything, files re-split + `--test-concurrency=8` | unchanged 48.1 min cumulative | **~6.5-8 min** | 100% | Nothing |
| E. Fake-bd (recommended investment) | Everything, mock-sprint scenarios on an in-memory bd shim + 1-2 real-bd canaries | est. <3 min cumulative | **~2 min** | ~95-98% (bd-CLI contract drift covered by canaries) | Real-bd interaction bugs outside the canary paths (e.g. a bd flag rename that only a non-canary scenario exercises) |

So the realistic Pareto: **~90% of protection at ~35% of wall time by selection (B)**,
**100% at ~45% by pure scheduling (D)**, **~95-98% at ~12% with the fake-bd
investment (E)**. D and E compose: D now, E when someone has a day to build the shim.

### Per-file runtime (the scheduling unit for `node --test`)

| File | Cumulative | File | Cumulative |
|---|---|---|---|
| mock-sprint-stall-detection | 7.8 min | happy-path | 5.2 min |
| mock-sprint-finalization-pr | 7.6 min | budget-live | 4.4 min |
| mock-sprint-develop-failures | 7.3 min | golden-transcript-3bead | 4.3 min |
| mock-sprint-exit-goalpriority | 6.4 min | golden-transcript | 4.2 min |
| mock-sprint-plan-contracts | 0.8 min | all 16 other files combined | ~2s |

Perfect-packing lower bound on wall time: 12.0 min at concurrency 4, 6.0 min at
concurrency 8. Observed 16 min means today's packing loses ~4 min to file
granularity alone.

## 3. The full table (75 top-level run units, in run order)

Tiers: **CRIT** (unique, load-bearing, would ship a real bug class if deleted) /
**HIGH** (distinct real regression class) / **MED** (real but narrow, or partially
covered elsewhere) / **LOW** (cheap change-detector, marginal protection) /
**DUP** (redundant with a named sibling -- deletable with ~zero coverage loss).

| # | File | Suite / test | ms | Tier | Protects against | Overlap | Speed-up |
|---|---|---|---|---|---|---|---|
| 1 | agents-markdown-drift-guard | agents/ md in sync with dist/agents/ | 6 | MED | Editing the non-canonical planner/plan-reviewer .md copy and having it silently no-op at runtime | none | none needed |
| 2 | budget-live | apra-fleet-unw2.8 (N10): live budget accounting (5 tests) | 265,554 | HIGH | Budget going silently inert again (no model on dispatch -> cost never accrues -> ceiling unreachable); tier metadata not reaching doer dispatch; literal model IDs being rewritten; real per-member pricing silently degrading to tier-band fallback; BudgetExceededError becoming unreachable | each of its 5 tests re-runs the same full pipeline as #49 just to inspect models/cost | biggest per-suite win: tests 1+5 mergeable (one run asserts both accrual and no-ceiling default); tests 2+3 are single-assertion checks on the doer dispatch model -- provable in the plan+develop phases alone or at unit level against the model-selection code; all five are fake-bd candidates (assertions are on dispatched/cost events, not bd state) |
| 3 | cli-robustness | parseCliArgs (a) | 6 | HIGH | A typo'd CLI flag silently defaulting instead of failing loudly | none | -- |
| 4 | cli-robustness | resolveMemberValidation (b) | 4 | HIGH | Sprint starting against an unregistered member; --allow-missing-members semantics | none | -- |
| 5 | cli-robustness | resolveRoleMap + buildRunnerArgs -> validateArgs (c) | 43 | HIGH | --role-map/--requirements-file parsed but dropped before the runner; malformed/colliding role maps accepted | key-normalization overlaps #67 (validateArgs side) | -- |
| 6 | cli-robustness | checkIssuesExistOnMember (d) | 2 | HIGH | The `bd show` precondition running locally instead of on the orchestrator member; transport failure counted as a silent pass | none | -- |
| 7 | cli-robustness | --budget flag (f) | 2 | MED | --budget parsed but never reaching args.budget; negative/NaN accepted | end-state validated again in #2 | -- |
| 8 | cli-robustness | viewer port (e) | 36 | MED | Viewer port collision crashing the process instead of a clean actionable error (binds a real socket) | none | -- |
| 9 | cli-server-resolution | resolveFleetServerCommand | 15 | HIGH | Installed/bundled layout failing with an opaque spawn error (real bug 3ns.1); env overrides ignored | none | -- |
| 10 | cli-server-resolution | resolveRunnerScriptPath | 3 | HIGH | Same layout-resolution bug class for the runner script path | shares error-shape with #9 | -- |
| 11 | contracts-schema-loader | loadSchemaFileFrom | 15 | MED | Loader throwing on absent file (must return null) or silently accepting malformed JSON | none | -- |
| 12 | contracts-schema-loader | majorVersionFromId | 1 | LOW | A one-regex helper; failure would surface via #13 anyway | #13 | -- |
| 13 | contracts-schema-loader | assertVersionPin | 3 | MED | A vendored schema major-version bump loading silently instead of failing loudly | none | -- |
| 14 | contracts-schema-loader | SCHEMAS/validateRoleInput wired vs fixture dir | 50 | HIGH | Vendored-schema resolution silently falling back to literals; input pre-flight validation (harvester/reviewer required keys) breaking | none | -- |
| 15 | contracts-schema-loader | fallback shim vs real resolveSchemasDir() | 1 | MED | contracts.mjs import crashing / exporting unusable schemas in any checkout layout | #20 covers the empty-dir wired case | -- |
| 16 | contracts-schema-observability | whole-directory absence stays quiet | 181 | MED | The documented fallback state starting to warn-spam | none | -- |
| 17 | contracts-schema-observability | dir exists but a role file missing warns | 65 | MED | A submodule bump silently dropping one role's schema (schema quietly reverts to fallback) | none | -- |
| 18 | contracts-schema-observability | allowlist roles never warn | 108 | LOW | planner allow-list detail; narrow | #17 is the load-bearing half | -- |
| 19 | contracts-schema-packaging | resolveSchemasDir path-precedence (direct) | 5 | DUP | Same 4-tier precedence logic as #24, tested twice in two files with the same injection technique | **#24 (contracts-schemas-dir-resolution)** covers branches 1-5 incl. the env override and empty-string cases | delete this suite OR #24's overlapping cases; keep one file |
| 20 | contracts-schema-packaging | wired end-to-end vs real OS temp dir | 84 | MED | A corrupted/partial install (no vendor/ ancestor) crashing at import instead of degrading to fallback literals | none | -- |
| 21 | contracts-schema-packaging | vendor-schemas.mjs --check drift | 477 | MED | The vendoring script's drift gate breaking (exits 0 on divergence) -- spawns 2 real node subprocesses | none | acceptable cost |
| 22 | contracts-schema-vendor-consistency | vendored/fallback consistency (+2 nested AC groups) | 42 | HIGH | A submodule bump changing a role schema without the fallback literal being updated (silently-wrong fallback window) | none | -- |
| 23 | contracts-schema-vendor-consistency | fixture drift actually caught (mutate 1 byte) | 82 | MED | The #22 checker itself being vacuous (meta-test) | proves #22 | -- |
| 24 | contracts-schemas-dir-resolution | resolveSchemasDir | 5 | HIGH | Bundled-location precedence violations; env-override handling (the canonical copy of what #19 duplicates) | #19 | keep this one |
| 25 | contracts | ROLES | 3 | LOW | Someone editing the frozen role list -- a change-detector that restates a literal | any role-consuming test fails too | -- |
| 26 | contracts | normalizeRole | 1 | LOW | Trivial lowercase/trim helper | exercised via #5/#67 | -- |
| 27 | contracts | validateRole | 1 | LOW | Enum membership check | #25/#26 | -- |
| 28 | contracts | verdict schemas (+9 nested per-schema groups) | 9 | HIGH | Any of the 9 ajv verdict schemas loosening (an invalid LLM verdict passing) or tightening (valid verdicts rejected) -- these schemas gate every LLM response in the sprint loop | fixture-level; wired behavior covered by mock sprints | -- |
| 29 | contracts | wrapUntrustedBlock | 2 | HIGH | Prompt-injection fence escape: embedded ``` runs closing the untrusted block early (A7); fence-widening logic | wiring asserted in #49 | -- |
| 30 | contracts | appendSchemaInstruction | 1 | LOW | Prompt suffix formatting | golden #33 would catch drift | -- |
| 31 | golden-transcript-3bead | 3-bead: streak+reviewer lists match snapshot | 82,872 | HIGH | Reverting the title/id sort that makes multi-bead prompts deterministic (invisible to the single-bead golden #33 where sorts are no-ops) | complements #33 | fake-bd candidate; scenario is already minimal |
| 32 | golden-transcript-3bead | 3-bead: two runs identical (determinism) | 177,515 | MED | Nondeterminism creeping into the 3-bead prompt artifacts -- a second FULL run purely as proof | #31 fails too if determinism breaks vs the snapshot | **demote to nightly** (saves 177s) |
| 33 | golden-transcript | happy-path dispatch sequence matches snapshot | 83,936 | CRIT | ANY unreviewed prompt rewording, schema-id change, or dispatch reorder in runner.js -- the only test that catches arbitrary prompt drift | none (unique breadth) | fake-bd candidate (bd output flows into prompts; the shim must be output-faithful, or keep this as a real-bd canary) |
| 34 | golden-transcript | two runs identical transcript (determinism) | 170,194 | MED | Nondeterminism in the full transcript; second full run as proof | #33 vs committed snapshot already catches per-run drift | **demote to nightly** (saves 170s) |
| 35 | mock-sprint-develop-failures | doer that throws is isolated; sibling completes | 92,088 | HIGH | parallel() isolation regressing (one failing streak aborting the cycle); retry-exactly-once (2x per round) logic | none | fake-bd; also inherently runs 3 dev rounds -- a maxCycles/round cap tweak isn't safe (the 6-dispatch count is the assertion) |
| 36 | mock-sprint-develop-failures | doer that lies is treated as failure | 85,788 | HIGH | Trusting doer-claimed closedIds instead of verifying via bd (anti-rubber-stamp core) | #59 reuses the same lying doer for stall | fake-bd |
| 37 | mock-sprint-develop-failures | reviewer reopenIds applied by orchestrator | 93,837 | HIGH | Privilege separation regressing (reviewer mutating beads itself); prompt-level bd-mutation ban dropped | none | fake-bd |
| 38 | mock-sprint-develop-failures | malicious reviewer newTasks rejected non-fatally | 75,251 | HIGH | N3 wiring: injection payloads reaching command(); rejection aborting the sprint | unit logic pinned in #62 -- this row is the wiring + non-fatality proof | fake-bd |
| 39 | mock-sprint-develop-failures | orphaned in_progress bead != success | 89,751 | HIGH | A5: `--ready == []` misread as done while a bead is stuck in_progress | #40/#41 same exit-check code, different statuses | fake-bd |
| 40 | mock-sprint-exit-goalpriority | out-of-goal P3 doesn't block P1/P2 | 108,293 | HIGH | Goal-priority exit window regressing (P3 blocking completion) | #39/#41 | fake-bd |
| 41 | mock-sprint-exit-goalpriority | deferred goal-priority bead blocks success | 86,522 | MED | N18a: `deferred` missing from NOT_DONE_STATUSES | same exit-check window as #39/#40 -- one status-enum away | fake-bd; also carries two cheap runner.js source-regex assertions (A6) that could live in a fast file |
| 42 | mock-sprint-exit-goalpriority | stale APPROVED needs fresh re-review | 115,358 | HIGH | N8: exiting on a prior cycle's verdict when this cycle's review never ran | none | fake-bd |
| 43 | mock-sprint-exit-goalpriority | final FAIL -> status:failed, PR still published | 74,706 | MED | A6 FAIL-side propagation + FAIL verdict visible in PR text | PASS side asserted inside #49; #39 also proves FAIL propagation | fake-bd |
| 44 | mock-sprint-finalization-pr | finalization re-run idempotent (no throw on existing PR) | 154,651 | HIGH | N11: re-running a sprint against a branch with an existing PR crashing at `gh pr create` -- runs TWO full sprints by design | none | fake-bd (halves twice the cost of everyone else) |
| 45 | mock-sprint-finalization-pr | adversarial verdict notes can't inject into gh pr create | 79,457 | HIGH | hfs: LLM-authored verdict notes breaking out of the quoted gh command | sanitizer unit-pinned in #70; this is the wiring proof | fake-bd |
| 46 | mock-sprint-finalization-pr | injected gh pr create failure -> typed error | 82,281 | MED | A real (non-"already exists") gh failure being swallowed | #47 same seam | fake-bd |
| 47 | mock-sprint-finalization-pr | injected git push failure -> typed error | 70,596 | DUP | Same non-failSoft command() error-surfacing mechanism as #46, one command earlier | **#46** (identical mechanism, same code path in runner.js's publish step) | fold into #46 as a second injection in one scenario (saves ~70s) |
| 48 | mock-sprint-finalization-pr | deploy.md probe failure skips phases, no throw | 68,758 | MED | A4: probe failure killing the sprint instead of skipping Deploy/Integ | none | fake-bd |
| 49 | mock-sprint-happy-path | happy path deterministic across two runs | 239,678 | CRIT | The flagship: full pipeline reaches success; git fetch/checkout-first + push/PR-last ordering; never auto-merges; harvester receives all 5 required inputs with real content; planner --metadata (not --notes) tier convention; plan-reviewer scope; doer branch; reviewer prompt untrusted-fencing; PASS in PR title/body; run1-vs-run2 dispatch + bead-state determinism | run2 half (~120s) overlaps #34's determinism proof; PASS PR text pairs with #43's FAIL | drop run2 per-commit (nightly), keep run1's assertions (saves ~120s); fake-bd |
| 50 | mock-sprint-happy-path | multi-member pool distributes + branch-ensure on every member | 71,149 | HIGH | The 'Doer' casing pool-collapse bug (all work landing on member[0]); N4 branch-ensure reaching every member's checkout | none | fake-bd |
| 51 | mock-sprint-plan-contracts | plan-reviewer never approves -> abort, zero doers | 48,470 | HIGH | Substring-matching "APPROVED" in a rejection; unapproved plan reaching Develop; 3-round bound | none | already the cheapest full-sprint (aborts in plan phase); fake-bd |
| 52 | mock-sprint-pure-logic | parseBdJson noise -> diagnostic error | 3 | MED | A bd deprecation warning producing a bare SyntaxError with no command context | none | -- |
| 53 | mock-sprint-pure-logic | checkMemberTopology: single member passes | 1 | MED | (with 54-56) shared-checkout topology refusals -- feeds the known member=folder constraint | -- | -- |
| 54 | mock-sprint-pure-logic | checkMemberTopology: shared identity passes | 0 | MED | see #53 | -- | -- |
| 55 | mock-sprint-pure-logic | checkMemberTopology: disagreeing identities refuse | 0 | HIGH | Two members on divergent checkouts silently corrupting a sprint | -- | -- |
| 56 | mock-sprint-pure-logic | checkMemberTopology: unresolvable identity refuses | 1 | MED | see #55 | -- | -- |
| 57 | mock-sprint-pure-logic | checkHarvesterContract catches blank inputs | 14 | MED | The harvester contract checker regressing to label-matching (vacuous pass on blank analysisText etc.) -- meta-test proving #49's harvester assertions are real | proves #49 | -- |
| 58 | mock-sprint-pure-logic | computeBranchSlug collision disambiguation | 2 | MED | feat/x vs feat-x colliding into one analysis artifact path | none | -- |
| 59 | mock-sprint-stall-detection | zero-progress stall-abort before max_cycles | 141,023 | HIGH | Stall detector deleted/loosened: a no-progress sprint burning all cycles (and budget) | #60 covers the harder variant | fake-bd |
| 60 | mock-sprint-stall-detection | close/reopen oscillation -> high-water-mark stall + thrash flag | 293,617 | HIGH | N9: adjacent-delta stall check defeated by 5,4,5,4 oscillation; per-bead reopen-thrash attribution | subsumes much of #59's mechanism but needs the rise-then-plateau shape | the single most expensive test: shrink the filler chain 5 -> 2-3 beads (still rise-then-plateau; saves est. 1.5-2 min); fake-bd |
| 61 | mock-sprint-stall-detection | contradictory CHANGES_NEEDED -> ReviewerContractViolationError | 35,108 | HIGH | N8b: a finished sprint misreported as stalled; empty-reopenIds CHANGES_NEEDED looping forever | none | fake-bd |
| 62 | newtasks-validation | validateNewTask | 8 | HIGH | The N3 injection allowlist loosening ($(...), backticks, trailing backslash, bogus priority reaching bd create) | wiring proven in #38 | -- |
| 63 | regen-vendor-schema-fixtures | pure copy mechanics | 27 | LOW | A dev script's read/copy/diff helpers | #64 is the part that matters | -- |
| 64 | regen-vendor-schema-fixtures | checked-in fixture consistency | 13 | HIGH | The fixture snapshot drifting from the real vendor/apra-pm submodule -- every fixture-based schema test in the suite silently tests stale schemas without this | none (it validates the others' foundation) | -- |
| 65 | runner-arg-contract | validateIssueId | 5 | HIGH | Shell-injection ids reaching command() | #67 aggregates | -- |
| 66 | runner-arg-contract | validateBranchName | 2 | HIGH | Shell-injection branch names | #67 | -- |
| 67 | runner-arg-contract | validateArgs | 12 | HIGH | Contract defaults/required args; roleMap normalization + collision; unknown args | #5 (CLI side) | -- |
| 68 | runner-arg-contract | runner.js mock-level execution | 163 | CRIT | Full runner loop with a spy fleetApi: args reach execution and the published state; malicious/missing/unknown args -> ZERO fleet dispatches; orchestrator roleMap routes bd commands to the mapped member. Best protection-per-ms in the suite -- and the existence proof that the sprint loop itself costs ~0.2s without real bd | none | none needed -- this is the template for mechanism 2 |
| 69 | runner-role-input-contract | role-input contract tripwire (+8 nested role groups) | 25 | HIGH | N13/N1: a prompt builder dropping a vendored-required input (scope/branch/harvester quintet) -- source-derived, so it re-arms itself against reverts | #49 asserts the same contracts at dispatch level | -- |
| 70 | sanitize-pr-text | sanitizePrText | 7 | HIGH | The PR-text sanitizer loosening (quote/backtick/$ escaping into gh commands) | wiring proven in #45 | -- |
| 71 | viewer-extensions | renderBeadsHtml: XSS escaping | 12 | HIGH | LLM-authored bead titles executing script in the dashboard (which exposes /stop) | none | -- |
| 72 | viewer-extensions | renderBeadsHtml: dependency tree | 6 | MED | Blocks-based nesting breaking; dependency cycles infinite-looping the renderer | none | -- |
| 73 | viewer-extensions | renderBeadsHtml: badges defensive | 3 | LOW | Cosmetic badge fallbacks (UNKNOWN/MISC/BLOCKED) | none | -- |
| 74 | viewer-extensions | renderBeadsHtml: Sprint/Backlog layout | 2 | LOW | Section headers/sort cosmetics | none | -- |
| 75 | viewer-extensions | beadsExtension embedded script valid | 4 | MED | Template-literal escaping bugs corrupting the .toString()-embedded browser script | #71 re-run against the embedded copy | -- |

Tier totals: CRIT 3 (523.8s) / HIGH 32 (2,145.0s) / MED 25 (~214.6s) / LOW 10 (~0.06s) / DUP 2 (70.6s).
(The HIGH total is dominated by 14 slow mock-sprint tests; the 15 fast HIGH suites cost 0.3s combined.)

## 4. Concrete time-reduction mechanisms (no protection loss unless stated)

1. **Scheduling (zero risk, do first): re-split the slow files and raise
   concurrency.** The wall clock is bounded by file-level packing: stall-detection
   (7.8 min), finalization-pr (7.6), develop-failures (7.3), exit-goalpriority (6.4)
   are the long poles, and effective parallelism is only 3.01x. Split each of those
   four files so no file exceeds ~5 min (e.g. one file per big test), and raise
   `--test-concurrency` to 8 -- these tests are child-process/IO-bound (bd
   subprocesses), not CPU-bound, and every scenario already uses an isolated temp
   dir, so they parallelize safely (watch only for Windows EBUSY noise in teardown,
   which is already retried). Expected wall: **~6.5-8 min** (perfect-packing bound
   at concurrency 8 is 6.0 min; the 4.9-min oscillation test is the new long pole).

2. **Kill the real-bd tax (the structural fix): an in-memory `bd` shim.**
   Every slow test's cost is `bd` (Go binary + embedded Dolt store) subprocesses:
   `bd init` per scenario plus dozens of create/list/show/update/close/link calls.
   Row #68 proves the entire runner loop runs in 163 ms when executeCommand returns
   canned bd output. The scenarios' assertions are about runner.js's orchestration
   (dispatch order, exit conditions, error types, command strings) -- not about bd
   internals -- so an in-memory bead store implementing the ~7 subcommands the
   runner and harness actually issue (init, create [-t/-p/--metadata/--silent],
   list [--json/--ready/--all/--parent/--status/--priority-max], show, update
   [--parent/--status], close, link), returning byte-plausible JSON, preserves
   nearly all their value. Keep the happy-path (#49) and golden main (#33) on real
   bd as CLI-contract canaries. Expected result: 22 mock-sprint tests drop from
   50-290s each to low seconds; wall **~2 min**. Cheaper intermediate variant:
   create ONE warmed `bd init` template dir per test file and `fs.cp` it per
   scenario -- removes the (likely most expensive) Dolt store creation from every
   scenario without faking anything.

3. **Demote the three determinism second-runs to a nightly lane** (#32, #34, and
   run2 inside #49): each re-executes an identical full sprint purely to prove
   run-to-run stability, ~490s cumulative. Per-commit, the snapshot comparisons
   (#31/#33 vs committed golden files) already catch drift; true nondeterminism is
   a slow-moving property well served nightly.

4. **Delete the two DUP rows**: fold #47 (git push failure) into #46 (gh failure)
   as a second injected failure in one scenario (~70s), and drop one of the two
   resolveSchemasDir precedence suites (#19 vs #24, ~0s but removes a maintenance
   double).

5. **Scenario diet on the worst offender**: #60's filler dependency chain (5 beads,
   one unblocked per cycle) exists only to produce a rise-then-plateau closed-count
   history; 2-3 fillers produce the same shape for ~40% fewer cycles (~1.5-2 min
   saved). Similarly, budget-live's five tests run five full sprints where two
   sprints plus unit-level model-selection assertions would prove the same wiring
   (~2-3 min saved).

6. **Not recommended**: deleting any of the slow HIGH tests outright. Each maps
   1:1 to a real, previously-shipped bug (N1, N3, N4, N8, N9, N10, N11, N12, N18,
   A5, A6, hfs, pool-collapse) -- this suite is unusually honest in that respect;
   there is remarkably little dead weight among the expensive tests. The waste is
   in HOW they run (real Dolt-backed bd per scenario, duplicate determinism runs,
   file packing), not in WHAT they test.

## 5. Bottom line

- 50 of 75 test units cost ~1.6s total and are all worth keeping as-is.
- 25 units consume 99.94% of the runtime; ~23 of them guard distinct real
  regression classes and should not be deleted.
- The user's hypothesized "99% value at 10% time" is not reachable by selection,
  but IS effectively reachable by engineering: scheduling alone halves the wall
  clock to ~7-8 min with zero change in protection; a fake-bd layer (modeled on the
  already-existing 163ms spy-API suite) gets ~95-98% of today's protection at
  roughly 2 minutes.
- Single best next action: split the four >6-min files and run at
  `--test-concurrency=8` -- a ~10-line, zero-coverage-risk change that removes
  ~half the wall time today.
