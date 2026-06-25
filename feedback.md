## Summary

Build: PASS. Tests: 92 files passed, 1521 tests passed, 8 todo. No regressions.

---

## Task results

### apra-fleet-34m -- APPROVED
`src/cli/agent-transform.ts` lines 7-8: mirror comment added correctly referencing `apra-pm/install.mjs:transformAgentForOpenCode`. No behavior change. Acceptance criteria met.

### apra-fleet-a0p -- APPROVED
`src/cli/install.ts` lines 791-796: `/auto-sprint` and `/pm` example lines printed when `llm === 'claude' && installPm`, placed immediately after the install summary block. Output strings match the spec in requirements.md Requirement 3 verbatim. Acceptance criteria met.

### apra-fleet-8rd -- APPROVED
Commit `aa4868d` documents the crosstalk audit result. No fleet MCP tool references found in auto-sprint.js; no auto-sprint internals in `skills/fleet/SKILL.md`. No code changes were required. Acceptance criteria met.

### apra-fleet-96j -- CHANGES NEEDED (task reopened)

The acceptance criteria says "Add assertions in tests/install-multi-provider.test.ts for: (1) cost.js present for all providers when PM installed -- contains computeSprintQuote, no agent()/phase() calls; (2) auto-sprint.js in ~/.claude/workflows after claude install, absent for others; (3) Skill/Workflow(auto-sprint) in claude settings, absent for opencode/gemini/agy."

Items 4 and 5 are satisfied:
- Item 4 (all 8 agents land): active tests added for claude/gemini/agy/opencode at `tests/install-multi-provider.test.ts` lines ~853-955.
- Item 5 (opencode.json no top-level permissions key): already covered by the pre-existing test at line 961 (`OPENCODE_FORBIDDEN_KEYS` includes `'permissions'`).

Items 1-3 are NOT satisfied. They are present only as `it.todo(...)` stubs (8 stubs total, lines ~957-976 in the branch version of the test file). The stubs carry a comment "requires B1/B2 cost extraction step" / "requires B2" / "requires B3 perms step", indicating that Requirement 1 (cost.js extraction + auto-sprint.js workflow copy, `src/cli/install.ts` AssetManifest + runInstall step) and Requirement 2 (claude-only Skill(auto-sprint)/Workflow(auto-sprint) permissions, `buildRequiredPerms` / `mergePermissions`) from requirements.md are not yet implemented in install.ts on this branch. Without those installer changes, active tests for items 1-3 would fail, which is why .todo stubs were used.

Required rework for apra-fleet-96j: implement Requirement 1 and Requirement 2 from requirements.md in `src/cli/install.ts` (and supporting scripts `scripts/gen-sea-config.mjs`, `scripts/vendor-pm.mjs`), then convert the 8 `.todo` stubs into active `it()` assertions that verify the installed artifacts. Until the installer actually writes cost.js and auto-sprint.js and appends the permissions entries, "assertions" for those behaviors cannot be meaningfully added.

No unrelated file hygiene issues found. The `sprint-logs/` files are expected workflow artifacts.
