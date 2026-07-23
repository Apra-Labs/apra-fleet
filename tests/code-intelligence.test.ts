import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { getProvider, NullProvider, PROVIDERS } from '../src/tools/code-intelligence.js';

describe('code-intelligence getProvider', () => {
  beforeEach(() => {
    backupAndResetRegistry();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('returns global provider when called with no args', async () => {
    // With no config file and no registered providers except 'none',
    // getProvider() falls through to the global path and looks up
    // 'codebase-memory' which is not in PROVIDERS -- it should throw.
    await expect(getProvider()).rejects.toThrow(/not configured/);
  });

  it('returns NullProvider when member has codeIntelProvider=none', async () => {
    const agent = makeTestLocalAgent({ codeIntelProvider: 'none' });
    addAgent(agent);

    const provider = await getProvider(agent.id);
    expect(provider).toBeInstanceOf(NullProvider);
  });

  it('falls back to global provider when member has no codeIntelProvider set', async () => {
    const agent = makeTestLocalAgent();
    addAgent(agent);

    // No codeIntelProvider on agent, so it falls through to global config.
    // Global config absent + 'codebase-memory' not in PROVIDERS = throws.
    await expect(getProvider(agent.id)).rejects.toThrow(/not configured/);
  });

  it('falls back to global when memberId does not exist in registry', async () => {
    // Non-existent member falls through to global config lookup.
    await expect(getProvider('nonexistent-id')).rejects.toThrow(/not configured/);
  });

  it('returns member-specific provider when codeIntelProvider is set and registered', async () => {
    // Temporarily register a fake provider for testing
    const fakeProvider = new NullProvider();
    PROVIDERS['gitnexus'] = fakeProvider;

    const agent = makeTestLocalAgent({ codeIntelProvider: 'gitnexus' });
    addAgent(agent);

    const provider = await getProvider(agent.id);
    expect(provider).toBe(fakeProvider);

    // Cleanup
    delete PROVIDERS['gitnexus'];
  });

  describe('NullProvider', () => {
    it('returns structured disabled message from all methods', async () => {
      const provider = new NullProvider();
      const methods = ['graph', 'impact', 'query', 'context', 'map', 'flow', 'tests'] as const;

      for (const method of methods) {
        const result = await provider[method]({}) as any;
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');
        expect(result.content[0].text).toContain('disabled');
        expect(result.isError).toBe(false);
      }
    });

    it('never throws', async () => {
      const provider = new NullProvider();
      // Call each method -- none should throw
      await expect(provider.graph({})).resolves.toBeDefined();
      await expect(provider.impact({})).resolves.toBeDefined();
      await expect(provider.query({})).resolves.toBeDefined();
      await expect(provider.context({})).resolves.toBeDefined();
      await expect(provider.map({})).resolves.toBeDefined();
      await expect(provider.flow({})).resolves.toBeDefined();
      await expect(provider.tests({})).resolves.toBeDefined();
    });
  });
});
