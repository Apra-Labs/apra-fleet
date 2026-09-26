import { describe, it, expect, beforeEach } from 'vitest';
import type { Agent } from '../src/types.js';
import type { ProviderAdapter } from '../src/providers/provider.js';
import {
  setBudget,
  evaluateBudget,
  recordAndEvaluate,
  recordEstimatedSpend,
  estimatedSpendFor,
  estimateDispatchCost,
  resolveBudgetScope,
  getBudgetConfig,
  _resetBudgetState,
  DEFAULT_WARN_FRACTION,
} from '../src/services/budget-awareness.js';
import { makeTestAgent } from './test-helpers.js';

// Minimal ProviderAdapter stubs -- the budget-awareness surface only touches
// modelTiers() (via getMemberModelPricing on the dollar path) and the optional
// getUsage() capability. Everything else is irrelevant to these unit tests, so
// we cast a small object rather than construct a full adapter.
function providerWithoutUsage(): ProviderAdapter {
  return {
    modelTiers: () => ({ cheap: 'haiku', standard: 'sonnet', premium: 'opus' }),
  } as unknown as ProviderAdapter;
}

function providerWithUsage(getUsage: NonNullable<ProviderAdapter['getUsage']>): ProviderAdapter {
  return {
    modelTiers: () => ({ cheap: 'haiku', standard: 'sonnet', premium: 'opus' }),
    getUsage,
  } as unknown as ProviderAdapter;
}

const SCOPE = 'member-1';

let agent: Agent;

beforeEach(() => {
  _resetBudgetState();
  agent = makeTestAgent({ id: SCOPE, llmProvider: 'claude' });
});

describe('budget-awareness: no budget configured', () => {
  it('evaluateBudget returns undefined for an unconfigured scope (back-compat no-op)', async () => {
    const state = await evaluateBudget({ scope: SCOPE, agent, provider: providerWithoutUsage() });
    expect(state).toBeUndefined();
  });

  it('recordAndEvaluate returns undefined for an unconfigured scope', async () => {
    const state = await recordAndEvaluate({
      scope: SCOPE, agent, provider: providerWithoutUsage(), tier: 'standard',
      usage: { input_tokens: 100, output_tokens: 100 },
    });
    expect(state).toBeUndefined();
  });

  it('resolveBudgetScope prefers the first candidate that has a budget, else undefined', () => {
    expect(resolveBudgetScope([SCOPE, 'workspace-1'])).toBeUndefined();
    setBudget('workspace-1', { limit: 1000, unit: 'tokens' });
    expect(resolveBudgetScope([SCOPE, 'workspace-1'])).toBe('workspace-1');
    setBudget(SCOPE, { limit: 500, unit: 'tokens' });
    expect(resolveBudgetScope([SCOPE, 'workspace-1'])).toBe(SCOPE);
  });

  it('setBudget with a non-positive limit clears the budget', () => {
    setBudget(SCOPE, { limit: 1000, unit: 'tokens' });
    expect(getBudgetConfig(SCOPE)).toBeDefined();
    setBudget(SCOPE, { limit: 0, unit: 'tokens' });
    expect(getBudgetConfig(SCOPE)).toBeUndefined();
  });
});

describe('budget-awareness: warning band (attach block only at/above the band)', () => {
  it('does NOT warn below the band and the block is not surfaced', async () => {
    setBudget(SCOPE, { limit: 1000, unit: 'tokens' }); // default warn 0.8
    recordEstimatedSpend(SCOPE, 700); // 70% < 80%
    const state = await evaluateBudget({ scope: SCOPE, agent, provider: providerWithoutUsage() });
    expect(state).toBeDefined();
    expect(state!.warned).toBe(false);
    expect(state!.block.fraction).toBeCloseTo(0.7);
  });

  it('warns at/above the default 0.8 band and surfaces the structured block', async () => {
    setBudget(SCOPE, { limit: 1000, unit: 'tokens' });
    recordEstimatedSpend(SCOPE, 800); // exactly 80%
    const state = await evaluateBudget({ scope: SCOPE, agent, provider: providerWithoutUsage() });
    expect(state!.warned).toBe(true);
    expect(state!.block).toEqual({
      spent: 800,
      budget: 1000,
      fraction: 0.8,
      scope: SCOPE,
      unit: 'tokens',
      source: 'estimated',
    });
  });

  it('honors a custom warnFraction', async () => {
    setBudget(SCOPE, { limit: 1000, unit: 'tokens', warnFraction: 0.5 });
    recordEstimatedSpend(SCOPE, 500);
    const state = await evaluateBudget({ scope: SCOPE, agent, provider: providerWithoutUsage() });
    expect(state!.warned).toBe(true);
  });

  it('recordAndEvaluate only surfaces a warned block once the band is crossed', async () => {
    setBudget(SCOPE, { limit: 1000, unit: 'tokens' });
    // below band: warned=false
    let state = await recordAndEvaluate({
      scope: SCOPE, agent, provider: providerWithoutUsage(), tier: 'standard',
      usage: { input_tokens: 300, output_tokens: 300 }, // 600 tokens -> 60%
    });
    expect(state!.warned).toBe(false);
    // crosses band on the next dispatch
    state = await recordAndEvaluate({
      scope: SCOPE, agent, provider: providerWithoutUsage(), tier: 'standard',
      usage: { input_tokens: 200, output_tokens: 200 }, // +400 -> 1000 -> 100%
    });
    expect(state!.warned).toBe(true);
    expect(state!.block.spent).toBe(1000);
  });

  it('DEFAULT_WARN_FRACTION is the documented 0.8 band', () => {
    expect(DEFAULT_WARN_FRACTION).toBe(0.8);
  });
});

