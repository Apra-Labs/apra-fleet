/**
 * {{secret.NAME}} of a live secret on a member command, and the fleet_status
 * list. A local member runs the real command through the real shell, so
 * redaction and the mint are the production path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  credentialDelete,
  credentialSet,
  credentialUpdate,
  isLiveSecret,
  prepareLiveSecret,
  saveLiveSecret,
} from '../src/services/credential-store.js';
import { resetLiveTokenCache } from '../src/services/live-secret-cache.js';
import { executeCommand } from '../src/tools/execute-command.js';
import { fleetStatus, liveSecretsCompactLines, liveSecretsHealth } from '../src/tools/check-status.js';
import { addAgent } from '../src/services/registry.js';
import { provisionVcsAuth } from '../src/tools/provision-vcs-auth.js';
import { backupAndResetRegistry, makeTestLocalAgent, restoreRegistry, resultText } from './test-helpers.js';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const TOKEN_CANARY = `tok-EXEC-CANARY-${RUN}`;
const VALUE_CANARY = `bound-EXEC-CANARY-${RUN}`;

let tmp: string;
let names: string[];
let member: ReturnType<typeof makeTestLocalAgent>;

function mintJs(label: string, body: string = ''): { program: string; args: string[]; runs: () => number } {
  const counter = path.join(tmp, `${label}.runs`);
  const js = path.join(tmp, `${label}.js`);
  fs.writeFileSync(js, `
    const fs = require('fs'); fs.appendFileSync(${JSON.stringify(counter)}, 'x'); ${body}
    process.stdout.write(JSON.stringify({ token: ${JSON.stringify(TOKEN_CANARY)}, expires_at: new Date(Date.now() + 3600000).toISOString() }));
  `);
  return {
    program: process.execPath, args: [js],
    runs: () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').length : 0),
  };
}

function register(label: string, script: { program: string; args: string[] }, env: Array<{ env: string; value: string }> = []): string {
  const n = `${label}_${RUN}`;
  names.push(n);
  saveLiveSecret(prepareLiveSecret(n, { program: script.program, args: script.args, env }));
  return n;
}

async function run(command: string): Promise<string> {
  return resultText(await executeCommand({
    member_id: member.id, command, timeout_s: 30, long_running: false, max_retries: 0,
  } as never));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-exec-'));
  names = [];
  backupAndResetRegistry();
  member = makeTestLocalAgent({ friendlyName: `live-exec-${RUN}`, workFolder: tmp });
  addAgent(member);
  resetLiveTokenCache();
});

afterEach(() => {
  for (const n of names.filter(isLiveSecret)) credentialDelete(n);
  for (const n of names) {
    try { credentialDelete(n); } catch { /* already removed */ }
  }
  restoreRegistry();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('execute_command with a live secret', () => {
  it('mints, substitutes the token, and redacts it from the output', async () => {
    const script = mintJs('ok');
    const n = register('ok', script);
    const out = await run(`echo before {{secret.${n}}} after`);
    expect(out).toContain('before');
    expect(out).toContain(`[REDACTED:${n}]`);
    expect(out).not.toContain(TOKEN_CANARY);
    expect(script.runs()).toBe(1);
  });

  it('reuses the cached token on the next command', async () => {
    const script = mintJs('reuse');
    const n = register('reuse', script);
    await run(`echo {{secret.${n}}}`);
    await run(`echo {{secret.${n}}}`);
    expect(script.runs()).toBe(1);
  });

  it('a member outside allowedMembers is denied and causes no mint', async () => {
    const script = mintJs('deny');
    const n = register('deny', script);
    credentialUpdate(n, { members: 'someone-else' });
    const out = await run(`echo {{secret.${n}}}`);
    expect(out).toContain('not accessible to member');
    expect(script.runs()).toBe(0);
  });

  it('network_policy deny blocks a network command, as for a static secret', async () => {
    const n = register('net', mintJs('net'));
    credentialUpdate(n, { network_policy: 'deny' });
    const out = await run(`curl https://example.test -H {{secret.${n}}}`);
    expect(out).toContain('network_policy=deny');
    expect(out).not.toContain(TOKEN_CANARY);
  });

  it('a failing script gives a typed error naming the secret and reason, and runs no command', async () => {
    const marker = path.join(tmp, 'command-ran');
    const n = register('fails', mintJs('fails', `process.stderr.write(${JSON.stringify(TOKEN_CANARY)}); process.exit(5);`));
    const out = await run(`echo {{secret.${n}}} > "${marker}"`);
    expect(out).toContain('E-LIVE-SECRET');
    expect(out).toContain(n);
    expect(out).toContain('exit code 5');
    expect(out).not.toContain(TOKEN_CANARY);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('a static secret still resolves as before', async () => {
    const n = `static_${RUN}`;
    names.push(n);
    credentialSet(n, VALUE_CANARY, true, 'allow');
    const out = await run(`echo {{secret.${n}}}`);
    expect(out).toContain(`[REDACTED:${n}]`);
    expect(out).not.toContain(VALUE_CANARY);
  });

  it('an unknown name still reports not found', async () => {
    expect(await run('echo {{secret.nosuchname}}')).toContain('Credential "nosuchname" not found');
  });
});

describe('every caller that would keep the value in a file is refused', () => {
  it('provision_vcs_auth reports the name as denied, with no mint', async () => {
    const script = mintJs('vcs');
    const n = register('vcs', script);
    const out = resultText(await provisionVcsAuth({
      member_id: member.id, provider: 'azure-devops', pat: `{{secret.${n}}}`, org_url: 'https://dev.azure.com/x',
    } as never));
    expect(out).toContain('live secret');
    expect(script.runs()).toBe(0);
  });
});

describe('fleet_status lists every live secret', () => {
  function bound(): string {
    const r = `R_${RUN}`;
    names.push(r);
    credentialSet(r, VALUE_CANARY, true, 'allow');
    return r;
  }

  it('shows the path, args and bindings with placeholders only, and not run before the first mint', () => {
    const r = bound();
    const script = mintJs('st');
    const n = register('st', script, [{ env: 'CLIENT_SECRET', value: `{{secret.${r}}}` }]);
    const entry = liveSecretsHealth().find((s) => s.name === n);
    expect(entry).toMatchObject({
      path: script.program, args: script.args, bindings: [`CLIENT_SECRET={{secret.${r}}}`],
      state: 'not run', lastMinted: null, expiresAt: null, lastFailure: null,
    });
  });

  it('shows an inline script with its placeholders', () => {
    const r = bound();
    const n = `inl_${RUN}`;
    names.push(n);
    const inline = `node -e "mint" {{secret.${r}}}`;
    saveLiveSecret(prepareLiveSecret(n, { inline }));
    const entry = liveSecretsHealth().find((s) => s.name === n);
    expect(entry).toMatchObject({ script: inline, bindings: [`FLEET_SECRET_${r}={{secret.${r}}}`] });
    expect(liveSecretsCompactLines(liveSecretsHealth())).toContain(`script: ${inline}`);
  });

  it('after a mint shows state, last minted and expiry, in both formats, and never a token or value', async () => {
    const r = bound();
    const n = register('after', mintJs('after'), [{ env: 'X', value: `{{secret.${r}}}` }]);
    await run(`echo {{secret.${n}}}`);

    const compact = await fleetStatus({ format: 'compact' });
    const json = await fleetStatus({ format: 'json' });
    const line = compact.split('\n').find((l) => l.startsWith(`live secret ${n} `));
    expect(line).toContain('state: ok');
    expect(line).toContain(`bindings: X={{secret.${r}}}`);
    expect(line).toMatch(/last minted: \d{4}-/);
    expect(line).toMatch(/expires: \d{4}-/);
    const entry = (JSON.parse(json) as { liveSecrets: Array<Record<string, unknown>> }).liveSecrets.find((s) => s.name === n);
    expect(entry).toMatchObject({ state: 'ok' });
    for (const text of [compact, json]) {
      expect(text).not.toContain(TOKEN_CANARY);
      expect(text).not.toContain(VALUE_CANARY);
    }
  });

  it('shows the last failure', async () => {
    const n = register('badrun', mintJs('badrun', 'process.exit(5);'));
    await run(`echo {{secret.${n}}}`);
    const entry = liveSecretsHealth().find((s) => s.name === n);
    expect(entry).toMatchObject({ state: 'failed', lastFailure: 'exit code 5' });
    expect(entry?.retryAfter).not.toBeNull();
  });

  it('with no members registered the list still shows, in both formats', async () => {
    const n = register('empty', mintJs('empty'));
    backupAndResetRegistry();
    expect(await fleetStatus({ format: 'compact' })).toContain(`live secret ${n} `);
    expect(JSON.parse(await fleetStatus({ format: 'json' })).liveSecrets.some((s: { name: string }) => s.name === n)).toBe(true);
  });

  it('with no live secrets the output has no live secret lines or key', async () => {
    expect(liveSecretsCompactLines([])).toBe('');
    expect(JSON.parse(await fleetStatus({ format: 'json' })).liveSecrets).toBeUndefined();
  });
});
