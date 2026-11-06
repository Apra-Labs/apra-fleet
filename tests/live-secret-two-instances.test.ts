/**
 * The server and the CLI are separate processes that share credentials.json but
 * not the session store. Two module instances stand in for them, so what the CLI
 * reports can be compared with what the server then does.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Store = typeof import('../src/services/credential-store.js');

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

let server: Store;
let cli: Store;
let tmp: string;
let names: string[];

async function freshInstance(): Promise<Store> {
  vi.resetModules();
  return import('../src/services/credential-store.js');
}

function name(label: string): string {
  const n = `${label}_${RUN}`;
  names.push(n);
  return n;
}

function credentialsFile(): Buffer {
  return fs.readFileSync(path.join(cli.credentialDataDir(), 'credentials.json'));
}

/** Bind `secret` to a new live secret from the CLI instance. The script is never run here. */
function bindFromCli(secret: string): string {
  const js = path.join(tmp, 'mint.js');
  fs.writeFileSync(js, '');
  const live = name('consumer');
  cli.saveLiveSecret(cli.prepareLiveSecret(live, {
    program: process.execPath, args: [js], env: [{ env: 'X', value: `{{secret.${secret}}}` }],
  }));
  return live;
}

beforeEach(async () => {
  server = await freshInstance();
  cli = await freshInstance();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-two-'));
  names = [];
});

afterEach(() => {
  for (const n of names.filter((x) => cli.isLiveSecret(x))) cli.credentialDelete(n);
  for (const n of names) {
    try { cli.credentialDelete(n); } catch { /* already removed */ }
    try { server.credentialDelete(n); } catch { /* already removed */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the instances really are separate', () => {
  it('a session value in the server is not visible to the CLI', () => {
    const r = name('separate');
    server.credentialSet(r, 'session-value', false, 'allow');
    expect(cli.credentialResolve(r, '*')).toBeNull();
    expect(server.credentialResolve(r, '*')).toHaveProperty('plaintext', 'session-value');
  });
});

describe('expired bound secret: the CLI refusal matches the server view', () => {
  function expiredBound(): { r: string; live: string } {
    const r = name('bound');
    cli.credentialSet(r, 'old-value', true, 'deny', ['alpha'], -1);
    return { r, live: bindFromCli(r) };
  }

  it('--ttl from the CLI is refused, the file is untouched, and the server still says expired', () => {
    const { r, live } = expiredBound();
    const before = credentialsFile();

    expect(() => cli.credentialUpdate(r, { expiresAt: Date.now() + 3_600_000 })).toThrow(cli.BoundSecretError);
    expect(() => cli.credentialUpdate(r, { expiresAt: null })).toThrow(/--persist/);
    expect(() => cli.credentialUpdate(r, { members: '*' })).toThrow(`in use by: ${live}`);
    expect(() => cli.credentialUpdate(r, { network_policy: 'allow' })).toThrow(cli.BoundSecretError);

    expect(credentialsFile().equals(before)).toBe(true);
    expect(server.credentialResolve(r, 'alpha')).toHaveProperty('expired');
    expect(server.lookupServerSecret(r).status).toBe('expired');
  });

  it('a session value cannot be set in the server, because the binding is read from the file', () => {
    const { r } = expiredBound();
    expect(() => server.credentialSet(r, 'fresh-value', false, 'allow')).toThrow(/--persist/);
    expect(server.credentialResolve(r, 'alpha')).toHaveProperty('expired');
  });

  it('a session value the server already held when the CLI bound the name does not take over at expiry', () => {
    const r = name('heldsession');
    cli.credentialSet(r, 'persistent-value', true, 'deny', ['alpha'], -1);
    server.credentialSet(r, 'held-session-value', false, 'allow', '*');
    bindFromCli(r); // the CLI cannot see the server's session store

    expect(server.credentialResolve(r, 'beta')).toHaveProperty('expired');
    expect(server.lookupServerSecret(r).status).toBe('expired');
    expect(() => cli.credentialUpdate(r, { network_policy: 'allow' })).toThrow(cli.BoundSecretError);
  });

  it('--set --persist from the CLI is the fix, and the server serves the new value', () => {
    const { r } = expiredBound();
    cli.credentialSet(r, 'new-value', true, 'allow');
    expect(server.credentialResolve(r, 'anyone')).toHaveProperty('plaintext', 'new-value');
    cli.credentialUpdate(r, { members: 'alpha' });
    expect(server.credentialResolve(r, 'beta')).toHaveProperty('denied');
  });
});

describe('a restriction reported by the CLI takes effect in the server', () => {
  it('a valid bound secret: --members and --deny from the CLI apply to the next resolve', () => {
    const r = name('valid');
    cli.credentialSet(r, 'value', true, 'allow');
    bindFromCli(r);

    expect(cli.credentialUpdate(r, { members: 'alpha', network_policy: 'deny' })).toMatchObject({ members: 'alpha', network_policy: 'deny' });

    expect(server.credentialResolve(r, 'beta')).toHaveProperty('denied');
    expect(server.credentialResolve(r, 'alpha')).toMatchObject({ meta: { network_policy: 'deny' } });
  });
});

describe('unbound secrets across the two processes, as on main', () => {
  it('after the server resolved an expired secret, the CLI update reports not found', () => {
    const r = name('unbound');
    cli.credentialSet(r, 'old-value', true, 'deny', ['alpha'], -1);
    expect(server.credentialResolve(r, 'alpha')).toHaveProperty('expired');

    server.credentialSet(r, 'fresh-value', false, 'allow');

    expect(cli.credentialUpdate(r, { network_policy: 'deny' })).toBeNull();
    expect(server.credentialResolve(r, 'beta')).toHaveProperty('plaintext', 'fresh-value');
  });
});
