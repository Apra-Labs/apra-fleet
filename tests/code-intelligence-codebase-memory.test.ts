import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock references so they are available inside vi.mock factories, which
// are hoisted to the top of the file before any import statements.
// ---------------------------------------------------------------------------
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReaddirSync = vi.hoisted(() => vi.fn());
const mockCallTool = vi.hoisted(() => vi.fn());
const mockConnect = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

// CodebaseMemoryProvider's pre-flight index check (hasIndex()) reads
// ~/.cache/codebase-memory-mcp via fs.existsSync/readdirSync. Mocking the
// whole 'fs' module lets each test control whether an index is "present"
// without touching the real filesystem (the module imports only these two
// functions from 'fs').
vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readdirSync: mockReaddirSync,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  // Must use a class or regular function (not arrow) so `new` works correctly.
  class MockClient {
    connect = mockConnect;
    callTool = mockCallTool;
  }
  return { Client: vi.fn().mockImplementation(MockClient) };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  class MockTransport {}
  return { StdioClientTransport: vi.fn().mockImplementation(MockTransport) };
});

// ---------------------------------------------------------------------------
// Static import (resolved after mocks are hoisted)
// ---------------------------------------------------------------------------
import { CodebaseMemoryProvider } from '../src/tools/code-intelligence-codebase-memory.js';

// Configure the mocked fs so hasIndex() reports an index is present/absent.
function setIndexPresent(): void {
  mockExistsSync.mockReturnValue(true);
  mockReaddirSync.mockReturnValue(['some-project.sqlite']);
}

function setIndexMissing(): void {
  mockExistsSync.mockReturnValue(false);
  mockReaddirSync.mockReturnValue([]);
}

