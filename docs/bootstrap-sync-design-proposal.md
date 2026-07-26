# Bootstrap/Sync Design Proposal: apra-fleet.exe <-> fleet-dashboard

- Status: AGREED (round 2, 2026-07-05 -- fleet-dashboard's round 2
  response gave zero open objections; see fleet-dashboard's
  docs/bootstrap-sync-design-response.md for both rounds in full)
- Proposed by: apra-fleet-reorg
- Date: 2026-07-05
- Depends on / references: docs/api-contract-reconciliation.md (this repo),
  fleet-dashboard's docs/architecture.md, docs/cross-repo-design-protocol.md
  (this repo), fleet-dashboard's docs/bootstrap-sync-design-response.md
  (round 1 response), fleet-dashboard-anw (filed this round: members.ts
  missing ironWall), beads apra-fleet-yeb (epic) / apra-fleet-48p (this
  design task)
- Follows from: the product-owner directive that fleet-dashboard is the
  sole persistence layer for workspace/project/member/secret config, and
  the subsequent scoping decision that (a) apra-fleet.exe's standalone
  (no-cloud) mode is unchanged and SSH stays permanent, (b) hub-service
  retires to reference-only, (c) relay/NAT-traversal execution is
  deferred, and (d) the near-term goal is specifically: easy bootstrap of
  workspaces/members/projects, plus durable off-device storage of that
  config -- NOT a new execution transport.

## Round 1 response summary (fleet-dashboard, 2026-07-05)

Full response: fleet-dashboard's docs/bootstrap-sync-design-response.md.
Verdicts: Q1 AGREE (1b first, 1a later), Q2 AGREE, Q3 NEEDS-DISCUSSION
(blocking -- member JWTs have zero read access today), Q4 AGREE, Q5 AGREE
with two hard caveats. Plus five findings the proposal missed. Every item
below is addressed explicitly, not silently dropped.

## What this proposal is asking fleet-dashboard to agree on

apra-fleet.exe needs a well-defined way to (1) enroll into a fleet-dashboard
workspace, (2) pull workspace/member/project config down into a local JSON
cache, and (3) optionally push local registrations up so they're durable.
This proposal is the apra-fleet-reorg side's answer to those three
questions, plus a policy question about sync behavior. All five open
questions below need fleet-dashboard's explicit concurrence before
apra-fleet-reorg starts building against any of them (see
docs/cross-repo-design-protocol.md).

## Open questions

### 1. Enrollment / auth flow

**Proposal:** apra-fleet.exe's existing `apra-fleet join <token>` CLI
command (today pointed at apra-fleet-reorg's own retiring hub-service)
gets repointed at fleet-dashboard. Two candidate shapes, in preference
order:

- **1a (preferred).** fleet-dashboard's contract grows a short-lived,
  single-use enrollment-token endpoint (mint via the dashboard UI or an
  authenticated session call; exchange via an unauthenticated POST with
  just the token, matching the security shape apra-fleet-reorg's own
  enrollment.ts already proved out: atomic single-use claim, short TTL,
  workspace-scoped). This is docs/api-contract-reconciliation.md's item
  22, previously recommended CONTRACT ADAPTS.
- **1b (fallback, if 1a is not near-term feasible).** apra-fleet.exe uses
  fleet-dashboard's EXISTING `POST /v1/ws/:id/members` (member
  registration, JWT issued once) directly -- meaning a human with
  dashboard access registers the member first (getting a token), then
  hands that raw member JWT to the device out of band (copy-paste or a
  config file), rather than a short-lived exchange token. This is a real,
  named security downgrade (a long-lived credential in a copy-paste
  instead of a short-lived exchange token) and apra-fleet-reorg would
  only accept it as an explicitly temporary bridge, not a permanent
  answer.

**Question for fleet-dashboard:** does 1a fit your near-term roadmap, or
should apra-fleet-reorg build against 1b first with an explicit plan to
migrate to 1a once it exists?

**RESOLVED (round 1, AGREE):** build against 1b now; migrate to 1a once
fleet-dashboard's enrollment-token endpoint exists (unbuilt,
unroadmapped as of round 1 -- confirmed by fleet-dashboard's own review
against their real handlers, serverless.yml routes, and full beads
history). **Blocking prerequisite surfaced by the review, not by this
proposal:** 1b depends on `POST /v1/ws/:id/members`, which fleet-dashboard's
review found is missing its `ironWall` workspace-isolation check (any
approved user can register a member in any workspace by id) -- filed as
fleet-dashboard-anw (P1, security). **apra-fleet-reorg will not build
against 1b's enrollment flow until fleet-dashboard-anw is closed** --
depending on an endpoint with a known workspace-isolation hole would
mean enrollment inherits that hole.

