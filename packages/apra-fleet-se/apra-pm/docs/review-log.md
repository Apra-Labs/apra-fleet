# Code Review Log

Running record of issues found by deep review passes and the fixes applied.
Each entry records the finding, the affected file(s), and what was changed.

---

## Review pass 1 -- 2026-06-23 (tier-name refactor)

Scope: `feat/gh-6-7-8-9` branch -- provider-agnostic tier names, beads as
message bus, cost.js extraction, installer changes.

### Findings fixed

**R1-1 * `buildSprintSummary` fallback thresholds too aggressive**
- File: `.claude/workflows/auto-sprint.js` line 656
- Finding: fallback `{ outlier_pct: 50, calibration_failure_pct: 100 }` used
  when `calibration.outlier_thresholds` is absent; should match
  `DEFAULT_CALIBRATION` values (`outlier_pct: 200`, `calibration_failure_pct: 500`).
  4x too sensitive -- every early sprint triggered spurious calibration suggestions.
- Fix: changed fallback to `{ outlier_pct: 200, calibration_failure_pct: 500 }`.

**R1-2 * Pre-migration beads tasks with model-ID metadata silently ran at wrong tier**
- File: `.claude/workflows/auto-sprint.js` line 607
- Finding: `parseReadyStreaks` used `t.m || defaultModel` directly; tasks created
  before the `cheap/standard/premium` rename carried old model IDs (e.g.
  `claude-haiku-4-5`) which `resolveModel()` fell back to standard tier silently.
- Fix: added normalisation block -- reverse-lookup `MODEL_TO_TIER` map, emit
  `console.warn` (not `log` -- see R2-1), fall back to `defaultModel` with warning.

**R1-3 * `doerLabel` suffix extraction dead code**
- File: `.claude/workflows/auto-sprint.js` line 1228
- Finding: `.split('-').slice(-2,-1)[0]` was designed for hyphenated model IDs;
  with tier names (`cheap`, `standard`, `premium`) it just echoes the full name.
- Fix: simplified to `streak.model` directly.

**R1-4 * `cost.md` said taskAssignments `model` field is a provider model ID**
- File: `skills/pm/cost.md` line 98
- Finding: `"The model field is the provider-specific model ID"` -- contradicts the
  refactor; `computeSprintQuote` expects tier names.
- Fix: corrected to `"tier name (cheap/standard/premium)"` with concrete example.

---

## Review pass 2 -- 2026-06-24 (installer + cost.js extraction)

Scope: same branch -- `install.mjs` step 4, `cost.js` co-location, `__SKILL_DIR__`
placeholder, all skill `.md` files.

### Findings fixed

**R2-1 * `log()` inside `PURE_FUNCTIONS_BEGIN/END` block breaks vm isolation**
- File: `.claude/workflows/auto-sprint.js` lines 617, 620
- Finding: `parseReadyStreaks` (inside the pure block) called workflow-global
  `log()` for pre-migration model-ID warnings. When the block is extracted via
  `vm` or `require()` for testing, `log` is not defined -> `ReferenceError`.
  Exactly the migration path the code was meant to handle.
- Fix: replaced `log(...)` with `typeof console !== 'undefined' && console.warn(...)`
  (safe in any context). Also hoisted `KNOWN_TIERS` Set and `MODEL_TO_TIER` reverse
  map outside the per-task loop (were re-allocated every iteration).

**R2-2 * `install.mjs` `blockEnd` guard wrong when END marker missing**
- File: `install.mjs` line 270
- Finding: `blockEnd = fullSrc.indexOf('// PURE_FUNCTIONS_END') + markerLen`.
  If END is absent, `indexOf` returns `-1`; `-1 + 21 = 20`. Guard
  `blockEnd < blockStart` never fires (20 < thousands). Result: `slice(blockStart, 20)`
  produces empty garbage written silently to `cost.js`.
- Fix: capture `indexOf` result separately, check it for `-1` before adding length.
  Guard now: `blockStart < 0 || blockEnd < 0 || blockEnd <= blockStart`.

**R2-3 * `getReadyStreaks` passed legacy alias `MODEL_SONNET` as `defaultModel`**
- File: `.claude/workflows/auto-sprint.js` line 855
- Finding: should pass `TIER_STANDARD` (the canonical constant) not `MODEL_SONNET`
  (a legacy alias whose value happens to equal `TIER_STANDARD`). If the alias were
  ever reverted the default would silently become a model ID string.
- Fix: changed call to `parseReadyStreaks(..., TIER_STANDARD)`.

**R2-4 * `doer-reviewer-loop.md` said `"model":"<exact model id>"` in taskAssignments**
- File: `skills/pm/doer-reviewer-loop.md` lines 167, 175
- Finding: plan-reviewer template instructed agents to write provider model IDs;
  `computeSprintQuote` expects tier-name keys -> silent pricing failures.
- Fix: both occurrences changed to `"model":"<tier: cheap|standard|premium>"`.

**R2-5 * `sprint.md` had stale `~/.claude/workflows/auto-sprint.js` path**
- File: `skills/pm/sprint.md` line 114
- Finding: referenced the old path; `cost.js` now lives at `<skillDir>/cost.js`.
- Fix: updated to `<skillDir>/cost.js` with a pointer to `cost.md`.

**R2-6 * `cost.md` sprint log schema said `"model":"<model-id>"`**
- File: `skills/pm/cost.md` line 118
- Finding: `dispatch()` writes tier names to the `model` field; the schema example
  was misleading.
- Fix: changed to `"model":"<tier: cheap|standard|premium>"`.

**R2-7 * `__SKILL_DIR__` placeholder had no per-provider resolution table**
- File: `skills/pm/cost.md`
- Finding: only a prose hint for Claude; Gemini/AGY/OpenCode paths undocumented.
  Orchestrators on non-Claude providers would be unable to resolve the path.
- Fix: added a four-row table mapping each provider to its `__SKILL_DIR__` value.

**R2-8 * `simple-sprint.md` CHANGES NEEDED only mentioned `reopenIds`, not `newTasks`**
- File: `skills/pm/simple-sprint.md` line 32
- Finding: all other files document both arrays; the omission meant orchestrators
  on simple sprints would silently drop out-of-scope reviewer findings.
- Fix: updated step 6 to mention both `reopenIds` and `newTasks`.

**R2-9 * `beads.md` duplicate sentence**
- File: `skills/pm/beads.md` lines 19 and 25
- Finding: `"Tasks reference their track via assignee or label."` appeared verbatim
  twice in the same section -- edit artifact.
- Fix: removed the first occurrence.

**R2-10 * `cost-extraction.test.mjs` test fragility -- `costMod` loaded inside a test**
- File: `test/cost-extraction.test.mjs`
- Finding: `costMod` was populated inside the "require succeeds" test body; if
  `require()` threw, all 9 downstream tests would fail with the misleading message
  `"cost.js not loaded"` instead of the actual error.
- Fix: moved the extraction, write, and `require()` to module-level (top of file).
  If it throws, the whole test file fails immediately with the real error. Removed
  the now-redundant `assert.ok(costMod, 'cost.js not loaded')` guards.
