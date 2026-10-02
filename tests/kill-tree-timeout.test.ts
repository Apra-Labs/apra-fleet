import { describe, it, expect, vi, afterEach } from 'vitest';

// GitHub #562: LocalStrategy's synchronous tree-kill runs on the server's event
// loop; it must be bounded (timeout) and must not pop a console (windowsHide).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(), execSync: vi.fn() };
});

import { execFileSync, execSync } from 'node:child_process';
import { killLocalProcessTree, KILL_TREE_TIMEOUT_MS } from '../src/services/strategy.js';

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

afterEach(() => {
  setPlatform(realPlatform);
  vi.mocked(execFileSync).mockReset();
  vi.mocked(execSync).mockReset();
});

describe('killLocalProcessTree', () => {
  it('KILL_TREE_TIMEOUT_MS is a finite bound of about 10s', () => {
    expect(KILL_TREE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(KILL_TREE_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it('on Windows calls taskkill.exe directly (no shell) with a timeout and windowsHide', () => {
    setPlatform('win32');
    killLocalProcessTree(4242, 'ignored on windows', 'C:\\Program Files\\Git\\bin\\bash.exe');
    expect(execSync).not.toHaveBeenCalled();
    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [file, args, opts] = vi.mocked(execFileSync).mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(file).toBe('taskkill.exe');
    expect(args).toEqual(['/F', '/T', '/PID', '4242']);
    expect(opts.timeout).toBe(KILL_TREE_TIMEOUT_MS);
    expect(opts.windowsHide).toBe(true);
    expect(opts.shell).toBeUndefined();
  });

  it('on POSIX runs the member kill string with a timeout through the resolved shell', () => {
    setPlatform('linux');
    killLocalProcessTree(4242, 'kill -9 4242', '/bin/bash');
    expect(execFileSync).not.toHaveBeenCalled();
    const [cmd, opts] = vi.mocked(execSync).mock.calls[0] as [string, Record<string, unknown>];
    expect(cmd).toBe('kill -9 4242');
    expect(opts.timeout).toBe(KILL_TREE_TIMEOUT_MS);
    expect(opts.shell).toBe('/bin/bash');
  });

  it('swallows a timeout/error (best-effort)', () => {
    setPlatform('win32');
    vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(new Error('spawnSync taskkill.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }); });
    expect(() => killLocalProcessTree(1, 'x')).not.toThrow();
  });
});
