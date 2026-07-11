// Estimated per-1M-token prices (USD), prompt/completion split.
// These are point-in-time ESTIMATES, not a live pricing feed -- do not treat
// them as authoritative for billing. lastUpdated: 2024 (see apra-fleet-unw.4;
// no new prices were invented when this table was reviewed -- if a model you
// need isn't listed below, calculateCost() returns `null` rather than
// guessing at a price).
export const MODEL_PRICING = {
    // Standard models (price per 1M tokens)
    'gpt-4o': { prompt: 5.00, completion: 15.00 },
    'gpt-4-turbo': { prompt: 10.00, completion: 30.00 },
    'claude-3-5-sonnet-20240620': { prompt: 3.00, completion: 15.00 },
    'claude-3-opus-20240229': { prompt: 15.00, completion: 75.00 },
    'gemini-1.5-pro': { prompt: 3.50, completion: 10.50 },
    'gemini-1.5-flash': { prompt: 0.35, completion: 1.05 }
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
