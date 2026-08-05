<!-- llm-context: UNIFIED DESIGN (source of truth). Supersedes and replaces BOTH
     docs/design-role-wise-permission-delivery.md (proactive/provisioning half)
     and docs/missing-grant-recovery-and-playbook-evolution.md (reactive/
     classification half). How apra-fleet declares, compiles, delivers,
     verifies, and recovers tool/OS permissions for fleet members across all
     LLM providers, with the workflow engine role-aware and fleet-mcp role-free. -->
<!-- keywords: compose_permissions, deliverConfigFile, verify-after-write,
     permissions.json sets, playbook ## Permissions, role-free fleet-mcp,
     missing_grant, workspace_not_trusted, os_permission_denied,
     provider_cannot_grant, NEVER_AUTO_GRANT, withPhasePermissions,
     apra-fleet-a1e6, apra-fleet-5oo, fleet-api-contract -->
<!-- source: C:/akhil/git/apra-fleet/docs/  (intended landing location; authored
     from C:/Users/akhil/.claude/jobs/d1bff30b/tmp/unified-permission-design.md) -->

# Unified Design: Permission Declaration, Delivery, and Recovery for Fleet Members

Status: PROPOSAL, unified -- replaces `docs/design-role-wise-permission-delivery.md`
(never committed) and `docs/missing-grant-recovery-and-playbook-evolution.md`
(committed) in full. Neither original survives as an authority; where this
document differs from either, this document wins.
Date: 2026-08-05.
Verification baseline: branch `chore/integration-binary-fixes-and-auth-selfheal`,
HEAD `f23da821`. Every claim about current behavior below was re-checked against
that tree; several claims made by the source documents were found stale and are
corrected here (see 3.6 and the inline notes).

---

## 0. How this document was produced, and the decisions it records

The two source documents were the same author's two halves of one problem:

- Doc A (`design-role-wise-permission-delivery.md`): the PROACTIVE half -- the
  workflow engine provisions each member's permissions before each phase's
  dispatch, through a role-free `compose_permissions` interface.
- Doc B (`missing-grant-recovery-and-playbook-evolution.md`): the REACTIVE half
  -- when a permission block still happens, classify it correctly, extract the
  missing grant, and evolve the declarations under human review.

They are compatible in direction but conflicted on six specific points. This
document resolves all six. Summary (full reasoning at the cited sections):

