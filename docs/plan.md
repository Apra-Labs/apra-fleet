# Member Tags -- Implementation Plan

## Phased Approach

### Phase 0: Merge PR #238 (Category)

**Prerequisite for all subsequent phases.**

PR #238 adds `category` to the Agent model, registration, update, and status display. Merge it first so the tag work layers cleanly on top.

**Files**: Already changed in PR #238 (no additional work).

**Tasks**:
1. Review and merge PR #238 (`feature/categorization`)
2. Verify all existing tests pass after merge

---

### Phase 1: Tag Data Model and Storage

**Goal**: Add `tags` field to Agent, expose it in registration and update tools.

**Dependencies**: Phase 0 complete.

**Files changed**:

| File | Change |
|------|--------|
| `src/types.ts` | Add `tags?: string[]` to `Agent` interface |
| `src/tools/register-member.ts` | Add `tags` param to schema (array of strings, max 10, each max 64 chars). Store in agent record |
| `src/tools/update-member.ts` | Add `tags` param. Empty array clears tags |
| `src/tools/check-status.ts` | Display tags in compact and JSON output |
| `src/tools/list-members.ts` | Display tags in compact and JSON output |
| `src/index.ts` | Update tool description for `register_member` and `update_member` |

**Tests**:
- `tests/update-member.test.ts`: add/clear/update tags
- `tests/category.test.ts`: verify tags appear in status/list output
- New `tests/tags.test.ts`: tag validation (max length, max count, empty array)

**Backward compat**: No existing behavior changes. Tags are optional, default undefined.

---

### Phase 2: Tag-Aware Permission Composition

**Goal**: `compose_permissions` accepts `tags` alongside `role`, resolves tags to permissions.

**Dependencies**: Phase 1 complete.

**Files changed**:

| File | Change |
|------|--------|
| `src/tools/compose-permissions.ts` | (1) Add `tags` to schema (optional string array). (2) Validation: require at least one of `role` or `tags`. (3) Extract primary mode: first of `doer`/`reviewer` in tags, or from `role` param. (4) New `composeFromTags()`: load base profile from primary mode, load stack profiles with mode key, load `tag-<name>.json` for each non-mode tag, merge all. (5) Pass primary mode to `provider.composePermissionConfig()` -- no signature change |
| `src/index.ts` | Update `compose_permissions` tool description to mention `tags` |

**New profile files** (examples, not shipped in Phase 2):

| File | Purpose |
|------|---------|
| `skills/fleet/profiles/tag-gpu.json` | Docker, nvidia-smi, nvidia-docker permissions |
| `skills/fleet/profiles/tag-devops.json` | Terraform, kubectl, helm, ansible permissions |

**Tests**:
- `tests/compose-permissions.test.ts`:
  - `tags: ['doer']` produces identical output to `role: 'doer'`
  - `tags: ['reviewer']` produces identical output to `role: 'reviewer'`
  - `tags: ['doer', 'gpu']` merges doer + gpu permissions
  - `role: 'doer'` still works (backward compat)
  - Both `role` and `tags` provided: tags wins
  - Unknown tag (no profile file): no error, no extra permissions
  - Tags with no mode tag: defaults to doer
  - Primary mode extraction: first mode tag wins

**Backward compat**: `role` parameter remains. All existing `compose_permissions` calls work unchanged. Provider adapters are NOT modified -- they still receive `'doer' | 'reviewer'`.

---

### Phase 3: Tag-Aware Skill Matrix

**Goal**: Skill matrix lookup uses tags instead of free-text role column.

**Dependencies**: Phase 1 complete (can run in parallel with Phase 2).

**Files changed**:

| File | Change |
|------|--------|
| `skills/fleet/skill-matrix.md` | Rename "Role" column to "Tag". Document that values are now real tags |
| `src/cli/install.ts` | If install flow checks skill matrix, update to read member tags (Step 6). Currently this is documentation-driven, not code-driven, so changes may be minimal |

**Tests**:
- Verify install flow still works for members with no tags
- Verify skill selection for `tags: ['devops']` + VCS=bitbucket returns `bitbucket-devops`

---

### Phase 4: PM Skill Doc Updates

**Goal**: PM skill orchestration docs reference tags instead of roles, while preserving the doer-reviewer loop.

**Dependencies**: Phases 1-2 complete.

**Files changed**:

| File | Change |
|------|--------|
| `skills/pm/doer-reviewer.md` | Replace `role` references with `tags`. "Compose permissions with tags: ['doer']" instead of "role: doer". Note: the doer-reviewer loop structure is unchanged |
| `skills/pm/single-pair-sprint.md` | Update dispatch references from role to tags |
| `skills/pm/multi-pair-sprint.md` | Update pair tracking to note tags |
| `skills/pm/context-file.md` | No change needed (templates are tpl-doer.md / tpl-reviewer.md, keyed by tag name) |
| `skills/fleet/permissions.md` | Update documentation to explain tag-based composition |

