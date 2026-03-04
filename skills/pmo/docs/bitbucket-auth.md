# Bitbucket Authentication

## Credential Type

Bitbucket uses **API tokens** (app passwords) tied to a user account. Tokens are long-lived and do not auto-expire.

## Setup

1. Go to `https://id.atlassian.com/manage-profile/security/api-tokens`
   (or Bitbucket: Settings > Personal Bitbucket settings > App passwords)
2. Create a new app password with the required scopes (see table below)
3. Copy the token — it is shown only once
4. Provide the token, your email, and workspace slug to the PMO

## Deploy

```
provision_vcs_auth(
  agent_id,
  provider: 'bitbucket',
  email: 'your-email@example.com',
  api_token: 'ATBB_...',
  workspace: 'your-workspace-slug'
)
```

## Scope Mapping

| Role | Required Bitbucket Scopes |
|------|--------------------------|
| development | `repository:write`, `pullrequest:write` |
| code-review | `repository:read`, `pullrequest:read` |
| testing | `repository:read`, `pipeline:read` |
| devops | `repository:admin`, `pipeline:write`, `pullrequest:write` |
| debugging | `repository:read` |

When selecting scopes, take the **union** of all roles assigned to the agent.

## Test Commands

```bash
# Test API access (returns user info)
curl -sf -u email:token https://api.bitbucket.org/2.0/user

# Test workspace access
curl -sf -u email:token https://api.bitbucket.org/2.0/repositories/{workspace}?pagelen=1

# Test git access
git ls-remote https://bitbucket.org/{workspace}/{repo}.git HEAD
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `401 Unauthorized` | Invalid email/token pair | Verify email matches Atlassian account; regenerate token |
| `403 Forbidden` | Insufficient scopes | Create new app password with additional scopes |
| `Repository not found` | Wrong workspace slug | Check workspace slug in Bitbucket URL |
| Clone prompts for password | Credential helper not configured | Re-run `provision_vcs_auth` |
