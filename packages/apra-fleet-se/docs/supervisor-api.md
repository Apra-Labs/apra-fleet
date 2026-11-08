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

## Mutating requests: JSON content type and same origin (or token)

Every non-GET/HEAD/OPTIONS supervisor route -- `POST /api/sprints`,
`/api/sprints/:id/decisions/:decisionId`, `/api/sprints/:id/stop`,
`/api/shutdown`, `/api/reservations/:sprintId/force-release`, the
`/api/dolt-push-mutex/*` and `/api/child-id-allocator/*` routes, and the
`/sprints/:id/live/{stop,pause,resume,save_logs}` and
`/sprints/:id/live/extensions/:extId/actions/:actionId` proxy actions -- is
checked by the single dispatcher in `server.mjs` (helper:
`packages/apra-fleet-workflow/src/viewer/request-guard.mjs`) BEFORE any
handler runs. A request is admitted only when:

1. its `Content-Type` is `application/json` (parameters such as
   `; charset=utf-8` are fine). Anything else -- an HTML form's
   `application/x-www-form-urlencoded` or `multipart/form-data`, `text/plain`,
   or no content type at all -- is `415` with a JSON `error`, even with an
   empty body (send `-H "Content-Type: application/json"` with curl);
2. it is same-origin: no `Origin` header (curl, the sprint child's HTTP
   clients, server-side callers), or an `Origin` whose host:port equals the
   request's `Host`. A different `Origin` (including `null`), or a
   `Sec-Fetch-Site` of `cross-site` or `same-site`, is `403` -- UNLESS the
   request carries a valid token.

Token: set `FLEET_SUPERVISOR_TOKEN` in the supervisor's environment (or pass
`apiToken` to `createSupervisor()`), then send `Authorization: Bearer <token>`
or `X-Fleet-Token: <token>`. A matching token admits a cross-origin JSON
request; a presented token that does not match is always `403`, whatever the
origin. With no token configured, only same-origin requests pass. The
dashboard's own buttons and forms send JSON from the supervisor's own origin,
so they need no token.

Host header (DNS-rebinding defence, EVERY request, GET included): checked
before anything else. An attacker page whose name is re-resolved to
127.0.0.1 controls both `Origin` and `Host`, so the origin comparison above
would admit it. The supervisor therefore answers only a `Host` whose name is a
loopback name (`localhost`, `127.0.0.1`, `[::1]`), any IP literal (a page
served from an IP literal cannot rebind), its own `--host` (unless a wildcard
such as `0.0.0.0`), or a name listed with `--allowed-host <name>` (repeatable
or comma-separated) / `FLEET_SUPERVISOR_ALLOWED_HOSTS`. Any other name is
`403` with a JSON `error`, whatever the method, origin or token. The port in
`Host` is not compared (a port-forward or reverse proxy may change it; a
rebinding attacker cannot choose the name). Off-box binds reached by a DNS
name must list that name; reaching them by IP needs no configuration.

The per-sprint child viewer (the `--viewer-port` server the live proxy
forwards to) applies the same guard (no token mechanism; same Host check on every request,
extra names via `createDashboardViewer({ allowedHosts })`) to its own POST routes
(`/stop`, `/pause`, `/resume`, `/save_logs`, `/extensions/:id/actions/:id`),
since it is reachable directly on loopback and is the endpoint the decision
answer ultimately reaches. The live proxy strips the browser's `Origin`,
`Referer`, `Sec-Fetch-*` and token headers when forwarding an admitted request,
so the child sees it as a same-host, Origin-less call.

## POST /api/sprints: the full precondition order

`launch()` in `api.mjs` runs these checks strictly in order; any failure
short-circuits before anything downstream runs:

1. **Request-shape validation** (`validateLaunchRequest`) -- `issue` is
   comma-split by `splitIssueIds()` (trim, drop empties) and then EACH id is
   validated with `validateIssueId`; `branch`/`base` via `validateBranchName`
   (both imported from `fleet-sprint/runner.js` -- the SAME regexes the CLI
   and the engine itself re-check, single source of truth), and the pair via
   `validateBranchPair` (`fleet-sprint/sprint-args.mjs`: `branch` equal to
   `base`, ignoring case and `refs/heads/`/`origin/`/`refs/remotes/origin/`
   prefixes, -> `400`, field `branch`); `members` (a
   string array or a comma-separated string) non-empty after normalization.
   Optional `phases` is validated too: only `{ "regression": "run" | "skip" }`
   is accepted (anything else -> `400`, field `phases`); `"skip"` forwards
   `--skip-regression` to the child.
   Optional `roleMap` (object or JSON string) is resolved too. The
   `roleMap.orchestrator` key is a DEPRECATED alias of `roleMap.backlog`:
   using it still works, and the response carries a top-level
   `warnings: string[]` (empty `[]` when no alias was used; one deprecation
   message per alias use otherwise). The operator's original map (alias
   intact) is forwarded to the child, so its run log warns too. A `roleMap`
   holding BOTH keys with different members, any `roleMap` that fails to
   resolve (bad JSON, bad shape), and a string `'@file'` reference (a
   CLI-only form; never read from a request body) are all `400`, field
   `roleMap`.
   Any failure -> `400` naming the field. Note the split has to happen first:
   `ISSUE_ID_PATTERN` has no comma in its charset, so an un-split `"a,b"`
   would be rejected.