| # | Conflict | Resolution | Where |
|---|---|---|---|
| 1 | Source of truth: playbook `## Permissions` (B) vs `permissions.json` `sets` (A) | Both, as a pipeline: playbooks are the authored source of truth; `permissions.json` is the committed, drift-guarded COMPILED artifact; engine and fleet-mcp consume only the compiled artifact | Section 7 |
| 2 | Role-scoped delivery: open question (B) vs never (A) | Doc A stands: fleet-mcp stays role-free forever; the engine resolves roles to concrete sets | Section 2 |
| 3 | Union semantics across playbooks/phases | One statement, one name: "union semantics", stated once with its consequences | Section 6.4 |
| 4 | Preflight block-and-abort (B) vs provision-as-remediation (A) | Provision what the system can provision; police only what it cannot. Grounded in the double revert of the gate and the ledger seed | Section 9 |
| 5 | Verify-after-write | One requirement (doc A's incident is the evidence), with doc B's concurrency / session-resume / Windows-escaping folded in as sub-requirements | Section 5 |
| 6 | Failure taxonomy naming | Doc B's names win (`missing_grant`, `workspace_not_trusted`, `os_permission_denied`, `provider_cannot_grant`, plus the `NEVER_AUTO_GRANT` gate), because two of them already exist verbatim in code | Section 4 |

One piece of doc B is deliberately kept SEPARABLE rather than merged into the
narrative: the error-classification-surface work (structured envelopes for
`classifyPromptError`, the `AGENT_RAN_DISPATCH_REASONS` addition, the shared
reason enum in `packages/fleet-api-contract`). Section 8 specifies it as a
self-contained workstream this design references but does not depend on for its
primary (proactive) path.

---

## 1. Problem and scope

### 1.1 The problem

A fleet sprint dispatches nine workflow roles (`planner`, `plan-reviewer`,
`doer`, `reviewer`, `deployer`, `integ-test-runner`, `regression-test-runner`,
`ci-watcher`, `harvester` -- `packages/apra-fleet-se/fleet-sprint/contracts.mjs:57-67`)
onto fleet members whose LLM CLIs each enforce a native permission allowlist
before running any tool. Permissions are therefore a precondition of every
dispatch. Today they are delivered exactly once, at member registration, under a
hardcoded legacy `role: 'doer'` (`src/tools/register-member.ts:401-405`), and
never again. Nothing in the workflow engine composes, verifies, or repairs
permissions at sprint launch or phase start
(`packages/apra-fleet-se/fleet-sprint/runner.js` contains no call to
`compose_permissions` -- verified by grep at HEAD).

The observed failure has two shapes:

- **Late discovery.** Plan/Develop/Review burn real dispatch cost, then the
  Deploy phase (`runner.js:7740-7767`) hits a member whose allowlist lacks a
  command its own runbook declares. Bead `apra-fleet-5oo` (P1, open) records the
  canonical incident: integ-test-runner BLOCKED in 3 of 4 cycles of sprint
  `apra-fleet-cvb` because no profile granted `Bash(bd *)`, and three beads got
  closed on the doer's say-so with zero independent verification.
- **Misdiagnosis.** When the block does surface, the classifier calls it an
  auth failure: `permission_error` sits inside the `auth` regex of
  `classifyPromptError` (`src/utils/prompt-errors.ts:11`), `execute_prompt`
  emits `reason: 'auth'`, `isAuthDispatchError`
  (`packages/apra-fleet-se/fleet-sprint/errors.mjs:391-393`) fires a
  `provision_llm_auth` self-heal that cannot help, and
  `isNonRetryableDispatchError` (`errors.mjs:372-375`) kills the retry loop.
  The sprint dies on a diagnosis that was wrong at second zero.

The failure is not "a permission was missing". It is WHEN the gap is discovered
(after the expensive phases), WHO is expected to fix it (a human, by hand-editing
a provider config -- the exact anti-pattern this repo's CLAUDE.md forbids), and
WHAT the system concludes when it happens (a credential failure).

### 1.2 Scope

In scope:

- A role-free proactive delivery interface on `compose_permissions` and an
  engine-side per-phase provisioning wrapper (Sections 2, 6).
- A declaration pipeline: playbook `## Permissions` -> compiler
  (`apra-fleet-a1e6`) -> committed `permissions.json` with named sets
  (Section 7).
- A hard prerequisite: making `deliverConfigFile` delivery reliable and
  verified (Section 5). This blocks everything else.
- A unified permission-failure taxonomy and the reactive classification /
  extraction backstop (Sections 4, 8).
- Failure policy: what is provisioned, what remains policed, what a compose
  failure does to a phase (Section 9).

Out of scope, explicitly:

- **Silent in-band degradation.** A headless dispatch that hits a denied tool,
  narrates around it, and exits 0 produces no error to classify. Everything in
  Section 8 hangs off the non-zero-exit path. Detecting in-band refusals needs
  provider structured turn events and is its own future design (Section 12).
- The identity-axis `role: 'doer'` stamps in the member token and session
  registry (`register-member.ts:440-444, 486-494`) -- same phase-out family,
  different axis, tracked separately (Section 10).

---

## 2. Layering: the engine is role-aware, fleet-mcp is role-free (resolves conflict 2)

Doc B left "should `compose_permissions` become role-aware?" as an open
question. Doc A answered it: never. Doc A's answer stands, and this section is
the definitive statement so the question does not reopen.

**The pros of role-aware fleet-mcp, honestly stated:** it would be the smaller
diff (extend the existing `role` enum at `src/tools/compose-permissions.ts:17`),
it would let `register_member` and ad hoc callers say "make this member a
deployer" without owning a mapping, and it would give the tool surface a
vocabulary humans already use.

**Why it loses anyway:**

1. The existing enum is already a legacy artifact under phase-out. `role` is
   `z.enum(['doer','reviewer']).optional()` (`compose-permissions.ts:17`),
   collapsed by `resolvePrimaryMode()` (`:145-153`) into a binary that selects
   `base-dev` vs `base-reviewer` (`:122, :159`) and is passed to every provider
   adapter as `composePermissionConfig(role: 'doer'|'reviewer', allow)`
   (`src/providers/provider.ts:152`). The operator's architectural correction
   (recorded in doc A section 0) is that doer/reviewer was a poor early choice
   surviving only for backward compatibility. Widening the enum would deepen a
   leak that is scheduled for removal.
2. Role is a WORKFLOW concept. The engine already knows, at every dispatch
   site, which member is about to play which role: `roleMap` is normalized once
   in `validateArgs` (`runner.js:2335-2345`), resolved by `getMemberForRole` /
   `getMembersForRole` (`runner.js:4915, 4922`), and every phase dispatch
   passes both the member and the `agentType` explicitly (e.g. the deployer at
   `runner.js:7740-7767`). No other layer can know this, and no other layer
   needs to. fleet-mcp composing "for a deployer" would mean fleet-mcp being
   told a workflow fact it has no business holding -- and every future role
   added to `contracts.ROLES` would become a core-product schema change.
3. The role-free interface already half-exists. `grant: string[]`
   (`compose-permissions.ts:20`) is a concrete, role-free permission input on
   the reactive path. What is missing is only its proactive twin (Section 6.1).
4. What the coarse provider adapters actually need is not a role. `codex`
   ignores `allow` entirely and maps role to `approval_mode`
   (`src/providers/codex.ts:148-161`); `opencode` ignores `allow` and maps role
   to coarse edit/write/bash allows (`src/providers/opencode.ts:170-175`). The
   information they consume is "may this composition write", which is a
   property of the permission SET, not of a workflow role. That axis survives
   as `write_mode` (Section 6.1); the role name does not.

**The layering, normatively:**

| Layer | Knows about roles | Owns |
|---|---|---|
| fleet-mcp (`src/tools/*`, `src/providers/*`) | Nothing. It composes and delivers concrete permission sets. It must not be able to tell a deployer from a harvester. | The single sanctioned write path, provider adapters, `NEVER_AUTO_GRANT`, delivery verification |
| Workflow engine (`runner.js`, apra-pm `auto-sprint.js`) | Everything. Role is first-class here, as in any human workflow. | role -> (base profile, write_mode) mapping; reading the project's compiled ledger to resolve role -> set names; per-phase provisioning calls |
| Target project (its own repo) | Its own roles' NEEDS. | Playbooks declaring `## Permissions`; the compiled `permissions.json` including role-to-set bindings (Section 7) |

The rule that makes the constraint testable: **if a change requires fleet-mcp to
learn a new role name, the change is wrong.** The role string never crosses the
MCP wire.

Delivery remains physically member-scoped -- a provider config file belongs to a
member, not to a role. Role-scoping is achieved temporally (the engine composes
the right set immediately before the phase that needs it) and is subject to
union semantics (Section 6.4).

---

## 3. Current state (verified against source at HEAD `f23da821`)

This section is the ground truth the rest of the document builds on. Nothing
here is aspirational.

### 3.1 `compose_permissions` (`src/tools/compose-permissions.ts`)

- Input schema (`:15-22`): member identifier, `role` (legacy enum, `:17`),
  `tags` (`:18`, role-agnostic except that `doer`/`reviewer` are magic
  mode-selecting values, `:147-149, :176`), `project_folder` (`:19`),
  `grant`/`grant_reason` (`:20-21`).
- Guard: at least one of `role` or `tags` is required (`:262-264`) -- there is
  no way today to compose from an explicit permission list proactively.
- Composition (`compose` `:121-140`, `composeFromTags` `:158-189`): base
  profile selected by role (`role === 'doer' ? 'base-dev' : 'base-reviewer'`,
  `:122, :159`); detected stack profiles merged under their `dev`/`reviewer`
  keys (`:126-132, :163-171`); `tag-<name>.json` per non-mode tag
  (`:175-181`); ledger `granted[]` merged last (`:134-138, :183-186`). All
  pure additive Set union.
- Stack detection (`detectStacks`, `:100-119`) runs live `ls` probes on the
  member -- real per-member state fleet-mcp is uniquely placed to observe.
- Ledger (`:56-59, :86-98`): `permissions.json` in `project_folder`, shape
  `{ stacks: string[], granted: [{permission, reason, date}] }` (template:
  `skills/fleet/profiles/tpl-permissions.json`). No `sets` key exists today.
  Only read/written when `project_folder` is passed.
- Reactive grant path (`:276-331`): refuses `NEVER_AUTO_GRANT` members
  (`:277-280`; the denylist itself at `:51-54`: `Bash(sudo:*)`, `Bash(su:*)`,
  `Bash(env:*)`, `Bash(printenv:*)`, `Bash(nc:*)`, `Bash(nmap:*)`,
  `Bash(chmod 777:*)`), expands `CO_OCCURRENCE` (`:42-48, :283-286`), contains
  a `provider.name === 'claude'` special-case read-merge branch (`:290-301`)
  that is a layering wart, appends to the ledger (`:314-323`), and re-delivers.
- Workspace trust is self-healed on every run (`seedWorkspaceTrust`,
  `:328, :356`).
- Delivery: `provider.composePermissionConfig(mode, allow)` +
  `provider.permissionConfigPaths()`, then `deliverConfigFile()` deep-merges
  into whatever is on the member (`deepMerge` `:202-212`; its doc comment
  `:195-201` records why wholesale overwrite is forbidden: it once destroyed
  `mcpServers['apra-fleet-member']`'s live JWT). No LLM involvement.

### 3.2 The delivery defect (the blocking one)

`deliverConfigFile` (`compose-permissions.ts:219-255`):

- The mkdir command's result is discarded (`:226-229`).
- The remote read for merge has a hardcoded 5000 ms timeout (`:236`).
- The write command is built at `:251-253` (Windows:
  `[System.IO.File]::WriteAllText(...)` with naive single-quote doubling;
  POSIX: a heredoc) and executed at `:254` as
  `await strategy.execCommand(writeCmd, 5000);` -- **the result is never
  checked**. There is no read-back. A failed, timed-out, or truncated write
  still yields the tool's success string ("Granted N permissions...",
  `:330`).
- The read-merge-write sequence (`:233-254`) holds no lock. Two concurrent
  composes against one member are a silent lost-update race.

Live evidence (2026-08-04 incident, recorded in doc A 2.1.1 and preserved here
as the motivating data): three consecutive `compose_permissions` calls against
`fleet-lin-dev1`, `fleet-win-dev1`, and `fleet-mac` reported success while
writing 0/19, 0/19, and 17/19 of the requested entries respectively; an
isolated retry of the two dropped entries on `fleet-mac` also silently failed.
(This is operational evidence from the incident log, not something re-runnable
from this tree; the code paths that make it possible are verified above.)

### 3.3 Registration (`src/tools/register-member.ts`)

Since `apra-fleet-5oo.1`, registration auto-runs compose and hard-refuses the
registration on failure (`:399-414`). The call hardcodes `role: 'doer'`
(`:403`) and does NOT pass `project_folder`, so a project's ledger is never
merged at registration. Two additional `role: 'doer'` stamps exist on the
identity axis: the minted member token (`:440-444`) and
`sessionRegistry.register()` (`:486-494`).

### 3.4 Providers (`src/providers/*.ts`)

Interface: `composePermissionConfig(role: 'doer'|'reviewer', allow?)`
(`provider.ts:152`).

- `claude` (`claude.ts:272-274`): writes `permissions.allow` verbatim to
  `.claude/settings.local.json`; ignores role.
- `agy` (`agy.ts:214-217`): translates via
  `convertClaudeAllowToAgyPermissions` (`agy.ts:321-365`); ignores role; has no
  per-project trust concept (`agy.ts:308-313`).
- `gemini` (`gemini.ts:165-179`): role -> mode in settings.json; `allow` into
  `fleet.toml`.
- `codex` (`codex.ts:148-161`): **ignores `allow` entirely**; role ->
  `approval_mode` full-auto/suggest + sandbox network flag.
- `opencode` (`opencode.ts:170-175`): **ignores `allow` entirely**; coarse
  edit/write/bash allow/deny by role.
- `copilot` (`copilot.ts:140-155`): partially honors `allow` -- doer gets
  `allow-all-tools: true` plus a `tools.allow` list; reviewer gets a deny list
  for write/edit/run_command. (Doc B's table understated this as "approval
  flag only"; corrected here.)

### 3.5 Classification and routing (current)

- `classifyPromptError` (`src/utils/prompt-errors.ts:16-18`) is first-match-wins
  over whatever output string it is handed. Categories (`:1`): `auth`,
  `server`, `overloaded`, `max_turns`, `workspace_not_trusted`, `unknown`.
  `permission_error` is inside the `auth` pattern (`:11`).
  `workspace_not_trusted` is matched first on the CLI's exact phrase (`:10`).
- `execute_prompt`'s structured reason union (`src/tools/execute-prompt.ts:44`)
  has no `missing_grant` / `os_permission_denied` / `provider_cannot_grant`.
- `AGENT_RAN_DISPATCH_REASONS` (`runner.js:4241`) is exactly
  `{'max_turns_exhausted', 'watchdog_timeout'}`.
- `packages/apra-fleet-client/src/client/api.mjs`: `composePermissions` is a
  passthrough at `:333-335` with a `ComposePermissionsOptions` typedef
  (`:147-152`) that mirrors the legacy `role` enum; `executePrompt`
  (`:219-222`) is a passthrough with NO typedef for the structured result's
  `reason` -- the reason union has already drifted (`server`, `overloaded`
  added server-side) with nothing catching it, which is the evidence for
  Section 8.4's structural fix.
- `packages/fleet-api-contract` exists (src/: `endpoints.ts`, `openapi.ts`,
  `schemas/`) and is the natural home for a shared reason enum.

### 3.6 What does NOT exist at HEAD (corrections to both source docs)

- **There is no pre-sprint permission-diff gate in `runner.js`.** Commit
  `abc61c28` added one; commit `c0dd7474` reverted it, and the revert is in
  HEAD's ancestry (verified with `git merge-base --is-ancestor`). Grep for the
  gate's markers in `runner.js` finds nothing. Doc A's present-tense framing
  ("commit abc61c28 added ... its fate is under separate review") is stale:
  the fate is decided, it is gone.
- **There is no root `permissions.json` in this repo.** Commit `e5eea375`
  seeded one plus a drift-guard test; commit `1dddf9a5` reverted both and
  re-ignored `/permissions.json` in `.gitignore`. Also stale in doc A.
- **Doc B's provider-token claim is inverted.** Doc B asserts the tokens
  `Web`, `Fetch`, `Agent`, `Mcp(<server>)` "appear in no profile and in no
  provider". Half right: they appear in no profile (verified: `base-dev.json`
  and `base-reviewer.json` contain only `Read/Write/Edit/Glob/Grep` and
  `Bash(...)` entries). But the AGY converter explicitly maps ALL FOUR:
  `Agent` -> `invoke_subagent` + `send_message` (`agy.ts:338-340`),
  `Mcp(<server>)` -> `mcp` (`:351-353`), bare `Mcp` -> `mcp:*` (`:354-355`),
  `Web`/`Fetch`/`WebSearch` -> `read_url` (`:356-357`). Conversely the REAL
  Claude tool names `WebFetch` and `Task` match no branch and fall through to
  the catch-all (`:358-361`), which emits a server-side `console.warn` plus an
  inert `custom` rule. This is a standing never-silently-drop violation: a
  caller granting `WebFetch` or `Task` to an AGY member gets a success result
  and a rule AGY will never honor, with the only diagnostic a log line the
  caller never sees. Recorded as a concrete open defect: **the AGY converter
  has mappings for four phantom tokens nothing emits, and lacks mappings for
  two real tool names; unmapped tokens must be surfaced in the tool result,
  not just logged** (Section 10, step 2).
- The beads for the reverted commits (`apra-fleet-fahx`, `apra-fleet-fccm`) no
  longer resolve in bd. The revert rationale below (Section 9.1) is therefore
  reconstructed from the commits' own content, bead `apra-fleet-a1e6` (which
  explicitly indicts fccm's approach), and the same-day operator correction --
  flagged here so a human can validate the reconstruction.

---

## 4. Unified permission-failure taxonomy (resolves conflict 6)

Doc A and doc B named the same ideas differently: doc A spoke of the
`NEVER_AUTO_GRANT` denylist, workspace-trust self-healing, and
coarse-provider incapacity; doc B defined Categories A-E. One taxonomy, one
set of names. **Doc B's names win**, for a concrete reason: two of them already
exist verbatim in shipped code -- `workspace_not_trusted` is a live
classification category and structured reason
(`prompt-errors.ts:1,10`; `execute-prompt.ts:44`) and `NEVER_AUTO_GRANT` is a
live constant (`compose-permissions.ts:51`). Adopting doc B's vocabulary means
zero renames of existing identifiers; adopting doc A's prose labels would have
meant inventing new strings for things that already have names in the tree.
Doc B's organizing principle is also the right one: classify by REMEDIATION
OWNER (who can fix this, with what action), not by which layer refused --
because the remediation is the only thing a caller can act on.

The taxonomy applies on BOTH paths: proactively (what kind of gap is this, can
the system provision it?) and reactively (what kind of block just happened?).

| Name | Definition | Remediation owner and action | Retryable |
|---|---|---|---|
| `missing_grant` | The LLM CLI refused a tool because it is not in the member's composed allowlist | Fleet: this is the provisioned category. Proactively: Section 6 composes it before dispatch. Reactively: Section 8 surfaces it with `grantsNeeded` for human-reviewed declaration evolution. Never auto-granted from the reactive signal | Not until granted AND verified |
| `workspace_not_trusted` | The CLI silently ignores a config Fleet wrote because the workspace was never trusted; Claude drops `permissions.allow` wholesale (`prompt-errors.ts:4-10`) | Fleet: `seedWorkspaceTrust`, then re-deliver. Already self-healed on every compose (`compose-permissions.ts:328,356`). This is the governing precedent for "wrote the file" != "the CLI honors it" | After trust + re-delivery |
| `os_permission_denied` | The CLI ran the tool; the host OS / kernel / daemon refused (docker socket, EACCES, sudo password) | Human, on the member host. `compose_permissions` can NEVER fix this; it must never produce a proposed grant or a playbook diff | No |
| `provider_cannot_grant` | A member on a provider with no allowlist model (`codex`, `opencode`; `copilot` partially -- see 3.4) was refused by its approval policy | Operator: a deliberate approval-mode / member-configuration decision. Never auto-proposed | No |
| `NEVER_AUTO_GRANT` (policy gate, not a classification) | An extracted or supplied permission is on the denylist (`compose-permissions.ts:51-54`) | Human escalation only. Enforced at every entry point: reactive `grant` (already, `:277-280`), the new proactive inputs, compiled `sets` content, and PROPOSAL time in the reactive diff flow -- a generated diff proposing `Bash(sudo:*)` is precisely the artifact a tired operator approves | n/a |

Two structural rules carried from doc B, normative here:

- **`missing_grant` is positively identified** from the provider's structured
  refusal event only, never inferred from free text (Section 8.1).
- **`os_permission_denied` is derived as the residual** -- a permission-shaped
  terminal failure that is NOT a structured refusal. It gets no competing
  pattern in any first-match-wins list. If an implementer finds themselves
  writing an `os_permission_denied` regex racing `missing_grant` in
  `classifyPromptError`'s array, this design has been misread.

Why the `missing_grant` / `os_permission_denied` split earns its keep (decision
recorded once, from doc B): they are remediated by different owners, and the
cost of conflation is asymmetric -- a misdiagnosed OS denial that produces a
grant proposal gets reviewed, approved, committed, and applied; the retry fails
identically; and the project has permanently widened its permission surface in
exchange for nothing. A ratchet-opening misdiagnosis is materially worse than a
wrong label.

Resolved here (was doc B open question 1): `os_permission_denied` IS a
first-class `reason` value, not an advisory field. Callers branch on `reason`,
and "do not retry, do not grant, fix the host" is the single most actionable
thing the system can say; that it is derived rather than matched is an
implementation property, not a contract property.

---

## 5. Blocking prerequisite: reliable, verified delivery (resolves conflict 5)

Both docs independently found the same gap; it is stated once, here, and it is
**Step 0 of the rollout -- nothing else in this design ships before it.**

The defect (verified, Section 3.2): `deliverConfigFile` discards its write
command's result (`compose-permissions.ts:254`) and never reads the file back.
The tool cannot distinguish "delivered" from "silently didn't", and in the
2026-08-04 incident it consistently didn't. Every benefit claimed by proactive
per-phase composition ("the grant is delivered") is false until this is fixed
-- worse than false: a phase that BELIEVES it just provisioned a member
dispatches with higher false confidence than today's stale
registration-time-only compose.

Requirements:

1. **Check the write result.** Non-zero exit or stderr from the mkdir, read,
   or write commands -> throw. Never continue silently.
2. **Read back and verify.** After every delivery, re-read the target config
   path and confirm the composed permissions are present before returning
   success. Verification failure is a hard, distinguishable error propagated
   to the caller; under Section 6's wrapper it is a persistent failure that
   fails the phase (Section 9.2). "Wrote the file" is not "the CLI honors it"
   -- the read-back proves the write; workspace trust (already self-healed at
   `:328,356`) covers the honor half for Claude; both must have completed
   before the dependent dispatch.
3. **Diagnose the transport before choosing the fix.** The hardcoded 5000 ms
   timeouts (`:229, :236, :254`) plus an unchunked multi-KB payload are the
   likely (unconfirmed) cause of the partial-vs-total write failures observed.
   Measure write latency against realistic payload sizes on all three OS
   families before picking between: larger timeout, chunked delivery reusing
   the pattern `writePromptFile` already uses for large prompts
   (base64-chunked append loop, `execute-prompt.ts:176-206` -- which also
   sidesteps quoting fragility), or a different transport primitive.
4. **Windows escaping.** The current write path does naive single-quote
   doubling into a PowerShell string literal (`:252`). Grant strings can
   originate from model-influenced text on the reactive path; the chunked
   base64 route of (3) is preferred precisely because it removes the escaping
   surface. Whatever is chosen, escaping requirements must be explicit and
   tested on both OS paths.
5. **Per-member delivery lock.** The read-merge-write at `:233-254` must be
   serialized per member (in-process mutex keyed on member id is sufficient --
   all writes flow through this one server). Two concurrent composes must not
   lose updates.
6. **Session-resume semantics.** CLIs read settings at process start. A grant
   applied while a member session is live may not take effect until a fresh
   session, so "grant then resume the same session" can loop forever. Policy:
   after a compose intended to unblock a dispatch, the next dispatch must use
   a fresh session (the engine already owns session lifecycle via
   `memberSessionGuard.killIfAlive`, used at e.g. `runner.js:7762`); retry
   once.
7. **The incident workaround is not a pattern.** Bypassing
   `compose_permissions` and writing merged JSON via `execute_command` with a
   manual read-back was a one-time diagnostic; it defeats the single
   sanctioned provider-agnostic write path and must not be repeated. (Per this
   repo's CLAUDE.md: permission blocks are surfaced, not routed around --
   the same discipline applies to routing around our own delivery tool.)

---

## 6. Proactive delivery: the primary path

**One sentence:** immediately before each phase's dispatch, the workflow engine
resolves which permission set the member about to be dispatched needs -- using
its own role knowledge, the product's role -> profile defaults, and the target
project's compiled ledger bindings -- and calls `compose_permissions` with
concrete, role-free inputs; fleet-mcp composes, delivers through the provider
adapter, verifies (Section 5), and knows nothing about why.

### 6.1 Role-free `compose_permissions` inputs

```
compose_permissions({
  member_name,                 // unchanged
  permissions: string[],       // NEW: explicit concrete entries to merge in
  profiles: string[],          // NEW: named base profiles to load (opaque names)
  ledger_sets: string[],       // NEW: named sets from the project ledger to merge
  write_mode: boolean,         // NEW: the coarse axis the adapters genuinely need
  tags: string[],              // unchanged (doer/reviewer magic values deprecated)
  project_folder,              // unchanged; required whenever ledger_sets is used
  grant, grant_reason,         // unchanged reactive path
  role,                        // LEGACY doer|reviewer only; deprecated; no new values ever
})
```

- `permissions[]` is the proactive twin of the existing `grant[]` shape --
  merged into the composed set like a ledger grant. `NEVER_AUTO_GRANT` is
  enforced against it (and against `ledger_sets` content): the denylist is a
  product safety property and must not be bypassable by an engine-supplied
  list.
- `profiles[]` names are opaque to fleet-mcp -- filename lookup and Set union,
  nothing more. The actual leak today is not the filename `base-dev` but the
  DERIVATION `role === 'doer' ? 'base-dev' : 'base-reviewer'`
  (`compose-permissions.ts:122`); the caller supplying the name removes it.
  Ship with existing filenames now; add permission-shape aliases
  (`base-write`/`base-readonly`, plus new `base-verify`/`base-operate`) as a
  later cosmetic step -- alias, never hard-rename, because installed skill
  dirs (`~/.claude/skills/fleet/profiles/`) must keep resolving.
- `write_mode` replaces `resolvePrimaryMode()`'s output at the provider
  boundary. The provider interface becomes
  `composePermissionConfig(mode: 'write'|'readonly', allow)` with the old
  strings accepted as deprecated aliases (touches every adapter listed in 3.4;
  pure rename). It also selects between stack-profile inner keys
  (`dev`/`reviewer` today, `:126,:163`), which get the same alias treatment.
  fleet-mcp stays truthful: it knows a set is read-only; it does not know it
  is composing for a reviewer.
- `role` stays accepted, marked deprecated in `.describe()`, internally mapped
  to `profiles` + `write_mode`. It gets no new values, ever. It is deleted
  when its last caller (`register_member`, Section 10 step 9) migrates.
- Composition order (all additive, order-independent):
  named profiles -> detected stack profiles -> tag profiles -> ledger
  `granted[]` -> requested `sets[].allow` -> caller `permissions[]`.

### 6.2 The engine-side wrapper

Structurally parallel to the existing `withGitSync` (`runner.js:4999`), which
is the established precedent for a member-side dispatch precondition:

```
withPhasePermissions(role, member, () => agent(prompt, { agentType: role, member_name: member, ... }))
```

- Runs at phase start for each member the phase will dispatch to. Roles are
  already explicit at every dispatch site; `getMemberForRole` /
  `getMembersForRole` (`runner.js:4915,4922`) already resolve the pairing. No
  new role-routing machinery.
- Resolves `role -> { profiles, write_mode }` from the PRODUCT-owned default
  map (a sibling of `contracts.ROLES`, keyed by it) and
  `role -> set names` from the PROJECT's compiled ledger bindings
  (Section 7.3). Calls
  `client.composePermissions({ member_name, profiles, ledger_sets, write_mode, tags, project_folder })`
  through `packages/apra-fleet-client` (`api.mjs:333`), whose
  `ComposePermissionsOptions` typedef (`api.mjs:147-152`) is updated in the
  same change -- CLAUDE.md makes client parity part of the tool change itself.
- The role string never crosses the wire.
- Passes `project_folder` -- closing the registration-era gap where the ledger
  is never merged (3.3).
- Idempotent and memoized per `(member, resolved-set-signature)` per sprint
  run; re-compose on cycle boundaries only if a cheap ledger fingerprint
  changed. Cost: one MCP round trip plus two `ls` probes per distinct pair --
  negligible against a dispatch.

### 6.3 Registration-time compose = baseline; phase-time compose = the workflow layer

`register_member` keeps composing a baseline so a fresh member is never an
attribution-only stub, and keeps its hard-refuse-on-failure contract
(`register-member.ts:399-414`, `apra-fleet-5oo.1`). It migrates from
`role: 'doer'` to the new interface: explicit baseline profile name (same
content as today's `base-dev` -- keeping current effective behavior is the
no-regression choice), the member's tags, and `project_folder` when the member
is registered against a known project. Phase-time compose then layers
additively on that baseline. (This resolves doc A's open question Q6: the
baseline is the current content under a non-role name, tag-adjustable; the
member's future roles are unknowable at registration and nothing is gained by
pretending otherwise.)

### 6.4 Union semantics (resolves conflict 3 -- stated once)

Both source docs independently discovered the same fact; here is its single
statement. **The effective grant on a member is the union of everything ever
composed onto it**: composition is Set union
(`compose-permissions.ts:121-189`), delivery is `deepMerge`
(`:202-212, :244`), and delivery is physically member-scoped. Consequences,
accepted deliberately for v1:

- A member serving multiple roles across phases accumulates the union across
  the sprint. A grant `deploy.md` needs is, once delivered, available to every
  other role dispatched to that member.
- True per-phase NARROWING would require replace-not-merge delivery, which
  risks clobbering co-tenant keys in the same file (the JWT incident recorded
  at `:195-201`) and churns the config every phase. Deferred with an explicit
  revisit trigger (Section 12).
- What keeps union semantics from collapsing into "everything, everywhere":
  the powerful entries live in PROJECT sets that are only requested for the
  phases that need them (first delivery is as-late-as-needed), `write_mode`
  keeps the write axis orthogonal to breadth (a deployer set can be wide and
  still read-only on source -- the deployer is already dispatched with
  `pushCode: false`, `runner.js:7755`), and `NEVER_AUTO_GRANT` caps the
  ceiling. Breadth is orthogonal to the write axis; "vivid" does not mean
  "unbounded".

---

## 7. Declaration pipeline and authority (resolves conflict 1)

### 7.1 The conflict, honestly

Doc B: the committed playbook `## Permissions` section is the source of truth;
`permissions.json` is a derived cache and audit trail, never an independent
grant source. Its strength: playbooks are what humans author, review, and
commit, and what the executing agents' own Step 0 checks read -- authority and
review live in one visible place. Its weakness: taken literally, something in
the delivery path has to read playbooks -- and the reverted gate (`abc61c28`)
shows exactly how that goes wrong: the engine grew a hardcoded list of three
apra-fleet-specific playbook filenames, violating the genericity constraint
that fleet-sprint is a general product (CLAUDE.md fleet-sprint-product-vs-
dogfood; bead `apra-fleet-a1e6` was filed against precisely this leak).

Doc A: the engine consumes `permissions.json` (extended with named `sets`) at a
conventional path and is forbidden from knowing playbook filenames. Its
strength: the genericity constraint is load-bearing and this satisfies it;
`loadLedger` already exists (`compose-permissions.ts:86-93`). Its weakness: if
`permissions.json` is independently authored, it becomes a second grant source
that can silently diverge from what the playbooks declare -- doc B's exact
objection, and doc A's own sharpest open risk (its Q4: an in-sprint agent with
`Write` could add a set entry and self-grant on the next phase).

### 7.2 Resolution: a compiler pipeline, not a winner

The two positions are reconcilable because they answer different questions.
**Authority** (who decides what a project may do): the playbooks.
**Consumption** (what machines read): the compiled ledger. Concretely:

```
playbook ## Permissions sections          (authored, reviewed, committed -- SOURCE OF TRUTH)
        |
        v  a1e6 compiler (project-side tool; discovers playbooks by the
        |  project's own convention -- glob/manifest -- NEVER run by the engine)
        v
permissions.json  { stacks, granted, sets, bindings }   (COMMITTED, generated, drift-guarded)
        |
        +--> engine reads bindings to resolve role -> set names   (conventional path only)
        +--> fleet-mcp reads sets[<name>].allow via project_folder (opaque names)
```

- The **playbook wins**. The compiled ledger is committed (reviewable diffs,
  stable input for the engine) but GENERATED: a project-local drift-guard test
  (scaffolded by the a1e6 tool, as the reverted `e5eea375` prototyped for this
  repo before it was reverted for being hand-rolled and target-specific) fails
  CI whenever the ledger and the playbooks disagree. A ledger entry with no
  playbook provenance is drift: reported, never silently honored as if
  declared.
- The **engine never knows a playbook filename**. It knows one conventional
  path (`<project_folder>/permissions.json`) and asks for set names resolved
  from that file's own bindings. The a1e6 compiler -- which DOES walk playbooks
  -- is a project-side authoring tool a human or CI runs, not engine code.
  (This is exactly the split a1e6's bead text draws: reusable authoring
  tooling now; engine auto-invocation deliberately out of its scope.)
- **`granted[]` keeps its current meaning** (project-wide, applied to every
  composition, zero migration for existing ledgers) and doubles as the
  reactive audit trail: mid-sprint reactive grants land there with
  `{permission, reason, date}` provenance (`compose-permissions.ts:314-323`)
  and are REPORTED as pending-promotion drift. The durable fix is promoting
  them into a playbook and recompiling -- doc B's evolution flow, Section 8.5.
- **`sets`** is new: named, task/activity-scoped allow lists with reasons.
  fleet-mcp unions `sets[<name>].allow` for requested names; it never
  enumerates them and has no opinion about what a name means.
- **`bindings`** is new and is what makes the genericity constraint hold
  without a naming convention: a map from workflow role names to set names
  (e.g. `{ "deployer": ["deploy"], "integ-test-runner": ["integ-test"] }`),
  emitted by the compiler from the project's own playbook-to-role knowledge.
  Note the direction: the TARGET knowing the engine's role taxonomy is normal
  and already true (projects author playbooks specifically for the deployer /
  integ-test-runner / regression-test-runner roles); the ENGINE knowing the
  target's file layout is the forbidden direction. fleet-mcp never reads
  `bindings` at all -- only the engine does, and it receives resolved set
  names, not roles, over the wire. (This settles doc A's Q3: the role mapping
  is split -- product-owned `role -> {profiles, write_mode}` defaults beside
  `contracts.ROLES`; project-owned `role -> sets` via bindings.)

Example compiled ledger:

```json
{
  "stacks": ["node"],
  "granted": [
    { "permission": "Bash(docker:*)", "reason": "granted mid-sprint: integ tests", "date": "2026-08-01" }
  ],
  "sets": {
    "deploy":     { "allow": ["Bash(docker:*)", "Bash(systemctl:*)"], "reason": "deploy.md steps 3-7" },
    "integ-test": { "allow": ["Bash(npm run test:integ:*)", "Bash(bd:*)"], "reason": "integ-test-playbook.md" }
  },
  "bindings": {
    "deployer": ["deploy"],
    "integ-test-runner": ["integ-test"]
  }
}
```

### 7.3 The self-grant risk, closed (doc A's Q4, decided)

An in-sprint agent with `Write` could edit `permissions.json` (or a playbook)
and launder a self-grant into the next phase's compose. Defense in depth, all
four layers required:

1. **Drift guard**: the compiled ledger is regenerated deterministically from
   playbooks; a hand-edited ledger fails the project's drift test, and a
   playbook edit shows up as a reviewable diff in the sprint's PR -- the same
   review surface as any other code change.
2. **`NEVER_AUTO_GRANT`** is enforced against `sets` content and `permissions[]`
   at compose time (Section 6.1) -- the worst entries cannot be smuggled
   regardless of file edits.
3. **Deny rule where expressible**: base profiles gain
   `deny: ["Write(permissions.json)", "Edit(permissions.json)"]` on providers
   that support deny lists (Claude); coarse providers cannot express it, which
   is acceptable because layers 1-2 are provider-independent.
4. **Within-sprint honoring rule**: the engine resolves bindings/sets from the
   ledger as of the sprint's base commit, not the working tree, so an edit
   made DURING the sprint cannot affect that same sprint's composes.

This is deliberately not "refuse to run if the ledger changed" -- that would be
another block-and-abort gate on a condition better handled by review plus
determinism (Section 9).

---

## 8. Reactive backstop: classification, extraction, contract (the separable workstream)

This section is doc B's surviving core, corrected. It is implementable as a
standalone workstream (it touches `prompt-errors.ts`, provider adapters,
`execute-prompt.ts`, `fleet-api-contract`, `errors.mjs`/`runner.js` routing --
none of the Section 5-7 machinery), and the unified design references it rather
than depending on it: proactive delivery is the primary path; this is what
catches what the declarations never knew.

### 8.1 Detection: structured envelopes, not raw regex

The deeper defect behind the `auth` misclassification is WHERE classification
runs and over WHAT: `classifyPromptError` is first-match-wins over an entire
concatenated transcript (`prompt-errors.ts:16-18`) that contains the model's
own prose and every command's output. No taxonomy survives that surface (live
precedent: a test suite printing `EACCES: permission denied` once reclassified
a whole dispatch as a credential failure). Normative rules:

