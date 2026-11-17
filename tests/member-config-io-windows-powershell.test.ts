import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  readMemberFile, writeMemberFile, deleteMemberFile, memberFileExists, readMemberJson,
  isGitTracked, resolveGitExcludePath, ensureGitExcluded, removeGitExcluded,
  type MemberExecFn,
} from '../src/services/member-config-io.js';

// REAL Windows PowerShell 5.1 (powershell.exe, what a Windows member's shell
// is) driving the member config read/write and git-exclude command builders
// end to end. Every command is produced by member-config-io.ts's own builders
// -- no command string is copied here -- so a quoting change in that module is
// exercised as shipped. Gated on process.platform ONLY: on a win32 host this
// suite always runs (a missing powershell.exe or git is a FAILURE, not a
// skip), so the Windows path can never silently drop out of the suite.

const isWin = process.platform === 'win32';

/** -EncodedCommand, as the product does for PowerShell members. */
const powershellExec = (cwd: string): MemberExecFn => async (command) => {
  const enc = Buffer.from(command, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc], {
    cwd, encoding: 'utf8', timeout: 60_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
};

const tmpPrefix = 'mcio-winps-';
const tmpLeft = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith(tmpPrefix));

describe.runIf(isWin)('member config IO + git exclude on real Windows PowerShell 5.1', () => {
  let root: string;
  let tmpBefore: string[];

  beforeAll(() => {
    tmpBefore = tmpLeft();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix)));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
    expect(tmpLeft()).toEqual(tmpBefore);
  });

  it('the shell under test is Windows PowerShell 5.x (not pwsh 7)', async () => {
    const r = await powershellExec(root)('[Console]::Out.Write($PSVersionTable.PSVersion.Major)');
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('5');
  });

  it('write / read / exists / delete round trip on a path with a space and a $', async () => {
    const dir = path.join(root, 'a dir$x');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'cfg.json');
    const exec = powershellExec(root);

    expect(await memberFileExists(exec, file, false)).toBe(false);
    expect(await readMemberFile(exec, file, false)).toBe('');
    await writeMemberFile(exec, file, '{"mcpServers":{"a":{"type":"http"}}}', false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ mcpServers: { a: { type: 'http' } } });
    expect(await readMemberJson(exec, file, false)).toEqual({ mcpServers: { a: { type: 'http' } } });
    expect(await memberFileExists(exec, file, false)).toBe(true);
    expect(await memberFileExists(exec, dir, false)).toBe(false); // a directory is not a file
    await deleteMemberFile(exec, file, false);
    expect(fs.existsSync(file)).toBe(false);
    // Nothing else appeared (no $x expansion into a sibling path).
    expect(fs.readdirSync(root).sort()).toEqual(['a dir$x']);
  }, 120_000);

  it('git exclude: resolves .git/info/exclude, adds and removes the anchored line, never tracks', async () => {
    const wf = path.join(root, 'work folder');
    fs.mkdirSync(wf);
    execFileSync('git', ['init', '-q', wf]);
    const exec = powershellExec(root);

    const excludePath = await resolveGitExcludePath(exec, wf, true, 'powershell5');
    expect(excludePath).not.toBeNull();
    expect(path.resolve(excludePath as string).toLowerCase())
      .toBe(path.join(wf, '.git', 'info', 'exclude').toLowerCase());

    fs.writeFileSync(path.join(wf, 'opencode.json'), '{}');
    expect(await isGitTracked(exec, wf, 'opencode.json', true, false)).toBe(false);

    await ensureGitExcluded(exec, wf, ['opencode.json', '.claude/settings.local.json'], true, 'powershell5');
    const lines = () => fs.readFileSync(path.join(wf, '.git', 'info', 'exclude'), 'utf8').split(/\r?\n/).map(l => l.trim());
    expect(lines()).toContain('/opencode.json');
    expect(lines()).toContain('/.claude/settings.local.json');
    // Idempotent: a second ensure adds nothing.
    const once = fs.readFileSync(path.join(wf, '.git', 'info', 'exclude'), 'utf8');
    await ensureGitExcluded(exec, wf, ['opencode.json'], true, 'powershell5');
    expect(fs.readFileSync(path.join(wf, '.git', 'info', 'exclude'), 'utf8')).toBe(once);
    // The excluded file no longer shows the clone as dirty.
    expect(execFileSync('git', ['-C', wf, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');

    await removeGitExcluded(exec, wf, ['opencode.json'], true, 'powershell5');
    expect(lines()).not.toContain('/opencode.json');
    expect(lines()).toContain('/.claude/settings.local.json');

    // A tracked file reads as tracked through the same shell.
    execFileSync('git', ['-C', wf, 'add', 'opencode.json']);
    expect(await isGitTracked(exec, wf, 'opencode.json', true, false)).toBe(true);
  }, 120_000);

  it('not a git repository: resolveGitExcludePath is null and ensureGitExcluded writes nothing', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    const exec = powershellExec(root);
    expect(await resolveGitExcludePath(exec, plain, true, 'powershell5')).toBeNull();
    await ensureGitExcluded(exec, plain, ['opencode.json'], true, 'powershell5');
    expect(fs.readdirSync(plain)).toEqual([]);
  }, 120_000);
});
