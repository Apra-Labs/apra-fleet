/**
 * A Windows member runs Win32-OpenSSH, whose SFTP server does not accept the
 * MSYS/Git Bash drive form (/c/Users/x) -- it answers "No such file". A Git
 * Bash member's probed home, and every path built from it (the installer
 * staging dir), is in that form, so the SFTP layer must rewrite it to
 * C:/Users/x. POSIX and PowerShell members are unchanged.
 *
 * Revert check: making toSftpPath return its input unchanged fails the gitbash
 * cases below (the staging upload reaches fastPut as /c/Users/...).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import * as sshModule from '../src/services/ssh.js';
import { uploadViaSFTP, downloadViaSFTP, uploadContentToHome, removeSecretFile } from '../src/services/sftp.js';
import { toSftpPath } from '../src/utils/platform.js';
import { memberStagingDir, binaryNameFor } from '../src/services/member-fleet-install.js';
import { makeTestAgent } from './test-helpers.js';
import type { Agent } from '../src/types.js';

vi.mock('../src/services/ssh.js');

type Os = 'windows' | 'linux';
interface ShellCase {
  name: string;
  os: Os;
  shell: Agent['shell'];
  home: string;
  workFolder: string;
  /** The staging dir as the SFTP server must receive it. */
  sftpStaging: string;
}

const CASES: ShellCase[] = [
  { name: 'gitbash', os: 'windows', shell: 'gitbash', home: '/c/Users/x', workFolder: 'C:\\Users\\x\\repo', sftpStaging: 'C:/Users/x/.apra-fleet/staging' },
  { name: 'powershell5', os: 'windows', shell: 'powershell5', home: 'C:\\Users\\x', workFolder: 'C:\\Users\\x\\repo', sftpStaging: 'C:/Users/x/.apra-fleet/staging' },
  { name: 'pwsh7', os: 'windows', shell: 'pwsh7', home: 'C:\\Users\\x', workFolder: 'C:\\Users\\x\\repo', sftpStaging: 'C:/Users/x/.apra-fleet/staging' },
  { name: 'posix', os: 'linux', shell: undefined, home: '/home/x', workFolder: '/home/x/repo', sftpStaging: '/home/x/.apra-fleet/staging' },
];

describe('toSftpPath', () => {
  it('rewrites a Windows member MSYS drive path to the Windows form', () => {
    expect(toSftpPath('/c/Users/x/.apra-fleet/staging', 'windows')).toBe('C:/Users/x/.apra-fleet/staging');
    expect(toSftpPath('/d/data', 'windows')).toBe('D:/data');
    expect(toSftpPath('/c', 'windows')).toBe('C:/');
  });

  it('leaves Windows-form paths and non-drive paths on a Windows member unchanged', () => {
    expect(toSftpPath('C:/Users/x', 'windows')).toBe('C:/Users/x');
    expect(toSftpPath('C:\\Users\\x', 'windows')).toBe('C:\\Users\\x');
    expect(toSftpPath('/C:/Users/x', 'windows')).toBe('/C:/Users/x');
    expect(toSftpPath('.claude/agents', 'windows')).toBe('.claude/agents');
    expect(toSftpPath('/cc/x', 'windows')).toBe('/cc/x');
  });

  it('never rewrites on a POSIX member (/c/x is a real path there)', () => {
    expect(toSftpPath('/c/data', 'linux')).toBe('/c/data');
    expect(toSftpPath('/c/data', 'macos')).toBe('/c/data');
    expect(toSftpPath('/c/data', undefined)).toBe('/c/data');
  });

  for (const c of CASES) {
    it(`${c.name}: the installer staging dir built for the member shell maps to ${c.sftpStaging}`, () => {
      const staging = memberStagingDir(c.home, c.os, c.shell as never);
      const viaSftp = toSftpPath(staging, c.os).replace(/\\/g, '/');
      expect(viaSftp).toBe(c.sftpStaging);
    });
  }
});

