import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { wrapPowerShellEncoded, WindowsCommands } from '../src/os/windows.js';

/**
 * apra-fleet-ot2z.12: on PS 5.1, `powershell -EncodedCommand <script>`'s raw
 * exit-code behavior already surfaces most non-terminating cmdlet failures as
 * exit 1 (verified live: Get-Item on a missing path, Set-Content to an
 * unwritable path both already exit 1 with no wrapping at all).
 * wrapPowerShellEncoded()'s real value is (a) correctly suppressing exit 1
 * for a failure the caller genuinely opted out of via an explicit
 * `-ErrorAction SilentlyContinue` on an individual cmdlet, and (b)
 * preserving a native command's exit code (via $LASTEXITCODE) that would
 * otherwise be masked by the wrapper's own `exit 0`.
 */
function decode(cmd: string): string {
  const m = cmd.match(/^powershell -EncodedCommand (.+)$/);
  expect(m).not.toBeNull();
  return Buffer.from(m![1], 'base64').toString('utf16le');
}

describe('wrapPowerShellEncoded: error-handling scaffold', () => {
  it('prepends $ErrorActionPreference = \'Stop\'', () => {
    const decoded = decode(wrapPowerShellEncoded('Write-Output "hi"'));
    expect(decoded).toContain("$ErrorActionPreference = 'Stop'");
  });

  it('wraps the script body in try/catch that exits non-zero, propagating a native $LASTEXITCODE', () => {
    const decoded = decode(wrapPowerShellEncoded('Write-Output "hi"'));
    expect(decoded).toMatch(/try \{ Write-Output "hi"; if \(\$LASTEXITCODE -ne \$null -and \$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}; exit 0 \} catch \{ Write-Error \$_; exit 1 \}/);
  });

  it('places $ErrorActionPreference before the try block', () => {
    const decoded = decode(wrapPowerShellEncoded('Write-Output "hi"'));
    const prefIdx = decoded.indexOf('$ErrorActionPreference');
    const tryIdx = decoded.indexOf('try {');
    expect(prefIdx).toBeGreaterThanOrEqual(0);
    expect(tryIdx).toBeGreaterThan(prefIdx);
  });

  it('preserves an explicit -ErrorAction SilentlyContinue on an individual cmdlet (deleteFiles-style tolerance)', () => {
    const decoded = decode(wrapPowerShellEncoded('Remove-Item "gone.txt" -Force -ErrorAction SilentlyContinue'));
    expect(decoded).toContain('-ErrorAction SilentlyContinue');
  });
});

describe('WindowsCommands.gitCurrentBranch: no POSIX shell constructs', () => {
  it('does not emit a POSIX `2>/dev/null || true` -- uses a PowerShell try/catch instead', () => {
    const cmds = new WindowsCommands();
    const cmd = cmds.gitCurrentBranch('C:\\work\\repo');

    expect(cmd).not.toContain('2>/dev/null');
    expect(cmd).not.toContain('|| true');
    expect(cmd).toContain('try {');
    expect(cmd).toContain('git -C "C:\\work\\repo" branch --show-current');
  });
});

// Only run the live PowerShell assertions on actual Windows where a real
// `powershell` binary is available (Windows dev machines / windows-latest CI
// runners). These tests use Windows-only constructs (cmd.exe, batch exit
// codes) that a `powershell`/`pwsh` binary on macOS/Linux won't behave the
// same for, so require the platform check too, not just binary presence.
// Other platforms in the CI OS matrix skip this without failing the suite.
const hasPowerShell = process.platform === 'win32' && (() => {
  try {
    execSync('powershell -Command "$true"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(hasPowerShell)('wrapPowerShellEncoded: live PowerShell exit codes', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'wpse-test-'));
  const failBat = join(tmpDir, 'fail.bat');
  writeFileSync(failBat, '@echo off\r\nexit /b 7\r\n');

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a native command exit code (via $LASTEXITCODE) is preserved, not swallowed by the wrapper exit 0', () => {
    // Regression test: the wrapper used to `exit 0` unconditionally after the
    // try block, silently swallowing a failing native command's exit code
    // (e.g. a broken credential-helper .bat) even though PowerShell itself
    // does not throw a terminating error for a non-zero native exit code.
    const cmd = wrapPowerShellEncoded(`& "${failBat}"`);
    let code = 0;
    try {
      execSync(cmd, { stdio: 'ignore' });
    } catch (e) {
      code = (e as { status?: number }).status ?? 1;
    }
    expect(code).toBe(7);
  }, 20000);

  it('a script with no error still exits 0', () => {
    const cmd = wrapPowerShellEncoded('Write-Output "ok"');
    const out = execSync(cmd, { encoding: 'utf-8' });
    expect(out.trim()).toBe('ok');
  }, 20000);

  it('deleteFiles-style SilentlyContinue tolerance still exits 0 on a missing file', () => {
    const cmd = wrapPowerShellEncoded('Remove-Item "C:\\this\\path\\does\\not\\exist.txt" -Force -ErrorAction SilentlyContinue');
    let code: number | undefined = 0;
    try {
      execSync(cmd, { stdio: 'ignore' });
    } catch (e) {
      code = (e as { status?: number }).status;
    }
    expect(code).toBe(0);
  }, 20000);
});
