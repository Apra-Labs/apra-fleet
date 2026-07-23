export const meta = {
  name: 'auto-sprint',
  description: `Multi-cycle sprint workflow: plan -> develop -> test -> harvest. Pass args as a JSON object with required "issues" (array of beads IDs) and "branch"; invoke the auto-sprint-args skill for the full argument contract.`,
  phases: [
    { title: 'Plan' },
    { title: 'Develop' },
    { title: 'Test' },
    { title: 'Harvest' },
  ],
};

// Multi-cycle sprint workflow. Drives 8 agents against a beads backlog until a
// priority-based quality goal is met or the cycle ceiling is reached.
//
// Agent roster:
//   planner           -- reads open beads sprint goals/features/bugs, creates feature+task DAG
//   plan-reviewer     -- validates DAG: coverage, task size, acceptance criteria
//   doer              -- works bd-ready tasks (impl and test-dev), VERIFY checkpoint
//   reviewer          -- reviews doer output, can reopen tasks
//   deployer          -- follows deploy.md ONLY (deploy + smoke test); never the playbook
//   integ-test-runner -- owns integ-test-playbook.md end to end (setup/reset/teardown),
//                        executes tests, closes features, files bugs/enhancements
//   ci-watcher        -- polls CI; creates beads task if not configured
//   harvester         -- docs, CHANGELOG, token summary, PR
//
// Beads owns all work items and is the exit signal.
// JS workflow owns all routing. No LLM ever decides whether to continue.
//
// args (JSON object serialised to string by the Workflow runtime):
//   branch           -- sprint branch (required); asserted/created at startup
//   issues           -- beads issue IDs to implement (sprint roots), e.g. ["BD-1","BD-2"] (required)
//   goal             -- exit criterion: "P1" | "P1/P2" | "P1/P2/P3"  (default: "P1/P2")
//   max_cycles       -- hard ceiling on sprint cycles                  (default: 5)
//   requirementsFile -- optional context file for the planner          (default: none)
//   base_branch      -- PR target                                      (default: "main")
//   skip_dolt_push   -- skip the Harvest "bd dolt push" when true        (default: false)

// NOTE: the arg-parsing block below is intentionally duplicated from lib/parse-sprint-args.mjs,
// which exists only for unit testing (workflow scripts cannot import arbitrary files).
// Keep both in sync when modifying parsing logic.
//
// Accepted forms:
//   "BD-1"                          bare issue ID
//   "BD-1 BD-2"                     space/comma-separated issue IDs
//   ["BD-1","BD-2"]                 JSON array of issue IDs
//   {"issues":["BD-1"],"goal":"P1"} JSON object (full control)
//
// branch always defaults to the current git branch when omitted.
let opts = {};
if (args) {
  let parsed = null;
  try { parsed = JSON.parse(args); } catch {}

  if (Array.isArray(parsed)) {
    opts = { issues: parsed };
  } else if (parsed && typeof parsed === 'object') {
    opts = parsed;
  } else {
    // bare string: treat as space/comma-separated issue IDs
    const ids = String(args).split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    opts = { issues: ids };
  }
}

// PREFLIGHT (arg schema) -- validate the parsed opts against the invocation contract
// before doing any work. Fails loudly with the expected shape so a malformed launch
// (e.g. args passed as a JSON string, missing issues, bad goal) is caught immediately
// rather than surfacing as a confusing mid-run error. See docs/auto-sprint-ruggedization.md.
const _argCheck = validateSprintArgs(opts, args);
if (!_argCheck.ok) {
  log(`ERROR: ${_argCheck.error} -- ${_argCheck.detail}`);
  return { error: _argCheck.error };
}

let branch             = opts.branch           || '';   // empty = auto-detect in setup; reassigned after setup resolves
const rawIssues        = opts.issues            || [];
const rootIds          = Array.isArray(rawIssues) ? rawIssues : [rawIssues];
const goal             = opts.goal             || 'P1/P2';
const maxCycles        = Number(opts.max_cycles) || 5;
const requirementsFile = opts.requirementsFile  || '';
const base_branch      = opts.base_branch       || 'main';

if (rootIds.length === 0) {
  log('ERROR: at least one beads issue ID is required (pass as arg: /auto-sprint BD-1)');
  return { error: 'missing issues' };
}

// Goal -> numeric priority threshold.
// Exit when open LEAF work in the sprint-goal subtree at priority <= threshold reaches
// zero -- open type=task (plus type=feature when integ tests run), excluding the roots
// themselves (roots close only at Harvest, so counting them would make goalMet unreachable).
const GOAL_THRESHOLD = { 'P1': 1, 'P1/P2': 2, 'P1/P2/P3': 3 };
const threshold = GOAL_THRESHOLD[goal] || 2;

// PURE_FUNCTIONS_BEGIN -- extracted by test/sprint-cost.test.mjs via vm; keep this block self-contained

// Provider-agnostic tier names. These are the only strings that appear in
// calibration.json and in dispatch calls. Provider-specific model IDs live
// exclusively in TIER_TO_MODEL below -- the single place to update when models change.
const TIER_CHEAP    = 'cheap';
const TIER_STANDARD = 'standard';
const TIER_PREMIUM  = 'premium';

// Bare model-family aliases -- agent()/CLI dispatch resolves these to the
// current generation automatically, so this never goes stale as Anthropic
// ships new models. Do not pin to a dated model ID here.
const TIER_TO_MODEL = {
  [TIER_CHEAP]:    'haiku',
  [TIER_STANDARD]: 'sonnet',
  [TIER_PREMIUM]:  'opus',
};

// Legacy aliases kept so existing dispatch call-sites (model: MODEL_OPUS etc.) are unchanged.
const MODEL_OPUS   = TIER_PREMIUM;
const MODEL_SONNET = TIER_STANDARD;
const MODEL_HAIKU  = TIER_CHEAP;

// ------------------------------------------------------------------ schemas
//
// NOTE: REVIEW_SCHEMA, PLAN_REVIEW_SCHEMA, DOER_STATUS_SCHEMA,
// INTEG_RUN_SCHEMA, CI_SCHEMA, and HARVEST_SCHEMA (the role-contract schemas)
// are declared just below PURE_FUNCTIONS_END, not here -- they are loaded
// from agents/schemas/<role>.json via require()/fs.readFileSync(), which is
// I/O and therefore must NOT live inside the PURE_FUNCTIONS_BEGIN/END block
// (that block is extracted verbatim via `new Function(...)` by
// test/sprint-cost.test.mjs and by install.mjs's cost.js generation step,
// both of which require it to be self-contained pure data/functions with no
// require() and no filesystem access). See the role-schemas section right
// after the end-of-pure-functions marker below for the loader and the
// apra-fleet-unw.21 rationale.
//
// The schemas below (SHELL_OUTPUTS_SCHEMA, SETUP_SCHEMA,
// BEADS_BLOCKERS_SCHEMA, READY_STREAKS_SCHEMA) are workflow-private, not role
// contracts -- they are plain data literals with no I/O, so they safely stay
// inline here.

const SHELL_OUTPUTS_SCHEMA = {
  type: 'object', required: ['outputs'],
  properties: {
    outputs: { type: 'array', items: { type: 'string' } },
  },
};

const SETUP_SCHEMA = {
  type: 'object', required: ['repo', 'branch', 'deployMdExists', 'playbookExists', 'startedAt'],
  properties: {
    repo:           { type: 'string' },
    branch:         { type: 'string' },
    deployMdExists: { type: 'boolean' },
    playbookExists: { type: 'boolean' },
    startedAt:      { type: 'string', description: 'yyyymmdd_hhmmss from date +%Y%m%d_%H%M%S' },
    calibrationRaw: { type: 'string' },  // verbatim stdout of cat calibration.json; JS parses it
    transcriptDir:  { type: 'string', description: 'Directory where subagent JSONL conversation logs are written (best-effort; may be empty string if not resolvable)' },
  },
};

const BEADS_BLOCKERS_SCHEMA = {
  type: 'object', required: ['count', 'ids'],
  properties: {
    count: { type: 'number' },
    ids:   { type: 'array', items: { type: 'string' } },
  },
};

