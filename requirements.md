# Requirements: Install Agent Files During apra-fleet Install

## Problem

`execute_prompt` validates agent files at provider-specific paths before dispatching:
- Claude:  `<workFolder>/.claude/agents/<name>.md`  or  `~/.claude/agents/<name>.md`
- Gemini:  `<workFolder>/.gemini/agents/<name>.md`  or  `~/.gemini/agents/<name>.md`
- AGY:     `<workFolder>/.gemini/antigravity-cli/agents/<name>.md`  or  `~/.gemini/antigravity-cli/agents/<name>.md`

The repo ships 4 agent definitions in `agents/`:
- `agents/planner.md`
- `agents/doer.md`
- `agents/reviewer.md`
- `agents/plan-reviewer.md`

But `apra-fleet install` never writes them anywhere. Any call to `execute_prompt` with `agent: "doer"` etc. fails with "agent not found" on a fresh install.

## Goal

After this change, `apra-fleet install --llm <provider>` writes each agent file to the
user-level agents directory for that provider:
- `--llm claude`  ->  `~/.claude/agents/*.md`
- `--llm gemini`  ->  `~/.gemini/agents/*.md`
- `--llm agy`     ->  `~/.gemini/antigravity-cli/agents/*.md`
- `--llm codex`   ->  no agent concept, skip silently
- `--llm copilot` ->  no agent concept, skip silently

## Scope

### src/cli/install.ts
- Add `agents: Record<string, string>` to `AssetManifest` interface
- In `buildDevManifest`: collect `agents/*.md` into the `agents` field
  (key = filename e.g. `"doer.md"`, value = relative path `"agents/doer.md"`)
- In `runInstall`: add a new step after skill installation that writes agent files
  to `paths.agentsDir` (if defined for the provider)
- Update step count (`baseSteps`) and the final summary log line to include agents dir

### src/cli/config.ts (or wherever `ProviderInstallConfig` is defined)
- Add `agentsDir: string | undefined` to `ProviderInstallConfig`
- Set it for claude, gemini, agy; leave undefined for codex and copilot

### SEA asset bundler
- Find where `sea-config.json` or equivalent asset manifest is built and add `agents/*.md`
  so they are bundled into the SEA binary for production installs

### Tests
- `tests/install-multi-provider.test.ts`: verify agents are written to the correct dir
  for claude, gemini, agy; verify codex/copilot skip gracefully
- Any mock of `AssetManifest` or `buildDevManifest` needs the new `agents` field

## Constraints
- ASCII only in committed files (pre-commit hook enforces this)
- Branch: `enhancement/skill-reorg`
- Do not touch files under `C:\Users\akhil\.claude\skills\` -- those are live running skills
