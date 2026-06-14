# Review: opencode/e2e fixes on feat/opencode-pm-epic (a83bd78..1e0e0ea)

**Verdict: APPROVED**

Reviewer: kdagg (reviewer agent)
Date: 2026-06-14
Commits reviewed: 2359dd0, f0f8028, f9b194b, db4755c, ba9aba6, 1e0e0ea

---

## 1. Build and Tests

- `npm install && npm run build` -- clean, no errors.
- `npm test` -- **1513 passed**, 7 skipped, 0 failures. (91 test files passed, 1 skipped.)

## 2. Key Fix: valid opencode.json (ba9aba6)

**PASS.** The gating `if (llm !== 'opencode')` at install.ts:608 correctly skips:
- `mergeHooksConfig` (hooks)
- `configureStatusline` (statusLine)
- `writeDefaultModel` (defaultModel)

And `if (llm !== 'opencode')` at install.ts:761 correctly skips:
- `mergePermissions` (permissions)

The guard condition is safe -- all other providers (claude, gemini, agy, codex, copilot) are !== 'opencode' and remain unchanged.

`mergeOpenCodeConfig` (install.ts:356-365) writes MCP under `mcp['apra-fleet']` with `{ type: 'local', command: [...], enabled: true }` -- NOT `mcpServers`. Confirmed correct.

**Real install test** (`node dist/index.js install --force --llm opencode --skill none` with temp HOME):
```json
{
  "mcp": {
    "apra-fleet": {
      "type": "local",
      "command": ["node", "/Users/akhil/git/apra-fleet/dist/index.js"],
      "enabled": true
    }
  }
}
```
Only valid key (`mcp`). No hooks, statusLine, defaultModel, mcpServers, or permissions.

**Regression tests** (tests/install-multi-provider.test.ts:846-954): assert opencode.json has NONE of the forbidden keys, all top-level keys within the valid set, MCP under `mcp` with type local + command array, AND that a Claude install still has hooks/statusLine/permissions. All pass.

## 3. GLM Premium Tier (1e0e0ea)

**PASS.** In src/providers/opencode.ts:
- `modelTiers()` returns `{ cheap: 'ollama/qwen3-coder:30b', standard: 'ollama/qwen3-coder:30b', premium: 'ollama/MichelRosselli/GLM-4.5-Air:Q4_K_M' }`.
- `modelForTier('premium')` returns `'ollama/MichelRosselli/GLM-4.5-Air:Q4_K_M'`.
- `modelForTier('cheap')` and `modelForTier('mid')` both return `'ollama/qwen3-coder:30b'`.
- `modelTiers()` and `modelForTier()` **agree** for every tier.

`PROVIDER_STANDARD_MODELS['opencode']` (config.ts:49) is `'ollama/qwen3-coder:30b'` -- unchanged (standard = qwen3-coder:30b). Correct.

Tests updated consistently:
- opencode-provider.test.ts:71 asserts `tiers.premium === 'ollama/MichelRosselli/GLM-4.5-Air:Q4_K_M'`.
- opencode-provider.test.ts:76 asserts `modelForTier('premium') === 'ollama/MichelRosselli/GLM-4.5-Air:Q4_K_M'`.
- model-tiers.test.ts:101 asserts adapter-default premium fallback is `'ollama/MichelRosselli/GLM-4.5-Air:Q4_K_M'`.

## 4. s10 Slim Suite (db4755c)

**PASS.**
- `lite-suites.json` has a single opencode suite (id s10), no `os` field.
- `fleet-lite-e2e.yml` suite options `[s10]`, opencode-only branches, runner input (default `self-hosted`) present.
- No s10.1/s10.3 leftovers (grep returned 0 hits).
- `run-lite-e2e.mjs` is opencode-only (only `opencode` in the provider switch).
- The opencode permission seed writes valid/empty (`echo '{}' > ...opencode.json`), not the invalid `{"permissions":{"allow":["*"]}}`.
- `validate-sprint.test.ts` asserts the single opencode suite (length 1, id s10, provider opencode, no `os` property).

## 5. apra-pm Submodule (a32ad43)

**PASS.**
- `grep 'pm-lite|apra-pm-lite' vendor/apra-pm/` -> 0 hits (rename complete).
- `e2e/suites.json` ids: [s1, s7, s8, s9], no `os` field on any suite.
- `.github/workflows/pm-e2e.yml` exists (not pm-lite-e2e.yml), has `runner` input + `runs-on: ${{ inputs.runner }}`.
- s9 opencode is wired (CLI map in Derive-provider step + verify step + dispatch).
- **No invalid opencode permission seed** -- apra-pm's pm-e2e.yml has no "Seed OpenCode config" step at all; it uses `--dangerously-skip-permissions` at runtime, which is correct.

## 6. File Hygiene

**PASS.**
- Only intended files changed (10 files + 1 submodule pointer).
- No stray artifacts.
- No process files at repo root (feedback.md/requirements.md/design.md/plan.md all absent).
- ASCII only -- 0 non-ASCII characters in the diff.

## Summary

All 6 review criteria pass. The key user-reported bug (invalid opencode.json) is correctly fixed with proper gating that doesn't affect other providers, backed by thorough regression tests. The GLM premium tier change is consistent across all touchpoints. The s10 suite is clean and minimal. The apra-pm submodule is properly updated. No issues found.
