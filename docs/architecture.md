<!-- llm-context: This document explains the internal architecture of apra-fleet  -- the MCP server, member registry, SSH transport, session management, and how tools are dispatched. Read this when a user asks how fleet works under the hood, or when debugging connectivity or session issues. -->
<!-- keywords: MCP server, member registry, SSH, transport, session, tool dispatch, child process, local member, remote member, architecture -->
<!-- see-also: ../README.md (getting started), tools-infrastructure.md (tool details), vocabulary.md (terminology) -->

# Architecture

## Why This Exists

AI coding agents are powerful on a single machine. But real work spans many machines  -- a dev server, a staging box, a GPU trainer, a production host. Today, if you want Claude Code working across all of them, you SSH in manually, run prompts one at a time, and copy files by hand. There's no single pane of glass.

Apra Fleet gives one Claude instance the ability to orchestrate many. Register machines, push files, run prompts, monitor health  -- all through natural language from your terminal. One master, many members.

## Conceptual Model

The system has three layers of abstraction:

**Fleet** -> **Members** -> **Sessions**

A *fleet* is the collection of all registered machines. A *member* is one machine with a working directory  -- the unit you talk to. A *session* is a conversation thread on a member  -- Claude remembers context across prompts within a session, and you can reset it to start fresh.

Members come in two flavors:
- **Remote members** communicate over SSH. They can be any machine you can reach  -- Linux VMs, macOS servers, Windows boxes.
- **Local members** run on the same machine as the master, in a different folder. No SSH needed. Useful for isolating work into separate project directories without spinning up another machine.

This distinction is hidden behind a **Strategy pattern**: every tool interacts with members through a uniform interface. The strategy implementation (remote via SSH, or local via child process) is selected at runtime based on member type. Tools never know or care which kind of member they're talking to.

## How It Fits Together

```
+----------------------------------------------------+
|  Master Machine                                    |
|                                                    |
|  Claude Code CLI <--stdio--> Apra Fleet Server     |
|                               |                    |
|                    +----------+----------+         |
|                    |  Member Strategy    |         |
|                    |  (uniform interface)|         |
|                    +--+-----------+-----+         |
|                       |           |                |
|              Remote Strategy   Local Strategy      |
|              (ssh2 + sftp)    (child_process + fs) |
|                       |           |                |
|                    SSH |      local exec            |
+----------------------------------------------------+
                        |           |
           +------------+           +--> /other/project/
           v                             (same machine)
    +--------------+
    | Remote Member |
    | (any OS,      |
    |  any provider)|
    +--------------+
```

The MCP server speaks **stdio**  -- the standard transport for Claude Code MCP servers. Claude sends JSON-RPC tool calls, the server executes them, returns results. No HTTP, no ports to open.

## Layers

The codebase follows a strict layering:

```
  index.ts           <- MCP server entry point, tool registration
  tools/*            <- one file per tool, each self-contained
  services/*         <- core capabilities (strategy, registry, SSH, file transfer)
  providers/*        <- LLM provider adapters (Claude, Antigravity, Codex, Copilot, Gemini)
  os/*               <- OS-specific command builders (Linux, macOS, Windows)
  utils/*            <- stateless helpers (crypto, shell escaping)
  types.ts           <- shared data structures
```

Each layer only depends on the layers below it. Tools never import other tools. Services don't know about the MCP protocol.

## HTTP Transport & Interactive Sessions

Alongside the stdio MCP transport, the server exposes a `StreamableHTTPServerTransport` on `POST/GET/DELETE /mcp` (`src/services/http-transport.ts`), bound to `127.0.0.1` only. This is what lets a member's own `apra-fleet` MCP server connect back interactively -- distinct from the subprocess/SSH-driven `execute_prompt` path, which stays subprocess-only. See `docs/hub-spoke-wire-protocol.md` for the full wire-level design.

Each `/mcp` connection carries one of two identities:

