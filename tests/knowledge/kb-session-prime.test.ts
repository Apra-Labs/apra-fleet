import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

function gitBlobHash(data: Buffer): string {
  const header = Buffer.from(`blob ${data.length}\0`);
  return createHash('sha1').update(header).update(data).digest('hex');
}

function setupGitSuccess(): void {
  mockExecFile.mockImplementation((...allArgs: unknown[]) => {
    const cb = allArgs[allArgs.length - 1] as (err: Error | null, stdout: string, stderr: string) => void;
    const fileArgs = (allArgs[1] as string[]).slice(1);
    const hashes = fileArgs.map((f: string) => {
      try {
        const data = fs.readFileSync(f) as Buffer;
        return gitBlobHash(data);
      } catch {
        return '';
      }
    });
    cb(null, hashes.join('\n') + '\n', '');
  });
}

function makeContextCache(file: string, hash: string): KBEntryInput {
  return {
    type: 'context-cache',
    title: `Summary of ${path.basename(file)}`,
    summary: `Handles ${path.basename(file)} logic.`,
    content: `Detailed content for ${file}`,
    source_files: [file],
    symbols: ['someFunc'],
    tags: [],
    content_hash: hash,
    content_hash_type: 'git',
    flagged_for_review: false,
    author: 'test-agent',
    source: 'doer',
    confidence: 'INFERRED',
  };
}

let provider: SqliteProvider;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-prime-test-'));
  mockExecFile.mockReset();
  setupGitSuccess();
  provider = new SqliteProvider(':memory:');
  await provider.init();
});

afterEach(() => {
  provider.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('kb_session_prime', () => {
  it('cold session: stale_files has entries, session_warm=false', async () => {
    const filePath = path.join(tmpDir, 'cold.ts');
    fs.writeFileSync(filePath, 'const cold = true;');

    const result = await provider.prime({ session_files: [filePath] });
    expect(result.session_warm).toBe(false);
    expect(result.stale_files).toContain(filePath);
  });

  it('warm session: stale_files empty, session_warm=true', async () => {
    const filePath = path.join(tmpDir, 'warm.ts');
    const content = 'const warm = true;';
    fs.writeFileSync(filePath, content);
    const hash = gitBlobHash(Buffer.from(content));

    await provider.capture(makeContextCache(filePath, hash));

    const result = await provider.prime({ session_files: [filePath] });
    expect(result.session_warm).toBe(true);
    expect(result.stale_files).toHaveLength(0);
    expect(result.fresh_summaries).toHaveLength(1);
  });

  it('recommended_code_calls is array of objects with tool+args keys', async () => {
    const result = await provider.prime({
      session_files: ['src/registry.ts'],
      hint_symbols: ['initRegistry'],
    });

    expect(Array.isArray(result.recommended_code_calls)).toBe(true);
    for (const call of result.recommended_code_calls) {
      expect(call).toHaveProperty('tool');
      expect(call).toHaveProperty('args');
      expect(typeof call.tool).toBe('string');
      expect(typeof call.args).toBe('object');
    }

    const symbolCall = result.recommended_code_calls.find(c => c.tool === 'code_context');
    expect(symbolCall).toBeDefined();
    expect(symbolCall!.args).toEqual({ name: 'initRegistry' });

    const impactCall = result.recommended_code_calls.find(c => c.tool === 'code_impact');
    expect(impactCall).toBeDefined();
    expect(impactCall!.args).toEqual({ target: 'src/registry.ts', direction: 'upstream' });
  });

  it('no hints: recommended_code_calls is empty array', async () => {
    const result = await provider.prime({});
    expect(result.recommended_code_calls).toEqual([]);
    expect(result.session_warm).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Graph-neighbor expansion (T1.3 P4b) -- exercises the kbSessionPrime wrapper
// with the KB providers and the code-intelligence provider fully mocked. KB
// constraint 1: module-level singletons -> vi.resetModules() + dynamic import
// at the start of each test; mock fns hoisted via vi.hoisted().
// ---------------------------------------------------------------------------

import type { KBEntry } from '../../src/services/knowledge/types.js';

const mockPrime = vi.hoisted(() => vi.fn());
const mockProjectQuery = vi.hoisted(() => vi.fn());
const mockGlobalQuery = vi.hoisted(() => vi.fn());
const mockContext = vi.hoisted(() => vi.fn());
const mockGetProvider = vi.hoisted(() => vi.fn());
const mockGetKbProviders = vi.hoisted(() => vi.fn());
const mockValidateFilePaths = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/knowledge/kb-providers.js', () => ({
  getKbProviders: mockGetKbProviders,
}));
vi.mock('../../src/tools/code-intelligence.js', () => ({
  getProvider: mockGetProvider,
}));
vi.mock('../../src/services/knowledge/path-validation.js', () => ({
  validateFilePaths: mockValidateFilePaths,
}));

function entry(id: string, type: KBEntry['type'] = 'knowledge'): KBEntry {
  return {
    id,
    type,
    title: id,
    summary: `summary-${id}`,
    content: '',
    source_files: [],
    symbols: [],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    stale: false,
    flagged_for_review: false,
    author: '',
    source: 'doer',
    confidence: 'CONFIRMED',
    created_at: '2026-01-01T00:00:00.000Z',
    use_count: 0,
  };
}

// Build a code-intelligence `context` MCP result carrying the given neighbor
// names as incoming calls.
function contextResult(names: string[]): unknown {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          status: 'found',
          symbol: { name: 'root' },
          incoming: { calls: names.map(n => ({ name: n })) },
          outgoing: { calls: [] },
        }),
      },
    ],
  };
}

