<!-- llm-context: Architecture Decision Record evaluating the persistence backend for
     fleet.apralabs.com (the hub, tier 3 of the hub-and-spoke architecture): Postgres-only
     vs Postgres+Redis vs Postgres+NATS, against presence, at-least-once message relay,
     JWT issuance/revocation, workspace/member CRUD, audit/activity log, and usage-ledger
     responsibilities. Answers hub-spoke-master-plan.md section 6 / beads item 3
     (apra-fleet-us9.3). Read together with docs/hub-spoke-wire-protocol.md (the wire
     contract this backend must satisfy) and docs/hub-spoke-master-plan.md (the mission). -->
<!-- keywords: ADR, persistence, Postgres, Redis, Redis Streams, NATS, NATS JetStream,
     fleet.apralabs.com, hub, presence, message relay, at-least-once, self-host parity -->
<!-- see-also: hub-spoke-master-plan.md (section 6, the strawman this ADR resolves),
     hub-spoke-wire-protocol.md (section 5-6, delivery/TTL requirements this backend
     must satisfy) -->

# ADR: Hub Persistence -- Postgres-only vs Postgres+Redis vs Postgres+NATS

**Status:** Superseded (2026-07-05) -- see update note below.
**Date:** 2026-07-04
**Authors:** Azure Pipeline (doer) + human founder input via hub-spoke-master-plan.md

> **2026-07-05 update (apra-fleet-yp3/qaz, epic apra-fleet-yeb):** the product
> owner's authoritative directive (docs/api-contract-reconciliation.md section 1.5;
> see that section's sourcing note -- this repo has not independently verified
> fleet-dashboard's private implementation, only its published contract) makes
> fleet-dashboard the sole tier-3 persistence layer for workspace/project/member/
> secret configuration; `apra-fleet.exe` never owns a Postgres database of its own.
> That supersedes this ADR's premise that `src/hub-service/` (Postgres-only,
> evaluated below) would be *the* deployed persistence backend for
> fleet.apralabs.com -- hub-service is now reference-only
> (docs/hub-service-deployment.md). The subsequent scoping decision
> (docs/api-contract-reconciliation.md section 1.6) also defers the relay/envelope
> subsystem this ADR's message-relay responsibility (item 2) was designed for --
> SSH stays the permanent execution transport, and relay/NAT-traversal is tracked
> separately (`apra-fleet-8rs`), not an active near-term concern. The evaluation
> below (why plain pub/sub is disqualified, at-least-once/TTL/redelivery
> requirements, self-host-parity analysis) remains a useful specification of the
> semantics a real backend must satisfy; it is not a live deployment decision
> anymore. Read docs/api-contract-reconciliation.md sections 1.5-1.6 first for
> current scope.

## Context

fleet.apralabs.com (tier 3, "the hub") must serve five responsibilities for every
connected spoke (apra-fleet.exe, tier 2):

1. **Presence** -- which machines/members are currently connected (volatile,
   TTL-keyed, high write rate at scale: one heartbeat per spoke every ~15s per
   docs/hub-spoke-wire-protocol.md section 4).
2. **At-least-once message relay** -- send_message, execute_command, and
   execute_prompt routing between spokes in the same workspace. Plain pub/sub
   is DISQUALIFIED: a spoke that is briefly disconnected must not silently
   lose a queued execute_command (docs/hub-spoke-wire-protocol.md section 5-6
   already specifies FIFO-per-target-member, ack-then-retire, redeliver-until-
   acked semantics that any candidate backend must implement).
3. **JWT issuance and revocation state** -- user accounts, signing keys,
   token lifecycle (issuance is an auth-service concern, not a data-store
   concern) plus a fast revoked-jti lookup on every request.
4. **Workspace/member/machine CRUD** -- the durable system of record: who is
   in which workspace, tied to (eventually) billing and compliance.
5. **Audit/activity log** -- append-only, queryable by member/time/outcome,
   exportable, compliance-adjacent, and feeds the web dashboard's activity
   view and the per-(project,member) usage/cost ledger
   (hub-spoke-master-plan.md Addendum item 3 / beads item us9.15).

