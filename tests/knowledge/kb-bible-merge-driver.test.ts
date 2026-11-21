/**
 * In a clone set up by kb_setup, a LOCAL git merge or rebase of two
 * bible-changing branches resolves through the bible merge driver
 * (`apra-fleet kb merge-driver`, registered by kb_setup as git config
 * merge.<name>.driver plus a line in the clone's info/attributes).
 *
 * Real git in a temp dir; the driver runs the BUILT CLI (dist/index.js), so
 * run `npm run build` first. A control clone without kb_setup shows the same
 * merge conflicting under git's line merge, which proves the driver did the work.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { _setKbInvalidateCommandOverride } from '../../src/tools/kb-invalidate.js';
import { serializeBible } from '../../src/services/knowledge/bible-merge.js';
import { BIBLE_MERGE_DRIVER_NAME, BIBLE_ATTRIBUTES_LINE, buildBibleMergeDriverCommand, installBibleMergeDriver } from '../../src/cli/kb-merge-driver.js';
import { KB_CONFIG_PATH } from '../../src/services/knowledge/kb-config.js';
// @ts-expect-error -- plain .mjs script without type declarations
import { checkBibleFile } from '../../scripts/check-kb-canonical.mjs';
import { isolateGitConfig } from './isolate-git-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const BIBLE = path.join('.fleet', 'kb-canonical.json');

let root: string;
let savedConfig: string | null;
let restoreGitConfig: () => void;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function gitStatus(cwd: string, ...args: string[]): number {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).status ?? -1;
}

function entry(id: string, summary = `summary ${id}`): Record<string, unknown> {
  return { id, type: 'knowledge', title: `title ${id}`, summary, symbols: [], source_files: ['src/a.ts'], confidence: 'CONFIRMED' };
}
function bible(entries: Array<Record<string, unknown>>, demotions: Array<Record<string, unknown>> = []): string {
  return serializeBible({ version: 3, provenance: { branch: 'main' }, entries, ...(demotions.length > 0 ? { demotions } : {}) });
}
const WITHDRAWN_B = { id: 'b', at: '2026-01-02T00:00:00.000Z', reason: 'withdrawn', note: 'no longer holds after the refactor', evidence_files: ['src/a.ts'] };

function commitBible(repo: string, text: string, msg: string): void {
  fs.mkdirSync(path.join(repo, '.fleet'), { recursive: true });
  fs.writeFileSync(path.join(repo, BIBLE), text);
  git(repo, 'add', BIBLE);
  git(repo, 'commit', '-q', '-m', msg);
}

/**
 * main: entries a, b, c. Branch ours edits entry b's summary and adds d.
 * Branch theirs withdraws b (entry removed, withdrawn tombstone added) and adds e.
 * Both rewrite the lines around b, so git's line merge conflicts.
 */
function makeOrigin(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  commitBible(dir, bible([entry('a'), entry('b'), entry('c')]), 'base');
  git(dir, 'checkout', '-q', '-b', 'ours');
  commitBible(dir, bible([entry('a'), entry('b', 'ours rewrote this summary'), entry('c'), entry('d')]), 'ours');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'checkout', '-q', '-b', 'theirs');
  commitBible(dir, bible([entry('a'), entry('c'), entry('e')], [WITHDRAWN_B]), 'theirs');
  git(dir, 'checkout', '-q', 'main');
}

function cloneOf(origin: string, dir: string): string {
  git(root, 'clone', '-q', origin, dir);
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'checkout', '-q', '-b', 'ours', 'origin/ours');
  return dir;
}

function readBible(repo: string): { entries: Array<{ id: string }>; demotions?: Array<{ id: string; reason: string }> } {
  return JSON.parse(fs.readFileSync(path.join(repo, BIBLE), 'utf8'));
}

beforeAll(() => {
  if (!fs.existsSync(DIST_INDEX)) throw new Error(`built CLI missing at ${DIST_INDEX}: run npm run build first`);
});

beforeEach(() => {
  restoreGitConfig = isolateGitConfig();
  _setKbInvalidateCommandOverride([process.execPath, DIST_INDEX]);
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bible-driver-')));
  savedConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (savedConfig === null) fs.rmSync(KB_CONFIG_PATH, { force: true });
  else fs.writeFileSync(KB_CONFIG_PATH, savedConfig);
  restoreGitConfig();
});

