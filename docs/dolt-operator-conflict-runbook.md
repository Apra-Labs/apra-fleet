# Dolt conflict recovery: Operator runbook (apra-fleet-3pb)

This is the procedure a HUMAN OPERATOR follows when their own local clone's
`bd dolt pull` reports a merge conflict against `origin/main`, and they have
direct shell/`dolt` CLI access to that clone. It is the exact procedure used
live on 2026-07-30 (verified safe twice, no data loss).

## When to use this runbook (vs the Tier 2 runbook)

Use **this** runbook when: you are an operator on your OWN local beads clone
(not a fleet member's clone), `bd dolt pull` failed with a merge-conflict
message, and you have direct terminal/`dolt` CLI access to resolve it by
hand.

Use
[`packages/apra-fleet-se/fleet-sprint/docs/dolt-tier2-runbook.md`](../packages/apra-fleet-se/fleet-sprint/docs/dolt-tier2-runbook.md)
instead when: a fleet MEMBER's clone is wedged during an automated sprint and
an agent has been dispatched (by `dolt-recovery-tier2.mjs`) to resolve it as
the last-resort escalation after the scripted Path A/Path B recovery ladder
both failed. That is a different actor (a dispatched agent, not you at a
terminal), a different clone (a member's, not your own), and a different
entry point (automated escalation, not a merge conflict you personally hit).

See also: the Tier 2 runbook links back here for the "I am a human at a
terminal, not a dispatched agent" case.

## Step 1: a failing `bd dolt pull` is safe, not destructive

If `bd dolt pull` fails with something like `merge conflicts ... merge
aborted and working set restored`, this is SAFE. `bd` detected the conflict,
aborted the merge, and restored your working set to exactly what it was
before the pull. You have not lost anything and your clone is not corrupted.
Do not panic-reset or re-clone -- proceed to the steps below.

## Step 2: find the embedded-Dolt working directory (GOTCHA)

Every clone's embedded Dolt data lives under `.beads/embeddeddolt/<name>`,
but `<name>` is **not** the same across clones -- it is whatever
`dolt_database` says in that clone's own `.beads/metadata.json`. Do not
assume it is `beads`, `apra_fleet`, or any other specific value; read it out
of the file every time:

```bash
cat .beads/metadata.json
# {
#   "database": "dolt",
#   "backend": "dolt",
#   "dolt_mode": "embedded",
#   "dolt_database": "beads"          <-- this is the directory name to use
# }
```

The working directory for every raw `dolt` command below is then
`.beads/embeddeddolt/<dolt_database value>` -- e.g. `.beads/embeddeddolt/beads`
for the metadata.json shown above, but check your own clone's file before
proceeding; a different clone may say `apra_fleet` or something else
entirely.

## Step 3: set a throwaway local Dolt identity

Raw `dolt` CLI commands (as opposed to `bd`'s own wrapped commands) require a
committer identity. Set one scoped to this repo only -- do not touch your
global git/dolt identity:

```bash
cd .beads/embeddeddolt/<dolt_database value>
dolt config --local --add user.email "operator-recovery@local"
dolt config --local --add user.name "Operator Recovery"
```

## Step 4: reproduce the conflict without `bd`'s auto-abort

`bd dolt pull` aborts and hides the conflict the moment it detects one (Step
1). To actually inspect it, reproduce the merge yourself with `--no-commit`
so it stays open instead of auto-aborting:

```bash
dolt merge origin/main --no-commit
```

## Step 5: inspect the conflict

First get the shape (which table(s), how many conflicting rows):

```sql
select table, num_conflicts from dolt_conflicts;
```

Then inspect the actual conflicting row(s) for the table(s) reported above
(substitute the real table name, e.g. `issues`):

```sql
select * from dolt_conflicts_issues;
```

Understand BOTH sides of every conflicting row before deciding how to
resolve it -- do not resolve blind.

## Step 6: resolve per table

For a table where picking one side wholesale is genuinely safe (e.g. one
side is a stale/no-op duplicate of the other), resolve it directly:

```bash
dolt conflicts resolve --ours <table>
# or
dolt conflicts resolve --theirs <table>
```

> **CAUTION -- real content collisions must never be silently discarded.**
> If the conflict is a genuine content collision (TWO DIFFERENT issues
> independently claiming the SAME id, with different, both-real content),
> picking `--ours` or `--theirs` wholesale destroys the losing side's work.
> In that case:
>
> 1. Pick a side to keep at the original id (typically whichever is already
>    referenced elsewhere, or was pushed first).
> 2. Recreate the LOSING side's content under a **fresh** id.
> 3. Add a cross-reference note on both issues (the kept one and the
>    recreated one) pointing at each other and explaining the id collision
>    and recovery.
> 4. Only then run `dolt conflicts resolve` for that table.
>
> Never resolve a genuine content collision by simply discarding one side's
> work.

## Step 7: commit and push

```bash
dolt add -A
dolt commit -m "resolve dolt conflict: <short description>"
dolt push origin main
```

## Step 8: verify every clone pulls cleanly afterward

The recovery is not done until you have confirmed it from a DIFFERENT
clone's perspective, not just your own:

```bash
bd dolt pull
```

Run this in every clone that was (or could have been) affected. A clean pull
everywhere, with no conflict reported, is what confirms the reconciliation
actually worked -- your own belief that you fixed it is not sufficient.
