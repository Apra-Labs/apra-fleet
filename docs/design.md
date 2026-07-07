# Member Tags -- Design

## Current-State Map

### Where roles are used today

#### 1. Permission Composition Schema and Logic

**`src/tools/compose-permissions.ts`**
- **Line 16**: `role: z.enum(['doer', 'reviewer'])` -- the hard-coded enum in the MCP tool schema.
- **Line 119-120** (`compose()`): `const baseName = role === 'doer' ? 'base-dev' : 'base-reviewer'` -- selects which base profile to load.
- **Line 124**: `const roleKey = role === 'doer' ? 'dev' : 'reviewer'` -- maps role to stack profile key.
- **Lines 125-129**: Iterates detected stacks, loads `profile[roleKey]` permissions for each.
- **Line 206**: `provider.composePermissionConfig(input.role, allow)` -- passes role to provider adapter (reactive grant path).
- **Line 238**: Same call on the proactive compose path.

#### 2. Provider Adapter Interface

**`src/providers/provider.ts:93`**
```typescript
composePermissionConfig(role: 'doer' | 'reviewer', allow?: string[]): Array<Record<string, unknown> | string>;
```
Every provider implements this typed signature.

#### 3. Provider Implementations

| Provider | File | Behavior |
|----------|------|----------|
| Claude | `src/providers/claude.ts:160` | Ignores `_role`, uses `allow` list directly |
| Gemini | `src/providers/gemini.ts:161` | `doer` -> `mode: "auto_edit"`; `reviewer` -> `mode: "default"` |
| Codex | `src/providers/codex.ts:148` | `doer` -> `approvalMode: "full-auto"`, `networkAccess: true`; `reviewer` -> `suggest`, `false` |
| Copilot | `src/providers/copilot.ts:140` | `doer` -> `allow-all-tools: true`; `reviewer` -> deny list (write_file, edit_file, run_command) |
| Agy | `src/providers/agy.ts:192` | Ignores `_role`, same config for both |

**Key insight**: Only Gemini, Codex, and Copilot use role to change provider-level behavior. Claude and Agy ignore it entirely. The role-driven provider mode is a binary "can write" / "read-only" decision, not a rich role mapping.

#### 4. Permission Profiles

**`skills/fleet/profiles/`**

Base profiles (selected by role):
- `base-dev.json` -- broad file + shell access (for doer)
- `base-reviewer.json` -- read-only + feedback file write (for reviewer)

Stack profiles (keyed by `dev`/`reviewer`):
- `node.json`: `dev` -> npm/npx/node/yarn/pnpm/tsx; `reviewer` -> npm test/lint/npx
- `python.json`: `dev` -> python/pip/pytest/poetry/ruff/mypy/uv; `reviewer` -> pytest/ruff/mypy
- `rust.json`, `go.json`, `jvm.json`, `cpp.json`, `dotnet.json`, `php.json`: similar split

#### 5. Skill Matrix

**`skills/fleet/skill-matrix.md`**
- Uses broader role labels: `devops`, `code-review`, `development`, `testing`, `debugging`
- These are disconnected from the `doer`/`reviewer` enum -- they exist only in documentation
- Rule: "Skills are additive -- multiple roles = union of all required skills"

#### 6. PM Skill Orchestration

**`skills/pm/doer-reviewer.md`**
- Line 2: Icon assignment: doer=circle, reviewer=square
- Line 3: "Compose and deliver permissions per permissions.md for each member's role"
- Line 14: "Dispatch reviews at model=premium" (reviewer-specific)
- Lines 35-37: Resume rules keyed on `nextTask.phase` vs `lastDispatchedPhase`
- Line 65: "Role switch (doer <-> reviewer) -> resume=false"
- Line 79: "A role switch always requires sending the new agent context file"

**`skills/pm/single-pair-sprint.md`**
- Dispatch loop selects doer vs reviewer
- Model tier: doer uses `nextTask.tier`, reviewer always `premium`

**`skills/pm/context-file.md`**
- Maps provider -> filename (CLAUDE.md, GEMINI.md, etc.)
- Role-specific templates: `tpl-doer.md`, `tpl-reviewer.md`

#### 7. Agent Data Model

**`src/types.ts:6-36`** (`Agent` interface)
- No `role` field stored on Agent. Role is ephemeral, supplied at dispatch time.
- PR #238 adds `category?: string` (single free-text label for display grouping).

