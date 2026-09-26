# Migrating a beads (bd) Dolt database to 1.1.0

**Who this is for:** anyone upgrading `bd` from a 1.0.x release to **1.1.0** whose beads
database syncs through a git remote (`refs/dolt/data`). On the first write after the upgrade
you will hit:

```
refusing to auto-apply pending schema migrations to a remote-backed database (v49 -> v53):
migrating clones independently forks the schema.  Writes are blocked until the schema is reconciled.
```

This is a **deliberate safety gate**, not a bug (beads issue #4259). If two clones migrated the
same shared remote independently, their Dolt histories would fork into an unmergeable state. So
the rule is: **exactly one clone migrates and pushes; any other clone adopts that result.**

> Source of truth for this procedure: bd's own `CHANGELOG.md` (1.1.0) and
> `website/docs/getting-started/upgrading.md`. The gate is enforced in
> `internal/storage/schema/remote_migrate_gate.go`.

---

## The common case: one owner, one clone (do this)

**Almost everyone is here** -- you own your beads DB and it lives on one machine. You are your
own designated migrator, so it is four commands:

```bash
# 1. On your CURRENT (old) bd binary: publish everything first.
bd dolt push

# 2. Install bd 1.1.0  (e.g. `npm install -g @beads/bd@1.1.0`, or the GitHub release).

# 3. Cheap insurance: back up issues as JSONL before migrating.
bd export --all -o .beads/backup/pre-migrate-$(date +%Y%m%d).jsonl

# 4. Migrate and publish. BD_ALLOW_REMOTE_MIGRATE=1 is the "I am the sole migrator" override
#    that lifts the gate; it is safe precisely because no one else shares this DB.
BD_ALLOW_REMOTE_MIGRATE=1 bd migrate     # applies v49 -> v53 locally
bd dolt push                              # publishes the migrated schema to your remote
```

That's it. Because no other clone shares your remote, there is nothing else to reconcile.

> `bd migrate` (no subcommand) is the command that applies the schema migrations -- there is no
> separate `bd migrate schema` step for this.

---

## The rare case: you personally run more than one machine against the SAME remote

Only if *you* have several clones (e.g. a laptop and a desktop) syncing one beads remote. Then
pick ONE as the migrator and have the others adopt.

**Step 0 -- on EVERY clone, while still on the OLD binary:**
```bash
bd dolt push      # publish all local work
bd dolt pull      # get in sync
# then STOP editing until the upgrade is finished
```
This is the critical precaution: once 1.1.0 is installed, **`push` and `pull` are also refused**
while migrations are pending, so any work still stranded on a not-yet-upgraded clone can be lost
when that clone later runs `bd bootstrap` (which *replaces* its local DB).

**Step 1 -- the designated migrator only:**
```bash
bd export --all -o .beads/backup/pre-migrate-$(date +%Y%m%d).jsonl
# install bd 1.1.0
BD_ALLOW_REMOTE_MIGRATE=1 bd migrate
bd dolt push
```

**Step 2 -- every OTHER clone of yours:**
```bash
# install bd 1.1.0
bd bootstrap      # adopts the migrated DB from the remote (dolt pull is refused with pending migrations)
```
`bd bootstrap` is the adopt mechanism -- it repoints the local DB at the migrated remote. No git
re-clone is needed.

---

## Notes

- **The auto-gate (`BD_SMART_GATE`, default on):** the *first mover* may auto-migrate when the
  remote is still at the old version; it stops and points to `bd bootstrap` if the remote is
  *already* migrated; and it stops for a human if it detects a genuine fork. The explicit
  `BD_ALLOW_REMOTE_MIGRATE=1` path above works **regardless** of this setting, which is why it is
  the reliable thing to script.
- **Recovering from an accidental fork:** if `bd dolt pull` ever fails with
  `cannot merge because table ... has different primary keys`, two clones migrated independently.
  Pick one canonical clone, ensure its data is complete (compare against a `bd export`), then have
  every other clone re-adopt with `bd bootstrap`.
- **Backups are cheap:** `bd export --all` before any migration is always worth it; the JSONL is a
  complete, human-readable snapshot you can re-import.

---

## Not applicable: `no-db` / JSONL-only projects

If a project sets `no-db: true` in `.beads/config.yaml` (JSONL is the source of truth and Dolt
sync is disabled), there is **nothing to migrate** -- any `refs/dolt/data` on its remote is a stale
cache from an older bd. Such a project should simply drop the stale ref and let each clone build a
fresh local DB from `issues.jsonl`. The fleet e2e toy repo is the only project in this category.
