# Console Server (`/ui` and `/api/fleet/*`)

## What it is

Alongside the MCP transport (`/mcp`) and the workflow HTTP surface, the fleet
server exposes a small web console: a React/Vite single-page app served at
`/ui`, backed by a `/api/fleet/*` JSON API. The first shipped screen is a
members table reading the live fleet registry. This is an orchestrator-local
convenience surface, not a replacement for the MCP tool interface -- every
data path it exposes calls the same in-process tool handlers an MCP client
would call.

## Why a seam, not an inline route

Earlier iterations added `/ui` serving directly inside the HTTP transport
file that also owns `/mcp` request routing. That coupling does not scale:
every future console feature (secrets page, health page, workflow-package
proxy, auth) would mean editing the same shared file, which is exactly the
kind of shared-file contention that turns a multi-track sprint plan into a
merge-conflict generator.

The fix is a dedicated seam:

- `src/console/server.ts` exports `handleConsoleRequest(req, res):
  Promise<boolean>`. It returns `true` if it handled the request, `false`
  otherwise.
- `src/services/http-transport.ts` calls `handleConsoleRequest` in exactly
  one place, before the `/mcp` 404 guard. If it returns `false`, transport
  code falls through to existing `/mcp` handling unchanged.
- `server.ts` dispatches to route modules via an **explicit, hand-maintained
  import list** (`ROUTE_MODULES`), not a directory glob. A glob would break
  inside the single-executable-application (SEA) binary, where the
  filesystem the running process sees is a virtual asset store, not a real
  directory tree that can be listed. Every new console route is one line
  added to that list plus a new file under `src/console/routes/` -- later
  sprints add files, they don't edit `server.ts`'s routing logic itself
  (only its import list).

This means the ownership boundary for `src/console/` is per-file: one file
owns route registration, one owns each route's business logic, one owns
static asset serving. A track working on a new page adds a new route module
and touches the shared `server.ts` only to append one import -- a
low-collision edit compared to interleaving logic in a shared handler body.

## Request flow

- `src/console/server.ts` -- route dispatch (the seam described above).
- `src/console/routes/*.ts` -- one file per logical route group (e.g.
  `routes/fleet.ts` for `/api/fleet/*`). A route module maps HTTP verbs/paths
  to handler functions; it does not talk to tool internals directly.
