# Review: Fleet-less E2E Suite (s10) -- Commits 9db658c, cc110b5, 9c7a837 (+f56f7ac)

**Verdict: APPROVED**

Reviewer: reviewer agent
Branch: feat/opencode-pm-epic
Date: 2026-06-14

---

## Summary

Four commits add fleet-less (local-subagent-only) e2e coverage (s10), fix the `opencode run` invocation form across all existing e2e calls, relabel the s*.1-3 suite description, and fix CI submodule checkouts. All deliverables are correct, well-scoped, and do not regress existing suites.

## Criteria Results

### 1. Build + Tests

- `npm install && npm run build`: clean (tsc, zero errors)
- `npm test`: **1510 passed**, 7 skipped, 91 test files passed, 1 skipped
- `tests/validate-sprint.test.ts`: 6 meaningful tests exercising `evaluateGates()` -- all-pass fixture plus one failing-case test per gate (pr-exists, commits, final-changeset-clean, process-discipline, beads-closed). Not tautologies -- each test flips one input and asserts the specific gate fails with a meaningful detail string.

### 2. Fleet-lessness

- `local-sprint-script.md`: explicitly instructs "Do NOT use any fleet server, fleet MCP tools, member registration, member pairing, or remote prompt dispatch."
- `grep -Ein 'register_member|execute_prompt|/pm pair|fleet_status'` returns 0 matches across all three files (local-sprint-script.md, run-lite-e2e.mjs, fleet-lite-e2e.yml).
- The s10 flow uses only `/pm plan`, `/pm start`, `/pm cleanup` with local subagents. No fleet registration or pairing anywhere.

### 3. run-lite-e2e.mjs Correctness

- Reads `lite-suites.json`, clones the toy repo, renders `local-sprint-script.md` with token substitution (`{{REPO}}`, `{{BRANCH}}`, `{{TOY_PROJECT_URL}}`, `{{VCS}}`).
- Claude: `-p prompt --model sonnet --output-format stream-json` (correct).
- OpenCode: `opencode run <prompt> --format json --dangerously-skip-permissions` (positional, NOT --prompt).
- Invokes `validateSprint()` imported from `./validate-sprint.mjs` (line 16, called at line 109) -- confirmed this is the shared validator's first e2e consumer.
- `node --check`: passes (exit 0).
- Includes PR capture, teardown, result artifact write, and timeout handling.

### 4. fleet-lite-e2e.yml

- Trigger: `workflow_dispatch` ONLY. No `push`, `pull_request`, or `schedule` triggers present.
- Builds fleet binary then runs `install --force --llm <provider>`.
- Verifies `SKILL.md` + 4 agents (planner, plan-reviewer, doer, reviewer) at the correct config dir.
- Pre-flight subagent dispatch check present (dispatches a test subagent, asserts SUBAGENT-OK + PMLITE-READY).
- Checkout uses `submodules: recursive`.
- `E2E_GH_TOKEN` wired as both `GH_TOKEN` and `E2E_GH_TOKEN` env vars.
- YAML parses cleanly.

### 5. lite-suites.json

- Valid JSON (confirmed via python3 json.load).
- Two suites: s10.1 (claude) and s10.2 (opencode with ollama/qwen3-coder:30b).
- Gemini/agy intentionally excluded (noted in `_comment`).
- Relaxed gates: `minCommits: 4`, `expectedIssues: 3` -- reasonable for a small local-subagent sprint on the toy repo.

### 6. File Hygiene

- Exactly 7 files in diff range (5 new, 2 modified): lite-suites.json, local-sprint-script.md, run-lite-e2e.mjs, ci.yml, fleet-e2e.yml, fleet-lite-e2e.yml, validate-sprint.test.ts.
- No stray artifacts, no deletions, no unrelated changes.
- ASCII-only verified across all 5 new/primary files (grep -P '[^\x00-\x7F]' returns 0 matches each).

### 7. Cohesion with #304

- fleet-e2e.yml changes are limited to: 4 opencode `--prompt` -> positional fixes + 1 suite description relabel. No regression to s1-s9 logic.
- ci.yml addition (`submodules: recursive` on all checkout steps) is a valid companion fix -- tests that read vendor/apra-pm files need the submodule initialized.
- The s10 suite is entirely additive (new workflow, new runner, new config, new tests).

## Notes

- The 4th commit (f56f7ac) adds `submodules: recursive` to ci.yml. Not listed in the original 3 deliverables but is a necessary fix for test correctness and is cleanly scoped.
- validate-sprint.test.ts inlines the `evaluateGates` logic rather than importing from the .mjs file. This is intentional (noted in the file comment) to avoid subprocess overhead in unit tests. The logic mirrors the source faithfully.

## Verdict

**APPROVED** -- all 7 criteria pass. The fleet-less e2e suite is well-constructed, properly isolated from fleet concerns, and does not regress existing suites.