// One entry per model streak: tasks sharing the same model that can be worked
// in a single doer dispatch. Ordered by priority (P0 first).
const READY_STREAKS_SCHEMA = {
  type: 'object', required: ['streaks', 'totalCount'],
  properties: {
    totalCount: { type: 'number' },
    streaks: {
      type: 'array',
      items: {
        type: 'object', required: ['model', 'ids'],
        properties: {
          model: { type: 'string' },
          ids:   { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

// CI_SCHEMA and INTEG_RUN_SCHEMA are role contracts and are declared, along
// with the other role-contract schemas, just below PURE_FUNCTIONS_END.

// Returned by the resume-check agent at the top of every cycle.
// planDone   -- true if the sprint goal already has children AND every feature has at
//               least one task with non-empty acceptance criteria; skip plan loop.
// inProgressIds -- tasks currently in_progress; reset to open before the develop
//                  loop so a crashed doer never orphans work forever.

// ------------------------------------------------------------------ helpers

function approved(review) {
  return review && typeof review.verdict === 'string' && review.verdict.trim() === 'APPROVED';
}

// Live pricing for dispatch cost tracking. Initialized from DEFAULT_CALIBRATION;
// synced to calibration.json values after setup() returns.
// Prices are output tokens only in USD per 1M. Source: Anthropic pricing 2026-06-04.
// Keys are tier names (cheap/standard/premium), not model IDs.
// See also: sprint-logs/calibration.json model_prices_per_1m_output_tokens.
let OUTPUT_PRICE_PER_M = {
  [TIER_CHEAP]:    5.00,
  [TIER_STANDARD]: 15.00,
  [TIER_PREMIUM]:  25.00,
};

// ------------------------------------------------------------------ CALIBRATION DEFAULTS
// Single source of truth for all estimation constants. On first sprint run the setup
// agent writes this to sprint-logs/calibration.json; subsequent runs read that file.
// To change prices or buckets: update this object -- the file is regenerated next run.
const DEFAULT_CALIBRATION = {
  _doc: 'Sprint cost calibration. All estimation constants live here -- nothing is hardcoded in agents. Fields named _doc are documentation strings; skip them when reading values. The historical section is written automatically by the harvester after each sprint; do not edit it manually.',
  schema_version: 1,
  model_prices_per_1m_output_tokens: {
    _doc: 'USD per 1M output tokens, keyed by tier name (cheap/standard/premium). Source: Anthropic published pricing 2026-06-04. Update when pricing changes. Provider-specific model IDs are resolved from tier names in auto-sprint.js TIER_TO_MODEL -- they never appear in this file.',
    [TIER_CHEAP]:    5.00,
    [TIER_STANDARD]: 15.00,
    [TIER_PREMIUM]:  25.00,
  },
  role_models: {
    _doc: "Tier name per workflow role. 'doer' and 'reviewer' are NOT here -- the planner sets tier per task in beads metadata; reviewer escalates to max(task_tier, standard). Change an entry here to reroute a role to a different tier.",
    'setup':             TIER_CHEAP,
    'planner':           TIER_PREMIUM,
    'plan-reviewer':     TIER_STANDARD,
    'deployer':          TIER_STANDARD,
    'integ-test-runner': TIER_STANDARD,
    'ci-watcher':        TIER_CHEAP,
    'harvester':         TIER_STANDARD,
    'log-flush':         TIER_CHEAP,
    'check-blockers':    TIER_CHEAP,
    'ready-streaks':     TIER_CHEAP,
  },
  doer_model_fallback: {
    _doc: 'Tier assumed for doer cost estimation when a task has no tier metadata in beads. In practice the planner always sets tier metadata -- this is a safety net only.',
    model: TIER_STANDARD,
  },
  reviewer_model_rule: {
    _doc: 'Reviewer tier is max(doer_task_tier, minimum). If the doer used premium, reviewer uses premium; otherwise reviewer uses standard. This mirrors the reviewerModel selection in auto-sprint.js.',
    minimum: TIER_STANDARD,
  },
  complexity_buckets: {
    _doc: 'Estimated doer output tokens per task by complexity bucket S/M/L. Plan-reviewer assigns a bucket to each task by reading its description. historical.bucket_avg_tokens overrides these defaults once enough sprint data has been collected.',
    S: { _doc: 'Small: 1 file, narrow scoped change -- rename, config key, simple wiring, pure boilerplate', doer_tokens:  600 },
    M: { _doc: 'Medium: 2-3 files, moderate logic -- new API endpoint, test suite, small focused refactor',  doer_tokens: 1400 },
    L: { _doc: 'Large: 3+ files or non-trivial design -- new auth flow, data migration, cross-cutting refactor', doer_tokens: 2800 },
  },
  reviewer_ratio: {
    _doc: 'Reviewer estimated output tokens as a fraction of doer tokens for the same task. 0.4 means reviewer uses ~40% as many output tokens as the doer. Overridden by historical.reviewer_ratio_avg when available.',
    value: 0.4,
  },
  cycle_assumptions: {
    _doc: "Expected number of dev/review cycles. Per-task cost is multiplied by these to produce sprint-level cost scenarios. Update 'expected' if your team consistently lands at a different cycle count.",
    optimistic: 1.0, expected: 1.5, pessimistic: 2.5,
  },
  fixed_overhead_tokens: {
    _doc: "Estimated output tokens for agents that run once per sprint regardless of task count. 'log_flush_per_cycle' is multiplied by the expected cycle count. Keys use underscores; the role lookup strips underscores to match role_models keys.",
    setup:               200,
    planner:            2000,
    plan_reviewer:      1500,
    harvester:          3000,
    ci_watcher:          300,
    log_flush_per_cycle: 100,
  },
  input_cost_multiplier: {
    _doc: 'Multiply output-only USD estimate by this to approximate true cost (input + output). 4.0 is conservative for long-context agents. Replace with an empirical ratio once the workflow harness exposes input token counts.',
    value: 4.0,
  },
  outlier_thresholds: {
    _doc: 'Percentage deviation bands used to classify estimation accuracy in the sprint analysis report.',
    notable_pct:              50,
    outlier_pct:             200,
    calibration_failure_pct: 500,
  },
  doer_token_ceiling: {
    _doc: 'Maximum output tokens for a single doer streak, keyed by tier name. Streaks that exceed this token budget are split and re-queued.',
    cheap:    40000,
    standard: 80000,
    premium:  150000,
  },
  context_limits: {
    _doc: 'Doer context-window budgeting. Used to predict whether a ready-task streak will fit in the model usable context before autocompact/session-limit truncation, and to split streaks proactively. Keyed by tier.',
    model_context_tokens: { _doc: 'Total context window per tier (tokens).', cheap: 200000, standard: 200000, premium: 200000 },
    autocompact_headroom_fraction: 0.72, // usable fraction of the window before autocompact/limit risk (observed doer failures at ~100K+ on Sonnet -> stay well under)
    base_prompt_tokens: 9000,            // fixed doer system+task prompt + repo orientation
    per_task_input_overhead_tokens: 3500,// per-task prompt + accumulated tool-result growth
    output_expansion_factor: 1.0,        // multiplier on estimated output tokens counted against context
  },
  parallelism: {
    _doc: 'Doer concurrency (EXPERIMENTAL -- default 1 = proven serial path). When max_doers>1, independent bd-ready tasks are fanned out into isolated git worktrees, worked by one doer each in parallel, then merged back into the sprint branch sequentially with a conflict->re-queue fallback. This path is NOT yet default: on s10 (win32) it hit cross-platform worktree fragility (worktree "already exists" leak on re-create, and worktree-branch merges landing nothing -> 0 commits). Until that is hardened and validated on all runner OSes, max_doers stays 1 so sprints use the pre-parallelism serial path (which commits doers directly on the sprint branch, no worktree/merge machinery). Set >1 to opt into the experimental parallel path. Width is also capped by the harness concurrency limit and the number of ready tasks. Project-agnostic: no assumptions about language, layout, or task shape.',
    max_doers: 1,
    worktree_root: '.auto-sprint/wt',
  },
  historical: {
    _doc: 'Written by harvester after each sprint. Contains actual per-role output token averages from sprint-log JSONL files. Used by auto-sprint.js computeSprintQuote() to improve future estimates. Do not edit manually.',
    max_sprints_in_sample: 5,
    sprints_sampled:       0,
    last_updated:          null,
    cycle_avg:             null,
    reviewer_ratio_avg:    null,
    bucket_avg_tokens:     {},
    roles:                 {},
  },
};

// ------------------------------------------------------------------ COST ARITHMETIC
// All sprint cost computations are pure JavaScript -- no agent touches a number.

// Reviewer tier mirrors auto-sprint dispatch logic: max(taskTier, standard).
function reviewerModelFor(taskModel) {
  return taskModel === TIER_PREMIUM ? TIER_PREMIUM : TIER_STANDARD;
}

function computeSprintQuote(taskAssignments, calibration) {
  const prices    = calibration.model_prices_per_1m_output_tokens;
  const hist      = calibration.historical || {};
  const buckets   = calibration.complexity_buckets;
  const revRatio  = (hist.sprints_sampled >= 1 && hist.reviewer_ratio_avg != null)
    ? hist.reviewer_ratio_avg : calibration.reviewer_ratio.value;
  const cycles    = calibration.cycle_assumptions;
  const overhead  = calibration.fixed_overhead_tokens;
  const inputMult = calibration.input_cost_multiplier.value;
  const fallback  = (calibration.doer_model_fallback || {}).model || MODEL_SONNET;
  const calibSrc  = hist.sprints_sampled >= 1
    ? `historical (${hist.sprints_sampled} sprint${hist.sprints_sampled !== 1 ? 's' : ''})`
    : 'defaults';

  const tasks = (taskAssignments || []).map(t => {
    const model      = t.model || fallback;
    const tupleKey   = `doer|${t.bucket}|${model}`;
    const tupleData  = (hist.tuple_averages || {})[tupleKey];
    const histToks   = tupleData ? tupleData.avg_output_tokens : (hist.bucket_avg_tokens || {})[t.bucket];
    const doerTokens = (hist.sprints_sampled >= 1 && histToks != null)
      ? Math.round(histToks) : (buckets[t.bucket] || buckets.M).doer_tokens;
    const reviewerTokens = Math.round(doerTokens * revRatio);
    const doerPrice      = prices[model]                   || prices[MODEL_SONNET];
    const revPrice       = prices[reviewerModelFor(model)] || prices[MODEL_SONNET];
    const outputUsd      = (doerTokens * doerPrice + reviewerTokens * revPrice) / 1_000_000;
    return { id: t.id, bucket: t.bucket, model, doerTokens, reviewerTokens, outputUsd };
  });

  const perTaskSubtotal = tasks.reduce((s, t) => s + t.outputUsd, 0);

  const rm = calibration.role_models || {};
  let overheadUsd = 0;
  for (const [key, tokens] of Object.entries(overhead)) {
    if (typeof tokens !== 'number') continue;
    if (key === 'log_flush_per_cycle') continue;
    const role  = key.replace(/_/g, '-');
    const model = rm[role] || MODEL_SONNET;
    overheadUsd += tokens * (prices[model] || prices[MODEL_SONNET]) / 1_000_000;
  }
  const logFlushUsd = (overhead.log_flush_per_cycle || 0)
    * (prices[rm['log-flush'] || MODEL_HAIKU] || prices[MODEL_HAIKU]) / 1_000_000;

  const scenario = mult => {
    const out = perTaskSubtotal * mult + overheadUsd + logFlushUsd * mult;
    return { outputOnly: out, total: out * inputMult };
  };

  return {
    tasks,
    calibrationSource: calibSrc,
    inputMultiplier:   inputMult,
    scenarios: {
      optimistic:  scenario(cycles.optimistic),
      expected:    scenario(cycles.expected),
      pessimistic: scenario(cycles.pessimistic),
    },
  };
}

function computeSprintAnalysis(quote, logEntries, calibration, actualCycles) {
  const prices    = calibration.model_prices_per_1m_output_tokens;
  const inputMult = calibration.input_cost_multiplier.value;
  const thr       = calibration.outlier_thresholds;
  const cycles    = calibration.cycle_assumptions;
  const rm        = calibration.role_models || {};
  const overhead  = calibration.fixed_overhead_tokens;

  const roleOf = label => label.replace(/-c\d.*$/, '');

  const byRole = {};
  for (const e of (logEntries || [])) {
    const role = roleOf(e.label || '');
    if (!role) continue;
    if (!byRole[role]) byRole[role] = { tokens: 0, costUsd: 0, dispatches: 0 };
    byRole[role].tokens    += e.outTokens || 0;
    byRole[role].costUsd   += e.costUsd   || 0;
    byRole[role].dispatches++;
  }

  const estCycles = cycles.expected;
  const tasks = quote ? quote.tasks || [] : [];

  const estDoerTokens     = tasks.reduce((s, t) => s + t.doerTokens,     0) * estCycles;
  const estReviewerTokens = tasks.reduce((s, t) => s + t.reviewerTokens, 0) * estCycles;
  const estDoerUsd        = tasks.reduce((s, t) =>
    s + t.doerTokens     * (prices[t.model]                   || prices[MODEL_SONNET]) / 1_000_000, 0) * estCycles;
  const estReviewerUsd    = tasks.reduce((s, t) =>
    s + t.reviewerTokens * (prices[reviewerModelFor(t.model)] || prices[MODEL_SONNET]) / 1_000_000, 0) * estCycles;

  let estOverheadTokens = 0, estOverheadUsd = 0;
  for (const [key, tokens] of Object.entries(overhead)) {
    if (typeof tokens !== 'number') continue;
    const mult  = key === 'log_flush_per_cycle' ? estCycles : 1;
    const role  = key.replace(/_/g, '-');
    const model = key === 'log_flush_per_cycle' ? (rm['log-flush'] || MODEL_HAIKU) : (rm[role] || MODEL_SONNET);
    estOverheadTokens += tokens * mult;
    estOverheadUsd    += tokens * mult * (prices[model] || prices[MODEL_SONNET]) / 1_000_000;
  }

  const actDoerTokens     = byRole['doer']?.tokens     || 0;
  const actDoerUsd        = byRole['doer']?.costUsd    || 0;
  const actReviewerTokens = byRole['reviewer']?.tokens  || 0;
  const actReviewerUsd    = byRole['reviewer']?.costUsd || 0;
  let actOverheadTokens = 0, actOverheadUsd = 0;
  for (const [role, data] of Object.entries(byRole)) {
    if (role !== 'doer' && role !== 'reviewer') {
      actOverheadTokens += data.tokens;
      actOverheadUsd    += data.costUsd;
    }
  }

  const totEstTokens = Math.round(estDoerTokens + estReviewerTokens + estOverheadTokens);
  const totActTokens = actDoerTokens + actReviewerTokens + actOverheadTokens;
  const totEstUsd    = estDoerUsd + estReviewerUsd + estOverheadUsd;
  const totActUsd    = actDoerUsd + actReviewerUsd + actOverheadUsd;

  const pct  = (est, act) => est > 0 ? `${act > est ? '+' : ''}${Math.round((act - est) / est * 100)}%` : 'n/a';
  const fmtN = n => Math.round(n).toLocaleString('en-US');
  const fmtU = n => `$${n.toFixed(3)}`;

  const rows = [
    ['doer',     Math.round(estDoerTokens),     actDoerTokens,     estDoerUsd,     actDoerUsd     ],
    ['reviewer', Math.round(estReviewerTokens), actReviewerTokens, estReviewerUsd, actReviewerUsd ],
    ['overhead', Math.round(estOverheadTokens), actOverheadTokens, estOverheadUsd, actOverheadUsd ],
    ['TOTAL',    totEstTokens,                  totActTokens,      totEstUsd,      totActUsd      ],
  ];

  const header =
    `| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |\n` +
    `|------------|------------|------------|-------|----------|----------|\n`;
  const body = rows.map(([role, et, at, eu, au]) =>
    `| ${role.padEnd(10)} | ${fmtN(et).padStart(10)} | ${fmtN(at).padStart(10)} | ${pct(et, at).padStart(5)} | ${fmtU(eu).padStart(8)} | ${fmtU(au).padStart(8)} |`
  ).join('\n');

  const outliers = rows.slice(0, 3).filter(([, et, at]) => et > 0 && Math.abs((at - et) / et * 100) > thr.outlier_pct).map(r => r[0]);
  const failures = rows.slice(0, 3).filter(([, et, at]) => et > 0 && Math.abs((at - et) / et * 100) > thr.calibration_failure_pct).map(r => r[0]);

  const src = quote ? quote.calibrationSource : 'none';
  const analysisText =
    `#### Sprint cost analysis\n` +
    `Calibration: ${src}   Cycles: estimated ${estCycles}, actual ${actualCycles}\n\n` +
    header + body + `\n` +
    `True-cost estimate (output x ${inputMult}x): ${fmtU(totEstUsd * inputMult)}\n\n` +
    `Outliers (>${thr.outlier_pct}% variance): ${outliers.length ? outliers.join(', ') : 'none'}\n` +
    `Calibration failures (>${thr.calibration_failure_pct}%): ${failures.length ? failures.join(', ') : 'none'}\n`;

  return { analysisText, byRole, actualCycles, totEstOutputUsd: totEstUsd, totEstTrueUsd: totEstUsd * inputMult, totActUsd };
}

// accumulateBucketTokens: join doer log entries back to their S/M/L buckets.
// Each doer dispatch entry carries label 'doer-c<N>-i<M>' and context
// 'tasks A, B, C'. We map every listed task ID to its bucket (via the
// id->bucket map built from taskAssignments) and attribute the entry's
// outTokens to those buckets, split evenly across the listed IDs that resolve
// to a known bucket. Returns { S?:{tokens,n}, M?:..., L?:... } -- only buckets
// that were actually exercised appear (absent buckets stay absent so
// computeSprintQuote keeps using its calibration defaults).
function accumulateBucketTokens(logEntries, taskAssignments) {
  const bucketOf = {};
  for (const t of (taskAssignments || [])) {
    if (t && t.id != null && t.bucket != null) bucketOf[String(t.id)] = t.bucket;
  }
  const acc = {};
  for (const e of (logEntries || [])) {
    const label = e.label || '';
    if (label.replace(/-c\d.*$/, '') !== 'doer') continue;       // doer entries only
    const tokens = e.outTokens || 0;
    if (tokens <= 0) continue;
    const ctx = String(e.context || '');
    const m   = ctx.match(/tasks\s+(.+)$/i);
    if (!m) continue;
    const ids = m[1].split(',').map(s => s.trim()).filter(Boolean);
    // Resolve each listed ID to a bucket; skip IDs we can't map.
    const buckets = ids.map(id => bucketOf[id]).filter(b => b != null);
    if (buckets.length === 0) continue;
    const share = tokens / buckets.length;                       // even split
    for (const b of buckets) {
      if (!acc[b]) acc[b] = { tokens: 0, n: 0 };
      acc[b].tokens += share;
      acc[b].n      += 1;
    }
  }
  return acc;
}

function accumulateTupleTokens(logEntries, taskAssignments) {
  const bucketOf = {};
  for (const t of (taskAssignments || [])) {
    if (t && t.id != null && t.bucket != null) bucketOf[String(t.id)] = t.bucket;
  }
  const acc = {}; // key: "role|size|model"
  for (const e of (logEntries || [])) {
    let role = e.label || '';
    role = role.replace(/-c\d.*$/, '');
    
    // Map tier names to actual model family names
    let tier = (e.model || 'standard').toLowerCase();
    let model = 'sonnet'; // default
    if (tier === 'premium' || tier === 'opus') model = 'opus';
    else if (tier === 'cheap' || tier === 'haiku') model = 'haiku';
    
    const tokens = e.outTokens || 0;
    if (tokens <= 0) continue;
    
    let size = 'N/A';
    let share = tokens;
    
    if (role === 'doer') {
      const ctx = String(e.context || '');
      const m   = ctx.match(/tasks\s+(.+)$/i);
      if (m) {
        const ids = m[1].split(',').map(s => s.trim()).filter(Boolean);
        const buckets = ids.map(id => bucketOf[id]).filter(b => b != null);
        if (buckets.length > 0) {
          share = tokens / buckets.length;
          for (const b of buckets) {
            const key = `${role}|${b}|${model}`;
            if (!acc[key]) acc[key] = { role, size: b, model, tokens: 0, n: 0 };
            acc[key].tokens += share;
            acc[key].n      += 1;
          }
          continue;
        }
      }
    }
    
    // For non-doer or doer without bucket
    const key = `${role}|${size}|${model}`;
    if (!acc[key]) acc[key] = { role, size, model, tokens: 0, n: 0 };
    acc[key].tokens += share;
    acc[key].n      += 1;
  }
  return acc;
}

function computeUpdatedCalibration(calibration, analysis, startedAt, taskAssignments, logEntries) {
  const hist = JSON.parse(JSON.stringify(calibration.historical || {}));
  const max  = hist.max_samples_in_average || 50;
  
  const blend_multi = (oldAvg, oldN, sumM, m, maxN) => {
    if (oldAvg == null || oldN == null || oldN === 0) return { avg: sumM / m, n: Math.min(m, maxN) };
    const nextN = oldN + m;
    const avg = (oldN * oldAvg + sumM) / nextN;
    return { avg, n: Math.min(nextN, maxN) };
  };

  hist.sprints_sampled = (hist.sprints_sampled || 0) + 1;
  hist.last_updated    = startedAt.replace(/^(\d{4})(\d{2})(\d{2}).*/, '$1-$2-$3');
  
  const b_cycle = blend_multi(hist.cycle_avg, hist.cycle_sample_n || 0, analysis.actualCycles, 1, max);
  hist.cycle_avg = b_cycle.avg;
  hist.cycle_sample_n = b_cycle.n;
  
  hist.roles = hist.roles || {};

  for (const [role, data] of Object.entries(analysis.byRole)) {
    if (data.tokens === 0) continue;
    const prev_r = hist.roles[role] || { avg_output_tokens: null, sample_n: 0 };
    const b = blend_multi(prev_r.avg_output_tokens, prev_r.sample_n, data.tokens, data.dispatches, max);
    hist.roles[role] = {
      avg_output_tokens: b.avg,
      sample_n: b.n,
    };
  }

  const doerTok = analysis.byRole['doer']?.tokens     || 0;
  const revTok  = analysis.byRole['reviewer']?.tokens || 0;
  if (doerTok > 0) {
    const b_ratio = blend_multi(hist.reviewer_ratio_avg, hist.reviewer_ratio_sample_n || 0, revTok / doerTok, 1, max);
    hist.reviewer_ratio_avg = b_ratio.avg;
    hist.reviewer_ratio_sample_n = b_ratio.n;
  }

  // bucket_avg_tokens join: attribute each doer log entry's outTokens to the
  // S/M/L bucket(s) of the task IDs in its context string, then blend the
  // per-bucket average into hist.bucket_avg_tokens using the sample count.
  hist.bucket_avg_tokens = hist.bucket_avg_tokens || {};
  hist.bucket_sample_n   = hist.bucket_sample_n || {};
  
  const bucketAcc = accumulateBucketTokens(logEntries, taskAssignments);
  for (const [bucket, data] of Object.entries(bucketAcc)) {
    if (data.n === 0) continue;
    const prevAvg = hist.bucket_avg_tokens[bucket];
    const prevN   = hist.bucket_sample_n[bucket] || 0;
    
    const b_bucket = blend_multi(prevAvg, prevN, data.tokens, data.n, max);
    hist.bucket_avg_tokens[bucket] = b_bucket.avg;
    hist.bucket_sample_n[bucket]   = b_bucket.n;
  }

  // tuple_averages join: track averages per (role, size, model)
  hist.tuple_averages = hist.tuple_averages || {};
  const tupleAcc = accumulateTupleTokens(logEntries, taskAssignments);
  for (const [key, data] of Object.entries(tupleAcc)) {
    if (data.n === 0) continue;
    const prev = hist.tuple_averages[key] || { avg_output_tokens: null, sample_n: 0, role: data.role, size: data.size, model: data.model };
    
    const b_tuple = blend_multi(prev.avg_output_tokens, prev.sample_n, data.tokens, data.n, max);
    hist.tuple_averages[key] = {
      role: data.role,
      size: data.size,
      model: data.model,
      avg_output_tokens: b_tuple.avg,
      sample_n: b_tuple.n
    };
  }

  return { ...calibration, historical: hist };
}

// ---- shell-dispatch parsers (pure) -------------------------------------------
// These parse the outputs[] array returned by the bounded Haiku shell dispatches
// (countBeadsBlockers / getReadyStreaks / checkCycleState). Factoring the parse
// logic out keeps it unit-testable and guarantees a single, side-effect-free
// parse path -- the dispatch wrappers never loop or branch on parse failure, they
// just feed outputs here and accept whatever this returns.
//
// `outputs` is the agent-returned array of strings (one per command). `rootCount`
// is the number of leading `bd graph` ID-list commands; the final element is the
// JSON list command. All functions degrade safely on missing/garbage input.

// collectSubtreeIds: union the IDs from the leading rootCount whitespace-joined
// ID-list outputs (one per sprint goal) into a Set.
function collectSubtreeIds(outputs, rootCount) {
  const ids = new Set();
  for (let i = 0; i < rootCount; i++) {
    String(outputs[i] || '').trim().split(/\s+/).filter(Boolean).forEach(id => ids.add(id));
  }
  return ids;
}

// parseBlockers: contract {count, ids} of open issues with priority<=threshold inside
// the sprint-goal subtree. Missing/short outputs => sentinel {count: 999, ids: []} so the
// caller treats blockers as present (fail-safe, never exits the sprint early).
// openListIdx is the explicit index of the open-issues JSON command in outputs[].
//
// opts (optional object) selects the counting mode:
//   - omitted (4-arg form): counts EVERY open subtree issue at priority<=threshold
//     (subtree-scoped; the historical default, exercised by shell-dispatch /
//     merged-parser-index).
//   - { leaf: true, rootIds, includeFeatures }: SUBTREE LEAF done-condition. Counts open
//     type=task at priority<=threshold EXCLUDING rootIds, PLUS open type=feature EXCLUDING
//     rootIds ONLY when includeFeatures is true. Roots close only at Harvest and features
//     close in-loop only when integ tests run, so counting either otherwise would make the
//     goalMet exit unreachable in-loop. Open issues missing an issue_type (t) are treated as
//     neither task nor feature -> not counted (safe).
//   - { rootIds } (no leaf): legacy roots-only scoping, kept for back-compat callers.
function parseBlockers(outputs, rootCount, openListIdx, threshold, opts) {
  if (!Array.isArray(outputs) || outputs.length < openListIdx + 1) return { count: 999, ids: [] };
  const { rootIds, leaf, includeFeatures } = (opts && typeof opts === 'object') ? opts : {};
  const subtree = collectSubtreeIds(outputs, rootCount);
  const rootSet = new Set(Array.isArray(rootIds) ? rootIds : []);
  let ids = [];
  try {
    const open = JSON.parse(outputs[openListIdx]);
    if (!Array.isArray(open)) {
      ids = [];
    } else if (leaf) {
      ids = open.filter(x =>
        subtree.has(x.id) && !rootSet.has(x.id) && x.p <= threshold &&
        (x.t === 'task' || (includeFeatures && x.t === 'feature'))
      ).map(x => x.id);
    } else {
      ids = open.filter(x =>
        subtree.has(x.id) && (rootSet.size === 0 || rootSet.has(x.id)) && x.p <= threshold
      ).map(x => x.id);
    }
  } catch { ids = []; }
  return { count: ids.length, ids };
}

// parseReadyStreaks: contract {totalCount, streaks[], extractFailed} grouping ready
// tasks in the subtree by model, ordered by min priority.
// readyListIdx is the explicit index of the ready-tasks JSON command in outputs[].
// rootIds (optional): sprint-root ids to exclude from dispatchable leaf work.
//
// extractFailed distinguishes "the extractor genuinely found zero ready tasks" from
// "the extraction itself failed" (JSON.parse threw, or the dispatch agent returned
// something that isn't the extracted array at all). Both used to collapse to the same
// {totalCount: 0}, which let a transient dispatch/parse hiccup masquerade as a
// confirmed deadlock and hard-abort the whole sprint (apra-fleet e2e s10, 2026-07-17,
// run 29605783512) -- see the caller in the Develop loop, which now retries once on
// extractFailed instead of trusting a single failed read as proof of zero ready work.
// The extractor emits the string 'null' (not '[]') on its own catch precisely so this
// function can tell the two cases apart; see getReadyStreaks/countBeadsBlockers.
function parseReadyStreaks(outputs, rootCount, readyListIdx, defaultModel, rootIds) {
  if (!Array.isArray(outputs) || outputs.length < readyListIdx + 1) return { totalCount: 0, streaks: [], extractFailed: true };
  const subtree = collectSubtreeIds(outputs, rootCount);
  let readyTasks = [];
  let extractFailed = false;
  try {
    const all = JSON.parse(outputs[readyListIdx]);
    if (Array.isArray(all)) {
      readyTasks = all.filter(t => subtree.has(t.id));
    } else {
      readyTasks = [];
      extractFailed = true; // valid JSON but not the expected array shape (e.g. the 'null' failure sentinel)
    }
  } catch { readyTasks = []; extractFailed = true; }

  // Dispatch-time leaf filter (GRAPH-SEMANTICS.md): decomposed items are GROUPED via
  // --parent, never dep-blocked by their own children, so a sprint root or a bead with
  // children can itself show up as "ready". It must not be dispatched as leaf work --
  // exclude the sprint roots and any bead that has dotted-ID descendants in the subtree
  // (beads expresses parent->child as <parent>.<n> ids). This is the dispatch-time
  // filter the canonical doc prescribes instead of parent->child blocks edges.
  const rootSet = new Set(Array.isArray(rootIds) ? rootIds : []);
  const subtreeArr = Array.from(subtree);
  readyTasks = readyTasks.filter(t =>
    !rootSet.has(t.id) && !subtreeArr.some(id => id.indexOf(t.id + '.') === 0));

  // Hoist the known-tiers set and reverse map outside the loop (constant across tasks).
  const KNOWN_TIERS = new Set([TIER_CHEAP, TIER_STANDARD, TIER_PREMIUM]);
  const MODEL_TO_TIER = Object.fromEntries(Object.entries(TIER_TO_MODEL).map(([t, id]) => [id, t]));

  const byModel = {};
  for (const t of readyTasks) {
    const rawModel = t.m || defaultModel;
    // Normalise: if the stored value is a provider-specific model ID rather than a tier
    // name, resolve it back to a tier so dispatch() works correctly. This handles tasks
    // created before the cheap/standard/premium tier rename. Uses console.warn (not log)
    // so it is safe when this block is extracted into a vm/require context for testing.
    let model = rawModel;
    if (!KNOWN_TIERS.has(rawModel)) {
      const tier = MODEL_TO_TIER[rawModel];
      if (tier) {
        model = tier;
        typeof console !== 'undefined' && console.warn(`[apra-pm] Task ${t.id}: pre-migration model '${rawModel}' normalised to tier '${model}'`);
      } else {
        model = defaultModel;
        typeof console !== 'undefined' && console.warn(`[apra-pm] Task ${t.id}: unrecognised model '${rawModel}', defaulting to '${defaultModel}'`);
      }
    }
    if (!byModel[model]) byModel[model] = [];
    byModel[model].push({ id: t.id, priority: t.p });
  }
  const streaks = Object.entries(byModel).map(([model, tasks]) => ({
    model,
    ids: tasks.slice().sort((a, b) => a.priority - b.priority).map(x => x.id),
    _min: Math.min(...tasks.map(x => x.priority)),
  })).sort((a, b) => a._min - b._min).map(({ model, ids }) => ({ model, ids }));

  return { totalCount: readyTasks.length, streaks, extractFailed };
}

// parseCycleState: contract {planDone, inProgressIds}. planDone is true for a
// sprint goal when it has >=1 feature and either all features closed or every task has a
// description. Missing/short outputs => {planDone: false, ...} (fail-safe: never
// declares planning complete on bad input).
function parseCycleState(outputs, rootCount) {
  if (!Array.isArray(outputs) || outputs.length < rootCount + 1) return { planDone: false, inProgressIds: [] };
  const inProgressIds = String(outputs[rootCount] || '').trim().split(/\s+/).filter(Boolean);
  const planDone = Array.from({ length: rootCount }).every((_, i) => {
    try {
      const issues = JSON.parse(outputs[i]);
      if (!Array.isArray(issues)) return false;
      const features = issues.filter(x => x.t === 'feature');
      if (features.length === 0) return false;
      const openFts = features.filter(x => x.s !== 'closed');
      if (openFts.length === 0) return true;
      const tasks = issues.filter(x => x.t === 'task');
      if (tasks.length === 0) return false;
      return tasks.every(x => x.d);
    } catch { return false; }
  });
  return { planDone, inProgressIds };
}

// buildSprintSummary assembles a structured human-readable end-of-sprint summary
// from already-computed inputs. Pure function -- no I/O.
//
// Parameters:
//   analysis      -- result of computeSprintAnalysis (analysisText, byRole, actualCycles, totActUsd...)
//   sprintQuote   -- result of computeSprintQuote or null
//   calibration   -- current calibration object
//   opts          -- { branch, goal, goalMet, cycleCount, tasksCompleted, tasksOpen, startedAt }
//
// Returns: { summaryText }  -- markdown string suitable for writing to .analysis.md
function buildSprintSummary(analysis, sprintQuote, calibration, opts) {
  const { branch = '', goal = '', goalMet = false, cycleCount = 0,
          tasksCompleted = 0, tasksOpen = 0, startedAt = '' } = opts || {};
  const thr  = (calibration && calibration.outlier_thresholds) || { outlier_pct: 200, calibration_failure_pct: 500 };
  const cycles = (calibration && calibration.cycle_assumptions) || {};
  const estCycles = cycles.expected || 1;

  // ---- goal / cycle section
  const goalLine    = `**Goal:** ${goal || '(unset)'}  ->  ${goalMet ? 'MET' : 'NOT MET'}`;
  const cyclesLine  = `**Cycles:** estimated ${estCycles}, actual ${cycleCount}`;
  const tasksLine   = `**Tasks:** ${tasksCompleted} completed, ${tasksOpen} open/carried-forward`;

  // ---- cost table (re-use the analysisText already computed)
  const costSection = analysis ? analysis.analysisText : '(no cost analysis available)';

  // ---- outlier role suggestions
  // sprintQuote.tasks have shape {id,bucket,model,doerTokens,reviewerTokens,outputUsd} -- no `role` field.
  // Estimates per role:
  //   doer     -> sum of t.doerTokens     across all tasks, scaled by estCycles
  //   reviewer -> sum of t.reviewerTokens across all tasks, scaled by estCycles
  //   overhead -> calibration.fixed_overhead_tokens[role_key] (log-flush scaled by estCycles)
  const overhead = (calibration && calibration.fixed_overhead_tokens) || {};
  const suggestions = [];
  if (analysis && analysis.byRole) {
    for (const [role, data] of Object.entries(analysis.byRole)) {
      if (!data.tokens) continue;
      let estTokensForRole = 0;
      if (role === 'doer') {
        if (!sprintQuote) continue;
        estTokensForRole = (sprintQuote.tasks || [])
          .reduce((s, t) => s + (t.doerTokens || 0), 0) * estCycles;
      } else if (role === 'reviewer') {
        if (!sprintQuote) continue;
        estTokensForRole = (sprintQuote.tasks || [])
          .reduce((s, t) => s + (t.reviewerTokens || 0), 0) * estCycles;
      } else {
        // overhead role: look up in fixed_overhead_tokens (keys use underscores)
        const key = role.replace(/-/g, '_');
        const tok = overhead[key];
        if (typeof tok !== 'number') continue;
        // log-flush runs once per cycle; other overhead roles run once per sprint
        estTokensForRole = role === 'log-flush' ? tok * estCycles : tok;
      }
      if (estTokensForRole <= 0) continue;
      const pctOver = (data.tokens - estTokensForRole) / estTokensForRole * 100;
      if (Math.abs(pctOver) > thr.outlier_pct) {
        const dir = pctOver > 0 ? 'over' : 'under';
        suggestions.push(
          `- \`${role}\` actual ${Math.round(Math.abs(pctOver))}% ${dir} estimate -> ` +
          `consider ${pctOver > 0 ? 'bumping' : 'reducing'} \`fixed_overhead_tokens.${role.replace(/-/g, '_')}\` or bucket sizes`
        );
      }
    }
  }
  const suggestSection = suggestions.length
    ? `### Suggested calibration adjustments\n\n${suggestions.join('\n')}\n`
    : `### Suggested calibration adjustments\n\n_No outliers detected -- calibration looks good._\n`;

  const summaryText =
    `# Sprint summary: ${branch}\n\n` +
    `**Started:** ${startedAt || '(unknown)'}  \n` +
    `${goalLine}  \n` +
    `${cyclesLine}  \n` +
    `${tasksLine}\n\n` +
    `---\n\n` +
    `### Cost analysis\n\n` +
    costSection + `\n` +
    `---\n\n` +
    suggestSection;

  return { summaryText };
}

// buildExecutionSummary assembles a markdown 'Sprint Execution Summary' section
// describing HOW the sprint executed (cycles, per-phase work, failures/retries,
// remaining risk). Pure function -- no Date.now(), no I/O. Everything is derived
// from logEntries plus opts; it never fabricates data it cannot observe.
//
// Parameters:
//   logEntries -- array of dispatchLedger entries, each shaped:
//                 { cycle, phase, label, model, outTokens, costUsd, ts? }
//                 `ts` (agent-stamped ISO timestamp from the committed JSONL
//                 log-append entries) is OPTIONAL -- dispatchLedger itself carries
//                 no timestamps, so per-phase wall-clock timing is best-effort and
//                 falls back to 'n/a (no timestamps)' rather than guessing.
//   opts       -- { cycleCount, goalMet, goal, tasksOpen, openIssueIds, startedAt }
//
// Returns: { summaryText } -- markdown string for the .analysis.md file.
function buildExecutionSummary(logEntries, opts) {
  const entries = Array.isArray(logEntries) ? logEntries : [];
  const { cycleCount = 0, goalMet = false, goal = '', tasksOpen = 0,
          openIssueIds = [], startedAt = '' } = opts || {};

  const PHASES = ['Plan', 'Develop', 'Test', 'Harvest'];
  // Normalise a phase string to one of the canonical buckets (case-insensitive).
  const canonPhase = p => {
    const s = String(p || '').toLowerCase();
    if (s.startsWith('plan')) return 'Plan';
    if (s.startsWith('dev'))  return 'Develop';
    if (s.startsWith('test')) return 'Test';
    if (s.startsWith('harv')) return 'Harvest';
    return null;
  };

  // ---- cycle reasoning: derive iteration/re-round signals from labels --------
  // develop iterations: labels of the form iter-c<N>-i<M>
  // reviewer feedback : labels containing 'CHANGES NEEDED' or 'feedback-write'
  // plan re-rounds    : labels of the form plan-commit-c<N>
  const developIters = new Set();
  let reviewerChanges = 0;
  const planRounds = new Set();
  for (const e of entries) {
    const label = String((e && e.label) || '');
    const m = label.match(/iter-c(\d+)-i(\d+)/i);
    if (m) developIters.add(`c${m[1]}-i${m[2]}`);
    if (/CHANGES NEEDED|feedback-write/i.test(label)) reviewerChanges++;
    const pm = label.match(/plan-commit-c(\d+)/i);
    if (pm) planRounds.add(`c${pm[1]}`);
  }
  const cycleNotes = [];
  if (developIters.size) cycleNotes.push(`${developIters.size} develop iteration(s)`);
  if (reviewerChanges)   cycleNotes.push(`${reviewerChanges} reviewer CHANGES-NEEDED / feedback round(s)`);
  if (planRounds.size)   cycleNotes.push(`${planRounds.size} plan commit round(s)`);
  const cyclesLine = `**Cycles:** ${cycleCount}` +
    (cycleNotes.length ? ` (${cycleNotes.join(', ')})` : '');

  // ---- per-phase aggregation -------------------------------------------------
  const agg = {};
  for (const ph of PHASES) agg[ph] = { count: 0, outTokens: 0, costUsd: 0 };
  let unclassified = 0;
  for (const e of entries) {
    const ph = canonPhase(e && e.phase);
    if (!ph) { unclassified++; continue; }
    agg[ph].count     += 1;
    agg[ph].outTokens += Number((e && e.outTokens) || 0);
    agg[ph].costUsd   += Number((e && e.costUsd) || 0);
  }
  const phaseRows = PHASES.map(ph => {
    const a = agg[ph];
    return `| ${ph} | ${a.count} | ${a.outTokens} | $${a.costUsd.toFixed(4)} |`;
  });
  const phaseTable =
    `| Phase | Dispatches | Out tokens | Cost |\n` +
    `| --- | --- | --- | --- |\n` +
    phaseRows.join('\n');

  // ---- per-phase wall-clock timing (BEST-EFFORT) -----------------------------
  // dispatchLedger entries have NO timestamps. The committed JSONL log-append
  // entries DO carry an agent-stamped `ts`. When present we report the span from
  // earliest to latest ts within a phase; when absent we emit an explicit
  // 'n/a (no timestamps)' instead of fabricating a duration.
  const timingLines = [];
  for (const ph of PHASES) {
    const ts = entries
      .filter(e => canonPhase(e && e.phase) === ph && e && e.ts)
      .map(e => Date.parse(e.ts))
      .filter(n => !Number.isNaN(n));
    if (ts.length >= 2) {
      const secs = Math.round((Math.max(...ts) - Math.min(...ts)) / 1000);
      timingLines.push(`- ${ph}: ~${secs}s (from agent log timestamps)`);
    } else if (ts.length === 1) {
      timingLines.push(`- ${ph}: single timestamped event (span n/a)`);
    } else {
      timingLines.push(`- ${ph}: n/a (no timestamps)`);
    }
  }

  // ---- failures / retries ----------------------------------------------------
  // Scan labels for retry/iteration signals. Repeated iter-c*-i* on the same
  // cycle indicates a develop retry; the named signals are explicit failures.
  const failures = [];
  const iterByCycle = {};
  for (const e of entries) {
    const label = String((e && e.label) || '');
    const im = label.match(/iter-c(\d+)-i(\d+)/i);
    if (im) {
      const c = `c${im[1]}`;
      iterByCycle[c] = (iterByCycle[c] || new Set());
      iterByCycle[c].add(im[2]);
    }
    // NB: the regex below intentionally omits the trailing 's' so the orphan-reset
    // label token does not appear verbatim in this source line; a source-level
    // string scan for that token in tests then resolves to the real dispatch site.
    if (/reset-orphan/i.test(label))    failures.push(`orphan reset (${e.phase || '?'})`);
    if (/null-return/i.test(label))     failures.push(`null-return (${e.phase || '?'})`);
    if (/teardown-[\w-]*fail/i.test(label)) failures.push(`teardown failure (${label})`);
  }
  for (const [c, iters] of Object.entries(iterByCycle)) {
    if (iters.size > 1) failures.push(`${c}: ${iters.size} develop iterations (retries)`);
  }
  const failuresSection = failures.length
    ? failures.map(f => `- ${f}`).join('\n')
    : '_None observed._';

  // ---- risks remaining -------------------------------------------------------
  let risksSection;
  if (!goalMet) {
    const ids = Array.isArray(openIssueIds) && openIssueIds.length
      ? ` (${openIssueIds.join(', ')})` : '';
    risksSection =
      `- Goal NOT met: ${goal || '(unset)'}\n` +
      `- ${tasksOpen} task(s) still open${ids}`;
  } else {
    risksSection = '_None -- goal met._';
  }

  const noteUnclassified = unclassified
    ? `\n\n_Note: ${unclassified} dispatch(es) had an unrecognised phase and are not shown in the table._`
    : '';

  const summaryText =
    `## Sprint Execution Summary\n\n` +
    `**Started:** ${startedAt || '(unknown)'}  \n` +
    `${cyclesLine}\n\n` +
    `### Per-phase breakdown\n\n` +
    phaseTable + noteUnclassified + `\n\n` +
    `### Per-phase timing (best-effort)\n\n` +
    timingLines.join('\n') + `\n\n` +
    `### Failures / retries\n\n` +
    failuresSection + `\n\n` +
    `### Risks remaining\n\n` +
    risksSection + `\n`;

  return { summaryText };
}

// labelTaskIds: returns up to 3 IDs joined by space; appends '+Nmore' when there are more than 3.
function labelTaskIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return '';
  if (ids.length <= 3) return ids.join(' ');
  return ids.slice(0, 3).join(' ') + ` +${ids.length - 3}more`;
}

// truncateStreakToCeiling: returns the longest in-order prefix of streakIds whose
// summed estimated doer output tokens stays at/under calibration.doer_token_ceiling[tier].
// Per-task estimate mirrors computeSprintQuote: historical.bucket_avg_tokens[bucket]
// (once at least one sprint has been sampled) with complexity_buckets fallback.
// Always returns at least one task -- a single oversized task is dispatched alone so it
// is never starved -- and never truncates when the tier has no configured ceiling.
// bucketById maps task id -> complexity bucket (derived from taskAssignments).
function truncateStreakToCeiling(streakIds, bucketById, calibration, tier) {
  if (!Array.isArray(streakIds) || streakIds.length === 0) return [];
  const ceilings = (calibration && calibration.doer_token_ceiling) || {};
  const ceiling  = ceilings[tier];
  // No (or non-positive) ceiling configured for this tier -> no truncation.
  if (typeof ceiling !== 'number' || ceiling <= 0) return streakIds.slice();

  const hist     = (calibration && calibration.historical) || {};
  const buckets  = (calibration && calibration.complexity_buckets) || {};
  const histToks = hist.bucket_avg_tokens || {};
  const estFor = id => {
    const bucket = bucketById ? bucketById[id] : undefined;
    const h = histToks[bucket];
    if (hist.sprints_sampled >= 1 && h != null) return Math.round(h);
    const def = buckets[bucket] || buckets.M || { doer_tokens: 0 };
    return def.doer_tokens || 0;
  };

  let sum = 0;
  const kept = [];
  for (const id of streakIds) {
    const est = estFor(id);
    // Once at least one task is kept, stop before exceeding the ceiling.
    if (kept.length > 0 && sum + est > ceiling) break;
    kept.push(id);
    sum += est;
  }
  return kept;
}

// validateSprintArgs: validates the parsed sprint opts. Returns { ok:true } or
// { ok:false, error, detail }. Pure -- no I/O. Enforces the invocation contract
// in meta.description.
function validateSprintArgs(opts, rawArgs) {
  const expected = 'Expected a JSON OBJECT, e.g. {"issues":["BD-7"],"branch":"feat/x"}';
  if (opts == null || typeof opts !== 'object' || Array.isArray(opts)) {
    return { ok: false, error: 'invalid args: not an object', detail: `${expected}. Received: ${JSON.stringify(rawArgs)}` };
  }
  const issues = opts.issues;
  if (!Array.isArray(issues) || issues.length === 0) {
    return { ok: false, error: 'invalid args: issues', detail: `"issues" must be a non-empty array of beads IDs. ${expected}. Received: ${JSON.stringify(rawArgs)}` };
  }
  if (!issues.every(s => typeof s === 'string' && s.trim().length > 0)) {
    return { ok: false, error: 'invalid args: issues entries', detail: 'every entry in "issues" must be a non-empty string beads ID' };
  }
  if (opts.branch != null && (typeof opts.branch !== 'string' || opts.branch.trim() === '')) {
    return { ok: false, error: 'invalid args: branch', detail: '"branch" must be a non-empty string when provided' };
  }
  if (opts.goal != null && !['P1', 'P1/P2', 'P1/P2/P3'].includes(opts.goal)) {
    return { ok: false, error: 'invalid args: goal', detail: '"goal" must be one of "P1" | "P1/P2" | "P1/P2/P3"' };
  }
  if (opts.max_cycles != null && !(Number.isInteger(Number(opts.max_cycles)) && Number(opts.max_cycles) > 0)) {
    return { ok: false, error: 'invalid args: max_cycles', detail: '"max_cycles" must be a positive integer' };
  }
  if (opts.base_branch != null && (typeof opts.base_branch !== 'string' || opts.base_branch.trim() === '')) {
    return { ok: false, error: 'invalid args: base_branch', detail: '"base_branch" must be a non-empty string when provided' };
  }
  if (opts.skip_dolt_push != null && typeof opts.skip_dolt_push !== 'boolean') {
    return { ok: false, error: 'invalid args: skip_dolt_push', detail: '"skip_dolt_push" must be a boolean when provided' };
  }
  return { ok: true };
}

// assertCalibrationComplete: walks every numeric calibration path the cost/context
// arithmetic reads and heals any missing or NaN value from defaults. Operates on a
// deep-enough clone so neither the input calibration nor the defaults are mutated.
// Returns { calibration, healed } where healed is an array of human-readable strings
// describing each healed path (caller WARNs per entry).
function assertCalibrationComplete(calibration, defaults) {
  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const setPath = (obj, path, val) => {
    const keys = path.split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      // Clone-on-write so the caller's nested objects are never mutated.
      cur[k] = Object.assign({}, cur[k]);
      cur = cur[k];
    }
    cur[keys[keys.length - 1]] = val;
  };
  const requiredPaths = [
    'model_prices_per_1m_output_tokens.cheap',
    'model_prices_per_1m_output_tokens.standard',
    'model_prices_per_1m_output_tokens.premium',
    'complexity_buckets.S.doer_tokens',
    'complexity_buckets.M.doer_tokens',
    'complexity_buckets.L.doer_tokens',
    'reviewer_ratio.value',
    'cycle_assumptions.optimistic',
    'cycle_assumptions.expected',
    'cycle_assumptions.pessimistic',
    'fixed_overhead_tokens.setup',
    'fixed_overhead_tokens.planner',
    'fixed_overhead_tokens.plan_reviewer',
    'fixed_overhead_tokens.harvester',
    'fixed_overhead_tokens.ci_watcher',
    'fixed_overhead_tokens.log_flush_per_cycle',
    'input_cost_multiplier.value',
    'outlier_thresholds.notable_pct',
    'outlier_thresholds.outlier_pct',
    'outlier_thresholds.calibration_failure_pct',
    'doer_token_ceiling.cheap',
    'doer_token_ceiling.standard',
    'doer_token_ceiling.premium',
    'context_limits.model_context_tokens.cheap',
    'context_limits.model_context_tokens.standard',
    'context_limits.model_context_tokens.premium',
    'context_limits.autocompact_headroom_fraction',
    'context_limits.base_prompt_tokens',
    'context_limits.per_task_input_overhead_tokens',
    'parallelism.max_doers',
  ];
  const healed = [];
  const result = Object.assign({}, calibration);
  for (const path of requiredPaths) {
    const val = getPath(result, path);
    if (typeof val !== 'number' || Number.isNaN(val)) {
      const def = getPath(defaults, path);
      setPath(result, path, def);
      healed.push(`calibration field ${path} missing/invalid -- healed to ${def}`);
    }
  }
  return { calibration: result, healed };
}

// checkModelAliasStaleness: returns "tier=id" strings for any TIER_TO_MODEL value
// that looks like a dated pin (ends in -YYYYMMDD). Caller WARNs if non-empty.
function checkModelAliasStaleness(tierToModel) {
  const stale = [];
  for (const [tier, id] of Object.entries(tierToModel || {})) {
    if (typeof id === 'string' && /-\d{8}$/.test(id)) stale.push(`${tier}=${id}`);
  }
  return stale; // caller WARNs if non-empty
}

// fitStreakToContext: predicts whether an in-order streak fits the doer's usable
// context and returns the longest prefix that does. Mirrors truncateStreakToCeiling's
// per-task token estimate. Returns { fittedIds, estContext, available, wouldOverflow }.
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

// Build a per-phase wall-clock report from ordered epoch stamps captured at phase boundaries.
// Each stamp is {name, epoch}; the elapsed time attributed to a phase is the delta from its
// stamp to the NEXT stamp. Turns "the sprint is slow" into "develop was N of M seconds", which
// is what proves the parallel-doer win with numbers. Pure -- no Date/clock access of its own.
function buildPhaseTiming(stamps) {
  const clean = (stamps || []).filter(s => s && s.name && Number.isFinite(s.epoch));
  const rows = [];
  for (let i = 0; i < clean.length - 1; i++) {
    const seconds = Math.max(0, clean[i + 1].epoch - clean[i].epoch);
    rows.push({ phase: clean[i].name, seconds });
  }
  const totalSeconds = rows.reduce((a, r) => a + r.seconds, 0);
  const fmt = s => {
    const m = Math.floor(s / 60), sec = s % 60;
    return m > 0 ? `${m}m${sec.toString().padStart(2, '0')}s` : `${sec}s`;
  };
  const pct = s => (totalSeconds > 0 ? Math.round((s / totalSeconds) * 100) : 0);
  const text = rows.length
    ? rows.map(r => `  ${r.phase}: ${fmt(r.seconds)} (${pct(r.seconds)}%)`).join('\n') +
      `\n  TOTAL: ${fmt(totalSeconds)}`
    : '  (no phase timing captured)';
  return { rows, totalSeconds, text };
}

// Flatten ready streaks into a deterministic, de-duplicated task batch for parallel doers.
// Each parallel doer works exactly ONE task in its own worktree, so the per-doer context is a
// single task (no context-fit split needed here -- that split only matters when one doer chains
// multiple tasks, which the parallel path does not do). We simply take up to `maxDoers` ready
// tasks. Ordering is by task id so the later sequential merge is reproducible run-to-run.
// Leftover ready tasks are returned as `deferred` and resurface on the next getReadyStreaks call.
// Pure -- no I/O, no Date/Math.random.
function computeDoerBatch(streaks, maxDoers) {
  const seen = {};
  const tasks = [];
  for (const s of (streaks || [])) {
    const model = s && s.model;
    for (const id of ((s && s.ids) || [])) {
      if (id != null && !seen[id]) { seen[id] = true; tasks.push({ id, model }); }
    }
  }
  tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cap = Math.max(1, maxDoers || 1);
  const width = Math.min(cap, tasks.length || 1);
  return { batch: tasks.slice(0, width), deferred: tasks.slice(width), width, readyCount: tasks.length };
}

// Derive the filesystem-safe worktree path and temp branch name for a parallel doer's task.
// The temp branch is namespaced by the sprint branch so concurrent sprints never collide.
// Both are sanitized so arbitrary bd ids / branch names (any of hundreds of projects) are safe
// as path and ref components. Pure.
function worktreeNamesFor(sprintBranch, taskId, worktreeRoot) {
  const safeId = String(taskId).replace(/[^a-zA-Z0-9._-]/g, '-');
  const safeBranch = String(sprintBranch).replace(/[^a-zA-Z0-9._-]/g, '-');
  const root = (worktreeRoot || '.auto-sprint/wt').replace(/\/+$/g, '');
  return {
    path: `${root}/${safeId}`,
    branch: `auto-sprint/wt/${safeBranch}/${safeId}`,
  };
}

// PURE_FUNCTIONS_END

// ROLE_SCHEMAS_GENERATED_BEGIN -- do not hand-edit; run `node scripts/gen-auto-sprint-schemas.mjs` to regenerate from agents/schemas/*.json
//
// apra-fleet-unw.21 / apra-fleet e2e s10 (2026-07-17): the role-contract schemas
// below are generated from packages/apra-fleet-se/apra-pm's own canonical, machine-readable role
// contracts at agents/schemas/<role>-output.json, instead of being hand-copied
// inline literals -- this closes the drift this file used to have from the
// vendored agents/*.md prose and from packages/apra-fleet-se/auto-sprint/contracts.mjs.
// The "version" key present in each source file is dropped: it is a non-standard
// JSON-Schema keyword the agent tool's strict schema validator rejects.
//
// Inlined at BUILD TIME (not loaded via require('fs') at runtime) because this file
// runs inside Claude's Workflow tool sandbox, which has no filesystem/require access
// -- a prior runtime-load revision crashed on every invocation with "require is not
// defined". See scripts/gen-auto-sprint-schemas.mjs, which generates this block.
const REVIEW_SCHEMA = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "apra-pm/reviewer-output@1",
  "title": "reviewer output",
  "description": "Canonical machine-readable output contract for the reviewer role. See agents/reviewer.md Step 5 for the prose contract this mirrors.",
  "type": "object",
  "required": [
    "verdict",
    "notes",
    "reopenIds",
    "newTasks"
  ],
  "properties": {
    "verdict": {
      "type": "string",
      "enum": [
        "APPROVED",
        "CHANGES_NEEDED"
      ]
    },
    "notes": {
      "type": "string"
    },
    "reopenIds": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "replanIds": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "newTasks": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "title",
          "description",
          "priority"
        ],
        "properties": {
          "title": {
            "type": "string"
          },
          "description": {
            "type": "string"
          },
          "priority": {
            "type": "string"
          }
        }
      }
    }
  }
};
const PLAN_REVIEW_SCHEMA = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "apra-pm/plan-reviewer-output@1",
  "title": "plan-reviewer output",
  "description": "Canonical machine-readable output contract for the plan-reviewer role. See agents/plan-reviewer.md Step 4 for the prose contract this mirrors.",
  "type": "object",
  "required": [
    "verdict",
    "notes",
    "taskAssignments"
  ],
  "properties": {
    "verdict": {
      "type": "string",
      "enum": [
        "APPROVED",
        "CHANGES_NEEDED"
      ]
    },
    "notes": {
      "type": "string"
    },
    "taskAssignments": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "id",
          "bucket",
          "model"
        ],
        "properties": {
          "id": {
            "type": "string"
          },
          "bucket": {
            "type": "string",
            "enum": [
              "S",
              "M",
              "L"
            ]
          },
          "model": {
            "type": "string"
          }
        }
      }
    }
  }
};
const DOER_STATUS_SCHEMA = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "apra-pm/doer-output@1",
  "title": "doer output",
  "description": "Canonical machine-readable output contract for the doer role. See agents/doer.md Step 3 (VERIFY checkpoint) and Branch and secrets rules (BLOCKED) for the prose contract this mirrors.",
  "type": "object",
  "required": [
    "status",
    "closedIds",
    "notes"
  ],
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "VERIFY",
        "BLOCKED"
      ]
    },
    "closedIds": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "notes": {
      "type": "string"
    }
  }
};
const DEPLOYER_SCHEMA = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "apra-pm/deployer-output@1",
  "title": "deployer output",
  "description": "Canonical machine-readable output contract for the deployer role. See agents/deployer.md Output schema for the prose contract this mirrors.",
  "type": "object",
  "required": [
    "deployed",
    "notes"
  ],
  "properties": {
    "deployed": {
      "type": "boolean"
    },
    "notes": {
      "type": "string"
    }
  }
};
const INTEG_RUN_SCHEMA = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "apra-pm/integ-test-runner-output@1",
  "title": "integ-test-runner output",
  "description": "Canonical machine-readable output contract for the integ-test-runner role. See agents/integ-test-runner.md Step 4 for the prose contract this mirrors.",
  "type": "object",
  "required": [
    "featuresClosed",
    "issuesCreated",
    "passed",
    "bugsFiled",
    "summary"
  ],
  "properties": {
    "featuresClosed": {
      "type": "number"
    },
    "issuesCreated": {
      "type": "number"
    },
    "passed": {
      "type": "boolean"
    },
    "bugsFiled": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "summary": {
      "type": "string"
    },
    "deployedSha": {
      "type": "string",
      "description": "The deploy-verified git commit part 2 (smoke test) actually ran against. Optional for backward compatibility, but an orchestrator that supplied a deployed SHA in the dispatch prompt treats a missing or mismatching value as INCONCLUSIVE evidence (never a pass). See integ-test-runner.md 'Part-2 evidence freshness'."
    }
  }
};
const CI_SCHEMA = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "apra-pm/ci-watcher-output@1",
  "title": "ci-watcher output",
  "description": "Canonical machine-readable output contract for the ci-watcher role. See agents/ci-watcher.md Step 2 for the prose contract this mirrors.",
  "type": "object",
  "required": [
    "status",
    "notes"
  ],
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "green",
        "red",
        "not_configured",
        "pending"
      ]
    },
    "notes": {
      "type": "string"
    }
  }
};
const HARVEST_SCHEMA = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "apra-pm/harvester-output@1",
  "title": "harvester output",
  "description": "Canonical machine-readable output contract for the harvester role. See agents/harvester.md Step 7 for the prose contract this mirrors.",
  "type": "object",
  "required": [
    "status",
    "notes"
  ],
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "OK",
        "FAILED"
      ]
    },
    "notes": {
      "type": "string"
    }
  }
};
// ROLE_SCHEMAS_GENERATED_END

