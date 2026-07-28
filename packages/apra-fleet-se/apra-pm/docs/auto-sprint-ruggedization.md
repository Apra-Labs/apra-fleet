# Auto-Sprint Ruggedization -- Design & Implementation Spec

Status: implemented. Branch: `ruggedize/auto-sprint-preflight-checkpoint`.

Known limitation: the concurrency lock uses a branch-keyed state file whose mtime acts as a
TTL heartbeat (`SPRINT_STATE_TTL_S = 3600`). It reliably blocks a *resume* that overlaps a
still-live run (the observed git-corruption incident), but two brand-new launches fired at the
exact same instant on the same branch can both pass the check before either writes the file
(a TOCTOU window at t=0, before any file exists). Launches are manual, so this is acceptable;
a hard mutex would need an atomic create (O_EXCL) which is a future refinement.

Note on parallel sprints: this lock prevents ACCIDENTAL overlap on the SAME branch. Running
two sprints DELIBERATELY on DIFFERENT branches still requires separate git worktrees, because
one working tree cannot be checked out to two branches at once (confirmed the hard way during
this very change, when another auto-sprint switched the shared checkout mid-edit).

This spec ruggedizes `.claude/workflows/auto-sprint.js` against the recurring failure
modes observed across projects (apra-pm, fleet-dashboard, apra-fleet). It is written so
the fixes live **inside the workflow product itself** -- auto-sprint must be self-contained
and must NOT depend on any operator's personal `~/.claude/CLAUDE.md` or memories to be safe.

## Global constraints (do not violate)

- **No `Date.now()` / `Math.random()` / argless `new Date()` in the workflow script.** They
  break resume. Time/randomness must come from a shell/node subprocess dispatched via
  `dispatchShell` (inside those subprocesses `Date.now()` is fine -- the ban is on the
  workflow script body only).
- **No TDZ.** Every `const`/`let` must be declared before any code path that reads it.
  New pure helpers go **before the `// PURE_FUNCTIONS_END` marker (line ~955)**. New
  module-level state (`let`) goes in the STATE section (~line 1099) or later, never
  referenced above its declaration.
- **Cross-platform.** Runs in Git Bash on Windows but must also work on macOS/Linux. Prefer
  `node -e "..."` for filesystem/time/stat operations over `stat -c`/`stat -f` (which differ
  by platform). `mkdir -p` is fine in the bash contexts already used.
- **Idempotent shell.** Every setup/preflight shell command must be safe to re-run (resume).
- Keep the byte-for-byte duplication note at line ~46 in mind, but `lib/parse-sprint-args.mjs`
  is out of scope unless arg parsing changes shape.

## Failure-mode -> fix map

| Mode | Fix | Gate behavior |
|------|-----|---------------|
| Wrong args format | `validateSprintArgs()` -- schema check, loud failure with expected shape | HARD-FAIL |
| Stale-main branching | `git fetch` + create sprint branch **from `origin/<base_branch>`**; verify base at latest | auto fetch+branch-from-origin; FAIL if fetch fails and base cannot be confirmed |
| Missing calibration fields | `assertCalibrationComplete()` after deep-merge -- fill missing/NaN numerics from DEFAULT_CALIBRATION | AUTO-HEAL + WARN |
| Missing-issues when all blocked | preflight root existence/open check + post-plan deadlock guard (ready==0 while open>0) with `blocked_by` diagnostic | HARD-FAIL with actionable diagnostic |
| Stale pinned model IDs | `checkModelAliasStaleness()` -- warn if any TIER_TO_MODEL value looks dated (`-\d{8}$`) | WARN |
| Concurrent runs corrupt checkout | branch-keyed lock in state file with mtime-based liveness (TTL) | FAIL if lock live |
| Mid-sprint crash re-does work / junk issues | phase-level `.state.json` checkpoint + resume (skip setup, resume at saved cycle/phase) | resume forward |
| Doer context exhaustion -> null -> work lost | `predictStreakFits()` -- proactively split a streak that won't fit usable context | split + requeue before dispatch |

## 1. Arg-schema validation (pure) -- HARD-FAIL, earliest

Add pure function before `PURE_FUNCTIONS_END`:

