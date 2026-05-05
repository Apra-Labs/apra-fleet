# GitHub Auth

Two modes via `provision_vcs_auth`:

## GitHub App (Recommended)

Short-lived tokens, auto-minted. Need one-time `setup_git_app`.

Use for: Org repos where you have admin access.

Setup:
1. Create App `https://github.com/organizations/{org}/settings/apps`
2. Grant permissions (Contents, PRs, Actions, etc.)
3. Install on org
4. Download private key (.pem)
5. Run `setup_git_app` with App ID, private key path, installation ID

Deploy:
```
provision_vcs_auth(member_id, provider: 'github')
provision_vcs_auth(member_id, provider: 'github', git_access: 'push', repos: ['Org/Repo'])
```

Tokens expire 1h. Re-mint via `provision_vcs_auth`.

## Personal Access Token (PAT)

Long-lived token.

Use for: Personal repos or if App install impossible.

Setup:
1. Go `https://github.com/settings/tokens`
2. Create fine-grained/classic token with scopes
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

## Reuse

Store token in credential store for `execute_command` (REST API or manual git).

**Store:**

```
credential_store_set  name=github_pat
```

**Use:**

```
execute_command  command="curl -H 'Authorization: Bearer {{secure.github_pat}}' https://api.github.com/user"
execute_command  command="git remote set-url origin https://token:{{secure.github_pat}}@github.com/Org/Repo.git"
```

Token resolves server-side, redacted in output (`[REDACTED:github_pat]`). Never in LLM logs.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| 401 Bad credentials | Re-mint via `provision_vcs_auth` |
| 403 Forbidden | Check App permissions/PAT scopes |
| Repo not found | Add repo to App installation |
| gh: command not found | Install `gh` (brew/apt) |