describe('SFTP transfers to a Git Bash member use a path the SFTP server accepts (local SFTP stub)', () => {
  let fastPut: ReturnType<typeof vi.fn>;
  let fastGet: ReturnType<typeof vi.fn>;
  let mkdir: ReturnType<typeof vi.fn>;
  let writeFile: ReturnType<typeof vi.fn>;
  let unlink: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(fs, 'mkdirSync').mockImplementation((() => undefined) as never);
    // Mimics Win32-OpenSSH: an MSYS /c/... path does not exist.
    const msys = (p: string) => /^\/[A-Za-z]\//.test(p);
    const noSuchFile = () => Object.assign(new Error('No such file'), { code: 2 });
    mkdir = vi.fn((_p: string, cb: (e: unknown) => void) => cb(null));
    fastPut = vi.fn((_l: string, r: string, _o: unknown, cb: (e: unknown) => void) => cb(msys(r) ? noSuchFile() : null));
    fastGet = vi.fn((r: string, _l: string, _o: unknown, cb: (e: unknown) => void) => cb(msys(r) ? noSuchFile() : null));
    writeFile = vi.fn((r: string, _d: unknown, cb: (e: unknown) => void) => cb(msys(r) ? noSuchFile() : null));
    unlink = vi.fn((_r: string, cb: (e: unknown) => void) => cb(null));
    const fakeClient = {
      sftp: (cb: (e: unknown, s: unknown) => void) => cb(null, { mkdir, fastPut, fastGet, writeFile, unlink, end: vi.fn() }),
    } as never;
    vi.mocked(sshModule.openPooledChannel).mockImplementation((async (_a: unknown, open: (c: unknown) => Promise<unknown>) => ({
      channel: await open(fakeClient), client: fakeClient, release: vi.fn(),
    })) as never);
  });

  afterEach(() => vi.restoreAllMocks());

  for (const c of CASES) {
    it(`${c.name}: staging the installer uploads to ${c.sftpStaging}`, async () => {
      const agent = makeTestAgent({ os: c.os, shell: c.shell, workFolder: c.workFolder });
      const staging = memberStagingDir(c.home, c.os, c.shell as never);
      const exe = binaryNameFor(c.os);
      const r = await uploadViaSFTP(agent, [`/tmp/${exe}`], staging);
      expect(r.failed).toEqual([]);
      expect(r.success).toEqual([exe]);
      expect(fastPut.mock.calls[0][1]).toBe(`${c.sftpStaging}/${exe}`);
    });
  }

  it('gitbash: a work folder stored in MSYS form is the default upload target in Windows form', async () => {
    const agent = makeTestAgent({ os: 'windows', shell: 'gitbash', workFolder: '/c/Users/x/repo' });
    const r = await uploadViaSFTP(agent, ['/tmp/a.txt']);
    expect(r.failed).toEqual([]);
    expect(fastPut.mock.calls[0][1]).toBe('C:/Users/x/repo/a.txt');
  });

  it('gitbash: receive_files of an MSYS path downloads the Windows-form path', async () => {
    const agent = makeTestAgent({ os: 'windows', shell: 'gitbash', workFolder: 'C:\\Users\\x\\repo' });
    const r = await downloadViaSFTP(agent, ['/c/Users/x/repo/out.log'], '/tmp/dl');
    expect(r.failed).toEqual([]);
    expect(fastGet.mock.calls[0][0]).toBe('C:/Users/x/repo/out.log');
  });

  it('gitbash: content written under an MSYS base dir lands at the Windows-form path', async () => {
    const agent = makeTestAgent({ os: 'windows', shell: 'gitbash', workFolder: 'C:\\Users\\x\\repo' });
    const r = await uploadContentToHome(agent, [{ relPath: 'a.md', content: 'x' }], '/c/Users/x/.claude/agents');
    expect(r.failed).toEqual([]);
    expect(writeFile.mock.calls[0][0]).toBe('C:/Users/x/.claude/agents/a.md');
  });

  it('gitbash: removing a staged secret file given in MSYS form unlinks the SFTP form', async () => {
    const agent = makeTestAgent({ os: 'windows', shell: 'gitbash', workFolder: 'C:\\Users\\x\\repo' });
    await removeSecretFile(agent, '/c/Users/x/.fleet-env-1');
    expect(unlink.mock.calls[0][0]).toBe('/C:/Users/x/.fleet-env-1');
  });

  it('posix: an absolute /c/... path is used as given', async () => {
    const agent = makeTestAgent({ os: 'linux', workFolder: '/home/x/repo' });
    await downloadViaSFTP(agent, ['/c/data/out.log'], '/tmp/dl');
    expect(fastGet.mock.calls[0][0]).toBe('/c/data/out.log');
  });
});
