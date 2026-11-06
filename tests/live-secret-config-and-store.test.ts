/**
 * In-process rules: T from config.json (including invalid values), the shared
 * mint and backoff, and every path listed under "Bindings are permanent" that
 * does not need the CLI.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FLEET_DIR } from '../src/paths.js';
import {
  BoundSecretError,
  credentialDelete,
  credentialList,
  credentialResolve,
  credentialSet,
  credentialUpdate,
  isLiveSecret,
  LiveRegistrationError,
  lookupLiveSecret,
  lookupServerSecret,
  prepareLiveSecret,
  purgeExpiredCredentials,
  saveLiveSecret,
  SecretInUseError,
} from '../src/services/credential-store.js';
import {
  dropLiveToken,
  getLiveToken,
  getLiveTokenStatus,
  liveRefreshAt,
  mintLiveSecret,
  resetLiveTokenCache,
} from '../src/services/live-secret-cache.js';
import { LiveSecretError } from '../src/services/live-secret-runner.js';
import { _resetCache, getLiveSecretRefreshConfig } from '../src/services/user-config.js';
import { credentialStoreDelete } from '../src/tools/credential-store-delete.js';
import { credentialStoreSet } from '../src/tools/credential-store-set.js';
import { credentialStoreUpdate } from '../src/tools/credential-store-update.js';
import { closeLogFile, getActiveLogFile } from '../src/utils/log-helpers.js';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const CONFIG_PATH = path.join(FLEET_DIR, 'config.json');
const VALUE_CANARY = `bound-STORE-CANARY-${RUN}`;

let tmp: string;
let created: string[];
let savedConfig: string | null;

function name(label: string): string {
  const n = `${label}_${RUN}`;
  created.push(n);
  return n;
}

/** A node script printing a token whose lifetime and text come from the given values. */
function liveScript(label: string, opts: { lifetimeMs?: number; fail?: boolean; delayMs?: number } = {}): { program: string; args: string[]; env: [] ; runs: () => number } {
  const counter = path.join(tmp, `${label}.runs`);
  const js = path.join(tmp, `${label}.js`);
  fs.writeFileSync(js, `
    const fs = require('fs');
    fs.appendFileSync(${JSON.stringify(counter)}, 'x');
    const n = fs.readFileSync(${JSON.stringify(counter)}, 'utf8').length;
    if (${opts.fail === true}) process.exit(4);
    setTimeout(() => process.stdout.write(JSON.stringify({
      token: 'tok-' + n, expires_at: new Date(Date.now() + ${opts.lifetimeMs ?? 3_600_000}).toISOString(),
    })), ${opts.delayMs ?? 0});
  `);
  return {
    program: process.execPath, args: [js], env: [],
    runs: () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').length : 0),
  };
}

function register(n: string, script: { program: string; args: string[] }, env: Array<{ env: string; value: string }> = []) {
  const record = prepareLiveSecret(n, { program: script.program, args: script.args, env });
  saveLiveSecret(record);
  return record;
}

function writeConfig(content: unknown): void {
  fs.mkdirSync(FLEET_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, typeof content === 'string' ? content : JSON.stringify(content));
  _resetCache();
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-store-'));
  created = [];
  savedConfig = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf-8') : null;
  fs.rmSync(CONFIG_PATH, { force: true });
  _resetCache();
  resetLiveTokenCache();
});

