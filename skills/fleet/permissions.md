# Member Permissions

## Before dispatching work

Call `compose_permissions` with the member and role (`doer` or `reviewer` — additional roles can be added to the profiles). Optionally pass `project_folder` — the path to a folder containing a `permissions.json` ledger of previously approved permissions. The tool detects the project stack (Node.js, Python, Go, etc.) from the member's `work_folder`, selects the matching permission profile from the fleet profiles, merges any ledger grants, and delivers the right provider-native config to the member. Same call works across all agentic providers.

> "Compose permissions for java-dev1 as doer, project folder ./my-project"

## Permission denial during execution

When `execute_prompt` output contains a permission denial, call `compose_permissions` with `grant`:

> "Grant Bash(docker:*) to build-server, reason: integration tests, project folder ./my-project"

The tool validates (blocks dangerous tools like sudo/env), expands co-occurrences (docker→docker-compose), delivers the updated config, and appends to the project ledger for future use.

## Role switch

When a member's role changes, re-run `compose_permissions` with the new role.

## Never auto-granted

`sudo`, `su`, `env`, `printenv`, `nc`, `nmap` — the tool rejects these. Escalate to user.
