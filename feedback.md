# PR #101 Review: feat: first-run onboarding experience and user engagement nudges

**Reviewer:** Claude Code (automated review)
**Date:** 2026-04-18
**Verdict:** APPROVED (with one non-blocking note)

## Summary

This PR adds a first-run onboarding experience (ASCII banner + getting started guide), contextual nudges (post-registration, post-first-prompt, multi-member milestone), and a welcome-back preamble on subsequent server starts. The implementation uses a well-thought-out three-channel defense-in-depth delivery strategy to ensure onboarding text reaches the user verbatim despite the LLM intermediary.

## What was reviewed

- `src/onboarding/text.ts` — all user-facing text constants
- `src/services/onboarding.ts` — state management (load, save, milestones, session flags)
- `src/index.ts` — `wrapTool`, `sanitizeToolResult`, `sendOnboardingNotification`, McpServer construction
- `src/tools/register-member.ts` — input validation (angle bracket regex)
- `src/tools/update-member.ts` — input validation (angle bracket regex)
- `src/types.ts` — `OnboardingState` interface
- `src/cli/install.ts` — data directory comment
- `docs/adr-onboarding-ux-delivery.md` — architecture decision record
- `tests/onboarding.test.ts` — 57 tests covering state, milestones, nudges, sanitization, integration
- `tests/onboarding-text.test.ts` — 21 tests for text constants
- `tests/onboarding-smoke.mjs` — end-to-end smoke test
- `.gitignore` — CLAUDE.md addition

## Findings

### Architecture & Design — Excellent

- Three-channel delivery (notifications, markers+instructions, audience annotations) is well-reasoned. The ADR documents the failure modes, token costs, and tradeoffs clearly.
- Sanitization defense (both output-boundary `sanitizeToolResult` and input-boundary Zod regex) is defense-in-depth done right. The ADR honestly documents the `update_member` gap and notes it was closed in this PR.
- The `wrapTool` abstraction replaces 21 inline wrappers with a single function — cleaner and easier to maintain.
- Passive-tool guard (`version`, `shutdown_server`) prevents silent consumption of the banner by auto-called tools.
- First-run banner bypasses JSON check while welcome-back/nudges respect it — correct design for different urgency levels.

### Code Quality — Clean

- State management is well-structured: in-memory singleton loaded once, atomic file writes, forward-compatible merge with defaults, corruption recovery.
- `_resetForTest()` is a clean test-only escape hatch.
- Token cost analysis in the text.ts header is thorough and reproducible.
- The sanitizer regex handles case variants, attributes, unterminated tags, and multiple occurrences.

### Testing — Thorough

- 722 tests pass, zero failures (4 skipped, pre-existing).
- Build compiles cleanly with no TypeScript errors.
- Tests cover: fresh install, upgrade path, corruption recovery, milestone progression, idempotency, passive-tool guard, JSON bypass, full session sequence, notification emission, sanitization edge cases, schema validation.
- Smoke test provides an additional end-to-end verification layer.

### Non-blocking note

- `.gitignore` adds `CLAUDE.md`. Since CLAUDE.md is already tracked by git, this has no immediate effect — git only ignores untracked files. However, if someone ever removes CLAUDE.md from tracking, this gitignore entry would prevent re-adding it. This looks like a development artifact. Low risk, can be cleaned up in a follow-up.

## Verdict

**APPROVED.** The implementation is well-designed, thoroughly tested, security-conscious, and clean. The three-channel delivery strategy with injection defense is a thoughtful solution to the real problem of delivering verbatim content through an LLM intermediary.
