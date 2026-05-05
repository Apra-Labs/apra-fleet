# Member Permissions

## Before dispatch

Call `compose_permissions` with member + role (`doer`/`reviewer`). optional: `project_folder` (ledger path). Tool detects stack (Node, Python, etc.), selects profile, merges ledger, delivers config. Works across providers.

> "Compose permissions for java-dev1 as doer, project folder ./my-project"

## Denial during execution

If `execute_prompt` has denial, call `compose_permissions` with `grant`:

> "Grant Bash(docker:*) to build-server, reason: tests, project folder ./my-project"

Tool validates (blocks sudo/env), expands (docker→docker-compose), delivers updated config, appends to ledger.

## Role switch

If role changes, re-run `compose_permissions` with new role.

## Never auto-granted

`sudo`, `su`, `env`, `printenv`, `nc`, `nmap` — tool rejects. Escalate to user.
