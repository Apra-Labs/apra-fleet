import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain .mjs shared with .github/e2e/fleet-setup.mjs
import { selfSafeSleepPattern, countSleepsCommand, killSleepsCommand, encodePowerShell } from '../.github/e2e/exec-wrapper-checks.mjs';

function decodePs(cmd: string): string {
  const b64 = /-EncodedCommand (\S+)$/.exec(cmd)![1];
  return Buffer.from(b64, 'base64').toString('utf16le');
}

describe('exec-wrapper-checks pure helpers', () => {
  it('sleep pattern matches the target but never the checker command line itself', () => {
    const pat = selfSafeSleepPattern([31234, 31235]);
    expect(pat).toBe('sleep [3]1234|sleep [3]1235');
    const re = new RegExp(pat);
    expect(re.test('sleep 31234')).toBe(true);
    expect(re.test('sleep 31235')).toBe(true);
    expect(re.test(countSleepsCommand('linux', [31234, 31235]))).toBe(false);
    expect(re.test(killSleepsCommand('macos', [31234, 31235]))).toBe(false);
  });

  it('windows commands are shell-agnostic -EncodedCommand invocations filtering sleep.exe', () => {
    const count = countSleepsCommand('windows', [31234, 31235]);
    expect(count).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
    expect(decodePs(count)).toContain("Name='sleep.exe'");
    expect(decodePs(count)).toContain('(31234|31235)');
    expect(decodePs(killSleepsCommand('windows', [31234]))).toContain('Stop-Process');
    expect(Buffer.from(encodePowerShell('x'), 'base64').toString('utf16le')).toBe('x');
  });
});
