# pm Skill: Tag-Based Member Selection

Architectural decisions governing how the pm skill selects and dispatches fleet
members, recorded so future contributors understand the invariants and do not
re-introduce role-based wording.

---

## Why tags, not roles

The pm skill selects fleet members by tag (`tags: ['doer']`, `tags: ['reviewer']`),
never by a `role:` field. Role-based selection was a legacy interface that predated
the tag system; the fleet `list_members` tool no longer accepts a `role` parameter at
all, so any role-based wording in the skill text is dead on arrival.

Three skill files carry the tag-based dispatch wording and must keep it:

| File | Where |
|------|-------|
| `skills/pm/SKILL.md` | member-selection rule |
| `skills/pm/fleet-addendum.md` | Permissions + doer-reviewer pairing |
| `skills/pm/doer-reviewer-loop.md` | Continuity + Resume rules + Safeguards |

---

## Invariants future contributors must preserve

### 1. Always compose before dispatch

`compose_permissions` must be called before EVERY fleet dispatch, regardless of
unattended mode. The permission config is per-member and per-tag. Skipping
compose when reusing a member across tag switches produces stale permissions.

### 2. Tag switch requires a fresh dispatch

A switch from `tags: ['doer']` to `tags: ['reviewer']` (or vice versa) must
always use `resume=false`. The doer-reviewer-loop.md resume table encodes this:

| Dispatch | resume |
|----------|--------|
| Tag switch (doer -> reviewer, or vice versa) | `false` |

Never resume across a tag switch. The new context file must be sent before the
fresh dispatch.

### 3. Recompose when switching tags

Call `compose_permissions` again whenever the tag changes. The fleet
`compose_permissions` tool accumulates a permissions ledger per member; issuing
it for the new tag ensures future same-member, same-tag calls start from the
correct baseline.

### 4. Preserve git identities and heading names

The git commit identities `pm-doer`, `pm-reviewer`, `pm-planner`, and
`pm-plan-reviewer` are NOT role-dispatch parameters -- they are git author
identifiers and must not be changed to tag names. Similarly, section headings
like "Per-role prompt templates" describe structural roles (doer vs reviewer) and
are not dispatch parameters; they must be preserved.

---

## Member selection: tag queries

Fleet members must be selected with the `list_members(tags: [...])` tool, never
by role name, display name, or naming convention.

### Basic queries

```
list_members(tags: ['doer'])      # all members tagged doer
list_members(tags: ['reviewer'])  # all members tagged reviewer
```

Pick the first available result (or the preferred one when multiple match).
Re-run the query when switching from doer to reviewer -- do not cache results
across tag switches.

### Multi-tag queries for capability-based dispatch

When a task requires a specific capability, narrow the query with additional tags:

```
list_members(tags: ['reviewer', 'bitbucket'])  # reviewer with Bitbucket access
list_members(tags: ['doer', 'python'])          # doer with Python capability
list_members(tags: ['doer', 'rust'])            # doer with Rust capability
```

Multi-tag queries return members that carry ALL listed tags. If no member matches
a narrow query, fall back to the single-tag query and note the missing capability
in the dispatch prompt.

---

## Test coverage

The test suite (`test/skill-pm-tags-dispatch.test.mjs`) covers:

- `tags: ['doer']` / `tags: ['reviewer']` present in all three skill files
- `role: doer` / `role: reviewer` absent from dispatch/permission contexts
- `compose_permissions` called before dispatch
- Preserved git identities and section headings
- "Tag switch" resume rule present in doer-reviewer-loop.md
