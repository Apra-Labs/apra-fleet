import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  codeIntelligenceHealth,
  codeIntelligenceCompactLine,
  computeTopSymbols,
  fleetStatus,
} from '../src/tools/check-status.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';

vi.mock('../src/services/strategy.js', () => ({
  getStrategy: () => ({
    execCommand: vi.fn().mockResolvedValue({ stdout: 'idle', stderr: '', code: 0 }),
    testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 }),
    transferFiles: vi.fn(),
    close: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// codeIntelligenceHealth() / codeIntelligenceCompactLine() (F3.3)
//
// Read-only, fast, no MCP child spawn, no network. Must degrade gracefully
// (never throw) when meta.json is missing/unparseable or git is unavailable.
// ---------------------------------------------------------------------------
describe('codeIntelligenceHealth()', () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = mkdtempSync(join(tmpdir(), 'code-intel-status-test-'));
  });

  afterEach(() => {
    rmSync(tempRepo, { recursive: true, force: true });
  });

  it('(a) reports absent when the repo has no .gitnexus directory', () => {
    const health = codeIntelligenceHealth(tempRepo);
    expect(health.present).toBe(false);
  });

  it('(b) degrades gracefully when meta.json is present but git is unavailable', () => {
    mkdirSync(join(tempRepo, '.gitnexus'), { recursive: true });
    writeFileSync(
      join(tempRepo, '.gitnexus', 'meta.json'),
      JSON.stringify({
        lastCommit: 'abc123ef0000111122223333444455556666aaaa',
        indexedAt: '2026-07-01T00:00:00.000Z',
        stats: { files: 10, nodes: 20, edges: 30 },
      }),
    );

    // tempRepo is not a git repository, so `git rev-parse HEAD` fails there --
    // this exercises the "git unavailable" degrade path without needing to
    // mock child_process.
    const health = codeIntelligenceHealth(tempRepo);

    expect(health.present).toBe(true);
    expect(health.headStatus).toBe('unavailable');
    // Never throws -- the caller always gets a usable object back.
    expect(() => codeIntelligenceCompactLine(health)).not.toThrow();
  });

  it('(c) parses stats/indexedAt/lastCommit fields from meta.json', () => {
    mkdirSync(join(tempRepo, '.gitnexus'), { recursive: true });
    writeFileSync(
      join(tempRepo, '.gitnexus', 'meta.json'),
      JSON.stringify({
        lastCommit: 'deadbeef00001111222233334444555566667777',
        indexedAt: '2026-07-05T12:00:00.000Z',
        stats: { files: 90, nodes: 1234, edges: 5678 },
      }),
    );

    const health = codeIntelligenceHealth(tempRepo);

    expect(health.present).toBe(true);
    expect(health.files).toBe(90);
    expect(health.nodes).toBe(1234);
    expect(health.edges).toBe(5678);
    expect(health.indexedAt).toBe('2026-07-05T12:00:00.000Z');
    expect(health.lastCommit).toBe('deadbeef00001111222233334444555566667777');
  });

  it('never throws when meta.json contains invalid JSON', () => {
    mkdirSync(join(tempRepo, '.gitnexus'), { recursive: true });
    writeFileSync(join(tempRepo, '.gitnexus', 'meta.json'), '{ not valid json');

    expect(() => codeIntelligenceHealth(tempRepo)).not.toThrow();
    const health = codeIntelligenceHealth(tempRepo);
    expect(health.present).toBe(false);
  });

  it('never throws when the repo directory itself does not exist', () => {
    const missingDir = join(tempRepo, 'does-not-exist');
    expect(() => codeIntelligenceHealth(missingDir)).not.toThrow();
    expect(codeIntelligenceHealth(missingDir).present).toBe(false);
  });
});

