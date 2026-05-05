# Project Init

## Flow

1. Determine PM's agent context filename via `llmProvider` (`context-file.md`). create from `tpl-pm.md` if missing.
2. create `projects.md` from `tpl-projects.md` if missing.
3. Create `<project>/` subfolder, populate:
   - `status.md`: members, phases, blockers (`tpl-status.md`).
   - `requirements.md`: user intent (`tpl-requirements.md`).
   - `design.md`: design decisions (`tpl-design.md`).
   - `backlog.md`: technical debt, deferred items (`tpl-backlog.md`). ID format: `BL-N`.
   - `deploy.md`: deployment runbook. Create from `tpl-deploy.md` if repo root missing.
   - `permissions.json`: learned permission grants. Populated by `compose_permissions`.
   - `planned.json`: immutable plan (saved after Approval in Phase 2).
4. Add project row to `projects.md`.

All artifacts inside `<project>/` (Sandboxing Rule 2 in SKILL.md).
