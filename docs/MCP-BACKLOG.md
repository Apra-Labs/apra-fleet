# Backlog

1. ~~Auto-Push in Verify Tasks~~ — Done. tpl-claude.md verify checkpoint now includes `git push origin <branch>`.
2. **Fleet Status in CLI Statusline** (Low, mostly done) — Statusline + freshness indicators working. Remaining: sort by urgency (busy/blocked first).
3. ~~execute_prompt max-turns Awareness~~ — Done. `max_turns` param added (default 50, min 1, max 500). Tests in platform.test.ts.
4. ~~Apra Labs Branding~~ — Done. package.json author/homepage/repository/bugs, GitHub repo description + topics.
5. ~~Installer: Symlink Skills Instead of Copy~~ — Won't do. SEA binary embeds skills — no source dir to symlink. Re-install on update is acceptable.
6. **Git Auth TTL Cleanup** (Low) — Auto-remove credential helper file after token expiry (tokens expire in 1hr anyway).
7. **send_files Flat Placement** (Low) — Basename-only placement silently overwrites on collision. Preserve relative paths or warn.
8. **reset_session Running Work Check** (Low) — No BUSY check before reset. Running process keeps going, next prompt may conflict.
9. **Member Decommissioning Protocol** (Low) — `remove_member` does best-effort cleanup but doesn't remove SSH keys from authorized_keys or delete remote working folders. Full flow: verify idle → revoke VCS → remove SSH key → clean folder → remove from registry.
10. **Shell Strategy Variants** (Low) — Support `windows-cmdExe` and `windows-gitbash` shell types. Currently assumes PowerShell for all Windows SSH.
11. **Read Remote File Tool** (Low) — New tool: `read_remote_file` to fetch files (especially binaries) from a member's work folder. Text files can use `execute_command` + `cat`.
12. ~~SEA Binary Icon Branding~~ — Done. `assets/icons/apra-fleet.ico` generated via `scripts/gen-ico.mjs`. `package-sea.mjs` injects icon via rcedit before postject (Windows). CI installs rcedit on Windows build.
13. ~~White-Label Mode~~ — Moved to PM skill backlog #16. Attribution is controlled by Claude Code settings and PM skill templates, not the MCP server.
14. **Inter-Session Attention Mechanism** (High) — No alerting between sessions for blocked/verify members. Options: needs-attention file, Slack DM, desktop toast, dashboard widget. May overlap with fleet statusline (#2).
15. **GitHub App Token Limitations** (High, Research) — GitHub App installation tokens minted via `provision_vcs_auth` have restricted permissions that cause friction: (a) Cannot push workflow files (`.github/workflows/*.yml`) — GitHub requires `workflows` permission which needs explicit App-level opt-in and is not available on fine-grained tokens by default. (b) Cannot call certain `gh` CLI APIs — the token is scoped to `contents`, `pull_requests`, etc. but `gh` commands like `gh pr merge` or `gh api` may need additional scopes not granted. (c) Workaround today: PM creates PRs and merges from the controller (which has full `gh` auth), or user manually pushes CI files. Research: can the GitHub App be configured with `workflows` permission? Does `gh` CLI work with installation tokens at all, or does it require OAuth/PAT? Should we mint tokens with broader scopes, or keep them narrow and route CI/gh operations through the PM?
16. ~~Installer: Pre-approve Fleet Tools~~ — Done. Installer adds `mcp__apra-fleet__*`, `Agent(*)`, `Read(~/.claude/skills/pm/**)` to allow list.
17. ~~SSH Server Setup Guide~~ — Done. `docs/ssh-setup.md` covers Windows (OpenSSH Server install, firewall, admin authorized_keys gotcha), macOS, Linux, Jetson, and troubleshooting table.
18. **Slack Notifications for Fleet Events** (Future) — Standalone watcher reads `statusline-state.json` periodically, POSTs to Slack webhook on state changes (verify, blocked, offline). Subsumes #14. Design documented in conversation.
