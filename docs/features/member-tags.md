<!-- llm-context: Describes the member category and tags feature added in sprint feat/member-tags-design. Read when working on member registration, display, or tag-aware dispatch/filtering. -->
<!-- keywords: tags, category, Agent, register_member, update_member, groupByCategory, check_status, list_members -->
<!-- see-also: ../architecture.md (Agent data model), ../../src/types.ts (Agent interface), ../../src/utils/agent-helpers.ts (groupByCategory) -->

# Member Category and Tags

## Overview

Each registered member (Agent) can carry two classification fields:

| Field | Type | Purpose |
|-------|------|---------|
| `category` | `string` (optional) | Free-text label used to group members in display output |
| `tags` | `string[]` (optional) | Arbitrary keyword set for filtering and skill-matrix matching |

Both fields are backward compatible -- they default to `undefined` and existing members without them behave identically to before.

## Data Model

Defined in `src/types.ts` on the `Agent` interface:

```typescript
category?: string;
tags?: string[];
```

### Constraints (enforced by Zod schemas in register-member.ts and update-member.ts)

- `tags`: maximum 10 elements; each element maximum 64 characters
- `category`: free text, trimmed on write; empty string is stored as `undefined`
- Passing `tags: []` in `update_member` clears the tags field (stored as `undefined`)

## Validation

Both `registerMemberSchema` and `updateMemberSchema` include identical Zod constraints:

```typescript
tags: z.array(z.string().max(64)).max(10).optional()
category: z.string().optional()
```

Boundary behaviour: exactly 10 tags of 64 chars each is valid; 11 tags or a 65-char tag is rejected with a Zod validation error.

## Display

Tags and category are surfaced in `check_status` and `list_members` output:

- **Compact text format**: members are grouped by category (alphabetically; `(uncategorized)` always last). Tags are shown as a comma-separated inline list after the member line.
- **JSON format**: `category` and `tags` are included as-is in the JSON member object.

## groupByCategory Utility

`src/utils/agent-helpers.ts` exports `groupByCategory<T>()`:

```typescript
function groupByCategory<T>(
  items: T[],
  getCategory: (item: T) => string | null | undefined,
): { grouped: Map<string, T[]>; sortedKeys: string[] }
```

- Returns a `Map` keyed by category string and an array of sorted keys.
- Items with no category (null, undefined, or empty) are grouped under the key `"(uncategorized)"`.
- Alphabetical sort with `"(uncategorized)"` pinned last.

## MCP Tool Interface

### register_member

Optional parameters added:

| Parameter | Type | Description |
|-----------|------|-------------|
| `category` | string (optional) | Category label for display grouping |
| `tags` | string[] (optional) | Up to 10 keyword tags, max 64 chars each |

### update_member

Same parameters as register_member. Semantics:

- `category: ""` clears the category (stored as undefined)
- `tags: []` clears all tags (stored as undefined)
- Omitting `tags` entirely leaves the existing tags unchanged

## Architecture Invariants

- Tags and category are purely metadata; they do not affect dispatch routing, SSH transport, or session management in Phases 0-1.
- Tag-based permission composition (Phase 2, apra-fleet-04a) and tag-based member filtering in list_members (Phase 5, apra-fleet-4xe) are planned follow-on work but are NOT yet implemented.
- The `groupByCategory` utility is generic (`<T>`) and reusable for any item type, not just Agents.

## Phases Implemented vs Planned

| Phase | ID | Status | Description |
|-------|----|--------|-------------|
| 0 | apra-fleet-j23 | Done | category field + groupByCategory + display |
| 1 | apra-fleet-9iw | Done | tags field + validation + display + tests |
| 2 | apra-fleet-04a | Planned | Tag-aware permission composition |
| 3 | apra-fleet-51i | Planned | Tag-aware skill matrix |
| 4 | apra-fleet-6ky | Planned | Update permissions.md for tag composition |
| 5 | apra-fleet-4xe | Planned | Tag filter param in list_members |
| Integration | apra-fleet-2tl | Planned | Full end-to-end integration tests |
