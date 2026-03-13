# Backlog

1. **Auto-Push in Verify Tasks** (High) — Every VERIFY checkpoint task should include `git push origin <branch>` so code is on origin before the reviewer is triggered.
2. **Fleet Status in CLI Statusline** (High) — Server writes pre-rendered `~/.apra-fleet/statusline.txt` after every tool call. Needs-attention members first, then by last activity. Format: `🟢 bob:⏸ verify  🔵 alice:⚡ auth-module`. Statusline shell script reads the file and appends freshness from mtime: <5m ✅, <1h ⚠️, >1h 🚨.
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
