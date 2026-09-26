# Beads Database Maintenance Playbook (Prune / Flatten / Compact)

## Why this is needed

Beads is backed by Dolt, which uses a differential (commit-chain) storage
model: every issue/field mutation is a new Dolt commit layered on top of the
last. Over weeks of active use across many fleet members, this accumulates:

- A long, ever-growing commit history that every `bd dolt pull`/`push`
  has to walk.
- Debris from closed issues, stale comments, and superseded field values
  that are no longer useful but are still physically present in every
  clone's `.beads/` store.

Both effects make ordinary beads operations (`bd list`, `bd dolt pull`,
`bd bootstrap`) measurably slower over time, and the effect compounds --
every member clone carries the same growing history independently. Roughly
every couple of weeks, the team should run this maintenance procedure to
prune closed debris and flatten the history back down to a single base
commit.

## This is a disruptive procedure -- read before running

`bd flatten` (and `bd compact`) rewrite Dolt history: they discard the
existing commit chain and replace it with a fresh one that has **no shared
ancestor** with any existing clone. This is not an ordinary merge conflict --
it is an unrelated-history situation. No automated self-heal exists for it
today (see `apra-fleet-417.10`: this was proposed and designed but never
implemented). The only way any *other* clone recovers is to discard its
local `.beads/` state and re-bootstrap fresh from the rewritten remote.

In practice this means: once you run this procedure, every other fleet
member's beads clone is stale and broken until it is manually
re-bootstrapped. There is no way to "merge forward" -- members have no
choice but to throw away their local `.beads/` and re-clone.

## Prerequisites (do not skip)

1. **All members have pushed.** Confirm every active member has run
   `bd dolt push` and has no unpushed local mutations. Anything not pushed
   before the flatten is permanently lost (not merged, not recoverable) --
   there is no scoped export/replay step in this procedure.
2. **All members are "in the know."** Notify every operator/member owner
   before starting: after this runs, their next beads operation may fail or
   show stale/wrong data until they re-bootstrap. Do not run this silently
   mid-sprint -- pause or wait for a natural gap between sprints on every
   member first.
3. **No sprint is actively mutating beads.** Check `GET /api/sprints` on the
   supervisor(s); an in-flight sprint pushing/pulling beads during the
   flatten will hit the unrelated-history failure mid-run.

## Procedure

**Order matters: prune first, then flatten -- never the other way round.**
`bd prune` only deletes rows; Dolt's differential storage still holds that
data in old commit generations until something GCs it. `bd flatten` does a
single full GC pass at the end of its squash. Pruning first means that one
GC pass reclaims both the old history *and* the just-deleted rows together.
Flattening first and pruning after would leave the prune's deletion commits
un-reclaimed on top of the already-squashed history, requiring a second
full GC (another flatten or `bd gc`) to actually free that space -- wasteful
given a full GC can take minutes on multi-gigabyte stores.

Run from any single clone with dolt push access to the shared remote
(the orchestrator member's beads-only folder is a good choice -- see
`supervisor-setup-guide.md` Step 3).

1. **Dry-run the prune first:**
   ```bash
   bd prune --older-than 14d --dry-run
   ```
   `--older-than` (not `--days` -- that flag belongs to `bd compact`, see
   below) is the age gate: run this on a 2-week cadence and use
   `--older-than 14d` to match, so each run only sweeps the closed backlog
   that has aged out since the last run instead of re-sweeping everything
   closed every time. Adjust the value if the team's actual cadence drifts
   (e.g. `--older-than 30d` for a monthly cadence). `--pattern '*'` (delete
   every closed bead regardless of age) is also available but not the
   recommended default for a recurring maintenance cadence -- reserve it for
   a one-off full sweep.

   Review the dry-run output before proceeding. `bd prune` only removes
   closed, non-ephemeral beads (issues/deps/labels/events/comments); pinned,
   open, in-progress, and closed-but-referenced-by-an-open-bead items are
   skipped by default. Pass `--ignore-references` only if you deliberately
   want to drop closed beads that an open bead still references in its
   description/notes/comments.

2. **Run the prune for real:**
   ```bash
   bd prune --older-than 14d --force
   ```

3. **Flatten the history to reclaim storage:**
   ```bash
   bd flatten --force
   ```
   This runs the full squash-and-GC sequence (new branch, soft-reset to
   root, single-commit snapshot, swap main, prune remote-tracking refs,
   full Dolt GC across all generations). The full GC can take several
   minutes on a multi-gigabyte store. This step is irreversible -- no
   Dolt time-travel after this point.

4. **Push:**
   ```bash
   bd dolt push
   ```

5. **Verify:**
   ```bash
   bd status
   ```
   Confirm issue counts look sane (open/closed totals match expectations
   from the pre-prune dry-run).

## Recovering every other clone

This is the mandatory follow-up step on **every other fleet member and
checkout** (dev checkouts, deploy checkouts, the orchestrator folder, any
local scratch clones) -- there is no automated version of this today:

```bash
mv .beads .beads.bak-$(date +%s)
bd bootstrap --yes
bd status   # confirm issue counts match the freshly-flattened remote
```

On Windows/PowerShell:
```powershell
Rename-Item .beads ".beads.bak-$(Get-Date -UFormat %s)"
bd bootstrap --yes
bd status
```

Once every clone reports matching counts, delete the `.beads.bak-*`
backups.

## Notes for next time

- Track how many months/weeks elapse between runs and how long `bd dolt
  pull`/`bd list` took just before this run vs. just after, so degradation
  can be tracked over time.
- `apra-fleet-417.10` remains open, unimplemented design work to make the
  "recover every other clone" step automatic (scoped export before
  discard, re-bootstrap, replay). Until that lands, the manual
  re-bootstrap step above is the only recovery path.
