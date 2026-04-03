# apra-fleet — Implementation Plan: Token Usage Improvements

> Reduce unnecessary token spend by defaulting execute_prompt to the standard model tier, updating the installer and skill docs to stop recommending opus/premium for orchestration, and adding per-phase token tracking to progress.json so the PM can report cost by phase.

---

## Tasks

### Phase 1: Default Model Tier in execute_prompt

#### Task 1: Verify defaultModel settings support for non-Claude providers
- **Change:** Verify that Gemini CLI and Codex CLI honor a `defaultModel` (or equivalent) setting in their config files. For each provider: write the standard-tier model name to the provider's settings path, invoke the CLI with a trivial prompt, and confirm the model used matches. Document findings in a table in this task's notes.
- **Files:** None (investigation only)
- **Done when:** A table exists documenting: (a) which config key each provider uses for default model, (b) whether setting it actually changes the model used. Claude is already confirmed (`model: sonnet` in `~/.claude/settings.json` works). If a provider ignores the setting, note that Phase 2 must use `--model` flag injection for that provider.
- **Blockers:** Requires Gemini CLI and Codex CLI to be installed for testing

#### Task 2: Resolve standard tier model when model param is omitted
- **Change:** In `executePrompt()`, when `model` is undefined, call `provider.modelTiers().standard` and pass the resolved model name as `--model` to the CLI invocation
- **Files:** `src/tools/execute-prompt.ts`
- **Done when:** Unit test confirms that omitting `model` param results in the command including `--model claude-sonnet-4-5` (Claude), `--model gemini-2.5-pro` (Gemini), `--model gpt-5.4` (Codex); all existing tests pass
- **Blockers:** None — `modelTiers()` already exists on all providers

#### Task 3: Update executePromptSchema model param description
- **Change:** Update the `model` parameter description in the schema to document that omitting it defaults to the standard tier (e.g. "sonnet for Claude, equivalent for other providers")
- **Files:** `src/tools/execute-prompt.ts`
- **Done when:** Schema description reflects standard-tier default; no test changes needed

#### Task 4: Add tests for default model tier resolution
- **Change:** Add test cases to the execute_prompt test file verifying: (a) no `model` param → standard tier flag in command, (b) explicit `model` param → passed through unchanged
- **Files:** `tests/execute-prompt.test.ts`
- **Done when:** New tests pass; `npm test` green

#### VERIFY: Phase 1
- Run full test suite (`npm test`)
- Confirm all Phase 1 changes work together
- Report: tests passing, any regressions, any issues found

---

### Phase 2: Installer Default Model

#### Task 5: Write `defaultModel: standard` to settings during install
- **Change:** In `installSettings()` (or equivalent), after merging provider config, add `defaultModel` field set to the standard tier model name for that provider. For providers where Task 1 found that the config setting is ignored, instead inject `--model <standard>` into the CLI invocation flags.
- **Files:** `src/cli/install.ts`
- **Done when:** After `apra-fleet install`, the provider's settings file contains a `defaultModel` entry set to the standard model (e.g. `claude-sonnet-4-5` for Claude); existing install test passes with updated assertion
- **Blockers:** Task 1 findings determine the approach per provider

#### Task 6: Add install tests for defaultModel
- **Change:** Assert that each provider's post-install settings include the correct `defaultModel` value
- **Files:** `tests/install-multi-provider.test.ts` (or existing install test file)
- **Done when:** Tests for claude, gemini, codex providers all pass

#### VERIFY: Phase 2
- Run full test suite
- Confirm installer writes correct defaultModel for all three providers
- Report: tests passing, any regressions, any issues found

---

### Phase 3: Token Extraction in execute_prompt

#### Task 7: Add `usage` field to ParsedResponse interface
- **Change:** Add `usage?: { input_tokens: number; output_tokens: number }` to the `ParsedResponse` type/interface; update all providers' `parseResponse()` to return this field (undefined if not available)
- **Files:** `src/providers/provider.ts`, `src/providers/claude.ts`, `src/providers/gemini.ts`, `src/providers/codex.ts`, `src/providers/copilot.ts`
- **Done when:** TypeScript compiles; all provider `parseResponse()` implementations satisfy the updated interface
- **Blockers:** None — optional field, backward-compatible