// ---------------------------------------------------------------------------
// CodebaseMemoryProvider method delegation
//
// The provider module holds a module-level sharedClient singleton. Because
// the MCP Client constructor is mocked above, the first call to any provider
// method sets sharedClient to the mock instance; subsequent calls reuse it.
// mockCallTool is shared across tests; each test configures its own return
// value(s) via mockResolvedValueOnce so tests do not interfere with each
// other.
// ---------------------------------------------------------------------------
describe('CodebaseMemoryProvider method delegation', () => {
  let provider: CodebaseMemoryProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    setIndexPresent();
    provider = new CodebaseMemoryProvider();
  });

  it('graph() calls search_graph then trace_path with correct params and merges the results', async () => {
    const searchResult = { content: [{ type: 'text', text: JSON.stringify([{ name: 'foo' }]) }] };
    const traceResult = { content: [{ type: 'text', text: JSON.stringify({ chain: ['a', 'b'] }) }] };
    mockCallTool.mockResolvedValueOnce(searchResult);
    mockCallTool.mockResolvedValueOnce(traceResult);

    const result = (await provider.graph({ symbol: 'foo', repo: '/repo' })) as { content: { text: string }[] };
    const parsed = JSON.parse(result.content[0].text);

    expect(mockCallTool).toHaveBeenNthCalledWith(1, {
      name: 'search_graph',
      arguments: { name_pattern: 'foo', project: '/repo' },
    });
    expect(mockCallTool).toHaveBeenNthCalledWith(2, {
      name: 'trace_path',
      arguments: { function_name: 'foo', direction: 'both', project: '/repo' },
    });
    expect(parsed).toEqual({ symbol: 'foo', matches: searchResult, callChain: traceResult });
  });

  it('graph() omits the project arg when repo is not provided', async () => {
    mockCallTool.mockResolvedValueOnce({ content: [] });
    mockCallTool.mockResolvedValueOnce({ content: [] });

    await provider.graph({ symbol: 'foo' });

    expect(mockCallTool).toHaveBeenNthCalledWith(1, { name: 'search_graph', arguments: { name_pattern: 'foo' } });
    expect(mockCallTool).toHaveBeenNthCalledWith(2, {
      name: 'trace_path',
      arguments: { function_name: 'foo', direction: 'both' },
    });
  });

  it('graph() returns the search_graph error unchanged and skips trace_path', async () => {
    const errorResult = { isError: true, content: [{ type: 'text', text: 'boom' }] };
    mockCallTool.mockResolvedValueOnce(errorResult);

    const result = await provider.graph({ symbol: 'foo' });

    expect(result).toEqual(errorResult);
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });

  it('impact() calls detect_changes with correct params and returns the response unchanged', async () => {
    const expected = { content: [{ type: 'text', text: 'impact result' }] };
    mockCallTool.mockResolvedValueOnce(expected);

    const result = await provider.impact({ target: 'foo', direction: 'upstream', repo: '/repo' });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'detect_changes',
      arguments: { target: 'foo', direction: 'upstream', project: '/repo' },
    });
    expect(result).toBe(expected);
  });

  it('query() calls query_graph with correct params and returns the response unchanged', async () => {
    const expected = { content: [{ type: 'text', text: 'query result' }] };
    mockCallTool.mockResolvedValueOnce(expected);

    const result = await provider.query({ query: 'MATCH (n) RETURN n', repo: '/repo' });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'query_graph',
      arguments: { query: 'MATCH (n) RETURN n', project: '/repo' },
    });
    expect(result).toBe(expected);
  });

  it('context() calls get_code_snippet then search_graph with correct params and merges the results', async () => {
    const snippetResult = { content: [{ type: 'text', text: JSON.stringify({ code: 'function foo(){}' }) }] };
    const relationshipsResult = { content: [{ type: 'text', text: JSON.stringify([{ name: 'foo' }]) }] };
    mockCallTool.mockResolvedValueOnce(snippetResult);
    mockCallTool.mockResolvedValueOnce(relationshipsResult);

    const result = (await provider.context({ name: 'foo', repo: '/repo' })) as { content: { text: string }[] };
    const parsed = JSON.parse(result.content[0].text);

    expect(mockCallTool).toHaveBeenNthCalledWith(1, {
      name: 'get_code_snippet',
      arguments: { name: 'foo', project: '/repo' },
    });
    expect(mockCallTool).toHaveBeenNthCalledWith(2, {
      name: 'search_graph',
      arguments: { name_pattern: 'foo', project: '/repo' },
    });
    expect(parsed).toEqual({ name: 'foo', snippet: snippetResult, relationships: relationshipsResult });
  });

  it('context() returns the get_code_snippet error unchanged and skips search_graph', async () => {
    const errorResult = { isError: true, content: [{ type: 'text', text: 'boom' }] };
    mockCallTool.mockResolvedValueOnce(errorResult);

    const result = await provider.context({ name: 'foo' });

    expect(result).toEqual(errorResult);
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });

  it('map() calls get_architecture with correct params and returns the response unchanged', async () => {
    const expected = { content: [{ type: 'text', text: 'map result' }] };
    mockCallTool.mockResolvedValueOnce(expected);

    const result = await provider.map({ top: 5, repo: '/repo' });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'get_architecture',
      arguments: { top: 5, project: '/repo' },
    });
    expect(result).toBe(expected);
  });

  it('flow() calls trace_path with correct params and returns the response unchanged', async () => {
    const expected = { content: [{ type: 'text', text: 'flow result' }] };
    mockCallTool.mockResolvedValueOnce(expected);

    const result = await provider.flow({ from: 'a', to: 'b', repo: '/repo' });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'trace_path',
      arguments: { from: 'a', to: 'b', project: '/repo' },
    });
    expect(result).toBe(expected);
  });

  it('tests() calls search_graph and filters matches down to test paths via isTestPath', async () => {
    const matches = [
      { name: 'callerA', filePath: 'src/foo.ts' },
      { name: 'testCallerA', filePath: 'tests/foo.test.ts' },
      { name: 'specCallerB', file_path: 'src/lib/bar.spec.ts' },
    ];
    mockCallTool.mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(matches) }] });

    const result = (await provider.tests({ symbol: 'foo', repo: '/repo' })) as { content: { text: string }[] };
    const parsed = JSON.parse(result.content[0].text);

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'search_graph',
      arguments: { name_pattern: 'foo', project: '/repo' },
    });
    expect(parsed).toEqual({
      symbol: 'foo',
      tests: [
        { name: 'testCallerA', filePath: 'tests/foo.test.ts' },
        { name: 'specCallerB', file_path: 'src/lib/bar.spec.ts' },
      ],
      count: 2,
    });
  });

  it('tests() supports a wrapped { matches: [...] } payload shape', async () => {
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ matches: [{ name: 't', filePath: 'tests/x.test.ts' }] }) }],
    });

    const result = (await provider.tests({ symbol: 'x' })) as { content: { text: string }[] };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual({ symbol: 'x', tests: [{ name: 't', filePath: 'tests/x.test.ts' }], count: 1 });
  });

  it('tests() returns an empty tests array when no match is a test path', async () => {
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify([{ name: 'callerA', filePath: 'src/foo.ts' }]) }],
    });

    const result = (await provider.tests({ symbol: 'x' })) as { content: { text: string }[] };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual({ symbol: 'x', tests: [], count: 0 });
  });

  it('tests() passes through an error result unchanged', async () => {
    const errorResult = { isError: true, content: [{ type: 'text', text: 'boom' }] };
    mockCallTool.mockResolvedValueOnce(errorResult);

    const result = await provider.tests({ symbol: 'x' });

    expect(result).toEqual(errorResult);
  });
});

