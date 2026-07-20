<!-- llm-context: REFERENCE-ONLY status note (apra-fleet-yp3, 2026-07-05): this hub
     service is NOT deployed to fleet.apralabs.com and receives no further production
     feature work -- fleet-dashboard is the sole tier-3 persistence layer going forward
     (see docs/api-contract-reconciliation.md section 1.5, the authoritative product-owner
     directive). Everything below documents a working reference implementation (2133
     passing tests, verified wire-protocol/security-isolation semantics) kept as a
     specification, not a deployment guide to follow. See
     docs/adr-hub-persistence.md and docs/hub-spoke-master-plan.md for the superseded
     architecture and persistence decisions this reference shape followed from. -->
<!-- keywords: hub service, reference implementation, deprecated deployment, docker,
     Postgres, HUB_JWT_SECRET, superseded by fleet-dashboard -->

# Hub Service Deployment (Reference Implementation -- Not a Deployment Target)

> **Status: reference-only, dev/test use only.** `src/hub-service/` is not deployed
> to fleet.apralabs.com and gets no further production feature work. The product
> owner decided fleet-dashboard is the sole tier-3 persistence layer (all
> workspace/project/member/secret configuration); `apra-fleet.exe` talks to it as a
> client (SaaS-connected mode) or falls back to local JSON files (standalone mode),
> never to a Postgres database it owns itself. See
> `docs/api-contract-reconciliation.md` section 1.5 for the directive and
> `apra-fleet-yp3` for the retirement decision. Everything below is preserved as a
> record of a working reference implementation -- useful for the team building the
> production equivalent, not instructions to actually stand this up in production.

Self-hostable by design (docs/adr-hub-persistence.md): no cloud-vendor-specific
services required, just Postgres and a place to run one Node process. (This
self-host-parity rationale was the pre-directive design intent; it no longer
applies now that fleet-dashboard owns tier-3 persistence -- kept here only for
historical/reference accuracy.)

## Local development (reference/dev-only -- do not use for production)

```bash
docker compose -f docker-compose.hub-service.yml up
```

Starts a disposable Postgres 16 container and the hub service on `:8080`, running
migrations automatically on startup (`src/hub-service/main.ts`). The compose file's
`HUB_JWT_SECRET` is a fixed local-dev value -- never reuse it anywhere else.

## Building the image standalone (reference/dev-only -- do not use for production)

```bash
docker build -f Dockerfile.hub-service -t apra-fleet-hub .
docker run -p 8080:8080 \
  -e HUB_DATABASE_URL=postgres://user:pass@host:5432/dbname \
  -e HUB_JWT_SECRET="$(openssl rand -hex 32)" \
  apra-fleet-hub
```

## Required environment variables

| Variable | Required | Description |
|---|---|---|
| `HUB_DATABASE_URL` | yes | Postgres connection string. Any Postgres 14+ works -- managed (RDS, Cloud SQL, Supabase) or self-hosted. |
| `HUB_JWT_SECRET` | yes | HS256 signing secret for member tokens (`src/hub-service/hub-jwt.ts`). Generate with `openssl rand -hex 32`. This is an MVP stopgap -- apra-fleet-us9.5 will replace it with asymmetric (dashboard-minted) signing; rotating this value invalidates every outstanding member token, so plan a rotation window if you ever need to change it. |
| `PORT` | no (default `8080`) | HTTP listen port. |
| `HOST` | no (default `0.0.0.0`) | Bind address. This is a network-facing cloud service by design -- unlike the local `apra-fleet.exe` spoke, which binds `127.0.0.1` only, the hub is meant to be reachable. |

## What's running

A single Node process (`node dist/hub-service/main.js`) that:
1. Runs every pending migration in `db/migrations/` on startup (`CREATE TABLE IF NOT
   EXISTS` throughout -- safe to run on every restart, no separate migration-tracking
   table needed at this scale).
2. Serves the routes in `packages/fleet-api-contract`'s `Endpoints` map: health,
   installers, member/project CRUD, cost, activity, hub-mediated enrollment
   (`apra-fleet-fnz.4`/`us9.5`), and OAuth sign-in/workspace/admin-user management
   (`apra-fleet-us9.16`). See `src/hub-service/http-server.ts`.

No background workers, no separate queue service -- `relay_queue`/`audit_log`/
`usage_ledger` are plain tables read and written in-request (docs/adr-hub-persistence.md's
Postgres-only decision).

## TLS / WAN deployment

This process only ever speaks plain HTTP -- there is no TLS termination inside
`src/hub-service/http-server.ts`. For any deployment reachable over the public
internet (the default `fleet.apralabs.com` target that `apra-fleet join` and the
dashboard OAuth flow assume), put a TLS-terminating reverse proxy or load balancer
in front of it (e.g. a managed platform's built-in HTTPS, nginx, Caddy, or a cloud
load balancer) and forward plain HTTP to this process on `PORT`. Nothing in the
data model or request handling assumes LAN-only or single-machine reachability
(confirmed in `apra-fleet-fnz.5`'s WAN-readiness review) -- this is the one
deployment-shape gap that isn't yet spelled out here, not an architectural blocker.

## What's NOT yet deployable

- Real member JWT issuance/rotation with asymmetric signing (`apra-fleet-us9.5`'s
  asymmetric-signing follow-on) -- today's `HUB_JWT_SECRET` is an HS256 stopgap for
  testing the data/HTTP layer.
- Spoke relay traffic (`apra-fleet-us9.6`/`us9.7`) -- nothing yet calls this hub for
  real command dispatch, so `relay_queue`/`activity_log`/`usage_ledger` have no live
  writers outside tests.
