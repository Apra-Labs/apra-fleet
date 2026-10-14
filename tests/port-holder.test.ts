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
  parseNetstatListenPid, pidOwnedByOtherUser, netstatPortHolder, lsofPortHolder,
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

describe('holder owned by another OS user whose name is not visible (standard user over SSH)', () => {
  const me = { user: 'alice' };
  const NETSTAT = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              ABHOEREN        1000',
    '  TCP    127.0.0.1:7523         0.0.0.0:0              ABHOEREN        4321',
    '  TCP    127.0.0.1:50000        127.0.0.1:7523         HERGESTELLT     5555',
    '  TCP    [::]:7524              [::]:0                 LISTENING       6000',
  ].join('\r\n');

  it('windows netstat: the LISTEN pid by unbound foreign address (state column is localized)', () => {
    expect(parseNetstatListenPid(NETSTAT, 7523)).toBe(4321);
    expect(parseNetstatListenPid(NETSTAT, 7524)).toBe(6000);
    expect(parseNetstatListenPid(NETSTAT, 50000)).toBeUndefined();
  });

  it('EPERM on signal 0 -> another user; success -> this user; ESRCH -> unknown', () => {
    const throwing = (code: string) => () => { throw Object.assign(new Error(code), { code }); };
    expect(pidOwnedByOtherUser(1, throwing('EPERM'))).toBe(true);
    expect(pidOwnedByOtherUser(1, () => true)).toBe(false);
    expect(pidOwnedByOtherUser(1, throwing('ESRCH'))).toBeUndefined();
  });

  it('windows (CIM denied): netstat + EPERM -> E-PORT-HELD-BY-OTHER-USER naming another OS user and the fix', () => {
    const holder = netstatPortHolder(7523, () => NETSTAT, () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); });
    expect(holder).toEqual({ pid: 4321, otherUser: true });
    const r = describePortConflict(7523, 'server.json in this data dir records no apra-fleet server (holder pid: none)', holder, me);
    expect(r.foreign).toBe(true);
    expect(r.message).toContain(PORT_HELD_BY_OTHER_USER_CODE);
    expect(r.message).toContain('another OS user (pid 4321)');
    expect(r.message).toContain('APRA_FLEET_PORT');
  });

  it('windows: this user\'s own holder stays a same-user conflict', () => {
    const holder = netstatPortHolder(7523, () => NETSTAT, () => true);
    expect(describePortConflict(7523, 'generic', holder, me).foreign).toBe(false);
  });

  it('macOS: lsof ran but sees no listener on the bound port -> another OS user', () => {
    const noMatch = () => { throw Object.assign(new Error('exit 1'), { status: 1, stdout: '' }); };
    const holder = lsofPortHolder(7523, noMatch);
    expect(holder).toEqual({ otherUser: true });
    const r = describePortConflict(7523, 'generic', holder, me);
    expect(r.foreign).toBe(true);
    expect(r.message).toContain('another OS user (pid not visible to this user)');
    expect(lsofPortHolder(7523, () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); })).toBeNull();
  });

  it('linux: the /proc/net/tcp uid already names the other user (unchanged)', () => {
    expect(heldByOtherUser({ uid: 1002 }, { uid: 1001 })).toBe(true);
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
