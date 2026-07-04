<!-- llm-context: Design brainstorm for how new members get onboarded onto apra-fleet, written
     2026-07-03 in response to human feedback that (a) 3b's answer cannot be .mcp.json,
     (b) the current design only considered Claude Code when apra-fleet must work across
     Claude, AGY, and OpenCode, and (c) onboarding needs a frictionless user journey that
     starts single-machine but extends to LAN and eventually WAN without a breaking
     redesign. This is a discussion document, not yet an implementation. -->

# Member Onboarding: User Journey Design Brainstorm

## 0. Where this comes from

`register_member` today (`src/tools/register-member.ts:330-370`) only wires up the
interactive HTTP/JWT session when `isLocal && memberProvider === 'claude'`. For that one
case, it hardcodes:
- the server at `127.0.0.1:7523` (tracked as 2.3.3 / issue `apra-fleet-2xs.3`),
- `project_id: 'default'` (tracked as 2.3.2 / issue `apra-fleet-2xs.2`),
- the MCP entry written straight into `<work_folder>/.claude/settings.local.json` --
  which is what open question 3b was about, and which `compose_permissions` then
  clobbers wholesale (issue `apra-fleet-2xs.1`).

The human's feedback on 3b: **the answer cannot be `.mcp.json`**, and while
`settings.local.json` (direct file write) and `claude mcp add --scope project` (CLI
verb) are roughly equivalent *for Claude*, the question itself was too narrow --
apra-fleet has three providers today (Claude, AGY, OpenCode) and the onboarding
mechanism has to work for all of them, not just Claude. The right answer depends on
the onboarding user journey, not on Claude Code's file layout in isolation.

## 1. Current journey (as-is, single machine, Claude-only)

1. Human, in the orchestrator's main conversation, runs `register_member` with a
   `work_folder` on the **same machine** the orchestrator process is running on.
2. The tool directly touches that machine's filesystem: spawns a `claude` process,
   writes `.claude/settings.local.json` by hand, mints a JWT inline.
3. If the member later runs `compose_permissions`, the file gets rewritten and the
   MCP entry silently disappears (the bug in `apra-fleet-2xs.1`).
4. For any non-Claude provider, or any member not on the orchestrator's own
   filesystem, none of this runs -- `isLocal && memberProvider === 'claude'` is the
   entire gate. Everything else falls back to the older SSH/subprocess-only path.

This is really a **push model**: the orchestrator reaches out and configures the
member's disk directly. It only works because today orchestrator and member share a
filesystem. It cannot survive LAN (different machine, no shared disk) let alone WAN
(no shared network trust at all).

## 2. Why "which file" was the wrong first question

3b asked "where does the MCP entry live" as if there's one universal answer file.
But the real design constraint is: **the mechanism that registers apra-fleet's MCP
endpoint with a member must be owned by that member's own provider CLI, because each
provider owns its own config surface and its own file-merge semantics** (this is
exactly why `compose_permissions` fighting a hand-written `settings.local.json` entry
is a bug -- Claude Code's own tooling doesn't know about our hand-edit and stomps it).

Ruling things out:
- **`.mcp.json`** -- ruled out by the human. It's a project-scoped file Claude Code
  reads, but (a) it's Claude-specific just like `settings.local.json`, and (b) it has
  its own merge/precedence rules relative to `settings.local.json` and CLI-registered
  servers that we'd be fighting just the same way, for no benefit over the CLI verb.
- **Hand-writing `settings.local.json`** (current code) -- works today but is
  exactly what `compose_permissions` clobbers; Claude Code doesn't know we wrote it,
  so nothing coordinates the merge. Claude-only.
- **`claude mcp add --scope project ...`** -- equivalent problem-for-problem to
  hand-writing the file (human confirmed these two are "equivalent" for Claude), but
  with one real advantage: it's the *provider's own* mutation path, so future changes
  to Claude Code's config format are Anthropic's problem, not ours, and it composes
  correctly with whatever `compose_permissions` or the user does afterward via the
  same CLI.

So the actual answer to 3b is: **there is no single file. Each provider gets its own
adapter method that performs *that provider's native* endpoint-registration action.**
For Claude that's the `claude mcp add` CLI verb. AGY and OpenCode need their own
investigated equivalents (this is now explicitly in scope for `apra-fleet-2xs.5`,
retitled/broadened below).

## 3. Provider-agnostic registration: extending the existing adapter pattern

