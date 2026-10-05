import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import { GitNexusProvider } from './code-intelligence-gitnexus.js';
import { CodebaseMemoryProvider } from './code-intelligence-codebase-memory.js';
import { getAgent } from '../services/registry.js';
import { resolveSelfSession, validateSelfRepoFolder } from '../services/knowledge/kb-self.js';
import { knownRepoRemoteUrl } from '../services/member-remote-url.js';
import { codeIndexReadiness, codeIntelDisabledError, ensureGitNexusIndexReady, indexedCommitOf } from './code-intelligence-readiness.js';
import { codeReindex, codeStatus, type CodeReindexResult, type CodeStatusResult } from './code-intelligence-reindex.js';

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

// provider 'none': every method throws E-CODE-INTEL-DISABLED -- never an ok
// result that merely says "disabled".
export class NullProvider implements CodeIntelligenceProvider {
  async graph(_params: Record<string, unknown>): Promise<unknown> { throw codeIntelDisabledError('code_graph'); }
  async impact(_params: Record<string, unknown>): Promise<unknown> { throw codeIntelDisabledError('code_impact'); }
  async query(_params: Record<string, unknown>): Promise<unknown> { throw codeIntelDisabledError('code_query'); }
  async context(_params: Record<string, unknown>): Promise<unknown> { throw codeIntelDisabledError('code_context'); }
  async map(_params: Record<string, unknown>): Promise<unknown> { throw codeIntelDisabledError('code_map'); }
  async flow(_params: Record<string, unknown>): Promise<unknown> { throw codeIntelDisabledError('code_flow'); }
  async tests(_params: Record<string, unknown>): Promise<unknown> { throw codeIntelDisabledError('code_tests'); }
}

export const PROVIDERS: Record<string, CodeIntelligenceProvider> = {
  'codebase-memory': new CodebaseMemoryProvider(),
  gitnexus: new GitNexusProvider(),
  none: new NullProvider(),
};

export const codeGraphSchema = z.object({
  symbol: z.string().describe('Function, class, or method name to trace in the call graph'),
});

export const codeImpactSchema = z.object({
  target: z.string().describe('Symbol name to analyze, e.g. "handleIPChange"'),
  direction: z.enum(['upstream', 'downstream']).describe('"upstream" to find callers, "downstream" to find callees'),
  file_path: z.string().optional().describe('File path hint for disambiguation'),
});

export const codeQuerySchema = z.object({
  query: z.string().describe('Code search query (symbol, pattern, or concept)'),
});

export const codeContextSchema = z.object({
  name: z.string().describe('Symbol name to retrieve callers, callees, and execution flows for, e.g. "validateUser"'),
});

export const codeMapSchema = z.object({
  top: z.number().int().positive().optional().describe('Maximum number of communities to return (default 20).'),
});

export const codeFlowSchema = z.object({
  from: z.string().optional().describe('Entry-point symbol or label fragment the flow must start from'),
  to: z.string().optional().describe('Terminal symbol or label fragment the flow must end at'),
  name: z.string().optional().describe('Process name or label fragment to match, e.g. "RemoveMember"'),
});

export const codeTestsSchema = z.object({
  symbol: z.string().describe('Function, class, or method name to find transitive test callers for'),
});

// ---------------------------------------------------------------------------
// code (self) resolution. No code_* tool takes a repo/path argument: the repo
// a call is about is the calling session's own folder, by the same rule as
// kb (self) (src/services/knowledge/kb-self.ts, resolveSelfSession):
//
//   MEMBER session -- the member's registered work folder.
//   FULL session   -- the fleet server's working folder.
//
// A local folder must exist (E-SELF-NO-WORKFOLDER) and be a git repository
// (E-SELF-NOT-A-REPO). Unlike kb tools, no origin remote is required: a code
// index is keyed by folder, not by KB identity. A MEMBER session never falls
// back to the server folder. A remote (non-local) member's work folder lives
// on another host and cannot be validated here; it is passed through as-is,
// so the provider's index pre-flight reports whether this host has an index
// for it.
// ---------------------------------------------------------------------------

export interface CodeSelf {
  /** The resolved repo folder, passed to the provider as params.repo. */
  repo: string;
  /** Member id of a MEMBER session (per-member provider override); undefined for FULL. */
  memberId?: string;
  /** Known origin remote of a remote member's repo (KB enrichment only). */
  remoteUrl?: string;
  /** True when the folder lives on another host (this process cannot run analyze there). */
  remote?: boolean;
}

/** Resolve the calling session's own code-intelligence folder. Throws KbSelfError. */
export function resolveCodeSelf(): CodeSelf {
  const self = resolveSelfSession();
  if (self.agent && self.agent.agentType !== 'local') {
    return { repo: self.folder, memberId: self.memberId, remoteUrl: knownRepoRemoteUrl(self.agent) ?? undefined, remote: true };
  }
  validateSelfRepoFolder(self.folder, self.memberLabel);
  return { repo: self.folder, memberId: self.memberId };
}

/** Appended to every code_* tool description so callers know there is no repo argument. */
export const CODE_SELF_NOTE =
  ' Scope: always the calling session\'s own repo -- a member session uses its registered work folder, any other session the fleet server\'s working folder; there is no repo/path scope argument. Fails with E-SELF-NO-WORKFOLDER or E-SELF-NOT-A-REPO when that folder is missing or is not a git repository, E-CODE-INDEX-NOT-READY when it has no code index yet or the index is still building, and E-CODE-INTEL-DISABLED when code intelligence is off (each with a one-line remediation).';

