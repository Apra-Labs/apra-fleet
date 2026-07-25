import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getProvider, NullProvider, PROVIDERS,
  codeQuery, codeReferences, codeDefinition, codeCallGraph, codeImpact,
} from '../src/tools/code-intelligence.js';
import type { CodeIntelProvider, CodeIntelResult } from '../src/tools/code-intelligence.js';

// Mock the registry module
vi.mock('../src/services/registry.js', () => ({
  getAgent: vi.fn(),
}));

import { getAgent } from '../src/services/registry.js';
const mockGetAgent = vi.mocked(getAgent);

describe('code-intelligence', () => {
  beforeEach(() => {
    mockGetAgent.mockReset();
  });

  describe('getProvider() with no args', () => {
    it('returns the global default provider', () => {
      const provider = getProvider();
      expect(provider.name).toBe('default');
    });

    it('returns the same provider on repeated calls (backward compat)', () => {
      const a = getProvider();
      const b = getProvider();
      expect(a).toBe(b);
    });
  });

  describe('getProvider(memberId)', () => {
    it('returns member-specific provider when codeIntelProvider is set', () => {
      mockGetAgent.mockReturnValue({
        id: 'agent-1',
        friendlyName: 'Test Agent',
        agentType: 'local',
        workFolder: '/tmp/work',
        createdAt: '2026-01-01',
        codeIntelProvider: 'none',
      });

      const provider = getProvider('agent-1');
      expect(provider.name).toBe('none');
      expect(provider).toBeInstanceOf(NullProvider);
    });

    it('falls back to default when agent has no codeIntelProvider', () => {
      mockGetAgent.mockReturnValue({
        id: 'agent-2',
        friendlyName: 'Test Agent 2',
        agentType: 'local',
        workFolder: '/tmp/work',
        createdAt: '2026-01-01',
      });

      const provider = getProvider('agent-2');
      expect(provider.name).toBe('default');
    });

    it('falls back to default when agent is not found', () => {
      mockGetAgent.mockReturnValue(undefined);

      const provider = getProvider('nonexistent');
      expect(provider.name).toBe('default');
    });

    it('falls back to default for unknown provider name', () => {
      mockGetAgent.mockReturnValue({
        id: 'agent-3',
        friendlyName: 'Test Agent 3',
        agentType: 'local',
        workFolder: '/tmp/work',
        createdAt: '2026-01-01',
        codeIntelProvider: 'unknown-provider',
      });

      const provider = getProvider('agent-3');
      expect(provider.name).toBe('default');
    });
  });

  describe('NullProvider', () => {
    let nullProvider: NullProvider;

    beforeEach(() => {
      nullProvider = new NullProvider();
    });

    it('has name "none"', () => {
      expect(nullProvider.name).toBe('none');
    });

    it('query() returns structured error, never throws', () => {
      const result = nullProvider.query('someSymbol');
      expect(result.success).toBe(false);
      expect(result.error).toContain('code intelligence disabled');
      expect(result.error).toContain('query');
    });

    it('getReferences() returns structured error, never throws', () => {
      const result = nullProvider.getReferences('someSymbol');
      expect(result.success).toBe(false);
      expect(result.error).toContain('code intelligence disabled');
      expect(result.error).toContain('getReferences');
    });

    it('getDefinition() returns structured error, never throws', () => {
      const result = nullProvider.getDefinition('someSymbol');
      expect(result.success).toBe(false);
      expect(result.error).toContain('code intelligence disabled');
      expect(result.error).toContain('getDefinition');
    });

    it('getCallGraph() returns structured error, never throws', () => {
      const result = nullProvider.getCallGraph('someSymbol', 3);
      expect(result.success).toBe(false);
      expect(result.error).toContain('code intelligence disabled');
      expect(result.error).toContain('getCallGraph');
    });

    it('getImpact() returns structured error, never throws', () => {
      const result = nullProvider.getImpact('someSymbol');
      expect(result.success).toBe(false);
      expect(result.error).toContain('code intelligence disabled');
      expect(result.error).toContain('getImpact');
    });
  });

  describe('PROVIDERS map', () => {
    it('contains "none" mapping to NullProvider', () => {
      expect(PROVIDERS['none']).toBeInstanceOf(NullProvider);
    });

    it('contains "default" mapping', () => {
      expect(PROVIDERS['default']).toBeDefined();
      expect(PROVIDERS['default'].name).toBe('default');
    });
  });

  describe('tool handler functions', () => {
    describe('without memberId (global fallback)', () => {
      it('codeQuery uses default provider', async () => {
        const result = JSON.parse(await codeQuery({ symbol: 'foo' }));
        expect(result.success).toBe(false);
        expect(result.error).toContain('no code intelligence provider configured');
      });

      it('codeReferences uses default provider', async () => {
        const result = JSON.parse(await codeReferences({ symbol: 'foo' }));
        expect(result.success).toBe(false);
        expect(result.error).toContain('no code intelligence provider configured');
      });

      it('codeDefinition uses default provider', async () => {
        const result = JSON.parse(await codeDefinition({ symbol: 'foo' }));
        expect(result.success).toBe(false);
        expect(result.error).toContain('no code intelligence provider configured');
      });

      it('codeCallGraph uses default provider', async () => {
        const result = JSON.parse(await codeCallGraph({ symbol: 'foo' }));
        expect(result.success).toBe(false);
        expect(result.error).toContain('no code intelligence provider configured');
      });

      it('codeImpact uses default provider', async () => {
        const result = JSON.parse(await codeImpact({ symbol: 'foo' }));
        expect(result.success).toBe(false);
        expect(result.error).toContain('no code intelligence provider configured');
      });
    });

    describe('with memberId (per-member provider)', () => {
      it('codeQuery resolves member-specific provider', async () => {
        mockGetAgent.mockReturnValue({
          id: 'agent-ci',
          friendlyName: 'CI Agent',
          agentType: 'local',
          workFolder: '/tmp/work',
          createdAt: '2026-01-01',
          codeIntelProvider: 'none',
        });

        const result = JSON.parse(await codeQuery({ symbol: 'bar' }, 'agent-ci'));
        expect(result.success).toBe(false);
        expect(result.error).toContain('code intelligence disabled');
        expect(mockGetAgent).toHaveBeenCalledWith('agent-ci');
      });

      it('codeReferences resolves member-specific provider', async () => {
        mockGetAgent.mockReturnValue({
          id: 'agent-ci',
          friendlyName: 'CI Agent',
          agentType: 'local',
          workFolder: '/tmp/work',
          createdAt: '2026-01-01',
          codeIntelProvider: 'none',
        });

        const result = JSON.parse(await codeReferences({ symbol: 'bar' }, 'agent-ci'));
        expect(result.success).toBe(false);
        expect(result.error).toContain('code intelligence disabled');
      });

      it('codeCallGraph forwards depth and resolves member provider', async () => {
        mockGetAgent.mockReturnValue({
          id: 'agent-ci',
          friendlyName: 'CI Agent',
          agentType: 'local',
          workFolder: '/tmp/work',
          createdAt: '2026-01-01',
          codeIntelProvider: 'none',
        });

        const result = JSON.parse(await codeCallGraph({ symbol: 'baz', depth: 5 }, 'agent-ci'));
        expect(result.success).toBe(false);
        expect(result.error).toContain('code intelligence disabled');
        expect(result.error).toContain('getCallGraph');
      });

      it('codeImpact resolves member-specific provider', async () => {
        mockGetAgent.mockReturnValue({
          id: 'agent-ci',
          friendlyName: 'CI Agent',
          agentType: 'local',
          workFolder: '/tmp/work',
          createdAt: '2026-01-01',
          codeIntelProvider: 'none',
        });

        const result = JSON.parse(await codeImpact({ symbol: 'qux' }, 'agent-ci'));
        expect(result.success).toBe(false);
        expect(result.error).toContain('code intelligence disabled');
      });
    });

    describe('with memberId falling back to default', () => {
      it('falls back when agent has no codeIntelProvider', async () => {
        mockGetAgent.mockReturnValue({
          id: 'agent-noconfig',
          friendlyName: 'No Config Agent',
          agentType: 'local',
          workFolder: '/tmp/work',
          createdAt: '2026-01-01',
        });

        const result = JSON.parse(await codeQuery({ symbol: 'test' }, 'agent-noconfig'));
        expect(result.success).toBe(false);
        expect(result.error).toContain('no code intelligence provider configured');
      });
    });
  });
});
