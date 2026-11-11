import { describe, it, expect, vi, afterEach } from 'vitest';

// A value typed with `apra-fleet secret --set NAME --persist` while
// credential_store_set waits for NAME lands with the policy that call asked
// for. Real auth socket, real CLI handler, real credential store; only the
// terminal launch and the keyboard prompt are replaced.

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

import { hasPendingAuth, cleanupAuthSocket } from '../src/services/auth-socket.js';
import { credentialStoreSet } from '../src/tools/credential-store-set.js';
import { runSecret } from '../src/cli/secret.js';
import { credentialDelete, lookupServerSecret } from '../src/services/credential-store.js';

const NAME = `WAITING_${Date.now().toString(36)}`;

afterEach(async () => {
  credentialDelete(NAME);
  await cleanupAuthSocket();
});

async function untilPending(name: string): Promise<void> {
  for (let i = 0; i < 200 && !hasPendingAuth(name); i++) await new Promise((r) => setTimeout(r, 10));
  expect(hasPendingAuth(name)).toBe(true);
}

describe('secret --set --persist into a waiting credential_store_set', () => {
  it('the value lands with the deny and members the waiting call asked for, not the CLI flags', async () => {
    const waiting = credentialStoreSet({ name: NAME, prompt: 'value', network_policy: 'deny', members: 'alpha' });
    await untilPending(NAME);
    await runSecret(['--set', NAME, '--persist', '--allow', '--members', '*']);
    expect(await waiting).toContain(`${NAME} stored [persistent]`);
    const found = lookupServerSecret(NAME);
    expect(found.status).toBe('ok');
    if (found.status !== 'ok') return;
    expect(found.value).toBe(VALUE);
    expect([found.meta.network_policy, found.meta.allowedMembers]).toEqual(['deny', ['alpha']]);
  });
});