### 2. What gets cached locally, and where

**Proposal:** extend `src/services/registry.ts`'s existing `registry.json`
shape (or add a clearly-named sibling file, e.g. `cloud-cache.json`) with
the workspace/member/project data pulled from fleet-dashboard. No local
relational database in any case, per the product-owner directive --
this question is purely "one JSON file or two," not "JSON vs. a DB."

**Question for fleet-dashboard:** none, technically -- this is
apra-fleet-reorg's own internal storage choice and shouldn't require your
concurrence. Included here for visibility only, since the shape of what
we cache depends on your answers to questions 3-4 below.

**RESOLVED (round 1, AGREE, two caveats folded in):** confirmed no
concurrence needed. The cache layer will (a) preserve and round-trip
unknown fields rather than dropping them (matches the contract's
additive-only evolution rule, applied API-wide per fleet-dashboard's
review, not just to installers), and (b) not assume `GET members`/
`GET projects` are always complete unpaginated arrays -- the cache
schema accounts for eventual cursor pagination matching `GET activity`'s
existing shape, even though neither endpoint paginates today.

### 3. Sync direction and conflict resolution

**Proposal:** pull-primary, push-on-explicit-action. Concretely:
- Workspace/member/project **reads** always prefer fleet-dashboard's data
  when SaaS-connected and reachable; the local cache is a read-through
  cache for offline/stale operation only (see question 5), never a
  competing source of truth.
- Local **writes** (e.g. registering a new member via today's existing
  local flow) do NOT silently create a phantom local-only record when
  SaaS-connected -- they call fleet-dashboard's create endpoint directly,
  and the local cache reflects the result. There is no "local record
  first, sync later" reconciliation to design, because there is no
  local-authoritative write path once SaaS-connected.
- This sidesteps most conflict-resolution complexity (no last-write-wins,
  no merge) by design: fleet-dashboard is simply authoritative for writes
  too, not just reads, whenever it's reachable.

**Question for fleet-dashboard:** does this match your own mental model
of the relationship (dashboard/API is authoritative, device is a thin
client), or do you expect apra-fleet.exe to support any local-only
mutation path while SaaS-connected that would need real reconciliation?

**Round 1 verdict: NEEDS-DISCUSSION (the blocking item).** The model
matched perfectly -- fleet-dashboard confirmed no local-authoritative
write path is expected anywhere. What made the plan unimplementable as
written: **member JWTs have zero read access today.** `memberAuthGuard`
protects only `connect`/`heartbeat`/`POST usage`/`POST activity`; every
list/read route (`GET members`, `GET projects`, `GET workspaces`) and
`POST members` (create) are session-cookie-only. A device holding only a
member JWT cannot pull config, and cannot push a new member registration
either.

**RESOLUTION PROPOSED (round 2), adopting fleet-dashboard's own suggested
direction:**

- **Pull side:** fleet-dashboard builds a dedicated, member-JWT-scoped
  `GET /v1/ws/:id/bootstrap` snapshot endpoint (scoped to the token's
  `ws` claim via `memberAuthGuard`, the same pattern `connect`/`heartbeat`
  already use) returning the workspace's members + projects in one call,
  rather than exposing member-JWT variants of every existing session-only
  list route. Chosen over member-JWT list-endpoint variants because it's
  smaller new surface area, and it pairs naturally with a single JSON
  cache file (question 2) -- one endpoint, one cache write, not N
  endpoints reconciled into one file.