describe('codeIntelligenceCompactLine()', () => {
  it('renders the no-index line verbatim when absent', () => {
    const line = codeIntelligenceCompactLine({ present: false });
    expect(line).toBe("code-intel: no index (run 'npx gitnexus analyze' or /pm index)");
  });

  it('renders nodes/edges/files, indexedAt, and matching HEAD', () => {
    const line = codeIntelligenceCompactLine({
      present: true,
      nodes: 1234,
      edges: 5678,
      files: 90,
      indexedAt: '2026-07-05T12:00:00.000Z',
      lastCommit: 'deadbeef00001111222233334444555566667777',
      headStatus: 'matching',
    });
    expect(line).toBe(
      'code-intel: index present | 1234 nodes / 5678 edges / 90 files | indexed 2026-07-05T12:00:00.000Z | matching HEAD',
    );
  });

  it('renders "N commits behind HEAD" when behind', () => {
    const line = codeIntelligenceCompactLine({
      present: true,
      nodes: 1,
      edges: 2,
      files: 3,
      indexedAt: '2026-07-05T12:00:00.000Z',
      lastCommit: 'deadbeef00001111222233334444555566667777',
      headStatus: 'behind',
      commitsBehind: 5,
    });
    expect(line).toContain('5 commits behind HEAD');
  });

  it('renders the unavailable fragment with an 8-char lastCommit prefix', () => {
    const line = codeIntelligenceCompactLine({
      present: true,
      nodes: 1,
      edges: 2,
      files: 3,
      indexedAt: '2026-07-05T12:00:00.000Z',
      lastCommit: 'deadbeef00001111222233334444555566667777',
      headStatus: 'unavailable',
    });
    expect(line).toContain('indexed deadbeef, HEAD comparison unavailable');
  });

  it('appends the top-symbols fragment when present', () => {
    const line = codeIntelligenceCompactLine({
      present: true,
      nodes: 1,
      edges: 2,
      files: 3,
      indexedAt: '2026-07-05T12:00:00.000Z',
      lastCommit: 'deadbeef00001111222233334444555566667777',
      headStatus: 'matching',
      topSymbols: [{ target: 'a', count: 12 }, { target: 'b', count: 9 }],
    });
    expect(line).toBe(
      'code-intel: index present | 1 nodes / 2 edges / 3 files | indexed 2026-07-05T12:00:00.000Z | matching HEAD | top symbols (30d): a (12), b (9)',
    );
  });

  it('omits the top-symbols fragment entirely when absent', () => {
    const line = codeIntelligenceCompactLine({ present: true, headStatus: 'matching' });
    expect(line).not.toContain('top symbols');
  });

  it('appends the top-symbols fragment even on the no-index line', () => {
    const line = codeIntelligenceCompactLine({
      present: false,
      topSymbols: [{ target: 'x', count: 1 }],
    });
    expect(line).toBe("code-intel: no index (run 'npx gitnexus analyze' or /pm index) | top symbols (30d): x (1)");
  });
});

