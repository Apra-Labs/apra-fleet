# Claude Code Fleet MCP

Coordinate Claude Code agents across every machine in your network — from a single conversation.

## Why

You're working in Claude Code and you want to:

- Run your test suite on Linux while you develop on macOS
- Have one agent build the frontend, another the backend, and a third running tests — all in parallel
- Spin up isolated workspaces on the same machine without them stepping on each other
- Use a beefy cloud VM for compilation while coding from your laptop

Fleet MCP makes all of this a conversation. No dashboards, no orchestration YAML — just tell Claude what you want and it happens.

## How it works

Fleet MCP is an [MCP server](https://modelcontextprotocol.io/) that Claude Code connects to. It manages a registry of agents (machines with Claude Code installed) and provides tools to register them, send files, execute prompts, and check status. Remote agents connect via SSH. Local agents run as isolated child processes on the same machine.

## Quick start

**1. Install**

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Apra-Labs/claude-code-fleet-mcp/main/install.sh | bash

# Windows (PowerShell)
irm https://raw.githubusercontent.com/Apra-Labs/claude-code-fleet-mcp/main/install.ps1 | iex
```

This clones, builds, and registers the MCP server — all in one step.

**2. Load the server**

Run `/mcp` in Claude Code to pick up the new server. You should see the fleet tools listed.

<details>
<summary>Manual install</summary>

```bash
git clone https://github.com/Apra-Labs/claude-code-fleet-mcp.git
cd claude-code-fleet-mcp
npm install && npm run build
claude mcp add --scope user fleet -- node /full/path/to/claude-code-fleet-mcp/dist/index.js
```

Replace `/full/path/to/` with the actual path where you cloned the repo.

</details>

## Registering your first agent

Once Fleet MCP is running, just talk to Claude:

> "Register 192.168.1.10 as `build-server`. Username is akhil, password is blah-blah, setup key based authentication and work in `/home/akhil/projects/myapp`."

Claude will call `register_agent`, test connectivity, detect the OS, and confirm Claude Code is installed. Done.

For a local agent (same machine, isolated workspace):

> "Register a local agent called `test-runner` working in `/tmp/myapp-tests`."

No SSH needed — it runs as a child process.

## Installing Claude on agents

Don't have Claude Code on a remote machine yet? Fleet can handle that too:

> "Install Claude Code on build-server."

Or update it across your entire fleet:

> "Update Claude on all agents."

Uses the `update_claude` tool — works on Linux, macOS, and Windows agents.

## Real-world examples

### Offload to a powerful machine

> "Register my cloud VM at dev.example.com as `gpu-box`, username ubuntu, password temp123, setup key auth, folder `/home/ubuntu/ml-project`. Send over the training script and run it."

Claude uploads the file via SFTP and kicks off the job on the remote machine. Code from your laptop, run on a 96-core beast.

### Parallel feature development

Register three agents — `frontend`, `backend`, `tests` — each in its own workspace. Then:

> "On `frontend`, add a login form component. On `backend`, add the /auth/login endpoint. When both are done, have `tests` write integration tests for the login flow."

Three agents working simultaneously, each with full Claude Code capabilities.

### Large-scale refactoring

> "Register local agents `refactor-1` through `refactor-5`. Split the migration of all API handlers from Express to Hono across them — each agent takes a different module."

Parallelize a refactor that would take hours into work across multiple isolated workspaces.

### Deploy and verify across environments

> "On `staging-server`, pull main and run the deploy script. Once it's done, on `test-runner`, run the full E2E suite against staging."

Chain work across agents — deploy on one, verify on another.

### Multi-platform testing

Register agents on Linux, macOS, and Windows. Then:

> "Run `npm test` on build-server, mac-mini, and win-desktop at the same time. Show me the results side by side."

Claude sends the prompt to all three agents in parallel and reports back.

## Git authentication

Fleet can provision scoped, short-lived GitHub tokens to agents — so each agent gets only the git access it needs.

**One-time setup:** Create a [GitHub App](https://docs.github.com/en/apps/creating-github-apps) on your org, install it, then register it with Fleet:

> "Set up git auth with app ID 12345, installation ID 67890, and the private key at ~/my-app.pem."

This calls `setup_git_app`, which verifies connectivity and stores the credentials securely.

**Per-agent provisioning:** Set git access when registering or updating agents:

> "Register build-server with git_access push and git_repos Apra-Labs/ApraPipes."

Then provision credentials:

> "Provision git auth for build-server."

This calls `provision_git_auth`, which mints a 1-hour scoped token and deploys a git credential helper to the agent. The token is limited to the declared repos and access level.

**Access levels:**

| Level | Git operations | Non-git |
|-------|---------------|---------|
| `read` | clone, pull, fetch | — |
| `push` | read + push to branches | — |
| `admin` | push + force-push + tags + releases | CI/CD triggers |
| `issues` | — | issues, PRs, comments |
| `full` | admin + issues | everything |

You can override access level and repos per call:

> "Provision git auth for build-server with admin access to Apra-Labs/ApraPipes."

See `docs/design-git-auth.md` for the full design.

## Tools

| Tool | Description |
|------|-------------|
| `register_agent` | Register a machine as a fleet agent (local or remote via SSH) |
| `remove_agent` | Unregister a fleet agent |
| `update_agent` | Update an agent's registration (rename, change host, folder, auth, git access) |
| `list_agents` | List all registered fleet agents |
| `agent_detail` | Deep-dive status for a single agent |
| `fleet_status` | Overview status of all agents |
| `execute_prompt` | Run a Claude prompt on an agent (supports session resume) |
| `execute_command` | Run a shell command directly on an agent (no Claude CLI needed) |
| `reset_session` | Clear session ID so the next prompt starts fresh |
| `send_files` | Upload local files to a remote agent via SFTP |
| `provision_auth` | Deploy OAuth credentials or an API key to an agent |
| `setup_ssh_key` | Generate SSH key pair and migrate from password to key auth |
| `setup_git_app` | One-time setup: register a GitHub App for scoped git token minting |
| `provision_git_auth` | Mint a scoped, short-lived git token for an agent and deploy credentials |
| `revoke_git_auth` | Remove deployed git credentials from an agent |
| `update_claude` | Update or install Claude Code CLI on agents |
| `shutdown_server` | Gracefully shut down the MCP server |

## Configuration file

For bulk registration or integration testing, you can define agents in `fleet.config.json`:

```json
{
  "agents": [
    {
      "friendly_name": "build-linux",
      "agent_type": "remote",
      "host": "192.168.1.10",
      "port": 22,
      "username": "akhil",
      "auth_type": "key",
      "work_folder": "/home/akhil/project"
    },
    {
      "friendly_name": "test-local",
      "agent_type": "local",
      "work_folder": "/tmp/test-workspace"
    }
  ]
}
```

See `fleet.config.example.json` for a full example with password auth and Windows agents.

This file is used by the integration test suite and is gitignored. For normal usage, register agents conversationally — it's easier.

## Requirements

- **Node.js 20+**
- **SSH access** for remote agents (password or key-based)
- Claude Code CLI on agents is recommended but can be installed remotely via `update_claude`

## Development

```bash
npm run build       # Compile TypeScript
npm test            # Run unit tests (vitest)
npm run dev         # Watch mode for development
npm run smoke       # Build + smoke test

# Integration test (requires fleet.config.json and real agents)
FLEET_PASSWORD=xxx npm run integration
```

## License

MIT
