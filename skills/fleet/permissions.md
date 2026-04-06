# Member Permissions

## Provider Permission Mechanisms

`compose_permissions` produces the correct provider-native config automatically. No manual file editing required.

| Provider | Config Path(s) | Format | Mechanism |
|----------|---------------|--------|-----------|
| Claude | `.claude/settings.local.json` | JSON | Per-tool allow list |
| Gemini | `.gemini/settings.json` + `.gemini/policies/fleet.toml` | JSON + TOML | Mode selection + TOML policy rules |
| Codex | `.codex/config.toml` | TOML | Approval mode (`full-auto`/`suggest`) + sandbox settings |
| Copilot | `.github/copilot/settings.local.json` | JSON | Per-tool allow/deny flags |

## Before every sprint

Run `compose_permissions` with member_id, role (doer/reviewer), and project_folder:

> "Compose permissions for build-server as doer, project folder ./my-project"

The tool detects the project stack, merges base + stack profiles + project ledger, and delivers the provider-native permission config to the member. Zero manual file composition.

## Mid-sprint denial

When a member's output contains a permission denial, call `compose_permissions` with `grant`:

> "Grant Bash(docker:*) to build-server, reason: integration tests, project folder ./my-project"

The tool validates (blocks dangerous tools like sudo/env), expands co-occurrences (docker→docker-compose), delivers the updated config, and appends to the project ledger for next sprint.

## Role switch

When switching doer↔reviewer, re-run `compose_permissions` with the new role.

## Never auto-granted

`sudo`, `su`, `env`, `printenv`, `nc`, `nmap` — the tool rejects these. Escalate to user.
