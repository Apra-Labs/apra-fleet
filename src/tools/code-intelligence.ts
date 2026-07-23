import { z } from 'zod';
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

// ---------------------------------------------------------------------------
// Member context -- set by execute_prompt so code-intel tool handlers resolve
// the calling member's provider without exposing memberId in MCP schemas.
// ---------------------------------------------------------------------------

let _currentMemberId: string | undefined;

/** Set the active member context (call before dispatching code-intel tools). */
export function setMemberContext(memberId: string | undefined): void {
  _currentMemberId = memberId;
}

/** Get the active member context. */
export function getMemberContext(): string | undefined {
  return _currentMemberId;
}

// ---------------------------------------------------------------------------
// Tool schemas -- memberId is NOT exposed; it flows via member context.
// ---------------------------------------------------------------------------

export const symbolLookupSchema = z.object({
  query: z.string().describe('Symbol name or pattern to look up'),
});

export const callChainSchema = z.object({
  symbol: z.string().describe('Fully-qualified symbol to trace call chain for'),
});

export const impactAnalysisSchema = z.object({
  symbol: z.string().describe('Symbol to analyze downstream impact for'),
});

export const codeContextSchema = z.object({
  file_path: z.string().describe('File path to retrieve context for'),
});

export const codeQuerySchema = z.object({
  query: z.string().describe('Structural query to run against the codebase'),
});

export const codeGraphSchema = z.object({
  symbol: z.string().describe('Symbol to retrieve dependency graph for'),
});

export const indexStatusSchema = z.object({});

// ---------------------------------------------------------------------------
// Tool handler helpers
// ---------------------------------------------------------------------------

function formatResult(result: CodeIntelResult): string {
  if (result.ok) {
    return JSON.stringify({ ok: true, data: result.data, message: result.message });
  }
  return JSON.stringify({ ok: false, message: result.message });
}

function resolveProvider(memberId?: string): CodeIntelAdapter | undefined {
  return getCodeIntelProvider(memberId ?? _currentMemberId);
}

const NO_PROVIDER_MSG = 'No code-intelligence provider configured. Set codeIntelProvider on the member or in config.json.';

// ---------------------------------------------------------------------------
// Tool handler functions -- each accepts optional memberId for internal use
// ---------------------------------------------------------------------------

export async function symbolLookup(input: z.infer<typeof symbolLookupSchema>, memberId?: string): Promise<string> {
  const provider = resolveProvider(memberId);
  if (!provider) return JSON.stringify({ ok: false, message: NO_PROVIDER_MSG });
  return formatResult(await provider.symbolLookup(input.query));
}

export async function callChain(input: z.infer<typeof callChainSchema>, memberId?: string): Promise<string> {
  const provider = resolveProvider(memberId);
  if (!provider) return JSON.stringify({ ok: false, message: NO_PROVIDER_MSG });
  return formatResult(await provider.callChain(input.symbol));
}

export async function impactAnalysis(input: z.infer<typeof impactAnalysisSchema>, memberId?: string): Promise<string> {
  const provider = resolveProvider(memberId);
  if (!provider) return JSON.stringify({ ok: false, message: NO_PROVIDER_MSG });
  return formatResult(await provider.impactAnalysis(input.symbol));
}

export async function codeContext(input: z.infer<typeof codeContextSchema>, memberId?: string): Promise<string> {
  const provider = resolveProvider(memberId);
  if (!provider) return JSON.stringify({ ok: false, message: NO_PROVIDER_MSG });
  return formatResult(await provider.codeContext(input.file_path));
}

export async function codeQuery(input: z.infer<typeof codeQuerySchema>, memberId?: string): Promise<string> {
  const provider = resolveProvider(memberId);
  if (!provider) return JSON.stringify({ ok: false, message: NO_PROVIDER_MSG });
  return formatResult(await provider.codeQuery(input.query));
}

export async function codeGraph(input: z.infer<typeof codeGraphSchema>, memberId?: string): Promise<string> {
  const provider = resolveProvider(memberId);
  if (!provider) return JSON.stringify({ ok: false, message: NO_PROVIDER_MSG });
  return formatResult(await provider.codeGraph(input.symbol));
}

export async function indexStatus(_input: z.infer<typeof indexStatusSchema>, memberId?: string): Promise<string> {
  const provider = resolveProvider(memberId);
  if (!provider) return JSON.stringify({ ok: false, message: NO_PROVIDER_MSG });
  return formatResult(await provider.indexStatus());
}
