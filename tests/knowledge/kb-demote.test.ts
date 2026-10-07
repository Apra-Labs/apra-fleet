import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { HttpKbProvider } from '../../src/services/knowledge/http-provider.js';
import { execFileSync } from 'node:child_process';
import { kbDemote } from '../../src/tools/kb-demote.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { addAgent } from '../../src/services/registry.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from '../test-helpers.js';

// kb_demote: the CONFIRMED -> INFERRED trust-withdrawal path.
//
// Everything here runs against a REAL SqliteProvider(':memory:') anchored at a
// REAL temp directory with REAL files on disk, and the tool-layer cases call
// the REAL kb_demote handler. Nothing about demote() or the tool is mocked --
// the only vi.spyOn is on getKbProviders, which decides WHICH KB the tool
// opens, not what demote does to it (same technique as kb-directive-gate.test.ts).
//
// Every refusal case asserts the ROW IS UNCHANGED afterwards, not merely that
// an error was thrown: a refusal that threw after a partial write would still
// satisfy a rejects.toThrow() assertion, and the ordering guarantee this tool
// depends on ("all refusals before any write") is exactly what that would
// break.

const REASON = 'Re-read the cited file and the claim holds in fewer cases than the promotion note asserts.';
const PROMOTE_REASON = 'Verified against src/real.ts: the retry budget is read once at startup.';

let tmp: string;
let repo: string;
let provider: SqliteProvider;

/** The raw row, straight out of sqlite -- never through a read path that could paper over a write. */
interface RawRow {
  id: string;
  confidence: string;
  content: string;
  source: string;
  promoted_at: string | null;
  demoted_at: string | null;
  demoted_basis_hashes: string;
  source_file_hashes: string;
  stale: number;
  superseded_at: string | null;
  tags: string;
}

function rawDb(): { prepare(s: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown } } {
  return (provider as unknown as {
    getDb(): { prepare(s: string): { get(...a: unknown[]): unknown; run(...a: unknown[]): unknown } };
  }).getDb();
}

function row(id: string): RawRow {
  return rawDb().prepare('SELECT * FROM entries WHERE id = ?').get(id) as RawRow;
}

/**
 * The fields a refusal must leave untouched. Captured before the call and
 * compared after it, so the assertion is "nothing moved", not "the one field I
 * remembered to check did not move".
 */
function snapshot(id: string) {
  const r = row(id);
  return {
    confidence: r.confidence,
    content: r.content,
    source: r.source,
    promoted_at: r.promoted_at,
    demoted_at: r.demoted_at,
    demoted_basis_hashes: r.demoted_basis_hashes,
    stale: r.stale,
    superseded_at: r.superseded_at,
  };
}

function sha256Of(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function entryInput(over: Record<string, unknown> = {}) {
  return {
    type: 'knowledge' as const,
    title: 'A demotable entry',
    summary: 'A summary',
    content: 'Some content about the repository.',
    source_files: ['src/real.ts'],
    symbols: ['realSymbol'],
    tags: [] as string[],
    content_hash: '',
    content_hash_type: 'sha256' as const,
    flagged_for_review: false,
    author: 'tester',
    source: 'session' as const,
    confidence: 'INFERRED' as const,
    ...over,
  };
}

/**
 * Capture an entry and walk it up to CONFIRMED through the real promote path.
 * Defaults to the module-level `provider`; the migration regression test
 * below passes its own file-backed instance.
 */
async function confirmedEntry(over: Record<string, unknown> = {}, on: SqliteProvider = provider): Promise<string> {
  const { id } = await on.capture(entryInput(over));
  await on.promote(id, PROMOTE_REASON);
  return id;
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-demote-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'real.ts'), 'export const real = 1;\n');
  fs.writeFileSync(path.join(repo, 'src', 'other.ts'), 'export const other = 1;\n');
  fs.mkdirSync(path.join(repo, 'src', 'adir'), { recursive: true });
  // A real file OUTSIDE the anchor, so the traversal case is refused for
  // traversing rather than merely for not existing.
  fs.writeFileSync(path.join(tmp, 'outside.ts'), 'export const outside = 1;\n');

  provider = new SqliteProvider(':memory:', repo);
  await provider.init();
});