#### Task 8: Extract Claude token counts from JSON response
- **Change:** In `claude.ts` `parseResponse()`, extract `parsed.usage.input_tokens` and `parsed.usage.output_tokens` from the response JSON when present and populate `usage` in the returned `ParsedResponse`
- **Files:** `src/providers/claude.ts`
- **Done when:** Unit test with a mock Claude response containing a `usage` object confirms tokens are returned; test with mock missing `usage` confirms graceful undefined

#### Task 9: Surface token counts in execute_prompt output
- **Change:** In `executePrompt()`, after parsing the response, if `parsed.usage` is defined, append a line `\nTokens: input=${parsed.usage.input_tokens} output=${parsed.usage.output_tokens}` to the returned text
- **Files:** `src/tools/execute-prompt.ts`
- **Done when:** Integration test with a mocked Claude response confirms token line appears; missing usage results in no extra line

#### VERIFY: Phase 3
- Run full test suite
- Confirm token counts appear in execute_prompt output for Claude provider
- Report: tests passing, any regressions, any issues found

---

### Phase 4: Progress.json Phase-wise Token Accumulation

#### Task 10: Add token and tier fields to tpl-progress.json schema
- **Change:** Extend the task entry schema in `tpl-progress.json` with two new fields:
  - `tokens`: `{ "doer": { "input": 0, "output": 0 }, "reviewer": { "input": 0, "output": 0 } }` — cumulative across review cycles
  - `tier`: `"standard"` — model tier for this task's doer dispatch (one of `cheap`, `standard`, `premium`). Reviewer tier is always `premium` and not stored per-task.
- **Files:** `skills/pm/tpl-progress.json`
- **Done when:** Template file validates as valid JSON; new `tokens` and `tier` fields present in the task entry schema

#### Task 11: Create src/tools/update-task-tokens.ts MCP tool
- **Change:** Add a new fleet-mcp tool update_task_tokens in src/tools/update-task-tokens.ts that runs on the PM side (no member-side Node.js required). The tool:
  1. Accepts params: member_id, progress_json (explicit full path on the member — PM passes it, tool does not guess), task_id, role (doer or reviewer), input_tokens, output_tokens
  2. Calls execute_command → cat <progress_json> to read the current contents from the member
  3. Parses and updates the JSON on the PM side (MCP server always has Node.js): accumulates tasks[i].tokens[role].input += input_tokens and output — never overwrites, always adds
  4. Initializes missing tokens field to { doer: {input:0,output:0}, reviewer: {input:0,output:0} } if absent
  5. Calls send_files to push the updated progress.json back to the member
  6. Calls execute_command → git add <progress_json> && git commit -m chore: update token counts for task <task_id> on the member
- **Files:** src/tools/update-task-tokens.ts
- **Done when:** Tool is callable via MCP; integration test confirms: (a) tokens accumulate correctly across multiple calls, (b) missing tokens field is initialized, (c) git commit is created on the member after each update; all existing tests pass

#### Task 12: Document token update workflow in PM skill
- **Change:** Add a step in the post-dispatch section of doer-reviewer.md instructing the PM to:
  1. After each `execute_prompt` response, extract token counts from the `Tokens: input=N output=M` line (regex: `Tokens: input=(\d+) output=(\d+)`)
  2. Call `execute_command` on the doer member: `node scripts/update-tokens.js --task-id <current-task-id> --role <doer|reviewer> --input <N> --output <M>`
  3. The PM must call this after every dispatch — doer dispatches use `--role doer`, reviewer dispatches use `--role reviewer`. Reviewer tokens accumulate across review cycles (the script handles this).
- **Files:** `skills/pm/doer-reviewer.md`
- **Done when:** doer-reviewer.md contains the exact post-dispatch workflow above; the PM has no ambiguity about how to update tokens

#### VERIFY: Phase 4
- Run `node scripts/update-tokens.js --task-id 1 --role doer --input 1000 --output 500` on a sample progress.json — confirm tokens are accumulated
- Run it again with `--role reviewer --input 200 --output 100` — confirm reviewer tokens are added separately
- Run it a third time with `--role reviewer --input 300 --output 150` — confirm accumulation (not overwrite): reviewer should show input=500, output=250
- Report: script works, docs are clear, progress.json updated correctly

