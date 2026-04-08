# Apra Fleet

[![CI](https://github.com/Apra-Labs/apra-fleet/actions/workflows/ci.yml/badge.svg)](https://github.com/Apra-Labs/apra-fleet/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5+-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](https://github.com/Apra-Labs/apra-fleet/releases)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2.svg)](https://modelcontextprotocol.io)

Coordinate AI coding agents across every machine in your network — from a single conversation.

**Apra Fleet** is an open-source **MCP server** for **LLM orchestration** and **agentic workflow** automation. It enables **multi-agent systems** where **autonomous agents** coordinate across machines via SSH. Built for developers using Claude Code, Cursor, Copilot, Windsurf, and other AI coding assistants. Supports **agent memory** persistence, **remote execution**, and cloud compute.

## Why

You're working with an AI coding agent and you want to:

- Run your test suite on Linux while you develop on macOS
- Have one agent build the frontend, another the backend, and a third running tests — all in parallel
- Spin up isolated workspaces on the same machine without them stepping on each other
- Use a beefy cloud VM for compilation while coding from your laptop
- Coordinate autonomous agents across your entire infrastructure — one conversation, zero context-switching

Apra Fleet makes all of this a conversation. No dashboards, no orchestration YAML — just tell your agent what you want and it happens.

Apra Fleet is the missing orchestration layer between your AI coding assistant and your infrastructure.

## How it works

Apra Fleet is an MCP server that agentic coding systems connect to. It manages a registry of members (machines with an AI coding agent installed) and provides tools to register them, send files, execute prompts, and check status. Remote members connect via SSH. Local members run as isolated child processes on the same machine.

## Quick start

See the [User Guide](docs/user-guide.md) for step-by-step install and usage instructions.

**TL;DR:**

```bash
# Download the binary for your platform from GitHub Releases
# https://github.com/Apra-Labs/apra-fleet/releases

# Install (registers MCP server, hooks, statusline, and optionally the PM skill)
./apra-fleet install --skill

# Load in Claude Code
/mcp
```

Then just talk to Claude:

> "Register 192.168.1.10 as `build-server`. Username is akhil, use password auth, work folder `/home/akhil/projects/myapp`."

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
| `provision_auth` | Deploy OAuth credentials or an API key to a member |
| `setup_ssh_key` | Generate SSH key pair and migrate from password to key auth |
| `setup_git_app` | One-time setup: register a GitHub App for scoped git token minting |
| `provision_vcs_auth` | Deploy VCS credentials to a member (GitHub App, Bitbucket, Azure DevOps) |
| `revoke_vcs_auth` | Remove deployed VCS credentials from a member |
| `cloud_control` | Start, stop, or check status of cloud compute instances |
| `monitor_task` | Monitor long-running tasks on cloud members |
| `update_llm_cli` | Update or install AI coding agent CLI on members |
| `shutdown_server` | Gracefully shut down the MCP server |

## PM Skill

Apra Fleet ships with an optional Project Manager skill that orchestrates multi-step work across members — planning, doer-reviewer loops, verification checkpoints, and deployment. Install it with `--skill` during setup. See `skills/pm/SKILL.md` for details.

## Git Authentication

Fleet can provision scoped, short-lived tokens to members — so each member gets only the git access it needs.

**Supported providers:** GitHub (App or PAT), Bitbucket (API token), Azure DevOps (PAT).

**Access levels:** `read`, `push`, `admin`, `issues`, `full`.

See `docs/design-git-auth.md` for the full design.

## Secure Password Entry

When registering a remote member with password authentication, you don't need to pass the password inline. Apra Fleet opens a separate terminal window for password entry so credentials never appear in chat history or logs.

- Password is encrypted immediately with AES-256-GCM and never stored in plaintext
- Works on macOS (Terminal.app), Windows (cmd), and Linux (gnome-terminal/xterm)
- Headless or unsupported environments get a manual command fallback
- Supports password rotation via `update_member`

See `docs/adr-oob-password.md` for the design rationale.

## Cloud Compute

Fleet members can run on cloud instances (AWS EC2) that start and stop automatically based on demand. When you send a prompt to a cloud member, Apra Fleet starts the instance, waits for SSH, re-provisions credentials, and executes the work. When the member goes idle, it stops the instance to save costs.

- **Auto start/stop** — instances start on demand and stop after a configurable idle timeout
- **GPU-aware idle detection** — monitors GPU utilization via `nvidia-smi` so GPU workloads keep instances alive
- **Long-running tasks** — a task wrapper script survives SSH disconnects, supports retry with restart commands, and tracks status
- **Cost tracking** — real-time cost estimates based on instance type and uptime, with warnings for high spend
- **Custom workload detection** — define a shell command to signal busy/idle for arbitrary workloads (CPU training, downloads, etc.)

See `docs/cloud-compute.md` for setup and configuration details.

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
