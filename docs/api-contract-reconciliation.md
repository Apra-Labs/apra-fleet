# API Contract Reconciliation: apra-fleet-reorg <-> fleet-dashboard

- **Status:** Proposal for joint review by both teams
- **Date:** 2026-07-05
- **Scope:** The HTTP/WS boundary between `apra-fleet.exe` + hub-service (repo `apra-fleet-reorg`, branch `feat/hub-spoke-migration`, `src/hub-service/`) and the fleet.apralabs.com web console (repo `fleet-dashboard`, whose `docs/api-contract.md` is the published contract).
- **Ground truth:** Every gap below was verified against the actual code of both repos, not against docs alone.

---

## 1. Executive Summary

Two teams built the two halves of fleet.apralabs.com independently. `fleet-dashboard` published an API contract (`docs/api-contract.md`) and built a Lambda/DynamoDB backend and Next.js frontend against it. `apra-fleet-reorg` built a Postgres-backed hub-service in an intensive hub-and-spoke migration sprint (2133 passing tests, tsc clean) that implements *most* of the same surface -- but with no URL versioning, a different auth transport, a stubbed OAuth flow, several contract endpoints never wired to HTTP, and an entire relay/wire-protocol subsystem the contract has never heard of.

The gap is 22 items: 6 transport/protocol mismatches, 8 missing endpoints, 6 shape mismatches, and 2 undocumented capabilities. None of them are irreconcilable, but two are security-critical (the OAuth stub and the session-transport question) and must be settled before either side ships anything user-facing.

**Overall recommendation: a phased reconciliation with a clear rule of deference.**

1. **For request/response *shapes*, naming, versioning, and error envelopes, the hub defers to the contract.** The contract is published, the dashboard is built against it, and most of these fixes are mechanical (rename a key, add a prefix, wrap a response). Roughly 13 of the 22 items fall here, including all of the "route exists at the data layer but was never wired to HTTP" debt (usage, activity, reject, create-workspace), which is simply unfinished work on the hub side and should be finished.

2. **For *architecture* -- how agents connect, stay present, and receive commands -- the contract defers to the hub.** The relay/envelope system (durable at-least-once queue, TTL, redelivery, security-reviewed workspace isolation) is a genuinely stronger design than the contract's naive REST `connect`/`heartbeat`, which has no reconnection or redelivery semantics at all. The contract should absorb it, not the reverse. About 7 items fall here.

3. **Two items need a design neither side currently has**: the live activity stream (recommend SSE, not the contract's WebSocket and not the hub's nothing) and the member-shape field set (rename on the hub, additive documentation in the contract).

4. **Security gates first.** The OAuth stub trusts client-supplied identity with zero verification -- it must never reach an environment holding real credentials. The cookie-vs-bearer decision has real XSS/CSRF tradeoffs and is settled explicitly in item 2, not hand-waved.

The action plan in section 4 sequences all 22 items into four tiers.

---

## 1.5 Fable's Review — fleet-dashboard Implementation Team Response

*Added 2026-07-05 by the fleet-dashboard implementer. First pass (below, superseded) speculated that `hub-service`'s independent Postgres-backed persistence was a deliberate "self-host parity" design after reading `docs/adr-hub-persistence.md`. **The product owner has since corrected that reading with an explicit, authoritative architecture directive, quoted verbatim below.** That correction changes several verdicts, not just the framing, so this section documents the corrected position first and marks which original per-item agreements it overrides.*

### 1.5.1 Authoritative architecture directive (product owner, 2026-07-05)

> fleet-dashboard is the only true persistence layer for all configuration (workspace, project, members, secrets etc.). apra-fleet.exe — a singleton running on a device — can run in 2 modes: with fleet-dashboard as a SaaS backend (JWT generated and used) or without JWT. In either case it should use local JSON files (not pgsql) to store the configuration. Everything which violates this must be corrected.

This is explicit, comes from the product owner, and supersedes both this document's premise and my own earlier "self-host parity" speculation below. Restated plainly:

- **fleet-dashboard owns all configuration data** — workspaces, projects, members, secrets, and (by extension) the OAuth/admin-approval identity model that gates access to them. There is exactly one system of record for this data, not two.
- **`apra-fleet.exe` is a singleton per device**, and it has exactly two modes:
  1. **SaaS-connected mode** — authenticates to fleet-dashboard with a member JWT (issued by fleet-dashboard, per the published contract) and treats fleet-dashboard's API as the source of truth for workspace/project/member configuration. It does not maintain its own copy of that data in a database.
  2. **Standalone mode (no JWT, no fleet-dashboard)** — operates without any cloud backend at all.
- **In *both* modes, any local state `apra-fleet.exe` itself needs lives in local JSON files on the device — never Postgres, never any other relational/server database.** A device-local singleton process does not need (and per this directive, must not have) a relational database of its own.

### 1.5.2 What this means for `hub-service` specifically — corrections to my first-pass agreements

Given the directive, `src/hub-service/`'s Postgres-backed `workspaces.ts`, `users.ts` (OAuth + admin approve/reject), `session-jwt.ts`, and `member-tokens.ts` are not a legitimate "self-hosted alternative implementation of tier 3" — they are exactly the kind of violation the directive names. Corrections to what I wrote in the (superseded) first pass below:

- **Item 3 (OAuth stub):** the corrected verdict isn't "make the stub real" — it's **remove OAuth from hub-service entirely.** OAuth sign-in authenticates a *human* to the *web console*; it is a fleet-dashboard concern by definition and has no reason to exist in a device-local singleton at all, secure or not. My earlier note validating "Option A, hub builds a real server-side flow" assumed hub-service should have some OAuth implementation; the directive says it shouldn't have one, period.
- **Item 5 (`iss` claim) and Item 6 (member JWT expiry):** my earlier claim that "the hub issues its own member JWT... is expected and correct for the self-hosted deployment path" is **retracted.** Under the directive, member JWTs are minted **only** by fleet-dashboard (`POST /v1/ws/:id/members`); `apra-fleet.exe` in SaaS-connected mode is a *client* presenting a JWT it received from fleet-dashboard, never an issuer of its own. `hub-service/session-jwt.ts` and `member-tokens.ts` minting tokens independently is the violation, not a parallel-but-valid implementation. The `iss`/expiry shape questions (items 5-6) still matter, but only for fleet-dashboard's own issuance — they are moot for hub-service once it stops issuing tokens itself.
- **Item 7 (create workspace), Item 14 (admin reject), Item 20 (workspace counts):** same correction. Workspace CRUD and admin user-approval are configuration-authority operations that belong solely to fleet-dashboard. `hub-service`'s `workspaces.ts` and the admin half of `users.ts` should be deleted in favor of `apra-fleet.exe` calling fleet-dashboard's real endpoints when SaaS-connected, and simply not offering workspace/admin management at all in standalone mode (there is no cloud workspace to manage without a cloud).
- **Item 9/10 (member connect/heartbeat / presence):** the relay-based presence mechanism (`presence.announce`/`presence.heartbeat` envelopes) is not itself a persistence-layer violation — presence is transient liveness signaling about an already-connected device, not "configuration." That part of my original agreement stands. What must change: presence state derived locally should still be reported *to fleet-dashboard* (via the contract's connect/heartbeat endpoints or an equivalent), not persisted independently as a competing system of record for member status.
- **Item 21 (wire-protocol relay) and Item 22 (enrollment):** command relay (envelopes/ack/stream) is legitimately local-device, real-time operational machinery, not "configuration" in the sense the directive addresses — I still read this as correctly hub-owned. However: (a) if `relay-queue.ts`/`presence.ts`/`audit-log.ts` currently persist to Postgres, that persistence must move to local JSON files per the directive's literal instruction ("it should use local json files (not pgsql) to store the configuration") — even if this data is more operational than configuration, the directive's blanket "not pgsql" is unambiguous and the safer reading is to apply it here too rather than carve out an exception; and (b) enrollment (`POST /ws/:id/enrollment-tokens`, `POST /join/exchange`) mints a *member identity + JWT* per item 22's own description — per the corrected directive, the JWT half of that exchange must come from fleet-dashboard, not from hub-service independently. Enrollment as a *local UX flow* (operator runs `apra-fleet join <token>`) can still be hub/agent-owned; the credential it ends in cannot be locally minted.
- **Items 1, 2, 4, 17, 19:** unaffected by this correction — these are shape/protocol-level fixes (versioning, cookie attributes, error envelope, installer fields, status enum) that apply regardless of which side ends up owning which data, and my original agreement on all of them stands as written below.

### 1.5.3 Net effect on this document's recommendations

This is larger than a per-item edit — it changes the shape of the reconciliation itself. Recommend the authors of this document (both teams, jointly) treat the corrected scope as: **`apra-fleet.exe`/`hub-service`'s job is to be a well-behaved *client* of fleet-dashboard's published contract when SaaS-connected, plus local-JSON-backed standalone operation when not — not a second implementation of fleet-dashboard's persistence responsibilities under any circumstance.** Concretely, that likely removes items 3, 5, 6, 7, 14, and 20 from "hub adapts its own competing implementation to match the contract" and replaces them with "hub-service deletes/replaces its independent workspace/OAuth/admin/JWT-issuance code with calls into fleet-dashboard's real API," which is a materially different (and larger, in a different way) engineering task than this document currently scopes for those items. Recommend a follow-up pass by both teams re-deriving the action plan (Section 4) against this corrected scope before treating the current Tier 0-3 breakdown as final.

## 1.6 Final scoping decision (product owner + user, 2026-07-05) -- supersedes the tier-ownership *and* the relay-urgency framing above

This section records the decision that actually shipped, reconciling 1.5's persistence directive with the working product (see beads epic `apra-fleet-yeb`, and `docs/hub-spoke-master-plan.md`'s 2026-07-05 update note, which points back here):

