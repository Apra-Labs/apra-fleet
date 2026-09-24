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
open, and neither ever answers 401 (`/ui` is the shell itself; `GET /ext/*`
matches a normal reverse-proxy read path). `GET /ext/*` staying open does
**not** mean it is unconditionally credentialed toward the upstream package,
though -- see "GET `/ext/*` and the unauthenticated-credential decision"
below.

`handleConsoleRequest` is also **total**: once it has recognised a request as
a console path, it never lets a throw escape as an unhandled rejection.
Everything from the guard check above through the `/ui` branch, the `/ext`
proxy dispatch and `matchRoutes` is covered by one outer `try`/`catch` (in
addition to the route-handler's own, pre-existing catch) that answers 500
(carrying the error message) when headers are not yet sent, or ends the
response otherwise -- never rethrows. This matters because
`src/services/http-transport.ts` awaits `handleConsoleRequest` from inside an
async request listener with nothing else guarding it: before this guarantee,
a throw anywhere in that region (the recorded incident: a registered
package's non-`http(s)` `baseUrl` making `http.request` throw synchronously
inside the `/ext` proxy) surfaced as an unhandled rejection and killed the
whole MCP server process. The false-return contract for a non-console path
is unaffected -- that check runs before the `try`, so a path outside the
console never has anything written to `res`.

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

### GET `/ext/*` and the unauthenticated-credential decision (apra-fleet-iywi.11)

`GET /ext/*` stays unguarded (see "Auth guard and console cookie" above), so
`handleConsoleRequest` never answers 401 for it. Left unqualified, that has a
consequence worth naming explicitly: **any page the operator's browser has
open can issue a plain cross-origin `GET` to this loopback port** -- no
preflight, and `<img>`/`<script>` tags work too -- and, before this decision,
that GET reached `src/console/proxy.ts` exactly like a legitimate one, which
derived and attached the per-package upstream credential regardless of
whether the caller proved who it was. CORS stops the attacker reading the
response body, but any state-changing or information-triggering `GET`
endpoint a package exposes was reachable, credentialed, with the console
supplying the credential on the attacker's behalf.

**Decision: keep `GET /ext/*` open, but attach the derived upstream
credential only when the inbound request itself carries a valid console
credential** (the fleet-key bearer, or the `apra_console_token` cookie).
`src/console/server.ts`'s `isExtPath` dispatch branch checks this explicitly
for a `GET` (a non-`GET` request that reaches the branch at all has already
passed the guard, so it is always treated as authenticated) and passes the
result to `src/console/proxy.ts` as `ExtProxyOptions.forwardCredential`;
`handleExtProxyRequest` skips attaching `Authorization` entirely when it is
`false`. An unauthenticated `GET` still reaches the upstream -- the 404
(unknown id) / 502 (unreachable or bad-scheme upstream) / 200 (success)
contract is unchanged -- it simply carries nothing usable as a credential.
This is enforced in code (the `forwardCredential` branch), not left to
operator convention or to documentation alone.

Weighed against the two alternatives considered and rejected:

- **(a) Guard `GET /ext/*` like every other console path.** Rejected: it
  would require the shell to send the console cookie (or bearer) on every
  package-UI load, which is a same-origin request and would work, but it
  also flips the answer to "can a script/`<img>` tag on a third-party page
  even reach `/ext/*` at all" to a flat no for anything without a credential
  -- a much larger behavioural change than the credential the review was
  actually worried about, and it stops matching "a normal reverse-proxy's
  read path" (the reason `GET` was left open in the first place). The
  chosen option gets the same security outcome (no credentialed request from
  an unauthenticated caller) without that behavioural change.
- **(c) Require an `Origin`/`Sec-Fetch-Site` check on the unguarded path.**
  Rejected: it is enforced by header presence rather than a credential check,
  so it degrades silently for any client that does not send those headers
  (plain `curl`/scripted health checks, and some older or non-browser HTTP
  clients) -- a check that fails open for missing headers is weaker than one
  that fails closed on a missing credential, and it would duplicate
  protection the existing bearer/cookie check already provides more
  reliably.

Both rejected options were judged against the same three questions as the
chosen one: whether the shell can still load package UI from the browser
(yes, unaffected under all three -- package-UI loads are same-origin, so the
console cookie is sent automatically regardless of which option is chosen);
whether a third-party page can still cause a *credentialed* upstream request
(no, under the chosen option and (a); under (c), only if the third-party page
also spoofs `Sec-Fetch-Site`/`Origin`, which a browser prevents but a
non-browser HTTP client does not); and whether the choice is enforced by code
rather than convention (yes for the chosen option and (a); weaker for (c), as
above). No regression to the derived-credential property itself: an
AUTHORISED GET (or any authenticated non-GET) still receives a credential
that is not byte-equal to the fleet key and still differs per package id --
`forwardCredential` only ever removes the header, it never changes how the
credential the removed header would have carried is derived.

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