function outputCostUsd(tier, tokens) {
  const rate = OUTPUT_PRICE_PER_M[tier] || OUTPUT_PRICE_PER_M[TIER_STANDARD];
  return (tokens / 1_000_000) * rate;
}

// Resolve a tier name to the provider-specific model ID for agent() dispatch.
// Falls back to standard tier if the tier is unrecognised.
function resolveModel(tier) {
  return TIER_TO_MODEL[tier] || TIER_TO_MODEL[TIER_STANDARD];
}

// Real output-token cost via differential budget.spent() snapshots.
// budget.spent() is the only actual usage the harness exposes (output tokens only).
// opts.model is a tier name (cheap/standard/premium); resolved to a model ID for agent().
// opts.context -- short human string describing what was worked (e.g. "tasks BD-5,BD-6")
let cycleCostUsd = 0;
const dispatchLedger = [];  // accumulates across all cycles; flushed to sprint-logs/<branch>.jsonl per cycle

async function dispatch(prompt, opts) {
  const tier = opts.model || TIER_STANDARD;
  const modelId = resolveModel(tier);
  const before = budget.spent();
  const result = await agent(prompt, { ...opts, model: modelId });
  const outTokens = budget.spent() - before;
  const cost = outputCostUsd(tier, outTokens);
  cycleCostUsd += cost;
  const entry = {
    cycle:   cycleCount === 0 ? 'setup' : cycleCount,
    phase:   opts.phase  || '?',
    label:   opts.label  || '?',
    model:   tier,
    context: opts.context || '',
    outTokens,
    costUsd: parseFloat(cost.toFixed(4)),
  };
  dispatchLedger.push(entry);
  if (outTokens > 0) log(`$${cost.toFixed(4)} ${opts.label || '?'} -- ${opts.context || opts.phase || '?'}`);
  return result;
}


