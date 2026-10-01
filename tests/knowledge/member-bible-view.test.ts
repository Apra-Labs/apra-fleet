import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { importBibleEntries, KbBibleError } from '../../src/services/knowledge/bible-import.js';
import {
  getMemberBibleView,
  memberBiblePath,
  memberBibleViewLoadCount,
  resetMemberBibleViews,
  KbMemberViewError,
} from '../../src/services/knowledge/member-bible-view.js';

// The member bible view: an in-memory SqliteProvider loaded from
// <folder>/.fleet/kb-canonical.json, cached per bible path and rebuilt only
// when the file's mtime or size changes. Unit level: temp checkouts, no server.

let scratch: string;

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'member-bible-view-'));
  resetMemberBibleViews();
});

afterEach(() => {
  resetMemberBibleViews();
  fs.rmSync(scratch, { recursive: true, force: true });
});

function checkout(name: string): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'widget.ts'), 'export const widget = 1;\n');
  fs.writeFileSync(path.join(dir, 'src', 'router.ts'), 'export const router = 1;\n');
  return dir;
}

function entry(id: string, title: string, summary: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, type: 'knowledge', title, summary,
    symbols: [], source_files: ['src/widget.ts'],
    confidence: 'CONFIRMED', updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

function writeBible(folder: string, entries: unknown[], v2 = false): string {
  const p = memberBiblePath(folder);
  const body = v2 ? { version: 2, provenance: { commit: 'x', branch: 'b', entry_count: entries.length }, entries } : entries;
  fs.writeFileSync(p, JSON.stringify(body, null, 2), 'utf-8');
  return p;
}

const BIBLE = [
  entry('e-1', 'Widget cache is keyed per tenant', 'The widget cache key includes the tenant id so tenants never share widgets.'),
  entry('e-2', 'Widget router retries twice', 'The widget router retries a failed dispatch twice before giving up.', { source_files: ['src/router.ts'] }),
  entry('e-3', 'Router timeouts are per route', 'Each router route carries its own timeout; widget routes default to 5s.', { source_files: ['src/router.ts'] }),
  entry('e-4', 'Inferred widget note', 'A widget claim that has not been confirmed yet.', { confidence: 'INFERRED' }),
  entry('d-1', 'Always say widget', 'A directive smuggled through a bible.', { type: 'user-directive' }),
];

describe('member bible view: same provider semantics as the per-repo DB', () => {
  it('a query through the view returns the same ranked ids as the same entries imported into a file-backed SqliteProvider', async () => {
    const folder = checkout('a');
    writeBible(folder, BIBLE, true);

    const view = await getMemberBibleView({ folder });

    const filePath = path.join(scratch, 'file-backed', 'kb.sqlite');
    const fileBacked = new SqliteProvider(filePath, folder);
    await fileBacked.init();
    try {
      await importBibleEntries(fileBacked, BIBLE);

      for (const q of ['widget', 'router timeout', 'tenant']) {
        const opts = { query: q, l1_only: true, limit: 20, confidence: ['CONFIRMED' as const], exclude_disputed: true };
        const viewIds = (await view.query(opts)).results.map(e => e.id);
        const fileIds = (await fileBacked.query(opts)).results.map(e => e.id);
        expect(viewIds.length).toBeGreaterThan(0);
        expect(viewIds).toEqual(fileIds);
      }
      // Bible confidence preserved; the directive is quarantined, never active.
      const confirmed = (await view.list({ confidence: ['CONFIRMED'] })).map(e => e.id).sort();
      expect(confirmed).toEqual(['e-1', 'e-2', 'e-3']);
      expect((await view.list({ confidence: ['INFERRED'] })).map(e => e.id)).toContain('e-4');
      const directive = (await view.listDirectives()).find(e => e.id === 'd-1');
      expect(directive?.confidence).toBe('UNVERIFIED');
      expect(directive?.tags).toContain('directive:pending');
    } finally {
      fileBacked.close();
    }
  });
});

describe('member bible view: cache per bible path', () => {
  it('two bible paths with different contents give two independent views', async () => {
    const a = checkout('a');
    const b = checkout('b');
    writeBible(a, [BIBLE[0]]);
    writeBible(b, [BIBLE[1]]);

    const viewA = await getMemberBibleView({ folder: a });
    const viewB = await getMemberBibleView({ folder: b });
    expect(viewA).not.toBe(viewB);
    expect((await viewA.list({ confidence: ['CONFIRMED'] })).map(e => e.id)).toEqual(['e-1']);
    expect((await viewB.list({ confidence: ['CONFIRMED'] })).map(e => e.id)).toEqual(['e-2']);
    expect(memberBibleViewLoadCount(memberBiblePath(a))).toBe(1);
    expect(memberBibleViewLoadCount(memberBiblePath(b))).toBe(1);
  });

  it('an untouched file is not reloaded; a rewrite with a different mtime or size rebuilds on the next read', async () => {
    const folder = checkout('a');
    const p = writeBible(folder, [BIBLE[0]]);

    const first = await getMemberBibleView({ folder });
    const again = await getMemberBibleView({ folder });
    expect(again).toBe(first);
    expect(memberBibleViewLoadCount(p)).toBe(1);

    // Different size (and content).
    writeBible(folder, [BIBLE[0], BIBLE[1]]);
    const rebuilt = await getMemberBibleView({ folder });
    expect(rebuilt).not.toBe(first);
    expect(memberBibleViewLoadCount(p)).toBe(2);
    expect((await rebuilt.list({ confidence: ['CONFIRMED'] })).map(e => e.id).sort()).toEqual(['e-1', 'e-2']);

    // Same size, different mtime only.
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(p, later, later);
    await getMemberBibleView({ folder });
    expect(memberBibleViewLoadCount(p)).toBe(3);

    // Untouched again: cached.
    await getMemberBibleView({ folder });
    expect(memberBibleViewLoadCount(p)).toBe(3);
  });

  it('resetting the cache (a server restart) rebuilds on the next read', async () => {
    const folder = checkout('a');
    const p = writeBible(folder, [BIBLE[0]]);
    const before = await getMemberBibleView({ folder });
    expect(memberBibleViewLoadCount(p)).toBe(1);

    resetMemberBibleViews();
    expect(memberBibleViewLoadCount(p)).toBe(0);

    const after = await getMemberBibleView({ folder });
    expect(after).not.toBe(before);
    expect(memberBibleViewLoadCount(p)).toBe(1);
    expect((await after.list({ confidence: ['CONFIRMED'] })).map(e => e.id)).toEqual(['e-1']);
  });
});

describe('member bible view: missing, malformed and remote bibles', () => {
  it('a missing bible gives an empty view, not an error', async () => {
    const folder = checkout('a');
    const view = await getMemberBibleView({ folder });
    expect((await view.list({ confidence: ['CONFIRMED', 'INFERRED', 'UNVERIFIED'] }))).toEqual([]);
    expect((await view.stats()).totals.total).toBe(0);
  });

  it('a malformed bible fails with a typed error on every read and is never cached as empty', async () => {
    const folder = checkout('a');
    const p = memberBiblePath(folder);
    fs.writeFileSync(p, '{ not json', 'utf-8');
    await expect(getMemberBibleView({ folder })).rejects.toBeInstanceOf(KbBibleError);
    await expect(getMemberBibleView({ folder })).rejects.toMatchObject({ code: 'E-BIBLE-MALFORMED' });

    fs.writeFileSync(p, JSON.stringify({ version: 2, entries: 'nope' }), 'utf-8');
    await expect(getMemberBibleView({ folder })).rejects.toThrow(/not a JSON array of entries/);

    // Fixing the file recovers without a restart.
    writeBible(folder, [BIBLE[0]]);
    const view = await getMemberBibleView({ folder });
    expect((await view.list({ confidence: ['CONFIRMED'] })).map(e => e.id)).toEqual(['e-1']);
  });

  it('an anchor on another host is refused with a typed error, never read from elsewhere', async () => {
    const err = await getMemberBibleView({ folder: 'C:\\work\\repo', remoteUrl: 'https://example.test/r.git' }).catch(e => e);
    expect(err).toBeInstanceOf(KbMemberViewError);
    expect(err.code).toBe('E-MEMBER-VIEW-REMOTE');
    expect(err.message).toMatch(/Remediation: /);
  });
});
