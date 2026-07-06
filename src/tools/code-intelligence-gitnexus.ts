import { existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CodeIntelligenceProvider } from './code-intelligence.js';
import { freshnessNote } from './code-intelligence-freshness.js';

let sharedClient: Client | null = null;
let connectionPromise: Promise<Client> | null = null;

// Structured, actionable "offline" result. Same shape as a normal MCP tool
// result (content array of text plus isError) so callers never receive an
// unhandled throw or a silent empty result -- mirrors the F3.1 error shape.
const OFFLINE_MESSAGE =
  "Code intelligence is offline: the gitnexus service could not be reached. " +
  "Start or reinstall it by running 'npx gitnexus analyze' in the repo " +
  "(or /pm index), then retry.";

function offlineResult(detail?: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const text = detail ? `${OFFLINE_MESSAGE} (${detail})` : OFFLINE_MESSAGE;
  return { content: [{ type: 'text', text }], isError: true };
}

// Structured, actionable "missing index" result (F3.1). Returned without ever
// spawning or contacting the child gitnexus process when a repo has not been
// indexed yet.
function missingIndexResult(repo: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const text = `No code intelligence index found for ${repo}. Run 'npx gitnexus analyze' in the repo (or /pm index) and retry.`;
  return { content: [{ type: 'text', text }], isError: true };
}

// Reset the shared connection state so the next call reconnects from scratch.
function resetConnection(): void {
  sharedClient = null;
  connectionPromise = null;
}

async function getGitNexusClient(): Promise<Client> {
  if (sharedClient) return sharedClient;
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async () => {
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['-y', 'gitnexus', 'mcp'],
      stderr: 'pipe',
    });

    const client = new Client(
      { name: 'apra-fleet', version: '1.0.0' },
      { capabilities: {} },
    );

    // Transport death reset: if the child process dies (close) or the
    // transport/client errors after a successful connect, drop the cached
    // client and promise so the next call reconnects. Guard on identity so a
    // late handler for a client that was already replaced does not clobber a
    // newer connection.
    const onDeath = (): void => {
      if (sharedClient === client) {
        resetConnection();
      }
    };
    transport.onclose = onDeath;
    transport.onerror = onDeath;
    client.onclose = onDeath;
    client.onerror = onDeath;

    try {
      await client.connect(transport);
    } catch (err) {
      // Failure reset: clear the poisoned promise (sharedClient stays null) so
      // the NEXT call attempts a brand-new connection instead of awaiting a
      // rejected promise forever. Rethrow so the current caller sees failure.
      connectionPromise = null;
      throw err;
    }

    sharedClient = client;
    return client;
  })();

  return connectionPromise;
}

// Freshness metadata (F2.2): when a call carries a `repo` param and the index
// exists, compare meta.json's lastCommit against the repo's current
// `git rev-parse HEAD`. Never throws -- any failure reading meta.json or
// running git degrades to "no note" so a stale/missing index or unavailable
// git never blocks or fails the call.
function computeFreshnessNote(repo: string): string | null {
  try {
    const metaPath = join(repo, '.gitnexus', 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { lastCommit?: string };
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repo, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return freshnessNote(meta.lastCommit, head);
  } catch {
    return null;
  }
}

// Append the freshness note to an MCP tool response as an additional text
// content block, preserving the existing content array shape. If the result
// does not look like a content-array response, return it unchanged rather
// than risk corrupting an unexpected shape.
function appendFreshnessNote(result: unknown, note: string): unknown {
  if (
    result &&
    typeof result === 'object' &&
    'content' in result &&
    Array.isArray((result as { content: unknown }).content)
  ) {
    const { content, ...rest } = result as { content: unknown[] } & Record<string, unknown>;
    return { ...rest, content: [...content, { type: 'text', text: note }] };
  }
  return result;
}

// Single guarded entry point for every provider method. A thrown
// connection/dead-client error is converted into a structured actionable
// result and the shared state is reset so the next call reconnects.
//
// Pre-flight (F3.1): when the call carries a non-empty `repo` param, verify
// the repo has been indexed (`<repo>/.gitnexus/meta.json` exists) BEFORE ever
// touching the child process. Calls without a `repo` param are forwarded
// untouched -- the check only applies when a repo is named.
async function callGitNexus(name: string, params: Record<string, unknown>): Promise<unknown> {
  const repo = params.repo;
  const hasRepo = typeof repo === 'string' && repo.length > 0;
  if (hasRepo) {
    const metaPath = join(repo as string, '.gitnexus', 'meta.json');
    if (!existsSync(metaPath)) {
      return missingIndexResult(repo as string);
    }
  }

  try {
    const client = await getGitNexusClient();
    const result = await client.callTool({ name, arguments: params });
    if (hasRepo) {
      const note = computeFreshnessNote(repo as string);
      if (note) return appendFreshnessNote(result, note);
    }
    return result;
  } catch (err) {
    resetConnection();
    const detail = err instanceof Error ? err.message : String(err);
    return offlineResult(detail);
  }
}

export class GitNexusProvider implements CodeIntelligenceProvider {
  async graph(params: Record<string, unknown>): Promise<unknown> {
    return callGitNexus('call_graph', params);
  }

  async impact(params: Record<string, unknown>): Promise<unknown> {
    return callGitNexus('impact', params);
  }

  async query(params: Record<string, unknown>): Promise<unknown> {
    return callGitNexus('query', params);
  }

  async context(params: Record<string, unknown>): Promise<unknown> {
    return callGitNexus('context', params);
  }
}