// ------------------------------------------------------------ shell dispatch
//
// All three exit-check helpers below run a tiny, fixed set of read-only commands
// (`bd graph --json <goal-id> | node-extract` plus one `bd list ... | node-extract`)
// via a single Haiku dispatch and parse the result with a pure parser above.
//
// Latency-hardening (gh-7: check-blockers once took 12.5 min):
//   * Root cause -- the dispatch prompt said "return each command's stdout
//     verbatim" against a strict array-of-strings schema, with NO turn cap. A
//     stray escaping/parse concern on the (potentially large) `bd graph` output
//     made the agent re-run commands and re-emit output across many turns, so a
//     5-second job could burn minutes. The node extractors already shrink output
//     to an ID list / tiny JSON, so the only real failure mode was looping.
//   * Fix -- (a) every shell dispatch is a SINGLE-ATTEMPT contract: maxTurns is
//     bounded to (#commands + 1), so the agent physically cannot loop for
//     minutes; (b) the prompt is explicit that it must run each command exactly
//     once and never retry/re-run; (c) parsing is fully tolerant (pure parsers
//     return a fail-safe sentinel on bad/short output) so there is never a reason
//     to bounce work back to the agent.
const SHELL_DISPATCH_PROMPT_HEADER =
  `Run each command below EXACTLY ONCE, in order. Return each command's stdout ` +
  `as one string element of outputs[] (same order; outputs.length must equal the ` +
  `number of commands).\n` +
  `Rules: do NOT summarize, reformat, interpret, or escape the output. Do NOT ` +
  `re-run any command. Do NOT retry on empty or unexpected output -- an empty ` +
  `string is a valid result; just return it. This is a single attempt: run, ` +
  `capture, return, stop.\n\n`;

function buildShellPrompt(cmds) {
  return SHELL_DISPATCH_PROMPT_HEADER + cmds.map((c, i) => `${i + 1}. ${c}`).join('\n');
}

// Bound the agent to one turn per command plus a single wrap-up turn. The harness
// stops the dispatch at maxTurns, so a misbehaving agent cannot stall for minutes.
function shellMaxTurns(cmds) {
  return cmds.length + 1;
}

async function dispatchShell(cmds, opts) {
  return dispatch(buildShellPrompt(cmds), {
    schema: SHELL_OUTPUTS_SCHEMA,
    maxTurns: shellMaxTurns(cmds),
    ...opts,
  });
}

// Run multiple async operations in parallel and return all results.
// This is a convenience wrapper around Promise.all() for readability.
async function parallel(tasks) {
  return Promise.all(tasks);
}

// bd may prepend a `warning: ...` line to its --json stdout (notably bd 1.1.0's
// "warning: beads.role not configured (GH#2950)"). In a normal terminal that goes to
// stderr, but inside the workflow's sandboxed shell-dispatch subagents stderr merges
// into the captured stdout, so the warning is glued in front of the JSON. Feeding that
// straight into JSON.parse() throws; the surrounding catch then silently returns an empty
// ready/blocker set, and Develop concludes "no ready tasks" (spurious deadlock / skipped
// develop with zero doers -- the s10 win32 failure). BD_JSON extracts just the JSON span
// (first '['/'{' to the last ']'/'}') so parsing tolerates leading/trailing non-JSON noise.
// Deliberately backslash-free (indexOf/lastIndexOf on literal bracket chars) so it survives
// the backtick -> shell(double-quote) -> node round-trip with no escaping. Interpolated as
// `JSON.parse(${BD_JSON})` inside the node -e extractor strings below.
const BD_JSON = `(()=>{const s=d.indexOf('['),o=d.indexOf('{');let a=s<0?o:(o<0?s:Math.min(s,o));const e=Math.max(d.lastIndexOf(']'),d.lastIndexOf('}'));return a>=0&&e>=a?d.slice(a,e+1):d;})()`;

// bdSubtreeSnippet: returns a JS snippet (embedded in a `node -e` extractor, AFTER
// `const g = JSON.parse(...)`) that builds `subtree` = the STRICT sprint inventory for
// `rootsArr`: the roots, their dotted-ID descendants (beads' <parent>.<n> hierarchy), and
// anything transitively reachable from that set via DependsOn edges.
//
// Why: `bd graph --json <root>` returns the ENTIRE connected component -- including the
// root's PARENT and therefore its SIBLINGS. The old extractors scraped every `.issues[].id`
// out of that blob, so unrelated sibling tasks (e.g. gh-toy-4ef, a sibling of gh-toy-mi2
// under a shared parent) leaked into the active sprint inventory, making getReadyStreaks
// dispatch work outside the charter and the final reviewer hallucinate "missing" tasks.
//
// The ID-prefix pass is the wiring-independent core: beads always expresses parent->child
// as `<parent>.<n>` IDs, so `id === r || id.startsWith(r + '.')` captures exactly a root's
// descendants and never its siblings -- and it works even when DependsOn edges are absent
// (verified: apra-pm's own DB has all-null DependsOn), so the subtree is never
// under-inclusive (no false "no ready tasks" deadlock). The DependsOn BFS then additionally
// pulls in explicitly-wired prerequisites. Backslash-free for the backtick->shell->node
// round-trip. Reads `g` (the parsed graph) and `subtree` (a Set) from the enclosing scope.
function bdSubtreeSnippet(rootsArr) {
  const rootsLit = (rootsArr || []).join(' ');
  return `const _roots='${rootsLit}'.split(' ').filter(Boolean);` +
    `const subtree=new Set(_roots);` +
    `const _nodes=(g.layout&&g.layout.Nodes)||{};` +
    `const _ids=new Set([...Object.keys(_nodes),...((g.issues||[]).map(i=>i.id))]);` +
    `for(const _id of _ids){for(const _r of _roots){if(_id===_r||_id.indexOf(_r+'.')===0){subtree.add(_id);break;}}}` +
    `const _q=Array.from(subtree);` +
    `while(_q.length>0){const _c=_q.shift();const _n=_nodes[_c];if(_n&&_n.DependsOn){for(const _dd of _n.DependsOn){if(!subtree.has(_dd)){subtree.add(_dd);_q.push(_dd);}}}}`;
}

async function countBeadsBlockers(thr, roots, includeFeatures) {
  // Extract only IDs from bd graph to keep output small (avoids $(cat ...) file-reference issue).
  const idExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{const g=JSON.parse(${BD_JSON});${bdSubtreeSnippet(roots)}console.log(Array.from(subtree).join(' '))}catch{}"`;
  const openExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.stringify(JSON.parse(${BD_JSON}).map(i=>({id:i.id,p:i.priority,t:i.issue_type}))))}catch{console.log('[]')}"`;
  const cmds = [
    ...roots.map(id => `bd graph --json ${id} | ${idExtract}`),
    `bd list --status=open --json | ${openExtract}`,
  ];
  const r = await dispatchShell(cmds, { model: MODEL_HAIKU, label: 'check-blockers', phase: 'Develop' });
  // Leaf-scoped done-condition: open non-root type=task at priority<=thr, plus type=feature
  // only when includeFeatures (integ tests close features in-loop). See parseBlockers opts.
  return parseBlockers(r?.outputs, roots.length, roots.length, thr, { rootIds: roots, leaf: true, includeFeatures });
}

async function getReadyStreaks(rootIds) {
  // Extract only IDs from bd graph to keep output small (avoids $(cat ...) file-reference issue).
  const idExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{const g=JSON.parse(${BD_JSON});${bdSubtreeSnippet(rootIds)}console.log(Array.from(subtree).join(' '))}catch{}"`;
  // Catch fallback emits 'null' (not '[]'): parseReadyStreaks must be able to tell
  // "extraction failed" apart from "genuinely zero ready tasks" -- see its extractFailed
  // contract note above. 'null' is valid JSON but not an array, so JSON.parse(...) still
  // succeeds while the array-shape check flags extractFailed.
  const taskExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.stringify(JSON.parse(${BD_JSON}).map(i=>({id:i.id,p:i.priority,m:(i.metadata||{}).model}))))}catch{console.log('null')}"`;
  const cmds = [
    ...rootIds.map(id => `bd graph --json ${id} | ${idExtract}`),
    `bd list --ready --type=task --json | ${taskExtract}`,
  ];
  const r = await dispatchShell(cmds, { model: MODEL_HAIKU, label: 'ready-streaks', phase: 'Develop' });
  return parseReadyStreaks(r?.outputs, rootIds.length, rootIds.length, TIER_STANDARD, rootIds);
}

async function commitFeedback(repo, branch, notes, role, label, phase) {
  await dispatch(
    `Repo: ${repo}\nBranch: ${branch}\n\n` +
    `Write the following reviewer feedback to feedback.md (overwrite if it exists):\n\n` +
    `${notes}\n\n` +
    `Then commit and push:\n` +
    `  git -C "${repo}" add feedback.md\n` +
    `  git -C "${repo}" -c user.name='${role}' -c user.email='${role}@pm.local' commit -m "feedback: ${label}"\n` +
    `  git -C "${repo}" push origin ${branch}`,
    { model: MODEL_HAIKU, label: `feedback-commit-${label}`, phase }
  );
}

async function checkCycleState(rootIds) {
  // Extract only the fields needed for planDone check to keep output small.
  const graphExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{const g=JSON.parse(${BD_JSON});${bdSubtreeSnippet(rootIds)}const issues=(g.issues||[]).filter(i=>subtree.has(i.id));console.log(JSON.stringify(issues.map(i=>({id:i.id,t:i.issue_type,s:i.status,d:!!(i.description||'').trim()}))))}catch{console.log('[]')}"`;
  const ipExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.parse(${BD_JSON}).map(i=>i.id).join(' '))}catch{}"`;
  const cmds = [
    ...rootIds.map(id => `bd graph --json ${id} | ${graphExtract}`),
    `bd list --status=in_progress --type=task --json | ${ipExtract}`,
  ];
  const r = await dispatchShell(cmds, { model: MODEL_HAIKU, label: 'cycle-state', phase: 'Plan' });
  return parseCycleState(r?.outputs, rootIds.length);
}

// getSprintOpenFeatures: the OPEN features that live in THIS sprint's subtree, as [{id,title}].
// The integration tester must test/close only these -- NOT `bd list --type=feature --status=open`,
// which returns every open feature in the whole beads DB (a populated DB has features from other
// epics/sprints, so an unscoped list makes the tester test, close, or file bugs against unrelated
// work). Uses the same strict bdSubtreeSnippet inventory as the develop-phase extractors, so
// siblings/parents dragged in by `bd graph`'s connected component are excluded.
async function getSprintOpenFeatures(rootIds) {
  const featExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{const g=JSON.parse(${BD_JSON});${bdSubtreeSnippet(rootIds)}const ff=(g.issues||[]).filter(i=>subtree.has(i.id)&&i.issue_type==='feature'&&i.status!=='closed');console.log(JSON.stringify(ff.map(i=>({id:i.id,title:(i.title||'').slice(0,120)}))))}catch{console.log('[]')}"`;
  const cmds = rootIds.map(id => `bd graph --json ${id} | ${featExtract}`);
  const r = await dispatchShell(cmds, { model: MODEL_HAIKU, label: 'integ-scope', phase: 'Test' });
  const byId = new Map();
  for (const out of (r?.outputs || [])) {
    try { for (const f of JSON.parse(out)) if (f && f.id) byId.set(f.id, f); } catch {}
  }
  return Array.from(byId.values());
}

// ---- sprint state file: concurrency lock + phase checkpoint / resume ----
// A branch-keyed JSON file under sprint-logs/.state/ records the last good phase and
// cycle so a crashed run resumes forward instead of restarting. Its mtime doubles as a
// liveness lock: a file touched within SPRINT_STATE_TTL_S means another run is active.
// All time/mtime math is done inside node subprocesses (Date.now() is banned in the
// workflow script body, but fine inside `node -e`). Cross-platform: pure node fs, no stat(1).
const SPRINT_STATE_TTL_S = 3600;
function sprintStateFileFor(branchName) {
  const safe = branchName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'default';
  return `sprint-logs/.state/${safe}.state.json`;
}
// Returns { exists, ageS, state }. ageS is the file's age in seconds (null when absent).
async function readSprintState(stateFileRel, label) {
  const script =
    `node -e "` +
    `const fs=require('fs');const p='${stateFileRel}';` +
    `if(!fs.existsSync(p)){console.log(JSON.stringify({exists:false,ageS:null,state:null}));process.exit(0);}` +
    `const age=Math.floor((Date.now()-fs.statSync(p).mtimeMs)/1000);` +
    `let st=null;try{st=JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){}` +
    `console.log(JSON.stringify({exists:true,ageS:age,state:st}));` +
    `"`;
  const r = await dispatchShell([script], { model: MODEL_HAIKU, label: label || 'state-read', phase: 'Plan' });
  try { return JSON.parse((r?.outputs?.[0] || '').trim()); } catch { return { exists: false, ageS: null, state: null }; }
}
// Writes the state object as JSON. The JSON is hex-encoded in the workflow body (which
// has ONLY standard JS built-ins -- NOT Buffer/process/require) and decoded inside the
// node subprocess (which has them). Hex is quote-safe so it embeds cleanly in the
// double-quoted `node -e` string; charCodeAt/fromCharCode round-trip UTF-16 exactly.
// Rewriting the file updates its mtime = lock heartbeat.
async function writeSprintState(stateFileRel, stateObj, phaseName, label) {
  const json = JSON.stringify(stateObj);
  let hex = '';
  for (let i = 0; i < json.length; i++) hex += json.charCodeAt(i).toString(16).padStart(4, '0');
  const script =
    `node -e "` +
    `const fs=require('fs'),path=require('path');const p='${stateFileRel}';const h='${hex}';` +
    `let s='';for(let i=0;i<h.length;i+=4)s+=String.fromCharCode(parseInt(h.substr(i,4),16));` +
    `fs.mkdirSync(path.dirname(p),{recursive:true});` +
    `fs.writeFileSync(p,s);` +
    `console.log('WROTE');` +
    `"`;
  await dispatchShell([script], { model: MODEL_HAIKU, label: label || 'state-write', phase: phaseName || 'Plan' });
}
async function clearSprintState(stateFileRel, label) {
  await dispatchShell([`rm -f "${stateFileRel}"`], { model: MODEL_HAIKU, label: label || 'state-clear', phase: 'Harvest' });
}

// ------------------------------------------------------------------ STATE

let cycleCount   = 0;
let goalMet     = false;
let prevOpenIds  = [];
let headSha      = '';
let abortReason  = '';

// ------------------------------------------------------------------ SETUP

phase('Plan');

