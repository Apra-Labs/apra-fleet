# Issue #215 — provision_llm_auth cross-provider scenarios

## Problem

`provision_llm_auth` was written before multi-provider support was fully built. Cross-provider scenarios — e.g. a Claude orchestrator provisioning a Gemini member, or a Gemini orchestrator provisioning a Claude member — have never been reviewed for correctness and may silently fail or use the wrong credentials.

## Why it matters

With ~20 developers using fleet daily across mixed provider setups, cross-provider provisioning is a real and growing scenario. Silent auth failure mid-sprint is a hard-to-debug blocker.

## Current implementation (src/tools/provision-auth.ts)

`provisionAuth` resolves the agent's provider via `getProvider(agent.llmProvider)` and follows three flows:

- **Flow A (OAuth copy):** if `provider.oauthCredentialFiles()` returns files, copy local credential files to the member. Includes settings merge, env var unset, and verification.
- **Flow B (API key direct):** if `api_key` param provided, call `provisionApiKey` which sets env var in shell profiles and stores encrypted in registry.
- **Fallback (OOB key):** if Flow A files don't exist and no API key, trigger `collectOobApiKey` OOB prompt.

## Symmetric vs cross-provider

**Symmetric (claude→claude, gemini→gemini):** OAuth credential sharing works — both sides use the same provider's credential store. Likely already correct.

**Cross-provider — needs research and implementation:**

### Three-strategy flow (in order of preference)

1. **Pre-auth probe** — before any provisioning, run a minimal CLI check on the member (`gemini --version` or `claude -p hello`) to detect if already authenticated. If it works, skip provisioning entirely.

2. **Local OAuth credential detection** — check if the target provider's OAuth credentials exist locally (e.g. `~/.gemini/credentials.json` for Gemini, `~/.claude/credentials` for Claude). If present and valid, copy via existing Flow A.

3. **OOB API key collection** — if neither of the above, prompt user via OOB flow for the target provider's API key (e.g. `GEMINI_API_KEY`), then invoke Flow B.

### Provider combinations to cover
- claude orchestrator → gemini member
- claude orchestrator → codex member
- claude orchestrator → copilot member
- gemini orchestrator → claude member
- gemini orchestrator → codex member
- gemini orchestrator → copilot member

## What this issue should produce

1. Audit of `provision_llm_auth` per provider combination — which work, which are broken, which are untested
2. Implement the three-strategy flow for cross-provider cases
3. Tests covering the pre-auth probe, OAuth detection, and OOB fallback paths

## Related files
- `src/tools/provision-auth.ts` — primary implementation
- `src/providers/index.ts` — provider adapter interface (`oauthCredentialFiles`, `authEnvVar`, etc.)
- `src/cli/auth.ts` — OOB input mechanism (supports `--api-key` mode)