```js
// Validates the parsed sprint opts. Returns { ok:true } or { ok:false, error, detail }.
// Pure -- no I/O. Enforces the invocation contract in meta.description.
function validateSprintArgs(opts, rawArgs) {
  const expected = 'Expected a JSON OBJECT, e.g. {"issues":["BD-7"],"branch":"feat/x"}';
  if (opts == null || typeof opts !== 'object' || Array.isArray(opts) === false && false) { /* see below */ }
  const issues = opts.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return { ok:false, error:'invalid args: issues', detail:`"issues" must be a non-empty array of beads IDs. ${expected}. Received: ${JSON.stringify(rawArgs)}` };
  }
  if (!issues.every(s => typeof s === 'string' && s.trim().length > 0)) {
    return { ok:false, error:'invalid args: issues entries', detail:'every entry in "issues" must be a non-empty string beads ID' };
  }
  if (opts.branch != null && (typeof opts.branch !== 'string' || opts.branch.trim() === '')) {
    return { ok:false, error:'invalid args: branch', detail:'"branch" must be a non-empty string when provided' };
  }
  if (opts.goal != null && !['P1','P1/P2','P1/P2/P3'].includes(opts.goal)) {
    return { ok:false, error:'invalid args: goal', detail:'"goal" must be one of "P1" | "P1/P2" | "P1/P2/P3"' };
  }
  if (opts.max_cycles != null && !(Number.isInteger(Number(opts.max_cycles)) && Number(opts.max_cycles) > 0)) {
    return { ok:false, error:'invalid args: max_cycles', detail:'"max_cycles" must be a positive integer' };
  }
  if (opts.base_branch != null && (typeof opts.base_branch !== 'string' || opts.base_branch.trim() === '')) {
    return { ok:false, error:'invalid args: base_branch', detail:'"base_branch" must be a non-empty string when provided' };
  }
  return { ok:true };
}
```

Call site: immediately after the arg-parsing block (after `opts` is resolved, ~line 71,
before deriving `branch`/`rootIds`). If `!ok`, `log()` the detail and `return { error }`.
Note: bare-string / array arg forms are normalized to `{issues}` by the existing parser, so
they still pass. The check exists to catch genuinely malformed input with a helpful message.

## 2. Calibration completeness (pure) -- AUTO-HEAL + WARN

Add pure function before `PURE_FUNCTIONS_END`. It walks the numeric paths the cost/context
arithmetic actually reads and, for any missing or NaN value, fills from DEFAULT_CALIBRATION
and records a warning. Mutates a shallow-cloned calibration and returns `{ calibration, healed[] }`.

Required numeric paths to assert (fill from DEFAULT_CALIBRATION if missing/NaN):
- `model_prices_per_1m_output_tokens[cheap|standard|premium]`
- `complexity_buckets[S|M|L].doer_tokens`
- `reviewer_ratio.value`, `cycle_assumptions[optimistic|expected|pessimistic]`
- `fixed_overhead_tokens[setup|planner|plan_reviewer|harvester|ci_watcher|log_flush_per_cycle]`
- `input_cost_multiplier.value`
- `outlier_thresholds[notable_pct|outlier_pct|calibration_failure_pct]`
- `doer_token_ceiling[cheap|standard|premium]`
- `context_limits.model_context_tokens[cheap|standard|premium]` (NEW, see Sec. 7)
- `context_limits.autocompact_headroom_fraction`, `.base_prompt_tokens`, `.per_task_input_overhead_tokens`

Call site: right after the `const calibration = Object.assign(...)` deep-merge (~line 1245).
Replace `const calibration` usage so the healed object is used downstream; log each healed
path as `WARN: calibration field <path> missing/invalid -- healed to <default>`.

## 3. Model-alias staleness (pure) -- WARN

```js
function checkModelAliasStaleness(tierToModel) {
  const stale = [];
  for (const [tier, id] of Object.entries(tierToModel || {})) {
    if (typeof id === 'string' && /-\d{8}$/.test(id)) stale.push(`${tier}=${id}`);
  }
  return stale; // caller WARNs if non-empty
}
```
Call site: once during preflight (after TIER_TO_MODEL is in scope). WARN only.

## 4. Latest-HEAD / branch-from-origin -- AUTO-HEAL, FAIL on fetch failure

