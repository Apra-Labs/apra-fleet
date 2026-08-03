import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { KbCaptureRejected } from '../../src/services/knowledge/types.js';
import { kbCapture } from '../../src/tools/kb-capture.js';
import { kbHarvest } from '../../src/tools/kb-harvest.js';
import { kbImport } from '../../src/tools/kb-import.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';

/**
 * Phase 1 of docs/superpowers/specs/2026-08-03-kb-trust-pipeline-design.md.
 *
 * Capture fails closed on an uncheckable basis. An entry with no source_files
 * can never be staled by freshnessSweep() -- it builds its work set only from
 * entries with a parsed basis -- so it is permanently unfalsifiable. An entry
 * citing files that do not exist is checkable and already wrong.
 *
 * Enforcement lives in SqliteProvider.capture() rather than the tool handlers
 * because three of the four capture call sites bypass the tool layer. These
 * tests exercise the provider directly AND through the call sites.
 */

let tmp: string;
let repo: string;
let provider: SqliteProvider;

function entry(over: Record<string, unknown> = {}) {
  return {
    type: 'knowledge' as const,
    title: 'An entry',
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-inv-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'real.ts'), 'export const real = 1;\n');

  provider = new SqliteProvider(':memory:', repo);
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider,
    global: provider,
    projectSlug: 'test',
  } as any);
});

afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('capture fails closed on an uncheckable basis (provider choke point)', () => {
  it('accepts an entry whose source_files exist in the repo', async () => {
    const { id, audn_decision } = await provider.capture(entry());
    expect(audn_decision).toBe('add');
    expect(id).toBeTruthy();
  });

  it('rejects an entry with zero source_files', async () => {
    await expect(provider.capture(entry({ source_files: [] })))
      .rejects.toThrow(KbCaptureRejected);
  });

  it('rejects an entry whose source_files do not exist in the repo', async () => {
    await expect(provider.capture(entry({ source_files: ['src/ghost.ts'] })))
      .rejects.toThrow(/src\/ghost\.ts/);
  });

  it('names every missing file, not just the first', async () => {
    await expect(provider.capture(entry({ source_files: ['src/a.ts', 'src/real.ts', 'src/b.ts'] })))
      .rejects.toThrow(/src\/a\.ts.*src\/b\.ts/s);
  });

  it('resolves relative source_files against the provider repo, not process.cwd()', async () => {
    // src/real.ts exists in the temp repo. It must NOT be resolved against the
    // fleet server's cwd, which is the repo-blindness failure class of tm7.
    // A path that exists in THIS checkout but not in the temp repo must reject.
    const { audn_decision } = await provider.capture(entry({ source_files: ['src/real.ts'] }));
    expect(audn_decision).toBe('add');

    await expect(provider.capture(entry({
      title: 'cwd leak probe',
      source_files: ['src/cli/install.ts'],
    }))).rejects.toThrow(KbCaptureRejected);
  });
});

describe('the rule has no exemption for privileged capture paths', () => {
  it('rejects zero source_files even under importMode', async () => {
    await expect(provider.capture(entry({ source_files: [], source: 'import' }), { importMode: true }))
      .rejects.toThrow(KbCaptureRejected);
  });

  it('rejects a missing basis even under importMode', async () => {
    await expect(provider.capture(entry({ source_files: ['src/ghost.ts'] }), { importMode: true }))
      .rejects.toThrow(KbCaptureRejected);
  });

  it('rejects zero source_files for a harvest capture', async () => {
    await expect(provider.capture(entry({ source_files: [], source: 'harvest', author: 'harvest' })))
      .rejects.toThrow(KbCaptureRejected);
  });

  it.each(['knowledge', 'learning', 'runbook', 'context-cache'] as const)(
    'rejects zero source_files for type %s',
    async (type) => {
      await expect(provider.capture(entry({ type, source_files: [] })))
        .rejects.toThrow(KbCaptureRejected);
    }
  );
});

