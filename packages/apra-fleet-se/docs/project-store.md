# Fleet-supervisor project store (`supervisor.sqlite`)

The fleet-supervisor console is gaining a project domain -- one console
project per beads-tracked repo, with the members that belong to it, cached
git/beads probe results, and (eventually) a UI for binding members, viewing
health, and driving sprints per project. This document describes the
durable-state layer that domain is built on: a `node:sqlite`-backed store
(`src/projects/store/`) and its first HTTP surface (`src/projects/routes/`).
Both are implemented; the route module is not yet mounted into the running
supervisor -- see "Current status" below.

This is a different subsystem from the sprint-launch API described in
`docs/supervisor-api.md` (`/api/sprints`, `/api/members`, `/api/health`).
That API predates the project domain and reasons about running/queued
sprints and member reservations; the project store reasons about which
projects exist and what each project's members look like on disk. The two
will eventually share the supervisor process and its `route()` table, but
they are independent data models.

## Why `node:sqlite` and not a JSON ledger

Every other piece of durable supervisor state (the reservation ledger, sprint
history) is a JSON file under the service data directory. The project domain
needs relational integrity that a hand-rolled JSON store does not give for
free: a member's cached git-probe row is meaningless once its project is
deleted, and losing that invariant silently (rather than via an enforced
foreign key) was judged a worse failure mode than taking a dependency on
`node:sqlite`. `node:sqlite` is a Node builtin from Node 22.13.0 onward, so
the dependency costs nothing to package -- but it is also not usable on an
older runtime, which the store's own opener has to detect and report
rather than crash into: attempting to `require('node:sqlite')` on a floor
below 22.13.0 throws an opaque, unhelpful error from deep in the call stack,
so the loader catches it and re-throws a typed `NodeSqliteUnavailableError`
naming the runtime, the floor, and the remedy. Call sites that can degrade
instead of failing (tests, optional features) check availability first
rather than catching the thrown error.

## Store invariants

- **One file, one data-dir knob.** The store's path is always derived from
  the same `FLEET_SE_DATA_DIR` knob (falling back to `~/.apra-fleet-se`)
  that every other piece of supervisor state already honours. There is
  deliberately no second hardcoded home-directory literal anywhere in the
  store module -- an isolated store (a test, a sandbox deploy, two
  supervisors on one host) is obtained purely by pointing the data-dir knob
  elsewhere, and any code path that hardcoded a path would silently escape
  that isolation.
- **WAL journalling and `PRAGMA foreign_keys = ON`, set on every open.**
  SQLite leaves foreign keys off by default and journal mode is
  per-connection, not persisted in the file -- so both pragmas are applied
  by the opener itself, not left to whichever repository module happens to
  run first. Every declared `ON DELETE CASCADE` and FK rejection in the
  schema depends on this.
- **Ordered, idempotent migrations, each in its own transaction.** A
  migration module exports `{version, name, up(db)}`; the runner sorts by
  version, skips anything at or below the store's recorded
  `schema_version`, and wraps each migration's DDL together with its
  `schema_version` insert in one transaction -- so a failing migration
  leaves neither half-applied DDL nor a version row that claims success.
  Reopening an already-migrated store is therefore a true no-op: this is
  what makes "run the app again" a safe migration strategy with no separate
  "check if migrated" step anywhere else in the codebase.
- **The remote in a project's beads binding is operator-supplied, never
  created by the console.** A project's `beads.remote` field is nullable
  (a project may point at a purely local beads clone), and nothing in the
  store or its migrations ever writes a remote that the operator did not
  already provide. See "DQ-12: probe, never create" below for how the route
  layer enforces the same invariant on write.

## Schema (as of the first migration)

- **`projects`** -- one row per console project: `id` (operator-chosen
  slug, the natural primary key -- not a surrogate key), `name`,
  `backlog_member` (the fleet member that owns the beads database),
  `beads_kind`/`beads_dir`/`beads_remote`/`beads_prefix` (the beads
  binding), `operator`, and timestamps.