1. **Tier-3 ownership (unchanged from 1.5):** fleet-dashboard is the sole persistence layer for workspace/project/member/secret configuration. `apra-fleet.exe` is either a SaaS-connected client of fleet-dashboard's published contract (JWT issued by fleet-dashboard) or standalone with local-JSON state -- never a second relational system of record. Cross-checked directly against fleet-dashboard's own `docs/architecture.md` (DynamoDB-backed, OAuth + session-cookie auth already built, iron-wall workspace isolation already tested) -- this repo's docs should be read alongside that one, not in place of it.
2. **`src/hub-service/` retires to reference-only** (apra-fleet-yp3): valuable as a working proof of wire-protocol/security-isolation semantics (2133 passing tests), but not deployed and not extended further. See `docs/hub-service-deployment.md`'s top-of-file status note.
3. **SSH is NOT deprecated -- it stays permanent.** Section 5's framing above ("SSH-less fleet orchestration ... is the value proposition") is corrected here: today's standalone `apra-fleet.exe` (local `registry.json`, `LocalStrategy`, `RemoteStrategy`/SSH) continues to work exactly as-is, zero regression. SSH is a first-class execution transport, not a migration target being phased out.
4. **Relay/NAT-traversal command execution (the envelope/SSE system, items 9/10/21 above) is explicitly DEFERRED**, not urgently owned by this repo. fleet-dashboard's own bidirectional WebSocket relay is "designed, not yet built" per their `docs/architecture.md`; there is no need to build or maintain a competing relay here right now (tracked as the deferred child issue `apra-fleet-8rs`). Read this as superseding the "the relay is an asset; do not let contract convenience erode it" urgency in Section 5 below -- that analysis remains a correct description of the relay's technical merits, but it is no longer this repo's near-term priority.
5. **The near-term focus is the bootstrap/sync integration**: (a) easy bootstrap of workspaces/members/projects via fleet-dashboard's web UI instead of local-only CLI setup, and (b) durable off-device storage of that configuration -- see `docs/bootstrap-sync-design-proposal.md` for the agreed design (enrollment/auth flow, pull-sync, push-sync, sync policy), cross-linked with fleet-dashboard's `docs/bootstrap-sync-design-response.md` and `docs/architecture.md`.

A reader who wants the current, non-superseded state of tier ownership and scope should start at this section (1.6), then `docs/bootstrap-sync-design-proposal.md` for the concrete bootstrap/sync design, before reading the (now historical) items and Section 5 analysis below.

<details>
<summary>Superseded first-pass review (2026-07-05, kept for record — see 1.5.1/1.5.2 above for the corrected position)</summary>

*The paragraphs below assumed `hub-service`'s independent persistence was a deliberate, legitimate "self-host parity" architecture. The product owner has since corrected this; treat the items below as superseded except where 1.5.2 explicitly says a given point "stands."*

**A framing correction that matters more than any single item.** This document's premise ("two teams built the two halves of fleet.apralabs.com independently") undersells what's actually going on, and the undersell weakens the document's own case. Reading `src/hub-service/` alongside `docs/adr-hub-persistence.md` makes clear that `hub-service` is not confused scope creep or a misunderstanding of tier boundaries — it is a **deliberate, self-hostable Postgres-backed implementation of fleet.apralabs.com itself** (tier 3), built for the explicitly named "self-host parity" value: anyone should be able to self-host the open-source counterpart instead of depending on the managed SaaS. fleet-dashboard is the *other* implementation of that same tier-3 role — Next.js/Serverless/DynamoDB, currently the hosted SaaS. That reframes the stakes correctly: this isn't cleanup after two teams stepped on each other by accident, it is the necessary specification work for **one client (`apra-fleet.exe`) that must work identically against two independent backend implementations of one contract.** Recommend adding a sentence to this effect near the top of Section 1 — it is a stronger argument for "the contract is the single source of truth" than the document currently makes, and it forecloses a reader's natural objection ("why does a local hub need workspaces/OAuth/admin at all?") before it's asked.

With that framing, here is the item-by-item response from the side that has a fully built, tested, and independently-verified (Playwright e2e, ~330 tests) implementation to check claims against:

- **Item 1 (versioning), Item 4 (error envelope):** **AGREE, no notes.** fleet-dashboard's real handlers (`backend/src/handlers/*.ts`) return exactly `{ error: { code, message } }` on every route, and every route lives under `/v1`. Confirmed by direct code inspection, not just the published contract text.

- **Item 2 (cookie transport):** **AGREE, with one refinement.** fleet-dashboard's session/state cookies are already `HttpOnly; Secure; SameSite=Lax` (verified in `backend/src/handlers/auth.ts`). Worth being precise about the CSRF claim, though: `SameSite=Lax` (the default in every current browser) already blocks the cookie from being attached to a cross-site **POST/PUT/DELETE** — which is the entire mutation surface on both our real APIs — so the primary CSRF vector is already closed by the cookie attribute alone, not left open pending a token. A double-submit CSRF token is still good defense-in-depth (and fleet-dashboard doesn't have one either — this is a real gap on *our* side too, not a hypothetical), but the document's framing ("a cookie without CSRF protection converts an XSS-theft risk into a CSRF-forgery risk rather than removing risk") overstates the residual risk given `SameSite=Lax` on an all-mutating-verbs API. Recommend both sides add a synchronizer token as defense-in-depth, but don't block Tier 0 on it — `SameSite=Lax` is not "no protection."

