<!-- llm-context: Master plan for the hub-and-spoke cloud migration: 3-tier architecture
     LLM-CLI -> apra-fleet.exe (local) -> fleet.apralabs.com (cloud hub), workspace_id JWT
     scoping, SSH-to-hub-relay migration for execute_command, execute_prompt two-mode design,
     persistence-layer evaluation (Redis strawman). Written 2026-07-03. Reconciles with
     docs/sse-http-revival-plan.md (Phase 1 decisions), docs/member-onboarding-journey.md
     (Journeys A/B/C), and docs/cloud-fleet-architecture.md (earlier 2-tier cloud vision).
     Read this BEFORE cloud-fleet-architecture.md; where they disagree, this document wins. -->
<!-- keywords: hub-spoke, workspace_id, fleet.apralabs.com, 3-tier, JWT issuance, spoke relay,
     execute_command hub relay, execute_prompt two modes, Redis persistence, provider-agnostic -->

# Hub-and-Spoke Master Plan

Status: planning document, 2026-07-03, partially implemented as of 2026-07-04. This
plan supersedes the topology described in docs/cloud-fleet-architecture.md where the
two conflict (see section 5).

> **2026-07-05 update -- superseded on tier-3 ownership and SSH/relay scope
> (apra-fleet-yp3/qaz, epic apra-fleet-yeb):** the `src/hub-service/` implementation
> described throughout this plan as "the hub" is now reference-only. The product
> owner's authoritative directive (docs/api-contract-reconciliation.md section 1.5;
> see that section's sourcing note -- this repo has not independently verified
> fleet-dashboard's private implementation, only its published contract) makes
> fleet-dashboard the sole tier-3 persistence layer for all workspace/project/
> member/secret configuration; `apra-fleet.exe` is either a SaaS-connected client of
> fleet-dashboard's contract (JWT issued by fleet-dashboard) or standalone with
> local-JSON state -- it never owns a Postgres database of its own. The subsequent
> scoping decision (docs/api-contract-reconciliation.md section 1.6) further
> corrects item 6 above: **SSH is NOT deprecated -- it stays a permanent,
> first-class execution transport**, and the SSH-to-hub-relay migration this plan
> describes (items 6-7 below) is explicitly DEFERRED, not an active migration
> target (deferred child issue `apra-fleet-8rs`). The near-term focus is bootstrap/
> sync (see docs/bootstrap-sync-design-proposal.md), not relay/execution transport
> replacement. The workspace_id JWT scoping and wire-protocol/security semantics
> documented below remain valid design; only "hub-service is the deployed tier-3
> backend" and "SSH dispatch is being replaced" are retired. Read
> docs/api-contract-reconciliation.md sections 1.5-1.6 first for current scope.

**Implementation status (2026-07-04):** The `workspace_id` hard-scope claim (item 4)
is live: `src/services/jwt.ts` requires `workspace_id` on every claim, `project_id`
survives only as an optional non-security grouping label, and `src/services/
token-issuer.ts` mints IDs behind a pluggable `TokenIssuer` seam (Phase 1: one
machine == one implicit workspace, derived from the install's signing-key identity;
a future cloud-dashboard issuer can replace the local dev issuer with no token
migration). `session-registry.ts`, `send-message.ts`, and `http-transport.ts` are
workspace-scoped end to end -- cross-workspace sends/broadcasts are indistinguishable
from "not connected" (see `tests/workspace-isolation.test.ts`). The wire contract
between hub and dashboard (Zod schemas + generated OpenAPI 3.1) now lives in the
`@apralabs/fleet-api-contract` workspace package -- see
`packages/fleet-api-contract/README.md`. `registerMcpEndpoint()` (item 7's
same-machine onboarding path) is implemented and live-verified for AGY and OpenCode
(`src/providers/agy.ts`, `src/providers/opencode.ts`). The cloud hub service itself
(fleet.apralabs.com, tier 3) is not yet built -- everything above is local-machine
(tier 1/2) groundwork that the hub will consume without breaking changes.

---

## 1. Mission statement

Apra Fleet is becoming a hub-and-spoke orchestration platform for LLM-CLI agents:

1. **SSE/HTTP is the primary communication bridge** between every LLM CLI and the
   fleet server process on its machine (apra-fleet.exe). stdio remains a
   compatibility fallback; SSH stops being a dispatch transport.
2. **Hub-and-spoke topology.** The fleet server is the hub; members are spokes. A
   member is an LLM-CLI process running in a folder on some machine -- any of the
   six supported providers (claude, gemini, codex, copilot, agy, opencode).
3. **The hub can run anywhere**, including hosted in the cloud as fleet.apralabs.com.
   Every member connects to it with a JWT issued from the fleet web dashboard.
4. **The JWT is the hard scope.** A workspace_id claim burned into the JWT places a
   member into exactly one workspace. Workspaces are iron-walled: no message, event,
   command, or registry visibility crosses a workspace boundary, enforced at every
   hub handler, not by convention.
5. **Within a workspace, members message freely.** Multiple members may run on one
   machine; machine identity is not a boundary, workspace identity is.
6. **SSH-based execute_command is obsoleted.** Every machine runs an apra-fleet.exe
   that authenticates outbound to the hub with its own JWT. execute_command means:
   the hub relays the command to the target machine's apra-fleet.exe, which executes
   it locally and streams the result back. No inbound SSH, no SSH credentials in the
   fleet credential store for dispatch purposes.
