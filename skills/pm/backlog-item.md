# Backlog Item — Content Template and Maintenance

## Creating a Backlog Item

When deferring an item, provide enough detail to act on it in a future sprint without re-investigation.

```bash
bd create "{{headline}}" -p 3 --parent {{epic-id}} --description "$(cat <<'EOF'
Impact: High | Medium | Low
Source: {{GitHub issue URL | review finding ID | sprint name}}

Detail:
{{Full description — code locations, root causes, reproduction steps. Do not summarize.}}

Impact of not addressing:
{{What breaks, degrades, or accumulates if left unresolved.}}
EOF
)"
```

## When to Create

- Unaddressed MEDIUM/LOW review findings after a reviewer verdict
- Scope items deferred mid-sprint to keep the sprint on track
- User says "add to backlog" or "defer this"
- Post-sprint items that did not make the cut

## Backlog Maintenance

### Review

```bash
bd list --all --pretty                     # full tree including all low-priority items
bd list --status open --pretty             # open items only
```

### Re-prioritize

When a future sprint is ready to pick up a backlog item:

```bash
bd update {{id}} -p {{new-priority}}       # e.g. -p 1 to promote to high
```

### Close stale items

```bash
bd close {{id}} --reason "{{reason}}"      # no longer relevant, superseded, fixed elsewhere
```

### Promote to active work

```bash
bd update {{id}} --assignee {{member}} --status in_progress
```

### Cross-sprint dependency

When a backlog item cannot start until another sprint or task completes:

```bash
bd dep add {{backlog-item-id}} {{blocker-id}}
```

`bd ready` will not surface the item until the blocker closes.
