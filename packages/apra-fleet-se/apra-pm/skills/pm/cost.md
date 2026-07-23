# Cost Quoting and Calibration

pm produces sprint cost quotes and post-sprint analyses using the same pure
JavaScript functions as the auto-sprint workflow. No arithmetic is done in prose --
all numbers come from deterministic JS. Node.js (v18+) is required; the orchestrator
checks for it at setup and warns the user if it is absent (cost features are skipped,
everything else runs normally).

## Source of the functions

`install.mjs` extracts the pure functions from `auto-sprint.js` at install time
and writes them as a self-contained CommonJS module to `cost.js` in the same
directory as this file (`<configDir>/skills/pm/cost.js`). It is refreshed
automatically on every install run -- no `--force` needed. On Claude Code, the
full `auto-sprint.js` is additionally copied to `~/.claude/workflows/auto-sprint.js`
so the `/auto-sprint` workflow works natively.

The orchestrator loads the functions with a plain `require()` using `__SKILL_DIR__`
(the absolute path to the skill directory, available in the orchestrator context):

```bash
node -e "
const { computeSprintQuote } = require('__SKILL_DIR__/cost.js');
const fs    = require('fs');
const calib = JSON.parse(fs.readFileSync('sprint-logs/calibration.json', 'utf8'));
const ta    = JSON.parse(process.env.TASK_ASSIGNMENTS);
process.stdout.write(JSON.stringify(computeSprintQuote(ta, calib)));
"
```

Replace `__SKILL_DIR__` with the absolute path for your provider:

| Provider | `__SKILL_DIR__` |
|----------|----------------|
| Claude   | `~/.claude/skills/pm` |
| Gemini   | `~/.gemini/skills/pm` |
| AGY      | `~/.gemini/antigravity-cli/skills/pm` |
| OpenCode | `~/.config/opencode/skills/pm` |

Pass inputs via `process.env` (for JSON blobs) or inline literals. Capture stdout
and parse as JSON.

## Calibration file

`sprint-logs/calibration.json` is the single source of truth for pricing, bucket
sizes, cycle assumptions, and historical averages. It is shared between auto-sprint
and pm -- they update the same file so historical data accumulates regardless of
which harness ran the sprint.

Keys in `model_prices_per_1m_output_tokens` and `role_models` are **tier names**
(`cheap`, `standard`, `premium`), not provider-specific model IDs. The mapping from
tier name to actual model ID lives exclusively in `TIER_TO_MODEL` inside
`auto-sprint.js` -- the single place to update when models change. This makes
`calibration.json` provider-agnostic and reusable across Claude, AGY, OpenCode, etc.

- **On first run** (file absent): the setup step bootstraps it from `DEFAULT_CALIBRATION`
  inside `cost.js` (same object the workflow uses). Write it with:
  ```bash
  node -e "
  const { DEFAULT_CALIBRATION } = require('__SKILL_DIR__/cost.js');
  const fs = require('fs');
  fs.mkdirSync('sprint-logs', { recursive: true });
  fs.writeFileSync('sprint-logs/calibration.json', JSON.stringify(DEFAULT_CALIBRATION, null, 2));
  "
  ```
  Replace `__SKILL_DIR__` with the absolute path to the pm skill directory.
- **On subsequent runs**: read it, deep-merge with `DEFAULT_CALIBRATION` (so new
  fields added to the source always have a default), and use the result.

## Setup check (once per sprint)

```bash
node --version 2>/dev/null || echo MISSING
```

If `MISSING`: warn the user that cost quoting is unavailable, skip all cost steps,
continue the sprint normally. If Node.js is present, proceed with calibration load /
bootstrap as above.

## Phase 3 -- quote after plan APPROVED

After the plan-reviewer returns APPROVED with `taskAssignments` (id + bucket + model
per task -- see `doer-reviewer-loop.md` plan-reviewer template), the orchestrator:

