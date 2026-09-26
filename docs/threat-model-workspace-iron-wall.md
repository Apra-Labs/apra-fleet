# Threat Model: Workspace Iron Wall (apra-fleet-us9.11)

Formal security review of the hub-spoke cloud migration's multi-tenant
isolation boundary. Scope: the hub service (apra-fleet-us9.4) and spoke-mode
wire protocol (apra-fleet-us9.6) as actually implemented on branch
`feat/hub-spoke-migration`. This traces the ACTUAL code paths, not just the
design docs, and cites file:line for every verdict.

Mission requirement under review (docs/hub-spoke-master-plan.md section 2.3 /
section 4): "workspaces iron-walled, no cross-talk." A token for workspace A
must never be able to read, write, or even confirm the existence of workspace
B's resources.

## Summary

| # | Threat | Verdict |
|---|--------|---------|
| 1a | Cross-workspace read of list resources (members/projects/cost/activity) | MITIGATED |
| 1b | Cross-workspace relay submission | MITIGATED |
| 1c | Cross-workspace read of the relay queue via the SSE stream | **GAP FOUND -> FIXED this pass** |
| 2a | JWT signature forgery | MITIGATED |
| 2b | Stolen valid token replayed | PARTIALLY MITIGATED (design-acknowledged MVP residual) |
| 2c | Revoked JWT (jti) reuse | MITIGATED |
| 2d | Auth error / timing side channels | MITIGATED |
| 3a | Relay enqueue addressed to a foreign workspace's member | MITIGATED |
| 3b | Relay queue flooding (DoS) | MITIGATED (soft cap) |
| 3c | Read a foreign workspace's queued envelopes | Same as 1c -> FIXED |
| 3d | Intra-workspace ack of another member's envelope | OPEN (intra-tenant only, low sev) -> deferred, see below |
| 4 | Enrollment-token replay / reuse | MITIGATED |

Nine threat vectors were solid on review, one was a real cross-workspace gap
(1c/3c) that is fixed in this pass with a regression test, and one is a minor
intra-workspace integrity finding (3d) deferred to a new low-priority beads
issue. Two defense-in-depth hardening recommendations are noted.

All verdicts below reference `src/hub-service/` unless stated otherwise.

---

## Threat 1: Cross-workspace leakage

### 1a. Reading another workspace's list resources -- MITIGATED

Every `/ws/:id/...` route authorizes through a single choke point:

- `authorize(req, workspaceId)` (http-server.ts:56-62) verifies the bearer
  JWT, then rejects (`return null`) unless `claims.workspace_id === workspaceId`
  AND the jti is not revoked. A mismatch is a hard REJECT, never a silent
  correction.
- The data layer independently scopes every query by `workspace_id`
  (e.g. `getMember` members.ts:64-74, `listMemberViews`, `listProjectViews`,
  `getCostResponse`, `getActivityFeed`), so even a logic slip in the route
  cannot return another tenant's rows.
- A mismatch is indistinguishable from "workspace does not exist" and from
  "invalid token": all paths emit an identical `401 {error:'unauthorized'}`
  (http-server.ts:144-147, 305-308, etc.). No existence leakage.

Tests: http-server.test.ts:141 (wrong-workspace token -> 401),
http-server.test.ts:202 (a member created in A is invisible when listing B),
:224 (projects cross-workspace rejected), :276 (cost isolated), :288
(activity, "no auth leakage across workspaces").

### 1b. Submitting a relay envelope into another workspace -- MITIGATED

`submitEnvelope` (envelope-routes.ts:67-85):

- Line 72-74: rejects (`400`) if the envelope body's `workspace_id` does not
  equal the bearer token's `claims.workspace_id`. Body-supplied workspace_id is
  never trusted over the JWT.
- `handleRelay` (envelope-routes.ts:105-122) resolves the target strictly with
  `getMember(claims.workspace_id, env.to.member_id)` (line 107). A target that
  does not resolve *within the caller's own workspace* returns `403` (line 109)
  -- and returns the same 403 whether the member lives in another workspace or
  does not exist at all, so no cross-workspace existence leak.
