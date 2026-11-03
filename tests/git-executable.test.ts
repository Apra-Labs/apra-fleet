// A git.exe planted in a work folder is never executed by fleet-server git
// spawns (apra-fleet-rx6b). Two layers:
//   1. Platform-independent unit cases of resolveGitExecutable with injected
//      PATH / PATHEXT / isFile / platform.
//   2. A real Windows-only case: a work folder with a planted git.exe (a link
//      or copy of node.exe that runs a planted <subcommand>.js writing a marker
//      file) is passed as the repo cwd to two real KB git call sites; the
//      marker must never appear and the real git answer must come back.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  resolveGitExecutable,
  defaultGitResolveDeps,
  GitNotFoundError,
  GIT_NOT_FOUND_CODE,
  type GitResolveDeps,
} from '../src/os/git-executable.js';
import { resolveProjectSlug } from '../src/services/knowledge/project-slug.js';
import { resolveRepositoryIdentity } from '../src/services/knowledge/repository-header.js';

function winDeps(over: Partial<GitResolveDeps> & { files: string[] }): GitResolveDeps {
  const files = new Set(over.files.map((f) => f.toLowerCase()));
  return {
    platform: 'win32',
    pathValue: over.pathValue,
    pathext: over.pathext ?? '.COM;.EXE;.BAT;.CMD',
    isFile: (p) => files.has(p.toLowerCase()),
  };
}

