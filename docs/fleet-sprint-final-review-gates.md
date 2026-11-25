# fleet-sprint Final Review gates and terminal sync

How the engine keeps a sprint from reporting PASS while work is unreviewed,
open, or unsynced. Generic engine behaviour; applies to any target repo.

## Open-work verdict gate

Final Review applies `applyOpenWorkVerdictGate` (in `set-aside.mjs`) after all
other verdict gates. The verdict becomes FAIL when:

- the final open-at-goal set is non-empty, or
- a verify-routed bead at or above goal priority is unclosed and not deferred.

It reads the same raw at-goal view as the verify carry-over builder, so the two
cannot disagree. Blocking ids are placed at the top of the notes, the
reviewer's own notes are kept, and ids another gate already named are not
repeated. The notes reach the PR body; the PR title carries only the verdict.

## Review catch-up

`sprintState.reviewedScopeIds` is a ledger of beads that were ever in a review
round's scope. `runReviewCatchUpPhase` runs inside Final Review on a fresh
closed-bead read and reviews any closed bead not in the ledger (for example a
bead from a FAILED streak that closed late). If the review budget is spent, the
beads are reopened instead, and the open-work gate then forces FAIL.

Known limits:
- The ledger records "was ever reviewed", not "latest close was reviewed". A bead
  reopened by a reviewer and later re-closed by a FAILED streak is skipped.
- Guarded reopens also reopen below-goal beads the sprint worked on; those do not
  count toward the at-goal open set.

## Dolt push race handling

`dolt-sync.mjs` treats a push race (another clone pushed first) as expected:

- `expectedFailureKinds` suppresses the "FAILED ... may be stale" log for a race
  that is then healed.
- Reconciliation is a bounded loop (`DOLT_PUSH_RACE_MAX_RECONCILES`, 3) with
  jittered waits. Exhaustion throws `DoltPushRaceError`, a subclass of
  `DoltDivergedError`, so existing handlers still apply.
- Auth failures never enter the loop.

At the terminal, `publish-pr.mjs` (`checkTerminalBeadsSync`) reads the
`DoltSync.flush()` ledger, retries each pending member once, and otherwise
reports a `beads-sync-failed` result in the PR body and run record (status
success-with-warnings). The terminal push goes through `DoltSync.syncAfter`, so
failures land in that ledger.

## Typed early rejections in execute_prompt

Pre-dispatch rejections return `structuredContent {isError, reason}` (see
[mcp-tools.md](mcp-tools.md)). They are deterministic, but are not yet listed in
`isNonRetryableDispatchError`, so dispatch-role may spend retries on them.
