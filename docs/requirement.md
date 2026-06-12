# Member Tags -- Requirements

## Problem Statement

Apra-fleet members are currently organized around a hard-coded two-role system: `doer` and `reviewer`. These roles are baked into the Zod schema (`z.enum(['doer', 'reviewer'])` in `compose-permissions.ts:16`), the provider adapter interface (`composePermissionConfig(role: 'doer' | 'reviewer')` in `provider.ts:93`), permission profiles (`base-dev.json` / `base-reviewer.json`), stack profiles (`dev` / `reviewer` keys), and the PM skill orchestration docs.

This fixed enum makes it impossible to model real-world fleet diversity:

- A GPU-equipped member should carry permissions for CUDA/docker workloads regardless of whether it is acting as doer or reviewer in a given sprint.
- A "devops" member needs Terraform/kubectl permissions that are orthogonal to the doer/reviewer axis.
- The skill matrix (`skill-matrix.md`) already uses broader role labels (`devops`, `code-review`, `debugging`, `development`, `testing`) that have no programmatic connection to the `doer`/`reviewer` enum.
- PR #238 introduces `category` -- a single free-text grouping label -- but category is a display/organizational concept, not a permission/capability axis. Tags subsume category's use case while also driving permissions and orchestration.

## Goals

1. **Replace the fixed `doer`/`reviewer` enum with a flexible tag set** on each member. Tags are string labels (e.g. `doer`, `reviewer`, `gpu`, `devops`, `testing`) that can be combined freely.
2. **Drive permissions, skill selection, and orchestration from tags**, not a single role enum.
3. **Maintain full backward compatibility**: existing `doer`/`reviewer` semantics must keep working identically. The two legacy roles become reserved tag names that map to today's behavior.
4. **Subsume PR #238's `category` field**: category becomes one possible tag (or a separate display-grouping concern) rather than a parallel field.
5. **Enable future extensibility**: custom tags like `gpu`, `high-memory`, `bitbucket`, `production` can influence permission composition and orchestration selection without code changes.

## Non-Goals

- Implementing RBAC (role-based access control) with inheritance hierarchies. Tags are flat labels, not a permission tree.
- Changing how LLM providers or cloud instances work. Tags affect fleet-level orchestration, not provider internals.
- Replacing the PM skill's doer-reviewer loop. The loop stays; it just keys off tags instead of a role enum.
- Multi-tenancy or workspace isolation.

## Why Tags Beat Roles

| Concern | Fixed Roles | Tags |
|---------|-------------|------|
| Extensibility | Adding a role requires code changes to enum, providers, profiles | Adding a tag is data-only |
| Composability | A member is exactly one role at a time | A member carries N tags simultaneously |
| Permission granularity | Binary (all dev perms OR all reviewer perms) | Additive: each tag contributes its permission delta |
| Skill matrix alignment | Skill matrix uses `devops`/`code-review` but code uses `doer`/`reviewer` -- disconnected | Tags unify both: `devops` is a real tag that drives both skills and permissions |
| Orchestration flexibility | PM can only pick doer or reviewer | PM can select by any tag combination (`gpu AND doer`, `reviewer AND bitbucket`) |

## User Stories

1. **As a fleet operator**, I want to tag a member as `gpu` so that when it is dispatched as a doer, it also gets docker/CUDA permissions without manual intervention.
2. **As a PM skill**, I want to select a member for review by filtering on `[reviewer, bitbucket]` tags so that Bitbucket PRs are reviewed by a member with the right skills.
3. **As a fleet operator**, I want to register a member with `tags: [doer, devops]` and have `compose_permissions` automatically merge base-dev + devops permissions.
4. **As an existing user**, I want my current `compose_permissions` calls with `role: 'doer'` to keep working unchanged -- the system should treat this as `tags: ['doer']`.
5. **As a fleet operator**, I want `fleet_status` and `list_members` to group members by tags (replacing the `category` field from PR #238).

## Backward Compatibility Requirements

- The `compose_permissions` MCP tool MUST continue to accept `role: 'doer' | 'reviewer'` as input. Internally, `role: 'doer'` maps to `tags: ['doer']`.
- A new optional `tags` parameter is added. When both `role` and `tags` are provided, the tag list takes precedence and `role` is ignored.
- Permission profiles `base-dev.json` and `base-reviewer.json` remain the base profiles for `doer` and `reviewer` tags respectively.
- Stack profiles (`node.json`, `python.json`, etc.) keep their `dev`/`reviewer` keys. The tag resolver maps `doer` -> `dev` key, `reviewer` -> `reviewer` key.
- Provider adapters continue to receive a primary role indicator (`doer` or `reviewer`) for mode selection (e.g. Gemini's `auto_edit` vs `default`, Codex's `full-auto` vs `suggest`). Tags do not change provider mode semantics.
- PM skill docs that reference `role` continue to work. The PM dispatches with `tags: ['doer']` or `tags: ['reviewer']` which behave identically to today's `role: 'doer'` / `role: 'reviewer'`.

## Must Not Break: Skills and Hooks

- All installed skills (`bitbucket-devops`, `lvsm-log-analyzer-skill`, `aprapipes-devops`) must continue to function.
- The PM skill's doer-reviewer loop, resume rules, and safeguards must be unaffected.
- Hooks (post-checkout, post-merge, startup) must be unaffected.
- The `permissions.json` ledger format must remain compatible (existing ledger files must load without migration).

## Acceptance Criteria

1. `compose_permissions` with `role: 'doer'` produces identical output to today.
2. `compose_permissions` with `role: 'reviewer'` produces identical output to today.
3. `compose_permissions` with `tags: ['doer', 'gpu']` produces doer base permissions merged with gpu-specific permissions.
4. `register_member` and `update_member` accept a `tags` array.
5. `fleet_status` and `list_members` display member tags.
6. The `category` field (PR #238) is either subsumed by tags or kept as a separate display-only field with no functional overlap.
7. All existing tests pass without modification (except adding new tag-specific tests).
8. PM skill dispatches using `role: 'doer'` and `role: 'reviewer'` continue to work identically.