7. **execute_prompt has exactly two modes.** (a) One-shot: the local apra-fleet.exe
   spawns the member's provider CLI headless (e.g. `claude -p`, `agy -p`,
   `codex exec`) and returns the parsed result. (b) Interactive: a long-running CLI
   session into which the fleet server injects prompts over the established
   SSE channel (the send_message path this sprint is building).
8. **Three tiers**: LLM-CLI --(HTTP/SSE, localhost)--> apra-fleet.exe
   --(HTTPS/SSE, outbound)--> fleet.apralabs.com. The LLM CLI never talks to the
   cloud hub directly; the local exe is its only fleet endpoint.
9. **The cloud hub is a persistence and messaging layer**, nothing more. The
   human's strawman is a managed Redis instance; section 6 evaluates it honestly
   and recommends a refinement, not a rubber stamp.
10. **User trust, safety, and security are the highest values.** The
    fleet.apralabs.com web property lets users create workspaces, add and manage
    members, install fleet servers, and observe project state. Users still drive
    projects from their LLM CLIs exactly as today; the web property is visibility
    and administration, not orchestration.
11. **The architecture must not be Claude-centric.** Claude is one provider among
    six. Every protocol, config surface, and capability in this plan is audited for
    accidental Claude assumptions in section 9.

## 2. The 3-tier architecture

```
Tier 1: LLM CLI (claude | gemini | codex | copilot | agy | opencode)
        |  HTTP+SSE (MCP), localhost only, Bearer JWT
        v
Tier 2: apra-fleet.exe  (one per machine; singleton service; the SPOKE)
        |  HTTPS+SSE, outbound only, machine/member JWT with workspace_id
        v
Tier 3: fleet.apralabs.com  (the HUB: persistence + messaging + auth + dashboard)
```

### 2.1 What each tier does

**Tier 1 (LLM CLI).** Connects to its local apra-fleet.exe over the existing MCP
HTTP+SSE transport (`src/services/http-transport.ts`). Sees fleet tools
(send_message, execute_command, execute_prompt, ...). Its JWT is minted for it at
registration/enrollment time and carries {member_id, workspace_id, role,
work_folder}. Tier 1 never holds hub credentials and never opens a WAN connection
for fleet purposes.

**Tier 2 (apra-fleet.exe).** Today this process is the whole universe: it runs the
MCP server, mints JWTs (`src/services/jwt.ts:40`), holds the session registry
(`src/services/session-registry.ts`), and executes commands locally or over SSH
(`src/services/strategy.ts:256`). Under hub-spoke it keeps the local MCP server
role but becomes, additionally, a **relay client of the hub**:

- It authenticates outbound to fleet.apralabs.com with its own JWT (issued from the
  dashboard when the machine is enrolled) and holds a persistent SSE channel.
- Local tool calls whose target is on another machine are forwarded to the hub;
  the hub routes them to the target machine's apra-fleet.exe.
- Commands relayed TO it from the hub are executed with the exact code path that
  `LocalStrategy.execCommand()` implements today (`src/services/strategy.ts:70`) --
  timeouts, PID capture, output spill, credential redaction all reused.
- It stops being a JWT-minting authority. Phase 1's local mint
  (`src/services/jwt.ts`, HS256, key at ~/.apra-fleet/fleet.key) survives only as a
  dev-mode / offline-mode fallback. In hub mode, tokens come from the dashboard and
  tier 2 merely verifies them (against the hub's public key) and passes them
  through. This is the single biggest authority shift in the plan -- see 3.3.
- **Data ownership constraint (explicit user decision, apra-fleet-us9.6 scope
  note):** the hub's Postgres (tier 3, `src/hub-service/db/`) is the sole master
  record for workspace/machine/member/project data -- a local Postgres (or any
  other local SQL database) on a tier-2 machine is explicitly NOT an acceptable
  design. Tier 2 fetches this data from the hub's REST endpoints
  (`GET /ws/:id/members`, `/ws/:id/projects`, etc. -- already built,
  `src/hub-service/http-server.ts`) and caches it locally as plain JSON, extending
  the *existing* local file-based registry (`~/.apra-fleet/data/registry.json`,
  `src/services/registry.ts`, docs/architecture.md "File-Based Registry") rather
  than introducing a second, competing persistence layer on the device. Whoever
  implements the outbound hub client (this issue) should treat "REST fetch +
  local JSON cache" as a hard constraint, not an implementation detail to
  re-derive.

**Tier 3 (fleet.apralabs.com).** Holds: workspace/member registry (durable),
cross-machine session presence (volatile), the message relay for send_message /
execute_command / execute_prompt routing, JWT issuance and revocation, the audit
and activity log, and the web dashboard. It is deliberately dumb about content: it
routes envelopes between spokes within a workspace and persists what the dashboard
needs to display. It runs no LLM and executes no commands.

### 2.2 How the JWT and workspace_id flow

1. User creates a workspace in the dashboard -> hub allocates workspace_id.
2. User adds a machine: dashboard produces an enrollment artifact (installer +
   short-lived enrollment token, or a `apra-fleet join <token>` one-liner, per
   docs/member-onboarding-journey.md Journey B -- retargeted at the hub, see 4).
3. apra-fleet.exe on the machine exchanges the enrollment token with the hub for a
   long-lived machine JWT: {machine_id, workspace_id, role: "spoke"}.
4. Registering a member on that machine mints (hub-side) a member JWT:
   {member_id, workspace_id, role, work_folder}. Tier 2 writes it into the
   provider's MCP registration (via the provider-agnostic registerMcpEndpoint()
   adapter method, docs/member-onboarding-journey.md section 3).