- **Push side -- privilege question resolved, not left open:** a device
  does **not** register other members using its own member JWT. Fleet-
  dashboard's review named the real risk directly: a newly-created
  member's once-shown JWT would flow through the REGISTERING device, a
  privilege-escalation shape apra-fleet-reorg does not want to introduce.
  **Member registration stays human/session-only** (today's `POST
  /v1/ws/:id/members` via the dashboard), full stop. This means
  apra-fleet-db4 ("push-sync") is narrower than originally scoped: there
  is no device-initiated "register a new member with the cloud" call.
  What a SaaS-connected device DOES still need to push, if anything, is
  scoped separately in the pull/bootstrap design task rather than assumed
  here -- e.g. presence/status is already covered by the existing
  `connect`/`heartbeat` member-JWT routes, which this proposal does not
  change.

**Still open for round 2 confirmation:** does fleet-dashboard agree with
the `GET /v1/ws/:id/bootstrap` shape (vs. member-JWT list-endpoint
variants), and with resolving push-registration to human-session-only
rather than building a device-safe variant of it?

### 4. Sync trigger: automatic vs. explicit

**Proposal:** automatic on every relevant local read (list_members,
list_projects, etc. transparently refresh from fleet-dashboard when
SaaS-connected and reachable, falling back to cache on failure --
see question 5), but explicit for the INITIAL enrollment decision itself
(a device does not become SaaS-connected by accident; `apra-fleet join
<token>` is the one deliberate action that flips a device into
SaaS-connected mode). No background polling daemon, no periodic sync job
-- sync happens lazily, on demand, tied to actual local commands a user
runs.

**Question for fleet-dashboard:** any rate-limit or caching-header
guidance we should design around, given this implies fleet-dashboard's
read endpoints may be called somewhat frequently by an interactively-used
CLI (not a polling background service, but also not a single fetch at
startup)?

**RESOLVED (round 1, AGREE):** confirmed zero throttle/burst/usage-plan/
quota configuration exists today (verified against `serverless.yml` and
`config/*.yml`), and zero `Cache-Control`/`ETag` support (every read is a
live DynamoDB query) -- an interactively-driven CLI refreshing on local
commands is fine at that rate. Design commitment: honor `Retry-After` on
429 (contract-reserved, not yet enforced) and the documented 1s-start/
60s-cap/jittered backoff on 5xx/network failure; do not hardcode an
assumption that 429 never happens, since fleet-dashboard flagged that
real throttling likely arrives alongside the enrollment-exchange endpoint
(question 1's 1a) once it's unauthenticated.

### 5. Offline / failure behavior

**Proposal:** fail-open. If fleet-dashboard is unreachable, apra-fleet.exe
falls back to the last-synced local cache and continues operating,
exactly as standalone mode would, rather than blocking local commands on
network reachability. This matches the standing requirement that
standalone behavior is never regressed -- a SaaS-connected device that
temporarily can't reach the cloud should degrade to "acts like standalone
until connectivity returns," not "refuses to function."

**Question for fleet-dashboard:** none functionally required from your
side, but flagging so you're aware apra-fleet.exe will sometimes act on
stale cached workspace/member/project data during an outage, and any
UI/messaging on your side about "last synced at X" should assume the
device-side cache can lag your API by an unbounded amount during a real
outage, not just typical request latency.

**RESOLVED (round 1, AGREE with two caveats, both adopted as hard
requirements, not left as suggestions):**

1. **Fail-open triggers ONLY on network failure/5xx, never on 401.**
   Rotation has no grace period (`rotate` overwrites `currentJti`
   atomically; the very next call with the old token hard-fails) and the
   contract explicitly requires surfacing an operator-visible
   "token needs rotation" state on 401, not retrying silently. Lumping
   401 into "unreachable -> operate on cache" would silently mask a
   deliberately revoked credential -- treated as a correctness bug in
   this design, not a style preference.
2. **"Cloud unreachable" and "cloud reachable, credential dead" are two
   distinct device states with distinct UX**, per fleet-dashboard's
   finding D: since member JWTs expire in 30 days and rotation requires a
   human session (device cannot self-renew), an outage-then-reconnect
   with an expired/rotated token must prompt for re-enrollment/rotation,
   not retry the sync loop forever indistinguishably from a network blip.

## Status after round 2 -- AGREED

All 5 questions settled with zero open objections from fleet-dashboard's
round 2 response. Two prerequisites now block implementation, both on
fleet-dashboard's side, both already correctly sequenced into the beads
below rather than blocking this design's AGREED status:

1. **fleet-dashboard-anw** (ironWall missing on members.ts) must close
   before apra-fleet-6bf (enrollment) builds against 1b.
2. **`GET /v1/ws/:id/bootstrap`** does not exist yet and is fleet-
   dashboard's own new work (their round 2 response commits to filing a
   bead for it) -- apra-fleet-aho (pull-sync) cannot start until it
   exists.

Residual, non-blocking item flagged by fleet-dashboard's own review:
whether members CRUD should ALSO require an owner/admin role (not just
workspace membership) is their policy decision to make when fixing anw --
does not affect this proposal's correctness either way.

## What apra-fleet-reorg commits to once this reaches AGREED status

- Bead apra-fleet-6bf (repoint enrollment), apra-fleet-aho (pull-sync),
  and apra-fleet-db4 (push-sync) start implementation only after this
  doc's status is AGREED, per docs/cross-repo-design-protocol.md.
- Any DISAGREE or NEEDS-DISCUSSION verdict on the above blocks those
  three beads until resolved -- this proposal is not a soft suggestion
  apra-fleet-reorg will proceed with regardless of your response.
- apra-fleet-6bf specifically also waits on fleet-dashboard-anw closing.