afterEach(() => {
  for (const n of created.filter(isLiveSecret)) credentialDelete(n);
  for (const n of created) {
    try { credentialDelete(n); } catch { /* already removed */ }
  }
  if (savedConfig === null) fs.rmSync(CONFIG_PATH, { force: true });
  else fs.writeFileSync(CONFIG_PATH, savedConfig);
  _resetCache();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('T from config.json', () => {
  it('defaults to min(0.10 x lifetime, 600 s) with no config.json', () => {
    expect(getLiveSecretRefreshConfig()).toEqual({ refreshFraction: 0.1, refreshMaxSeconds: 600 });
    expect(liveRefreshAt(0, 1000 * 1000)).toBe(900 * 1000); // 10% of 1000 s
    expect(liveRefreshAt(0, 20_000 * 1000)).toBe(19_400 * 1000); // capped at 600 s
  });

  it('takes both values from liveSecrets.*', () => {
    writeConfig({ liveSecrets: { refreshFraction: 0.5, refreshMaxSeconds: 30 } });
    expect(getLiveSecretRefreshConfig()).toEqual({ refreshFraction: 0.5, refreshMaxSeconds: 30 });
    expect(liveRefreshAt(0, 40 * 1000)).toBe(20 * 1000); // 50% of 40 s
    expect(liveRefreshAt(0, 1000 * 1000)).toBe(970 * 1000); // capped at 30 s
  });

  const BAD_FRACTIONS: unknown[] = [0, -0.1, 1, 1.5, '0.2', null, [], {}, true];
  for (const bad of BAD_FRACTIONS) {
    it(`an invalid refreshFraction ${JSON.stringify(bad)} logs and uses the default, and keeps a valid sibling`, () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      writeConfig({ liveSecrets: { refreshFraction: bad, refreshMaxSeconds: 30 } });
      expect(getLiveSecretRefreshConfig()).toEqual({ refreshFraction: 0.1, refreshMaxSeconds: 30 });
      expect(err.mock.calls.flat().join(' ')).toContain('liveSecrets.refreshFraction');
    });
  }

  const BAD_MAX: unknown[] = [0, -5, '600', null, [], {}, false];
  for (const bad of BAD_MAX) {
    it(`an invalid refreshMaxSeconds ${JSON.stringify(bad)} logs and uses the default, and keeps a valid sibling`, () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      writeConfig({ liveSecrets: { refreshFraction: 0.2, refreshMaxSeconds: bad } });
      expect(getLiveSecretRefreshConfig()).toEqual({ refreshFraction: 0.2, refreshMaxSeconds: 600 });
      expect(err.mock.calls.flat().join(' ')).toContain('liveSecrets.refreshMaxSeconds');
    });
  }

  it('a non-object liveSecrets logs and uses the defaults', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const bad of [[], 'x', 3]) {
      writeConfig({ liveSecrets: bad });
      expect(getLiveSecretRefreshConfig()).toEqual({ refreshFraction: 0.1, refreshMaxSeconds: 600 });
    }
    expect(err.mock.calls.flat().join(' ')).toContain('liveSecrets must be an object');
  });

  it('malformed config.json falls back to the defaults', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeConfig('{ not json');
    expect(getLiveSecretRefreshConfig()).toEqual({ refreshFraction: 0.1, refreshMaxSeconds: 600 });
  });

  it('T from config decides reuse versus a new mint on access', async () => {
    // Above T: reuse. A 90% fraction puts a 4 s token below T almost at once.
    const n = name('T');
    const script = liveScript('t', { lifetimeMs: 4_000 });
    register(n, script);
    await getLiveToken(n, lookupLiveSecret(n)!);
    await getLiveToken(n, lookupLiveSecret(n)!);
    expect(script.runs()).toBe(1);

    writeConfig({ liveSecrets: { refreshFraction: 0.9 } });
    resetLiveTokenCache();
    const m = name('T2');
    const eager = liveScript('t2', { lifetimeMs: 4_000 });
    register(m, eager);
    await getLiveToken(m, lookupLiveSecret(m)!);
    await new Promise((r) => setTimeout(r, 900));
    await getLiveToken(m, lookupLiveSecret(m)!);
    expect(eager.runs()).toBe(2);
  }, 30_000);
});

