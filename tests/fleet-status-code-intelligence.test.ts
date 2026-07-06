import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  codeIntelligenceHealth,
  codeIntelligenceCompactLine,
} from '../src/tools/check-status.js';

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
});
