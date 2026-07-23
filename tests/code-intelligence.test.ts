import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NullProvider, getProvider } from '../src/tools/code-intelligence.js';
import type { Agent } from '../src/types.js';

// Mock the registry module so we can control what getAgent returns
vi.mock('../src/services/registry.js', () => ({
  getAgent: vi.fn(),
}));

import { getAgent } from '../src/services/registry.js';
const mockGetAgent = vi.mocked(getAgent);

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'test-agent',
    friendlyName: 'Test Agent',
    agentType: 'local',
    workFolder: '/tmp/work',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('getProvider() backward compatibility', () => {
  beforeEach(() => {
    mockGetAgent.mockReset();
  });

  it('returns global default provider when no memberId is provided', () => {
    const provider = getProvider();
    expect(provider.name).toBe('codebase-memory');
  });

  it('returns global default provider when memberId is undefined', () => {
    const provider = getProvider(undefined);
    expect(provider.name).toBe('codebase-memory');
  });

  it('returns global default provider when memberId is empty string', () => {
    const provider = getProvider('');
    expect(provider.name).toBe('codebase-memory');
  });
});

describe('getProvider(memberId) with member-specific provider', () => {
  beforeEach(() => {
    mockGetAgent.mockReset();
  });

  it('returns codebase-memory when member has codeIntelProvider=codebase-memory', () => {
    mockGetAgent.mockReturnValue(makeAgent({ codeIntelProvider: 'codebase-memory' }));
    const provider = getProvider('test-agent');
    expect(provider.name).toBe('codebase-memory');
    expect(mockGetAgent).toHaveBeenCalledWith('test-agent');
  });

  it('returns gitnexus when member has codeIntelProvider=gitnexus', () => {
    mockGetAgent.mockReturnValue(makeAgent({ codeIntelProvider: 'gitnexus' }));
    const provider = getProvider('test-agent');
    expect(provider.name).toBe('gitnexus');
  });

  it('returns NullProvider when member has codeIntelProvider=none', () => {
    mockGetAgent.mockReturnValue(makeAgent({ codeIntelProvider: 'none' }));
    const provider = getProvider('test-agent');
    expect(provider.name).toBe('none');
    expect(provider).toBeInstanceOf(NullProvider);
  });

  it('falls back to global default when member has no codeIntelProvider set', () => {
    mockGetAgent.mockReturnValue(makeAgent({}));
    const provider = getProvider('test-agent');
    expect(provider.name).toBe('codebase-memory');
  });

  it('falls back to global default when member is not found', () => {
    mockGetAgent.mockReturnValue(undefined);
    const provider = getProvider('unknown-agent');
    expect(provider.name).toBe('codebase-memory');
  });
});

describe('NullProvider', () => {
  const nullProvider = new NullProvider();

  it('has name "none"', () => {
    expect(nullProvider.name).toBe('none');
  });

  it('query() returns structured disabled message and never throws', () => {
    const result = nullProvider.query('MyClass');
    expect(result.success).toBe(false);
    expect(result.provider).toBe('none');
    expect(result.message).toContain('Code intelligence disabled');
    expect(result.message).toContain('MyClass');
  });

  it('callChain() returns structured disabled message and never throws', () => {
    const result = nullProvider.callChain('someFunction');
    expect(result.success).toBe(false);
    expect(result.provider).toBe('none');
    expect(result.message).toContain('Code intelligence disabled');
    expect(result.message).toContain('someFunction');
  });

  it('impact() returns structured disabled message and never throws', () => {
    const result = nullProvider.impact('aVariable');
    expect(result.success).toBe(false);
    expect(result.provider).toBe('none');
    expect(result.message).toContain('Code intelligence disabled');
    expect(result.message).toContain('aVariable');
  });
});
