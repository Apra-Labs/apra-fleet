# fleet-sprint Supervisor HTTP API -- Operational Semantics

This is the companion to `packages/apra-fleet-se/docs/supervisor-openapi.yaml`
(exact method/path/schema/status-code contract). This document covers what
OpenAPI cannot capture precisely: ordering of checks, what a field actually
means operationally, and cross-endpoint relationships. For the deeper
architecture (reservation ledger design, watchdog classifier, multi-member
topology, journal/replay) see `docs/architecture.md`; this file only adds the
wire-level detail architecture.md deliberately leaves loose.

Source files: `src/supervisor/api.mjs`, `server.mjs`, `dashboard.mjs`,
`backlog.mjs`, `history.mjs`, `ledger.mjs`, `fleet-members.mjs`,
`dolt-mutex.mjs`, `id-allocator.mjs`, `proxy.mjs`, `reconcile.mjs`,
`history-view.mjs`, `log-view.mjs`, `self-log.mjs`, wired together in
`bin/serve.mjs`.

## POST /api/sprints: the full precondition order

`launch()` in `api.mjs` runs these checks strictly in order; any failure
short-circuits before anything downstream runs:

1. **Request-shape validation** (`validateLaunchRequest`) -- `issue` via
   `validateIssueId`, `branch`/`base` via `validateBranchName` (both
   imported from `fleet-sprint/runner.js` -- the SAME regexes the CLI and
   the engine itself re-check, single source of truth), `members`
   non-empty after normalization. Any failure -> `400` naming the field.
2. **apra-fleet-gey.2 relaunch gate** -- looks up
   `history.latestForIssueRoot(issue)`. If that prior incarnation's record
   is "deterministic" (see below) and the request did not pass
   `overrideRelaunchGate: true`, the launch is refused with `409` (field
   `issue`) BEFORE the member-overlap guard even runs. Rationale: a
   deterministic failure will almost certainly recur immediately on an
   identical relaunch, so it is not worth burning a spawn/reservation
   attempt to re-hit it.
3. **eft.5.2 member-overlap guard** (`defaultMemberOverlapGuard`) -- runs
   only if step 2 passed. Computes the full member UNION (the request's
   `members` PLUS every value in every `roleMap` role list, including the
   `orchestrator` pseudo-role) and rejects with `409` (field `members`) if
   that union intersects ANY other active reservation, from either of two
   sources merged into one conflict set:
   - this supervisor's own ledger (`ledger.list()`);
   - the fleet server's own per-member `reservedBy` record (via the same
     `listMembers` collaborator `GET /api/members` uses) -- catching a
     reservation made by some OTHER means (e.g. a workflow/cli-launched
     sprint that reserved directly via the fleet's `member_reservation`
     tool and never touched this ledger at all).
   This check runs strictly BEFORE `ledger.claim()`, so a rejected launch
   never touches the ledger -- byte-identical, no partial claim.
4. **`ledger.claim()`** -- atomically reserves both axes (member set AND
   issue-scope root) in one disk write, so they always claim/release
   together. The generated `sprintId` (`<issue>-<uuid>`) is minted BEFORE
   spawning so it can be forwarded into the child's own `--run-id` argv --
   the ledger reservation and the engine's own run-state agree on one
   identity for this launch, rather than the child falling back to reusing
   a relaunch-shared branch name.
5. **Spawn** -- `spawner.spawnSprint()`.

**Known gap (not enforced today): issue-scope overlap.** `docs/architecture.md`
documents an "Issue-scope overlap" guard (`src/supervisor/scope-overlap.mjs`,
`createScopeGuard`) as a second overlap axis alongside the member-overlap
guard. Reading the actual wiring in `bin/serve.mjs`, `createSprintController()`
is constructed WITHOUT a `beforeLaunch` override, so it falls back to
`defaultMemberOverlapGuard` alone -- `createScopeGuard` is exercised only by
unit tests (`test/supervisor-scope-overlap.test.mjs`,
`test/supervisor-reservation.test.mjs`), never composed into the live
`POST /api/sprints` path. In the current build, two sprints CAN be launched
against overlapping/nested issue scopes as long as their member sets don't
overlap -- only the member axis is actually guarded at launch time. `expandScope()`
from the same module IS used live, but only for rendering (the Backlog
tree's partial-claim overlay in `backlog.mjs`), not as a launch-time reject.
This looked like a real contract inconsistency worth a bead -- flagged, not fixed.

## "Deterministic terminal reason" (the gey.2 gate's trigger)

A history record counts as deterministic (`isDeterministicTerminalReason()`
in `history.mjs`) iff either:
- its `event` is `launch-failed` (the child exited within the launch-failed
  window with no dispatch ever happening), OR
- its `terminalReason === 'BEADS_SYNC_CONFLICT'` (currently the only member
  of `DETERMINISTIC_TERMINAL_REASONS`).

Everything else (a normal `finished` with any other `terminalReason`, an
`aborted-by-restart`, a `force-released`, etc) is NOT deterministic and does
not trip the gate -- a relaunch of that issue root proceeds normally without
needing `overrideRelaunchGate`.

## "Terminal" in this codebase

A sprint's reservation lifecycle "ends" (as opposed to actively running --
`RUNNING_HEALTHY`/`RUNNING_UNRESPONSIVE` watchdog states) via one of these
history events: `finished` (the engine itself reached an exit condition and
persisted `terminalReason`/`verdict`), `launch-failed` (child exited before
ever dispatching), `child-exited` (raw process-exit observation, may or may
not later resolve to `finished`), `aborted-by-restart` (supervisor restart
found the child dead), `force-released` (an operator manually tore down the
reservation via `POST /api/reservations/:id/force-release`), or
`auto-released`. Only `finished` and `launch-failed` carry a meaningful
`terminalReason`/`verdict` -- the others are release bookkeeping, not a
verdict on the sprint's outcome.

