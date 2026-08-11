import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { wrapPowerShellEncoded } from '../src/os/windows.js';

/**
 * apra-fleet-ot2z.12: `powershell -EncodedCommand <script>` exits 0 unless a
 * *terminating* error occurs. Non-terminating failures (Set-Content
 * access-denied, Remove-Item failure, a cmdlet erroring under the default
 * $ErrorActionPreference='Continue') write to stderr but still return exit
 * code 0, so callers checking the exit code can't see them.
 *
 * wrapPowerShellEncoded() now forces $ErrorActionPreference = 'Stop' and
 * wraps the script body in try/catch { Write-Error $_; exit 1 } so
 * non-terminating errors become terminating ones and surface as a non-zero
 * exit code.
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

  it('wraps the script body in try/catch that exits non-zero', () => {
    const decoded = decode(wrapPowerShellEncoded('Write-Output "hi"'));
    expect(decoded).toMatch(/try \{ Write-Output "hi"; exit 0 \} catch \{ Write-Error \$_; exit 1 \}/);
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

// Only run the live PowerShell assertions where a real `powershell` binary is
// available (Windows dev machines / windows-latest CI runners). Other
// platforms in the CI OS matrix skip this without failing the suite.
const hasPowerShell = (() => {
  try {
    execSync('powershell -Command "$true"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(hasPowerShell)('wrapPowerShellEncoded: live PowerShell exit codes', () => {
  it('a non-terminating cmdlet failure now yields a non-zero exit code', () => {
    const cmd = wrapPowerShellEncoded('Get-Item -Path "C:\\this\\path\\does\\not\\exist.txt"');
    let code = 0;
    try {
      execSync(cmd, { stdio: 'ignore' });
    } catch (e) {
      code = (e as { status?: number }).status ?? 1;
    }
    expect(code).not.toBe(0);
  });

  it('a script with no error still exits 0', () => {
    const cmd = wrapPowerShellEncoded('Write-Output "ok"');
    const out = execSync(cmd, { encoding: 'utf-8' });
    expect(out.trim()).toBe('ok');
  });

  it('deleteFiles-style SilentlyContinue tolerance still exits 0 on a missing file', () => {
    const cmd = wrapPowerShellEncoded('Remove-Item "C:\\this\\path\\does\\not\\exist.txt" -Force -ErrorAction SilentlyContinue');
    let code: number | undefined = 0;
    try {
      execSync(cmd, { stdio: 'ignore' });
    } catch (e) {
      code = (e as { status?: number }).status;
    }
    expect(code).toBe(0);
  });
});