#### 8. Registration and Update

**`src/tools/register-member.ts`**: No role field. PR #238 adds `category`.
**`src/tools/update-member.ts`**: No role field. PR #238 adds `category`.

#### 9. Status and Listing

**`src/tools/check-status.ts`**: PR #238 adds `category` to `AgentStatusRow`, groups output by category.
**`src/tools/list-members.ts`**: PR #238 adds category grouping.
**`src/utils/agent-helpers.ts`**: PR #238 adds `groupByCategory()` utility.

---

## Proposed Tag Data Model

### Storage (Agent interface)

```typescript
// src/types.ts
export interface Agent {
  // ... existing fields ...
  tags?: string[];       // NEW: flexible tag set, e.g. ['doer', 'gpu', 'devops']
  category?: string;     // KEEP from PR #238: display-only grouping label
}
```

**Decision: keep `category` separate from `tags`.**

Rationale: `category` (from PR #238) is a display/organizational grouping label -- a single value used to visually group members in `fleet_status` and `list_members`. Tags are a functional capability axis that drives permissions, skill selection, and orchestration. A member might have `tags: ['doer', 'gpu']` and `category: 'production'`. Merging these concerns would overload tags with display semantics or force users to pick a "primary" tag for grouping.

### Tag Schema

```typescript
// In compose-permissions.ts schema
export const composePermissionsSchema = z.object({
  ...memberIdentifier,
  // Legacy -- still accepted for backward compat
  role: z.enum(['doer', 'reviewer']).optional()
    .describe('Legacy role. Maps to tags internally. Use tags instead.'),
  // New
  tags: z.array(z.string().min(1).max(64)).optional()
    .describe('Tags to compose permissions for. Supersedes role when provided.'),
  project_folder: z.string().optional(),
  grant: z.array(z.string()).optional(),
  grant_reason: z.string().optional(),
});
```

Validation: at least one of `role` or `tags` must be provided. If both are provided, `tags` wins.

### Reserved Tags

| Tag | Maps To | Meaning |
|-----|---------|---------|
| `doer` | base-dev profile + `dev` stack keys | Can write code, full shell access |
| `reviewer` | base-reviewer profile + `reviewer` stack keys | Read + feedback, limited shell |

These two reserved tags reproduce today's behavior exactly.

### Custom Tags

Custom tags (e.g. `gpu`, `devops`, `testing`, `bitbucket`) are resolved by looking for a matching profile file:

```
skills/fleet/profiles/tag-<name>.json
```

Example `tag-gpu.json`:
```json
{
  "permissions": {
    "allow": ["Bash(docker:*)", "Bash(nvidia-smi:*)", "Bash(nvidia-docker:*)"]
  }
}
```

If no profile file exists for a tag, the tag has no permission effect (it may still be used for orchestration selection or display).

### How Tags Resolve to Permissions

The `compose()` function changes from:

```
1. Load base profile (base-dev or base-reviewer)
2. For each detected stack, load profile[dev] or profile[reviewer]
3. Merge ledger grants
```

To:

```
1. Determine primary mode tag: first tag matching 'doer' or 'reviewer' (default: 'doer')
2. Load base profile for primary mode (base-dev or base-reviewer)
3. For each detected stack, load profile[modeKey] (dev or reviewer)
4. For each non-mode tag, load tag-<name>.json and merge its permissions
5. Merge ledger grants
```

This is strictly additive. A member with `tags: ['doer', 'gpu']` gets everything a `doer` gets today, plus whatever `tag-gpu.json` adds.

### How Tags Resolve to Provider Mode

Providers need a binary decision: "can this member write?" The primary mode tag (`doer` or `reviewer`) determines this:

```typescript
// In compose-permissions.ts, before calling provider
const primaryMode: 'doer' | 'reviewer' =
  tags.includes('doer') ? 'doer' :
  tags.includes('reviewer') ? 'reviewer' :
  'doer';  // default: doer capabilities

provider.composePermissionConfig(primaryMode, allow);
```

The provider adapter interface signature does NOT change. Providers still receive `'doer' | 'reviewer'` for mode selection. Tags only affect the permission allow-list that is passed alongside.

### How Tags Resolve to Skills

The skill matrix (`skill-matrix.md`) already uses tag-like role names. With the tag model:

| Tag | Required Skills |
|-----|----------------|
| `devops` + VCS=bitbucket | `bitbucket-devops` |
| `code-review` + VCS=bitbucket | `bitbucket-devops` |
| `devops` + project=ApraPipes | `aprapipes-devops` |
| `debugging` + project=StreamSurv | `lvsm-log-analyzer-skill` |

Lookup: `for each tag in member.tags, find matching skill-matrix rows`.

### How Tags Drive Orchestration

The PM skill selects members by tag:

```
# Instead of: "dispatch doer member"
# Now: select member where tags include 'doer'
# Or: select member where tags include 'reviewer' AND 'bitbucket'
```

The PM skill docs (`doer-reviewer.md`, `single-pair-sprint.md`) would accept this transparently because `doer` and `reviewer` are just tags.

---

## How PR #238 Fits In

PR #238 (`feature/categorization` branch, state: OPEN) adds:

1. `category?: string` field to `Agent` interface (`src/types.ts`)
2. `category` parameter to `register_member` and `update_member` schemas
3. `groupByCategory()` utility in `src/utils/agent-helpers.ts`
4. Category-grouped output in `fleet_status` and `list_members`
5. Tests in `tests/category.test.ts` and `tests/update-member.test.ts`

**Integration strategy: merge PR #238 first, then layer tags on top.**

- `category` stays as a display-only grouping field (single string, visual organization)
- `tags` is added as a separate functional field (string array, drives permissions/skills/orchestration)
- `groupByCategory()` continues to work for display grouping
- `fleet_status` and `list_members` show both category groups and tag badges
- The tag system does NOT depend on category, and category does NOT depend on tags

**Why not replace `category` with tags?**

Category is a single-value organizational label (e.g. "production", "staging", "team-a"). Tags are multi-value capability descriptors (e.g. "doer", "gpu", "devops"). A member in the "production" category with tags `[doer, gpu]` uses category for grouping and tags for capability. Collapsing them forces awkward choices: is "production" a capability tag? Does `fleet_status` group by all tags or pick one? Keeping them separate is cleaner.

---

## Alternatives Considered

### A. Replace category with tags entirely

Merge PR #238's `category` into the tag model: one of the tags is designated the "display group" tag.

**Rejected**: Forces a single tag to serve double duty. Display grouping is a UI concern; capability tags are a functional concern. Users would need to pick a "primary" tag for grouping, adding complexity.

### B. Hierarchical roles (RBAC)

Define roles with inheritance: `gpu-doer` inherits from `doer`, etc.

**Rejected**: Over-engineered for the problem. Flat tags with additive permission merging achieve the same result with less complexity. No real use case for inheritance depth > 1.

### C. Inline permission overrides (no tags)

Let `compose_permissions` accept an arbitrary permission list directly, bypassing roles/tags.

**Rejected**: Already partially exists via the `grant` parameter. But grants are reactive (mid-sprint). Tags provide proactive, reusable capability profiles that persist across sprints.

### D. Extend the role enum

Add `'doer' | 'reviewer' | 'devops' | 'gpu' | ...` to the enum.

**Rejected**: Enum explosion. Every new capability requires a code change. Tags are data-driven.

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking `compose_permissions` callers | PM skill, manual users fail | Keep `role` parameter; map it to tags internally. 100% backward compat |
| Provider adapter type change | Build break | Do NOT change `composePermissionConfig` signature. Extract primary mode from tags before calling |
| Tag-profile file not found | Silent no-op for unknown tags | Log a warning when a tag has no matching profile. Non-mode tags without profiles are valid (orchestration-only tags) |
| Permission over-granting | Security | Tags are additive. `reviewer` + `gpu` gets reviewer base + gpu perms, not doer base. The primary mode tag controls the base |
| PM skill confusion | Dispatch errors | PM skill docs updated to use `tags: ['doer']` / `tags: ['reviewer']`. Old `role:` dispatch still works |
| Tag naming collisions | Ambiguity | Reserved tags (`doer`, `reviewer`) documented. Warn if a custom tag profile shadows a reserved name |
| Migration of existing members | Data loss | No migration needed. Existing members have no tags. `compose_permissions` with `role: 'doer'` works as before. Tags are opt-in |
