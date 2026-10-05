import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { memberFileExists } from '../src/services/member-config-io.js';

// memberFileExists: true only for a regular FILE -- POSIX uses `test -f`;
// PowerShell uses Test-Path -PathType Leaf and must exit non-zero when it is
// false (a bare Test-Path exits 0 either way). A directory reads as false.

const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { timeout: 60_000 }).status === 0;

function recorder(code = 0) {
  const cmds: string[] = [];
  const exec = async (c: string) => { cmds.push(c); return { stdout: '', stderr: '', code }; };
  return { cmds, exec };
}

describe('memberFileExists command shape', () => {
  it('POSIX: test -f with the resolved path', async () => {
    const r = recorder(0);
    expect(await memberFileExists(r.exec, '/w/opencode.json', true)).toBe(true);
    expect(r.cmds).toEqual(['test -f "/w/opencode.json"']);
  });

  it('PowerShell: exit code reflects Test-Path; backslash path, quote-escaped', async () => {
    const r = recorder(1);
    expect(await memberFileExists(r.exec, "C:/Users/o'x/opencode.json", false)).toBe(false);
    expect(r.cmds[0]).toBe("if (Test-Path -LiteralPath 'C:\\Users\\o''x\\opencode.json' -PathType Leaf) { exit 0 } else { exit 1 }");
  });
});

describe.skipIf(process.platform === 'win32')('memberFileExists live POSIX shell', () => {
  it('false for missing, true for existing (empty) file, false for a directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfe-'));
    try {
      const exec = async (c: string) => {
        const r = spawnSync('sh', ['-c', c], { encoding: 'utf8', timeout: 30_000 });
        return { stdout: r.stdout, stderr: r.stderr, code: r.status ?? 1 };
      };
      const file = path.join(dir, 'opencode.json');
      fs.writeFileSync(file, '');
      fs.mkdirSync(path.join(dir, 'adir.json'));
      expect(await memberFileExists(exec, file, true)).toBe(true);
      expect(await memberFileExists(exec, path.join(dir, 'missing.json'), true)).toBe(false);
      expect(await memberFileExists(exec, path.join(dir, 'adir.json'), true)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasPwsh)('memberFileExists live pwsh', () => {
  it('false for missing, true for existing (empty) file, false for a directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfe-'));
    try {
      const file = path.join(dir, 'opencode.json');
      fs.writeFileSync(file, '');
      const exec = async (c: string) => {
        const r = spawnSync('pwsh', ['-NoProfile', '-Command', c], { encoding: 'utf8', timeout: 60_000 });
        return { stdout: r.stdout, stderr: r.stderr, code: r.status ?? 1 };
      };
      expect(await memberFileExists(exec, file, false)).toBe(true);
      expect(await memberFileExists(exec, path.join(dir, 'missing.json'), false)).toBe(false);
      fs.mkdirSync(path.join(dir, 'adir.json'));
      expect(await memberFileExists(exec, path.join(dir, 'adir.json'), false)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
