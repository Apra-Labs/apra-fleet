/**
 * provision_auth(kind, ...), provisionAuthForKind: policy before any mint, the
 * rejected drop, and no handler text or value in the result, errors or log. The
 * store and the scripts are real; the delivery is a stub handler (the kb delivery
 * itself is tested in provision-kb-auth.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  credentialDataDir,
  credentialDelete,
  credentialSet,
  credentialUpdate,
  lookupLiveSecret,
  prepareLiveSecret,
  saveLiveSecret,
} from '../src/services/credential-store.js';
import {
  dropCachedLiveToken,
  getLiveTokenDetail,
  getLiveTokenStatus,
  resetLiveTokenCache,
} from '../src/services/live-secret-cache.js';
import {
  provisionAuthForKind,
  ProvisionAuthError,
  ProvisionHandlerError,
  type ProvisionKindFailure,
  type ProvisionKindHandler,
} from '../src/services/provision-auth-kinds.js';
import { addAgent, getAgent, updateAgent } from '../src/services/registry.js';
import { getActiveLogFile } from '../src/utils/log-helpers.js';
import { backupAndResetRegistry, makeTestAgent, makeTestLocalAgent, restoreRegistry } from './test-helpers.js';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const TOKEN_CANARY = `tok-PROVISION-CANARY-${RUN}`;
const STATIC_CANARY = `static-PROVISION-CANARY-${RUN}`;
const BOUND_CANARY = `bound-PROVISION-CANARY-${RUN}`;
const HANDLER_TEXT = `handler-free-text-${RUN}`;
const REMOTE = 'https://kb.example.test';

let tmp: string;
let names: string[];
let local: ReturnType<typeof makeTestLocalAgent>;
let remote: ReturnType<typeof makeTestAgent>;
let calls: string[];
let delivered: Array<{ value: string; expiresAt: string | null; agentType?: string; host?: string; params: unknown }>;
let stub: Record<string, ProvisionKindHandler<any>>;

interface LiveFixture { name: string; runs: () => number; failFlag: string; holdFlag: string }

/**
 * A live secret whose script counts runs and prints a different token and expiry
 * per run. It fails while failFlag exists, after waiting for holdFlag to go away.
 */
