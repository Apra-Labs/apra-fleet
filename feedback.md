# PR Review Fix Verification — 2026-04-24

**Branch:** `sprint/session-lifecycle-oob-fix`
**Commits reviewed:** `64b6f66..e6d7982` (6 commits)
**Reviewer:** Claude (automated review)

---

## Verdict: APPROVED

All 6 fixes are correct and complete. Build compiles clean (`tsc` — zero errors). All 940 tests pass (6 skipped). One minor nit on stale comments in integration tests — not blocking.

---

## Fix-by-Fix Assessment

### Fix 1 — `stop_agent` → `stop_prompt` rename (commit 64b6f66): PASS

- `src/tools/stop-agent.ts` renamed to `src/tools/stop-prompt.ts`; schema/type/function renamed to `stopPromptSchema`/`StopPromptInput`/`stopPrompt`
- `src/index.ts:194`: MCP tool name is now `'stop_prompt'`, references `stopPromptSchema` and `stopPrompt`
- `src/utils/agent-helpers.ts:90,98`: comments updated to reference `stop_prompt`
- `tests/stop-agent.test.ts` renamed to `tests/stop-prompt.test.ts`
- `grep -r "stop_agent" src/` returns zero matches
- `docs/api/stop-agent.md` removed, `docs/api/stop-prompt.md` created
- `docs/features/session-lifecycle.md` updated — all references now say `stop_prompt`
- **Nit (non-blocking):** `tests/integration/session-lifecycle.test.ts` lines 82, 101, 121, 141 still have `stop_agent` in *comments* (not code). The actual function calls use `stopPrompt`. This is cosmetic and doesn't affect behavior.

### Fix 2 — DRY: extract duplicate headless fallback (commit 3940788): PASS

- New helper `buildHeadlessFallback(memberName, reason)` at `src/services/auth-socket.ts:358-360`
- All three headless branches (Windows :417, Linux :421, macOS :425) now call the helper with platform-specific reason strings
- The old inline fallback strings (with duplicated `\n\nRun this in a separate terminal:...` boilerplate) are gone
- The catch-all fallback at line ~490 (spawn failure) remains separate, which is correct — it has different structure (`Could not open a terminal window` + error message)

### Fix 3 — macOS SSH gap (commit 9eba874): PASS

- New function `isSSHSession()` at `src/services/auth-socket.ts:374-376`: checks `process.env.SSH_TTY`
- `launchAuthTerminal` line 424: `if (platform === 'darwin' && isSSHSession())` — returns headless fallback before attempting AppleScript/Terminal.app
- Placed correctly before the unconditional `platform === 'darwin'` block at line 428
- JSDoc correctly notes SSH_TTY is set by the SSH daemon on both Linux and macOS

### Fix 4 — `stop_prompt` in SKILL.md tools table (commit 9a2ac33): PASS

- `skills/fleet/SKILL.md:37`: `| stop_prompt | Stop the active execute_prompt session on a member — kills the LLM process and sets a stopped flag to prevent re-dispatch |`
- Description is accurate — matches actual behavior in `stop-prompt.ts`

### Fix 5 — `timeout_ms` vs `max_total_ms` guidance in SKILL.md (commit be83193): PASS

- New section `## execute_prompt Timeout Parameters` at `skills/fleet/SKILL.md:111-124`
- Clear table distinguishing inactivity timeout (resets on output) vs hard ceiling (never resets)
- Practical guidance on when to use which
- Notes that both run concurrently
- Placed in the right location — after dispatch rules, before model tiers

### Fix 6 — Stale .md references updated (commit e6d7982): PASS

- `docs/api/execute-prompt.md:72`: now references `stop_prompt` (was `stop_agent`)
- `docs/api/stop-agent.md` replaced by `docs/api/stop-prompt.md` — all internal references updated
- `docs/features/session-lifecycle.md`: all references updated to `stop_prompt`
- `grep -r "stop_agent" docs/` returns zero matches
- `grep -r "stop_agent" skills/` returns zero matches
- `docs/api/execute-prompt.md` already had correct `timeout_ms`/`max_total_ms` docs from prior sprint work

---

## Build & Test

- `npm run build` (`tsc`): **clean** — zero errors
- `npm test` (`vitest run`): **57 test files, 940 passed, 6 skipped, 0 failed** (19.8s)

---

## Phases 1–6 Regression Check

No regressions detected. The 6 fix commits are purely additive (rename, extract helper, add SSH check, update docs) with no changes to core session lifecycle logic, timeout implementation, PID tracking, or OOB auth flow.