1. `missing_grant` is matched against the provider's STRUCTURED refusal event
   only (Claude `--output-format json` fields; Codex NDJSON error events; AGY
   transcript entries), owned by each provider adapter behind the existing
   `provider.classifyError` seam (already the dispatch point,
   `execute-prompt.ts:140`).
2. Raw-text matching is a last-resort heuristic explicitly allowed to return
   `unknown`; a bounded terminal-error window, never the whole transcript.
3. `os_permission_denied` is the derived residual (Section 4). No pattern
   entry.
4. Move `permission_error` out of the `auth` regex (`prompt-errors.ts:11`) as
   part of this work -- it is the last token there describing a tool block
   rather than a credential failure.
5. Precision over recall: every pattern is justified against its
   false-positive cost, because `auth` fires `provision_llm_auth` and kills
   retries (`errors.mjs:372-375, 391-393`).

### 8.2 Extraction (`extractGrantsNeeded`)

Reverses the structured refusal into unified grant strings. Normative:
no-match is normal (`{reason:'missing_grant', grantsNeeded: []}` is valid --
never force a guess); extraction deliberately widens (`docker ps` ->
`Bash(docker:*)`, then `CO_OCCURRENCE` expansion, `compose-permissions.ts:42-48`)
and every widening is SHOWN in the proposed diff; dedupe with a fixed cap; run
against the untruncated buffer. Vocabulary rule: tokens must be verifiable
against `skills/fleet/profiles/*.json` and real provider mappings -- see the
AGY inverted-coverage defect (3.6) for what happens otherwise.

