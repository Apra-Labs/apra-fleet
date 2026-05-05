# Troubleshooting

| Symptom | Action |
|---------|--------|
| Empty response | Check auth token expiry. Re-provision via `provision_vcs_auth`. |
| Timeout (inactivity) | `timeout_s`: fires when no stdout/stderr output arrives for N seconds (default 300s / 5 min). Applies to all members and providers. Common cause: test runners and build tools (npm test, vitest, cargo build) that buffer output, producing no output for long stretches. Fix: increase `timeout_s` to 600–1200 for build/test dispatches. |
| Timeout (total) | `max_total_s`: fires after N seconds of total elapsed time regardless of activity. Provider-agnostic. Use for hard ceilings on long-running jobs. Set alongside `timeout_s` when you need both a silence guard and a wall-clock cap. |
| Permission denied | Run `compose_permissions` for the member to produce provider-native config. Claude: check `.claude/settings.local.json`. Gemini: check `.gemini/policies/`. Codex: check `.codex/config.toml` approval mode. Copilot: check `.github/copilot/settings.local.json`. |
| Stuck after reset | Escalate model (cheap→standard→premium). If still stuck, flag to the user. |
| Auth error (401/403) | GitHub App: re-mint via `provision_vcs_auth`. Bitbucket/Azure DevOps: ask the user for a fresh token, provision, and retry. See auth-*.md. |
| Token/password appears in command output | Use `credential_store_set` to store the secret. Reference it as `{{secure.NAME}}` in `execute_command`. Fleet redacts it to `[REDACTED:NAME]` before the LLM sees the output. |
| Rotate a credential without re-provisioning | Run `credential_store_delete name=<NAME>` then `credential_store_set name=<NAME>`. The new value is picked up immediately on the next `execute_command` referencing `{{secure.NAME}}`. |
| Tool execution issue | Check `APRA_FLEET_DATA_DIR/logs/fleet-<pid>.log` for execution traces. Filter by member with `jq 'select(.member_id == "<uuid>")'` or by tool with `jq 'select(.tag == "<tool>")'`. See the **Fleet Logs** section in SKILL.md for field reference and `jq` examples. |