- **Item 3 (OAuth stub):** **AGREE, strongly, and this is directly validated by a working reference implementation.** fleet-dashboard already built and tested Option A in full — real server-side authorization-code exchange for both Google and Microsoft, a CSRF `oauth_state` httpOnly cookie compared with `crypto.timingSafeEqual`, session issued only after the exchange completes, delivered exclusively via `Set-Cookie` (never a URL param, never localStorage). One implementation detail worth naming precisely: fleet-dashboard's variant fetches the provider's userinfo/Graph endpoint using the exchanged access token, rather than verifying an `id_token`'s JWT signature against the provider's JWKS (Option B's variant). Both are legitimate and secure — the client secret and the code exchange happen server-side either way — but they are not the same code path, so if hub-service adopts Option A, confirm which variant before assuming interchangeability with fleet-dashboard's implementation. **[Superseded — see 1.5.2: hub-service should not have an OAuth implementation at all.]**

- **Item 5 (`iss` claim) and Item 6 (member JWT expiry):** **AGREE with an important scope clarification.** Per fleet-dashboard's contract, member JWTs are minted by *whichever backend is playing the tier-3 role* at `POST /v1/ws/:id/members` (registration) — so "the hub issues its own member JWT" is expected and correct *for the self-hosted deployment path*, not evidence of duplicated/competing issuance. On item 6 specifically: fleet-dashboard already has `POST /v1/ws/:id/members/:mid/rotate` built, tested, and working (old token revoked immediately, no grace period) — the document's claim that "the renewal machinery already exists and is tested" is independently confirmed true on the fleet-dashboard side as well, which strengthens the case for CONTRACT ADAPTS to 7 days. Note for whoever edits the published contract: fleet-dashboard's own `docs/api-contract.md` currently says 30 days and will need the matching edit — this isn't just a hub-side change once the contract text moves. **[Superseded — see 1.5.2: hub-service should not independently issue member JWTs; the rotation/expiry discussion still applies to fleet-dashboard's own issuance.]**

- **Item 17 (installer shape):** **AGREE, and fleet-dashboard's already-shipped implementation is the reference to copy, not just the spec to match.** fleet-dashboard's real `GET /v1/installers` returns lowercase `os`, one row per (os, arch) pair, and a `version` field precisely as this item recommends — this is running code, not aspirational contract text. Copy the exact shape from `fleet-dashboard`'s `docs/api-contract.md` "Installers" section rather than re-deriving it.

- **Item 19 (`awaiting-connect` status):** **AGREE, and flagging a real bug this item exposed in fleet-dashboard's own contract.** Cross-checking this item against `fleet-dashboard/docs/api-contract.md` found an internal inconsistency: the Members section's *prose* already says a member "flips a pending member ('awaiting connect', connected=false) to online" on first `connect` call — but the formal `status` enum two sections later still only lists `busy | online | offline`, omitting the state the prose describes. This item is correct that `awaiting-connect` is real, honest, and needed; fleet-dashboard will fix this contract inconsistency on its own side regardless of this document's outcome, since it's a bug independent of the hub-service question. Thank you for catching it.

- **Item 20 (workspace member/project counts):** **AGREE.** fleet-dashboard's `GET /v1/workspaces` already returns `{ id, name, role }` and does not currently include counts — so if hub-service already computes and returns them, documenting them as additive/optional (rather than either side stripping them) is the right call, and fleet-dashboard would pick them up as a genuine improvement if the contract documents the shape. **[Superseded — see 1.5.2: workspace listing is a fleet-dashboard-owned endpoint hub-service should call, not reimplement.]**

- **Item 21 (wire-protocol relay) and Item 22 (enrollment):** **AGREE these are correctly hub-owned, with the self-host-parity framing making it clearer why.** Presence/relay/command-execution and machine enrollment are tier-2-to-tier-3 concerns that fleet-dashboard's implementation deliberately does not own (fleet-dashboard's own design docs describe the cloud side as "deliberately thin: persistence + messaging," not a command-relay implementation) — whichever tier-3 backend is in play, this subsystem's design should be specified once, normatively, and both backends should satisfy the same relay contract if fleet-dashboard's SaaS deployment is ever meant to support agent-initiated command relay directly rather than solely via a local hub-service. Worth a follow-up question for joint discussion: does fleet-dashboard's SaaS deployment need to implement the relay contract too (for users who want the hosted convenience *and* the relay), or is relay/command-execution exclusively a hub-service (self-hosted or local) responsibility with fleet-dashboard's SaaS deployment intentionally out of that path? The document doesn't currently answer this, and the answer changes item 21's scope. **[Partially superseded — see 1.5.2: relay ownership stands, but its persistence must be local JSON, not Postgres.]**

**Overall (superseded):** no disagreements on substance. Every item checked against fleet-dashboard's real, tested implementation either confirms the recommendation directly or surfaces a small refinement (item 2's CSRF framing, item 19's bug in our own docs). The self-host-parity framing is the one addition worth making prominent, since it changes *why* a reader should care about reconciliation from "two teams collided" to "one client must work against two conformant backends" — a stronger and more accurate claim.

</details>

---

## 2. How to Read the Verdicts

Each item ends with one of these verdicts:

- **HUB ADAPTS** -- apra-fleet-reorg changes to match the published contract as-is.
- **CONTRACT ADAPTS** -- fleet-dashboard's contract (and possibly its backend/frontend) changes to match what the hub built, because the hub's design is better or the hub's data is more honest.
- **BOTH MOVE** -- a new shared design, or each side changes a different part of the same item.

Every verdict names its deciding factor. "Cheapest to ship" is never the deciding factor on a security-sensitive item.

---

## 3. Item-by-Item Analysis

### Category A: Transport / protocol-level mismatches

---

#### Item 1: URL versioning (`/v1` prefix)

**Gap.** The contract puts every route under `/v1/...` (e.g. `/v1/ws/:id/members`). The hub mounts everything at the bare root (`/ws/:id/members`) with no version prefix anywhere.

**Alternatives.**

- **A. Hub adds the `/v1` prefix to all routes.**
  - Pros: One router-level change (mount the existing router under `/v1`); the contract is already published and the dashboard client is already calling `/v1/...`; path versioning is the industry-default way to make breaking changes survivable, and this very document proves breaking changes happen. Zero data-model impact.
  - Cons: Every existing hub test fixture and the `apra-fleet.exe` client base URL must be updated (mechanical, but wide -- expect a large but trivial diff). Any already-enrolled dev spokes pointing at unversioned URLs break until re-pointed.
- **B. Contract drops versioning; both sides live at the root.**
  - Pros: Nothing to change on the hub.
  - Cons: Throws away the one mechanism that would let v2 of this contract ship without a flag day. Given the divergence documented here, betting there will never be a v2 is not credible. Dashboard client changes anyway (it calls `/v1/` today).
- **C. Version via header (`Accept: application/vnd.fleet.v1+json`) instead of path.**
  - Pros: Clean URLs; per-endpoint version negotiation.
  - Cons: Harder to route at load balancers/CDNs, harder to curl, invisible in logs, and neither side has any of the plumbing. Highest cost for the least end-user value.

**Recommendation: A -- HUB ADAPTS.** Deciding factor: the prefix is cheap to add now and priceless the day a breaking change is needed; the contract already committed to it and the dashboard already dials it. Do this first, because every other route-level fix in this document should land under `/v1` once rather than being touched twice.

---

#### Item 2: Session transport -- httpOnly cookie vs Bearer token (SECURITY-SENSITIVE)

**Gap.** The contract specifies an httpOnly cookie (`fleet_session`) for human/dashboard sessions. The hub returns `{jwt: token}` in a JSON body and expects it back in the `Authorization: Bearer` header.

**Alternatives.**

- **A. Hub implements the httpOnly cookie per contract (with `Secure`, `SameSite=Lax` or `Strict`, plus CSRF protection on state-changing routes).**
  - Pros: An httpOnly cookie is unreadable by page JavaScript, which removes the single worst failure mode for a dashboard holding production-infrastructure credentials: an XSS bug (yours or a dependency's) exfiltrating a long-lived session token. The dashboard frontend is already built assuming cookie transport, so its fetch layer needs no token-plumbing, no localStorage, no refresh dance in JS. Matches the published contract.
  - Cons: Cookies reintroduce CSRF, so the hub must add `SameSite` plus a CSRF token (double-submit or synchronizer) on mutating routes -- real work, and it must be done correctly, not sketched. Cookie auth is awkward for non-browser callers, so the hub must keep Bearer for machine/member JWTs (it already does -- member auth is a separate token class and stays Bearer).
  - Cost: moderate (cookie issuance, CSRF middleware, CORS `credentials: include` configuration between dashboard origin and hub origin).
- **B. Contract changes to Bearer; dashboard stores the JWT in JS-accessible storage.**
  - Pros: Zero hub work; no CSRF surface (the browser never auto-attaches the credential); simpler CORS.
  - Cons: The token now lives where XSS can read it. For an app whose whole purpose is remote command execution on a fleet of machines, a stolen session is not "someone read my dashboard" -- it is "someone can drive my fleet." Every dependency in the Next.js bundle becomes part of the auth trust boundary. This trades a defensible, well-understood CSRF mitigation problem for an open-ended XSS exposure. Also forces dashboard rework (it is built for cookies).
- **C. Support both: cookie for browser sessions, Bearer for programmatic access to the same human-level API.**
  - Pros: Flexibility; enables future CLI-as-human use cases.
  - Cons: Two auth paths through the same middleware doubles the attack-review surface and invites subtle bugs (e.g. CSRF checks applied on the cookie path but a Bearer fallback that silently accepts a cookie-derived token). Add this later only if a concrete need appears, not speculatively.

**Recommendation: A -- HUB ADAPTS.** Deciding factor: security over convenience. XSS-exfiltration of a fleet-control credential is a materially worse failure mode than CSRF, and CSRF has crisp, standard mitigations (`SameSite=Lax` + per-request CSRF token on mutations) that the hub team must implement as part of this item, not as a follow-up. The CSRF mitigation is in scope for this item; a cookie without it is not "done." Member/agent auth stays Bearer -- machines do not have a cookie jar, and the contract agrees.

---

#### Item 3: OAuth flow -- stub that trusts client-supplied identity (SECURITY-CRITICAL)

**Gap.** The contract expects `POST /v1/auth/oauth/:provider` to drive a real OAuth flow (redirect to Google/Microsoft, verified callback, cookie set server-side). The hub's implementation accepts `{oauthSubject, email, name}` in a JSON POST and trusts it with **zero verification**. Anyone who can reach the endpoint can become anyone.

This is not a shape mismatch. It is an authentication bypass by design, acceptable only as a test scaffold, and it must be labeled as such everywhere it appears until replaced.

**Alternatives.**

- **A. Hub implements the full server-side authorization-code flow per contract** (redirect to provider, hub-held client secret, code exchange on the hub, ID-token verification, session cookie set on callback).
  - Pros: The strongest and most conventional design; the identity assertion never passes through client-writable hands; secrets stay server-side; matches the contract as written; pairs naturally with the cookie decision in item 2 (the callback sets the cookie).
  - Cons: The most implementation work on the hub: provider app registrations, redirect-URI management per environment, `state`/nonce handling, callback routes. All of it is table stakes for a product asking users to sign in with Google/Microsoft.
- **B. Token-verification variant: dashboard runs the provider's front-end flow (e.g. Google Identity Services), then POSTs the resulting **ID token** to the hub, which verifies signature, `aud`, `iss`, and expiry against the provider's JWKS before creating a session.**
  - Pros: Cryptographically sound -- the hub verifies a provider-signed assertion rather than trusting a JSON body; keeps the hub's endpoint shape close to what exists today (a POST with a body), so the smallest secure delta from current code; no hub-side redirect plumbing.
  - Cons: Requires a contract amendment (the flow differs from the contract's redirect description); JWKS fetching/caching and strict claim validation are easy to get subtly wrong (`aud` confusion, accepting the wrong token type -- it must be the ID token, never an access token); pushes provider-flow logic into the dashboard bundle.
- **C. Keep the stub, gate it behind an environment flag (`AUTH_MODE=insecure-dev`), and defer real OAuth.**
  - Pros: Unblocks local development and E2E tests immediately; zero new code.
  - Cons: As the *only* mode it is disqualifying -- flags have a way of being set in the wrong environment, and the failure mode is total identity compromise. Acceptable **only** as an explicitly-named dev mode that refuses to start when `NODE_ENV=production`, alongside A or B, never instead of them.

**Recommendation: A -- HUB ADAPTS**, with B as an acceptable fallback if the team amends the contract to say so explicitly, and C retained strictly as a hard-gated dev mode. Deciding factor: this is the perimeter of the entire product; nothing behind it matters if it stays a stub. State it plainly in both repos' issue trackers: **the current endpoint is an authentication bypass and must not be deployed to any environment that will ever hold a real credential.**

---

#### Item 4: Error envelope shape

**Gap.** Contract: `{ error: { code, message } }`. Hub: `{ error: "string" }` -- flat, no machine-readable code.

**Alternatives.**

- **A. Hub adopts the contract's structured envelope**, emitted from one shared error-handling middleware, with a small documented code registry (`unauthorized`, `not_found`, `validation_failed`, `conflict`, ...).
  - Pros: Error codes let the dashboard branch on failure kind (show a re-auth prompt on `unauthorized`, a form error on `validation_failed`) instead of string-matching English prose -- direct end-user value in error UX. One middleware change plus test updates; the hub's flat strings map 1:1 onto `message`.
  - Cons: Every hub test asserting on the flat shape updates (wide, mechanical). Choosing the code taxonomy takes a short design pass.
- **B. Contract flattens to `{ error: "string" }`.**
  - Pros: Hub does nothing.
  - Cons: Permanently forbids programmatic error handling; the dashboard would parse prose forever. Optimizes for this week at the cost of every future feature.
- **C. Hub emits both (`{ error: { code, message }, message: "string" }`) during a transition window.**
  - Pros: No coordinated flag day.
  - Cons: The two sides are not integrated in production yet, so there is nothing to transition *from*. A compatibility shim with no consumers is pure carrying cost.

**Recommendation: A -- HUB ADAPTS.** Deciding factor: structured codes are the difference between a dashboard that can react to failures and one that can only display them; the fix is one middleware plus test churn. This is plain implementation debt -- fix it to match the contract, full stop.

---

#### Item 5: Member JWT `iss` claim

**Gap.** Contract: `iss` is always `fleet.apralabs.com`. Hub: signs the placeholder literal `hub`.

**Alternatives.**

- **A. Hub hardcodes `iss: "fleet.apralabs.com"`.**
  - Pros: One-line change; matches contract.
  - Cons: Dev/staging hubs sign tokens claiming to be production -- if key material ever leaks across environments, tokens become cross-honorable, and audit logs lie about token origin.
- **B. Config-driven issuer (`HUB_ISSUER` env var) defaulting to `fleet.apralabs.com`; verification requires an exact match with the deployment's own configured issuer.**
  - Pros: Contract satisfied in production; staging/dev tokens are structurally distinguishable and non-interchangeable; standard JWT hygiene; still a tiny change.
  - Cons: One more required config knob; the contract text should note that non-production issuers exist.
- **C. Contract changes to accept `hub`.**
  - Pros: Nothing changes on the hub.
  - Cons: Enshrines a placeholder as the permanent identity of the token authority. No upside beyond laziness.

**Recommendation: B -- HUB ADAPTS (with a one-sentence contract footnote about non-production issuers).** Deciding factor: `hub` is admitted placeholder debt, and while fixing it, environment-scoped issuers cost nothing extra and close a cross-environment token-confusion hole. Note: all existing member tokens are invalidated by the issuer change -- sequence this alongside item 6 so members re-enroll once, not twice.

---

#### Item 6: Member JWT expiry -- 30 days (contract) vs 7 days (hub)

**Gap.** Contract: member JWTs expire 30 days from issuance. Hub: 7 days.

**Alternatives.**

- **A. Hub moves to 30 days.**
  - Pros: Matches contract; fewer expiry events for unattended spoke machines; less rotation traffic.
  - Cons: A stolen member token (these live on disk on spoke machines -- laptops, CI boxes) is honored ~4x longer. Member tokens authorize command execution and file transfer; 30 days of exposure for a machine credential is generous by any modern standard.
- **B. Contract moves to 7 days, and documents the hub's existing rotate endpoint as the intended renewal path (agents rotate proactively, e.g. when >50% of lifetime has elapsed).**
  - Pros: Shorter blast radius on token theft; the renewal machinery already exists and is tested on the hub; the number in the contract was, as far as either repo's history shows, not load-bearing -- nothing in the dashboard depends on 30 vs 7. Security posture improves with near-zero code change (the hub already does this).
  - Cons: An agent offline for more than 7 days must re-enroll rather than rotate -- a real, if rare, operational annoyance (mitigated by the enrollment-token flow, item 22). Contract text changes.
- **C. Configurable per-workspace TTL with a bounded range (e.g. 1-30 days, default 7).**
  - Pros: Lets security-sensitive workspaces tighten and lab workspaces loosen.
  - Cons: Per-workspace auth policy is a v2-sized feature (UI, storage, enforcement, docs) hiding inside a constant. Do not build it to settle a disagreement about a default.

**Recommendation: B -- CONTRACT ADAPTS.** Deciding factor: security over convenience -- these are machine credentials sitting on disk on fleet spokes, and the shorter default plus the already-built rotation path is strictly the better posture. Revisit C only if a customer actually asks. Coordinate the re-enrollment wave with item 5's issuer change.

---

### Category B: Endpoints the contract expects that the hub does not expose

---

#### Item 7: `POST /v1/workspaces` (create workspace)

**Gap.** Contract defines it. The hub has a working data-layer `createWorkspace()` that was never wired to an HTTP route -- workspaces currently cannot be created through the API at all.

**Alternatives.**

- **A. Wire the route per contract** (authenticated human session, creator becomes owner/admin per the hub's existing RBAC model).
  - Pros: Hours of work -- the hard part (data layer, RBAC) exists and is tested; unblocks the dashboard's most basic onboarding flow ("create your first workspace").
  - Cons: None of substance. Needs an authorization decision (may any authenticated user create workspaces, or only approved ones?) -- the hub's existing signup-approval model (see item 14) answers this: approved users only.
- **B. Treat workspace creation as an admin-only, out-of-band operation (CLI/ops script) and remove it from the contract.**
  - Pros: Smaller attack surface.
  - Cons: Makes the product un-self-serve for its primary onboarding path; contradicts the dashboard's built UI. Internal tidiness at direct end-user expense.
- **C. Defer to v2.**
  - Cons: There is no v1 story for a user's first five minutes without it. Not viable.

**Recommendation: A -- HUB ADAPTS.** Deciding factor: this is unfinished wiring over finished plumbing; it blocks first-run onboarding and costs almost nothing.

---

#### Item 8: `DELETE /v1/ws/:id/members/:mid` (soft-delete a member)

**Gap.** Contract defines member removal as a soft delete. The hub has no member-removal path of any kind -- once registered, a member exists forever.

**Alternatives.**

- **A. Implement soft delete per contract**: mark the row deleted, immediately invalidate the member's JWT (deny at auth middleware, and terminate any live relay stream for that member), exclude from default listings.
  - Pros: Matches contract; preserves the usage/activity ledger's referential integrity (deleted members still appear in historical cost data); gives operators the essential "this laptop was stolen / this contractor left" action. JWT invalidation on delete is the security-relevant half -- without it, "deleted" members can still execute commands until their token expires.
  - Cons: Requires a revocation check on the hot auth path (a status lookup per request -- the hub already loads the member row for workspace-isolation checks, so this is nearly free).
- **B. Hard delete.**
  - Pros: Simplest mental model; true data removal.
  - Cons: Orphans or cascades away usage/activity history that billing views need; contract says soft; irreversible operator mistakes.
- **C. Status-based deactivation (`status: "disabled"`) instead of a delete verb.**
  - Pros: Reuses the status enum; naturally reversible.
  - Cons: Diverges from the contract's DELETE for no benefit; conflates presence states (item 19) with administrative states in one enum, which will hurt later.

**Recommendation: A -- HUB ADAPTS.** Deciding factor: the contract's soft-delete is the right design anyway (ledger integrity + revocation), and the revocation side-effect makes this a security item, not just CRUD -- a member-removal path is mandatory before any real fleet trusts this product.

---

#### Item 9: `POST /v1/ws/:id/members/:mid/connect` (first call after registration)

**Gap.** Contract expects a REST connect call. The hub has no such route; a member's arrival is signaled by a `presence.announce` envelope through the relay (`POST /ws/:id/envelopes`), which also transitions the member out of `awaiting-connect` (item 19).

**Alternatives.**

- **A. Contract adopts the envelope model**: delete `connect` from the contract; document that presence is derived hub-side from relay traffic, and specify the *member read-model* the dashboard consumes (`status`, `lastSeenAt` on `GET /v1/ws/:id/members`).
  - Pros: The relay is the system that actually knows whether a member is connected -- an SSE stream being open is ground truth; a REST "I connected" claim is hearsay that goes stale the moment the process dies. One presence mechanism instead of two that can disagree. The relay's isolation model is already security-reviewed; adding a parallel unreviewed presence path squanders that. Blast radius on the dashboard is ~zero: the *dashboard* never calls `connect` -- agents do, and the agent ships from the same repo as the hub.
  - Cons: The contract must grow a relay section (item 21) for this to be coherent; the dashboard team must accept that presence semantics are defined by relay behavior they do not implement.
- **B. Hub adds a REST `connect` shim that internally synthesizes a `presence.announce` envelope.**
  - Pros: Contract text survives untouched.
  - Cons: A fake endpoint that no real agent uses (the shipped agent speaks relay), kept alive purely so a document stays unedited. Two code paths to test, one of them dead. This is the definition of contract-worship over product truth.
- **C. Hub implements REST connect/heartbeat natively and demotes relay presence.**
  - Pros: Contract as written.
  - Cons: Strictly worse presence semantics (no liveness ground truth, no reconnection story), discards reviewed, working code. Rejected on the merits.

**Recommendation: A -- CONTRACT ADAPTS.** Deciding factor: the relay's presence is derived from an actually-open connection, which REST self-reporting cannot match; and since agent and hub co-ship from one repo, changing the contract here breaks nobody. The dashboard's real dependency is the member read-model, and that must be specified precisely as part of this change.

---

#### Item 10: `POST /v1/ws/:id/members/:mid/heartbeat`

**Gap.** Same situation as item 9: contract expects REST heartbeats; the hub folds liveness into `presence.heartbeat` envelopes over the relay.

**Alternatives.** Identical structure to item 9 (contract adopts envelopes / REST shim / hub rebuilds REST), with one addition worth naming:

- The contract's REST heartbeat has **no failure semantics**: nothing says what happens after N missed beats, how a half-dead agent distinguishes "hub rejected me" from "network blip," or how state converges after a partition. The relay already answers all of this (stream teardown detection, TTL, redelivery on reconnect).

**Recommendation: CONTRACT ADAPTS**, jointly with item 9 as a single contract amendment ("Member presence" section: announce/heartbeat envelope types, hub-side staleness threshold that flips `online -> offline`, and the read-model fields the dashboard renders). Deciding factor: same as item 9 -- one presence mechanism, the one with actual liveness semantics. Items 9 and 10 should be one PR against the contract, not two.

---

#### Item 11: `POST /v1/ws/:id/usage` (agent reports cost/token delta)

**Gap.** Contract defines it. The hub has `recordUsage()` at the data layer with **zero callers** -- no route, no envelope handler, nothing. The usage ledger is write-only in the sense that nothing can write to it.

**Alternatives.**

- **A. Wire the REST route per contract**, with a required client-supplied idempotency key.
  - Pros: Matches contract; simple fire-and-forget semantics fit the data (a delta report is not a command needing redelivery); a *billing-adjacent* path should be exactly-once-ish, and REST + idempotency key is the simplest way to get there. Data layer exists; this is a thin route plus validation.
  - Cons: Agents make one more kind of HTTP call outside the relay -- mild inconsistency with the "everything over envelopes" direction of items 9/10.
- **B. Add a `usage.report` envelope type over the relay.**
  - Pros: Single transport for all agent->hub traffic; reuses relay auth/isolation.
  - Cons: The relay is deliberately **at-least-once** -- redelivered usage envelopes double-count money unless every handler dedupes, and a deduping ledger inside an at-least-once queue is strictly more machinery than an idempotent REST insert. Cost data deserves the boring transport.
- **C. Defer; derive usage hub-side from relay command traffic.**
  - Cons: The hub cannot see agent-local token spend (the agent's own model calls) -- only the agent knows its usage. Derivation is impossible, not just deferred. Rejected.

**Recommendation: A -- HUB ADAPTS.** Deciding factor: at-least-once delivery is the wrong substrate for financial deltas; the contract's REST design is genuinely correct here, and the zero-caller `recordUsage()` is unambiguous implementation debt. Add the idempotency key to the contract text as a required header/field while wiring it.

---

#### Item 12: `POST /v1/ws/:id/activity` (agent pushes an activity event)

**Gap.** Contract defines it. Hub has `recordActivity()` with zero callers -- same as item 11.

**Alternatives.**

- **A. Wire the REST route per contract.**
  - Pros: Symmetric with item 11; trivially cheap; unblocks the dashboard's activity feed (which is currently rendering against a table nothing populates).
  - Cons: Activity events are higher-volume than usage deltas; naive one-row-per-POST may need batching later.
- **B. `activity.report` envelope over the relay.**
  - Pros: Transport consistency; and unlike usage, duplicate activity events are cosmetically annoying rather than financially wrong, so at-least-once is tolerable.
  - Cons: Still requires contract change plus envelope-type design; and the dashboard's read path doesn't care how events arrived. The marginal benefit over A is small.
- **C. Accept a batch array in the REST route (`events: [...]`) from day one.**
  - Pros: Amortizes chatty agents; trivially supersets A.
  - Cons: Minor contract amendment (array body).

**Recommendation: A now, with C's batch body as a friendly-amendment to the contract if the dashboard team agrees -- HUB ADAPTS.** Deciding factor: this is a dead simple missing route blocking a visible dashboard feature; ship the boring version, keep batching as a shape choice made once in the contract rather than retrofitted.

---

#### Item 13: `WS /v1/ws/:id/activity/stream` (live activity feed to browser)

**Gap.** Contract specifies a WebSocket. The hub has no WebSocket support at all. The hub's only streaming endpoint, `GET /ws/:id/stream`, is the **agent-relay SSE channel** -- a different audience (spokes, not browsers), different auth (member JWT), different purpose (command execution). It must not be conflated with, or exposed to, the dashboard.

**Alternatives.**

- **A. Hub adds a WebSocket server per contract.**
  - Pros: Contract as written; bidirectional if ever needed.
  - Cons: An entire new server capability (upgrade handling, per-connection auth with the item-2 session cookie, load-balancer WS config) for a feed that is strictly one-directional. Nothing else in either system needs WS. Highest cost, new operational surface, new security review.
- **B. Contract amends to SSE: `GET /v1/ws/:id/activity/stream` (`text/event-stream`), cookie-authenticated, with `Last-Event-ID` resume.**
  - Pros: The hub already runs production SSE (the relay), so the server patterns -- keepalive, connection accounting, backpressure -- are proven in this exact codebase; browsers get `EventSource` natively with built-in auto-reconnect and resume, which is *more* robust for a feed than raw WS (where the dashboard would hand-roll reconnection); cookie auth (item 2) attaches automatically. Smallest secure delta for both sides.
  - Cons: One-directional forever (fine -- it is a feed); contract text changes; a second SSE endpoint must be kept rigorously separate from the relay stream in auth middleware (session cookie, not member JWT -- an explicit test, not an assumption).
- **C. Defer streaming; dashboard polls `GET /v1/ws/:id/activity?since=<cursor>` every few seconds.**
  - Pros: Nearly free; a cursor-paginated GET is needed for feed history anyway.
  - Cons: Seconds of latency and polling load; "live" feed that is not live. Acceptable as a stepping stone, not an endpoint state.

**Recommendation: B, shipping C's cursor GET first as the fallback path -- BOTH MOVE** (contract drops WS for SSE; hub builds an endpoint it does not have). Deciding factor: SSE reuses this codebase's proven streaming machinery and the browser's native reconnect for a strictly one-way feed, where WS buys nothing but cost. The auth-separation between the two SSE endpoints is the security-review item here.

---

#### Item 14: `PUT /v1/admin/users/:id/reject` (reject a pending signup)

**Gap.** Contract defines it. Hub has `rejectUser()` at the data layer, never wired to HTTP. Consequence: an admin can approve signups but not reject them -- pending users accumulate forever.

**Alternatives.**

- **A. Wire the route per contract** (admin RBAC guard, same middleware as the existing approve route).
  - Pros: Hours of work; completes the approve/reject pair; the approval flow is a security control and currently only half-exists.
  - Cons: None.
- **B. Contract drops rejection; unapproved users simply never gain access.**
  - Pros: No work.
  - Cons: Pending list grows unboundedly; admins cannot distinguish "not yet reviewed" from "reviewed and refused"; a refused person can tell they were never acted on. Operationally and socially worse for zero savings.
- **C. Expand into a full user-lifecycle admin API (suspend, un-reject, delete).**
  - Pros: More complete.
  - Cons: Scope creep beyond both the contract and any current need. v2 material.

**Recommendation: A -- HUB ADAPTS.** Deciding factor: it is the missing half of an access-control workflow the hub already committed to; pure unfinished wiring.

---

### Category C: Endpoints that exist on both sides with mismatched shapes

---

#### Item 15: Member create/rotate response -- `{ member, token }` vs `{ member, jwt }`

**Gap.** Same value, different key: contract says `token`, hub says `jwt`.

**Alternatives.**

- **A. Hub renames `jwt` -> `token`.** Pros: one-line change per route plus test updates; matches contract; `token` is also the more format-agnostic name if the credential format ever changes. Cons: the in-repo agent client reads `jwt` and updates in the same PR (same repo -- trivially coordinated).
- **B. Contract renames to `jwt`.** Pros: none over A. Cons: dashboard client and contract both edit for a name that is *less* future-proof.
- **C. Hub returns both keys.** Cons: permanent ambiguity ("which one is canonical?") to avoid a coordinated one-line change between two files in the same repository. Not worth it.

**Recommendation: A -- HUB ADAPTS.** Deciding factor: trivial cost, and `token` is the better name anyway.

---

#### Item 16: `GET /installers` response wrapper

**Gap.** Contract: `{ apiVersion: "v1", installers: [...] }`. Hub: a bare JSON array.

**Alternatives.**

- **A. Hub adds the wrapper.** Pros: matches contract; a top-level object is standard defensive API design -- it leaves room to add fields (pagination, channel metadata) without a breaking change, which a bare array never does. Cons: trivial test churn.
- **B. Contract drops the wrapper.** Cons: locks the endpoint into a bare array forever; saves one object literal today.
- **C. Defer.** Cons: this endpoint feeds the public download page -- it is among the first things integrated; deferring a five-minute fix creates a known flag-day later.

**Recommendation: A -- HUB ADAPTS.** Deciding factor: bare-array responses are an API dead end; the contract's wrapper is correct practice.

---

#### Item 17: Installer row shape -- `os` casing, combined `arch`, missing `version`

**Gap.** Contract: `os: "macos"` (lowercase enum), one `arch` per row (`"arm64"`), and a `version` field. Hub: `os: "macOS"` (display casing), `arch: "arm64 . x64"` (a combined display string), and **no `version` field at all** -- not in the route, and not in the shared `@apralabs/fleet-api-contract` `InstallerSchema` either.

**Alternatives.**

- **A. Hub adopts the contract shape end-to-end**: lowercase machine enums, one row per (os, arch) pair, add `version` to `InstallerSchema` and the route; any display formatting ("macOS", "arm64 . x64") moves to the client where it belongs.
  - Pros: Machine-readable enums are what let an install script or the agent's self-updater pick the right binary programmatically -- `"arm64 . x64"` cannot be matched against `process.arch` without fragile string surgery. `version` is not optional garnish: without it there is no update-check story at all (`is my installed 0.3.4 older than what the hub offers?`). The shared schema package is the right single place to fix it, and both repos consume the fix from there.
  - Cons: Row-splitting touches how the hub enumerates its artifacts; schema change ships through the shared package (a coordinated version bump -- but that package exists precisely for this).
- **B. Contract adopts the hub's display strings.**
  - Cons: Bakes UI copy into the wire format; every non-dashboard consumer (scripts, the agent) then parses prose. Rejected.
- **C. Hub keeps combined rows but adds an `archs: ["arm64","x64"]` array alongside.**
  - Pros: Avoids row duplication for universal binaries.
  - Cons: If a single artifact genuinely serves both arches, *that* is the honest model -- but then the contract should say `archs: string[]`, not the hub say `"arm64 . x64"`. Worth raising: if the mac binary is a universal build, propose `archs` as a contract amendment rather than faking two rows pointing at one file.

**Recommendation: A, with the one carve-out from C -- HUB ADAPTS** (and if any artifact is truly multi-arch, propose `archs: string[]` to the contract instead of duplicating rows dishonestly). Deciding factor: this endpoint must be machine-consumable for installers and self-update to ever work; display strings on the wire and a missing `version` field are straightforward defects.

---

#### Item 18: Member shape -- `jwtExpiresAt` vs `jwtExp`; undocumented `model`/`tags` fields

**Gap.** Contract names the expiry field `jwtExpiresAt`; hub says `jwtExp`. Separately, the hub's member view includes `model` and `tags` fields the contract has never seen -- additive, and per the hub's internal "honesty contract" always null/empty until real data exists (never fabricate untracked data), so currently harmless but invisible to the dashboard team.

**Alternatives.**

- **A. Hub renames to `jwtExpiresAt`; contract adds `model` and `tags` as documented optional fields with their honesty semantics spelled out ("null/empty means not tracked, never a placeholder").**
  - Pros: The rename is trivial and the contract's name is clearer (`Exp` is claim-speak leaking into a view model). Documenting the additive fields costs a paragraph and buys the dashboard team the ability to *use* them the day they carry data -- `tags` in particular is already shipping in the agent model (see apra-fleet's member-tags work) and the dashboard will want to filter on it.
  - Cons: Coordinated but tiny.
- **B. Contract renames to `jwtExp`; extra fields stay undocumented.**
  - Cons: Worse name wins; undocumented fields on a contract boundary are how the *next* divergence starts -- the dashboard either ignores real data or starts depending on shapes nobody promised.
- **C. Hub strips `model`/`tags` from the view until the contract is ready for them.**
  - Pros: Boundary purity.
  - Cons: Deleting honest, additive, already-null-safe fields to satisfy a document, then re-adding them later, is churn with negative value.

**Recommendation: A -- BOTH MOVE** (hub renames one key to match the contract; contract documents the hub's two additive fields). Deciding factor: names should follow the published contract, but the contract must also describe reality -- an undocumented field is a divergence seed, and this whole document exists because divergence seeds grow.

---

#### Item 19: Member `status` enum -- extra `awaiting-connect` state

**Gap.** Contract: `busy | online | offline`. Hub adds `awaiting-connect` (registered, never yet connected).

**Alternatives.**

- **A. Contract adds `awaiting-connect`.**
  - Pros: It is a real, distinct lifecycle state with a distinct user action attached: "this member was created but its machine never phoned home -- check the install / re-issue the join token." Collapsing it into `offline` (which means "was here, is gone") destroys exactly the signal an operator debugging onboarding needs. Consistent with the hub's honesty contract: report the state you actually know. Dashboard cost is one enum member and a badge style.
  - Cons: Dashboard must handle a fourth state everywhere status renders (small but nonzero); enum growth is a soft breaking change for strict clients -- the contract should take this opportunity to state a forward-compat rule ("clients must render unknown statuses as a neutral badge").
- **B. Hub maps `awaiting-connect` -> `offline` at the view layer.**
  - Pros: Zero dashboard work.
  - Cons: The API lies by omission; support burden lands on "why does my new member show offline?" forever. Violates the honesty principle the hub explicitly adopted.
- **C. Split into two fields: `status` (contract's three) plus `lifecycle: "pending" | "active" | "removed"`.**
  - Pros: Cleanly separates presence from lifecycle; also gives item 8's soft-delete a home.
  - Cons: A bigger remodel of both sides than the problem warrants today; worth noting as the v2 shape if lifecycle states multiply.

**Recommendation: A -- CONTRACT ADAPTS**, with C recorded as the v2 direction if more lifecycle states appear. Deciding factor: `awaiting-connect` is honest, actionable information for the end user; hiding a true state to keep an enum small is backwards.

---

#### Item 20: `GET /workspaces` -- additive `members`/`projects` counts

**Gap.** Contract: `{ id, name, role }`. Hub additionally returns `members: <count>, projects: <count>`.

**Alternatives.**

- **A. Contract documents the counts as optional fields.**
  - Pros: A workspace list UI wants these counts (every comparable product shows them); they already exist and cost the dashboard nothing to ignore; one paragraph in the contract. Establishes the general additive-fields norm proposed in item 18.
  - Cons: Counts on a list endpoint have a query cost at scale -- the contract should mark them optional so the hub may drop or cache them later without breach.
- **B. Hub strips the counts.**
  - Cons: Deletes useful, working, additive data for document purity. Same anti-pattern as item 18-C.
- **C. Move counts to a separate stats endpoint.**
  - Pros: Keeps the list lean.
  - Cons: An extra round-trip per dashboard render to un-send data the hub already computed. Premature.

**Recommendation: A -- CONTRACT ADAPTS.** Deciding factor: additive, user-valuable, already built; the contract's job is to document the boundary, and "optional" wording preserves the hub's freedom at scale. Pair this with a general contract rule: *undocumented additive response fields are a contract bug -- either document them or the emitter removes them.*

---

### Category D: Hub capabilities the contract does not mention

---

#### Item 21: The wire-protocol relay system (`POST /ws/:id/envelopes`, `POST /ws/:id/ack`, `GET /ws/:id/stream`)

**Gap.** The hub's actual mechanism for spoke connectivity -- outbound-only SSE from the spoke, durable at-least-once envelope queue with TTL and redelivery, explicit acks, security-reviewed workspace isolation, command execution and file transfer through the hub instead of direct SSH -- appears nowhere in the contract. The contract's model of agent connectivity is the REST connect/heartbeat pair (items 9-10), which has no delivery, retry, ordering, or isolation semantics at all.

**Alternatives.**

- **A. Contract adds a "Wire Protocol (agent <-> hub)" section** documenting the three routes (under `/v1`), envelope structure and types, ack/redelivery/TTL semantics, member-JWT auth, and the workspace-isolation guarantees -- written as the *normative* description of agent connectivity, replacing connect/heartbeat.
  - Pros: This subsystem is the load-bearing core of the hub-and-spoke migration and the part that already survived a security review; it is *why* spokes no longer need inbound SSH -- arguably the product's single biggest architectural asset. A contract that omits the real agent boundary is not "the single source of truth," it is a partial truth, and partial truths at this boundary are how the next 22-item divergence happens. Documentation cost only; zero code changes on either side.
  - Cons: Real writing effort (this is the largest doc item); the dashboard team must review and own text about a subsystem they do not implement -- but they must understand it anyway, because member presence, activity, and "run command from the dashboard" features all sit on top of it.
- **B. Keep the relay as an internal, undocumented hub<->agent protocol; the contract covers only dashboard-facing routes.**
  - Pros: Smaller contract; agent and hub co-ship from one repo, so nothing breaks today.
  - Cons: The relay routes live on the same origin, same URL space, same auth infrastructure as the contract routes -- "undocumented" here means *undocumented shared attack surface and undocumented URL collisions waiting to happen* (the near-miss between `/ws/:id/stream` and item 13's activity stream is the live example). Also blocks any future third-party agent implementation.
- **C. Replace the relay with the contract's REST connect/heartbeat plus a to-be-designed command channel.**
  - Cons: Discards a working, tested, security-reviewed system for an unbuilt, weaker one that would need its own delivery semantics designed from scratch and re-reviewed. Named only for completeness; rejected outright.

**Recommendation: A -- CONTRACT ADAPTS.** Deciding factor: the relay is a genuine architectural improvement -- at-least-once delivery, TTL, redelivery, reviewed isolation -- over anything the contract sketches, and the contract's claim to be the single source of truth is void while it omits the system's real spine. This is the "harder, more disruptive path" only in page count; in code it is free.

---

#### Item 22: Enrollment-token flow (`POST /ws/:id/enrollment-tokens`, `POST /join/exchange`)

**Gap.** How a new machine actually joins a workspace -- an operator mints a short-lived enrollment token, the new spoke runs `apra-fleet join <token>` and exchanges it for a member identity + JWT. The contract does not mention any of it, and offers no alternative onboarding mechanism.

**Alternatives.**

- **A. Contract adds an "Enrollment" section** documenting both routes (under `/v1`), token TTL/single-or-multi-use semantics, required role to mint, and the exchange response (which is item 15's `{ member, token }` shape).
  - Pros: The dashboard *needs* this to build the obvious "Add member" button (mint token -> show `apra-fleet join <token>` copy-paste) -- so this is not archaeology, it is unblocking a core dashboard feature the contract currently cannot express. Security properties (short TTL, scoped to one workspace, no long-lived credential in the copy-paste) are exactly the kind of thing a contract should pin down before a UI team builds around looser assumptions.
  - Cons: Documentation effort; the two teams must agree token TTL and reuse policy explicitly (a feature, not a bug -- that agreement is currently implicit in hub code).
- **B. Leave enrollment CLI-only and undocumented.**
  - Cons: Guarantees the dashboard team either cannot build member-onboarding UI or reverse-engineers the routes from hub source -- reverse-engineering an auth-adjacent flow is precisely how insecure assumptions get built in.
- **C. Redesign enrollment to be dashboard-initiated only (dashboard pre-creates the member, hands out a full member JWT directly).**
  - Cons: Puts a long-lived machine credential in a browser copy-paste instead of a short-lived exchange token -- a strict security downgrade from what the hub already built. Rejected.

**Recommendation: A -- CONTRACT ADAPTS.** Deciding factor: the flow exists, works, and is the security-correct shape (short-lived exchange token, not a raw credential); the dashboard's "Add member" UX is blocked on documenting it, so this is end-user value, not tidiness.

---

## 4. Prioritized Action Plan

### Tier 0 -- Security gates: settle before ANY real integration or shared deployment

*Reason: these define the trust perimeter; everything else is decoration until they hold.*

| Item | Action | Owner |
|---|---|---|
| 3 | Replace the OAuth stub with a verified flow (server-side code flow preferred; hard-gated dev mode only otherwise) | hub |
| 2 | Move dashboard sessions to httpOnly cookie **with** SameSite + CSRF token on mutations, in the same change | hub |
| 6 | Contract adopts 7-day member JWT + documented rotation; coordinate re-enrollment with item 5 | contract |

**Explicit security callout.** Items 2 and 3 deserve a joint design review before a line is written: item 3 is a live authentication bypass if it ever escapes a sandbox, and item 2's cookie migration is only a security *improvement* if the CSRF half ships with it -- a cookie without CSRF protection converts an XSS-theft risk into a CSRF-forgery risk rather than removing risk. Items 8 (JWT revocation on member delete), 13 (auth separation between the two SSE endpoints), and 22 (enrollment token TTL/reuse policy) are second-ring security items: not perimeter, but each has a failure mode that hands out execution capability, so each needs a security-minded reviewer on the PR.

### Tier 1 -- Must resolve before the first end-to-end integration milestone

*Reason: every route and shape below is touched by the dashboard's first real screens (login, workspace list, member list, downloads); fixing them after integration means fixing them twice.*

- **1** `/v1` prefix (do first; all other route work lands under it once) -- hub
- **4** structured error envelope -- hub
- **5** config-driven `iss`, prod = `fleet.apralabs.com` -- hub
- **7** wire `POST /v1/workspaces` -- hub
- **15** `jwt` -> `token` rename -- hub
- **16** installers wrapper object -- hub
- **17** installer enums + `version` (through `@apralabs/fleet-api-contract`) -- hub + shared package
- **18** `jwtExpiresAt` rename (hub) + document `model`/`tags` (contract) -- both
- **9 + 10** one contract amendment: presence via relay envelopes + member read-model spec -- contract
- **21** contract "Wire Protocol" section -- contract
- **22** contract "Enrollment" section (unblocks Add-member UI) -- contract

### Tier 2 -- Should resolve soon; not blocking first integration

*Reason: each unblocks a specific second-wave feature (activity feed, cost views, admin hygiene) rather than the core loop.*

- **8** member soft-delete with JWT revocation -- hub (security-reviewed PR)
- **11** wire `POST /v1/ws/:id/usage` with idempotency key -- hub (+1-line contract note)
- **12** wire `POST /v1/ws/:id/activity` (batch body if agreed) -- hub
- **14** wire `PUT /v1/admin/users/:id/reject` -- hub
- **19** contract adds `awaiting-connect` + unknown-status forward-compat rule -- contract
- **13** cursor-paginated activity GET now; SSE stream endpoint next -- both

### Tier 3 -- Document-and-move-on / revisit at v2

*Reason: zero code risk today; only contract hygiene or future-shape notes.*

- **20** document additive workspace counts as optional -- contract
- Adopt the general rule from items 18/20: additive fields must be documented or removed
- Record item 19-C (status/lifecycle split) and item 6-C (per-workspace TTL) as v2 candidates

---

## 5. What Is Genuinely at Stake

This product asks real teams to do something that requires unusual trust: install a persistent agent on their machines, hand it credentials, and let a cloud hub relay *arbitrary command execution and file transfer* to those machines. That is the value proposition -- SSH-less fleet orchestration -- and it is also why "make the demo work" shortcuts here are not neutral. Two concrete stakes:

**The OAuth stub is a real vulnerability with a countdown timer, not a TODO.** Today it lives in a repo, harmlessly. The moment any deployment of the hub holds one real workspace with one real spoke, an unauthenticated `POST` with someone else's email is full account takeover, which -- through the relay -- is command execution on that person's machines. There is no version of this product where that is an acceptable interim state, and this document's strongest single recommendation is that both teams treat item 3 as a release blocker, stated in exactly those words in both trackers. The same logic applies at lower intensity to the session-transport choice (item 2): the session credential guards a fleet-control plane, so it belongs where page JavaScript cannot read it, and the CSRF cost of putting it there must be paid in full, in the same PR.

**The relay is an asset; do not let contract convenience erode it.** The envelope system -- outbound-only spoke connections, durable at-least-once delivery, TTL, redelivery, workspace isolation that has already been security-reviewed -- is the difference between "a dashboard that shows machines" and "an orchestrator a platform team can bet on." It handles the questions the contract's REST connect/heartbeat never asked: what happens on reconnect, what happens to in-flight commands when a spoke dies, how one workspace's traffic is provably invisible to another. The costly failure mode here is quiet: a well-meaning "just implement the contract as written" pass that builds the REST shims, lets presence and command paths bifurcate, and dilutes a reviewed isolation boundary with unreviewed parallel routes. Two years from now, the codebase where the contract absorbed the relay has one connectivity story that has been hardening the whole time; the codebase that kept both has an ambiguous protocol museum and a security review that no longer describes reality.

The through-line of every verdict above: **shapes bend toward the published contract, architecture bends toward the better design, and honesty beats tidiness at the boundary** (real states like `awaiting-connect` and real fields like `tags` get documented, not hidden). Both teams built well independently; the 22 gaps are the normal price of that, payable now at documentation-and-wiring rates -- or later, with interest, at incident rates.

---

## Appendix: Verdict Tally

| Verdict | Items | Count |
|---|---|---|
| HUB ADAPTS (contract wins) | 1, 2, 3, 4, 5, 7, 8, 11, 12, 14, 15, 16, 17 | 13 |
| CONTRACT ADAPTS (hub wins) | 6, 9, 10, 19, 20, 21, 22 | 7 |
| BOTH MOVE (new shared design) | 13 (SSE stream), 18 (rename + document) | 2 |
