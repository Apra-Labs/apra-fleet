# Plan: Multi-provider Installer Support (Issue #43)

Refactor the installer to support Gemini and Codex providers in addition to Claude. This includes adding a --llm parameter to the install command, mapping provider-specific configuration and skill paths, and ensuring the Project Manager (PM) skill is provider-neutral.

## Phase 1: CLI & Path Refactoring
- [x] Define `ProviderInstallConfig` interface and implement mapping for Gemini and Codex.
- [x] Update `src/cli/install.ts` to parse `--llm <provider>` and resolve paths dynamically.
- [x] **VERIFY 1:** CLI argument --llm is correctly parsed and paths are dynamically resolved for all three providers.

## Phase 2: Provider-specific Settings Support
- [x] Introduce `smol-toml` library and update merge functions to handle both JSON and TOML formats.
- [x] Update `mergeHooksConfig` and `mergePermissions` to support provider-specific formats (JSON for Claude/Gemini, TOML for Codex).
- [x] Ensure `mergePermissions` uses provider-specific skill paths (e.g., `~/.gemini/skills/pm` instead of hardcoded `~/.claude/`).
- [x] Update `configureStatusline` to use the correct provider's settings file.
- [x] **VERIFY 2:** Hooks, permissions, and statusline are correctly merged into both settings.json (Claude/Gemini) and config.toml (Codex).

## Phase 3: Skill Neutrality & MCP Registration
- [x] Research and document exact MCP registration commands for Gemini (`gemini mcp add`) and Codex (likely manual TOML entry).
- [x] Update MCP registration logic to use the provider's specific command or configuration update method.
- [x] Review `skills/pm/SKILL.md` and related templates for provider neutrality.
- [x] Ensure `installSkill` logic uses the correct provider's skills directory.
- [x] **VERIFY 3:** Skill is installed to the correct provider-specific directory and the MCP server is registered correctly for each CLI.

## Phase 4: Validation
- [ ] Create `tests/install.test.ts` to unit test the installer with different --llm inputs.
- [ ] Verify installation for claude, gemini, and codex providers in a clean environment.
- [ ] Run existing integration tests to ensure no regressions.
- [ ] **VERIFY 4 (Final):** All providers verified via comprehensive automated tests; documentation reflects multi-provider support.

## Risk Register
- **New Dependency (`smol-toml`):** Adding a library for TOML parsing. Mitigation: Choose a lightweight, well-maintained library.
- **Backwards Compatibility:** Ensure existing Claude installations are not broken by the path refactoring. Mitigation: Default `--llm` to `claude` and maintain legacy path logic where necessary.
- **Provider-specific Schema Differences:** Settings files for Gemini/Codex might have different schemas than Claude. Mitigation: Implement schema-aware merge logic.

---

# apra-fleet — Implementation Plan: Token Usage Improvements

> Reduce unnecessary token spend by defaulting execute_prompt to the standard model tier, updating the installer and skill docs to stop recommending opus/premium for orchestration, and adding per-phase token tracking to progress.json so the PM can report cost by phase.

---

## Tasks

### Phase 1: Default Model Tier in execute_prompt

#### Task 1: Resolve standard tier model when model param is omitted
- **Change:** In `executePrompt()`, when `model` is undefined, call `provider.modelTiers().standard` and pass the resolved model name as `--model` to the CLI invocation
- **Files:** `src/tools/execute-prompt.ts`
- **Done when:** Unit test confirms that omitting `model` param results in the command including `--model claude-sonnet-4-5` (Claude), `--model gemini-2.5-pro` (Gemini), `--model gpt-5.4` (Codex); all existing tests pass
- **Blockers:** None — `modelTiers()` already exists on all providers

#### Task 2: Update executePromptSchema model param description
- **Change:** Update the `model` parameter description in the schema to document that omitting it defaults to the standard tier (e.g. "sonnet for Claude, equivalent for other providers")
- **Files:** `src/tools/execute-prompt.ts`
- **Done when:** Schema description reflects standard-tier default; no test changes needed

#### Task 3: Add tests for default model tier resolution
- **Change:** Add test cases to the execute_prompt test file verifying: (a) no `model` param → standard tier flag in command, (b) explicit `model` param → passed through unchanged
- **Files:** `tests/execute-prompt.test.ts`
- **Done when:** New tests pass; `npm test` green

#### VERIFY: Phase 1
- Run full test suite (`npm test`)
- Confirm all Phase 1 changes work together
- Report: tests passing, any regressions, any issues found

---

### Phase 2: Installer Default Model

#### Task 4: Write `defaultModel: standard` to settings during install
- **Change:** In `installSettings()` (or equivalent), after merging provider config, add `defaultModel` field set to the standard tier model name for that provider
- **Files:** `src/cli/install.ts`
- **Done when:** After `apra-fleet install`, the provider's settings file contains a `defaultModel` entry set to the standard model (e.g. `claude-sonnet-4-5` for Claude); existing install test passes with updated assertion
- **Blockers:** Need to verify that each CLI (Claude Code, Gemini CLI, Codex CLI) honours a `defaultModel` setting; if not, fall back to injecting `--model` everywhere