Modify the setup shell (`setupShellCmds`, ~line 1127). Requirements:
- Prepend a `git fetch origin --quiet && echo FETCHED || echo FETCH_FAIL` command; capture
  its output at a fixed index. (Renumber the "Fixed output indices" comment accordingly and
  update every `_outs[i]` read + the `SETUP_SCHEMA`/downstream index assumptions. Keep indices
  contiguous and documented.)
- Change branch creation so a NEW branch is cut from the freshest base:
  `git checkout "${branch}" 2>/dev/null || git checkout --track "origin/${branch}" 2>/dev/null || git checkout -b "${branch}" "origin/${base_branch}"`
  (the final clause now bases the new branch on `origin/<base_branch>` instead of stale local HEAD).
- After setup resolves, if fetch reported FETCH_FAIL: only FAIL if we cannot otherwise confirm
  the base is current. Simplest robust rule: FETCH_FAIL -> `log` a hard error and
  `return { error:'preflight: git fetch failed -- cannot guarantee branch is off latest ' + base_branch }`.
  (Auto-heal = the fetch itself; there is no safe silent fallback for a failed fetch.)
- Do NOT touch an existing sprint branch's base (resume must not rebase mid-flight).

## 5. Ready-work / deadlock guard -- HARD-FAIL with diagnostic

Two checks:

(a) **Root existence/open (startup, after setup):** shell `bd show <id> --json` for each root.
   - Any root that does not exist -> FAIL `preflight: root <id> not found`.
   - All roots already closed -> clean exit `{ done:true, reason:'all sprint roots already closed' }`
     (NOT an error; distinct from "missing issues").

(b) **Post-plan deadlock guard (inside loop, after plan approved, before develop):** when
   `planApproved` is true, fetch ready count for the subtree AND open count for the subtree.
   If `ready == 0 && open > 0`, the backlog is deadlocked (every leaf blocked). Emit a
   diagnostic that lists each open leaf and its `blocked_by` (the fleet-dashboard lesson:
   `bd dep cycles` misses parent-child deadlocks; inspect `blocked_by` on leaves), then
   `abortReason = 'deadlock: open issues but none ready'` and break the loop with a non-zero
   result. Reuse `getReadyStreaks` + a new small shell that lists open leaves w/ blocked_by.

## 6. Concurrency lock + phase-level checkpoint / resume

State file (branch-keyed, STABLE name so resume can find it across restarts):
`sprint-logs/.state/<sprintLogBranch>.state.json`

Shape:
```json
{
  "schema_version": 1,
  "branch": "...", "base_branch": "...", "rootIds": ["..."],
  "startedAt": "20260707_...", "repo": "/c/...", "transcriptDir": "...",
  "integTestEnabled": false, "calibrationRaw": "{...}",
  "cycle": 2, "lastGoodPhase": "Develop",
  "planApproved": true, "developComplete": false,
  "updatedAt": "20260707_..."
}
```
Liveness: mtime-based via node -- `AGE_S = (Date.now() - fs.statSync(f).mtimeMs)/1000` computed
in a node subprocess. `LOCK_TTL_S = 1800`. If a state file exists and `AGE_S < TTL` -> a run is
live -> FAIL `preflight: another auto-sprint run appears active on <branch> (state age <n>s < TTL)`.
If `AGE_S >= TTL` (or process crashed) -> treat as resumable.

Startup sequence (add a `readState`/`writeState` helper pair using `dispatchShell` with node):
1. Read state file + AGE via one node subprocess.
2. If live-lock -> FAIL.
3. If stale state exists for this branch+rootIds -> RESUME: skip the setup dispatch entirely,
   hydrate `repo/branch/base_branch/startedAt/transcriptDir/integTestEnabled/calibrationRaw`
   from state, set `cycleCount = state.cycle - 1` so the loop re-enters at the right cycle, and
   honor `planApproved`/`developComplete` to skip completed phases within that cycle.
4. Else fresh run -> after setup, write initial state.
5. **Heartbeat / checkpoint:** at each `phase(...)` transition and at cycle start, rewrite the
   state file with updated `lastGoodPhase`, `cycle`, and phase-completion flags. Rewriting the
   file updates mtime = heartbeat. Use a lightweight `dispatchShell` node write (these already
   happen at cycle start -- extend that write rather than adding new round-trips where possible).
6. On clean completion, delete the state file (`rm -f`) so a later run starts fresh.

