/**
 * The samples shipped in docs/secret-variables.md, run as written, with a fake az
 * and a fake curl first on PATH so no real tool or account is reached. jq is the
 * real one. Bash samples run on POSIX and PowerShell samples on Windows: each is
 * for the shell of the OS it runs on. Text is read from the doc, so a doc edit that
 * breaks a sample fails here.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  credentialDelete,
  credentialSet,
  isLiveSecret,
  prepareLiveSecret,
  type LiveSecretSpec,
} from '../src/services/credential-store.js';
import { mintLiveSecret } from '../src/services/live-secret-cache.js';
import { findExecutableOnPath } from '../src/utils/find-on-path.js';
import { windowsSystemTool } from '../src/os/windows-executable.js';

const DOC = fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'secret-variables.md'), 'utf-8').replace(/\r\n/g, '\n');
const WIN = process.platform === 'win32';
const hasJq = !WIN && findExecutableOnPath('jq') !== null;
if (!WIN && !hasJq) console.warn('[live-secret-samples] jq not found: the bash samples are SKIPPED');

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const TOKEN = `tok-SAMPLE-${RUN}`;
const SECRET = `sp-SAMPLE-CANARY-${RUN}`;
const EXPIRES_ON = 4_102_444_800; // 2100-01-01T00:00:00Z

/** The fenced block right after the sample's marker. */
function sample(name: string): string {
  const marker = `<!-- live-secret-sample:${name} -->`;
  const at = DOC.indexOf(marker);
  if (at < 0) throw new Error(`docs/secret-variables.md has no sample ${name}`);
  const open = DOC.indexOf('\n', DOC.indexOf('```', at)) + 1;
  return DOC.slice(open, DOC.indexOf('\n```', open));
}

/** The script of a one-line `secret --live NAME --inline '...'` sample. */
function inlineOf(name: string): string {
  const m = sample(name).split('\n')[0].match(/--inline '(.*)'$/);
  if (!m) throw new Error(`sample ${name} is not an inline registration`);
  return m[1];
}

let tmp: string;
let fakes: string;
let names: string[];
const savedPath = process.env.PATH;

function writeFake(tool: string, posix: string, windows: string): void {
  if (WIN) fs.writeFileSync(path.join(fakes, `${tool}.cmd`), windows);
  else fs.writeFileSync(path.join(fakes, tool), `#!/bin/sh\n${posix}`, { mode: 0o755 });
}

function log(file: string): string {
  return path.join(tmp, file);
}

async function mint(name: string, spec: LiveSecretSpec): Promise<{ token: string; expiresAt: string }> {
  names.push(name);
  return mintLiveSecret(prepareLiveSecret(name, spec));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-sample-'));
  fakes = path.join(tmp, 'fakes');
  fs.mkdirSync(fakes);
  names = [];
  const azJson = JSON.stringify({ t: TOKEN, e: EXPIRES_ON });
  writeFake(
    'az',
    `printf '%s\\n' "$*" > '${log('az.args')}'\nprintf '%s' '${azJson}'\n`,
    `@echo %*> "${log('az.args')}"\r\n@echo ${azJson}\r\n`,
  );
  // The fake curl records its argv and stdin apart, then answers like a token endpoint.
  writeFake(
    'curl',
    `printf '%s\\n' "$*" > '${log('curl.args')}'\ncat > '${log('curl.stdin')}'\nprintf '%s' '{"access_token":"${TOKEN}","expires_in":3600}'\n`,
    '@exit /b 9\r\n',
  );
  process.env.PATH = `${fakes}${path.delimiter}${savedPath}`;
});

