# Skill Matrix

Maps project + role to required skills. Used in onboarding (Step 6).

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
| `bitbucket-devops` | Bitbucket API: create/merge PRs, pipelines, review |
| `aprapipes-devops` | ApraPipes build, test, deploy |
| `azdevops-devops` | Azure DevOps API ops (planned) |
| `lvsm-log-analyzer-skill` | Log analysis for AVMS/BBNVR devices |

## Rules

1. Skills additive — roles = union of skills.
2. GitHub rarely needs extra skills (gh CLI enough).
3. Bitbucket/Azure DevOps need provider skills for devops/code-review (lack native API knowledge).
4. Project-specific skills layer on top.
5. Independent of LLM provider — Gemini/Claude need same project skills. Selection driven by VCS + project.
