/**
 * apra-fleet-dv5.5: per-member, per-tier LLM token pricing.
 *
 * Deterministic tier -> concrete-model resolution (resolveModelForTier() in
 * execute-prompt.ts / each provider's modelTiers()) is config-driven and
 * known ahead of any dispatch -- it does not require a per-dispatch
 * echo-back to know what "member X's premium tier" resolves to. This module
 * resolves each of a member's three tiers to a concrete model (mirroring
 * resolveModelForTier's own resolution order: the member's own
 * `modelTiers` override first, then the provider's default) and looks up
 * that model's $/1M-token price.
 *
 * Same "unknown model returns null, never fabricate a price" discipline as
 * apra-fleet-workflow's pricing.mjs -- these are point-in-time ESTIMATES,
 * not a live pricing feed.
 */
import type { Agent, LlmProvider } from '../types.js';
import type { ProviderAdapter } from '../providers/provider.js';
import { getModelOverride } from './user-config.js';

export interface ModelPrice {
  model: string;
  promptPrice: number;
  completionPrice: number;
  /** $/1M prompt tokens served from the prompt cache (cache_read_input_tokens). */
  cacheReadPrice: number;
  /** $/1M prompt tokens written to the prompt cache (cache_creation_input_tokens). */
  cacheWritePrice: number;
}

/**
 * Anthropic prompt-cache write pricing, from
 * https://platform.claude.com/docs/en/about-claude/pricing (checked
 * 2026-10-06): a 5-minute cache write costs 1.25x the base input price and a
 * 1-hour write 2x. The Claude Code CLI writes its cache with the 1-hour TTL
 * (every recorded fleet dispatch reports ephemeral_1h_input_tokens and zero
 * ephemeral_5m_input_tokens), so cache writes are priced at 2x. Cache READ
 * rates are NOT one multiplier (0.1x on most models, 0.05x on Opus 5.5,
 * 0.025x on Fable 5.1), so each table row carries its own `cacheRead`.
 *
 * This table is the FALLBACK only: a Claude dispatch's cost is the CLI's own
 * reported figure (usage.cost_usd); the table prices providers and results
 * that report no cost.
 */
export const ANTHROPIC_CACHE_WRITE_MULTIPLIER = 2;

/** True for a Claude-family model id, under any provider's naming
 *  (claude provider aliases haiku/sonnet/opus, copilot/agy 'claude-*' ids). */
function isClaudeModel(model: string): boolean {
  return /^(haiku|sonnet|opus|fable)$/.test(model) || /(^|\/)claude-/.test(model);
}

export type MemberModelPricing = {
  cheap: ModelPrice | null;
  standard: ModelPrice | null;
  premium: ModelPrice | null;
};

/**
 * provider -> concrete model id -> $/1M-token {prompt, completion}.
 *
 * Seeded from each provider adapter's own modelTiers() default (see
 * src/providers/*.ts) -- these are the models actually dispatched against
 * absent a per-member modelTiers override. An unlisted model (whether from
 * an override or a future provider default change) returns null rather
 * than a fabricated/guessed price.
 */
// Claude rows are Anthropic list prices (see ANTHROPIC_CACHE_WRITE_MULTIPLIER):
// `cacheRead` is the model's own cache-hit rate. The claude provider's
// aliases resolve to the current models: haiku = Haiku 4.5, sonnet =
// Sonnet 5.5, opus = Opus 5.5 (a recorded result confirms opus ->
// claude-opus-5-5), fable = Fable 5.1.
const PROVIDER_MODEL_PRICING: Partial<Record<LlmProvider, Record<string, { prompt: number; completion: number; cacheRead?: number }>>> = {
  claude: {
    haiku: { prompt: 1.00, completion: 5.00, cacheRead: 0.10 },
    sonnet: { prompt: 2.00, completion: 10.00, cacheRead: 0.20 },
    opus: { prompt: 4.00, completion: 20.00, cacheRead: 0.20 },
    fable: { prompt: 10.00, completion: 50.00, cacheRead: 0.25 },
    'claude-haiku-4-5': { prompt: 1.00, completion: 5.00, cacheRead: 0.10 },
    'claude-sonnet-5-5': { prompt: 2.00, completion: 10.00, cacheRead: 0.20 },
    'claude-opus-5-5': { prompt: 4.00, completion: 20.00, cacheRead: 0.20 },
    'claude-fable-5-1': { prompt: 10.00, completion: 50.00, cacheRead: 0.25 },
  },
  agy: {
    'gemini-3.8-flash-low': { prompt: 0.10, completion: 0.40 },
    // Effort variants of one model share its per-token rate (same weights).
    'gemini-3.8-flash-medium': { prompt: 0.10, completion: 0.40 },
    'gemini-3.8-flash-high': { prompt: 0.10, completion: 0.40 },
    'gemini-3.1-pro-low': { prompt: 0.35, completion: 1.05 },
    'gemini-3.1-pro-high': { prompt: 0.35, completion: 1.05 },
    'claude-opus-4-6-thinking': { prompt: 5.00, completion: 25.00, cacheRead: 0.50 },
  },
  codex: {
    'gpt-5.4-mini': { prompt: 0.25, completion: 2.00 },
    'gpt-5.4': { prompt: 5.00, completion: 15.00 },
  },
  copilot: {
    'claude-haiku-4-5': { prompt: 1.00, completion: 5.00, cacheRead: 0.10 },
    'claude-sonnet-4-5': { prompt: 3.00, completion: 15.00, cacheRead: 0.30 },
    'claude-opus-4-5': { prompt: 5.00, completion: 25.00, cacheRead: 0.50 },
  },
  // OpenCode's default tier models are all free-tier ($0) -- a real,
  // known price, not an "unknown model" null.
  opencode: {
    'opencode/north-mini-code-free': { prompt: 0, completion: 0 },
    'opencode/deepseek-v4-flash-free': { prompt: 0, completion: 0 },
    'opencode/nemotron-3-ultra-free': { prompt: 0, completion: 0 },
  },
  // 'none' is a compute-only, non-LLM provider (see member-detail.ts's
  // `tokenUsage = 'compute only'` handling) -- it has no models to price.
  none: {},
};