describe('kb_setup registers the bible merge driver in the clone', () => {
  it('writes local git config and the info/attributes line, idempotently, using absolute paths', async () => {
    const origin = path.join(root, 'origin');
    makeOrigin(origin);
    const clone = cloneOf(origin, path.join(root, 'clone'));

    const result = JSON.parse(await kbSetup({}, { folder: clone }));
    expect(result.steps.some((s: string) => s.startsWith('Registered the knowledge bible merge driver'))).toBe(true);
    await kbSetup({}, { folder: clone });

    const driver = git(clone, 'config', '--local', `merge.${BIBLE_MERGE_DRIVER_NAME}.driver`);
    expect(driver).toBe(buildBibleMergeDriverCommand([process.execPath, DIST_INDEX]));
    expect(driver).toContain('kb merge-driver %O %A %B %P');
    const attributes = fs.readFileSync(path.join(clone, '.git', 'info', 'attributes'), 'utf8');
    expect(attributes.split('\n').filter((l) => l === BIBLE_ATTRIBUTES_LINE)).toHaveLength(1);
    expect(git(clone, 'check-attr', 'merge', '--', BIBLE)).toBe(`${BIBLE}: merge: ${BIBLE_MERGE_DRIVER_NAME}`);
  });

  it('refuses a relative command rather than registering a driver that cannot run', () => {
    const repo = path.join(root, 'r');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    const r = installBibleMergeDriver(repo, ['node', 'dist/index.js']);
    expect(r.installed).toBe(false);
    expect(gitStatus(repo, 'config', '--local', `merge.${BIBLE_MERGE_DRIVER_NAME}.driver`)).not.toBe(0);
  });
});

describe('a local merge of two bible-changing branches', () => {
  it('conflicts under git line merge in a clone WITHOUT kb_setup (control)', () => {
    const origin = path.join(root, 'origin');
    makeOrigin(origin);
    const clone = cloneOf(origin, path.join(root, 'plain'));
    expect(gitStatus(clone, 'merge', '--no-edit', 'origin/theirs')).not.toBe(0);
    expect(fs.readFileSync(path.join(clone, BIBLE), 'utf8')).toMatch(/^<<<<<<< /m);
  });

  it('resolves automatically in a clone set up by kb_setup: tombstone wins, both sides kept, file validates', async () => {
    const origin = path.join(root, 'origin');
    makeOrigin(origin);
    const clone = cloneOf(origin, path.join(root, 'clone'));
    await kbSetup({}, { folder: clone });

    expect(gitStatus(clone, 'merge', '--no-edit', 'origin/theirs')).toBe(0);
    const text = fs.readFileSync(path.join(clone, BIBLE), 'utf8');
    expect(text).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
    const merged = readBible(clone);
    expect(merged.entries.map((e) => e.id)).toEqual(['a', 'c', 'd', 'e']);
    expect(merged.demotions).toEqual([WITHDRAWN_B]);
    expect(git(clone, 'status', '--porcelain')).toBe('');
    expect(checkBibleFile(path.join(clone, BIBLE)).problems).toEqual([]);
  });

  it('resolves a rebase the same way', async () => {
    const origin = path.join(root, 'origin');
    makeOrigin(origin);
    const clone = cloneOf(origin, path.join(root, 'clone'));
    await kbSetup({}, { folder: clone });

    expect(gitStatus(clone, 'rebase', '-q', 'origin/theirs')).toBe(0);
    const merged = readBible(clone);
    expect(merged.entries.map((e) => e.id)).toEqual(['a', 'c', 'd', 'e']);
    expect(merged.demotions).toEqual([WITHDRAWN_B]);
    expect(checkBibleFile(path.join(clone, BIBLE)).problems).toEqual([]);
  });

  it('leaves a genuine tombstone conflict as a git conflict with markers', async () => {
    const origin = path.join(root, 'origin');
    makeOrigin(origin);
    // Both branches tombstone c, differently.
    git(origin, 'checkout', '-q', 'ours');
    commitBible(origin, bible([entry('a'), entry('b', 'ours rewrote this summary'), entry('d')], [{ id: 'c', at: '2026-01-03T00:00:00.000Z', reason: 'demoted' }]), 'ours demotes c');
    git(origin, 'checkout', '-q', 'theirs');
    commitBible(origin, bible([entry('a'), entry('e')], [WITHDRAWN_B, { ...WITHDRAWN_B, id: 'c' }]), 'theirs withdraws c');
    git(origin, 'checkout', '-q', 'main');
    const clone = cloneOf(origin, path.join(root, 'clone'));
    await kbSetup({}, { folder: clone });

    expect(gitStatus(clone, 'merge', '--no-edit', 'origin/theirs')).not.toBe(0);
    expect(fs.readFileSync(path.join(clone, BIBLE), 'utf8')).toMatch(/^<<<<<<< /m);
    expect(git(clone, 'diff', '--name-only', '--diff-filter=U')).toBe(BIBLE.split(path.sep).join('/'));
  });
});
