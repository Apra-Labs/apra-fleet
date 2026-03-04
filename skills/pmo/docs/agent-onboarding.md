# Agent Onboarding Flow

After `register_agent`, run through these 8 steps to fully onboard the agent into the PMO workflow.

## Step 1: Detect VCS Provider

Run on the agent:
```
git remote -v
```

Parse the output to detect the VCS provider:
- `github.com` -> GitHub
- `bitbucket.org` -> Bitbucket
- `dev.azure.com` -> Azure DevOps

If the work folder has no git remotes (empty workspace), ask the user which VCS provider and repo URL to use.

## Step 2: Determine Agent Role(s)

Ask the user which role(s) this agent will have. Roles are **additive** — an agent can have multiple:

| Role | Description |
|------|-------------|
| `development` | Write code, create branches, push commits |
| `code-review` | Read PRs, post review comments |
| `testing` | Read repo, read CI/pipeline results |
| `devops` | Admin repo, manage pipelines, merge PRs |
| `debugging` | Read-only repo access |

## Step 3: Map Roles to Required Scopes

Take the union of all selected roles to determine required VCS scopes:

| Role | GitHub | Bitbucket | Azure DevOps PAT |
|------|--------|-----------|------------------|
| development | `repo` | `repository:write`, `pullrequest:write` | Code: R&W, PR: R&W |
| code-review | `repo:read` | `pullrequest:read`, `repository:read` | Code: Read, PR: R&W |
| testing | `repo:read`, `actions:read` | `repository:read`, `pipeline:read` | Code: Read, Build: Read |
| devops | `repo`, `actions:write` | `repository:admin`, `pipeline:write`, `pullrequest:write` | Full access or Code+Build+Release: R&W |
| debugging | `repo:read` | `repository:read` | Code: Read |

## Step 4: Check Existing Auth

Run a provider-specific connectivity test on the agent:

- **GitHub**: `gh auth status`
- **Bitbucket**: `curl -sf -u email:token https://api.bitbucket.org/2.0/repositories/{workspace}?pagelen=1`
- **Azure DevOps**: `curl -sf -u :pat https://dev.azure.com/{org}/_apis/projects?api-version=7.1&$top=1`

If the agent has no remotes configured yet, ask the user for VCS details before testing.

## Step 5: Guide Token Setup (if insufficient)

If existing auth is missing or insufficient for the required scopes, guide the user:

- **GitHub**: Use GitHub App (automatic via `setup_git_app`) or provide a PAT. See [github-auth.md](github-auth.md).
- **Bitbucket**: Create an API token at Atlassian account settings. See [bitbucket-auth.md](bitbucket-auth.md).
- **Azure DevOps**: Create a PAT in Azure DevOps user settings. See [azure-devops-auth.md](azure-devops-auth.md).

## Step 6: Deploy Credentials

Call `provision_vcs_auth` with the appropriate provider and credentials:

```
provision_vcs_auth(agent_id, provider: 'github', github_mode: 'github-app')
provision_vcs_auth(agent_id, provider: 'bitbucket', email: '...', api_token: '...', workspace: '...')
provision_vcs_auth(agent_id, provider: 'azure-devops', org_url: '...', pat: '...')
```

The tool configures the git credential helper and runs a connectivity test.

## Step 7: Check/Install Required Skills

Based on the project and role, determine which skills the agent needs:

| Condition | Required Skill |
|-----------|---------------|
| Bitbucket + (devops or code-review) | `bitbucket-devops` |
| ApraPipes project + devops | `aprapipes-devops` |
| GitHub + any role | No extra skill (gh CLI is sufficient) |
| Azure DevOps + (devops or code-review) | `azdevops-devops` (future) |

See [skill-matrix.md](skill-matrix.md) for the full mapping.

## Step 8: Update Agent Status File

Add an `## Agent Profile` section to the agent's status file:

```markdown
## Agent Profile
- VCS: Bitbucket (kumaakh/apra-lic-mgr)
- Roles: development, code-review
- Auth: Bitbucket API token (verified)
- Skills: bitbucket-devops (installed)
```

This records the onboarding outcome for future reference and makes it easy to see at a glance what an agent is configured for.
