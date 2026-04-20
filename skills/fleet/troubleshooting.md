# Troubleshooting

| Symptom | Action |
|---------|--------|
| Empty response | Check auth token expiry → re-provision via `provision_vcs_auth` |
| Timeout | Increase to 300s (build/test) or 600s (multi-step execution) |
| Permission denied | Run `compose_permissions` for the member — it produces provider-native config. Claude: check `.claude/settings.local.json`. Gemini: check `.gemini/policies/`. Codex: check `.codex/config.toml` approval mode. Copilot: check `.github/copilot/settings.local.json`. |
| Stuck after reset | Escalate model (cheap→standard→premium). Still stuck? Flag to user |
| Auth error (401/403) | GitHub App: re-mint via `provision_vcs_auth`. Bitbucket/Azure DevOps: ask user for fresh token, provision, retry. See auth-*.md |
| Token/password appears in command output | Use `credential_store_set` to store the secret, then reference it as `{{secure.NAME}}` in `execute_command` — Fleet redacts it to `[REDACTED:NAME]` before the LLM sees the output |
| Need to rotate a credential without re-provisioning | Run `credential_store_delete name=<NAME>` then `credential_store_set name=<NAME>` — the new value is picked up immediately on the next `execute_command` that references `{{secure.NAME}}` |
