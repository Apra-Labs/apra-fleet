import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// HttpKbProvider applies the secret's deny and allowedMembers on every KB call,
// for a static and a live secret, before any request or script run. The member
// session comes from the same context a tool call runs in. A registered member
// here stands for both cases: a local member on the orchestrator's fleet server,
// and a remote member on its own server, where it registers itself as type local
// under its orchestrator-side id and name. Real store, real helper, real local
// HTTP server.

import { HttpKbProvider, KbHttpAuthError } from '../../src/services/knowledge/http-provider.js';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { KB_CONFIG_PATH, readKbConfigFromDisk } from '../../src/services/knowledge/kb-config.js';
import {
  credentialDelete,
  credentialSet,
  credentialUpdate,
  prepareLiveSecret,
  saveLiveSecret,
} from '../../src/services/credential-store.js';
import { resetLiveTokenCache } from '../../src/services/live-secret-cache.js';
import { addAgent } from '../../src/services/registry.js';
import { runWithSessionMember } from '../../src/services/tool-scope.js';
import { kbHttpCredentialHealth } from '../../src/tools/check-status.js';
import { kbSetup, kbSetupSchema } from '../../src/tools/kb-setup.js';
import type { KBEntryInput } from '../../src/services/knowledge/types.js';
import { backupAndResetRegistry, makeTestLocalAgent, restoreRegistry } from '../test-helpers.js';
import { makeTempDir } from './token-command-helpers.js';
import { writeCountingHelper, startStubKbServer, type CountingHelper, type StubKbServer } from './kb-live-secret-fixture.js';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const STATIC = `KB_STATIC_${RUN}`;
const LIVE = `KB_LIVE_${RUN}`;
const VALUE = `zqcanary-kbpolicy-static-${RUN}`;
const PREFIX = `zqcanary-kbpolicy-live-${RUN}`;

let stub: StubKbServer;
let tmp: string;
let helper: CountingHelper;
let provider: HttpKbProvider;
let liveProvider: HttpKbProvider;
let member: ReturnType<typeof makeTestLocalAgent>;
let other: ReturnType<typeof makeTestLocalAgent>;
let savedConfig: string | null;

function entry(title: string): KBEntryInput {
  return {
    type: 'learning', title, summary: `${title} -- summary`, content: `${title} content`,
    source_files: ['src/gear.ts'], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
    flagged_for_review: false, author: 'test', source: 'session', confidence: 'INFERRED',
  };
}

async function authError(p: Promise<unknown>, reason: string, secret: string): Promise<KbHttpAuthError> {
  const err = await p.then(() => { throw new Error('expected E-KB-HTTP-AUTH'); }, (e: unknown) => e);
  expect(err).toBeInstanceOf(KbHttpAuthError);
  const auth = err as KbHttpAuthError;
  expect(auth.code).toBe('E-KB-HTTP-AUTH');
  expect(auth.reason).toBe(reason);
  expect(auth.secretName).toBe(secret);
  expect(auth.message).toContain(`"${secret}"`);
  expect(auth.message).not.toContain(VALUE);
  expect(auth.message).not.toContain(PREFIX);
  return auth;
}

const asMember = <T>(id: string | undefined, fn: () => Promise<T>) => runWithSessionMember(id, fn);

beforeAll(async () => {
  stub = await startStubKbServer();
  savedConfig = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
});

afterAll(async () => {
  await stub.close();
  if (savedConfig === null) fs.rmSync(KB_CONFIG_PATH, { force: true });
  else fs.writeFileSync(KB_CONFIG_PATH, savedConfig);
});

beforeEach(() => {
  tmp = makeTempDir('kb-http-policy-');
  backupAndResetRegistry();
  member = makeTestLocalAgent({ friendlyName: `kb-member-${RUN}`, workFolder: tmp });
  other = makeTestLocalAgent({ friendlyName: `kb-other-${RUN}`, workFolder: path.join(tmp, 'other') });
  addAgent(member);
  addAgent(other);
  credentialSet(STATIC, VALUE, true, 'allow');
  helper = writeCountingHelper(tmp, PREFIX);
  saveLiveSecret(prepareLiveSecret(LIVE, { program: helper.launch.program, args: helper.launch.args, env: [] }));
  resetLiveTokenCache();
  stub.requests.length = 0;
  const fallback = new SqliteProvider(path.join(tmp, 'fallback.sqlite'));
  provider = new HttpKbProvider(stub.url, { secretName: STATIC }, fallback);
  liveProvider = new HttpKbProvider(stub.url, { secretName: LIVE }, fallback);
});

