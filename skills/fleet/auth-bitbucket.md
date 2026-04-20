# Bitbucket Authentication

API tokens (app passwords) tied to a user account. Long-lived, no auto-expire.

## Setup

1. Go to `https://id.atlassian.com/manage-profile/security/api-tokens`
   (or Bitbucket: Settings > Personal Bitbucket settings > App passwords)
2. Create app password with required scopes (see below)
3. Copy token — shown only once
4. Provide token, email, and workspace slug when prompted

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

Union of all roles assigned to the member.

## Test

```bash
curl -sf -u email:token https://api.bitbucket.org/2.0/user
curl -sf -u email:token https://api.bitbucket.org/2.0/repositories/{workspace}?pagelen=1
git ls-remote https://bitbucket.org/{workspace}/{repo}.git HEAD
```

## Storing tokens for reuse

After provisioning VCS auth, you can store the Bitbucket API token in the credential store for direct use in `execute_command` — for example, calling the Bitbucket REST API or authenticating git operations manually.

**Store a Bitbucket token for reuse:**

```
credential_store_set  name=bitbucket_token
```

**Use it in a command on a member:**

```
execute_command  command="curl -sf -u me@example.com:{{secure.bitbucket_token}} https://api.bitbucket.org/2.0/user"
execute_command  command="git remote set-url origin https://me@example.com:{{secure.bitbucket_token}}@bitbucket.org/workspace/repo.git"
```

The token is resolved server-side and redacted in output (`[REDACTED:bitbucket_token]`) — it never appears in the LLM conversation or command logs.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| 401 Unauthorized | Verify email matches Atlassian account; regenerate token |
| 403 Forbidden | Create new app password with additional scopes |
| Repository not found | Check workspace slug in Bitbucket URL |
| Clone prompts for password | Re-run `provision_vcs_auth` |
