// End-to-end: KB store and bible round trip for content, recall_cues,
// error_signatures and the kb_invalidate retirement reason (design D9/D3).
//
// Runs the REAL MCP tool handlers (kb_capture, kb_promote, kb_export,
// kb_bible_commit, kb_import, kb_invalidate) against REAL SqliteProviders
// whose databases live inside a per-test sandbox directory, anchored at two
// scratch git clones (A exports, B imports) inside the same sandbox. Only the
// provider lookup is redirected (getKbProviders -> the sandbox providers), so
// no KB database is ever created under the fleet data dir. Every scenario
// asserts on file bytes or stored values, not on tool success flags.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { FLEET_DIR } from '../../src/paths.js';
import { kbCapture, kbCaptureSchema } from '../../src/tools/kb-capture.js';
import { kbPromote } from '../../src/tools/kb-promote.js';
import { kbExport } from '../../src/tools/kb-export.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { kbImport } from '../../src/tools/kb-import.js';
import { kbInvalidate, kbInvalidateSchema } from '../../src/tools/kb-invalidate.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'memory-contract', 'v1', 'bible', 'kb-canonical.schema.json'), 'utf-8'));
// A checked-in v3 bible with NO content/recall_cues/error_signatures. Its
// source_file_hashes are the git blob ids of the sandbox's src/alpha.ts and
// src/beta.ts (FILES below), so the entries pass bible admission at HEAD.
const OLD_BIBLE_FIXTURE = path.join(__dirname, 'fixtures', 'kb-bible-v3-no-rich-fields.json');
const FILES: Record<string, string> = {
  'src/alpha.ts': 'export const alpha = 1;\n',
  'src/beta.ts': 'export const beta = 2;\n',
};
const BASE = { baseBranch: 'main', baseCommit: '1111111111111111111111111111111111111111' };

