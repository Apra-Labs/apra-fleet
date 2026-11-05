/**
 * The samples shipped in docs/knowledge-layer.md, run as written, with a fake az
 * and a fake curl first on PATH so no real tool or account is reached. jq is the
 * real one. Bash samples run on POSIX and PowerShell samples on Windows: each is
 * for the shell of the OS it runs on. Text is read from the doc, so a doc edit that
 * breaks a sample fails here.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
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

const DOC = fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'knowledge-layer.md'), 'utf-8').replace(/\r\n/g, '\n');
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
  if (at < 0) throw new Error(`docs/knowledge-layer.md has no sample ${name}`);
  const open = DOC.indexOf('\n', DOC.indexOf('```', at)) + 1;
  return DOC.slice(open, DOC.indexOf('\n```', open));
}

/** The script of a one-line `secret --live NAME --inline '...'` sample. */
function inlineOf(name: string): string {
  const m = sample(name).match(/--inline '(.*)'$/);
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
    const out = await mint(`az_${RUN}`, { inline: inlineOf('az-powershell') });
    expect(out.token).toBe(TOKEN);
    expect(Date.parse(out.expiresAt)).toBe(EXPIRES_ON * 1000);
    expect(fs.readFileSync(log('az.args'), 'utf8')).toContain('account get-access-token --resource api://kb-app');
  }, 60_000);

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
});

describe('the samples are present and carry no value', () => {
  it('every sample exists and references secrets only by placeholder or env var', () => {
    for (const name of ['az-bash', 'az-powershell', 'sp-bash', 'oauth-bash', 'oauth-powershell']) {
      expect(sample(name).length).toBeGreaterThan(0);
    }
    expect(sample('sp-bash')).toContain('"$CLIENT_SECRET"');
    expect(sample('oauth-powershell')).toContain('$env:CLIENT_SECRET');
  });
});
