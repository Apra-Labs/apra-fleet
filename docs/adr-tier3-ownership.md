<!-- llm-context: Short, durable ADR distilling the final tier-3 ownership decision
     for the hub-and-spoke / SaaS architecture. This is the condensed answer; the
     full negotiation history and per-item rationale live in
     docs/api-contract-reconciliation.md (sections 1.5-1.6) and
     docs/hub-spoke-master-plan.md's 2026-07-05 update note. Read this file first
     for "what is true now"; read those files only if you need the "how we got
     here" history. -->
<!-- keywords: ADR, tier-3, persistence, fleet-dashboard, hub-service, reference-only,
     SSH, relay, bootstrap, sync, apra-fleet.exe -->

# ADR: Tier-3 Persistence Ownership (fleet-dashboard vs hub-service)

**Status:** Accepted (2026-07-05)
**Decided by:** product owner directive, epic `apra-fleet-yeb`
**Supersedes:** the self-host-parity premise of `docs/adr-hub-persistence.md` and
the "SSH is being replaced by hub relay" framing of `docs/hub-spoke-master-plan.md`

## Decision

1. **fleet-dashboard is the sole system of record** for all workspace, project,
   member, and secret configuration. There is exactly one persistence layer for
   this data -- not two independent implementations reconciled after the fact.
2. **`apra-fleet.exe` is a per-device singleton with exactly two modes:**
   - *SaaS-connected*: a client of fleet-dashboard's published API contract,
     authenticating with a member JWT that fleet-dashboard issues. It never
     maintains its own database copy of workspace/project/member config.
   - *Standalone*: no cloud backend; any local state lives in plain JSON files
     on disk.
   - In neither mode does `apra-fleet.exe` own a relational database of its own.
3. **`src/hub-service/` (the Postgres-backed service built during the
   hub-and-spoke migration sprint) is retired to reference-only status**
   (`apra-fleet-yp3`). It is not deployed to fleet.apralabs.com and receives no
   further production feature work. Its code and its 2133 tests are kept,
   unmodified and undeleted, because they are a verified specification of the
   wire-protocol and workspace-isolation semantics (at-least-once relay
   delivery, TTL/redelivery, JWT-scoped isolation) that whichever team builds
   the production tier-3 equivalent (fleet-dashboard) can build against.
4. **SSH is not deprecated.** It remains a first-class, permanent execution
   transport for standalone `apra-fleet.exe` (`RemoteStrategy`/SSH,
   `registry.json`). The SSH-to-hub-relay migration that earlier planning docs
   described is deferred (tracked as `apra-fleet-8rs`), not cancelled by
   omission and not silently abandoned -- it is an explicit, named deferral.
5. **Near-term product focus is bootstrap/sync**, not relay/execution-transport
   replacement: easy workspace/member/project bootstrap via fleet-dashboard's
   web UI, and durable off-device storage of that configuration. See
   `docs/bootstrap-sync-design-proposal.md` for the concrete design.

## Why

The hub-and-spoke migration sprint built a working, security-reviewed
Postgres-backed hub service in parallel with fleet-dashboard building the same
tier-3 role against its own published contract. Reconciling two independent
backends after the fact (see `docs/api-contract-reconciliation.md` for the
full 22-item gap analysis) is strictly more expensive, ongoing, integration
risk than declaring one system of record up front. The product owner's
directive resolves this by ownership, not by feature-by-feature negotiation:
fleet-dashboard owns configuration persistence; `apra-fleet.exe` is a
well-behaved client (or standalone with local JSON) and never a competing
database.

## What this does NOT mean

- It does not mean `src/hub-service/`'s code was wrong or wasted: its wire
  protocol, presence/relay model, and workspace-isolation guarantees are
  considered a genuinely stronger design than the contract's original REST
  connect/heartbeat sketch, and `docs/api-contract-reconciliation.md`
  recommends the contract absorb that architecture even though hub-service
  itself won't ship it.
- It does not mean SSH support is going away, or that existing standalone
  `apra-fleet.exe` installs need to change anything.
- It does not mean relay/NAT-traversal work is permanently rejected -- it is
  deferred, and the deferred work is tracked, not lost.

## Non-obvious constraints for future contributors

- Do not resurrect `src/hub-service/` as a deployment target without a new,
  explicit product-owner decision reversing this ADR. Bug fixes and
  reference-value maintenance (keeping its tests green) are fine; new
  production features routed through it are not.
- Any code path that would make `apra-fleet.exe` persist workspace/project/
  member/secret state to a relational database it owns is a violation of
  this decision, regardless of how convenient it looks locally.
- When fleet-dashboard's real bootstrap/sync API contract lands, the
  enrollment/JWT-issuance code paths in `src/hub-service/` (`session-jwt.ts`,
  `member-tokens.ts`, the OAuth/admin-approval half of `users.ts`) are the
  parts most likely to need deleting outright rather than adapting, since
  they mint credentials and manage configuration hub-service should not own
  going forward. See `docs/api-contract-reconciliation.md` section 1.5.2 for
  the item-by-item breakdown.

## See also

- `docs/api-contract-reconciliation.md` -- full 22-item hub<->dashboard gap
  analysis, negotiation history, and the verbatim product-owner directive
  (sections 1.5-1.6).
- `docs/hub-spoke-master-plan.md` -- original 3-tier design, now annotated
  with this decision's correction.
- `docs/adr-hub-persistence.md` -- superseded persistence ADR (Postgres vs
  Redis vs NATS strawman), kept for historical record.
- `docs/hub-service-deployment.md` -- reference-only status note and
  dev/test-only deployment instructions for `src/hub-service/`.
- `docs/bootstrap-sync-design-proposal.md` -- the concrete near-term design
  this decision unblocks.
