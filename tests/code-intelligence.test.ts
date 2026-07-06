import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Hoist mock references so they are available inside vi.mock factories, which
// are hoisted to the top of the file before any import statements.
// ---------------------------------------------------------------------------
const mockReadFile = vi.hoisted(() => vi.fn());
const mockCallTool = vi.hoisted(() => vi.fn());
const mockConnect = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockMaybeScheduleReindex = vi.hoisted(() => vi.fn());
const mockLogWarn = vi.hoisted(() => vi.fn());
const mockLogError = vi.hoisted(() => vi.fn());

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}));

// Only code-intelligence-gitnexus.ts's freshness-note wiring (F2.2) calls
// execFileSync (to read `git rev-parse HEAD`); no other code path under test
// in this file touches child_process, so a blanket mock is safe here.
vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

// T3.2: the freshness path calls maybeScheduleReindex() on divergence. Mock
// it here rather than exercising the real spawn logic (that lives in
// tests/code-intelligence-reindex.test.ts) so these tests stay focused on the
// wiring: exactly-once scheduling and failure isolation.
vi.mock('../src/tools/code-intelligence-reindex.js', () => ({
  maybeScheduleReindex: mockMaybeScheduleReindex,
}));

vi.mock('../src/utils/log-helpers.js', () => ({
  logWarn: mockLogWarn,
  logError: mockLogError,
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
import { getProvider, PROVIDERS, codeMapSchema, codeFlowSchema } from '../src/tools/code-intelligence.js';
import { GitNexusProvider, parseMarkdownTable, asciiSanitizeLabel } from '../src/tools/code-intelligence-gitnexus.js';

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

// ---------------------------------------------------------------------------
// GitNexusProvider freshness note wiring (F2.2)
//
// When the call carries a `repo` param whose index exists, callGitNexus
// compares meta.json's lastCommit against a stubbed `git rev-parse HEAD`
// (child_process.execFileSync is mocked at the top of this file) and appends
// the freshness note to the response when they differ.
// ---------------------------------------------------------------------------
describe('GitNexusProvider freshness note wiring (F2.2)', () => {
  let tempRepo: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    tempRepo = mkdtempSync(join(tmpdir(), 'code-intel-freshness-test-'));
    mkdirSync(join(tempRepo, '.gitnexus'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempRepo, { recursive: true, force: true });
  });

  it('appends the freshness note (no suffix) when reindex scheduling declines', async () => {
    writeFileSync(
      join(tempRepo, '.gitnexus', 'meta.json'),
      JSON.stringify({ lastCommit: 'aaaaaaaa1111222233334444555566667777' }),
    );
    mockExecFileSync.mockReturnValue('bbbbbbbb111122223333444455556666777788\n');
    mockMaybeScheduleReindex.mockReturnValue(false);

    const provider = new GitNexusProvider();
    const original = { content: [{ type: 'text', text: 'call graph result' }] };
    mockCallTool.mockResolvedValueOnce(original);

    const result = (await provider.graph({ symbol: 'x', repo: tempRepo })) as {
      content: { type: string; text: string }[];
    };

    expect(result.content[0]).toEqual({ type: 'text', text: 'call graph result' });
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({
      type: 'text',
      text:
        "[code-intelligence] index is behind repo HEAD (indexed aaaaaaaa vs HEAD bbbbbbbb). " +
        "Results may miss recent changes; run 'npx gitnexus analyze' to refresh.",
    });
    expect(mockMaybeScheduleReindex).toHaveBeenCalledTimes(1);
    expect(mockMaybeScheduleReindex).toHaveBeenCalledWith(tempRepo);
  });

  it('appends the freshness note WITH the reindex suffix when scheduling starts one (T3.2)', async () => {
    writeFileSync(
      join(tempRepo, '.gitnexus', 'meta.json'),
      JSON.stringify({ lastCommit: 'aaaaaaaa1111222233334444555566667777' }),
    );
    mockExecFileSync.mockReturnValue('bbbbbbbb111122223333444455556666777788\n');
    mockMaybeScheduleReindex.mockReturnValue(true);

    const provider = new GitNexusProvider();
    const original = { content: [{ type: 'text', text: 'call graph result' }] };
    mockCallTool.mockResolvedValueOnce(original);

    const result = (await provider.graph({ symbol: 'x', repo: tempRepo })) as {
      content: { type: string; text: string }[];
    };

    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({
      type: 'text',
      text:
        "[code-intelligence] index is behind repo HEAD (indexed aaaaaaaa vs HEAD bbbbbbbb). " +
        "Results may miss recent changes; run 'npx gitnexus analyze' to refresh." +
        " A background re-index has been started.",
    });
    expect(mockMaybeScheduleReindex).toHaveBeenCalledTimes(1);
  });

  it('a schedule failure (maybeScheduleReindex throws) does not affect the tool result', async () => {
    writeFileSync(
      join(tempRepo, '.gitnexus', 'meta.json'),
      JSON.stringify({ lastCommit: 'aaaaaaaa1111222233334444555566667777' }),
    );
    mockExecFileSync.mockReturnValue('bbbbbbbb111122223333444455556666777788\n');
    mockMaybeScheduleReindex.mockImplementation(() => {
      throw new Error('spawn EMFILE');
    });

    const provider = new GitNexusProvider();
    const original = { content: [{ type: 'text', text: 'call graph result' }] };
    mockCallTool.mockResolvedValueOnce(original);

    const result = (await provider.graph({ symbol: 'x', repo: tempRepo })) as {
      content: { type: string; text: string }[];
    };

    // The note is still appended (divergence itself is unaffected), but
    // without the suffix since scheduling failed -- and, crucially, the call
    // does not throw or return an error result.
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({
      type: 'text',
      text:
        "[code-intelligence] index is behind repo HEAD (indexed aaaaaaaa vs HEAD bbbbbbbb). " +
        "Results may miss recent changes; run 'npx gitnexus analyze' to refresh.",
    });
    expect(mockMaybeScheduleReindex).toHaveBeenCalledTimes(1);
    expect(mockLogError).toHaveBeenCalled();
  });

  it('does not call maybeScheduleReindex when there is no divergence', async () => {
    writeFileSync(
      join(tempRepo, '.gitnexus', 'meta.json'),
      JSON.stringify({ lastCommit: 'aaaaaaaa1111222233334444555566667777' }),
    );
    mockExecFileSync.mockReturnValue('aaaaaaaa1111222233334444555566667777\n');

    const provider = new GitNexusProvider();
    const original = { content: [{ type: 'text', text: 'call graph result' }] };
    mockCallTool.mockResolvedValueOnce(original);

    const result = await provider.graph({ symbol: 'x', repo: tempRepo });

    expect(result).toBe(original);
    expect(mockMaybeScheduleReindex).not.toHaveBeenCalled();
  });

  it('does not append a note when meta lastCommit matches stubbed HEAD', async () => {
    writeFileSync(
      join(tempRepo, '.gitnexus', 'meta.json'),
      JSON.stringify({ lastCommit: 'aaaaaaaa1111222233334444555566667777' }),
    );
    mockExecFileSync.mockReturnValue('aaaaaaaa1111222233334444555566667777\n');

    const provider = new GitNexusProvider();
    const original = { content: [{ type: 'text', text: 'call graph result' }] };
    mockCallTool.mockResolvedValueOnce(original);

    const result = await provider.graph({ symbol: 'x', repo: tempRepo });

    expect(result).toBe(original);
  });

  it('does not append a note and does not fail the call when git is unavailable', async () => {
    writeFileSync(
      join(tempRepo, '.gitnexus', 'meta.json'),
      JSON.stringify({ lastCommit: 'aaaaaaaa1111222233334444555566667777' }),
    );
    mockExecFileSync.mockImplementation(() => {
      throw new Error('git not found');
    });

    const provider = new GitNexusProvider();
    const original = { content: [{ type: 'text', text: 'call graph result' }] };
    mockCallTool.mockResolvedValueOnce(original);

    const result = await provider.graph({ symbol: 'x', repo: tempRepo });

    expect(result).toBe(original);
  });

  it('does not append a note when meta.json is unreadable/invalid JSON', async () => {
    writeFileSync(join(tempRepo, '.gitnexus', 'meta.json'), '{ not valid json');
    mockExecFileSync.mockReturnValue('bbbbbbbb111122223333444455556666777788\n');

    const provider = new GitNexusProvider();
    const original = { content: [{ type: 'text', text: 'call graph result' }] };
    mockCallTool.mockResolvedValueOnce(original);

    const result = await provider.graph({ symbol: 'x', repo: tempRepo });

    expect(result).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// codeMapSchema / codeFlowSchema validation (T2.1 / T2.2)
// ---------------------------------------------------------------------------
describe('codeMapSchema validation', () => {
  it('accepts an empty object (all fields optional)', () => {
    const result = codeMapSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts repo and top', () => {
    const result = codeMapSchema.safeParse({ repo: '/a/b', top: 5 });
    expect(result.success).toBe(true);
  });

  it('rejects a non-positive top', () => {
    const result = codeMapSchema.safeParse({ top: 0 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer top', () => {
    const result = codeMapSchema.safeParse({ top: 1.5 });
    expect(result.success).toBe(false);
  });
});

describe('codeFlowSchema validation', () => {
  it('accepts an empty object (all fields optional)', () => {
    const result = codeFlowSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts from/to/name/repo together', () => {
    const result = codeFlowSchema.safeParse({ from: 'Entry', to: 'Exit', name: 'RemoveMember', repo: '/a/b' });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseMarkdownTable() / asciiSanitizeLabel() -- pure functions reused by both
// map() and flow() to turn the child's `cypher` markdown-table output into
// structured rows.
// ---------------------------------------------------------------------------
describe('parseMarkdownTable()', () => {
  it('parses a header + separator + data rows into row objects', () => {
    const markdown = [
      '| label | symbols | cohesion |',
      '| --- | --- | --- |',
      '| Providers | 47 | 0.786 |',
      '| Services | 35 | 0.554 |',
    ].join('\n');

    expect(parseMarkdownTable(markdown)).toEqual([
      { label: 'Providers', symbols: '47', cohesion: '0.786' },
      { label: 'Services', symbols: '35', cohesion: '0.554' },
    ]);
  });

  it('returns an empty array for a header-only table (no data rows)', () => {
    const markdown = ['| label | symbols |', '| --- | --- |'].join('\n');
    expect(parseMarkdownTable(markdown)).toEqual([]);
  });

  it('returns an empty array for empty or non-table input', () => {
    expect(parseMarkdownTable('')).toEqual([]);
    expect(parseMarkdownTable('just one line')).toEqual([]);
  });

  it('fills missing trailing cells with empty string', () => {
    const markdown = ['| a | b | c |', '| --- | --- | --- |', '| 1 | 2 |'].join('\n');
    expect(parseMarkdownTable(markdown)).toEqual([{ a: '1', b: '2', c: '' }]);
  });
});

describe('asciiSanitizeLabel()', () => {
  it('converts a Unicode arrow to ASCII "->"', () => {
    expect(asciiSanitizeLabel('RemoveMember→MaskSecrets')).toBe('RemoveMember->MaskSecrets');
  });

  it('leaves plain ASCII text unchanged', () => {
    expect(asciiSanitizeLabel('Providers')).toBe('Providers');
  });

  it('replaces other stray non-ASCII characters with "?"', () => {
    expect(asciiSanitizeLabel('café')).toBe('caf?');
  });
});

// ---------------------------------------------------------------------------
// GitNexusProvider.map() (T2.1 code_map -- communities)
//
// gitnexus 1.6.7 has no direct communities/map tool, so map() composes over
// callGitNexus('cypher', ...) and parses the returned markdown table.
// ---------------------------------------------------------------------------
describe('GitNexusProvider.map()', () => {
  let provider: GitNexusProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    provider = new GitNexusProvider();
  });

  it('calls the cypher tool with a default top of 20 when top is omitted', async () => {
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ markdown: '| label | symbols | cohesion | keywords |\n| --- | --- | --- | --- |', row_count: 0 }) }],
    });

    await provider.map({});

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'cypher',
      arguments: expect.objectContaining({ params: { top: 20 } }),
    });
  });

  it('passes an explicit top through to the cypher params', async () => {
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ markdown: '| label | symbols | cohesion | keywords |\n| --- | --- | --- | --- |', row_count: 0 }) }],
    });

    await provider.map({ top: 5 });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'cypher',
      arguments: expect.objectContaining({ params: { top: 5 } }),
    });
  });

  it('parses the markdown table into structured communities and ASCII-sanitizes labels', async () => {
    const markdown = [
      '| label | symbols | cohesion | keywords |',
      '| --- | --- | --- | --- |',
      '| Provi→ders | 47 | 0.786 | ["auth","session"] |',
      '| Services | 35 | 0.554 |  |',
    ].join('\n');
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ markdown, row_count: 2 }) + '\n\n---\n**Next:** do something else' }],
    });

    const result = (await provider.map({})) as { content: { text: string }[] };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual({
      communities: [
        { label: 'Provi->ders', symbols: 47, cohesion: 0.786, keywords: '["auth","session"]' },
        { label: 'Services', symbols: 35, cohesion: 0.554, keywords: '' },
      ],
      row_count: 2,
    });
  });

});

