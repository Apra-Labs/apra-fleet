# Apra Fleet

Coordinate AI coding agents across every machine in your network — from a single conversation.

## Why

You're working with an AI coding agent and you want to:

- Run your test suite on Linux while you develop on macOS
- Have one agent build the frontend, another the backend, and a third running tests — all in parallel
- Spin up isolated workspaces on the same machine without them stepping on each other
- Use a beefy cloud VM for compilation while coding from your laptop

Apra Fleet makes all of this a conversation. No dashboards, no orchestration YAML — just tell your agent what you want and it happens.

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

> "Register 192.168.1.10 as `build-server`. Username is akhil, password is mypass, work folder `/home/akhil/projects/myapp`."

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
| `update_claude` | Update or install AI coding agent CLI on members |
| `shutdown_server` | Gracefully shut down the MCP server |

## PM Skill

Apra Fleet ships with an optional Project Manager skill that orchestrates multi-step work across members — planning, doer-reviewer loops, verification checkpoints, and deployment. Install it with `--skill` during setup. See `skills/pm/SKILL.md` for details.

## Git Authentication

Fleet can provision scoped, short-lived tokens to members — so each member gets only the git access it needs.

**Supported providers:** GitHub (App or PAT), Bitbucket (API token), Azure DevOps (PAT).

**Access levels:** `read`, `push`, `admin`, `issues`, `full`.

See `docs/design-git-auth.md` for the full design.

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

## License

CC BY-SA 3.0
