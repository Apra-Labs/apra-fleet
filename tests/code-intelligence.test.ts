import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mock references so they are available inside vi.mock factories, which
// are hoisted to the top of the file before any import statements.
// ---------------------------------------------------------------------------
const mockReadFile = vi.hoisted(() => vi.fn());
const mockCallTool = vi.hoisted(() => vi.fn());
const mockConnect = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
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
// Static imports (resolved after mocks are hoisted)
// ---------------------------------------------------------------------------
import { getProvider, PROVIDERS } from '../src/tools/code-intelligence.js';
import { GitNexusProvider } from '../src/tools/code-intelligence-gitnexus.js';

// ---------------------------------------------------------------------------
// getProvider() tests
// ---------------------------------------------------------------------------
describe('getProvider()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to gitnexus when config file is absent', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('no such file'), { code: 'ENOENT' }));

    const provider = await getProvider();
    expect(provider).toBe(PROVIDERS.gitnexus);
  });

  it('reads provider key from config.json and returns matching provider', async () => {
    mockReadFile.mockResolvedValue('{"provider":"gitnexus"}');

    const provider = await getProvider();
    expect(provider).toBe(PROVIDERS.gitnexus);
  });

  it('throws with a clear message when provider key is not in PROVIDERS map', async () => {
    mockReadFile.mockResolvedValue('{"provider":"no-such-provider"}');

    await expect(getProvider()).rejects.toThrow('no-such-provider');
    await expect(getProvider()).rejects.toThrow('not configured');
  });
});

// ---------------------------------------------------------------------------
// GitNexusProvider tests
//
// The provider module holds a module-level sharedClient singleton.  Because
// the MCP Client constructor is mocked above, the first call to any provider
// method sets sharedClient to the mock instance.  Subsequent calls reuse it.
// We use mockCallTool (shared across tests) and configure its return value per
// test via mockResolvedValueOnce so tests do not interfere with each other.
// ---------------------------------------------------------------------------
describe('GitNexusProvider', () => {
  let provider: GitNexusProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GitNexusProvider();
  });

  it('graph() delegates to call_graph and returns the response unchanged', async () => {
    const params = { symbol: 'handleIPChange' };
    const expected = { content: [{ type: 'text', text: 'call graph result' }] };
    mockCallTool.mockResolvedValueOnce(expected);

    const result = await provider.graph(params);

    expect(mockCallTool).toHaveBeenCalledWith({ name: 'call_graph', arguments: params });
    expect(result).toBe(expected);
  });

  it('impact() delegates to impact tool and returns the response unchanged', async () => {
    const params = { file_path: 'src/index.ts' };
    const expected = { content: [{ type: 'text', text: 'impact result' }] };
    mockCallTool.mockResolvedValueOnce(expected);

    const result = await provider.impact(params);

    expect(mockCallTool).toHaveBeenCalledWith({ name: 'impact', arguments: params });
    expect(result).toBe(expected);
  });

  it('query() delegates to query tool and returns the response unchanged', async () => {
    const params = { query: 'find all exports' };
    const expected = { content: [{ type: 'text', text: 'query result' }] };
    mockCallTool.mockResolvedValueOnce(expected);

    const result = await provider.query(params);

    expect(mockCallTool).toHaveBeenCalledWith({ name: 'query', arguments: params });
    expect(result).toBe(expected);
  });

  it('context() delegates to context tool and returns the response unchanged', async () => {
    const params = { file_path: 'src/utils/helpers.ts' };
    const expected = { content: [{ type: 'text', text: 'context result' }] };
    mockCallTool.mockResolvedValueOnce(expected);

    const result = await provider.context(params);

    expect(mockCallTool).toHaveBeenCalledWith({ name: 'context', arguments: params });
    expect(result).toBe(expected);
  });
});
