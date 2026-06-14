# VERIFY 3 Review -- Phase 3: OpenCode Provider Adapter

**Verdict: CHANGES NEEDED**

**Reviewer:** Claude (reviewer agent)
**Branch:** feat/opencode-pm-epic
**Base:** c98a0a0 (end of Phase 2)
**Commits reviewed:** 4c10108..898bf3f (8 commits, T3.1-T3.7)
**Date:** 2026-06-14

---

## Build & Test

### Criterion 1: `npm install && npm run build`
**PASS** -- Build succeeds, zero errors.

### Criterion 2: `npm test`
**PASS** -- 88 test files passed (1 skipped, pre-existing), 1446 tests passed (7 skipped, pre-existing). Zero regressions.

---

## Implementation Review

### Criterion 3: Full ProviderAdapter interface
**PASS** -- All 5 readonly props (`name`, `processName`, `authEnvVar`, `credentialPath`, `instructionFileName`) and all 26 methods implemented. No missing or stubbed methods. Parity with CodexProvider confirmed.

### Criterion 4: parseResponse matches REAL schema (exploration.md 8a)
**PASS** -- Fully correct:
- Text from `part.text` (NOT `part.content`) -- opencode.ts:131: `event.part?.text`
- Usage from `step_finish.part.tokens` -- opencode.ts:141-145: `event.part.tokens.input/output`
- sessionID from top-level `event.sessionID` -- opencode.ts:127-129
- Error events: `type:"error"`, no `part` assumed, message at `error.data.message` with fallback to `error.name` -- opencode.ts:133-135
- isError: non-zero exit code OR error event OR malformed JSON OR unexpected step_finish reason -- correct multi-condition logic
- Fixture `tests/fixtures/opencode-output.ndjson`: 4 lines matching verbatim captured shapes from exploration.md 8a (step_start, text, tool_use, step_finish with real sessionID `ses_01jxb9kz7xfcr1jv79sxmj9b1e` and real token counts 7165/2)
- Tests cover: text, tool_use, usage, sessionId, error, empty, non-zero exit, malformed JSON, step_finish stop/tool-calls/unexpected, multiple errors (prefer last)

### Criterion 5: instructionFileName == 'AGENTS.md'
**PASS** -- opencode.ts:12: `readonly instructionFileName = 'AGENTS.md';` with no TODO/UNVERIFIED comment. Verified per opencode.ai/docs/rules.

### Criterion 6: T3.7 per-member model_tiers
**PASS** -- Complete implementation:
- `Agent.modelTiers` in types.ts:36: optional `{ cheap?, standard?, premium? }`
- `register_member`: validates (rejects empty), single-model expansion (fills all 3), partial fill (cascades standard->cheap->first), opencode warning when omitted
- `resolveModelForTier` in execute-prompt.ts:92-99: member.modelTiers FIRST, then provider.modelForTier() fallback
- executePrompt dispatch (lines 170-186): branches on agent.modelTiers, calls resolveModelForTier for opencode path, preserves legacy modelCheap/Standard/Premium for other providers
- Tests (model-tiers.test.ts, 317 lines): full map / single-model / fallback chain / adapter defaults / Claude fallback / executePrompt integration (3 tiers + no-tiers fallback) / register_member validation (single/empty/partial/full/warning)

### Criterion 7: T3.6 install config
**PASS** --
- `getProviderInstallConfig('opencode')`: configDir=`~/.config/opencode`, settingsFile=`opencode.json`, skillsDir/fleetSkillsDir correct
- `PROVIDER_STANDARD_MODELS.opencode` = `'ollama/qwen3-coder:30b'`
- `update_llm_cli`: uses `getProvider(agent.llmProvider)` which returns OpenCodeProvider; delegates to `provider.installCommand()` / `provider.updateCommand()` -- works for opencode
- No auth provisioning: `authEnvVar=''`, `supportsOAuthCopy()=false`, `supportsApiKey()=false`, all OAuth methods return null/empty

Note: task criteria mentions `agentsDir ~/.config/opencode/agents` but `ProviderInstallConfig` interface has no `agentsDir` field (only `skillsDir`/`fleetSkillsDir`). Consistent with all other providers. Not a code bug.

### Criterion 8: composePermissionConfig
**FAIL -- BUG FOUND**

Code (opencode.ts:166-171):
```
doer:     { permission: { edit: 'allow', write: 'allow', bash: 'allow' } }
reviewer: { permission: { edit: 'deny',  write: 'deny',  bash: 'allow' } }
```

**Reviewer `write` should be `'allow'`, not `'deny'`.**

Evidence:
- **Design doc (section 5):** `reviewer: { edit: 'deny', write: 'allow', bash: 'allow' }`
- **Exploration doc (section 6.1):** "planner/plan-reviewer/reviewer had NO Edit (only Read/Grep/Glob/Bash/**Write**) so edit: deny, **write: allow**, bash: allow"
- **Claude agent definition:** The reviewer agent has `tools: [Read, Grep, Glob, Bash, Write]` -- Write is explicitly in the allowlist

**Impact:** A reviewer agent running under OpenCode would be unable to use the Write tool to create its verdict/feedback files.

**Fix required in two places:**
1. `src/providers/opencode.ts:170` -- change `write: 'deny'` to `write: 'allow'`
2. `tests/opencode-provider.test.ts:316` -- change `expect(perm.write).toBe('deny')` to `expect(perm.write).toBe('allow')`

### Criterion 9: classifyError
**PASS** -- Correct mappings:
- `not found / command not found` -> 'auth' (CLI missing)
- `connection refused / ECONNREFUSED` -> 'server'
- `timeout / ETIMEDOUT` -> 'server'
- `rate limit / 429` -> 'overloaded'
- default -> 'unknown'

### Criterion 10: File hygiene
**PASS** -- 14 files changed, all expected:
- 1 new provider: `src/providers/opencode.ts`
- 2 new test files: `tests/opencode-provider.test.ts`, `tests/model-tiers.test.ts`
- 1 new fixture: `tests/fixtures/opencode-output.ndjson`
- Modified source: types.ts, providers/index.ts, config.ts, execute-prompt.ts, register-member.ts, update-member.ts
- Regenerated: llms.txt, llms-full.txt, gen-llms-full.test.ts
- Updated doc: opencode-exploration.md
- No stray artifacts, no unrelated changes

---

## Summary

| # | Criterion | Verdict |
|---|-----------|---------|
| 1 | Build | PASS |
| 2 | Tests | PASS |
| 3 | Full interface | PASS |
| 4 | parseResponse | PASS |
| 5 | instructionFileName | PASS |
| 6 | model_tiers | PASS |
| 7 | Install config | PASS |
| 8 | composePermissionConfig | **FAIL** |
| 9 | classifyError | PASS |
| 10 | File hygiene | PASS |

**1 blocking finding:** Reviewer `write` permission is `'deny'` but must be `'allow'` per design and exploration docs. Two-line fix (opencode.ts + test).

9/10 criteria pass. The implementation is otherwise thorough, well-tested, and faithful to the design. The parseResponse implementation (the plan's #1 risk) is correct against the verified schema. The model_tiers feature is cleanly integrated with proper fallback chains and comprehensive tests.