1a. **Backlog hard pin** (only when `bin/serve.mjs` wired its backlog-member
   handle -- `src/supervisor/backlog-member.mjs`; a controller built without
   it keeps the unpinned behaviour). Every sprint a supervisor launches uses
   THAT supervisor's own backlog member (the LLM-less, unreservable member
   it ensures at startup for its project folder):
   - backlog member degraded (fleet unreachable at startup, no `.beads`
     found, ...) -> `503`, `error` = `this supervisor's backlog member is not
     ready: <reason>`, nothing spawned;
   - fleet member list unreadable at launch time -> `503`, `error` contains
     `cannot verify backlog member`, nothing spawned (the check is never
     skipped silently);
   - `roleMap` absent, or without a `backlog` (or deprecated `orchestrator`)
     key -> `backlog: [<supervisor member>]` is INJECTED into the role map
     the child receives (other roles untouched);
   - `roleMap.backlog` (or the alias) naming the supervisor member ->
     accepted (the alias still produces its deprecation warning);
   - naming any other member -> `400`, field `roleMap`, naming the
     supervisor's backlog member.
   The pinned member is `unreservable`, so it never enters the reserved
   member union (step 3).
2. **Relaunch gate** -- looks up
   `history.latestForIssueRoot(issue)`. If that prior incarnation's record
   is "deterministic" (see below) and the request did not pass
   `overrideRelaunchGate: true`, the launch is refused with `409` (field
   `issue`) BEFORE the member-overlap guard even runs. Rationale: a
   deterministic failure will almost certainly recur immediately on an
   identical relaunch, so it is not worth burning a spawn/reservation
   attempt to re-hit it.
