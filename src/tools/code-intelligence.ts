import { getAgent } from '../services/registry.js';

/**
 * Result returned by every CodeIntelProvider method.
 */
export interface CodeIntelResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Interface that all code-intelligence backends must implement.
 */
export interface CodeIntelProvider {
  readonly name: string;
  query(symbol: string, opts?: Record<string, unknown>): CodeIntelResult;
  getReferences(symbol: string): CodeIntelResult;
  getDefinition(symbol: string): CodeIntelResult;
  getCallGraph(symbol: string, depth?: number): CodeIntelResult;
  getImpact(symbol: string): CodeIntelResult;
}

/**
 * A provider that returns structured "disabled" messages for every operation.
 * Never throws -- all methods return { success: false, error: "..." }.
 */
export class NullProvider implements CodeIntelProvider {
  readonly name = 'none';

  private disabled(method: string): CodeIntelResult {
    return {
      success: false,
      error: `code intelligence disabled for this member (${method})`,
    };
  }

  query(_symbol: string, _opts?: Record<string, unknown>): CodeIntelResult {
    return this.disabled('query');
  }

  getReferences(_symbol: string): CodeIntelResult {
    return this.disabled('getReferences');
  }

  getDefinition(_symbol: string): CodeIntelResult {
    return this.disabled('getDefinition');
  }

  getCallGraph(_symbol: string, _depth?: number): CodeIntelResult {
    return this.disabled('getCallGraph');
  }

  getImpact(_symbol: string): CodeIntelResult {
    return this.disabled('getImpact');
  }
}

/**
 * Default provider used when no specific code-intelligence backend is configured.
 * Returns "not configured" results for all methods without throwing.
 */
class DefaultProvider implements CodeIntelProvider {
  readonly name = 'default';

  private notConfigured(method: string): CodeIntelResult {
    return {
      success: false,
      error: `no code intelligence provider configured (${method})`,
    };
  }

  query(_symbol: string, _opts?: Record<string, unknown>): CodeIntelResult {
    return this.notConfigured('query');
  }

  getReferences(_symbol: string): CodeIntelResult {
    return this.notConfigured('getReferences');
  }

  getDefinition(_symbol: string): CodeIntelResult {
    return this.notConfigured('getDefinition');
  }

  getCallGraph(_symbol: string, _depth?: number): CodeIntelResult {
    return this.notConfigured('getCallGraph');
  }

  getImpact(_symbol: string): CodeIntelResult {
    return this.notConfigured('getImpact');
  }
}

const nullProvider = new NullProvider();
const defaultProvider = new DefaultProvider();

/**
 * Map of known code-intelligence provider names to their implementations.
 * 'none' always maps to NullProvider; additional backends can be registered here.
 */
export const PROVIDERS: Record<string, CodeIntelProvider> = {
  none: nullProvider,
  default: defaultProvider,
};

/**
 * Resolve a code-intelligence provider.
 *
 * - No args: returns the global default provider (backward compatible).
 * - With memberId: looks up the agent's codeIntelProvider in the registry.
 *   - If the agent has codeIntelProvider set, uses that provider from PROVIDERS.
 *   - If codeIntelProvider is 'none', returns NullProvider.
 *   - If the agent has no codeIntelProvider, falls back to the global default.
 *   - If the agent is not found, returns the global default.
 */
export function getProvider(memberId?: string): CodeIntelProvider {
  if (!memberId) {
    return defaultProvider;
  }

  const agent = getAgent(memberId);
  if (!agent || !agent.codeIntelProvider) {
    return defaultProvider;
  }

  const providerName = agent.codeIntelProvider;
  const provider = PROVIDERS[providerName];
  if (!provider) {
    return defaultProvider;
  }

  return provider;
}
