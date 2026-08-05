import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbImport } from '../../src/tools/kb-import.js';
import { kbExport } from '../../src/tools/kb-export.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { FLEET_DIR } from '../../src/paths.js';

/**
 * apra-fleet-ong: kb_export silently truncated the COMMITTED team bible when
 * cited files were absent from the worktree, and auto-committed the truncation.
 *
 * The original reproduction: import a 97-entry bible into a worktree that does
 * not contain every cited file -> the post-import freshness sweep correctly
 * stales the entries whose basis is missing -> kb_export correctly emits only
 * CONFIRMED-and-non-stale -> 15 entries are written and AUTO-COMMITTED. Every
 * step behaved as designed; the COMPOSITION lost 82 entries from the shared
 * artifact other machines import from, with no human in the loop.
 *
 * This is the chain test the bug's done-criteria asked for: import -> sweep ->
 * export -> commit, in a real git worktree missing some cited files. It pins
 * the two things that make the loss survivable now:
 *
 *   1. Phase 1 refuses a missing/absent basis at CAPTURE, so those entries are
 *      COUNTED as rejected at import rather than silently vanishing later.
 *   2. Auto-commit defaults to off, so a shrunken export lands as a reviewable
 *      working-tree diff and the committed artifact at HEAD is untouched.
 *
 * The last case is deliberately unflattering: it records that an explicit
 * autoCommit opt-in STILL commits a truncation. That is the documented override
 * path, not a guarantee -- the protection here is the default, not a size guard.
 */

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
}

/** Commit with an explicit identity so the test never depends on global git config. */
function gitCommit(dir: string, message: string): void {
  git(dir, ['-c', 'user.name=test', '-c', 'user.email=test@test.local', 'commit', '-q', '-m', message]);
}

function bibleEntry(id: string, sourceFiles: string[]) {
  return {
    id,
    type: 'knowledge',
    title: 'Entry ' + id,
    summary: 'A claim recorded in the bible under id ' + id + '.',
    symbols: ['symbol_' + id],
    source_files: sourceFiles,
    confidence: 'CONFIRMED',
    updated_at: '2026-07-01T00:00:00.000Z',
  };
}

/**
 * Five CONFIRMED entries, mirroring the shape of the real 97-entry bible: two
 * cite a file this worktree really has, three cite files it does not (the
 * ephemeral sprint artifacts and moved paths that caused the original loss).
 */
const BIBLE = [
  bibleEntry('aaa-present-1', ['src/present.ts']),
  bibleEntry('bbb-present-2', ['src/present.ts']),
  bibleEntry('ccc-absent-1', ['PLAN.md']),
  bibleEntry('ddd-absent-2', ['src/kb/moved-away.ts']),
  bibleEntry('eee-no-basis', []),
];

const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');

let repoDir: string;
let provider: SqliteProvider;
let biblePath: string;
let priorConfig: string | null = null;

/** The path git reports and kb_export writes, relative to the repo root. */
const BIBLE_REL = '.fleet/kb-canonical.json';

beforeEach(async () => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ong-'));
  git(repoDir, ['init', '--quiet']);

  // The one cited file this worktree actually has.
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'present.ts'), 'export const present = 1;\n');

  // The bible is a COMMITTED artifact -- that is the thing ong could truncate.
  // A bible sitting only in the working tree would make the test vacuous.
  fs.mkdirSync(path.join(repoDir, '.fleet'), { recursive: true });
  biblePath = path.join(repoDir, '.fleet', 'kb-canonical.json');
  fs.writeFileSync(biblePath, JSON.stringify(BIBLE, null, 2) + '\n');
  git(repoDir, ['add', '-A']);
  gitCommit(repoDir, 'seed: repo with a committed 5-entry bible');

  provider = new SqliteProvider(':memory:', repoDir);
  await provider.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
    project: provider,
    global: provider,
    projectSlug: 'test',
  } as any);

  priorConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
  // Default state for every case: no config at all, so autoCommit is the default.
  if (fs.existsSync(KB_CONFIG_PATH)) fs.unlinkSync(KB_CONFIG_PATH);
});

