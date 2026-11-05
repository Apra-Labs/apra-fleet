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
  getLiveToken,
  getLiveTokenStatus,
  liveRefreshAt,
  mintLiveSecret,
  resetLiveTokenCache,
} from '../src/services/live-secret-cache.js';
import { LiveSecretError } from '../src/services/live-secret-runner.js';
import { _resetCache, getLiveSecretRefreshConfig } from '../src/services/user-config.js';
import { credentialStoreDelete } from '../src/tools/credential-store-delete.js';
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

/** True while the persistent record of this name in credentials.json is still expired. */
function persistentStillExpired(n: string): boolean {
  const file = JSON.parse(fs.readFileSync(path.join(process.env.APRA_FLEET_DATA_DIR ?? FLEET_DIR, 'credentials.json'), 'utf-8'));
  return Date.parse(file.credentials[n].expiresAt) < Date.now();
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

  it('an expired UNBOUND persistent secret also survives credentialResolve, until the startup purge', () => {
    const r = name('unbound');
    credentialSet(r, 'v', true, 'allow', '*', -1);
    expect(credentialResolve(r, '*')).toHaveProperty('expired');
    expect(credentialList().some((c) => c.name === r)).toBe(true);
    purgeExpiredCredentials();
    expect(credentialList().some((c) => c.name === r)).toBe(false);
    expect(credentialResolve(r, '*')).toBeNull();
  });

  it('a session value set after expiry resolves, for the member path and the KB path, and survives the purge', () => {
    const r = name('resetsession');
    credentialSet(r, 'old-value', true, 'allow', '*', -1);
    expect(credentialResolve(r, '*')).toHaveProperty('expired');

    credentialSet(r, 'fresh-value', false, 'allow'); // the default of credential_store_set

    const out = credentialResolve(r, '*') as { plaintext: string; meta: { scope: string } };
    expect(out.plaintext).toBe('fresh-value');
    expect(out.meta.scope).toBe('session');
    const kb = lookupServerSecret(r) as { status: string; value: string };
    expect(kb.status).toBe('ok');
    expect(kb.value).toBe('fresh-value');

    purgeExpiredCredentials();
    expect((credentialResolve(r, '*') as { plaintext: string }).plaintext).toBe('fresh-value');
  });

  it('an unexpired persistent record still wins over a session value', () => {
    const r = name('stillwins');
    credentialSet(r, 'persistent-value', true, 'allow');
    credentialSet(r, 'session-value', false, 'allow');
    expect((credentialResolve(r, '*') as { plaintext: string }).plaintext).toBe('persistent-value');
  });

  it('an expired session value over an expired persistent record reports expired', () => {
    const r = name('bothexpired');
    credentialSet(r, 'old-value', true, 'allow', '*', -1);
    credentialSet(r, 'also-old', false, 'allow', '*', -1);
    expect(credentialResolve(r, '*')).toHaveProperty('expired');
  });

  it('with a session value over an expired bound record, the record stays and a run still uses it', async () => {
    const { r, n } = bound(-1);
    credentialSet(r, 'session-value', false, 'allow');
    expect((credentialResolve(r, '*') as { plaintext: string }).plaintext).toBe('session-value');

    purgeExpiredCredentials();
    expect(() => credentialDelete(r)).toThrow(SecretInUseError);
    expect(credentialList().some((c) => c.name === r && c.scope === 'persistent')).toBe(true);
    await expect(mintLiveSecret(lookupLiveSecret(n)!)).resolves.toBeDefined();
  });

  it('credential_store_update refuses an expired secret and does not bring the old value back', async () => {
    const r = name('norevive');
    credentialSet(r, 'old-value', true, 'allow', '*', -1);

    for (const patch of [{ ttl_seconds: 3600 }, { ttl_seconds: 0 }, { members: 'a' }, { network_policy: 'deny' as const }]) {
      const out = await credentialStoreUpdate({ name: r, ...patch });
      expect(out).toContain('has expired');
      expect(out).not.toContain('updated');
    }
    expect(credentialResolve(r, '*')).toHaveProperty('expired');
    expect(credentialList().find((c) => c.name === r)?.allowedMembers).toBe('*');
  });

  it('credential_store_update over an expired record with a session value changes the session value only', async () => {
    const r = name('updsession');
    credentialSet(r, 'old-value', true, 'allow', '*', -1);
    credentialSet(r, 'fresh-value', false, 'allow');

    const out = await credentialStoreUpdate({ name: r, ttl_seconds: 3600 });

    expect(out).toContain('updated');
    expect((credentialResolve(r, '*') as { plaintext: string; meta: { scope: string } }).meta.scope).toBe('session');
    expect(persistentStillExpired(r)).toBe(true);
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
