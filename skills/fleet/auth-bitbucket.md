# Bitbucket Auth

API tokens (app passwords) for user account. Long-lived, no auto-expire.

## Setup

1. Go `https://id.atlassian.com/manage-profile/security/api-tokens`
   (or Bitbucket Settings > Personal settings > App passwords)
2. Create app password with scopes (see below)
3. Copy token (shown once)
4. Provide token, email, workspace slug when prompted

## Deploy

```
provision_vcs_auth(member_id, provider: 'bitbucket', email: '...', api_token: 'ATBB_...', workspace: '...')
```

## Scopes

| Role | Scopes |
|------|--------|
| development | `repository:write`, `pullrequest:write` |
| code-review | `repository:read`, `pullrequest:read` |
| testing | `repository:read`, `pipeline:read` |
| devops | `repository:admin`, `pipeline:write`, `pullrequest:write` |
| debugging | `repository:read` |

Union of roles assigned to member.

## Test

```bash
curl -sf -u email:token https://api.bitbucket.org/2.0/user
curl -sf -u email:token https://api.bitbucket.org/2.0/repositories/{workspace}?pagelen=1
git ls-remote https://bitbucket.org/{workspace}/{repo}.git HEAD
```

## Reuse

Store token in credential store for `execute_command` (REST API or manual git).

**Store:**

```
credential_store_set  name=bitbucket_token
```

**Use:**

```
execute_command  command="curl -sf -u me@example.com:{{secure.bitbucket_token}} https://api.bitbucket.org/2.0/user"
execute_command  command="git remote set-url origin https://me@example.com:{{secure.bitbucket_token}}@bitbucket.org/workspace/repo.git"
```

Token resolves server-side, redacted in output (`[REDACTED:bitbucket_token]`). Never in LLM logs.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| 401 Unauthorized | Verify email match Atlassian account; regen token |
| 403 Forbidden | New app password with more scopes |
| Repo not found | Check workspace slug in URL |
| Clone prompts password | Re-run `provision_vcs_auth` |