afterEach(() => {
  provider.dispose();
  liveProvider.dispose();
  credentialDelete(STATIC);
  credentialDelete(LIVE);
  restoreRegistry();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a store with no restrictions behaves as before', () => {
  it('allow and all members: every kind of session gets through, with the secret as the bearer', async () => {
    for (const id of [undefined, member.id, 'an-id-this-server-does-not-know']) {
      await asMember(id, () => provider.query({ query: 'gear' }));
      await asMember(id, () => liveProvider.query({ query: 'gear' }));
    }
    expect(stub.requests).toHaveLength(6);
    expect(stub.requests.filter((r) => r.token === VALUE)).toHaveLength(3);
    expect(stub.requests.filter((r) => r.token.includes(PREFIX))).toHaveLength(3);
    expect(helper.runs()).toHaveLength(1);
  }, 30_000);

  it('a record with no allowedMembers field, written by an older install, is all members', async () => {
    const file = path.join(process.env.APRA_FLEET_DATA_DIR as string, 'credentials.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete stored.credentials[STATIC].allowedMembers;
    fs.writeFileSync(file, JSON.stringify(stored));
    await asMember(member.id, () => provider.query({ query: 'gear' }));
    expect(stub.requests).toHaveLength(1);
  });

  it('a literal token has no record, so no policy applies', async () => {
    const literal = new HttpKbProvider(stub.url, 'literal-token', new SqliteProvider(path.join(tmp, 'literal.sqlite')));
    try {
      await asMember(member.id, () => literal.query({ query: 'gear' }));
      expect(stub.requests[0].token).toBe('literal-token');
    } finally {
      literal.dispose();
    }
  });

  it('a record stored with the removed confirm policy acts as allow', async () => {
    const file = path.join(process.env.APRA_FLEET_DATA_DIR as string, 'credentials.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.credentials[STATIC].network_policy = 'confirm';
    stored.credentials[LIVE].network_policy = 'confirm';
    fs.writeFileSync(file, JSON.stringify(stored));
    await asMember(member.id, () => provider.query({ query: 'gear' }));
    await asMember(member.id, () => liveProvider.query({ query: 'gear' }));
    expect(stub.requests).toHaveLength(2);
  }, 30_000);
});

describe('deny', () => {
  it('a static secret: refused for a member session and an operator session, no request sent', async () => {
    credentialUpdate(STATIC, { network_policy: 'deny' });
    for (const id of [member.id, undefined]) {
      const err = await asMember(id, () => authError(provider.query({ query: 'gear' }), 'policy-deny', STATIC));
      expect(err.message).toContain('network_policy=deny');
      expect(err.remediation).toContain(`apra-fleet secret --update ${STATIC} --allow`);
    }
    expect(stub.requests).toEqual([]);
  });

  it('a live secret: refused with no script run and no request sent', async () => {
    credentialUpdate(LIVE, { network_policy: 'deny' });
    await asMember(member.id, () => authError(liveProvider.query({ query: 'gear' }), 'policy-deny', LIVE));
    expect(helper.runs()).toEqual([]);
    expect(stub.requests).toEqual([]);
  });

  it('applies on every call: lifting it works on the next call with no restart', async () => {
    credentialUpdate(STATIC, { network_policy: 'deny' });
    await authError(provider.query({ query: 'gear' }), 'policy-deny', STATIC);
    credentialUpdate(STATIC, { network_policy: 'allow' });
    await provider.query({ query: 'gear' });
    expect(stub.requests).toHaveLength(1);
    credentialUpdate(STATIC, { network_policy: 'deny' });
    await authError(provider.query({ query: 'gear' }), 'policy-deny', STATIC);
    expect(stub.requests).toHaveLength(1);
  });

  it('a refused capture or invalidate is not queued, so it does not go out once allowed', async () => {
    credentialUpdate(STATIC, { network_policy: 'deny' });
    const capture = await authError(provider.capture(entry('refused')), 'policy-deny', STATIC);
    const invalidate = await authError(provider.invalidate(['src/gear.ts']), 'policy-deny', STATIC);
    expect([capture.queued, invalidate.queued]).toEqual([false, false]);
    expect(capture.message).not.toContain('queued');
    expect(provider.offlineQueue).toHaveLength(0);
    credentialUpdate(STATIC, { network_policy: 'allow' });
    await provider.capture(entry('next'));
    expect(stub.requests.map((r) => r.path)).toEqual(['/api/kb/capture']);
  });

  it('a write queued before the refusal stays queued through it, and goes once allowed', async () => {
    credentialDelete(STATIC);
    await authError(provider.capture(entry('from an outage of the secret')), 'missing', STATIC).then((e) => expect(e.queued).toBe(true));
    credentialSet(STATIC, VALUE, true, 'deny');
    await authError(provider.capture(entry('refused')), 'policy-deny', STATIC);
    expect(provider.offlineQueue).toHaveLength(1);
    credentialUpdate(STATIC, { network_policy: 'allow' });
    await provider.query({ query: 'gear' });
    expect(provider.offlineQueue).toHaveLength(0);
    expect(stub.requests.map((r) => r.path)).toEqual(['/api/kb/capture', '/api/kb/query']);
  });

  it('kb_setup refuses a deny secret, static and live, and takes it once allowed', async () => {
    const refused = async (name: string) => {
      const err = await kbSetup({ provider: 'http', remote: stub.url, token: `{{secret.${name}}}` } as never, { folder: tmp }).then(() => null, (e: Error) => e);
      expect(err?.message).toContain('network_policy=deny');
      expect(err?.message).toContain(`apra-fleet secret --update ${name} --allow`);
    };
    credentialUpdate(STATIC, { network_policy: 'deny' });
    credentialUpdate(LIVE, { network_policy: 'deny' });
    await refused(STATIC);
    await refused(LIVE);
    credentialUpdate(STATIC, { network_policy: 'allow' });
    credentialUpdate(LIVE, { network_policy: 'allow' });
    await kbSetup({ provider: 'http', remote: stub.url, token: `{{secret.${STATIC}}}` } as never, { folder: tmp });
    await kbSetup({ provider: 'http', remote: stub.url, token: `{{secret.${LIVE}}}` } as never, { folder: tmp });
  }, 30_000);

  it('the kb_setup contract states the deny refusal, in the tool schema and the generated request schema', () => {
    expect(kbSetupSchema.shape.token.description).toContain('must not have network_policy deny');
    const generated = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'memory-contract', 'v1', 'schemas', 'kb_setup.request.json'), 'utf8'));
    expect(JSON.stringify(generated)).toContain('must not have network_policy deny');
  });

  it('the client wrapper lists denied, in its type and its docs', () => {
    const root = path.resolve(__dirname, '..', '..', 'packages', 'apra-fleet-client');
    const type = fs.readFileSync(path.join(root, 'src', 'client', 'api.mjs'), 'utf8').split('\n').find((l) => l.includes('[resolves]'));
    expect(type).toContain('"denied"');
    const docs = fs.readFileSync(path.join(root, 'docs', 'api-reference.md'), 'utf8');
    expect(docs).toContain('`denied` when its network policy is deny, and every KB');
    expect(docs).toContain('`denied` when its network policy is deny)');
  });

  it('fleet_status says denied, static and live', () => {
    const health = (name: string) => kbHttpCredentialHealth({ provider: 'http', url: stub.url, tokenSecretName: name } as ReturnType<typeof readKbConfigFromDisk>);
    expect(health(STATIC)).toMatchObject({ resolves: 'ok' });
    expect(health(LIVE)).toMatchObject({ resolves: 'not run' });
    credentialUpdate(STATIC, { network_policy: 'deny' });
    credentialUpdate(LIVE, { network_policy: 'deny' });
    expect(health(STATIC)).toMatchObject({ resolves: 'denied' });
    expect(health(LIVE)).toMatchObject({ resolves: 'denied' });
  });
});

