import { describe, it, expect, beforeEach, afterEach, afterAll, vi, inject } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { KB_HOOK_MARKER, _setKbInvalidateCommandOverride } from '../../src/tools/kb-invalidate.js';
import { FLEET_DIR } from '../../src/paths.js';
import { isolateGitConfig } from './isolate-git-config.js';
import { releaseFileDataDir, fileDataDirViolations } from '../helpers/file-kb-data-dir.js';
import { FLEET_DIR as ISOLATED_FLEET_DIR } from '../../src/paths.js';
import { KB_CONFIG_PATH as ISOLATED_KB_CONFIG_PATH } from '../../src/services/knowledge/kb-config.js';

// This file's OWN fleet data dir, claimed before any src module loads
// (src/paths.ts fixes FLEET_DIR at import). The per-run data dir tests/setup.ts
// provides is shared by every file of the run, and so is the KB config file
// in it (<data dir>/knowledge/config.json), which this file writes and the
// code under test reads.
const fileDataDir = await vi.hoisted(async () =>
  (await import('../helpers/file-kb-data-dir.js')).claimFileDataDir('kb-setup-hook-outside-tree'));
afterAll(() => releaseFileDataDir(fileDataDir));

// ISOLATION GUARD: fails if this suite reads the run-shared data dir again --
// the hoisted claim removed, moved below the imports (FLEET_DIR is then fixed
// to the shared dir), or the dir not unique to this file.
describe('isolation guard', () => {
  it('this suite reads its own fleet data dir and KB config file, not the run-shared ones', () => {
    expect(fileDataDirViolations({
      label: 'kb-setup-hook-outside-tree', claimed: fileDataDir, fleetDir: ISOLATED_FLEET_DIR,
      kbConfigPath: ISOLATED_KB_CONFIG_PATH, runSharedDir: inject('APRA_FLEET_TEST_DATA_DIR'),
    })).toEqual([]);
  });
});

// Regression for the kb_setup post-commit hook: it must run `kb invalidate`
// through an absolute, JS-resolved command (so it works in a repo that is not
// an apra-fleet build tree), surface a failure on stderr, never overwrite a
// foreign hook, and upgrade an old-body hook that carries our marker.
// Real git in a temp repo; the invalidate command is a stub entry point that
// records its argv, so the effect of a real commit is observable.

const configPath = path.join(FLEET_DIR, 'knowledge', 'config.json');
const HOOK_STEP = 'Installed git post-commit hook for KB invalidation';

let rootDir: string;
let repo: string;
let stubLog: string;
let savedConfig: string | null;
let restoreGitConfig: () => void;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
}

function commit(file: string, content: string): { status: number | null; stderr: string } {
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, 'add', file);
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', `add ${file}`], {
    cwd: repo, encoding: 'utf8', windowsHide: true,
  });
  return { status: r.status, stderr: r.stderr };
}

// The stub lives in a directory with a space in its name, so shell quoting is exercised.
function useStub(exitCode: number): void {
  const dir = path.join(rootDir, 'stub dir');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'fake-fleet.js');
  fs.writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(stubLog)}, process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(${exitCode});\n`);
  _setKbInvalidateCommandOverride([process.execPath, script]);
}

const hookPath = () => path.join(repo, '.git', 'hooks', 'post-commit');

beforeEach(() => {
  restoreGitConfig = isolateGitConfig();
  rootDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-hook-outside-')));
  repo = path.join(rootDir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  stubLog = path.join(rootDir, 'calls.log');
  savedConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
  fs.rmSync(configPath, { force: true });
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
  if (savedConfig === null) fs.rmSync(configPath, { force: true });
  else fs.writeFileSync(configPath, savedConfig);
  restoreGitConfig();
});

describe('kb_setup post-commit hook outside the apra-fleet build tree', () => {
  it('keeps a foreign post-commit byte-identical and reports the skip', async () => {
    const foreign = '#!/bin/sh\necho team hook\n';
    fs.mkdirSync(path.dirname(hookPath()), { recursive: true });
    fs.writeFileSync(hookPath(), foreign);

    const result = JSON.parse(await kbSetup({}, { folder: repo }));

    expect(fs.readFileSync(hookPath(), 'utf-8')).toBe(foreign);
    expect(result.steps).not.toContain(HOOK_STEP);
    expect(result.steps.some((s: string) => /^Skipped git hook: existing post-commit at .* is not ours$/.test(s))).toBe(true);
  });

  it('installs a hook with no relative dist path or shell expansion, and a real commit invalidates through it', async () => {
    useStub(0);
    const result = JSON.parse(await kbSetup({}, { folder: repo }));
    expect(result.steps).toContain(HOOK_STEP);

    const text = fs.readFileSync(hookPath(), 'utf-8');
    expect(text).toContain(KB_HOOK_MARKER);
    // Old body: `node dist/index.js ...`, resolvable only inside a build tree.
    expect(text).not.toMatch(/(^|\s)node\s+dist\//m);
    expect(text).not.toMatch(/['"\s]dist\/index\.js/);
    expect(text).not.toMatch(/\$HOME|~\/|`/);
    expect(text).not.toContain('2>/dev/null');
    expect(text).not.toMatch(/\|\| true/);

    // cwd of the commit is a temp repo, not the build tree.
    expect(repo.startsWith(process.cwd())).toBe(false);
    const r = commit('a.txt', 'one');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(stubLog, 'utf-8').trim()).toBe('kb invalidate a.txt');
  });

  it('writes a stderr diagnostic, still lets the commit succeed, when the invalidate command fails', async () => {
    useStub(3);
    await kbSetup({}, { folder: repo });

    const r = commit('b.txt', 'two');

    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/apra-fleet: KB invalidation failed for b\.txt/);
  });

  it('upgrades an old-body hook carrying our marker, in place', async () => {
    useStub(0);
    fs.mkdirSync(path.dirname(hookPath()), { recursive: true });
    fs.writeFileSync(hookPath(), `#!/bin/sh\n${KB_HOOK_MARKER}\ngit diff-tree -r --name-only HEAD | while read f; do node dist/index.js kb invalidate "$f" 2>/dev/null || true; done\n`);

    const result = JSON.parse(await kbSetup({}, { folder: repo }));

    expect(result.steps).toContain(HOOK_STEP);
    expect(fs.readFileSync(hookPath(), 'utf-8')).not.toContain('node dist/index.js');
    commit('c.txt', 'three');
    expect(fs.readFileSync(stubLog, 'utf-8').trim()).toBe('kb invalidate c.txt');
  });

  it('skips the hook with a surfaced reason, writing nothing, when no absolute command can be resolved', async () => {
    _setKbInvalidateCommandOverride(['relative/index.js']);

    const result = JSON.parse(await kbSetup({}, { folder: repo }));

    expect(fs.existsSync(hookPath())).toBe(false);
    expect(result.steps.some((s: string) => /^Skipped git hook: cannot build a working hook/.test(s))).toBe(true);
  });
});
