# Uninstall Command (#245) — Plan Re-Review

**Reviewer:** claude-opus (plan reviewer)
**Date:** 2026-05-05 12:35:00+05:30
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.

---

## Prior Findings Resolution

Three blocking findings were raised in the initial review (commit 5c63998). The doer addressed all three in commits d03b5f0 and 7bcea64.

### F1 — install-config.json schema (was: BLOCKING → RESOLVED)

**Original issue:** install-config.json stored a single `{ llm, skill }` object. Successive installs with different providers would overwrite rather than accumulate, meaning `apra-fleet uninstall` could not reliably reverse multi-provider installs. Additionally, `uninstall --skill pm` (no --llm) had no way to iterate across providers.

**Doer:** fixed in commit d03b5f0 — T1 and T2 in PLAN.md updated to use a keyed-by-provider map schema `{ "providers": { "claude": {...}, "gemini": {...} } }`. install.ts merges on each install. T2 documents that `uninstall --skill pm` (no --llm) iterates all recorded providers.

**Verification:** T1 now explicitly specifies the keyed-by-provider map schema and merge-not-overwrite semantics. T2's done criteria include all six command variants. The schema design matches the recommended Option A from the original review. PASS.

### F2 — Claude MCP unregistration (was: BLOCKING → RESOLVED)

**Original issue:** T3 only mentioned "Revert changes in provider settings files" but Claude MCP registration uses `claude mcp add --scope user` (a CLI command), so uninstall must use `claude mcp remove apra-fleet --scope user`, not direct settings.json editing.

**Doer:** fixed in commit d03b5f0 — T3 in PLAN.md now explicitly specifies that Claude MCP unregistration uses `claude mcp remove apra-fleet --scope user` (not direct file editing), and notes Windows requires `shell: 'cmd.exe'`.

**Verification:** T3 now has a clearly labeled "F2 (Claude-specific)" sub-bullet specifying the CLI command, scope flag, and Windows shell requirement. This matches the install path in install.ts. PASS.

### F3 — Missing risk register (was: BLOCKING → RESOLVED)

**Original issue:** PLAN.md had no risk register despite the review checklist requiring one.

**Doer:** fixed in commit d03b5f0 — Risk Register section added to PLAN.md covering five risks with mitigations.

**Verification:** The risk register covers all five risks originally suggested in the review (corrupt config, partial installs, server race condition, cross-platform paths, user-edited settings) plus adds concrete mitigations for each. R3 (race with running server) goes beyond the suggestion by specifying a detect-and-abort strategy. R5 (user-edited settings) addresses the non-blocking note about defaultModel — T3 now specifies "only remove if it matches the fleet-installed value." PASS.

---

## Non-Blocking Notes Status

Both non-blocking notes from the initial review were also addressed:

- **defaultModel removal strategy:** T3 now explicitly states "only remove if it matches the fleet-installed value (preserve user customization)." PASS.
- **Confirmation prompt / --yes bypass:** T3's done criteria now include "--yes bypasses confirm prompt; interactive confirm shown otherwise." PASS.

---

## Build and Tests

Build: `tsc` passes cleanly. PASS.
Tests: 65 files, 1072 passed, 6 skipped, 0 failed. PASS.
CI: No workflow runs detected for this branch (no CI config in repo). N/A — not a regression.

---

## Summary

All three blocking findings (F1, F2, F3) are fully resolved. Both non-blocking notes were also incorporated. The plan is now comprehensive: it covers the multi-provider schema, Claude-specific CLI unregistration, surgical settings removal with user-customization protection, fallback scanning, confirmation prompts, and a thorough risk register. Build and tests remain green.

Verdict: **APPROVED** — the plan is ready for execution.
