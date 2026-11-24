# Supervisor authentication and authorization

The supervisor can run in two ways without code changes between them:

- **On a trusted machine or LAN** (`auth: none`, the default): it behaves exactly as before.
- **Behind an authenticating front** (`auth: trusted-front`): a separate process signs users in,
  and the supervisor only accepts requests that carry a short-lived identity assertion signed by
  that front. The supervisor never talks to an identity provider itself.

The front is pluggable. Any process that follows the [front contract](#front-contract) works: a
relay agent that signs users in with an OpenID Connect provider (for example an organisation's identity provider)
for access over the internet, or a small local sign-in service on a LAN. Changing the front is
configuration, not a supervisor change.

```
 browser --> [ front ]  -- signs user in, strips identity headers, maps roles,
                 |          adds X-Fleet-Identity (signed, ~60 s), forwards
                 v
         127.0.0.1:8787  [ supervisor ]  -- verifies assertion, checks route role,
                                             records the actor, serves the request
```

## Modes

| Mode | Who can call | Identity | Use |
|---|---|---|---|
| `none` (default) | Anything that can reach the port (loopback by default) | Every caller is the local operator; identity headers are ignored | Today's behaviour; single machine or trusted LAN |
| `trusted-front` | Loopback callers, plus requests with a valid front assertion | From the verified assertion; unsigned loopback callers are the local operator | Remote users through a front |

In `trusted-front` mode the supervisor refuses to start unless it is bound to a loopback address.
The front runs on the same machine and is the only network path in.

## Two kinds of caller

Sprints, the machine owner's scripts and the fleet skills all run on the same machine as the
supervisor and reach it over loopback. The front also connects over loopback, but it attaches an
assertion to every request it forwards. So the supervisor decides by the assertion:

| Request | Treated as |
|---|---|
| Carries `X-Fleet-Identity` | A remote user. The assertion must verify, otherwise `401`. Never falls back to local. |
| No `X-Fleet-Identity`, from a loopback address | The local operator (`local`, all roles), as today |
| No `X-Fleet-Identity`, from any other address | `401` |

This keeps local tooling and sprint callbacks working with no tokens. It relies on the front
attaching an assertion to every request it forwards; a front that cannot sign must refuse the
request (`503`), never forward it unsigned.

## Identity assertion

The front sends one header per request:

```
X-Fleet-Identity: <compact JWS>
```

- Algorithm `ES256` (P-256). The JWS header carries `kid`.
- Claims:

| Claim | Required | Meaning |
|---|---|---|
| `iss` | yes | The front's issuer string; must equal the configured issuer |
| `aud` | yes | `fleet-supervisor` (configurable) |
| `sub` | yes | Stable user id from the identity provider (e.g. the user's object id) |
| `name` | no | Display name |
| `email` | no | Sign-in name or email |
| `roles` | yes | Fleet roles, already mapped by the front: any of `viewer`, `operator`, `admin` |
| `iat`, `exp` | yes | `exp - iat` at most 300 s; the supervisor allows 30 s clock skew |
| `jti` | no | Request id, logged for correlation |

- `roles` must be an array. Unknown role strings are ignored; an assertion whose array holds no
  known role verifies, but the caller has no role and is refused every route except
  `GET /api/whoami`. A missing or non-array `roles` claim is `401`.
- `aud` may also be an array that contains the expected audience. `nbf`, if present, is checked
  with the same skew. A JWS header without `kid` is accepted only while the JWKS holds exactly
  one key. A `crit` header is refused.
- Verification uses the front's public keys from a JWKS file (`FLEET_SUPERVISOR_FRONT_JWKS`).
  The supervisor holds no secret. Several keys may be listed for rotation. The file is re-read
  when its modification time or size changes; while it cannot be read or parsed, every
  assertion is refused (fail closed). Only EC P-256 keys are used; any private member of a key
  is ignored.
- Any other identity header a caller sends (for example `X-Fleet-User`) is ignored by the
  supervisor. Fronts may add plain headers for their own logs; the supervisor trusts only the
  verified assertion.
- A missing, malformed, expired or wrongly signed assertion gives `401` with
  `{"error":"unauthenticated"}`. The response never says which check failed.

## Roles and route policy

Roles are cumulative: `admin` includes `operator`, which includes `viewer`.

| Minimum role | Routes |
|---|---|
| any verified identity | `GET /api/whoami` |
| `viewer` | Dashboard pages, sprint lists and state, live views, history, health |
| `operator` | Launch, stop, pause, resume, answer decisions, save logs, read raw logs (per-sprint and the supervisor's own), backlog, member listing (the launch form needs it) |
| `admin` | Shutdown, force-release of member reservations |
| local only | Sprint-to-supervisor callbacks (dolt push mutex, child id allocator) |

The policy is one table (`ROUTE_POLICY` in `src/supervisor/auth.mjs`), enforced by the server's
request dispatcher before any handler runs; a test fails when a registered route is missing from
it. For requests with an assertion, a route that is not in the table is denied (`403`), a
local-only route is denied (`403`) with `{"error":"forbidden"}`, and a route whose role is too
high gives `403` with `{"error":"forbidden","requiredRole":"<role>"}`. Unsigned loopback callers
(the local operator) are not checked against the table. Fronts should also block local-only
routes themselves.

The dashboard's Stop and Restart buttons use force-release, so they need `admin`; an operator
stops a sprint with `POST /api/sprints/:id/stop` or the live view's Stop. For a caller below
`operator` the dashboard page leaves out the Backlog content and the Launch Sprint form.

### Interaction with the request guard

Unsigned requests keep the existing guard unchanged (Host check, JSON content type, same origin
or `FLEET_SUPERVISOR_TOKEN`). A request with a verified assertion was admitted by the front,
which connects with the loopback address as `Host` and strips `Origin` and `Sec-Fetch-*`; for it
the Host, Origin, `Sec-Fetch-Site` and token checks are skipped, and only the rule that mutating
requests send `Content-Type: application/json` still applies.

## Forwarded path prefix

A front that publishes the supervisor under a path (for example `/<relay-path>/`) sends
`X-Forwarded-Prefix: /<prefix>`. The supervisor then renders every link and script URL in its
dashboard and live-viewer pages under that prefix. It is honoured only on requests with a valid
assertion and only if it matches `^(/[A-Za-z0-9._~-]+)+$` and has no `.` or `..` segment (a
browser would resolve those away); otherwise it is ignored.

Rewritten under the prefix: links, `fetch()` and `EventSource` URLs in the dashboard, the
proxied live viewer and the history view, and a root-absolute `Location` header on a proxied
response. Data the page embeds as JSON (backlog rows, a finished run's frozen state) is never
altered. With no prefix the pages are byte-for-byte unchanged.

## Audit

The acting identity (`sub` and `name`, or `local`) is recorded:

- as `launchedBy` (on `POST /api/sprints`) and `stoppedBy` (on `POST /api/sprints/:id/stop`
  and the live view's stop) on the sprint's ledger reservation, both `{ sub, name }`; a
  force-release or watchdog auto-release history event carries the reservation's `launchedBy`
  and `stoppedBy` (a force-release records its caller as `stoppedBy`). The fields are optional
  and absent on older records,
- for every mutating request that carries an assertion, one supervisor log line:
  `[audit] <METHOD> "<path>" sub="<sub>" status=<code>` (`sub=null` when the assertion failed;
  the token itself is never logged),
- in `GET /api/whoami`, which returns `{ sub, name, email, roles, mode }`. The dashboard page
  renders the same identity server-side ("Signed in as ...") and hides actions the role does not
  allow.

In `none` mode the actor is recorded as `local`.

## Configuration

| Setting | Flag | Default | Meaning |
|---|---|---|---|
| `FLEET_SUPERVISOR_AUTH` | `--auth` | `none` | `none` or `trusted-front` |
| `FLEET_SUPERVISOR_FRONT_JWKS` | `--front-jwks` | none | Path to the front's public JWKS file (required for `trusted-front`) |
| `FLEET_SUPERVISOR_FRONT_ISSUER` | `--front-issuer` | none | Expected `iss` (required for `trusted-front`) |
| `FLEET_SUPERVISOR_FRONT_AUDIENCE` | `--front-audience` | `fleet-supervisor` | Expected `aud` |

## Front contract

Any front must:

1. Authenticate every request; challenge unauthenticated callers (`401` for API calls, a sign-in
   page for page loads).
2. Remove `X-Fleet-Identity`, `X-Forwarded-Prefix`, `Authorization`, the front's own session
   cookie, and any `X-Fleet-*` header from the incoming request.
3. Map the provider's groups or app roles to `viewer`, `operator`, `admin`.
4. Sign a fresh assertion for EVERY request it forwards (lifetime 60 s recommended) and send it to
   the supervisor's loopback address, plus `X-Forwarded-Prefix` if published under a path. If it
   cannot sign, refuse the request; never forward it unsigned, because an unsigned loopback
   request is the local operator.
5. Block local-only routes from outside.
6. Keep its private key private; publish the public JWKS to the supervisor.

## Not covered here

- Signing users in (the front's job).
- Per-sprint ownership ("only the launcher may stop it"); roles only for now.
- Rate limiting; the front should do it.