function primedContext(top: KBEntry[]) {
  return {
    session_warm: true,
    stale_files: [],
    top_entries: top,
    fresh_summaries: [],
    recommended_code_calls: [],
    token_estimate: 0,
  };
}

describe('kb_session_prime graph-neighbor expansion', () => {
  beforeEach(() => {
    vi.resetModules();
    mockPrime.mockReset();
    mockProjectQuery.mockReset();
    mockGlobalQuery.mockReset();
    mockContext.mockReset();
    mockGetProvider.mockReset();
    mockGetKbProviders.mockReset();
    mockValidateFilePaths.mockReset();

    mockGlobalQuery.mockResolvedValue({ results: [], total: 0, l1_only: true });
    mockGetKbProviders.mockResolvedValue({
      project: { prime: mockPrime, query: mockProjectQuery },
      global: { query: mockGlobalQuery },
      projectSlug: 'test',
    });
    mockGetProvider.mockResolvedValue({ context: mockContext });
  });

  it('appends neighbor-derived entries below direct hits with via marker', async () => {
    mockPrime.mockResolvedValue(primedContext([entry('a'), entry('b')]));
    mockContext.mockResolvedValue(contextResult(['nbrX']));
    mockProjectQuery.mockResolvedValue({ results: [entry('c')], total: 1, l1_only: true });

    const { kbSessionPrime } = await import('../../src/tools/kb-session-prime.js');
    const parsed = JSON.parse(await kbSessionPrime({ hint_symbols: ['a'] }));

    expect(parsed.top_entries.map((e: KBEntry) => e.id)).toEqual(['a', 'b', 'c']);
    // Direct hits carry no via marker; neighbor entry does.
    expect(parsed.top_entries[0].via).toBeUndefined();
    expect(parsed.top_entries[1].via).toBeUndefined();
    expect(parsed.top_entries[2].via).toBe('graph-neighbor');
  });

  it('caps neighbors queried at NEIGHBOR_CAP (11 -> 10)', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => 'nbr' + i);
    mockPrime.mockResolvedValue(primedContext([]));
    mockContext.mockResolvedValue(contextResult(eleven));
    mockProjectQuery.mockResolvedValue({ results: [], total: 0, l1_only: true });

    const { kbSessionPrime, NEIGHBOR_CAP } = await import('../../src/tools/kb-session-prime.js');
    await kbSessionPrime({ hint_symbols: ['root'] });

    expect(NEIGHBOR_CAP).toBe(10);
    expect(mockProjectQuery).toHaveBeenCalledTimes(1);
    const passedQuery = mockProjectQuery.mock.calls[0][0].query as string;
    // 10 neighbors survive the cap; the 11th is excluded.
    const quotedTerms = passedQuery.match(/"nbr\d+"/g) ?? [];
    expect(quotedTerms).toHaveLength(NEIGHBOR_CAP);
    expect(passedQuery).not.toContain('"nbr10"');
  });

  it('caps additions at ADDED_ENTRY_CAP (8 candidates -> 5 added)', async () => {
    mockPrime.mockResolvedValue(primedContext([entry('d0')]));
    mockContext.mockResolvedValue(contextResult(['nbrX']));
    const eight = Array.from({ length: 8 }, (_, i) => entry('n' + i));
    mockProjectQuery.mockResolvedValue({ results: eight, total: 8, l1_only: true });

    const { kbSessionPrime, ADDED_ENTRY_CAP } = await import('../../src/tools/kb-session-prime.js');
    const parsed = JSON.parse(await kbSessionPrime({ hint_symbols: ['root'] }));

    expect(ADDED_ENTRY_CAP).toBe(5);
    const added = parsed.top_entries.filter((e: KBEntry & { via?: string }) => e.via === 'graph-neighbor');
    expect(added).toHaveLength(ADDED_ENTRY_CAP);
    // Direct hit is preserved and ranked first.
    expect(parsed.top_entries[0].id).toBe('d0');
  });

  it('dedupes neighbor entries against direct hits by id', async () => {
    mockPrime.mockResolvedValue(primedContext([entry('a'), entry('b')]));
    mockContext.mockResolvedValue(contextResult(['nbrX']));
    // query returns b (already a direct hit) plus new c, d
    mockProjectQuery.mockResolvedValue({
      results: [entry('b'), entry('c'), entry('d')],
      total: 3,
      l1_only: true,
    });

    const { kbSessionPrime } = await import('../../src/tools/kb-session-prime.js');
    const parsed = JSON.parse(await kbSessionPrime({ hint_symbols: ['a'] }));

    expect(parsed.top_entries.map((e: KBEntry) => e.id)).toEqual(['a', 'b', 'c', 'd']);
    const added = parsed.top_entries.filter((e: KBEntry & { via?: string }) => e.via === 'graph-neighbor');
    expect(added.map((e: KBEntry) => e.id)).toEqual(['c', 'd']);
  });

  it('graceful skip: CI provider throws -> output identical to non-expanded prime', async () => {
    const direct = primedContext([entry('a'), entry('b')]);
    mockPrime.mockResolvedValue(direct);
    mockGetProvider.mockRejectedValue(new Error('graph offline'));

    const { kbSessionPrime } = await import('../../src/tools/kb-session-prime.js');
    const withExpansion = JSON.parse(await kbSessionPrime({ hint_symbols: ['a'] }));

    // No neighbor query attempted, no additions, output matches direct hits.
    expect(mockProjectQuery).not.toHaveBeenCalled();
    expect(withExpansion.top_entries.map((e: KBEntry) => e.id)).toEqual(['a', 'b']);
    expect(withExpansion.top_entries.some((e: KBEntry & { via?: string }) => e.via)).toBe(false);
  });

  it('graceful skip: context() throws for every symbol -> no query, no additions', async () => {
    mockPrime.mockResolvedValue(primedContext([entry('a')]));
    mockContext.mockRejectedValue(new Error('boom'));

    const { kbSessionPrime } = await import('../../src/tools/kb-session-prime.js');
    const parsed = JSON.parse(await kbSessionPrime({ hint_symbols: ['a', 'b'] }));

    expect(mockProjectQuery).not.toHaveBeenCalled();
    expect(parsed.top_entries.map((e: KBEntry) => e.id)).toEqual(['a']);
  });

  it('skips expansion entirely when hint_symbols is absent', async () => {
    mockPrime.mockResolvedValue(primedContext([]));

    const { kbSessionPrime } = await import('../../src/tools/kb-session-prime.js');
    await kbSessionPrime({ session_files: [] });

    expect(mockGetProvider).not.toHaveBeenCalled();
    expect(mockProjectQuery).not.toHaveBeenCalled();
  });

  it('isError context result yields no neighbors (no query)', async () => {
    mockPrime.mockResolvedValue(primedContext([entry('a')]));
    mockContext.mockResolvedValue({ content: [{ type: 'text', text: 'Error: Unknown tool' }], isError: true });

    const { kbSessionPrime } = await import('../../src/tools/kb-session-prime.js');
    const parsed = JSON.parse(await kbSessionPrime({ hint_symbols: ['a'] }));

    expect(mockProjectQuery).not.toHaveBeenCalled();
    expect(parsed.top_entries.map((e: KBEntry) => e.id)).toEqual(['a']);
  });

  it('FTS-hostile neighbor is skipped without killing the batch', async () => {
    mockPrime.mockResolvedValue(primedContext([]));
    // "(" sanitizes to nothing; "goodName" survives.
    mockContext.mockResolvedValue(contextResult(['((', 'goodName']));
    mockProjectQuery.mockResolvedValue({ results: [entry('c')], total: 1, l1_only: true });

    const { kbSessionPrime } = await import('../../src/tools/kb-session-prime.js');
    const parsed = JSON.parse(await kbSessionPrime({ hint_symbols: ['root'] }));

    expect(mockProjectQuery).toHaveBeenCalledTimes(1);
    const passedQuery = mockProjectQuery.mock.calls[0][0].query as string;
    expect(passedQuery).toBe('"goodName"');
    expect(parsed.top_entries.map((e: KBEntry) => e.id)).toEqual(['c']);
  });

  // -- T2.1 / D4: shared OR-join helper proofs. MUST FAIL on today's code
  // (both sites use a plain join(' '), implicit AND across terms), PASS after.

  it('neighbor batch OR-joins multiple terms (not implicit AND)', async () => {
    mockPrime.mockResolvedValue(primedContext([]));
    mockContext.mockResolvedValue(contextResult(['alpha', 'beta']));
    mockProjectQuery.mockResolvedValue({ results: [], total: 0, l1_only: true });

    const { kbSessionPrime } = await import('../../src/tools/kb-session-prime.js');
    await kbSessionPrime({ hint_symbols: ['root'] });

    expect(mockProjectQuery).toHaveBeenCalledTimes(1);
    const passedQuery = mockProjectQuery.mock.calls[0][0].query as string;
    expect(passedQuery).toBe('"alpha" OR "beta"');
  });

  it('global-append OR-joins multiple hint_symbols (not implicit AND)', async () => {
    mockPrime.mockResolvedValue(primedContext([]));
    mockContext.mockResolvedValue(contextResult([]));
    mockProjectQuery.mockResolvedValue({ results: [], total: 0, l1_only: true });
    mockGlobalQuery.mockResolvedValue({ results: [], total: 0, l1_only: true });

    const { kbSessionPrime } = await import('../../src/tools/kb-session-prime.js');
    await kbSessionPrime({ hint_symbols: ['alpha', 'beta'] });

    expect(mockGlobalQuery).toHaveBeenCalledTimes(1);
    const passedQuery = mockGlobalQuery.mock.calls[0][0].query as string;
    expect(passedQuery).toBe('"alpha" OR "beta"');
  });

  it('global-append sanitizes FTS-hostile raw session_files and OR-joins them', async () => {
    mockPrime.mockResolvedValue(primedContext([]));
    mockGlobalQuery.mockResolvedValue({ results: [], total: 0, l1_only: true });

    const { kbSessionPrime } = await import('../../src/tools/kb-session-prime.js');
    await kbSessionPrime({ session_files: ['src/tools/kb-capture.ts', 'src/services/knowledge/audn.ts'] });

    expect(mockGlobalQuery).toHaveBeenCalledTimes(1);
    const passedQuery = mockGlobalQuery.mock.calls[0][0].query as string;
    // Slashes/dots are stripped (FTS5-hostile raw path chars), tokens are
    // quoted, and the two file paths are OR-joined rather than AND-joined.
    expect(passedQuery).not.toContain('/');
    expect(passedQuery).toContain(' OR ');
    expect(passedQuery).toContain('"kb"');
    expect(passedQuery).toContain('"audn"');
  });
});
