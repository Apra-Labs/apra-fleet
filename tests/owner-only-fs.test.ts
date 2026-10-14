import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restrictToOwner, ensureOwnerOnlyDir, openOwnerOnlyAppend } from '../src/utils/owner-only-fs.js';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-only-fs-'));
  tmpDirs.push(d);
  return d;
}

describe('owner-only-fs on Windows (execFile mocked)', () => {
  it('runs icacls with inheritance removed and a full-control grant for the current user only', () => {
    const calls: Array<[string, string[]]> = [];
    const execFile = (file: string, args: string[]) => { calls.push([file, args]); };
    expect(restrictToOwner('C:\\fleet\\fleet.log', 'file', { platform: 'win32', execFile, windowsUser: 'CORP\\alice' })).toBeNull();
    expect(restrictToOwner('C:\\fleet', 'dir', { platform: 'win32', execFile, windowsUser: 'CORP\\alice' })).toBeNull();
    expect(calls).toEqual([
      ['icacls', ['C:\\fleet\\fleet.log', '/inheritance:r', '/grant:r', 'CORP\\alice:F']],
      ['icacls', ['C:\\fleet', '/inheritance:r', '/grant:r', 'CORP\\alice:(OI)(CI)F']],
    ]);
  });

  it('reports an icacls failure as a reason instead of throwing', () => {
    const execFile = () => { throw new Error('icacls exited 5'); };
    const why = restrictToOwner('C:\\fleet', 'dir', { platform: 'win32', execFile, windowsUser: 'alice' });
    expect(why).toContain('icacls exited 5');
  });
});

describe.skipIf(process.platform === 'win32')('owner-only-fs on POSIX', () => {
  it('creates dirs 0700 and files 0600, and tightens a pre-existing 0644 file / 0755 dir', () => {
    const root = tmp();
    const dir = path.join(root, 'data', 'logs');
    expect(ensureOwnerOnlyDir(dir)).toEqual([]);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);

    const fresh = path.join(dir, 'fresh.log');
    const problems: string[] = [];
    fs.closeSync(openOwnerOnlyAppend(fresh, problems));
    expect(problems).toEqual([]);
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o600);

    const loose = path.join(dir, 'loose.log');
    fs.writeFileSync(loose, 'x', { mode: 0o644 });
    fs.chmodSync(loose, 0o644);
    fs.closeSync(openOwnerOnlyAppend(loose, problems));
    expect(fs.statSync(loose).mode & 0o777).toBe(0o600);

    const looseDir = path.join(root, 'loose-dir');
    fs.mkdirSync(looseDir, { mode: 0o755 });
    fs.chmodSync(looseDir, 0o755);
    expect(ensureOwnerOnlyDir(looseDir)).toEqual([]);
    expect(fs.statSync(looseDir).mode & 0o777).toBe(0o700);
  });
});