describe('resolveGitExecutable (injected deps, every OS)', () => {
  it('returns the bare name on POSIX platforms, without touching the filesystem', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const deps: GitResolveDeps = {
        platform, pathValue: '/usr/bin', pathext: undefined,
        isFile: () => { throw new Error('must not probe on POSIX'); },
      };
      expect(resolveGitExecutable(deps)).toBe('git');
    }
  });

  it('a git.exe in the cwd and in a PATH dir resolves to the PATH one', () => {
    const cwd = 'C:\\work\\repo';
    const deps = winDeps({
      pathValue: 'C:\\Program Files\\Git\\cmd',
      files: [`${cwd}\\git.exe`, 'C:\\Program Files\\Git\\cmd\\git.exe'],
    });
    expect(resolveGitExecutable(deps)).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
  });

  it('a git.exe only in the cwd resolves to the typed not-found error naming PATH', () => {
    const deps = winDeps({ pathValue: 'C:\\Windows\\System32', files: ['C:\\work\\repo\\git.exe'] });
    let err: unknown;
    try { resolveGitExecutable(deps); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GitNotFoundError);
    expect((err as GitNotFoundError).code).toBe(GIT_NOT_FOUND_CODE);
    expect((err as Error).message).toMatch(/PATH/);
  });

  it('relative and empty PATH entries are skipped (they would resolve against the cwd)', () => {
    const deps = winDeps({
      pathValue: ';.;bin;.\\tools;\\rooted-no-drive;"";  ;D:\\git\\cmd',
      files: ['git.exe', '.\\git.exe', 'bin\\git.exe', '.\\tools\\git.exe', '\\rooted-no-drive\\git.exe', 'D:\\git\\cmd\\git.exe'],
    });
    expect(resolveGitExecutable(deps)).toBe('D:\\git\\cmd\\git.exe');
  });

  it('only relative/empty PATH entries holding git -> not found, searched list excludes them', () => {
    const deps = winDeps({ pathValue: ';.;bin', files: ['git.exe', '.\\git.exe', 'bin\\git.exe'] });
    let err: unknown;
    try { resolveGitExecutable(deps); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GitNotFoundError);
    expect((err as GitNotFoundError).searched).toEqual([]);
  });

  it('honours PATHEXT order and never returns a shell-only .cmd/.bat shim', () => {
    const dir = 'C:\\tools';
    expect(resolveGitExecutable(winDeps({
      pathValue: dir, pathext: '.COM;.EXE', files: [`${dir}\\git.com`, `${dir}\\git.exe`],
    }))).toBe(`${dir}\\git.com`);
    expect(resolveGitExecutable(winDeps({
      pathValue: dir, pathext: '.EXE;.COM', files: [`${dir}\\git.com`, `${dir}\\git.exe`],
    }))).toBe(`${dir}\\git.exe`);
    expect(() => resolveGitExecutable(winDeps({
      pathValue: dir, pathext: '.CMD;.BAT;.EXE', files: [`${dir}\\git.cmd`, `${dir}\\git.bat`],
    }))).toThrow(GitNotFoundError);
  });

  it('strips quotes from a PATH entry and accepts UNC directories', () => {
    expect(resolveGitExecutable(winDeps({
      pathValue: '"C:\\Program Files\\Git\\cmd"', files: ['C:\\Program Files\\Git\\cmd\\git.exe'],
    }))).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(resolveGitExecutable(winDeps({
      pathValue: '\\\\server\\share\\git', files: ['\\\\server\\share\\git\\git.exe'],
    }))).toBe('\\\\server\\share\\git\\git.exe');
  });

  it('an unset PATH on win32 is a typed not-found error, not a crash', () => {
    expect(() => resolveGitExecutable(winDeps({ pathValue: undefined, files: [] }))).toThrow(GitNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Real Windows case.
// ---------------------------------------------------------------------------
const isWindows = process.platform === 'win32';
let realGit: string | undefined;
if (isWindows) {
  try { realGit = resolveGitExecutable(defaultGitResolveDeps()); } catch { realGit = undefined; }
}
const TMP_PREFIX = 'fleet-git-plant-';
const skipReason = !isWindows
  ? 'Windows-only: CreateProcess searches the spawn cwd before PATH only on win32'
  : !realGit ? 'git is not on PATH on this Windows host' : '';

function tmpEntries(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(TMP_PREFIX)).sort();
}

describe.skipIf(!!skipReason)(`planted git.exe in the work folder never runs (real Windows)${skipReason ? ` -- skipped: ${skipReason}` : ''}`, () => {
  let tmp: string;
  let repo: string;
  let marker: string;
  let before: string[];
  // NoDefaultCurrentDirectoryInExePath (any value) turns off the cwd search in
  // libuv / CreateProcess, which would hide the attack and make this case pass
  // even with a bare 'git'. Most hosts do not set it; remove it for the run so
  // the case exercises the default Windows search order, and restore it after.
  const NO_CWD_VAR = 'NoDefaultCurrentDirectoryInExePath';
  let savedNoCwd: string | undefined;

  beforeAll(() => {
    savedNoCwd = process.env[NO_CWD_VAR];
    delete process.env[NO_CWD_VAR];
    before = tmpEntries();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
    repo = path.join(tmp, 'repo');
    marker = path.join(tmp, 'PLANTED-GIT-RAN.txt');
    fs.mkdirSync(repo);
    // Real repo with an origin, built with the absolute real git BEFORE planting.
    const git = (args: string[]) => execFileSync(realGit!, args, { cwd: repo, stdio: 'ignore', windowsHide: true });
    git(['init', '-q']);
    git(['remote', 'add', 'origin', 'https://example.test/acme/planted-repo.git']);
    // Plant git.exe = node.exe. Run as `git.exe remote get-url origin` with the
    // repo as cwd, node loads ./remote.js -- which writes the marker.
    const planted = path.join(repo, 'git.exe');
    try { fs.linkSync(process.execPath, planted); } catch { fs.copyFileSync(process.execPath, planted); }
    const payload = `require('fs').appendFileSync(${JSON.stringify(marker)}, process.argv.join(' ') + '\\n');\n`;
    for (const sub of ['remote', 'rev-parse', 'init', 'hash-object', 'status']) {
      fs.writeFileSync(path.join(repo, `${sub}.js`), payload);
    }
  });

  afterAll(() => {
    if (savedNoCwd !== undefined) process.env[NO_CWD_VAR] = savedNoCwd;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    // No leftover files outside (or of) the temp dir.
    expect(tmpEntries()).toEqual(before);
  });

  it('resolveProjectSlug answers from the real git and the planted git.exe never runs', () => {
    const slug = resolveProjectSlug(repo);
    expect(fs.existsSync(marker), fs.existsSync(marker) ? fs.readFileSync(marker, 'utf-8') : '').toBe(false);
    expect(slug).not.toBe('default');
    expect(slug).toContain('planted-repo');
  });

  it('resolveRepositoryIdentity answers from the real git and the planted git.exe never runs', () => {
    const id = resolveRepositoryIdentity(repo);
    expect(fs.existsSync(marker), fs.existsSync(marker) ? fs.readFileSync(marker, 'utf-8') : '').toBe(false);
    expect(id?.remote).toContain('planted-repo');
  });
});
