# Backlog

1. ~~Auto-Push in Verify Tasks~~ — Done. tpl-claude.md verify checkpoint now includes `git push origin <branch>`.
2. **Fleet Status in CLI Statusline** (Low, mostly done) — Statusline + freshness indicators working. Remaining: sort by urgency (busy/blocked first).
3. **execute_prompt max-turns Awareness** (Medium) — Hardcoded `--max-turns 50`. Make configurable per call, or return a signal when limit is reached.
4. **Apra Labs Branding** (Medium) — package.json fields, README header/logo, startup banner, GitHub repo metadata, GitHub Pages site.
5. **Installer: Symlink Skills Instead of Copy** (Medium) — `install.cjs` copies `skills/pm/` to `~/.claude/skills/pm/`. A symlink would pick up updates after `git pull` without re-running the installer.
6. **Git Auth TTL Cleanup** (Low) — Auto-remove credential helper file after token expiry (tokens expire in 1hr anyway).
7. **send_files Flat Placement** (Low) — Basename-only placement silently overwrites on collision. Preserve relative paths or warn.
8. **reset_session Running Work Check** (Low) — No BUSY check before reset. Running process keeps going, next prompt may conflict.
9. **Member Decommissioning Protocol** (Low) — `remove_member` does best-effort cleanup but doesn't remove SSH keys from authorized_keys or delete remote working folders. Full flow: verify idle → revoke VCS → remove SSH key → clean folder → remove from registry.
10. **Shell Strategy Variants** (Low) — Support `windows-cmdExe` and `windows-gitbash` shell types. Currently assumes PowerShell for all Windows SSH.
11. **Read Remote File Tool** (Low) — New tool: `read_remote_file` to fetch files (especially binaries) from a member's work folder. Text files can use `execute_command` + `cat`.
12. **SEA Binary Icon Branding** (Medium) — Replace Node.js icon on SEA binary with Apra Labs icon. Use `rcedit` (Windows) or `.icns` (macOS) during `scripts/package-sea.mjs`. Source assets at `C:\akhil\NewVenture\website\Logo\`. Need multi-size .ico (256/128/64/48/32/16) generated from source PNG.
13. ~~White-Label Mode~~ — Moved to PM skill backlog #16. Attribution is controlled by Claude Code settings and PM skill templates, not the MCP server.
14. **Inter-Session Attention Mechanism** (High) — No alerting between sessions for blocked/verify members. Options: needs-attention file, Slack DM, desktop toast, dashboard widget. May overlap with fleet statusline (#2).
15. **GitHub App Token Limitations** (High, Research) — GitHub App installation tokens minted via `provision_vcs_auth` have restricted permissions that cause friction: (a) Cannot push workflow files (`.github/workflows/*.yml`) — GitHub requires `workflows` permission which needs explicit App-level opt-in and is not available on fine-grained tokens by default. (b) Cannot call certain `gh` CLI APIs — the token is scoped to `contents`, `pull_requests`, etc. but `gh` commands like `gh pr merge` or `gh api` may need additional scopes not granted. (c) Workaround today: PM creates PRs and merges from the controller (which has full `gh` auth), or user manually pushes CI files. Research: can the GitHub App be configured with `workflows` permission? Does `gh` CLI work with installation tokens at all, or does it require OAuth/PAT? Should we mint tokens with broader scopes, or keep them narrow and route CI/gh operations through the PM?
16. ~~Installer: Pre-approve Fleet Tools~~ — Done. Installer adds `mcp__apra-fleet__*`, `Agent(*)`, `Read(~/.claude/skills/pm/**)` to allow list.
17. ~~SSH Server Setup Guide~~ — Done. `docs/ssh-setup.md` covers Windows (OpenSSH Server install, firewall, admin authorized_keys gotcha), macOS, Linux, Jetson, and troubleshooting table.
