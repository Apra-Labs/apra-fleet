import { z } from 'zod';
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
  context(symbol: string): CodeIntelResult;
  map(scope?: string): CodeIntelResult;
  flow(name: string): CodeIntelResult;
  tests(symbol: string): CodeIntelResult;
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

  context(symbol: string): CodeIntelResult {
    return {
      success: false,
      provider: 'none',
      message: `Code intelligence disabled for this member. Cannot retrieve context for: ${symbol}`,
    };
  }

  map(_scope?: string): CodeIntelResult {
    return {
      success: false,
      provider: 'none',
      message: 'Code intelligence disabled for this member. Cannot generate architecture map.',
    };
  }

  flow(name: string): CodeIntelResult {
    return {
      success: false,
      provider: 'none',
      message: `Code intelligence disabled for this member. Cannot trace flow for: ${name}`,
    };
  }

  tests(symbol: string): CodeIntelResult {
    return {
      success: false,
      provider: 'none',
      message: `Code intelligence disabled for this member. Cannot find tests for: ${symbol}`,
    };
  }
}

function makeStubProvider(providerName: CodeIntelProviderName): CodeIntelProviderAdapter {
  return {
    name: providerName,
    query(symbol: string): CodeIntelResult {
      return { success: true, provider: providerName, data: { symbol } };
    },
    callChain(symbol: string): CodeIntelResult {
      return { success: true, provider: providerName, data: { symbol } };
    },
    impact(symbol: string): CodeIntelResult {
      return { success: true, provider: providerName, data: { symbol } };
    },
    context(symbol: string): CodeIntelResult {
      return { success: true, provider: providerName, data: { symbol } };
    },
    map(scope?: string): CodeIntelResult {
      return { success: true, provider: providerName, data: { scope } };
    },
    flow(name: string): CodeIntelResult {
      return { success: true, provider: providerName, data: { name } };
    },
    tests(symbol: string): CodeIntelResult {
      return { success: true, provider: providerName, data: { symbol } };
    },
  };
}

const PROVIDERS: Record<CodeIntelProviderName, CodeIntelProviderAdapter> = {
  'codebase-memory': makeStubProvider('codebase-memory'),
  gitnexus: makeStubProvider('gitnexus'),
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

// ---------------------------------------------------------------------------
// Active member context -- set by execute_prompt to thread member identity
// into code-intel tool calls without exposing memberId in tool schemas.
// ---------------------------------------------------------------------------
let _activeMemberId: string | undefined;

export function setActiveMember(memberId: string | undefined): void {
  _activeMemberId = memberId;
}

export function getActiveMember(): string | undefined {
  return _activeMemberId;
}

// ---------------------------------------------------------------------------
// Tool schemas -- memberId is intentionally absent; it is internal context.
// ---------------------------------------------------------------------------

export const codeGraphSchema = z.object({
  symbol: z.string().describe('Function, class, or method name to trace in the call graph'),
  repo: z.string().optional().describe('Absolute path to the repository root. Required when multiple repositories are indexed.'),
});

export const codeImpactSchema = z.object({
  target: z.string().describe('Symbol name to analyze, e.g. "handleIPChange"'),
  direction: z.enum(['upstream', 'downstream']).describe('"upstream" to find callers, "downstream" to find callees'),
  file_path: z.string().optional().describe('File path hint for disambiguation'),
  repo: z.string().optional().describe('Absolute path to the repository root. Required when multiple repositories are indexed.'),
});

export const codeQuerySchema = z.object({
  query: z.string().describe('Code search query (symbol, pattern, or concept)'),
  repo: z.string().optional().describe('Absolute path to the repository root. Required when multiple repositories are indexed.'),
});

export const codeContextSchema = z.object({
  name: z.string().describe('Symbol name to retrieve callers, callees, and execution flows for, e.g. "validateUser"'),
  repo: z.string().optional().describe('Absolute path to the repository root. Required when multiple repositories are indexed.'),
});

export const codeMapSchema = z.object({
  repo: z.string().optional().describe('Absolute path to the repository root. Required when multiple repositories are indexed.'),
  top: z.number().int().positive().optional().describe('Maximum number of communities to return (default 20).'),
});

export const codeFlowSchema = z.object({
  from: z.string().optional().describe('Entry-point symbol or label fragment the flow must start from'),
  to: z.string().optional().describe('Terminal symbol or label fragment the flow must end at'),
  name: z.string().optional().describe('Process name or label fragment to match, e.g. "RemoveMember"'),
  repo: z.string().optional().describe('Absolute path to the repository root. Required when multiple repositories are indexed.'),
});

export const codeTestsSchema = z.object({
  symbol: z.string().describe('Function, class, or method name to find transitive test callers for'),
  repo: z.string().optional().describe('Absolute path to the repository root. Required when multiple repositories are indexed.'),
});

// ---------------------------------------------------------------------------
// Tool handler functions -- each accepts optional memberId and forwards it
// to getProvider(). When memberId is omitted, falls back to the active member
// context (set by execute_prompt) or the global default provider.
// ---------------------------------------------------------------------------

function resolveMemberId(memberId?: string): string | undefined {
  return memberId ?? _activeMemberId;
}

export function handleCodeGraph(input: z.infer<typeof codeGraphSchema>, memberId?: string): string {
  const provider = getProvider(resolveMemberId(memberId));
  return JSON.stringify(provider.callChain(input.symbol));
}

export function handleCodeImpact(input: z.infer<typeof codeImpactSchema>, memberId?: string): string {
  const provider = getProvider(resolveMemberId(memberId));
  return JSON.stringify(provider.impact(input.target));
}

export function handleCodeQuery(input: z.infer<typeof codeQuerySchema>, memberId?: string): string {
  const provider = getProvider(resolveMemberId(memberId));
  return JSON.stringify(provider.query(input.query));
}

export function handleCodeContext(input: z.infer<typeof codeContextSchema>, memberId?: string): string {
  const provider = getProvider(resolveMemberId(memberId));
  return JSON.stringify(provider.context(input.name));
}

export function handleCodeMap(input: z.infer<typeof codeMapSchema>, memberId?: string): string {
  const provider = getProvider(resolveMemberId(memberId));
  return JSON.stringify(provider.map(input.repo));
}

export function handleCodeFlow(input: z.infer<typeof codeFlowSchema>, memberId?: string): string {
  const provider = getProvider(resolveMemberId(memberId));
  return JSON.stringify(provider.flow(input.name ?? input.from ?? input.to ?? ''));
}

export function handleCodeTests(input: z.infer<typeof codeTestsSchema>, memberId?: string): string {
  const provider = getProvider(resolveMemberId(memberId));
  return JSON.stringify(provider.tests(input.symbol));
}