afterEach(() => {
  provider.close();
  vi.restoreAllMocks();
  fs.rmSync(repoDir, { recursive: true, force: true });
  if (priorConfig !== null) {
    fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, priorConfig);
  } else if (fs.existsSync(KB_CONFIG_PATH)) {
    fs.unlinkSync(KB_CONFIG_PATH);
  }
});

/** The committed bible at HEAD -- the artifact other machines pull and import. */
function bibleAtHead(): unknown {
  return JSON.parse(git(repoDir, ['show', 'HEAD:' + BIBLE_REL]));
}

function headSha(): string {
  return git(repoDir, ['rev-parse', 'HEAD']).trim();
}

describe('apra-fleet-ong: import -> sweep -> export -> commit in a worktree missing cited files', () => {
  it('counts the entries it drops instead of losing them silently', async () => {
    const report = JSON.parse(await kbImport({ path: biblePath, repo: repoDir }));

    // Three entries cannot be checked against this worktree: two cite absent
    // files, one cites nothing at all. Phase 1 refuses them at the capture
    // choke point and the import REPORTS the count -- the loss is now visible
    // at the moment it happens, which is the half of ong that was silent.
    expect(report.rejected).toBe(3);
    expect(report.imported).toBe(2);
  });

  it('does not commit the shrunken bible, leaving the artifact at HEAD intact', async () => {
    const shaBefore = headSha();

    await kbImport({ path: biblePath, repo: repoDir });
    const result = JSON.parse(await kbExport({ repo_path: repoDir }));

    // The export DOES shrink: 5 committed entries in, 2 exported out.
    expect(result.exported).toBe(2);

    // ong's core failure was that this shrink got committed. It must not.
    expect(result.committed).toBe(false);
    expect(headSha()).toBe(shaBefore);

    // The committed artifact still holds all five entries. Anyone pulling this
    // repo still gets the full bible.
    expect(bibleAtHead()).toHaveLength(5);

    // No pm-kb commit was created at all.
    expect(git(repoDir, ['log', '--format=%an|%s'])).not.toContain('pm-kb');
  });

  it('leaves the truncation as a reviewable working-tree diff', async () => {
    await kbImport({ path: biblePath, repo: repoDir });
    await kbExport({ repo_path: repoDir });

    // The shrink is on disk and dirty -- a human can see and reject it. The
    // whole point of defaulting auto-commit off is that this diff gets read.
    const status = git(repoDir, ['status', '--porcelain', '--', BIBLE_REL]).trim();
    expect(status).not.toBe('');
    expect(status).toContain(BIBLE_REL);
  });

  it('makes the shrink legible in the diff via the v2 entry_count', async () => {
    await kbImport({ path: biblePath, repo: repoDir });
    await kbExport({ repo_path: repoDir });

    const written = JSON.parse(fs.readFileSync(biblePath, 'utf-8'));
    // A reader diffing this file sees the count drop, not just a shorter list.
    expect(written.version).toBe(2);
    expect(written.provenance.entry_count).toBe(2);
    expect(written.entries).toHaveLength(2);
    expect(written.entries.map((e: { id: string }) => e.id)).toEqual(['aaa-present-1', 'bbb-present-2']);
  });

  it('survives a re-import of its own truncated output without further loss', async () => {
    await kbImport({ path: biblePath, repo: repoDir });
    await kbExport({ repo_path: repoDir });

    // Round two, against the v2 file the export just wrote. The two survivors
    // are already present by id, so they are skipped rather than re-added, and
    // nothing new is rejected: the truncation does not compound on each cycle.
    const second = JSON.parse(await kbImport({ path: biblePath, repo: repoDir }));
    expect(second.rejected).toBe(0);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(2);
  });
});

describe('apra-fleet-ong: the explicit autoCommit opt-in is an override, not a guard', () => {
  it('still commits a shrinking export when the operator opts in', async () => {
    fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ bible: { autoCommit: true } }));

    await kbImport({ path: biblePath, repo: repoDir });
    const result = JSON.parse(await kbExport({ repo_path: repoDir }));

    // Recorded honestly: opting in re-arms the original failure. There is no
    // shrink-size guard -- the protection is that this is off by default and
    // turning it on is a deliberate act. If a guard is ever wanted, THIS is the
    // assertion that must flip.
    expect(result.committed).toBe(true);
    expect(bibleAtHead()).toHaveProperty('provenance.entry_count', 2);
  });
});
