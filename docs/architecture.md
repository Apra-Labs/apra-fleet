# Architecture

## Why This Exists

AI coding agents are powerful on a single machine. But real work spans many machines — a dev server, a staging box, a GPU trainer, a production host. Today, if you want Claude Code working across all of them, you SSH in manually, run prompts one at a time, and copy files by hand. There's no single pane of glass.

Apra Fleet gives one Claude instance the ability to orchestrate many. Register machines, push files, run prompts, monitor health — all through natural language from your terminal. One master, many members.

## Conceptual Model

The system has three layers of abstraction:

**Fleet** → **Members** → **Sessions**

A *fleet* is the collection of all registered machines. A *member* is one machine with a working directory — the unit you talk to. A *session* is a conversation thread on a member — Claude remembers context across prompts within a session, and you can reset it to start fresh.

Members come in two flavors:
- **Remote members** communicate over SSH. They can be any machine you can reach — Linux VMs, macOS servers, Windows boxes.
- **Local members** run on the same machine as the master, in a different folder. No SSH needed. Useful for isolating work into separate project directories without spinning up another machine.

This distinction is hidden behind a **Strategy pattern**: every tool interacts with members through a uniform interface. The strategy implementation (remote via SSH, or local via child process) is selected at runtime based on member type. Tools never know or care which kind of member they're talking to.

## How It Fits Together

```
┌────────────────────────────────────────────────────┐
│  Master Machine                                    │
│                                                    │
│  Claude Code CLI ◄──stdio──► Apra Fleet Server      │
│                               │                    │
│                    ┌──────────┴──────────┐         │
│                    │  Member Strategy    │         │
│                    │  (uniform interface)│         │
│                    └──┬─────────────┬───┘         │
│                       │             │              │
│              Remote Strategy   Local Strategy      │
│              (ssh2 + sftp)    (child_process + fs) │
│                       │             │              │
│                    SSH│        local exec           │
└───────────────────────┼─────────────┼──────────────┘
                        │             │
           ┌────────────┘             └──► /other/project/
           ▼                               (same machine)
    ┌──────────────┐
    │ Remote Member │
    │ (any OS,      │
    │  any provider)│
    └──────────────┘
```

The MCP server speaks **stdio** — the standard transport for Claude Code MCP servers. Claude sends JSON-RPC tool calls, the server executes them, returns results. No HTTP, no ports to open.

## Layers

The codebase follows a strict layering:

```
  index.ts           ← MCP server entry point, tool registration
  tools/*            ← one file per tool, each self-contained
  services/*         ← core capabilities (strategy, registry, SSH, file transfer)
  providers/*        ← LLM provider adapters (Claude, Gemini, Codex, Copilot)
  os/*               ← OS-specific command builders (Linux, macOS, Windows)
  utils/*            ← stateless helpers (crypto, shell escaping)
  types.ts           ← shared data structures
```

Each layer only depends on the layers below it. Tools never import other tools. Services don't know about the MCP protocol.

## Provider Abstraction

Fleet supports four LLM providers: Claude Code, Gemini CLI, OpenAI Codex CLI, and GitHub Copilot CLI. Members can mix providers within a single fleet.

### How It Works

Each member has an optional `llmProvider` field (`'claude' | 'gemini' | 'codex' | 'copilot'`). When absent, it defaults to `'claude'` for backwards compatibility. Every tool that interacts with the member's LLM CLI resolves the provider via `getProvider(agent.llmProvider)` and delegates CLI-specific concerns to the `ProviderAdapter` interface.

```
┌──────────┐     getProvider()     ┌─────────────────┐
│  Tool    │ ───────────────────►  │ ProviderAdapter  │
│ (generic)│                       │  (per-provider)  │
└──────────┘                       └────────┬─────────┘
                                            │ supplies:
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
  provider.ts    — ProviderAdapter interface + shared types
  claude.ts      — ClaudeProvider
  gemini.ts      — GeminiProvider
  codex.ts       — CodexProvider (NDJSON parser)
  copilot.ts     — CopilotProvider
  index.ts       — getProvider() singleton factory
```

### Mix-and-Match Fleet

A fleet can have members on different providers simultaneously. The PM dispatches work to members by name — it doesn't need to know which LLM backend each member uses. The fleet server resolves the correct CLI commands per member at runtime.