The codebase already has exactly the right shape for this: `ProviderAdapter`
(`src/providers/provider.ts`) already abstracts `composePermissionConfig()` and
`permissionConfigPaths()` per provider (claude.ts, agy.ts, opencode.ts, codex.ts,
gemini.ts, copilot.ts each implement it). MCP-endpoint registration is missing the
same treatment -- it needs a new adapter method, e.g.:

```ts
/** Register (or update) this member's apra-fleet MCP endpoint using the provider's
 *  own native mechanism. Returns what was done, for logging/audit. */
registerMcpEndpoint(opts: {
  url: string;            // e.g. http://<host>:<port>/mcp?member=...
  token: string;          // JWT bearer token
  workFolder: string;
  scope: 'project' | 'user';
}): Promise<{ mechanism: string; detail: string }>;
```

- **Claude**: `claude mcp add --transport http --scope project apra-fleet-member <url> --header "Authorization: Bearer <token>"` (needs a live check that this actually persists headers -- same verification `apra-fleet-2xs.5` already calls for, just via the CLI instead of guessing at file shape).
- **AGY**: needs investigation of AGY's own MCP registration mechanism (config file? CLI verb? env-var-based?). Unknown today -- this is new research, not yet started anywhere in the plan.
- **OpenCode**: `opencode-exploration.md` (per user memory) already has real findings from earlier OpenCode work; its MCP config shape is referenced in the SSE plan (`{type:'remote', url}` under HTTP default) -- reuse and confirm that path handles bearer auth headers, or find the native registration verb if one exists.

This turns 3b from "which file" into "one investigation task per provider," each
producing a concrete adapter implementation, converging on the same interface.

### 3a. Validation findings (apra-fleet-2xs.5)

Live-verified against the actual CLIs installed on this machine (not guessed from
docs). These are the mechanisms each provider's `registerMcpEndpoint()` should use:

- **Claude** -- confirmed via `claude mcp add --transport http --scope project
  <name> <url> --header "Authorization: Bearer <token>"`. Verified end-to-end: ran
  the exact command against a scratch project and inspected the resulting
  `.mcp.json`; the bearer token round-trips intact:
  ```json
  { "mcpServers": { "test-endpoint": {
      "type": "http", "url": "http://127.0.0.1:7523/mcp?member=test",
      "headers": { "Authorization": "Bearer testtoken123" } } } }
  ```
  Important: `.mcp.json` is Claude's *own* project-scope output file, written by
  the `claude` CLI itself -- the adapter should shell out to `claude mcp add`
  (like every other provider-native mechanism here) rather than hand-writing
  `.mcp.json`, which is exactly the "not .mcp.json" framing this task corrects.
  `--scope user` is available too, for the non-project-local registration case.

- **AGY** -- no `agy mcp` subcommand exists (`agy help` subcommand list: changelog,
  help, install, models, plugin(s), update -- no mcp verb). Per
  `docs/agy-safety-rationalization.md`, AGY reads MCP server config from a single
  centralized, non-project-scoped file: `~/.gemini/config/mcp_config.json`
  (`{ "mcpServers": { "<name>": { ... } } }`, same shape Claude uses inline).
  AGY's `registerMcpEndpoint()` mechanism is therefore: read-modify-write that
  JSON file directly (merge under `mcpServers.<name>`, do not clobber sibling
  entries -- mirrors the existing uninstall-time precision-cleanup pattern in
  `src/cli/uninstall.ts`). There is no "user" vs "project" scope distinction for
  AGY today; every registration is effectively machine-global. Follow-up ticket
  `apra-fleet-fnz.2` should implement this.

- **OpenCode** -- confirmed via `docs/opencode-exploration.md`: remote MCP servers
  are configured under `"mcp"` in `opencode.json` with
  `{ "type": "remote", "url": "...", "headers": { "Authorization": "Bearer ..." } }`,
  which already covers bearer-token auth headers natively -- no gap to close.
  OpenCode also exposes a native CLI verb, `opencode mcp auth <server>`, for
  interactive credential entry, but for apra-fleet's case (token minted by the
  hub/local server, not interactively typed) the adapter should read-modify-write
  `opencode.json` directly, same shape as AGY. Follow-up ticket `apra-fleet-fnz.3`
  should implement and confirm this against a live `opencode` install.

Net: all three providers can express `registerMcpEndpoint()` in terms of the
provider's own native mechanism (CLI verb for Claude, config-file merge for AGY
and OpenCode) with no protocol gaps for bearer-token auth. Implementation is
split into per-provider follow-ups (`fnz.1` wires the interface + Claude,
`fnz.2` AGY, `fnz.3` OpenCode) since each needs its own live-verification pass.