/**
 * Resolves a member's three tiers to concrete models using the SAME
 * precedence chain execute-prompt.ts actually dispatches with (see its
 * per-tier `if (resolvedModel === 'cheap') ... else if (... === 'standard')
 * ...` block, ~line 293-313), not just resolveModelForTier() in isolation
 * (that helper is itself only reached when `agent.modelTiers` is set --
 * dead code otherwise in the real dispatch path). Per tier, in order:
 *   1. `agent.modelTiers` (the whole-object override, e.g. from a planner
 *      or admin setting all three tiers at once) -- if set, wins for ALL
 *      three tiers and nothing below is consulted, mirroring
 *      resolveModelForTier()'s own cheap/standard/premium-then-first-
 *      defined fallback when a specific tier is absent from the object.
 *   2. `agent.model<Tier>` (the single-tier per-member override set via
 *      `update_member --model-cheap/standard/premium`, docs/install.md
 *      "Customizing model tier mapping").
 *   3. The global user-config override (`~/.apra-fleet/data/config.json`,
 *      getModelOverride()).
 *   4. The provider's own hardcoded default (provider.modelTiers()).
 */
function resolveMemberTierModels(agent: Agent, provider: ProviderAdapter): Record<'cheap' | 'standard' | 'premium', string> {
  const memberTiers = agent.modelTiers;
  if (memberTiers) {
    const fallback = memberTiers.standard ?? memberTiers.cheap ?? Object.values(memberTiers).filter(Boolean)[0] as string;
    return {
      cheap: memberTiers.cheap ?? fallback,
      standard: memberTiers.standard ?? fallback,
      premium: memberTiers.premium ?? fallback,
    };
  }

  const providerName = agent.llmProvider ?? 'claude';
  const defaults = provider.modelTiers();
  return {
    cheap: agent.modelCheap || getModelOverride(providerName, 'cheap') || defaults.cheap,
    standard: agent.modelStandard || getModelOverride(providerName, 'standard') || defaults.standard,
    premium: agent.modelPremium || getModelOverride(providerName, 'premium') || defaults.premium,
  };
}

function priceModel(providerName: LlmProvider, model: string): ModelPrice | null {
  const table = PROVIDER_MODEL_PRICING[providerName];
  if (!table) return null;
  const price = table[model];
  if (!price) return null;
  // Claude models: the row's own cache-read rate and Anthropic's 1-hour
  // cache-write rate. Other models' adapters report no cache-token counts
  // (always 0), so their cache rates never contribute; they are set to the
  // plain prompt price -- the honest "billed as an input token, no known
  // discount" figure -- rather than an invented discount.
  const claude = isClaudeModel(model);
  return {
    model,
    promptPrice: price.prompt,
    completionPrice: price.completion,
    cacheReadPrice: claude && price.cacheRead !== undefined ? price.cacheRead : price.prompt,
    cacheWritePrice: claude ? round6(price.prompt * ANTHROPIC_CACHE_WRITE_MULTIPLIER) : price.prompt,
  };
}

/** Strip binary floating-point noise (15 * 0.1 = 1.5000000000000002). */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * @param agent the member to resolve pricing for
 * @param provider the ProviderAdapter for agent.llmProvider (getProvider(agent.llmProvider))
 * @returns per-tier pricing; a tier is `null` when its resolved model has no
 *   known price (unlisted model, or a provider with no pricing table).
 */
export function getMemberModelPricing(agent: Agent, provider: ProviderAdapter): MemberModelPricing {
  const providerName: LlmProvider = agent.llmProvider ?? 'claude';
  const tierModels = resolveMemberTierModels(agent, provider);
  return {
    cheap: priceModel(providerName, tierModels.cheap),
    standard: priceModel(providerName, tierModels.standard),
    premium: priceModel(providerName, tierModels.premium),
  };
}