#### Task 5: Add install tests for defaultModel
- **Change:** Assert that each provider's post-install settings include the correct `defaultModel` value
- **Files:** `tests/install-multi-provider.test.ts` (or existing install test file)
- **Done when:** Tests for claude, gemini, codex providers all pass

#### VERIFY: Phase 2
- Run full test suite
- Confirm installer writes correct defaultModel for all three providers
- Report: tests passing, any regressions, any issues found

---

### Phase 3: Token Extraction in execute_prompt

#### Task 6: Add `usage` field to ParsedResponse interface
- **Change:** Add `usage?: { input_tokens: number; output_tokens: number }` to the `ParsedResponse` type/interface; update all providers' `parseResponse()` to return this field (undefined if not available)
- **Files:** `src/providers/provider.ts`, `src/providers/claude.ts`, `src/providers/gemini.ts`, `src/providers/codex.ts`, `src/providers/copilot.ts`
- **Done when:** TypeScript compiles; all provider `parseResponse()` implementations satisfy the updated interface
- **Blockers:** None — optional field, backward-compatible

#### Task 7: Extract Claude token counts from JSON response
- **Change:** In `claude.ts` `parseResponse()`, extract `parsed.usage.input_tokens` and `parsed.usage.output_tokens` from the response JSON when present and populate `usage` in the returned `ParsedResponse`
- **Files:** `src/providers/claude.ts`
- **Done when:** Unit test with a mock Claude response containing a `usage` object confirms tokens are returned; test with mock missing `usage` confirms graceful undefined

#### Task 8: Surface token counts in execute_prompt output
- **Change:** In `executePrompt()`, after parsing the response, if `parsed.usage` is defined, append a line `\nTokens: input=${parsed.usage.input_tokens} output=${parsed.usage.output_tokens}` to the returned text
- **Files:** `src/tools/execute-prompt.ts`
- **Done when:** Integration test with a mocked Claude response confirms token line appears; missing usage results in no extra line

#### VERIFY: Phase 3
- Run full test suite
- Confirm token counts appear in execute_prompt output for Claude provider
- Report: tests passing, any regressions, any issues found

---

### Phase 4: Progress.json Phase-wise Token Accumulation

#### Task 9: Add token fields to tpl-progress.json schema
- **Change:** Add a `tokens` object to each phase entry in the template: `{ doer: { input: 0, output: 0 }, reviewer: { input: 0, output: 0 } }`; tokens are cumulative across review cycles
- **Files:** `skills/pm/tpl-progress.json`
- **Done when:** Template file validates as valid JSON; new fields present under each phase

#### Task 10: Document token update workflow in PM skill
- **Change:** Add a step in the dispatch and post-dispatch sections instructing the PM to: (a) read token counts from the execute_prompt response, (b) use `execute_command` to update the corresponding phase's `tokens.doer` or `tokens.reviewer` in `progress.json`, accumulating (not overwriting) reviewer counts across cycles
- **Files:** `skills/pm/SKILL.md`, `skills/pm/doer-reviewer.md`
- **Done when:** Both docs clearly describe the PM's responsibility to extract and persist token counts after each dispatch

#### VERIFY: Phase 4
- Manual verification: run the PM through a planning session and confirm progress.json is updated with token counts
- Report: fields populated, accumulation correct across review cycles

---

### Phase 5: Skill & Docs — Remove Opus/Premium Orchestration References

#### Task 11: Replace opus-specific references with standard/premium tier language
- **Change:** Replace all occurrences of `model: "opus"` / `model=opus` with `model: "premium"` in doer/reviewer dispatch templates; update surrounding prose to clarify that reviewers use premium tier (best available per provider), doers use standard by default
- **Files:** `skills/pm/SKILL.md`, `skills/pm/doer-reviewer.md`
- **Done when:** No provider-specific model name appears in skill docs; `grep -r "opus" skills/` returns zero results

#### Task 12: Update planning prompt with model tier assignment step
- **Change:** Add a step to the planning prompt instructing the planner to assign a model tier (cheap / standard / premium) to each task based on complexity; this tier goes into the task definition and is used by the PM when dispatching
- **Files:** `skills/pm/plan-prompt.md` (or equivalent planning template)
- **Done when:** Planning prompt includes explicit model-tier assignment guidance; planner output includes tier per task

#### Task 13: Update user-facing docs to remove Opus branding
- **Change:** Replace "Opus" references with "premium tier" in user guide model recommendation table and any other user-facing docs
- **Files:** `docs/user-guide.md`
- **Done when:** `grep -ri "opus" docs/` returns zero results

#### VERIFY: Phase 5
- Run `grep -ri "opus" skills/ docs/` — expect zero matches
- Run full test suite
- Report: no Opus references remain, tests passing

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Claude CLI ignores `defaultModel` in settings.json | High | Verify in docs; if unsupported, inject `--model` flag in execute_prompt instead |
| Token format varies across provider/CLI versions | Medium | Make extraction resilient; return `undefined` rather than throw on missing field |
| Existing progress.json files lack token fields | Low | Fields are optional; PM handles missing gracefully, initialises on first write |
| Non-Claude providers don't emit token counts | Medium | Document limitation; return `undefined`, not an error |

## Notes
- Each task should result in a git commit
- Verify tasks are checkpoints — stop and report after each one
- Base branch: `main`
- Branch: `improve/token-usage`
