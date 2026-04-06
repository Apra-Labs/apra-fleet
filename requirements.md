# Requirements: Bug Fixes & API Cleanup Sprint

**Issues:** #83, #84, #85, #87, #88, #89
**Branch:** `sprint/skill-refactor`
**Base branch:** `main`
**Repo:** `C:\akhil\git\apra-fleet`

---

## Issue #89 — execute_prompt: agent CWD is /tmp instead of work folder

### Problem
`execute_prompt` sets the agent's working directory to the OS temp directory (`/tmp` or `os.tmpdir()`) instead of the member's registered work folder. The prompt file is correctly written to tmpDir, but `promptOpts.folder` is also set to `tmpDir` — meaning `buildAgentPromptCommand` launches the Claude Code agent with CWD in `/tmp`.

### Root cause
`src/tools/execute-prompt.ts:97,112` — `tmpDir` is used for both the prompt file location AND the agent launch folder. These should be separate: the prompt file goes in tmpDir, but the agent should launch in `agent.workFolder`.

### Expected behavior
The launched agent's CWD should be `agent.workFolder` (the member's project directory). The prompt file can remain in tmpDir.

### Acceptance criteria
- Agent launches with CWD = `agent.workFolder`
- Prompt file still written to tmpDir (no change)
- `buildAgentPromptCommand` receives `folder: agent.workFolder` and a separate prompt file path
- Existing tests updated to verify CWD

---

## Issue #88 — compose_permissions: ledger lost when project_folder omitted

### Problem
When `project_folder` is not provided to `compose_permissions`, the ledger defaults to `{ stacks: [], granted: [] }` — discarding any prior grant history. Additionally, on reactive grants, the ledger is only saved when `project_folder` is provided, meaning mid-sprint grants can be silently lost.

### Root cause
`src/tools/compose-permissions.ts:156` — `loadLedger` is conditionally called. No warning is returned when ledger is unavailable.

### Fix
1. Return a warning in the response when `project_folder` is omitted and grants are being applied (caller should know grants won't persist)
2. Ensure the ledger guard is documented in the skill doc

### Acceptance criteria
- Warning message when granting permissions without `project_folder`
- Existing grants still accumulate correctly when `project_folder` IS provided
- Test coverage for the no-project-folder path

---

## Issue #87 — member_detail: `claude.version` and `claude.auth` hardcoded for all providers

### Problem
`member_detail` returns auth and version info under the `claude` key (`result.claude = { version, auth }`) regardless of the actual LLM provider. For non-Claude members (Gemini, Codex, Copilot), this is misleading.

### Root cause
`src/tools/member-detail.ts:146` — field name `claude` is hardcoded, ignoring `agent.llmProvider`.

### Fix
Rename the field to `cli` or make it provider-agnostic (e.g., `result.cli = { version, auth }`). Update skill docs that reference `claude.version` or `claude.auth`.

### Acceptance criteria
- Field name reflects the generic nature (not provider-specific)
- Skill docs updated
- Backwards-compatible or documented as breaking change

---

## Issue #85 — execute_command: work_folder not documented in skill docs

### Problem
`execute_command` supports an optional `work_folder` parameter (tool schema, line 16) that overrides the member's registered folder. This parameter is not mentioned in skill docs, so the PM skill doesn't know it exists.

### Root cause
`skills/fleet/SKILL.md` lists `execute_command` but doesn't document the `work_folder` override.

### Fix
Add `work_folder` parameter documentation to the fleet skill doc's `execute_command` section.

### Acceptance criteria
- Skill doc describes `work_folder` parameter, its default, and when to use it

---

## Issue #84 — provision_auth: inconsistent tool name in skill docs and OOB calls

### Problem
The tool is registered as `provision_auth` in `src/index.ts:95`. Inside `src/tools/provision-auth.ts:252`, the OOB fallback passes the hardcoded string `'provision_auth'` to `collectOobApiKey`. Skill docs reference `provision_auth` correctly in the fleet skill table but may have stale references elsewhere.

### Fix
Audit all references to `provision_auth` / `provision-auth` across skill docs and source code. Ensure consistent naming.

### Acceptance criteria
- All skill doc references use the registered tool name `provision_auth`
- No stale `provision-auth` (hyphenated) references remain

---

## Issue #83 — update_task_tokens: clarify token accumulation and git-failure behavior

### Problem
`update_task_tokens` accumulates tokens correctly and handles git commit failure gracefully (returns warning). However, the tool's behavior on git failure is not documented — callers may not know that tokens are persisted even when the commit fails.

### Root cause
`src/tools/update-task-tokens.ts:104-119` — git commit is best-effort, but this isn't clear in the tool description or skill docs.

### Fix
1. Update tool description to clarify best-effort git commit behavior
2. Update fleet skill doc to note that tokens are persisted to file regardless of git commit result
3. Ensure the warning message on git failure is clear and actionable

### Acceptance criteria
- Tool description mentions best-effort commit
- Skill doc updated
- Warning message includes guidance (e.g., "manually commit progress.json")
