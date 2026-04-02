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
