import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { GitNexusProvider } from './code-intelligence-gitnexus.js';
import { CodebaseMemoryProvider } from './code-intelligence-codebase-memory.js';
import { getAgent } from '../services/registry.js';
import { kbScopeFields } from '../services/knowledge/kb-scope-input.js';
import { isCodeIntelEnabled, readRepoCodeIntelConfig } from '../services/knowledge/repo-config.js';

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
    content: [{ type: 'text', text: `Code intelligence is disabled for this member (method: ${method}).` }],
  };
}

export class NullProvider implements CodeIntelligenceProvider {
  async graph(_params: Record<string, unknown>): Promise<unknown> { return nullResult('graph'); }
  async impact(_params: Record<string, unknown>): Promise<unknown> { return nullResult('impact'); }
  async query(_params: Record<string, unknown>): Promise<unknown> { return nullResult('query'); }
  async context(_params: Record<string, unknown>): Promise<unknown> { return nullResult('context'); }
  async map(_params: Record<string, unknown>): Promise<unknown> { return nullResult('map'); }
  async flow(_params: Record<string, unknown>): Promise<unknown> { return nullResult('flow'); }
  async tests(_params: Record<string, unknown>): Promise<unknown> { return nullResult('tests'); }
}

function repoDisabledResult(method: string): { content: { type: string; text: string }[] } {
  return {
    content: [{ type: 'text', text: `Code intelligence is disabled for this repo (method: ${method}). Set enabled: true in .apra-fleet/code-intel.json to turn it on.` }],
  };
}

// Returned by getProvider() when the target repo has explicitly opted out
// via .apra-fleet/code-intel.json (enabled: false). Distinct from NullProvider
// so the message reflects a repo-level, not member-level, opt-out.
export class RepoDisabledProvider implements CodeIntelligenceProvider {
  async graph(_params: Record<string, unknown>): Promise<unknown> { return repoDisabledResult('graph'); }
  async impact(_params: Record<string, unknown>): Promise<unknown> { return repoDisabledResult('impact'); }
  async query(_params: Record<string, unknown>): Promise<unknown> { return repoDisabledResult('query'); }
  async context(_params: Record<string, unknown>): Promise<unknown> { return repoDisabledResult('context'); }
  async map(_params: Record<string, unknown>): Promise<unknown> { return repoDisabledResult('map'); }
  async flow(_params: Record<string, unknown>): Promise<unknown> { return repoDisabledResult('flow'); }
  async tests(_params: Record<string, unknown>): Promise<unknown> { return repoDisabledResult('tests'); }
}

function optInPromptResult(method: string): { content: { type: string; text: string }[] } {
  return {
    content: [{
      type: 'text',
      text:
        `Code intelligence has not been set up for this repo yet (method: ${method}). ` +
        'Indexing builds a local call-graph/symbol database so code_graph, code_impact, code_query, ' +
        'code_context, code_map, code_flow, and code_tests can answer structural questions without ' +
        'grepping the tree. Nothing has been indexed automatically. ' +
        "Run 'apra-fleet install --code-intel' in the repo to opt in and index it, " +
        "or 'apra-fleet install --no-code-intel' to opt out and stop seeing this prompt.",
    }],
  };
}

// Returned by getProvider() when the target repo has never recorded a
// code-intel choice (no .apra-fleet/code-intel.json) -- distinct from
// RepoDisabledProvider (explicit enabled: false) and from a plain
// "no index" result: this is the first-call opt-in prompt (apra-fleet-le1.2.1),
// shown instead of silently indexing or silently failing.
export class OptInPromptProvider implements CodeIntelligenceProvider {
  async graph(_params: Record<string, unknown>): Promise<unknown> { return optInPromptResult('graph'); }
  async impact(_params: Record<string, unknown>): Promise<unknown> { return optInPromptResult('impact'); }
  async query(_params: Record<string, unknown>): Promise<unknown> { return optInPromptResult('query'); }
  async context(_params: Record<string, unknown>): Promise<unknown> { return optInPromptResult('context'); }
  async map(_params: Record<string, unknown>): Promise<unknown> { return optInPromptResult('map'); }
  async flow(_params: Record<string, unknown>): Promise<unknown> { return optInPromptResult('flow'); }
  async tests(_params: Record<string, unknown>): Promise<unknown> { return optInPromptResult('tests'); }
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
  ...kbScopeFields,
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
// Handler functions -- thin wrappers that resolve the per-member provider and
// delegate to the appropriate method. memberId is optional: when omitted,
// getProvider() falls back to the global config. `repo`, when present on the
// input, is the repo path getProvider() uses for the repo-level opt-out check.
// ---------------------------------------------------------------------------

function repoPathOf(input: Record<string, unknown>): string | undefined {
  return typeof input.repo === 'string' ? input.repo : undefined;
}

export async function handleCodeGraph(input: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId, repoPathOf(input));
  return provider.graph(input);
}

export async function handleCodeImpact(input: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId, repoPathOf(input));
  return provider.impact(input);
}

export async function handleCodeQuery(input: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId, repoPathOf(input));
  return provider.query(input);
}

export async function handleCodeContext(input: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId, repoPathOf(input));
  return provider.context(input);
}

export async function handleCodeMap(input: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId, repoPathOf(input));
  return provider.map(input);
}

export async function handleCodeFlow(input: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId, repoPathOf(input));
  return provider.flow(input);
}

export async function handleCodeTests(input: Record<string, unknown>, memberId?: string): Promise<unknown> {
  const provider = await getProvider(memberId, repoPathOf(input));
  return provider.tests(input);
}

export async function getProvider(memberId?: string, repoPath?: string): Promise<CodeIntelligenceProvider> {
  // Repo-level opt-out takes priority over member/global provider resolution,
  // but it is enforced ONLY for repo-qualified calls (repoPath present).
  //
  // apra-fleet-tm7.21 decision: when repoPath is omitted, this check is
  // skipped -- it does NOT fall back to process.cwd() or to "the" indexed
  // repo. There is no single well-defined "current repo" at this layer: the
  // MCP server process is shared across members/repos, and process.cwd() is
  // exactly the kind of server-process-bound assumption that made kb_harvest
  // repo-blind elsewhere in this epic (apra-fleet-tm7, apra-fleet-3zl) --
  // reintroducing it here for the opt-out check would silently enforce (or
  // fail to enforce) the wrong repo's config whenever the server's cwd
  // differs from the repo a caller means. Concretely: a caller that omits
  // `repo` on a single-repo-style call gets a live provider even if that
  // repo has code-intel.json enabled:false; only repo-qualified calls are
  // covered by the opt-out. Callers that need the opt-out enforced MUST pass
  // `repo`. See tests/code-intelligence.test.ts 'getProvider() repo-level
  // opt-out' for the pinned behavior.
  if (repoPath && !(await isCodeIntelEnabled(repoPath))) {
    return new RepoDisabledProvider();
  }

  // First-call opt-in prompt (apra-fleet-le1.2.1): a repo with no
  // .apra-fleet/code-intel.json has never recorded a code-intel choice at
  // all -- readRepoCodeIntelConfig() returning null is the discriminator
  // between "never asked" and "explicitly enabled" (isCodeIntelEnabled()
  // above collapses both to true and cannot tell them apart on its own).
  // Enforced only for repo-qualified calls, same scoping as the opt-out
  // check above -- see the comment on this function for why repoPath-less
  // calls are not covered.
  if (repoPath && (await readRepoCodeIntelConfig(repoPath)) === null) {
    return new OptInPromptProvider();
  }

  // When a memberId is supplied, check the agent's per-member override first.
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