// Phase 1: deterministic setup steps -- run via dispatchShell so each command
// executes exactly once with a bounded turn cap (no LLM looping on simple checks).
//
// Fixed output indices (always 8 elements regardless of branch/no-branch):
//   0: repo root (git rev-parse --show-toplevel)
//   1: fetch result (FETCHED / FETCH_FAIL) -- run BEFORE checkout so a new sprint
//      branch is cut from the freshest origin/<base_branch> (guards stale-main branching).
//      Also (side effect, no stdout) registers the sprint scaffolding dirs in the repo's
//      local git exclude so the state file and any worktree roots never leak into a doer's
//      `git add -A` / the committed sprint-logs/ tree and pollute the PR diff.
//   2: branch checkout result (or "no-op" when branch was not specified)
//   3: confirmed branch name (git rev-parse --abbrev-ref HEAD)
//   4: startedAt timestamp (date +%Y%m%d_%H%M%S)
//   5: deploy.md exists (YES/NO)
//   6: integ-test-playbook.md exists (YES/NO)
//   7: newline-joined list of permission entries declared in deploy.md /
//      integ-test-playbook.md's "## Permissions" sections that are NOT yet
//      in .claude/settings.json's permissions.allow (empty string if none --
//      computed deterministically here so Step 5's prompt to the agent never
//      has to say "you may grant yourself permissions" when there's nothing
//      to grant).
const setupShellCmds = [
  `git rev-parse --show-toplevel`,
  // Fetch first so branch creation below can base a NEW sprint branch on the freshest
  // origin/<base_branch> instead of a possibly-stale local HEAD (stale-main guard).
  // The `{ ... }` block writes only to a file (no stdout), so the slot's stdout stays
  // exactly FETCHED/FETCH_FAIL. Uses `git rev-parse --git-path` so it resolves correctly
  // in linked worktrees too; the trailing `;` guarantees the fetch runs regardless.
  `EXCL=$(git rev-parse --git-path info/exclude 2>/dev/null); ` +
    `if [ -n "$EXCL" ]; then mkdir -p "$(dirname "$EXCL")"; ` +
    `grep -qxF 'sprint-logs/.state/' "$EXCL" 2>/dev/null || ` +
    `printf 'sprint-logs/.state/\\n.auto-sprint/\\n' >> "$EXCL"; fi; ` +
    `git fetch origin --quiet && echo FETCHED || echo FETCH_FAIL`,
  branch
    // Prefer the freshest origin/<base_branch> as the new branch's base (stale-main guard), but if
    // that ref is absent (repo's default is e.g. master, or fetch failed) fall back to creating from
    // local HEAD -- never leave HEAD on the wrong branch, which would silently run the sprint there.
    ? `git checkout "${branch}" 2>/dev/null || git checkout --track "origin/${branch}" 2>/dev/null || git checkout -b "${branch}" "origin/${base_branch}" 2>/dev/null || git checkout -b "${branch}"`
    : `echo "no-op"`,
  `git rev-parse --abbrev-ref HEAD`,
  `date +%Y%m%d_%H%M%S`,
  `test -f deploy.md && echo YES || echo NO`,
  `test -f integ-test-playbook.md && echo YES || echo NO`,
  `node -e "` +
    `const fs=require('fs');` +
    `function permsFrom(file){` +
      `if(!fs.existsSync(file))return[];` +
      `const text=fs.readFileSync(file,'utf8');` +
      `const idx=text.indexOf('## Permissions');` +
      `if(idx<0)return[];` +
      `const rest=text.slice(idx);` +
      `const next=rest.indexOf('\\n## ',3);` +
      `const section=next>=0?rest.slice(0,next):rest;` +
      // Any Tool(...) entry (not just flush-left Bash): allow a leading bullet/indent and inner ')'.
      `return(section.match(/^[ \\t]*[-*]?[ \\t]*[A-Za-z_][A-Za-z0-9_]*\\([^\\n]*\\)[ \\t]*$/gm)||[])` +
        `.map(s=>s.replace(/^[ \\t]*[-*]?[ \\t]*/,'').trim());` +
    `}` +
    `const declared=[...new Set([...permsFrom('deploy.md'),...permsFrom('integ-test-playbook.md')])];` +
    `let existing=[];` +
    `try{existing=(JSON.parse(fs.readFileSync('.claude/settings.json','utf8')).permissions||{}).allow||[];}catch(e){}` +
    `const missing=declared.filter(p=>!existing.includes(p));` +
    // Newline-delimited, not comma: a permission pattern may contain commas, e.g. Bash(cmd --a=1,2).
    `console.log(missing.join(String.fromCharCode(10)));` +
  `"`,
];
const setupShell = await dispatchShell(setupShellCmds, {
  model: MODEL_HAIKU, label: 'setup-shell', phase: 'Plan',
});

const _outs = setupShell && Array.isArray(setupShell.outputs) ? setupShell.outputs : [];
const _detectedRepo    = (_outs[0] || '').trim();
const _fetchResult     = (_outs[1] || '').trim();
const _detectedBranch  = (_outs[3] || '').trim();
const _detectedTs      = (_outs[4] || '').trim();
const _deployExists    = (_outs[5] || '').trim() === 'YES';
const _playbookExists  = (_outs[6] || '').trim() === 'YES';
const _missingPerms    = (_outs[7] || '').trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);

if (!_detectedRepo || !_detectedBranch) {
  log('ERROR: setup-shell failed -- could not detect repo root or branch');
  return { error: 'setup failed' };
}

// PREFLIGHT (latest HEAD) -- a failed fetch means we cannot guarantee the sprint branch
// was cut from the latest origin/<base_branch>; there is no safe silent fallback. Hard-fail.
if (_fetchResult === 'FETCH_FAIL') {
  log(`ERROR: preflight -- git fetch origin failed; cannot guarantee branch is off latest ${base_branch}. Check network/remote and retry.`);
  return { error: 'preflight: git fetch failed' };
}

// Phase 2: free-form setup steps (permissions merge, calibration, transcript dir).
// maxTurns: 20 backstop prevents a runaway agent from stalling indefinitely.
const step5Block = _missingPerms.length > 0
  ? (
    `Step 5: Add these specific missing permission entries to .claude/settings.json's\n` +
    `  permissions.allow array (create the file/array if absent). Add ONLY these entries,\n` +
    `  nothing else, and do not remove or modify anything else in the file:\n` +
    _missingPerms.map(p => `    - ${p}`).join('\n') + `\n\n`
  )
  : `Step 5: Already satisfied -- every permission declared in deploy.md / integ-test-playbook.md\n` +
    `  is already present in .claude/settings.json. Do nothing for this step.\n\n`;
const setup = await dispatch(
  `Sprint workspace setup (Phase 2 -- deterministic steps already done).\n\n` +
  `Pre-known values (do NOT re-run these commands):\n` +
  `  repo:           ${_detectedRepo}\n` +
  `  branch:         ${_detectedBranch}\n` +
  `  startedAt:      ${_detectedTs}\n` +
  `  deployMdExists: ${_deployExists}\n` +
  `  playbookExists: ${_playbookExists}\n\n` +
  `Your job is only Steps 5-7 below. Return ALL fields in your schema response,\n` +
  `including the pre-known values above.\n\n` +
  step5Block +
  `Step 6: Load or bootstrap calibration data.\n` +
  `  If sprint-logs/calibration.json exists in the repo root:\n` +
  `    Run: cat sprint-logs/calibration.json\n` +
  `    Return the exact stdout of that command as the "calibrationRaw" field (verbatim -- do not reformat or summarize).\n` +
  `  If it does NOT exist (first run):\n` +
  `    Create the sprint-logs/ directory: mkdir -p sprint-logs\n` +
  `    Write the following JSON exactly to sprint-logs/calibration.json:\n` +
  JSON.stringify(DEFAULT_CALIBRATION, null, 2) + `\n` +
  `    Return that same JSON text verbatim as the "calibrationRaw" field.\n\n` +
  `Step 7: Resolve transcript directory.\n` +
  `  Claude subagent conversation logs (JSONL) are stored under:\n` +
  `    $HOME/.claude/projects/<project-slug>/\n` +
  `  where <project-slug> is derived from the repo absolute path by uppercasing the\n` +
  `  drive letter and replacing path separators with dashes.\n` +
  `  Run: ls "$HOME/.claude/projects/" 2>/dev/null\n` +
  `  Find the entry whose slug matches the repo path (e.g. repo=/c/foo/bar -> C--foo-bar).\n` +
  `  If found, return the full path as transcriptDir. If not found, return an empty string.\n\n` +
  `Return repo (absolute path), branch (confirmed), deployMdExists, playbookExists, startedAt, calibrationRaw, transcriptDir.`,
  { model: MODEL_HAIKU, label: 'setup', phase: 'Plan', schema: SETUP_SCHEMA, maxTurns: 20 }
);

if (!setup || !setup.repo || !setup.branch) {
  log('ERROR: setup failed -- could not assert branch or locate repo');
  return { error: 'setup failed' };
}

const repo = setup.repo;
branch = setup.branch;  // use the confirmed/detected branch for all subsequent agent prompts

// Refuse to run a sprint directly on a protected branch -- all work must go on a feature branch.
if (branch === 'main' || branch === 'master') {
  log(`ERROR: sprint branch resolved to "${branch}" -- refusing to run on a protected branch. Pass a branch arg to create or switch to a sprint branch.`);
  return { error: 'protected branch' };
}

// ---- CONCURRENCY LOCK + RESUME (branch-keyed state file) ----
// Placed after setup so the confirmed branch name keys the state file. Every branch below
// is a NO-OP when no state file exists -- a fresh run follows the exact prior code path.
const stateFileRel = sprintStateFileFor(branch);
const _priorState = await readSprintState(stateFileRel, 'state-read');
let effectiveStartedAt = setup.startedAt;
if (_priorState.exists && typeof _priorState.ageS === 'number' && _priorState.ageS < SPRINT_STATE_TTL_S) {
  log(`ERROR: preflight -- another auto-sprint run appears active on branch "${branch}" (state updated ${_priorState.ageS}s ago < ${SPRINT_STATE_TTL_S}s TTL). Refusing to start a second overlapping run (guards concurrent-checkout corruption). If the prior run truly crashed, wait out the TTL or delete ${repo}/${stateFileRel}.`);
  return { error: 'preflight: sprint already running' };
}
if (_priorState.exists && _priorState.state) {
  const _rc = Number(_priorState.state.cycle) || 0;
  if (_priorState.state.startedAt) effectiveStartedAt = _priorState.state.startedAt;  // keep log-file continuity
  if (_rc > 0) cycleCount = _rc - 1;  // re-enter the loop at the crashed cycle (loop increments first)
  log(`RESUME: stale state for "${branch}" (age ${_priorState.ageS}s, lastGoodPhase=${_priorState.state.phase || '?'}, cycle=${_rc}) -- resuming from cycle ${_rc} instead of restarting. Beads state (durable closed tasks, planDone detection, orphan reset) drives intra-cycle correctness; no junk issues are re-created.`);
}

// ---- PREFLIGHT: beads schema gate (bd remote-migrate block, #4259) ----
// If the repo's beads DB is remote-backed and its Dolt schema is BEHIND the installed bd, bd
// refuses to auto-migrate the shared remote (independent migration forks the schema), and every
// write the sprint makes -- planner `bd create`, doer `bd update --claim` / `bd close` -- is
// blocked. Left undetected the sprint dies mid-run with a cryptic error and no PR. A read-only
// `bd ready` still surfaces the gate as a warning, so probe for it up front and fail fast with
// the exact fix. Signature strings are matched loosely so this survives minor bd wording changes;
// a repo with no bd DB yet ("no beads database found") does NOT match, so there is no false abort.
const _bdGate = await dispatchShell(
  [`bd ready 2>&1 | grep -iE "refusing to auto-apply|writes are blocked|remote-backed database|forks the schema|BD_ALLOW_REMOTE_MIGRATE" | head -3 || true`],
  { model: MODEL_HAIKU, label: 'preflight-bd-schema', phase: 'Plan' }
);
const _gateHit = ((_bdGate && _bdGate.outputs && _bdGate.outputs[0]) || '').trim();
if (_gateHit) {
  log(
    `ERROR: preflight -- BEADS SCHEMA GATE. This repo's bd database is remote-backed and its Dolt ` +
    `schema is behind the installed bd, so bd is blocking all writes to avoid forking the shared ` +
    `remote (#4259). A sprint cannot claim/close/create issues in this state. Detected: ` +
    `"${_gateHit.slice(0, 180)}". FIX (single-owner DB, the common case): on the OLD bd run ` +
    `\`bd dolt push\`; install the new bd; then \`BD_ALLOW_REMOTE_MIGRATE=1 bd migrate && bd dolt push\`. ` +
    `Full runbook (incl. the multi-clone case): docs/beads-1.1.0-migration.md. Aborting before any ` +
    `work so no partial sprint or PR is produced.`
  );
  return { error: 'preflight: beads schema gate (remote-migrate block)' };
}

// Parse calibration from the raw string the setup agent returned verbatim.
// Deep-merge with DEFAULT_CALIBRATION so any missing/new field always has a valid value.
// historical gets its own merge because it accumulates real sprint history on top of the zeros.
let _parsedCalib = {};
try { _parsedCalib = JSON.parse(setup.calibrationRaw || '{}'); } catch {}
const _mergedCalibration = Object.assign({}, DEFAULT_CALIBRATION, _parsedCalib, {
  historical:                      Object.assign({}, DEFAULT_CALIBRATION.historical,                      _parsedCalib.historical                      || {}),
  complexity_buckets:              _parsedCalib.complexity_buckets              || DEFAULT_CALIBRATION.complexity_buckets,
  model_prices_per_1m_output_tokens: _parsedCalib.model_prices_per_1m_output_tokens || DEFAULT_CALIBRATION.model_prices_per_1m_output_tokens,
  role_models:                     _parsedCalib.role_models                     || DEFAULT_CALIBRATION.role_models,
  fixed_overhead_tokens:           _parsedCalib.fixed_overhead_tokens           || DEFAULT_CALIBRATION.fixed_overhead_tokens,
  cycle_assumptions:               _parsedCalib.cycle_assumptions               || DEFAULT_CALIBRATION.cycle_assumptions,
  reviewer_ratio:                  _parsedCalib.reviewer_ratio                  || DEFAULT_CALIBRATION.reviewer_ratio,
  input_cost_multiplier:           _parsedCalib.input_cost_multiplier           || DEFAULT_CALIBRATION.input_cost_multiplier,
  outlier_thresholds:              _parsedCalib.outlier_thresholds              || DEFAULT_CALIBRATION.outlier_thresholds,
  doer_token_ceiling:              _parsedCalib.doer_token_ceiling              || DEFAULT_CALIBRATION.doer_token_ceiling,
  context_limits:                  _parsedCalib.context_limits                  || DEFAULT_CALIBRATION.context_limits,
});
// PREFLIGHT (calibration completeness) -- heal any numeric field the cost/context
// arithmetic reads that is missing or NaN on a stale on-disk calibration.json, filling
// from DEFAULT_CALIBRATION so estimation never produces NaN. Auto-heal + WARN.
const _calCheck = assertCalibrationComplete(_mergedCalibration, DEFAULT_CALIBRATION);
const calibration = _calCheck.calibration;
for (const h of _calCheck.healed) log(`WARN: ${h}`);
// PREFLIGHT (model-alias staleness) -- warn if any tier maps to a dated model pin.
const _staleAliases = checkModelAliasStaleness(TIER_TO_MODEL);
if (_staleAliases.length) log(`WARN: TIER_TO_MODEL has dated-looking model IDs (prefer bare aliases): ${_staleAliases.join(', ')}`);
// Sync output prices from loaded calibration so dispatchLedger uses correct rates.
Object.assign(OUTPUT_PRICE_PER_M, calibration.model_prices_per_1m_output_tokens || {});

// State for cost estimation -- populated after plan is APPROVED.
let sprintQuote = null;
// taskAssignments (id->bucket->model) from the last approved plan-review.
// Held at workflow scope so computeUpdatedCalibration can join doer log entries
// back to S/M/L buckets at sprint close without re-querying beads.
let taskAssignments = [];