- `src/console/local-api.ts` -- the in-process facade route handlers call
  into. It invokes the same tool handler functions the MCP transport calls
  (e.g. `list_members`'s handler) directly, in-process, with no HTTP
  self-call. This keeps the console's view of fleet state identical to what
  an MCP client would see, without adding a network hop or a second
  serialization boundary to keep in sync.
- `src/console/static.ts` -- serves the built shell's static assets and
  index-fallback routing for client-side routes.

## Static asset serving: dev disk vs. packaged binary

The shell is a normal Vite build (`packages/apra-fleet-shell-ui`, base path
`/ui/`) producing a `dist/` directory. `static.ts` resolves that directory
two different ways depending on how the server is running:

- **Dev checkout / npm install**: reads files directly from
  `packages/apra-fleet-shell-ui/dist` on disk, resolved relative to the
  package root (works whether the module was loaded from `src/` under
  `tsc`/ESM or from a built `dist/`).
- **SEA binary**: falls back to reading assets out of the SEA asset store
  under a `ui/` namespace, since a single-executable binary has no real
  filesystem tree to read `packages/.../dist` from.

Path resolution runs a traversal guard **before** any filesystem or asset
lookup -- rejecting `../` (raw and percent-encoded), Windows drive-letter
paths (`C:\...`), and UNC/`//server` paths -- so a malformed `/ui/<path>`
request can never escape the shell's asset root regardless of which backing
store answers it. Requests split into two classes: a path matching a real
built asset (e.g. `/ui/assets/<hash>.js`) 404s if that exact asset is
missing; anything else under `/ui/*` (an unknown client-side route) falls
back to `index.html`, matching standard SPA router behavior.

## Shell pages: Members, Secrets, Health

Beyond the minimal members-listing page, the console shell ships three full
screens against the `/api/fleet/*` route set:

- **Members (S1)**: a table (name, OS, shell, provider, auth state, tags,
  reserved-by, owner) that background-refreshes on an interval without
  flashing back to a loading state, a row-click drawer with member actions
  (provision LLM auth, provision/revoke VCS auth, setup SSH key, compose
  permissions, update LLM CLI, remove), and an add-member wizard for local and
  SSH-remote members.
- **Secrets (S2)**: list, add (opens the out-of-band credential URL in a new
  tab rather than collecting the secret value in-page -- DQ-7), update
  policy/members/expiry, delete, and GitHub App setup. No secret value ever
  appears in a request body or is rendered in the DOM; tests assert this
  directly against captured request bodies, not just the visible UI.
- **Health (S3)**: fleet status, version, data directory, update-available
  state, and a workflow-packages list that reads `GET /api/workflow-packages`
  tolerantly (both a 404 and a network failure render the same "none
  registered" empty state rather than an error).

All three pages are built on shared primitives in a separate `@apralabs/apra-fleet-ui-kit`
workspace package (`Table`, `Drawer`, `Form`, `Wizard`, `Page`, plus a shared
token/style layer) rather than one-off components per page, so future console
screens compose from the same primitives instead of re-deriving table/drawer/
wizard behavior.

### Client/server type drift is a standing risk at this seam, not a one-off bug

The shell's `/api/fleet/*` client types (`packages/apra-fleet-shell-ui/src/api/*.ts`)
are hand-maintained TypeScript interfaces describing the JSON the server's
route handlers emit; they are not generated from `src/types.ts` and nothing
fails the build when they diverge. A field that changes shape on the server
side (e.g. a member field going from a plain string to a structured object)
silently produces stale client typings that still compile and still pass
UI tests, because the UI test fixtures are themselves hand-written and can
encode the same stale shape the production payload no longer has. The
failure only surfaces at runtime, as a React "objects are not valid as a
React child" crash with no error boundary to contain it -- the whole screen
unmounts.

This is a structural gap, not a single fixed bug: any future field-shape
change to a member (or secret, or health) record made on the server side of
this seam needs either a generated/shared type, or an explicit drift guard
that asserts the client type against a real server payload shape (not a
hand-written fixture), plus an error boundary around each page so a
render-time exception degrades to a visible error message instead of a blank
screen. Treat "the client type still compiles" as no evidence of shape
agreement across this boundary.

### Drawer detail actions must actually call their detail route

A drawer or page that exposes a "detail" action (e.g. reading richer
per-member data than the list view already has) needs to actually invoke
that route from the UI and be exercised by a UI-level test -- a route with
its own passing route-level test does not, by itself, demonstrate the UI
uses it. It is possible to satisfy every route test while the corresponding
screen quietly renders off data it already has cached, leaving the detail
route wired but unreachable from the shell.

## Known constraints (by design, this iteration)

- **No auth guard on the console routes yet.** `handleConsoleRequest` is
  wired ahead of `/mcp`'s auth-checked path with no bearer/cookie check of
  its own. This is acceptable only because the server's default bind is
  loopback-only; the moment non-loopback binding is in play, the console
  routes (including the full member registry via `/api/fleet/members`)
  are reachable to anything that can route to the port. A future iteration
  must add a guard (session cookie or the same bearer scheme `/mcp` uses)
  before non-loopback binding and the console feature set can coexist
  safely.
- **Packaging is dev-checkout-complete, distribution-incomplete.** The
  console seam and static-serving logic support both the disk path and the
  SEA-asset path, but as of this writing neither the SEA manifest generator
  nor the npm package's shipped file list actually includes the built shell
  assets -- so `GET /ui` only answers 200 from a source checkout with the
  shell built locally. Making the SEA binary and the installed npm package
  both serve `/ui` requires wiring the shell's `dist/` into each
  distribution channel's asset manifest; the serving code on the receiving
  end is already in place and does not need to change.

## Fitting into the layering model

The console seam follows the same "each layer depends only on layers below
it" discipline as the rest of the codebase (see `docs/architecture.md`):
route modules depend on `local-api.ts`, which depends on the same tool
handlers services already expose -- never the reverse, and never a route
module reaching into another route module's internals.
