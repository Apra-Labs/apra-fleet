import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `apra-fleet auth --api-key` on Windows shells out to PowerShell. A failing
// child_process call throws an Error whose message is "Command failed: <full
// command line>\n<stderr>" -- the key must never reach the console through it.
// Both sync spawners are mocked (never run for real) to fail exactly like Node.
function nodeLikeFailure(cmdLine: string): Error {
  const err = new Error(`Command failed: ${cmdLine}\nParserError: ${cmdLine}`) as Error & { status: number };
  err.status = 1;
  return err;
}

vi.mock('node:child_process', () => ({
  execSync: (cmd: string) => { throw nodeLikeFailure(cmd); },
  execFileSync: (file: string, args: string[]) => { throw nodeLikeFailure([file, ...args].join(' ')); },
}));

describe('auth --api-key (Windows) failure output', () => {
  const realPlatform = process.platform;
  const TOKEN = 'sk-ant-SECRET-abc123';

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    vi.restoreAllMocks();
  });

  it('never prints the API key (plain or encoded) when PowerShell fails', async () => {
    const lines: string[] = [];
    const capture = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    vi.spyOn(console, 'error').mockImplementation(capture);
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit:${code}`); }) as never);

    const { runAuth } = await import('../src/cli/auth.js');
    await expect(runAuth(['--api-key', '--llm', 'claude', TOKEN])).rejects.toThrow('exit:1');

    const out = lines.join('\n');
    expect(out).toContain('Failed to set API key');
    expect(out).not.toContain(TOKEN);
    // No encoded form of the key either (UTF-16LE base64 as used by -EncodedCommand).
    expect(out).not.toMatch(/-EncodedCommand\s+\S/);
  });
});
