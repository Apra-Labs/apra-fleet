import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { GitNexusProvider } from './code-intelligence-gitnexus.js';
import { CodebaseMemoryProvider } from './code-intelligence-codebase-memory.js';
import { getAgent } from '../services/registry.js';

export interface CodeIntelligenceProvider {
  graph(params: Record<string, unknown>): Promise<unknown>;
  impact(params: Record<string, unknown>): Promise<unknown>;
  query(params: Record<string, unknown>): Promise<unknown>;
  context(params: Record<string, unknown>): Promise<unknown>;
  map(params: Record<string, unknown>): Promise<unknown>;
  flow(params: Record<string, unknown>): Promise<unknown>;
  tests(params: Record<string, unknown>): Promise<unknown>;
}

const CONFIG_PATH = join(homedir(), '.apra-fleet', 'data', 'code-intelligence', 'config.json');

export const PROVIDERS: Record<string, CodeIntelligenceProvider> = {
  'codebase-memory': new CodebaseMemoryProvider(),
  gitnexus: new GitNexusProvider(),
};

function nullResponse(method: string): { content: { type: string; text: string }[] } {
  return {
    content: [{ type: 'text', text: `Code intelligence is disabled for this member (method: ${method}).` }],
  };
}

export class NullProvider implements CodeIntelligenceProvider {
  async graph(_params: Record<string, unknown>): Promise<unknown> { return nullResponse('graph'); }
  async impact(_params: Record<string, unknown>): Promise<unknown> { return nullResponse('impact'); }
  async query(_params: Record<string, unknown>): Promise<unknown> { return nullResponse('query'); }
  async context(_params: Record<string, unknown>): Promise<unknown> { return nullResponse('context'); }
  async map(_params: Record<string, unknown>): Promise<unknown> { return nullResponse('map'); }
  async flow(_params: Record<string, unknown>): Promise<unknown> { return nullResponse('flow'); }
  async tests(_params: Record<string, unknown>): Promise<unknown> { return nullResponse('tests'); }
}

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

const nullProvider = new NullProvider();

// ---------------------------------------------------------------------------
// Active-member context store
//
// When the MCP host is operating on behalf of a specific fleet member (e.g.
// code-intel tools invoked during execute_prompt), setActiveCodeIntelMember()
// makes that member's ID available to the tool handlers so they resolve the
// correct per-member provider via getProvider(memberId).  Direct MCP calls
// with no member context leave this undefined -- global fallback applies.
// ---------------------------------------------------------------------------
let _activeMemberId: string | undefined;

export function setActiveCodeIntelMember(memberId: string | undefined): void {
  _activeMemberId = memberId;
}

export function getActiveCodeIntelMember(): string | undefined {
  return _activeMemberId;
}

export async function getProvider(memberId?: string): Promise<CodeIntelligenceProvider> {
  // When a memberId is supplied, check the agent's per-member override first.
  if (memberId) {
    const agent = getAgent(memberId);
    if (agent?.codeIntelProvider) {
      if (agent.codeIntelProvider === 'none') return nullProvider;
      const memberProvider = PROVIDERS[agent.codeIntelProvider];
      if (memberProvider) return memberProvider;
      // Fall through to global config if the stored key has no matching provider.
    }
  }

  // Global provider resolution (backward compatible).
  let providerKey = 'codebase-memory';
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8');
    const config = JSON.parse(raw) as { provider?: string };
    if (config.provider) providerKey = config.provider;
  } catch {
    // Config absent -- default to codebase-memory
  }

  const provider = PROVIDERS[providerKey];
  if (!provider) {
    throw new Error(
      `Code intelligence provider '${providerKey}' is not configured. Run 'apra-fleet install' to set up.`,
    );
  }
  return provider;
}

// ---------------------------------------------------------------------------
// Handler functions -- thin wrappers that resolve the correct per-member
// provider and delegate to it.  memberId is internal (not in tool schemas).
// When memberId is undefined the global fallback applies.
// ---------------------------------------------------------------------------

export async function handleGraph(input: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.graph(input);
}

export async function handleImpact(input: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.impact(input);
}

export async function handleQuery(input: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.query(input);
}

export async function handleContext(input: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.context(input);
}

export async function handleMap(input: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.map(input);
}

export async function handleFlow(input: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.flow(input);
}

export async function handleTests(input: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.tests(input);
}