- **JWT-authenticated** -- a `Bearer` token (`src/services/jwt.ts`, HS256, signed with `~/.apra-fleet/fleet.key`) verified via the pluggable `TokenIssuer` (`src/services/token-issuer.ts`). The token's `workspace_id` claim is the hard security boundary (never `project_id`, which is an optional non-security label) -- Phase 1 uses a local dev-mode issuer (one machine == one implicit workspace); a hub-era issuer swaps in behind the same interface with no token-shape change.
- **Unauthenticated URL-param fallback** -- a `?member=<id>` query param, trusted only because the server binds to loopback. Legacy friendly-name params are resolved to the member's UUID via the agent registry.

A connected member is tracked in the in-memory `sessionRegistry` (`src/services/session-registry.ts`), keyed on the composite `(workspace_id, member_id)` -- every lookup is workspace-scoped, so a member connected under a different workspace is indistinguishable from "not connected" (existence is never leaked across the boundary). `send_message` (`src/tools/send-message.ts`) uses this registry to push a `notifications/claude/channel` MCP notification to a connected member's live session, flipping its status to `busy`.

That flip is closed by `report_status` (`src/tools/report-status.ts`): a connected member's OWN session calls it (`online` or `idle`) to report it's done responding. There is no `member_id` parameter -- identity comes entirely from the live MCP session the call arrives on, resolved via `sessionRegistry.findBySessionId(extra.sessionId)` (the SDK populates `sessionId` on every tool call's `extra`). This is the tier-2-local status state machine `docs/hub-spoke-wire-protocol.md` section 4 reserves the `presence.member_status` envelope name for, once a hub relays it upward.

Fleet events (`credential:stored`, `task:completed`, `member:status-changed`, `stall:detected`) broadcast only to sessions in the same workspace as the local orchestrator -- never across a workspace wall.

`execute_prompt` (`src/tools/execute-prompt.ts`) itself is dual-path: for a member with NO live interactive session, it behaves exactly as before (subprocess/SSH, unchanged). For a member that IS interactively connected, it routes through the same channel instead of spawning anything -- `send_message` pushes the prompt and the caller awaits the member's `respond_to_message({reply_to, content})` call, correlated purely in-memory by `src/services/pending-responses.ts` (a `msgid` -> pending-promise map, timeout-bound by the same `timeout_s` the subprocess path uses). Mode selection is decided tier-2-locally against this machine's own `sessionRegistry` -- never from caller-side or (future) hub-side state -- so it is unaffected by whether `execute_prompt` is invoked directly or eventually relayed through a hub. This interactive mode is gated to Claude members only: `docs/interactive-injection-provider-survey.md` confirms it is POC-proven on Claude alone (the other five providers are confirmed unsupported or unconfirmed) -- a non-Claude member with a live session (e.g. from `registerMcpEndpoint`, which gives several providers basic MCP tool access) still falls through to the subprocess path.

## Provider Abstraction

Fleet supports six LLM providers -- Claude Code, Google Antigravity CLI (agy), OpenAI Codex CLI, GitHub Copilot CLI, Gemini CLI, and OpenCode -- plus a seventh null option, `'none'`, for a plain command executor with no LLM at all (`src/providers/none.ts`). Members can mix providers within a single fleet.

### How It Works

Each member has an optional `llmProvider` field (`'claude' | 'agy' | 'codex' | 'copilot' | 'gemini' | 'opencode' | 'none'`). When absent, it defaults to `'claude'` for backwards compatibility. Every tool that interacts with the member's LLM CLI resolves the provider via `getProvider(agent.llmProvider)` and delegates CLI-specific concerns to the `ProviderAdapter` interface.

A `'none'` member supports `execute_command` (already fully provider-agnostic, no changes needed) but never `execute_prompt` in either mode -- rejected immediately with a clear error rather than reaching `NoneProvider`'s methods, most of which throw by design (there is no CLI, no prompt, no model to build a command from). `register_member` skips CLI/auth verification entirely for these members, and status/detail views show `compute only` in place of a token count.

```
+----------+     getProvider()     +-----------------+
|  Tool    | --------------------> | ProviderAdapter  |
| (generic)|                       |  (per-provider)  |
+----------+                       +--------+---------+
                                            | supplies:
                                     cliCommand()
                                     buildPromptCommand()
                                     parseResponse()
                                     classifyError()
                                     authEnvVar
                                     processName
                                     ...
```

The `OsCommands` layer sits below this: it handles OS-specific shell wrapping (PATH prepend, PowerShell syntax, base64 decode) and delegates CLI-specific parts (binary name, flags, JSON format) to the provider.

### Provider Files

```
src/providers/
  provider.ts    - ProviderAdapter interface + shared types
  claude.ts      - ClaudeProvider
  agy.ts         - AgyProvider
  codex.ts       - CodexProvider (NDJSON parser)
  copilot.ts     - CopilotProvider
  gemini.ts      - GeminiProvider
  opencode.ts    - OpenCodeProvider (NDJSON parser, local/self-hosted models)
  index.ts       - getProvider() singleton factory
```

### Mix-and-Match Fleet

A fleet can have members on different providers simultaneously. The PM dispatches work to members by name  -- it doesn't need to know which LLM backend each member uses. The fleet server resolves the correct CLI commands per member at runtime.

```
PM (orchestrator, Claude)
  |
  +-- dev1   (claude,   remote)
  +-- dev2   (gemini,   remote)
  +-- dev3   (codex,    local)
  +-- dev4   (opencode, local)   <- self-hosted model via Ollama
  +-- review (copilot,  remote)
```

All five members use the same `execute_prompt` tool call. The tool builds provider-correct CLI commands for each.

### Key Differences Across Providers

- **`max_turns`** - Claude-only. Ignored for Antigravity, Codex, Copilot, and Gemini.
- **OAuth credential copy** - Claude-only. Non-Claude providers require an API key (`provision_llm_auth` with `api_key`).
- **JSON output format** - Codex emits NDJSON (one event per line). All others emit a single JSON object. Handled transparently by `provider.parseResponse()`.
- **Session resume** - Claude, Antigravity, and Gemini support resuming specific session IDs. Codex and Copilot resume the most recent local session. OpenCode supports session resume via `--session <id>` or `--continue`.
- **OpenCode** - uses any OpenAI-compatible endpoint (Ollama, vLLM). The user provisions the endpoint; Fleet installs the CLI and agents. Model tiers are set per member at registration via `model_tiers` (since models vary by deployment). Agent files are transformed from Claude format to OpenCode format at install time (tools allowlist -> permission map).

See `docs/provider-matrix.md` for the full comparison table.

### Multi-member topology (auto-sprint)

The `apra-fleet-se` auto-sprint runner (`packages/apra-fleet-se/auto-sprint/runner.js`) dispatches roles across configured members: the orchestrator issues every `bd` command and the git push/PR, doers round-robin across the doer pool, and the reviewer runs from the reviewer pool.

Two topology modes are supported, selected explicitly when a sprint starts:

- **`legacy` mode** -- no cross-member sync layer. Every `bd` command the orchestrator issues runs against the orchestrator member's beads DB, while each doer's own `bd close` runs against **its** member's DB; the sprint git branch is only meaningful if all members operate on the same working state. This coheres in exactly two topologies: **single-member** (one member does everything) or a **verified shared-workspace fleet** (every configured member resolves to the same checkout/beads DB). Independent per-member checkouts are **not supported** in this mode -- non-orchestrator members would silently work against a beads DB and git branch the orchestrator never sees.
- **`synced` mode** -- an orchestrator-bracketed git+Dolt sync layer wraps every dispatch that reads or writes git-tracked or beads state, reconciling each member's state explicitly instead of assuming it is already shared. This is what makes genuinely independent per-member checkouts safe. The sync layer includes a scripted-first escalation ladder for both git and Dolt conflicts (mechanical detection and resolution first, an agent dispatched with an explicit conflict runbook only as a documented last resort), plus supervisor-owned global coordination (a Dolt push mutex and a child-id allocator) so concurrent cross-member Dolt writes never silently corrupt each other's beads clone.

Guards enforcing whichever mode is selected:

1. **Branch-ensure everywhere** (both modes): before the first doer round, the runner git-ensures the sprint branch (`fetch` + `checkout -B`) on **every** member in the union of the orchestrator/doer/reviewer pools -- not just the orchestrator -- and non-destructively re-checks-out the branch on each member at the start of later cycles (it never resets to base once work is committed).
2. **Topology precondition**: `bin/cli.mjs` calls `checkMemberTopology()` before starting a multi-member sprint. In `legacy` mode it compares an identity signal (`git rev-parse HEAD`) across the configured members and **refuses to start with a clear error** if they disagree (or if a member's signal can't be obtained); in `synced` mode HEADs are allowed to differ, but every member must share the same git remote origin and pass a live beads-Dolt-pull probe. Single-member sprints trivially pass either check.

See `packages/apra-fleet-se/docs/architecture.md` for the full internals of both modes, including the escalation ladders and the always-on supervisor service that launches and tracks sprints.

## Workflow Subsystem (SEA-embedded workflow runner)

`apra-fleet workflow <name>` runs a self-contained script (an ESM entry point
under `workflows/<name>/`) against a live fleet connection, from inside the
single-executable-application (SEA) binary -- no separate Node install and no
unpacking to a temp directory required. `auto-sprint` is itself shipped as one
of these built-in workflows rather than as a bespoke subcommand, so the
launcher, the packaging, and the docs only need to solve this problem once.

**Two always-separate processes.** The workflow launcher (`apra-fleet
workflow`, `auto-sprint`) and the `apra-fleet` MCP server are never merged
into one process. This is a hard boundary, not an optimization detail --
see `docs/adr-workflow-server-resolution.md` for the ADR and its explicit
scope guard against reopening it.

**Server connection resolution is a single shared helper**, not duplicated
per consumer. `@apralabs/apra-fleet-client/server-resolution`
(`packages/apra-fleet-client/src/client/server-resolution.mjs`) implements
one resolution order used identically by `src/cli/workflow.ts` and
`packages/apra-fleet-se/bin/cli.mjs`:

1. `APRA_FLEET_TRANSPORT` forced override (`http` fails loud with no
   singleton rather than silently falling back to a private server; `stdio`
   or a set `APRA_FLEET_SERVER_CMD`/`_BIN` goes straight to self-spawn).
2. Probe for a healthy HTTP singleton (`checkRunningInstance()` -- the same
   pid + `/health` check the installed service already uses for
   startup-dedup) and attach with zero spawned processes. This is the
   default, steady-state path.
3. Fall back to stdio self-spawn (the four-tier command resolution
   `resolveFleetServerCommand()` already had) only when no healthy
   singleton is found.

The rationale for one shared helper over two copies: a launcher that merely
mirrored the old stdio-only `resolveFleetServerCommand()` would always
self-spawn a private server even when a healthy HTTP singleton already
existed, doubling running servers and splitting state. Duplicating the
resolution order in two languages (TS launcher, MJS auto-sprint) was
rejected because it guarantees drift between the two copies over time; see
the ADR for the full tradeoff writeup.

**Workflow entry contract:** a workflow is a directory under `workflows/`
containing a `workflow.json` (name, entry, description) and an entry file
that is either self-executing ESM or exports `main(args)` / `run(args)` /
a default export. The launcher sets two env vars for every workflow run --
`APRA_FLEET_SERVER_BIN` and `APRA_FLEET_SE_SCHEMAS_DIR` -- and never
clobbers a value the caller already set. See `docs/authoring-workflows.md`
for the full contract, including the raw-node escape hatch and how a
workflow should import the shared engine/client packages.

**Entry-path escape prevention is security-critical, not incidental:** the
launcher resolves a workflow's `entry` against its own directory and
rejects any resolution that escapes it (checked via `path.relative` plus
`..`/absolute-path detection) before ever executing the file. A workflow
manifest is not a trusted-by-construction input.

**Packaging:** the workflow runtime, agent schemas, and built-in workflows
(including auto-sprint) are embedded as SEA assets by
`scripts/gen-sea-config.mjs`, proven viable by an earlier spike that
dynamic `import()` of on-disk ESM works from inside a SEA main script on
all three target OSes.

**Install/uninstall/update lifecycle (Phases 1-3, closed this sprint,
`apra-fleet-7pm`):** `install.ts`'s workflow-install step and its extraction
logic (extract-to-temp-then-rename, with Windows EBUSY retry/backoff) were
factored out into `src/cli/workflow-assets.ts` so more than one caller can
share the exact same code path instead of re-implementing it:

- `apra-fleet install` (fresh install) calls `extractWorkflowSubsystemAssets()`
  to lay down `~/.apra-fleet/{node_modules,schemas,workflows/<builtin>}`.
- `src/cli/workflow.ts`'s launcher self-heals: if a `workflow <name>`
  invocation finds the on-disk payload missing or incomplete
  (`hasWorkflowSubsystemAssets()` is false), it re-extracts from the same
  embedded SEA assets before running, rather than failing with an opaque
  module-not-found error.
- `apra-fleet uninstall --skill workflows` removes the shared runtime/schema
  dirs plus only the built-in workflow subdirectories recorded in
  `workflows/.installed.json`'s `builtin` array (falling back to the static
  `BUILTIN_WORKFLOW_NAMES` list if that manifest is missing, so a
  partially-installed tree still cleans up). User-authored workflow
  directories are left in place; `workflows/` itself is only removed if
  nothing user-authored remains, and the command prints which user
  workflows it kept.