describe('cache', () => {
  it('concurrent callers share one mint', async () => {
    const n = name('shared');
    const script = liveScript('shared', { delayMs: 300 });
    const rec = register(n, script);
    const tokens = await Promise.all(Array.from({ length: 8 }, () => getLiveToken(n, rec)));
    expect(new Set(tokens)).toEqual(new Set(['tok-1']));
    expect(script.runs()).toBe(1);
  });

  it('a failure is typed, names the secret, backs off and shows in status', async () => {
    const n = name('fail');
    const script = liveScript('fail', { fail: true });
    const rec = register(n, script);
    const first = await getLiveToken(n, rec).catch((e) => e);
    expect(first).toBeInstanceOf(LiveSecretError);
    expect(first.code).toBe('E-LIVE-SECRET');
    expect(first.reasonCode).toBe('exit-nonzero');
    expect(first.exitCode).toBe(4);
    expect(first.message).toContain(`'${n}'`);

    const second = await getLiveToken(n, rec).catch((e) => e);
    expect(second.reasonCode).toBe('backoff');
    expect(script.runs()).toBe(1);

    const status = getLiveTokenStatus(n, rec);
    expect(status.state).toBe('failed');
    expect(status.lastFailureReason).toBe('exit code 4');
    expect(status.retryAfter).not.toBeNull();
  });

  it('a failed refresh still serves the unexpired token, then inside the backoff too, with no further run', async () => {
    writeConfig({ liveSecrets: { refreshFraction: 0.9 } });
    const failFlag = path.join(tmp, 'refresh.fail');
    const counter = path.join(tmp, 'refresh.runs');
    const js = path.join(tmp, 'refresh.js');
    fs.writeFileSync(js, `
      const fs = require('fs');
      fs.appendFileSync(${JSON.stringify(counter)}, 'x');
      if (fs.existsSync(${JSON.stringify(failFlag)})) process.exit(4);
      process.stdout.write(JSON.stringify({ token: 'tok-first', expires_at: new Date(Date.now() + 60000).toISOString() }));
    `);
    const n = name('refreshfail');
    const rec = register(n, { program: process.execPath, args: [js] });
    expect(await getLiveToken(n, rec)).toBe('tok-first');

    // 90% of a 60 s lifetime: below T after about 6 s. Move the clock instead of waiting.
    fs.writeFileSync(failFlag, '');
    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => realNow + 10_000);

    expect(await getLiveToken(n, rec)).toBe('tok-first'); // the refresh ran and failed
    expect(fs.readFileSync(counter, 'utf8')).toBe('xx');
    expect(await getLiveToken(n, rec)).toBe('tok-first'); // inside the backoff: no run
    expect(fs.readFileSync(counter, 'utf8')).toBe('xx');
    expect(getLiveTokenStatus(n, rec).state).toBe('failed');
  }, 30_000);

  it('dropping a token other than the cached one keeps the cached one; dropping the cached one mints', async () => {
    const n = name('droprule');
    const script = liveScript('droprule');
    const rec = register(n, script);
    expect(await getLiveToken(n, rec)).toBe('tok-1');

    dropLiveToken(n, 'tok-an-older-one'); // a concurrent 401 on a token already replaced
    expect(await getLiveToken(n, rec)).toBe('tok-1');
    expect(script.runs()).toBe(1);

    dropLiveToken(n, 'tok-1');
    expect(await getLiveToken(n, rec)).toBe('tok-2');
    expect(script.runs()).toBe(2);
  });

  it('a cached token stays cached when the bound value or the policy changes', async () => {
    const r = name('rot');
    const n = name('rotlive');
    credentialSet(r, VALUE_CANARY, true, 'allow');
    const script = liveScript('rot');
    register(n, script, [{ env: 'X', value: `{{secret.${r}}}` }]);
    await getLiveToken(n, lookupLiveSecret(n)!);

    credentialSet(r, 'rotated', true, 'allow');
    credentialUpdate(n, { network_policy: 'deny' });
    expect(await getLiveToken(n, lookupLiveSecret(n)!)).toBe('tok-1');
    expect(script.runs()).toBe(1);
  });
});

