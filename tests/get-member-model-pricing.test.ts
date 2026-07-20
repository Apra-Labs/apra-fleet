import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getMemberModelPricing } from '../src/tools/get-member-model-pricing.js';
import { addAgent } from '../src/services/registry.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

beforeEach(() => backupAndResetRegistry());
afterEach(() => restoreRegistry());

describe('get_member_model_pricing', () => {
  it('returns null for member_id/member_name both missing', async () => {
    const result = JSON.parse(await getMemberModelPricing({}));
    expect(result.error).toContain('provide either member_id');
  });

  it('errors for an unknown member id', async () => {
    const result = JSON.parse(await getMemberModelPricing({ member_id: 'does-not-exist' }));
    expect(result.error).toBeDefined();
  });

  it('claude member with no override returns provider default opus/sonnet/haiku prices', async () => {
    addAgent(makeTestAgent({ id: 'm-claude', friendlyName: 'claude-member', llmProvider: 'claude' }));
    const result = JSON.parse(await getMemberModelPricing({ member_id: 'm-claude' }));
    expect(result.llm_provider).toBe('claude');
    expect(result.pricing.cheap).toEqual({ model: 'haiku', promptPrice: 0.80, completionPrice: 4.00 });
    expect(result.pricing.standard).toEqual({ model: 'sonnet', promptPrice: 3.00, completionPrice: 15.00 });
    expect(result.pricing.premium).toEqual({ model: 'opus', promptPrice: 15.00, completionPrice: 75.00 });
  });

  it('agy member with no override returns provider default pricing', async () => {
    addAgent(makeTestAgent({ id: 'm-agy', friendlyName: 'agy-member', llmProvider: 'agy' }));
    const result = JSON.parse(await getMemberModelPricing({ member_id: 'm-agy' }));
    expect(result.pricing.cheap.model).toBe('gemini-3.5-flash-lite');
    expect(result.pricing.standard.model).toBe('gemini-3.5-flash');
    expect(result.pricing.premium.model).toBe('claude-sonnet-4.6');
    expect(result.pricing.premium.promptPrice).toBeGreaterThan(0);
  });

  it('codex member with no override returns provider default pricing', async () => {
    addAgent(makeTestAgent({ id: 'm-codex', friendlyName: 'codex-member', llmProvider: 'codex' }));
    const result = JSON.parse(await getMemberModelPricing({ member_id: 'm-codex' }));
    expect(result.pricing.cheap).toEqual({ model: 'gpt-5.4-mini', promptPrice: 0.25, completionPrice: 2.00 });
    expect(result.pricing.premium).toEqual({ model: 'gpt-5.4', promptPrice: 5.00, completionPrice: 15.00 });
  });

  it('copilot member with no override returns provider default pricing', async () => {
    addAgent(makeTestAgent({ id: 'm-copilot', friendlyName: 'copilot-member', llmProvider: 'copilot' }));
    const result = JSON.parse(await getMemberModelPricing({ member_id: 'm-copilot' }));
    expect(result.pricing.cheap.model).toBe('claude-haiku-4-5');
    expect(result.pricing.standard.model).toBe('claude-sonnet-4-5');
    expect(result.pricing.premium.model).toBe('claude-opus-4-5');
  });

  it('gemini member with no override returns provider default pricing', async () => {
    addAgent(makeTestAgent({ id: 'm-gemini', friendlyName: 'gemini-member', llmProvider: 'gemini' }));
    const result = JSON.parse(await getMemberModelPricing({ member_id: 'm-gemini' }));
    expect(result.pricing.cheap.model).toBe('gemini-3.5-flash-lite');
    expect(result.pricing.premium.model).toBe('gemini-3.1-pro-preview');
    expect(result.pricing.premium.promptPrice).toBe(3.50);
  });

  it('opencode member with no override returns free-tier ($0) pricing, not null', async () => {
    addAgent(makeTestAgent({ id: 'm-opencode', friendlyName: 'opencode-member', llmProvider: 'opencode' }));
    const result = JSON.parse(await getMemberModelPricing({ member_id: 'm-opencode' }));
    expect(result.pricing.cheap).toEqual({ model: 'opencode/north-mini-code-free', promptPrice: 0, completionPrice: 0 });
    expect(result.pricing.premium).toEqual({ model: 'opencode/nemotron-3-ultra-free', promptPrice: 0, completionPrice: 0 });
  });

  it('a "none" (compute-only, no LLM) member returns all-null pricing rather than throwing', async () => {
    addAgent(makeTestAgent({ id: 'm-none', friendlyName: 'none-member', llmProvider: 'none' }));
    const result = JSON.parse(await getMemberModelPricing({ member_id: 'm-none' }));
    expect(result.llm_provider).toBe('none');
    expect(result.pricing.cheap).toBeNull();
    expect(result.pricing.standard).toBeNull();
    expect(result.pricing.premium).toBeNull();
  });

  it('a member with a full modelTiers override returns that override model priced when known', async () => {
    addAgent(makeTestAgent({
      id: 'm-override',
      friendlyName: 'override-member',
      llmProvider: 'opencode',
      modelTiers: { cheap: 'opencode/north-mini-code-free', standard: 'opencode/deepseek-v4-flash-free', premium: 'some-unpriced-model' },
    }));
    const result = JSON.parse(await getMemberModelPricing({ member_id: 'm-override' }));
    expect(result.pricing.cheap).toEqual({ model: 'opencode/north-mini-code-free', promptPrice: 0, completionPrice: 0 });
    // Unlisted model in the override -> null, never fabricated.
    expect(result.pricing.premium).toBeNull();
  });

  it('a member with a single-tier modelPremium override (update_member --model-premium) is priced against that override, not the provider default', async () => {
    addAgent(makeTestAgent({ id: 'm-single-override', friendlyName: 'single-override-member', llmProvider: 'claude', modelPremium: 'sonnet' }));
    const result = JSON.parse(await getMemberModelPricing({ member_id: 'm-single-override' }));
    expect(result.pricing.premium).toEqual({ model: 'sonnet', promptPrice: 3.00, completionPrice: 15.00 });
    // Untouched tiers still resolve to the provider default.
    expect(result.pricing.cheap.model).toBe('haiku');
  });

  it('resolves by member_name when member_id is not provided', async () => {
    addAgent(makeTestAgent({ id: 'm-by-name', friendlyName: 'findable-by-name', llmProvider: 'claude' }));
    const result = JSON.parse(await getMemberModelPricing({ member_name: 'findable-by-name' }));
    expect(result.member_id).toBe('m-by-name');
  });
});