- `apra-fleet update` reads back the previously-persisted `--workflows` mode
  and threads it into the re-invoked install, so an update refreshes
  built-in workflow assets to the new version while preserving any
  user-authored workflows already on disk.

**CI coverage (Phase 4, closed this sprint):** `build:binary` smoke tests
exercise the packaged SEA binary's `workflow` subcommand and the
auto-sprint-as-built-in-workflow path end-to-end (not just the source
`.ts`/`.mjs` files), and a regression-guard test suite
(`tests/regression-command-surface.test.ts`) pins the full existing CLI
command surface (`install --help`, `uninstall --dry-run`, `--version`,
stdio handshake) against golden fixtures so future workflow-subsystem work
can't silently change unrelated command output.

The workflow subsystem is now installable, self-healing, uninstallable, and
update-safe end-to-end; remaining gaps for this feature are tracked as
individual open issues under `apra-fleet-7pm`, not as a phase-level
placeholder.

**Dev-mode manifest bundling is a transitive-dependency, not a top-level-only,
contract.** The dev-mode install path bundles `@apralabs/apra-fleet-client`'s
own package tree so the workflow runtime can load it without a real npm
install. Because that client package can itself gain a runtime dependency
(e.g. for a new transport), the manifest builder must walk and bundle the
client's own `dependencies`, not just the client package's own files -- a
manifest that copies only the client's top-level directory silently ships a
client that throws a module-not-found error the moment it needs a dependency
it never had bundled alongside it. Any future dependency added to
`apra-fleet-client` must be re-verified against this bundling path, not just
against the production/packaged-binary install path, since the two paths
build the manifest differently.