5. Every hub-bound envelope carries the sender's JWT; every hub handler validates
   workspace_id before touching any registry, queue, or log. Every tier-2-bound
   envelope from the hub is only ever delivered down a channel whose machine JWT
   carries the same workspace_id. The iron wall is therefore enforced twice: at
   admission (hub handlers) and at delivery (channel binding).
6. Signing: the hub signs with an asymmetric key (RS256/EdDSA); spokes hold only
   the public key. The current HS256 shared-secret design is incompatible with
   multi-machine issuance (any key holder can mint) and is retired outside
   dev-mode. The claim SHAPE is already location-agnostic (sse-http-revival-plan.md
   section 4 Q5 anticipated exactly this), so this is an issuer/algorithm change,
   not a claim redesign.

### 2.3 Trust boundaries

- Tier 1 <-> Tier 2: localhost, same user account. JWT prevents cross-member and
  (Phase 1) cross-project confusion, not a hostile-network attacker.
- Tier 2 <-> Tier 3: the real security boundary. TLS, asymmetric JWT, outbound-only
  connections (works behind NAT/firewalls -- this is what kills the SSH
  requirement), workspace_id enforced on every envelope.
- Workspace <-> workspace: no shared channels, no shared queues, per-workspace
  encryption keys for any vaulted secrets (cloud-fleet-architecture.md section 9's
  envelope-encryption design carries over unchanged).

## 3. project_id vs workspace_id: the honest reconciliation

Phase 1 (sse-http-revival-plan.md section 4, Q5 decision) made project_id a
first-class JWT claim and scoping key: single machine, multi-project, the local
orchestrator mints tokens, and send_message / session-registry / event broadcast
must all enforce project boundaries. The claim exists today
(`src/services/jwt.ts:21-26`) but is minted as the literal 'default'
(`src/tools/register-member.ts:347`).

**Conclusion: same enforcement mechanism, NOT simply the same concept renamed.
The hard boundary migrates from project_id to workspace_id, and project_id
survives (optionally) as a non-security grouping label inside a workspace.**

Point by point:

- **The mechanism is identical.** Everything Q5 mandated -- claim in the JWT,
  registry keyed/filtered by it, send_message sender-scope == target-scope,
  event routing scoped by it -- is exactly what workspace_id needs at the hub.
  The Phase 1 scoping work (apra-fleet-2xs.2 and the send_message/event-bus
  enforcement) is a direct dress rehearsal for the workspace wall. None of it is
  wasted.
- **The semantics differ in two ways.** (1) Scope: Phase 1 project_id means
  "a project/repo on this machine"; workspace_id means "a tenant boundary across
  machines". A workspace may plausibly contain several repos/projects and several
  machines. If we flatly rename, we lose the ability to group two related repos in
  one workspace while keeping them distinguishable. (2) Issuer: project_id is
  minted by the local orchestrator that already trusts itself; workspace_id is
  minted by the dashboard, which is an actual authority with accounts, revocation,
  and key management.
- **Required change, stated precisely:** the JWT claim that carries the HARD
  boundary should be named workspace_id. Phase 1 should mint it as
  workspace_id (deriving the value the way 2xs.2 planned to derive project_id --
  from the work_folder/repo identity in the single-machine case, where one machine
  == one implicit workspace is a perfectly good Phase 1 semantics). An OPTIONAL
  project_id claim can be layered later for intra-workspace grouping with no
  security weight. Doing the rename NOW, inside apra-fleet-2xs.2 before that issue
  is implemented, avoids a claim-migration (re-mint all member tokens, dual-read
  verify paths) later. This is a rescope of 2xs.2, called out in section 11.
- **What Phase 1 decided that the hub vision partially reverses:** "the local
  fleet server mints JWTs" was a decision (implicitly, in the whole 2.3.x series
  and jwt.ts's design). Under hub-spoke, local minting is demoted to
  dev/offline-mode. The claim shape survives; the authority does not. That is a
  genuine backward step for jwt.ts's role, not for its code (sign/verify with a
  pluggable key is 90% of what remains).

## 4. Reconciliation with member-onboarding-journey.md

The onboarding brainstorm (Journeys A/B/C, enrollment tokens, provider-agnostic
registerMcpEndpoint()) survives with one significant retarget:

- **Journey A (same machine) -- unchanged and strengthened.** Tier 1 <-> Tier 2
  registration via the provider's own native mechanism (registerMcpEndpoint(),
  apra-fleet-2xs.5) is precisely the tier-1 attachment mechanism of the 3-tier
  model. Start using it now, as that doc recommends.
- **Journey B (LAN) -- discovery mechanism superseded.** The doc proposed
  mDNS/LAN discovery or a token embedding the orchestrator's LAN address. Under
  hub-spoke there is no LAN discovery problem: every machine enrolls against the
  hub URL, which is globally known (fleet.apralabs.com or a self-hosted URL). The
  enrollment-token CONCEPT survives intact -- short-lived, single-use, bound to a
  scope and role -- but its issuer becomes the dashboard/hub and the address it
  embeds is the hub's, not the orchestrator's. `apra-fleet join <token>` remains
  the right UX.
