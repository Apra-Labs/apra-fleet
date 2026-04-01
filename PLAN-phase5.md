# Phase 5: PM Skill Provider Independence

## Goal
Make the PM skill (`skills/pm/`) fully provider-independent so that a Gemini (or Codex/Copilot) member can be registered, onboarded, assigned work, reviewed, and deployed through the same PM workflows that work for Claude members today. All existing Claude workflows must remain identical (backwards compatible).

## Scope

### What changes
- PM skill markdown files: remove Claude-specific model names, instruction file references, permission mechanisms
- `compose_permissions` server tool: provider-aware permission delivery (settings.local.json for Claude, skip-permissions flag for others)
- Templates: rename tpl-claude.md → tpl-doer.md, parameterize instruction file name
- Onboarding: provider-aware branching for auth, CLI setup, attribution config
- Doer-reviewer loop: provider-aware role config delivery

### What stays the same
- PM itself still runs on Claude (CLAUDE.md is PM's own config)
- All server-side tools (execute_command, execute_prompt, send_files) — already provider-aware from Phase 4
- ProviderAdapter interface — already has modelForTier(), instructionFileName, skipPermissionsFlag()
- Fleet registry, Agent type — already has llmProvider field

---

## Phase 5A: Model Tier Abstraction in Skill Docs

Replace all Claude-specific model names (haiku/sonnet/opus) with abstract tier names (cheap/mid/premium) in PM skill markdown files. The server already resolves tiers via `ProviderAdapter.modelForTier()`.

### Task 1: Replace model names in SKILL.md
**File:** `skills/pm/SKILL.md`
**Changes:**
- Line 74: `haiku→sonnet→opus` → `cheap→mid→premium`
- Lines 101-102: Replace "haiku for execution... sonnet for construction... opus for planning..." with tier-based language: "cheap tier for execution (commands, status, tests, deploys). mid tier for construction (code, config, devops). premium tier for planning, review, design, and architecture."
**Done criteria:** No occurrences of `haiku`, `sonnet`, or `opus` in SKILL.md.
**Complexity:** S

### Task 2: Replace model names in doer-reviewer.md
**File:** `skills/pm/doer-reviewer.md`
**Changes:**
- Line 58: `haiku→sonnet→opus` → `cheap→mid→premium`
- Line 63: `opus` → `premium tier`
**Done criteria:** No occurrences of `haiku`, `sonnet`, or `opus` in doer-reviewer.md.
**Complexity:** S

### Task 3: Replace model names in troubleshooting.md
**File:** `skills/pm/troubleshooting.md`
**Changes:**
- Line 9: `haiku→sonnet→opus` → `cheap→mid→premium`
**Done criteria:** No occurrences of `haiku`, `sonnet`, or `opus` in troubleshooting.md.
**Complexity:** S

### Task 4: VERIFY — Model tier abstraction
**Type:** verify
**Check:** `grep -ri "haiku\|sonnet\|opus" skills/pm/` returns zero matches. All skill docs use tier names exclusively. Build passes, tests pass.

---

## Phase 5B: Template Rename and Instruction File Parameterization

Rename tpl-claude.md to tpl-doer.md and parameterize all references to instruction file names (CLAUDE.md) so the PM sends the correct file name per provider.

### Task 5: Rename tpl-claude.md → tpl-doer.md
**Files:** `skills/pm/tpl-claude.md` → `skills/pm/tpl-doer.md`
**Changes:**
- `git mv skills/pm/tpl-claude.md skills/pm/tpl-doer.md`
- In tpl-doer.md: the content is already mostly generic. No content changes needed — the template uses `{{PROJECT_NAME}}` placeholder and generic instructions.
**Done criteria:** `tpl-claude.md` no longer exists. `tpl-doer.md` has identical content.
**Complexity:** S

### Task 6: Update all references to tpl-claude.md
**Files:** `skills/pm/SKILL.md`, `skills/pm/doer-reviewer.md`, any other files referencing `tpl-claude.md`
**Changes:**
- Replace all occurrences of `tpl-claude.md` with `tpl-doer.md`
**Done criteria:** `grep -ri "tpl-claude" skills/pm/` returns zero matches.
**Complexity:** S

### Task 7: Parameterize instruction file name in skill docs
**Files:** `skills/pm/SKILL.md`, `skills/pm/doer-reviewer.md`, `skills/pm/tpl-doer.md`, `skills/pm/tpl-reviewer.md`
**Changes:**
The PM skill currently hardcodes "CLAUDE.md" as the instruction file name for members. This must become provider-aware:
- In SKILL.md: Where it says "CLAUDE.md — execution model (from tpl-doer.md), add to .gitignore" → change to "Instruction file (e.g. CLAUDE.md, GEMINI.md — determined by member's provider) — execution model (from tpl-doer.md), add to .gitignore"
- In SKILL.md Rule 9: "Only CLAUDE.md stays uncommitted" → "Only the provider's instruction file stays uncommitted"
- In doer-reviewer.md: "Send `tpl-doer.md` as CLAUDE.md to doer" → "Send `tpl-doer.md` as the member's instruction file (e.g. CLAUDE.md for Claude, GEMINI.md for Gemini) to doer via `send_files`"
- In doer-reviewer.md: "Send `tpl-reviewer.md` as CLAUDE.md to reviewer" → same pattern
- In doer-reviewer.md "Git as transport" section: "CLAUDE.md is NEVER committed" → "The instruction file (CLAUDE.md, GEMINI.md, etc.) is NEVER committed"
- In tpl-doer.md: "NEVER commit CLAUDE.md" → "NEVER commit the instruction file (CLAUDE.md, GEMINI.md, etc.) — it is role-specific and not shared"
- In tpl-reviewer.md: same change
- Add a note in SKILL.md Task Harness section: "Use `member_detail` to look up the member's `llmProvider`, then use the provider's `instructionFileName` (CLAUDE.md, GEMINI.md, AGENTS.md, COPILOT.md) when sending tpl-doer.md or tpl-reviewer.md."

**Important:** Do NOT change references to the PM's own CLAUDE.md — the PM runs on Claude and its CLAUDE.md stays as-is. Only member-facing instruction file references become parameterized.

**Done criteria:** All member-facing instruction file references are parameterized. PM's own CLAUDE.md references remain unchanged. Clear guidance on how to determine the correct file name per provider.
**Complexity:** M

### Task 8: VERIFY — Template rename and parameterization
**Type:** verify
**Check:** `tpl-claude.md` does not exist. All references point to `tpl-doer.md`. No hardcoded `CLAUDE.md` for member instruction files in skill docs (PM's own CLAUDE.md references are fine). Build passes, tests pass.

---

## Phase 5C: Permission Abstraction

Make `compose_permissions` provider-aware. Claude members continue getting `settings.local.json`. Non-Claude members get `dangerouslySkipPermissions=true` passed via `execute_prompt` (since they lack fine-grained permission files). Update skill docs to reflect the bifurcation.

### Task 9: Add provider field to compose_permissions schema
**File:** `src/tools/compose-permissions.ts`
**Changes:**
- The tool already receives `member_id` and looks up the agent. The agent has `llmProvider`. No schema change needed — the tool should read `agent.llmProvider` internally.
- Add provider-aware branching in `composePermissions()`:
  - If `agent.llmProvider === 'claude'` (or undefined for backwards compat): existing behavior — compose and deliver `settings.local.json`
  - If non-Claude provider: return a message indicating that this provider uses CLI-level permission bypass, and that the PM should pass `dangerouslySkipPermissions: true` in `execute_prompt` calls. Do NOT attempt to write settings.local.json to non-Claude members.
- For the reactive grant path (when `input.grant` is provided): same bifurcation. Claude gets the grant merged into settings.local.json. Non-Claude gets a message that fine-grained grants are not supported — the entire session runs with full permissions.
**Done criteria:** `compose_permissions` called on a Gemini member returns guidance instead of writing settings.local.json. Claude member behavior unchanged. Unit tests cover both paths.
**Complexity:** M

### Task 10: Update permissions.md for provider awareness
**File:** `skills/pm/permissions.md`
**Changes:**
Add a "Provider Differences" section:
```
## Provider Differences

| Provider | Permission Mechanism | PM Action |
|----------|---------------------|-----------|
| Claude | `.claude/settings.local.json` (fine-grained) | `compose_permissions` composes and delivers per-tool allow list |
| Gemini | `--yolo` flag (all-or-nothing) | Pass `dangerouslySkipPermissions: true` in `execute_prompt` |
| Codex | `--sandbox danger-full-access` (all-or-nothing) | Pass `dangerouslySkipPermissions: true` in `execute_prompt` |
| Copilot | No sandbox mechanism | Pass `dangerouslySkipPermissions: true` in `execute_prompt` |

For non-Claude providers, `compose_permissions` returns guidance only — no file is delivered.
Mid-sprint denials do not apply to non-Claude providers (they run with full permissions).
```
- Update "Before every sprint" section to mention checking the member's provider first.
- Update "Mid-sprint denial" section to note this only applies to Claude members.
**Done criteria:** permissions.md documents the provider bifurcation clearly.
**Complexity:** S

### Task 11: Update SKILL.md rule 8 for provider awareness
**File:** `skills/pm/SKILL.md`
**Changes:**
- Rule 8 currently says: "NEVER use `dangerously_skip_permissions`. Before every sprint, compose and deliver member permissions per permissions.md (stack detection + profiles + project ledger → `settings.local.json`). Mid-sprint denial? Evaluate, grant, re-deliver, resume."
- Update to: "Before every sprint, compose and deliver member permissions per permissions.md. For Claude members: stack detection + profiles + project ledger → `settings.local.json`. For non-Claude members: pass `dangerouslySkipPermissions: true` in `execute_prompt` (these providers lack fine-grained permission files). NEVER use `dangerously_skip_permissions` on Claude members when fine-grained permissions can be composed."
**Done criteria:** Rule 8 reflects the provider-aware permission model.
**Complexity:** S

### Task 12: Update troubleshooting.md permission entry
**File:** `skills/pm/troubleshooting.md`
**Changes:**
- "Permission denied" row: update from "Evaluate and grant in `.claude/settings.local.json` via `send_files`" to "Claude members: evaluate and grant via `compose_permissions`. Non-Claude members: ensure `dangerouslySkipPermissions: true` is set in `execute_prompt`."
**Done criteria:** Troubleshooting table reflects provider-aware permission handling.
**Complexity:** S

### Task 13: Write tests for provider-aware compose_permissions
**File:** `tests/compose-permissions.test.ts` (or extend existing test file)
**Changes:**
- Test: Claude member → settings.local.json is composed and delivered (existing behavior)
- Test: Gemini member → returns guidance message, does NOT attempt to write settings.local.json
- Test: Claude member reactive grant → settings.local.json updated
- Test: Gemini member reactive grant → returns "not supported" guidance
- Test: Member with no llmProvider (backwards compat) → treated as Claude
**Done criteria:** All 5 test cases pass.
**Complexity:** M

### Task 14: VERIFY — Permission abstraction
**Type:** verify
**Check:** `npm test` passes. compose_permissions works correctly for Claude and Gemini members. Skill docs are consistent with implementation. No hardcoded `settings.local.json` references in skill docs without provider qualification.

---

## Phase 5D: Onboarding Provider Awareness

Make the onboarding flow detect the member's llmProvider and branch accordingly. Some steps are Claude-specific (attribution config, specific CLI checks), while others need provider-specific variants.

### Task 15: Update onboarding.md with provider branching
**File:** `skills/pm/onboarding.md`
**Changes:**

**Step 2 (Disable AI Attribution):** Currently writes to `.claude/settings.json`. This is Claude-specific.
- Add provider branching: "Check `member_detail` for `llmProvider`."
  - Claude: existing behavior (write `{"attribution":{"commit":"","pr":""}}` to `.claude/settings.json`)
  - Gemini: write equivalent config if Gemini CLI supports attribution disable, or skip with note "Gemini CLI does not support attribution config — skip"
  - Codex/Copilot: same pattern — skip or configure per provider's capabilities
- Add a provider matrix for attribution support.

**Step 3 (Detect VCS Provider):** Already generic — no changes needed.

**Step 5 (Setup VCS Auth):** Already generic — no changes needed.

**Step 6 (Check/Install Required Skills):** Already generic — no changes needed.

**New Step (between current 1 and 2): Verify CLI Installation**
- Add: "Run `execute_command` with the provider's `versionCommand()` (e.g. `claude --version`, `gemini --version`). If not installed, run `installCommand()` for the member's OS. Use `member_detail` to determine `llmProvider` and `os`."
- This replaces the implicit assumption that Claude CLI is present.

**Step 7 (Update Member Status File):** Add `LLM Provider: <provider>` to the member profile template.

**Done criteria:** Onboarding.md has clear provider branching for each step. A Gemini member can be fully onboarded following the documented steps.
**Complexity:** M

### Task 16: Update doer-reviewer.md for provider-aware config delivery
**File:** `skills/pm/doer-reviewer.md`
**Changes:**

**Section "Setup Checklist" item 3:**
- Currently: "Compose and deliver permissions per permissions.md for each member's role."
- Update to: "Compose and deliver permissions per permissions.md for each member's role. For non-Claude members, this means setting `dangerouslySkipPermissions: true` in `execute_prompt` calls rather than delivering a file."

**Section "Setup Checklist" item 4:**
- Already handled by Task 7 (instruction file parameterization). Verify consistency.

**Section "Permissions":**
- Currently: "Compose and deliver `settings.local.json` per permissions.md. Recompose when switching roles (doer↔reviewer)."
- Update to: "Compose and deliver permissions per permissions.md. Recompose when switching roles (doer↔reviewer). For non-Claude members, role switch does not require permission recomposition (they run with full permissions)."

**Done criteria:** doer-reviewer.md has no provider-specific assumptions in the workflow descriptions.
**Complexity:** S

### Task 17: VERIFY — Onboarding provider awareness
**Type:** verify
**Check:** All skill docs are internally consistent. A walkthrough of the onboarding flow for a hypothetical Gemini member succeeds on paper (each step has a defined action). Build passes, tests pass.

---

## Phase 5E: End-to-End Integration and Cleanup

Final integration tasks: ensure the full lifecycle (register → onboard → execute plan → review → deploy) works for both Claude and Gemini members. Clean up any remaining provider-specific assumptions.

### Task 18: Audit all skill docs for remaining Claude assumptions
**Files:** All files in `skills/pm/`
**Changes:**
- `grep -ri "claude" skills/pm/` — review every hit
- Categorize each as: (a) PM's own CLAUDE.md reference (keep), (b) member-facing Claude assumption (fix), (c) generic mention of Claude as a provider example (keep if qualified)
- Fix any remaining category (b) items
- Ensure `init.md` references to CLAUDE.md template are clearly about the PM's own config, not members
**Done criteria:** Every mention of "Claude" or "CLAUDE.md" in skill docs is either about the PM's own config or is qualified as a provider example alongside others.
**Complexity:** S

### Task 19: Add provider-awareness section to SKILL.md
**File:** `skills/pm/SKILL.md`
**Changes:**
Add a new "## Provider Awareness" section (after "## Model Selection"):
```
## Provider Awareness

Members may run different LLM providers (Claude, Gemini, Codex, Copilot). The PM adapts behavior per provider:

- **Instruction file:** Use `member_detail` → `llmProvider` to determine the correct instruction file name (CLAUDE.md, GEMINI.md, AGENTS.md, COPILOT.md). Send tpl-doer.md/tpl-reviewer.md renamed to the provider's instruction file.
- **Permissions:** Claude members get fine-grained permissions via `compose_permissions`. Non-Claude members run with `dangerouslySkipPermissions: true` in `execute_prompt`.
- **Model tiers:** Use `cheap`/`mid`/`premium` tier names. The server resolves to provider-specific models via `modelForTier()`.
- **CLI differences:** Each provider's CLI has different flags and capabilities. The server handles this via `ProviderAdapter` — PM should not construct CLI commands directly.
- **Attribution:** Only Claude supports disabling attribution via settings. Skip for other providers.

The PM itself always runs on Claude. These adaptations apply to fleet members only.
```
**Done criteria:** A single authoritative section documents all provider-aware behavior for the PM.
**Complexity:** S

### Task 20: Update skill-matrix.md for provider column
**File:** `skills/pm/skill-matrix.md`
**Changes:**
- The skill matrix currently doesn't account for LLM provider. Since skills are VCS/project-specific (not LLM-specific), no structural change is needed. But add a note:
  "Note: Skills are independent of the member's LLM provider. A Gemini member on Bitbucket needs `bitbucket-devops` the same as a Claude member would."
**Done criteria:** skill-matrix.md clarifies that skills are provider-agnostic.
**Complexity:** S

### Task 21: Walkthrough test — Gemini member lifecycle
**Type:** manual verification (document in task notes)
**Changes:**
Trace through the complete lifecycle for a Gemini member and verify each step has a defined, working path:
1. `register_member` with `llmProvider: 'gemini'` — Agent type stores provider ✓ (Phase 4)
2. Onboarding steps 1-7 — each step has Gemini branch (Task 15)
3. `/pm pair` — icons set, permissions composed (returns guidance for Gemini) (Task 9, 16)
4. `/pm start` — tpl-doer.md sent as GEMINI.md, execute_prompt uses Gemini CLI (Task 7, Phase 4)
5. Doer executes, hits verify → PM dispatches reviewer (if reviewer is also Gemini: tpl-reviewer.md sent as GEMINI.md)
6. Review cycle completes → merge → deploy
**Done criteria:** Each step maps to a concrete implementation. Any gaps are filed as follow-up issues.
**Complexity:** M

### Task 22: VERIFY — Full Phase 5
**Type:** verify
**Check:**
- `npm run build` — clean compilation
- `npm test` — all tests pass
- `grep -ri "haiku\|sonnet\|opus" skills/pm/` — zero matches
- `grep -ri "tpl-claude" skills/pm/` — zero matches
- Every `settings.local.json` reference in skill docs is qualified by provider
- The provider-awareness section in SKILL.md is comprehensive and consistent with all sub-documents

---

## Summary

| Phase | Tasks | Focus |
|-------|-------|-------|
| 5A | 1-4 | Model tier abstraction (haiku/sonnet/opus → cheap/mid/premium) |
| 5B | 5-8 | Template rename + instruction file parameterization |
| 5C | 9-14 | Permission abstraction (compose_permissions provider-aware) |
| 5D | 15-17 | Onboarding provider awareness |
| 5E | 18-22 | Integration, cleanup, end-to-end walkthrough |

**Total tasks:** 22 (17 implementation + 5 verify checkpoints)
**Estimated effort:** 5S + 5M + 1L = ~3-4 focused sessions
