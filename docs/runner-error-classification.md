# Runner error classification (fleet-sprint)

`packages/apra-fleet-se/fleet-sprint/runner.js` runs an autonomous sprint (Plan
-> Develop -> Review -> Publish, looping over cycles) and has to make several
independent decisions about any error it catches: does the run get a terminal
record so the supervisor watchdog doesn't call it CRASHED, does it push the
branch and raise an `[ABORTED]` PR, does the post-dispatch sync/teardown run
or get skipped, and does a reviewer verdict count as a genuine contract
violation. Each of those is a different question, and conflating them was the
root defect this area of the code had accumulated: a single blanket
`instanceof WorkflowError` check used to gate both "give this run a terminal
record" and "treat this as an abort worth a push and a PR", which swept
routine, non-terminal failures (ordinary dispatch retries, transient sync
errors) into a false `ABORTED` verdict.

The design now keeps these as separate, narrowly-scoped predicates rather
than one shared check. Each predicate documents, in the code, exactly which
error classes it includes/excludes and *why* -- that rationale is what a
future edit needs to preserve, not just the classification table itself.

## The four predicates

### `isTypedAbortError(err)`
Answers: "is this a genuine sprint abort that deserves a branch push and an
`[ABORTED]` PR?" It is a curated, explicit class list -- not
`instanceof WorkflowError` -- because most `WorkflowError` subclasses are
routine failures each phase already retries or soft-fails on its own.
Included: `StalledSprintError`, `SprintPlanRejectedError`,
`ReviewerContractViolationError`, `BudgetExceededError`, `GitDivergedError`,
a bare `DoltDivergedError` or one wrapped inside a `PostDispatchSyncError`,
and the pre-sprint-validation-failed message prefix. `CancelledError` is
always excluded (cooperative cancellation is a requested shutdown, not an
abort). Divergences are included deliberately: excluding them would starve
the `BEADS_SYNC_CONFLICT` terminal-reporting path (conflict dump capture)
that depends on `isTypedAbortError` returning true for a divergence.

### `isTerminalSprintFailure(err)`
Answers: "does this run get a terminal run-state record at all?" This is
deliberately broader than `isTypedAbortError`: it is true for every
`WorkflowError` (plus everything `isTypedAbortError` covers), because the
supervisor watchdog needs *any* typed failure -- not just aborts -- to read
as FINISHED-with-a-reason rather than CRASHED (e.g. a Planner dispatch error
from a dead interactive session). An untyped throw (a plain `Error` -- i.e. a
real bug) is intentionally NOT terminal here, so it still surfaces to the
CLI's top-level catch with no record and the watchdog reports it as CRASHED,
which is the correct signal for an unclassified defect.

These two predicates must not be collapsed back into one: `main()`'s catch
uses `isTerminalSprintFailure` to decide whether to write the terminal
record, and `isTypedAbortError` (a strict subset) to decide whether to also
push the branch and raise the abort PR.

### `isNoMutationDispatchFailure(err)`
Answers: "did this dispatch fail before producing any usable code/beads
mutation, such that the post-dispatch sync teardown would be wasted work and
should be skipped?" True for `AgentDispatchError` (except when its
`details.reason` is in `AGENT_RAN_DISPATCH_REASONS`), `FleetTransportError`,
or `BudgetExceededError`. `AGENT_RAN_DISPATCH_REASONS` = `max_turns_exhausted`
and `watchdog_timeout` -- both cases where the agent provably ran (turn
ceiling hit after real work; or the watchdog only abandoned a stalled *local*
promise while the remote member kept running and may have finished a whole
plan) so teardown must still happen normally. `AgentOutputError` is
explicitly excluded for the same reason: the LLM responded and only its
output was empty/unparseable, which routinely follows real committed work.
This predicate only ever sees pre-dispatch-boundary errors (it is checked
inside `withGitSync`'s dispatch closure), so it does not need to reason about
the full `isTypedAbortError` set -- only `BudgetExceededError` is reachable
from that set at this point, since everything else in `isTypedAbortError` is
either raised strictly after a dispatch already mutated state, or is a
sync-bracket divergence that can't occur inside a dispatch closure.

### `isReviewerContractViolation(verdict)`
Answers: "did the reviewer's `CHANGES_NEEDED` verdict violate the reviewer
contract?" `replanIds` is treated as a subset of `reopenIds`, matching the
pre-existing consumption gate: a `replanIds` entry that isn't also in
`reopenIds` is a silent-drop bug in the reviewer's own output, not something
the runner should quietly swallow, so it now surfaces both as a contract
violation and as a `replanIds: DROPPED` log line. `buildReviewerPrompt` was
updated to describe this same subset constraint so the reviewer's own
instructions match what the runner enforces.

## Other classification-adjacent behaviors this area owns

- **Final Review LLM-auth self-heal**: a successful self-heal on the auth
  failure path short-circuits (`handledByAuthSelfHeal`) instead of falling
  through into a second dispatch; a heal-retry that itself throws degrades
  through the same generic FAIL ladder every other Final Review failure uses,
  rather than a bespoke path.
- **Plan-reviewer dispatch failures**: a dispatch-layer failure while asking
  the plan-reviewer for a verdict is marked with `dispatchFailed: true` and
  retried, and only reaches `PlanReviewDispatchFailedError` (an infra failure)
  when every round is exhausted with the whole plan contested -- it must never
  be misreported as `SprintPlanRejectedError` (a genuine plan rejection is a
  distinct, non-infra outcome and the two must stay distinguishable to a
  human/CI reading the failure).
- **Publish push**: pushing the sprint branch during Publish is fail-soft with
  a bounded retry (delays: 0s, 5s, 15s). A persistent failure after all
  retries is logged, skips `gh pr create` and target-issue closure, but still
  returns the computed PASS/FAIL verdict with `pushed:false` rather than
  turning a real verdict into a run failure -- the sprint's work product
  (the verdict) and its publish step are treated as separable outcomes.

## Invariant for future changes to this area

When adding a new typed error class or a new dispatch-failure reason, decide
explicitly which of the four predicates above it belongs in (it is normal
for the answer to differ per predicate for the same error class) and update
that predicate's own explanatory comment, not just its `if` list. A
contract/routing test enumerating the full class-by-predicate table lives
alongside `runner.js`'s test suite and is the place to pin the new row(s);
treat gaps in that table as the primary regression risk in this area, since
the whole point of narrowing the checks was to make silent misclassification
visible rather than convenient to reintroduce.
