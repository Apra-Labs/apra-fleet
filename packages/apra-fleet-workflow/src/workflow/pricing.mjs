// Estimated per-1M-token prices (USD), prompt/completion split.
// These are point-in-time ESTIMATES, not a live pricing feed -- do not treat
// them as authoritative for billing. lastUpdated: 2024 (see apra-fleet-unw.4;
// no new prices were invented when this table was reviewed -- if a model you
// need isn't listed below, calculateCost() returns `null` rather than
// guessing at a price).
//
// N10 (apra-fleet-unw2.8, 2026-07): added the four fleet models this
// runner actually dispatches against -- 'fable', 'opus', 'sonnet', 'haiku'
// (the exact strings recorded in beads `--metadata '{"model": ...}'` by the
// planner, see runner.js's FIXED_ROLE_MODEL / resolveDoerModel doc
// comments). These map to Claude Fable 5 / Opus 4.8 / Sonnet 5 / Haiku 4.5
// respectively. THESE FOUR ROWS ARE ESTIMATES, not sourced from an official
// published price list -- there is no live pricing feed wired in (see the
// module doc comment above and N10's fix-direction note in
// packages/apra-fleet-workflow/docs/feedback-reassessment.md): they are
// ordered relative to each other the way the fleet's own tiering treats
// them (haiku cheapest/fastest, sonnet mid, opus/fable most capable &
// most expensive), scaled roughly against this table's pre-existing
// 2024-era rows for the same relative tiers, and should be replaced with
// real numbers the moment an authoritative source is available. Budget
// enforcement built on these rows is therefore honestly an ESTIMATE, not a
// verified actual -- see the "server-side echo of the resolved model"
// caveat below and in runner.js: the fleet does not currently report back
// which model it actually ran a dispatch on, so this table prices the
// model the CALLER ASKED for (via `opts.model`), not a confirmed actual.
// That server-side echo-back remains explicitly descoped (docs/plan.md).
export const MODEL_PRICING = {
    // Standard models (price per 1M tokens)
    'gpt-4o': { prompt: 5.00, completion: 15.00 },
    'gpt-4-turbo': { prompt: 10.00, completion: 30.00 },
    'claude-3-5-sonnet-20240620': { prompt: 3.00, completion: 15.00 },
    'claude-3-opus-20240229': { prompt: 15.00, completion: 75.00 },
    'gemini-1.5-pro': { prompt: 3.50, completion: 10.50 },
    'gemini-1.5-flash': { prompt: 0.35, completion: 1.05 },

    // Fleet models (N10, apra-fleet-unw2.8) -- ESTIMATES, see comment above.
    // Keys are the exact lowercase strings the planner writes into a bead's
    // `--metadata '{"model": "<tier>"}'` and that runner.js passes through
    // verbatim as `opts.model`; calculateCost() below matches via
    // substring-of-modelName, so a more specific real model id (e.g. a
    // hypothetical 'claude-haiku-4.5-20260601') would still match the
    // 'haiku' row.
    'haiku': { prompt: 0.80, completion: 4.00 },     // Claude Haiku 4.5 (estimate) -- cheapest/fastest tier
    'sonnet': { prompt: 3.00, completion: 15.00 },   // Claude Sonnet 5 (estimate) -- mid tier, unchanged from the 2024 sonnet row
    'opus': { prompt: 15.00, completion: 75.00 },    // Claude Opus 4.8 (estimate) -- premium tier, unchanged from the 2024 opus row
    'fable': { prompt: 15.00, completion: 75.00 }    // Claude Fable 5 (estimate) -- treated as premium tier, same order of magnitude as opus
};

/**
 * @param {string} modelName
 * @param {{ prompt_tokens?: number, completion_tokens?: number }|null} usage
 * @returns {number|null} the estimated cost in USD, or `null` when usage is
 *   missing/empty, or when `modelName` doesn't match any entry in
 *   MODEL_PRICING (unknown models are never silently priced with a default
 *   -- see apra-fleet-unw.4).
 */
export function calculateCost(modelName, usage) {
    if (!usage || (!usage.prompt_tokens && !usage.completion_tokens)) return null;

    let pricing = null;
    if (modelName) {
        const key = Object.keys(MODEL_PRICING).find(k => modelName.toLowerCase().includes(k));
        if (key) pricing = MODEL_PRICING[key];
    }
    if (!pricing) return null;

    const pTokens = usage.prompt_tokens || 0;
    const cTokens = usage.completion_tokens || 0;

    const promptCost = (pTokens / 1000000) * pricing.prompt;
    const compCost = (cTokens / 1000000) * pricing.completion;

    return promptCost + compCost;
}
