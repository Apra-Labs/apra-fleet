import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';
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

// --- Active member context for threading from execute_prompt ---
// When execute_prompt dispatches to a member, it sets this so that
// code-intel tool calls during the same server turn resolve the
// correct per-member provider without exposing memberId in schemas.
let _activeMemberId: string | undefined;

export function setActiveMemberId(memberId: string | undefined): void {
  _activeMemberId = memberId;
}

export function getActiveMemberId(): string | undefined {
  return _activeMemberId;
}

const DISABLED_MESSAGE = 'Code intelligence is disabled for this member.';

function disabledResult(): { content: Array<{ type: 'text'; text: string }>; isError: false } {
  return { content: [{ type: 'text', text: DISABLED_MESSAGE }], isError: false };
}

/**
 * A no-op provider returned when a member's codeIntelProvider is 'none'.
 * Every method returns a structured message instead of throwing.
 */
export class NullProvider implements CodeIntelligenceProvider {
  async graph(_params: Record<string, unknown>): Promise<unknown> {
    return disabledResult();
  }
  async impact(_params: Record<string, unknown>): Promise<unknown> {
    return disabledResult();
  }
  async query(_params: Record<string, unknown>): Promise<unknown> {
    return disabledResult();
  }
  async context(_params: Record<string, unknown>): Promise<unknown> {
    return disabledResult();
  }
  async map(_params: Record<string, unknown>): Promise<unknown> {
    return disabledResult();
  }
  async flow(_params: Record<string, unknown>): Promise<unknown> {
    return disabledResult();
  }
  async tests(_params: Record<string, unknown>): Promise<unknown> {
    return disabledResult();
  }
}

const CONFIG_PATH = join(homedir(), '.apra-fleet', 'data', 'code-intelligence', 'config.json');

export const PROVIDERS: Record<string, CodeIntelligenceProvider> = {
  none: new NullProvider(),
};

/**
 * Resolve the code-intelligence provider.
 *
 * - No args: returns the global (config-file) provider (backward compat).
 * - memberId provided: looks up the agent's codeIntelProvider from the
 *   registry. If set, uses that instead of the global config. If the
 *   member's codeIntelProvider is 'none', returns NullProvider.
 */
export async function getProvider(memberId?: string): Promise<CodeIntelligenceProvider> {
  // When a memberId is supplied, check the agent registry first.
  if (memberId) {
    const agent = getAgent(memberId);
    if (agent?.codeIntelProvider) {
      const memberProvider = PROVIDERS[agent.codeIntelProvider];
      if (memberProvider) {
        return memberProvider;
      }
      // If the provider key is set but not registered, fall through to global.
    }
  }

  // Global config fallback (original behavior).
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

// --- Schemas for MCP tool registration (memberId is internal, not exposed) ---

export const codeGraphSchema = z.object({
  symbol: z.string().describe('Symbol name to look up in the code graph'),
});

export const codeImpactSchema = z.object({
  symbol: z.string().describe('Symbol to analyze for downstream impact'),
});

export const codeQuerySchema = z.object({
  query: z.string().describe('Natural language query about the codebase'),
});

export const codeContextSchema = z.object({
  symbol: z.string().describe('Symbol or file path to get context for'),
});

export const codeMapSchema = z.object({
  path: z.string().optional().describe('Directory path to map (defaults to project root)'),
});

export const codeFlowSchema = z.object({
  symbol: z.string().describe('Symbol to trace data/control flow for'),
});

export const codeTestsSchema = z.object({
  symbol: z.string().describe('Symbol or file to find related tests for'),
});

// --- Handler functions: accept optional memberId for per-member routing ---

export async function handleGraph(params: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.graph(params);
}

export async function handleImpact(params: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.impact(params);
}

export async function handleQuery(params: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.query(params);
}

export async function handleContext(params: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.context(params);
}

export async function handleMap(params: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.map(params);
}

export async function handleFlow(params: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.flow(params);
}

export async function handleTests(params: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId);
  return provider.tests(params);
}