## PM Skill

The PM skill and its role agent definitions (planner, plan-reviewer, doer, reviewer, deployer, integ-test-runner, ci-watcher, harvester), plus their shared `agents/schemas/` and `agents/_shared/` assets, live in this monorepo at `packages/apra-fleet-se/apra-pm/`. At build time, `scripts/dist-pm.mjs` copies the skill and agent files into `dist/` (and `scripts/gen-sea-config.mjs` embeds them as SEA assets for the standalone binary), so all three install paths -- dev-mode, npm, and SEA binary -- carry the same set. At install time, agents are written to the provider's agents directory (e.g. `~/.claude/agents/`); `uninstall` removes that directory in the same pass. For OpenCode members, agent frontmatter is transformed from Claude format to OpenCode format during installation. Claude installs additionally get the `auto-sprint-args` skill (the args contract for the `/auto-sprint` workflow), written to `~/.claude/skills/auto-sprint-args`.

Remote fleet members do not share the operator's home directory, so `register_member`, `update_member`, and (starting with the first dispatch after an orchestrator upgrade) `execute_prompt` each independently hash-diff the canonical agent set against the remote box and push anything missing or stale. See [docs/tools-lifecycle.md](tools-lifecycle.md) and [docs/tools-work.md](tools-work.md) for the per-tool behavior.