The human's original strawman was "a managed Redis instance." This ADR takes
that strawman as INPUT, not output (per master-plan section 6's closing
instruction), and evaluates it honestly against all five responsibilities,
plus a value the mission states explicitly matters: **self-host parity** --
a single-binary hub with embedded/managed Postgres should beat a
multi-service compose file for anyone self-hosting fleet.apralabs.com's
open-source counterpart.

### Non-negotiable constraints

- Delivery guarantee for message relay MUST be at-least-once (ruling out bare
  pub/sub outright, in Redis or anywhere else).
- JWT issuance requires a real auth service (accounts, signing keys,
  lifecycle) -- no candidate below stores this in a cache-shaped datastore;
  it always lives in the relational system of record.
- CRUD and audit data need durable, queryable, relational storage --
  RDB/AOF-class persistence (periodic snapshot or ~1s write window loss) is
  not acceptable for "who is in which workspace" or a compliance-adjacent
  log.
- Self-host parity: fewer required services is a a tie-breaker, not just an
  ops nicety, when two options are otherwise equivalent on delivery
  guarantees.

## Options evaluated

### Option A: Postgres-only

Postgres as the sole datastore for all five responsibilities:

- **CRUD, audit, usage ledger:** natural fit -- exactly what Postgres is for.
- **JWT revocation:** a `revoked_tokens(jti, expires_at)` table with an index
  on `jti`, pruned by a periodic job (or partitioned by expiry) -- no
  meaningfully different from a Redis TTL-keyed set for this specific access
  pattern (point lookup by primary key) at the scale in view.
- **Presence:** a `presence(machine_id, member_id, status, last_seen)` table,
  updated on every heartbeat, read on every routing decision. This is the
  first real question mark: a write every 15s per spoke is fine at tens of
  workspaces / hundreds of members (the stated "realistic early scale" in
  master-plan section 6), but a HOT UPDATE-heavy table needs care (autovacuum
  tuning, or `UNLOGGED` table since presence is explicitly volatile and does
  not need WAL durability -- an unlogged table survives a graceful restart
  but not a crash, which is an ACCEPTABLE loss for presence specifically,
  unlike every other responsibility here).
- **Message relay:** a `relay_queue(id, workspace_id, target_member_id,
  envelope, status, created_at, acked_at)` table, with a `LISTEN/NOTIFY`
  channel per target member (or a shared channel filtered client-side) to
  wake a spoke's SSE-serving connection without polling. This satisfies the
  wire protocol's FIFO-per-target-member + ack-then-retire requirement
  directly: `ORDER BY id` per `(workspace_id, target_member_id)`, delete/mark
  on ack, a scheduled sweep for TTL-expired rows. LISTEN/NOTIFY payloads are
  capped (8000 bytes in Postgres) -- fine here, since the notification only
  needs to carry "new envelope for target X", not the envelope body itself;
  the receiving connection then does a `SELECT ... WHERE target_member_id=X
  AND status='pending' ORDER BY id`.

