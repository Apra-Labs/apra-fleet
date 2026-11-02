# Bitbucket Authentication

API tokens (app passwords) tied to a user account. Long-lived, no auto-expire.

## Setup

1. Go to `https://id.atlassian.com/manage-profile/security/api-tokens`
   (or Bitbucket: Settings > Personal Bitbucket settings > App passwords)
2. Create app password with required scopes (see below)
3. Copy token - shown only once
4. Store the token as the fleet secret `bitbucket_api_token` (`credential_store_set name=bitbucket_api_token`) and provide the workspace slug. No email is needed.

## Deploy

```
provision_vcs_auth(member_id, provider: 'bitbucket', api_token: '{{secret.bitbucket_api_token}}', workspace: '...')
```

`email` is optional and ignored for authentication (kept only as metadata if
given). The git credential helper always uses the fixed username
`x-bitbucket-api-token-auth`; re-provisioning a member whose helper still
carries an email username rewrites it. Verification GETs the member's origin
repository over REST with `Authorization: Bearer` and runs a non-interactive
`git ls-remote` against the origin -- both must pass for `verified: true`.

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
curl -sf -H "Authorization: Bearer $TOKEN" https://api.bitbucket.org/2.0/repositories/{workspace}/{repo}
GIT_TERMINAL_PROMPT=0 git ls-remote https://bitbucket.org/{workspace}/{repo}.git HEAD
```

## Storing tokens for reuse

After provisioning VCS auth, you can store the Bitbucket API token in the credential store for direct use in `execute_command` - for example, calling the Bitbucket REST API or authenticating git operations manually.

**Store a Bitbucket token for reuse:**

```
credential_store_set  name=bitbucket_api_token
```

**Use it in a command on a member:**

```
execute_command  command="curl -sf -H 'Authorization: Bearer '{{secret.bitbucket_api_token}} https://api.bitbucket.org/2.0/repositories/workspace/repo"
```

The token is resolved server-side and redacted in output (`[REDACTED:bitbucket_api_token]`) - it never appears in the LLM conversation or command logs.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| 401 Unauthorized (`rest_unauthorized`) | Token revoked or missing scopes; regenerate it and update the `bitbucket_api_token` secret |
| git fails, REST ok (`git_auth_failed`) | Re-run `provision_vcs_auth` so the helper carries the fixed username `x-bitbucket-api-token-auth` |
| 403 Forbidden | Create new app password with additional scopes |
| Repository not found | Check workspace slug in Bitbucket URL |
| Clone prompts for password | Re-run `provision_vcs_auth` |
