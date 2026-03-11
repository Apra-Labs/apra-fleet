# Azure DevOps Authentication

Personal Access Tokens (PATs) with configurable scopes and expiration. Auth: empty username, PAT as password.

## Setup

1. Go to `https://dev.azure.com/{org}/_usersSettings/tokens`
2. Click "New Token"
3. Set descriptive name (e.g., "fleet-{name}")
4. Select required scopes (see below)
5. Set expiration (recommend: 90 days)
6. Copy token — shown only once
7. Provide token and org URL to the PM

## Deploy

```
provision_vcs_auth(agent_id, provider: 'azure-devops', org_url: 'https://dev.azure.com/myorg', pat: '...')
```

## Scopes

| Role | PAT Scopes |
|------|-----------|
| development | Code: R&W, Pull Request Threads: R&W |
| code-review | Code: Read, Pull Request Threads: R&W |
| testing | Code: Read, Build: Read |
| devops | Full access, or Code + Build + Release: R&W |
| debugging | Code: Read |

Union of all roles assigned to the member.

## Test

```bash
curl -sf -u :pat "https://dev.azure.com/{org}/_apis/projects?api-version=7.1&\$top=1"
git ls-remote https://dev.azure.com/{org}/{project}/_git/{repo} HEAD
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| 401 Unauthorized | Create new PAT and re-deploy |
| 403 Forbidden | Create PAT with broader scopes |
| TF400813: Resource not available | Verify org URL matches `https://dev.azure.com/{org}` |
| Clone prompts for password | Re-run `provision_vcs_auth` |

## Notes

- PAT expiration: default 30 days, max 1 year
- Azure DevOps does not support app-based tokens — PATs are the standard
- Org URL must be base URL without trailing path