let sandbox: string;
let repoA: string;
let repoB: string;
let providerA: SqliteProvider;
let providerB: SqliteProvider;
let savedGitEnv: Array<[string, string | undefined]>;

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(name: string): string {
  const root = path.join(sandbox, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  git(root, ['init', '-q', '.']);
  git(root, ['remote', 'add', 'origin', 'git@github.com:acme/kb-rich-' + name + '.git']);
  for (const [rel, text] of Object.entries(FILES)) fs.writeFileSync(path.join(root, rel), text);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--no-verify', '-m', 'seed']);
  return root;
}

/** Every file under dir (relative path -> size:mtime), or {} when dir is absent. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else {
        const st = fs.statSync(p);
        out[path.relative(dir, p)] = st.size + ':' + st.mtimeMs;
      }
    }
  };
  walk(dir);
  return out;
}

// Persistent state outside the sandbox this test must never touch: the fleet
// data dir (where an unredirected provider would create kb.sqlite) and this
// repository's own .fleet dir (where an unanchored export would write).
const guarded = () => ({ fleetData: snapshot(FLEET_DIR), repoFleet: snapshot(path.join(REPO_ROOT, '.fleet')) });
let before: ReturnType<typeof guarded>;

beforeEach(async () => {
  before = guarded();
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-rich-e2e-')));
  // Git identity and an empty global config, both inside the sandbox, so the
  // export's local auto-commit works and no developer config is read.
  const gitconfig = path.join(sandbox, '.gitconfig');
  fs.writeFileSync(gitconfig, '[user]\n\tname = KB Test\n\temail = kb@test.invalid\n[commit]\n\tgpgsign = false\n');
  savedGitEnv = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].map(k => [k, process.env[k]]);
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  repoA = makeRepo('a');
  repoB = makeRepo('b');
  providerA = new SqliteProvider(path.join(sandbox, 'kb-a.sqlite'), repoA);
  providerB = new SqliteProvider(path.join(sandbox, 'kb-b.sqlite'), repoB);
  await providerA.init();
  await providerB.init();
  vi.spyOn(kbProvidersModule, 'getKbProviders').mockImplementation(async (repoPath?: string) => {
    const p = repoPath !== undefined && path.resolve(repoPath) === repoB ? providerB : providerA;
    return { project: p, global: p, projectSlug: 'kb-rich' } as any;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  providerA.close();
  providerB.close();
  for (const [k, v] of savedGitEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
  // Nothing outside the sandbox was written.
  expect(guarded()).toEqual(before);
});

const A = () => ({ folder: repoA });
const B = () => ({ folder: repoB });
const capture = async (args: Record<string, unknown>, anchor = A()) =>
  JSON.parse(await kbCapture(kbCaptureSchema.parse({ type: 'learning', source_files: ['src/alpha.ts'], ...args }), anchor));
const stored = async (p: SqliteProvider, id: string) => (await p.query({ ids: [id] })).results[0];
const bibleBytes = (repo: string) => fs.readFileSync(path.join(repo, '.fleet', 'kb-canonical.json'), 'utf-8');
const bibleEntry = (repo: string, id: string) => JSON.parse(bibleBytes(repo)).entries.find((e: { id: string }) => e.id === id);
function validateBible(text: string): void {
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(SCHEMA);
  const ok = validate(JSON.parse(text));
  expect(validate.errors ?? []).toEqual([]);
  expect(ok).toBe(true);
}

const RICH = {
  title: 'alpha must be read before beta is initialised',
  summary: 'Reading beta before alpha throws during module init.',
  content: 'Module init order: src/beta.ts reads alpha at load time.\nImporting beta first raised a ReferenceError in the test runner; importing alpha first fixed it.',
  symbols: ['alpha', 'beta'],
  source_files: ['src/alpha.ts', 'src/beta.ts'],
  trigger: 'test-failure',
  recall_cues: ['why does importing beta throw', 'module init order alpha beta'],
  error_signatures: ['ReferenceError: Cannot access \'alpha\' before initialization'],
};

describe('KB store and bible round trip (real handlers, sandboxed SqliteProvider)', () => {
  it('1+5: capture -> promote -> export/bible-commit writes content, recall_cues, error_signatures; a fresh KB import reproduces them; the bible validates', async () => {
    const { id } = await capture(RICH);
    await kbPromote({ id, reason: 'verified: reproduced the ReferenceError and the fix' }, A());
    // The trigger is stored for audit (not exported).
    expect((await stored(providerA, id)).trigger).toBe('test-failure');

    const exported = JSON.parse(await kbExport(BASE, A()));
    expect(exported.path.startsWith(sandbox + path.sep)).toBe(true);
    const text = bibleBytes(repoA);
    const entry = bibleEntry(repoA, id);
    expect(entry.content).toBe(RICH.content);
    expect(entry.recall_cues).toEqual(RICH.recall_cues);
    expect(entry.error_signatures).toEqual(RICH.error_signatures);
    expect(entry.trigger).toBeUndefined();
    // 5: the exported file validates against the published bible schema.
    validateBible(text);

    // kb_bible_commit (entry-level merge) writes the same three fields.
    const second = await capture({ ...RICH, title: 'second rich lesson', symbols: ['betaLoader'], source_files: ['src/beta.ts'], recall_cues: ['beta cue'], error_signatures: ['Error: beta'], content: 'Second lesson body, not the summary.' });
    await kbPromote({ id: second.id, reason: 'verified: second lesson checked by hand' }, A());
    await kbBibleCommit({ ids: [second.id], ...BASE }, A());
    const committed = bibleEntry(repoA, second.id);
    expect(committed.content).toBe('Second lesson body, not the summary.');
    expect(committed.recall_cues).toEqual(['beta cue']);
    expect(committed.error_signatures).toEqual(['Error: beta']);
    validateBible(bibleBytes(repoA));

    // A second, fresh KB imports that file and reproduces the fields exactly.
    const biblePath = path.join(repoA, '.fleet', 'kb-canonical.json');
    await kbImport({ path: biblePath }, B());
    for (const [eid, want] of [[id, RICH], [second.id, committed]] as const) {
      const got = await stored(providerB, eid);
      expect(got.content).toBe(want.content);
      expect(got.recall_cues).toEqual(want.recall_cues);
      expect(got.error_signatures).toEqual(want.error_signatures);
      expect(got.confidence).toBe('CONFIRMED');
    }
  });

  it('2: an old v3 bible imports with content = summary and no cues, and re-exports byte-identically', async () => {
    const fixture = fs.readFileSync(OLD_BIBLE_FIXTURE, 'utf-8');
    const result = JSON.parse(await kbImport({ path: OLD_BIBLE_FIXTURE }, B()));
    expect(result.imported).toBe(2);
    for (const e of JSON.parse(fixture).entries) {
      const got = await stored(providerB, e.id);
      expect(got.content).toBe(e.summary);
      expect(got.recall_cues).toEqual([]);
      expect(got.error_signatures).toEqual([]);
      expect(got.confidence).toBe('CONFIRMED');
    }
    await kbExport(BASE, B());
    expect(bibleBytes(repoB)).toBe(fixture);
  });

  it('3: kb_capture without content stores content = summary, and its export carries no content field', async () => {
    const { id } = await capture({ title: 'summary-only lesson', summary: 'alpha is exported as a const, never let.', symbols: ['alpha'] });
    expect((await stored(providerA, id)).content).toBe('alpha is exported as a const, never let.');
    await kbPromote({ id, reason: 'verified: read src/alpha.ts at HEAD' }, A());
    await kbExport(BASE, A());
    const text = bibleBytes(repoA);
    const entry = bibleEntry(repoA, id);
    expect(Object.keys(entry).sort()).toEqual(
      ['confidence', 'id', 'source_file_hashes', 'source_files', 'summary', 'symbols', 'title', 'type', 'updated_at'],
    );
    expect(text).not.toMatch(/"content"/);
    validateBible(text);
  });

  it('4: kb_invalidate {ids, reason} retires the entry with the reason readable from the store; without reason the shape is unchanged', async () => {
    const withReason = await capture({ title: 'retire me with a reason', summary: 'This lesson only described the change.', symbols: ['alpha'] });
    const plain = await capture({ title: 'retire me plainly', summary: 'Another lesson that only described a change.', symbols: ['beta'], source_files: ['src/beta.ts'] });

    const out1 = JSON.parse(await kbInvalidate(kbInvalidateSchema.parse({ ids: [withReason.id], reason: 'describes the change, not a lesson' }), A()));
    expect(out1).toEqual({ discarded: [withReason.id], not_found: [], already_discarded: [] });
    const r1 = await stored(providerA, withReason.id);
    expect(r1.superseded_at).toBeTruthy();
    expect(r1.retired_note).toBe('describes the change, not a lesson');

    const out2 = JSON.parse(await kbInvalidate(kbInvalidateSchema.parse({ ids: [plain.id] }), A()));
    expect(Object.keys(out2).sort()).toEqual(['already_discarded', 'discarded', 'not_found']);
    expect(out2).toEqual({ discarded: [plain.id], not_found: [], already_discarded: [] });
    const r2 = await stored(providerA, plain.id);
    expect(r2.superseded_at).toBeTruthy();
    expect(r2.retired_note).toBeUndefined();
  });
});
