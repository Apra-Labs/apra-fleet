# How authentication and authorization work for the fleet supervisor

This page is for an operator who wants to understand how the fleet supervisor decides who a
caller is and what that caller may do, and who wants to deploy it for remote users. Every fact
here is what the code does today; the source is `src/supervisor/auth.mjs` (verifier, caller
classification, route policy), `src/supervisor/base-path.mjs` (path prefix),
`src/supervisor/server.mjs` (dispatcher, `GET /api/whoami`, audit line) and `bin/serve.mjs`
(flags).

## Summary

The supervisor has two authentication modes. In `none` (the default) it has no notion of a user:
every caller is the local operator with full control, exactly as before authentication existed.
In `trusted-front` it serves remote users, and it still never talks to an identity provider
itself: it holds no client secret, makes no outbound calls and knows nothing about sign-in
pages, provider groups or provider tokens.

Instead, a separate process on the same machine, the **front**, signs users in with whatever
identity provider you use, decides which fleet role each user has, and vouches for the user on
every request it forwards by attaching a short-lived assertion signed with its own key. The
supervisor only checks that signature against the front's public key file. Processes on the
supervisor's own machine (sprints, your scripts, the fleet skills) reach it over loopback without
any assertion and remain the local operator.

```
 browser ---> [ front ] -- signs the user in, strips identity headers, maps roles,
                 |         adds X-Fleet-Identity (signed, about 60 s), forwards
                 v
     127.0.0.1:8787 [ supervisor ] -- verifies the assertion, checks the route's role,
                                      records the actor, serves the request
     local processes (sprints, scripts, skills) ---> 127.0.0.1:8787, no assertion
```

## How a request is authenticated

### Modes

| Mode | Who can call | Identity |
|---|---|---|
| `none` (default) | Anything that can reach the port (loopback only unless you pass `--host`) | Every caller is the local operator; `X-Fleet-Identity` and `X-Forwarded-Prefix` are ignored |
| `trusted-front` | Loopback callers only (the supervisor refuses to start on any other bind address) | From the verified assertion; an unsigned loopback caller is the local operator |

The local operator is `{ "sub": "local", "name": "local", "email": null, "roles": ["admin"] }`.
Because roles are cumulative, `admin` means every role.

### Two kinds of caller

In `trusted-front` mode the front and the local processes both connect over loopback, so the
supervisor tells them apart by the assertion header, never by address alone:

| Request | Treated as |
|---|---|
| Carries `X-Fleet-Identity` | A remote user. The assertion must verify, otherwise `401`. It never falls back to the local operator. |
| No `X-Fleet-Identity`, peer address is loopback (`127.0.0.0/8`, `::1`, `::ffff:127.x.x.x`) | The local operator, with full access; not checked against the route policy |
| No `X-Fleet-Identity`, any other peer address | `401` |

This is why a front must never forward a request unsigned: an unsigned request from the front's
loopback connection would be the local operator.

### Identity assertion

The front sends one header per request:

```
X-Fleet-Identity: <compact JWS>
```

- Algorithm `ES256` (ECDSA on the P-256 curve with SHA-256), raw 64-byte signature. Any other
  `alg` is refused. A JWS header with a `crit` member is refused.
- The JWS header should carry `kid`, naming a key in the JWKS file. A header without `kid` is
  accepted only while the JWKS file holds exactly one key.
- A token longer than 16 KB is refused without being parsed. A repeated header is refused (the
  values are joined and no longer form one token).

Claims:

| Claim | Required | Rule |
|---|---|---|
| `iss` | yes | Must equal the configured issuer exactly |
| `aud` | yes | Must equal the configured audience (default `fleet-supervisor`), or be an array that contains it |
| `sub` | yes | Non-empty string: the stable user id the front got from the identity provider |
| `roles` | yes | Array of fleet roles already mapped by the front: any of `viewer`, `operator`, `admin`. A missing or non-array `roles` is refused. Unknown strings are ignored; an array with no known role verifies but grants no role (see below) |
| `iat` | yes | Number (seconds). Refused if more than 30 s in the future |
| `exp` | yes | Number (seconds). Must be later than `iat`, at most 300 s after `iat`, and not more than 30 s in the past |
| `nbf` | no | If present, a number not more than 30 s in the future |
| `name` | no | Display name, recorded in the audit fields |
| `email` | no | Sign-in name or email, shown by `GET /api/whoami` |
| `jti` | no | Request id, for the front's own correlation |

