# Plan Review Findings — Issue #40: provision_auth env var visibility

**Reviewer:** Claude Opus 4.6
**Date:** 2026-04-01
**Plan:** PLAN.md
**Requirements:** requirements.md

---

## Checklist

### 1. Does every task have clear "done" criteria?
**PASS** — Every task has a "Done:" section with specific, testable outcomes (e.g., "returns 5 commands (was 4)", "command string includes auth env export prefix").

### 2. High cohesion within each task, low coupling between tasks?
**PASS** — Each task touches 1-2 files with a single concern. Tasks communicate only through the `Agent` type and `buildAuthEnvPrefix()` helper.

### 3. Are key abstractions and shared interfaces in the earliest tasks?
**PASS** — Task 1 introduces both the `encryptedEnvVars` type field and the `buildAuthEnvPrefix()` helper that Tasks 2, 4, and 5 depend on.

### 4. Is the riskiest assumption validated in Task 1?
**PASS** — The riskiest assumption is that inline env var injection works across platforms. Task 1 builds and unit-tests the helper in isolation before integration in Phase 2.

### 5. Later tasks reuse early abstractions (DRY)?
**PASS** — Tasks 4 and 5 both import and reuse `buildAuthEnvPrefix()` from Task 1. No duplication.

### 6. 2-3 work tasks per phase, then a VERIFY checkpoint?
**PASS** — Phase 1: 3 tasks + VERIFY, Phase 2: 2 tasks + VERIFY, Phase 3: 3 tasks + VERIFY, Phase 4: 2 tasks + VERIFY.

### 7. Each task completable in one session?
**PASS** — All tasks are small (1-2 files, clear scope). None require multi-session effort.

### 8. Dependencies satisfied in order?
**PASS** — Type + helper (T1) → storage (T2) → injection (T4/T5) → rename/fix (T6/T7) → cleanup (T8) → tests (T9/T10). Correct dependency ordering.

### 9. Any vague tasks that two developers would interpret differently?
**FAIL** — Task 8 is vague: "Verify that `remove_member` flow naturally cleans up `encryptedEnvVars` via registry deletion. If stored keys need explicit zeroing before delete, add that." Two developers would disagree on whether explicit zeroing is needed. The task should state a clear decision: either (a) registry deletion is sufficient and no code changes are needed, or (b) add explicit zeroing of the encrypted values before deletion. Currently it reads as "investigate and decide" which is design work, not implementation.

### 10. Any hidden dependencies between tasks?
**PASS** — No hidden dependencies detected. Task 3 (macOS .zshenv) is independent of the injection path. Task 7 (Gemini fix) is independent of env var work.

### 11. Does the plan include a risk register?
**FAIL** — No dedicated risk register section. Task 4 has an inline risk note ("Must ensure prefix is applied to ALL command builds") but there is no consolidated register covering:
- **Encrypted value size limits** — `agents.json` grows with each stored key. No limit mentioned.
- **Shell escaping edge cases** — API keys with special characters (quotes, backslashes, dollar signs) in inline export could break commands.
- **Race condition** — Two concurrent `provision_auth` calls could clobber `encryptedEnvVars` since `updateAgent()` does a read-merge-write.
- **Long-running tasks** — Explicitly deferred but `execute_command`'s nohup wrapper script does NOT get env vars injected, which could silently break long-running Gemini commands.

### 12. Does the plan align with requirements.md intent?
**FAIL** — The plan solves the right problem (inline injection), but has these discrepancies with requirements:

| Requirement | Plan | Issue |
|------------|------|-------|
| Fix `setEnv()` on Windows to use PowerShell | Omitted entirely | **Not a bug:** Windows `setEnv()` already uses `[Environment]::SetEnvironmentVariable()`. Requirements are incorrect here. Plan should note this explicitly rather than silently omitting. |
| Rename `CLAUDE_PATH` across `linux.ts` and `macos.ts` | Plan targets `linux.ts` and `windows.ts` | **Plan is correct:** `CLAUDE_PATH` exists in `linux.ts` and `windows.ts`, not `macos.ts`. Requirements have a typo. Plan should call this out. |
| Update `revoke_vcs_auth` to clean up stored env vars | Plan says "No changes needed to `revoke_vcs_auth`" | **Reasonable** but should explain why (VCS auth tokens are separate from LLM API keys). |
| Plan Task 6 says `CLAUDE_PATH` is "not exported" | `linux.ts` line 6: `const CLAUDE_PATH` | Verified correct — it is indeed a local `const`. |

---

## Additional Findings

1. **Windows escaping gap:** `buildAuthEnvPrefix()` mentions single-quote escaping for Windows, but the existing `windows.ts:envPrefix()` method (line 153) already implements this pattern (`value.replace(/'/g, "''")`). The plan should reference this existing method or explain why it builds its own escaping.

2. **Out-of-scope justification:** The plan defers long-running task env var injection as "out of scope." Requirements don't explicitly allow this deferral. Since the nohup wrapper script in `execute_command` (lines 38-73) generates a bash script written to disk, env vars would need to be written into the script — a different mechanism than inline prefix. The deferral is reasonable but should be captured as a known limitation with a follow-up issue.

3. **Integration tests missing:** Requirements specify integration tests (`provision_auth` → `execute_prompt` on Gemini member, Gemini session resume). The plan's Phase 4 only includes unit tests. This is a gap — either add integration test tasks or explicitly defer with justification.

---

## Verdict

**CHANGES NEEDED**

Three items must be addressed before implementation:

1. **Task 8 ambiguity** — Resolve the "verify and maybe add" language. State the decision clearly.
2. **Risk register** — Add a consolidated risk section covering escaping edge cases, concurrent provision_auth, and long-running task limitation.
3. **Requirements discrepancies** — Add explicit notes in the plan for each deviation from requirements (Windows setEnv already correct, CLAUDE_PATH file targets, revoke_vcs_auth exclusion, integration test deferral) so the plan is self-documenting and doesn't leave reviewers guessing.
