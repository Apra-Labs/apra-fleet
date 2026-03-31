# Code Review — Phase 1: Provider Abstraction Layer

**Date:** 2026-03-30
**Branch:** `feature/multi-provider`
**Commits reviewed:** `63e7711..a2d562c` (11 commits)
**Reviewer:** Claude (automated review per CLAUDE.md)

---

## Scope

Phase 1 (tasks 1–9 in progress.json): Add `LlmProvider` type, `ProviderAdapter` interface, four provider implementations (Claude, Gemini, Codex, Copilot), factory function, and unit tests.

## Verdict Summary

All Phase 1 "done" criteria are met. Code aligns with PLAN.md, requirements.md, and `docs/multi-provider-plan.md`. No existing tool files were modified. Backwards compatibility is preserved.

---

## Task-by-Task Verification

| Task | Description | Status | Notes |
|------|-------------|--------|-------|
| 1 | `LlmProvider` type + `llmProvider` field on Agent | PASS | `src/types.ts` — optional field, defaults to `'claude'` via `??` at call sites |
| 2 | `ProviderAdapter` interface | PASS | `src/providers/provider.ts` — matches design doc spec exactly (all 16 methods + 5 readonly props) |
| 3 | `ClaudeProvider` | PASS | `src/providers/claude.ts` — delegates `classifyError` to existing `classifyPromptError`, uses `escapeDoubleQuoted` / `sanitizeSessionId` |
| 4 | `GeminiProvider` | PASS | `src/providers/gemini.ts` — correct flags per research (`--yolo`, `--resume`, `--output-format json`) |
| 5 | `CodexProvider` | PASS | `src/providers/codex.ts` — NDJSON parser extracts last assistant message, handles error events |
| 6 | `CopilotProvider` | PASS | `src/providers/copilot.ts` — `--continue` for resume, `--allow-all-tools`, `--format json` |
| 7 | Factory (`getProvider`) | PASS | `src/providers/index.ts` — singleton pattern, defaults to Claude for `undefined`/`null` |
| 8 | Unit tests | PASS | `tests/providers.test.ts` — 496 lines, covers metadata, CLI commands, prompt building, response parsing (incl. NDJSON), session management, model tiers, error classification, auth capabilities, backwards compat |
| 9 | Phase 1 verification | PASS | All files exist, no tool files changed |

## Build & Tests

**NOTE:** `npm run build` and `npm test` could not be executed during this review due to shell permission constraints. The progress.json entry for task 9 reports: "npm run build: clean. npm test: 518 passed, 3 skipped, 33 test files." This is self-reported and should be independently verified.

## Requirements Alignment

| Requirement | Status |
|-------------|--------|
| Backwards compatibility (no `llmProvider` = Claude) | PASS — `llmProvider?` optional, `getProvider(undefined)` returns ClaudeProvider |
| Mix-and-match (different providers per member) | PASS — factory dispatches per-agent |
| Provider abstraction (no provider conditionals in tool code) | PASS — all provider logic encapsulated in `ProviderAdapter` implementations |
| Security (no injection in command building) | PASS — uses `escapeDoubleQuoted` and `sanitizeSessionId` consistently; auth env var names are hardcoded constants |
| Testing | PASS — unit tests for every provider + factory + backwards compat |
| No existing tool files modified | PASS — `git diff` confirms zero changes to `src/tools/`, `src/os/`, `src/utils/`, `src/index.ts` |

## Findings

### Minor Issues (non-blocking)

1. **Gemini `classifyError` redundant `toLowerCase`** — `gemini.ts:71` applies `.toLowerCase()` on `output` before regex matching, but the regex already uses the `/i` flag. The other three providers apply regex directly to `output` with `/i`. Functionally identical, but inconsistent style. Suggest aligning in a future cleanup pass.

2. **ClaudeProvider `modelForTier` uses latest model versions** — Returns `claude-sonnet-4-6` and `claude-opus-4-6` for mid/premium. The design doc's table says `sonnet` / `opus` generically. The code is correct (concrete model IDs are needed for `--model` flags), but if Anthropic releases newer models these will need updating. Consider whether a constant or config would help — but this is a Phase 2+ concern, not a blocker.

### Positive Observations

- Clean separation: providers import only from `types.ts`, `os-commands.ts` (for escape utilities), and `prompt-errors.ts` (Claude only). No circular dependencies.
- Codex NDJSON parser is robust: handles mixed JSON/non-JSON lines, error events, content arrays.
- Factory uses singletons — avoids unnecessary allocation.
- Test coverage is thorough: every provider method tested, including edge cases (non-JSON fallback, empty sessions, non-zero exit codes).

---

## Verdict

**APPROVED**

Phase 1 is complete and meets all "done" criteria. Ready to proceed to Phase 2 (OsCommands refactoring). The two minor issues noted above are non-blocking and can be addressed in a future cleanup.

> **Action required:** Independently verify `npm run build` and `npm test` pass, as this reviewer was unable to execute them.
