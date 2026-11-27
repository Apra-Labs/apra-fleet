import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { exporterSerialization, checkBibleFile } from '../scripts/check-kb-canonical.mjs';

// The local check for a merge of the base branch INTO a KB branch: it must
// name every bible entry the branch owns (absent from the base bible, or
// different there) whose cited files changed at HEAD, exit non-zero, and exit
// 0 once the entry is re-stamped per the documented procedure. Entries
// identical to the base bible are never reported, re-stamped or dropped.
// Real git repositories in temp dirs; the script runs as a child process.

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'check-kb-bible-drift.mjs');
const BIBLE = '.fleet/kb-canonical.json';
const AT = '2026-01-01T00:00:00.000Z';
const OWNED_ID = 'b0b0-owned-entry-citing-f';
const BASE_ID = 'a0a0-base-entry-citing-g';
const F = 'src/f.ts';
const G = 'src/g.ts';

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(dir: string, args: string[]): string {
  return execFileSync('git', [
    '-c', 'user.name=drift-test', '-c', 'user.email=drift-test@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
  ], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(dir: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

function commitAll(dir: string, message: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', message]);
}

function blobAtHead(dir: string, rel: string): string {
  return git(dir, ['rev-parse', `HEAD:${rel}`]).trim();
}

function entry(id: string, file: string, hash: string): Record<string, unknown> {
  return {
    id, type: 'knowledge', title: 'Title ' + id, summary: 'Summary ' + id, symbols: [],
    source_files: [file], confidence: 'CONFIRMED', updated_at: AT,
    source_file_hashes: { [file]: hash },
  };
}

function writeBible(dir: string, entries: Record<string, unknown>[]): void {
  const sorted = [...entries].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  write(dir, BIBLE, exporterSerialization({ version: 3, provenance: { branch: 'main' }, entries: sorted }));
}

function readBible(dir: string): { entries: Array<Record<string, any>> } {
  return JSON.parse(fs.readFileSync(path.join(dir, BIBLE), 'utf8'));
}

function runCheck(dir: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * main: F and G at v1, a bible holding BASE_ID (cites G, stamped at v1).
 * kb (the branch): adds OWNED_ID (cites F, stamped at v1).
 * main then changes F and G to v2; the branch merges main.
 */
function mergedKbBranch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-drift-'));
  tmpDirs.push(dir);
  git(dir, ['init', '--quiet', '-b', 'main']);
  write(dir, F, 'export const f = 1;\n');
  write(dir, G, 'export const g = 1;\n');
  commitAll(dir, 'base: files');
  const baseEntry = entry(BASE_ID, G, blobAtHead(dir, G));
  writeBible(dir, [baseEntry]);
  commitAll(dir, 'base: bible');

  git(dir, ['checkout', '--quiet', '-b', 'kb']);
  writeBible(dir, [baseEntry, entry(OWNED_ID, F, blobAtHead(dir, F))]);
  commitAll(dir, 'kb: own bible entry');

  git(dir, ['checkout', '--quiet', 'main']);
  write(dir, F, 'export const f = 2;\n');
  write(dir, G, 'export const g = 2;\n');
  commitAll(dir, 'base: change cited files');

  git(dir, ['checkout', '--quiet', 'kb']);
  git(dir, ['merge', '--quiet', '--no-edit', 'main']);
  return dir;
}

describe('check-kb-bible-drift: owned bible entries after a base merge (real git)', () => {
  it('reports the owned entry whose cited file the base changed, then exits 0 after a re-stamp; the base entry is never reported or touched', () => {
    const dir = mergedKbBranch();
    const baseEntryBefore = readBible(dir).entries.find((e) => e.id === BASE_ID);

    const first = runCheck(dir, ['--base', 'main']);
    expect(first.status).toBe(1);
    expect(first.stderr).toContain(OWNED_ID);
    expect(first.stderr).toContain(`${F} (changed)`);
    // G changed too, but BASE_ID is identical to the base bible: not the branch's.
    expect(first.stderr).not.toContain(BASE_ID);
    expect(first.stderr).not.toContain(G);

    // Re-stamp per docs/kb-bible-correctness.md (option 2): only the named,
    // re-verified id; then commit and re-run.
    const restamp = runCheck(dir, ['--base', 'main', '--restamp', OWNED_ID]);
    expect(restamp.status, restamp.stderr).toBe(0);
    const after = readBible(dir);
    expect(after.entries.find((e) => e.id === OWNED_ID)!.source_file_hashes).toEqual({ [F]: blobAtHead(dir, F) });
    expect(after.entries.find((e) => e.id === BASE_ID)).toEqual(baseEntryBefore);
    expect(checkBibleFile(path.join(dir, BIBLE)).problems).toEqual([]);
    commitAll(dir, 'kb: re-stamp after base merge');

    const second = runCheck(dir, ['--base', 'main']);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toMatch(/all 1 bible entry this branch owns \(vs main\) match/);
  });

  it('refuses to re-stamp an entry the branch does not own, leaving the bible unchanged', () => {
    const dir = mergedKbBranch();
    const before = fs.readFileSync(path.join(dir, BIBLE), 'utf8');
    const r = runCheck(dir, ['--base', 'main', '--restamp', BASE_ID]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`entry ${BASE_ID} is not an owned entry with a drifted basis`);
    expect(fs.readFileSync(path.join(dir, BIBLE), 'utf8')).toBe(before);
  });

  it('reports an owned entry whose cited file is gone at HEAD and refuses to re-stamp it', () => {
    const dir = mergedKbBranch();
    git(dir, ['rm', '--quiet', F]);
    git(dir, ['commit', '--quiet', '-m', 'kb: drop f']);
    const r = runCheck(dir, ['--base', 'main']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${OWNED_ID}`);
    expect(r.stderr).toContain(`${F} (absent)`);
    const re = runCheck(dir, ['--base', 'main', '--restamp', OWNED_ID]);
    expect(re.status).toBe(2);
    expect(re.stderr).toMatch(/withdraw it instead of re-stamping/);
  });

  it('names the exact one-line re-stamp command for the drifted ids', () => {
    const dir = mergedKbBranch();
    const r = runCheck(dir, ['--base', 'main']);
    expect(r.status).toBe(1);
    const line = r.stderr.split('\n').find((l) => l.startsWith('Re-stamp (after re-verifying): '));
    expect(line).toBe(`Re-stamp (after re-verifying): node scripts/check-kb-bible-drift.mjs --base main --restamp ${OWNED_ID}`);
    // The printed command works as given, and the check then passes.
    const args = line!.replace('Re-stamp (after re-verifying): node scripts/check-kb-bible-drift.mjs ', '').split(' ');
    expect(runCheck(dir, args).status).toBe(0);
    commitAll(dir, 'kb: re-stamp');
    expect(runCheck(dir, ['--base', 'main']).status).toBe(0);
  });

  it('passes a branch whose own entry is fine when the base changed a file only an entry the BASE owns cites', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-drift-'));
    tmpDirs.push(dir);
    git(dir, ['init', '--quiet', '-b', 'main']);
    write(dir, F, 'export const f = 1;\n');
    write(dir, G, 'export const g = 1;\n');
    commitAll(dir, 'base: files');
    const baseEntry = entry(BASE_ID, G, blobAtHead(dir, G));
    writeBible(dir, [baseEntry]);
    commitAll(dir, 'base: bible');
    git(dir, ['checkout', '--quiet', '-b', 'kb']);
    writeBible(dir, [baseEntry, entry(OWNED_ID, F, blobAtHead(dir, F))]);
    commitAll(dir, 'kb: own entry');
    git(dir, ['checkout', '--quiet', 'main']);
    write(dir, G, 'export const g = 2;\n');
    commitAll(dir, 'base: change a file only the base entry cites');
    // The merge queue's view: the PR merged with the base tip.
    git(dir, ['checkout', '--quiet', 'kb']);
    git(dir, ['merge', '--quiet', '--no-edit', 'main']);
    const r = runCheck(dir, ['--base', 'main']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/all 1 bible entry this branch owns/);
  });

  it('decides ownership against the merge-base: a base entry the base changed after the branch last merged it is not the branch\'s', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-drift-'));
    tmpDirs.push(dir);
    git(dir, ['init', '--quiet', '-b', 'main']);
    write(dir, G, 'export const g = 1;\n');
    commitAll(dir, 'base: file');
    writeBible(dir, [entry(BASE_ID, G, blobAtHead(dir, G))]);
    commitAll(dir, 'base: bible');
    git(dir, ['checkout', '--quiet', '-b', 'kb']);
    write(dir, G, 'export const g = 2;\n');
    commitAll(dir, 'kb: edit the cited file (the base entry is the base\'s to keep current)');
    git(dir, ['checkout', '--quiet', 'main']);
    writeBible(dir, [{ ...entry(BASE_ID, G, blobAtHead(dir, G)), summary: 'Summary revised on the base after the branch point' }]);
    commitAll(dir, 'base: revise the entry (not merged into kb)');
    git(dir, ['checkout', '--quiet', 'kb']);
    const r = runCheck(dir, ['--base', 'main']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/all 0 bible entries this branch owns/);
  });

  it('with core.autocrlf=true (CRLF work tree) the work-tree bible is not "uncommitted": --restamp works and writes exporter-format (LF) JSON', () => {
    const dir = mergedKbBranch();
    git(dir, ['config', 'core.autocrlf', 'true']);
    // Re-materialise the bible as a CRLF work-tree file, exactly as a
    // Windows checkout produces it.
    fs.rmSync(path.join(dir, BIBLE));
    git(dir, ['checkout', '--', BIBLE]);
    expect(fs.readFileSync(path.join(dir, BIBLE), 'utf8')).toContain('\r\n');
    expect(git(dir, ['status', '--porcelain']).trim()).toBe('');

    const r = runCheck(dir, ['--base', 'main', '--restamp', OWNED_ID]);
    expect(r.status, r.stderr).toBe(0);
    expect(checkBibleFile(path.join(dir, BIBLE)).problems).toEqual([]);
    commitAll(dir, 'kb: re-stamp (crlf)');
    expect(runCheck(dir, ['--base', 'main']).status).toBe(0);
  });

  it('still refuses to re-stamp when the work-tree bible has a real uncommitted change (autocrlf on)', () => {
    const dir = mergedKbBranch();
    git(dir, ['config', 'core.autocrlf', 'true']);
    const file = path.join(dir, BIBLE);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Summary ' + OWNED_ID, 'Edited summary'));
    const r = runCheck(dir, ['--base', 'main', '--restamp', OWNED_ID]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('has uncommitted changes');
  });

  it('exits 0 with no bible at HEAD, and 2 for a base ref that does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-drift-'));
    tmpDirs.push(dir);
    git(dir, ['init', '--quiet', '-b', 'main']);
    write(dir, F, 'x\n');
    commitAll(dir, 'init');
    const none = runCheck(dir, ['--base', 'main']);
    expect(none.status).toBe(0);
    expect(none.stdout).toMatch(/no bible at HEAD/);

    writeBible(dir, [entry(OWNED_ID, F, blobAtHead(dir, F))]);
    commitAll(dir, 'bible');
    const bad = runCheck(dir, ['--base', 'no-such-branch']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/does not name a commit/);
  });
});
