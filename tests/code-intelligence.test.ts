import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

// ---------------------------------------------------------------------------
// GitNexusProvider connection resilience (F3.2)
//
// These tests need COLD module state per test because getGitNexusClient()
// holds module-level sharedClient / connectionPromise singletons. We use
// vi.resetModules() + a dynamic import so each test starts with a fresh module
// (the vi.mock factories above are re-applied, reusing the same hoisted mock
// fns).
// ---------------------------------------------------------------------------
describe('GitNexusProvider connection resilience', () => {
  it('(a) first connect failure errors actionably; next call retries a fresh connection', async () => {
    vi.resetModules();
    vi.clearAllMocks();
    // First connect attempt rejects; later attempts succeed.
    mockConnect.mockRejectedValueOnce(new Error('spawn npx ENOENT'));
    mockConnect.mockResolvedValue(undefined);

    const { GitNexusProvider } = await import('../src/tools/code-intelligence-gitnexus.js');
    const provider = new GitNexusProvider();

    const first = (await provider.graph({ symbol: 'x' })) as { isError?: boolean; content: { text: string }[] };
    expect(first.isError).toBe(true);
    expect(first.content[0].text).toContain('offline');
    expect(first.content[0].text).toContain('npx gitnexus analyze');
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // Second call must attempt a brand-new connection (not await the poisoned promise).
    const expected = { content: [{ type: 'text', text: 'ok' }] };
    mockCallTool.mockResolvedValueOnce(expected);
    const second = await provider.graph({ symbol: 'x' });
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(second).toBe(expected);
  });

  it('(b) transport close resets the client so the next call reconnects', async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);

    const { GitNexusProvider } = await import('../src/tools/code-intelligence-gitnexus.js');
    const stdio = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const provider = new GitNexusProvider();

    mockCallTool.mockResolvedValueOnce({ content: [] });
    await provider.graph({ symbol: 'x' });
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // Simulate the child process dying: fire the transport close handler.
    const transportInstance = (stdio.StdioClientTransport as unknown as { mock: { instances: { onclose?: () => void }[] } })
      .mock.instances[0];
    expect(typeof transportInstance.onclose).toBe('function');
    transportInstance.onclose!();

    mockCallTool.mockResolvedValueOnce({ content: [] });
    await provider.graph({ symbol: 'x' });
    // A brand-new client was constructed and connected.
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it('(c) callTool throwing yields the structured error and resets state for reconnect', async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);

    const { GitNexusProvider } = await import('../src/tools/code-intelligence-gitnexus.js');
    const provider = new GitNexusProvider();

    mockCallTool.mockRejectedValueOnce(new Error('client closed'));
    const result = (await provider.impact({ file_path: 'src/index.ts' })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('offline');

    // State was reset: the next call reconnects (new connect attempt) and succeeds.
    const expected = { content: [{ type: 'text', text: 'ok' }] };
    mockCallTool.mockResolvedValueOnce(expected);
    const second = await provider.impact({ file_path: 'src/index.ts' });
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(second).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// GitNexusProvider pre-flight index check (F3.1)
//
// When a call carries a `repo` param, the provider must check
// `<repo>/.gitnexus/meta.json` with fs.existsSync BEFORE ever touching the
// child process. Missing index -> structured error, no connect, no callTool.
// Calls without `repo` are forwarded untouched.
// ---------------------------------------------------------------------------
describe('GitNexusProvider pre-flight index check (F3.1)', () => {
  let tempRepo: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    tempRepo = mkdtempSync(join(tmpdir(), 'code-intel-test-'));
  });

  afterEach(() => {
    rmSync(tempRepo, { recursive: true, force: true });
  });

  it('graph() returns the missing-index error without connecting when repo has no .gitnexus', async () => {
    const provider = new GitNexusProvider();
    const result = (await provider.graph({ symbol: 'x', repo: tempRepo })) as {
      isError?: boolean;
      content: { text: string }[];
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      `No code intelligence index found for ${tempRepo}. Run 'npx gitnexus analyze' in the repo (or /pm index) and retry.`,
    );
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('impact() returns the missing-index error without connecting when repo has no .gitnexus', async () => {
    const provider = new GitNexusProvider();
    const result = (await provider.impact({ target: 'x', direction: 'upstream', repo: tempRepo })) as {
      isError?: boolean;
      content: { text: string }[];
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      `No code intelligence index found for ${tempRepo}. Run 'npx gitnexus analyze' in the repo (or /pm index) and retry.`,
    );
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('query() returns the missing-index error without connecting when repo has no .gitnexus', async () => {
    const provider = new GitNexusProvider();
    const result = (await provider.query({ query: 'find exports', repo: tempRepo })) as {
      isError?: boolean;
      content: { text: string }[];
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      `No code intelligence index found for ${tempRepo}. Run 'npx gitnexus analyze' in the repo (or /pm index) and retry.`,
    );
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('context() returns the missing-index error without connecting when repo has no .gitnexus', async () => {
    const provider = new GitNexusProvider();
    const result = (await provider.context({ name: 'x', repo: tempRepo })) as {
      isError?: boolean;
      content: { text: string }[];
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      `No code intelligence index found for ${tempRepo}. Run 'npx gitnexus analyze' in the repo (or /pm index) and retry.`,
    );
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('forwards to callTool untouched when the repo param is absent', async () => {
    const provider = new GitNexusProvider();
    const expected = { content: [{ type: 'text', text: 'ok' }] };
    mockCallTool.mockResolvedValueOnce(expected);

    const result = await provider.graph({ symbol: 'x' });

    expect(mockCallTool).toHaveBeenCalledWith({ name: 'call_graph', arguments: { symbol: 'x' } });
    expect(result).toBe(expected);
  });
});
