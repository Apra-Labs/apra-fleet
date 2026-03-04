# Azure DevOps Authentication

## Credential Type

Azure DevOps uses **Personal Access Tokens (PATs)** with configurable scopes and expiration. Auth pattern: empty username with PAT as the password.

## Setup

1. Go to `https://dev.azure.com/{org}/_usersSettings/tokens`
2. Click "New Token"
3. Set a descriptive name (e.g., "fleet-agent-{name}")
4. Select the required scopes (see table below)
5. Set expiration (recommend: 90 days for long-running agents)
6. Copy the token — it is shown only once
7. Provide the token and org URL to the PMO

## Deploy

```
provision_vcs_auth(
  agent_id,
  provider: 'azure-devops',
  org_url: 'https://dev.azure.com/myorg',
  pat: 'azure-pat-token-here'
)
```

## Scope Mapping

| Role | Required Azure DevOps PAT Scopes |
|------|--------------------------------|
| development | Code: Read & Write, Pull Request Threads: Read & Write |
| code-review | Code: Read, Pull Request Threads: Read & Write |
| testing | Code: Read, Build: Read |
| devops | Full access, or Code + Build + Release: Read & Write |
| debugging | Code: Read |

When selecting scopes, take the **union** of all roles assigned to the agent.

## Test Commands

```bash
# Test API access (returns project list)
curl -sf -u :pat "https://dev.azure.com/{org}/_apis/projects?api-version=7.1&\$top=1"

# Test git access
git ls-remote https://dev.azure.com/{org}/{project}/_git/{repo} HEAD
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `401 Unauthorized` | PAT expired or revoked | Create a new PAT and re-deploy |
| `403 Forbidden` | Insufficient scopes | Create PAT with broader scopes |
| `TF400813: Resource not available` | Wrong org URL or project name | Verify org URL matches `https://dev.azure.com/{org}` |
| Clone prompts for password | Credential helper not configured | Re-run `provision_vcs_auth` |

## Notes

- PATs have configurable expiration (default 30 days, max 1 year)
- Azure DevOps does not support app-based tokens like GitHub Apps — PATs are the standard auth mechanism
- The org URL must be the base URL without trailing path (e.g., `https://dev.azure.com/myorg`)