- **Journey C (WAN) -- absorbed.** Journey C's requirements (reachable URL, TLS,
  non-replayable tokens) simply ARE the hub model. There is no separate WAN
  journey anymore; B and C collapse into "enroll against the hub".
- **What is invalidated:** any work item that would have implemented
  orchestrator-side LAN discovery/broadcast. As far as the beads record shows,
  that work was an open question (section 5, Q1 of that doc), not a built thing --
  so this is an un-deciding of an undecided question, i.e. cheap. The doc should
  gain a header note pointing here.

## 5. Reconciliation with cloud-fleet-architecture.md

That document (written earlier) already envisions a cloud hub, a dashboard,
multi-tenant "projects", a credential vault, and hooks-as-control-plane. Much of
it survives. Two of its load-bearing choices are REVERSED by the new mission:

1. **Topology: 2-tier -> 3-tier.** cloud-fleet-architecture.md has the member's
   LLM CLI connect DIRECTLY to fleets.apralabs.com/<project-id> (its section 6
   step 1, section 4 member types). The new mission interposes apra-fleet.exe on
   every machine: the CLI talks only to localhost. This is strictly better for
   the stated values (the CLI never holds hub credentials; machine-level relay
   enables execute_command on no-LLM terms everywhere; localhost latency for the
   chatty MCP hop) and it makes the local-only deployment a degenerate case of
   the same architecture (tier 3 absent) rather than a different architecture.
2. **SSH as permanent control plane -> SSH obsoleted.** Its section 5 declared
   SSH the control-plane transport indefinitely ("Do not over-engineer this")
   with the daemon relay reserved for unreachable machines (its section 11). The
   new mission universalizes the daemon: every machine runs apra-fleet.exe, so
   the "unreachable machine" special case becomes the only case, and SSH dispatch
   is retired. Its section 11 (no-LLM members via daemon) was, in hindsight, the
   general design; its section 5 was the special case.

Also superseded: its per-machine member table implying CLI-to-cloud MCP configs;
its Phase 2/3/4 migration table (dated against the -p pricing deadline). Carried
forward with full force: multi-tenancy enforcement at every handler (its section
3 and R2), the auth layering and envelope-encrypted vault (section 9), the
dashboard specification (section 15, including the Netlify prototype and
Discussion #188), fleet_request_human (section 8), the behavioral contract
(section 10), risks R1-R10. Its "project" tenancy concept is this plan's
"workspace" (the rename argument in section 3 applies to that doc's vocabulary
too). A header note should be added to that doc pointing here; that is a
follow-up docs task, not done in this change to keep this change reviewable.

## 6. The Redis strawman, evaluated

What must live at tier 3, and how well bare Redis serves each piece:

| Responsibility | Redis fit | Honest assessment |
|---|---|---|
| Cross-workspace session/presence registry | Strong | Hashes + TTL keys are ideal for "which spokes/members are connected right now". Volatile by design; losing it on failover means a reconnect storm, which spokes must handle anyway (SSE reconnect + re-announce). |
| Message relay (send_message, execute_command/execute_prompt routing) | Mixed | Redis pub/sub is fire-and-forget: a spoke that is briefly disconnected LOSES the message -- unacceptable for execute_command. Redis Streams + consumer groups give at-least-once with acks and replay, which is the actual requirement. Workable, but you are now building a small message broker on Redis primitives (per-workspace streams, per-spoke consumer groups, dead-letter handling). |
| JWT issuance | None | Issuance is an auth service: user accounts, signing keys, OAuth for the dashboard, token lifecycle. Redis stores none of this credibly. This alone means tier 3 cannot be "just Redis". |
| JWT revocation state | Strong | Revoked-jti set with TTL = token lifetime is a classic Redis use. |
| Workspace/member CRUD (system of record) | Weak | This is durable, relational, low-volume tenancy data tied to accounts and (eventually) billing. Redis persistence (RDB snapshots lose the last window; AOF everysec still loses ~1s; managed Redis failover can lose acknowledged writes) is not what you want under the row that says who is in which workspace. Postgres-class durability is. |
| Audit/activity log | Weak | Append-only, queryable by member/time/outcome, exportable, compliance-adjacent. Belongs in a real database (Postgres, with object-storage archival later). Keeping an unbounded log in RAM-priced storage is also economically wrong. |

**Opinion:** the strawman is half right. Redis (or a Redis-compatible managed
service) is a genuinely good fit for the two HOT paths -- presence and the
message relay via Streams -- and for revocation checks. It is the wrong system of
record for tenancy and audit, and it cannot do auth at all. The hub therefore
cannot be "nothing more than a managed Redis instance"; it is necessarily a thin
stateless service (which members reach over HTTPS/SSE -- Redis speaks neither)
in front of two stores:

- **Postgres** as system of record: workspaces, members, machines, token
  issuance records, audit log. At fleet's realistic early scale (tens of
  workspaces, hundreds of members), Postgres LISTEN/NOTIFY could even carry the
  messaging and let us defer Redis entirely -- worth an explicit benchmark before
  adding a second datastore.
- **Redis Streams** (or NATS JetStream, evaluated in the same ADR) for presence +
  relay once/if Postgres-only messaging shows strain.

