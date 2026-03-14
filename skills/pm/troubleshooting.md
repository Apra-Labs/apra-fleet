# Troubleshooting

| Symptom | Action |
|---------|--------|
| Empty response | Check auth token expiry → re-provision via `provision_vcs_auth` |
| Timeout | Increase to 300s (build/test) or 600s (multi-step execution) |
| Blew past checkpoint | Check `progress.json` via `execute_command`, dispatch review immediately |
| Permission denied | Evaluate and grant in `.claude/settings.local.json` via `send_files` |
| Stuck after reset | Escalate model (haiku→sonnet→opus). Still stuck? Flag to user |
| Auth error (401/403) | GitHub App: re-mint via `provision_vcs_auth`. Bitbucket/Azure DevOps: ask user for fresh token, provision, retry. See auth-*.md |
