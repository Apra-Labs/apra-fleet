# Bitbucket Authentication

API tokens (app passwords) tied to a user account. Long-lived, no auto-expire.

## Setup

1. Go to `https://id.atlassian.com/manage-profile/security/api-tokens`
   (or Bitbucket: Settings > Personal Bitbucket settings > App passwords)
2. Create app password with required scopes (see below)
3. Copy token — shown only once
4. Provide token, email, and workspace slug to the PM

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

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| 401 Unauthorized | Verify email matches Atlassian account; regenerate token |
| 403 Forbidden | Create new app password with additional scopes |
| Repository not found | Check workspace slug in Bitbucket URL |
| Clone prompts for password | Re-run `provision_vcs_auth` |