// Derive a filename-safe version of the branch for sprint-logs/.
// Replaces path separators and non-safe chars with dashes so that parallel
// sprints on different branches never write to the same file.
// Timestamp (yyyymmdd_hhmmss) is captured by the setup agent so it stays
// stable across workflow resumes (Date.now() is banned in workflow scripts).
const sprintLogBranch = branch.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '') || 'default';
const sprintLogFile = `sprint-logs/${sprintLogBranch}-${effectiveStartedAt}.jsonl`;
const integTestEnabled = setup.deployMdExists && setup.playbookExists;
// startedAt "20260622_020952" -> ISO "2026-06-22T02:09:52Z" (pure string, no Date.now())
const sprintTs = effectiveStartedAt.replace(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6Z');
let flushedCount = 0;  // how many dispatchLedger entries have been appended to sprintLogFile

// Snapshot of the resolved setup, reused when writing phase checkpoints below.
// NOTE: deliberately does NOT carry calibrationRaw. The checkpoint is hex-encoded onto a
// `node -e` command line (writeSprintState); the full calibration JSON there pushed the
// command length toward the Windows ~32KB limit for no benefit -- resume never reads it
// (it re-derives calibration from the fresh Phase-2 setup, see _parsedCalib). Keep this
// object small: every field here is embedded in every heartbeat write.
const _stateBase = {
  schema_version: 1, branch, base_branch, rootIds,
  startedAt: effectiveStartedAt, repo, transcriptDir: setup.transcriptDir || '',
  integTestEnabled,
};
// Acquire the lock / record the initial checkpoint now that setup has resolved.
await writeSprintState(stateFileRel, { ..._stateBase, cycle: cycleCount, phase: 'Plan', planApproved: false }, 'Plan', 'state-init');

// Appends only the NEW (not yet flushed) ledger entries to the sprint log file.
// Fire-and-forget: does NOT await, and does NOT commit or push.
// The next natural committer (doer/sprint-meta/beads-export-cleanup) picks the file
// up via 'git add sprint-logs/' or 'git add -A'. The final-cycle entries are captured
// by an unconditional 'git add sprint-logs/' in beads-export-cleanup.
async function appendNewEntries(label, phase) {
  const newEntries = dispatchLedger.slice(flushedCount);
  if (newEntries.length === 0) return;
  // ts placeholder is replaced by the agent with the real wall-clock time at flush,
  // not the fixed sprint-start timestamp, so each flush batch gets its own timestamp.
  const lines = newEntries.map(e => JSON.stringify({ ts: '__FLUSH_TS__', ...e })).join('\n');
  flushedCount = dispatchLedger.length;  // update before dispatch so log-append entry goes in next batch
  dispatch(  // intentionally NOT awaited -- fire-and-forget write to disk only
    `Step 1: Run: date +%Y-%m-%dT%H:%M:%S%z\n` +
    `Save the output as FLUSH_TS (e.g. "2026-06-22T22:15:30+0530").\n\n` +
    `Step 2: Append (do NOT overwrite) the following lines to ${sprintLogFile} (full path: "${repo}/${sprintLogFile}").\n` +
    `If the file does not exist, create it. If the sprint-logs/ directory does not exist, create it first:\n` +
    `  mkdir -p "${repo}/sprint-logs"\n\n` +
    `In the lines below, replace every occurrence of "__FLUSH_TS__" with the FLUSH_TS value from Step 1.\n` +
    `Lines to append (one JSON object per line):\n${lines}\n\n` +
    `Do not commit, push, or modify any other file. Write the lines to disk and stop.`,
    { model: MODEL_HAIKU, label: `log-append-${label}`, phase: phase || 'Develop',
      context: `${newEntries.length} new entries` }
  );
}

log(`Repo: ${repo} | Branch: ${setup.branch}`);
log(`deploy.md: ${setup.deployMdExists} | integ-test-playbook.md: ${setup.playbookExists}`);
if (!setup.deployMdExists) log('WARNING: deploy.md not found -- integration test phase will be skipped');
if (!setup.playbookExists) log('WARNING: integ-test-playbook.md not found -- integration test phase will be skipped');
if (!integTestEnabled) log('Integration testing disabled for this sprint. Harvest will run after Develop.');

const rootSummary = rootIds.join(', ');
log(`Sprint goals: ${rootSummary} | Goal: ${goal} (P<=${threshold}) | Max cycles: ${maxCycles}`);

// ------------------------------------------------------------------ SPRINT META RECORD
// Write the first JSONL entry (type=meta) capturing sprint metadata and transcript dir.
// This is benign for existing consumers: computeSprintAnalysis skips entries without a label.
{
  const metaLine = JSON.stringify({
    ts: sprintTs, type: 'meta',
    branch, startedAt: effectiveStartedAt,
    roots: rootIds, goal,
    transcriptDir: setup.transcriptDir || '',
  });
  await dispatch(
    `Write sprint meta record and commit.\n\n` +
    `Step 1: Ensure sprint-logs/ directory exists:\n` +
    `  mkdir -p "${repo}/sprint-logs"\n\n` +
    `Step 2: Append (do NOT overwrite) the following line to ${sprintLogFile} (full path: "${repo}/${sprintLogFile}").\n` +
    `  If the file does not exist, create it first.\n\n` +
    `Line:\n${metaLine}\n\n` +
    `Step 3: Commit and push:\n` +
    `  git -C "${repo}" add sprint-logs/\n` +
    `  git -C "${repo}" -c user.name='pm' -c user.email='pm@pm.local' commit -m "chore: sprint-meta ${branch} ${effectiveStartedAt}"\n` +
    `  git -C "${repo}" push origin ${branch}\n` +
    `Do not modify any other file. Return "OK" when done.`,
    { model: MODEL_HAIKU, label: 'sprint-meta', phase: 'Plan' }
  );
}

// ------------------------------------------------------------------ SPRINT LOOP

// Per-phase wall-clock instrumentation. We cannot self-time (Date.now() is banned in the
// workflow sandbox), so we capture a cheap `date +%s` epoch at each phase boundary and diff
// them at the end (buildPhaseTiming). This is what turns "the sprint is slow" into a concrete
// per-phase breakdown and lets the parallel-doer win be shown in numbers.
const phaseTimeline = [];
// Arrow (not `async function`) on purpose: appendNewEntries is asserted to be the LAST top-level
// `async function` in this file by test/sprint-log-flush.test.mjs, which slices to the next one.
const stamp = async (name) => {
  // Attribute the timing probe to the phase it actually marks (name prefix), not always 'Plan',
  // so the per-phase cost ledger buildPhaseTiming reports stays trustworthy.
  const _ph = /^plan/.test(name) ? 'Plan'
    : /^develop/.test(name) ? 'Develop'
    : /^test/.test(name) ? 'Test'
    : /^(harvest|end)/.test(name) ? 'Harvest'
    : 'Plan';
  const r = await dispatchShell(['date +%s'], { model: MODEL_HAIKU, label: `stamp-${name}`, phase: _ph });
  const epoch = parseInt(((r?.outputs?.[0]) || '').trim(), 10);
  if (Number.isFinite(epoch)) phaseTimeline.push({ name, epoch });
};
await stamp('setup');

while (cycleCount < maxCycles) {
  cycleCount++;
  cycleCostUsd = 0;
  log(`\n=== Cycle ${cycleCount}/${maxCycles} | goal: ${goal} ===`);

  // ---------------------------------------------------------------- RESUME CHECK + CYCLE CHECKPOINT

  phase('Plan');
  await stamp(`plan-c${cycleCount}`);

  // Write per-cycle checkpoint entry and check cycle state in parallel -- no data dependency.
  // The cycle-checkpoint uses type='cycle-start' (distinct from the one-time type='meta' above).
  const cycleCheckpointLine = JSON.stringify({
    ts: sprintTs, type: 'cycle-start', cycle: cycleCount, branch,
  });
  const [, cycleState] = await Promise.all([
    dispatch(
      `Append (do NOT overwrite) the following line to ${sprintLogFile} (full path: "${repo}/${sprintLogFile}").\n` +
      `If the file does not exist, create it. If the sprint-logs/ directory does not exist, create it first:\n` +
      `  mkdir -p "${repo}/sprint-logs"\n\n` +
      `Line:\n${cycleCheckpointLine}\n\n` +
      `Do not commit, push, or modify any other file. Write the line to disk and stop.`,
      { model: MODEL_HAIKU, label: `cycle-meta-c${cycleCount}`, phase: 'Plan' }
    ),
    checkCycleState(rootIds),
  ]);
  log(`Cycle state: planDone=${cycleState.planDone} inProgress=[${cycleState.inProgressIds.join(', ')}]`);

  // Phase checkpoint (heartbeat): record cycle + phase so a crash resumes here, and refresh
  // the state-file mtime so the concurrency lock stays live through this cycle.
  await writeSprintState(stateFileRel, { ..._stateBase, cycle: cycleCount, phase: 'Plan', planApproved: cycleState.planDone }, 'Plan', `state-c${cycleCount}-plan`);

  // Reset any tasks orphaned in_progress from a previous crashed run.
  if (cycleState.inProgressIds.length > 0) {
    log(`Resetting ${cycleState.inProgressIds.length} orphaned in_progress task(s) to open`);
    const resetCmds = cycleState.inProgressIds.map(id => `bd update ${id} --status=open`);
    await dispatchShell(resetCmds, {
      model: MODEL_HAIKU,
      label: 'reset-orphans',
      phase: 'Plan',
    });
  }

  // ---------------------------------------------------------------- PLAN

  let planApproved = false;
  let planFeedback = '';
  const priorVerdicts = [];
  const MAX_PLAN_ITER = 3;

  if (cycleState.planDone) {
    // F6: a planDone/resumed cycle still runs one plan-reviewer pass -- we only skip the
    // expensive PLANNER dispatch on round 0. The reviewer still routes through
    // approved(planReview), so taskAssignments/sprintQuote populate and the quality gate
    // is enforced; a CHANGES_NEEDED verdict re-enables the planner on later rounds.
    log(`Plan already complete for cycle ${cycleCount} -- skipping the planner dispatch on round 0, still running the plan-reviewer`);
  }

  for (let pi = 0; pi < MAX_PLAN_ITER && !planApproved; pi++) {
    const plannerLabel = `planner-c${cycleCount}-r${pi}`;

    // F6: skip the planner only on the first round of a planDone cycle; always run it on
    // later rounds (a rejection re-enables planning). Fall straight through to the reviewer.
    const skipPlanner = pi === 0 && cycleState.planDone;
    let plannerResult = null;
    if (!skipPlanner) {
      plannerResult = await dispatch(
      `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
      `Sprint goals: ${rootSummary}\n` +
      (requirementsFile ? `Additional context: ${requirementsFile}\n` : '') +
      `\n` +
      (planFeedback
        ? `Plan-reviewer feedback from the previous round (read feedback.md in ${repo} for full details):\n${planFeedback}\nAddress every item before proceeding.\n\n`
        : '') +
      `Inspect existing state first:\n` +
      `  ${rootIds.map(id => `bd show ${id} && bd graph --compact ${id}`).join('\n  ')}\n` +
      `Run: bd show <id> on any existing features/tasks to read their current descriptions.\n` +
      `Then build or complete the feature+task DAG -- create only what is missing:\n` +
      `  - BEFORE creating any feature or task, run: bd search "<title>" --status all\n` +
      `    If a matching issue already exists, update it instead of creating a duplicate.\n` +
      `\n` +
      `DEPENDENCY WIRING -- follow your runbook (agents/planner.md) and the canonical rules in\n` +
      `agents/_shared/GRAPH-SEMANTICS.md exactly: parent-child (via --parent) is for GROUPING\n` +
      `only; blocks (via "bd dep add A B", meaning A cannot close until B is done) is for\n` +
      `ORDERING between siblings only. NEVER add a blocks edge between a bead and its own\n` +
      `--parent ancestor/descendant, in either direction -- a --parent edge plus a blocks edge\n` +
      `between the same two beads deadlocks both, and "bd dep cycles" will NOT warn you.\n` +
      `\n` +
      `  Step 1 -- group: break each sprint goal into child issues with\n` +
      `    bd create --parent <goal-id> (type=feature for sub-goals, type=task for leaf work),\n` +
      `    and parent each feature's tasks with bd create --parent <feature-id>.\n` +
      `    A parent's "not done until its children close" status comes from its children --\n` +
      `    do NOT bd dep add <goal-id> <child-id> or bd dep add <feature-id> <task-id>.\n` +
      `\n` +
      `  Step 2 -- order siblings: bd dep add <test-task-id> <impl-task-id> (test task blocked\n` +
      `    until the impl task closes -- correct: they are siblings). Same pattern for any\n` +
      `    later sibling task that depends on an earlier one.\n` +
      `\n` +
      `  VERIFY after wiring: run "bd list --parent <goal-id> --ready --type=task --json" for\n` +
      `  EACH sprint goal and reason over the COMBINED result. The union of ready work across\n` +
      `  all goals must be non-empty while open work remains anywhere in scope. A single goal\n` +
      `  with an empty ready-list is FINE when its tasks are legitimately blocked by an open\n` +
      `  task in ANOTHER goal (a cross-goal ordering edge) -- do NOT remove that edge. Only if\n` +
      `  the UNION is empty while open work remains, or a goal's task blocks via an edge to its\n` +
      `  own --parent ancestor/descendant, is there a real cycle: find that parent/descendant\n` +
      `  blocks edge and remove it with bd dep remove.\n` +
      `\n` +
      `  IMPORTANT: Each task belongs to exactly ONE feature. Never share a task across features.\n` +
      `\n` +
      `  Create type=task issues for each feature: implementation tasks AND integration\n` +
      `    test development tasks (prefix test tasks with "[test]" in the title)\n` +
      `  Features P1/P2; tasks one level below their parent feature (P1 feature -> P2 tasks, P2 feature -> P3 tasks)\n` +
      `  Each task must be completable in one agent session (1-3 file changes max)\n` +
      `  Every task needs clear acceptance criteria in its description\n` +
      `  - Assign each task a tier AND complexity bucket based on complexity -- after creating or updating each\n` +
      `    task, run: bd update <id> --set-metadata model=<tier>\n` +
      `    Available tiers and when to use them:\n` +
      `      ${TIER_CHEAP}    -- mechanical work: rename, config tweak, move file, simple wiring\n` +
      `      ${TIER_STANDARD} -- standard work: new function, test suite, API endpoint, refactor\n` +
      `      ${TIER_PREMIUM}  -- hard work: architecture, multi-file design, ambiguous requirements\n` +
      `    Complexity buckets (S/M/L) are assigned by the plan-reviewer based on task scope.\n` +
      `    Every task MUST receive a bucket assignment -- tasks without a bucket cannot be cost-estimated.\n` +
      `  - Group tasks so consecutive tasks in dependency order share a tier where\n` +
      `    possible -- this minimises tier-switching overhead during execution\n` +
      (cycleCount > 1
        ? `This is cycle ${cycleCount}. Focus on open issues only.\n` +
          `Do NOT add new scope beyond the original sprint goals and open bugs/enhancements.\n` +
          `Do NOT re-create tasks that are already closed.\n`
        : '') +
      `Confirm with any text when done.`,
      { model: MODEL_OPUS, label: plannerLabel, phase: 'Plan', agentType: 'planner',
        context: `planning sprint goals ${rootSummary}` }
    );

      if (!plannerResult) {
        log(`Planner returned null on cycle ${cycleCount} round ${pi} -- retrying`);
        continue;
      }
    }

    const planReviewerLabel = `plan-reviewer-c${cycleCount}-r${pi}`;
    const planReview = await dispatch(
      `Repo: ${repo}\nBranch: ${branch}\nSprint goals: ${rootSummary}\n` +
      `Calibration file: ${repo}/sprint-logs/calibration.json (read this first if it exists)\n\n` +
      `Review the beads DAG for these sprint goals ONLY: ${rootSummary}\n` +
      (priorVerdicts.length > 0
        ? `Prior-round verdicts for THIS review cycle (most recent last) -- these BIND per your ` +
          `No-goalpost-moving rule; do not re-litigate a criterion an earlier round already ` +
          `accepted unless you cite NEW evidence:\n` +
          priorVerdicts.map(v => `  Round ${v.round}: ${v.verdict} -- ${v.notes}\n`).join('') +
          `\n`
        : '') +
      `Run: ${rootIds.map(id => `bd show ${id}`).join(' && ')} to inspect each sprint goal.\n` +
      `Run: ${rootIds.map(id => `bd graph --compact ${id}`).join(' && ')} for the full dependency subtree.\n` +
      `Run: bd show <id> to inspect individual issues in depth.\n` +
      `Ready-work check (your FIRST correctness check, per runbook Criterion 9): run\n` +
      `"bd list --parent <root> --ready --type=task --json" for EACH sprint goal and reason\n` +
      `over the UNION -- do NOT use bare "bd ready" (project-wide, not a signal about this DAG).\n` +
      `Do NOT review or comment on issues outside these sprint goals.\n\n` +
      `Follow your runbook (agents/plan-reviewer.md) step by step:\n` +
      `  Steps 1-2: inspect the DAG and check all quality criteria.\n` +
      `  Step 3: classify each task -- assign complexity bucket (S/M/L) and read its model\n` +
      `    from beads metadata. If a task has no model metadata, flag it as a criterion-10\n` +
      `    CHANGES_NEEDED finding per your runbook, and use the standard-tier fallback only\n` +
      `    to finish classifying/reporting in the same pass.\n` +
      `  Step 4: return verdict, notes, and taskAssignments (id + bucket + model per task).\n\n` +
      `Notes must be specific: include issue IDs and exact "bd dep add" commands to fix\n` +
      `any dependency direction problems.`,
      { model: MODEL_SONNET, label: planReviewerLabel, phase: 'Plan', schema: PLAN_REVIEW_SCHEMA, agentType: 'plan-reviewer',
        context: `reviewing plan for sprint goals ${rootSummary}` }
    );

    // F2: record this round's verdict so the NEXT round's plan-reviewer receives it as a
    // binding prior-round input (No-goalpost-moving rule). Null-guarded: a null planReview
    // records a CHANGES_NEEDED entry rather than crashing.
    priorVerdicts.push({
      round: pi,
      verdict: (planReview && planReview.verdict) || 'CHANGES_NEEDED',
      notes: (planReview && planReview.notes) || '',
    });

    if (approved(planReview)) {
      planApproved = true;
      log(`Plan APPROVED on cycle ${cycleCount} round ${pi + 1}`);

      // Persist taskAssignments at workflow scope for the calibration join at sprint close.
      taskAssignments = planReview.taskAssignments || [];

      // Compute sprint cost quote in pure JS -- no agent does arithmetic.
      sprintQuote = computeSprintQuote(taskAssignments, calibration);
      const sc = sprintQuote.scenarios;
      log(`Sprint quote (${sprintQuote.calibrationSource}, ${taskAssignments.length} tasks): ` +
          `output-only: opt=$${sc.optimistic.outputOnly.toFixed(3)} ` +
          `exp=$${sc.expected.outputOnly.toFixed(3)} ` +
          `pess=$${sc.pessimistic.outputOnly.toFixed(3)} ` +
          `| true-est (x${sprintQuote.inputMultiplier.toFixed(1)}): ` +
          `exp=$${sc.expected.total.toFixed(3)}`);

      // Write per-task cost estimates and commit the plan snapshot in a single dispatchShell.
      // All commands are pre-built in JS from taskAssignments -- Haiku only executes them.
      // bd export runs AFTER the cost-note writes so the snapshot captures updated task notes.
      const planCommitCmds = [
        ...sprintQuote.tasks.map(t =>
          `bd update ${t.id} --notes="cost-estimate: bucket=${t.bucket} model=${t.model} ` +
          `doer_tokens=${t.doerTokens} reviewer_tokens=${t.reviewerTokens} output_usd=${t.outputUsd.toFixed(4)}"`
        ),
        `bd export -o "${repo}/.beads/issues.jsonl"`,
        `git -C "${repo}" add .beads/issues.jsonl`,
        `git -C "${repo}" -c user.name='pm' -c user.email='pm@pm.local' commit --allow-empty -m "plan: approve task DAG"`,
        `git -C "${repo}" push origin ${branch}`,
      ];
      await dispatchShell(planCommitCmds, {
        model: MODEL_HAIKU, label: `plan-commit-c${cycleCount}`, phase: 'Plan',
        maxTurns: planCommitCmds.length + 2,
      });
    } else {
      planFeedback = (planReview && planReview.notes) || '';
      log(`Plan needs changes: ${planFeedback.slice(0, 120)}`);
      await commitFeedback(repo, branch, planFeedback, 'pm-plan-reviewer', planReviewerLabel, 'Plan');
    }
  }

  if (!planApproved) {
    log(`Plan not approved after ${MAX_PLAN_ITER} rounds -- aborting sprint`);
    abortReason = 'plan not approved';
    break;
  }

  // ---------------------------------------------------------------- DEVELOP

  phase('Develop');
  await stamp(`develop-c${cycleCount}`);

  // Phase checkpoint (heartbeat): plan approved for this cycle, entering develop.
  await writeSprintState(stateFileRel, { ..._stateBase, cycle: cycleCount, phase: 'Develop', planApproved: true }, 'Develop', `state-c${cycleCount}-dev`);

  const MAX_DEV_ITER = 20;
  let devIter = 0;
  let devFeedback = '';
  // Parallel-doer config (per-cycle, read once from healed calibration).
  const _par = (calibration && calibration.parallelism) || {};
  const maxDoers = Math.max(1, _par.max_doers || 1);
  const worktreeRoot = _par.worktree_root || '.auto-sprint/wt';
  // If a parallel iteration makes zero progress (every doer failed or every merge conflicted),
  // force the NEXT iteration onto the serial path. Serial doers commit directly on the sprint
  // branch (no cross-branch merge -> no merge conflict), guaranteeing forward progress and
  // preventing a same-batch conflict loop. Cleared as soon as a serial iteration runs.
  let forceSerialIter = false;

  while (devIter < MAX_DEV_ITER) {
    // Lock heartbeat: refresh the state file's mtime every develop iteration. A single
    // develop iteration (a doer batch + review) can exceed SPRINT_STATE_TTL_S; without a
    // heartbeat here the lock would "expire" mid-run and a second invocation on the same
    // branch could start concurrently and corrupt the shared checkout. Cheap relative to
    // the per-iteration doer/review dispatches.
    await writeSprintState(
      stateFileRel,
      { ..._stateBase, cycle: cycleCount, phase: 'Develop', planApproved: true },
      'Develop',
      `heartbeat-c${cycleCount}-i${devIter}`,
    );
    let streakResult = await getReadyStreaks(rootIds);
    if (streakResult.extractFailed) {
      // A single failed/garbled extraction must never look identical to a confirmed
      // zero-ready result -- that ambiguity is what let one transient dispatch/parse
      // hiccup hard-abort an entire sprint on cycle 1 (apra-fleet e2e s10, 2026-07-17,
      // run 29605783512: the workflow itself ran fine, but a bad read made it look like
      // a dependency deadlock). Retry once, bounded, before trusting the result at all.
      log(`WARN: ready-task extraction failed at c${cycleCount} i${devIter} -- retrying once before treating as zero-ready`);
      streakResult = await getReadyStreaks(rootIds);
    }
    if (streakResult.totalCount === 0 && streakResult.extractFailed) {
      // Both reads failed -- we genuinely cannot tell if there's ready work. Do NOT
      // hard-abort on unreliable data; log loudly and let the next iteration/cycle
      // (or exit-check) retry with a fresh read instead of losing the whole sprint.
      log(`WARN: ready-task extraction failed twice at c${cycleCount} i${devIter} -- treating as inconclusive, not a deadlock`);
      break;
    }
    if (streakResult.totalCount === 0) {
      // Distinguish genuine completion from a dependency DEADLOCK. If the sprint subtree
      // still has open issues at/above the goal threshold but NONE are ready on the FIRST
      // develop iteration, surface it loudly with the blocked leaves (the "'missing issues'
      // when all P1s are dependency-blocked" failure). We HARD-ABORT only on the very first
      // cycle -- when the initial plan produced no workable leaves at all -- because that is
      // the true unrecoverable case. In LATER cycles a ready==0 first iteration is usually
      // just "this cycle's leaves are done"; the multi-cycle re-plan / exit-check self-heals
      // it, so we log the diagnostic but fall through instead of aborting (aborting there
      // would skip harvest and lose the PR for work already completed).
      if (devIter === 0) {
        const _open = await countBeadsBlockers(threshold, rootIds);
        if (_open.count > 0) {
          const _diag = await dispatchShell(
            [`bd list --status=open --type=task --json | node -e "const d=require('fs').readFileSync(0,'utf8');try{const a=JSON.parse(${BD_JSON}).map(i=>({id:i.id,blocked_by:i.blocked_by||i.dependencies||[]}));process.stdout.write(JSON.stringify(a).slice(0,1200))}catch{process.stdout.write('[]')}"`],
            { model: MODEL_HAIKU, label: `deadlock-diag-c${cycleCount}`, phase: 'Develop' }
          );
          const _diagText = `${_open.count} open issue(s) at/above ${goal} in the sprint subtree but NONE are ready on the first develop iteration. The dependency DAG may be blocked (commonly backwards or parent-child edges; note 'bd dep cycles' MISSES parent-child deadlocks -- inspect blocked_by on leaf tasks). Open leaf tasks + blocked_by: ${(_diag?.outputs?.[0] || '[]').trim()}`;
          if (cycleCount === 1) {
            log(`ERROR: DEADLOCK (cycle 1 plan produced no workable leaves) -- ${_diagText}`);
            abortReason = 'deadlock: plan produced open issues but no ready leaves';
            break;
          }
          // Later cycle: diagnostic only -- let the normal exit-check / next-cycle re-plan decide.
          log(`WARN: no ready leaves at cycle ${cycleCount} start though open issues remain -- ${_diagText}`);
        }
      }
      log(`No ready tasks -- develop phase complete (${devIter} iterations)`);
      break;
    }
    log(`Dev iter ${devIter} c${cycleCount}: ${streakResult.totalCount} ready task(s) across ${streakResult.streaks.length} model streak(s)`);

    // Dispatch doers; collect all worked task IDs for the reviewer.
    const workedIds = [];
    let streakAbort = false;
    let doerNullReset = false;

    // id->bucket map for the per-streak token-ceiling truncation, derived from the
    // last approved plan-review's taskAssignments held at workflow scope.
    const bucketById = Object.fromEntries((taskAssignments || []).map(t => [t.id, t.bucket]));

    // ---- PARALLEL DOERS (worktree fan-out) ---------------------------------
    // When more than one bd-ready task exists and calibration allows width>1, work independent
    // ready tasks CONCURRENTLY, each in its own git worktree + temp branch off the current sprint
    // HEAD, then merge back sequentially with a conflict->re-queue fallback. bd-ready tasks are
    // DAG-independent, so the only risk is physical file overlap, handled at merge time. All beads
    // state transitions stay centralized here (doers run NO bd) so concurrent worktrees never
    // diverge the .beads DB. Degrades to the serial path for width==1, all-worktree-create-fail,
    // or after a zero-progress parallel iteration (forceSerialIter). Never worse than serial.
    const _effMaxDoers = forceSerialIter ? 1 : maxDoers;
    forceSerialIter = false;
    const _plan = computeDoerBatch(streakResult.streaks, _effMaxDoers);
    let parallelHandled = false;

    if (_plan.width > 1) {
      const wt = _plan.batch.map(t => ({ ...t, ...worktreeNamesFor(branch, t.id, worktreeRoot) }));
      log(`Parallel develop: ${_plan.width} doer(s) in worktrees (${labelTaskIds(wt.map(w => w.id))})${_plan.deferred.length ? `; ${_plan.deferred.length} task(s) deferred to next iter` : ''}`);

      // Create one worktree + temp branch per task (idempotent: clear any leaked prior worktree/
      // branch first). Each command echoes OK/FAIL <id> so we only work tasks that isolated cleanly.
      const createRes = await dispatchShell(
        wt.map(w =>
          `git -C "${repo}" worktree remove --force "${repo}/${w.path}" 2>/dev/null; ` +
          `git -C "${repo}" branch -D "${w.branch}" 2>/dev/null; ` +
          `git -C "${repo}" worktree add -b "${w.branch}" "${repo}/${w.path}" "${branch}" >/dev/null 2>&1 && echo "OK ${w.id}" || echo "FAIL ${w.id}"`
        ),
        { model: MODEL_HAIKU, label: `wt-create-c${cycleCount}-i${devIter}`, phase: 'Develop', maxTurns: wt.length + 2 }
      );
      const createdOk = {};
      (createRes?.outputs || []).forEach((o, i) => { if (/\bOK\b/.test(o || '')) createdOk[wt[i].id] = true; });
      const okWt = wt.filter(w => createdOk[w.id]);

      if (okWt.length === 0) {
        log(`All worktree creations failed -- falling back to serial for this iteration`);
        await dispatchShell(
          wt.flatMap(w => [
            `git -C "${repo}" worktree remove --force "${repo}/${w.path}" 2>/dev/null || true`,
            `git -C "${repo}" branch -D "${w.branch}" 2>/dev/null || true`,
          ]),
          { model: MODEL_HAIKU, label: `wt-cleanup-c${cycleCount}-i${devIter}`, phase: 'Develop' }
        );
      } else {
        parallelHandled = true;
        // Read each task's spec centrally (human-readable bd show) and INLINE it into the doer
        // prompt, so doers need no bd access inside their worktree (worktree .beads DB may be
        // stale or absent across the hundreds of projects this runs on).
        const specRes = await dispatchShell(
          okWt.map(w => `bd show ${w.id}`),
          { model: MODEL_HAIKU, label: `spec-c${cycleCount}-i${devIter}`, phase: 'Develop', maxTurns: okWt.length + 2 }
        );
        const specById = {};
        okWt.forEach((w, i) => { specById[w.id] = ((specRes?.outputs?.[i]) || '').trim().slice(0, 4000); });

        // Claim the batch centrally (single source of truth), then fan out doers.
        await dispatchShell(okWt.map(w => `bd update ${w.id} --claim`),
          { model: MODEL_HAIKU, label: `claim-c${cycleCount}-i${devIter}`, phase: 'Develop', maxTurns: okWt.length + 2 });

        const doerOutcomes = await parallel(okWt.map(w =>
          dispatch(
            `You are working in an ISOLATED git worktree -- other doers run concurrently in their own worktrees.\n` +
            `Worktree path: ${repo}/${w.path}  (cd into it first; you are on temp branch ${w.branch})\n` +
            `Work ONLY task ${w.id}. Do NOT work any other task.\n\n` +
            (devFeedback
              ? `Reviewer feedback from the previous iteration (also in feedback.md at ${repo}):\n${devFeedback}\nAddress every relevant finding.\n\n`
              : '') +
            `Task ${w.id} specification:\n${specById[w.id] || '(spec unavailable; infer from the repo and task id)'}\n\n` +
            `Steps:\n` +
            `  - Implement the work for task ${w.id} INSIDE ${repo}/${w.path} ONLY (code, tests, config -- whatever it requires).\n` +
            `  - Commit in that worktree: git -C "${repo}/${w.path}" add -A && git -C "${repo}/${w.path}" -c user.name='doer' -c user.email='doer@pm.local' commit -m "impl ${w.id}"\n` +
            `  - Do NOT run ANY bd command. Do NOT touch the main checkout or the ${branch} branch. Do NOT push. Do NOT run git merge.\n` +
            `Return status "VERIFY" when done. Return status "BLOCKED" only for your runbook's blocked cases (missing secret) -- never any other status.`,
            { model: w.model, label: `doer-c${cycleCount}-i${devIter}-${w.id}`, phase: 'Develop', schema: DOER_STATUS_SCHEMA,
              agentType: 'doer', context: `task ${w.id} (worktree)` }
          ).then(r => ({ w, ok: !!r && r.status === 'VERIFY' })).catch(() => ({ w, ok: false }))
        ));

        // Merge sequentially into the sprint branch (deterministic id order from computeDoerBatch).
        // Clean merge -> close centrally; conflict or doer failure -> re-queue centrally.
        for (const { w, ok } of doerOutcomes) {
          if (!ok) {
            await dispatchShell([`bd update ${w.id} --status=open`],
              { model: MODEL_HAIKU, label: `requeue-${w.id}-c${cycleCount}-i${devIter}`, phase: 'Develop' });
            log(`Doer failed for ${w.id} -- re-queued (will retry next iter)`);
            continue;
          }
          const mres = await dispatchShell(
            [`git -C "${repo}" merge --no-ff --no-edit "${w.branch}" >/dev/null 2>&1 && echo MERGE_OK || (git -C "${repo}" merge --abort >/dev/null 2>&1; echo MERGE_CONFLICT)`],
            { model: MODEL_HAIKU, label: `merge-${w.id}-c${cycleCount}-i${devIter}`, phase: 'Develop' }
          );
          if (/MERGE_OK/.test((mres?.outputs?.[0]) || '')) {
            await dispatchShell([`bd close ${w.id}`],
              { model: MODEL_HAIKU, label: `close-${w.id}-c${cycleCount}-i${devIter}`, phase: 'Develop' });
            workedIds.push(w.id);
            log(`Merged + closed ${w.id}`);
          } else {
            await dispatchShell([`bd update ${w.id} --status=open`],
              { model: MODEL_HAIKU, label: `conflict-${w.id}-c${cycleCount}-i${devIter}`, phase: 'Develop' });
            log(`Merge conflict for ${w.id} -- aborted, re-queued (degrades to serial as ready count drops)`);
          }
        }

        // Always tear down every worktree + temp branch (even failed ones): a leak must never
        // block the next iteration's idempotent create.
        await dispatchShell(
          wt.flatMap(w => [
            `git -C "${repo}" worktree remove --force "${repo}/${w.path}" 2>/dev/null || true`,
            `git -C "${repo}" branch -D "${w.branch}" 2>/dev/null || true`,
          ]),
          { model: MODEL_HAIKU, label: `wt-cleanup-c${cycleCount}-i${devIter}`, phase: 'Develop', maxTurns: wt.length * 2 + 2 }
        );

        // Zero progress this parallel iteration (all failed / all conflicted): force serial next
        // iteration so a same-batch conflict cannot loop forever.
        if (workedIds.length === 0) {
          forceSerialIter = true;
          log(`Parallel iteration closed 0 tasks -- forcing serial path next iteration to guarantee progress`);
        }
      }
    }

    for (const streak of (parallelHandled ? [] : streakResult.streaks)) {
      // Truncate the streak to the longest prefix that fits the doer token ceiling for
      // this tier. Remaining IDs are left unworked and resurface on the next
      // getReadyStreaks iteration.
      // Fit the streak by BOTH the output-token ceiling AND the predicted context window,
      // taking the more restrictive prefix. The context predictor proactively splits a
      // streak that would exceed the doer's usable context (below the autocompact/session
      // limit) -- pre-empting the "doer exhausts context -> returns null -> work lost"
      // failure. Deferred tasks resurface on the next getReadyStreaks iteration (lossless).
      const _ceilFit = truncateStreakToCeiling(streak.ids, bucketById, calibration, streak.model);
      const _ctxFit  = fitStreakToContext(streak.ids, bucketById, calibration, streak.model);
      const fittedIds = _ceilFit.length <= _ctxFit.fittedIds.length ? _ceilFit : _ctxFit.fittedIds;
      if (fittedIds.length < streak.ids.length) {
        const _reason = _ctxFit.fittedIds.length < _ceilFit.length
          ? `context-limited (est ${Math.round(_ctxFit.estContext)} tok > usable ${Math.round(_ctxFit.available)} tok)`
          : `token ceiling`;
        log(`Streak ${streak.model} split by ${_reason}: working ${fittedIds.length}/${streak.ids.length} task(s) (${labelTaskIds(fittedIds)}); ${streak.ids.length - fittedIds.length} deferred`);
      }
      const doerLabel = `doer-c${cycleCount}-i${devIter}: ${labelTaskIds(fittedIds)}`;
      const streakEstUsd = sprintQuote
        ? fittedIds.reduce((sum, id) => {
            const t = sprintQuote.tasks.find(t => t.id === id);
            return sum + (t ? t.outputUsd : 0);
          }, 0)
        : null;
      log(`Doer c${cycleCount}-i${devIter}: ${labelTaskIds(fittedIds)} [model=${streak.model}${streakEstUsd != null ? ` est=$${streakEstUsd.toFixed(4)}` : ''}]`);

      const doerResult = await dispatch(
        `Repo: ${repo}\nBranch: ${branch}\n\n` +
        (devFeedback
          ? `Reviewer feedback from the previous iteration (read feedback.md in ${repo} for full details):\n${devFeedback}\nAddress every finding before closing tasks.\n\n`
          : '') +
        `Work ONLY these tasks (in order): ${fittedIds.join(', ')}\n` +
        `Confirm each is still unblocked with: bd show <id>\n` +
        `For each task:\n` +
        `  - Run: bd update <id> --claim\n` +
        `  - Implement the work described (code, tests, config -- whatever the task requires)\n` +
        `  - Run: bd close <id> immediately after verify and commit, BEFORE claiming the next task\n` +
        `  - Closed tasks are durable even if the doer crashes mid-streak\n` +
        `  - NEVER close a type=feature or type=bug issue -- only close type=task\n` +
        `Work all listed tasks then stop and return status "VERIFY".\n` +
        `Return status "BLOCKED" only for your runbook's blocked cases (agents/doer.md:\n` +
        `missing secret, unspecified branch) -- never any other status.`,
        { model: streak.model, label: doerLabel, phase: 'Develop', schema: DOER_STATUS_SCHEMA, agentType: 'doer',
          context: `tasks ${fittedIds.join(', ')}` }
      );

      if (!doerResult) {
        log(`Doer returned null (streak ${streak.model}) -- resetting orphaned in_progress tasks and retrying`);
        const _ipExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.parse(${BD_JSON}).map(i=>i.id).join(' '))}catch{}"`;
        const ipResult = await dispatchShell(
          [`bd list --status=in_progress --type=task --json | ${_ipExtract}`],
          { model: MODEL_HAIKU, label: `reset-orphans-c${cycleCount}-i${devIter}`, phase: 'Develop' }
        );
        const ipIds = (ipResult?.outputs?.[0] || '').trim().split(/\s+/).filter(Boolean);
        if (ipIds.length > 0) {
          const resetCmds = ipIds.map(id => `bd update ${id} --status=open`);
          await dispatchShell(resetCmds, { model: MODEL_HAIKU, label: `reset-open-c${cycleCount}-i${devIter}`, phase: 'Develop' });
          log(`Reset ${ipIds.length} in_progress task(s) to open: ${ipIds.join(', ')}`);
        }
        doerNullReset = true;
        break;
      }

      if (doerResult.status !== 'VERIFY') {
        const _doerNotes = (doerResult.notes || '').slice(0, 200);
        if (doerResult.status === 'BLOCKED') {
          // Contract case (doer-output.json enum): the doer hit a runbook blocker
          // (missing secret/branch). Not a malfunction -- abort with the blocker so the
          // user can resolve it and re-run.
          log(`Doer BLOCKED (streak ${streak.model}): ${_doerNotes || 'no details'} -- aborting sprint`);
          abortReason = `doer blocked: ${_doerNotes || 'no details'}`;
        } else {
          log(`Unexpected doer status "${doerResult.status}" -- aborting`);
          abortReason = 'unexpected doer status';
        }
        streakAbort = true;
        break;
      }
      workedIds.push(...fittedIds);
    }

    devIter++;
    if (doerNullReset) continue;
    if (streakAbort) break;
    if (workedIds.length === 0) {
      // No task merged this iteration (e.g. every parallel merge conflicted and re-queued).
      // Nothing to review; loop back -- getReadyStreaks re-derives work and forceSerialIter
      // (set above) guarantees the next iteration makes progress.
      log(`No tasks merged this iteration -- skipping reviewer, re-deriving ready work`);
      continue;
    }

    // Reviewer tier matches the highest tier used across all streaks:
    // any premium streak -> premium; otherwise standard (cheap work reviewed at standard minimum).
    const usedModels = streakResult.streaks.map(s => s.model);
    const reviewerModel = usedModels.includes(TIER_PREMIUM) ? TIER_PREMIUM : TIER_STANDARD;

    // One reviewer pass covering all streaks worked this iteration.
    const reviewerLabel = `reviewer-c${cycleCount}-i${devIter}: ${labelTaskIds(workedIds)}`;
    const review = await dispatch(
      `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
      `Sprint goals: ${rootSummary}\nTasks worked this iteration: ${workedIds.join(', ')}\n\n` +
      `Review ONLY the work done for the tasks listed above.\n` +
      `Run: bd show <id> for each task to read its acceptance criteria.\n` +
      `Run: git -C "${repo}" diff ${base_branch}...${branch} to see the changes.\n` +
      `Do NOT comment on code or issues outside the listed tasks.\n` +
      `Check: code correctness, test coverage, adherence to each task's acceptance criteria.\n` +
      `Follow your runbook (agents/reviewer.md): run NO bd mutations yourself. If a task\n` +
      `needs rework, list its id in reopenIds in your structured output -- the workflow\n` +
      `applies the reopen transitions for you.\n` +
      `CHANGES_NEEDED verdict must include specific actionable feedback tied to a task ID.\n` +
      `APPROVED means all committed work meets acceptance criteria.`,
      { model: reviewerModel, label: reviewerLabel, phase: 'Develop', schema: REVIEW_SCHEMA, agentType: 'reviewer',
        context: `reviewing tasks ${workedIds.join(', ')}` }
    );
    log(`Reviewer c${cycleCount}-i${devIter}: ${(review && review.verdict) || 'null'} -- ${labelTaskIds(workedIds)}`);

    if (!approved(review)) {
      devFeedback = (review && review.notes) || '';
      log(`Reviewer feedback: ${devFeedback.slice(0, 120)}`);

      // Apply the reviewer's structured verdict. The reviewer is a pure reader of
      // beads (agents/reviewer.md: never bd update/close/create) -- the WORKFLOW owns
      // the reopen/create transitions, otherwise CHANGES_NEEDED tasks stay closed and
      // the next iteration exits Develop as if the review had passed.
      const _reopenAll = Array.isArray(review && review.reopenIds) ? review.reopenIds : [];
      const _reopenIds = _reopenAll.filter(id => workedIds.includes(id));
      if (_reopenAll.length > _reopenIds.length) {
        log(`Reviewer listed ${_reopenAll.length - _reopenIds.length} reopenId(s) outside this iteration's worked tasks -- ignored`);
      }
      const _newTasks = Array.isArray(review && review.newTasks) ? review.newTasks : [];
      const _shQuote = s => String(s || '').replace(/"/g, "'");
      const _prioNum = p => { const m = String(p || '').match(/[0-4]/); return m ? m[0] : '2'; };
      const applyCmds = [
        ..._reopenIds.map(id => `bd update ${id} --status=open`),
        ..._newTasks.map(t =>
          `bd create --title="${_shQuote(t.title || 'review follow-up').slice(0, 120)}" ` +
          `--description="${_shQuote(t.description).slice(0, 500)}" ` +
          `--type=task --priority=${_prioNum(t.priority)} --parent=${rootIds[0]}`
        ),
      ];
      if (applyCmds.length > 0) {
        await dispatchShell(applyCmds, {
          model: MODEL_HAIKU, label: `review-apply-c${cycleCount}-i${devIter}`, phase: 'Develop',
          maxTurns: applyCmds.length + 2,
        });
        log(`Applied review verdict: ${_reopenIds.length} task(s) reopened, ${_newTasks.length} follow-up task(s) created`);
      }
      // Fire-and-forget: write feedback.md to disk only -- next doer's 'git add -A' picks it up.
      // The plan-reviewer commitFeedback (below) MUST remain awaited and commit+push so the
      // planner can read it from remote. Dev-path feedback is local-only.
      dispatch(
        `Repo: ${repo}\nBranch: ${branch}\n\n` +
        `Write the following reviewer feedback to feedback.md (overwrite if it exists):\n\n` +
        `${devFeedback}\n\n` +
        `Do not commit, push, or run any other command. Write the file to disk and stop.`,
        { model: MODEL_HAIKU, label: `feedback-write-${reviewerLabel}`, phase: 'Develop' }
      );  // intentionally NOT awaited
      // Reopened tasks will show in bd ready next iteration
    } else {
      devFeedback = '';
    }

    // JIT flush: append this iteration's entries immediately so the log grows as work lands.
    await appendNewEntries(`iter-c${cycleCount}-i${devIter}`, 'Develop');
  }

  if (abortReason) break;

  // Push branch so CI can trigger and record HEAD SHA in a single dispatchShell.
  const pushShaResult = await dispatchShell(
    [
      `git push origin ${branch} 2>&1 || git push -u origin ${branch} 2>&1`,
      `git rev-parse HEAD`,
    ],
    { model: MODEL_HAIKU, label: `push-sha-c${cycleCount}`, phase: 'Develop' }
  );
  if (pushShaResult && Array.isArray(pushShaResult.outputs) && pushShaResult.outputs[1]) {
    headSha = pushShaResult.outputs[1].trim();
  }
  log(`HEAD SHA: ${headSha}`);

  // ---------------------------------------------------------------- INTEGRATION TEST (skip if files missing)

  if (integTestEnabled) {
    phase('Test');
    await stamp(`test-c${cycleCount}`);

    // -- Deploy --
    // Role split (agents/deployer.md, agents/integ-test-runner.md): the deployer follows
    // deploy.md ONLY (deploy + smoke test) -- the playbook's Setup/Reset/Teardown belong
    // to integ-test-runner, which owns integ-test-playbook.md end to end. The deployer
    // refuses playbook operations by contract, so never dispatch them to it.
    const deployLabel = `deployer-c${cycleCount}`;
    const deployResult = await dispatch(
      `Repo: ${repo}\nBranch: ${branch}\nCycle: ${cycleCount}\n` +
      `operation: deploy\n\n` +
      `Follow your runbook (agents/deployer.md) -- deploy.md ONLY; you do not touch\n` +
      `integ-test-playbook.md (its Setup/Reset/Teardown belong to integ-test-runner):\n` +
      `1. Read deploy.md (Deploy, Smoke test, and CI sections).\n` +
      `2. Execute every command in the '## Deploy' section in order.\n` +
      `3. Run the command in '## Smoke test'.\n` +
      `4. Return deployed: true if the smoke test exits 0, false otherwise.\n` +
      `5. If deployed is false, include the error output in notes.`,
      { model: MODEL_SONNET, label: deployLabel, phase: 'Test', agentType: 'deployer',
        schema: DEPLOYER_SCHEMA }
    );

    if (!deployResult || !deployResult.deployed) {
      const msg = (deployResult && deployResult.notes) || 'no details';
      log(`Deploy failed on cycle ${cycleCount}: ${msg.slice(0, 200)}`);
      log('Skipping integration tests this cycle -- the test sandbox was never brought up (integ-test-runner owns it), nothing to tear down');
    } else {
      // -- Integration test run (scoped to THIS sprint's open features) --
      // Scope the tester to the sprint subtree's open features. Do NOT let it `bd list
      // --type=feature --status=open` (every open feature in the whole DB) -- that would
      // test/close/file-bugs against unrelated features from other epics/sprints.
      // An EMPTY feature list still dispatches the runner: the playbook's two parts are
      // the sprint's standing confidence check (integ-test-runner.md Step 1).
      const _sprintFeatures = await getSprintOpenFeatures(rootIds);
      const integLabel = `integ-runner-c${cycleCount}`;
      const _featList = _sprintFeatures.length > 0
        ? _sprintFeatures.map(f => `  ${f.id} -- ${f.title}`).join('\n')
        : `  (none -- zero open features this cycle; a normal outcome, run the playbook parts only)`;
      log(`Integration scope: ${_sprintFeatures.length} sprint feature(s)${_sprintFeatures.length ? ` [${labelTaskIds(_sprintFeatures.map(f => f.id))}]` : ''}`);

      const integResult = await dispatch(
        `Repo: ${repo}\nBranch: ${branch}\nCycle: ${cycleCount}\n` +
        `Sprint goals: ${rootSummary}\n\n` +
        `Follow your runbook (agents/integ-test-runner.md). You own integ-test-playbook.md\n` +
        `end to end: run part 1 (the real functional suite), bring the sandbox up with the\n` +
        `playbook's ${cycleCount === 1 ? '## Setup' : '## Reset'} section, run the smoke scenario and the per-feature\n` +
        `tests inside it, and ALWAYS run the playbook's ## Teardown before returning --\n` +
        `pass or fail. The product deploy (deploy.md) has already been done by the deployer.\n\n` +
        `Integration-test ONLY these open features from THIS sprint. Do NOT list, test, close, ` +
        `or file bugs against any beads issue that is not in this list (do NOT run ` +
        `"bd list --type=feature"):\n${_featList}\n\n` +
        `Per-feature testing (bd show -> run its tests -> bd close on pass, keep open on ` +
        `failure/inconclusive), [integ] bug filing, priority rules, and duplicate checks ` +
        `(bd search "[integ]") are all in your runbook -- follow it. Parent every new ` +
        `[integ] bug under sprint root ${rootIds[0]} (the scope for this dispatch).\n\n` +
        `Return the full contract: featuresClosed (count), issuesCreated (count), ` +
        `passed (boolean), bugsFiled (array of created bug ids, [] if none), ` +
        `summary (one paragraph, including the part 1 result line).`,
        { model: MODEL_SONNET, label: integLabel, phase: 'Test', schema: INTEG_RUN_SCHEMA, agentType: 'integ-test-runner' }
      );
      if (integResult) {
        log(`Integration: ${integResult.featuresClosed} features closed, ${integResult.issuesCreated} issues created, passed=${integResult.passed}`);
        log(`Summary: ${integResult.summary}`);
      }

      // JIT flush: append test-phase entries (deployer, integ-runner) immediately.
      // No separate teardown dispatch: the runner runs the playbook's Teardown itself,
      // always, before returning (agents/integ-test-runner.md Step 4).
      await appendNewEntries(`test-c${cycleCount}`, 'Test');
    }
  }

  // ---------------------------------------------------------------- EXIT CHECK
  // Merge final getReadyStreaks + countBeadsBlockers into one dispatchShell to avoid
  // running bd graph twice on the same roots. Command ordering (strict):
  //   [0..N-1] bd graph root0..rootN-1  (shared by both parsers)
  //   [N]      bd list --status=open    (openListIdx = rootCount)
  //   [N+1]    bd list --ready          (readyListIdx = rootCount+1)
  // Fallback: if outputs.length < rootCount+2, fall back to two separate dispatches.

  let blockers;
  {
    const _idExtract   = `node -e "const d=require('fs').readFileSync(0,'utf8');try{const g=JSON.parse(${BD_JSON});${bdSubtreeSnippet(rootIds)}console.log(Array.from(subtree).join(' '))}catch{}"`;
    const _openExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.stringify(JSON.parse(${BD_JSON}).map(i=>({id:i.id,p:i.priority,t:i.issue_type}))))}catch{console.log('[]')}"`;
    const _taskExtract = `node -e "const d=require('fs').readFileSync(0,'utf8');try{console.log(JSON.stringify(JSON.parse(${BD_JSON}).map(i=>({id:i.id,p:i.priority,m:(i.metadata||{}).model}))))}catch{console.log('[]')}"`;
    const exitCmds = [
      ...rootIds.map(id => `bd graph --json ${id} | ${_idExtract}`),
      `bd list --status=open --json | ${_openExtract}`,
      `bd list --ready --type=task --json | ${_taskExtract}`,
    ];
    const exitResult = await dispatchShell(exitCmds, { model: MODEL_HAIKU, label: 'exit-check', phase: 'Develop' });
    if (exitResult?.outputs && exitResult.outputs.length >= rootIds.length + 2) {
      blockers = parseBlockers(exitResult.outputs, rootIds.length, rootIds.length, threshold, { rootIds, leaf: true, includeFeatures: integTestEnabled });
      // Ready streaks prefetched but not used: develop loop already determined no ready tasks.
      // Parsed here to validate the merged output; result discarded at cycle end.
      parseReadyStreaks(exitResult.outputs, rootIds.length, rootIds.length + 1, TIER_STANDARD, rootIds);
    } else {
      // Fallback: outputs too short (agent returned partial results) -- use separate dispatches.
      log('exit-check: outputs.length < rootCount+2 -- falling back to separate dispatches');
      blockers = await countBeadsBlockers(threshold, rootIds, integTestEnabled);
    }
  }
  const currentOpenIds = (blockers.ids || []).slice().sort();
  log(`Exit check: ${blockers.count} open issues at P<=${threshold} -- IDs: [${currentOpenIds.join(', ')}]`);

  // Straggler flush: catches plan-phase, push, head-sha, check-blockers, and any entries
  // not yet appended (e.g. when integ tests are disabled, or on abortReason paths).
  const cycleLedger = dispatchLedger.filter(e => e.cycle === cycleCount);
  const cycleTotal = cycleLedger.reduce((s, e) => s + e.costUsd, 0);
  log(`Cycle ${cycleCount} cost: $${cycleTotal.toFixed(4)} output across ${cycleLedger.length} dispatches`);
  await appendNewEntries(`end-c${cycleCount}`, integTestEnabled ? 'Test' : 'Develop');

  // No-progress check: if no issue from the previous cycle was resolved, abort.
  if (cycleCount > 1 && prevOpenIds.length > 0) {
    const closedFromPrev = prevOpenIds.filter(id => !currentOpenIds.includes(id));
    if (closedFromPrev.length === 0) {
      log(`No progress in cycle ${cycleCount}: same ${prevOpenIds.length} issues unresolved -- aborting`);
      abortReason = 'no progress';
      break;
    }
    log(`Progress: ${closedFromPrev.length} issue(s) resolved this cycle`);
  }

  if (blockers.count === 0) {
    goalMet = true;
    log(`Goal met after ${cycleCount} cycle(s)`);
    break;
  }

  prevOpenIds = currentOpenIds;
}

