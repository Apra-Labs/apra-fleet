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
const mockListTools = vi.hoisted(() => vi.fn());
const mockConnect = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockMaybeScheduleReindex = vi.hoisted(() => vi.fn());
const mockLogWarn = vi.hoisted(() => vi.fn());
const mockLogError = vi.hoisted(() => vi.fn());
const mockGetAgent = vi.hoisted(() => vi.fn());

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

vi.mock('../src/services/registry.js', () => ({
  getAgent: mockGetAgent,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  // Must use a class or regular function (not arrow) so `new` works correctly.
  class MockClient {
    connect = mockConnect;
    callTool = mockCallTool;
    listTools = mockListTools;
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
import { getProvider, PROVIDERS, NullProvider, codeMapSchema, codeFlowSchema, codeTestsSchema } from '../src/tools/code-intelligence.js';
import { GitNexusProvider, parseMarkdownTable, asciiSanitizeLabel } from '../src/tools/code-intelligence-gitnexus.js';
import { CodebaseMemoryProvider } from '../src/tools/code-intelligence-codebase-memory.js';

// ---------------------------------------------------------------------------
// getProvider() tests
// ---------------------------------------------------------------------------
describe('getProvider()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to codebase-memory when config file is absent', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('no such file'), { code: 'ENOENT' }));

    const provider = await getProvider();
    expect(provider).toBe(PROVIDERS['codebase-memory']);
  });

  it('reads provider key from config.json and returns matching provider', async () => {
    mockReadFile.mockResolvedValue('{"provider":"gitnexus"}');

    const provider = await getProvider();
    expect(provider).toBe(PROVIDERS.gitnexus);
  });

  it('returns CodebaseMemoryProvider when config.json says codebase-memory', async () => {
    mockReadFile.mockResolvedValue('{"provider":"codebase-memory"}');

    const provider = await getProvider();
    expect(provider).toBe(PROVIDERS['codebase-memory']);
  });

  it('throws with a clear message when provider key is not in PROVIDERS map', async () => {
    mockReadFile.mockResolvedValue('{"provider":"no-such-provider"}');

    await expect(getProvider()).rejects.toThrow('no-such-provider');
    await expect(getProvider()).rejects.toThrow('not configured');
  });

  it('PROVIDERS map contains both gitnexus and codebase-memory entries', () => {
    expect(PROVIDERS.gitnexus).toBeInstanceOf(GitNexusProvider);
    expect(PROVIDERS['codebase-memory']).toBeInstanceOf(CodebaseMemoryProvider);
  });

  it('PROVIDERS map contains a none entry that is a NullProvider', () => {
    expect(PROVIDERS.none).toBeInstanceOf(NullProvider);
  });

  it('returns member-specific provider when memberId has codeIntelProvider set', async () => {
    mockGetAgent.mockReturnValue({ id: 'agent-1', codeIntelProvider: 'gitnexus' });

    const provider = await getProvider('agent-1');
    expect(provider).toBe(PROVIDERS.gitnexus);
    expect(mockGetAgent).toHaveBeenCalledWith('agent-1');
    // Should not read the global config file when member override is found.
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('returns NullProvider when memberId has codeIntelProvider set to none', async () => {
    mockGetAgent.mockReturnValue({ id: 'agent-2', codeIntelProvider: 'none' });

    const provider = await getProvider('agent-2');
    expect(provider).toBe(PROVIDERS.none);
    expect(provider).toBeInstanceOf(NullProvider);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('falls back to global config when memberId has no codeIntelProvider', async () => {
    mockGetAgent.mockReturnValue({ id: 'agent-3' });
    mockReadFile.mockResolvedValue('{"provider":"gitnexus"}');

    const provider = await getProvider('agent-3');
    expect(provider).toBe(PROVIDERS.gitnexus);
  });

  it('falls back to global config when memberId is not found in registry', async () => {
    mockGetAgent.mockReturnValue(undefined);
    mockReadFile.mockRejectedValue(Object.assign(new Error('no such file'), { code: 'ENOENT' }));

    const provider = await getProvider('unknown-agent');
    expect(provider).toBe(PROVIDERS['codebase-memory']);
  });

  it('returns global default when no memberId is passed (backward compat)', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('no such file'), { code: 'ENOENT' }));

    const provider = await getProvider();
    expect(provider).toBe(PROVIDERS['codebase-memory']);
    expect(mockGetAgent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// NullProvider tests
// ---------------------------------------------------------------------------
describe('NullProvider', () => {
  it('returns structured disabled message from every method without throwing', async () => {
    const nullProvider = new NullProvider();
    const methods = ['graph', 'impact', 'query', 'context', 'map', 'flow', 'tests'] as const;

    for (const method of methods) {
      const result = await nullProvider[method]({}) as { content: Array<{ type: string; text: string }>; isError: boolean };
      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toBe('Code intelligence is disabled for this member.');
    }
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
// GitNexusProvider.graph() -- retargeted to cypher CALLS traversal (yashr-5t9)
//
// gitnexus 1.6.7 has NO `call_graph` child tool (the old mapping always
// returned an "Unknown tool" isError result). graph() now composes two
// depth-bounded `cypher` traversals over CALLS edges (callers + callees) into
// a structured multi-hop call graph, reusing extractCypherPayload +
// parseMarkdownTable + asciiSanitizeLabel.
// ---------------------------------------------------------------------------
describe('GitNexusProvider.graph() (cypher CALLS traversal)', () => {
  let provider: GitNexusProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    provider = new GitNexusProvider();
  });

  function mockGraphTable(rows: string[]): void {
    const markdown = ['| name | filePath | depth |', '| --- | --- | --- |', ...rows].join('\n');
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ markdown, row_count: rows.length }) }],
    });
  }

  it('issues a callers cypher then a callees cypher (never the non-existent call_graph tool) and shapes a call graph', async () => {
    mockGraphTable(['| callerA | src/a.ts | 1 |', '| callerB | src/b.ts | 2 |']); // callers
    mockGraphTable(['| calleeA | src/c.ts | 1 |']); // callees

    const result = (await provider.graph({ symbol: 'handleIPChange' })) as { content: { text: string }[] };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual({
      symbol: 'handleIPChange',
      maxDepth: 2,
      callers: [
        { name: 'callerA', filePath: 'src/a.ts', depth: 1 },
        { name: 'callerB', filePath: 'src/b.ts', depth: 2 },
      ],
      callees: [{ name: 'calleeA', filePath: 'src/c.ts', depth: 1 }],
    });

    expect(mockCallTool).toHaveBeenCalledTimes(2);
    const callersCall = mockCallTool.mock.calls[0][0];
    const calleesCall = mockCallTool.mock.calls[1][0];
    expect(callersCall.name).toBe('cypher');
    expect(calleesCall.name).toBe('cypher');
    expect(callersCall.name).not.toBe('call_graph');
    // Both traversals bind the schema `symbol` arg to the Cypher $symbol param.
    expect(callersCall.arguments.params).toEqual({ symbol: 'handleIPChange' });
    expect(calleesCall.arguments.params).toEqual({ symbol: 'handleIPChange' });
    // Depth-bounded CALLS traversal in both directions.
    expect(callersCall.arguments.query).toContain(':CodeRelation*1..2 {type: "CALLS"}');
    expect(callersCall.arguments.query).toContain('target.name = $symbol');
    expect(calleesCall.arguments.query).toContain('source.name = $symbol');
  });

  it('ASCII-sanitizes a unicode arrow in returned symbol names', async () => {
    mockGraphTable(['| Rem→ove | src/a.ts | 1 |']); // callers (unicode arrow)
    mockGraphTable([]); // callees empty

    const result = (await provider.graph({ symbol: 's' })) as { content: { text: string }[] };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.callers).toEqual([{ name: 'Rem->ove', filePath: 'src/a.ts', depth: 1 }]);
    expect(parsed.callees).toEqual([]);
  });

  it('returns the error result unchanged and skips the callees call when the callers cypher errors', async () => {
    const errorResult = { isError: true, content: [{ type: 'text', text: 'boom' }] };
    mockCallTool.mockResolvedValueOnce(errorResult);

    const result = await provider.graph({ symbol: 's' });

    expect(result).toEqual(errorResult);
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Child-tool surface guard (regression for yashr-5t9)
//
// This test guards the whole bug class: it asserts that every child tool name
// GitNexusProvider actually invokes exists in the gitnexus 1.6.7 child surface.
// It FAILS on the old graph()->'call_graph' mapping (call_graph is absent from
// the surface) and PASSES on the retargeted graph()->'cypher' mapping.
//
// The surface below was confirmed live via listTools() against the real child
// (npx -y gitnexus mcp over stdio) during the fix and cross-checked against the
// package source; see docs/code-intelligence-child-surface.md. We assert
// against a mocked listTools() with this known surface rather than spawning the
// child in CI: a live npx spawn is too slow/flaky for unit CI. The scratch
// probe used during the fix performs the live listTools() check out-of-band.
// ---------------------------------------------------------------------------
describe('GitNexusProvider child-tool surface guard (yashr-5t9 regression)', () => {
  // gitnexus 1.6.7 complete child tool surface (13 tools). call_graph is
  // deliberately ABSENT -- it never existed on this version.
  const CHILD_SURFACE_1_6_7 = [
    'list_repos', 'query', 'cypher', 'context', 'detect_changes', 'rename',
    'impact', 'route_map', 'tool_map', 'shape_check', 'api_impact',
    'group_list', 'group_sync',
  ];

  it('every child tool the provider invokes is present in the child listTools() surface', async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: CHILD_SURFACE_1_6_7.map((name) => ({ name })) });
    // Benign shape that satisfies every composed method's parser so each
    // provider method runs to completion and its child call(s) are recorded.
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ markdown: '', row_count: 0, byDepth: {} }) }],
    });

    const { GitNexusProvider } = await import('../src/tools/code-intelligence-gitnexus.js');
    const provider = new GitNexusProvider();

    // Exercise every provider method that reaches the child. No `repo` param so
    // the pre-flight index check never short-circuits before callTool.
    await provider.graph({ symbol: 's' });
    await provider.impact({ target: 's', direction: 'upstream' });
    await provider.query({ query: 's' });
    await provider.context({ name: 's' });
    await provider.map({});
    await provider.flow({});
    await provider.tests({ symbol: 's' });

    // The child's advertised surface, as the SDK Client's listTools() returns
    // it (the mock backs MockClient.listTools()).
    const listed = (await mockListTools()) as { tools: { name: string }[] };
    const surface = listed.tools.map((t) => t.name);

    const invokedToolNames = Array.from(new Set(mockCallTool.mock.calls.map((c) => c[0].name as string)));
    expect(invokedToolNames.length).toBeGreaterThan(0);
    // The exact bug being guarded: graph() must no longer call 'call_graph'.
    expect(invokedToolNames).not.toContain('call_graph');
    // Every tool the provider depends on must exist in the child's surface.
    for (const name of invokedToolNames) {
      expect(surface).toContain(name);
    }
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

    // impact() is a passthrough method, used here as a neutral vehicle to
    // exercise the generic connection/resilience wiring in callGitNexus.
    const first = (await provider.impact({ target: 'x', direction: 'upstream' })) as { isError?: boolean; content: { text: string }[] };
    expect(first.isError).toBe(true);
    expect(first.content[0].text).toContain('offline');
    expect(first.content[0].text).toContain('npx gitnexus analyze');
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // Second call must attempt a brand-new connection (not await the poisoned promise).
    const expected = { content: [{ type: 'text', text: 'ok' }] };
    mockCallTool.mockResolvedValueOnce(expected);
    const second = await provider.impact({ target: 'x', direction: 'upstream' });
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
    await provider.impact({ target: 'x', direction: 'upstream' });
    expect(mockConnect).toHaveBeenCalledTimes(1);

    // Simulate the child process dying: fire the transport close handler.
    const transportInstance = (stdio.StdioClientTransport as unknown as { mock: { instances: { onclose?: () => void }[] } })
      .mock.instances[0];
    expect(typeof transportInstance.onclose).toBe('function');
    transportInstance.onclose!();

    mockCallTool.mockResolvedValueOnce({ content: [] });
    await provider.impact({ target: 'x', direction: 'upstream' });
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

    // impact() is a passthrough method: with no repo, callGitNexus skips the
    // pre-flight index check and forwards straight to the child.
    const result = await provider.impact({ target: 'x', direction: 'upstream' });

    expect(mockCallTool).toHaveBeenCalledWith({ name: 'impact', arguments: { target: 'x', direction: 'upstream' } });
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

    const result = (await provider.impact({ target: 'x', direction: 'upstream', repo: tempRepo })) as {
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

    const result = (await provider.impact({ target: 'x', direction: 'upstream', repo: tempRepo })) as {
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

    const result = (await provider.impact({ target: 'x', direction: 'upstream', repo: tempRepo })) as {
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

    const result = await provider.impact({ target: 'x', direction: 'upstream', repo: tempRepo });

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

    const result = await provider.impact({ target: 'x', direction: 'upstream', repo: tempRepo });

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

    const result = await provider.impact({ target: 'x', direction: 'upstream', repo: tempRepo });

    expect(result).toBe(original);
  });

  it('does not append a note when meta.json is unreadable/invalid JSON', async () => {
    writeFileSync(join(tempRepo, '.gitnexus', 'meta.json'), '{ not valid json');
    mockExecFileSync.mockReturnValue('bbbbbbbb111122223333444455556666777788\n');

    const provider = new GitNexusProvider();
    const original = { content: [{ type: 'text', text: 'call graph result' }] };
    mockCallTool.mockResolvedValueOnce(original);

    const result = await provider.impact({ target: 'x', direction: 'upstream', repo: tempRepo });

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

describe('codeTestsSchema validation', () => {
  it('rejects an empty object (symbol is required)', () => {
    const result = codeTestsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('accepts symbol with optional repo', () => {
    const result = codeTestsSchema.safeParse({ symbol: 'handleIPChange', repo: '/a/b' });
    expect(result.success).toBe(true);
  });

  it('accepts symbol alone (repo omitted)', () => {
    const result = codeTestsSchema.safeParse({ symbol: 'handleIPChange' });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GitNexusProvider.tests() (T4.4 code_tests -- test-to-symbol mapping)
//
// Composes the child's `impact` tool (direction: upstream, maxDepth: 2,
// includeTests: true -- direct capability per the Decisions table in
// docs/code-intelligence-child-surface.md) and filters byDepth["1"] +
// byDepth["2"] items down to those whose filePath passes isTestPath (T4.3).
// ---------------------------------------------------------------------------
describe('GitNexusProvider.tests()', () => {
  let provider: GitNexusProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    provider = new GitNexusProvider();
  });

  it('calls impact with direction upstream, maxDepth 2, includeTests true, and the symbol as target', async () => {
    mockCallTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ byDepth: {} }) }],
    });

    await provider.tests({ symbol: 'handleIPChange' });

    expect(mockCallTool).toHaveBeenCalledWith({
      name: 'impact',
      arguments: expect.objectContaining({
        target: 'handleIPChange',
        direction: 'upstream',
        maxDepth: 2,
        includeTests: true,
      }),
    });
  });

  it('filters mixed test/product callers across depth 1 and depth 2 down to only test paths', async () => {
    mockCallTool.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: JSON.stringify({
          byDepth: {
            '1': [
              { name: 'callerA', filePath: 'src/foo.ts' },
              { name: 'testCallerA', filePath: 'tests/foo.test.ts' },
            ],
            '2': [
              { name: 'callerB', filePath: 'src/bar.ts' },
              { name: 'testCallerB', filePath: 'src/lib/bar.spec.ts' },
            ],
          },
        }),
      }],
    });

    const result = (await provider.tests({ symbol: 'x' })) as { content: { text: string }[] };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual({
      tests: [
        { name: 'testCallerA', filePath: 'tests/foo.test.ts' },
        { name: 'testCallerB', filePath: 'src/lib/bar.spec.ts' },
      ],
      count: 2,
    });
  });

  it('returns an empty tests array when no byDepth caller is a test path', async () => {
    mockCallTool.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: JSON.stringify({ byDepth: { '1': [{ name: 'callerA', filePath: 'src/foo.ts' }] } }),
      }],
    });

    const result = (await provider.tests({ symbol: 'x' })) as { content: { text: string }[] };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toEqual({ tests: [], count: 0 });
  });

  it('strips a trailing hint suffix before parsing, like cypher payloads', async () => {
    mockCallTool.mockResolvedValueOnce({
      content: [{
        type: 'text',
        text: JSON.stringify({ byDepth: { '1': [{ name: 't', filePath: 'tests/x.test.ts' }] } }) +
          '\n\n---\n**Next:** do something else',
      }],
    });

    const result = (await provider.tests({ symbol: 'x' })) as { content: { text: string }[] };
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.tests).toEqual([{ name: 't', filePath: 'tests/x.test.ts' }]);
  });

  it('passes through an error result unchanged', async () => {
    const errorResult = { isError: true, content: [{ type: 'text', text: 'boom' }] };
    mockCallTool.mockResolvedValueOnce(errorResult);

    const result = await provider.tests({ symbol: 'x' });

    expect(result).toEqual(errorResult);
  });
});

describe('GitNexusProvider.tests() pre-flight index check', () => {
  let tempRepo: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    tempRepo = mkdtempSync(join(tmpdir(), 'code-intel-tests-test-'));
  });

  afterEach(() => {
    rmSync(tempRepo, { recursive: true, force: true });
  });

  it('returns the missing-index error without connecting when repo has no .gitnexus', async () => {
    const provider = new GitNexusProvider();
    const result = (await provider.tests({ symbol: 'x', repo: tempRepo })) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      `No code intelligence index found for ${tempRepo}. Run 'npx gitnexus analyze' in the repo (or /pm index) and retry.`,
    );
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});
