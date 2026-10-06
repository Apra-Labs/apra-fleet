// Estimated per-1M-token prices (USD), prompt/completion split.
// These are point-in-time ESTIMATES, not a live pricing feed -- do not treat
// them as authoritative for billing. lastUpdated: 2024 (see apra-fleet-unw.4;
// no new prices were invented when this table was reviewed -- if a model you
// need isn't listed below, calculateCost() returns `null` rather than
// guessing at a price).
//
// apra-fleet-dv5.2: this table is now the FALLBACK layer only. Real
// per-member pricing (apra-fleet-dv5.5's get_member_model_pricing MCP tool,
// consumed client-side by apra-fleet-dv5.6) is the PRIMARY mechanism --
// these rows are the honest degrade-path used only when real pricing is
// unavailable for a given run/member (older fleet server, tool-call
// failure, or an unpriced provider/model).
//
// Two independent key families live in this table:
//  - Tier bands ('cheap'/'standard'/'premium'): what runner.js's
//    FIXED_ROLE_TIER and the planner's per-bead metadata convention emit by
//    default (apra-fleet-dv5.1) -- provider-agnostic, resolved to a
//    concrete model per member server-side. Seeded from the pre-existing
//    haiku/sonnet/opus rows below (same relative ordering), NOT sourced
//    from an official published price list.
//  - Concrete model IDs ('fable'/'opus'/'sonnet'/'haiku' and the
//    non-fleet rows further below): a fully legitimate, permanent
//    alternative to a tier keyword -- not a deprecated/legacy convention --
//    for a caller that already knows which concrete model a target member
//    runs and wants to price against that specifically. Matched via
//    substring-of-modelName (see calculateCost()), so a more specific real
//    model id (e.g. 'claude-haiku-4.5-20260601') still matches 'haiku'.
export const MODEL_PRICING = {
    // Standard models (price per 1M tokens)
    'gpt-4o': { prompt: 5.00, completion: 15.00 },
    'gpt-4-turbo': { prompt: 10.00, completion: 30.00 },
    'claude-3-5-sonnet-20240620': { prompt: 3.00, completion: 15.00 },
    'claude-3-opus-20240229': { prompt: 15.00, completion: 75.00 },
    'gemini-1.5-pro': { prompt: 3.50, completion: 10.50 },
    'gemini-1.5-flash': { prompt: 0.35, completion: 1.05 },

    // Tier-band fallback rows (apra-fleet-dv5.2) -- used only when real
    // per-member pricing is unavailable. Seeded from the haiku/sonnet/opus
    // rows below; keep in sync if those are ever revised.
    'cheap': { prompt: 0.80, completion: 4.00 },
    'standard': { prompt: 3.00, completion: 15.00 },
    'premium': { prompt: 15.00, completion: 75.00 },

    // Concrete fleet model IDs (N10, apra-fleet-unw2.8) -- ESTIMATES, see
    // comment above. A legitimate, permanent input form (not legacy).
    'haiku': { prompt: 0.80, completion: 4.00 },     // Claude Haiku 4.5 (estimate) -- cheapest/fastest tier
    'sonnet': { prompt: 3.00, completion: 15.00 },   // Claude Sonnet 5 (estimate) -- mid tier, unchanged from the 2024 sonnet row
    'opus': { prompt: 15.00, completion: 75.00 },    // Claude Opus 4.8 (estimate) -- premium tier, unchanged from the 2024 opus row
    'fable': { prompt: 15.00, completion: 75.00 }    // Claude Fable 5 (estimate) -- treated as premium tier, same order of magnitude as opus
};

// Prompt-cache rates (apra-fleet cache-token accounting). Anthropic list
// pricing (https://docs.anthropic.com/en/docs/about-claude/pricing, prompt
// caching): a cache read costs 0.1x the base input price, a 5-minute cache
// write 1.25x. Every row above is a Claude model or seeded from one EXCEPT the
// gpt-*/gemini-* rows, whose usage never carries Claude's cache fields; those
// price any cache token at the plain prompt rate (no invented discount).
// Mirrors src/services/model-pricing.ts on the server.
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;
const NON_CLAUDE_KEY_RE = /^(gpt-|gemini-)/;

