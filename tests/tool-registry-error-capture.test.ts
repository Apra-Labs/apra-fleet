import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// wrapTool (src/services/tool-registry.ts) records every error a tool call
// throws in the error registry, then rethrows it, or returns the isError
// result it always returned, unchanged. The handlers are mocked, so no KB or
// code index is opened.

const behaviour = vi.hoisted(() => ({ kbQuery: null as unknown, codeGraph: null as unknown, kbQueryCalls: 0 }));

vi.mock('../src/tools/kb-query.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tools/kb-query.js')>();
  return {
    ...actual,
    kbQuery: vi.fn(async () => {
      behaviour.kbQueryCalls++;
      if (behaviour.kbQuery) throw behaviour.kbQuery;
      return '{"results":[]}';
    }),
  };
});
vi.mock('../src/tools/code-intelligence.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/tools/code-intelligence.js')>();
  return {
    ...actual,
    handleCodeGraph: vi.fn(async () => { throw behaviour.codeGraph; }),
    resolveCodeSelf: vi.fn(() => ({ repo: '/capture-test/repo' })),
  };
});
vi.mock('../src/tools/code-intelligence-telemetry.js', () => ({ recordUsage: vi.fn() }));

import { registerAllTools } from '../src/services/tool-registry.js';
import { memberToolScope } from '../src/services/tool-scope.js';
import { queryErrorEntries, __resetErrorRegistry } from '../src/services/error-registry.js';
import { KbScopeKeyRemovedError } from '../src/services/knowledge/kb-removed-scope-keys.js';

type ToolHandler = (input: unknown, extra?: unknown) => Promise<unknown>;

async function register(memberId: string): Promise<Map<string, ToolHandler>> {
  const registered = new Map<string, ToolHandler>();
  const fakeServer = {
    tool: (name: string, _d: string, _s: unknown, handler: ToolHandler) => { registered.set(name, handler); },
    server: { sendLoggingMessage: async () => {} },
  };
  await registerAllTools(fakeServer as never, memberToolScope(memberId, false));
  return registered;
}

const CANARY = 'canary-7f3a-do-not-record';

describe('wrapTool error capture', () => {
  beforeEach(() => {
    __resetErrorRegistry();
    behaviour.kbQuery = null;
    behaviour.codeGraph = null;
    behaviour.kbQueryCalls = 0;
  });
  afterEach(() => __resetErrorRegistry());

  it('records a handler error under the session member and rethrows the same object', async () => {
    const tools = await register('m-cap');
    const err = Object.assign(new Error(`E-KB-HTTP-AUTH: token for ${CANARY} expired`), { code: 'E-KB-HTTP-AUTH', reason: 'expired' });
    behaviour.kbQuery = err;
    await expect(tools.get('kb_query')!({ query: CANARY })).rejects.toBe(err);
    const r = queryErrorEntries({ member: 'm-cap', sinceSeconds: 60 });
    expect(r.entries).toEqual([
      { at: expect.any(String), member: 'm-cap', source: 'tool-call', tool: 'kb_query', code: 'E-KB-HTTP-AUTH', reason: 'expired' },
    ]);
    // Neither the arguments nor the message text are recorded.
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  it('records the removed-scope-key refusal thrown before the handler, and rethrows it unchanged', async () => {
    const tools = await register('m-cap');
    let thrown: unknown;
    try {
      await tools.get('kb_query')!({ query: 'q', repo_path: CANARY });
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(KbScopeKeyRemovedError);
    expect((thrown as Error).message).toBe(new KbScopeKeyRemovedError('kb_query', ['repo_path']).message);
    expect(behaviour.kbQueryCalls).toBe(0);
    const r = queryErrorEntries({ member: 'm-cap', sinceSeconds: 60 });
    expect(r.entries.map(e => [e.tool, e.code])).toEqual([['kb_query', 'E-SCOPE-KEY-REMOVED']]);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  it('records an error the wrapper turns into an isError result once, and returns that result as before', async () => {
    const tools = await register('m-cap');
    behaviour.codeGraph = Object.assign(new Error('E-CODE-INDEX-NOT-READY: building'), {
      code: 'E-CODE-INDEX-NOT-READY',
      structuredContent: { code: 'E-CODE-INDEX-NOT-READY', retry_after_ms: 5000 },
    });
    const result = await tools.get('code_graph')!({ symbol: 'x' });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'E-CODE-INDEX-NOT-READY: building' }],
      isError: true,
      structuredContent: { code: 'E-CODE-INDEX-NOT-READY', retry_after_ms: 5000 },
    });
    const r = queryErrorEntries({ member: 'm-cap', sinceSeconds: 60 });
    expect(r.entries.map(e => [e.tool, e.code])).toEqual([['code_graph', 'E-CODE-INDEX-NOT-READY']]);
  });
});