Allowed clock skew is 30 s on `iat`, `exp` and `nbf`. The longest accepted lifetime
(`exp - iat`) is 300 s; fronts should use about 60 s and sign a fresh assertion for every
request.

### Front keys (JWKS file)

The supervisor verifies with the front's public keys, read from a JWKS file on local disk
(`FLEET_SUPERVISOR_FRONT_JWKS` / `--front-jwks`). It holds no secret.

- The file is a JSON object with a `keys` array (RFC 7517). Only keys with `kty` `EC` and `crv`
  `P-256` are used; a key whose `alg` is present and not `ES256`, or whose `use` is present and
  not `sig`, is skipped. Only `x` and `y` are imported: a private `d` in the file is ignored (but
  do not put one there).
- Several keys may be listed (for rotation); each is found by its `kid`. Two keys with the same
  `kid` make the whole file invalid.
- The file is re-read whenever its modification time or size changes, so a rotation needs no
  restart.
- While the file is missing, unreadable or invalid, every request that carries an assertion is
  refused with `401` (fail closed) and the supervisor logs why. Unsigned loopback callers are
  unaffected. At startup a missing or keyless file is a logged WARNING, not a refusal to start.

See "Example JWKS file" below for the format.

### Failure responses

| Situation | Status | Body |
|---|---|---|
| Assertion missing a required claim, malformed, expired, not yet valid, wrong issuer or audience, unknown `kid`, bad signature, or the JWKS file is unusable | `401` | `{"error":"unauthenticated"}` |
| Unsigned request from a non-loopback address (`trusted-front` only) | `401` | `{"error":"unauthenticated"}` |

The body is always exactly that: the response never says which check failed, and the token is
never logged.

### Interaction with the request guard

The supervisor's existing request guard (see `supervisor-api.md`) runs after authentication.
For unsigned requests it is unchanged: Host check (DNS-rebinding defence), JSON content type on
mutating requests, and same origin or the optional `FLEET_SUPERVISOR_TOKEN`. For a request with
a verified assertion the browser-to-front hop was already checked by the front, so the guard
ignores `Host`, `Origin`, `Referer`, `Sec-Fetch-*`, `Authorization` and `X-Fleet-Token` on it;
only the rule that a mutating request must send `Content-Type: application/json` still applies.

## How a request is authorized

### Roles

There are three fleet roles and they are cumulative: `admin` includes `operator`, which
includes `viewer`. The supervisor never sees the identity provider's own groups or roles; the
front maps them to these three names before signing.

Authorization applies only to requests with a verified assertion. The local operator (every
caller in `none` mode, and unsigned loopback callers in `trusted-front` mode) is not checked.

### Roles and route policy

The policy is one table, `ROUTE_POLICY` in `src/supervisor/auth.mjs`, enforced by the server's
request dispatcher before any handler runs. A test fails if a registered route has no entry.
This is the table as implemented.

Any verified identity, even one with no role:

| Method | Path |
|---|---|
| GET | `/api/whoami` |

`viewer` (dashboard pages, sprint lists and state, live views, history, health):

| Method | Path |
|---|---|
| GET | `/` |
| GET | `/state` |
| GET | `/events` |
| GET | `/api/health` |
| GET | `/api/sprints` |
| GET | `/api/sprints/:id` |
| GET | `/sprints/:id/live` |
| GET | `/sprints/:id/live/events` |
| GET | `/sprints/:id/live/state` |
| GET | `/sprints/:id/live/extensions/:extId/detail/:itemId` |
| GET | `/sprints/:id/live/activities/:activityId/output` |
| GET | `/sprints/:id/history` |

`operator` (launch, stop, pause, resume, answer decisions, save logs, read raw logs, backlog, and
the member list the launch form needs):