// ---------------------------------------------------------------------------
// CodebaseMemoryProvider connection resilience
//
// These tests need COLD module state per test because getCodebaseMemoryClient()
// holds module-level sharedClient / connectionPromise singletons. We use
// vi.resetModules() + a dynamic import so each test starts with a fresh module
// (the vi.mock factories above are re-applied, reusing the same hoisted mock
// fns).
// ---------------------------------------------------------------------------
describe('CodebaseMemoryProvider connection resilience', () => {
  it('(a) first connect failure returns a structured offline error; the next call reconnects', async () => {
    vi.resetModules();
    vi.clearAllMocks();
    setIndexPresent();
    // First connect attempt rejects; later attempts succeed.
    mockConnect.mockRejectedValueOnce(new Error('spawn codebase-memory-mcp ENOENT'));
    mockConnect.mockResolvedValue(undefined);

    const { CodebaseMemoryProvider: FreshProvider } = await import('../src/tools/code-intelligence-codebase-memory.js');
    const provider = new FreshProvider();

    // impact() is a passthrough method, used here as a neutral vehicle to
    // exercise the generic connection/resilience wiring in callCodebaseMemory.
    const first = (await provider.impact({ target: 'x' })) as { isError?: boolean; content: { text: string }[] };
    expect(first.isError).toBe(true);
    expect(first.content[0].text).toContain('offline');
    expect(first.content[0].text).toContain('codebase-memory-mcp');
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // Second call must attempt a brand-new connection (not await the poisoned promise).
    const expected = { content: [{ type: 'text', text: 'ok' }] };
    mockCallTool.mockResolvedValueOnce(expected);
    const second = await provider.impact({ target: 'x' });
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(second).toBe(expected);
  });

  it('(b) transport close resets the client so the next call reconnects', async () => {
    vi.resetModules();
    vi.clearAllMocks();
    setIndexPresent();
    mockConnect.mockResolvedValue(undefined);

    const { CodebaseMemoryProvider: FreshProvider } = await import('../src/tools/code-intelligence-codebase-memory.js');
    const stdio = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const provider = new FreshProvider();

    mockCallTool.mockResolvedValueOnce({ content: [] });
    await provider.impact({ target: 'x' });
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // Simulate the child process dying: fire the transport close handler.
    const transportInstance = (stdio.StdioClientTransport as unknown as { mock: { instances: { onclose?: () => void }[] } })
      .mock.instances[0];
    expect(typeof transportInstance.onclose).toBe('function');
    transportInstance.onclose!();

    mockCallTool.mockResolvedValueOnce({ content: [] });
    await provider.impact({ target: 'x' });
    // A brand-new client was constructed and connected.
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it('(c) callTool throwing yields the structured error and resets state for reconnect', async () => {
    vi.resetModules();
    vi.clearAllMocks();
    setIndexPresent();
    mockConnect.mockResolvedValue(undefined);

    const { CodebaseMemoryProvider: FreshProvider } = await import('../src/tools/code-intelligence-codebase-memory.js');
    const provider = new FreshProvider();

    mockCallTool.mockRejectedValueOnce(new Error('client closed'));
    const result = (await provider.impact({ target: 'x' })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('offline');
    expect(result.content[0].text).toContain('client closed');

    // State was reset: the next call reconnects (new connect attempt) and succeeds.
    const expected = { content: [{ type: 'text', text: 'ok' }] };
    mockCallTool.mockResolvedValueOnce(expected);
    const second = await provider.impact({ target: 'x' });
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(second).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// CodebaseMemoryProvider error handling
// ---------------------------------------------------------------------------
describe('CodebaseMemoryProvider error handling', () => {
  let provider: CodebaseMemoryProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    provider = new CodebaseMemoryProvider();
  });

  it('offline result shape matches the expected structured-error format', async () => {
    setIndexPresent();
    mockCallTool.mockRejectedValueOnce(new Error('ECONNRESET'));

    const result = (await provider.impact({ target: 'x' })) as { isError?: boolean; content: { type: string; text: string }[] };

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: 'text',
          text:
            'Code intelligence is offline: the codebase-memory-mcp service could not be reached. ' +
            "Start or reinstall it by running 'npm install -g codebase-memory-mcp' " +
            "(or 'codebase-memory-mcp install'), then retry. (ECONNRESET)",
        },
      ],
    });
  });

  it('missing-index pre-flight check returns a structured error without connecting or calling callTool', async () => {
    setIndexMissing();

    const result = (await provider.impact({ target: 'x' })) as { isError?: boolean; content: { type: string; text: string }[] };

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: 'text',
          text:
            'No code intelligence index found. Say "Index this project" to your agent ' +
            "(or run 'codebase-memory-mcp cli index_repository \\'{\"repo_path\": \"<repo>\"}\\'') " +
            'and retry.',
        },
      ],
    });
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('missing-index pre-flight check applies to every provider method', async () => {
    setIndexMissing();

    const methods: Array<Promise<unknown>> = [
      provider.graph({ symbol: 'x' }),
      provider.impact({ target: 'x' }),
      provider.query({ query: 'x' }),
      provider.context({ name: 'x' }),
      provider.map({}),
      provider.flow({}),
      provider.tests({ symbol: 'x' }),
    ];
    const results = (await Promise.all(methods)) as { isError?: boolean }[];

    for (const result of results) {
      expect(result.isError).toBe(true);
    }
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});
