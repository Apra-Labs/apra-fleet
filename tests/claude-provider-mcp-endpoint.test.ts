import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn((_file: string, _args: string[], _opts: any, callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
  callback(null, { stdout: '', stderr: '' });
});

vi.mock('node:child_process', () => ({
  execFile: (...args: any[]) => execFileMock(...args),
}));

describe('ClaudeProvider registerMcpEndpoint (apra-fleet-fnz.1)', () => {
  beforeEach(() => {
    execFileMock.mockClear();
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: any, callback: any) => {
      callback(null, { stdout: '', stderr: '' });
    });
  });

  it('shells out to `claude mcp add` with --transport http and the given scope', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const p = new ClaudeProvider();

    const result = await p.registerMcpEndpoint!({
      url: 'http://127.0.0.1:7523/mcp?member=test-uuid',
      token: 'testtoken123',
      workFolder: '/some/project/folder',
      scope: 'project',
    });

    expect(result.mechanism).toBe('cli-verb');
    expect(execFileMock).toHaveBeenCalledTimes(1);

    const [file, args, opts] = execFileMock.mock.calls[0];
    expect(file).toBe('claude');
    expect(args).toEqual([
      'mcp', 'add',
      '--transport', 'http',
      '--scope', 'project',
      'apra-fleet-member',
      'http://127.0.0.1:7523/mcp?member=test-uuid',
      '--header', 'Authorization: Bearer testtoken123',
    ]);
    expect(opts.cwd).toBe('/some/project/folder');
  });

  it('passes --scope user when scope is "user"', async () => {
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const p = new ClaudeProvider();

    await p.registerMcpEndpoint!({
      url: 'http://127.0.0.1:7523/mcp?member=u',
      token: 'tok',
      workFolder: '/whatever',
      scope: 'user',
    });

    const [, args] = execFileMock.mock.calls[0];
    expect(args).toContain('--scope');
    expect(args[args.indexOf('--scope') + 1]).toBe('user');
  });

  it('propagates a rejection if the claude CLI exits non-zero (e.g. claude not installed)', async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _opts: any, callback: any) => {
      callback(new Error('spawn claude ENOENT'));
    });
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const p = new ClaudeProvider();

    await expect(p.registerMcpEndpoint!({
      url: 'http://x',
      token: 't',
      workFolder: '/f',
      scope: 'project',
    })).rejects.toThrow('spawn claude ENOENT');
  });
});
