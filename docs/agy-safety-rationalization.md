# Architecture & Safety Rationalization: Google Antigravity (agy) Integration

This document rationalizes the design decisions, safety mechanisms, and compatibility considerations implemented for the Google Antigravity CLI (provider key: "agy") support in apra-fleet.

---

## 1. Executive Summary

The "feat/agy-support" branch introduces Google Antigravity CLI ("agy") as a primary, PM-capable LLM provider alongside "claude", while demoting the slower legacy "gemini" provider adapter.

Integration safety was verified against the following criteria:
- Isolation: Integration must not corrupt global configuration settings or conflict with other tool environments.
- Security: Credentials must be encrypted at rest, transmitted securely, and never leaked in execution logs.
- Stability: Unsupported options (such as live log tailing or model flags) must fail back gracefully without crashing execution pipelines.

The integration has achieved 100% test pass rate across 1,290+ unit and integration tests.

---

## 2. Installation & Cleanup Safety (install.ts / uninstall.ts)

### Change Rationalization
Unlike Claude or Gemini, the Antigravity CLI reads its global configurations (MCP servers and hooks) from separate JSON files located in a centralized config directory:
- MCP Config: "~/.gemini/config/mcp_config.json"
- Hooks Config: "~/.gemini/config/hooks.json"

### Safety Mechanisms
- Surgical Merging: The installer ("src/cli/install.ts") does not overwrite these files. Instead, it reads the existing JSON, initializes the target configuration blocks if missing, and merges the "apra-fleet" configuration.
- Isolated Scope: The merged config is isolated:
  - Hooks: Only hooks matching "apra-fleet" are registered.
  - MCP: Only the "apra-fleet" server is registered under "mcpServers".
- Precision Uninstallation: During uninstallation, the cleanup scripts ("src/cli/uninstall.ts") read these files and delete only the "apra-fleet" hook matchers and MCP server entry, leaving all other user-configured tools and settings untouched.
- Directory Safeguards: All write operations utilize "fs.mkdirSync(..., { recursive: true })" to prevent errors if the directories do not exist.

---

## 3. Authentication & Credential Isolation (provision-auth.ts)

### Change Rationalization
Antigravity utilizes the "GEMINI_API_KEY" environment variable to authenticate requests. We unified authentication provisioning to support local and remote members securely.

### Safety Mechanisms
- Local Exemption: Local members automatically skip LLM auth provisioning as they run on the host machine and inherit active host credentials directly.
- Remote Encryption: For remote members, if an API key is supplied or collected:
  - The plaintext key is transferred securely over the SSH channel.
  - The key is written to the remote shell profiles (e.g. .bashrc, .bash_profile) using OS-specific commands.
  - The key is stored in the local registry encrypted using the "encryptPassword" utility.
- OOB Fallback: If no API key is specified, the system falls back to Out-Of-Band (OOB) prompt collection, requesting the user to enter the key in a secure prompt, avoiding credential storage in command history.
- OAuth Safety: Agy returns "supportsOAuthCopy() -> false" and "oauthCredentialFiles() -> null", ensuring that no OAuth credential copy routines (which are Claude-specific) are executed.

---

## 4. Permission Composition & Execution Isolation (agy.ts / compose-permissions.ts)

### Change Rationalization
When a member executes a task, it must run under a strictly bounded execution profile to prevent privilege escalation or recursive loops (e.g. the member invoking the fleet server recursively).

### Safety Mechanisms
- Localized Directory Config: "permissionConfigPaths()" returns ".gemini/antigravity-cli/settings.json". This writes permission settings relative to the workspace folder of the active task, confining the member's sandbox to that repository.
- Loop Prevention: "composePermissionConfig" generates the following configuration:
  - Disables the "apra-fleet" MCP server on the member: "mcpServers: { 'apra-fleet': { disabled: true } }".
  - Disables fleet orchestration skills: "skillOverrides: { pm: 'off', fleet: 'off' }".
  This completely prevents recursive prompt dispatch loops where the agent could attempt to orchestrate itself.

---

## 5. Execution & Command Routing Safety (execute-prompt.ts)

### Change Rationalization
We added custom model tier mappings ("cheap", "standard", "premium") and model list validation to ensure that execution dispatches remain robust.

### Safety Mechanisms
- Curated Tier Validation: To prevent invalid model names from being passed to providers, we introduced three curated model arrays in "src/cli/config.ts" ("CURATED_CHEAP_MODELS", "CURATED_STANDARD_MODELS", "CURATED_PREMIUM_MODELS"). These are enforced via Zod schemas during member registration and update.
- Flag Suppression: Antigravity CLI does not support a native "--model" command-line flag (it selects the model based on its settings/profile). "AgyProvider.modelFlag()" returns an empty string "". This avoids syntax errors during execution command generation, preventing failures when custom models are configured on the member.

---

## 6. Session Resume & Log Polling Limitations (log-path-resolver.ts)

### Change Rationalization
Agy supports session resumption via the "--conversation <sessionId>" flag. However, it stores conversation logs in a binary Protocol Buffer format (".pb") under "~/.gemini/antigravity-cli/conversations/<sessionId>.pb", unlike Claude's text-based JSONL files.

### Safety Mechanisms & Graceful Fallback
- Log Polling Skip: Tail-polling binary files is highly error-prone and would result in corrupted output or crash the log parsing parser. Thus, "resolveSessionLogPath" explicitly throws an error for "agy":
  "Unsupported log polling for provider: agy"
- Graceful Degradation: The execution harness catches this exception and falls back to transport-level inactivity monitoring (silence timeout) and wall-clock total timeouts.
- Thread Safety: Prompt execution remains fully functional and robust. The only trade-off is that the PM server relies on console output/timeouts rather than parsing internal agent log files during prompt execution, which is the identical safe fallback behavior used for Codex and Copilot.

---

## 7. Verification Results

- All 1,290+ vitest tests pass successfully, confirming that the new "agy" adapter does not introduce regressions to Claude, Gemini, Codex, or Copilot.
- The single-executable installer build ("npm run build:binary") successfully compiles with all multi-provider config modifications packaged.