## 4. Target user journeys (phased, same data model throughout)

### Journey A -- same machine (today, hardening in flight)
Human runs `register_member` from the orchestrator's conversation; work_folder is
local. This stays the fast path -- no token exchange needed since there's already
implicit trust (same machine, same user). But it should call the new
`registerMcpEndpoint()` adapter method instead of hand-writing files, so it already
exercises the provider-agnostic path even before LAN/WAN exist.

### Journey B -- LAN (near-term future)
The member is a **different machine** on the same network. The orchestrator cannot
touch its filesystem. This has to flip from push to **pull / self-enrollment**:

1. Human runs something like `register_member --generate-enrollment-token
   --project <id>` on the orchestrator. Gets back a short-lived, single-use token
   (and optionally a QR code / one-liner to paste) bound to `project_id` + an
   expiry + an intended role (derived from tags, per the Q4 decision already made).
2. On the new machine, the human runs a single command:
   `apra-fleet join <token>` (or `npx apra-fleet join <token>`).
3. That command: detects which provider(s) are installed locally (claude/agy/
   opencode/codex/...), contacts the orchestrator over LAN (mDNS/local discovery, or
   the token embeds the orchestrator's LAN address), exchanges the enrollment token
   for a full JWT scoped to `(project_id, member_id)`, and calls the right
   provider's `registerMcpEndpoint()` locally -- on its own disk, with its own CLI.
4. The orchestrator's session registry sees the member connect and register itself,
   the same way it does today (the connect-time registry entry already exists in
   `session-registry.ts`); the only new part is *who initiates the network call*.

This journey requires nothing that isn't already planned: `project_id` is already
being promoted to first-class in the JWT/session-registry design (`apra-fleet-2xs.2`,
Q5 decision), so an enrollment token is just "a pre-auth credential that mints a JWT
with that project_id once, instead of the orchestrator minting it locally already
knowing the member."

### Journey C -- WAN (future, not implemented now, must not require a redesign)
Same `apra-fleet join <token>` command, but:
- discovery can't rely on LAN broadcast -- the token must carry (or resolve via a
  known relay/registration service) a reachable URL for the orchestrator.
- the localhost-only bind (`127.0.0.1`, already flagged as a Phase-1-acceptable,
  future-must-change assumption in the SSE plan) becomes a real constraint --
  needs a configurable bind + TLS, which the plan already flags as additive, not
  breaking.
- the enrollment token exchange must not be forgeable/replayable over an open
  network -- needs real expiry + single-use enforcement (LAN can get away with
  weaker guarantees since the network itself is a trust boundary; WAN cannot).

None of A/B/C require a different data model -- they require the **same**
`(project_id, member_id)`-keyed JWT/session-registry design already decided for Q5,
plus one new artifact (the enrollment token) and one new adapter method
(`registerMcpEndpoint`) that already generalizes the provider question. This is
exactly the "don't bake in single-machine assumptions" instruction from the Q5
decision, applied to onboarding specifically instead of just the transport/registry.

## 5. Open questions for the human

1. **Enrollment token transport for Journey B/C**: LAN mDNS/broadcast, a
   pasted URL, or a QR code flow? (Affects `apra-fleet join`'s UX more than the
   architecture.)
2. **AGY's native MCP registration mechanism** is genuinely unknown to this
   analysis -- needs investigation before `registerMcpEndpoint()` can be
   implemented for it. Is AGY's config file-based, CLI-verb-based, or something
   else entirely?
3. **Should Journey A (same-machine) start calling `registerMcpEndpoint()` now**,
   even before Journey B exists, so the interface gets battle-tested on the cheap
   path first? (Recommended: yes -- avoids designing the interface twice.)
4. **Enrollment token scope**: one-time single-member use, or reusable for
   onboarding N members into one project within a time window (e.g. bulk sprint
   setup)? Affects whether `--generate-enrollment-token` needs a `--max-uses` flag.

## 6. What this changes in the existing plan

- `apra-fleet-2xs.5` is broadened (see updated description/title): it's no longer
  "validate Claude Code's config surface" but "design + validate provider-agnostic
  MCP endpoint registration (`registerMcpEndpoint`) across Claude, AGY, and
  OpenCode" -- explicitly ruling out `.mcp.json`.
- A new epic (`apra-fleet-onboarding`, see beads) tracks the Journey A/B/C work,
  parented separately from the SSE/HTTP revival epic but sharing its `project_id`
  data model and depending on `apra-fleet-2xs.5`'s provider-adapter investigation.