## Key Design Decisions

### Strategy Pattern for Member Types

Rather than scattering `if (agent.agentType === 'local')` checks across every tool, the local/remote distinction lives in a single place: the strategy factory. Tools call `getStrategy(agent).execCommand(...)` and get back the same result shape regardless of how it was executed. Adding a third member type (e.g., Docker containers, cloud VMs with API-based access) means writing one new strategy class  -- no tool changes.

### Passwords Encrypted at Rest

SSH passwords are encrypted with AES-256-GCM before being written to the registry file. The encryption key is derived from the machine's identity (hostname + OS username), so the registry file is meaningless if copied to another machine. This isn't meant to stop a determined attacker with root access  -- it prevents accidental plaintext exposure in backups, screenshots, or config file shares.

### Connection Pooling with Idle Timeout

SSH connections are expensive to establish (TCP + key exchange + auth). The server pools them in memory and reuses connections across tool calls, with a 5-minute idle timeout that auto-closes unused connections. Timers are `unref()`'d so they don't prevent Node from exiting.

### Base64 Prompt Encoding

Prompts sent to remote members are base64-encoded before being passed through SSH. This sidesteps the shell escaping nightmare of nested quoting across SSH -> bash -> claude CLI, across different operating systems. The remote member decodes before passing to Claude.

