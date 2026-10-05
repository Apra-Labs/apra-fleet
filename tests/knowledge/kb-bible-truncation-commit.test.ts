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
 * the things that make the loss impossible (project) or survivable (global):
 *
 *   1. Phase 1 refuses a missing/absent basis at CAPTURE, so those entries are
 *      COUNTED as rejected at import rather than silently vanishing later.
 *   2. PROJECT scope: the export is additive. Entries already in the bible are
 *      never removed, so the composition cannot truncate the project bible at
 *      all -- with nothing new to add the file is left byte-identical and no
 *      commit is made, whatever the autoCommit setting.
 *   3. GLOBAL scope still rewrites its file from the live CONFIRMED set, so the
 *      size guard still matters there: under the DEFAULT, auto-commit refuses a
 *      SHRINKING export (reviewable working-tree diff, HEAD untouched), and an
 *      explicit autoCommit opt-in is the documented override that commits it --
 *      deliberately unflattering, not a guarantee.
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

  it('project export never shrinks the bible: file byte-identical, HEAD untouched, no commit', async () => {
    const shaBefore = headSha();
    const bytesBefore = fs.readFileSync(biblePath);

    await kbImport({ path: biblePath, repo: repoDir });
    const result = JSON.parse(await kbExport({ repo_path: repoDir }));

    // The project export is additive: all five committed entries stay, and the
    // two surviving KB entries are already present by id, so nothing is added.
    expect(result.exported).toBe(5);
    expect(result.committed).toBe(false);
    expect(fs.readFileSync(biblePath).equals(bytesBefore)).toBe(true);
    expect(headSha()).toBe(shaBefore);
    expect(bibleAtHead()).toHaveLength(5);
    expect(git(repoDir, ['log', '--format=%an|%s'])).not.toContain('pm-kb');
  });

  it('leaves no working-tree diff on the project bible at all', async () => {
    await kbImport({ path: biblePath, repo: repoDir });
    await kbExport({ repo_path: repoDir });

    const status = git(repoDir, ['status', '--porcelain', '--', BIBLE_REL]).trim();
    expect(status).toBe('');
  });

  it('survives a re-import of the untouched bible without further loss', async () => {
    await kbImport({ path: biblePath, repo: repoDir });
    await kbExport({ repo_path: repoDir });

    // Round two, against the same (untouched) file. The two survivors are
    // already present by id, so they are skipped rather than re-added; the
    // three uncheckable entries are counted again; the bible keeps all five.
    const second = JSON.parse(await kbImport({ path: biblePath, repo: repoDir }));
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.rejected).toBe(3);
    expect(JSON.parse(fs.readFileSync(biblePath, 'utf-8'))).toHaveLength(5);
  });

  it('an explicit autoCommit opt-in still cannot truncate the project bible', async () => {
    fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ bible: { autoCommit: true } }));
    const shaBefore = headSha();

    await kbImport({ path: biblePath, repo: repoDir });
    const result = JSON.parse(await kbExport({ repo_path: repoDir }));

    expect(result.committed).toBe(false);
    expect(headSha()).toBe(shaBefore);
    expect(bibleAtHead()).toHaveLength(5);
  });
});

// The GLOBAL bible is still rewritten from the live CONFIRMED set, so the
// shrink guard in kb_export's auto-commit is still load-bearing there. Same
// five-entry seed, committed as the global bible file. (The mocked providers
// point global at the same store the import fills.)
const GLOBAL_BIBLE_REL = '.fleet/kb-canonical-global.json';

function seedCommittedGlobalBible(): void {
  fs.writeFileSync(path.join(repoDir, GLOBAL_BIBLE_REL), JSON.stringify(BIBLE, null, 2));
  git(repoDir, ['add', GLOBAL_BIBLE_REL]);
  gitCommit(repoDir, 'seed: committed 5-entry global bible');
}

function globalBibleAtHead(): unknown {
  return JSON.parse(git(repoDir, ['show', 'HEAD:' + GLOBAL_BIBLE_REL]));
}

describe('apra-fleet-ong: global-scope shrink guard', () => {
  it('does not commit a shrunken global bible under the default, leaving HEAD intact', async () => {
    seedCommittedGlobalBible();
    const shaBefore = headSha();

    await kbImport({ path: biblePath, repo: repoDir });
    const result = JSON.parse(await kbExport({ repo_path: repoDir, scope: 'global' }));

    // The global export DOES shrink: 5 committed entries in, 2 exported out.
    expect(result.exported).toBe(2);
    expect(result.committed).toBe(false);
    expect(headSha()).toBe(shaBefore);
    expect(globalBibleAtHead()).toHaveLength(5);
    expect(git(repoDir, ['log', '--format=%an|%s'])).not.toContain('pm-kb');

    // The truncation is on disk and dirty -- a human can see and reject it --
    // and legible in the diff via the v2 entry_count.
    const status = git(repoDir, ['status', '--porcelain', '--', GLOBAL_BIBLE_REL]).trim();
    expect(status).toContain(GLOBAL_BIBLE_REL);
    const written = JSON.parse(fs.readFileSync(path.join(repoDir, GLOBAL_BIBLE_REL), 'utf-8'));
    expect(written.version).toBe(2);
    expect(written.provenance.entry_count).toBe(2);
    expect(written.entries.map((e: { id: string }) => e.id)).toEqual(['aaa-present-1', 'bbb-present-2']);
  });

  it('still commits a shrinking global export when the operator opts in', async () => {
    seedCommittedGlobalBible();
    fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ bible: { autoCommit: true } }));

    await kbImport({ path: biblePath, repo: repoDir });
    const result = JSON.parse(await kbExport({ repo_path: repoDir, scope: 'global' }));

    // Recorded honestly: opting in re-arms the original failure for the global
    // file. If a guard is ever wanted there, THIS is the assertion that must flip.
    expect(result.committed).toBe(true);
    expect(globalBibleAtHead()).toHaveProperty('provenance.entry_count', 2);
  });
});
