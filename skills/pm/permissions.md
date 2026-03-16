# Member Permissions

## Before every sprint

Run `compose_permissions` with member_id, role (doer/reviewer), and project_folder:

> "Compose permissions for build-server as doer, project folder ./my-project"

The tool detects the project stack, merges base + stack profiles + project ledger, and delivers `settings.local.json` to the member. Zero manual JSON composition.

## Mid-sprint denial

When a member's output contains a permission denial, call `compose_permissions` with `grant`:

> "Grant Bash(docker:*) to build-server, reason: integration tests, project folder ./my-project"

The tool validates (blocks dangerous tools like sudo/env), expands co-occurrences (docker→docker-compose), delivers, and appends to the project ledger for next sprint.

## Role switch

When switching doer↔reviewer, re-run `compose_permissions` with the new role.

## Never auto-granted

`sudo`, `su`, `env`, `printenv`, `nc`, `nmap` — the tool rejects these. Escalate to user.