describe('budget-awareness: hard threshold (exhausted, no spawn signal)', () => {
  it('is not exhausted when no hardFraction is configured (warn-only)', async () => {
    setBudget(SCOPE, { limit: 1000, unit: 'tokens' });
    recordEstimatedSpend(SCOPE, 5000); // way over, but warn-only
    const state = await evaluateBudget({ scope: SCOPE, agent, provider: providerWithoutUsage() });
    expect(state!.warned).toBe(true);
    expect(state!.exhausted).toBe(false);
  });

  it('is exhausted once spent/limit reaches the configured hardFraction', async () => {
    setBudget(SCOPE, { limit: 1000, unit: 'tokens', hardFraction: 1.0 });
    recordEstimatedSpend(SCOPE, 900); // 90% < 100% hard
    let state = await evaluateBudget({ scope: SCOPE, agent, provider: providerWithoutUsage() });
    expect(state!.exhausted).toBe(false);
    recordEstimatedSpend(SCOPE, 100); // now 100%
    state = await evaluateBudget({ scope: SCOPE, agent, provider: providerWithoutUsage() });
    expect(state!.exhausted).toBe(true);
    // the block carried on a budget_exhausted decision reflects the same figures
    expect(state!.block.fraction).toBeCloseTo(1.0);
    expect(state!.block.source).toBe('estimated');
  });
});

describe('budget-awareness: source is provider getUsage() when present, else estimated', () => {
  it('uses the provider getUsage() figure (source: provider) when the capability is present', async () => {
    setBudget(SCOPE, { limit: 1000, unit: 'tokens' });
    // Estimated spend exists but must be IGNORED in favor of the provider read.
    recordEstimatedSpend(SCOPE, 100);
    const provider = providerWithUsage(async () => ({ spent: 850 }));
    const state = await evaluateBudget({ scope: SCOPE, agent, provider });
    expect(state!.block.source).toBe('provider');
    expect(state!.block.spent).toBe(850);
    expect(state!.warned).toBe(true);
  });

  it('falls back to the estimate (source: estimated) when no getUsage() capability exists', async () => {
    setBudget(SCOPE, { limit: 1000, unit: 'tokens' });
    recordEstimatedSpend(SCOPE, 820);
    const state = await evaluateBudget({ scope: SCOPE, agent, provider: providerWithoutUsage() });
    expect(state!.block.source).toBe('estimated');
    expect(state!.block.spent).toBe(820);
  });

  it('falls back to the estimate when getUsage() returns null at runtime', async () => {
    setBudget(SCOPE, { limit: 1000, unit: 'tokens' });
    recordEstimatedSpend(SCOPE, 810);
    const provider = providerWithUsage(async () => null);
    const state = await evaluateBudget({ scope: SCOPE, agent, provider });
    expect(state!.block.source).toBe('estimated');
    expect(state!.block.spent).toBe(810);
  });

  it('falls back to the estimate when getUsage() throws', async () => {
    setBudget(SCOPE, { limit: 1000, unit: 'tokens' });
    recordEstimatedSpend(SCOPE, 830);
    const provider = providerWithUsage(async () => { throw new Error('endpoint unreachable'); });
    const state = await evaluateBudget({ scope: SCOPE, agent, provider });
    expect(state!.block.source).toBe('estimated');
    expect(state!.block.spent).toBe(830);
  });

  it('recordAndEvaluate does NOT self-meter on the provider path (provider owns its accounting)', async () => {
    setBudget(SCOPE, { limit: 1000, unit: 'tokens' });
    const provider = providerWithUsage(async () => ({ spent: 500 }));
    const state = await recordAndEvaluate({
      scope: SCOPE, agent, provider, tier: 'standard',
      usage: { input_tokens: 400, output_tokens: 400 },
    });
    // provider figure wins; the fleet-side estimate was never incremented
    expect(state!.block.source).toBe('provider');
    expect(state!.block.spent).toBe(500);
    expect(estimatedSpendFor(SCOPE)).toBe(0);
  });

  it('recordAndEvaluate self-meters on the estimated path (no getUsage capability)', async () => {
    setBudget(SCOPE, { limit: 10000, unit: 'tokens' });
    await recordAndEvaluate({
      scope: SCOPE, agent, provider: providerWithoutUsage(), tier: 'standard',
      usage: { input_tokens: 400, output_tokens: 400 },
    });
    expect(estimatedSpendFor(SCOPE)).toBe(800);
  });
});

describe('budget-awareness: estimateDispatchCost pricing', () => {
  it('a token budget counts raw input+output tokens', () => {
    const cost = estimateDispatchCost(
      agent, providerWithoutUsage(), 'standard',
      { input_tokens: 1200, output_tokens: 800 }, 'tokens',
    );
    expect(cost).toBe(2000);
  });

  it('a dollar budget prices tokens via getMemberModelPricing for the resolved tier', () => {
    // claude premium = opus: promptPrice 15/M, completionPrice 75/M.
    const cost = estimateDispatchCost(
      agent, providerWithoutUsage(), 'premium',
      { input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'dollars',
    );
    expect(cost).toBeCloseTo(15 + 75);
  });

  it('an unpriceable tier contributes 0 rather than a fabricated cost', () => {
    const noneAgent = makeTestAgent({ id: 'm-none', llmProvider: 'none' });
    const cost = estimateDispatchCost(
      noneAgent, providerWithoutUsage(), 'standard',
      { input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'dollars',
    );
    expect(cost).toBe(0);
  });
});