| Method | Path |
|---|---|
| POST | `/api/sprints` |
| POST | `/api/sprints/:id/stop` |
| POST | `/api/sprints/:id/decisions/:decisionId` |
| POST | `/sprints/:id/live/stop` |
| POST | `/sprints/:id/live/pause` |
| POST | `/sprints/:id/live/resume` |
| POST | `/sprints/:id/live/save_logs` |
| POST | `/sprints/:id/live/extensions/:extId/actions/:actionId` |
| GET | `/sprints/:id/log` |
| GET | `/supervisor/log` |
| GET | `/api/backlog` |
| GET | `/api/backlog/tasks` |
| GET | `/api/members` |

`admin` (shutdown and force-release of member reservations):

| Method | Path |
|---|---|
| POST | `/api/shutdown` |
| POST | `/api/reservations/:sprintId/force-release` |

Local only (sprint-to-supervisor callbacks; never reachable with an assertion, whatever the
role):

| Method | Path |
|---|---|
| POST | `/api/dolt-push-mutex/:sprintId/acquire` |
| POST | `/api/dolt-push-mutex/:sprintId/release` |
| POST | `/api/dolt-push-mutex/:sprintId/renew` |
| GET | `/api/dolt-push-mutex` |
| POST | `/api/child-id-allocator/:parentId/allocate` |
| POST | `/api/child-id-allocator/confirm` |
| POST | `/api/child-id-allocator/release` |
| GET | `/api/child-id-allocator` |

Rules:

- `:name` matches exactly one non-empty path segment. A literal path wins over a pattern.
- **Default deny**: a request with an assertion whose method and path match no entry is refused.
  The table lists only `GET` and `POST`, so `HEAD` or `OPTIONS` with an assertion is refused too.
- A verified identity whose `roles` held no known role can call only `GET /api/whoami`.
- Refusals are all `403`:

| Situation | Body |
|---|---|
| Role too low | `{"error":"forbidden","requiredRole":"<viewer, operator or admin>"}` |
| Local-only route | `{"error":"forbidden"}` |
| Route not in the table | `{"error":"forbidden"}` |

### What the dashboard shows

For a signed-in user the dashboard page says "Signed in as <name> (<highest role>)" and hides
what the role may not use. This is cosmetic; the table above is what is enforced. Below
`operator` the page leaves out the backlog and the Launch Sprint form. The dashboard's Stop and
Restart buttons use force-release, so they need `admin`; an operator stops a sprint with
`POST /api/sprints/:id/stop` or the live view's Stop.

## Forwarded path prefix

A front that publishes the supervisor under a path, for example `https://<front-host>/fleet/`,
sends `X-Forwarded-Prefix: /fleet`. The supervisor then renders its pages so that every URL the
browser follows carries that prefix. Rules:

- Honoured only in `trusted-front` mode and only on a request whose assertion verified. In
  `none` mode and on unsigned requests it is ignored.
- Accepted only if it matches `^(/[A-Za-z0-9._~-]+)+$`, is at most 512 characters, and has no
  `.` or `..` segment (a browser would resolve those away). Anything else is silently ignored
  and the page is served without a prefix.
- Rewritten under the prefix: root-absolute `href`, `src` and `action` attributes, and quoted
  string literals starting with one of the supervisor's own top-level segments (`/api`,
  `/sprints`, `/state`, `/events`, `/supervisor`), which covers links, `fetch()` and
  `EventSource` URLs in the dashboard, the live viewer and the history view; and a root-absolute
  `Location` header on a proxied live-viewer response.
