import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { restrictToOwner, ensureOwnerOnlyDir, openOwnerOnlyAppend, currentWindowsUser, ownerOnlyInstallWarnings } from '../src/utils/owner-only-fs.js';

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

  it('currentWindowsUser reads the process token (whoami), not env USERDOMAIN=WORKGROUP', () => {
    const saved = process.env.USERDOMAIN;
    process.env.USERDOMAIN = 'WORKGROUP';
    try {
      expect(currentWindowsUser(() => 'desktop-1\\alice\r\n')).toBe('desktop-1\\alice');
    } finally {
      if (saved === undefined) delete process.env.USERDOMAIN; else process.env.USERDOMAIN = saved;
    }
    expect(currentWindowsUser(() => { throw new Error('no whoami'); })).toBe(os.userInfo().username);
    expect(currentWindowsUser(() => 'garbled-no-domain')).toBe(os.userInfo().username);
  });

  it('ownerOnlyInstallWarnings prints a loud [!] line naming the file and the icacls fix on failure', () => {
    const root = tmp();
    const key = path.join(root, 'member-access.key');
    fs.writeFileSync(key, 'x');
    const execFile = () => { throw new Error('No mapping between account names and security IDs'); };
    const lines = ownerOnlyInstallWarnings(
      [{ path: root, kind: 'dir' }, { path: key, kind: 'file' }, { path: path.join(root, 'missing'), kind: 'file' }],
      { platform: 'win32', execFile, windowsUser: 'desktop-1\\alice' },
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^ {4}\[!\] /);
    expect(lines[0]).toContain(`icacls "${root}" /inheritance:r /grant:r "desktop-1\\alice:(OI)(CI)F"`);
    expect(lines[1]).toContain(key);
    expect(lines[1]).toContain('No mapping between account names');
    expect(lines[1]).toContain(`icacls "${key}" /inheritance:r /grant:r "desktop-1\\alice:F"`);
    expect(ownerOnlyInstallWarnings([{ path: key, kind: 'file' }], { platform: 'win32', execFile: () => {}, windowsUser: 'a' })).toEqual([]);
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