**Backward compat**: PM skill dispatch with `role: 'doer'` / `role: 'reviewer'` still works because Phase 2 maps role to tags internally.

---

### Phase 5: Tag-Based Member Selection

**Goal**: PM skill can select members by tag query (e.g. "find a member with tags ['reviewer', 'bitbucket']").

**Dependencies**: Phases 1-4 complete.

**Files changed**:

| File | Change |
|------|--------|
| `src/tools/list-members.ts` | Add optional `tags` filter param: return only members whose tags include all specified tags |
| `src/index.ts` | Update `list_members` tool description |
| `skills/pm/doer-reviewer.md` | Document tag-based member selection for pairing |

**Tests**:
- `list_members` with `tags: ['gpu']` returns only gpu-tagged members
- `list_members` with `tags: ['doer', 'gpu']` returns members with both tags
- `list_members` with no tag filter returns all members (backward compat)

---

## Test Strategy

### Unit Tests

| Test file | Coverage |
|-----------|----------|
| `tests/compose-permissions.test.ts` | Tag resolution, backward compat with role, profile merging, primary mode extraction, unknown tags |
| `tests/tags.test.ts` (new) | Tag validation, storage, update, clear |
| `tests/category.test.ts` | Unchanged -- category remains separate |
| `tests/update-member.test.ts` | Tag update operations |
| `tests/install-permissions.test.ts` | Verify install flow with tagged members |

### Regression Tests (Skills/Hooks)

| Test | What it verifies |
|------|-----------------|
| `compose_permissions` with `role: 'doer'` | Identical output to pre-tag behavior |
| `compose_permissions` with `role: 'reviewer'` | Identical output to pre-tag behavior |
| PM skill dispatch with `role` param | Loop, resume rules, safeguards unchanged |
| Existing skill matrix lookups | Skill assignment unchanged for current member configs |
| Permission ledger load/save | Existing `permissions.json` files work without migration |
| Provider adapter calls | `composePermissionConfig` receives `'doer'` or `'reviewer'`, not raw tags |

### Integration Tests

- Register a member with tags, compose permissions, verify correct profile merging
- Update member tags, recompose permissions, verify delta
- Full PM sprint with tagged doer and reviewer: verify loop completes

---

## Rollout / Migration

### No data migration needed

- Existing members have no `tags` field. This is fine -- `compose_permissions` continues to accept `role` and maps it to tags internally.
- No schema migration for `fleet-registry.json`. The `tags` field is optional.
- No migration for `permissions.json` ledger. Format unchanged.

### Rollout steps

1. **Ship Phase 0**: Merge PR #238 (category). Release as minor version.
2. **Ship Phases 1-2**: Tag data model + tag-aware permissions. Release as minor version. Announce `tags` parameter in `compose_permissions`. `role` remains supported, no deprecation yet.
3. **Ship Phases 3-4**: Skill matrix + PM doc updates. Release as patch (docs-only impact on skill behavior).
4. **Ship Phase 5**: Tag-based member selection. Release as minor version.
5. **Future**: Consider deprecating `role` parameter after tags are established. No timeline pressure.

### Protecting Existing Skills and Hooks

Each phase includes specific backward-compat checks:

| Protection | How |
|-----------|-----|
| `role` parameter stays | `compose_permissions` schema keeps `role` as optional. Validation: at least one of role/tags required |
| Provider adapters unchanged | `composePermissionConfig(role, allow)` signature stays. Primary mode extracted from tags before calling |
| Profile files unchanged | `base-dev.json`, `base-reviewer.json`, `node.json`, etc. keep current structure. New tag profiles go in `tag-<name>.json` files |
| PM skill loop unchanged | Doer-reviewer cycle, resume rules, safeguards, model tier rules all preserved. Docs updated to use tag vocabulary but logic is identical |
| Hooks unchanged | Hooks do not reference roles. No changes needed |
| Ledger format unchanged | `permissions.json` keeps `{ stacks, granted }` structure |
| Install flow unchanged | `install.ts` does not store roles. Tags are optional at registration |

---

## Task Dependency Graph

```
Phase 0: Merge PR #238
    |
    v
Phase 1: Tag Data Model
    |
    +-------+-------+
    |               |
    v               v
Phase 2:        Phase 3:
Tag Perms       Skill Matrix
    |
    v
Phase 4: PM Docs
    |
    v
Phase 5: Tag Selection
```

Phases 2 and 3 can run in parallel. All other phases are sequential.