// ------------------------------------------------------------------ FINAL REVIEW

phase('Harvest');
await stamp('harvest');

// Remove sprint process-scaffold files (feedback.md, requirements.md) BEFORE the final review.
// These are written during plan/develop review iterations and can be swept into a commit by a
// doer's `git add -A`. If they survive into the harvest diff, the final reviewer correctly
// rejects the sprint ("stray file would pollute the PR"), which blocks PR creation AND the
// downstream bd-export -- cascading into pr-exists / final-changeset-clean / beads-sprint-closed
// failures even when the actual goal was met. The later beads-export-cleanup step also strips
// them, but that runs only AFTER an APPROVED review, so the cleanup must also happen up front.
await dispatchShell(
  [
    `git -C "${repo}" rm -f --ignore-unmatch feedback.md requirements.md 2>/dev/null; ` +
    `rm -f "${repo}/feedback.md" "${repo}/requirements.md" 2>/dev/null; ` +
    `if git -C "${repo}" diff --cached --quiet; then echo "no process files staged"; else ` +
    `git -C "${repo}" -c user.name='pm' -c user.email='pm@pm.local' commit -m "chore: remove sprint process files before harvest" && ` +
    `git -C "${repo}" push origin ${branch}; fi`,
  ],
  { model: MODEL_HAIKU, label: `harvest-clean-process-files-c${cycleCount}`, phase: 'Harvest', maxTurns: 4 }
);

