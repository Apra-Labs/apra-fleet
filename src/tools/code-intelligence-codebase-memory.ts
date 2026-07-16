// ---------------------------------------------------------------------------
// Code Intelligence Provider: codebase-memory-mcp
// ---------------------------------------------------------------------------
//
// Tool:    codebase-memory-mcp (https://github.com/DeusData/codebase-memory-mcp)
// License: MIT
//
// Selected over Joern (see code-intelligence-joern.ts, superseded) per the
// evaluation documented there. This file follows the exact same MCP client
// lifecycle pattern as GitNexusProvider (code-intelligence-gitnexus.ts):
// shared singleton client, StdioClientTransport over stdio, onclose/onerror
// resilience that resets state so the next call reconnects, and a pre-flight
// index check that returns a structured result before ever touching the
// child process.
//
// codebase-memory-mcp persists its SQLite graph databases under
// ~/.cache/codebase-memory-mcp/ (README "Persistence" section; overridable
// via CBM_CACHE_DIR, not read here -- the default location is the one the
// fleet's own install path uses). If that directory is missing or empty, no
// project has ever been indexed, so callCodebaseMemory() short-circuits with
// a structured "no index" result instead of spawning the binary.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CodeIntelligenceProvider } from './code-intelligence.js';

let sharedClient: Client | null = null;
let connectionPromise: Promise<Client> | null = null;

// Structured, actionable "offline" result. Same shape as a normal MCP tool
// result (content array of text plus isError) so callers never receive an
// unhandled throw or a silent empty result.
const OFFLINE_MESSAGE =
  'Code intelligence is offline: the codebase-memory-mcp service could not be reached. ' +
  "Start or reinstall it by running 'npm install -g codebase-memory-mcp' " +
  "(or 'codebase-memory-mcp install'), then retry.";

function offlineResult(detail?: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const text = detail ? `${OFFLINE_MESSAGE} (${detail})` : OFFLINE_MESSAGE;
  return { content: [{ type: 'text', text }], isError: true };
}

// codebase-memory-mcp's default database storage directory (README
// "Persistence" section: "SQLite databases stored at
// ~/.cache/codebase-memory-mcp/").
const CACHE_DIR = join(homedir(), '.cache', 'codebase-memory-mcp');

// Pre-flight index check: verify at least one project has been indexed
// before ever spawning the child process. Never throws -- any error reading
// the directory degrades to "no index" rather than blocking the call.
function hasIndex(): boolean {
  try {
    return existsSync(CACHE_DIR) && readdirSync(CACHE_DIR).length > 0;
  } catch {
    return false;
  }
}

// Structured, actionable "missing index" result, returned without ever
// spawning or contacting the child codebase-memory-mcp process when no
// project has been indexed yet.
function missingIndexResult(): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  const text =
    'No code intelligence index found. Say "Index this project" to your agent ' +
    "(or run 'codebase-memory-mcp cli index_repository \\'{\"repo_path\": \"<repo>\"}\\'') " +
    'and retry.';
  return { content: [{ type: 'text', text }], isError: true };
}

// Reset the shared connection state so the next call reconnects from scratch.
function resetConnection(): void {
  sharedClient = null;
  connectionPromise = null;
}

async function getCodebaseMemoryClient(): Promise<Client> {
  if (sharedClient) return sharedClient;
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async () => {
    const transport = new StdioClientTransport({
      command: 'codebase-memory-mcp',
      args: ['mcp'],
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

function isErrorResult(result: unknown): boolean {
  return !!(result && typeof result === 'object' && (result as { isError?: unknown }).isError === true);
}

function textResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

// Single guarded entry point for every provider method. Verifies an index
// exists before ever touching the child process; a thrown connection/dead
// -client error is converted into a structured actionable result and the
// shared state is reset so the next call reconnects.
async function callCodebaseMemory(name: string, params: Record<string, unknown>): Promise<unknown> {
  if (!hasIndex()) {
    return missingIndexResult();
  }

  try {
    const client = await getCodebaseMemoryClient();
    return await client.callTool({ name, arguments: params });
  } catch (err) {
    resetConnection();
    const detail = err instanceof Error ? err.message : String(err);
    return offlineResult(detail);
  }
}

export class CodebaseMemoryProvider implements CodeIntelligenceProvider {
  // graph(): search_graph locates matches for the symbol, trace_path
  // returns its BFS call chain (callers + callees, direction "both").
  async graph(params: Record<string, unknown>): Promise<unknown> {
    const { symbol, repo } = params;
    const projectArg = typeof repo === 'string' ? { project: repo } : {};

    const searchResult = await callCodebaseMemory('search_graph', {
      name_pattern: symbol,
      ...projectArg,
    });
    if (isErrorResult(searchResult)) return searchResult;

    const traceResult = await callCodebaseMemory('trace_path', {
      function_name: symbol,
      direction: 'both',
      ...projectArg,
    });
    if (isErrorResult(traceResult)) return traceResult;

    return textResult({ symbol, matches: searchResult, callChain: traceResult });
  }

  // impact(): detect_changes maps a target symbol plus traversal direction
  // to affected symbols and blast radius.
  async impact(params: Record<string, unknown>): Promise<unknown> {
    const { repo, ...toolParams } = params;
    return callCodebaseMemory('detect_changes', {
      ...toolParams,
      ...(typeof repo === 'string' ? { project: repo } : {}),
    });
  }

  // query(): query_graph runs the read-only openCypher-subset query string.
  async query(params: Record<string, unknown>): Promise<unknown> {
    const { repo, ...toolParams } = params;
    return callCodebaseMemory('query_graph', {
      ...toolParams,
      ...(typeof repo === 'string' ? { project: repo } : {}),
    });
  }

  // Implemented in a follow-up task (context, map, flow, tests).
  async context(params: Record<string, unknown>): Promise<unknown> {
    throw new Error('CodebaseMemoryProvider.context() not implemented');
  }

  async map(params: Record<string, unknown>): Promise<unknown> {
    throw new Error('CodebaseMemoryProvider.map() not implemented');
  }

  async flow(params: Record<string, unknown>): Promise<unknown> {
    throw new Error('CodebaseMemoryProvider.flow() not implemented');
  }

  async tests(params: Record<string, unknown>): Promise<unknown> {
    throw new Error('CodebaseMemoryProvider.tests() not implemented');
  }
}
