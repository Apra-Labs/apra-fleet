import { describe, it, expect, vi, beforeEach } from 'vitest';

// apra-fleet-b4g.13: the code_context handler body in
// src/services/tool-registry.ts is what joins the two layers b4g.8 pinned --
// codeContextSchema (which accepts repo/repo_remote_url) and
// enrichContextWithKb (which forwards them to getKbProviders). That join was
// itself unpinned: deleting `input.repo_remote_url ?? undefined`, or the
// equally old `input.repo ?? undefined`, from the enrichContextWithKb call
// left the whole suite green, because NO test imported tool-registry.ts.
//
// Shape (b) of the two shapes the bead offered was chosen: a minimal fake
// McpServer that records every (name, schemaShape, handler) triple
// registerAllTools() registers, so the real registered closure can be invoked
// directly. Shape (a) (extracting the handler body into an exported function)
// would have moved the wiring OUT of the registry and left the registry line
// itself just as unpinned; shape (b) needs no source change at all and makes
// every other handler body in that file reachable from a test for the first
// time.
//
// Isolation: handleCodeContext, enrichContextWithKb and recordUsage are
// mocked, so no code-intel provider is resolved, no KB is opened, and no
// telemetry is appended to the real ~/.apra-fleet data dir. registerAllTools
// imports its tool modules but nothing else here executes them.

const enrichSpy = vi.hoisted(() => vi.fn());
const handleCodeContextSpy = vi.hoisted(() => vi.fn());
const recordUsageSpy = vi.hoisted(() => vi.fn());

vi.mock('../src/tools/code-intelligence-kb-enrich.js', () => ({
  enrichContextWithKb: enrichSpy,
}));
vi.mock('../src/tools/code-intelligence.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tools/code-intelligence.js')>();
  return { ...actual, handleCodeContext: handleCodeContextSpy };
});
vi.mock('../src/tools/code-intelligence-telemetry.js', () => ({
  recordUsage: recordUsageSpy,
}));

import { registerAllTools } from '../src/services/tool-registry.js';
import { codeContextSchema } from '../src/tools/code-intelligence.js';

type ToolHandler = (input: unknown, extra?: unknown) => Promise<{ content: { type: string; text: string }[] }>;

interface Registered {
  schema: Record<string, unknown>;
  handler: ToolHandler;
}

// Minimal stand-in for McpServer: records what each server.tool() call
// registered. `server.server.sendLoggingMessage` is the only other member
// registerAllTools touches (onboarding notifications).
async function recordRegisteredTools(): Promise<Map<string, Registered>> {
  const registered = new Map<string, Registered>();
  const fakeServer = {
    tool: (name: string, _description: string, schema: Record<string, unknown>, handler: ToolHandler) => {
      registered.set(name, { schema, handler });
    },
    server: { sendLoggingMessage: async () => {} },
  };
  await registerAllTools(fakeServer as never);
  return registered;
}

const PROVIDER_RESULT = { content: [{ type: 'text', text: 'provider result' }] };
const ENRICHED_RESULT = { content: [{ type: 'text', text: 'provider result' }, { type: 'text', text: '[knowledge-bank] ...' }] };

describe('code_context registry wiring (apra-fleet-b4g.13)', () => {
  beforeEach(() => {
    handleCodeContextSpy.mockReset();
    handleCodeContextSpy.mockResolvedValue(PROVIDER_RESULT);
    enrichSpy.mockReset();
    enrichSpy.mockResolvedValue(ENRICHED_RESULT);
    recordUsageSpy.mockReset();
  });

  it('registers code_context with a schema that accepts repo and repo_remote_url', async () => {
    const { schema } = (await recordRegisteredTools()).get('code_context')!;
    expect(Object.keys(schema)).toEqual(expect.arrayContaining(['name', 'repo', 'repo_remote_url']));
  });

  it('forwards BOTH the repo path and the repo remote url from the parsed input into enrichContextWithKb', async () => {
    const { handler } = (await recordRegisteredTools()).get('code_context')!;

    // Parse through the registered schema exactly as the MCP server would,
    // so the handler sees the same shape it sees in production.
    const input = codeContextSchema.parse({
      name: 'validateUser',
      repo: 'C:\\Users\\member\\work\\acme',
      repo_remote_url: 'git@github.com:acme/acme.git',
    });

    await handler(input);

    // Third argument = repo path, fourth = remote url. Deleting EITHER from
    // the enrichContextWithKb call in src/services/tool-registry.ts turns this
    // assertion red (verified by mutation, not inspection).
    expect(enrichSpy).toHaveBeenCalledWith(
      'validateUser',
      PROVIDER_RESULT,
      'C:\\Users\\member\\work\\acme',
      'git@github.com:acme/acme.git',
    );
    expect(handleCodeContextSpy).toHaveBeenCalledWith(input, undefined);
  });

  it('normalises absent repo/repo_remote_url to undefined rather than dropping the arguments', async () => {
    const { handler } = (await recordRegisteredTools()).get('code_context')!;

    await handler(codeContextSchema.parse({ name: 'validateUser' }));

    expect(enrichSpy.mock.calls[0]).toEqual(['validateUser', PROVIDER_RESULT, undefined, undefined]);
  });

  it('returns the ENRICHED result, not the raw provider result', async () => {
    const { handler } = (await recordRegisteredTools()).get('code_context')!;

    const out = await handler(codeContextSchema.parse({ name: 'validateUser' }));

    expect(JSON.parse(out.content[out.content.length - 1].text)).toEqual(ENRICHED_RESULT);
  });
});