describe('allowedMembers', () => {
  it('a member not listed is refused by name, static and live, with no request or script run', async () => {
    credentialUpdate(STATIC, { members: member.friendlyName });
    credentialUpdate(LIVE, { members: member.friendlyName });
    const err = await asMember(other.id, () => authError(provider.query({ query: 'gear' }), 'member-not-allowed', STATIC));
    expect(err.message).toContain(other.friendlyName);
    expect(err.remediation).toContain(`apra-fleet secret --update ${STATIC} --members`);
    await asMember(other.id, () => authError(liveProvider.query({ query: 'gear' }), 'member-not-allowed', LIVE));
    expect(helper.runs()).toEqual([]);
    expect(stub.requests).toEqual([]);
  });

  it('a listed member gets through, matched by friendly name', async () => {
    credentialUpdate(STATIC, { members: member.friendlyName });
    credentialUpdate(LIVE, { members: member.friendlyName });
    await asMember(member.id, () => provider.query({ query: 'gear' }));
    await asMember(member.id, () => liveProvider.query({ query: 'gear' }));
    expect(stub.requests).toHaveLength(2);
  }, 30_000);

  it('a member id this server cannot name fails a restricted secret closed', async () => {
    credentialUpdate(STATIC, { members: member.friendlyName });
    const err = await asMember('an-id-this-server-does-not-know', () => authError(provider.query({ query: 'gear' }), 'member-not-allowed', STATIC));
    expect(err.message).toContain('an-id-this-server-does-not-know');
    expect(stub.requests).toEqual([]);
  });

  it('an operator session has no member to check, as in credentialResolve', async () => {
    credentialUpdate(STATIC, { members: member.friendlyName });
    await asMember(undefined, () => provider.query({ query: 'gear' }));
    expect(stub.requests).toHaveLength(1);
  });

  it('a member refused here has its capture dropped, not sent by the next session on this provider', async () => {
    credentialUpdate(STATIC, { members: member.friendlyName });
    const err = await asMember(other.id, () => authError(provider.capture(entry('from outsider')), 'member-not-allowed', STATIC));
    expect(err.queued).toBe(false);
    await asMember(other.id, () => authError(provider.invalidate(['src/gear.ts']), 'member-not-allowed', STATIC));
    expect(provider.offlineQueue).toHaveLength(0);
    await asMember(member.id, () => provider.capture(entry('from member')));
    expect(stub.requests.map((r) => r.path)).toEqual(['/api/kb/capture']);
  });

  it('the caller is read per call, not fixed on the provider', async () => {
    credentialUpdate(STATIC, { members: member.friendlyName });
    await asMember(member.id, () => provider.query({ query: 'gear' }));
    await asMember(other.id, () => authError(provider.query({ query: 'gear' }), 'member-not-allowed', STATIC));
    await asMember(member.id, () => provider.query({ query: 'gear' }));
    expect(stub.requests).toHaveLength(2);
  });
});
