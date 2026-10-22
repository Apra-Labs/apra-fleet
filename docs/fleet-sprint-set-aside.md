# fleet-sprint: set-aside and immediate stall

How the sprint engine handles work that cannot proceed, without retrying it
forever or burning cycles on it.

## Rules

1. **A BLOCKED bead is set aside, with its dependents.** When a doer reports
   BLOCKED, the engine records the blocked bead ids and every bead that
   transitively depends on them via open `blocks` edges. Set-aside beads are not
   handed to doers again this run. Other beads in the same streak return to the
   ready pool.
2. **A deploy Permissions failure sets the deploy aside.** Only a deployer
   result whose `failedStep` is `permissions` does this. Later cycles skip the
   deployer, but the last deploy failure is still reported so the deploy
   verdict gate keeps working.
3. **Immediate stall.** If nothing is left that can make progress because of
   set-aside work, the sprint stalls at once, rather than after the usual
   two no-progress cycles. The stall error names every set-aside bead and
   `deploy` (blocker ids and reasons).
4. **Report.** A "Set aside this run" section appears in the PR body (publish
   and abort paths) and in the sprint analysis. It is omitted when nothing was
   set aside.

## Design points

- Blocked ids come from the doer's structured `blockedIds` field, or, failing
  that, from the one bead still open in the streak. Notes text is never parsed.
- Dependent traversal follows only `blocks` edges. `parent-child` edges are
  grouping, not ordering, and closed beads are skipped (see
  `_shared/GRAPH-SEMANTICS.md`). The traversal relies on `bd list --all --json`
  returning dependency edges.
- The stall evaluation is a pure function (no I/O) so it is unit-testable; the
  runner calls it at the start of each round and at Cycle Evaluation, before the
  two-cycle stall check.
- The code is plain JS with no shell, path or process assumptions, so it is
  OS-neutral.

## Known gaps

- If the deploy is set aside and every bead is closed, the deploy-blocked retry
  branch still runs up to its cycle limit and logs "Re-attempting deploy next
  cycle" although the deploy is never redispatched. These cycles are wasted.
- The abort path passing the set-aside data into the PR body is covered only by
  building the body directly, not by an end-to-end test.

## Testing note

Tests that used to rely on BLOCKED being retried now leave a bead open without
BLOCKED, which still exercises the retry path.
