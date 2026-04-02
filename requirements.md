# Requirements: Multi-Provider Installer Support (Issue #43)

## Problem Statement
The `apra-fleet.exe install --skill` command is currently hardcoded for the Claude provider. It installs the MCP server configuration into `~/.claude/settings.json` and copies the Project Manager (PM) skill to `~/.claude/skills/pm/`.

To support the full fleet ecosystem, the installer must be updated to support other providers like Gemini and Codex, allowing the PM (and other skills) to run on the user's preferred LLM.

## User Story
As a Fleet Administrator, I want to install the PM skill for Gemini so that I can use my AI Ultra subscription to orchestrate my fleet members.

## Functional Requirements

### 1. New CLI Parameter: `--llm`
- Add an optional `--llm` parameter to the `install` command.
- **Supported Values:** `claude` (default), `gemini`, `codex`.
- **Validation:** If an unsupported provider is passed, the installer should exit with a clear error message listing supported providers.

### 2. Provider-Specific Path Mapping
The installer must map the following configuration and skill directories based on the `--llm` value:

| Provider | MCP Server Config Path | Skill Directory Path |
| :--- | :--- | :--- |
| **Claude** | `~/.claude/settings.json` | `~/.claude/skills/pm/` |
| **Gemini** | `~/.gemini/settings.json` | `~/.gemini/skills/pm/` |
| **Codex** | `~/.codex/config.toml` | *TBD (Investigate)* |

### 3. MCP Server Configuration (Trust/Permissions)
The installer must ensure the MCP server is correctly registered and trusted:
- **Claude:** Use the standard `settings.json` format.
- **Gemini:** Add `"trust": true` to the `mcpServers` entry in `~/.gemini/settings.json`.
- **Codex:** Update `config.toml` with the correct server entry.

### 4. Skill Content Updates
- Update `skills/pm/SKILL.md` (Line 122) to remove the hardcoded reference: "PM always runs on Claude". It should be changed to a provider-neutral statement (e.g., "PM runs on the configured fleet provider").

### 5. Shared Components (No Changes Required)
The following components should remain unchanged regardless of the `--llm` provider:
- Binary installation to `~/.apra-fleet/bin/`.
- Hooks, scripts, and data directories.
- The MCP server binary path and `stdio` protocol.

## Success Criteria
1. Running `apra-fleet.exe install --skill --llm gemini` successfully installs the PM skill and MCP config into the `~/.gemini/` directory.
2. The `SKILL.md` file no longer contains provider-specific hardcoding for the PM role.
3. The installer remains backwards compatible (defaulting to Claude).

## Technical Context
- **Primary Source File:** `src/cli/install.ts`
- **Related Files:** `skills/pm/SKILL.md`, `src/services/registry.ts`
- **Testing:** New integration tests must verify installation paths for both Claude and Gemini.
