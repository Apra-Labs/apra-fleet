# Design: Git Authentication for Fleet Agents

## Problem

Fleet agents need git access (clone, push, force-push, issue management) across multiple git hosts (GitHub, Azure DevOps, Bitbucket, GitLab). Today there's no standardized way to provision git credentials to agents, and no way to scope permissions per agent role.

Key requirements:
- **Multi-host**: Same abstraction across GitHub, Azure DevOps, Bitbucket, GitLab, self-hosted
- **Scoped permissions**: Read-only agents shouldn't be able to push; dev agents shouldn't force-push to main
- **Short-lived tokens**: Compromised agent = limited blast radius
- **Zero user plumbing**: Users declare intent ("this agent needs read access"), fleet handles the rest
- **Audit trail**: Every token mint logged with agent name, scope, timestamp

## Design

### User-Facing Config

Agents declare git access in their registration or agent config:

```yaml
agents:
  code-analyst:
    host: 192.168.1.13
    work_folder: /Users/akhil/git/ApraPipes
    git_access: read
    git_repos: [Apra-Labs/ApraPipes]

  feature-dev:
    host: 192.168.1.13
    work_folder: /Users/akhil/git/ApraPipes
    git_access: push
    git_repos: [Apra-Labs/ApraPipes]

  release-bot:
    host: 192.168.1.14
    work_folder: /home/deploy/releases
    git_access: admin
    git_repos: ["*"]

  project-mgr:
    host: local
    work_folder: C:\akhil\project-tracking
    git_access: issues
    git_repos: [Apra-Labs/ApraPipes, Apra-Labs/apra-lic-mgr]
```

### Access Levels

| Level | Git operations | Non-git |
|---|---|---|
| `read` | clone, pull, fetch, blame, log | - |
| `push` | read + push to branches (branch protection blocks main/force-push) | - |
| `admin` | read + push + force-push + tags + releases | CI/CD triggers |
| `issues` | - (no code access) | issues, PRs, projects, comments |
| `full` | admin + issues | Everything |

### Backend: GitHub App Token Minting

For GitHub-hosted repos, use a **GitHub App** installed on the org.

```
┌─────────────────────────────────────────────┐
│  apra-fleet-app (GitHub App)                │
│  Installed on: Apra-Labs org                │
│  App private key stored on PM/master         │
│                                             │
│  Max permissions (app-level):               │
│  - contents: write                          │
│  - issues: write                            │
│  - pull_requests: write                     │
│  - actions: write                           │
│  - administration: write                    │
└──────────────┬──────────────────────────────┘
               │
  PM mints scoped tokens per agent at runtime:
               │
               ├──→ code-analyst:  { contents: read,  repos: [ApraPipes] }
               ├──→ feature-dev:   { contents: write, repos: [ApraPipes] }
               ├──→ release-bot:   { contents: write, admin: write, repos: [*] }
               └──→ project-mgr:   { issues: write, pull_requests: write }
```

**Token minting flow:**

```typescript
// Using @octokit/app
import { App } from "@octokit/app";

const app = new App({
  appId: FLEET_GITHUB_APP_ID,
  privateKey: FLEET_GITHUB_APP_KEY,
});

async function mintGitToken(agent: Agent): Promise<string> {
  const octokit = await app.getInstallationOctokit(installationId);

  const { token } = await octokit.request(
    "POST /app/installations/{installation_id}/access_tokens",
    {
      installation_id: installationId,
      repositories: agent.git_repos,          // scoped to specific repos
      permissions: mapAccessLevel(agent.git_access),  // scoped permissions
    }
  );

  return token;  // valid for 1 hour
}

function mapAccessLevel(level: string): Record<string, string> {
  switch (level) {
    case "read":   return { contents: "read" };
    case "push":   return { contents: "write" };
    case "admin":  return { contents: "write", administration: "write", actions: "write" };
    case "issues": return { issues: "write", pull_requests: "write" };
    case "full":   return { contents: "write", administration: "write", issues: "write", pull_requests: "write", actions: "write" };
  }
}
```

**Credential deployment to agent:**

