# Project Init

1. Determine PM context filename (see `context-file.md`). If missing → create from `tpl-pm.md`.
2. If `projects.md` missing → create from `tpl-projects.md`.
3. Create `<project>/` folder, populate from templates:
- `status.md`: members, phases, sessions (tpl-status.md).
- `requirements.md`: intent, constraints (tpl-requirements.md).
- `design.md`: architecture (tpl-design.md).
- `backlog.md`: debt, deferred items (tpl-backlog.md).
- `deploy.md`: deployment runbook (tpl-deploy.md).
- `permissions.json`: permission grants (empty).
- `planned.json`: immutable plan (saved after Approval).
4. Add row to `projects.md`.

Artifacts live in `<project>/`.