afterEach(() => {
  process.env.PATH = savedPath;
  for (const n of names.filter(isLiveSecret)) credentialDelete(n);
  for (const n of names) {
    try { credentialDelete(n); } catch { /* already removed */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(WIN || !hasJq)('bash samples (POSIX, needs jq)', () => {
  it('Entra ID through az, inline', async () => {
    const out = await mint(`az_${RUN}`, { inline: inlineOf('az-bash') });
    expect(out.token).toBe(TOKEN);
    expect(Date.parse(out.expiresAt)).toBe(EXPIRES_ON * 1000);
    expect(fs.readFileSync(log('az.args'), 'utf8')).toContain('account get-access-token --resource api://kb-app');
  });

  for (const [sampleName, firstArg, urlPart] of [
    ['sp-bash', 'my-tenant', 'https://login.microsoftonline.com/my-tenant/oauth2/v2.0/token'],
    ['oauth-bash', 'https://idp.example.test/token', 'https://idp.example.test/token'],
  ] as const) {
    it(`${sampleName}: the bound secret reaches curl on stdin, never its command line`, async () => {
      const secretName = `sp_${sampleName.replace('-', '_')}_${RUN}`;
      names.push(secretName);
      credentialSet(secretName, SECRET, true, 'allow');
      const file = path.join(tmp, `${sampleName}.sh`);
      fs.writeFileSync(file, `${sample(sampleName)}\n`, { mode: 0o755 });

      const out = await mint(`live_${sampleName.replace('-', '_')}_${RUN}`, {
        program: file, args: [firstArg, 'my-client', 'api://kb/.default'],
        env: [{ env: 'CLIENT_SECRET', value: `{{secret.${secretName}}}` }],
      });

      expect(out.token).toBe(TOKEN);
      expect(Date.parse(out.expiresAt)).toBeGreaterThan(Date.now());
      const args = fs.readFileSync(log('curl.args'), 'utf8');
      expect(args).toContain(urlPart);
      expect(args).toContain('client_secret@-');
      expect(args).not.toContain(SECRET);
      expect(fs.readFileSync(log('curl.stdin'), 'utf8')).toBe(SECRET);
    });
  }
});

describe.skipIf(!WIN)('PowerShell samples (Windows)', () => {
  let server: http.Server;
  let url: string;
  let bodies: string[];

  beforeAll(async () => {
    bodies = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        bodies.push(body);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: TOKEN, expires_in: 3600 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('Entra ID through az, inline', async () => {
    // A doubled single quote in a PowerShell string is one literal quote.
    const out = await mint(`az_${RUN}`, { inline: inlineOf('az-powershell').replace(/''/g, "'") });
    expect(out.token).toBe(TOKEN);
    expect(Date.parse(out.expiresAt)).toBe(EXPIRES_ON * 1000);
    expect(fs.readFileSync(log('az.args'), 'utf8')).toContain('account get-access-token --resource api://kb-app');
  }, 60_000);

  it('Entra ID through az, the registration line exactly as typed in Windows PowerShell, through the real CLI', () => {
    const data = path.join(tmp, 'data');
    fs.mkdirSync(data);
    const line = sample('az-powershell').split('\n')[0];
    expect(line.startsWith('apra-fleet secret ')).toBe(true);
    const typed = line.replace('apra-fleet', `& "${process.execPath}" "${path.resolve(__dirname, '..', 'dist', 'index.js')}"`);
    const r = spawnSync(windowsSystemTool('powershell') as string, [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(typed, 'utf16le').toString('base64'),
    ], { env: { ...process.env, APRA_FLEET_DATA_DIR: data }, encoding: 'utf-8', timeout: 90_000 });
    expect(r.stderr).not.toContain('FAILED');
    expect(r.stdout).toMatch(/^OK: expires 2100-01-01T/);
    expect(fs.readFileSync(log('az.args'), 'utf8')).toContain('{t:accessToken,e:expires_on}');
    const stored = JSON.parse(fs.readFileSync(path.join(data, 'credentials.json'), 'utf-8')).credentials.KB_TOKEN;
    expect(stored.inline).toContain(".ToString('o')");
  }, 120_000);

  it('generic OAuth: the bound secret goes in the request body', async () => {
    const secretName = `sp_oauth_${RUN}`;
    names.push(secretName);
    credentialSet(secretName, SECRET, true, 'allow');
    const file = path.join(tmp, 'mint-oauth.ps1');
    fs.writeFileSync(file, sample('oauth-powershell'));

    const out = await mint(`live_oauth_${RUN}`, {
      program: file, args: [url, 'my-client', 'api://kb/.default'],
      env: [{ env: 'CLIENT_SECRET', value: `{{secret.${secretName}}}` }],
    });

    expect(out.token).toBe(TOKEN);
    expect(Date.parse(out.expiresAt)).toBeGreaterThan(Date.now());
    const body = new URLSearchParams(bodies[bodies.length - 1]);
    expect(body.get('client_secret')).toBe(SECRET);
    expect(body.get('grant_type')).toBe('client_credentials');
  }, 60_000);

  it('generic OAuth, the registration line exactly as typed in Windows PowerShell, through the real CLI', async () => {
    const data = path.join(tmp, 'data');
    fs.mkdirSync(data);
    const cli = path.resolve(__dirname, '..', 'dist', 'index.js');
    const env = { ...process.env, APRA_FLEET_DATA_DIR: data };
    const set = spawnSync(process.execPath, [cli, 'secret', '--set', 'sp_secret', '--persist', '-y'], { env, input: `${SECRET}\n`, encoding: 'utf-8' });
    expect(set.status).toBe(0);
    const file = path.join(tmp, 'mint-oauth.ps1');
    fs.writeFileSync(file, sample('oauth-powershell'));
    const line = sample('oauth-powershell-register').split('\n')[0];
    const typed = line
      .replace('apra-fleet', `& "${process.execPath}" "${cli}"`)
      .replace('C:\\kb\\mint-oauth.ps1', `"${file}"`)
      .replace('<token-url>', url)
      .replace('<client-id>', 'my-client')
      .replace('<scope>', 'api://kb/.default');

    // Not spawnSync: the script calls the token server running in this process.
    const child = spawn(windowsSystemTool('powershell') as string, [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(typed, 'utf16le').toString('base64'),
    ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const r = { stdout: '', stderr: '' };
    child.stdout.on('data', (c) => { r.stdout += c; });
    child.stderr.on('data', (c) => { r.stderr += c; });
    await new Promise((resolve) => child.on('close', resolve));

    expect(typed).not.toContain(' -- ');
    expect(r.stderr).not.toContain('Usage');
    expect(r.stderr).not.toContain('FAILED');
    expect(r.stdout).toMatch(/^OK: expires /);
    expect(new URLSearchParams(bodies[bodies.length - 1]).get('client_secret')).toBe(SECRET);
    const stored = JSON.parse(fs.readFileSync(path.join(data, 'credentials.json'), 'utf-8')).credentials.KB_TOKEN;
    expect(stored.bindings).toEqual([{ env: 'CLIENT_SECRET', secret: 'sp_secret' }]);
  }, 120_000);
});

/**
 * Runs a registration line as typed, through the real CLI in a real shell, with
 * the CLI standing in for the installed apra-fleet. A child process, not
 * spawnSync, because a script may call the token server running in this process.
 */
async function typedInShell(line: string, data: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const cli = path.resolve(__dirname, '..', 'dist', 'index.js');
  expect(line.startsWith('apra-fleet secret --live ')).toBe(true);
  expect(line).not.toContain(' -- ');
  const env = { ...process.env, APRA_FLEET_DATA_DIR: data };
  const child = WIN
    ? spawn(windowsSystemTool('powershell') as string, [
      '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(line.replace('apra-fleet', `& "${process.execPath}" "${cli}"`), 'utf16le').toString('base64'),
    ], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('bash', ['-c', line], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const r = { stdout: '', stderr: '', code: null as number | null };
  child.stdout.on('data', (c) => { r.stdout += c; });
  child.stderr.on('data', (c) => { r.stderr += c; });
  r.code = await new Promise((resolve) => child.on('close', resolve));
  return r;
}

function dataDirWithBoundSecret(): string {
  const data = path.join(tmp, 'data');
  fs.mkdirSync(data, { recursive: true });
  const cli = path.resolve(__dirname, '..', 'dist', 'index.js');
  const set = spawnSync(process.execPath, [cli, 'secret', '--set', 'sp_secret', '--persist', '-y'], {
    env: { ...process.env, APRA_FLEET_DATA_DIR: data }, input: `${SECRET}\n`, encoding: 'utf-8',
  });
  expect(set.status).toBe(0);
  return data;
}

function storedLive(data: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(data, 'credentials.json'), 'utf-8');
  expect(raw).not.toContain(SECRET);
  expect(raw).not.toContain(TOKEN);
  return JSON.parse(raw).credentials.KB_TOKEN;
}

function expectRegistered(r: { stdout: string; stderr: string; code: number | null }): void {
  expect(r.stderr).toBe('');
  expect(r.stdout).toMatch(/^OK: expires /);
  expect(r.code).toBe(0);
}

describe.skipIf(WIN || !hasJq)('bash registration lines as typed, through the real CLI (POSIX, needs jq)', () => {
  beforeEach(() => {
    // The stand-in for the installed command the typed line names.
    fs.writeFileSync(path.join(fakes, 'apra-fleet'), `#!/bin/sh\nexec "${process.execPath}" "${path.resolve(__dirname, '..', 'dist', 'index.js')}" "$@"\n`, { mode: 0o755 });
  });

  it('inline, Entra ID through az', async () => {
    const data = path.join(tmp, 'data');
    fs.mkdirSync(data);
    expectRegistered(await typedInShell(sample('az-bash').split('\n')[0], data));
    expect(fs.readFileSync(log('az.args'), 'utf8')).toContain('{t:accessToken,e:expires_on}');
    expect(storedLive(data).kind).toBe('live');
  }, 60_000);

  it('inline, OAuth client credentials: the bound secret reaches curl on stdin', async () => {
    const data = dataDirWithBoundSecret();
    expectRegistered(await typedInShell(sample('oauth-inline-bash').split('\n')[0], data));
    expect(fs.readFileSync(log('curl.args'), 'utf8')).toContain('https://idp.example.test/token');
    expect(fs.readFileSync(log('curl.args'), 'utf8')).not.toContain(SECRET);
    expect(fs.readFileSync(log('curl.stdin'), 'utf8')).toBe(SECRET);
    expect(storedLive(data).bindings).toEqual([{ env: 'FLEET_SECRET_sp_secret', secret: 'sp_secret' }]);
  }, 60_000);

  for (const [script, register, placeholder, values, urlPart] of [
    ['sp-bash', 'sp-bash-register', '/opt/kb/mint-sp.sh', ['<tenant>', 'my-tenant', '<client-id>', 'my-client', '<app-id-uri>', 'api://kb'], 'https://login.microsoftonline.com/my-tenant/oauth2/v2.0/token'],
    ['oauth-bash', 'oauth-bash-register', '/opt/kb/mint-oauth.sh', ['<token-url>', 'https://idp.example.test/token', '<client-id>', 'my-client', '<scope>', 'api://kb/.default'], 'https://idp.example.test/token'],
  ] as const) {
    it(`script file ${script}: the file as printed, the line as typed`, async () => {
      const data = dataDirWithBoundSecret();
      const file = path.join(tmp, `${script}.sh`);
      fs.writeFileSync(file, `${sample(script)}\n`, { mode: 0o755 });
      let line = sample(register).split('\n')[0].replace(placeholder, file);
      for (let i = 0; i < values.length; i += 2) line = line.replace(values[i], values[i + 1]);
      expectRegistered(await typedInShell(line, data));
      expect(fs.readFileSync(log('curl.args'), 'utf8')).toContain(urlPart);
      expect(fs.readFileSync(log('curl.args'), 'utf8')).not.toContain(SECRET);
      expect(fs.readFileSync(log('curl.stdin'), 'utf8')).toBe(SECRET);
      expect(storedLive(data).bindings).toEqual([{ env: 'CLIENT_SECRET', secret: 'sp_secret' }]);
    }, 60_000);
  }
});

describe.skipIf(!WIN)('PowerShell registration lines as typed, through the real CLI (Windows)', () => {
  let server: http.Server;
  let url: string;
  let lastBody: URLSearchParams;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        lastBody = new URLSearchParams(body);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: TOKEN, expires_in: 3600 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('inline, OAuth client credentials: the bound secret goes in the request body', async () => {
    const data = dataDirWithBoundSecret();
    const line = sample('oauth-inline-powershell').split('\n')[0].replace('https://idp.example.test/token', url);
    expectRegistered(await typedInShell(line, data));
    expect(lastBody.get('client_secret')).toBe(SECRET);
    expect(lastBody.get('grant_type')).toBe('client_credentials');
    expect(storedLive(data).bindings).toEqual([{ env: 'FLEET_SECRET_sp_secret', secret: 'sp_secret' }]);
  }, 120_000);

  it('script file .bat: the file as printed, the line as typed', async () => {
    const data = dataDirWithBoundSecret();
    const file = path.join(tmp, 'mint-oauth.bat');
    fs.writeFileSync(file, `${sample('oauth-bat')}\n`);
    const line = sample('oauth-bat-register').split('\n')[0]
      .replace('C:\\kb\\mint-oauth.bat', `"${file}"`)
      .replace('<token-url>', url)
      .replace('<client-id>', 'my-client')
      .replace('<scope>', 'api://kb/.default');
    expectRegistered(await typedInShell(line, data));
    expect(lastBody.get('client_secret')).toBe(SECRET);
    expect(lastBody.get('client_id')).toBe('my-client');
    expect(lastBody.get('scope')).toBe('api://kb/.default');
    expect(storedLive(data).bindings).toEqual([{ env: 'CLIENT_SECRET', secret: 'sp_secret' }]);
  }, 120_000);
});

describe('the samples are present and carry no value', () => {
  it('every sample exists and references secrets only by placeholder or env var', () => {
    for (const name of [
      'az-bash', 'az-powershell', 'oauth-inline-bash', 'oauth-inline-powershell', 'sp-bash', 'sp-bash-register',
      'oauth-bash', 'oauth-bash-register', 'oauth-powershell', 'oauth-powershell-register', 'oauth-bat', 'oauth-bat-register',
    ]) {
      expect(sample(name).length).toBeGreaterThan(0);
    }
    expect(sample('sp-bash')).toContain('"$CLIENT_SECRET"');
    expect(sample('oauth-powershell')).toContain('$env:CLIENT_SECRET');
    expect(sample('oauth-bat')).toContain('$env:CLIENT_SECRET');
    expect(sample('oauth-bat')).not.toContain('%CLIENT_SECRET%');
  });

  it('no registration sample needs a bare --, which npm\'s PowerShell shim drops', () => {
    for (const name of ['sp-bash-register', 'oauth-bash-register', 'oauth-powershell-register', 'oauth-bat-register']) {
      expect(sample(name)).not.toContain(' -- ');
    }
  });

  it('the Windows inline samples hold no double quote, which Windows PowerShell 5.1 strips', () => {
    for (const name of ['az-powershell', 'oauth-inline-powershell']) {
      expect(sample(name)).not.toContain('"');
    }
  });
});
