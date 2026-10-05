/**
 * writeSecretFileInHome / removeSecretFile against a fake SFTP session: the
 * path comes from the server's own realpath (never a guessed home), the file
 * is owner-only BEFORE any content lands (open 0600 -> fchmod -> write ->
 * close), and Win32-OpenSSH's "/C:/..." form maps to "C:/..." for the member
 * shell and back for unlink. Fake content only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent } from '../src/types.js';

let realpathResult = '/home/u';
let writeFails = false;
const calls: Array<{ op: string; args: unknown[] }> = [];
type Cb = (err: Error | null) => void;
const fakeSftp = {
  realpath: (p: string, cb: (err: Error | null, abs: string) => void) => { calls.push({ op: 'realpath', args: [p] }); cb(null, realpathResult); },
  open: (p: string, flags: string, opts: { mode: number }, cb: (err: Error | null, h: Buffer) => void) => { calls.push({ op: 'open', args: [p, flags, opts] }); cb(null, Buffer.from('h1')); },
  fchmod: (h: Buffer, mode: number, cb: Cb) => { calls.push({ op: 'fchmod', args: [h.toString(), mode] }); cb(null); },
  write: (h: Buffer, data: Buffer, off: number, len: number, pos: number, cb: Cb) => {
    calls.push({ op: 'write', args: [h.toString(), data.toString('utf-8'), off, len, pos] });
    cb(writeFails ? new Error('disk full') : null);
  },
  close: (h: Buffer, cb: Cb) => { calls.push({ op: 'close', args: [h.toString()] }); cb(null); },
  unlink: (p: string, cb: Cb) => { calls.push({ op: 'unlink', args: [p] }); cb(null); },
  end: () => { calls.push({ op: 'end', args: [] }); },
};
const release = vi.fn();

vi.mock('../src/services/ssh.js', () => ({
  openPooledChannel: vi.fn(async () => ({ channel: fakeSftp, release })),
}));

const { writeSecretFileInHome, removeSecretFile, sftpPathToShellPath } = await import('../src/services/sftp.js');
const agent = { id: 'm1', friendlyName: 'm1', agentType: 'remote' } as Agent;
const ops = () => calls.map(c => c.op);

beforeEach(() => { calls.length = 0; release.mockClear(); writeFails = false; });

describe('writeSecretFileInHome', () => {
  it('POSIX: owner-only before content, under the server-resolved home', async () => {
    realpathResult = '/home/u';
    const content = "export K='FAKE'\n";
    const p = await writeSecretFileInHome(agent, '.apra-fleet-env-1', content);
    expect(p).toBe('/home/u/.apra-fleet-env-1');
    expect(calls.find(c => c.op === 'realpath')!.args).toEqual(['.']);
    expect(ops().filter(o => ['open', 'fchmod', 'write', 'close'].includes(o))).toEqual(['open', 'fchmod', 'write', 'close']);
    expect(calls.find(c => c.op === 'open')!.args).toEqual(['/home/u/.apra-fleet-env-1', 'w', { mode: 0o600 }]);
    expect(calls.find(c => c.op === 'fchmod')!.args).toEqual(['h1', 0o600]);
    expect(calls.find(c => c.op === 'write')!.args[1]).toBe(content);
    expect(ops()).toContain('end');
    expect(release).toHaveBeenCalled();
  });

  it('Windows: maps the SFTP "/C:/..." path to "C:/..." for the member shell', async () => {
    realpathResult = '/C:/Users/u';
    const p = await writeSecretFileInHome(agent, '.apra-fleet-env-2', 'K=RkFLRQ==\n');
    expect(p).toBe('C:/Users/u/.apra-fleet-env-2');
    expect(calls.find(c => c.op === 'open')!.args[0]).toBe('/C:/Users/u/.apra-fleet-env-2');
  });

  it('a failed write closes and removes the partial file', async () => {
    realpathResult = '/home/u';
    writeFails = true;
    await expect(writeSecretFileInHome(agent, '.apra-fleet-env-3', 'x')).rejects.toThrow(/disk full/);
    expect(ops()).toContain('close');
    expect(calls.find(c => c.op === 'unlink')!.args).toEqual(['/home/u/.apra-fleet-env-3']);
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
