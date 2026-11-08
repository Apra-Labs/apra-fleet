# Supervisor and viewer request guard

The fleet-sprint supervisor and the per-run dashboard viewer bind loopback HTTP
servers whose POST routes change state (launch or stop a run, record an
operator decision, shut down). Any web page the operator visits could otherwise
aim a form POST or a DNS-rebound request at them. One shared guard, exported
from the workflow package as `viewer/request-guard`, runs before any route
handler in both servers.

## Rules

1. **Host check on every request, GET included.** The Host name must be a
   loopback name, any IP literal, the server's own non-wildcard bind host, or an
   explicitly allowed extra name (supervisor `--allowed-host` flag or its env
   var, `FLEET_SUPERVISOR_ALLOWED_HOSTS`). The port is not compared. This defeats DNS rebinding: a rebound page
   controls both Origin and Host and makes them agree, so the Origin check alone
   is not enough, and an unguarded GET would let it read run state.
2. **Mutating requests (anything but GET/HEAD/OPTIONS) need
   `Content-Type: application/json`.** A browser cannot send that cross-site
   without a CORS preflight, which these servers never approve; an HTML form
   cannot send it at all.
3. **Mutating requests must be same-origin.** No Origin header (curl, the sprint
   child's HTTP clients, the supervisor's own proxy) or an Origin whose host
   equals the request Host. Cross-site and same-site Sec-Fetch-Site values are
   refused.
4. **Token escape hatch.** If a token is configured
   (`FLEET_SUPERVISOR_TOKEN`), `Authorization: Bearer <token>` or
   `X-Fleet-Token` admits a cross-site mutating request. A presented token that
   does not match is always refused. Comparison is constant time. A token does
   not waive the Host check.

## Consequences for callers

- Every in-repo POST caller must send `application/json` (dashboard, viewer,
  the coordination clients, the child stop/action proxy, sandbox deploy, and any
  curl example in docs or skills). A new caller that omits it gets a 415 whose
  body names the remedy.
- The supervisor's proxy to child viewers strips Origin and token headers before
  forwarding, so a token never leaks to a child. A child viewer has no token
  mechanism and says so in its refusal instead of reporting "invalid token".
- Error responses never include stack traces. Header parsing (bearer prefix) and
  the mini-DOM open-tag scan are linear-time so hostile input cannot trigger
  regex backtracking.
- Rejection bodies (403/415) name the remedy so an operator behind a reverse
  proxy knows to add an allowed host.

## Invariants

- The guard lives in one module shared by both servers; do not re-implement it
  per route.
- Any new mutating route is covered automatically by being behind the
  dispatcher; do not add a route that is served before the guard.
