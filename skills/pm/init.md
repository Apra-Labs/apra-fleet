# Project Init

## Flow

1. Determine PM's agent context filename from `llmProvider` (see `context-file.md`). If file does not exist in PM's working directory, create from `tpl-pm.md`.
2. If `projects.md` does not exist, create from `tpl-projects.md`.
3. Create `<project>/` subfolder and populate from templates:
   - `status.md`: members, phases, sessions, blockers (`tpl-status.md`)
   - `requirements.md`: user intent and constraints (`tpl-requirements.md`)
   - `design.md`: architecture and design decisions (`tpl-design.md`)
   - `backlog.md`: technical debt and deferred items (`tpl-backlog.md`). PM populates this during and after each sprint: unaddressed MEDIUM/LOW review findings, mid-sprint scope corrections, and issues deferred to keep the sprint on track. Each item receives a `BL-N` identifier. Items not resolved in a sprint remain here for the next one.
   - `deploy.md`: local copy of project deployment runbook; authoritative copy lives in git repo root or `docs/`. See `/pm deploy` for lookup-or-create flow. Scaffold from `tpl-deploy.md` if neither exists.
   - `permissions.json`: learned permission grants, populated by `compose_permissions` as grants are approved during the sprint (created empty at init)
   - `planned.json`: immutable plan copy (saved after plan is APPROVED in Phase 2)
4. Add project row to `projects.md`.

All project artifacts live in `<project>/`. See Core Rule 2 in `SKILL.md` for the full sandboxing requirement.