describe('bindings are permanent', () => {
  function bound(expiresInSeconds?: number): { r: string; n: string; script: ReturnType<typeof liveScript> } {
    const r = name('bound');
    const n = name('consumer');
    credentialSet(r, VALUE_CANARY, true, 'allow', '*', expiresInSeconds);
    const script = liveScript(n);
    register(n, script, [{ env: 'BOUND_VALUE', value: `{{secret.${r}}}` }]);
    return { r, n, script };
  }

  it('credentialDelete throws SecretInUseError and deletes nothing, and works once the consumer is gone', () => {
    const { r, n } = bound();
    let caught: unknown;
    try { credentialDelete(r); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(SecretInUseError);
    expect((caught as Error).message).toBe(`secret is in use by: ${n}`);
    expect(lookupServerSecret(r).status).toBe('ok');

    expect(credentialDelete(n)).toBe(true);
    expect(credentialDelete(r)).toBe(true);
  });

  it('credential_store_delete surfaces the refusal', async () => {
    const { r, n } = bound();
    const out = await credentialStoreDelete({ name: r });
    expect(out).toContain(`secret is in use by: ${n}`);
    expect(lookupServerSecret(r).status).toBe('ok');
  });

  it('registering a live secret over a bound name is refused in prepare and in save', () => {
    const { r, n } = bound();
    const script = liveScript('over');
    expect(() => prepareLiveSecret(r, { program: script.program, args: script.args, env: [] })).toThrow(`secret is in use by: ${n}`);
    // A bound name that appeared after prepare is caught at save.
    const free = name('free');
    const record = prepareLiveSecret(free, { program: script.program, args: script.args, env: [] });
    credentialSet(free, 'v', true, 'allow');
    register(name('late'), script, [{ env: 'X', value: `{{secret.${free}}}` }]);
    expect(() => saveLiveSecret(record)).toThrow(LiveRegistrationError);
  });

  it('save re-checks that a bound secret still exists', () => {
    const r = name('vanishing');
    credentialSet(r, 'v', true, 'allow');
    const script = liveScript('vanish');
    const record = prepareLiveSecret(name('needs'), { program: script.program, args: script.args, env: [{ env: 'X', value: `{{secret.${r}}}` }] });
    credentialDelete(r);
    expect(() => saveLiveSecret(record)).toThrow(/does not exist/);
  });

  it('an expired bound secret survives credentialResolve, which reports expired', () => {
    const { r } = bound(-1);
    const out = credentialResolve(r, '*');
    expect(out).toHaveProperty('expired');
    expect(credentialList().some((c) => c.name === r)).toBe(true);
    expect(credentialResolve(r, '*')).toHaveProperty('expired'); // still there, still expired
  });

  it('a bound name cannot have a session value, in the store and in the tool, and --persist still works', async () => {
    const { r, n } = bound();
    expect(() => credentialSet(r, 'session-value', false, 'allow')).toThrow(BoundSecretError);
    expect(() => credentialSet(r, 'session-value', false, 'allow')).toThrow(`in use by: ${n}`);
    expect(() => credentialSet(r, 'session-value', false, 'allow')).toThrow(/--persist/);
    expect(credentialResolve(r, '*')).toHaveProperty('plaintext', VALUE_CANARY);

    const out = await credentialStoreSet({ name: r, prompt: 'x', persist: false, network_policy: 'allow', members: '*' });
    expect(out).toContain('[FAIL]');
    expect(out).toContain('persist: true');

    credentialSet(r, 'rotated', true, 'allow');
    expect(credentialResolve(r, '*')).toHaveProperty('plaintext', 'rotated');
  });

  it('binding a name that has a session value here is refused, even with a persistent record beside it', () => {
    const r = name('hassession');
    credentialSet(r, 'persistent-value', true, 'allow');
    credentialSet(r, 'session-value', false, 'allow');
    const script = liveScript('hassession');
    let caught: unknown;
    try {
      prepareLiveSecret(name('s2'), { program: script.program, args: script.args, env: [{ env: 'X', value: `{{secret.${r}}}` }] });
    } catch (err) { caught = err; }
    expect((caught as LiveRegistrationError).reasonCode).toBe('binding-session');
    expect((caught as Error).message).toContain('--persist');
  });

  it('expired bound: the message says --persist, and credentialUpdate and the tool refuse every patch', async () => {
    const { r } = bound(-1);
    expect((credentialResolve(r, '*') as { expired: string }).expired).toContain(`apra-fleet secret --set ${r} --persist`);

    expect(() => credentialUpdate(r, { expiresAt: Date.now() + 3_600_000 })).toThrow(BoundSecretError);
    for (const patch of [{ ttl_seconds: 3600 }, { ttl_seconds: 0 }, { members: 'a' }, { network_policy: 'deny' as const }]) {
      const out = await credentialStoreUpdate({ name: r, ...patch });
      expect(out).toContain('[FAIL]');
      expect(out).toContain('--persist');
    }
    expect(credentialResolve(r, '*')).toHaveProperty('expired');
    expect(credentialList().find((c) => c.name === r)?.allowedMembers).toBe('*');
  });

  it('a valid bound secret can still be updated', () => {
    const { r } = bound();
    expect(credentialUpdate(r, { network_policy: 'deny' })).toMatchObject({ network_policy: 'deny' });
  });

  it('once its live secret is deleted, an expired secret goes back to the unbound rule', () => {
    const { r, n } = bound(-1);
    expect(credentialResolve(r, '*')).toHaveProperty('expired');
    credentialDelete(n);
    expect(credentialResolve(r, '*')).toHaveProperty('expired');
    expect(credentialResolve(r, '*')).toBeNull();
  });

  it('the startup purge skips an expired bound record and its consumer', () => {
    const { r, n } = bound(-1);
    purgeExpiredCredentials();
    expect(credentialList().some((c) => c.name === r)).toBe(true);
    expect(isLiveSecret(n)).toBe(true);
    expect(lookupServerSecret(r).status).toBe('expired');
  });

  it('a run with an expired bound secret still gets the value, and warns in the log by name only', async () => {
    const { r, n } = bound(-1);
    closeLogFile();
    const recordPath = path.join(tmp, 'delivered.txt');
    const js = path.join(tmp, 'deliver.js');
    fs.writeFileSync(js, `require('fs').writeFileSync(${JSON.stringify(recordPath)}, process.env.BOUND_VALUE);
      process.stdout.write(JSON.stringify({ token: 't', expires_at: new Date(Date.now() + 3600000).toISOString() }));`);
    credentialDelete(n);
    const rec = register(n, { program: process.execPath, args: [js] }, [{ env: 'BOUND_VALUE', value: `{{secret.${r}}}` }]);

    await mintLiveSecret(rec);

    expect(fs.readFileSync(recordPath, 'utf8')).toBe(VALUE_CANARY);
    const log = fs.readFileSync(getActiveLogFile()!, 'utf8');
    const lines = log.split('\n').filter((l) => l.includes('"live-secret"'));
    const warning = lines.find((l) => l.includes(`"${r}"`) || l.includes(`\\"${r}\\"`));
    expect(warning).toBeDefined();
    expect(warning).toContain('"level":"warn"');
    expect(warning).toContain('expired at');
    expect(log).not.toContain(VALUE_CANARY);
  });

  it('a session-tier secret cannot be bound, and the error says --persist', () => {
    const r = name('sess');
    credentialSet(r, 'v', false, 'allow');
    const script = liveScript('sess');
    let caught: unknown;
    try {
      prepareLiveSecret(name('s1'), { program: script.program, args: script.args, env: [{ env: 'X', value: `{{secret.${r}}}` }] });
    } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(LiveRegistrationError);
    expect((caught as LiveRegistrationError).reasonCode).toBe('binding-session');
    expect((caught as Error).message).toContain('--persist');
    expect((caught as Error).message).toContain(r);
  });

  it('a live secret cannot be bound, so a helper cycle cannot be built', () => {
    const a = name('a');
    const script = liveScript('a');
    register(a, script);
    let caught: unknown;
    try {
      prepareLiveSecret(name('b'), { program: script.program, args: script.args, env: [{ env: 'X', value: `{{secret.${a}}}` }] });
    } catch (err) { caught = err; }
    expect((caught as LiveRegistrationError).reasonCode).toBe('binding-live');
  });

  it('a bound secret that vanished from a hand-edited file fails the run with a typed error', async () => {
    const r = name('gone');
    credentialSet(r, 'v', true, 'allow');
    const script = liveScript('gone');
    const rec = prepareLiveSecret(name('needsgone'), { program: script.program, args: script.args, env: [{ env: 'X', value: `{{secret.${r}}}` }] });
    credentialDelete(r);
    const err = await mintLiveSecret(rec).catch((e) => e);
    expect(err).toBeInstanceOf(LiveSecretError);
    expect(err.reasonCode).toBe('bound-secret-missing');
    expect(script.runs()).toBe(0);
  });
});

describe('an unbound secret behaves as on main', () => {
  it('expired: the first resolve reports it and deletes it, the next reports not found', () => {
    const r = name('mainexpiry');
    credentialSet(r, 'old-value', true, 'allow', '*', -1);
    expect(credentialList().some((c) => c.name === r)).toBe(true);

    expect((credentialResolve(r, '*') as { expired: string }).expired).toBe(`Credential '${r}' has expired. Re-set with credential_store_set.`);

    expect(credentialList().some((c) => c.name === r)).toBe(false);
    expect(credentialResolve(r, '*')).toBeNull();
  });

  it('a session value set before the first resolve goes with the expired record', () => {
    const r = name('mainsession');
    credentialSet(r, 'old-value', true, 'deny', ['alpha'], -1);
    credentialSet(r, 'session-value', false, 'allow', '*');

    expect(credentialResolve(r, 'beta')).toHaveProperty('expired');
    expect(credentialResolve(r, 'beta')).toBeNull();
    expect(credentialList().some((c) => c.name === r)).toBe(false);
  });

  it('a session value set after that resolve is used', () => {
    const r = name('mainreset');
    credentialSet(r, 'old-value', true, 'allow', '*', -1);
    expect(credentialResolve(r, '*')).toHaveProperty('expired');

    credentialSet(r, 'fresh-value', false, 'allow');

    expect(credentialResolve(r, '*')).toMatchObject({ plaintext: 'fresh-value', meta: { scope: 'session' } });
    expect(lookupServerSecret(r)).toMatchObject({ status: 'ok', value: 'fresh-value' });
  });

  it('the KB lookup reports expired over a session value and deletes nothing', () => {
    const r = name('mainkb');
    credentialSet(r, 'old-value', true, 'allow', '*', -1);
    credentialSet(r, 'session-value', false, 'allow');
    expect(lookupServerSecret(r).status).toBe('expired');
    expect(credentialList().find((c) => c.name === r)).toMatchObject({ scope: 'persistent' });
  });

  it('the startup purge removes the record and its session value', () => {
    const r = name('mainpurge');
    credentialSet(r, 'old-value', true, 'allow', '*', -1);
    credentialSet(r, 'session-value', false, 'allow');
    purgeExpiredCredentials();
    expect(credentialResolve(r, '*')).toBeNull();
  });

  it('credential_store_update on an expired secret reports not found', async () => {
    const r = name('mainupdate');
    credentialSet(r, 'old-value', true, 'allow', '*', -1);
    expect(await credentialStoreUpdate({ name: r, ttl_seconds: 3600 })).toContain('not found');
    expect(credentialResolve(r, '*')).toBeNull();
  });

  it('credentialUpdate from a process that has not resolved it still patches the record, as on main', () => {
    const r = name('mainpatch');
    credentialSet(r, 'old-value', true, 'allow', '*', -1);
    expect(credentialUpdate(r, { network_policy: 'deny' })).toMatchObject({ network_policy: 'deny' });
  });

  it('an unexpired persistent record wins over a session value', () => {
    const r = name('mainwins');
    credentialSet(r, 'persistent-value', true, 'allow');
    credentialSet(r, 'session-value', false, 'allow');
    expect(credentialResolve(r, '*')).toHaveProperty('plaintext', 'persistent-value');
  });
});

describe('policy fields', () => {
  it('a new live secret has the defaults of secret --set --persist, and list shows them with kind live', () => {
    const n = name('defaults');
    register(n, liveScript('defaults'));
    expect(lookupLiveSecret(n)).toMatchObject({ network_policy: 'allow', allowedMembers: '*' });
    const meta = credentialList().find((c) => c.name === n);
    expect(meta).toMatchObject({ kind: 'live', scope: 'persistent', network_policy: 'allow', allowedMembers: '*' });
    expect(meta?.expiresAt).toBeUndefined();
  });

  it('credentialUpdate changes members and policy, ignores an expiry, and keeps the script', () => {
    const n = name('upd');
    const rec = register(n, liveScript('upd'));
    expect(credentialUpdate(n, { members: 'a, b', network_policy: 'deny', expiresAt: 5 })).toEqual({ members: 'a,b', network_policy: 'deny' });
    const after = lookupLiveSecret(n);
    expect(after).toMatchObject({ allowedMembers: ['a', 'b'], network_policy: 'deny', program: rec.program, args: rec.args, created_at: rec.created_at });
    expect(after).not.toHaveProperty('expiresAt');
  });
});
