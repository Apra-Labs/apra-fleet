import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';

// Regression: an .mjs symbol answering "Target 'x' not found" from
// code_impact and "Symbol 'x' not found" from code_context although it
// exists. Cause: gitnexus 1.6.12's incremental analyze of a large repo
// overwrites symbol rows of files it did not change (a fresh index had 43297
// rows with 43297 ids; one incremental run after a one-line edit left 43298
// rows with 34011 ids). The fix: every fleet-run analyze is a full rebuild
// (--force), and a not-found answer from an index whose ids are not unique is
// flagged as unreliable with a rebuild requested. The detector's query against
// a real index is pinned in tests/code-index-corrupt-real-gitnexus.test.ts.
//
// Isolation: the gitnexus MCP child is a mocked Client (no npx is spawned);
// its callTool replays the responses gitnexus 1.6.12 gave for the live case
// (captured 2026-11-04 against a corrupt index). maybeScheduleReindex is
// stubbed and scheduleIndexBuild is the vi.fn from tests/setup.ts, so no
// analyze ever runs. Repos, GITNEXUS_HOME and APRA_FLEET_DATA_DIR live in one
// scratch dir removed in afterAll.

const sandbox = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-corrupt-')));
  const data = path.join(root, 'data');
  const gnHome = path.join(root, 'gitnexus-home');
  fs.mkdirSync(data);
  fs.mkdirSync(gnHome);
  process.env.APRA_FLEET_DATA_DIR = data;
  process.env.GITNEXUS_HOME = gnHome;
  return { root, data, gnHome };
});

const mockCallTool = vi.hoisted(() => vi.fn());

vi.mock('../src/tools/code-intelligence-reindex.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/code-intelligence-reindex.js')>();
  return { ...actual, maybeScheduleReindex: () => false };
});
vi.mock('../src/services/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/registry.js')>();
  return { ...actual, getAgent: () => ({ codeIntelProvider: 'gitnexus' }) };
});
vi.mock('../src/utils/find-on-path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/find-on-path.js')>()),
  npxUnavailableReason: () => null,
}));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class MockClient {
    connect = vi.fn(async () => undefined);
    callTool = mockCallTool;
    close = vi.fn(async () => undefined);
  }
  return { Client: MockClient };
});
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  class MockTransport {}
  return { StdioClientTransport: MockTransport };
});

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { handleCodeImpact, handleCodeContext } from '../src/tools/code-intelligence.js';
import { INDEX_ID_UNIQUENESS_QUERY, notFoundName } from '../src/tools/code-intelligence-gitnexus.js';
import { GITNEXUS_ANALYZE_ARGS } from '../src/tools/code-intelligence-reindex.js';
import { scheduleIndexBuild } from '../src/tools/code-index-heal.js';

const schedule = vi.mocked(scheduleIndexBuild);

// The .mjs symbol from the live case.
const MJS = {
  name: 'postprocessTo2020_12',
  filePath: 'memory-contract/v1/tests/postprocess-2020-12.mjs',
  id: 'Function:memory-contract/v1/tests/postprocess-2020-12.mjs:postprocessTo2020_12',
};
const HINT_IMPACT = '\n\n---\n**Next:** Review d=1 items first (WILL BREAK). To check affected execution flows, READ gitnexus://repo/r/processes.';
const HINT_CONTEXT = '\n\n---\n**Next:** If planning changes, use impact({target: "x", direction: "upstream"}) to check blast radius.';

/** gitnexus 1.6.12 impact answer for a name with no (readable) node. */
function impactNotFound(name: string): unknown {
  const payload = { error: `Target '${name}' not found`, target: { name }, direction: 'upstream', impactedCount: null, risk: 'UNKNOWN' };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) + HINT_IMPACT }] };
}

/** gitnexus 1.6.12 context answer for a name with no (readable) node. */
function contextNotFound(name: string): unknown {
  return { content: [{ type: 'text', text: JSON.stringify({ error: `Symbol '${name}' not found` }, null, 2) + HINT_CONTEXT }] };
}