Threat model, absolute: **`grantsNeeded` is a hint for a human, never an
authority, never an input to an automated write.** The text it derives from is
model-influenceable. Proposed diffs carry provenance (member, dispatch,
verbatim refusal). `NEVER_AUTO_GRANT` members are refused at PROPOSAL time
(Section 4). `apra-fleet-workflow` must never react to `missing_grant` by
calling `compose_permissions`.

### 8.3 Routing: `missing_grant` is an agent-ran failure

`AGENT_RAN_DISPATCH_REASONS` (`runner.js:4241`) is today
`{'max_turns_exhausted','watchdog_timeout'}`. `missing_grant` MUST be added: a
grant block typically lands mid-task, after real commits exist on the member;
any new reason outside that set falls into the no-mutation bucket by default
and post-dispatch G-push/D-push is skipped, stranding work. Regression guard in
`packages/apra-fleet-se/test/error-classification-routing-table.test.mjs`
(exists, verified).

### 8.4 Contract: one shared reason enum

`ExecutePromptStructured.reason` (`execute-prompt.ts:44`) gains
`missing_grant`, `os_permission_denied`, `provider_cannot_grant` (additive;
unknown values degrade to the conservative `nonzero_exit` bucket -- state this
in the contract because `fleet-sprint` branches on specific reasons). Parity
with `packages/apra-fleet-client` is made STRUCTURAL: define the enum once in
`packages/fleet-api-contract` (exists: `src/schemas/`), import it in both
`execute-prompt.ts` and the client, add a contract test that fails on
divergence. The evidence this must be structural rather than procedural: the
client has no result-reason typedef at all today (`api.mjs:219-222` is a bare
passthrough) and the enum has already drifted (`server`, `overloaded` added
with nothing catching it).