The right next step is a short ADR comparing: Postgres-only, Postgres+Redis,
Postgres+NATS -- against delivery guarantees, ops burden of a second datastore,
and self-hosting simplicity (mission point: self-hosted parity matters; a
single-binary hub with embedded Postgres beats a three-service compose file).
That ADR is a beads issue (section 11), and the human's strawman is its input,
not its output.

## 7. execute_command: from SSH to hub relay

### 7.1 What exists today (the SSH surface)

- Transport: `src/services/ssh.ts` (ssh2 exec), `src/services/sftp.ts` +
  `src/services/file-transfer.ts` (SFTP transfer), `src/services/known-hosts.ts`
  (host-key pinning), `src/utils/ssh-error-messages.ts` (error classification).
- Strategy: `RemoteStrategy` (`src/services/strategy.ts:26-65`) is the SSH arm;
  `LocalStrategy` (`:67-254`) is the local arm; `getStrategy()` picks by
  `agentType` (`:256`).
- Registration: the remote path of register_member -- host/port/username/
  auth_type/password/key_path fields (`src/tools/register-member.ts:31-36`), OOB
  password collection (`:118-124`), SSH connectivity test and OS detection
  (`:232-266`).
- Credentials: encrypted SSH passwords in the member registry
  (`encryptPassword`, register-member.ts:210), key paths, `setup_ssh_key` tool
  (`src/tools/setup-ssh-key.ts`), and the SSH-delivery arms of provision_llm_auth
  / provision_vcs_auth.
- Cloud lifecycle: the AWS path (`src/services/cloud/*`) reaches instances over
  SSH after start.
- Tests that exist because SSH exists: ssh-error-messages.test.ts,
  known-hosts.test.ts, strategy.test.ts (remote arm), file-transfer-matrix.test.ts,
  register-member-oob.test.ts, parts of execute-command.test.ts,
  provision-auth.test.ts, provision-vcs-auth.test.ts.

### 7.2 What replaces it

The target machine's apra-fleet.exe executes the command itself, on the hub's
relayed instruction:

1. Caller's tier-2 sends an execute_command envelope {target_member, command,
   timeout, ...} to the hub over its authenticated channel.
2. Hub validates workspace_id (caller and target in the same workspace), audits,
   and forwards down the target machine's channel. If the target spoke is
   offline: queued with TTL or failed fast, per an explicit semantics decision
   (the SSH model's "host unreachable" error becomes "spoke offline" -- clearer,
   but the timeout/queueing semantics must be designed, not inherited).
3. Target apra-fleet.exe executes via the existing LocalStrategy code --
   `{{secure.NAME}}` resolution, network-egress policy, redaction, long_running
   task wrapper (execute-command.ts:114-265) all run ON THE TARGET, where the
   credential store lives. This is a deliberate improvement: today, secrets are
   resolved on the orchestrator machine and substituted into the command line
   that crosses SSH; under relay, the secret never leaves the machine that owns it.
4. Result (or task_id for long_running) streams back through the hub.

File transfer (send_files/receive_files) follows the same shape: hub-brokered
relay replaces SFTP (cloud-fleet-architecture.md section 12 already sketched
this; S3-or-direct is part of the persistence ADR).

### 7.3 What is obsoleted vs retained

Obsoleted as dispatch transport (deprecate, then remove): ssh.ts, sftp.ts,
known-hosts.ts, RemoteStrategy, SSH fields and connectivity probes in
register_member, SSH-password encryption in the member registry, setup_ssh_key,
the SSH arms of provision auth delivery, and the tests listed above.

Retained: SSH as an OPTIONAL bootstrap convenience (getting apra-fleet.exe
installed on a machine you can already reach) may survive as an installer path,
but it is no longer part of the runtime protocol. Cloud instance lifecycle
(start/stop EC2) is control-plane-of-the-machine, not of the member, and can stay
until the hub grows machine-provisioning features.

Sequencing honesty: this is a deprecation, not a day-one deletion. The relay path
must exist, be tested across all six providers and three OSes, and cover
long_running + file transfer before the SSH path is removed. Both will coexist
for at least one release.

## 8. execute_prompt: exactly two modes

**Mode (a) -- one-shot spawn.** The member's local apra-fleet.exe spawns the
provider CLI headless and parses the result. This EXISTS today for all six
providers -- it is the entire current execute_prompt
(`src/tools/execute-prompt.ts:132`, subprocess-only, per
sse-http-revival-plan.md 2.3.10) built on
`ProviderAdapter.buildPromptCommand()` / `headlessInvocation()`
(`src/providers/provider.ts:64,115`). What changes under hub-spoke is only WHERE
it runs: for a remote member, the spawn happens on the target machine's tier 2
via the same relay as execute_command, instead of over SSH. The provider
abstraction needs zero changes for this.

**Mode (b) -- long-running interactive with server-driven prompt injection.**
The sprint-in-flight send_message path: a persistent CLI session attached to its
local apra-fleet.exe, prompts injected via the SSE notification channel
(`src/tools/send-message.ts:32-38`). Under hub-spoke, a remote execute_prompt in
mode (b) is: caller tier-2 -> hub -> target tier-2 -> send_message-style
injection into the locally-attached session. The injection hop is always
tier-2-local; the hub only ever relays between exes.

**Is apra-fleet-2xs.7/.8 still correct?** Yes, with one framing adjustment:

- 2xs.7 (status lifecycle: busy -> online transitions, member response path) is
  tier-2-local protocol between the exe and its attached CLI sessions. The hub
  adds a second consumer of the same status stream (presence reporting upward)
  but does not change the state machine. Still correct; build it.
