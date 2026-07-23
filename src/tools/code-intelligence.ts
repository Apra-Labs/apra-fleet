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

function nullResult(method: string): { content: { type: string; text: string }[] } {
  return {
    content: [{
      type: 'text',
      text: `Code intelligence is disabled for this member (provider=none). Skipped: ${method}`,
    }],
  };
}

export class NullProvider implements CodeIntelligenceProvider {
  graph(_params: Record<string, unknown>): Promise<unknown> { return Promise.resolve(nullResult('graph')); }
  impact(_params: Record<string, unknown>): Promise<unknown> { return Promise.resolve(nullResult('impact')); }
  query(_params: Record<string, unknown>): Promise<unknown> { return Promise.resolve(nullResult('query')); }
  context(_params: Record<string, unknown>): Promise<unknown> { return Promise.resolve(nullResult('context')); }
  map(_params: Record<string, unknown>): Promise<unknown> { return Promise.resolve(nullResult('map')); }
  flow(_params: Record<string, unknown>): Promise<unknown> { return Promise.resolve(nullResult('flow')); }
  tests(_params: Record<string, unknown>): Promise<unknown> { return Promise.resolve(nullResult('tests')); }
}

export const PROVIDERS: Record<string, CodeIntelligenceProvider> = {
  'codebase-memory': new CodebaseMemoryProvider(),
  gitnexus: new GitNexusProvider(),
  none: new NullProvider(),
};

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

// --- Handler functions ---
// Each handler accepts an optional memberId to resolve the per-member provider.
// When memberId is undefined (direct MCP call with no member context), getProvider
// falls back to the global config.

export async function handleGraph(input: z.infer<typeof codeGraphSchema>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.graph(input);
}

export async function handleImpact(input: z.infer<typeof codeImpactSchema>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.impact(input);
}

export async function handleQuery(input: z.infer<typeof codeQuerySchema>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.query(input);
}

export async function handleContext(input: z.infer<typeof codeContextSchema>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.context(input);
}

export async function handleMap(input: z.infer<typeof codeMapSchema>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.map(input);
}

export async function handleFlow(input: z.infer<typeof codeFlowSchema>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.flow(input);
}

export async function handleTests(input: z.infer<typeof codeTestsSchema>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.tests(input);
}

export async function getProvider(memberId?: string): Promise<CodeIntelligenceProvider> {
  // When a memberId is provided, check the agent's per-member override first.
  if (memberId) {
    const agent = getAgent(memberId);
    if (agent?.codeIntelProvider) {
      const memberProvider = PROVIDERS[agent.codeIntelProvider];
      if (!memberProvider) {
        throw new Error(
          `Code intelligence provider '${agent.codeIntelProvider}' is not configured. Run 'apra-fleet install' to set up.`,
        );
      }
      return memberProvider;
    }
  }

  // Fall back to the global config.
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
