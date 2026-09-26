import type { Agent } from '../types.js';
import type { ProviderAdapter } from '../providers/provider.js';
import { getMemberModelPricing } from './model-pricing.js';

/**
 * Usage/budget awareness for execute_prompt (apra-fleet-eft.80.2).
 *
 * A member/workspace can be given a configured spend budget -- either a
 * dollar/day ceiling or a token/window ceiling. Two independent concerns:
 *
 *   1. SOURCE of the "spent so far" figure. The PRIMARY source is a
 *      provider-native usage/quota read, exposed as the optional
 *      `getUsage()` adapter capability (see ProviderAdapter.getUsage in
 *      src/providers/provider.ts and docs/execute-prompt-usage-api-survey.md
 *      for which providers can actually answer it). When a provider does NOT
 *      implement getUsage(), OR its getUsage() returns null at runtime (no
 *      credential, endpoint unreachable, ...), we FALL BACK to a fleet-side
 *      ESTIMATE: accumulate each dispatch's own parsed token counts, priced
 *      via getMemberModelPricing() for a dollar budget (or summed raw for a
 *      token budget). The two paths are distinguished on every emitted block
 *      by `source: 'provider'` vs `source: 'estimated'`.
 *
 *   2. WHAT crossing a threshold does. Once spent/limit reaches the warning
 *      band (default 0.8), a structured usage block is attached to every
 *      subsequent result (nothing is attached below the band). When an
 *      optional hard fraction is configured, a NEW dispatch is REJECTED
 *      before any LLM call once spent/limit reaches it -- an in-flight
 *      dispatch is never killed, only the next admission is refused.
 *
 * This module is intentionally self-contained (its own in-memory budget
 * registry, settable via setBudget) so the reservation/sprint layer -- or a
 * test -- can configure a per-scope budget without a config-file round trip.
 * A scope key is any opaque string; execute_prompt uses the member id, then
 * the workspace id, as candidate scopes (resolveBudgetScope).
 */

export type BudgetUnit = 'dollars' | 'tokens';

export interface BudgetConfig {
  /** Spend ceiling in the chosen unit: dollars/day or tokens/window. */
  limit: number;
  unit: BudgetUnit;
  /** Fraction of `limit` (0..1) at/above which the usage block is attached to
   *  every result. Default DEFAULT_WARN_FRACTION (0.8). */
  warnFraction?: number;
  /** Optional hard-stop fraction (0..1). When set, a NEW dispatch is rejected
   *  before any LLM call once spent/limit reaches it. Omit for warn-only. */
  hardFraction?: number;
}

/** The structured block attached to a result once the warning band is crossed
 *  (and to a budget_exhausted rejection). Deliberately NOT named `usage` to
 *  avoid colliding with execute_prompt's existing token-count `usage`
 *  ({input_tokens, output_tokens, total_tokens}), which workflow consumers
 *  already read. */
export interface BudgetUsageBlock {
  spent: number;
  budget: number;
  fraction: number;
  scope: string;
  unit: BudgetUnit;
  source: 'provider' | 'estimated';
}

/** Return shape of the optional provider-native getUsage() capability. */
export interface ProviderUsage {
  /** Amount already spent in the requested unit (dollars or tokens). */
  spent: number;
}

export interface BudgetState {
  /** True when a hard fraction is configured and spent/limit has reached it --
   *  execute_prompt must refuse the NEW dispatch (no LLM call). */
  exhausted: boolean;
  /** True when spent/limit has reached the warning band -- the block should be
   *  attached to the result. */
  warned: boolean;
  block: BudgetUsageBlock;
}

/** Default warning band: 80% of the configured budget. */
export const DEFAULT_WARN_FRACTION = 0.8;

// scope key -> configured budget. Empty by default: with no budget configured
// for a scope, evaluateBudget returns undefined and execute_prompt behaves
// exactly as before (back-compat).
const budgets = new Map<string, BudgetConfig>();

// scope key -> accumulated fleet-side ESTIMATED spend (in that scope's unit).
// Only consulted/updated on the estimated path (provider has no getUsage()).
const estimatedSpend = new Map<string, number>();

/** Configure (or, with undefined, clear) the budget for a scope. A
 *  non-positive limit is treated as "no budget". */
export function setBudget(scope: string, cfg: BudgetConfig | undefined): void {
  if (!cfg || !(cfg.limit > 0)) {
    budgets.delete(scope);
    return;
  }
  budgets.set(scope, cfg);
}

/** The configured budget for a scope, or undefined. */
export function getBudgetConfig(scope: string): BudgetConfig | undefined {
  return budgets.get(scope);
}

