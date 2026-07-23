import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR, makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { _resetCache } from '../src/services/user-config.js';
import {
  getCodeIntelProvider,
  NullProvider,
  setMemberContext,
  getMemberContext,
  symbolLookup,
  callChain,
  impactAnalysis,
  codeContext,
  codeQuery,
  codeGraph,
  indexStatus,
} from '../src/tools/code-intelligence.js';

const CONFIG_PATH = path.join(FLEET_DIR, 'config.json');

function writeGlobalConfig(codeIntelProvider: string): void {
  if (!fs.existsSync(FLEET_DIR)) {
    fs.mkdirSync(FLEET_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ codeIntelProvider }), 'utf-8');
}

function removeGlobalConfig(): void {
  try { fs.unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
}

beforeEach(() => {
  backupAndResetRegistry();
  _resetCache();
  removeGlobalConfig();
  setMemberContext(undefined);
});

afterEach(() => {
  restoreRegistry();
  _resetCache();
  removeGlobalConfig();
  setMemberContext(undefined);
});

describe('getCodeIntelProvider', () => {
  it('returns undefined when no memberId and no global config', () => {
    expect(getCodeIntelProvider()).toBeUndefined();
  });

  it('with no args, returns global default when configured', () => {
    writeGlobalConfig('gitnexus');
    const provider = getCodeIntelProvider();
    expect(provider?.name).toBe('gitnexus');
  });

  it('resolves per-member codebase-memory provider', () => {
    const member = addTestAgent({ codeIntelProvider: 'codebase-memory' });
    const provider = getCodeIntelProvider(member.id);
    expect(provider?.name).toBe('codebase-memory');
  });

  it('resolves per-member gitnexus provider', () => {
    const member = addTestAgent({ codeIntelProvider: 'gitnexus' });
    const provider = getCodeIntelProvider(member.id);
    expect(provider?.name).toBe('gitnexus');
  });

  it('resolves per-member none to NullProvider', () => {
    const member = addTestAgent({ codeIntelProvider: 'none' });
    const provider = getCodeIntelProvider(member.id);
    expect(provider).toBeInstanceOf(NullProvider);
    expect(provider?.name).toBe('none');
  });

  it('falls back to global config when member has no preference set', () => {
    const member = addTestAgent({ codeIntelProvider: undefined });
    writeGlobalConfig('gitnexus');
    const provider = getCodeIntelProvider(member.id);
    expect(provider?.name).toBe('gitnexus');
  });

  it('falls back to global config when memberId does not resolve to an agent', () => {
    writeGlobalConfig('codebase-memory');
    const provider = getCodeIntelProvider('nonexistent-member-id');
    expect(provider?.name).toBe('codebase-memory');
  });

  it('per-member setting overrides global config', () => {
    const member = addTestAgent({ codeIntelProvider: 'none' });
    writeGlobalConfig('gitnexus');
    const provider = getCodeIntelProvider(member.id);
    expect(provider).toBeInstanceOf(NullProvider);
  });
});

describe('NullProvider', () => {
  const provider = new NullProvider();

  it('has name "none"', () => {
    expect(provider.name).toBe('none');
  });

  it('symbolLookup returns structured disabled message', async () => {
    const result = await provider.symbolLookup('foo');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('disabled');
    expect(result.message).toContain('symbolLookup');
  });

  it('callChain returns structured disabled message', async () => {
    const result = await provider.callChain('foo');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('disabled');
    expect(result.message).toContain('callChain');
  });

  it('impactAnalysis returns structured disabled message', async () => {
    const result = await provider.impactAnalysis('foo');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('disabled');
    expect(result.message).toContain('impactAnalysis');
  });

  it('codeContext returns structured disabled message', async () => {
    const result = await provider.codeContext('foo.ts');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('disabled');
    expect(result.message).toContain('codeContext');
  });

  it('codeQuery returns structured disabled message', async () => {
    const result = await provider.codeQuery('foo');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('disabled');
    expect(result.message).toContain('codeQuery');
  });

  it('codeGraph returns structured disabled message', async () => {
    const result = await provider.codeGraph('foo');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('disabled');
    expect(result.message).toContain('codeGraph');
  });

  it('indexStatus returns structured disabled message', async () => {
    const result = await provider.indexStatus();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('disabled');
    expect(result.message).toContain('indexStatus');
  });
});

describe('member context', () => {
  it('setMemberContext / getMemberContext round-trip', () => {
    setMemberContext('member-abc');
    expect(getMemberContext()).toBe('member-abc');
    setMemberContext(undefined);
    expect(getMemberContext()).toBeUndefined();
  });
});

describe('tool handlers use member context for routing', () => {
  it('symbolLookup routes to the member-context provider (none -> disabled)', async () => {
    const member = addTestAgent({ codeIntelProvider: 'none' });
    setMemberContext(member.id);

    const raw = await symbolLookup({ query: 'Foo' });
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('disabled');
  });

  it('callChain, impactAnalysis, codeContext, codeQuery, codeGraph, indexStatus all honor member context', async () => {
    const member = addTestAgent({ codeIntelProvider: 'none' });
    setMemberContext(member.id);

    const results = await Promise.all([
      callChain({ symbol: 'Foo' }),
      impactAnalysis({ symbol: 'Foo' }),
      codeContext({ file_path: 'foo.ts' }),
      codeQuery({ query: 'Foo' }),
      codeGraph({ symbol: 'Foo' }),
      indexStatus({}),
    ]);

    for (const raw of results) {
      const parsed = JSON.parse(raw);
      expect(parsed.ok).toBe(false);
      expect(parsed.message).toContain('disabled');
    }
  });

  it('explicit memberId argument overrides the ambient member context', async () => {
    const noneMember = addTestAgent({ codeIntelProvider: 'none' });
    const memoryMember = addTestAgent({ codeIntelProvider: 'codebase-memory' });
    setMemberContext(noneMember.id);

    const raw = await symbolLookup({ query: 'Foo' }, memoryMember.id);
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('codebase-memory provider not yet implemented');
  });

  it('returns a "no provider configured" message when nothing is set', async () => {
    const raw = await symbolLookup({ query: 'Foo' });
    const parsed = JSON.parse(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('No code-intelligence provider configured');
  });
});

function addTestAgent(overrides: Parameters<typeof makeTestAgent>[0] = {}) {
  const agent = makeTestAgent(overrides);
  addAgent(agent);
  return agent;
}
