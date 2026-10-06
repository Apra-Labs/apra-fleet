/**
 * Port holder detection and the refusal when ANOTHER user's process holds the
 * configured port (two member installs on one host, one per Unix user).
 * Parsers are tested on captured probe output; start/install behaviour is in
 * port-held-by-other-user.test.ts with a fake probe.
 */
import { describe, it, expect } from 'vitest';
import {
  parseProcNetTcp, userFromPasswd, parseLsofFields, parseWindowsPortHolder, windowsPortHolderScript,
  heldByOtherUser, describePortConflict, PORT_HELD_BY_OTHER_USER_CODE,
} from '../src/services/port-holder.js';

const PROC_NET_TCP = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 0100007F:1D63 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 55501 1 0000000000000000 100 0 0 10 0',
  '   1: 0100007F:1DC3 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 55502 1 0000000000000000 100 0 0 10 0',
  '   2: 0100007F:9C40 0100007F:1D63 01 00000000:00000000 00:00000000 00000000  1002        0 55503 1 0000000000000000 100 0 0 10 0',
].join('\n');

describe('linux /proc/net/tcp parsing', () => {
  it('finds the LISTEN socket uid and inode for the port (7523 = 0x1D63)', () => {
    expect(parseProcNetTcp(PROC_NET_TCP, 7523)).toEqual({ uid: 1001, inode: '55501' });
    expect(parseProcNetTcp(PROC_NET_TCP, 7619)).toEqual({ uid: 1002, inode: '55502' });
  });
  it('ignores non-LISTEN rows and other ports', () => {
    expect(parseProcNetTcp(PROC_NET_TCP, 40000)).toBeNull();
    expect(parseProcNetTcp(PROC_NET_TCP, 7524)).toBeNull();
  });
  it('maps a uid to its login name from /etc/passwd', () => {
    const pw = 'root:x:0:0:root:/root:/bin/bash\nalice:x:1001:1001::/home/alice:/bin/bash\nbob:x:1002:1002::/home/bob:/bin/bash\n';
    expect(userFromPasswd(pw, 1002)).toBe('bob');
    expect(userFromPasswd(pw, 4242)).toBeUndefined();
  });
});

describe('macOS lsof parsing', () => {
  it('reads pid, command, login and uid of the first record', () => {
    expect(parseLsofFields('p812\ncapra-fleet\nu502\nLbob\nf12\n')).toEqual({ pid: 812, command: 'apra-fleet', uid: 502, user: 'bob' });
  });
  it('empty output -> null', () => { expect(parseLsofFields('')).toBeNull(); });
});

describe('windows probe', () => {
  it('parses the JSON line', () => {
    expect(parseWindowsPortHolder('{"pid":5120,"name":"apra-fleet.exe","user":"bob"}\r\n')).toEqual({ pid: 5120, command: 'apra-fleet.exe', user: 'bob' });
    expect(parseWindowsPortHolder('')).toBeNull();
    expect(parseWindowsPortHolder('garbage')).toBeNull();
  });
  it('the script embeds only the integer port', () => {
    const s = windowsPortHolderScript(7611);
    expect(s).toContain('-LocalPort 7611');
    expect(s).toContain('GetOwner');
  });
});

describe('classification and message', () => {
  const me = { user: 'alice', uid: 1001 };
  it('uid decides when both sides have one; else names (case-insensitive); else unknown', () => {
    expect(heldByOtherUser({ uid: 1002, user: 'alice' }, me)).toBe(true);
    expect(heldByOtherUser({ uid: 1001 }, me)).toBe(false);
    expect(heldByOtherUser({ user: 'ALICE' }, { user: 'alice' })).toBe(false);
    expect(heldByOtherUser({ user: 'bob' }, { user: 'alice' })).toBe(true);
    expect(heldByOtherUser({ pid: 9 }, me)).toBeUndefined();
  });
  it('another user -> foreign refusal naming the user, pid and remedy', () => {
    const r = describePortConflict(7523, 'generic', { pid: 4321, user: 'bob', uid: 1002, command: 'apra-fleet' }, me);
    expect(r.foreign).toBe(true);
    expect(r.message).toContain(PORT_HELD_BY_OTHER_USER_CODE);
    expect(r.message).toContain('"bob"');
    expect(r.message).toContain('pid 4321');
    expect(r.message).toContain('--member --port');
  });
  it('another user whose pid is not visible -> says so, never invents one', () => {
    const r = describePortConflict(7523, 'generic', { uid: 1002, user: 'bob' }, me);
    expect(r.foreign).toBe(true);
    expect(r.message).toContain('pid not visible to this user');
  });
  it('same user -> generic message plus the holder pid', () => {
    const r = describePortConflict(7523, 'Port 7523 is already in use.', { pid: 777, uid: 1001, user: 'alice' }, me);
    expect(r).toEqual({ foreign: false, message: expect.stringContaining('Port 7523 is already in use.') });
    expect(r.message).toContain('pid 777');
  });
  it('unknown holder -> generic message unchanged', () => {
    expect(describePortConflict(7523, 'generic', null, me)).toEqual({ foreign: false, message: 'generic' });
  });
});

describe('real platform probe (this process holds the port)', () => {
  it.skipIf(!['linux', 'darwin', 'win32'].includes(process.platform))('names this process and this user', async () => {
    const net = await import('node:net');
    const { findPortHolder, heldByOtherUser } = await import('../src/services/port-holder.js');
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as import('node:net').AddressInfo).port;
    try {
      const holder = await findPortHolder(port);
      expect(holder).not.toBeNull();
      expect(holder!.pid).toBe(process.pid);
      expect(heldByOtherUser(holder!)).toBe(false);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  }, 30_000);
});
