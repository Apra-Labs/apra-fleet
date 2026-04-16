# Apra Fleet

[![CI](https://github.com/Apra-Labs/apra-fleet/actions/workflows/ci.yml/badge.svg)](https://github.com/Apra-Labs/apra-fleet/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](https://github.com/Apra-Labs/apra-fleet/releases)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2.svg)](https://modelcontextprotocol.io)

AI agents that write code, review each other's work, and coordinate across your machines — from a single conversation.

**Apra Fleet** is an open-source **MCP server** that pairs AI coding agents into **doer-reviewer loops** for higher quality code, and orchestrates them across machines via SSH when you need distributed power. Works with Claude Code, Gemini, Codex and other AI coding assistants.

## What you get

### Doer-reviewer loops — two agents, one quality bar

Pair two agents so one writes code while the other reviews it. The built-in Project Manager orchestrates the handoff with structured checkpoints — no manual coordination needed. This works on a **single machine** (two local agents) or across machines.

```
You:   "Pair local-1 and local-2. local-1 builds the auth module, local-2 reviews."
Fleet: Doer writes code → pauses at checkpoint → Reviewer validates → feedback loop → done.
```

Every change gets a second pair of eyes before you even look at it.

### Multi-machine orchestration — your infrastructure, one conversation

When a single machine isn't enough, Fleet coordinates agents across every machine in your network via SSH. No dashboards, no orchestration YAML — just conversation.

- Run your test suite on Linux while you develop on macOS
- Have one agent build the frontend, another the backend, a third running tests — all in parallel
- Spin up isolated workspaces on the same machine without them stepping on each other
- Use a beefy cloud VM for compilation while coding from your laptop

### PM Skill — structured multi-step workflows

The optional Project Manager skill goes beyond simple task dispatch:

- **Planning** — breaks work into steps, gets your approval before execution
- **Doer-reviewer loops** — pairs agents for write-then-review workflows
- **Verification checkpoints** — agents pause at defined points for review
- **Progress tracking** — state synced via git (`PLAN.md`, `progress.json`, `feedback.md`)

Installed by default — both the fleet and PM skills are written on `apra-fleet install`. See [`skills/pm/SKILL.md`](skills/pm/SKILL.md) for details.

### Provider recommendations

Fleet members can run different LLM backends. Mix and match based on the role:

| Role | Recommended | Why |
|------|-------------|-----|
| **PM (orchestrator)** | Claude (Opus or Sonnet) | Most thoroughly tested for planning and multi-step orchestration |
| **Doer** | Any provider | Claude Sonnet, Gemini Flash, Codex, Copilot — mix freely |
| **Reviewer** | Premium tier models | Catches subtle issues that smaller models miss |

See [`docs/provider-matrix.md`](docs/provider-matrix.md) for the full capability comparison.

## Quick start

Copy-paste the one-liner for your platform:

**macOS (Apple Silicon)**
```bash
curl -fsSL https://github.com/Apra-Labs/apra-fleet/releases/latest/download/apra-fleet-darwin-arm64 -o apra-fleet && chmod +x apra-fleet && ./apra-fleet install
```

**Linux (x64)**
```bash
curl -fsSL https://github.com/Apra-Labs/apra-fleet/releases/latest/download/apra-fleet-linux-x64 -o apra-fleet && chmod +x apra-fleet && ./apra-fleet install
```

**Windows (x64)** — run in PowerShell:
```powershell
Invoke-WebRequest -Uri https://github.com/Apra-Labs/apra-fleet/releases/latest/download/apra-fleet-win-x64.exe -OutFile apra-fleet.exe; .\apra-fleet.exe install
```

Then load in Claude Code:
```
/mcp
```

**Single machine — start here.** No remote servers needed:

> "Register a local member called `doer`. Register another called `reviewer`. Pair them."

**Remote machines — add when ready:**

> "Register 192.168.1.10 as `build-server`. Username is akhil, use password auth, work folder `/home/akhil/projects/myapp`."

## How it works

Apra Fleet is an MCP server that agentic coding systems connect to. It manages a registry of **members** (machines with an AI coding agent installed) and provides tools to register them, send files, execute prompts, and check status. Remote members connect via SSH. Local members run as isolated child processes on the same machine.

## Tools

| Tool | Description |
|------|-------------|
| `register_member` | Register a machine as a fleet member (local or remote via SSH) |
| `remove_member` | Unregister a fleet member |
| `update_member` | Update a member's registration (rename, change host, folder, auth, git access) |
| `list_members` | List all registered fleet members |
| `member_detail` | Deep-dive status for a single member |
| `fleet_status` | Overview status of all members |
| `execute_prompt` | Run a Claude prompt on a member (supports session resume) |
| `execute_command` | Run a shell command directly on a member (no Claude CLI needed) |
| `reset_session` | Clear session ID so the next prompt starts fresh |
| `send_files` | Upload local files to a remote member via SFTP |
| `receive_files` | Download files from a member's work folder |
| `provision_llm_auth` | Deploy OAuth credentials or an API key to a member |
| `setup_ssh_key` | Generate SSH key pair and migrate from password to key auth |
| `setup_git_app` | One-time setup: register a GitHub App for scoped git token minting |
| `provision_vcs_auth` | Deploy VCS credentials to a member (GitHub App, Bitbucket, Azure DevOps) |
| `revoke_vcs_auth` | Remove deployed VCS credentials from a member |
| `cloud_control` | Start, stop, or check status of cloud compute instances |
| `monitor_task` | Monitor long-running tasks on cloud members |
| `compose_permissions` | Generate and deliver provider-native permission config |
| `update_llm_cli` | Update or install AI coding agent CLI on members |
| `shutdown_server` | Gracefully shut down the MCP server |
| `version` | Report server version |

## Git Authentication

Fleet can provision scoped, short-lived tokens to members — so each member gets only the git access it needs.

**Supported providers:** GitHub (App or PAT), Bitbucket (API token), Azure DevOps (PAT).

**Access levels:** `read`, `push`, `admin`, `issues`, `full`.

See [`docs/design-git-auth.md`](docs/design-git-auth.md) for the full design.

## Secure Password Entry

When registering a remote member with password authentication, you don't need to pass the password inline. Apra Fleet opens a separate terminal window for password entry so credentials never appear in chat history or logs.

- Password is encrypted immediately with AES-256-GCM and never stored in plaintext
- Works on macOS (Terminal.app), Windows (cmd), and Linux (gnome-terminal/xterm)
- Headless or unsupported environments get a manual command fallback
- Supports password rotation via `update_member`

See [`docs/adr-oob-password.md`](docs/adr-oob-password.md) for the design rationale.

## Cloud Compute

Fleet members can run on cloud instances (AWS EC2) that start and stop automatically based on demand. When you send a prompt to a cloud member, Apra Fleet starts the instance, waits for SSH, re-provisions credentials, and executes the work. When the member goes idle, it stops the instance to save costs.

- **Auto start/stop** — instances start on demand and stop after a configurable idle timeout
- **GPU-aware idle detection** — monitors GPU utilization via `nvidia-smi` so GPU workloads keep instances alive
- **Long-running tasks** — a task wrapper script survives SSH disconnects, supports retry with restart commands, and tracks status
- **Cost tracking** — real-time cost estimates based on instance type and uptime, with warnings for high spend
- **Custom workload detection** — define a shell command to signal busy/idle for arbitrary workloads (CPU training, downloads, etc.)

See [`docs/cloud-compute.md`](docs/cloud-compute.md) for setup and configuration details.

## FAQ

<details>
<summary><strong>Do I need to install apra-fleet on every device?</strong></summary>

No. apra-fleet only needs to be installed on the device where **you** interact with it. All members are registered and managed from that single installation. Remote machines just need SSH access.
</details>

<details>
<summary><strong>Does apra-fleet only work with Claude?</strong></summary>

No. Fleet supports Claude and Gemini today, with Codex support in development. We recommend Claude as the PM's LLM provider for the best experience — it is the most thoroughly tested for planning and orchestration workflows. Gemini works well for members, especially when you want a different LLM perspective during review.
</details>

<details>
<summary><strong>What if I only have one machine?</strong></summary>

Fleet works great on a single machine. Use the Simple Sprint pattern with a single member, or register two local members (doer + reviewer) that run as isolated child processes. No remote servers needed.
</details>

<details>
<summary><strong>Why use separate folders for doer and reviewer?</strong></summary>

Agents can misbehave when they have too much context. A separate reviewer workspace provides an unbiased perspective that tends to identify more problems. Using different environments for review also validates whether the committed work can be built and run independently.
</details>

<details>
<summary><strong>Does using fleet increase my LLM token usage?</strong></summary>

No — fleet actively reduces token usage through three mechanisms: (1) selecting the right model tier based on task complexity, routing simple tasks to lighter models; (2) preferring shell commands via `execute_command` (zero tokens) over full agent prompts where possible; (3) smart conversation management that decides whether to resume existing sessions (leveraging cached context) or start fresh.
</details>

<details>
<summary><strong>How does fleet safeguard my passwords and credentials?</strong></summary>

Three layers: (1) out-of-band collection — passwords are entered via a shell prompt outside the conversation, so the LLM never sees them; (2) encryption at rest — stored credentials are encrypted locally, never plaintext in config files; (3) passwordless migration — fleet encourages key-based SSH auth to reduce password handling.
</details>

<details>
<summary><strong>Is apra-fleet limited to software development?</strong></summary>

No. Fleet is a general-purpose remote operations platform. Use cases include remote product support, simultaneous log analysis across machines, patch distribution, infrastructure automation, and even profiling and market research.
</details>

<details>
<summary><strong>How does apra-fleet relate to Google's A2A protocol?</strong></summary>

They're architecturally distinct and largely complementary. A2A requires each agent to run a persistent HTTP server and enables autonomous agent-to-agent delegation. Fleet requires only SSH access and uses a human-orchestrated hub-and-spoke model where the PM decides the workflow. Fleet could eventually expose members as A2A-compatible agents while preserving its SSH-based transport.
</details>

See the full [FAQ](docs/FAQ.md) for all questions, or browse the [FAQ discussions](https://github.com/Apra-Labs/apra-fleet/discussions/127).

## Development

```bash
npm install && npm run build   # Build from source
npm test                       # Unit tests (vitest)
npm run build:binary           # Build single-executable binary
node dist/index.js install     # Dev-mode install (registers MCP, hooks, statusline)
```

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned features and good-first-issue ideas for contributors.

## License

Apache 2.0 — see [LICENSE](LICENSE) for the full text.
