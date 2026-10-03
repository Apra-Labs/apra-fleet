/**
 * writeSecretFileInHome / removeSecretFile against a fake SFTP session: the
 * path comes from the server's own realpath (never a guessed home), the file
 * is created 0600, and Win32-OpenSSH's "/C:/..." form maps to "C:/..." for the
 * member shell and back for unlink. Fake content only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent } from '../src/types.js';

let realpathResult = '/home/u';
const calls: Array<{ op: string; args: unknown[] }> = [];
const fakeSftp = {
  realpath: (p: string, cb: (err: Error | null, abs: string) => void) => { calls.push({ op: 'realpath', args: [p] }); cb(null, realpathResult); },
  writeFile: (p: string, data: Buffer, opts: { mode: number }, cb: (err: Error | null) => void) => { calls.push({ op: 'writeFile', args: [p, data.toString('utf-8'), opts] }); cb(null); },
  chmod: (p: string, mode: number, cb: (err: Error | null) => void) => { calls.push({ op: 'chmod', args: [p, mode] }); cb(null); },
  unlink: (p: string, cb: (err: Error | null) => void) => { calls.push({ op: 'unlink', args: [p] }); cb(null); },
  end: () => { calls.push({ op: 'end', args: [] }); },
};
const release = vi.fn();

vi.mock('../src/services/ssh.js', () => ({
  openPooledChannel: vi.fn(async () => ({ channel: fakeSftp, release })),
}));

const { writeSecretFileInHome, removeSecretFile, sftpPathToShellPath } = await import('../src/services/sftp.js');
const agent = { id: 'm1', friendlyName: 'm1', agentType: 'remote' } as Agent;

beforeEach(() => { calls.length = 0; release.mockClear(); });

describe('writeSecretFileInHome', () => {
  it('POSIX: writes 0600 under the server-resolved home and returns that path', async () => {
    realpathResult = '/home/u';
    const p = await writeSecretFileInHome(agent, '.apra-fleet-env-1', 'export K=\'FAKE\'\n');
    expect(p).toBe('/home/u/.apra-fleet-env-1');
    expect(calls.find(c => c.op === 'realpath')!.args).toEqual(['.']);
    expect(calls.find(c => c.op === 'writeFile')!.args).toEqual(['/home/u/.apra-fleet-env-1', 'export K=\'FAKE\'\n', { mode: 0o600 }]);
    expect(calls.find(c => c.op === 'chmod')!.args).toEqual(['/home/u/.apra-fleet-env-1', 0o600]);
    expect(calls.some(c => c.op === 'end')).toBe(true);
    expect(release).toHaveBeenCalled();
  });

  it('Windows: maps the SFTP "/C:/..." path to "C:/..." for the member shell', async () => {
    realpathResult = '/C:/Users/u';
    const p = await writeSecretFileInHome(agent, '.apra-fleet-env-2', 'K=RkFLRQ==\n');
    expect(p).toBe('C:/Users/u/.apra-fleet-env-2');
    expect(calls.find(c => c.op === 'writeFile')!.args[0]).toBe('/C:/Users/u/.apra-fleet-env-2');
  });

  it('refuses a file name that could carry a path or shell syntax', async () => {
    await expect(writeSecretFileInHome(agent, '../x', 'v')).rejects.toThrow(/Unsafe/);
    await expect(writeSecretFileInHome(agent, "a'b", 'v')).rejects.toThrow(/Unsafe/);
  });
});

describe('removeSecretFile', () => {
  it('maps a Windows shell path back to the SFTP form', async () => {
    await removeSecretFile(agent, 'C:/Users/u/.apra-fleet-env-2');
    expect(calls.find(c => c.op === 'unlink')!.args).toEqual(['/C:/Users/u/.apra-fleet-env-2']);
  });

  it('leaves a POSIX path unchanged', async () => {
    await removeSecretFile(agent, '/home/u/.apra-fleet-env-1');
    expect(calls.find(c => c.op === 'unlink')!.args).toEqual(['/home/u/.apra-fleet-env-1']);
  });
});

describe('sftpPathToShellPath', () => {
  it('only strips the slash before a drive letter', () => {
    expect(sftpPathToShellPath('/C:/x')).toBe('C:/x');
    expect(sftpPathToShellPath('/home/x')).toBe('/home/x');
  });
});
