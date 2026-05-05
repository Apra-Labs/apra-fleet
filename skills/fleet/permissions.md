# Member Permissions

## Before dispatching work

Call `compose_permissions` with the member and role (`doer` or `reviewer`). Add additional roles to profiles as needed. Optionally pass `project_folder`—the path to a folder containing a `permissions.json` ledger of approved permissions. The tool detects the project stack (Node.js, Python, Go, etc.) from the member `work_folder`, selects the matching permission profile, merges ledger grants, and delivers the provider-native config. This call works across all agentic providers.

> "Compose permissions for java-dev1 as doer, project folder ./my-project"

## Permission denial during execution

When `execute_prompt` output contains a permission denial, call `compose_permissions` with `grant`:

> "Grant Bash(docker:*) to build-server, reason: integration tests, project folder ./my-project"

The tool validates (blocks dangerous tools like `sudo` or `env`), expands co-occurrences (docker→docker-compose), delivers the updated config, and appends to the project ledger.

## Role switch

When a member role changes, re-run `compose_permissions` with the new role.

## Never auto-granted

The tool rejects `sudo`, `su`, `env`, `printenv`, `nc`, and `nmap`. Escalate these to the user.