## Ledger vs. history: two different questions

- **The ledger** (`ledger.mjs`) answers "who holds a reservation RIGHT
  NOW" -- it is deliberately NOT an audit log; a released entry is gone
  from `ledger.list()`/`ledger.get()` entirely, with no trace.
- **History** (`history.mjs`, `sprint-history.json`) is the durable,
  append-only audit log the ledger deliberately does not keep. Every
  release (of any kind) and every observed terminal state is recorded here,
  keyed by `sprintId` and (for the relaunch gate) queryable by issue root
  via `latestForIssueRoot()`.

`GET /api/sprints/:id` reflects this split directly: if the ledger still
holds a reservation AND the child's port resolves, you get `live: true` plus
the child's proxied `/state`. Otherwise you get `live: false` plus the
historical record (`history.forSprint(id)` for the full list, `latest` for
the most recent event) -- and a `404` only if NEITHER a ledger entry NOR any
history exists for that id at all.

## GET /api/members: reservation source precedence

Each member's `reserved`/`reservedBy` overlay resolves in this order: the
LOCAL ledger wins if it has a reservation naming that member (scanned via
`ledger.list()`, first-writer-wins if somehow duplicated); otherwise falls
back to whatever `reservedBy` the raw fleet member object already carries
(the fleet server's own record, e.g. set by a workflow that reserved via
`member_reservation` directly, bypassing this ledger entirely). A member
reserved by neither source reports `reserved: false, reservedBy: null`.

## scopeFreshness: what it does and does not guarantee

`GET /api/backlog` and `GET /api/sprints` both include `scopeFreshness:
{lastSyncedAt, ageSeconds}`. This is advisory, not authoritative: both
overlap-detection layers reason over the supervisor's OWN local `bd` state,
which is not guaranteed to have just been refreshed from a remote/other
member's writes. `lastSyncedAt` is `null` and `ageSeconds` is the literal
string `'never-synced'` until `ledger.setScopeFreshness()` is called after a
successful sync/pull -- the field is never silently absent, so a dashboard
can render "last synced N minutes ago" (or "never synced") instead of
presenting overlap checks as ground truth. See `docs/architecture.md`
"Known best-effort limitation -- scope freshness" for the full rationale.

## POST /api/sprints/:id/stop vs POST /api/reservations/:id/force-release

These are two different operator actions, easy to confuse:

- **`POST /api/sprints/:id/stop`** is COOPERATIVE: it proxies to the still-
  live child's own `/stop` endpoint and asks it to wind down gracefully. It
  requires the reservation to still resolve to a reachable port (`409` if
  not); it does NOT release the ledger reservation itself -- that happens
  later, normally, once the child actually exits and the watchdog/spawner
  observe it.
- **`POST /api/reservations/:sprintId/force-release`** is UNCONDITIONAL: it
  releases both ledger axes immediately regardless of whether the child is
  still alive, and (apra-fleet-3i3.1) best-effort SIGKILLs the child if a
  pid was recorded. Use this to recover a wedged reservation whose child is
  unresponsive to the cooperative stop, or already gone but never observed
  as released. It records a `force-released` history event and echoes back
  enough of the original launch (`branch`, `base`, `goal`, `childPid`,
  whether the kill landed) that a dashboard "Restart" control can replay the
  same `POST /api/sprints` request without a separate lookup.
- Force-release **only touches this supervisor's own local ledger** -- it
  does not reach into a different tracking mechanism the fleet server might
  have (that's the same server-side `reservedBy` record `GET /api/members`
  and the member-overlap guard already consult independently) -- so if a
  reservation is wedged on BOTH axes independently, check both.

## Dolt-push mutex and child-id allocator: why they exist, and why no 409s

Both `dolt-mutex.mjs` and `id-allocator.mjs` exist because `bd`'s embedded
Dolt mode wedges on row-level conflicts if two sprints write concurrently:

- **Dolt-push mutex** serializes every cross-sprint `bd dolt push` through
  one FIFO queue. Deliberately implemented as a **long-poll**, not an
  accept/reject: `POST .../acquire` does not respond until the caller
  actually holds the mutex. There is no 409 anywhere in this surface --
  contention is resolved by waiting in the queue, and `release`/`renew`
  return a boolean (`released`/`renewed`) rather than erroring on a stale
  token, so a late call from an already-reclaimed holder is a silent no-op,
  never a 4xx. A background sweep (default every 5s) reclaims a grant whose
  lease expired (default 60s) or whose recorded pid died, handing it to the
  next waiter automatically -- a crashed holder can never wedge the queue
  forever.
- **Child-id allocator** mints the next child bead id under a shared parent
  (`<parentId>.<n>`) so two concurrent sprints decomposing the same parent
  never derive the same id. Same lease/reclaim/sweep design as the mutex.
  It is explicitly two-phase: `allocate()` only RESERVES a seq; the caller
  must actually create the bead (`bd create --id <childId>` then
  `bd update <childId> --parent <parentId>` -- two calls, because `bd`
  rejects `--id` and `--parent` together) and then call `confirm()` on
  success or `release()` on failure. An abandoned reservation (crash before
  confirm/release) is reclaimed back to the free pool the same way as the
  mutex.

Both are supervisor-local, in-memory-plus-persisted-snapshot singletons
(state files under the supervisor's data dir, atomic temp-file+rename
writes) -- there is exactly one of each per running supervisor process, and
every sprint child talks to them over the SAME supervisor HTTP port their
spawner injected as `FLEET_SE_SERVICE_URL`, not a side channel.

## Live-view proxy (`/sprints/:id/live*`) vs. history view (`/sprints/:id/history`) vs. log (`/sprints/:id/log`)

Three different "look at sprint :id" surfaces that are easy to conflate:

- **`/sprints/:id/live` (+ `/live/events`, `/live/state`, `/live/stop`,
  `/live/save_logs`, `/live/extensions/...`, `/live/activities/...`)** is a
  REVERSE PROXY to the still-running child's own `--viewer-port` HTTP
  server -- it only works while the child is alive and its port is known.
  The base route (`/sprints/:id/live` with no suffix) is the one exception:
  it transparently falls through to the SAME renderer `/sprints/:id/history`
  uses once the sprint has no live port, so a single URL keeps working
  across the live-to-finished transition. Every OTHER `/live/*` subpath
  404s once the sprint stops being live (there is no historical fallback
  for `/live/events`, `/live/state`, etc -- only the base HTML route falls
  through).
- **`/sprints/:id/history`** always renders the persisted terminal state
  (`old_runs/<id>.json`, or the legacy `old_sprints/<id>.json`) through the
  identical HTML template the live viewer uses, frozen (no `/state`/`/events`
  polling wired client-side, Save/Stop controls hidden). This is the
  dedicated, always-reachable link regardless of live/not-live status.
- **`/sprints/:id/log`** and **`/supervisor/log`** are unrelated to the
  viewer template entirely -- they serve the RAW stdout/stderr text file the
  spawner tees a child process's output to (or, for `/supervisor/log`, the
  supervisor's own tee). This is the surface that still works when a sprint
  crashed hard enough that neither the live proxy nor a persisted
  `old_runs/*.json` exists. Both support `?tail=<N>` to return only the last
  N lines.

All three `:id`-keyed routes (`history-view.mjs`, `log-view.mjs`, and the
history-fallthrough in `proxy.mjs`) validate `id` with `isSafeSprintId()`
(non-empty, no `.`/`..`, no `/`/`\`) before ever touching the filesystem, and
`log-view.mjs` additionally never builds a path FROM `:id` directly -- it
only uses it as a lookup key into the ledger's/history's already-recorded
`logPath`, so a traversal payload in `:id` can at most fail to match (400
from the safety check, or 404 from no match), never escape the log
directory.

## Status-code summary (cross-endpoint)

- **400** -- always paired with a `field` name (for `POST /api/sprints`) or
  a plain `error` message (missing path param, invalid JSON body, missing
  token). Used across nearly every JSON POST route.
- **404** -- "no such live/known thing": unknown sprint id (`GET
  /api/sprints/:id`, `POST /api/sprints/:id/stop`, force-release), no live
  port and no history (`/sprints/:id/live` subpaths), no persisted state
  (`/sprints/:id/history`), no recorded/on-disk log
  (`/sprints/:id/log`, `/supervisor/log`).
- **409** -- used ONLY by `POST /api/sprints` (relaunch gate, member-overlap
  guard) and `POST /api/sprints/:id/stop` (reservation exists but no
  reachable child port). The dolt-mutex and id-allocator surfaces
  deliberately never use 409 -- see above.
- **500** -- generic unhandled-error isolation (`server.mjs`'s dispatcher
  never lets a handler exception escape uncaught) plus a couple of named
  500s (`GET /api/backlog/tasks` build failure, log read errors other than
  ENOENT).
- **502** -- reverse-proxy-specific (`/sprints/:id/live*`): the child was
  supposed to be reachable (port resolved) but the actual upstream
  connect/response failed.
- **503** -- dolt-mutex acquire and id-allocator allocate failures (e.g. the
  seam shutting down) -- distinct from 500 to signal "try again", not "this
  request is wrong".