/** First candidate scope that has a configured budget, or undefined when none
 *  do -- lets execute_prompt prefer a member-scoped budget over a
 *  workspace-scoped one while treating "no budget anywhere" as a no-op. */
export function resolveBudgetScope(candidates: Array<string | undefined>): string | undefined {
  for (const c of candidates) {
    if (c && budgets.has(c)) return c;
  }
  return undefined;
}

/** Add to a scope's accumulated ESTIMATED spend. */
export function recordEstimatedSpend(scope: string, delta: number): void {
  if (!(delta > 0)) return;
  estimatedSpend.set(scope, (estimatedSpend.get(scope) ?? 0) + delta);
}

/** A scope's accumulated estimated spend (0 when untracked). */
export function estimatedSpendFor(scope: string): number {
  return estimatedSpend.get(scope) ?? 0;
}

/** Test-only: clear all configured budgets and accumulated estimated spend. */
export function _resetBudgetState(): void {
  budgets.clear();
  estimatedSpend.clear();
}

/**
 * Spend that a single dispatch's token usage represents, in the budget's unit.
 * For a token budget this is just input+output tokens. For a dollar budget it
 * is priced via getMemberModelPricing() for the resolved tier; an unpriceable
 * tier (unknown model, subscription-plan member with no meter) contributes 0
 * rather than a fabricated cost -- the same "never invent a price" discipline
 * model-pricing.ts already follows.
 */
export function estimateDispatchCost(
  agent: Agent,
  provider: ProviderAdapter,
  tier: 'cheap' | 'standard' | 'premium' | undefined,
  usage: { input_tokens: number; output_tokens: number },
  unit: BudgetUnit,
): number {
  if (unit === 'tokens') return usage.input_tokens + usage.output_tokens;
  const pricing = getMemberModelPricing(agent, provider);
  const price = pricing[tier ?? 'standard'];
  if (!price) return 0;
  return (usage.input_tokens / 1_000_000) * price.promptPrice
    + (usage.output_tokens / 1_000_000) * price.completionPrice;
}

/**
 * Current budget state for a scope, or undefined when the scope has no
 * configured budget (callers must treat undefined as "no budget awareness --
 * behavior unchanged"). Reads the spend figure from the provider's getUsage()
 * capability when present (source: 'provider'), else from the accumulated
 * fleet-side estimate (source: 'estimated').
 */
export async function evaluateBudget(opts: {
  scope: string;
  agent: Agent;
  provider: ProviderAdapter;
}): Promise<BudgetState | undefined> {
  const cfg = budgets.get(opts.scope);
  if (!cfg) return undefined;

  let spent: number;
  let source: 'provider' | 'estimated';
  if (typeof opts.provider.getUsage === 'function') {
    let native: ProviderUsage | null = null;
    try {
      native = await opts.provider.getUsage({ agent: opts.agent, unit: cfg.unit, scope: opts.scope });
    } catch {
      native = null; // provider read failed -- fall back to the estimate.
    }
    if (native && typeof native.spent === 'number') {
      spent = native.spent;
      source = 'provider';
    } else {
      spent = estimatedSpendFor(opts.scope);
      source = 'estimated';
    }
  } else {
    spent = estimatedSpendFor(opts.scope);
    source = 'estimated';
  }

  const fraction = spent / cfg.limit;
  const warnFraction = cfg.warnFraction ?? DEFAULT_WARN_FRACTION;
  const exhausted = cfg.hardFraction !== undefined && fraction >= cfg.hardFraction;
  const block: BudgetUsageBlock = {
    spent,
    budget: cfg.limit,
    fraction,
    scope: opts.scope,
    unit: cfg.unit,
    source,
  };
  return { exhausted, warned: fraction >= warnFraction, block };
}

/**
 * Account a just-completed dispatch's usage against the scope's budget (only
 * self-metering on the estimated path -- a provider-native source owns its own
 * accounting) and return the resulting state. Undefined when no budget is
 * configured for the scope.
 */
export async function recordAndEvaluate(opts: {
  scope: string;
  agent: Agent;
  provider: ProviderAdapter;
  tier: 'cheap' | 'standard' | 'premium' | undefined;
  usage: { input_tokens: number; output_tokens: number };
}): Promise<BudgetState | undefined> {
  const cfg = budgets.get(opts.scope);
  if (!cfg) return undefined;
  if (typeof opts.provider.getUsage !== 'function') {
    recordEstimatedSpend(opts.scope, estimateDispatchCost(opts.agent, opts.provider, opts.tier, opts.usage, cfg.unit));
  }
  return evaluateBudget({ scope: opts.scope, agent: opts.agent, provider: opts.provider });
}
