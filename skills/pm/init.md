# Project Init

## Flow

1. If CLAUDE.md doesn't exist in PM's working directory → create from tpl-claude-pm.md
2. If projects.md doesn't exist → create from tpl-projects.md
3. Create `<project>/` subfolder, populate from templates:
   - `status.md` — members, phases, sessions, blockers (tpl-status.md)
   - `requirements.md` — user intent and constraints (PM fills during planning)
   - `design.md` — architecture and design decisions (tpl-design.md)
   - `backlog.md` — project-specific backlog items
   - `deploy.md` — deploy + verify steps (tpl-deploy.md)
   - `planned.json` — immutable plan copy (created during `/pm start`)
4. Add project row to projects.md

All project artifacts live in `<project>/` — never scattered outside it.
