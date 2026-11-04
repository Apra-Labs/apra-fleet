// The GOMAXPROCS default through the REAL Windows env builders (not just the
// pure rule): WindowsCommands.getCleanEnv with an injected powershell answer
// and WindowsGitBashCommands.cleanExec with an injected parent env. Remote
// command strings (PowerShell / Git Bash vs unchanged linux/macOS) are covered
// in tests/go-concurrency-default.test.ts. Platform-independent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process');
// resolveGitBashPath probes well-known bash.exe locations; pretend the first exists.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => true), default: { ...actual, existsSync: vi.fn(() => true) } };
});

import { execFileSync } from 'node:child_process';
import { WindowsCommands } from '../src/os/windows.js';
import { WindowsGitBashCommands } from '../src/os/windows-gitbash.js';

const mockExecFileSync = vi.mocked(execFileSync);

function getCleanEnv(cmds: WindowsCommands): Record<string, string> {
  return (cmds as unknown as { getCleanEnv(): Record<string, string> }).getCleanEnv();
}

describe('WindowsCommands.getCleanEnv (local PowerShell member)', () => {
  beforeEach(() => mockExecFileSync.mockReset());

  it('absent GOMAXPROCS -> default 1 added', () => {
    mockExecFileSync.mockReturnValue('{"Path":"C:\\\\Windows","TEMP":"C:\\\\t"}' as never);
    const env = getCleanEnv(new WindowsCommands());
    expect(env.GOMAXPROCS).toBe('1');
    expect(env.Path).toBe('C:\\Windows');
  });

  it('GOMAXPROCS=4 from the Machine/User env -> preserved as 4', () => {
    mockExecFileSync.mockReturnValue('{"Path":"C:\\\\Windows","GOMAXPROCS":"4"}' as never);
    const env = getCleanEnv(new WindowsCommands());
    expect(env.GOMAXPROCS).toBe('4');
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'GOMAXPROCS')).toEqual(['GOMAXPROCS']);
  });
});

describe('WindowsGitBashCommands.cleanExec (local Git Bash member)', () => {
  beforeEach(() => vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\u\\AppData\\Local'));
  afterEach(() => vi.unstubAllEnvs());

  it('absent GOMAXPROCS in the inherited env -> default 1 added', () => {
    vi.stubEnv('GOMAXPROCS', undefined as unknown as string);
    delete process.env.GOMAXPROCS;
    const { env, shell } = new WindowsGitBashCommands().cleanExec('bd dolt pull');
    expect(shell).toMatch(/bash\.exe$/i);
    expect(env?.GOMAXPROCS).toBe('1');
  });

  it('GOMAXPROCS=4 in the inherited env -> preserved as 4', () => {
    vi.stubEnv('GOMAXPROCS', '4');
    const { env } = new WindowsGitBashCommands().cleanExec('bd dolt pull');
    expect(env?.GOMAXPROCS).toBe('4');
  });
});
