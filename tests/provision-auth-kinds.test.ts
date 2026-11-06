/**
 * provision_auth(kind, ...), provisionAuthForKind: policy before any mint or prompt, the rejected drop, and no
 * value in the result, errors or log. The store and the scripts are real; the
 * delivery is a stub handler (the kb delivery comes with provision_kb_auth) and
 * the out-of-band prompt is a mock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { mockConfirm } = vi.hoisted(() => ({ mockConfirm: vi.fn() }));

vi.mock('../src/services/auth-socket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/auth-socket.js')>()),
  collectOobConfirm: mockConfirm,
}));

import {
  credentialDelete,
  credentialSet,
  credentialUpdate,
  lookupLiveSecret,
  prepareLiveSecret,
  saveLiveSecret,
} from '../src/services/credential-store.js';
import { getLiveTokenStatus, resetLiveTokenCache } from '../src/services/live-secret-cache.js';
import {
  provisionAuthForKind,
  ProvisionAuthError,
  type ProvisionKindFailure,
  type ProvisionKindHandler,
} from '../src/services/provision-auth-kinds.js';
import { addAgent } from '../src/services/registry.js';
import { getActiveLogFile } from '../src/utils/log-helpers.js';
import { backupAndResetRegistry, makeTestAgent, makeTestLocalAgent, restoreRegistry } from './test-helpers.js';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const TOKEN_CANARY = `tok-PROVISION-CANARY-${RUN}`;
const STATIC_CANARY = `static-PROVISION-CANARY-${RUN}`;
const BOUND_CANARY = `bound-PROVISION-CANARY-${RUN}`;
const REMOTE = 'https://kb.example.test';

let tmp: string;
let names: string[];
let local: ReturnType<typeof makeTestLocalAgent>;
let remote: ReturnType<typeof makeTestAgent>;
let calls: string[];
let delivered: Array<{ value: string; expiresAt: string | null; agentType?: string; params: unknown }>;
let stub: Record<string, ProvisionKindHandler<any>>;
let confirmedBeforeLastRun: number;

interface LiveFixture { name: string; runs: () => number; failFlag: string }

/** A live secret whose script counts runs and prints a different token and expiry per run. */
function live(label: string, opts: { policy?: 'allow' | 'confirm' | 'deny'; members?: string } = {}): LiveFixture {
  const name = `${label}_${RUN}`;
  names.push(name);
  const counter = path.join(tmp, `${label}.runs`);
  const failFlag = path.join(tmp, `${label}.fail`);
  const js = path.join(tmp, `${label}.js`);
  fs.writeFileSync(js, `
    const fs = require('fs');
    fs.appendFileSync(${JSON.stringify(counter)}, 'x');
    if (fs.existsSync(${JSON.stringify(failFlag)})) { process.stderr.write(${JSON.stringify(BOUND_CANARY)}); process.exit(3); }
    const run = fs.readFileSync(${JSON.stringify(counter)}, 'utf8').length;
    process.stdout.write(JSON.stringify({ token: ${JSON.stringify(TOKEN_CANARY)} + '-' + run, expires_at: new Date(Date.UTC(2099, 0, run)).toISOString() }));
  `);
  saveLiveSecret(prepareLiveSecret(name, { program: process.execPath, args: [js], env: [] }));
  if (opts.policy || opts.members) credentialUpdate(name, { ...(opts.policy ? { network_policy: opts.policy } : {}), ...(opts.members ? { members: opts.members } : {}) });
  return { name, runs: () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').length : 0), failFlag };
}

function staticSecret(label: string, opts: { policy?: 'allow' | 'confirm' | 'deny'; members?: string[]; ttl?: number } = {}): string {
  const name = `${label}_${RUN}`;
  names.push(name);
  credentialSet(name, STATIC_CANARY, true, opts.policy ?? 'allow', opts.members ?? '*', opts.ttl);
  return name;
}

const tokenOf = (run: number) => `${TOKEN_CANARY}-${run}`;
const expiryOf = (run: number) => new Date(Date.UTC(2099, 0, run)).toISOString();

function provision(secret: string, more: Record<string, unknown> = {}, handlers = stub, member: { id: string } = remote) {
  return provisionAuthForKind({ kind: 'kb', member_id: member.id, secret, remote: REMOTE, ...more }, handlers);
}

async function failure(p: Promise<unknown>): Promise<ProvisionAuthError> {
  const err = await p.then(() => { throw new Error('expected a refusal'); }, (e: unknown) => e);
  expect(err).toBeInstanceOf(ProvisionAuthError);
  return err as ProvisionAuthError;
}

function expectRefused(err: ProvisionAuthError, reason: ProvisionKindFailure): void {
  expect(err.code).toBe('E-PROVISION-AUTH');
  expect(err.reason).toBe(reason);
}

function lastMintedMs(fixture: LiveFixture): number {
  const at = getLiveTokenStatus(fixture.name, lookupLiveSecret(fixture.name)!).lastMintedAt;
  expect(at).not.toBeNull();
  return Date.parse(at as string);
}

function expectNoValue(...texts: string[]): void {
  const logFile = getActiveLogFile();
  const logged = logFile && fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  for (const text of [...texts, logged]) {
    expect(text).not.toContain(TOKEN_CANARY);
    expect(text).not.toContain(STATIC_CANARY);
    expect(text).not.toContain(BOUND_CANARY);
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-auth-'));
  names = [];
  calls = [];
  delivered = [];
  backupAndResetRegistry();
  local = makeTestLocalAgent({ friendlyName: `prov-local-${RUN}`, workFolder: tmp });
  remote = makeTestAgent({ friendlyName: `prov-remote-${RUN}` });
  addAgent(local);
  addAgent(remote);
  resetLiveTokenCache();
  confirmedBeforeLastRun = 0;
  mockConfirm.mockReset();
  mockConfirm.mockImplementation(async () => {
    calls.push('confirm');
    return { confirmed: true, terminalUnavailable: false };
  });
  stub = {
    kb: {
      parse: (input) => {
        calls.push('parse');
        return { remote: input.remote };
      },
      describe: () => 'stub target',
      prepare: async () => { calls.push('prepare'); },
      deliver: async ({ member, value, expiresAt, params }) => {
        calls.push('deliver');
        delivered.push({ value, expiresAt, agentType: member.agentType, params });
        return { status: 'verified' };
      },
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const n of names) {
    try { credentialDelete(n); } catch { /* already removed */ }
  }
  restoreRegistry();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('provisionAuthForKind: a live and a static secret', () => {
  it('a live secret mints, is delivered, and the result reports member, kind, name, expiry and verification only', async () => {
    const s = live('livebasic');
    const result = await provision(s.name);
    expect(result).toEqual({
      member: { id: remote.id, name: remote.friendlyName },
      kind: 'kb',
      secret: s.name,
      expiresAt: expiryOf(1),
      verification: { status: 'verified' },
    });
    expect(delivered).toEqual([{ value: tokenOf(1), expiresAt: expiryOf(1), agentType: 'remote', params: { remote: REMOTE } }]);
    expect(s.runs()).toBe(1);
    expectNoValue(JSON.stringify(result));
  }, 30_000);

  it('a second provision reuses the cached token and its own expiry', async () => {
    const s = live('livecached');
    await provision(s.name);
    const again = await provision(s.name);
    expect(again.expiresAt).toBe(expiryOf(1));
    expect(delivered[1].value).toBe(tokenOf(1));
    expect(s.runs()).toBe(1);
  }, 30_000);

  it('a static secret is delivered with its expiry, and runs no script', async () => {
    const name = staticSecret('statictl', { ttl: 3600 });
    const result = await provision(name);
    expect(delivered[0].value).toBe(STATIC_CANARY);
    expect(Date.parse(result.expiresAt as string)).toBeGreaterThan(Date.now());
    expect(delivered[0].expiresAt).toBe(result.expiresAt);
    expectNoValue(JSON.stringify(result));
  });

  it('a static secret with no expiry reports null, not a made-up time', async () => {
    const result = await provision(staticSecret('staticno'));
    expect(result.expiresAt).toBeNull();
  });

  it('a session static secret resolves too', async () => {
    const name = `session_${RUN}`;
    names.push(name);
    credentialSet(name, STATIC_CANARY, false, 'allow');
    await provision(name);
    expect(delivered[0].value).toBe(STATIC_CANARY);
  });

  it('hands the handler the member, local and remote alike, so a kind can branch on it', async () => {
    const s = live('bothmembers');
    await provision(s.name, {}, stub, local);
    await provision(s.name, {}, stub, remote);
    expect(delivered.map((d) => d.agentType)).toEqual(['local', 'remote']);
  }, 30_000);

  it('a missing secret and an expired static secret are refused, and nothing is delivered', async () => {
    expectRefused(await failure(provision(`nosuch_${RUN}`)), 'secret-not-found');
    const expired = staticSecret('staticexp', { ttl: -10 });
    expectRefused(await failure(provision(expired)), 'secret-expired');
    expect(calls).not.toContain('deliver');
  });
});

describe('provisionAuthForKind: allowedMembers', () => {
  it('a live secret not shared with the member is refused before any mint, prompt or handler step', async () => {
    const s = live('livenotshared', { members: 'someone-else', policy: 'confirm' });
    const err = await failure(provision(s.name));
    expectRefused(err, 'member-not-allowed');
    expect(err.message).toContain(remote.friendlyName);
    expect(s.runs()).toBe(0);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(calls).not.toContain('prepare');
    expect(calls).not.toContain('deliver');
  });

  it('a static secret not shared with the member is refused', async () => {
    const name = staticSecret('staticnotshared', { members: ['someone-else'] });
    expectRefused(await failure(provision(name)), 'member-not-allowed');
    expect(delivered).toEqual([]);
  });

  it('a listed member is served, by friendly name', async () => {
    const s = live('liveshared', { members: remote.friendlyName });
    await provision(s.name);
    expect(delivered[0].value).toBe(tokenOf(1));
    const name = staticSecret('staticshared', { members: [remote.friendlyName] });
    await provision(name);
    expect(delivered[1].value).toBe(STATIC_CANARY);
  }, 30_000);
});

describe('provisionAuthForKind: network policy', () => {
  it('deny refuses a live secret before any mint, prompt or handler step', async () => {
    const s = live('livedeny', { policy: 'deny' });
    expectRefused(await failure(provision(s.name)), 'policy-deny');
    expect(s.runs()).toBe(0);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(calls).toEqual(['parse']);
  });

  it('deny refuses a static secret', async () => {
    const name = staticSecret('staticdeny', { policy: 'deny' });
    expectRefused(await failure(provision(name)), 'policy-deny');
    expect(delivered).toEqual([]);
  });

  it('confirm asks out of band, after prepare and before the mint, and an accepted prompt delivers', async () => {
    const s = live('liveconfirm', { policy: 'confirm' });
    mockConfirm.mockImplementation(async () => {
      calls.push('confirm');
      confirmedBeforeLastRun = s.runs();
      return { confirmed: true, terminalUnavailable: false };
    });
    await provision(s.name);
    expect(calls).toEqual(['parse', 'prepare', 'confirm', 'deliver']);
    expect(confirmedBeforeLastRun).toBe(0);
    expect(s.runs()).toBe(1);
    const [confirmedName, context] = mockConfirm.mock.calls[0];
    expect(confirmedName).toBe(s.name);
    expect(context.memberName).toBe(remote.friendlyName);
    expect(context.command).toContain('stub target');
    expectNoValue(JSON.stringify(context));
  }, 30_000);

  it('confirm declined delivers nothing and runs no script', async () => {
    const s = live('livedeclined', { policy: 'confirm' });
    mockConfirm.mockResolvedValue({ confirmed: false, terminalUnavailable: false });
    expectRefused(await failure(provision(s.name)), 'confirm-declined');
    expect(s.runs()).toBe(0);
    expect(delivered).toEqual([]);
  });

  it('confirm with no terminal is its own failure, and delivers nothing', async () => {
    const name = staticSecret('staticnoterm', { policy: 'confirm' });
    mockConfirm.mockResolvedValue({ confirmed: false, terminalUnavailable: true });
    expectRefused(await failure(provision(name)), 'confirm-unavailable');
    expect(delivered).toEqual([]);
  });

  it('allow does not prompt', async () => {
    await provision(live('liveallow').name);
    expect(mockConfirm).not.toHaveBeenCalled();
  }, 30_000);

  it('a failing prepare shows no prompt and runs no script', async () => {
    const s = live('prepfail', { policy: 'confirm' });
    stub.kb.prepare = async () => { throw new ProvisionAuthError('not-available', 'install too old'); };
    expectRefused(await failure(provision(s.name)), 'not-available');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(s.runs()).toBe(0);
  });
});

describe('provisionAuthForKind: reason rejected', () => {
  it('drops a token minted before the rejection, and delivers a new one with its own expiry', async () => {
    const s = live('rejolder');
    await provision(s.name);
    const result = await provision(s.name, { reason: 'rejected', rejected_at: new Date(lastMintedMs(s) + 1000).toISOString() });
    expect(s.runs()).toBe(2);
    expect(delivered[1].value).toBe(tokenOf(2));
    expect(result.expiresAt).toBe(expiryOf(2));
  }, 30_000);

  it('keeps a token minted after the rejection, and runs no script', async () => {
    const s = live('rejnewer');
    await provision(s.name);
    const result = await provision(s.name, { reason: 'rejected', rejected_at: new Date(lastMintedMs(s) - 1000).toISOString() });
    expect(s.runs()).toBe(1);
    expect(delivered[1].value).toBe(tokenOf(1));
    expect(result.expiresAt).toBe(expiryOf(1));
  }, 30_000);

  it('with no time given, the rejection counts as now, so the cached token goes', async () => {
    const s = live('rejnow');
    await provision(s.name);
    await provision(s.name, { reason: 'rejected' });
    expect(s.runs()).toBe(2);
    expect(delivered[1].value).toBe(tokenOf(2));
  }, 30_000);

  it('without the reason the cached token stays', async () => {
    const s = live('rejnone');
    await provision(s.name);
    await provision(s.name);
    expect(s.runs()).toBe(1);
  }, 30_000);

  it('a failed mint after the drop fails: the rejected token is not delivered again', async () => {
    const s = live('rejfail');
    await provision(s.name);
    fs.writeFileSync(s.failFlag, '');
    expectRefused(await failure(provision(s.name, { reason: 'rejected' })), 'mint-failed');
    expect(delivered).toHaveLength(1);
  }, 30_000);

  it('a refused caller cannot drop the token: deny and a member it is not shared with leave the cache alone', async () => {
    const s = live('rejrefused');
    await provision(s.name);
    credentialUpdate(s.name, { network_policy: 'deny' });
    expectRefused(await failure(provision(s.name, { reason: 'rejected' })), 'policy-deny');
    credentialUpdate(s.name, { network_policy: 'allow', members: 'someone-else' });
    expectRefused(await failure(provision(s.name, { reason: 'rejected' })), 'member-not-allowed');
    credentialUpdate(s.name, { members: '*' });
    await provision(s.name);
    expect(s.runs()).toBe(1);
    expect(delivered[1].value).toBe(tokenOf(1));
  }, 30_000);

  it('a declined prompt leaves the cache alone', async () => {
    const s = live('rejdeclined');
    await provision(s.name);
    credentialUpdate(s.name, { network_policy: 'confirm' });
    mockConfirm.mockResolvedValue({ confirmed: false, terminalUnavailable: false });
    expectRefused(await failure(provision(s.name, { reason: 'rejected' })), 'confirm-declined');
    credentialUpdate(s.name, { network_policy: 'allow' });
    await provision(s.name);
    expect(s.runs()).toBe(1);
  }, 30_000);

  it('a static secret has no cached token: the value is delivered, and the handler\'s verification reports the rest', async () => {
    const name = staticSecret('rejstatic');
    await provision(name, { reason: 'rejected' });
    expect(delivered[0].value).toBe(STATIC_CANARY);
  });

  it('a bad rejected_at, rejected_at without the reason, and an unknown reason are refused before any mint', async () => {
    const s = live('rejbad');
    expectRefused(await failure(provision(s.name, { reason: 'rejected', rejected_at: 'yesterday' })), 'bad-input');
    expectRefused(await failure(provision(s.name, { rejected_at: new Date().toISOString() })), 'bad-input');
    expectRefused(await failure(provision(s.name, { reason: 'other' })), 'bad-input');
    expect(s.runs()).toBe(0);
  });
});

describe('provisionAuthForKind: no value in the result, errors or log', () => {
  it('a verification detail holding the value is scrubbed', async () => {
    const s = live('leakdetail');
    stub.kb.deliver = async ({ value }) => ({ status: 'failed', detail: `server said no to ${value}` });
    const result = await provision(s.name);
    expect(result.verification).toEqual({ status: 'failed', detail: `server said no to [REDACTED:${s.name}]` });
    expectNoValue(JSON.stringify(result));
  }, 30_000);

  it('a typed handler error holding the value is scrubbed, and keeps its reason', async () => {
    const s = live('leaktyped');
    stub.kb.deliver = async ({ value }) => { throw new ProvisionAuthError('delivery-failed', `ssh failed for ${value}`); };
    const err = await failure(provision(s.name));
    expectRefused(err, 'delivery-failed');
    expect(err.message).toBe(`ssh failed for [REDACTED:${s.name}]`);
    expectNoValue(err.message, String(err.stack));
  }, 30_000);

  it('any other handler error loses its text', async () => {
    const name = staticSecret('leakplain');
    stub.kb.deliver = async ({ value }) => { throw new Error(`stderr: ${value}`); };
    const err = await failure(provision(name));
    expectRefused(err, 'delivery-failed');
    expect(err.message).toContain(name);
    expectNoValue(err.message, String(err.stack));
    stub.kb.prepare = async () => { throw new Error(STATIC_CANARY); };
    const early = await failure(provision(name));
    expectRefused(early, 'delivery-failed');
    expectNoValue(early.message);
  });

  it('a failed mint gives a typed error without the script\'s output', async () => {
    const s = live('leakmint');
    fs.writeFileSync(s.failFlag, '');
    const err = await failure(provision(s.name));
    expectRefused(err, 'mint-failed');
    expect(err.message).toContain(s.name);
    expectNoValue(err.message);
  }, 30_000);

  it('a success and a refusal each leave a names-only log line', async () => {
    const s = live('logged');
    await provision(s.name);
    credentialUpdate(s.name, { network_policy: 'deny' });
    await failure(provision(s.name));
    const logged = fs.readFileSync(getActiveLogFile() as string, 'utf8');
    expect(logged).toContain(`secret=\\"${s.name}\\" expires=${expiryOf(1)} verification=verified`);
    expect(logged).toContain(`secret=\\"${s.name}\\" failed: policy-deny`);
    expectNoValue();
  }, 30_000);
});

describe('provisionAuthForKind: the kind table', () => {
  it('an unknown kind is refused, including a name every object inherits', async () => {
    const name = staticSecret('unknownkind');
    for (const kind of ['nope', '__proto__', 'constructor']) {
      expectRefused(await failure(provisionAuthForKind({ kind, member_id: remote.id, secret: name })), 'unknown-kind');
    }
  });

  it('an unknown member is refused', async () => {
    const name = staticSecret('unknownmember');
    expectRefused(await failure(provisionAuthForKind({ kind: 'kb', member_name: `ghost-${RUN}`, secret: name }, stub)), 'member-not-found');
    expectRefused(await failure(provisionAuthForKind({ kind: 'kb', secret: name }, stub)), 'member-not-found');
  });

  it('kb needs an http(s) remote', async () => {
    const name = staticSecret('kbremote');
    for (const bad of [undefined, '', 'not a url', 'ftp://kb.example.test']) {
      expectRefused(await failure(provisionAuthForKind({ kind: 'kb', member_id: remote.id, secret: name, remote: bad })), 'bad-input');
    }
  });

  it('kb delivery is not available yet, and says so before any mint or prompt', async () => {
    const s = live('kbnotyet', { policy: 'confirm' });
    const err = await failure(provisionAuthForKind({ kind: 'kb', member_id: remote.id, secret: s.name, remote: REMOTE }));
    expectRefused(err, 'not-available');
    expect(s.runs()).toBe(0);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('kb applies policy first: deny wins over not available', async () => {
    const s = live('kbdeny', { policy: 'deny' });
    expectRefused(await failure(provisionAuthForKind({ kind: 'kb', member_id: local.id, secret: s.name, remote: REMOTE })), 'policy-deny');
  });
});