```
PM (orchestrator, Claude)
  |
  +-- dev1   (claude,  remote)
  +-- dev2   (gemini,  remote)
  +-- dev3   (codex,   local)
  +-- review (copilot, remote)
```

All four members use the same `execute_prompt` tool call. The tool builds provider-correct CLI commands for each.

### Key Differences Across Providers

- **`max_turns`** — Claude-only. Ignored for Gemini, Codex, and Copilot.
- **OAuth credential copy** — Claude-only. Non-Claude providers require an API key (`provision_auth` with `api_key`).
- **JSON output format** — Codex emits NDJSON (one event per line). All others emit a single JSON object. Handled transparently by `provider.parseResponse()`.
- **Session resume** — Claude stores a server-side session ID. Others resume the most recent local session via a generic flag.

See `docs/provider-matrix.md` for the full comparison table.

## Key Design Decisions

### Strategy Pattern for Member Types

Rather than scattering `if (agent.agentType === 'local')` checks across every tool, the local/remote distinction lives in a single place: the strategy factory. Tools call `getStrategy(agent).execCommand(...)` and get back the same result shape regardless of how it was executed. Adding a third member type (e.g., Docker containers, cloud VMs with API-based access) means writing one new strategy class — no tool changes.

### Passwords Encrypted at Rest

SSH passwords are encrypted with AES-256-GCM before being written to the registry file. The encryption key is derived from the machine's identity (hostname + OS username), so the registry file is meaningless if copied to another machine. This isn't meant to stop a determined attacker with root access — it prevents accidental plaintext exposure in backups, screenshots, or config file shares.

### Connection Pooling with Idle Timeout

SSH connections are expensive to establish (TCP + key exchange + auth). The server pools them in memory and reuses connections across tool calls, with a 5-minute idle timeout that auto-closes unused connections. Timers are `unref()`'d so they don't prevent Node from exiting.

### Base64 Prompt Encoding

Prompts sent to remote members are base64-encoded before being passed through SSH. This sidesteps the shell escaping nightmare of nested quoting across SSH → bash → claude CLI, across different operating systems. The remote member decodes before passing to Claude.

### Session Persistence

Each member stores an optional `sessionId` — a Claude conversation thread ID. When `resume=true` (the default), subsequent prompts continue the same conversation, so the remote Claude has full context of prior exchanges. Resetting a session is an explicit action, not an accident.

### File-Based Registry

All fleet state lives in `~/.apra-fleet/data/registry.json` — a single JSON file in the user's home directory. It's deliberately not in the project directory (won't be git-committed accidentally) and not in a database (no server to run, no migrations). For a fleet of dozens of members, JSON is more than sufficient.

### Duplicate Folder Prevention

Two members cannot share the same working directory on the same device. For remote members, "same device" means same SSH host. For local members, "same device" is always the master machine. This is enforced during registration and updates. It prevents two members from stomping on each other's files.

## Tools

The tools break into natural groups. Each group has detailed documentation:

**[Lifecycle](tools-lifecycle.md)** — `register_member`, `list_members`, `update_member`, `remove_member`, `shutdown_server`
Manage the fleet roster and server lifecycle. Registration validates connectivity, detects the OS, and checks that Claude CLI is available. Removal includes best-effort cleanup of auth credentials on the member.

**[Work](tools-work.md)** — `send_files`, `execute_prompt`, `execute_command`, `reset_session`
The core workflow. Push files to a member, run prompts against it, run shell commands directly, manage conversation sessions.

**[Infrastructure](tools-infrastructure.md)** — `provision_auth`, `setup_ssh_key`, `update_agent_cli` (alias: `update_claude`)
One-time setup and maintenance. Provision auth (copy OAuth credentials or deploy API key for any provider), migrate from password to key auth, update the LLM CLI on members.

**[Observability](tools-observability.md)** — `fleet_status`, `member_detail`
Two-layer monitoring. `fleet_status` gives a quick summary table across all members with fleet-aware busy detection (distinguishes between Claude processes serving this member vs unrelated Claude activity). `member_detail` drills into one member with connectivity, CLI version, session state, and system resource metrics.

## Cross-Platform Support

Members can run Windows, macOS, or Linux. The `platform.ts` utility generates the right shell commands for each OS — different commands for checking processes, reading memory, setting environment variables. The OS is auto-detected during registration (`uname -s` on Unix, `cmd /c ver` on Windows) and stored in the member record so subsequent tool calls don't need to re-detect.
