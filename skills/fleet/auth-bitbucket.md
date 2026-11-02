# Bitbucket Authentication

Scoped Atlassian API tokens tied to a user account. Bitbucket app passwords
are retired (Atlassian CHANGE-3222) and are not supported.

## Setup

1. Go to `https://id.atlassian.com/manage-profile/security/api-tokens`
2. Choose "Create API token with scopes", app Bitbucket, with the required scopes (see below)
3. Copy token - shown only once
4. Store the token as the fleet secret `bitbucket_api_token` (`credential_store_set name=bitbucket_api_token`) and provide the workspace slug. The secret name `bitbucket_api_token` is FIXED: it is not configurable and there is no fallback name. No email is needed.

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
| development | `read:repository:bitbucket`, `write:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket` |
| code-review | `read:repository:bitbucket`, `read:pullrequest:bitbucket` |
| testing | `read:repository:bitbucket`, `read:pipeline:bitbucket` |
| devops | `admin:repository:bitbucket`, `write:pipeline:bitbucket`, `write:pullrequest:bitbucket` |
| debugging | `read:repository:bitbucket` |

Union of all roles assigned to the member. A fleet-sprint member that pushes
and opens PRs needs the four development scopes.

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

`{{secret.NAME}}` is substituted already quoted for the member's shell, so
reference it bare, never inside your own quotes. The example above is for a
POSIX shell; on a PowerShell member use
`curl.exe -sf -H ('Authorization: Bearer ' + {{secret.bitbucket_api_token}}) https://api.bitbucket.org/2.0/repositories/workspace/repo`.

The token is resolved server-side and redacted in output (`[REDACTED:bitbucket_api_token]`) - it never appears in the LLM conversation or command logs.

## Upgrading from 0.4.4

- If you followed the older version of this doc you stored the token as
  `bitbucket_token`. Store it again as `bitbucket_api_token`
  (`credential_store_set name=bitbucket_api_token`); nothing reads the old name.
- A remote member is re-provisioned automatically the first time its old
  helper fails the sprint's credential probe.
- A LOCAL member is never re-provisioned automatically. Re-provision each one
  by hand, once:
  `provision_vcs_auth member_name=MEMBER provider=bitbucket workspace=WORKSPACE api_token={{secret.bitbucket_api_token}}`
- Azure DevOps members now take the same probe-first path: a rotated PAT is
  deployed only after the old one fails its probe; re-run `provision_vcs_auth`
  to deploy it sooner.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| 401 Unauthorized (`rest_unauthorized`) | Token revoked or missing scopes; regenerate it and update the `bitbucket_api_token` secret |
| git fails, REST ok (`git_auth_failed`) | Re-run `provision_vcs_auth` so the helper carries the fixed username `x-bitbucket-api-token-auth` |
| 403 Forbidden | The API token lacks a scope; create a new API token with the missing scopes and store it as `bitbucket_api_token` |
| 410 Gone | An app password is still in use (retired); replace it with an API token stored as `bitbucket_api_token` |
| Repository not found | Check workspace slug in Bitbucket URL |
| Clone prompts for password | Re-run `provision_vcs_auth` |
