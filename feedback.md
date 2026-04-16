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

# Plan Review — Install UX, Bug Fixes & Docs

- **Reviewer:** fleet-rev
- **Date:** 2026-04-16
- **Verdict:** APPROVED

---

## 1. Clear done criteria per task — PASS

Every task has a `Done:` block with verifiable bullets. The criteria are mostly behavioral and testable:

- 1.1: TOML round-trips through `smol-toml.parse`; `getProvider('nonsense')` throws; matrix test passes.
- 1.2: New test passes; manual smoke step documented.
- 1.3: Asserted Claude command contains ` -c` and no `--resume`.
- 2.1: Eight-row matrix test green; `--help` reflects defaults.
- 2.2: Busy-server error path, `--force` kill path, and restart-reminder message all covered.
- 3.1: `llms.txt` present; generator idempotent; CI commits on tag push.
- 3.2: Section added; dev-mode command verified locally.
- 3.3: Install section updated; no stray `--skill` in one-liner examples.

Minor: Task 1.1's first Done bullet ("running against a mocked home") is softer than the others — acceptable because the task is explicitly a diagnostic, and its escalation path is documented.

## 2. Cohesion / coupling — PASS

Phases are semantically cohesive (bugs → install UX → docs/CI). Cross-phase coupling is minimal and made explicit: 3.3 blocks on 2.1; 2.1 must land before 2.2 (shared arg parser). Within-phase coupling (both #96 and #139 touching `install.ts`) is called out in the risk register with an explicit sequencing mitigation. No drive-by coupling across phases.

## 3. Abstractions in earliest tasks — PASS

Task 1.1 is a diagnostic audit, not a framework. The plan explicitly reuses existing machinery (`smol-toml.stringify`, `buildResumeFlag`, `writeStatusline`, `paths.*` constants, `execute-prompt.writePromptFile` as a template for Windows TOML write). No new abstractions introduced on speculation; no "utility layer" tasks. The riskiest bug (#115) gets an audit before any refactor — the right shape.

## 4. Riskiest assumption in Task 1 — PASS

The risk register's first row names it directly: "#115 TOML bug root cause unclear from the report alone (`model = \gpt-5.3-codex` does not obviously map to any existing write path)." Task 1.1 mitigates by requiring reproduction on Windows before code changes, and the task's Blocks clause defines an escalation path if reproduction fails with mocked `fs`. This is the single biggest unknown in the sprint and it is treated as such.

## 5. DRY reuse — PASS

- 1.1 consolidates rather than duplicates: "Route `config.toml` writes through `smol-toml.stringify` consistently" — removes the parallel PowerShell `Set-Content` path.
- 1.3 keeps `buildResumeFlag` for Gemini rather than forking a Claude-specific helper.
- 2.1 extends the existing `install-multi-provider.test.ts` matrix rather than creating a new test file.
- 3.1 references existing docs rather than rewriting them.
- 3.3 cross-checks paths against `install.ts` constants before documenting — prevents drift.

No task reinvents an existing helper.

## 6. Phase structure with VERIFY checkpoints — PASS

Four checkpoints: VERIFY 1, 2, 3, FINAL. Each has concrete checkboxes with grep-able or runnable verification (e.g., "Grep confirms no remaining `--resume` emission in Claude provider code"). VERIFY FINAL re-walks the requirements acceptance criteria in order, which gives a clean audit trail. Checkpoints are positioned at phase boundaries, not mid-task.

## 7. Session completability — PASS (with one watch-item)

Tier tagging is present (`premium` / `standard` / `cheap`) and aligns with task scope. Tasks 1.2, 1.3, 2.1, 2.2, 3.1, 3.3 each fit comfortably in one session. 3.2 is a cheap doc task.

Watch-item: Task 1.1 is the largest — audit + fix + provider-error-path + tests + Windows repro — and is correctly tagged `premium`. If the Windows reproduction path has to be deferred (per the Blocks clause), the fix portion is still session-scoped. Acceptable.

## 8. Dependency order — PASS

- Bugs (Phase 1) → Install UX (Phase 2) → Docs (Phase 3) is the right order because Phase 3 documents Phase 2's new defaults.
- Within Phase 2: 2.1 before 2.2 is explicit and justified (arg-parser refactor first, force-check on top).
- 3.3 blocks on 2.1, stated at the top of the task.
- 3.1 and 3.2 have no dependencies and can run in parallel with Phase 1/2.

No circular or implicit dependencies.

## 9. Vague tasks — PASS

Tasks cite concrete file paths, line numbers (`src/services/statusline.ts:42`, `execute-prompt.ts:140-144`), function names (`writeConfig`, `mergeCodexConfig`, `deliverConfigFile`), exact commands (`taskkill /F /IM apra-fleet.exe`, `pgrep -f apra-fleet`), and exact flag values. Task 1.1's "Likely candidates" language is appropriate for a diagnostic — it names two specific hypotheses rather than hand-waving. Task 3.2's file map enumerates the directories to cover. No task reads as "investigate X and improve it."

## 10. Hidden dependencies — PASS

Verified the one potentially-missing item: the requirements § `cherry-pick 0b9c2f7` is already landed on this branch as commit `6e48ece` ("chore: make package.json description provider-agnostic"). The plan's silence on it is correct, not an omission.

Other dependencies surfaced explicitly:
- Windows host for #115 reproduction (risk register row 1, task 1.1 Blocks).
- `parseResponse`/`touchAgent` must stay intact when switching to `-c` (risk register row 3, task 1.3 step 3).
- `--skill` backwards-compat: bare `--skill` → `all` (risk register row 5, task 2.1 step 1).
- `release` job tag-gating for `llms-full.txt` regeneration (risk register row 6, task 3.1 step 4).

No constraint from requirements (merge-freeze files list, `release` job reuse) is missed.

## 11. Risk register — PASS

Seven rows, each with a specific mitigation that maps to a task or step. Risks are concrete (not "general complexity") and include:
- Reproduction unknown (#115)
- Possible already-fixed bug (#39) — mitigated by write-test-first policy
- Regression surface (#108 session capture)
- Friendly-fire in process-kill (#96) — mitigated by exact-name matching and mocked test
- Backwards-compat of `--skill` default change (#139)
- Docs drift / bloat in `llms-full.txt`
- Merge conflict between parallel install.ts features — mitigated by explicit sequencing

Each row names the mitigating task. This is a high-quality register.

## 12. Alignment with requirements intent — PASS

All eight issues in scope are addressed in order. Requirements-level constraints honored:

- "Both #96 and #139 touch `install.ts` — must be done in the same phase" → Phase 2 does exactly this.
- "#136 depends on #139 shipping first" → 3.3 blocks on 2.1.
- "All doc changes must be verified against actual code behavior" → 3.3 step 3 requires grep-verification against `install.ts` constants; 3.1 step 1 verifies doc files exist before referencing; 3.2 verifies `package.json` scripts before writing install command.
- "`llms-full.txt` CI step: the existing `release` job" → 3.1 step 4 modifies the existing `release` job, does not add a workflow.
- "Never commit CLAUDE.md, permissions.json, or progress control files" — not restated in plan; low risk since no task writes those files, but worth flagging to doers.
- Acceptance criteria in requirements map 1:1 to VERIFY FINAL checkboxes.
- Out-of-scope items (#27, #95, PR #128) not touched by any task.

Intent alignment is tight.

---

## Verdict

**APPROVED**

The plan is specific, phased, and well-risk-managed. Diagnostic-first on the riskiest issue (#115), reuse-over-refactor across the board, and VERIFY checkpoints aligned with requirements acceptance criteria. Minor watch-items (Task 1.1 depends on Windows reproduction access; "do not commit CLAUDE.md / permissions.json" constraint not restated in plan body) are low-severity and do not block kickoff.

Proceed to execution.
