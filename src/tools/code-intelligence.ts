import { getAgent } from '../services/registry.js';
import { getGlobalCodeIntelProvider } from '../services/user-config.js';
import type { CodeIntelProvider } from '../types.js';

/**
 * Structured result returned by every CodeIntelAdapter method.
 */
export interface CodeIntelResult {
  ok: boolean;
  data?: unknown;
  message: string;
}

/**
 * Adapter interface for code-intelligence backends.
 * Each method corresponds to a code-intelligence tool exposed via MCP.
 */
export interface CodeIntelAdapter {
  readonly name: string;
  symbolLookup(query: string): Promise<CodeIntelResult>;
  callChain(symbol: string): Promise<CodeIntelResult>;
  impactAnalysis(symbol: string): Promise<CodeIntelResult>;
  codeContext(filePath: string): Promise<CodeIntelResult>;
  codeQuery(query: string): Promise<CodeIntelResult>;
  codeGraph(symbol: string): Promise<CodeIntelResult>;
  indexStatus(): Promise<CodeIntelResult>;
}

/**
 * NullProvider returns structured disabled-messages for every operation.
 * Used when a member has codeIntelProvider='none'.
 */
export class NullProvider implements CodeIntelAdapter {
  readonly name = 'none';

  private disabled(operation: string): Promise<CodeIntelResult> {
    return Promise.resolve({
      ok: false,
      message: `code intelligence disabled for this member (operation: ${operation})`,
    });
  }

  symbolLookup(_query: string): Promise<CodeIntelResult> {
    return this.disabled('symbolLookup');
  }
  callChain(_symbol: string): Promise<CodeIntelResult> {
    return this.disabled('callChain');
  }
  impactAnalysis(_symbol: string): Promise<CodeIntelResult> {
    return this.disabled('impactAnalysis');
  }
  codeContext(_filePath: string): Promise<CodeIntelResult> {
    return this.disabled('codeContext');
  }
  codeQuery(_query: string): Promise<CodeIntelResult> {
    return this.disabled('codeQuery');
  }
  codeGraph(_symbol: string): Promise<CodeIntelResult> {
    return this.disabled('codeGraph');
  }
  indexStatus(): Promise<CodeIntelResult> {
    return this.disabled('indexStatus');
  }
}

/**
 * Placeholder adapter for the codebase-memory backend.
 * Actual integration will be wired in a follow-up task.
 */
class CodebaseMemoryProvider implements CodeIntelAdapter {
  readonly name = 'codebase-memory';

  private stub(operation: string): Promise<CodeIntelResult> {
    return Promise.resolve({
      ok: false,
      message: `codebase-memory provider not yet implemented (operation: ${operation})`,
    });
  }

  symbolLookup(query: string): Promise<CodeIntelResult> { return this.stub('symbolLookup'); }
  callChain(symbol: string): Promise<CodeIntelResult> { return this.stub('callChain'); }
  impactAnalysis(symbol: string): Promise<CodeIntelResult> { return this.stub('impactAnalysis'); }
  codeContext(filePath: string): Promise<CodeIntelResult> { return this.stub('codeContext'); }
  codeQuery(query: string): Promise<CodeIntelResult> { return this.stub('codeQuery'); }
  codeGraph(symbol: string): Promise<CodeIntelResult> { return this.stub('codeGraph'); }
  indexStatus(): Promise<CodeIntelResult> { return this.stub('indexStatus'); }
}

/**
 * Placeholder adapter for the gitnexus backend.
 * Actual integration will be wired in a follow-up task.
 */
class GitNexusProvider implements CodeIntelAdapter {
  readonly name = 'gitnexus';

  private stub(operation: string): Promise<CodeIntelResult> {
    return Promise.resolve({
      ok: false,
      message: `gitnexus provider not yet implemented (operation: ${operation})`,
    });
  }

  symbolLookup(query: string): Promise<CodeIntelResult> { return this.stub('symbolLookup'); }
  callChain(symbol: string): Promise<CodeIntelResult> { return this.stub('callChain'); }
  impactAnalysis(symbol: string): Promise<CodeIntelResult> { return this.stub('impactAnalysis'); }
  codeContext(filePath: string): Promise<CodeIntelResult> { return this.stub('codeContext'); }
  codeQuery(query: string): Promise<CodeIntelResult> { return this.stub('codeQuery'); }
  codeGraph(symbol: string): Promise<CodeIntelResult> { return this.stub('codeGraph'); }
  indexStatus(): Promise<CodeIntelResult> { return this.stub('indexStatus'); }
}

const PROVIDERS: Record<CodeIntelProvider, CodeIntelAdapter> = {
  'none': new NullProvider(),
  'codebase-memory': new CodebaseMemoryProvider(),
  'gitnexus': new GitNexusProvider(),
};

/**
 * Resolve the code-intelligence provider for a given member.
 *
 * Resolution order:
 * 1. If memberId is provided, look up the agent's codeIntelProvider setting.
 *    - If set, use it (returns NullProvider for 'none').
 * 2. Fall back to the global codeIntelProvider from config.json.
 * 3. If neither is set, return undefined (no code-intel configured).
 */
export function getCodeIntelProvider(memberId?: string): CodeIntelAdapter | undefined {
  // Per-member resolution
  if (memberId) {
    const agent = getAgent(memberId);
    if (agent?.codeIntelProvider) {
      return PROVIDERS[agent.codeIntelProvider];
    }
  }

  // Global fallback
  const globalProvider = getGlobalCodeIntelProvider();
  if (globalProvider) {
    return PROVIDERS[globalProvider];
  }

  return undefined;
}
