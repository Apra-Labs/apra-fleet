# Reviewer Feedback

## Task apra-fleet-96j: Missing agy Absence Assertions

**Issue:** Two agy absence assertions are missing from `tests/install-multi-provider.test.ts`.

### Details

**AC Criterion 2** states `auto-sprint.js` must be absent for providers other than claude. Tests cover opencode and gemini ("auto-sprint.js is NOT written to ~/.claude/workflows/ for opencode install", "...for gemini install") but there is no corresponding test for agy.

**AC Criterion 3** states `Skill(auto-sprint)` and `Workflow(auto-sprint)` must be absent for opencode, gemini, AND agy. Tests cover opencode and gemini absence ("Skill(auto-sprint) and Workflow(auto-sprint) are absent from opencode settings", "...from gemini settings") but there is no test for agy.

### Required Additions

1. A test named e.g. "auto-sprint.js is NOT written to ~/.claude/workflows/ for agy install" -- calls `runInstall(['--llm', 'agy'])` using `setupWorkflowMocks()` and asserts `fileState.has(path.join(mockHome, '.claude', 'workflows', 'auto-sprint.js'))` is false.

2. A test named e.g. "Skill(auto-sprint) and Workflow(auto-sprint) are absent from agy settings" -- calls `runInstall(['--llm', 'agy'])` using `setupWorkflowMocks()` and asserts the agy settings.json (path.join(mockHome, '.gemini', 'antigravity-cli', 'settings.json')) does not contain `Skill(auto-sprint)` or `Workflow(auto-sprint)` in `permissions.allow`.

### Verification

All other criteria are fully met:
- Build passes cleanly (tsc)
- 1529 tests pass
- cost.js coverage for all four providers is complete
- 8-agent coverage for claude/gemini/agy/opencode is complete
- opencode.json no-top-level-permissions assertion is present
