import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  NullProvider,
  getProvider,
  setActiveMember,
  getActiveMember,
  handleCodeGraph,
  handleCodeImpact,
  handleCodeQuery,
  handleCodeContext,
  handleCodeMap,
  handleCodeFlow,
  handleCodeTests,
} from '../src/tools/code-intelligence.js';
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

  it('context() returns structured disabled message and never throws', () => {
    const result = nullProvider.context('SomeType');
    expect(result.success).toBe(false);
    expect(result.provider).toBe('none');
    expect(result.message).toContain('Code intelligence disabled');
    expect(result.message).toContain('SomeType');
  });

  it('map() returns structured disabled message and never throws', () => {
    const result = nullProvider.map();
    expect(result.success).toBe(false);
    expect(result.provider).toBe('none');
    expect(result.message).toContain('Code intelligence disabled');
  });

  it('flow() returns structured disabled message and never throws', () => {
    const result = nullProvider.flow('RemoveMember');
    expect(result.success).toBe(false);
    expect(result.provider).toBe('none');
    expect(result.message).toContain('Code intelligence disabled');
    expect(result.message).toContain('RemoveMember');
  });

  it('tests() returns structured disabled message and never throws', () => {
    const result = nullProvider.tests('myFunc');
    expect(result.success).toBe(false);
    expect(result.provider).toBe('none');
    expect(result.message).toContain('Code intelligence disabled');
    expect(result.message).toContain('myFunc');
  });
});

describe('active member context', () => {
  afterEach(() => {
    setActiveMember(undefined);
  });

  it('getActiveMember() returns undefined by default', () => {
    expect(getActiveMember()).toBeUndefined();
  });

  it('setActiveMember() sets and getActiveMember() reads the active member', () => {
    setActiveMember('member-alpha');
    expect(getActiveMember()).toBe('member-alpha');
  });

  it('setActiveMember(undefined) clears the active member', () => {
    setActiveMember('member-alpha');
    setActiveMember(undefined);
    expect(getActiveMember()).toBeUndefined();
  });
});

describe('tool handler functions forward memberId to getProvider()', () => {
  beforeEach(() => {
    mockGetAgent.mockReset();
    setActiveMember(undefined);
  });

  afterEach(() => {
    setActiveMember(undefined);
  });

  it('handleCodeGraph uses explicit memberId over active member', () => {
    mockGetAgent.mockReturnValue(makeAgent({ codeIntelProvider: 'gitnexus' }));
    setActiveMember('other-member');
    const result = JSON.parse(handleCodeGraph({ symbol: 'foo' }, 'test-agent'));
    expect(result.provider).toBe('gitnexus');
    expect(mockGetAgent).toHaveBeenCalledWith('test-agent');
  });

  it('handleCodeGraph falls back to active member when no explicit memberId', () => {
    mockGetAgent.mockReturnValue(makeAgent({ codeIntelProvider: 'gitnexus' }));
    setActiveMember('test-agent');
    const result = JSON.parse(handleCodeGraph({ symbol: 'bar' }));
    expect(result.provider).toBe('gitnexus');
    expect(mockGetAgent).toHaveBeenCalledWith('test-agent');
  });

  it('handleCodeGraph uses global default when no memberId and no active member', () => {
    const result = JSON.parse(handleCodeGraph({ symbol: 'baz' }));
    expect(result.provider).toBe('codebase-memory');
    expect(mockGetAgent).not.toHaveBeenCalled();
  });

  it('handleCodeGraph returns NullProvider disabled message when codeIntelProvider=none', () => {
    mockGetAgent.mockReturnValue(makeAgent({ codeIntelProvider: 'none' }));
    const result = JSON.parse(handleCodeGraph({ symbol: 'foo' }, 'test-agent'));
    expect(result.success).toBe(false);
    expect(result.provider).toBe('none');
    expect(result.message).toContain('Code intelligence disabled');
    expect(result.message).toContain('foo');
  });

  it('handleCodeImpact forwards memberId', () => {
    mockGetAgent.mockReturnValue(makeAgent({ codeIntelProvider: 'none' }));
    const result = JSON.parse(handleCodeImpact({ target: 'sym', direction: 'upstream' as const }, 'test-agent'));
    expect(result.success).toBe(false);
    expect(result.provider).toBe('none');
  });

  it('handleCodeQuery forwards memberId', () => {
    mockGetAgent.mockReturnValue(makeAgent({ codeIntelProvider: 'gitnexus' }));
    const result = JSON.parse(handleCodeQuery({ query: 'search term' }, 'test-agent'));
    expect(result.provider).toBe('gitnexus');
  });

  it('handleCodeContext forwards memberId', () => {
    mockGetAgent.mockReturnValue(makeAgent({ codeIntelProvider: 'gitnexus' }));
    const result = JSON.parse(handleCodeContext({ name: 'MyClass' }, 'test-agent'));
    expect(result.provider).toBe('gitnexus');
  });

  it('handleCodeMap forwards memberId', () => {
    mockGetAgent.mockReturnValue(makeAgent({ codeIntelProvider: 'gitnexus' }));
    const result = JSON.parse(handleCodeMap({}, 'test-agent'));
    expect(result.provider).toBe('gitnexus');
  });

  it('handleCodeFlow forwards memberId', () => {
    mockGetAgent.mockReturnValue(makeAgent({ codeIntelProvider: 'gitnexus' }));
    const result = JSON.parse(handleCodeFlow({ name: 'flow1' }, 'test-agent'));
    expect(result.provider).toBe('gitnexus');
  });

  it('handleCodeTests forwards memberId', () => {
    mockGetAgent.mockReturnValue(makeAgent({ codeIntelProvider: 'gitnexus' }));
    const result = JSON.parse(handleCodeTests({ symbol: 'testFn' }, 'test-agent'));
    expect(result.provider).toBe('gitnexus');
  });
});