### 8.5 Declaration evolution flow

On a reactive `missing_grant` with extracted grants: the sprint logs a proposed
PLAYBOOK diff (with provenance and explicit widening annotations); a human
reviews and commits; the a1e6 compiler regenerates `permissions.json`; the next
sprint's proactive compose delivers it. The in-flight sprint still fails the
phase -- acceptable ONLY because proactive delivery makes reactive discovery
the exception; a rising reactive-grant rate is the signal that declarations or
profiles are wrong (Section 11), and if it stays common the park/resume
question reopens (Section 12).

---

## 9. Failure handling: provision what you can, police what you cannot (resolves conflict 4)

### 9.1 The evidence: why the gate and the seed were reverted

The posture question -- hard preflight gate vs provisioning -- is not abstract;
this branch ran the experiment. Commit `abc61c28` (pre-sprint permission-diff
gate, bead apra-fleet-fahx) and commit `e5eea375` (root `permissions.json`
seed + drift test, bead apra-fleet-fccm) both landed and were both reverted
within minutes of each other (`c0dd7474`, `1dddf9a5`, 2026-08-04 09:02-09:04),
the same morning as the operator's architectural correction. The revert
commits carry no message body and the two beads no longer resolve in bd, so
the following rationale is reconstructed from the original commits' content,
bead `apra-fleet-a1e6` (which explicitly indicts fccm's approach), and the
correction -- a human should confirm it matches intent:

- **Genericity violation.** The gate hardcoded
  `deploy.md`/`integ-test-playbook.md`/`regression-test-playbook.md` into
  `runner.js` -- target-specific structure inside the general engine, the
  precise leak `a1e6` was filed against ("only works because apra-fleet
  dogfoods fleet-sprint on itself"). The seed's drift test hand-rolled the
  same three filenames.
- **Provider leak.** The gate read `.claude/settings.json` only -- a
  Gemini/AGY/OpenCode member is mis-diagnosed by construction.
- **Anti-least-privilege by construction.** The gate unioned every declared
  permission across every dispatchable member regardless of role (its own
  commit message: "computes the dispatchable member set ... and checks each
  member's ... permissions.allow" against the union of all runbooks), so a
  review-only member was refused for lacking deployer grants. The seed made
  it worse: a flat `granted[]` union meant every future composition --
  including reviewers -- would receive deploy-grade grants project-wide.
- **The wrong output.** Report-only, no flag to fix: "abort; go hand-edit N
  members" -- which is exactly the 1.2-style hand-edit anti-pattern the whole
  design exists to eliminate, prescribed by the system itself.

The lesson is NOT "preflight checks are bad". It is: **a gate that can only say
"no", on a condition the system owns a trusted LLM-free provider-aware writer
for, converts a solvable provisioning problem into an unsolvable-by-the-system
human chore -- and leaks target structure into the engine to do it.** Both
reverted pieces reappear in this design in corrected form: the gate's
declared-permission parsing becomes the project-side a1e6 compiler; the seed's
ledger becomes the compiled, set-structured, bindings-carrying artifact of
Section 7.

### 9.2 The policy

- **Provisioned (never gated): permission coverage.** The engine composes the
  phase's set at phase start (Section 6). Bead `apra-fleet-5oo`'s remaining
  preflight scope is REDEFINED on this axis: verify that our own provisioning
  SUCCEEDED (compose returned verified success for each planned
  (phase, member) pair), not that a human pre-arranged the state.
- **Policed (hard preflight, refuse with an actionable error): what the
  orchestrator cannot fix.** `bd` binary presence on the member; VCS push/PR
  auth (provisioning credentials is `provision_vcs_auth`'s separate path;
  readiness remains a preflight question); provider reachability and auth
  freshness; and `provider_cannot_grant` incapacity -- when a phase's resolved
  set requires fine-grained allows on a provider whose adapter declares it
  cannot express them (capability predicate, Section 10 step 6), that is
  surfaced at preflight as "not satisfiable on this provider", a true
  member-configuration decision for the operator. A verification gate over
  coarse providers must say "not verifiable here", never produce a false pass
  or a false refusal.
- **Compose failure at phase start:** transient (transport, unreachable,
  timeout) -> bounded retry with backoff (2 retries), same as any member-side
  precondition. Persistent (non-success result, verification failure, retries
  exhausted) -> **fail the PHASE, not the sprint**, with a structured ASCII
  error naming member/phase/provider/config-path/underlying error; the
  sprint's existing per-phase degradation handles it like any dispatch
  failure. (This settles doc A's Q1: no special sprint-abort for
  Deploy-phase compose failures -- per-phase degradation is uniform; escalate
  to sprint abort only if the SAME member+set compose fails persistently
  across two consecutive cycles, at which point the sprint provably cannot
  reach a deployable outcome.)
- **Never** dispatch anyway on unknown permission state; a dispatch with
  unknown permission state is the original failure mode.
- **Never** let in-sprint code widen its own grants -- the safety classifier
  precedent (docs/auto-sprint-permission-diff-safety-block.md) stands
  absolutely. Composing a pre-declared, human-reviewed, committed set via
  trusted orchestrator-side code is provisioning, not self-granting -- the
  decision was made by a human at review time, not by an agent at run time.
  That distinction is the entire moral basis of this design.
- The deployer's Step 0 refuse-and-report remains unchanged as the last line
  of defense rather than the first.

---

## 10. Migration and rollout

Order matters; each step is independently shippable and behavior-preserving
until step 7 flips the flag.

- **Step 0 (blocking): the delivery fix** (Section 5). Write-result checking,
  read-back verification, transport diagnosis, per-member lock, Windows
  escaping. Nothing else lands first.
- **Step 1:** Add `permissions[]`, `profiles[]`, `ledger_sets[]`, `write_mode`
  to `compose_permissions`; `role` becomes a deprecated alias. No behavior
  change for existing callers. Same change updates
  `packages/apra-fleet-client`'s `ComposePermissionsOptions`
  (`api.mjs:147-152`) -- client parity is part of the tool change, not
  follow-up.
- **Step 2:** Provider hygiene: rename the adapter parameter to
  `'write'|'readonly'` with aliases across all seven adapters (3.4); move the
  `provider.name === 'claude'` read-merge branch
  (`compose-permissions.ts:290-301`) behind a provider capability method; fix
  the AGY converter's inverted coverage (3.6) -- add `WebFetch` and `Task`
  mappings (or an explicit surfaced non-translation), remove or quarantine the
  phantom `Web`/`Fetch`/`Agent` tokens, and surface unmapped tokens in the
  tool RESULT, not only console.warn.
- **Step 3:** Ledger schema: `sets` + `bindings` keys (absent keys = today's
  behavior; existing ledgers valid unchanged); new `base-verify` /
  `base-operate` built-in profiles (`base-operate` starts near-empty --
  powerful entries belong in project sets, settling doc A's Q5).
- **Step 4:** The a1e6 compiler + drift-guard scaffold as reusable
  project-side tooling in `packages/apra-fleet-se` (per the bead: discovery by
  glob/manifest, not a hardcoded filename list). Run it once per adopting
  project; for this repo that regenerates, in corrected set-structured form,
  what `e5eea375` hand-seeded.
- **Step 5:** Provider capability predicates (`supportsFineGrainedAllow()` or
  equivalent) so composition and preflight can distinguish "delivered" from
  "coarsely approximated" (feeds Section 9.2's policed axis).
- **Step 6:** Engine: product-owned role -> {profiles, write_mode} defaults
  beside `contracts.ROLES`; `withPhasePermissions` in `runner.js` behind a
  flag, default off.
- **Step 7:** Dogfood one sprint flag-on; then default on; redefine
  `apra-fleet-5oo.3`/`5oo.4` per Section 9.2 (5oo.4's missing-permission test
  case becomes "missing permission -> composed and delivered; compose failure
  -> phase blocked with actionable error").
- **Step 8 (parallel track, separable):** the Section 8 reactive workstream --
  classification envelopes, `extractGrantsNeeded`, reason-enum additions via
  `fleet-api-contract`, `AGENT_RAN_DISPATCH_REASONS` update + routing-table
  test, the playbook-diff proposal flow.
- **Step 9:** Migrate `register_member` off `role: 'doer'` (Section 6.3); once
  no caller passes `role`, delete the enum. File the identity-axis stamps
  (`register-member.ts:440-444, 486-494`) as a separate bead in the same
  phase-out epic -- permissions axis ships first (settles doc A's Q7).

---

## 11. Observability

The highest-leverage output is the data, and it is cheap -- not deferred:

- Per compose: member, provider, requested profiles/sets, resolved entry
  count, delivery outcome (verified / failed / coarsely-approximated), and
  duration -- this is also the dataset that closes Section 5's transport
  diagnosis.
- Per dispatch: whether a `missing_grant` fired, extracted grants, which
  set/binding was in scope, and whether a subsequent grant actually unblocked
  the work.
- Drift reports: ledger-vs-playbook drift (compiler/CI) and
  reactive-`granted[]`-pending-promotion (Section 7.2), so the ratchet is
  visible. Ratchet control: playbook entries carry reason+date provenance;
  entries not exercised within a review horizon are proposed for removal.
- The steering signal: a grant firing repeatedly across projects belongs in
  `skills/fleet/profiles/*.json`; one firing repeatedly in one project belongs
  in that project's playbook; one firing once belongs nowhere.

---

## 12. Open questions (genuinely unresolved only)

Everything resolved above (role-awareness, source of truth, gate-vs-provision,
taxonomy names, union-vs-narrowing for v1, mapping ownership, ledger
trust boundary, base-operate content, registration baseline, phase-out
sequencing, deploy-phase blast radius, os_permission_denied as a reason)
deliberately does NOT reappear here.

1. **Silent in-band degradation.** Exit-0 dispatches that narrate around a
   denied tool are invisible to everything in this design. Needs provider
   structured turn-event reading; own proposal. Until it exists, do not
   describe permission failures as "handled".
2. **Per-phase narrowing (revisit trigger).** v1 is additive-only
   (Section 6.4). Revisit if observability shows cross-role accumulation on
   shared members materially widening what a low-trust phase can touch --
   likely requiring adapter-side "replace the allow key only" delivery, which
   needs Step 0's verification machinery to be safe.
3. **Park/resume for reactive misses.** Section 8.5 accepts losing the
   in-flight phase on a reactive `missing_grant`. If observability shows
   reactive discovery staying common after proactive delivery is default-on,
   a park -> grant -> fresh-session resume path becomes worth its complexity.
4. **Transport fix selection.** Section 5 mandates diagnosis before choosing
   timeout-raise vs chunked-write vs new primitive; the measurement outcome
   decides, and it has not been run yet.
5. **Compiler conventions (a1e6's own scope).** Whether playbook discovery is
   glob, manifest, or frontmatter-based, and the exact `bindings` emission
   rules -- owned by the a1e6 implementation, target-side.
6. **Ratchet review cadence.** Section 11 defines the mechanism (provenance +
   unexercised-entry proposals); the horizon and who runs the periodic review
   is an operational policy decision for the humans.

---

## Appendix: disposition of the source documents

- `docs/design-role-wise-permission-delivery.md` (untracked): superseded in
  full. Its sections 0-3 survive as Sections 2, 3, 6 here; its 2.1.1 delivery
  incident is Section 5's evidence; its open questions Q1-Q8 are all either
  resolved inline (Q1 in 9.2, Q2 in 6.4/12.2, Q3 in 7.2, Q4 in 7.3, Q5 in
  10 step 3, Q6 in 6.3, Q7 in 10 step 9, Q8 moot -- the gate is reverted) or
  carried to Section 12.
- `docs/missing-grant-recovery-and-playbook-evolution.md` (committed):
  superseded in full. Its taxonomy survives (renamed nothing -- its names won)
  as Section 4; its detection/extraction/contract spec as Section 8; its
  grant-application requirements as Section 5 sub-requirements; its authority
  statement as Section 7 (inverted from "ledger is a cache" to "ledger is the
  compiled artifact", preserving its intent that the playbook wins); its
  provider-token claims corrected per Section 3.6.
