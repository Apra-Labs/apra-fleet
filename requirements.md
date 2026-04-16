# Requirements — Install UX, Bug Fixes & Docs

## Base Branch
`main` — branch to fork from and merge back to

## Sprint Branch
`feat/install-ux-and-docs`

## Goal
Fix a cluster of bugs (Codex TOML quoting, silent provider fallback, session resume, statusline ghost), tighten the install UX (--force flag, --skill default), and fill the documentation gaps (CONTRIBUTING agent section, install explainer, llms.txt/llms-full.txt).

## Scope

### Phase 1 — Bug Fixes (Issues #115, #108, #39)

#### #115 — Codex config.toml TOML quoting + silent provider fallback
Root cause reported by kumaakh (comment: https://github.com/Apra-Labs/apra-fleet/issues/115#issuecomment-4247693714):

1. **TOML quoting bug**: When apra-fleet installs Codex CLI it writes `config.toml` with backslash-escaped values instead of proper double-quoted TOML strings:
   - **Broken**: `model = \gpt-5.3-codex` / `provider = \openai`
   - **Expected**: `model = "gpt-5.3-codex"` / `provider = "openai"`
   - Audit the `config.toml` generation/write logic and fix values to be emitted as `"value"` (TOML string literals).

2. **Silent provider fallback**: When provider config parsing fails (e.g. malformed TOML from bug #1), the fleet server silently falls back to Claude without notifying the PM. The PM ran a reviewer on Claude without knowing — only caught by observing unexpected behaviour.
   - Fix: when provider config parsing fails, surface a clear error and halt. Do NOT silently switch providers.

#### #108 — Use `claude -c` instead of `claude -r <session-id>` for session resume
Fleet currently uses `-r <session-id>` for resume, requiring session IDs to be stored and threaded through resume logic. Switch to `claude -c` (resume most-recent session) since fleet always resumes the most recent session for a given member anyway.
- Session IDs should still be captured and stored after each run for debugging/observability — they just stop being the resume mechanism.
- Verify `claude -c` with no prior session starts a fresh session (same as today's behaviour).
- Locate all uses of `-r <session-id>` in `execute_prompt` / session management code and replace.

#### #39 — Verify statusline icon clears after remove_member
Original report: after de-registering a member, the status icon under Claude input persists.
- This was believed fixed in a prior release. Write a test or smoke-test step that verifies: register a member → confirm icon appears → remove_member → confirm icon clears.
- If the fix is confirmed working, close the issue. If not, diagnose and fix.

---

### Phase 2 — Install Improvements (Issues #96, #139)

Both touch `install.ts` — do in the same phase to avoid merge conflicts.

#### #96 — `--force` flag + busy/running prompt
On Windows the binary is locked while running as an MCP server. Fix:

1. **`--force` flag**: `apra-fleet install --force` kills the running server before replacing the binary:
   - Windows: `taskkill /F /IM apra-fleet.exe`
   - macOS/Linux: `pkill -f apra-fleet`
   - After kill: replaces binary, prints "Restart Claude Code to reload the MCP server."

2. **Busy prompt** (no `--force`): when installer detects a running process and `--force` was not passed:
   ```
   Error: apra-fleet is currently running (MCP server process detected).
   Stop it first, or re-run with --force to kill it automatically:

     apra-fleet install --force

   On Windows you can also run: taskkill /F /IM apra-fleet.exe
   ```
   Exit with non-zero code.

Acceptance criteria from issue #96:
- `apra-fleet install` on a running server shows the prompt with `--force` hint
- `apra-fleet install --force` kills the running server and completes install
- Works on Windows (taskkill) and macOS/Linux (pkill)
- Post-install message reminds user to restart Claude Code / run `/mcp`

#### #139 — Make `--skill all` the default; add named skill set options
Current: bare `install` = no skills. Every example needs `--skill`. Multiple users confused.

Proposed:

| Command | Installs |
|---------|----------|
| `apra-fleet install` | MCP server + fleet skill + PM skill (default = `all`) |
| `apra-fleet install --skill all` | Same as above |
| `apra-fleet install --skill pm` | MCP server + fleet skill + PM skill |
| `apra-fleet install --skill fleet` | MCP server + fleet skill only |
| `apra-fleet install --skill none` | MCP server only, no skills |
| `apra-fleet install --no-skill` | Same as `--skill none` |

- PM depends on fleet — installing `pm` always includes `fleet`
- Old bare `--skill` (no value) treated as `--skill all` for backwards compat
- `--help` reflects new defaults and options
- Docs updated: README, docs/user-guide.md, docs/FAQ.md, skills/pm/deploy.md — drop `--skill` from examples

---

### Phase 3 — Documentation & CI (Issues #140, #136, #134)

#### #140 — CONTRIBUTING.md: add "For AI agents" section
Add a new **"For AI agents"** section to CONTRIBUTING.md covering:
- Dev-mode install: `npm run build && node dist/index.js install` to test changes locally
- Which files are safe to edit freely vs. which need care:
  - `src/` — TypeScript source, always rebuild after changes
  - `skills/` — skill markdown files, no build needed, picked up at runtime
  - `CLAUDE.md` — agent context for Claude Code contributors
  - `hooks/` — shell hooks, test manually
- How to test skill changes: edit `skills/fleet/` or `skills/pm/`, run `/mcp` to reload, verify in conversation
- Sprint branches follow `sprint/<description>` or `feat/<description>` naming
- PM skill and fleet skill are the orchestration layer — changes there affect all active sprints

**Important**: Verify dev-mode install command against actual package.json scripts before writing.

#### #136 — User guide: add install `--skill` explainer section (blocked on #139)
Add a short, visible section near the top of the install flow in `docs/user-guide.md` explaining:
- What files get written and where (`~/.apra-fleet/bin/`, `~/.claude/skills/pm/`, hooks, statusline config)
- What install does NOT do (no system-level changes, no network calls, no background services)
- How to uninstall / what to delete if you want to remove it

**Must be verified against actual installer behavior before writing** — no documenting from assumption. Read the installer source first.

This section must reflect the new `--skill` defaults from #139.

#### #134 — llms.txt + CI-generated llms-full.txt
Following the [llms.txt spec](https://llmstxt.org/):

**llms.txt** (human-maintained, repo root):
```markdown
# Apra Fleet

> MCP server for orchestrating multiple agentic AI instances (called "members") across machines via SSH.

Body paragraphs explaining the project.

## Docs

- [User Guide](docs/user-guide.md): Installation, member registration, multi-provider setup
- [Vocabulary](docs/vocabulary.md): Fleet-specific terminology reference
- [Provider Matrix](docs/provider-matrix.md): LLM provider capability comparison
- [FAQ](docs/FAQ.md): Common questions and answers
- [Architecture](docs/architecture.md): Internal architecture and how fleet works
```

**llms-full.txt** (CI-generated on every release, XML-wrapped structure):
```xml
<project title="Apra Fleet" summary="MCP server for orchestrating multiple agentic AI instances...">

<docs>
<doc title="User Guide" desc="Installation, member registration, multi-provider setup">
[content of docs/user-guide.md]
</doc>
...
</docs>

</project>
```

Deliverables:
- `llms.txt` added to repo root (doer writes a reasonable first version matching existing docs)
- CI `release` job updated to generate `llms-full.txt` using the XML-wrapped structure and commit it to the repo root after each release
- `llms-full.txt` committed to repo root after CI runs (readable without a build step)
- Docs referenced in llms.txt: user-guide, vocabulary, provider-matrix, FAQ, architecture — verify these files exist; document only what exists

---

## Out of Scope
- #27 (broader Codex multi-provider support) — #115 fixes only the TOML quoting and fallback; full Codex testing is separate
- #95 (MCP entry already exists error on reinstall) — different root cause from #96
- PR #128 / feat/oob-improvements — stashed, separate work stream, do not touch

## Constraints
- Both #96 and #139 touch `install.ts` — must be done in the same phase to avoid conflicts
- #136 depends on #139 shipping first — write the explainer section only after the `--skill` default change is implemented
- All doc changes must be verified against actual code behavior — no speculative documentation
- `llms-full.txt` CI step: the existing `release` job in `.github/workflows/ci.yml` is the target; add a step, do not create a new workflow
- Never commit CLAUDE.md, permissions.json, or progress control files

## Acceptance Criteria
- [ ] Codex `config.toml` written with proper TOML double-quoted strings
- [ ] Fleet server errors (does not silently fallback) when provider config cannot be parsed
- [ ] `claude -c` used for session resume; session IDs still captured and stored
- [ ] Statusline icon confirmed cleared after `remove_member` (test or smoke-test evidence)
- [ ] `apra-fleet install` (no flags) installs MCP + fleet skill + PM skill
- [ ] `apra-fleet install --skill fleet/pm/all/none` all work correctly
- [ ] `apra-fleet install --no-skill` installs MCP only
- [ ] Old bare `--skill` (no value) treated as `--skill all` for backwards compat
- [ ] `apra-fleet install` on running server shows `--force` prompt
- [ ] `apra-fleet install --force` kills server and completes install (Windows + macOS/Linux)
- [ ] CONTRIBUTING.md has "For AI agents" section with verified dev-mode install command
- [ ] user-guide.md has install explainer section reflecting new `--skill` defaults
- [ ] `llms.txt` added to repo root, follows spec format
- [ ] CI release job generates and commits `llms-full.txt` in XML-wrapped format
- [ ] All new code has unit tests; all existing tests pass; CI green