// ---------------------------------------------------------------------------
// Handler functions -- resolve (self) (unless the caller already resolved it),
// resolve the per-member provider, and delegate with the resolved folder as
// params.repo. Any repo key on the input is overwritten, never trusted.
// ---------------------------------------------------------------------------

async function runCodeTool(
  method: keyof CodeIntelligenceProvider,
  input: Record<string, unknown>,
  self: CodeSelf = resolveCodeSelf(),
): Promise<unknown> {
  const provider = await getProvider(self.memberId);
  // A remote member's folder is on another host: never start a build for it
  // here. Checked before the provider's own (healing) pre-flight runs.
  if (self.remote && provider instanceof GitNexusProvider) ensureGitNexusIndexReady(self.repo, { remote: true });
  const result = await provider[method]({ ...input, repo: self.repo });
  return withIndexedCommit(result, provider instanceof GitNexusProvider ? indexedCommitOf(self.repo) : null);
}

/**
 * Stamp the commit an answer was served from onto a code_* result. Providers
 * with no commit notion (codebase-memory, none) report null rather than omit
 * the field, so every code_* response has the same envelope key.
 */
export function withIndexedCommit(result: unknown, commit: string | null): unknown {
  const indexedCommit = commit && commit.length > 0 ? commit : null;
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), indexedCommit };
  }
  return { result, indexedCommit };
}

export async function handleCodeGraph(input: Record<string, unknown>, self?: CodeSelf): Promise<unknown> {
  return runCodeTool('graph', input, self);
}

export async function handleCodeImpact(input: Record<string, unknown>, self?: CodeSelf): Promise<unknown> {
  return runCodeTool('impact', input, self);
}

export async function handleCodeQuery(input: Record<string, unknown>, self?: CodeSelf): Promise<unknown> {
  return runCodeTool('query', input, self);
}

export async function handleCodeContext(input: Record<string, unknown>, self?: CodeSelf): Promise<unknown> {
  return runCodeTool('context', input, self);
}

export async function handleCodeMap(input: Record<string, unknown>, self?: CodeSelf): Promise<unknown> {
  return runCodeTool('map', input, self);
}

export async function handleCodeFlow(input: Record<string, unknown>, self?: CodeSelf): Promise<unknown> {
  return runCodeTool('flow', input, self);
}

export async function handleCodeTests(input: Record<string, unknown>, self?: CodeSelf): Promise<unknown> {
  return runCodeTool('tests', input, self);
}

/**
 * Typed result for code_reindex / code_status when the member's provider is
 * neither gitnexus nor none: the analyze/readiness machinery is gitnexus-only,
 * so such a provider gets this shape (identical for both tools), never
 * gitnexus readiness. Provider 'none' throws E-CODE-INTEL-DISABLED instead.
 */
export interface ProviderNotSupportedResult {
  outcome: 'not-started';
  reason: 'provider-not-supported';
  provider: string;
  indexedCommit: null;
  detail: string;
}

/**
 * Resolve the member's provider BEFORE any spawn/status IO. Returns null for
 * gitnexus (caller proceeds), throws E-CODE-INTEL-DISABLED for none, else the
 * typed not-supported result.
 */
async function gateOnProvider(tool: 'code_reindex' | 'code_status', self: CodeSelf): Promise<ProviderNotSupportedResult | null> {
  const provider = await getProvider(self.memberId);
  if (provider instanceof GitNexusProvider) return null;
  if (provider instanceof NullProvider) throw codeIntelDisabledError(tool);
  const name = Object.keys(PROVIDERS).find((k) => PROVIDERS[k] === provider) ?? 'unknown';
  return {
    outcome: 'not-started',
    reason: 'provider-not-supported',
    provider: name,
    indexedCommit: null,
    detail: `${tool} only applies to the 'gitnexus' provider; this member uses '${name}', which manages its own index.`,
  };
}

export const codeReindexSchema = z.object({});
export const codeStatusSchema = z.object({});

/**
 * code_reindex: (re)build the calling session's own code index. Starts
 * `npx gitnexus analyze --index-only` detached (never writes AGENTS.md,
 * CLAUDE.md or skills into the repo), captures its output to
 * <data>/code-index/<slug>/analyze.log, and returns after the first tick
 * (lock held + process alive + a log line, or 'Already up to date'). A missing
 * npx/gitnexus is a typed not-started reason, never 'started'.
 */
export async function handleCodeReindex(_input: Record<string, unknown>, self: CodeSelf = resolveCodeSelf()): Promise<CodeReindexResult | ProviderNotSupportedResult> {
  const gated = await gateOnProvider('code_reindex', self);
  if (gated) return gated;
  if (self.remote) {
    return {
      outcome: 'not-started',
      reason: 'remote-member',
      indexedCommit: null,
      detail: `The work folder '${self.repo}' is on another host; run code_reindex from a session on that host.`,
    };
  }
  return codeReindex(self.repo);
}

/** code_status: last analyze run (status.json), live readiness, and the indexed commit. */
export async function handleCodeStatus(_input: Record<string, unknown>, self: CodeSelf = resolveCodeSelf()): Promise<CodeStatusResult | ProviderNotSupportedResult | { remote: true; repo: string; indexedCommit: null; detail: string }> {
  const gated = await gateOnProvider('code_status', self);
  if (gated) return gated;
  if (self.remote) {
    return { remote: true, repo: self.repo, indexedCommit: null, detail: `The work folder '${self.repo}' is on another host; run code_status from a session on that host.` };
  }
  return codeStatus(self.repo, codeIndexReadiness('gitnexus', self.repo));
}

export async function getProvider(memberId?: string): Promise<CodeIntelligenceProvider> {
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