- `enqueue(claims.workspace_id, ...)` (line 117) always writes under the
  caller's own workspace_id, never a body-supplied one.

Tests: envelope-routes.test.ts:50 (workspace_id mismatch -> 400),
envelope-routes.test.ts:124 ("rejects a relay envelope targeting a member from
a DIFFERENT workspace (403, not a silent drop)"), http-server.test.ts:300
(POST /ws/:id/envelopes enforces the iron wall).

### 1c. Reading another workspace's queued envelopes via the SSE stream -- GAP FOUND, FIXED

This was the one genuine cross-workspace hole.

**The gap (before the fix):** `fetchDeliverable` scoped its read by
`target_member_id` alone -- NOT by `workspace_id` -- even though the
`relay_queue` table carries `workspace_id`
(db/migrations/001_hub_service_schema.sql:58-71) and both write paths
(`enqueue`, `ack`) key on it. relay-queue.test.ts explicitly documented this,
asserting that a colliding member_id across two workspaces returned BOTH rows
and stating "workspace enforcement ... happens at the route/handler level ...
not inside fetchDeliverable itself."

But the route/handler level did NOT enforce it. The `/ws/:id/stream` handler
(http-server.ts) computed `machineId = claims.member_id`, then
`listForMachine(machineId)` -> for each member `fetchDeliverable(m.member_id)`,
with no workspace filter anywhere. The only thing standing between tenants was
presence membership -- and presence is populated from spoke-supplied data with
no workspace check: `handlePresence` (envelope-routes.ts:87-103) feeds the
announce payload's member_ids straight into `announceSnapshot` / `announce`
(presence.ts:22-58), which trust them verbatim.

**Concrete attack:** a compromised or malicious spoke enrolled in workspace A
sends `presence.announce` listing a `member_id` belonging to workspace B. The
hub inserts that member_id into workspace A's machine presence. On the next
stream poll, `fetchDeliverable(victimMemberId)` returns workspace B's queued
`execute_command` payloads and streams them to the attacker -- and marks them
`delivered`, potentially starving the real recipient. member_ids are UUIDs
(members.ts / crypto.randomUUID), so this leaned on unguessability, which is
obscurity, not an iron wall.

**The fix (this pass):**
- `fetchDeliverable(workspaceId, targetMemberId, ...)` now takes the workspace
  as its first argument and scopes the UPDATE by `workspace_id = $1 AND
  target_member_id = $2` (relay-queue.ts:130-152), symmetric with the write
  side.
- The stream route passes the JWT-verified `workspaceId` (never presence, never
  a body value): `fetchDeliverable(workspaceId, m.member_id, pool)`
  (http-server.ts, in the `/ws/:id/stream` poll loop). Even if a foreign
  member_id is injected into this machine's presence, the read can only ever
  surface envelopes queued under THIS workspace -- of which the attacker's
  tenant has none for the victim, so nothing leaks.

Tests proving the fix:
- relay-queue.test.ts (cross-workspace isolation test, ~line 118): two
  workspaces enqueue to the same member_id string; each `fetchDeliverable`
  returns only its own workspace's envelope (was: both).
- http-server.test.ts ("IRON WALL (apra-fleet-us9.11): a spoke in workspace A
  cannot drain workspace B's queue by announcing B's member_id into its own
  presence") -- full end-to-end HTTP proof: attacker announces the victim's
  member_id, opens `/ws/ws-a/stream`, and receives ZERO frames across a full
  poll cycle, while the envelope remains deliverable within workspace B.

Two supporting robustness fixes were needed for the stream to be testable and
production-safe (both genuine latent issues, not test-only workarounds):
- `res.flushHeaders()` on stream connect (http-server.ts) so a client/proxy
  gets the `200` + SSE headers immediately, instead of only when the first
  event happens to be written.
- `server.closeAllConnections()` in `HttpServerHandle.close()` (http-server.ts)
  so a graceful shutdown with a live long-lived SSE stream does not hang
  forever waiting for a connection that never ends on its own.

---

## Threat 2: Token theft / replay

### 2a. Signature forgery -- MITIGATED

`verify` (hub-jwt.ts:60-84) recomputes the HMAC-SHA256 and compares with
`crypto.timingSafeEqual` after a length check (line 66-68) -- constant-time, so
no byte-by-byte timing oracle on the signature. A tampered header/body/sig
yields `null`. `exp` is enforced (line 71).

Test: hub-jwt.test.ts (tampered and expired tokens rejected).

### 2b. Stolen valid token replayed -- PARTIALLY MITIGATED (acknowledged MVP residual)

Bearer tokens are replayable by anyone who obtains them; there is no
sender-constraint (DPoP/mTLS) and a 7-day lifetime (hub-jwt.ts:38,54). This is
a design-acknowledged stopgap: hub-jwt.ts's header comment calls HS256 an
explicit MVP stopgap that apra-fleet-us9.5's asymmetric signer replaces, and
transport confidentiality is assumed to be TLS (docs, apra-fleet-fnz.5). The
compensating control that IS in place is immediate revocation (2c). Not a code
bug; recorded here as residual risk.

Recommendation (for us9.5, not this pass): asymmetric signing, shorter access
token TTL with refresh, and consideration of sender-constrained tokens for the
machine channel.

### 2c. Revoked JWT (jti) reuse -- MITIGATED

`isRevoked(claims.jti)` (jwt-revocation.ts:31-37) is called on EVERY
authenticated path:
- `authorize` (http-server.ts:60) -- used by all `/ws/:id/*` routes, including
  the wire-protocol routes added this session: `/ws/:id/envelopes`,
  `/ws/:id/ack`, and `/ws/:id/stream` (http-server.ts:246-247, 274-275,
  207-211).
- `authorizeSession` (http-server.ts:70) -- used by `/workspaces`,
  `/workspaces/:id/select`, `/ws/:id/enrollment-tokens`, and all `/admin/*`
  routes (via `requirePlatformAdmin`, http-server.ts:80-86).

Token rotation revokes the prior jti (member-tokens.ts / rotateMemberToken), so
a caller still holding the old token is rejected immediately, not only at
natural expiry.

Test: http-server.test.ts:175 ("rotate revokes the old token and issues a new
one that authenticates") -- the old token returns 401 after rotation.

Minor test-coverage note (not a code gap): the revoked-jti rejection is proven
on the members route; the wire-protocol routes inherit the exact same
`authorize()` choke point by construction but have no dedicated
revoked-token-on-/stream assertion. Low priority.

### 2d. Auth error / timing side channels -- MITIGATED

All authorization failure modes -- bad signature, expired, wrong workspace,
revoked jti, and unknown workspace -- funnel through `authorize()` returning
`null` and produce a byte-identical `401 {error:'unauthorized'}`. No response,
status, or message distinguishes "wrong workspace" from "revoked" from "bad
signature," so a token thief learns nothing about why a token failed or whether
a target workspace/member exists. Signature comparison is constant-time (2a).

---

## Threat 3: Relay abuse

### 3a. Enqueue addressed to a foreign workspace's member -- MITIGATED

See 1b: `getMember(claims.workspace_id, ...)` gates every relay admission
(envelope-routes.ts:107).

### 3b. Relay queue flooding (DoS) -- MITIGATED (soft cap)

`enqueue` enforces a per-`(workspace_id, target_member_id)` depth cap
(`MAX_QUEUE_DEPTH = 1000`) and byte cap (`MAX_QUEUE_BYTES = 8 MiB`)
(relay-queue.ts:37-38, 68-78), rejecting the NEWEST admission with
`queue_full` -> HTTP `429` (envelope-routes.ts:118-120), never silently
evicting an older queued item. The cap is per-target, so one member cannot
exhaust another member's budget. It is a soft cap computed in application code
(a SELECT-then-check, not a DB constraint), which is acceptable per
docs/hub-spoke-wire-protocol.md section 6 for a defensive bound.

Test: relay-queue.test.ts:137 ("rejects the newest admission once a target
member's queue hits the depth cap (never silently drops an older item)").

### 3c. Reading a foreign workspace's queue -- FIXED

Identical to 1c. Fixed by scoping `fetchDeliverable` by workspace_id.

### 3d. Intra-workspace ack of another member's envelope -- OPEN (deferred, low severity)

`POST /ws/:id/ack` (http-server.ts:272-300) takes `member_id` from the request
body and calls `ack(workspaceId, memberId, envelopeId)` (relay-queue.ts:133-146)
scoped by `workspace_id` -- so it CANNOT cross the iron wall. However, within a
single workspace it does not verify that `member_id` is a member currently
served by the calling machine (`claims.member_id`). A compromised spoke inside
a workspace could therefore ack (retire) envelopes addressed to a DIFFERENT
member in the SAME workspace, suppressing their delivery.

This is an intra-tenant integrity weakness, not a cross-tenant leak, so it is
out of the strict "iron wall" scope and lower severity (all machines in a
workspace are enrolled into one tenant). It is deferred to a new beads issue
with a specific recommendation: cross-check that `member_id` resolves to a
member present on `claims.member_id`'s machine (presence.listForMachine)
before acking, mirroring the delivery-side scoping.

The same "presence trusts spoke-supplied member_ids" root cause (envelope-
routes.ts:87-103) is now harmless for cross-tenant reads after the 1c fix, but
as defense-in-depth `presence.announce` could additionally validate that every
announced member_id resolves within the machine's workspace
(`getMember(claims.workspace_id, ...)`). Recommended, not required; folded into
the same deferred issue.

---

## Threat 4: Enrollment-token replay / reuse -- MITIGATED

`exchangeEnrollmentToken` (enrollment.ts:61-81) claims the token in a SINGLE
atomic statement:

```sql
UPDATE enrollment_tokens
SET used_at = now()
WHERE token = $1 AND used_at IS NULL AND expires_at > now()
RETURNING *
```

Re-read and verified genuinely race-safe (not merely per the docstring): the
`WHERE used_at IS NULL` predicate and the `SET used_at = now()` are evaluated
under the same row lock in one statement, so of two concurrent exchanges for
the same token exactly one matches the predicate and gets a `RETURNING` row;
the other matches zero rows and returns `null` (enrollment.ts:73-74) -- it can
never mint a second machine/JWT pair. Expired tokens are excluded by
`expires_at > now()`; already-used tokens by `used_at IS NULL`. There is no
alternate redemption code path: the only caller is `POST /join/exchange`
(http-server.ts:661-681), which surfaces the `null` as a generic
`401 {error:'invalid, expired, or already-used token'}` -- the three failure
reasons are indistinguishable to the caller (no oracle on token state).

Tests: enrollment.test.ts:72 (single-use: second exchange fails), :86 (expired
rejected), :94 ("two concurrent exchange attempts ... exactly one succeeds
(atomic claim, not a check-then-act race)"), :106 (a token for one workspace
cannot mint a JWT for another).

---

## Fixes applied in this pass

1. `fetchDeliverable(workspaceId, targetMemberId, ...)` scoped by workspace_id
   (relay-queue.ts:130-152) + stream route passes the JWT-verified workspaceId
   (http-server.ts `/ws/:id/stream`). Closes the cross-workspace read gap
   (1c/3c).
2. `res.flushHeaders()` on SSE connect (http-server.ts) -- clients confirm the
   stream opened before the first event.
3. `server.closeAllConnections()` in `close()` (http-server.ts) -- graceful
   shutdown no longer hangs on live SSE streams.
4. Regression tests: relay-queue.test.ts cross-workspace isolation (inverted
   from documenting the gap to proving the fix); http-server.test.ts end-to-end
   "IRON WALL" stream leakage test. All existing call sites updated to the new
   `fetchDeliverable` signature (envelope-routes.test.ts,
   relay-queue.docker.test.ts).

## Deferred (new beads issue under apra-fleet-us9.11)

- 3d: intra-workspace ack does not verify the target member belongs to the
  calling machine; and defense-in-depth `presence.announce` member_id
  workspace validation. Intra-tenant integrity, low severity.
