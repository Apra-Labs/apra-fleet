# Project Init

## Flow

1. Determine the PM's agent context filename from `llmProvider` (see `context-file.md`). If that file doesn't exist in PM's working directory → create from `tpl-pm.md`
2. If projects.md doesn't exist → create from tpl-projects.md
3. Create `<project>/` subfolder, populate from templates:
   - `status.md` — members, phases, sessions, blockers (tpl-status.md)
   - `requirements.md` — user intent and constraints (tpl-requirements.md)
   - `design.md` — architecture and design decisions (tpl-design.md)
   - `backlog.md` — technical debt and deferred items (created from `tpl-backlog.md`). PM populates this during and after each sprint: unaddressed MEDIUM/LOW review findings, mid-sprint scope corrections, and any issues deferred to keep the sprint on track. Each item gets a `BL-N` identifier. Nothing is lost — items not resolved in a sprint live here for the next one.
   - `deploy.md` — local copy of the project's deployment runbook; authoritative copy lives in the git repo root (or `docs/`). See `/pm deploy` for the lookup-or-create flow. Scaffold from `tpl-deploy.md` if neither exists.
   - `permissions.json` — learned permission grants, populated by `compose_permissions` as grants are approved during the sprint (created empty at init)
   - `planned.json` — immutable plan copy (saved after plan is APPROVED in Phase 2 — not at init time)
4. Add project row to projects.md

4. Add project row to projects.md

5. **Beads init** — run from the orchestrator (Bash):
   ```bash
   cd <repo>
   bd init                                    # idempotent
   bd create "sprint: <project>" -p 1         # → <epic-id>
   ```
   Record `<epic-id>` in `<project>/status.md` under a `## Beads` section. Task IDs are added here after `/pm plan` completes. See `beads.md` for the full pattern.

All project artifacts live in `<project>/` — see Core Rule 2 in SKILL.md for the full sandboxing requirement.
