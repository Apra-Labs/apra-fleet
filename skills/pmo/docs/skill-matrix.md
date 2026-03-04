# Skill Matrix

Maps project type + agent role to required skills. Use during onboarding (Step 7) to determine which skills an agent needs.

## Matrix

| Project | VCS | Role | Required Skills |
|---------|-----|------|----------------|
| Any | GitHub | Any | None (gh CLI is sufficient, Claude knows it natively) |
| Any | Bitbucket | devops | `bitbucket-devops` |
| Any | Bitbucket | code-review | `bitbucket-devops` |
| Any | Bitbucket | development | None |
| Any | Bitbucket | testing | None |
| Any | Bitbucket | debugging | None |
| Any | Azure DevOps | devops | `azdevops-devops` (future) |
| Any | Azure DevOps | code-review | `azdevops-devops` (future) |
| Any | Azure DevOps | development | None |
| ApraPipes | Any | devops | `aprapipes-devops` |
| StreamSurv AVMS | Any | debugging | `lvsm-log-analyzer-skill` |

## Skill Descriptions

| Skill | Purpose |
|-------|---------|
| `bitbucket-devops` | Bitbucket API operations: create/merge PRs, manage pipelines, review code |
| `aprapipes-devops` | ApraPipes-specific build, test, and deployment workflows |
| `azdevops-devops` | Azure DevOps API operations (planned, not yet implemented) |
| `lvsm-log-analyzer-skill` | SiteManager log analysis for AVMS/BBNVR devices |

## Rules

1. Skills are **additive** — if an agent has multiple roles, install the union of all required skills
2. GitHub agents rarely need extra skills — the gh CLI covers most operations
3. Bitbucket and Azure DevOps agents need provider-specific skills for devops/code-review roles because Claude lacks native API knowledge for these providers
4. Project-specific skills (like `aprapipes-devops`) are layered on top of VCS skills
