# File Audit — Remaining Items

> Original audit: 2026-03-19
> Removes and terminology fixes done. Only content refinements remain.

---

### 27. `skills/pm/SKILL.md`
Primary target for PM skill improvements. Baseline version — functional but could benefit from the completed backlog improvements being reflected in the content.

### 31. `skills/pm/permissions.md`
References `compose_permissions` tool — verify this matches actual tool name in `src/tools/compose-permissions.ts`.

### 32. `skills/pm/plan-prompt.md`
Doesn't reference the `tpl-plan.md` output format. Should explicitly link to the template so the prompt and expected output stay in sync.

### 39. `skills/pm/tpl-claude-pm.md`
Only 2 lines. As the PM's own CLAUDE.md template, should be more complete — at minimum include project context, member roster reference, and key constraints.

### 44. `skills/pm/tpl-progress.json`
No field documentation. Should have a companion comment or doc explaining what each field means, valid values, and how PM reads/writes it.

### 49. `skills/pm/profiles/tpl-permissions.json`
Empty template with no guidance. Should show a realistic example or have inline documentation for expected structure.