function impactFound(): unknown {
  const payload = {
    target: { id: MJS.id, name: MJS.name, type: 'Function', filePath: MJS.filePath },
    direction: 'upstream', impactedCount: 2, risk: 'LOW',
  };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) + HINT_IMPACT }] };
}

function contextFound(): unknown {
  const payload = { status: 'found', symbol: { uid: MJS.id, name: MJS.name, kind: 'Function', filePath: MJS.filePath }, incoming: {}, outgoing: {} };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) + HINT_CONTEXT }] };
}

/** gitnexus 1.6.12 cypher answer: a Markdown table in { markdown, row_count }. */
function cypherIds(damaged: number): unknown {
  const total = 43298;
  const markdown = `| total | distinct_ids |\n| --- | --- |\n| ${total} | ${total - damaged} |`;
  return { content: [{ type: 'text', text: JSON.stringify({ markdown, row_count: 1 }, null, 2) }] };
}

/** A fake gitnexus child: answers `tool` with `answer`, the id probe with `damaged` rows beyond one per id. */
function fakeGitnexus(answer: unknown, damaged: number): void {
  mockCallTool.mockImplementation(async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
    if (name === 'cypher' && args.query === INDEX_ID_UNIQUENESS_QUERY) return cypherIds(damaged);
    if (name === 'impact' || name === 'context') return answer;
    throw new Error(`unexpected gitnexus call ${name}`);
  });
}

let n = 0;
function newRepo(): string {
  const dir = path.join(sandbox.root, `repo${n++}`);
  fs.mkdirSync(path.join(dir, '.gitnexus'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitnexus', 'meta.json'), JSON.stringify({ lastCommit: 'a'.repeat(40), indexedAt: '2026-01-01T00:04:00.000Z' }));
  return dir;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0].text.split('\n\n---\n')[0];
  return JSON.parse(text) as Record<string, unknown>;
}

function textsOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((c) => c.text).join('\n');
}

afterAll(() => {
  delete process.env.GITNEXUS_HOME;
  fs.rmSync(sandbox.root, { recursive: true, force: true });
});
beforeEach(() => {
  schedule.mockReset();
  schedule.mockReturnValue({ started: true });
  mockCallTool.mockReset();
});