- 2xs.8 (execute_prompt routes interactively-connected members via send_message +
  wait-for-response, subprocess fallback) is exactly mode (b) vs mode (a)
  selection. Still correct. One rescope note: the mode-selection logic must live
  in tier 2 (the member's OWN exe decides, since only it knows whether an
  interactive session is attached), so implement the routing decision against the
  LOCAL session registry, never against caller-side state. If implemented that
  way now, it survives the hub unchanged.
- Caveat carried from the revival plan (2.3.9): mode (b)'s injection currently
  rides an experimental Claude channel. Mode (a) is the universal baseline for
  all six providers; mode (b) is a per-provider CAPABILITY to be detected and
  advertised, not assumed (see section 9).

## 9. Claude-centrism audit

Places where the current code or the vision text accidentally assumes Claude,
and what de-centering requires:

1. `src/tools/register-member.ts:330` -- the interactive bootstrap gate is
   `isLocal && memberProvider === 'claude'`. Acceptable for the experimental
   sub-feature it guards (per the correction: this gate is NOT the scope of
   register_member as a whole), but the production path must go through the
   provider-agnostic registerMcpEndpoint() adapter (apra-fleet-2xs.5).
2. `src/tools/register-member.ts:385` -- spawns the literal `claude` binary with
   `--dangerously-load-development-channels`, a Claude-only dev flag.
3. `src/tools/send-message.ts:33` -- the injection method is
   `notifications/claude/channel`; `src/services/http-transport.ts:169`
   advertises the `claude/channel` experimental capability. The envelope name
   itself is provider-branded; a provider-neutral channel name plus per-provider
   delivery adapters is needed before mode (b) can claim to be multi-provider.
4. `src/tools/register-member.ts:352-364` -- MCP entry hand-written into
   `.claude/settings.local.json`, a Claude config surface (already ruled the
   wrong mechanism by member-onboarding-journey.md section 2).
5. docs/cloud-fleet-architecture.md section 7 -- hooks-as-control-plane
   (PreToolUse/PostToolUse/Stop/UserPromptSubmit) is Claude Code's hook system.
   Gemini/codex/copilot/agy/opencode hook equivalents are unverified; the
   behavioral-contract enforcement design must degrade gracefully to "no hooks:
   trust + audit at the tool boundary" per provider.
6. Mission text point 7 says "claude/agy/opencode -p prompt" -- fine as
   shorthand, but note codex spawns via `exec` not `-p`; the
   `headlessInvocation()` abstraction (provider.ts:115) already normalizes this.
   No action needed beyond not hardcoding `-p` anywhere new.
7. Mode (b) interactive injection is POC-proven ONLY on Claude. Whether each of
   the other five CLIs can (i) attach to a local MCP server with headers, and
   (ii) accept injected prompts mid-session, is unknown and must be researched
   per provider before mode (b) is advertised for them. Until then, mode (a) is
   every provider's guaranteed path.

What is NOT Claude-centric (credit where due): ProviderAdapter covers all six
providers uniformly for spawn, parse, auth, models, permissions
(`src/providers/provider.ts:50-116`); execute_command is provider-independent;
the JWT/session/transport layers carry no provider assumptions.

## 10. Gap analysis

### 10.1 Already exists and serves the end-goal

- Six-provider adapter abstraction: `src/providers/provider.ts:50` and the six
  implementations; selection via `getProvider()` (`src/providers/index.ts`).
- HTTP+SSE MCP transport with per-session servers, JWT verify on POST, health,
  port fallback: `src/services/http-transport.ts:70-306`.
- JWT sign/verify with the location-agnostic claim shape:
  `src/services/jwt.ts:21-78`.
- Session registry (volatile, shape carries project/workspace field):
  `src/services/session-registry.ts:16-51`.
- Event bus + SSE broadcast of fleet events: `src/services/event-bus.ts`,
  broadcast at `src/services/http-transport.ts:250-271` (needs scoping, already
  decided in Phase 1).
- send_message injection skeleton: `src/tools/send-message.ts:14-43`.
- execute_command with secure-token resolution, egress policy, redaction,
  long-running wrapper: `src/tools/execute-command.ts:114-265` -- ALL reusable
  on the target side of the relay.
- LocalStrategy = the daemon-side execution engine, already hardened (timeouts,
  PID capture, spill): `src/services/strategy.ts:67-254`.
- Singleton + service manager (apra-fleet.exe as an always-on OS service --
  precondition for being a spoke): `src/services/singleton.ts`,
  `src/services/service-manager/*`.
- register_member's full breadth (local/remote/cloud, six providers, tags,
  model tiers): `src/tools/register-member.ts:25-67`.
- Phase 1 decisions that are hub-forward-compatible by design:
  sse-http-revival-plan.md section 4 Q5.
