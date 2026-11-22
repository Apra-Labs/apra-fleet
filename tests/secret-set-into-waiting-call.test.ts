import net from 'node:net';
import { describe, it, expect, vi, afterEach } from 'vitest';

// A value typed with `apra-fleet secret --set NAME` while credential_store_set
// waits for NAME: each flag typed on the CLI replaces what the call asked for,
// and anything not typed is as the call asked. Real auth socket, real CLI
// handler, real credential store; only the terminal launch and the keyboard
// prompt are replaced.

vi.mock('../src/services/auth-socket.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/services/auth-socket.js')>();
  return {
    ...real,
    collectOobApiKey: (name: string, tool: string, opts?: Parameters<typeof real.collectOobApiKey>[2]) =>
      real.collectOobApiKey(name, tool, { ...opts, launchFn: () => 'launched' }),
  };
});

const VALUE = `zqcanary-waiting-${Date.now().toString(36)}`;
vi.mock('../src/utils/collect-secret.js', () => ({ collectSecret: async () => VALUE }));

import { hasPendingAuth, cleanupAuthSocket, getSocketPath } from '../src/services/auth-socket.js';
import { credentialStoreSet } from '../src/tools/credential-store-set.js';
import { runSecret } from '../src/cli/secret.js';
import { credentialDelete, lookupServerSecret } from '../src/services/credential-store.js';

const NAME = `WAITING_${Date.now().toString(36)}`;
const LATER = '2099-01-01T00:00:00.000Z';

afterEach(async () => {
  vi.restoreAllMocks();
  credentialDelete(NAME);
  await cleanupAuthSocket();
});

async function untilPending(name: string): Promise<void> {
  for (let i = 0; i < 200 && !hasPendingAuth(name); i++) await new Promise((r) => setTimeout(r, 10));
  expect(hasPendingAuth(name)).toBe(true);
}

/** What was stored: tier, policy, members and expiry, after checking the value is the typed one. */
function stored(): [string, string, string[] | '*', string | undefined] {
  const found = lookupServerSecret(NAME);
  expect(found.status).toBe('ok');
  if (found.status !== 'ok') throw new Error('not stored');
  expect(found.value).toBe(VALUE);
  return [found.meta.scope, found.meta.network_policy, found.meta.allowedMembers, found.meta.expiresAt];
}

/** Run `apra-fleet secret` into the waiting call, returning what it printed to stderr. */
async function typed(args: string[]): Promise<string> {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a.join(' ')); });
  await runSecret(args);
  return errors.join('\n');
}

describe('secret --set into a waiting credential_store_set', () => {
  it('each flag typed on the CLI replaces what the waiting call asked for, and the CLI says so', async () => {
    const waiting = credentialStoreSet({ name: NAME, prompt: 'value', persist: false, network_policy: 'deny', members: 'alpha', ttl_seconds: 60 });
    await untilPending(NAME);
    const out = await typed(['--set', NAME, '--persist', '--allow', '--members', '*', '--expires-at', LATER]);
    expect(out).toContain('From this command: --persist, --allow, --members, --expires-at;');
    expect(await waiting).toContain(`${NAME} stored [persistent]`);
    expect(stored()).toEqual(['persistent', 'allow', '*', LATER]);
  });

  it('a flag left off the CLI keeps the waiting call\'s value, never a CLI default', async () => {
    const tier = credentialStoreSet({ name: NAME, prompt: 'value', persist: true, network_policy: 'deny', members: 'alpha' });
    await untilPending(NAME);
    const bare = await typed(['--set', NAME]);
    await tier;
    expect(stored().slice(0, 3)).toEqual(['persistent', 'deny', ['alpha']]);
    expect(bare).not.toContain('From this command');
    credentialDelete(NAME);

    const policy = credentialStoreSet({ name: NAME, prompt: 'value', network_policy: 'deny', members: 'alpha' });
    await untilPending(NAME);
    const members = await typed(['--set', NAME, '--persist', '--members', 'beta']);
    await policy;
    expect(stored().slice(0, 3)).toEqual(['persistent', 'deny', ['beta']]);
    expect(members).toContain('From this command: --persist, --members;');
  });

  it('a CLI that does not say which flags were typed gets the waiting call\'s values', async () => {
    const waiting = credentialStoreSet({ name: NAME, prompt: 'value', persist: false, network_policy: 'deny', members: 'alpha' });
    await untilPending(NAME);
    // What `secret --set NAME --persist --allow` sent before the rule: persist, and no typed fields.
    const ack = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const client = net.connect(getSocketPath(), () => {
        client.write(JSON.stringify({ type: 'auth', member_name: NAME, password: VALUE, persist: true }) + '\n');
      });
      client.on('data', (chunk) => { resolve(JSON.parse(chunk.toString().split('\n')[0])); client.end(); });
      client.on('error', reject);
    });
    await waiting;
    expect(stored().slice(0, 3)).toEqual(['session', 'deny', ['alpha']]);
    expect(ack).toEqual({ type: 'ack', ok: true, stored: true });
  });
});
