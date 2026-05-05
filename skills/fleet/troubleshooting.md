# Troubleshooting

| Symptom | Action |
|---------|--------|
| Empty response | Check auth expiry → re-provision via `provision_vcs_auth` |
| Timeout (inactivity) | `timeout_s`: no stdout/stderr for N seconds (default 300s). Transport-level. Cause: buffering tools (npm test, vitest, cargo build). Fix: increase `timeout_s` (600–1200) for build/test. |
| Timeout (total) | `max_total_s`: total elapsed time cap. Provider-agnostic. Use for hard ceilings. |
| Permission denied | `compose_permissions` (native config). Claude: `.claude/settings.local.json`. Gemini: `.gemini/policies/`. Codex: `.codex/config.toml`. Copilot: `.github/copilot/settings.local.json`. |
| Stuck after reset | Escalate model (cheap→standard→premium). Still stuck? Flag user. |
| Auth error (401/403) | GH App: re-mint via `provision_vcs_auth`. BB/Az: fresh token, provision, retry. See auth-*.md. |
| Token in output | Use `credential_store_set`, reference `{{secure.NAME}}` in `execute_command`. Fleet redacts to `[REDACTED:NAME]`. |
| Rotate credential | `credential_store_delete` then `credential_store_set`. New value used immediately via `{{secure.NAME}}`. |
| Tool issue (silent fail) | Check `APRA_FLEET_DATA_DIR/logs/fleet-<pid>.log`. Filter with `jq`: `select(.member_id == "<uuid>")` or `select(.tag == "<tool>")`. See SKILL.md for logs info. |