describe('an .mjs symbol answering not found from a corrupt index (ids not unique)', () => {
  it('code_impact: the not-found answer is flagged INDEX CORRUPT with confidence LOW and a rebuild is requested', async () => {
    const repo = newRepo();
    fakeGitnexus(impactNotFound(MJS.name), 7774);
    const out = await handleCodeImpact({ target: MJS.name, direction: 'upstream' }, { repo, memberId: 'm' });
    const payload = payloadOf(out);
    expect(payload.error).toBe(`Target '${MJS.name}' not found`);
    expect(payload.index_integrity).toEqual({ corrupt: true, damaged_rows: 7774, rebuild: { started: true } });
    expect(payload.confidence).toBe('LOW');
    expect(payload.risk).toBe('UNKNOWN');
    const texts = textsOf(out);
    expect(texts).toContain(`[code-intelligence] INDEX CORRUPT: '${MJS.name}' was not found, but 7774 rows`);
    expect(texts).toContain('NOT evidence that the symbol does not exist');
    expect(texts).toContain('A full rebuild of the index has started');
    expect(texts).toContain('**Next:**');
    expect(schedule).toHaveBeenCalledWith(repo);
  });

  it('code_context: the not-found answer is flagged INDEX CORRUPT with confidence LOW and a rebuild is requested', async () => {
    const repo = newRepo();
    fakeGitnexus(contextNotFound(MJS.name), 7774);
    const out = await handleCodeContext({ name: MJS.name }, { repo, memberId: 'm' });
    const payload = payloadOf(out);
    expect(payload.error).toBe(`Symbol '${MJS.name}' not found`);
    expect(payload.index_integrity).toEqual({ corrupt: true, damaged_rows: 7774, rebuild: { started: true } });
    expect(payload.confidence).toBe('LOW');
    expect(textsOf(out)).toContain(`[code-intelligence] INDEX CORRUPT: '${MJS.name}' was not found`);
    expect(schedule).toHaveBeenCalledWith(repo);
  });

  it('a rebuild that cannot start now says why and points at code_reindex', async () => {
    const repo = newRepo();
    schedule.mockReturnValue({ started: false, reason: 'cooldown', detail: 'an index build finished less than 120s ago' });
    fakeGitnexus(impactNotFound(MJS.name), 12351);
    const out = await handleCodeImpact({ target: MJS.name, direction: 'upstream' }, { repo, memberId: 'm' });
    expect(payloadOf(out).index_integrity).toMatchObject({ damaged_rows: 12351, rebuild: { started: false, reason: 'cooldown' } });
    expect(textsOf(out)).toContain('No rebuild started (cooldown: an index build finished less than 120s ago); run code_reindex');
  });

  it('after the full rebuild the .mjs symbol resolves through code_impact and code_context, unflagged', async () => {
    const repo = newRepo();
    fakeGitnexus(impactFound(), 0);
    const impact = await handleCodeImpact({ target: MJS.name, direction: 'upstream' }, { repo, memberId: 'm' }) as Record<string, unknown>;
    expect(payloadOf(impact)).toMatchObject({ target: { id: MJS.id, filePath: MJS.filePath }, risk: 'LOW' });
    expect(payloadOf(impact).index_integrity).toBeUndefined();
    expect(impact.resolution_mismatch).toBeUndefined();
    expect(impact.confidence).toBeUndefined();

    fakeGitnexus(contextFound(), 0);
    const ctx = await handleCodeContext({ name: MJS.name }, { repo, memberId: 'm' }) as Record<string, unknown>;
    expect(payloadOf(ctx)).toMatchObject({ status: 'found', symbol: { uid: MJS.id, filePath: MJS.filePath } });
    expect(ctx.resolution_mismatch).toBeUndefined();
    expect(ctx.confidence).toBeUndefined();
    // A found answer never costs an integrity probe.
    expect(mockCallTool.mock.calls.map((c) => (c[0] as { name: string }).name)).not.toContain('cypher');
    expect(schedule).not.toHaveBeenCalled();
  });

  it('a genuinely missing symbol in a healthy index (ids unique) is returned unchanged, no rebuild', async () => {
    const repo = newRepo();
    const answer = impactNotFound('noSuchSymbol');
    fakeGitnexus(answer, 0);
    const out = await handleCodeImpact({ target: 'noSuchSymbol', direction: 'upstream' }, { repo, memberId: 'm' }) as Record<string, unknown>;
    expect(payloadOf(out).index_integrity).toBeUndefined();
    expect(payloadOf(out).confidence).toBeUndefined();
    expect(textsOf(out)).not.toContain('INDEX CORRUPT');
    expect(schedule).not.toHaveBeenCalled();
  });

  it('notFoundName reads both gitnexus not-found shapes and nothing else', () => {
    expect(notFoundName(impactNotFound(MJS.name))).toBe(MJS.name);
    expect(notFoundName(contextNotFound(MJS.name))).toBe(MJS.name);
    expect(notFoundName(impactFound())).toBeNull();
    expect(notFoundName({ content: [{ type: 'text', text: 'boom' }], isError: true })).toBeNull();
    expect(notFoundName({ content: [{ type: 'text', text: 'not json' }] })).toBeNull();
  });

  it('every fleet-run analyze is a full rebuild (--force), so incremental writeback never corrupts the index', () => {
    expect(GITNEXUS_ANALYZE_ARGS).toContain('--index-only');
    expect(GITNEXUS_ANALYZE_ARGS).toContain('--force');
  });

  it('every analyze command the /pm index skill and the member remediation give is a full rebuild', () => {
    for (const file of ['packages/apra-fleet-se/apra-pm/skills/pm/index.md', 'packages/apra-fleet-se/fleet-sprint/member-init-probe.mjs']) {
      const text = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf-8');
      const commands = text.split('\n').filter((line) => /npx (?:-y )?gitnexus(?:@\S+)? analyze/.test(line));
      expect(commands.length, file).toBeGreaterThan(0);
      for (const line of commands) expect(line).toContain('--force');
    }
  });
});
