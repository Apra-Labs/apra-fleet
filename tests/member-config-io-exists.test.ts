import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { memberFileExists } from '../src/services/member-config-io.js';

// memberFileExists: POSIX uses `test -e`; PowerShell must exit non-zero when
// Test-Path is false (a bare Test-Path exits 0 either way).

const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { timeout: 60_000 }).status === 0;

function recorder(code = 0) {
  const cmds: string[] = [];
  const exec = async (c: string) => { cmds.push(c); return { stdout: '', stderr: '', code }; };
  return { cmds, exec };
}

describe('memberFileExists command shape', () => {
  it('POSIX: test -e with the resolved path', async () => {
    const r = recorder(0);
    expect(await memberFileExists(r.exec, '/w/opencode.json', true)).toBe(true);
    expect(r.cmds).toEqual(['test -e "/w/opencode.json"']);
  });

  it('PowerShell: exit code reflects Test-Path; backslash path, quote-escaped', async () => {
    const r = recorder(1);
    expect(await memberFileExists(r.exec, "C:/Users/o'x/opencode.json", false)).toBe(false);
    expect(r.cmds[0]).toBe("if (Test-Path -LiteralPath 'C:\\Users\\o''x\\opencode.json') { exit 0 } else { exit 1 }");
  });
});

describe.skipIf(!hasPwsh)('memberFileExists live pwsh', () => {
  it('false for missing, true for existing (empty) file', async () => {
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
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