describe('GitNexusProvider.map() pre-flight index check', () => {
  let tempRepo: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    tempRepo = mkdtempSync(join(tmpdir(), 'code-intel-map-test-'));
  });

  afterEach(() => {
    rmSync(tempRepo, { recursive: true, force: true });
  });

  it('returns the missing-index error without connecting when repo has no .gitnexus', async () => {
    const provider = new GitNexusProvider();
    const result = (await provider.map({ repo: tempRepo })) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      `No code intelligence index found for ${tempRepo}. Run 'npx gitnexus analyze' in the repo (or /pm index) and retry.`,
    );
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// GitNexusProvider.flow() (T2.2 code_flow -- process flows)
//
// gitnexus 1.6.7 has no direct flows/processes tool, so flow() composes a
// list query (filtered by name/from/to over Process.heuristicLabel) followed
// by one steps query per matched process over STEP_IN_PROCESS edges.
// ---------------------------------------------------------------------------
describe('GitNexusProvider.flow()', () => {
  let provider: GitNexusProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    provider = new GitNexusProvider();
  });

  function mockListResult(rows: string[]): void {
    const markdown = [
      '| label | processType | stepCount |',
      '| --- | --- | --- |',
      ...rows,
    ].join('\n');
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ markdown, row_count: rows.length }) }],
    });
  }

  function mockStepsResult(rows: string[]): void {
    const markdown = ['| step | filePath | stepOrder |', '| --- | --- | --- |', ...rows].join('\n');
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ markdown, row_count: rows.length }) }],
    });
  }

  it('builds a WHERE clause on $name when name is provided', async () => {
    mockListResult([]);

    await provider.flow({ name: 'RemoveMember' });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'cypher',
      arguments: expect.objectContaining({
        query: expect.stringContaining('p.heuristicLabel CONTAINS $name'),
        params: { name: 'RemoveMember' },
      }),
    });
  });

  it('builds a WHERE clause combining $from and $to when both are provided', async () => {
    mockListResult([]);

    await provider.flow({ from: 'RemoveMember', to: 'MaskSecrets' });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'cypher',
      arguments: expect.objectContaining({
        query: expect.stringContaining('p.heuristicLabel CONTAINS $from'),
        params: { from: 'RemoveMember', to: 'MaskSecrets' },
      }),
    });
    const call = mockCallTool.mock.calls[0][0];
    expect(call.arguments.query).toContain('p.heuristicLabel CONTAINS $to');
    expect(call.arguments.query).toContain(' AND ');
  });

  it('omits the WHERE clause entirely when no filters are provided', async () => {
    mockListResult([]);

    await provider.flow({});

    const call = mockCallTool.mock.calls[0][0];
    expect(call.arguments.query).not.toContain('WHERE');
    expect(call.arguments.params).toEqual({});
  });

  it('fetches steps for each matched process and ASCII-sanitizes the unicode arrow in labels', async () => {
    mockListResult(['| RemoveMember→MaskSecrets | cross_community | 10 |']);
    mockStepsResult([
      '| validate | src/a.ts | 1 |',
      '| mask | src/b.ts | 2 |',
    ]);

    const result = (await provider.flow({ name: 'RemoveMember' })) as { content: { text: string }[] };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual({
      processes: [
        {
          label: 'RemoveMember->MaskSecrets',
          processType: 'cross_community',
          stepCount: 10,
          steps: [
            { step: 'validate', filePath: 'src/a.ts', order: 1 },
            { step: 'mask', filePath: 'src/b.ts', order: 2 },
          ],
        },
      ],
      row_count: 1,
    });

    // Second callTool invocation is the steps lookup, keyed on the RAW
    // (un-sanitized) label so it matches the child's stored heuristicLabel.
    expect(mockCallTool).toHaveBeenCalledTimes(2);
    const stepsCall = mockCallTool.mock.calls[1][0];
    expect(stepsCall.arguments.params).toEqual({ label: 'RemoveMember→MaskSecrets' });
  });

  it('caps step lookups at 5 matched processes', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => `| Process${i} | linear | 1 |`);
    mockListResult(rows);
    for (let i = 0; i < 5; i++) mockStepsResult([]);

    await provider.flow({});

    // 1 list call + 5 step-lookup calls (capped), not 8.
    expect(mockCallTool).toHaveBeenCalledTimes(6);
  });
});

describe('GitNexusProvider.flow() pre-flight index check', () => {
  let tempRepo: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    tempRepo = mkdtempSync(join(tmpdir(), 'code-intel-flow-test-'));
  });

  afterEach(() => {
    rmSync(tempRepo, { recursive: true, force: true });
  });

  it('returns the missing-index error without connecting when repo has no .gitnexus', async () => {
    const provider = new GitNexusProvider();
    const result = (await provider.flow({ name: 'x', repo: tempRepo })) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      `No code intelligence index found for ${tempRepo}. Run 'npx gitnexus analyze' in the repo (or /pm index) and retry.`,
    );
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});
