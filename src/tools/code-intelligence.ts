import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { GitNexusProvider } from './code-intelligence-gitnexus.js';
import { CodebaseMemoryProvider } from './code-intelligence-codebase-memory.js';
import { isCodeIntelEnabled } from '../services/knowledge/repo-config.js';

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

// Structured message returned by getProvider() when the target repo has
// opted out of code intelligence via .apra-fleet/code-intel.json
// (enabled=false). This is a disablement, not an error -- callers should
// serialize it and return it as the tool result rather than throwing.
export interface CodeIntelDisabledResult {
  disabled: true;
  message: string;
}

export function isCodeIntelDisabledResult(value: unknown): value is CodeIntelDisabledResult {
  return !!value && typeof value === 'object' && (value as { disabled?: unknown }).disabled === true;
}

export async function getProvider(repoPath?: string): Promise<CodeIntelligenceProvider | CodeIntelDisabledResult> {
  if (repoPath && !(await isCodeIntelEnabled(repoPath))) {
    return {
      disabled: true,
      message: `Code intelligence is disabled for ${repoPath} (.apra-fleet/code-intel.json enabled=false).`,
    };
  }

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