// ---------------------------------------------------------------------------
// computeTopSymbols() (T4.2, design D8 read spec)
//
// Single pass over usage.jsonl AND usage.jsonl.1 (if present), 30-day
// window, aggregate count by target, top 5. Never throws -- no file, an
// unreadable file, or any other error degrades to undefined (segment
// omitted). computeTopSymbols() takes the usage/rotated paths as optional
// overrides (defaulting to the real ~/.apra-fleet paths) purely so tests can
// point it at real temp files instead of mocking fs.
// ---------------------------------------------------------------------------
describe('computeTopSymbols()', () => {
  let usageDir: string;
  let usagePath: string;
  let rotatedPath: string;
  const NOW = new Date('2026-07-06T00:00:00.000Z').getTime();

  function line(target: string, daysAgo: number): string {
    const ts = new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    return JSON.stringify({ ts, tool: 'code_graph', target, repo: null });
  }

  beforeEach(() => {
    usageDir = mkdtempSync(join(tmpdir(), 'code-intel-top-symbols-test-'));
    usagePath = join(usageDir, 'usage.jsonl');
    rotatedPath = join(usageDir, 'usage.jsonl.1');
  });

  afterEach(() => {
    rmSync(usageDir, { recursive: true, force: true });
  });

  it('returns undefined when neither usage file exists', () => {
    expect(computeTopSymbols(NOW, usagePath, rotatedPath)).toBeUndefined();
  });

  it('aggregates counts by target and returns the top 5 by count, descending', () => {
    const lines = [
      line('a', 1), line('a', 1), line('a', 1),
      line('b', 1), line('b', 1),
      line('c', 1),
      line('d', 1),
      line('e', 1),
      line('f', 1),
    ];
    writeFileSync(usagePath, lines.join('\n') + '\n');

    const top = computeTopSymbols(NOW, usagePath, rotatedPath);

    expect(top).toBeDefined();
    expect(top!.length).toBe(5);
    expect(top![0]).toEqual({ target: 'a', count: 3 });
    expect(top![1]).toEqual({ target: 'b', count: 2 });
    // c, d, e, f are tied at 1 -- exactly one of them is dropped to respect
    // the top-5 cap, and the remaining four keep count 1 each.
    expect(top!.slice(2).every((s) => s.count === 1)).toBe(true);
  });

  it('returns fewer than 5 entries when fewer than 5 distinct targets exist', () => {
    writeFileSync(usagePath, [line('a', 1), line('b', 1), line('b', 1)].join('\n') + '\n');

    const top = computeTopSymbols(NOW, usagePath, rotatedPath);

    expect(top).toEqual([{ target: 'b', count: 2 }, { target: 'a', count: 1 }]);
  });

  it('excludes entries older than 30 days', () => {
    writeFileSync(usagePath, [line('recent', 1), line('old', 31)].join('\n') + '\n');

    const top = computeTopSymbols(NOW, usagePath, rotatedPath);

    expect(top).toEqual([{ target: 'recent', count: 1 }]);
  });

  it('includes an entry exactly at the 30-day boundary', () => {
    writeFileSync(usagePath, line('boundary', 30) + '\n');

    const top = computeTopSymbols(NOW, usagePath, rotatedPath);

    expect(top).toEqual([{ target: 'boundary', count: 1 }]);
  });

  it('reads usage.jsonl.1 in addition to usage.jsonl', () => {
    writeFileSync(usagePath, line('fromCurrent', 1) + '\n');
    writeFileSync(rotatedPath, [line('fromRotated', 1), line('fromRotated', 1)].join('\n') + '\n');

    const top = computeTopSymbols(NOW, usagePath, rotatedPath);

    expect(top).toEqual(
      expect.arrayContaining([
        { target: 'fromRotated', count: 2 },
        { target: 'fromCurrent', count: 1 },
      ]),
    );
    expect(top!.length).toBe(2);
  });

  it('skips unparseable lines without throwing', () => {
    writeFileSync(usagePath, ['not valid json', line('ok', 1), '{ also not valid'].join('\n') + '\n');

    expect(() => computeTopSymbols(NOW, usagePath, rotatedPath)).not.toThrow();
    expect(computeTopSymbols(NOW, usagePath, rotatedPath)).toEqual([{ target: 'ok', count: 1 }]);
  });

  it('skips lines missing ts or target without throwing', () => {
    writeFileSync(
      usagePath,
      [
        JSON.stringify({ tool: 'code_graph', target: 'noTs', repo: null }),
        JSON.stringify({ ts: new Date(NOW).toISOString(), tool: 'code_graph', repo: null }),
        line('ok', 1),
      ].join('\n') + '\n',
    );

    expect(computeTopSymbols(NOW, usagePath, rotatedPath)).toEqual([{ target: 'ok', count: 1 }]);
  });

  it('returns undefined when the usage file exists but every line is unparseable/out of window', () => {
    writeFileSync(usagePath, ['garbage', line('old', 100)].join('\n') + '\n');

    expect(computeTopSymbols(NOW, usagePath, rotatedPath)).toBeUndefined();
  });

  it('never throws when the usage path points at a directory instead of a file', () => {
    // readFileSync on a directory throws EISDIR -- must degrade to undefined.
    expect(() => computeTopSymbols(NOW, usageDir, rotatedPath)).not.toThrow();
    expect(computeTopSymbols(NOW, usageDir, rotatedPath)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fleetStatus() per-member codeIntelProvider display (apra-fleet-c6o.1.3)
// ---------------------------------------------------------------------------
describe('fleetStatus per-member code-intel provider display', () => {
  beforeEach(() => {
    backupAndResetRegistry();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('shows code-intel=<provider> in compact output for a member that has it set', async () => {
    const member = makeTestAgent({ friendlyName: 'ci-member', codeIntelProvider: 'gitnexus' });
    addAgent(member);

    const result = await fleetStatus({ format: 'compact' });
    expect(result).toContain('code-intel=gitnexus');
  });

  it('omits code-intel= from compact output for a member without it set', async () => {
    const member = makeTestAgent({ friendlyName: 'no-ci-member' });
    addAgent(member);

    const result = await fleetStatus({ format: 'compact' });
    expect(result).not.toContain('code-intel=');
  });

  it('includes codeIntelProvider in JSON member rows for a member that has it set', async () => {
    const member = makeTestAgent({ friendlyName: 'ci-json-member', codeIntelProvider: 'codebase-memory' });
    addAgent(member);

    const result = await fleetStatus({ format: 'json' });
    const parsed = JSON.parse(result);
    const row = parsed.members.find((m: { name: string }) => m.name === 'ci-json-member');
    expect(row.codeIntelProvider).toBe('codebase-memory');
  });
});
