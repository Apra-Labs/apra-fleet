# Review: Commits 96f2afd + 7895b2d — sprint/ux-quality-fixes
**Reviewer:** fleet-rev  
**Date:** 2026-04-06  
**Verdict: APPROVED**

---

## Checklist Results

### 1. npm test — PASS
619 passed + 4 skipped (623 total). All 41 test files green. The 4 skipped tests are pre-existing (not introduced by these commits). Meets the ≥620 expectation.

### 2. Install key is plain `apra-fleet` across all 4 providers — PASS
`mcpKey = 'apra-fleet'` set at line 331 of `src/cli/install.ts`. All four provider code paths (Claude `claude mcp add`, Gemini `mergeGeminiConfig`, Codex `mergeCodexConfig`, Copilot `mergeCopilotConfig`) receive and use this single constant. No versioned key anywhere.

### 3. Stale key cleanup is correct — PASS
`cleanupStaleMcpServers()` checks both `mcpServers` and `mcp_servers` dicts. The guard condition `(key.startsWith('apra-fleet-') || key.startsWith('apra-fleet_')) && key !== mcpKey` is precise: it only removes keys that begin with the exact versioned prefixes used by previous releases and skips the new plain key. No risk of removing unrelated entries (any non-`apra-fleet-*` / `apra-fleet_*` key is untouched).

### 4. `version` tool correctly wired — PASS
`src/tools/version.ts` exports `versionSchema` (empty `z.object({}`), no inputs required) and `version()` which returns `` `apra-fleet ${serverVersion}` ``. Wired in `src/index.ts` under the `'version'` tool name with the correct description. Import and registration are clean.

### 5. Remote tmp path fix is correct — PASS
`promptFilePath` is now constructed **after** `agent` is resolved (line 94–96 in `execute-prompt.ts`). The ternary `agent.agentType === 'local' ? os.tmpdir() : '/tmp'` correctly routes: local members (including the Windows PM host) use `os.tmpdir()`, remote SSH members (macOS/Linux) use `/tmp`. This directly fixes the regression where a Windows `os.tmpdir()` path (`C:\Users\...\AppData\Local\Temp`) was sent to remote SSH members. The `path.join(tmpDir, promptFileName)` then builds a valid path for both branches.

### 6. No other regressions — PASS
The whitespace-only blank line left in the Claude install block (where the legacy `claude mcp remove` try/catch was removed) is cosmetic only. All tests pass. No functional regressions detected.

---

**APPROVED** — both commits are correct, targeted, and well-tested. Ready to merge.
