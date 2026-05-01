# Issue #190 — CODEX session resume and session listing

## Problem

Fleet's CODEX provider (`src/providers/codex.ts`) declares `supportsResume(): true` but is non-functional:

1. `parseResponse()` always returns `sessionId: undefined` — fleet never captures a session ID for CODEX members, so `resume=true` can never actually resume a session
2. `buildPromptCommand()` appends `resume` only if `sessionId` is truthy — but since it is always `undefined`, the resume branch never fires
3. `resumeFlag()` returns `'resume'` with no session ID — a placeholder that does nothing
4. Session listing (equivalent of Claude's `--list-sessions`) has not been researched for the codex CLI

## Goal

Research the codex CLI's session resume and listing capabilities, then implement working session resume (capturing the session ID from NDJSON output and passing it correctly on resume) and session listing (if supported).

## Research questions

1. What NDJSON event type does `codex exec --json` emit that contains the session ID?
2. What is the exact CLI flag/syntax for resuming a session (`--continue <id>`, `--session <id>`, or similar)?
3. Does the `codex` CLI support listing past sessions? If so, what command?
4. Are there codex CLI version constraints for these features?

## Acceptance Criteria

- `execute_prompt(resume=true)` on a CODEX member correctly resumes the previous session (verified by observing shared context across two calls)
- `fleet_status` shows the session ID for CODEX members after a prompt completes
- Session listing implemented or explicitly documented as unsupported with a `TODO` noting the CLI gap
- `npm run build` and `npm test` pass

## Files in scope

- `src/providers/codex.ts` — `parseResponse()`, `buildPromptCommand()`, `resumeFlag()`, `supportsResume()`
- `tests/providers/codex.test.ts` (new or existing)

## Notes

- Base branch: `main`
- Research must be done against a live CODEX member with `codex --version` and `codex exec --help`
