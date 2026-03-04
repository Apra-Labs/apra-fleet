# GitHub Authentication

## Auth Modes

GitHub supports two credential modes via `provision_vcs_auth`:

### GitHub App (Recommended)

Short-lived tokens minted automatically. Requires one-time `setup_git_app` configuration.

**When to use**: Organization repos where you have admin access to install a GitHub App.

**Setup**:
1. Create a GitHub App at `https://github.com/organizations/{org}/settings/apps`
2. Grant required permissions (Contents, Pull Requests, Actions, etc.)
3. Install the app on your organization
4. Download the private key (.pem file)
5. Run `setup_git_app` with the App ID, private key path, and installation ID

**Deploy**:
```
provision_vcs_auth(agent_id, provider: 'github')
# or with overrides:
provision_vcs_auth(agent_id, provider: 'github', git_access: 'push', repos: ['Org/Repo'])
```

Tokens expire after 1 hour. Re-mint automatically via `provision_vcs_auth` when needed.

### Personal Access Token (PAT)

Long-lived token provided by the user.

**When to use**: Personal repos, or when GitHub App installation is not possible.

**Setup**:
1. Go to `https://github.com/settings/tokens`
2. Create a fine-grained or classic token with required scopes
3. Provide the token to the PMO

**Deploy**:
```
provision_vcs_auth(agent_id, provider: 'github', github_mode: 'pat', token: 'ghp_...')
```

## Scope Mapping

| Role | Required GitHub Scopes |
|------|----------------------|
| development | `repo` (full repository access) |
| code-review | `repo:read` |
| testing | `repo:read`, `actions:read` |
| devops | `repo`, `actions:write` |
| debugging | `repo:read` |

## Test Commands

```bash
# Check gh CLI auth
gh auth status

# Test git access
git ls-remote https://github.com/{owner}/{repo}.git HEAD

# Test API access
gh api /user
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `401 Bad credentials` | Token expired or revoked | Re-mint via `provision_vcs_auth` |
| `403 Resource not accessible` | Insufficient permissions | Check App permissions or PAT scopes |
| `Repository not found` | Repo not in App installation | Add repo to GitHub App installation |
| `gh: command not found` | gh CLI not installed | Install via `brew install gh` or `apt install gh` |
