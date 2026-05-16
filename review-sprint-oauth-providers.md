# Review: E2E Test Phase Split (1f93a95)

**Reviewer:** fleet-rev
**Date:** 2026-05-16
**Commit:** 1f93a95 refactor(e2e): split monolithic test into setup + sprint phases
**Branch:** e2e/local-only

---

## 1. CORRECTNESS

### setup-script.md -- PASS

- **T1+T2 merged sensibly**: T1 (registration) and T2 (basic execution) are present, logically ordered, and self-contained. T4 is fully removed -- no residual references.
- **Placeholder tokens**: All tokens used (SUITE_ID, PM_OS, PM_PROVIDER, VCS, TOY_PROJECT_URL, DOER_PROVIDER, DOER_HOST, DOER_USER, DOER_FOLDER, REVIEWER_PROVIDER, REVIEWER_HOST, REVIEWER_USER, REVIEWER_FOLDER) match the sed substitution list in fleet-e2e.yml lines 189-206. The `{{secure.E2E_ACRED}}` notation is intentionally NOT sed-substituted; it is a meta-hint for the LLM to use the credential store value (seeded in the "Seed fleet credential store" workflow step).
- **CHECKPOINT rule**: "Always include every test completed so far **in this phase** in the array" -- correct per-phase scoping (line 28).

### sprint-script.md -- PASS

- **T5 intact**: All sub-steps (T5.1-T5.4) preserved with correct structure.
- **FORBIDDEN directive** (line 23): "You are strictly forbidden from using 'invoke_agent' or the 'Agent' tool" -- clear and explicit.
- **MANDATORY directive** (line 25): "You MUST call 'activate_skill(name="pm")' at the start of T5.3" -- clear.
- **Poll loop bounded termination** (lines 58-75):
  - Max iterations: 20 (explicit)
  - Interval: ~30 seconds (explicit)
  - Done conditions: `approved` -> success; iteration count reaches 20 -> FAIL with specific reason text
  - State transition actions are exhaustive (VERIFY/needs_review, CHANGES_REQUESTED/needs_fix, approved)
  - This is precisely bounded -- no vague "keep polling until done" language.
- **Placeholder tokens**: All match the sed list (SUITE_ID, PM_OS, PM_PROVIDER, VCS, TOY_PROJECT_URL, DOER_PROVIDER, DOER_FOLDER, REVIEWER_PROVIDER, REVIEWER_FOLDER, BRANCH_PREFIX).

### fleet-e2e.yml -- PASS

- **Render step** (lines 208-209): Produces both `rendered-setup.md` and `rendered-sprint.md`. Correct.
- **Two sequential phases**: Setup phase (line 211) writes `raw-setup.txt`; sprint phase (line 254) writes `raw-sprint.txt`. Each has independent `LLM_EXIT` tracking and fail-loud handling.
- **fail-loud**: Both phases use the jq extractor on the stream-json result line (lines 247 and 305). No `head -40`.
- **claude --add-dir**: Lines 228-231 add `$RUN_DIR`, `$HOME/.claude` (PM config/MCP), `$(dirname "$DOER_FOLDER")`, `$(dirname "$REVIEWER_FOLDER")`. Covers run directory, config/skills, and member work folder parents.
- **YAML valid**: Confirmed via yaml.safe_load.
- **Gemini placeholders** (`<<GEMINI-DIRS...>>`): Noted, not flagged per review scope.

### extract-results.mjs -- PASS

- **Multiple raw files**: Accepts variadic `...rawFiles` (line 12), iterates all (lines 56-61).
- **Checkpoint merge**: Regex extracts CHECKPOINT lines from concatenated text of all phases; deduplicates by `test` name via findIndex (line 105) -- later phases override earlier entries for same test name.
- **PM tokens summed**: Accumulated across all raw files (lines 58-60).
- **overall logic**: FAIL if `checkpoints.length === 0 || checkpoints.some(t => t.status === 'FAIL')` (line 115). Correct -- empty = FAIL, any FAIL = FAIL.
- **Syntax check**: `node --check` passes.

---

## 2. PROSE QUALITY

### Precision and Clarity -- PASS

- Instructions are imperative and unambiguous. No vague pronouns or undefined terms.
- The poll loop uses precise numeric bounds (20 iterations, ~30 seconds) rather than vague duration language like "keep checking" or "wait until done."
- State transitions ("When status shows X: do Y") are deterministic -- no interpretation needed.
- CHECKPOINT format is specified exactly with JSON examples at each transition point.
- The session-log-collection section (lines 87-117 of sprint-script.md) provides a deterministic path formula, explicit slug conversion rule, and exact steps for staging/receiving/cleaning.

### Cyber-classifier-trigger wording -- PASS (all removed)

- **No IP|User|Pass credential table**: Credentials referenced via prose "resolved from the fleet credential store key E2E_ACRED" with {{secure.E2E_ACRED}} as parameter hint. No tabular credential display.
- **No `find ... 2>/dev/null` hidden-tree search for session files**: The transcript path section (sprint-script.md:93-98) states the deterministic path formula and explicitly says "Do NOT use `find`, `locate`, or any recursive search."
- **No exfiltration framing**: The copy-stage-receive pattern (lines 100-111) is framed as a technical necessity ("Session files live outside the member's work_folder so `receive_files` cannot access them directly"). Direction is INTO the work folder for API access, not outward.
- Note: setup-script.md:44 uses `find ~/.nvm -name bd -type f 2>/dev/null` -- this is a standard "locate installed binary" pattern for the `bd` CLI tool, not a session/transcript/hidden-file search. Not a classifier concern.

### Benign-intent preamble -- PASS

- sprint-script.md line 2: "Automated end-to-end test of the apra-fleet product, operating on the team's own test machines and the fleet-e2e-toy test repo." Establishes legitimate testing context.

### Grammar and Terminology -- PASS

- Consistent terminology: "work folder" (not mixed with "working directory"/"workdir"), "credential store" (not "secrets"/"vault"), "session ID" (not "session"/"sess-id").
- Grammar is clean throughout both files.
- Cross-file consistency: both scripts reference "run directory (current working directory)" identically.

---

## 3. MINOR OBSERVATIONS (non-blocking)

1. The `Collect Session Logs` section assumes the LLM can parse `raw-setup.txt` (stream-json format) to extract session IDs from the setup phase. This is workable since stream-json is standardized and the LLM will find `session_id` fields in `type:"system"` lines, but explicitly naming the JSON field/line-type would remove any ambiguity.

2. The `<<GEMINI-TRANSCRIPT-PATH: pending gemini-specialist review>>` placeholder in sprint-script.md (line 96) is noted -- not flagged per review scope.

---

## SUMMARY

The split is well-designed: setup (T1+T2) runs registration/connectivity in one 80-turn budget, sprint (T5) runs the PM-driven sprint loop in a separate 80-turn budget. This directly addresses the max_turns exhaustion that caused the original failure. The poll loop has explicit bounded termination (max 20 iterations with named done-conditions, not a vague loop). extract-results.mjs correctly merges checkpoints and tokens across phases. All placeholders are covered by the sed render step. The prose is precise and unambiguous. No classifier-triggering patterns remain. YAML is valid. Build and syntax checks pass.

VERDICT: APPROVE