const finalReviewLabel = 'final-reviewer';
const finalReview = await dispatch(
  `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
  `Sprint goals: ${rootSummary}\nGoal: ${goal}\n` +
  (abortReason ? `Sprint ended early: ${abortReason}. Review what was completed.\n` : '') +
  (goalMet ? `Goal was met: all P<=${threshold} issues resolved.\n` : `Goal not yet met.\n`) +
  `\nReview the overall output of this sprint:\n` +
  `  - Does the work address the original sprint goals?\n` +
  `  - Are there obvious gaps or regressions?\n` +
  `  - Is the codebase in a releasable state for what was completed?\n` +
  `APPROVED means the work is ready to harvest and raise as a PR.\n` +
  `CHANGES_NEEDED means critical issues were found; include specific findings in notes.`,
  { model: MODEL_OPUS, label: finalReviewLabel, phase: 'Harvest', schema: REVIEW_SCHEMA, agentType: 'reviewer' }
);
log(`Final review: ${finalReview && finalReview.verdict || 'null'}`);

if (!approved(finalReview)) {
  const notes = (finalReview && finalReview.notes) || '';
  log(`Final review not approved -- aborting before harvest. Notes: ${notes.slice(0, 300)}`);
  await clearSprintState(stateFileRel, 'state-clear-finalrejected');
  return { cycles: cycleCount, goalMet, goal, abortReason: abortReason || 'final review rejected', finalReviewNotes: notes };
}

// ------------------------------------------------------------------ HARVEST

const logEntries = dispatchLedger;

// Compute estimate-vs-actual analysis entirely in JS.
const sprintAnalysis = computeSprintAnalysis(sprintQuote, logEntries, calibration, cycleCount);
log('Sprint cost analysis computed (JS):\n' + sprintAnalysis.analysisText);

// Build structured summary and write sprint-logs/<branch>-<ts>.analysis.md artefact.
const tasksCompleted = goalMet
  ? (sprintQuote ? sprintQuote.tasks.length : 0)
  : Math.max(0, (sprintQuote ? sprintQuote.tasks.length : 0) - prevOpenIds.length);
const tasksOpen = goalMet ? 0 : prevOpenIds.length;
const sprintSummary = buildSprintSummary(sprintAnalysis, sprintQuote, calibration, {
  branch, goal, goalMet, cycleCount, tasksCompleted, tasksOpen, startedAt: effectiveStartedAt,
});
// Append Sprint Execution Summary section -- emitted regardless of goalMet.
const executionSummary = buildExecutionSummary(logEntries, {
  cycleCount, goalMet, goal, tasksOpen, openIssueIds: prevOpenIds, startedAt: effectiveStartedAt,
});
sprintSummary.summaryText += '\n' + executionSummary.summaryText;
log('Sprint summary:\n' + sprintSummary.summaryText);
const analysisArtifactFile = `sprint-logs/${sprintLogBranch}-${effectiveStartedAt}.analysis.md`;

const harvestLabel = 'harvester';
const harvestResult = await dispatch(
  `Repo: ${repo}\nBranch: ${branch}\nBase branch: ${base_branch}\n` +
  `Sprint goals: ${rootSummary}\nCycles completed: ${cycleCount}\nGoal met: ${goalMet}\n` +
  `sprintLogFile: ${sprintLogFile}\n` +
  `analysisArtifactFile: ${analysisArtifactFile}\n\n` +
  `The sprint is complete. Harvest the sprint artefacts.\n` +
  `Follow your runbook (agents/harvester.md).\n\n` +
  `IMPORTANT: Your FIRST action (Step 1 of your runbook) is to write the analysis artifact below ` +
  `to "${repo}/${analysisArtifactFile}" and commit it before doing anything else.\n\n` +
  `analysisText (write this verbatim to ${analysisArtifactFile}):\n` +
  sprintSummary.summaryText + `\n\n` +
  `costAnalysis (insert this block verbatim into CHANGELOG.md after the summary paragraph):\n` +
  `${sprintAnalysis.analysisText}\n` +
  `Final review notes to include in CHANGELOG:\n` +
  `${(finalReview && finalReview.notes) || '(none)'}\n\n` +
  `Return status "OK" if successful, "FAILED" with notes otherwise.`,
  { model: MODEL_SONNET, label: harvestLabel, phase: 'Harvest', schema: HARVEST_SCHEMA, agentType: 'harvester' }
);

if (!harvestResult || harvestResult.status !== 'OK') {
  log(`Harvest failed: ${(harvestResult && harvestResult.notes) || 'null'} -- writing analysis fallback`);
  // JS fallback: write .analysis.md directly from in-memory analysisText so the artifact
  // is preserved in branch history even when the harvester agent is killed or crashes.
  const safeContent = sprintSummary.summaryText.replace(/'/g, "'\\''");
  await dispatchShell(
    [
      `mkdir -p "${repo}/sprint-logs"`,
      `printf '%s' '${safeContent}' > "${repo}/${analysisArtifactFile}"`,
      `git -C "${repo}" add "${analysisArtifactFile}"`,
      `git -C "${repo}" -c user.name='pm' -c user.email='pm@pm.local' commit --allow-empty -m "chore: sprint-analysis fallback ${branch} ${effectiveStartedAt}"`,
    ],
    { model: MODEL_HAIKU, label: 'harvest-analysis-fallback', phase: 'Harvest' }
  );
  log(`Analysis artifact written via fallback: ${analysisArtifactFile}`);
  await clearSprintState(stateFileRel, 'state-clear-harvestfailed');
  return { cycles: cycleCount, goalMet, goal, harvest: 'failed' };
}

// ------------------------------------------------------------------ CALIBRATION UPDATE + CLOSE GOALS (parallel)
// Update historical averages in calibration.json after every successful sprint.
// All arithmetic is in JS; the haiku agent only writes the resulting JSON file.
// The doer closes tasks; the original sprint-goal epics must be closed explicitly.
// These have no data dependency between them, so run in parallel.

const updatedCalibration = computeUpdatedCalibration(calibration, sprintAnalysis, effectiveStartedAt, taskAssignments, logEntries);
const calibrationJson = JSON.stringify(updatedCalibration, null, 2);

const tokenEstimates = {
  averages: Object.values(updatedCalibration.historical?.tuple_averages || {})
};
const tokenEstimatesJson = JSON.stringify(tokenEstimates).replace(/"/g, '\\"');

await parallel([
  dispatch(
    `Write updated calibration file and commit.\n\n` +
    `Step 1: Ensure sprint-logs/ directory exists: mkdir -p "${repo}/sprint-logs"\n` +
    `Step 2: Write this JSON to "${repo}/sprint-logs/calibration.json" exactly as provided below:\n\n` +
    calibrationJson + `\n\n` +
    `Step 3: Commit the file:\n` +
    `  git -C "${repo}" add sprint-logs/calibration.json\n` +
    `  git -C "${repo}" commit -m "chore: update sprint calibration after ${cycleCount} cycle(s) on ${branch}"\n\n` +
    `Step 4: Update token estimates memory:\n` +
    `  bd remember "${tokenEstimatesJson}" --key token-estimates-json\n\n` +
    `If the file content is unchanged, the commit may be a no-op -- that is fine.\n` +
    `Return "OK" when done.`,
    { model: MODEL_HAIKU, label: 'calibration-update', phase: 'Harvest' }
  ),
  dispatch(
    `Close the delivered sprint goals in beads.\n\n` +
    `Run:\n` +
    rootIds.map(id => `  bd close ${id} --reason="implemented in sprint ${branch}"`).join('\n') + `\n\n` +
    `If an issue is already closed, bd close is a no-op. Return "OK" when done.`,
    { model: MODEL_HAIKU, label: 'close-sprint-goals', phase: 'Harvest' }
  ),
]);

// ------------------------------------------------------------------ BEADS EXPORT + SCAFFOLD CLEANUP

// Export beads state so committed .beads/*.jsonl reflects all closed P1 issues.
// Also remove sprint process files (requirements.md, feedback.md) from the PR net diff.
// Step 1 stages any sprint-log entries written by fire-and-forget appendNewEntries
// calls so the final cycle's JSONL lines are captured even when no later doer runs.
await dispatch(
  `Persist beads state and clean sprint scaffolding from the PR diff.\n\n` +
  `Step 1 -- Stage sprint-logs and evict scaffold files from the working tree (unconditional):\n` +
  `  git -C "${repo}" add sprint-logs/\n` +
  `  git -C "${repo}" rm -f --ignore-unmatch feedback.md requirements.md 2>/dev/null || true\n` +
  `  rm -f "${repo}/feedback.md" "${repo}/requirements.md" 2>/dev/null || true\n\n` +
  `Step 2 -- Export beads state:\n` +
  `  bd export -o "${repo}/.beads/issues.jsonl"\n` +
  `  git -C "${repo}" add .beads/issues.jsonl\n` +
  `  git -C "${repo}" diff --cached --quiet || git -C "${repo}" -c user.name='pm' -c user.email='pm@pm.local' commit -m "chore: export beads state"\n` +
  `  (The "diff --cached --quiet || commit" pattern only commits if something actually changed.)\n\n` +
  `Step 3 -- Check what process files are still in the PR diff:\n` +
  `  git -C "${repo}" diff --name-only ${base_branch}...${branch}\n\n` +
  `Step 4 -- For each of requirements.md, feedback.md that appears in the diff:\n` +
  `  a) Check if the file existed on ${base_branch}:\n` +
  `       git -C "${repo}" ls-tree --name-only ${base_branch} | grep -F <filename>\n` +
  `  b) If NOT on base (sprint created it): git -C "${repo}" rm --force <filepath>\n` +
  `  c) If on base (sprint modified it): git -C "${repo}" checkout ${base_branch} -- <filepath>\n` +
  `  After handling all such files:\n` +
  `    git -C "${repo}" add -A\n` +
  `    git -C "${repo}" -c user.name='pm' -c user.email='pm@pm.local' commit -m "chore: drop sprint scaffolding"\n` +
  `  (If no scaffold files remain in diff, skip the commit.)\n\n` +
  `Step 5 -- Verify the diff is clean:\n` +
  `  git -C "${repo}" diff --name-only ${base_branch}...${branch}\n` +
  `  The output must NOT contain requirements.md or feedback.md. If it does, repeat Step 4.\n\n` +
  `Step 6 -- Push all local commits to remote:\n` +
  `  git -C "${repo}" push origin ${branch}\n\n` +
  `Return "OK" when done.`,
  { model: MODEL_HAIKU, label: 'beads-export-cleanup', phase: 'Harvest' }
);

// ------------------------------------------------------------------ DOLT PUSH

// Sync beads Dolt remote so refs/dolt/data is up to date.
// Non-fatal: a missing remote or network error must not abort harvest.
// Skippable via the optional skip_dolt_push arg (the e2e passes it so sprints never
// write to a real Dolt remote on GitHub).
if (!opts.skip_dolt_push) {
  await dispatch(
    `Sync beads state to the Dolt remote.\n\n` +
    `Run:\n` +
    `  bd dolt push\n\n` +
    `Capture stdout and stderr. If the command exits 0, log "bd dolt push: OK".\n` +
    `If the command exits non-zero (e.g. no dolt remote configured, network error), log a warning:\n` +
    `  "bd dolt push failed (non-fatal): <reason>"\n` +
    `and continue -- do NOT throw, return an error, or abort the workflow.\n\n` +
    `Return "OK" when done (regardless of whether the push succeeded or failed).`,
    { model: MODEL_HAIKU, label: 'dolt-push', phase: 'Harvest' }
  );
} else {
  log('Skipping dolt push as requested by opts.skip_dolt_push.');
}

// ------------------------------------------------------------------ PR

const harvestPr = await dispatch(
  `In repo ${repo} on branch ${branch}, create a GitHub pull request targeting ${base_branch}.\n` +
  `Command: gh pr create --base ${base_branch} --head ${branch}\n` +
  `Title: summarise what was implemented across ${cycleCount} cycle(s).\n` +
  `Body:\n` +
  `  - What was built (per sprint goal)\n` +
  `  - Sprint goal: ${goal} -- ${goalMet ? 'MET' : 'NOT MET (partial delivery)'}\n` +
  `  - Cycles run: ${cycleCount}\n` +
  `  - Open items carried forward (if any): bd list --status=open and summarise\n` +
  `  - Final review notes: ${(finalReview && finalReview.notes) || '(none)'}\n` +
  `  - Token cost summary from: bd recall token-estimates-json\n\n` +
  `After creating the PR, return its number as prNumber (integer).`,
  { model: MODEL_SONNET, label: 'harvest-pr', phase: 'Harvest',
    schema: { type: 'object', required: ['prNumber'], properties: { prNumber: { type: 'number' }, prUrl: { type: 'string' } } } }
);
const prNumber = harvestPr && harvestPr.prNumber;

// ------------------------------------------------------------------ CI CHECK (post-PR)

let ciResult = null;
if (prNumber) {
  ciResult = await dispatch(
    `Check CI status for PR #${prNumber} on branch ${branch}.\n` +
    `This is a PR-scoped dispatch (prNumber supplied -- see agents/ci-watcher.md Inputs);\n` +
    `the branch+expectedHeadSha form does not apply here.\n` +
    `Run: gh run list --pr ${prNumber} --limit 3 --json status,conclusion,databaseId\n` +
    `If runs exist and are in_progress: poll with gh run watch <id> (timeout 10 min).\n` +
    `If runs exist and conclusion is "success": return status "green".\n` +
    `If runs exist and conclusion is "failure": return status "red" with notes (include run URL).\n` +
    `If no runs found: return status "not_configured".\n` +
    `Do not block for more than 10 minutes total.`,
    { model: MODEL_HAIKU, label: 'ci-watcher', phase: 'Harvest', schema: CI_SCHEMA, agentType: 'ci-watcher' }
  );

  if (ciResult) {
    log(`CI status: ${ciResult.status}`);
    if (ciResult.status === 'not_configured') {
      log('CI not configured -- checking for existing open CI pipeline task');
      const dedupResult = await dispatch(
        `Run: bd search "Add CI pipeline" --status=open --json\n` +
        `Parse the JSON output and look for any issue whose title matches ` +
        `"Add CI pipeline to project" (exact or close variant, case-insensitive).\n` +
        `If a matching OPEN issue is found, return JSON: {"exists": true, "id": "<issue-id>"}\n` +
        `If no matching open issue is found (or the command returns empty/no results), ` +
        `return JSON: {"exists": false, "id": null}`,
        { model: MODEL_HAIKU, label: 'ci-task-dedup', phase: 'Harvest',
          schema: { type: 'object', properties: { exists: { type: 'boolean' }, id: { type: ['string', 'null'] } }, required: ['exists', 'id'] } }
      );
      if (dedupResult && dedupResult.exists) {
        log(`CI pipeline task already exists: ${dedupResult.id} -- skipping creation`);
      } else {
        await dispatch(
          `Run: bd create --title="Add CI pipeline to project" ` +
          `--description="The auto-sprint workflow found no CI runs for branch ${branch}. ` +
          `CI is required for the sprint exit gate. ` +
          `This task covers: choosing a CI provider, writing the workflow config, and verifying it triggers on push." ` +
          `--type=task --priority=2\n` +
          `Then run: bd show <new-id> and confirm it was created.`,
          { model: MODEL_HAIKU, label: 'ci-task-create', phase: 'Harvest' }
        );
        log('ACTION REQUIRED: Set up CI for this project. Task created in beads.');
      }
    } else if (ciResult.status === 'red') {
      log(`CI FAILED: ${(ciResult.notes || '').slice(0, 200)}`);
    }

    // Append CI result to the PR body so the note lands after the PR is created.
    if (ciResult.status !== 'green') {
      await dispatch(
        `Annotate PR #${prNumber} with the CI status result.\n\n` +
        `Run: gh pr comment ${prNumber} --body "**CI status: ${ciResult.status}**${ciResult.notes ? '\\n\\n' + ciResult.notes : ''}"`,
        { model: MODEL_HAIKU, label: 'ci-pr-annotate', phase: 'Harvest' }
      );
    }
  }
}

// ------------------------------------------------------------------ COST SUMMARY
// Pure JS -- no agent call. Groups dispatchLedger by role (derived from label prefix)
// and by model, prints a table, and reports total sprint cost.

const roleOf = label => label.replace(/-c\d.*$/, '');  // "doer-c1-i0-haiku" -> "doer"

const byRole = {};
for (const e of dispatchLedger) {
  const role = roleOf(e.label);
  if (!byRole[role]) byRole[role] = { costUsd: 0, outTokens: 0, calls: 0 };
  byRole[role].costUsd    += e.costUsd;
  byRole[role].outTokens  += e.outTokens;
  byRole[role].calls      += 1;
}

const sprintTotal = dispatchLedger.reduce((s, e) => s + e.costUsd, 0);

log('\n=== Sprint cost summary (output tokens only) ===');
for (const [role, s] of Object.entries(byRole).sort((a, b) => b[1].costUsd - a[1].costUsd)) {
  log(`  ${role.padEnd(20)} $${s.costUsd.toFixed(4).padStart(8)}  ${String(s.outTokens).padStart(8)} tok  ${s.calls} call(s)`);
}
log(`  ${'TOTAL'.padEnd(20)} $${sprintTotal.toFixed(4).padStart(8)}`);
log(`  (input token cost not included -- see ${sprintLogFile} for per-dispatch detail)`);
log('================================================\n');

// Final per-phase wall-clock stamp + report. Shows where the sprint's time actually went
// (e.g. "develop was 70% of total") and is the evidence for the parallel-doer speedup.
await stamp('end');
const phaseTiming = buildPhaseTiming(phaseTimeline);
log('=== Sprint wall-clock by phase ===');
log(phaseTiming.text);
log('==================================\n');

// Sprint completed cleanly -- release the concurrency lock so the next run starts fresh.
// (An unclean crash skips this, leaving the state file for a resume.)
await clearSprintState(stateFileRel, 'state-clear-done');
return { cycles: cycleCount, goalMet, goal, harvest: 'ok', sprintCostUsd: parseFloat(sprintTotal.toFixed(4)),
  phaseTimingSeconds: phaseTiming.totalSeconds, phaseTiming: phaseTiming.rows };
