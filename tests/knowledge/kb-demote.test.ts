import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';

// kb_demote provider behaviour (workstream A verification). Everything here runs
// against a REAL SqliteProvider -- no mocks, no fakes -- and every outcome is
// asserted by reading the row back out of SQLite, because the thing under test
// is what is PERSISTED, not what the method returned.

const REASON = 'the cited basis file was rewritten and no longer supports this claim';

function makeInput(overrides: Partial<KBEntryInput> = {}): KBEntryInput {
  return {
    type: 'learning',
    title: 'demoteSymbol test entry',
    summary: 'An entry used to exercise the demotion ladder',
    content: 'Behavior involving demoteSymbol.',
    source_files: [],
    symbols: ['demoteSymbol'],
    tags: [],
    content_hash: '',
    content_hash_type: 'sha256',
    flagged_for_review: false,
    author: 'test-agent',
    source: 'doer',
    confidence: 'INFERRED',
    ...overrides,
  };
}

function rawRow(p: SqliteProvider, id: string): Record<string, unknown> | undefined {
  return (p as any).getDb()
    .prepare('SELECT * FROM entries WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
}

function columnNames(p: SqliteProvider): string[] {
  const rows = (p as any).getDb().prepare('PRAGMA table_info(entries)').all() as { name: string }[];
  return rows.map(r => r.name);
}

let provider: SqliteProvider;
// A provider WITH a repo anchor. unresolvableBasisFiles only reports a relative
// path when the provider is anchored, so the evidence-resolution refusal is only
// reachable here -- an unanchored (global) KB cannot check a relative path at all.
let anchored: SqliteProvider;
let tmpDir: string;
let basisFile: string;
const BASIS_CONTENT = 'export const demoted = true;';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-demote-test-'));
  basisFile = path.join(tmpDir, 'basis.ts');
  fs.writeFileSync(basisFile, BASIS_CONTENT);
  fs.writeFileSync(path.join(tmpDir, 'evidence.ts'), 'export const evidence = true;');
  provider = new SqliteProvider(':memory:');
  await provider.init();
  anchored = new SqliteProvider(':memory:', tmpDir);
  await anchored.init();
});