afterEach(() => {
  provider.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Refusal matrix. One case each, every one asserting the row is unchanged.
// ---------------------------------------------------------------------------

describe('kb_demote refuses before any write', () => {
  it('an unknown id', async () => {
    await expect(provider.demote('no-such-id', REASON)).rejects.toThrow('Entry not found: no-such-id');
  });

  it("another member's row, with the SAME message an unknown id gets (existence is not disclosed)", async () => {
    const id = await confirmedEntry({ tags: ['member:aaaaaaaa'] });
    const before = snapshot(id);

    // The exact message, not a pattern: a different message for "exists but is
    // not yours" is itself the existence disclosure this rule exists to prevent.
    const unknownIdMessage = await provider.demote('probe-id', REASON).catch((e: Error) => e.message);
    const foreignRowMessage = await provider
      .demote(id, REASON, undefined, { ownerTag: 'member:bbbbbbbb' })
      .catch((e: Error) => e.message);

    expect(foreignRowMessage).toBe('Entry not found: ' + id);
    expect(unknownIdMessage).toBe('Entry not found: probe-id');
    // Same shape, differing only in the id echoed back.
    expect(foreignRowMessage.replace(id, 'X')).toBe(unknownIdMessage.replace('probe-id', 'X'));
    expect(snapshot(id)).toEqual(before);
  });

  it('a superseded row', async () => {
    const id = await confirmedEntry();
    await provider.discard([id]);
    const before = snapshot(id);
    expect(before.superseded_at).toBeTruthy();

    await expect(provider.demote(id, REASON)).rejects.toThrow(/^E-DEMOTE-SUPERSEDED:/);
    expect(snapshot(id)).toEqual(before);
  });

  it('a user-directive row (checked BEFORE the not-CONFIRMED gate, so an UNVERIFIED directive still gets the directive refusal)', async () => {
    const { id } = await provider.capture(entryInput({
      type: 'user-directive',
      title: 'A standing instruction',
      confidence: 'UNVERIFIED',
    }));
    const before = snapshot(id);
    expect(before.confidence).not.toBe('CONFIRMED');

    await expect(provider.demote(id, REASON)).rejects.toThrow(/^E-DEMOTE-REFUSED-DIRECTIVE:/);
    expect(snapshot(id)).toEqual(before);
  });

  it('an INFERRED row -- a refusal, never a silent no-op return', async () => {
    const { id } = await provider.capture(entryInput());
    const before = snapshot(id);
    expect(before.confidence).toBe('INFERRED');

    // .rejects, not a returned result: a no-op return would let a caller
    // believe it lowered trust that was already below CONFIRMED.
    await expect(provider.demote(id, REASON)).rejects.toThrow(/^E-DEMOTE-NOT-CONFIRMED:/);
    expect(snapshot(id)).toEqual(before);
  });

  it('an UNVERIFIED row', async () => {
    const { id } = await provider.capture(entryInput({ confidence: 'UNVERIFIED' }));
    const before = snapshot(id);
    expect(before.confidence).toBe('UNVERIFIED');

    await expect(provider.demote(id, REASON)).rejects.toThrow(/^E-DEMOTE-NOT-CONFIRMED:/);
    expect(snapshot(id)).toEqual(before);
  });

  it('a 19-character reason (one short of the floor)', async () => {
    const id = await confirmedEntry();
    const before = snapshot(id);
    const justTooShort = 'x'.repeat(19);
    expect(justTooShort).toHaveLength(19);

    await expect(provider.demote(id, justTooShort)).rejects.toThrow(/^E-DEMOTE-REASON-REQUIRED:/);
    expect(snapshot(id)).toEqual(before);

    // The boundary is real in both directions: 20 is accepted.
    await expect(provider.demote(id, 'y'.repeat(20))).resolves.toMatchObject({ confidence_after: 'INFERRED' });
  });

  it('a reason that is only newlines (collapses to empty)', async () => {
    const id = await confirmedEntry();
    const before = snapshot(id);

    await expect(provider.demote(id, '\n\n\n\n\n')).rejects.toThrow(/^E-DEMOTE-REASON-REQUIRED:/);
    expect(snapshot(id)).toEqual(before);
  });

  it('an evidence path that does not resolve', async () => {
    const id = await confirmedEntry();
    const before = snapshot(id);

    await expect(provider.demote(id, REASON, ['src/nope.ts']))
      .rejects.toThrow(/^E-DEMOTE-EVIDENCE-UNRESOLVED: .*does not resolve/);
    expect(snapshot(id)).toEqual(before);
  });

  it('an evidence path containing a parent-directory traversal segment', async () => {
    const id = await confirmedEntry();
    const before = snapshot(id);

    // ../outside.ts EXISTS on disk, so this can only be refused for traversing
    // out of the anchor -- proving the traversal check runs before existence.
    expect(fs.existsSync(path.join(tmp, 'outside.ts'))).toBe(true);
    await expect(provider.demote(id, REASON, ['../outside.ts']))
      .rejects.toThrow(/^E-DEMOTE-EVIDENCE-UNRESOLVED: .*traverses out of the anchor/);
    expect(snapshot(id)).toEqual(before);
  });

  it('an ABSOLUTE evidence path pointing outside the provider\'s anchor', async () => {
    const id = await confirmedEntry();
    const before = snapshot(id);

    // A real file OUTSIDE the anchor, named by an ABSOLUTE path. resolveBasisFile
    // passes an absolute path through unchanged and it exists on disk, so if the
    // guard were reverted to the old '..'-segment-only check (which an absolute
    // path with no '..' segment never trips), this would resolve, pass the
    // is-a-file check and demote would SUCCEED -- turning this .rejects into a
    // failing assertion. That is the regression this case guards against.
    const absoluteOutside = path.join(tmp, 'outside.ts');
    expect(path.isAbsolute(absoluteOutside)).toBe(true);
    expect(fs.existsSync(absoluteOutside)).toBe(true);

    await expect(provider.demote(id, REASON, [absoluteOutside]))
      .rejects.toThrow(/^E-DEMOTE-EVIDENCE-UNRESOLVED: .*is absolute or traverses out of the anchor/);
    expect(snapshot(id)).toEqual(before);
  });

  it('an evidence path that resolves to a directory, not a file', async () => {
    const id = await confirmedEntry();
    const before = snapshot(id);

    await expect(provider.demote(id, REASON, ['src/adir']))
      .rejects.toThrow(/^E-DEMOTE-EVIDENCE-UNRESOLVED: .*is not a file/);
    expect(snapshot(id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Success path and semantics.
// ---------------------------------------------------------------------------

describe('kb_demote success path', () => {
  it('lowers CONFIRMED to INFERRED, stamps demoted_at, and leaves promoted_at and source untouched', async () => {
    const id = await confirmedEntry();
    const before = row(id);
    expect(before.confidence).toBe('CONFIRMED');
    expect(before.promoted_at).toBeTruthy();
    expect(before.source).toBe('promotion');
    expect(before.demoted_at).toBeNull();

    const result = await provider.demote(id, REASON);

    expect(result).toEqual({ id, confidence_before: 'CONFIRMED', confidence_after: 'INFERRED' });
    const after = row(id);
    expect(after.confidence).toBe('INFERRED');
    expect(after.demoted_at).toBeTruthy();
    expect(Date.parse(after.demoted_at as string)).not.toBeNaN();
    // Unlike promote(), which stamps source='promotion', demote erases nothing:
    // the provenance of the promotion it reverses must survive it.
    expect(after.promoted_at).toBe(before.promoted_at);
    expect(after.source).toBe(before.source);
  });

  it('appends the EXACT note, with evidence, as a full-string match', async () => {
    const id = await confirmedEntry();
    const contentBefore = row(id).content;

    await provider.demote(id, REASON, ['src/real.ts', 'src/other.ts']);

    const expectedNote = '\n[Demoted: ' + REASON + ' | evidence: src/real.ts, src/other.ts -- tester]';
    // Full equality, not toContain: a substring match would pass on a note with
    // the wrong leading whitespace, a duplicated clause or trailing junk.
    expect(row(id).content).toBe(contentBefore + expectedNote);
  });

  it('omits the evidence clause entirely when no evidence files are given', async () => {
    const id = await confirmedEntry();
    const contentBefore = row(id).content;

    await provider.demote(id, REASON);

    expect(row(id).content).toBe(contentBefore + '\n[Demoted: ' + REASON + ' -- tester]');
  });

  it('collapses newlines inside the reason to spaces', async () => {
    const id = await confirmedEntry();
    const contentBefore = row(id).content;

    await provider.demote(id, 'First line of the reason.\nSecond line of the reason.');

    expect(row(id).content).toBe(
      contentBefore + '\n[Demoted: First line of the reason. Second line of the reason. -- tester]'
    );
  });

  it('writes EXACTLY ONE leading newline, so the note can never match the kb_feedback marker', async () => {
    const id = await confirmedEntry();
    const contentBefore = row(id).content;

    await provider.demote(id, REASON);
    const appended = row(id).content.slice(contentBefore.length);

    expect(appended.startsWith('\n[Demoted: ')).toBe(true);
    expect(appended.startsWith('\n\n')).toBe(false);
    // The literal marker feedback() writes, which scanners key off.
    expect(row(id).content).not.toMatch(/\n\n\[feedback /);
  });

  it('demotes a STALE CONFIRMED row -- staleness is a freshness verdict, not a trust tier', async () => {
    const id = await confirmedEntry();
    rawDb().prepare('UPDATE entries SET stale = 1 WHERE id = ?').run(id);
    expect(row(id).stale).toBe(1);

    await expect(provider.demote(id, REASON)).resolves.toMatchObject({ confidence_after: 'INFERRED' });
    expect(row(id).confidence).toBe('INFERRED');
    expect(row(id).stale).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The disk-hash regression guard.
// ---------------------------------------------------------------------------

describe('kb_demote snapshots the basis from DISK, not from the capture-time column', () => {
  it('records the sha256 of the EDITED file, and never the capture-time source_file_hashes value', async () => {
    const basisFile = path.join(repo, 'src', 'real.ts');
    const originalSha = sha256Of(basisFile);

    const id = await confirmedEntry();
    const captureTimeHashes = JSON.parse(row(id).source_file_hashes) as Record<string, string>;
    expect(captureTimeHashes['src/real.ts']).toBeTruthy();

    // The tree moves on AFTER the entry was captured and promoted. This is the
    // whole point: a demotion must record the tree it actually judged, so the
    // later ping-pong guard can ask "has anything changed since we demoted?".
    fs.writeFileSync(basisFile, 'export const real = 2; // edited after promotion\n');
    const editedSha = sha256Of(basisFile);
    expect(editedSha).not.toBe(originalSha);

    await provider.demote(id, REASON);

    const demoted = JSON.parse(row(id).demoted_basis_hashes) as Record<string, string>;
    // The assertion that fails if demote() is reverted to copying the
    // capture-time column (the defect in the superseded upstream attempt):
    // that column holds the hash of the file as it was BEFORE the edit.
    expect(demoted['src/real.ts']).toBe(editedSha);
    expect(demoted['src/real.ts']).not.toBe(originalSha);
    expect(demoted['src/real.ts']).not.toBe(captureTimeHashes['src/real.ts']);
  });

  it('leaves a basis file that has since disappeared out of the map rather than fabricating a hash', async () => {
    const id = await confirmedEntry();
    fs.rmSync(path.join(repo, 'src', 'real.ts'));

    await provider.demote(id, REASON);

    expect(JSON.parse(row(id).demoted_basis_hashes)).toEqual({});
    expect(row(id).confidence).toBe('INFERRED');
  });
});

// ---------------------------------------------------------------------------
// Own-scope (ownerTag) matrix.
// ---------------------------------------------------------------------------

describe('kb_demote own-scope', () => {
  it('a FULL session (no ownerTag) can demote any row, including another member\'s', async () => {
    const id = await confirmedEntry({ tags: ['member:aaaaaaaa'] });

    await expect(provider.demote(id, REASON)).resolves.toMatchObject({ confidence_after: 'INFERRED' });
  });

  it('a member session can demote its OWN row', async () => {
    const id = await confirmedEntry({ tags: ['member:aaaaaaaa'] });

    await expect(provider.demote(id, REASON, undefined, { ownerTag: 'member:aaaaaaaa' }))
      .resolves.toMatchObject({ confidence_after: 'INFERRED' });
  });

  it('a member session cannot demote an UNTAGGED row either', async () => {
    const id = await confirmedEntry();
    const before = snapshot(id);

    await expect(provider.demote(id, REASON, undefined, { ownerTag: 'member:aaaaaaaa' }))
      .rejects.toThrow('Entry not found: ' + id);
    expect(snapshot(id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// The kb_demote TOOL, through its real handler.
// ---------------------------------------------------------------------------

describe('the kb_demote tool handler', () => {
  // Two REAL registered local members, both anchored at the scratch repo. The
  // member path resolves its KB through the registry, so an unregistered uuid
  // never reaches the own-scope rule at all (it fails earlier with
  // E-SELF-NO-WORKFOLDER) and would prove nothing about ownerTag.
  const MEMBER_A = '11111111-1111-4111-8111-111111111111';
  const MEMBER_B = '22222222-2222-4222-8222-222222222222';

  beforeEach(() => {
    // The anchor must be a git repo with an origin remote to carry a KB identity.
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.test/kb-demote.git'], { cwd: repo });

    backupAndResetRegistry();
    addAgent(makeTestLocalAgent({ id: MEMBER_A, friendlyName: 'kb-demote-a', workFolder: repo }));
    addAgent(makeTestLocalAgent({ id: MEMBER_B, friendlyName: 'kb-demote-b', workFolder: repo }));

    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: provider,
      global: provider,
      projectSlug: 'test',
    } as never);
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('returns {id, previous_confidence, new_confidence} as a JSON string', async () => {
    const id = await confirmedEntry();

    const out = JSON.parse(await kbDemote({ id, reason: REASON }));

    expect(out).toEqual({ id, previous_confidence: 'CONFIRMED', new_confidence: 'INFERRED' });
    expect(row(id).confidence).toBe('INFERRED');
  });

  it('forwards evidence_files through to the provider', async () => {
    const id = await confirmedEntry();
    const contentBefore = row(id).content;

    await kbDemote({ id, reason: REASON, evidence_files: ['src/other.ts'] });

    expect(row(id).content).toBe(contentBefore + '\n[Demoted: ' + REASON + ' | evidence: src/other.ts -- tester]');
  });

  it('a MEMBER session reaches the provider WITH its ownerTag: another member\'s row is not found', async () => {
    const id = await confirmedEntry({ tags: ['member:' + MEMBER_A] });
    const before = snapshot(id);

    await expect(
      runWithSessionMember(MEMBER_B, () => kbDemote({ id, reason: REASON }))
    ).rejects.toThrow('Entry not found: ' + id);
    expect(snapshot(id)).toEqual(before);

    // ...and its own row still demotes, so the refusal above is the tag rule
    // doing its job and not the member path being broken outright.
    await expect(
      runWithSessionMember(MEMBER_A, () => kbDemote({ id, reason: REASON }))
    ).resolves.toContain('"new_confidence":"INFERRED"');
  });

  it('a FULL session reaches the provider WITHOUT an ownerTag, so another member\'s row demotes', async () => {
    const id = await confirmedEntry({ tags: ['member:' + MEMBER_A] });

    await expect(kbDemote({ id, reason: REASON })).resolves.toContain('"new_confidence":"INFERRED"');
  });
});

// ---------------------------------------------------------------------------
// HttpKbProvider.
// ---------------------------------------------------------------------------

describe('HttpKbProvider.demote', () => {
  it('refuses with a not-supported error and writes NOTHING to the local fallback', async () => {
    const fallback = new SqliteProvider(':memory:', repo);
    await fallback.init();
    const { id } = await fallback.capture(entryInput());
    await fallback.promote(id, PROMOTE_REASON);

    const fallbackDb = (fallback as unknown as {
      getDb(): { prepare(s: string): { get(...a: unknown[]): unknown } };
    }).getDb();
    const readBack = () => fallbackDb.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RawRow;
    const before = readBack();
    expect(before.confidence).toBe('CONFIRMED');

    // Nothing listens on this port: the refusal must come from demote() itself,
    // never from a failed request falling back to the local store.
    const http = new HttpKbProvider('http://127.0.0.1:17777', 'token', fallback);

    await expect(http.demote(id, REASON)).rejects.toThrow(/not supported for an HTTP KB/);

    const after = readBack();
    expect(after.confidence).toBe('CONFIRMED');
    expect(after.content).toBe(before.content);
    expect(after.demoted_at).toBeNull();
    expect(after.demoted_basis_hashes).toBe(before.demoted_basis_hashes);
    expect(after.promoted_at).toBe(before.promoted_at);

    fallback.close();
  });
});

// ---------------------------------------------------------------------------
// Guarded migration: the demoted_at / demoted_basis_hashes columns.
// ---------------------------------------------------------------------------
//
// This is a regression test, not a schema inspection: it reopens a REAL
// file-backed DB (node:sqlite supports DROP COLUMN) that had both columns
// removed -- simulating a DB created before this migration landed -- and
// asserts init() backfills them as a harmless, caught ALTER TABLE ADD COLUMN,
// with the pre-existing row still readable AND still demotable afterwards.

describe('the demoted_at / demoted_basis_hashes migration is guarded and backfills', () => {
  it('re-adds both columns on re-init after they are dropped, and a pre-existing row stays readable and demotable', async () => {
    const dbPath = path.join(tmp, 'migration.sqlite');

    const first = new SqliteProvider(dbPath, repo);
    await first.init();
    const id = await confirmedEntry({}, first);

    const firstDb = (first as unknown as {
      getDb(): { prepare(s: string): { all(...a: unknown[]): { name: string }[] }; exec(s: string): void };
    }).getDb();

    // Simulate a DB created before this migration landed.
    firstDb.exec('ALTER TABLE entries DROP COLUMN demoted_at');
    firstDb.exec('ALTER TABLE entries DROP COLUMN demoted_basis_hashes');
    const droppedCols = firstDb.prepare('PRAGMA table_info(entries)').all().map((c) => c.name);
    expect(droppedCols).not.toContain('demoted_at');
    expect(droppedCols).not.toContain('demoted_basis_hashes');
    first.close();

    // Re-open the SAME file-backed DB. init()'s guarded ALTER must backfill
    // both columns here (a real migration, not the usual caught no-op), and
    // the row captured before the drop must still read back correctly.
    const second = new SqliteProvider(dbPath, repo);
    await second.init();

    const secondDb = (second as unknown as {
      getDb(): { prepare(s: string): { all(...a: unknown[]): { name: string }[]; get(...a: unknown[]): unknown } };
    }).getDb();
    const restoredCols = secondDb.prepare('PRAGMA table_info(entries)').all().map((c) => c.name);
    expect(restoredCols).toContain('demoted_at');
    expect(restoredCols).toContain('demoted_basis_hashes');

    const restoredRow = secondDb.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RawRow;
    expect(restoredRow.confidence).toBe('CONFIRMED');
    expect(restoredRow.demoted_at).toBeNull();
    expect(restoredRow.demoted_basis_hashes).toBe('{}');

    // Re-added columns are not just present but USABLE: a demote against the
    // re-opened provider succeeds end-to-end.
    await expect(second.demote(id, REASON)).resolves.toMatchObject({ confidence_after: 'INFERRED' });
    expect((secondDb.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RawRow).demoted_at).toBeTruthy();
    second.close();
  });

  it('is a no-op on a freshly created DB that already has both columns (the common case)', async () => {
    const dbPath = path.join(tmp, 'migration-fresh.sqlite');
    const p = new SqliteProvider(dbPath, repo);
    await p.init();
    const id = await confirmedEntry({}, p);

    // Re-init-by-reopen must not throw even though both columns already exist
    // (the guarded ALTER's ordinary, far more common path).
    p.close();
    const reopened = new SqliteProvider(dbPath, repo);
    await expect(reopened.init()).resolves.toBeUndefined();
    await expect(reopened.demote(id, REASON)).resolves.toMatchObject({ confidence_after: 'INFERRED' });
    reopened.close();
  });
});
