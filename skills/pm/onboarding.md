# Member Onboarding

After `register_agent`, run these 8 steps before dispatching any work.

## Step 1: Detect VCS Provider

Run on the member: `git remote -v`

- `github.com` → GitHub
- `bitbucket.org` → Bitbucket
- `dev.azure.com` → Azure DevOps

No remotes? Ask the user for VCS provider and repo URL.

## Step 2: Determine Roles

Ask the user. Roles are additive — a member can have multiple:

| Role | Description |
|------|-------------|
| development | Write code, create branches, push commits |
| code-review | Read PRs, post review comments |
| testing | Read repo, read CI/pipeline results |
| devops | Admin repo, manage pipelines, merge PRs |
| debugging | Read-only repo access |

## Step 3: Map Roles to Scopes

Union of all selected roles determines required VCS scopes:

| Role | GitHub | Bitbucket | Azure DevOps PAT |
|------|--------|-----------|------------------|
| development | `repo` | `repository:write`, `pullrequest:write` | Code: R&W, PR: R&W |
| code-review | `repo:read` | `pullrequest:read`, `repository:read` | Code: Read, PR: R&W |
| testing | `repo:read`, `actions:read` | `repository:read`, `pipeline:read` | Code: Read, Build: Read |
| devops | `repo`, `actions:write` | `repository:admin`, `pipeline:write`, `pullrequest:write` | Full access or Code+Build+Release: R&W |
| debugging | `repo:read` | `repository:read` | Code: Read |

## Step 4: Check Existing Auth

Run provider-specific connectivity test on the member:
- GitHub: `gh auth status`
- Bitbucket: `curl -sf -u email:token https://api.bitbucket.org/2.0/repositories/{workspace}?pagelen=1`
- Azure DevOps: `curl -sf -u :pat https://dev.azure.com/{org}/_apis/projects?api-version=7.1&$top=1`

No remotes yet? Ask user for VCS details first.

## Step 5: Guide Token Setup (if insufficient)

- GitHub: Use GitHub App (automatic via `setup_git_app`) or PAT. See auth-github.md.
- Bitbucket: Create API token at Atlassian account settings. See auth-bitbucket.md.
- Azure DevOps: Create PAT in user settings. See auth-azdevops.md.

## Step 6: Deploy Credentials

```
provision_vcs_auth(agent_id, provider: 'github', github_mode: 'github-app')
provision_vcs_auth(agent_id, provider: 'bitbucket', email: '...', api_token: '...', workspace: '...')
provision_vcs_auth(agent_id, provider: 'azure-devops', org_url: '...', pat: '...')
```

## Step 7: Check/Install Required Skills

See skill-matrix.md for the full mapping.

| Condition | Required Skill |
|-----------|---------------|
| Bitbucket + (devops or code-review) | `bitbucket-devops` |
| ApraPipes project + devops | `aprapipes-devops` |
| GitHub + any role | None (gh CLI sufficient) |
| Azure DevOps + (devops or code-review) | `azdevops-devops` (future) |

## Step 8: Update Member Status File

Add to the member's status file:

```
## Member Profile
- VCS: Bitbucket (kumaakh/apra-lic-mgr)
- Roles: development, code-review
- Auth: Bitbucket API token (verified)
- Skills: bitbucket-devops (installed)
```