- **`member_git`** -- the cached result of the per-member git probe, one row
  per `(project_id, member)`, `ON DELETE CASCADE` from `projects`. A member
  with no checkout still gets a row (all checkout columns `NULL`) so "bound
  but no checkout" is representable and distinct from "never probed".
  `origin_slug` (the normalised host+path of the checkout's origin) is the
  grouping key the project-overview and sprint-definition surfaces use to
  split a project's members into repo groups, and is indexed alongside
  `member` for that lookup and for cross-project member lookups
  respectively. Writes are always upserts (`INSERT ... ON CONFLICT DO
  UPDATE`) since a probe re-runs against the same pair every refresh, never
  a fresh insert needing a separate update path. `worktrees`, `playbooks`,
  and `status_json` are TEXT columns holding serialized JSON; the
  repository module serializes on write and parses on read so every other
  caller works with objects/arrays, never hand-rolled `JSON.stringify`/
  `parse`.
- **`schema_version`** -- one row per applied migration (`version`, `name`,
  `applied_at`), maintained entirely by the migration runner in `db.mjs`.

Deleting a project cascades to its `member_git` rows with no separate
"refuse if members are bound" guard: `member_git` is a probe cache, not
state of its own, so losing it alongside its project is correct behaviour,
not a hazard.

Every repository function (`createProject`/`updateProject`/`upsertMemberGit`
etc.) that rejects an invalid row throws a `StoreValidationError` carrying
one or more `{field, reason}` entries -- collecting every violation rather
than stopping at the first -- which the route layer maps directly onto its
400 response bodies. A write that violates a foreign key (e.g. an
`member_git` upsert against a project id that does not exist) is caught at
the SQLite layer and re-thrown as the same `StoreValidationError` shape, so
callers have exactly one error type to handle for "this row cannot be
written."

## DQ-12: probe, never create

The console must never create a beads remote on the operator's behalf --
only verify that one supplied by the operator is real and reachable. The
`/api/projects` route module enforces this with a single shared gate
(`checkBeadsRemote`, reused by both create and update so the invariant lives
in one place, not two copies that can drift): whenever a request supplies a
non-empty `beads.remote`, the gate runs `git ls-remote <remote>
refs/dolt/data` on the project's backlog member through the fleet
`executeCommand` client, and 400s the whole request on field
`beads.remote` if the probe fails (non-zero exit, an MCP-level error, or a
transport failure) -- before any row is written or updated. A request with
no remote (or, on update, one that hasn't actually changed) skips the probe
entirely: there is nothing to verify, and an unrelated field-only rename
should not trigger a network round trip. The route module never runs `git
remote add` or `git init` anywhere in its implementation; this is treated as
an invariant worth guarding with a dedicated test, not just documenting.

The probe currently interpolates the operator-supplied remote directly into
the shell command string run on the member. This is a known gap -- the
value should be validated/escaped before this module is ever mounted into a
running supervisor -- and is tracked as follow-up work, not yet closed.

## Route module shape

`registerProjectRoutes(supervisor, {store, client})` registers
`POST/GET/PUT/DELETE /api/projects[/:id]` against the supervisor's existing
`route()` table. It takes an already-open store handle (the shape
`openStore()` returns) and a fleet client exposing `executeCommand()` --
the same client shape `executeFleetCommand()` and the CLI's remote-probe
helper already use elsewhere in this package, so there is one accepted
shape for "run a command on a member and read whether it succeeded," not
several independently-parsed ones. `POST` validates the full create payload
and probes `beads.remote` (DQ-12) before writing; `PUT` diffs the patch
against the stored row and probes only when `beads.remote` is both present
and genuinely different from what's stored, 400ing before the update ever
touches the row; `GET`/`DELETE` 404 on an unknown id; a duplicate `POST`
409s.

## Current status

The route module exists and is fully tested against mocked
`store`/`client` collaborators, but it is not called from the supervisor's
boot path (`bin/serve.mjs`) yet -- mounting it, wiring the store's real
`openStore()` call into supervisor startup, and building the first UI
surface against it are later sprints' work. The route module's own
"already mounted" guard currently only scans this package's `src/supervisor/**`
tree for a stray registration call, not `bin/serve.mjs` itself, which is a
known gap to close before or alongside mounting.
