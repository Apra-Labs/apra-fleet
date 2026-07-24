# Dolt conflict recovery: Tier 2 runbook (apra-fleet-eft.9.6)

This is the runbook a REAL agent receives when it is dispatched to resolve a
wedged beads (dolt) clone that the scripted recovery ladder could not close on
its own. It is the dolt counterpart of the git conflict ladder's Tier 2
runbook (`conflict-ladder.mjs`'s `buildConflictResolutionRunbookPrompt`) -- see
that module's header comment for the git version of the same posture.

## Script-first posture: when this is (and is not) dispatched

The dolt sync discipline (Plan Part 3.3/3.4, apra-fleet-eft.9) is
script-first: two scripted recovery paths run with **zero** agent dispatch
before Tier 2 is ever considered:

1. **Path A** (`dolt-recovery.mjs`, apra-fleet-eft.9.4) -- scripted,
   resolve-in-place recovery for a plain single-row conflict in an
   allowlisted table (`issues` by default), gated behind two deterministic
   checks (conflicted table(s) all allowlisted; exactly one conflicted row).
2. **Path B** (`dolt-recovery-path-b.mjs`, apra-fleet-eft.9.5) -- the
   fallback for whatever Path A's gates reject (a multi-row conflict, a
   conflict outside the allowlist, or a genuine operational failure that
   makes resolve-in-place unsafe): discard the wedged clone's local dolt
   state and re-bootstrap fresh from the shared remote, replaying back the
   one pending mutation that mattered.

Tier 2 (this runbook, dispatched by `dolt-recovery-tier2.mjs`'s
`recoverDoltConflict()`) is the escalation of LAST resort: it is dispatched
**only** when

- Path A's deterministic gate rejected the conflict shape, **and**
- Path B was also attempted and itself failed (a scripted step -- most
  commonly `bd bootstrap` or the mutation replay -- returned output that is
  not one of the specific, already-classified recognized failure/gotcha
  patterns).

The recovery procedure must never proceed blind past an output it does not
recognize. Every escalation records the wedged state (see below) before
dispatch -- there is no silent "try something and hope" step anywhere in this
ladder.

## The wedged state you are handed

Every Tier 2 dispatch is armed with a recorded **wedged state** snapshot,
captured immediately before dispatch, with these fields:

- `member` -- which fleet member/clone is wedged.
- `clonePath` -- the local `.beads` embedded dolt data dir this recovery was
  operating against (default `.beads/embeddeddolt`).
- `conflictShape` -- the last `assessConflictGates()` result Path A computed
  (which table(s) conflicted, how many conflicting rows, which gate(s)
  failed), or `null` if Path A never got far enough to compute one.
- `lastOutput` -- the raw error/output text of the last scripted step that
  failed (Path B's failure if Path B ran, otherwise Path A's).
- `stage` -- which stage of the ladder produced this wedged state (e.g.
  `path-b-exhausted`).
- `recordedAt` -- an ISO timestamp of when the state was captured.

Do not guess past what this snapshot tells you -- if it is incomplete or
ambiguous, say so in your report rather than inventing what you think the
conflict must have been.

## Steps to follow, in order

1. Read the wedged state above in full. Confirm you understand `clonePath`,
   `conflictShape`, and `lastOutput` before touching anything.
2. Run `bd dolt status` (or, if unavailable, inspect `.beads/metadata.json`
   and the embedded dolt data dir directly) to confirm the clone's actual
   current state matches what the wedged-state snapshot describes. If it does
   not (e.g. someone already fixed it), say so and stop -- do not "helpfully"
   redo work that already happened.
3. If a merge is genuinely still open and conflicted, use `dolt sql-server`
   against the SAME embedded data dir referenced by `clonePath` (see Path A's
   own module doc for the exact server-start / `dolt_allow_commit_conflicts`
   / `DOLT_MERGE` / `dolt_conflicts` sequence) to inspect every conflicting
   row with real judgment -- not a blind `--ours`/`--theirs` rule. Understand
   BOTH sides of each conflicting row before deciding how to resolve it.
4. Resolve each conflicting row with `CALL DOLT_CONFLICTS_RESOLVE(...)`
   (table-name arg required) and commit with `CALL DOLT_COMMIT(...)`. Verify
   with `SELECT * FROM dolt_conflicts` that zero rows remain before moving on.
5. Confirm zero data loss: `SELECT * FROM dolt_log` must show commits from
   BOTH sides of the original conflict.
6. Flip `.beads/metadata.json` back to `dolt_mode: "embedded"` and stop the
   ephemeral sql-server -- exactly as Path A's own teardown does, and
   regardless of whether you succeeded or not (reversibility always).
7. `bd dolt pull` then `bd dolt push` to republish the reconciled clone.
   Confirm the push actually succeeds -- your own belief that you fixed it is
   never sufficient; a mechanical re-verification (a clean `bd dolt status`
   and a genuinely successful push) is what decides success, the same
   posture as the git ladder's Tier 2 re-verification in
   `runner.js`'s `syncMemberAfter`.
8. If, after this, the clone is still wedged or you are not confident the
   conflict was resolved correctly, do **not** force a push or discard data
   to make the error go away. Report exactly what you observed (the
   conflicting row(s), what you tried, and why it did not resolve) so a
   human can take over -- silently discarding real work to unblock a sprint
   is worse than staying blocked.

Do not run any `bd` beads-content command unrelated to this recovery (no
closing/reopening beads) -- this is a pure dolt-clone-recovery dispatch, not a
development streak.
