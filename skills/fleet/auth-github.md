# GitHub Auth

## GitHub App
Auto-mint tokens. Needs `setup_git_app`.

1. Create App in Org.
2. Perms: Contents, PRs, Actions.
3. Install.
4. `.pem` key.
5. `setup_git_app`.

**Deploy:**
`provision_vcs_auth(id, provider: github, git_access: push, repos: [...])`.

## PAT
`provision_vcs_auth(id, provider: github, github_mode: pat, token: ...)`.