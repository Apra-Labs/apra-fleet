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

## Auth guard and console cookie

Every `/api/*` request and every non-`GET` `/ext/*` request is checked
against the shared fleet key (`~/.apra-fleet/fleet.key`,
`src/services/jwt.ts`) before route dispatch -- `handleConsoleRequest`
(`src/console/server.ts`) runs the check itself, ahead of the route lookup,
keyed on `API_NAMESPACES`/`isExtPath`, which are derived from
`ROUTE_MODULES`/`EXT_PREFIX` rather than a hand-maintained path list. A route
module appended later (per the seam above) is therefore guarded
automatically with no second list to keep in sync. `/health` and `/mcp` are
not console paths and never reach this guard; `GET /ui` and `GET /ext/*` stay
open (`/ui` is the shell itself; `GET /ext/*` matches a normal
reverse-proxy read path).

A caller authenticates with either the raw fleet key as a bearer token
(`Authorization: Bearer <fleet.key>`, unchanged for existing CLI/script
callers) or the `apra_console_token` cookie set on every `GET /ui`. The
cookie is **not** the raw fleet key -- the fleet key also signs member JWTs
(`jwt.ts`'s HS256 HMAC secret), so handing it to a browser as a cookie would
let anything that reads it mint arbitrary member JWTs. The cookie instead
carries `HMAC-SHA256(fleetKey, CONSOLE_COOKIE_LABEL)`, a value verifiable
server-side (recompute and compare) but not reversible into the signing key.
Both credential paths are checked against a path normalised through the same
`normalizePath()` helper the router uses, so the guard and the dispatcher can
never disagree about which route a URL names.

## The `/ext` reverse proxy and the per-package upstream credential

`/ext/<package id>/*` is a **proxy mount, not a route table**: no route
module declares it, and `handleConsoleRequest` dispatches it straight to
`src/console/proxy.ts` from a single branch, after the guard above. The
package id is resolved to a `baseUrl` through the registry service
(`src/services/workflow-packages.ts`), read fresh per request so a package
registered a moment ago is reachable immediately. An id that is not
registered answers **404**; a registered package whose upstream is
unreachable answers **502** with a package-offline body -- "does not exist"
and "exists but is down" are deliberately distinct answers.

Both directions stream via `pipe()`, so no body is ever held whole in
memory. `text/event-stream` responses are additionally passed through
unbuffered: `Accept-Encoding: identity` is sent upstream on every request
(compression must never be negotiated, because a compressor aggregates bytes
and destroys the per-event flush, and the content type is unknowable until
the response headers arrive -- by which point negotiation has already
happened), headers are flushed before the first event, and Nagle is disabled
so a short event is not held back. Upstream `Location` headers are rewritten
back under `/ext/<package id>`; a genuinely external origin is left
untouched rather than re-mounted, so the console never becomes an open
redirector.

**The raw fleet key is never forwarded upstream.** It is the HS256 signing
secret for member JWTs (see above), and workflow packages are third-party by
design and registered at runtime -- forwarding it would let any of them mint
member JWTs with an arbitrary `member_id`, `role` and `workspace_id`. What
is sent instead is a per-package derived credential,
`HMAC-SHA256(fleetKey, "<label>:<len(id)>:<id>")`, as an `Authorization`
bearer. It is not reversible into the signing key, and it differs per
package id, so one package cannot replay its credential against another.
The length prefix makes the label/id encoding unambiguous, which is what
actually guarantees that per-package property.

The label is deliberately **different** from `CONSOLE_COOKIE_LABEL`: same
primitive, same key, separate domain. Were they shared, a package could
replay the credential the console just handed it back at the console as a
valid `apra_console_token` cookie. For the same reason, the inbound `Cookie`
and `Authorization` headers (which carry the console's own credentials) are
stripped rather than relayed, and an upstream attempting to `Set-Cookie` the
console's own cookie name is refused -- all packages share the console
origin, so an unfiltered `Set-Cookie` would let one of them overwrite the
console credential in the browser.

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

## Known constraints (by design, this iteration)

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