1. Writes `taskAssignments` to a temp env var or file.
2. Runs `computeSprintQuote(taskAssignments, calibration)` via the node snippet above.
3. Logs the quote (opt/expected/pessimistic scenarios, calibration source).
4. Writes per-task cost estimates back to beads notes:
   ```bash
   bd update <id> --notes="cost-estimate: bucket=<B> model=<M> doer_tokens=<N> reviewer_tokens=<N> output_usd=<N>"
   ```
   Dispatch a single cheap-tier agent to run all `bd update` commands in one pass.

The `taskAssignments` array shape (matches the plan-reviewer role schema,
`agents/schemas/plan-reviewer-output.json`).
The `model` field is the **tier name** (`cheap`/`standard`/`premium`) read from the
task's assigned model tier in its beads metadata (`--metadata '{"model": "<tier>"}'`)
-- never a provider-specific model ID:
```json
[{ "id": "BD-10", "bucket": "M", "model": "standard" }, ...]
```

## Harvest -- analysis and calibration update

At sprint close, after the harvester runs:

1. **Compute analysis**: run `computeSprintAnalysis(quote, logEntries, calibration,
   actualCycles)`. `logEntries` is the sprint log JSONL (see Sprint log below) read
   and parsed from `sprint-logs/<branch>-<startedAt>.jsonl`. If the log file does not
   exist (pm ran without logging), pass `[]` for logEntries -- the analysis degrades
   gracefully to estimates-only.
2. **Build summary**: run `buildSprintSummary(analysis, quote, calibration, opts)`
   where `opts = { branch, goal, goalMet, cycleCount, tasksCompleted, tasksOpen,
   startedAt }`. Write the returned `summaryText` to
   `sprint-logs/<branch>-<startedAt>.analysis.md` and commit it.
3. **Update calibration**: run `computeUpdatedCalibration(calibration, analysis,
   startedAt, taskAssignments, logEntries)` and write the result back to
   `sprint-logs/calibration.json`. Commit it. This blends the actual token counts
   into the historical averages so future quotes improve.
4. **Update fleet token memory**: Parse the `tuple_averages` from the updated
   calibration object into a flat array: `const tokenEstimates = { averages: Object.values(updatedCalibration.historical?.tuple_averages || {}) }`. Then write it to the beads persistent memory:
   `bd remember '<json_string>' --key token-estimates-json`

## Sprint log

pm appends one JSONL record per dispatch to `sprint-logs/<branch>-<startedAt>.jsonl`
so `computeSprintAnalysis` can compare estimates to actuals. Each record:

```json
{ "ts": "<ISO timestamp>", "cycle": 1, "phase": "Develop", "label": "doer-c1-i1",
  "model": "<tier: cheap|standard|premium>", "context": "tasks BD-10, BD-11",
  "outTokens": 1234, "costUsd": 0.0185 }
```

The orchestrator appends after each dispatch using a cheap-tier agent (same
`appendNewEntries` pattern as auto-sprint). The `label` format `<role>-c<N>-i<M>`
is required -- `computeSprintAnalysis` strips the suffix to recover the role name.

If the harness/CLI does not expose per-subagent token counts, record
`outTokens: 0` and `costUsd: 0` -- the analysis will show actuals as zero but the
estimate side still works and calibration is not corrupted.

## Node.js invocation pattern for all functions

All five functions follow the same extract-and-call pattern. Reference:

| Function | When | Inputs | Output |
|---|---|---|---|
| `computeSprintQuote` | After plan APPROVED | `taskAssignments`, `calibration` | quote object with scenarios |
| `computeSprintAnalysis` | Harvest | `quote`, `logEntries`, `calibration`, `actualCycles` | analysisText + byRole |
| `buildSprintSummary` | Harvest | `analysis`, `quote`, `calibration`, `opts` | summaryText markdown |
| `computeUpdatedCalibration` | Harvest | `calibration`, `analysis`, `startedAt`, `taskAssignments`, `logEntries` | updated calibration object |
| `DEFAULT_CALIBRATION` | Setup bootstrap | -- | JSON to write to calibration.json |

Never hardcode prices, bucket sizes, or cycle assumptions -- always read them from
`calibration.json` (or `DEFAULT_CALIBRATION` on first bootstrap). The file is the
single source of truth shared across all sprint harnesses.
