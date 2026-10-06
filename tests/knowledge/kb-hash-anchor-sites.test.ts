import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { computeFileHashBatch } from '../../src/services/knowledge/file-hash.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// Per-site pins for SqliteProvider's repo anchor on relative source paths:
// freshness lookup (context), contradiction-resolution revival, and the
// reconcile prefilter. Each uses a RELATIVE basis and a process.cwd() that is
// NOT the repo, so each FAILS if that site's hash call loses the repo anchor
// (i.e. if hashAnchored() is bypassed by a bare computeFileHashBatch(files),
// the hashes resolve against the foreign cwd and never match).
// No tool layer here: the provider is exercised directly.

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'knowledge',
    title: 'anchor site entry',
    summary: 'anchor site summary',
    content: 'anchor site content',
    source_files: ['src/a.ts'],
    symbols: [],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'test-agent',
    source: 'session',
    confidence: 'INFERRED',
    ...overrides,
  };
}

let repoDir: string;
let otherCwd: string;
let prevCwd: string;
let provider: SqliteProvider;

beforeEach(async () => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-anchor-sites-repo-'));
  otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-anchor-sites-cwd-'));
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src/a.ts'), 'export const a = 1;');
  fs.writeFileSync(path.join(repoDir, 'src/b.ts'), 'export const b = 1;');
  prevCwd = process.cwd();
  process.chdir(otherCwd);
  provider = new SqliteProvider(':memory:', repoDir);
  await provider.init();
});

afterEach(() => {
  process.chdir(prevCwd);
  provider.close();
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(otherCwd, { recursive: true, force: true });
});

function raw(id: string): { stale: number; superseded_at: string | null; confidence: string } {
  return (provider as any).getDb()
    .prepare('SELECT stale, superseded_at, confidence FROM entries WHERE id = ?').get(id);
}

describe('SqliteProvider repo anchor on relative basis paths (cwd != repo)', () => {
  it('freshness lookup (context) reports a relative context-cache entry as fresh', async () => {
    const hash = (await computeFileHashBatch(['src/a.ts'], { cwd: repoDir }))['src/a.ts']!.hash;
    await provider.capture(makeInput({
      type: 'context-cache', title: 'ctx a entry', content_hash: hash, source_file: 'src/a.ts', source_files: ['src/a.ts'],
    }));
    const [res] = await provider.context(['src/a.ts']);
    expect(res.status).toBe('fresh');
  });

  it('contradiction-resolution winner whose relative basis matches is un-staled', async () => {
    const a = await provider.capture(makeInput({ title: 'winner claim token', content: 'winner body' }));
    const b = await provider.capture(makeInput({
      title: 'loser claim token', content: 'loser body', source_files: ['src/b.ts'],
    }));
    const db = (provider as any).getDb();
    db.prepare('UPDATE entries SET contradiction_of = ? WHERE id = ?').run(a.id, b.id);
    db.prepare('UPDATE entries SET stale = 1 WHERE id = ?').run(a.id);
    expect(raw(a.id).stale).toBe(1);
    await provider.resolveContradiction(a.id, b.id, 'test evidence');
    expect(raw(a.id).stale).toBe(0);
    expect(raw(a.id).confidence).toBe('CONFIRMED');
  });

  it('reconcile prefilter settles a pair mechanically (nothing left for the agent)', async () => {
    const a = await provider.capture(makeInput({
      title: 'gammaSym is broken report', summary: 'gammaSym broken', content: 'gammaSym is broken.',
      source_files: ['src/a.ts'],
    }));
    // The challenger is a contradiction of the original with a basis that no
    // longer matches (its file changes after capture).
    const b = await provider.capture(makeInput({
      title: 'gammaSym is fixed report', summary: 'gammaSym is fixed as of the latest release.',
      content: 'gammaSym is fixed as of the latest release.', source_files: ['src/b.ts'],
    }));
    const db = (provider as any).getDb();
    db.prepare('UPDATE entries SET flagged_for_review = 1 WHERE id = ?').run(a.id);
    db.prepare('UPDATE entries SET contradiction_of = ? WHERE id = ?').run(a.id, b.id);
    fs.writeFileSync(path.join(repoDir, 'src/b.ts'), 'export const b = 2;');

    const report = await provider.reconcilePrefilter();
    expect(report.left_for_agent).toEqual([]);
    expect(report.resolved).toEqual([{ winnerId: a.id, loserId: b.id }]);
  });
});

// Reverting the anchor fix (hashAnchored -> bare computeFileHashBatch(files))
// makes all three tests above, and kb-reconcile-e2e, fail.