---

### Phase 5: Skill & Docs — Remove Opus/Premium Orchestration References

#### Task 13: Replace opus-specific references with standard/premium tier language
- **Change:** Replace all occurrences of `model: "opus"` / `model=opus` with `model: "premium"` in doer/reviewer dispatch templates; update surrounding prose to clarify that reviewers use premium tier (best available per provider), doers use standard by default
- **Files:** `skills/pm/SKILL.md`, `skills/pm/doer-reviewer.md`
- **Done when:** No provider-specific model name appears in skill docs; `grep -r "opus" skills/` returns zero results

#### Task 14: Update planning prompt with model tier assignment step
- **Change:** Add a step to the planning prompt (PHASE 1 — DRAFT section) instructing the planner to:
  1. Assign a model tier (`cheap`, `standard`, or `premium`) to each task based on complexity
  2. The tier is written into each task's entry in PLAN.md (e.g. `- **Tier:** standard`)
  3. When the PM creates progress.json from the plan, it copies each task's tier into `tasks[i].tier`
  4. During dispatch, the PM reads `tasks[i].tier` and passes `model: <tier>` to `execute_prompt` for doer dispatches
  5. **Constraint:** Reviewer dispatches always use `premium` regardless of the task's tier — this is not configurable by the planner
- **Files:** `skills/pm/plan-prompt.md`
- **Done when:** Planning prompt includes explicit tier assignment guidance; constraint that reviewers always use premium is documented; the flow from PLAN.md → progress.json → dispatch is unambiguous

#### Task 15: Update user-facing docs to remove Opus branding
- **Change:** Replace "Opus" references with "premium tier" in user guide model recommendation table and any other user-facing docs
- **Files:** `docs/user-guide.md`
- **Done when:** `grep -ri "opus" docs/` returns zero results

#### Task 16: Document resume=true rule for follow-up dispatches in PM skill
- **Change:** Update `skills/pm/SKILL.md` and `skills/pm/doer-reviewer.md` to document the resume rule:
  - Initial plan generation: `resume=false`
  - Plan revisions (any feedback iteration): `resume=true` — member already has plan context; resuming saves re-reading files
  - Initial review dispatch: `resume=false` — reviewer needs fresh, unbiased context
  - Re-review after CHANGES NEEDED + doer fixes: `resume=true` — reviewer already read the plan; saves significant tokens
  - Role switch (doer to reviewer): always `resume=false`
  Present this as a token-saving best practice in both files.
- **Files:** `skills/pm/SKILL.md`, `skills/pm/doer-reviewer.md`
- **Done when:** Both files contain the resume rule table or equivalent; `grep -n resume skills/pm/SKILL.md` and `grep -n resume skills/pm/doer-reviewer.md` show the new guidance

#### VERIFY: Phase 5
- Run `grep -ri "opus" skills/ docs/` — expect zero matches
- Run full test suite
- Report: no Opus references remain, tests passing

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Non-Claude CLIs ignore `defaultModel` in settings | High | Task 1 verifies upfront; fallback is `--model` flag injection in execute_prompt. Claude already confirmed working. |
| Token format varies across provider/CLI versions | Medium | Make extraction resilient; return `undefined` rather than throw on missing field |
| Existing progress.json files lack token/tier fields | Low | Fields are optional; `scripts/update-tokens.js` initializes missing fields to zeros before accumulating |
| Non-Claude providers don't emit token counts | Medium | Document limitation; return `undefined`, not an error |
| LLM instruction reliability for token parsing | Medium | PM must parse a simple regex (`Tokens: input=(\d+) output=(\d+)`), but LLMs can skip steps. Mitigation: use a committed script (`scripts/update-tokens.js`) instead of ad-hoc commands; VERIFY Phase 4 validates accumulation correctness |
| apra-focus reference gap for token extraction | Low | Requirements.md says to refer to apra-focus codebase for token usage patterns. Task 8 (Claude extraction) should cross-reference `apra-focus` implementation before finalizing the parsing approach |

## Notes
- Each task should result in a git commit
- Verify tasks are checkpoints — stop and report after each one
- Base branch: `main`
- Branch: `improve/token-usage`
