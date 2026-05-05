# Azure DevOps Authentication

Personal Access Tokens (PATs) use configurable scopes and expiration. Authentication requires an empty username and the PAT as a password.

## Setup

1. Go to https://dev.azure.com/{org}/_settings/tokens.
2. Click "New Token".
3. Set a descriptive name (e.g., "fleet-{name}").
4. Select the required scopes.
5. Set the expiration. 90 days is recommended.
6. Copy the token. It is shown only once.
7. Provide the token and the organization URL when prompted.

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

Assigned scopes are the union of all roles for the member.

## Test

```bash
curl -sf -u :pat "https://dev.azure.com/{org}/_apis/projects?api-version=7.1&$top=1"
git ls-remote https://dev.azure.com/{org}/{project}/_git/{repo} HEAD
```

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| 401 Unauthorized | Create a new PAT and re-deploy. |
| 403 Forbidden | Create a PAT with broader scopes. |
| TF400813: Resource not available | Verify the organization URL matches https://dev.azure.com/{org}. |
| Clone prompts for password | Re-run provision_vcs_auth. |

## Storing tokens for reuse

Store the Azure DevOps PAT in the credential store for use in execute_command after provisioning VCS auth. This enables REST API calls or manual git authentication.

**Store an Azure DevOps PAT:**

```
credential_store_set  name=azdevops_pat
```

**Use the token in a command:**

```
execute_command  command="curl -sf -u :{{secure.azdevops_pat}} 'https://dev.azure.com/{org}/_apis/projects?api-version=7.1'"
execute_command  command="git remote set-url origin https://token:{{secure.azdevops_pat}}@dev.azure.com/{org}/{project}/_git/{repo}"
```

The token is resolved server-side and redacted in the output ([REDACTED:azdevops_pat]). It never appears in the conversation or command logs.

## Notes

- PAT expiration: 30 days default, 1 year maximum.
- Azure DevOps does not support app-based tokens. PATs are the standard.
- The organization URL must be the base URL without a trailing path.