3. **Member-overlap guard** (`defaultMemberOverlapGuard`) -- runs
   only if step 2 passed. Computes the full member UNION (the request's
   `members` PLUS every value in every `roleMap` role list, including the
   `backlog` pseudo-role) and rejects with `409` (field `members`) if
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
4. **Issue-scope overlap guard** (`createScopeGuard().checkLaunch()` in
   `src/supervisor/scope-overlap.mjs`) -- the second overlap axis, over the
   same ledger. It runs only if the member axis passed: `bin/serve.mjs`'s
   `composeBeforeLaunch({ memberOverlapGuard, scopeGuard })` is what the live
   `createSprintController()` is given as its `beforeLaunch`, and it awaits
   the member guard first, then `scopeGuard.checkLaunch(issueRoots)`. A
   conflict throws the same `ApiError(409, ...)` shape as the member guard,
   with field `issue` and a `formatScopeConflict()` message naming the
   conflicting sprint(s) and the overlapping bead ids. Either axis failing
   rejects the whole launch; a launch overlapping on neither succeeds.
   (`expandScope()` from the same module is also used live for rendering --
   the Backlog tree's partial-claim overlay in `backlog.mjs`.)
   `checkLaunch()` costs ONE bulk `bd list --all --limit 0 --json` and an
   in-memory tree walk, regardless of how many nodes the request's scope has
   or how many sprints are active -- it used to be one `bd list --parent`
   subprocess per node, awaited sequentially and repeated per active sprint,
   which is why a large epic could stall this endpoint for minutes before it
   answered. The `--all` is required for correctness, not speed: without it a
   closed intermediate parent hides its open subtree from the overlap check.
5. **`ledger.claim()`** -- atomically reserves both axes (member set AND
   issue-scope root) in one disk write, so they always claim/release
   together. The generated `sprintId` (`<issue>-<uuid>`) is minted BEFORE
   spawning so it can be forwarded into the child's own `--run-id` argv --
   the ledger reservation and the engine's own run-state agree on one
   identity for this launch, rather than the child falling back to reusing
   a relaunch-shared branch name.
6. **Spawn** -- `spawner.spawnSprint()`.

Both overlap guards (steps 3 and 4) run strictly before `ledger.claim()`, so
a launch rejected on either axis leaves the ledger completely untouched.

## "Deterministic terminal reason" (the relaunch gate's trigger)

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
  still alive, and best-effort SIGKILLs the child if a pid was recorded. Use
  this to recover a wedged reservation whose child is
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
  accept/reject: `POST .../acquire` sends 200 headers at once and heartbeat
  whitespace every 30s (so a client's fetch timeouts cannot end the wait or
  cost the queue place), and its JSON body completes only when the caller
  actually holds the mutex, or with `{ error }` if the wait failed. There is
  no 409 anywhere in this surface --
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

## POST /api/sprints: `decisionNotify` (optional)

Same JSON shape as the CLI's `--decision-notify`: `{message_member, email:
{provider, from, to, host, port, user, secure}, dashboard_url, timeout_s}`
(an object, or the same thing as a JSON string). It is validated with
`validateDecisionNotify` (`fleet-sprint/decision-notify.mjs`) before any
spawn; an invalid value (bad JSON, unknown key, bad email block) is a `400`
with field `decisionNotify`. A valid value is forwarded to the child as
`--decision-notify <json>`. Credentials never go in the body (unknown keys are
rejected); the fleet credential store holds them. When omitted, the child
falls back to the `FLEET_SPRINT_DECISION_NOTIFY` environment variable it
inherits from the supervisor. Without `message_member` the message goes to the
default target `orchestrator`, the operator's channel-capable orchestrating
session registered on the fleet server; a channel with no target (no email
block, or no fleet client) is logged once at launch and recorded `failed` per
decision without a repeated warning. See
`docs/fleet-sprint-set-aside.md`.

## GET /api/sprints/:id: `resultStatus` and `warnings` (finished sprints)

A finished sprint's own result status and warnings are lifted to the top level
of the response, on both read paths: while the ledger reservation is still
held (from the persisted terminal state's `result`), and after the watchdog
has released it (from the durable `finished` history event, which carries
`resultStatus` and `warnings`). `resultStatus` is `success` or
`success-with-warnings`; the latter is returned when the branch was pushed but
the PR was not opened for a VCS auth failure, and `warnings` then holds the
reason (e.g. `PR not opened: VCS auth failure ... auth-failure`). The verdict
is unchanged (a PASS stays PASS) and `success-with-warnings` is a success, not
a failure. `warnings` is omitted when empty. Terminal sprints are not listed
by `GET /api/sprints` (live only); read them by id.

## Pending decisions

A sprint that is waiting on an operator decision (see
`docs/fleet-sprint-set-aside.md`) surfaces it as follows.

- `GET /api/sprints/:id` (live sprints) gains `pendingDecisions` (the
  child's pending-decision list), `decisionState` (the decisions extension
  state string, when present) and `runState` (set to
  `paused-awaiting-decision` while the run is paused on a decision).
- `POST /api/sprints/:id/decisions/:decisionId`, body `{answer}` (a non-empty
  string, length-capped), proxies the answer to the child's decisions
  extension. Response `{sprintId, decisionId, status: "answered", released}`.
  `400` (field `body` or `answer`): body not an object, or `answer` missing,
  empty or too long (also a child-side rejection of the answer). `404`: unknown
  sprint, or no pending decision with that id. `409`: the sprint has no
  reachable child, or the child answered with an unexpected failure.
- `POST /sprints/:id/live/extensions/:extId/actions/:actionId` is the generic
  proxy route to the child's extension action endpoint (the dashboard uses it
  for the decisions `answer` action).

## Live-view proxy (`/sprints/:id/live*`) vs. history view (`/sprints/:id/history`) vs. log (`/sprints/:id/log`)

Three different "look at sprint :id" surfaces that are easy to conflate:

- **`/sprints/:id/live` (+ `/live/events`, `/live/state`, `/live/stop`,
  `/live/pause`, `/live/resume`, `/live/save_logs`, `/live/extensions/...`,
  `/live/activities/...`)** is a
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

## GET /api/health: `beads` (which tracker this supervisor runs against)

The supervisor runs `bd` itself (backlog listing, launch-time scope-overlap
checks) from its own working directory, so bd's walk-up discovery decides
which `.beads` those reads hit -- and every sprint child inherits that
choice. `bin/serve.mjs` therefore resolves it ONCE at startup (walk up from
cwd, or from `--beads-dir`), probes `bd where --json`, `bd config get
sync.remote --json` and `git remote get-url origin` in that project root,
and reports:

```json
"beads": { "dir": "<.beads path as bd resolved it>", "prefix": "<bead id prefix>",
           "syncRemote": "<sync.remote or empty>", "repoRemote": "<git origin URL or empty>" }