afterEach(() => {
  provider.close();
  anchored.close();
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** capture() clamps CONFIRMED -> INFERRED, so CONFIRMED is only reachable up the ladder. */
async function captureConfirmed(): Promise<string> {
  const { id } = await provider.capture(makeInput({ source_files: [basisFile] }));
  await provider.promote(id, 'verified against the seeded tree for this test fixture');
  return id;
}

describe('SqliteProvider.demote -- schema', () => {
  it('a freshly created DB has demoted_at and demoted_basis_hashes', () => {
    const cols = columnNames(provider);
    expect(cols).toContain('demoted_at');
    expect(cols).toContain('demoted_basis_hashes');
  });

  it('a DB created WITHOUT the demoted columns gains them on open, rows intact', async () => {
    // There is no migration framework: the swallowed ALTER in init() is the ONLY
    // mechanism, so an on-disk DB predating this change is built here verbatim
    // (no demoted_* columns, and no source_file_hashes either) and reopened.
    const legacyPath = path.join(tmpDir, 'legacy.sqlite');
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(
      'CREATE TABLE entries ('
      + 'id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,'
      + 'summary TEXT NOT NULL, content TEXT NOT NULL,'
      + "source_files TEXT NOT NULL DEFAULT '[]', symbols TEXT NOT NULL DEFAULT '[]',"
      + "module TEXT, tags TEXT NOT NULL DEFAULT '[]',"
      + "content_hash TEXT NOT NULL DEFAULT '', content_hash_type TEXT NOT NULL DEFAULT 'sha256',"
      + 'stale INTEGER NOT NULL DEFAULT 0, flagged_for_review INTEGER NOT NULL DEFAULT 0,'
      + "contradiction_of TEXT, author TEXT NOT NULL DEFAULT '',"
      + "source TEXT NOT NULL DEFAULT 'doer', confidence TEXT NOT NULL DEFAULT 'INFERRED',"
      + "scope TEXT NOT NULL DEFAULT 'project', created_at TEXT NOT NULL,"
      + 'superseded_at TEXT, promoted_at TEXT,'
      + 'use_count INTEGER NOT NULL DEFAULT 0, last_accessed TEXT)'
    );
    // The pre-change schema also carried the FTS mirror and its triggers, and
    // the row is inserted AFTER them so the external-content index matches --
    // otherwise the first UPDATE on the migrated row fires the delete trigger
    // against an unindexed rowid and SQLite reports a malformed image.
    legacy.exec(
      "CREATE VIRTUAL TABLE entries_fts USING fts5(title, summary, content, tags,"
      + " content='entries', content_rowid='rowid');"
      + ' CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN'
      + ' INSERT INTO entries_fts(rowid, title, summary, content, tags)'
      + ' VALUES (new.rowid, new.title, new.summary, new.content, new.tags); END;'
      + ' CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN'
      + " INSERT INTO entries_fts(entries_fts, rowid, title, summary, content, tags)"
      + " VALUES ('delete', old.rowid, old.title, old.summary, old.content, old.tags); END;"
      + ' CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN'
      + " INSERT INTO entries_fts(entries_fts, rowid, title, summary, content, tags)"
      + " VALUES ('delete', old.rowid, old.title, old.summary, old.content, old.tags);"
      + ' INSERT INTO entries_fts(rowid, title, summary, content, tags)'
      + ' VALUES (new.rowid, new.title, new.summary, new.content, new.tags); END;'
    );
    legacy.prepare(
      'INSERT INTO entries (id, type, title, summary, content, source_files, created_at,'
      + ' author, source, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      'legacy-1', 'learning', 'Legacy entry', 'Legacy summary', 'Legacy content.',
      JSON.stringify([basisFile]), new Date().toISOString(), 'legacy-author', 'doer', 'INFERRED'
    );
    legacy.close();

    const reopened = new SqliteProvider(legacyPath);
    await reopened.init();
    try {
      const cols = columnNames(reopened);
      expect(cols).toContain('demoted_at');
      expect(cols).toContain('demoted_basis_hashes');

      const before = rawRow(reopened, 'legacy-1')!;
      expect(before.content).toBe('Legacy content.');
      expect(before.confidence).toBe('INFERRED');
      expect(before.demoted_at ?? null).toBeNull();

      // The migrated row is demotable, which is the point of migrating it.
      const result = await reopened.demote('legacy-1', REASON);
      expect(result.confidence_after).toBe('UNVERIFIED');
      const after = rawRow(reopened, 'legacy-1')!;
      expect(after.demoted_at).toBeTruthy();
      expect(after.confidence).toBe('UNVERIFIED');
    } finally {
      reopened.close();
    }
  });
});

describe('SqliteProvider.demote -- the ladder', () => {
  it('CONFIRMED -> INFERRED: stamps demoted_at, snapshots the basis, appends the note', async () => {
    const id = await captureConfirmed();
    const before = rawRow(provider, id)!;
    expect(before.confidence).toBe('CONFIRMED');

    const result = await provider.demote(id, REASON);
    expect(result).toEqual({ id, confidence_before: 'CONFIRMED', confidence_after: 'INFERRED' });

    const after = rawRow(provider, id)!;
    expect(after.confidence).toBe('INFERRED');
    expect(after.demoted_at).toBeTruthy();
    // D6: the snapshot is the row's basis AS IT WAS, copied verbatim.
    expect(after.demoted_basis_hashes).toBe(before.source_file_hashes);
    expect(after.demoted_basis_hashes).not.toBe('{}');
    expect(after.content).toBe(before.content + '\n[Demoted: ' + REASON + ' -- test-agent]');
    // promote() stamps promoted_at and source='promotion'; demote touches neither.
    expect(after.promoted_at).toBe(before.promoted_at);
    expect(after.source).toBe(before.source);
    expect(after.source).toBe('promotion');

    // rowToEntry surfaces the new column through the normal read path.
    const entry = (await provider.query({ ids: [id] })).results[0];
    expect(entry.demoted_at).toBe(after.demoted_at);
  });

  it('INFERRED -> UNVERIFIED, one rung per call', async () => {
    const { id } = await provider.capture(makeInput({ source_files: [basisFile] }));
    const before = rawRow(provider, id)!;

    const result = await provider.demote(id, REASON);
    expect(result.confidence_before).toBe('INFERRED');
    expect(result.confidence_after).toBe('UNVERIFIED');

    const after = rawRow(provider, id)!;
    expect(after.confidence).toBe('UNVERIFIED');
    expect(after.demoted_at).toBeTruthy();
    expect(after.demoted_basis_hashes).toBe(before.source_file_hashes);
    expect(after.promoted_at ?? null).toBeNull();
    expect(after.source).toBe(before.source);
  });

  it('UNVERIFIED is a no-op: same confidence and a byte-identical row', async () => {
    const { id } = await provider.capture(
      makeInput({ source_files: [basisFile], confidence: 'UNVERIFIED' })
    );
    const before = JSON.stringify(rawRow(provider, id));

    const result = await provider.demote(id, REASON);
    expect(result.confidence_before).toBe('UNVERIFIED');
    expect(result.confidence_after).toBe('UNVERIFIED');
    expect(JSON.stringify(rawRow(provider, id))).toBe(before);
  });

  it('kb_promote after a demote moves the entry one rung back up', async () => {
    const id = await captureConfirmed();
    await provider.demote(id, REASON);
    expect(rawRow(provider, id)!.confidence).toBe('INFERRED');

    const result = await provider.promote(id, 'rechecked the basis file; the claim holds after all');
    expect(result.confidence_before).toBe('INFERRED');
    expect(result.confidence_after).toBe('CONFIRMED');
    const after = rawRow(provider, id)!;
    expect(after.confidence).toBe('CONFIRMED');
    // The demotion record survives the re-promotion -- it is history, not state.
    expect(after.demoted_at).toBeTruthy();
  });
});

describe('SqliteProvider.demote -- refusals leave the row byte-identical', () => {
  it('refuses an id that does not exist, writing nothing', async () => {
    const { id } = await provider.capture(makeInput({ source_files: [basisFile] }));
    const before = JSON.stringify(rawRow(provider, id));

    await expect(provider.demote('no-such-entry', REASON)).rejects.toThrow(
      'Entry not found: no-such-entry'
    );
    expect(rawRow(provider, 'no-such-entry')).toBeUndefined();
    expect(JSON.stringify(rawRow(provider, id))).toBe(before);
  });

  it('refuses a superseded entry', async () => {
    const id = await captureConfirmed();
    (provider as any).getDb()
      .prepare('UPDATE entries SET superseded_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
    const before = JSON.stringify(rawRow(provider, id));

    await expect(provider.demote(id, REASON)).rejects.toThrow('Cannot demote superseded entry: ' + id);
    expect(JSON.stringify(rawRow(provider, id))).toBe(before);
  });

  it('refuses a user-directive and points at reject-directive', async () => {
    const id = await captureConfirmed();
    (provider as any).getDb()
      .prepare("UPDATE entries SET type = 'user-directive' WHERE id = ?")
      .run(id);
    const before = JSON.stringify(rawRow(provider, id));

    await expect(provider.demote(id, REASON)).rejects.toThrow(/reject-directive/);
    expect(JSON.stringify(rawRow(provider, id))).toBe(before);
  });

  it('refuses a reason under 20 trimmed characters', async () => {
    const id = await captureConfirmed();
    const before = JSON.stringify(rawRow(provider, id));

    // 24 characters, but only 5 once trimmed -- the floor is on the trimmed form.
    await expect(provider.demote(id, '                   stale')).rejects.toThrow(
      /kb_demote requires a reason/
    );
    await expect(provider.demote(id, 'wrong')).rejects.toThrow(/kb_demote requires a reason/);
    expect(JSON.stringify(rawRow(provider, id))).toBe(before);
  });

  it('refuses evidence that does not resolve, naming the missing path', async () => {
    const { id } = await anchored.capture(makeInput({ source_files: ['basis.ts'] }));
    const before = JSON.stringify(rawRow(anchored, id));

    await expect(anchored.demote(id, REASON, ['basis.ts', 'nope.ts'])).rejects.toThrow(/nope\.ts/);
    expect(JSON.stringify(rawRow(anchored, id))).toBe(before);
  });

  it('refuses an evidence path that traverses out of the anchor', async () => {
    const { id } = await anchored.capture(makeInput({ source_files: ['basis.ts'] }));
    const before = JSON.stringify(rawRow(anchored, id));

    await expect(anchored.demote(id, REASON, ['../outside.ts'])).rejects.toThrow(
      /Path traversal rejected/
    );
    await expect(anchored.demote(id, REASON, [path.join(tmpDir, 'basis.ts')])).rejects.toThrow(
      /Path traversal rejected/
    );
    expect(JSON.stringify(rawRow(anchored, id))).toBe(before);
  });
});

describe('SqliteProvider.demote -- evidence files', () => {
  it('succeeds with no evidence_files and records no evidence clause', async () => {
    const id = await captureConfirmed();
    await provider.demote(id, REASON);
    const content = rawRow(provider, id)!.content as string;
    expect(content).toContain('[Demoted: ' + REASON + ' -- test-agent]');
    expect(content).not.toContain('evidence:');
  });

  it('succeeds with an empty evidence_files array (D2)', async () => {
    const { id } = await anchored.capture(makeInput({ source_files: ['basis.ts'] }));
    const result = await anchored.demote(id, REASON, []);
    expect(result.confidence_after).toBe('UNVERIFIED');
    expect(rawRow(anchored, id)!.content as string).not.toContain('evidence:');
  });

  it('records valid evidence paths in the appended note', async () => {
    const { id } = await anchored.capture(makeInput({ source_files: ['basis.ts'] }));
    await anchored.demote(id, REASON, ['basis.ts', 'evidence.ts']);
    expect(rawRow(anchored, id)!.content as string).toContain(
      '[Demoted: ' + REASON + ' | evidence: basis.ts, evidence.ts -- test-agent]'
    );
  });
});

describe('SqliteProvider.demote -- the note must not act as a feedback downvote', () => {
  it('the appended note does not match FEEDBACK_MARKER_RE', async () => {
    const id = await captureConfirmed();
    await provider.demote(id, REASON, undefined);
    const content = rawRow(provider, id)!.content as string;
    const re = (SqliteProvider as any).FEEDBACK_MARKER_RE as RegExp;
    expect(re.test(content)).toBe(false);
  });

  it('a later freshness sweep still unstales a demoted entry', async () => {
    const { id } = await provider.capture(makeInput({ source_files: [basisFile] }));
    await provider.demote(id, REASON);
    expect(rawRow(provider, id)!.confidence).toBe('UNVERIFIED');

    // Basis moves -> the sweep stales it (the freshness actor, the only one the
    // sweep may revive).
    fs.writeFileSync(basisFile, BASIS_CONTENT + ' // changed');
    const staling = await provider.freshnessSweep();
    expect(staling.staled).toBe(1);
    expect(rawRow(provider, id)!.stale).toBe(1);

    // Basis comes back (branch switch) -> revival must still be possible. A note
    // matching FEEDBACK_MARKER_RE would make this unstaled count 0 forever.
    fs.writeFileSync(basisFile, BASIS_CONTENT);
    const revival = await provider.freshnessSweep();
    expect(revival.unstaled).toBe(1);
    expect(rawRow(provider, id)!.stale).toBe(0);
  });
});

describe('HttpKbProvider.demote', () => {
  it('throws the not-supported error and writes nothing to the local fallback', async () => {
    const fallback = new SqliteProvider(':memory:');
    await fallback.init();
    const { id } = await fallback.capture(makeInput({ source_files: [basisFile] }));
    const before = JSON.stringify(rawRow(fallback, id));

    const http = new HttpKbProvider('http://127.0.0.1:59999', 'test-token', fallback);
    try {
      await expect(http.demote(id, REASON)).rejects.toThrow(
        'kb_demote is not supported for an HTTP KB yet'
      );
      expect(JSON.stringify(rawRow(fallback, id))).toBe(before);
    } finally {
      http.dispose();
      fallback.close();
    }
  });
});