/**
 * @param {string} key a MODEL_PRICING key
 * @returns {{ cacheRead: number, cacheWrite: number }} $/1M cache rates
 */
export function cacheRatesFor(key) {
    const row = MODEL_PRICING[key];
    if (NON_CLAUDE_KEY_RE.test(key)) return { cacheRead: row.prompt, cacheWrite: row.prompt };
    return { cacheRead: row.prompt * CACHE_READ_MULTIPLIER, cacheWrite: row.prompt * CACHE_WRITE_MULTIPLIER };
}

/**
 * Every billed token count in an execute_prompt usage block: input, output,
 * and the two prompt-cache counts (reported separately from input_tokens;
 * absent = 0). usage.total_tokens is deliberately NOT this -- it stays
 * input+output for context admission.
 * @param {{ input_tokens?: number, output_tokens?: number, total_tokens?: number, cache_read_input_tokens?: number, cache_creation_input_tokens?: number }|null|undefined} usage
 * @returns {number}
 */
export function billedTokens(usage) {
    if (!usage) return 0;
    // total_tokens (input+output) when reported, else the two parts.
    const base = typeof usage.total_tokens === 'number'
        ? usage.total_tokens
        : (usage.input_tokens || 0) + (usage.output_tokens || 0);
    return base + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
}

// Tier-band keys are exact-match only (see calculateCost()) -- excluded
// from the substring scan so a near-miss string ('standard-tier') never
// silently matches a real tier keyword ('standard').
const TIER_BAND_KEYS = new Set(['cheap', 'standard', 'premium']);

/**
 * @param {string} modelName
 * @param {{ input_tokens?: number, output_tokens?: number, cache_read_input_tokens?: number, cache_creation_input_tokens?: number }|null} usage
 * @returns {number|null} the estimated cost in USD, or `null` when usage is
 *   missing/empty, or when `modelName` doesn't match any entry in
 *   MODEL_PRICING (unknown models are never silently priced with a default
 *   -- see apra-fleet-unw.4).
 */
export function calculateCost(modelName, usage) {
    if (!usage || (!usage.input_tokens && !usage.output_tokens && !usage.cache_read_input_tokens && !usage.cache_creation_input_tokens)) return null;

    let pricing = null;
    let pricingKey = null;
    if (modelName) {
        const lower = modelName.toLowerCase();
        // Exact match first (apra-fleet-dv5.2): a tier band ('cheap',
        // 'standard', 'premium') only ever prices an EXACT tier keyword --
        // it is deliberately excluded from the substring scan below, so a
        // string like 'standard-tier' (a plausible typo/mismatch, not a
        // real tier keyword) stays unpriced rather than silently matching
        // 'standard'. Substring matching remains reserved for concrete
        // model IDs (e.g. 'claude-haiku-4.5-20260601' still matches
        // 'haiku'), where a caller legitimately passes a longer real model
        // string that happens to contain a known short concrete-id key.
        if (Object.prototype.hasOwnProperty.call(MODEL_PRICING, lower)) {
            pricingKey = lower;
        } else {
            pricingKey = Object.keys(MODEL_PRICING)
                .filter((k) => !TIER_BAND_KEYS.has(k))
                .find((k) => lower.includes(k)) || null;
        }
        if (pricingKey) pricing = MODEL_PRICING[pricingKey];
    }
    if (!pricing) return null;

    const pTokens = usage.input_tokens || 0;
    const cTokens = usage.output_tokens || 0;

    const crTokens = usage.cache_read_input_tokens || 0;
    const cwTokens = usage.cache_creation_input_tokens || 0;
    const { cacheRead, cacheWrite } = cacheRatesFor(pricingKey);

    const promptCost = (pTokens / 1000000) * pricing.prompt;
    const compCost = (cTokens / 1000000) * pricing.completion;
    const cacheCost = (crTokens / 1000000) * cacheRead + (cwTokens / 1000000) * cacheWrite;

    return promptCost + compCost + cacheCost;
}