Resume must guarantee: no re-run of setup, no re-plan when `planApproved`, no re-dispatch of a
completed Develop iteration set -- preventing duplicate/junk issue creation.

## 7. Streak context-fit predictor -- split before dispatch

New DEFAULT_CALIBRATION section:
```js
context_limits: {
  _doc: 'Doer context-window budgeting. Used to predict whether a ready-task streak will fit in the model usable context before autocompact/session-limit truncation, and to split streaks proactively. Keyed by tier.',
  model_context_tokens: { _doc:'Total context window per tier (tokens).', cheap: 200000, standard: 200000, premium: 200000 },
  autocompact_headroom_fraction: 0.72, // usable fraction of the window before autocompact/limit risk (observed doer failures at ~100K+ on Sonnet -> stay well under)
  base_prompt_tokens: 9000,            // fixed doer system+task prompt + repo orientation
  per_task_input_overhead_tokens: 3500,// per-task prompt + accumulated tool-result growth
  output_expansion_factor: 1.0,        // multiplier on estimated output tokens counted against context
},
```

Pure function before `PURE_FUNCTIONS_END`:
```js
// Predicts whether an in-order streak fits the doer's usable context and returns the
// longest prefix that does. Mirrors truncateStreakToCeiling's per-task token estimate.
// Returns { fittedIds, estContext, available, wouldOverflow }.
function fitStreakToContext(streakIds, bucketById, calibration, tier) {
  const cl = (calibration && calibration.context_limits) || {};
  const windowTokens = (cl.model_context_tokens || {})[tier];
  const frac = cl.autocompact_headroom_fraction;
  if (typeof windowTokens !== 'number' || typeof frac !== 'number' || windowTokens <= 0) {
    return { fittedIds: streakIds.slice(), estContext: 0, available: Infinity, wouldOverflow: false };
  }
  const available = windowTokens * frac;
  const base = cl.base_prompt_tokens || 0;
  const perTask = cl.per_task_input_overhead_tokens || 0;
  const outMul = cl.output_expansion_factor != null ? cl.output_expansion_factor : 1.0;
  // reuse the same output estimate as truncateStreakToCeiling
  const hist = (calibration && calibration.historical) || {};
  const buckets = (calibration && calibration.complexity_buckets) || {};
  const histToks = hist.bucket_avg_tokens || {};
  const estOut = id => {
    const b = bucketById ? bucketById[id] : undefined;
    const h = histToks[b];
    if (hist.sprints_sampled >= 1 && h != null) return Math.round(h);
    const def = buckets[b] || buckets.M || { doer_tokens: 0 };
    return def.doer_tokens || 0;
  };
  let sum = base, kept = [];
  for (const id of streakIds) {
    const cost = perTask + estOut(id) * outMul;
    if (kept.length > 0 && sum + cost > available) break; // always keep >=1
    kept.push(id); sum += cost;
  }
  return { fittedIds: kept, estContext: sum, available, wouldOverflow: kept.length < streakIds.length };
}
```

Integration (line ~1547): compute BOTH truncations and take the more restrictive prefix:
```js
const ceilFit = truncateStreakToCeiling(streak.ids, bucketById, calibration, streak.model);
const ctx = fitStreakToContext(streak.ids, bucketById, calibration, streak.model);
const fittedIds = ceilFit.length <= ctx.fittedIds.length ? ceilFit : ctx.fittedIds;
if (ctx.wouldOverflow && ctx.fittedIds.length <= ceilFit.length) {
  log(`Streak ${streak.model} context-limited: est ${Math.round(ctx.estContext)} tok > usable ${Math.round(ctx.available)} tok -- working ${fittedIds.length}/${streak.ids.length}, deferring ${streak.ids.length - fittedIds.length}`);
}
```
Deferred tasks resurface on the next `getReadyStreaks` iteration (existing behavior), so
splitting is safe and lossless.

## Verification per pass

After every edit: `node --check .claude/workflows/auto-sprint.js` must pass. A final grep must
confirm no new `Date.now(`/`Math.random(`/`new Date(` in the script body, and that every new
pure function sits above `PURE_FUNCTIONS_END`.

## Out of scope for this branch (file follow-up beads)

- Per-phase wall-clock timing (ledger `ts` field) -- mode E, separate issue.
- Cross-epic dependency validation in the planner -- mode G, separate issue.
