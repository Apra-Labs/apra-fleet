/**
 * WindowsCommands.getCleanEnv must read the env via -EncodedCommand with a
 * timeout. The old inline `-c` form (~2300 chars) hung PowerShell 5.1
 * indefinitely on some hosts, and with no timeout it froze the fleet server
 * on the first local-member operation (e.g. register_member).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process');

import { execFileSync } from 'node:child_process';
import { WindowsCommands } from '../src/os/windows.js';

const mockExecFileSync = vi.mocked(execFileSync);

function getCleanEnv(cmds: WindowsCommands): Record<string, string> {
  return (cmds as unknown as { getCleanEnv(): Record<string, string> }).getCleanEnv();
}

describe('WindowsCommands.getCleanEnv', () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it('invokes powershell with -EncodedCommand, -NoProfile and a timeout', () => {
    mockExecFileSync.mockReturnValue('{"Path":"C:\\\\Windows"}\r\n' as never);

    const env = getCleanEnv(new WindowsCommands());

    expect(env).toEqual({ Path: 'C:\\Windows' });
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    const [file, args, opts] = mockExecFileSync.mock.calls[0] as [string, string[], { timeout?: number }];
    expect(file).toBe('powershell.exe');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const decoded = Buffer.from(args[3], 'base64').toString('utf16le');
    expect(decoded).toContain("[Environment]::GetEnvironmentVariables('Machine')");
    expect(decoded).toContain('ConvertTo-Json -Compress');
    expect(opts.timeout).toBeGreaterThan(0);
  });

  it('caches the result across calls', () => {
    mockExecFileSync.mockReturnValue('{"A":"1"}' as never);
    const cmds = new WindowsCommands();

    getCleanEnv(cmds);
    getCleanEnv(cmds);

    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it('fails loudly on timeout instead of hanging', () => {
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' });
    });

    expect(() => getCleanEnv(new WindowsCommands())).toThrow(/Windows environment.*timed out/);
  });
});
