# User Guide

## What is Apra Fleet?

Apra Fleet lets you control Claude Code on multiple machines from a single conversation. Register your machines once, then tell Claude to run prompts, execute commands, or send files to any of them — local or remote.

## Install

### 1. Download the binary

Go to [GitHub Releases](https://github.com/Apra-Labs/apra-fleet/releases) and download the binary for your platform:

- `apra-fleet-linux-x64` — Linux (x86_64)
- `apra-fleet-darwin-arm64` — macOS (Apple Silicon)
- `apra-fleet-win-x64.exe` — Windows

### 2. Run the installer

The binary is self-installing. Run it with `install` to set everything up:

```bash
# macOS / Linux
chmod +x apra-fleet-darwin-arm64
./apra-fleet-darwin-arm64 install --skill

# Windows
apra-fleet-win-x64.exe install --skill
```

The `--skill` flag installs the PM (Project Manager) skill, which adds orchestration capabilities for multi-step projects. Omit it if you only need basic fleet operations.

**What `install` does:**
- Copies the binary to `~/.apra-fleet/bin/`
- Installs hooks and scripts to `~/.apra-fleet/`
- Registers the fleet server with Claude Code
- Configures a status bar showing fleet member activity
- (With `--skill`) Installs the PM skill to `~/.claude/skills/pm/`

### 3. Load the server in Claude Code

Start or restart Claude Code, then type:

```
/mcp
```

You should see `apra-fleet` listed as a connected server.

## Register your first member

A "member" is any machine (or workspace) that fleet manages. There are two types:

### Local member (same machine)

Just tell Claude:

> "Register a local member called `my-project` working in `C:\Users\me\projects\myapp`."

No SSH needed — it runs as a child process on your machine.

### Remote member (another machine via SSH)

You need SSH access to the remote machine. Tell Claude:

> "Register 192.168.1.10 as `build-server`. Username is akhil, password is mypass, work folder `/home/akhil/projects/myapp`."

Fleet will test connectivity, detect the OS, and check if Claude Code is installed. If Claude Code isn't installed, you can say:

> "Install Claude Code on build-server."

### SSH key auth

After registering a remote member with a password, migrate to key-based auth:

> "Set up SSH key auth for build-server."

This generates a key pair, deploys it, verifies it works, then removes the password from storage.

## Using fleet members

### Run a prompt on a member

> "On build-server, run the test suite and fix any failures."

Claude sends the prompt to the member's Claude Code instance, which has full access to the code in its work folder.

### Run a command on a member

> "Run `git status` on build-server."

Direct shell commands without starting a Claude session — useful for quick checks.

### Send files to a member

> "Send `config.json` and `deploy.sh` to build-server."

Uploads files via SFTP to the member's work folder.

### Check status

> "Show me fleet status."

Shows all members, their status (online/offline), and last activity.

## Git authentication

By default, remote members can't push/pull from your repositories. Fleet provisions scoped credentials so each member gets only the access it needs.

### GitHub

**Apra Labs members:**

The `apra-fleet-git` app is already installed on the Apra-Labs org. Two steps:

1. **Ensure your repo is added:** Go to `https://github.com/organizations/Apra-Labs/settings/installations` → `apra-fleet-git` → Configure → select your repositories. (Ask an org admin if you don't have access.)
2. **Download the private key:** [apra-fleet-git.pem](https://drive.google.com/file/d/1evUnHsDpv6ZaHyiHoRv-ElQc6vjaWYHd/view?usp=drive_link) (Apra Labs internal — requires org access)
3. **Register the app on your fleet instance (once per machine):** "Set up git auth with app ID 3001109, installation ID 113837928, and private key at ~/Downloads/apra-fleet-git.pem." This only needs to happen once — after that, any member can be provisioned.

Then provision any member:

> "Provision git auth for build-server with push access to Apra-Labs/my-repo."

Skip the "Option A" setup below — it's for creating your own app.

**Option A: GitHub App (recommended for orgs)**

Setting up your own GitHub App (skip this if using the Apra-Labs app above):

1. Go to `https://github.com/organizations/{your-org}/settings/apps` → New GitHub App
2. Name it (e.g. "fleet-git"), set Homepage URL to anything
3. Under Permissions, grant: **Contents** (Read & Write), **Pull Requests** (Read & Write), **Actions** (Read) — add more as needed
4. Create the app, then **Generate a private key** (downloads a `.pem` file)
5. **Install the app** on your org and select which repos it can access
6. Note the **App ID** (from the app's settings page) and **Installation ID** (from the URL after installing: `https://github.com/settings/installations/{installation_id}`)

Then tell Claude:

> "Set up git auth with app ID 12345, installation ID 67890, and private key at ~/my-app.pem."

Now you can provision any member:

> "Provision git auth for build-server with push access to Apra-Labs/my-repo."

Tokens expire after 1 hour and are re-minted automatically.

**Option B: Personal Access Token (simpler, for personal repos)**

1. Go to `https://github.com/settings/tokens` → Generate new token
2. Select scopes: `repo` for full access, or fine-grained per-repo tokens

Then tell Claude:

> "Provision GitHub PAT auth for build-server. Token is ghp_xxxxx."

### Bitbucket

1. Go to Atlassian account → **App passwords** → Create app password
2. Grant permissions: Repository Read/Write, Pull Request Read/Write

Then:

> "Provision Bitbucket auth for build-server. Email is me@example.com, workspace is my-team, token is xxxx."

### Azure DevOps

1. Go to `https://dev.azure.com/{org}/_usersSettings/tokens` → New Token
2. Grant scopes: Code (Read & Write), Pull Request Threads (Read & Write)

Then:

> "Provision Azure DevOps auth for build-server. Org URL is https://dev.azure.com/my-org, token is xxxx."

## PM Skill (Project Manager)

If you installed with `--skill`, you have access to the PM — an orchestration layer for multi-step projects.

### Initialize a project

> "/pm init my-project"

Creates a project folder with templates for status tracking, requirements, design docs, and deployment steps.

### Plan and execute

> "/pm plan Implement user authentication with OAuth2"

The PM writes requirements, dispatches a member to generate an implementation plan, runs it through a review cycle, then executes it phase by phase with verification checkpoints.

### Doer-reviewer loop

> "/pm pair frontend-dev frontend-reviewer"

Pairs two members — one builds, one reviews. The PM handles git transport between them, sends context docs to the reviewer, and iterates until the reviewer approves.

### Key PM commands

| Command | What it does |
|---------|-------------|
| `/pm init <project>` | Create project folder with templates |
| `/pm plan <requirement>` | Generate an implementation plan |
| `/pm start <member> <plan>` | Send task harness and kick off execution |
| `/pm status <member>` | Check progress |
| `/pm resume <member>` | Resume after a verification checkpoint |
| `/pm pair <member> <member>` | Pair doer and reviewer |
| `/pm deploy <member>` | Run deployment steps |

## Troubleshooting

**Member shows as offline?**
- Check if the machine is reachable: `ping <ip>`
- For remote members, verify SSH: `ssh user@host "echo ok"`
- Auth issue? Re-provision: "Provision auth for build-server"

**Permission denied on a member?**
- Fleet can configure member permissions. Say: "Grant build-server permission to run npm install"

**Can't push workflow files or merge PRs from a member?**
- Minted tokens may lack CI/CD permissions. Run these operations from your main Claude Code session instead — it has your full git credentials.

**Empty response from a member?**
- Usually an expired auth token. Say: "Provision auth for build-server"

**Member blew past a checkpoint?**
- Check what actually happened: "Run `cat progress.json` on build-server"
