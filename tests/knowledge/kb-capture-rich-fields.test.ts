import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// Design D9/D3 storage half: kb_capture's optional content (defaults to the
// summary), recall_cues / error_signatures / trigger round-tripped through the
// store, kb_invalidate {ids, reason} storing a retirement note, and the
// additive migration of a database created before those columns existed.
// Runs the real kb_capture / kb_invalidate handlers against a real
// SqliteProvider; only the session-scope resolution is stubbed to hand them
// that provider.

const providerState = vi.hoisted(() => ({ p: undefined as unknown }));

vi.mock('../../src/services/tool-scope.js', () => ({
  getSessionMemberId: () => undefined,
  getSessionKbMaintainer: () => false,
}));
vi.mock('../../src/services/knowledge/kb-self.js', () => ({
  getSelfKbProviders: async () => ({ project: providerState.p, global: providerState.p, projectSlug: 'slug' }),
  memberOwnerTag: () => undefined,
}));

import { kbCapture, kbCaptureSchema } from '../../src/tools/kb-capture.js';
import { kbInvalidate, kbInvalidateSchema } from '../../src/tools/kb-invalidate.js';

let provider: SqliteProvider;

beforeEach(async () => {
  provider = new SqliteProvider(':memory:');
  await provider.init();
  providerState.p = provider;
});
afterEach(() => provider.close());

const capture = async (args: Record<string, unknown>) =>
  JSON.parse(await kbCapture(kbCaptureSchema.parse({ type: 'learning', source_files: ['src/a.ts'], ...args })));
const getById = async (id: string) => (await provider.query({ ids: [id] })).results[0];

describe('kb_capture rich fields', () => {
  it('stores content equal to the summary when content is omitted', async () => {
    const { id, audn_decision } = await capture({ title: 'no content', summary: 'Summary only, no content field given.', symbols: ['symNoContent'] });
    expect(audn_decision).toBe('add');
    const e = await getById(id);
    expect(e.content).toBe('Summary only, no content field given.');
    expect(e.recall_cues).toEqual([]);
    expect(e.error_signatures).toEqual([]);
    expect(e.trigger).toBeUndefined();
  });

  it('schema: content is optional but still min 1 when present', () => {
    expect(kbCaptureSchema.safeParse({ type: 'learning', title: 't', summary: 's' }).success).toBe(true);
    expect(kbCaptureSchema.safeParse({ type: 'learning', title: 't', summary: 's', content: '' }).success).toBe(false);
    expect(kbCaptureSchema.safeParse({ type: 'learning', title: 't', summary: 's', trigger: 'describes-the-change' }).success).toBe(false);
  });

  it('round-trips recall_cues, error_signatures and trigger through a read (query by id and list)', async () => {
    const { id } = await capture({
      title: 'rich capture',
      summary: 'Rich capture summary.',
      content: 'Rich capture full content body.',
      symbols: ['symRich'],
      trigger: 'test-failure',
      recall_cues: ['why does the sweep stale this', 'freshness anchor missing'],
      error_signatures: ['E-SELF-NO-REMOTE', 'TypeError: x is undefined'],
    });
    const e = await getById(id);
    expect(e.content).toBe('Rich capture full content body.');
    expect(e.recall_cues).toEqual(['why does the sweep stale this', 'freshness anchor missing']);
    expect(e.error_signatures).toEqual(['E-SELF-NO-REMOTE', 'TypeError: x is undefined']);
    expect(e.trigger).toBe('test-failure');

    const listed = (await provider.list({ confidence: ['INFERRED'] })).find(x => x.id === id)!;
    expect(listed.recall_cues).toEqual(e.recall_cues);
    expect(listed.error_signatures).toEqual(e.error_signatures);
    expect(listed.trigger).toBe('test-failure');
  });

  it('provider.capture sanitizes a deserialized body: non-string elements and out-of-enum trigger are dropped', async () => {
    const input = {
      type: 'learning', title: 'http body', summary: 'HTTP body summary.', content: 'HTTP body content.',
      source_files: ['src/a.ts'], symbols: ['symHttp'], tags: [],
      content_hash: '', content_hash_type: 'sha256', flagged_for_review: false,
      author: 'unknown', source: 'session', confidence: 'INFERRED',
      recall_cues: ['ok', 7, null], error_signatures: 'not-an-array', trigger: 'bogus',
    } as unknown as KBEntryInput;
    const { id } = await provider.capture(input);
    const e = await getById(id);
    expect(e.recall_cues).toEqual(['ok']);
    expect(e.error_signatures).toEqual([]);
    expect(e.trigger).toBeUndefined();
  });
});

