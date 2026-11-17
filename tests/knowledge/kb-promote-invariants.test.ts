import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';

/**
 * Phase 1 of docs/superpowers/specs/2026-08-03-kb-trust-pipeline-design.md.
 *
 * promote() is the ONLY path that mints CONFIRMED (capture clamps every
 * incoming CONFIRMED down to INFERRED), so it carries the two gates that make a
 * CONFIRMED entry auditable: a recorded evidence string, and a basis that still
 * resolves against the tree it is being verified on.
 */

let tmp: string;
let repo: string;
let provider: SqliteProvider;

const GOOD_REASON = 'Verified against src/real.ts: the retry budget is read once at startup.';

function entry(over: Record<string, unknown> = {}) {
  return {
    type: 'knowledge' as const,
    title: 'A promotable entry',
    summary: 'A summary',
    content: 'Some content about the repository.',
    source_files: ['src/real.ts'],
    symbols: ['realSymbol'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256' as const,
    flagged_for_review: false,
    author: 'test',
    source: 'session' as const,
    confidence: 'INFERRED' as const,
    ...over,
  };
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-promote-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'real.ts'), 'export const real = 1;\n');

  provider = new SqliteProvider(':memory:', repo);
  await provider.init();
});

afterEach(() => {
  provider.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('kb_promote requires a recorded evidence string', () => {
  it('promotes INFERRED to CONFIRMED when given a real reason', async () => {
    const { id } = await provider.capture(entry());
    const res = await provider.promote(id, GOOD_REASON);
    expect(res.confidence_before).toBe('INFERRED');
    expect(res.confidence_after).toBe('CONFIRMED');
  });

  it('refuses a promotion with no reason at all', async () => {
    const { id } = await provider.capture(entry());
    await expect(provider.promote(id)).rejects.toThrow(/requires a reason/);
  });

  it.each(['', '   ', 'ok', 'lgtm', 'verified', 'looks right'])(
    'refuses the trivial reason %j',
    async (reason) => {
      const { id } = await provider.capture(entry({ title: 'entry for ' + JSON.stringify(reason) }));
      await expect(provider.promote(id, reason)).rejects.toThrow(/requires a reason/);
    }
  );

  it('leaves the entry unpromoted after a refusal', async () => {
    const { id } = await provider.capture(entry());
    await expect(provider.promote(id, 'ok')).rejects.toThrow();
    const stored = (await provider.query({ ids: [id] })).results[0];
    expect(stored.confidence).toBe('INFERRED');
  });

  it('records the reason in the promoted entry content', async () => {
    const { id } = await provider.capture(entry());
    await provider.promote(id, GOOD_REASON);
    const stored = (await provider.query({ ids: [id] })).results[0];
    expect(stored.content).toContain(GOOD_REASON);
  });
});

describe('kb_promote refuses an entry whose basis no longer resolves', () => {
  it('refuses when a cited source file has been deleted since capture', async () => {
    const { id } = await provider.capture(entry());
    fs.rmSync(path.join(repo, 'src', 'real.ts'));

    await expect(provider.promote(id, GOOD_REASON)).rejects.toThrow(/basis does not resolve/);
  });

  it('names the missing file in the refusal', async () => {
    const { id } = await provider.capture(entry());
    fs.rmSync(path.join(repo, 'src', 'real.ts'));

    await expect(provider.promote(id, GOOD_REASON)).rejects.toThrow(/src\/real\.ts/);
  });

  it('refuses a pre-existing row that cites no source files at all', async () => {
    // capture() now refuses these, but rows predating the rule still exist and
    // are exactly the structurally unfalsifiable entries -- promote must not
    // mint CONFIRMED for one. Simulate such a row by clearing the basis after
    // capture, which is the only way to produce one now.
    const { id } = await provider.capture(entry({ title: 'basis to be cleared' }));
    (provider as any).getDb()
      .prepare('UPDATE entries SET source_files = ? WHERE id = ?')
      .run(JSON.stringify([]), id);

    await expect(provider.promote(id, GOOD_REASON)).rejects.toThrow(/cites no source files/);
  });

  it('still promotes when every cited file is present', async () => {
    const { id } = await provider.capture(entry({ source_files: ['src/real.ts'] }));
    const res = await provider.promote(id, GOOD_REASON);
    expect(res.confidence_after).toBe('CONFIRMED');
  });
});