function live(label: string, opts: { policy?: 'allow' | 'deny'; members?: string; lifetimeMs?: number } = {}): LiveFixture {
  const name = `${label}_${RUN}`;
  names.push(name);
  const counter = path.join(tmp, `${label}.runs`);
  const failFlag = path.join(tmp, `${label}.fail`);
  const holdFlag = path.join(tmp, `${label}.hold`);
  const js = path.join(tmp, `${label}.js`);
  const expiry = opts.lifetimeMs ? `new Date(Date.now() + ${opts.lifetimeMs})` : 'new Date(Date.UTC(2099, 0, run))';
  fs.writeFileSync(js, `
    const fs = require('fs');
    fs.appendFileSync(${JSON.stringify(counter)}, 'x');
    const run = fs.readFileSync(${JSON.stringify(counter)}, 'utf8').length;
    const finish = () => {
      if (fs.existsSync(${JSON.stringify(failFlag)})) { process.stderr.write(${JSON.stringify(BOUND_CANARY)}); process.exit(3); }
      process.stdout.write(JSON.stringify({ token: ${JSON.stringify(TOKEN_CANARY)} + '-' + run, expires_at: ${expiry}.toISOString() }));
    };
    const wait = () => { if (fs.existsSync(${JSON.stringify(holdFlag)})) setTimeout(wait, 20); else finish(); };
    wait();
  `);
  saveLiveSecret(prepareLiveSecret(name, { program: process.execPath, args: [js], env: [] }));
  if (opts.policy || opts.members) credentialUpdate(name, { ...(opts.policy ? { network_policy: opts.policy } : {}), ...(opts.members ? { members: opts.members } : {}) });
  return { name, runs: () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').length : 0), failFlag, holdFlag };
}

function staticSecret(label: string, opts: { policy?: 'allow' | 'deny'; members?: string[]; ttl?: number } = {}): string {
  const name = `${label}_${RUN}`;
  names.push(name);
  credentialSet(name, STATIC_CANARY, true, opts.policy ?? 'allow', opts.members ?? '*', opts.ttl);
  return name;
}

/** A record as an older install wrote it: the policy no longer exists, so no API can set it. */
function storeRemovedConfirm(name: string): void {
  const file = path.join(credentialDataDir(), 'credentials.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.credentials[name].network_policy = 'confirm';
  fs.writeFileSync(file, JSON.stringify(stored));
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

function loggedText(): string {
  const logFile = getActiveLogFile();
  return logFile && fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
}

function expectNoValue(...texts: string[]): void {
  for (const text of [...texts, loggedText()]) {
    expect(text).not.toContain(TOKEN_CANARY);
    expect(text).not.toContain(STATIC_CANARY);
    expect(text).not.toContain(BOUND_CANARY);
    expect(text).not.toContain(HANDLER_TEXT);
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-auth-'));
  names = [];
  calls = [];
  delivered = [];
  backupAndResetRegistry();
  local = makeTestLocalAgent({ friendlyName: `prov-local-${RUN}`, workFolder: tmp });
  remote = makeTestAgent({ friendlyName: `prov-remote-${RUN}`, host: 'old.example.test' });
  addAgent(local);
  addAgent(remote);
  resetLiveTokenCache();
  stub = {
    kb: {
      parse: (input) => {
        calls.push('parse');
        return { remote: input.remote };
      },
      prepare: async () => { calls.push('prepare'); },
      deliver: async ({ member, value, expiresAt, params }) => {
        calls.push('deliver');
        delivered.push({ value, expiresAt, agentType: member.agentType, host: member.host, params });
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
    expect(delivered).toEqual([{ value: tokenOf(1), expiresAt: expiryOf(1), agentType: 'remote', host: 'old.example.test', params: { remote: REMOTE } }]);
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

describe('provisionAuthForKind: policy, the same for a remote and a local member', () => {
  for (const which of ['remote', 'local'] as const) {
    const member = () => (which === 'remote' ? remote : local);

    it(`${which}: a live secret not shared with the member is refused before any mint or handler step`, async () => {
      const s = live(`livenotshared${which}`, { members: 'someone-else' });
      const err = await failure(provision(s.name, {}, stub, member()));
      expectRefused(err, 'member-not-allowed');
      expect(err.message).toContain(member().friendlyName);
      expect(s.runs()).toBe(0);
      expect(calls).toEqual(['parse']);
    });

    it(`${which}: a static secret not shared with the member is refused`, async () => {
      const name = staticSecret(`staticnotshared${which}`, { members: ['someone-else'] });
      expectRefused(await failure(provision(name, {}, stub, member())), 'member-not-allowed');
      expect(delivered).toEqual([]);
    });

    it(`${which}: deny refuses a live secret before any mint or handler step`, async () => {
      const s = live(`livedeny${which}`, { policy: 'deny' });
      expectRefused(await failure(provision(s.name, {}, stub, member())), 'policy-deny');
      expect(s.runs()).toBe(0);
      expect(calls).toEqual(['parse']);
    });

    it(`${which}: deny refuses a static secret`, async () => {
      const name = staticSecret(`staticdeny${which}`, { policy: 'deny' });
      expectRefused(await failure(provision(name, {}, stub, member())), 'policy-deny');
      expect(delivered).toEqual([]);
    });

    it(`${which}: a listed member is served, by friendly name`, async () => {
      const s = live(`liveshared${which}`, { members: member().friendlyName });
      await provision(s.name, {}, stub, member());
      expect(delivered[0].value).toBe(tokenOf(1));
      const name = staticSecret(`staticshared${which}`, { members: [member().friendlyName] });
      await provision(name, {}, stub, member());
      expect(delivered[1].value).toBe(STATIC_CANARY);
    }, 30_000);

    it(`${which}: a record stored with the removed confirm policy acts as allow`, async () => {
      const s = live(`liveconfirm${which}`);
      storeRemovedConfirm(s.name);
      await provision(s.name, {}, stub, member());
      expect(delivered[0].value).toBe(tokenOf(1));
      const name = staticSecret(`staticconfirm${which}`);
      storeRemovedConfirm(name);
      await provision(name, {}, stub, member());
      expect(delivered[1].value).toBe(STATIC_CANARY);
    }, 30_000);
  }
});

describe('provisionAuthForKind: prepare', () => {
  it('runs after the policy checks and before the mint and deliver', async () => {
    const s = live('prepareorder');
    stub.kb.prepare = async () => {
      expect(s.runs()).toBe(0);
      calls.push('prepare');
    };
    await provision(s.name);
    expect(calls).toEqual(['parse', 'prepare', 'deliver']);
  }, 30_000);

  it('a failing prepare runs no script and delivers nothing', async () => {
    const s = live('prepfail');
    stub.kb.prepare = async () => { throw new ProvisionHandlerError('not-available'); };
    expectRefused(await failure(provision(s.name)), 'not-available');
    expect(s.runs()).toBe(0);
    expect(delivered).toEqual([]);
  });

  it('deliver gets the member as registered after prepare: a started cloud member has a new host', async () => {
    const s = live('freshmember');
    stub.kb.prepare = async ({ member }) => { updateAgent(member.id, { host: 'new.example.test' }); };
    await provision(s.name);
    expect(delivered[0].host).toBe('new.example.test');
    expect(getAgent(remote.id)?.host).toBe('new.example.test');
  }, 30_000);

  it('a member removed during prepare is refused, with no mint', async () => {
    const s = live('membergone');
    const gone = makeTestAgent({ friendlyName: `prov-gone-${RUN}` });
    addAgent(gone);
    stub.kb.prepare = async () => {
      const { removeAgent } = await import('../src/services/registry.js');
      removeAgent(gone.id);
    };
    expectRefused(await failure(provision(s.name, {}, stub, gone)), 'member-not-found');
    expect(s.runs()).toBe(0);
  });

  it('a secret deleted during prepare is refused, with no mint', async () => {
    const s = live('deletedduring');
    stub.kb.prepare = async () => { credentialDelete(s.name); };
    expectRefused(await failure(provision(s.name)), 'secret-not-found');
    expect(s.runs()).toBe(0);
  });

  it('deny set during prepare is seen, with no mint', async () => {
    const s = live('denyduring');
    stub.kb.prepare = async () => { credentialUpdate(s.name, { network_policy: 'deny' }); };
    expectRefused(await failure(provision(s.name)), 'policy-deny');
    expect(s.runs()).toBe(0);
    const name = staticSecret('denyduringstatic');
    stub.kb.prepare = async () => { credentialUpdate(name, { network_policy: 'deny' }); };
    expectRefused(await failure(provision(name)), 'policy-deny');
    expect(delivered).toEqual([]);
  });

  it('a member unshared during prepare is seen, with no mint', async () => {
    const s = live('unshareduring');
    stub.kb.prepare = async () => { credentialUpdate(s.name, { members: 'someone-else' }); };
    expectRefused(await failure(provision(s.name)), 'member-not-allowed');
    expect(s.runs()).toBe(0);
  });

  it('a value rotated during prepare is the one delivered', async () => {
    const name = staticSecret('rotateduring');
    stub.kb.prepare = async () => { credentialSet(name, `${STATIC_CANARY}-rotated`, true, 'allow'); };
    await provision(name);
    expect(delivered[0].value).toBe(`${STATIC_CANARY}-rotated`);
  });

  it('a refused rejected call during prepare leaves the cached token', async () => {
    const s = live('denyduringrejected');
    await provision(s.name);
    stub.kb.prepare = async () => { credentialUpdate(s.name, { network_policy: 'deny' }); };
    expectRefused(await failure(provision(s.name, { reason: 'rejected' })), 'policy-deny');
    credentialUpdate(s.name, { network_policy: 'allow' });
    stub.kb.prepare = undefined;
    await provision(s.name);
    expect(s.runs()).toBe(1);
  }, 30_000);
});

describe('provisionAuthForKind: reason rejected', () => {
  it('always drops the cached token and mints, and delivers the new one with its own expiry', async () => {
    const s = live('rejdrop');
    await provision(s.name);
    const result = await provision(s.name, { reason: 'rejected' });
    expect(s.runs()).toBe(2);
    expect(delivered[1].value).toBe(tokenOf(2));
    expect(result.expiresAt).toBe(expiryOf(2));
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

  it('a static secret has no cached token: the value is delivered, and the handler\'s verification reports the rest', async () => {
    const name = staticSecret('rejstatic');
    await provision(name, { reason: 'rejected' });
    expect(delivered[0].value).toBe(STATIC_CANARY);
  });

  it('an unknown reason is refused before any mint; a removed time field is simply not read', async () => {
    const s = live('rejbad');
    expectRefused(await failure(provision(s.name, { reason: 'other' })), 'bad-input');
    expect(s.runs()).toBe(0);
    await provision(s.name);
    await provision(s.name, { reason: 'rejected', rejected_at: '2000-01-01T00:00:00Z' });
    expect(s.runs()).toBe(2);
  }, 30_000);
});

describe('live secret cache: a drop against a mint in flight, and token and expiry pairing', () => {
  /** A cached token 1 that is due for refresh, with a refresh about to start. */
  async function dueForRefresh(s: LiveFixture, realNow: number) {
    const rec = lookupLiveSecret(s.name)!;
    expect((await getLiveTokenDetail(s.name, rec)).token).toBe(tokenOf(1));
    vi.spyOn(Date, 'now').mockImplementation(() => realNow + 3_590_000);
    return rec;
  }

  it('a drop during a refresh does not start a second run, and a failed refresh does not bring the old token back', async () => {
    const s = live('inflightfail', { lifetimeMs: 3_600_000 });
    const rec = await dueForRefresh(s, Date.now());
    fs.writeFileSync(s.holdFlag, '');
    fs.writeFileSync(s.failFlag, '');
    const first = getLiveTokenDetail(s.name, rec);
    expect(dropCachedLiveToken(s.name)).toBe(true);
    const second = getLiveTokenDetail(s.name, rec);
    fs.rmSync(s.holdFlag);
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    expect(s.runs()).toBe(2);
  }, 30_000);

  it('a drop during a refresh keeps the new token when the refresh works', async () => {
    const s = live('inflightok', { lifetimeMs: 3_600_000 });
    const rec = await dueForRefresh(s, Date.now());
    fs.writeFileSync(s.holdFlag, '');
    const first = getLiveTokenDetail(s.name, rec);
    dropCachedLiveToken(s.name);
    const second = getLiveTokenDetail(s.name, rec);
    fs.rmSync(s.holdFlag);
    expect((await first).token).toBe(tokenOf(2));
    expect((await second).token).toBe(tokenOf(2));
    expect(s.runs()).toBe(2);
  }, 30_000);

  it('a drop does not reset backoff: inside it no script runs, and the call fails', async () => {
    const s = live('dropbackoff', { lifetimeMs: 3_600_000 });
    const rec = await dueForRefresh(s, Date.now());
    fs.writeFileSync(s.failFlag, '');
    const served = await getLiveTokenDetail(s.name, rec); // the refresh fails; token 1 is still valid
    expect(served.token).toBe(tokenOf(1));
    expect(s.runs()).toBe(2);
    expect(dropCachedLiveToken(s.name)).toBe(true);
    await expect(getLiveTokenDetail(s.name, rec)).rejects.toThrow();
    expect(s.runs()).toBe(2);
    expect(getLiveTokenStatus(s.name, rec).retryAfter).not.toBeNull();
  }, 30_000);

  it('a token served during a failed refresh and during backoff keeps its own expiry', async () => {
    const s = live('backoffexpiry', { lifetimeMs: 3_600_000 });
    const rec = lookupLiveSecret(s.name)!;
    const realNow = Date.now();
    const minted = await getLiveTokenDetail(s.name, rec);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow + 3_590_000);
    fs.writeFileSync(s.failFlag, '');
    const duringFailure = await getLiveTokenDetail(s.name, rec);
    const duringBackoff = await getLiveTokenDetail(s.name, rec);
    expect(duringFailure).toEqual(minted);
    expect(duringBackoff).toEqual(minted);
    expect(s.runs()).toBe(2);
  }, 30_000);

  it('concurrent callers each get a token with that same mint\'s expiry, across a replacement', async () => {
    const s = live('pairs');
    const rec = lookupLiveSecret(s.name)!;
    fs.writeFileSync(s.holdFlag, '');
    const firstMint = Array.from({ length: 6 }, () => getLiveTokenDetail(s.name, rec));
    fs.rmSync(s.holdFlag);
    const firstDone = firstMint[0];
    await firstDone;
    // The first mint's waiters read their results after the token was replaced.
    dropCachedLiveToken(s.name);
    const secondMint = Array.from({ length: 6 }, () => getLiveTokenDetail(s.name, rec));
    const all = await Promise.all([...firstMint, ...secondMint]);
    expect(s.runs()).toBe(2);
    expect(all.map((d) => d.expiresAt)).toEqual([...Array(6).fill(expiryOf(1)), ...Array(6).fill(expiryOf(2))]);
    expect(all.map((d) => d.token)).toEqual([...Array(6).fill(tokenOf(1)), ...Array(6).fill(tokenOf(2))]);
  }, 30_000);
});

describe('provisionAuthForKind: no handler text or value in the result, errors or log', () => {
  const forms = (value: string): string[] => [
    value,
    Buffer.from(value).toString('base64'),
    Buffer.from(value, 'utf16le').toString('base64'),
    encodeURIComponent(value),
    value.slice(0, 16),
    HANDLER_TEXT,
  ];

  it('a verification detail or an unknown reason from a handler does not reach the result', async () => {
    const s = live('leakdetail');
    stub.kb.deliver = async ({ value }) => ({ status: 'failed', reason: `${HANDLER_TEXT} ${value}`, detail: `${HANDLER_TEXT} ${value}` }) as never;
    const result = await provision(s.name);
    expect(result.verification).toEqual({ status: 'failed', reason: 'unverified', detail: 'the value could not be verified' });
    expectNoValue(JSON.stringify(result));
  }, 30_000);

  it('a known verification reason gets its fixed text, and an extra detail is dropped', async () => {
    const name = staticSecret('fixeddetail');
    stub.kb.deliver = async () => ({ status: 'failed', reason: 'rejected', detail: HANDLER_TEXT }) as never;
    const result = await provision(name);
    expect(result.verification).toEqual({ status: 'failed', reason: 'rejected', detail: 'the receiving server refused the value' });
    expect(loggedText()).toContain(`secret=\\"${name}\\" expires=none verification=failed: rejected`);
    expectNoValue(JSON.stringify(result));
  });

  it('a typed ProvisionAuthError from a handler keeps no text, in any encoding of the value', async () => {
    const name = staticSecret('leaktyped');
    stub.kb.deliver = async ({ value }) => {
      throw new ProvisionAuthError('policy-deny', forms(value).join(' '));
    };
    const err = await failure(provision(name));
    expectRefused(err, 'delivery-failed');
    for (const form of forms(STATIC_CANARY)) {
      expect(err.message).not.toContain(form);
      expect(String(err.stack)).not.toContain(form);
      expect(loggedText()).not.toContain(form);
    }
  });

  it('a handler reason carries no text: a known one gets its fixed text, an unknown one is delivery-failed', async () => {
    const name = staticSecret('reasononly');
    stub.kb.deliver = async () => { throw new ProvisionHandlerError('not-available'); };
    const known = await failure(provision(name));
    expectRefused(known, 'not-available');
    expect(known.message).toContain('this kind cannot deliver to a member yet');
    stub.kb.deliver = async ({ value }) => { throw new ProvisionHandlerError(`${HANDLER_TEXT} ${value}` as never); };
    const unknown = await failure(provision(name));
    expectRefused(unknown, 'delivery-failed');
    expectNoValue(unknown.message);
  });

  it('any other handler error loses its text, from parse, prepare and deliver', async () => {
    const name = staticSecret('leakplain');
    stub.kb.deliver = async ({ value }) => { throw new Error(`stderr: ${value} ${HANDLER_TEXT}`); };
    const fromDeliver = await failure(provision(name));
    expectRefused(fromDeliver, 'delivery-failed');
    expect(fromDeliver.message).toContain(name);
    expectNoValue(fromDeliver.message, String(fromDeliver.stack));
    stub.kb.prepare = async () => { throw new Error(HANDLER_TEXT); };
    expectNoValue((await failure(provision(name))).message);
    stub.kb.parse = () => { throw new Error(HANDLER_TEXT); };
    expectNoValue((await failure(provision(name))).message);
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
    const logged = loggedText();
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

  it('kb applies policy first: deny is refused before the kind checks the member', async () => {
    const s = live('kbdeny', { policy: 'deny' });
    expectRefused(await failure(provisionAuthForKind({ kind: 'kb', member_id: local.id, secret: s.name, remote: REMOTE })), 'policy-deny');
  });
});
