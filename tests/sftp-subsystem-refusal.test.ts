/**
 * A channel whose "sftp" subsystem request is refused after the channel
 * opened must be closed. ssh2's exec() closes its channel on the equivalent
 * failure, but sftp() (ssh2 1.17) only calls back with the error and leaves
 * the session channel open on both ends -- one of the member sshd's
 * MaxSessions gone per attempt. openSftp() closes it.
 *
 * Runs the REAL ssh2 Client against a real ssh2 Server joined by an
 * in-memory duplex pair: no socket, no network, no sshd. The server counts
 * the session channels it accepted and how many the client closed.
 */
import { Duplex } from 'node:stream';
import { describe, it, expect, afterEach } from 'vitest';
import ssh2 from 'ssh2';
import { openSftp } from '../src/services/sftp.js';

const { Client, Server, utils } = ssh2 as unknown as {
  Client: typeof import('ssh2').Client;
  Server: typeof import('ssh2').Server;
  utils: typeof import('ssh2').utils;
};

function duplexPair(): [Duplex, Duplex] {
  let a: Duplex;
  let b: Duplex;
  const make = (peer: () => Duplex) => new Duplex({
    write(chunk, _enc, cb) { peer().push(chunk); cb(); },
    read() {},
    final(cb) { peer().push(null); cb(); },
  });
  a = make(() => b);
  b = make(() => a);
  return [a, b];
}

interface Harness {
  client: import('ssh2').Client;
  stats: { opened: number; closed: number };
  waitClosed: (n: number) => Promise<void>;
}

const hostKey = utils.generateKeyPairSync('ed25519').private;
const live: Harness[] = [];

/** Connect a real client to a real server whose sftp subsystem is `mode`. */
async function connect(mode: 'refuse' | 'accept'): Promise<Harness> {
  const stats = { opened: 0, closed: 0 };
  const closeWaiters: Array<() => void> = [];
  const server = new Server({ hostKeys: [hostKey] }, (conn) => {
    conn.on('authentication', (ctx) => ctx.accept());
    conn.on('ready', () => {
      conn.on('session', (accept) => {
        stats.opened += 1;
        const session = accept();
        session.on('subsystem', (acceptSub, rejectSub) => {
          if (mode === 'refuse') rejectSub();
          else acceptSub(); // accepted but never speaks SFTP: init stays pending
        });
        session.on('close', () => { stats.closed += 1; closeWaiters.splice(0).forEach((w) => w()); });
      });
    });
  });
  const [clientSide, serverSide] = duplexPair();
  server.injectSocket(serverSide as any);
  const client = new Client();
  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve());
    client.once('error', reject);
    client.connect({ sock: clientSide as any, username: 'u', password: 'p', hostVerifier: () => true });
  });
  // Bounded: resolves once n channels closed or after 2s, whichever is first,
  // so a leak fails the assertion below instead of hanging the test.
  const waitClosed = async (n: number): Promise<void> => {
    const deadline = Date.now() + 2000;
    while (stats.closed < n && Date.now() < deadline) {
      await new Promise<void>((r) => { closeWaiters.push(r); setTimeout(r, 50); });
    }
  };
  const h = { client, stats, waitClosed };
  live.push(h);
  return h;
}

describe('openSftp: refused subsystem request', () => {
  afterEach(() => {
    for (const h of live.splice(0)) { try { h.client.end(); } catch { /* ignore */ } }
  });

  it('closes the channel ssh2 leaves open, so the server sees the session end', async () => {
    const { stats, client, waitClosed } = await connect('refuse');
    await expect(openSftp(client)).rejects.toThrow(/Unable to start subsystem: sftp/);
    await expect(openSftp(client)).rejects.toThrow(/Unable to start subsystem: sftp/);
    await waitClosed(2);
    expect(stats).toEqual({ opened: 2, closed: 2 });
  });

  it('does not close a concurrent session that is still past its subsystem request', async () => {
    const { stats, client } = await connect('accept');
    // Subsystem accepted, SFTP handshake never answered: this open stays pending.
    const pending = openSftp(client);
    pending.catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(stats.opened).toBe(1);
    // Simulate a refused open on the same client running the cleanup scan.
    const refusing = { sftp: (cb: (err: Error) => void) => cb(new Error('Unable to start subsystem: sftp')) };
    Object.assign(refusing, { _chanMgr: (client as any)._chanMgr });
    await expect(openSftp(refusing as any)).rejects.toThrow(/subsystem/);
    await new Promise((r) => setTimeout(r, 50));
    expect(stats.closed).toBe(0);
  });
});
