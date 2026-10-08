/**
 * The env a local Windows member hands to bd/dolt/git must be bounded
 * (deduped PATH, block under CHILD_ENV_BLOCK_CAP_CHARS) while keeping what
 * those children need. Exercised through the REAL env builders --
 * WindowsCommands.getCleanEnv (PowerShell members) and
 * WindowsGitBashCommands.cleanExec (Git Bash members) -- with the OS reads
 * mocked, so this runs on every OS. See docs/troubleshooting.md ("Not enough
 * memory resources").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process');
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  // resolveGitBashPath() probes for bash.exe on disk; pretend it is there.
  return { ...actual, existsSync: () => true };
});
vi.mock('../src/utils/log-helpers.js', () => ({ logWarn: vi.fn(), logLine: vi.fn(), logError: vi.fn() }));

import { execFileSync } from 'node:child_process';
import { WindowsCommands } from '../src/os/windows.js';
import { WindowsGitBashCommands } from '../src/os/windows-gitbash.js';
import { envBlockSize, CHILD_ENV_BLOCK_CAP_CHARS } from '../src/os/child-env-bound.js';
import { logWarn } from '../src/utils/log-helpers.js';

const GIT_DIR = 'C:\\Program Files\\Git\\cmd';
const MINGW = 'C:\\Program Files\\Git\\mingw64\\bin';

/** Machine Path + User Path the way getCleanEnv concatenates them, plus the
 *  prefixes three nested Git Bash logins add -- heavily duplicated. */
function duplicatedPath(): string {
  const machine = ['C:\\Windows\\system32', 'C:\\Windows', GIT_DIR, 'C:\\Program Files\\nodejs\\'];
  const user = ['C:\\Users\\bella\\AppData\\Roaming\\npm', GIT_DIR + '\\', 'c:\\windows\\SYSTEM32'];
  let parts = [...machine, ...user];
  for (let i = 0; i < 3; i += 1) parts = [MINGW, 'C:\\Program Files\\Git\\usr\\bin', ...parts];
  // Pad with many repeats so PATH duplication alone is significant.
  for (let i = 0; i < 200; i += 1) parts.push(machine[i % machine.length]);
  return parts.join(';');
}

function oversizedEnv(): Record<string, string> {
  return {
    Path: duplicatedPath(),
    USERPROFILE: 'C:\\Users\\bella',
    HOME: 'C:\\Users\\bella',
    SystemRoot: 'C:\\Windows',
    GH_TOKEN: 'ghp_secret',
    GIT_ASKPASS: 'C:\\fleet\\askpass.bat',
    GCM_INTERACTIVE: 'never',
    MY_REGISTRY_PASSWORD: 'p',
    BIG_INHERITED_BLOB: 'x'.repeat(40000),
    OTHER_BLOB: 'y'.repeat(5000),
  };
}

function pathEntries(env: Record<string, string>): string[] {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH')!;
  return env[key].split(';');
}

function assertBoundedAndUsable(env: Record<string, string>): void {
  expect(envBlockSize(env)).toBeLessThanOrEqual(CHILD_ENV_BLOCK_CAP_CHARS);
  const entries = pathEntries(env);
  const norm = entries.map((e) => e.replace(/[\\/]+$/, '').toLowerCase());
  expect(new Set(norm).size).toBe(norm.length);
  // bd/dolt still find git, and the user's home and credentials survive.
  expect(entries).toContain(GIT_DIR);
  expect(entries).toContain(MINGW);
  expect(env.USERPROFILE).toBe('C:\\Users\\bella');
  expect(env.HOME).toBe('C:\\Users\\bella');
  expect(env.SystemRoot).toBe('C:\\Windows');
  expect(env.GH_TOKEN).toBe('ghp_secret');
  expect(env.GIT_ASKPASS).toBe('C:\\fleet\\askpass.bat');
  expect(env.GCM_INTERACTIVE).toBe('never');
  expect(env.MY_REGISTRY_PASSWORD).toBe('p');
  // The oversized irrelevant variable is what went.
  expect(env.BIG_INHERITED_BLOB).toBeUndefined();
}

describe('WindowsCommands.getCleanEnv bounds the child env', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    vi.mocked(logWarn).mockReset();
  });

  it('dedupes PATH, caps the block, keeps git/home/credential vars, and warns about what it dropped', () => {
    const input = oversizedEnv();
    expect(envBlockSize(input)).toBeGreaterThan(CHILD_ENV_BLOCK_CAP_CHARS);
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify(input) as never);

    const { env } = new WindowsCommands().cleanExec('bd dolt pull');

    assertBoundedAndUsable(env!);
    expect(env!.OTHER_BLOB).toBe(input.OTHER_BLOB);
    expect(logWarn).toHaveBeenCalledWith('clean_env', expect.stringContaining('BIG_INHERITED_BLOB'));
  });
});

describe('WindowsGitBashCommands.cleanExec bounds the inherited fleet-server env', () => {
  const saved = { ...process.env };
  beforeEach(() => { vi.mocked(logWarn).mockReset(); });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  it('dedupes PATH, caps the block, and keeps git/home/credential vars', () => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, oversizedEnv());

    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let env: Record<string, string> | undefined;
    try {
      env = new WindowsGitBashCommands().cleanExec('bd dolt pull').env;
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
    }

    assertBoundedAndUsable(env!);
    expect(logWarn).toHaveBeenCalledWith('clean_env', expect.stringContaining('BIG_INHERITED_BLOB'));
  });
});