**Honest risk:** Postgres LISTEN/NOTIFY does not guarantee delivery to a
notify listener that is not currently connected (by design -- it is a
signaling mechanism, not a queue). This is FINE for this design specifically
BECAUSE the actual envelope data lives durably in the table regardless of
whether a NOTIFY was missed: a reconnecting spoke's tier-2 code, on
`presence.announce`, can (and per docs/hub-spoke-wire-protocol.md section 4
already does) trigger an explicit "flush anything queued for me" read
against the table, independent of whether a NOTIFY arrived. NOTIFY is a
latency optimization (near-instant push when connected) with the table as
the correctness backstop (a poll-on-reconnect fallback) -- this is a
sound pattern, not a gap, provided the reconnect-flush behavior is actually
implemented (it is spec'd; see wire-protocol.md section 4 "Reconnect").

### Option B: Postgres + Redis (Streams + consumer groups)

Postgres remains system of record for CRUD/audit/usage/JWT-issuance.
Redis Streams (`XADD` per target-member stream, `XREADGROUP` consumer groups
for ack/retry, `XCLAIM` for redelivery) takes over presence and message
relay.

- **Presence:** Redis hashes + TTL keys are a strong, idiomatic fit (master
  plan section 6 already says so) -- better throughput ceiling than a hot
  Postgres table at very large scale, though "very large scale" is not
  where this product is starting.
- **Message relay:** Redis Streams + consumer groups give genuine
  at-least-once with acks and replay -- matches the wire protocol's
  requirements well, PROVIDED per-workspace streams + per-target-member
  consumer groups + dead-letter handling are built out (this is real,
  non-trivial application code sitting ON TOP of Redis primitives, not a
  feature Redis provides out of the box -- master plan section 6's "you are
  now building a small message broker on Redis primitives" caveat stands).
- **Cost:** a second stateful service to run, monitor, back up (for the
  consumer-group offsets, which ARE meaningful state, not just cache), and
  reason about during failover, for a self-hosted deployment.

### Option C: Postgres + NATS (JetStream)

Same split as Option B, but JetStream instead of Redis Streams for
presence + relay.

- **Message relay:** JetStream's consumer model (durable consumers, ack
  policies, work-queue retention) is arguably a MORE NATURAL fit for
  at-least-once relay than Redis Streams -- it is a real message-queue
  product, not a cache repurposed into one. Built-in dedup
  (`Nats-Msg-Id` header + a dedup window) maps directly onto this design's
  `envelope_id` idempotency key (wire-protocol.md section 5).
  Multi-tenant subject hierarchies (`ws.<workspace_id>.member.<member_id>`)
  map cleanly onto the workspace/member addressing scheme.
  Presence: JetStream KV (built on the same engine) can serve the same
  role Redis hashes+TTL would, without a second product family.
- **Cost:** same "second stateful service" tax as Option B, arguably a less
  familiar operational surface for most teams than Redis (which is close to
  ubiquitous), though NATS' single-binary-with-embedded-JetStream story is
  itself a point FOR self-host parity (one extra binary, not a cluster to
  operate) if it is ever needed.

## Decision

**Postgres-only for the initial hub (fleet.apralabs.com MVP and the
self-hosted OSS path), with an explicit, benchmarked trigger for adding
Redis Streams or NATS JetStream later if Postgres-only messaging shows
strain.** This matches master-plan section 6's closing recommendation and
this ADR affirms it after the more detailed option-by-option evaluation
above; it is not a rubber stamp of the strawman, since the strawman was
"just Redis" and this decision explicitly is not that.

Rationale, in priority order:

1. **JWT issuance and CRUD/audit already require Postgres regardless of which
   option wins.** Every option here keeps Postgres as system of record. The
   only question this ADR actually needs to answer is whether presence +
   relay ALSO live there, or need a second stateful service on day one. That
   reframing matters: this is not "Postgres vs Redis vs NATS" in the
   abstract, it is "one stateful service vs two," with Postgres being the
   one service in every option.
2. **Self-host parity is a stated product value, not a nicety.** A
   single-binary hub with embedded/managed Postgres is a materially simpler
   self-hosting story than a three-service compose file (hub + Postgres +
   Redis/NATS). At the realistic early scale named in the master plan (tens
   of workspaces, hundreds of members), this is not a premature
   simplification -- it is the RIGHT scale for the simpler option to win.
3. **LISTEN/NOTIFY-plus-durable-table is a sound at-least-once design for
   this specific problem**, not a workaround: the correctness path (the
   queue table with FIFO ordering, ack-then-retire, TTL sweep) does not
   depend on NOTIFY delivery at all; NOTIFY is a pure latency optimization.
   This directly satisfies docs/hub-spoke-wire-protocol.md section 5-6's
   requirements without a second product.
4. **The escape hatch is explicit and benchmarked, not vague.** Section 7
   below states the exact metrics and thresholds that would trigger adding
   Redis Streams or NATS JetStream, so "start simple" does not become
   "never revisit this."
5. **Between Redis Streams and NATS JetStream, if/when a second service
   becomes necessary:** lean NATS JetStream over Redis Streams, because (a)
   its ack/dedup/durable-consumer model is a closer semantic match to this
   design's at-least-once + envelope_id-idempotency requirements than Redis
   Streams' more do-it-yourself consumer-group bookkeeping, and (b) its
   embedded/single-binary deployment story is a better self-host-parity fit
   than a Redis cluster. This is a soft preference for LATER, not part of
   the MVP decision, since the MVP decision is "neither, yet."

## What this means for the hub service MVP (apra-fleet-us9.4)

- Tables to design first: `workspaces`, `machines`, `members`,
  `revoked_tokens`, `presence` (unlogged), `relay_queue`, `audit_log`,
  `usage_ledger` (feeds beads item us9.15).
- `relay_queue` schema must satisfy docs/hub-spoke-wire-protocol.md
  sections 3, 5, and 6 directly: `envelope_id` (unique per
  `(workspace_id, target_member_id)` for idempotent re-admission), `kind`,
  `payload` (jsonb), `status` (`pending|delivered|acked|expired`),
  `created_at` (TTL is measured from THIS, hub admission time, never the
  originator's `ts`), `ttl_ms`, `acked_at`. An index on
  `(target_member_id, status, id)` serves both the FIFO delivery read and
  the reconnect-flush read from the same table shape.
- `presence` as `UNLOGGED` is a deliberate, named exception to "Postgres
  durability everywhere" -- it is the one responsibility where losing state
  on a hard crash is explicitly acceptable (spokes reconnect and
  re-announce; wire-protocol.md section 4 already designs for this as the
  normal recovery path, not a failure mode).
- LISTEN/NOTIFY channel naming: one channel per workspace_id (not per
  member, to bound channel count), with the connection holding that
  workspace's spokes doing a client-side filter by target_member_id on
  notify payloads -- keeps the fan-out mechanism simple while the actual
  correctness lives in the table query, not the channel.

## Alternatives considered and rejected outright

### Bare Redis (the original strawman, unqualified)

Rejected as the WHOLE answer (not as a future option) because it cannot do
JWT issuance/auth at all, and its RDB/AOF persistence characteristics are
the wrong durability class for CRUD/audit system-of-record data (master
plan section 6's table already makes this case in detail; this ADR does not
repeat it beyond affirming the conclusion).

### MongoDB / another document store as system of record

Not evaluated in depth: the CRUD shape here (workspaces -> projects ->
members, JWT/revocation, audit log) is naturally relational
(hub-spoke-master-plan.md Addendum item 2's hierarchy correction makes this
more true, not less -- it is an explicit tree with real foreign-key-shaped
relationships), and the team already runs Postgres-adjacent tooling
elsewhere in the Apra stack (informal prior, not independently verified in
this ADR's research, but not contradicted by anything found either).

### Kafka

Considered as a NATS/Redis-Streams alternative for the relay only;
rejected from consideration at this ADR's scope because it is a
heavier operational footprint than either NATS or Redis for the message
volumes in view, and does not improve self-host parity versus the
Postgres-only option this ADR already prefers for the MVP -- if the
benchmarked trigger in section "escape hatch" below is ever hit, NATS
JetStream is the recommended next step to evaluate first, not Kafka.

## Escape hatch: when to revisit this decision

Add Redis Streams or NATS JetStream (per the soft preference above) when
ANY of the following is observed against the Postgres-only MVP, not before:

1. **Presence write latency** under realistic heartbeat load (one write per
   spoke per ~15s, per wire-protocol.md section 4) measurably degrades
   `relay_queue` read/write latency on the SAME instance (i.e., presence
   traffic contending with relay traffic on shared Postgres resources).
2. **Relay queue depth** routinely approaches the per-member cap defined in
   wire-protocol.md section 6 (1000 envelopes / 8 MiB) under NORMAL
   operation (not as a defensive cap being correctly exercised against an
   actually-offline spoke, but as a sign of undersized headroom).
3. **LISTEN/NOTIFY fan-out** (one channel per workspace) shows measurable
   notification latency growth as concurrent connected-spokes-per-workspace
   grows, past whatever the then-current largest real workspace's spoke
   count is.
4. Any of the above is observed in PRODUCTION telemetry, not synthetic
   benchmarking alone -- this ADR explicitly asks for a real signal before
   taking on a second stateful service, per the self-host-parity value this
   decision is built around.
