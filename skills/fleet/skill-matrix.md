# Skill Matrix

Map project/role to skills. Onboarding Step 6.

| Project | VCS | Role | Required Skills |
|---|---|---|---|
| Any | GitHub | Any | None (gh CLI) |
| Any | Bitbucket | devops/review | `bitbucket-devops` |
| Any | AzDO | devops/review | `azdevops-devops` (future) |
| ApraPipes | Any | devops | `aprapipes-devops` |
| AVMS | Any | debug | `lvsm-log-analyzer` |

## Skills

- `bitbucket-devops`: Bitbucket API, PRs, pipelines.
- `aprapipes-devops`: Build, test, deploy.
- `azdevops-devops`: AzDO API (planned).
- `lvsm-log-analyzer`: AVMS/BBNVR log analysis.

## Rules

1. Skills additive: multiple roles = union.
2. GitHub: `gh` CLI enough.
3. Bitbucket/AzDO: Need skills for devops/review (API knowledge).
4. Project skills layer on VCS skills.
5. Selection driven by VCS/project, not LLM provider.