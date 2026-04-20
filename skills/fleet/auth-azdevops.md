# Azure DevOps Authentication

Personal Access Tokens (PATs) with configurable scopes and expiration. Auth: empty username, PAT as password.

## Setup

1. Go to `https://dev.azure.com/{org}/_settings/tokens`
2. Click "New Token"
3. Set descriptive name (e.g., "fleet-{name}")
4. Select required scopes (see below)
5. Set expiration (recommend: 90 days)
6. Copy token — shown only once
7. Provide token and org URL when prompted

## Deploy

```
provision_vcs_auth(member_id, provider: 'azure-devops', org_url: 'https://dev.azure.com/myorg', pat: '...')
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

## Storing tokens for reuse

After provisioning VCS auth, you can store the Azure DevOps PAT in the credential store for direct use in `execute_command` — for example, calling the Azure DevOps REST API or authenticating git operations manually.

**Store an Azure DevOps PAT for reuse:**

```
credential_store_set  name=azdevops_pat
```

**Use it in a command on a member:**

```
execute_command  command="curl -sf -u :{{secure.azdevops_pat}} 'https://dev.azure.com/{org}/_apis/projects?api-version=7.1'"
execute_command  command="git remote set-url origin https://token:{{secure.azdevops_pat}}@dev.azure.com/{org}/{project}/_git/{repo}"
```

The token is resolved server-side and redacted in output (`[REDACTED:azdevops_pat]`) — it never appears in the LLM conversation or command logs.

## Notes

- PAT expiration: default 30 days, max 1 year
- Azure DevOps does not support app-based tokens — PATs are the standard
- Org URL must be base URL without trailing path