describe('kb_invalidate {ids, reason}', () => {
  it('stores the reason as the retirement note of every retired id', async () => {
    const a = await capture({ title: 'retire a', summary: 'Retire a summary.', symbols: ['symRetireA'] });
    const b = await capture({ title: 'retire b', summary: 'Retire b summary.', symbols: ['symRetireB'] });
    const out = JSON.parse(await kbInvalidate(kbInvalidateSchema.parse({ ids: [a.id, b.id], reason: 'captured the change, not a lesson' })));
    expect(out).toEqual({ discarded: [a.id, b.id], not_found: [], already_discarded: [] });
    for (const id of [a.id, b.id]) {
      const e = await getById(id);
      expect(e.superseded_at).toBeTruthy();
      expect(e.retired_note).toBe('captured the change, not a lesson');
    }
    // The internal retired_reason is untouched: bible-commit still reports 'invalidated'.
    expect(provider.getRetirementReasons([a.id]).get(a.id)).toBe('invalidated');
  });

  it('without reason the note stays empty and the response shape is unchanged', async () => {
    const a = await capture({ title: 'retire plain', summary: 'Retire plain summary.', symbols: ['symRetirePlain'] });
    const out = JSON.parse(await kbInvalidate(kbInvalidateSchema.parse({ ids: [a.id] })));
    expect(Object.keys(out).sort()).toEqual(['already_discarded', 'discarded', 'not_found']);
    expect(out).toEqual({ discarded: [a.id], not_found: [], already_discarded: [] });
    const e = await getById(a.id);
    expect(e.retired_note).toBeUndefined();
    const row = (provider as any).getDb().prepare('SELECT retired_note FROM entries WHERE id = ?').get(a.id);
    expect(row.retired_note).toBeNull();
  });

  it('refuses reason together with files', async () => {
    await expect(kbInvalidate(kbInvalidateSchema.parse({ files: ['src/a.ts'], reason: 'nope' }))).rejects.toThrow(/reason is accepted only together with ids/);
  });
});

describe('pre-migration database', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-rich-migrate-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('opens a DB without the new columns, migrates it and keeps every row', async () => {
    const dbPath = path.join(tmp, 'kb.sqlite');
    // Build a DB with the current schema, write a row, then strip the four
    // new columns so the file is exactly what an older build left behind.
    const old = new SqliteProvider(dbPath);
    await old.init();
    const { id } = await old.capture({
      type: 'knowledge', title: 'legacy row', summary: 'Legacy summary.', content: 'Legacy content that predates D9.',
      source_files: ['src/a.ts'], symbols: ['symLegacy'], tags: ['keep'],
      content_hash: '', content_hash_type: 'sha256', flagged_for_review: false,
      author: 'doer', source: 'session', confidence: 'INFERRED',
    });
    old.close();
    const raw = new DatabaseSync(dbPath);
    for (const col of ['recall_cues', 'error_signatures', 'trigger', 'retired_note']) {
      raw.exec(`ALTER TABLE entries DROP COLUMN ${col}`);
    }
    const colsBefore = (raw.prepare('PRAGMA table_info(entries)').all() as { name: string }[]).map(c => c.name);
    raw.close();
    expect(colsBefore).not.toContain('recall_cues');
    expect(colsBefore).not.toContain('retired_note');

    const p = new SqliteProvider(dbPath);
    await p.init();
    try {
      const e = (await p.query({ ids: [id] })).results[0];
      expect(e.title).toBe('legacy row');
      expect(e.content).toBe('Legacy content that predates D9.');
      expect(e.tags).toEqual(['keep']);
      expect(e.symbols).toEqual(['symLegacy']);
      expect(e.recall_cues).toEqual([]);
      expect(e.error_signatures).toEqual([]);
      expect(e.trigger).toBeUndefined();
      expect(e.retired_note).toBeUndefined();
      const colsAfter = ((p as any).getDb().prepare('PRAGMA table_info(entries)').all() as { name: string }[]).map(c => c.name);
      expect(colsAfter).toEqual(expect.arrayContaining(['recall_cues', 'error_signatures', 'trigger', 'retired_note']));
      // The migrated DB accepts the new fields.
      providerState.p = p;
      const { id: id2 } = await capture({ title: 'after migrate', summary: 'After migrate summary.', symbols: ['symAfter'], recall_cues: ['cue'] });
      expect((await p.query({ ids: [id2] })).results[0].recall_cues).toEqual(['cue']);
    } finally {
      p.close();
    }
  });
});