describe('user-directive is exempt -- it is an instruction, not a claim about code', () => {
  it('accepts a user-directive with no source_files', async () => {
    const { id } = await provider.capture(entry({
      type: 'user-directive',
      title: 'Never force-push to main',
      summary: 'Standing user rule',
      content: 'The user said: never force-push to main.',
      source_files: [],
    }));
    const stored = (await provider.query({ ids: [id] })).results[0];
    // Still quarantined as a pending proposal by the directive gate.
    expect(stored.type).toBe('user-directive');
    expect(stored.confidence).toBe('UNVERIFIED');
    expect(stored.tags).toContain('directive:pending');
  });

  it('still rejects a user-directive that cites a file which does not exist', async () => {
    // The exemption covers "no basis at all", not "a basis that is wrong".
    await expect(provider.capture(entry({
      type: 'user-directive',
      title: 'Directive naming a ghost file',
      source_files: ['src/ghost.ts'],
    }))).rejects.toThrow(KbCaptureRejected);
  });
});

describe('rejection reaches the kb_capture tool call site', () => {
  it('kb_capture surfaces the rejection rather than storing the entry', async () => {
    await expect(kbCapture({
      type: 'learning',
      title: 'Uncheckable learning',
      summary: 'No files cited',
      content: 'A claim with nothing to check it against.',
      symbols: ['someSymbol'],
    })).rejects.toThrow(KbCaptureRejected);
  });
});

describe('rejection reaches the kb_import call site without killing the import', () => {
  it('drops unfalsifiable bible entries, keeps the checkable one, and reports rejected', async () => {
    // The rejectable entries come FIRST so a throw would abort the good one.
    const bible = [
      {
        id: 'bible-no-basis',
        type: 'knowledge',
        title: 'A bible entry citing nothing',
        summary: 'Unfalsifiable, exactly like the ones this work exists to drop.',
        symbols: ['ghostSymbol'],
        source_files: [],
        confidence: 'CONFIRMED',
      },
      {
        id: 'bible-dead-path',
        type: 'knowledge',
        title: 'A bible entry citing a path this repo does not have',
        summary: 'Cites a file moved away by a refactor.',
        symbols: ['movedSymbol'],
        source_files: ['src/kb/kb-server.ts'],
        confidence: 'CONFIRMED',
      },
      {
        id: 'bible-good',
        type: 'knowledge',
        title: 'A bible entry that still describes this tree',
        summary: 'Cites a file that is really here.',
        symbols: ['realSymbol'],
        source_files: ['src/real.ts'],
        confidence: 'CONFIRMED',
      },
    ];
    const biblePath = path.join(tmp, 'bible.json');
    fs.writeFileSync(biblePath, JSON.stringify(bible));

    const out = JSON.parse(await kbImport({ path: biblePath, repo: repo }));

    expect(out.rejected).toBe(2);
    expect(out.imported).toBe(1);

    const stored = (await provider.query({ ids: ['bible-good'] })).results[0];
    expect(stored).toBeTruthy();
    // Import remains the sole exemption from the confidence clamp.
    expect(stored.confidence).toBe('CONFIRMED');

    expect((await provider.query({ ids: ['bible-no-basis'] })).results.length).toBe(0);
    expect((await provider.query({ ids: ['bible-dead-path'] })).results.length).toBe(0);
  });
});

describe('rejection reaches the kb_harvest call site without killing the batch', () => {
  it('stores the checkable entry, counts the rejected one, and keeps going', async () => {
    // Two learnings: the first cites nothing, the second cites a real file.
    // The rejectable one comes FIRST so a throw would abort the valid one.
    const transcript = [
      'Note: this observation cites no file at all and cannot be checked by anyone.',
      '',
      'Important: the retry budget is enforced in src/real.ts and nowhere else at all.',
      '',
    ].join('\n');

    const out = JSON.parse(await kbHarvest({ repo_path: repo, session_transcript: transcript }));

    expect(out.entries_rejected).toBe(1);
    expect(out.entries_captured).toBe(1);

    const stored = await provider.query({ query: 'retry budget' });
    expect(stored.results.length).toBeGreaterThan(0);
  });

  it('reports entries_rejected alongside the three existing counters', async () => {
    const out = JSON.parse(await kbHarvest({
      repo_path: repo,
      session_transcript: 'Note: an unfalsifiable aside with no file reference whatsoever here.',
    }));

    expect(out).toHaveProperty('entries_captured');
    expect(out).toHaveProperty('entries_updated');
    expect(out).toHaveProperty('entries_skipped');
    expect(out).toHaveProperty('entries_rejected');
    expect(out.entries_rejected).toBe(1);
  });

  it('an empty transcript still reports the fourth counter', async () => {
    const out = JSON.parse(await kbHarvest({ repo_path: repo }));
    expect(out.entries_rejected).toBe(0);
  });
});