- Prior cloud thinking to mine: docs/cloud-fleet-architecture.md (vault, auth
  layers, dashboard spec, risks) and the dashboard prototype
  (https://majestic-biscuit-bef096.netlify.app/, Discussion #188) -- NOTE: this
  Netlify prototype is itself superseded by the fleet-dashboard hi-fi spec found
  at C:\akhil\git\fleet-dashboard, see the Addendum at the end of this document.
  That spec is the current design source for the web dashboard, not this one.

### 10.2 Net-new (does not exist in any form)

Verified by search: no code matches apralabs.com / workspace_id / any hub
deployable distinct from apra-fleet.exe.

- The fleet.apralabs.com hub service itself: auth/issuance, workspace + machine +
  member CRUD, message relay, presence, audit log, self-hosted packaging.
- The web dashboard (a Netlify UI prototype exists; no product code in this repo).
  UPDATE 2026-07-04: superseded by a real hi-fi spec + clickable prototype at
  C:\akhil\git\fleet-dashboard -- see the Addendum. That bundle also surfaces
  scope this plan had not accounted for: no-LLM (plain executor) members,
  cost/usage tracking, and OAuth + admin/RBAC provisioning for the dashboard
  itself (as distinct from member JWT issuance).
- Spoke mode in apra-fleet.exe: outbound hub channel, reconnect/backoff, relayed
  execution, presence reporting.
- Dashboard-issued JWTs + asymmetric verification in tier 2; enrollment token
  exchange (`apra-fleet join`).
- workspace_id claim (as such) and the workspace-wall enforcement at hub
  handlers.
- Hub-brokered file transfer.
- Per-provider interactive-injection capability research (mode (b) beyond
  Claude).

### 10.3 Backward steps required (explicit)

1. **JWT authority reversal.** Phase 1 builds the local exe as mint authority
   (jwt.ts + register-member minting). Hub-spoke demotes that to
   dev/offline-mode. Code survives; the design decision "local server mints" is
   un-decided for the hub era. Mitigation: implement 2xs.2's minting behind an
   issuer interface now.
2. **Claim rename.** Q5's project_id-as-hard-boundary becomes
   workspace_id-as-hard-boundary (section 3). If 2xs.2 ships as literal
   project_id first, a token migration follows later; rescoping 2xs.2 now avoids
   that entirely. This contradicts the Q5 decision's LETTER (the claim name),
   not its spirit (first-class scoping).
3. **cloud-fleet-architecture.md's two reversed pillars** (2-tier topology; SSH
   as permanent control plane) -- section 5. Doc-level un-deciding; no code was
   built on either.
4. **Onboarding Journey B's LAN-discovery mechanism** -- superseded before
   implementation (section 4). Cheap.
5. **SSH dispatch stack deprecation** -- not an undo of Phase 1 (it predates it)
   but a real removal of working, tested code (section 7.3) after the relay
   proves out.
6. **NOT backward (worth stating):** Q1 (HTTP default install), Q2 (UUID
   identity), Q4 (role from tags), the session-registry data shape, the
   provider adapters, and all of 2xs.1/.3/.4/.6/.7 survive unchanged.

## 11. Proposed beads structure (hub-spoke epic)

A new top-level epic (NOT nested under apra-fleet-2xs; the existing epics become
prerequisites feeding it). Children, with model lines per the established
convention (fable = open-ended research; opus = high-risk cross-cutting design;
sonnet = scoped implementation; haiku = mechanical):

1. Hub-spoke wire protocol design (envelopes, presence, relay semantics,
   offline/queue TTL) -- opus.
2. workspace_id claim schema + issuer interface (rescopes/feeds 2xs.2) -- opus.
3. Persistence ADR: Postgres-only vs Postgres+Redis vs Postgres+NATS -- fable.
4. Hub service MVP (auth, CRUD, relay, presence; self-host parity) -- sonnet,
   after 1/2/3.
5. Cloud JWT issuance + enrollment (`apra-fleet join`, asymmetric verify,
   revocation) -- sonnet.
6. Spoke mode in apra-fleet.exe (outbound channel, reconnect, relayed exec via
   LocalStrategy) -- sonnet.
7. execute_command SSH-to-relay migration + deprecation inventory -- sonnet.
8. execute_prompt two-mode formalization (mode selection in tier 2; per-provider
   capability flags) -- sonnet, after 2xs.7/.8.
9. Interactive-injection capability survey across gemini/codex/copilot/agy/
   opencode -- fable.
10. Web dashboard MVP (workspace mgmt, member status, token issuance, audit
    view) -- sonnet, after 4.
11. Workspace iron-wall security review + threat model -- opus, after 4/6.
12. Hub-brokered file transfer (replaces SFTP) -- sonnet, after 6.
13. Docs reconciliation: revision headers on cloud-fleet-architecture.md and
    member-onboarding-journey.md pointing here -- haiku.

Dependency sketch (acyclic): 1,2,3,9,13 have no new-epic prerequisites; 2 builds
on apra-fleet-2xs.2; 4 <- {1,2,3}; 5 <- {2,4}; 6 <- {1,5}; 7 <- {6}; 8 <-
{2xs.7, 2xs.8, 9}; 10 <- {4,5}; 11 <- {4,6}; 12 <- {6}. Existing-issue rescopes:
2xs.2 (mint the boundary claim as workspace_id behind an issuer interface) and a
scope note on 2xs.8 (mode selection must be tier-2-local). All other 2xs/fnz
issues stand as written.

(Beads note: items 1-13 above were created in the apra-fleet-us9 epic; see the
Addendum below for three additional items -- .14, .15, .16 -- added 2026-07-04
after reviewing the fleet-dashboard hi-fi spec.)

---

## Addendum (2026-07-04): reconciliation with the fleet-dashboard hi-fi spec

