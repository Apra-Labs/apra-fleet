# GitHub Authentication

Two modes via `provision_vcs_auth`:

## GitHub App (Recommended)

Short-lived tokens, minted automatically. Requires one-time `setup_git_app`.

When to use: Org repos where you have admin access to install a GitHub App.

Setup:
1. Create GitHub App at `https://github.com/organizations/{org}/settings/apps`
2. Grant permissions (Contents, Pull Requests, Actions, etc.)
3. Install on your organization
4. Download private key (.pem file)
5. Run `setup_git_app` with App ID, private key path, installation ID

Deploy:
```
provision_vcs_auth(member_id, provider: 'github')
provision_vcs_auth(member_id, provider: 'github', git_access: 'push', repos: ['Org/Repo'])
```

Tokens expire after 1 hour. Re-mint via `provision_vcs_auth` when needed.

## Personal Access Token (PAT)

Long-lived token from the user.

When to use: Personal repos, or when GitHub App install isn't possible.

Setup:
1. Go to `https://github.com/settings/tokens`
2. Create fine-grained or classic token with required scopes
3. Provide token when prompted

Deploy:
```
provision_vcs_auth(member_id, provider: 'github', github_mode: 'pat', token: 'ghp_...')
```

## Scopes

| Role | Scopes |
|------|--------|
| development | `repo` |
| code-review | `repo:read` |
| testing | `repo:read`, `actions:read` |
| devops | `repo`, `actions:write` |
| debugging | `repo:read` |

## Test

```bash
gh auth status
git ls-remote https://github.com/{owner}/{repo}.git HEAD
gh api /user
```

## Storing tokens for reuse

After provisioning VCS auth, you can also store the token in the credential store so members can use it directly in `execute_command` calls — for example, when calling the GitHub REST API or authenticating git operations that bypass the configured remote URL.

**Store a GitHub PAT for reuse:**

```
credential_store_set  name=github_pat
```

**Use it in a command on a member:**

```
execute_command  command="curl -H 'Authorization: Bearer {{secure.github_pat}}' https://api.github.com/user"
execute_command  command="git remote set-url origin https://token:{{secure.github_pat}}@github.com/Org/Repo.git"
```

The token is resolved server-side and redacted in output (`[REDACTED:github_pat]`) — it never appears in the LLM conversation or command logs.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| 401 Bad credentials | Re-mint via `provision_vcs_auth` |
| 403 Resource not accessible | Check App permissions or PAT scopes |
| Repository not found | Add repo to GitHub App installation |
| gh: command not found | Install via `brew install gh` or `apt install gh` |
