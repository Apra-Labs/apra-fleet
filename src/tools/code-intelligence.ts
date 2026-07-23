import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
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
