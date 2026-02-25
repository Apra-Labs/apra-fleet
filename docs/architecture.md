# Architecture

## Why This Exists

AI coding agents are powerful on a single machine. But real work spans many machines — a dev server, a staging box, a GPU trainer, a production host. Today, if you want Claude Code working across all of them, you SSH in manually, run prompts one at a time, and copy files by hand. There's no single pane of glass.

Claude Code Fleet MCP gives one Claude instance the ability to orchestrate many. Register machines, push files, run prompts, monitor health — all through natural language from your terminal. One master, many agents.

## Conceptual Model

The system has three layers of abstraction:

**Fleet** → **Agents** → **Sessions**

A *fleet* is the collection of all registered machines. An *agent* is one machine with a working directory — the unit you talk to. A *session* is a conversation thread on an agent — Claude remembers context across prompts within a session, and you can reset it to start fresh.

Agents come in two flavors:
- **Remote agents** communicate over SSH. They can be any machine you can reach — Linux VMs, macOS servers, Windows boxes.
- **Local agents** run on the same machine as the master, in a different folder. No SSH needed. Useful for isolating work into separate project directories without spinning up another machine.

This distinction is hidden behind a **Strategy pattern**: every tool interacts with agents through a uniform interface. The strategy implementation (remote via SSH, or local via child process) is selected at runtime based on agent type. Tools never know or care which kind of agent they're talking to.

## How It Fits Together

```
┌────────────────────────────────────────────────────┐
│  Master Machine                                    │
│                                                    │
│  Claude Code CLI ◄──stdio──► Fleet MCP Server      │
│                               │                    │
│                    ┌──────────┴──────────┐         │
│                    │  Agent Strategy     │         │
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
    │ Remote Agent  │
    │ (any OS)      │
    └──────────────┘
```

The MCP server speaks **stdio** — the standard transport for Claude Code MCP servers. Claude sends JSON-RPC tool calls, the server executes them, returns results. No HTTP, no ports to open.

## Layers

The codebase follows a strict layering:

```
  index.ts           ← MCP server entry point, tool registration
  tools/*            ← one file per tool, each self-contained
  services/*         ← core capabilities (strategy, registry, SSH, file transfer)
  utils/*            ← stateless helpers (crypto, platform commands)
  types.ts           ← shared data structures
```

Each layer only depends on the layers below it. Tools never import other tools. Services don't know about the MCP protocol.

## Key Design Decisions

### Strategy Pattern for Agent Types

Rather than scattering `if (agent.agentType === 'local')` checks across every tool, the local/remote distinction lives in a single place: the strategy factory. Tools call `getStrategy(agent).execCommand(...)` and get back the same result shape regardless of how it was executed. Adding a third agent type (e.g., Docker containers, cloud VMs with API-based access) means writing one new strategy class — no tool changes.

### Passwords Encrypted at Rest

SSH passwords are encrypted with AES-256-GCM before being written to the registry file. The encryption key is derived from the machine's identity (hostname + OS username), so the registry file is meaningless if copied to another machine. This isn't meant to stop a determined attacker with root access — it prevents accidental plaintext exposure in backups, screenshots, or config file shares.

### Connection Pooling with Idle Timeout

SSH connections are expensive to establish (TCP + key exchange + auth). The server pools them in memory and reuses connections across tool calls, with a 5-minute idle timeout that auto-closes unused connections. Timers are `unref()`'d so they don't prevent Node from exiting.

### Base64 Prompt Encoding

Prompts sent to remote agents are base64-encoded before being passed through SSH. This sidesteps the shell escaping nightmare of nested quoting across SSH → bash → claude CLI, across different operating systems. The remote side decodes before passing to Claude.

### Session Persistence

Each agent stores an optional `sessionId` — a Claude conversation thread ID. When `resume=true` (the default), subsequent prompts continue the same conversation, so the remote Claude has full context of prior exchanges. Resetting a session is an explicit action, not an accident.

### File-Based Registry

All fleet state lives in `~/.claude-fleet/registry.json` — a single JSON file in the user's home directory. It's deliberately not in the project directory (won't be git-committed accidentally) and not in a database (no server to run, no migrations). For a fleet of dozens of agents, JSON is more than sufficient.

### Duplicate Folder Prevention

Two agents cannot share the same working directory on the same device. For remote agents, "same device" means same SSH host. For local agents, "same device" is always the master machine. This is enforced during registration and updates. It prevents two Claude sessions from stomping on each other's files.

## The Twelve Tools

The tools break into natural groups. Each group has detailed documentation:

**[Lifecycle](tools-lifecycle.md)** — `register_agent`, `list_agents`, `update_agent`, `remove_agent`
Manage the fleet roster. Registration validates connectivity, detects the OS, and checks that Claude CLI is available. Removal includes best-effort cleanup of provisioned OAuth tokens on the agent.

**[Work](tools-work.md)** — `send_files`, `execute_prompt`, `reset_session`
The core workflow. Push files to an agent, run Claude prompts against them, manage conversation sessions.

**[Infrastructure](tools-infrastructure.md)** — `provision_auth`, `setup_ssh_key`, `update_claude`
One-time setup and maintenance. Provision OAuth tokens, migrate from password to key auth, update the Claude CLI remotely.

**[Observability](tools-observability.md)** — `fleet_status`, `agent_detail`
Two-layer monitoring. `fleet_status` gives a quick summary table across all agents with fleet-aware busy detection (distinguishes between Claude processes serving this agent vs unrelated Claude activity). `agent_detail` drills into one agent with connectivity, CLI version, session state, and system resource metrics.

## Cross-Platform Support

Agents can run Windows, macOS, or Linux. The `platform.ts` utility generates the right shell commands for each OS — different commands for checking processes, reading memory, setting environment variables. The OS is auto-detected during registration (`uname -s` on Unix, `cmd /c ver` on Windows) and stored in the agent record so subsequent tool calls don't need to re-detect.
