# Implementation Plan: MCP API & Usability Sprint (Issues #50–53)

**Branch:** `improve/token-usage`  
**Baseline:** 604 tests passing  
**Date:** 2026-04-04

---

## Phase 6: MCP Server Title (#50)

### Task 1: Update MCP server name string
- **File:** `src/index.ts:73`
- **Change:** `apra-fleet ${serverVersion}` → `apra fleet server ${serverVersion}`
- **Why:** Users and tooling cannot tell this is the fleet *server* — the word "server" is missing

### VERIFY
- [ ] `npm run build` succeeds
- [ ] `npm test` — 604 tests pass
- [ ] Commit: `fix(#50): add 'server' to MCP title string`

---

## Phase 7: Name Lookup in member_detail (#51)

### Task 2: Modify getAgentOrFail to accept name fallback
- **File:** `src/utils/agent-helpers.ts`
- **Change:** 
  - Import `findAgentByName` from registry
  - In `getAgentOrFail()`, if `getAgent(id)` returns undefined, try `findAgentByName(id)` before returning error
- **Why:** Option B from requirements — all tools benefit from DRY fix

### Task 3: Update member_detail schema description
- **File:** `src/tools/member-detail.ts:13`
- **Change:** `'The UUID of the member (worker) to inspect'` → `'UUID or friendly name of the member (worker) to inspect'`

### Task 4: Add tests for name lookup
- **File:** `tests/agent-helpers.test.ts` (or add to existing test file)
- **Tests:**
  - `getAgentOrFail` returns agent when given valid UUID
  - `getAgentOrFail` returns agent when given valid name
  - `getAgentOrFail` returns error string when neither UUID nor name matches

### VERIFY
- [ ] `npm run build` succeeds
- [ ] `npm test` — all tests pass (should be 604+)
- [ ] Manual test: `member_detail({ member_id: "focus-dev1" })` works
- [ ] Commit: `fix(#51): accept member name in getAgentOrFail`

---

## Phase 8: Branch Display (#52)

### Task 5: Add lastBranch to Agent type
- **File:** `src/types.ts`
- **Change:** Add `lastBranch?: string;` to Agent interface (after line 27, near other optional fields)

### Task 6: Add gitCurrentBranch to OsCommands interface
- **File:** `src/os/os-commands.ts`
- **Change:** Add method signature:
  ```ts
  gitCurrentBranch(folder: string): string;
  ```

### Task 7: Implement gitCurrentBranch for all OS targets
- **Files:** `src/os/linux.ts`, `src/os/macos.ts`, `src/os/windows.ts`
- **Implementation:** Return `git -C "<folder>" branch --show-current 2>/dev/null || true`
  - The `|| true` ensures non-zero exit (not a git repo) doesn't throw
  - Windows: same command works in bash/git-bash

### Task 8: Fetch and display branch in member_detail
- **File:** `src/tools/member-detail.ts`
- **Changes:**
  1. After resources section (~line 195), add branch fetch:
     ```ts
     let branch: string | undefined;
     try {
       const branchResult = await strategy.execCommand(cmds.gitCurrentBranch(agent.workFolder), 10000);
       const branchName = branchResult.stdout.trim();
       if (branchName) {
         branch = branchName;
         updateAgent(agent.id, { lastBranch: branch });
       }
     } catch { /* not a git repo — ignore */ }
     ```
  2. Add `branch` to result object if defined (~line 196)
  3. In compact output (~line 219), append branch to resources line if present

### Task 9: Display cached branch in fleet_status
- **File:** `src/tools/check-status.ts`
- **Changes:**
  1. Add `branch?: string` to `AgentStatusRow` interface (~line 32)
  2. In `checkAgent()`, set `row.branch = agent.lastBranch` if defined
  3. In compact output loop (~line 223), include branch in line if present

### Task 10: Add tests for branch handling
- **Tests:**
  - member_detail with git repo includes branch in output
  - member_detail without git repo omits branch gracefully
  - fleet_status shows cached lastBranch

### VERIFY
- [ ] `npm run build` succeeds
- [ ] `npm test` — all tests pass
- [ ] Commit: `feat(#52): display git branch in member_detail and fleet_status`

---

## Phase 9: execute_prompt Schema Tiers (#53)

### Task 11: Update execute_prompt model description
- **File:** `src/tools/execute-prompt.ts:20`
- **Change:** Replace description with:
  ```ts
  'Model tier ("cheap", "standard", "premium") or a specific model ID for power users. Prefer tier names — the server resolves them to the correct model per provider. If omitted, defaults to the standard tier. Applies to both new and resumed sessions.'
  ```
- **Why:** Lead with tier names, remove provider-specific model ID examples that become stale

### VERIFY
- [ ] `npm run build` succeeds
- [ ] `npm test` — all tests pass
- [ ] Commit: `fix(#53): lead with tier names in execute_prompt model description`

---

## Final VERIFY

- [ ] All 4 issues addressed (#50, #51, #52, #53)
- [ ] `npm run build && npm test` — no regressions
- [ ] Each task committed with issue reference
- [ ] Branch ready for PR

---

## Assumptions Verified

| Assumption | Verified |
|------------|----------|
| `getAgent(id)` only does UUID lookup | Yes — `registry.ts:95-96` |
| `findAgentByName(name)` exists separately | Yes — `registry.ts:99-103` |
| `updateAgent(id, updates)` can persist `lastBranch` | Yes — accepts `Partial<Agent>` |
| OsCommands interface is in `os-commands.ts` | Yes — lines 11-61 |
| All 3 OS implementations exist | Yes — linux.ts, macos.ts, windows.ts |
| `git branch --show-current` works on all platforms | Yes — available in git 2.22+ (2019) |
| AgentStatusRow is local to check-status.ts | Yes — lines 25-34 |
| execute_prompt schema at line 20 | Yes — confirmed |