```typescript
async function provisionGitAuth(agent: Agent): Promise<void> {
  const token = await mintGitToken(agent);

  // Configure git credential helper on the agent
  await agent.executeCommand(
    `git config --global credential.helper '!f() { echo "password=${token}"; }; f'`
  );

  // Or more robustly, write a credential helper script
  await agent.executeCommand(`cat > ~/.fleet-git-credential << 'EOF'
#!/bin/sh
echo "protocol=https"
echo "host=github.com"
echo "username=x-access-token"
echo "password=${token}"
EOF
chmod +x ~/.fleet-git-credential
git config --global credential.helper ~/.fleet-git-credential`);
}
```

### Backend: Azure DevOps

Use an **Azure AD App Registration** (Service Principal):

```typescript
// Using @azure/identity + azure-devops-node-api
const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
const token = await credential.getToken("499b84ac-1321-427f-aa17-267ca6975798/.default");

// Deploy to agent as PAT-style credential
await agent.executeCommand(
  `git config --global credential.helper '!f() { echo "password=${token.token}"; }; f'`
);
```

### Backend: Bitbucket

Use a **Bitbucket OAuth Consumer** or **Repository Access Token**:
- OAuth Consumer: org-level, token minting via client_credentials grant
- Repository Access Token: per-repo, created via Bitbucket API, scoped permissions

### Backend: Self-hosted / GitLab

- GitLab: **Project Access Tokens** or **Group Access Tokens** via API
- Self-hosted: SSH keys (fallback — no token API available)

### Token Lifecycle

```
Agent startup / first git operation
        │
        ▼
  PM mints scoped token (1hr TTL)
        │
        ▼
  Deploy credential to agent via execute_command
        │
        ▼
  Agent uses git normally (clone/push/etc)
        │
        ▼
  Token nearing expiry? Auto-refresh before next git operation
        │
        ▼
  Agent deregistered? Token expires naturally (1hr max)
```

### MCP Tool Interface

New tool: `provision_git_auth`

```typescript
// Input
{
  agent_name: "feature-dev",
  // Optional overrides (defaults come from agent config):
  git_host?: "github" | "azure" | "bitbucket" | "gitlab",
  access_level?: "read" | "push" | "admin" | "issues" | "full",
  repos?: string[],
}

// Output
{
  status: "ok",
  host: "github.com",
  access_level: "push",
  repos: ["Apra-Labs/ApraPipes"],
  expires_at: "2026-03-03T16:00:00Z",
  token_prefix: "ghs_****"  // masked for audit
}
```

### Security Properties

| Property | How it's achieved |
|---|---|
| **Least privilege** | Token scoped to declared repos + access level |
| **Short-lived** | 1hr tokens, auto-refreshed |
| **Auditable** | Token minting logged with agent, scope, timestamp |
| **Revocable** | Remove agent = token expires naturally; revoke app installation for emergency |
| **No secrets on agents** | Agents never see the app private key, only short-lived tokens |
| **Compromised agent** | Max 1hr window, scoped to declared repos only |

### Comparison with Alternatives

| | SSH Keys | PATs | GitHub App (this design) |
|---|---|---|---|
| Per-agent scoping | No | Manual | Automatic |
| Token lifetime | Forever | Days-years | 1 hour |
| Multi-host | Same key everywhere | Different per host | Abstracted |
| User effort | Generate + register keys | Generate + distribute tokens | Declare `git_access: push` |
| Revocation | Manual key removal | Manual token revocation | Auto-expires |
| Audit | SSH logs | None built-in | Full mint log |

## Implementation Plan

1. **GitHub App setup** — create app, install on org, store private key in fleet config
2. **`provision_git_auth` tool** — mints scoped token, deploys credential to agent
3. **Auto-provisioning** — mint token on agent startup or first git operation
4. **Auto-refresh** — check token expiry before git operations, refresh if needed
5. **Multi-host backends** — Azure DevOps, Bitbucket, GitLab adapters (same `provision_git_auth` interface)
6. **Agent config** — add `git_access` and `git_repos` fields to agent registration
