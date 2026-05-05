# Uninstall Command (#245) — Plan Review

**Reviewer:** claude-opus (plan reviewer)
**Date:** 2026-05-05 12:20:00+05:30
**Verdict:** CHANGES NEEDED

> See the recent git history of this file to understand the context of this review.

---

## 1. Plan Structure and Phasing

The plan has a clean three-phase structure (Foundation, Core Logic, Testing) with verify gates. Task dependencies are correctly ordered: T1 (shared config) -> T2 (scaffold) -> T3 (settings cleanup) -> T4 (directory removal) -> T5 (tests). PASS.

Progress.json matches PLAN.md tasks 1:1. All tasks are `pending`, which is correct for a plan review. PASS.

---

## 2. Command Variants Coverage

Requirements specify six command variants:

| Variant | Plan coverage |
|---------|--------------|
| `uninstall` (full) | T2 reads install-config, T3+T4 remove settings+dirs |
| `uninstall --llm gemini` | T2 accepts `--llm` flag |
| `uninstall --llm claude` | T2 accepts `--llm` flag |
| `uninstall --llm gemini --skill pm` | T2 accepts `--skill` flag |
| `uninstall --llm gemini --skill fleet` | T2 accepts `--skill` flag |
| `uninstall --skill pm` (all providers) | **GAP — see Finding F1** |

FAIL — see F1 below.

---

## 3. install-config.json as Source of Truth

**Finding F1 (blocking):** The current `install-config.json` written by install.ts (line 604) stores a single object `{ llm, skill }`. Each `apra-fleet install --llm <provider>` overwrites this file — it does not accumulate. If a user runs:

```
apra-fleet install --llm claude
apra-fleet install --llm gemini
```

Only `{ "llm": "gemini", "skill": "all" }` survives. Then `apra-fleet uninstall` (no flags) would only uninstall Gemini, leaving Claude's registrations orphaned.

The plan must address this. Two options:

**Option A (recommended):** Extend install-config.json to an array or keyed-by-provider structure, e.g. `{ "providers": { "claude": { "skill": "all" }, "gemini": { "skill": "all" } } }`. Update install.ts to merge rather than overwrite. This also naturally supports `apra-fleet uninstall --skill pm` (all providers) — iterate over all recorded providers.

**Option B (minimal):** Accept the single-provider limitation but document it. Uninstall with no flags removes whatever is recorded. `--skill pm` without `--llm` falls back to scanning known paths. This is weaker but could ship faster.

Either way, the plan needs an explicit task or note addressing the install-config schema. T1 ("Refactor Shared Config") is the natural place.

**Doer:** fixed — T1 and T2 in PLAN.md updated to use a keyed-by-provider map schema `{ "providers": { "claude": {...}, "gemini": {...} } }`. install.ts merges on each install. T2 documents that `uninstall --skill pm` (no --llm) iterates all recorded providers. Commit: _to be filled after push_.

---

## 4. Claude MCP Unregistration

**Finding F2 (blocking):** Install registers Claude's MCP server via `claude mcp add --scope user` (CLI command), not by editing `~/.claude/settings.json` directly. But T3 only mentions "Revert changes in provider settings files." For Claude, uninstall must call `claude mcp remove apra-fleet --scope user`, not edit the settings file. The plan should explicitly note this provider-specific path in T3 or as a separate sub-task.

**Doer:** fixed — T3 in PLAN.md now explicitly specifies that Claude MCP unregistration uses `claude mcp remove apra-fleet --scope user` (not direct file editing), and notes Windows requires `shell: 'cmd.exe'`. Commit: _to be filled after push_.

---

## 5. Surgical Settings Edit Strategy

T3 says "Ensure we don't clobber user settings." This aligns with requirements. The existing `readConfig`/`writeConfig` pattern in install.ts supports surgical edits. T1 extracts these into shared config.ts, making them available to uninstall. PASS.

However, the plan should be more specific about what "revert" means for each key:
- `mcpServers.apra-fleet` — delete key (Gemini, Codex, Copilot)
- `permissions.allow` — filter out fleet-specific entries, preserve user-added ones
- `hooks.PostToolUse` — filter out hooks with fleet matchers, preserve user hooks
- `defaultModel` — delete key (or leave it? user may have changed it)
- `statusLine` — delete key

NOTE — `defaultModel` is a tricky case. If the user manually changed it after install, deleting it would lose their preference. The plan should specify the strategy (e.g., only remove if it matches the fleet-installed value).

---

## 6. Fallback Scan

T4 mentions "Missing install-config falls back to scanning." This aligns with requirements ("warns and offers best-effort scan"). PASS, but the plan should note which paths get scanned (the four providers' known config dirs from `getProviderInstallConfig`).

---

## 7. --dry-run and --yes Flags

T2 mentions both flags. T3 and T4 both say "--dry-run logs correctly." Requirements say "Confirm prompt before destructive action unless --yes flag is passed."

NOTE — The plan doesn't explicitly mention implementing the confirmation prompt. T2's done criteria say "Command safely executes dry-run logging" but don't mention the interactive confirm. This should be called out in T3 or T4 as a done criterion.

---

## 8. Windows and macOS Path Handling

Not explicitly mentioned in the plan. The existing `getProviderInstallConfig` uses `path.join` (cross-platform), and install.ts has `process.platform === 'win32'` guards. Since T1 extracts these shared utilities, the plan implicitly covers this — but T3 should note that Claude unregistration on Windows needs `shell: 'cmd.exe'` (matching install.ts line 321).

NOTE — worth a one-liner in T3.

---

## 9. Risk Register

**Finding F3 (blocking):** The task checklist explicitly asks for a risk register. PLAN.md has none. Common risks for an uninstall command:

- Deleting wrong directories if install-config is corrupted
- Partial uninstall leaving broken state (e.g., permissions referencing deleted skills)
- Race condition if server is running during uninstall
- Uninstall removing user-customized settings (defaultModel, hooks)
- Codex TOML format edge cases

Add a risk register section to PLAN.md.

**Doer:** fixed — Risk Register section added to PLAN.md covering R1 (missing/corrupt install-config, fallback scan), R2 (partial installs, per-provider tracking), R3 (race with running server, abort with guidance), R4 (Windows vs macOS paths, cmd.exe spawn), R5 (user-edited settings, post-uninstall warning). Commit: _to be filled after push_.

---

## 10. Build and Tests

Build: `tsc` passes cleanly. PASS.
Tests: 65 files, 1072 passed, 6 skipped, 0 failed. PASS.

The commits from #243 and #244 (`11c7d77`, `27ee40c`) are unrelated to #245 but don't cause issues — they were merged into main before this branch was cut, or were in-flight. The #245-specific commit is `4f64d76` which only adds PLAN.md and progress.json.

---

## Summary

Three blocking findings prevent approval:

1. **F1 — install-config schema:** Single-provider overwrite means `apra-fleet uninstall` can't reliably reverse multi-provider installs. Plan must address the schema (extend or document limitation) and handle `--skill <name>` without `--llm` across all providers.

2. **F2 — Claude MCP unregistration:** Must use `claude mcp remove`, not settings file editing. Plan should note this explicitly in T3.

3. **F3 — Missing risk register:** Required by review checklist. Add to PLAN.md.

Two non-blocking notes for the doer to consider:

- **defaultModel removal strategy** — specify whether to unconditionally delete or only if it matches the fleet-installed value.
- **Confirmation prompt** — ensure `--yes` bypass and interactive confirm are explicit done criteria.