### Session Persistence

Each member stores an optional `sessionId`  -- a Claude conversation thread ID. When `resume=true` (the default), subsequent prompts continue the same conversation, so the remote Claude has full context of prior exchanges. Resetting a session is an explicit action, not an accident.

### File-Based Registry

All fleet state lives in `~/.apra-fleet/data/registry.json`  -- a single JSON file in the user's home directory. It's deliberately not in the project directory (won't be git-committed accidentally) and not in a database (no server to run, no migrations). For a fleet of dozens of members, JSON is more than sufficient.

### Duplicate Folder Prevention

Two members cannot share the same working directory on the same device. For remote members, "same device" means same SSH host. For local members, "same device" is always the master machine. This is enforced during registration and updates. It prevents two members from stomping on each other's files.

## Tools

The tools break into natural groups. Each group has detailed documentation:

**[Lifecycle](tools-lifecycle.md)**  -- `register_member`, `list_members`, `update_member`, `remove_member`, `shutdown_server`
Manage the fleet roster and server lifecycle. Registration validates connectivity, detects the OS, and checks that Claude CLI is available. Removal includes best-effort cleanup of auth credentials on the member.

**[Work](tools-work.md)**  -- `send_files`, `execute_prompt`, `execute_command`, `reset_session`
The core workflow. Push files to a member, run prompts against it, run shell commands directly, manage conversation sessions.

**[Infrastructure](tools-infrastructure.md)**  -- `provision_llm_auth`, `setup_ssh_key`, `update_llm_cli`
One-time setup and maintenance. Provision auth (copy OAuth credentials or deploy API key for any provider), migrate from password to key auth, update the LLM CLI on members.

**[Observability](tools-observability.md)**  -- `fleet_status`, `member_detail`
Two-layer monitoring. `fleet_status` gives a quick summary table across all members with fleet-aware busy detection (distinguishes between Claude processes serving this member vs unrelated Claude activity). `member_detail` drills into one member with connectivity, CLI version, session state, and system resource metrics.

## Cross-Platform Support

Members can run Windows, macOS, or Linux. The `platform.ts` utility generates the right shell commands for each OS  -- different commands for checking processes, reading memory, setting environment variables. The OS is auto-detected during registration (`uname -s` on Unix, `cmd /c ver` on Windows) and stored in the member record so subsequent tool calls don't need to re-detect.
