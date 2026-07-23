import type { Agent } from '../types.js';
import { getAgent } from '../services/registry.js';

export type CodeIntelProviderName = 'codebase-memory' | 'gitnexus' | 'none';

export interface CodeIntelResult {
  success: boolean;
  provider: string;
  data?: unknown;
  message?: string;
}

export interface CodeIntelProviderAdapter {
  readonly name: CodeIntelProviderName;
  query(symbol: string): CodeIntelResult;
  callChain(symbol: string): CodeIntelResult;
  impact(symbol: string): CodeIntelResult;
}

/**
 * A provider that returns structured "disabled" messages for members
 * that have code intelligence turned off. Never throws.
 */
export class NullProvider implements CodeIntelProviderAdapter {
  readonly name: CodeIntelProviderName = 'none';

  query(symbol: string): CodeIntelResult {
    return {
      success: false,
      provider: 'none',
      message: `Code intelligence disabled for this member. Cannot query symbol: ${symbol}`,
    };
  }

  callChain(symbol: string): CodeIntelResult {
    return {
      success: false,
      provider: 'none',
      message: `Code intelligence disabled for this member. Cannot trace call chain for: ${symbol}`,
    };
  }

  impact(symbol: string): CodeIntelResult {
    return {
      success: false,
      provider: 'none',
      message: `Code intelligence disabled for this member. Cannot analyze impact for: ${symbol}`,
    };
  }
}

const PROVIDERS: Record<CodeIntelProviderName, CodeIntelProviderAdapter> = {
  'codebase-memory': {
    name: 'codebase-memory',
    query(symbol: string): CodeIntelResult {
      return { success: true, provider: 'codebase-memory', data: { symbol } };
    },
    callChain(symbol: string): CodeIntelResult {
      return { success: true, provider: 'codebase-memory', data: { symbol } };
    },
    impact(symbol: string): CodeIntelResult {
      return { success: true, provider: 'codebase-memory', data: { symbol } };
    },
  },
  gitnexus: {
    name: 'gitnexus',
    query(symbol: string): CodeIntelResult {
      return { success: true, provider: 'gitnexus', data: { symbol } };
    },
    callChain(symbol: string): CodeIntelResult {
      return { success: true, provider: 'gitnexus', data: { symbol } };
    },
    impact(symbol: string): CodeIntelResult {
      return { success: true, provider: 'gitnexus', data: { symbol } };
    },
  },
  none: new NullProvider(),
};

/**
 * Resolve the code-intelligence provider for a fleet member.
 *
 * - No memberId: returns the global default provider (codebase-memory).
 * - memberId with codeIntelProvider set: returns the member-specific provider.
 * - memberId with codeIntelProvider='none': returns NullProvider.
 * - memberId without codeIntelProvider or unknown member: falls back to global default.
 */
export function getProvider(memberId?: string): CodeIntelProviderAdapter {
  const defaultProvider = PROVIDERS['codebase-memory'];

  if (!memberId) {
    return defaultProvider;
  }

  const agent: Agent | undefined = getAgent(memberId);
  if (!agent || !agent.codeIntelProvider) {
    return defaultProvider;
  }

  const provider = PROVIDERS[agent.codeIntelProvider];
  if (!provider) {
    return defaultProvider;
  }

  return provider;
}
