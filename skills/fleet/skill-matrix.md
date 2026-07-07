# Skill Matrix

Maps project + tag to required skills. Used during onboarding (Step 6).

Tags are real member tag names (set via `update_member tags=[...]`). They drive
both skill selection (which activate_skill calls to make during onboarding) and
permission composition (which tag-<name>.json profiles are merged in
compose_permissions). The values in the Tag column below are the exact strings
stored in the member's `tags` array.

| Project | VCS | Tag | Required Skills |
|---------|-----|-----|----------------|
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

1. Skills are additive -- multiple tags = union of all required skills
2. Members with no tags need no tag-driven skills; VCS and project rules still apply
3. GitHub members rarely need extra skills -- gh CLI covers most operations
4. Bitbucket/Azure DevOps members need provider-specific skills for devops/code-review tags (LLMs lack native API knowledge without skills)
5. Project-specific skills layer on top of VCS skills
6. Skills are independent of the member's LLM provider -- a Gemini member needs the same project skills as a Claude member. Skill selection is driven by VCS provider, project, and tags, not LLM provider.