```

`beads` is `null` when no identity was wired (a bare `createSupervisor()`,
tests) AND when the identity is unknown: no `.beads` was reachable from the
supervisor's cwd, or its probe failed. In the latter case `beadsWarning`
carries the reason and the fix, e.g.:

```json
"beads": null,
"beadsWarning": "no beads database found walking up from /some/dir. Backlog and scope-overlap checks are disabled and sprints will verify against the backlog member's beads instead. To fix: restart fleet-se from inside the project folder, or pass --beads-dir <project-or-.beads-path>, then GET /api/health?refresh=1."
```

(a nonexistent `--beads-dir` is still a startup error, not a warning).
`?refresh=1` re-runs the probes first; if that re-probe fails the last good
identity is still returned and `beadsRefreshError` carries the message --
the liveness answer itself never fails on it. While the identity is
unknown, a successful `?refresh=1` recovers it (and drops `beadsWarning`);
a failed one updates `beadsWarning` to the current probe error. The same
four fields are recorded as `beads` on each launched sprint's ledger entry
(`null` while unknown) and the engine receives them as `--expect-beads`
(omitted while unknown; the engine then verifies members against the
backlog member's own identity), so a member whose own `bd where`
disagrees is refused rather than dispatched at the wrong tracker. `dir` is
display-only: it is a path on the supervisor's host.

## GET /api/health: `backlogMember`

When `bin/serve.mjs` wired its backlog-member handle, health also reports

```json
"backlogMember": { "status": "ready" | "degraded", "name": "<member name or null>", "reason": "<why degraded, or null>" }
```

At startup the supervisor adopts a local LLM-less member whose work folder
is its project folder (adding the `backlog` tag and `unreservable` when
missing), or registers one named `backlog-<camelCaseFolderName>` -- also
when an LLM member already uses that folder (the registry allows one LLM and
one LLM-less member per folder; the LLM member is left alone and logged). It
REFUSES to start (exit 1) when the derived name is taken by a member for
another folder. Fleet unreachable is not fatal: status is `degraded`, launches
answer `503`, and a background retry flips it to `ready`.

## Status-code summary (cross-endpoint)

- **400** -- always paired with a `field` name (for `POST /api/sprints`) or
  a plain `error` message (missing path param, invalid JSON body, missing
  token). Used across nearly every JSON POST route.
- **403** -- a mutating request refused as cross-site (foreign `Origin` or
  `Sec-Fetch-Site`) without a valid token, or carrying an invalid token (see
  "Mutating requests" above), or any request whose `Host` header names a host
  the supervisor does not answer to (DNS-rebinding defence).
- **415** -- a mutating request without `Content-Type: application/json`.
- **404** -- "no such live/known thing": unknown sprint id (`GET
  /api/sprints/:id`, `POST /api/sprints/:id/stop`, force-release), no live
  port and no history (`/sprints/:id/live` subpaths), no persisted state
  (`/sprints/:id/history`), no recorded/on-disk log
  (`/sprints/:id/log`, `/supervisor/log`).
- **409** -- used by `POST /api/sprints` (relaunch gate and member-overlap
  guard, both field `issue`/`members`; plus the issue-scope overlap guard,
  field `issue`), `POST /api/sprints/:id/stop` (reservation exists but no
  reachable child port) and `POST /api/sprints/:id/decisions/:decisionId`
  (no reachable child, or the child refused the answer). The dolt-mutex and id-allocator surfaces
  deliberately never use 409 -- see above.
- **500** -- generic unhandled-error isolation (`server.mjs`'s dispatcher
  never lets a handler exception escape uncaught) plus a couple of named
  500s (`GET /api/backlog/tasks` build failure, log read errors other than
  ENOENT).
- **502** -- reverse-proxy-specific (`/sprints/:id/live*`): the child was
  supposed to be reachable (port resolved) but the actual upstream
  connect/response failed.
- **503** -- `POST /api/sprints` while the supervisor's backlog member is
  degraded or the fleet member list cannot be read (see step 1a), plus
  id-allocator allocate failures (e.g. the seam shutting down) -- distinct
  from 500 to signal "try again", not "this request is wrong". A dolt-mutex
  acquire failure (e.g. an invalid pid) is `{ error }` in the 200 body, since
  headers already went out; a supervisor shutdown drops the connection instead.
