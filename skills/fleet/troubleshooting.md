# Troubleshooting

| Symptom | Action |
|---------|--------|
| Empty response | Check auth token expiry → re-provision via `provision_vcs_auth` |
| Timeout (inactivity) | `timeout_ms`: fires when no stdout/stderr output arrives for N ms (default 300000ms / 5 min). Applies to all members and all providers — transport-level, not provider-specific. Common cause: test runners and build tools that buffer output (npm test, vitest, cargo build) producing no output for long stretches even while active. Fix: increase `timeout_ms` to 600000–1200000ms for build/test dispatches. |
| Timeout (total) | `max_total_ms`: fires after N ms of total elapsed time regardless of output activity. Provider-agnostic. Use for hard ceilings on long-running jobs. Set alongside `timeout_ms` when you need both a silence guard and a wall-clock cap. |
| Permission denied | Run `compose_permissions` for the member — it produces provider-native config. Claude: check `.claude/settings.local.json`. Gemini: check `.gemini/policies/`. Codex: check `.codex/config.toml` approval mode. Copilot: check `.github/copilot/settings.local.json`. |
| Stuck after reset | Escalate model (cheap→standard→premium). Still stuck? Flag to user |
| Auth error (401/403) | GitHub App: re-mint via `provision_vcs_auth`. Bitbucket/Azure DevOps: ask user for fresh token, provision, retry. See auth-*.md |
| Token/password appears in command output | Use `credential_store_set` to store the secret, then reference it as `{{secure.NAME}}` in `execute_command` — Fleet redacts it to `[REDACTED:NAME]` before the LLM sees the output |
| Need to rotate a credential without re-provisioning | Run `credential_store_delete name=<NAME>` then `credential_store_set name=<NAME>` — the new value is picked up immediately on the next `execute_command` that references `{{secure.NAME}}` |
| Tool execution issue (unexpected behavior, missing output, silent failure) | Check `APRA_FLEET_DATA_DIR/logs/fleet-<pid>.log` for detailed execution traces. Filter by member with `jq 'select(.member_id == "<uuid>")'` or by tool with `jq 'select(.tag == "<tool>")'`. See the **Fleet Logs** section in SKILL.md for full field reference and `jq` examples. |
