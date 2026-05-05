# Azure DevOps Auth

Personal Access Tokens (PATs) with scopes + expiration. Auth: empty username, PAT as password.

## Setup

1. Go `https://dev.azure.com/{org}/_settings/tokens`
2. "New Token"
3. Name: `fleet-{name}`
4. Select scopes (see below)
5. Expiration: 90 days
6. Copy token (shown once)
7. Provide token + org URL when prompted

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

Union of roles assigned to member.

## Test

```bash
curl -sf -u :pat "https://dev.azure.com/{org}/_apis/projects?api-version=7.1&\$top=1"
git ls-remote https://dev.azure.com/{org}/{project}/_git/{repo} HEAD
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| 401 Unauthorized | New PAT + re-deploy |
| 403 Forbidden | PAT with broader scopes |
| TF400813: Not available | Org URL must match `https://dev.azure.com/{org}` |
| Clone prompts for password | Re-run `provision_vcs_auth` |

## Reuse

Store PAT in credential store for `execute_command` (REST API or manual git).

**Store:**

```
credential_store_set  name=azdevops_pat
```

**Use:**

```
execute_command  command="curl -sf -u :{{secure.azdevops_pat}} 'https://dev.azure.com/{org}/_apis/projects?api-version=7.1'"
execute_command  command="git remote set-url origin https://token:{{secure.azdevops_pat}}@dev.azure.com/{org}/{project}/_git/{repo}"
```

Token resolves server-side, redacted in output (`[REDACTED:azdevops_pat]`). Never in LLM logs.

## Notes

- Expiration: default 30d, max 1y
- No app tokens — use PAT
- Org URL: base URL, no trailing path