A real hi-fi UX spec + clickable prototype for fleet.apralabs.com exists at
`C:\akhil\git\fleet-dashboard` (`BUSINESS_MISSION.md`, `README.md`,
`Fleet Cloud.html`, `cloud/*.jsx`, `hifi/ui.jsx`). Its `BUSINESS_MISSION.md` is
dated 2026-07-03 "from founder input" and states the identical 3-tier mission
this document elaborates, in near-identical wording -- strong corroboration,
not a conflicting source. Its README explicitly says it **supersedes the
localhost-only console direction**, i.e. it supersedes the older Netlify
prototype (majestic-biscuit-bef096.netlify.app, Discussion #188) referenced
in sections 5 and 10.1 above. Treat `C:\akhil\git\fleet-dashboard` as the
current design source for the web dashboard from here on.

It also surfaces concrete product scope this plan had not accounted for:

1. **"No LLM" members are a first-class member type**, not an edge case: a
   member can be "any LLM -- or no LLM at all" (a plain executor). Today's
   `register-member.ts` `llm_provider` enum
   (`claude|gemini|codex|copilot|agy|opencode`) has no such option. This
   affects `ProviderAdapter` selection (needs a null-object adapter),
   `execute_prompt` (mode (a)/(b) from section 8 don't apply -- a no-LLM
   member only ever executes commands, never prompts), and cost tracking
   (must render "compute only" instead of token cost).
2. **Projects have no repository field.** A project is a logical grouping of
   members within a workspace ("the same member pool serves projects within
   its workspace"); a real project spans many repos. Checkout identity
   (machine + work folder) belongs to the **member**, not the project. Any
   part of this plan or the codebase that implicitly treats "project" as
   synonymous with "repo" needs to unlearn that -- workspace -> projects ->
   members(machine:folder) is the real hierarchy, not workspace -> repos.
3. **Cost/usage tracking is real, first-class scope**, not a dashboard nicety:
   per-(project, member) cost and token usage, rolled up to the workspace,
   with an explicit **honesty contract** ("Session window only; 7d/30d
   disabled with a tooltip until a persisted usage ledger exists -- never
   fake time windows"). This needs a usage ledger at tier 3, which is new
   input to the persistence ADR (section 6 / beads item 3): usage records are
   append-heavy and naturally time-series-shaped, another point in favor of
   Postgres-class storage over Redis as the system of record, with Redis (if
   adopted) only ever a cache/rollup accelerator in front of it.
4. **The dashboard has its own OAuth + RBAC + admin-provisioning surface**,
   distinct from member JWT issuance: human users sign in via Google/Microsoft
   OAuth, land in a pending-approval queue, and a super-admin approves them
   into a role (Member/Admin/Super-admin) with explicit workspace assignments
   ("users only ever see workspaces they're assigned to"). This is a second,
   separate auth system from the member-JWT/workspace_id design in section 3
   -- one authenticates human dashboard users, the other authenticates
   machine/member spokes -- and both need to exist. Section 11's beads item 10
   ("Web dashboard MVP ... token issuance, audit view") understated this;
   see the retitled item below.
5. **Concrete enrollment CLI shape, with a naming collision to resolve.** The
   dashboard spec's Add-Member wizard produces:
   `apra-fleet register --token <jwt> --name <name> --folder <path>
   [--cli <provider>|--no-llm]`. `docs/member-onboarding-journey.md` (Journey
   B) independently proposed `apra-fleet join <token>`. These are the same
   idea with two different verbs (`register` vs `join`) and different flag
   shapes -- pick one canonical command before implementing beads item 5
   (Cloud JWT issuance + enrollment). Recommendation: prefer the
   dashboard spec's `register --token ...` form since it is the more
   detailed, UX-validated source, and update member-onboarding-journey.md's
   Journey B language to match rather than the reverse.
6. **JWT/token UX is specified precisely** and should be adopted as the
   contract for beads item 5: shown exactly once at issuance (never
   retrievable again), rotate-with-immediate-revocation of the old token,
   30-day expiry surfaced as a chip (warn at <=3 days, shown as expired
   after), and a claims card exposing `iss`/`ws` (workspace, the hard
   scope)/`sub`/`exp`.
7. **A concrete REST+SSE API sketch already exists** (dashboard README "State
   & API sketch" section) covering OAuth callback, workspace/project/member
   CRUD, JWT issuance/rotation, an activity SSE stream, a cost endpoint, and
   admin user-provisioning endpoints. Beads item 4 (hub service MVP) and item
   10 (web dashboard) should be built against this contract rather than
   inventing a fresh one.

### Addendum beads updates (2026-07-04)

- `apra-fleet-us9.10` (Web dashboard MVP) description updated to point at
  `C:\akhil\git\fleet-dashboard` as the real design source and to include the
  OAuth/RBAC/admin-provisioning surface explicitly, not just token issuance.
- New children added to the `apra-fleet-us9` epic:
  - `.14` No-LLM member type support (register_member, ProviderAdapter
    null-object, execute_prompt mode gating, cost "compute only" rendering).
  - `.15` Usage/cost ledger at tier 3 (per project/member, rolled up to
    workspace; feeds the persistence ADR, item 3, and the dashboard's cost
    view).
  - `.16` Dashboard OAuth + RBAC + admin-provisioning (human user auth,
    distinct from member JWT/workspace_id auth; pending-approval workflow,
    role + workspace assignment).
- No existing 2xs/fnz issues needed further changes from this addendum.