- Never rewritten: absolute and protocol-relative URLs, and data the page embeds as JSON
  (backlog rows, a finished run's frozen state), which reaches the browser verbatim.
- With no prefix, pages are byte-for-byte what they were without this feature.

The front forwards the path without the prefix: the supervisor's routes are always at `/`.

## Audit

The acting identity is recorded as `{ sub, name }`: from the assertion for a remote user, and
`{ "sub": "local", "name": "local" }` for the local operator (including every caller in `none`
mode).

- **`launchedBy`** is stored on the sprint's ledger reservation when `POST /api/sprints`
  launches it.
- **`stoppedBy`** is stored on the reservation when someone calls `POST /api/sprints/:id/stop`
  or the live view's stop (`POST /sprints/:id/live/stop`). Recording it is best effort; it never
  fails the stop.
- A force-release history event carries the reservation's `launchedBy` and records the caller
  of `POST /api/reservations/:sprintId/force-release` as `stoppedBy`. A watchdog auto-release
  history event carries the reservation's `launchedBy` and `stoppedBy` when they were recorded.
- The fields are optional and absent on records written before this feature.

**Audit log line.** For every mutating request (anything but `GET`, `HEAD`, `OPTIONS`) that
carried `X-Fleet-Identity`, the supervisor writes one line to its log when the response is
closed, whatever the outcome:

```
[audit] POST "/api/sprints" sub="00000000-0000-0000-0000-000000000001" status=201
[audit] POST "/api/shutdown" sub="00000000-0000-0000-0000-000000000001" status=403
[audit] POST "/api/sprints" sub=null status=401
```

The format is `[audit] <METHOD> <path as a JSON string> sub=<sub as a JSON string> status=<code>`;
`sub=null` means the assertion did not verify. The token itself is never logged. Unsigned
(local operator) requests and read-only requests get no audit line.

**`GET /api/whoami`** returns the caller as the supervisor sees it:

```json
{ "sub": "local", "name": "local", "email": null, "roles": ["admin"], "mode": "trusted-front" }
```

A remote user gets its own `sub`, `name`, `email` and known `roles` (possibly empty), and
`mode` is the supervisor's mode (`none` or `trusted-front`).

## Configuration reference

Each setting can be given as a `bin/serve.mjs` flag or as an environment variable; the flag
wins. An empty or whitespace-only value counts as unset.

| Environment variable | Flag | Default | Meaning |
|---|---|---|---|
| `FLEET_SUPERVISOR_AUTH` | `--auth <mode>` | `none` | `none` or `trusted-front` |
| `FLEET_SUPERVISOR_FRONT_JWKS` | `--front-jwks <path>` | none | Path to the front's public JWKS file. Required for `trusted-front` |
| `FLEET_SUPERVISOR_FRONT_ISSUER` | `--front-issuer <iss>` | none | Expected `iss` of the front's assertions. Required for `trusted-front` |
| `FLEET_SUPERVISOR_FRONT_AUDIENCE` | `--front-audience <aud>` | `fleet-supervisor` | Expected `aud` |

Related settings that already existed:

| Environment variable | Flag | Default | Meaning |
|---|---|---|---|
| (none) | `--host <addr>` | `127.0.0.1` | Bind address. Must be loopback for `trusted-front` |
| (none) | `--port <port>` | `8787` | HTTP port |
| `FLEET_SUPERVISOR_ALLOWED_HOSTS` | `--allowed-host <name>` | none | Extra `Host` names answered (checked on unsigned requests only) |
| `FLEET_SUPERVISOR_TOKEN` | (none) | none | Optional token that admits cross-site mutating requests (unsigned requests only) |

**Startup refusals.** The supervisor prints `Error: refusing to start: <reason>` and exits with
status 1, before binding the port, when:

- the mode is not `none` or `trusted-front`;
- the mode is `trusted-front` and `--host` is not a loopback address (`127.x.x.x`, `::1`,
  `[::1]` or `localhost`);
- the mode is `trusted-front` and no JWKS path is set;
- the mode is `trusted-front` and no issuer is set.

The message names the setting to fix. A JWKS path that is set but points at a missing or
unusable file does not stop startup; it logs a WARNING and every signed request is refused
until the file is usable. On a successful start in `trusted-front` mode the log shows
`[supervisor] auth: trusted-front (issuer "...", audience "...", JWKS "...")`.

## Deployment shapes

### A. Single machine or trusted network: `none`

Run the supervisor with no auth settings. It binds `127.0.0.1:8787`, and only processes on the
same machine can reach it; all of them are the local operator. This is the right choice when the
people using the dashboard are logged in to that machine, or reach it through a tunnel that
already authenticates them.

Do not combine `none` with a non-loopback `--host` unless every machine that can reach the port
is trusted: see "Security notes".

### B. Remote users through an authenticating front

The front is any process that follows the "Front contract" below. It typically signs users in
with an OpenID Connect identity provider (your organisation's directory, or a hosted user pool),
maps the provider's groups or app roles to `viewer` / `operator` / `admin`, and publishes the
supervisor to browsers. Ready-made fronts and provider-specific walkthroughs live with the front
implementation, not in this repository.

Procedure:

1. **Start the front** on the supervisor's machine, configured to forward to
   `http://127.0.0.1:8787`. A front normally creates its signing key pair on first start and
   writes the public half as a JWKS file.
2. **Take two values from the front**: the path of its public JWKS file and the issuer string it
   puts in `iss`. If the front's audience is not `fleet-supervisor`, take that too.
3. **Start the supervisor** in `trusted-front` mode, on loopback (the default host):

   ```bash
   FLEET_SUPERVISOR_AUTH=trusted-front \
   FLEET_SUPERVISOR_FRONT_JWKS=/path/to/front-keys/jwks.json \
   FLEET_SUPERVISOR_FRONT_ISSUER=https://front.example.com \
   node ~/.apra-fleet/workflows/fleet-sprint/bin/serve.mjs --beads-dir /path/to/project
   ```

   or with flags:

   ```bash
   node ~/.apra-fleet/workflows/fleet-sprint/bin/serve.mjs --beads-dir /path/to/project \
     --auth trusted-front \
     --front-jwks /path/to/front-keys/jwks.json \
     --front-issuer https://front.example.com
   ```

   Add `--front-audience <aud>` only if the front does not use `fleet-supervisor`. Check that
   the log shows `[supervisor] auth: trusted-front (...)` and and no error. The supervisor refuses to start if the JWKS file is unreadable, invalid or holds no EC P-256 key.
4. **Verify locally**, on the supervisor's machine:

   ```bash
   curl -s http://127.0.0.1:8787/api/whoami
   # {"sub":"local","name":"local","email":null,"roles":["admin"],"mode":"trusted-front"}
   curl -s -H "X-Fleet-Identity: not-a-token" http://127.0.0.1:8787/api/whoami
   # {"error":"unauthenticated"}
   ```

   The first shows that local tooling still works; the second shows that assertions are being
   checked.
5. **Verify through the front** in a browser: open the front's public URL, sign in, and check
   that the dashboard says "Signed in as <you> (<role>)". Opening `<front URL>/api/whoami`
   shows your `sub`, `email` and fleet roles as the supervisor sees them. Launch or stop a
   sprint as an operator and look for the `[audit]` line in the supervisor log.

#### Example JWKS file

The values below are deliberately fake and not a valid key; a real file is written by the front.

```json
{
  "keys": [
    {
      "kty": "EC",
      "crv": "P-256",
      "kid": "example-front-key-1",
      "alg": "ES256",
      "use": "sig",
      "x": "EXAMPLExONLYxNOTxAxREALxKEYxXXXXXXXXXXXXXXX",
      "y": "EXAMPLExONLYxNOTxAxREALxKEYxYYYYYYYYYYYYYYY"
    }
  ]
}
```

#### Example assertion (decoded)

Header:

```json
{ "alg": "ES256", "kid": "example-front-key-1", "typ": "JWT" }
```

Payload:

```json
{
  "iss": "https://front.example.com",
  "aud": "fleet-supervisor",
  "sub": "00000000-0000-0000-0000-000000000001",
  "name": "Example User",
  "email": "user@example.com",
  "roles": ["viewer", "operator"],
  "iat": 1800000000,
  "exp": 1800000060,
  "jti": "00000000-0000-0000-0000-00000000abcd"
}
```

On the wire the header and payload are base64url-encoded JSON, followed by the base64url
signature, joined with `.` (`<header>.<payload>.<signature>`); that whole string is the value
of `X-Fleet-Identity`.

#### Rotating the front key

1. Generate the new key pair at the front and **add** its public key, with a new `kid`, to the
   JWKS file the supervisor reads. Keep the old key in the file.
2. Switch the front to sign with the new key (its assertions now carry the new `kid`).
3. Once the longest assertion lifetime has passed (300 s at most; a minute is typical),
   **remove** the old key from the file.

The supervisor re-reads the file on each change; no restart is needed. If you replace the file
in one step instead, requests signed with the old key that are in flight at that moment get
`401`. Removing a key is also how you cut off a front whose private key may have leaked.

## Front contract

Any front MUST:

1. Authenticate every request before forwarding it, and challenge unauthenticated callers
   (`401` for API calls, a sign-in page for page loads).
2. Sign a fresh assertion (as specified in "Identity assertion") for EVERY request it forwards,
   with a lifetime of about 60 s and never more than 300 s, and send it as `X-Fleet-Identity` to
   the supervisor's loopback address.
3. Refuse a request it cannot sign (for example with `503`) and never forward it unsigned: an
   unsigned loopback request is the supervisor's local operator.
4. Strip from every incoming request, before adding its own headers: `X-Fleet-Identity`,
   `X-Forwarded-Prefix`, every other `X-Fleet-*` header, `Authorization`, and its own session
   cookie. Send `X-Forwarded-Prefix` only if it publishes the supervisor under a path, and only
   with a value the supervisor accepts.
5. Block the local-only routes (`/api/dolt-push-mutex` and `/api/child-id-allocator`, and
   everything under them) from outside, in a way that case, percent-encoding or repeated slashes
   cannot bypass. The supervisor refuses them anyway; blocking them at the front keeps them off
   the network entirely.
6. Map the identity provider's groups or app roles to the fleet roles `viewer`, `operator` and
   `admin`, and put only those in `roles`. Refuse users with no mapped role at the front.
7. Keep its private signing key private: readable only by the front's own account, never logged,
   never copied to another machine. Give the supervisor only the public JWKS file.
8. Run on the same machine as the supervisor and be the only network path to it.

9. Protect its own session cookie against cross-site requests (`SameSite=Lax` or `Strict`, plus CSRF
   protection on every mutating route) and answer no permissive CORS preflight (no
   `Access-Control-Allow-Origin` for a foreign origin, and no credentials for one). The supervisor
   ignores `Origin`, `Referer` and `Sec-Fetch-*` on a forwarded request, so the front is the only
   cross-site defence: a cross-site page that can make the browser send the cookie can otherwise
   drive the supervisor as the signed-in user.

A front SHOULD also rate-limit and log sign-ins.

## Security notes

**What is trusted:**

- The front's signing key. Whoever holds the private key can act as any user with any role.
- Every process on the supervisor's machine. In `trusted-front` mode an unsigned loopback
  request is the local operator with full control, so any local process, under any local
  account, is the local operator. Run the supervisor on a machine whose local users and
  software you trust.
- The JWKS file and the supervisor's settings: anyone who can write them can add a key or change
  the issuer. Keep them writable only by the account that runs the supervisor.

**What is not trusted:**

- Anything a browser sends: identity-like headers are ignored unless they form a valid signed
  assertion, and the front strips them as well.
- The network. In `trusted-front` mode the supervisor listens only on loopback and refuses to
  start otherwise; remote callers reach it only through the front.

**`none` mode on a network address.** `none` has no user identity. Bound to a non-loopback
address (`--host 0.0.0.0` or a LAN address), every peer that can reach the port has full
control: it can launch sprints, which run agents with the fleet's credentials, stop them, read
logs and shut the supervisor down. The request guard only stops other web sites from driving a
user's browser against the supervisor; it does not stop a direct client. Keep `none` on
loopback, and use `trusted-front` with a front when anyone else needs access.

**Assertions are bearer tokens for their lifetime.** A captured assertion can be replayed until
it expires; the supervisor does not track `jti`. This is why the lifetime is short and why the
front-to-supervisor hop stays on loopback.

## Not covered

- Signing users in, sessions and sign-out: the front's job.
- Per-sprint ownership (for example "only the launcher may stop it"): authorization is by role
  only.
- Rate limiting and brute-force protection: the front should do it.
- Replay detection within an assertion's lifetime.
- Network-level authentication (for example mutual TLS) between the front and the supervisor;
  they share a machine and talk over loopback.
