# Bitbucket Authentication

API tokens (app passwords) tie to a user account. They are long-lived and never expire.

## Setup

1. Go to `https://id.atlassian.com/manage-profile/security/api-tokens` or Bitbucket Settings.
2. Create an app password with the required scopes.
3. Copy the token; it is shown only once.
4. Provide the token, the email, and the workspace slug when prompted.

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

Assigned scopes are the union of all roles.

## Test

```bash
curl -sf -u email:token https://api.bitbucket.org/2.0/user
curl -sf -u email:token https://api.bitbucket.org/2.0/repositories/{workspace}?pagelen=1
git ls-remote https://bitbucket.org/{workspace}/{repo}.git HEAD
```

## Storing tokens for reuse

Store the Bitbucket API token in the credential store for use in `execute_command`. This enables calling the Bitbucket REST API or manual git authentication.

**Store a Bitbucket token:**

```
credential_store_set  name=bitbucket_token
```

**Use it in a command:**

```
execute_command  command="curl -sf -u me@example.com:{{secure.bitbucket_token}} https://api.bitbucket.org/2.0/user"
execute_command  command="git remote set-url origin https://me@example.com:{{secure.bitbucket_token}}@bitbucket.org/workspace/repo.git"
```

The token resolves server-side and is redacted in the output. It never appears in the conversation or the logs.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| 401 Unauthorized | Verify the email matches the account; regenerate the token. |
| 403 Forbidden | Create a new app password with additional scopes. |
| Repository not found | Check the workspace slug in the Bitbucket URL. |
| Clone prompts for password | Re-run `provision_vcs_auth`. |