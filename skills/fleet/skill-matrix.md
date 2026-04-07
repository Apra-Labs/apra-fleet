# Skill Matrix

Maps project + role to required skills. Used during onboarding (Step 7).

| Project | VCS | Role | Required Skills |
|---------|-----|------|----------------|
| Any | GitHub | Any | None (gh CLI sufficient) |
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

## Skills

| Skill | Purpose |
|-------|---------|
| `bitbucket-devops` | Bitbucket API: create/merge PRs, manage pipelines, review code |
| `aprapipes-devops` | ApraPipes-specific build, test, deployment |
| `azdevops-devops` | Azure DevOps API operations (planned) |
| `lvsm-log-analyzer-skill` | SiteManager log analysis for AVMS/BBNVR devices |

## Rules

1. Skills are additive — multiple roles = union of all required skills
2. GitHub members rarely need extra skills — gh CLI covers most operations
3. Bitbucket/Azure DevOps members need provider-specific skills for devops/code-review (LLMs lack native API knowledge without skills)
4. Project-specific skills layer on top of VCS skills
5. Skills are independent of the member's LLM provider — a Gemini member needs the same project skills as a Claude member. Skill selection is driven by VCS provider and project, not LLM provider.
