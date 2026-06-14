# OpenCode PM Epic -- Phase 4 Review (Agent Installation System)

**Reviewer:** fleet-rev
**Date:** 2026-06-14 01:05:00+05:30
**Verdict:** APPROVED

---

## 1. Build + Tests

PASS. `npm run build` succeeds (tsc clean). `npm test` passes: 89 test files, 1460 tests passed, 7 skipped (1 file skipped -- auth-terminal-wait platform-conditional). Zero failures.

---

## 2. T4.1: agentsDir in ProviderInstallConfig

PASS. `ProviderInstallConfig` interface extended with `agentsDir: string | undefined` (config.ts:57). `getProviderInstallConfig` returns correct values per provider:

| Provider | agentsDir |
|----------|-----------|
| claude | `~/.claude/agents` |
| gemini | `~/.gemini/agents` |
| agy | `~/.gemini/antigravity-cli/agents` |
| opencode | `~/.config/opencode/agents` |
| codex | `undefined` |
| copilot | `undefined` |

All match spec exactly.

---

## 3. T4.2: Agent Install Step

PASS. install.ts:706-733 adds a conditional agent install step:
- `installAgents = installPm && paths.agentsDir !== undefined` -- agents install only when PM is installed AND provider supports agents.
- Step numbering is dynamic: `totalSteps` incremented by 1 when `installAgents` is true; output shows `[8/9]` for agents, `[9/9]` for Beads.
- Agents sourced from `vendor/apra-pm/agents/` with `dist/agents` fallback (install.ts:722-723).
- SEA manifest includes agents (gen-sea-config.mjs:49,59,97).
- Codex/Copilot skip silently: verified by real install -- no agent directories created, no log output about agents.
- Existing install.test.ts updated correctly: step assertions loosened from `[8/8]` to `Installing Beads task tracker...` to accommodate dynamic step counts.

---

## 4. T4.3: Agent Transform (Key Deliverable)

PASS. `transformAgentForOpenCode` (agent-transform.ts:36-74) correctly converts Claude frontmatter to OpenCode format. Verified by real install to temp dir:

| Agent File | edit | write | bash | mode | name | description |
|------------|------|-------|------|------|------|-------------|
| doer.md | allow | allow | allow | subagent | DROPPED | Preserved verbatim |
| planner.md | deny | allow | allow | subagent | DROPPED | Preserved verbatim |
| plan-reviewer.md | deny | allow | allow | subagent | DROPPED | Preserved verbatim |
| reviewer.md | deny | allow | allow | subagent | DROPPED | Preserved verbatim |

All match the REQUIRED outputs from the task spec exactly. Markdown body content preserved verbatim across all four agents (verified by real file inspection).

Transform applied ONLY for `llm === 'opencode'` (install.ts:715,728). Confirmed Claude install produces raw Claude-format frontmatter (name, description, tools fields intact, no mode/permission fields).

Design section 6 alignment: transform logic follows the specified pseudocode -- `edit` from `Edit` tool presence, `write` always `allow`, `bash` from `Bash` tool presence, `name` dropped, `mode: subagent` added.

Edge cases handled:
- Missing `tools` field: falls back to `buildDefaultPermissionMap()` returning `{edit: deny, write: allow, bash: deny}` -- safe defaults.
- Unknown tool names: ignored (only Edit, Write, Bash inspected; unknown names like `FutureTool` pass through harmlessly).
- Missing frontmatter: returns content unchanged.

NOTE (not blocking): `buildPermissionMap` line 27 has `write: toolSet.has('Write') ? 'allow' : 'allow'` -- both branches return `'allow'`. This matches the design spec verbatim (`write: <'allow' if 'Write' in tools, else 'allow'>`). The ternary is intentionally always-true to document that write is unconditionally allowed. Acceptable as-is.

---

## 5. T4.4: Test Quality

PASS. Two new test files with meaningful assertions:

**agent-transform.test.ts** (8 tests):
- Tests each of the 4 agent files with specific permission assertions (not just `toContain('allow')` but checking each permission key individually).
- Verifies `name` field is dropped, `description` preserved, `mode: subagent` present.
- Verifies body content preserved verbatim (slice comparison at body start).
- Edge cases: missing tools field, unknown tools, no frontmatter.

**install-multi-provider.test.ts** additions (agent section, 6 tests):
- Tests `claude`, `gemini`, `agy` each install 4 agent files.
- Tests `opencode` installs 4 transformed agent files (with `mode: subagent`, no `name` field).
- Tests `codex`, `copilot` skip agent install (no agents dir created).
- Assertions check frontmatter content, not just file existence.

---

## 6. Critical Consistency Check: Transform vs Phase 3 Permission Config

PASS. Phase 3 `composePermissionConfig` (opencode.ts:166-171):
- doer: `{ edit: 'allow', write: 'allow', bash: 'allow' }`
- reviewer: `{ edit: 'deny', write: 'allow', bash: 'allow' }`

Phase 4 transformed agent permissions:
- doer.md: `edit: allow, write: allow, bash: allow`
- reviewer.md: `edit: deny, write: allow, bash: allow`
- plan-reviewer.md: `edit: deny, write: allow, bash: allow`

CONSISTENT. The `write: allow` for reviewer matches the fix applied in 1c24108. No mismatch detected.

---

## 7. File Hygiene

PASS. `git diff --stat 1c24108..HEAD` shows exactly 6 files changed:

- `src/cli/agent-transform.ts` (new) -- transform logic
- `src/cli/config.ts` -- agentsDir addition
- `src/cli/install.ts` -- agent install step
- `tests/agent-transform.test.ts` (new) -- transform tests
- `tests/install-multi-provider.test.ts` -- agent install tests
- `tests/install.test.ts` -- step numbering fix

No stray artifacts, no config files, no unrelated changes. Clean diff.

---

## Summary

All 7 VERIFY 4 criteria pass. The agent installation system is correctly implemented with install-time transform for OpenCode, raw copy for Claude/Gemini/AGY, and silent skip for Codex/Copilot. The transform output is consistent with Phase 3's permission composition. Test coverage is thorough with content-level assertions. File hygiene is clean.

**Verdict: APPROVED**
