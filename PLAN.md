# Plan: Multi-provider Installer Support (Issue #43)

Refactor the installer to support Gemini and Codex providers in addition to Claude. This includes adding a --llm parameter to the install command, mapping provider-specific configuration and skill paths, and ensuring the Project Manager (PM) skill is provider-neutral.

## Phase 1: CLI & Path Refactoring
- [ ] Update src/cli/install.ts to accept --llm <provider> (defaulting to claude).
- [ ] Define ProviderInstallConfig interface to encapsulate provider-specific paths and commands.
- [ ] Refactor hardcoded Claude paths in src/cli/install.ts to use ProviderInstallConfig.
- [ ] Implement mapping for Gemini and Codex:
  - Claude: ~/.claude/settings.json, ~/.claude/skills/pm
  - Gemini: ~/.gemini/settings.json, ~/.gemini/skills/pm
  - Codex: ~/.codex/config.toml, ~/.codex/skills/pm
- [ ] **VERIFY 1:** CLI argument --llm is correctly parsed and paths are dynamically resolved for all three providers.

## Phase 2: Provider-specific Settings Support
- [ ] Update mergeHooksConfig to handle different settings file locations and formats.
- [ ] Update mergePermissions to support provider-specific formats (JSON for Claude/Gemini, TOML for Codex).
- [ ] Update configureStatusline to use the correct provider's settings file.
- [ ] **VERIFY 2:** Hooks, permissions, and statusline are correctly merged into both settings.json (Claude/Gemini) and config.toml (Codex).

## Phase 3: Skill Neutrality & MCP Registration
- [ ] Update MCP registration command to use the provider's CLI (e.g., gemini mcp add).
- [ ] Review skills/pm/SKILL.md and related templates for provider neutrality.
- [ ] Ensure installSkill logic uses the correct provider's skills directory.
- [ ] **VERIFY 3:** Skill is installed to the correct provider-specific directory and the MCP server is registered under the correct CLI.

## Phase 4: Validation
- [ ] Create tests/install.test.ts to unit test the installer with different --llm inputs.
- [ ] Verify installation for claude, gemini, and codex providers in a clean environment.
- [ ] Run existing integration tests to ensure no regressions.
- [ ] **VERIFY 4 (Final):** All providers verified via comprehensive automated tests; documentation reflects multi-provider support.
