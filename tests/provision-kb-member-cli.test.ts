/**
 * The member-side half of provision_kb_auth, through the real built CLI (node
 * dist/index.js), with APRA_FLEET_DATA_DIR pointed at a per-test temp dir:
 *  - `secret --set NAME --persist --expires-at <time|none> -y`, value on stdin;
 *  - `kb-setup --remote <url> --token-ref NAME`, against a KB stub server here.
 * Plus the E-KB-HTTP-AUTH remediation on a member install. Requires `npm run build`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { clearMemberInstallMarker, writeMemberInstallMarker } from '../src/cli/install-guard.js';
import { KbHttpAuthError } from '../src/services/knowledge/http-provider.js';
import { buildPushSecretCommand } from '../src/services/provision-kb.js';

const CLI = path.resolve(__dirname, '..', 'dist', 'index.js');
const TOKEN = `kb-member-CANARY-${Date.now().toString(36)}`;
const NAME = 'KB_TOKEN';

let sandbox: string;
let dataDir: string;
let server: http.Server | null;
let serverToken: string;
let requests: Array<{ url?: string; auth?: string }>;
const savedDataDir = process.env.APRA_FLEET_DATA_DIR;

interface Run { code: number | null; stdout: string; stderr: string }

/** Async, so the stub KB server in this process can answer while the CLI runs. */
function cli(args: string[], input = '', cwd = sandbox): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir }, cwd, timeout: 60_000, encoding: 'utf-8' },
      (err, stdout, stderr) => resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout, stderr }));
    child.stdin?.end(input);
  });
}

function record(name = NAME): Record<string, unknown> | undefined {
  const file = path.join(dataDir, 'credentials.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')).credentials[name] : undefined;
}

const kbConfigPath = () => path.join(dataDir, 'knowledge', 'config.json');
const lastJson = (r: Run) => JSON.parse(r.stdout.trim().split(/\r?\n/).pop()!);

async function startKb(): Promise<string> {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization });
    const ok = req.headers.authorization === `Bearer ${serverToken}`;
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { l1_results: [], l2_expanded: [] } : { error: 'Invalid token', code: 'UNAUTHORIZED' }));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

async function setSecret(value = TOKEN, ...extra: string[]): Promise<Run> {
  return cli(['secret', '--set', NAME, '--persist', ...extra, '-y'], `${value}\n`);
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-member-cli-'));
  dataDir = path.join(sandbox, 'data');
  fs.mkdirSync(dataDir);
  process.env.APRA_FLEET_DATA_DIR = dataDir;
  server = null;
  serverToken = TOKEN;
  requests = [];
});

afterEach(async () => {
  clearMemberInstallMarker();
  if (savedDataDir === undefined) delete process.env.APRA_FLEET_DATA_DIR;
  else process.env.APRA_FLEET_DATA_DIR = savedDataDir;
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('secret --set --expires-at (real CLI)', () => {
  it('stores the given expiry, and a second push replaces it rather than keeping the first', async () => {
    const t1 = new Date(Date.now() + 3_600_000).toISOString();
    const t2 = new Date(Date.now() + 7_200_000).toISOString();
    expect((await setSecret(TOKEN, '--expires-at', t1)).code).toBe(0);
    expect(record()?.expiresAt).toBe(t1);
    expect((await setSecret(`${TOKEN}-2`, '--expires-at', t2)).code).toBe(0);
    expect(record()?.expiresAt).toBe(t2);
    expect(record()).toMatchObject({ network_policy: 'allow', allowedMembers: '*' });
  });

  it('none clears a stored expiry', async () => {
    await setSecret(TOKEN, '--expires-at', new Date(Date.now() + 3_600_000).toISOString());
    expect((await setSecret(TOKEN, '--expires-at', 'none')).code).toBe(0);
    expect(record()?.expiresAt).toBeUndefined();
  });

  it('a time without a zone, a past time, or no --persist is refused and stores nothing', async () => {
    for (const extra of [['--expires-at', '2099-01-01T00:00:00'], ['--expires-at', '2000-01-01T00:00:00Z']]) {
      const r = await setSecret(TOKEN, ...extra);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('--expires-at');
    }
    const noPersist = await cli(['secret', '--set', NAME, '--expires-at', 'none', '-y'], `${TOKEN}\n`);
    expect(noPersist.code).toBe(1);
    expect(record()).toBeUndefined();
  });
});

describe('the push command, run by the member shell for real', () => {
  /** A stand-in for <home>/.apra-fleet/bin/apra-fleet that runs this build's CLI. */
  function wrapper(): string {
    if (process.platform === 'win32') {
      const file = path.join(sandbox, 'apra-fleet.cmd');
      fs.writeFileSync(file, `@"${process.execPath}" "${CLI}" %*\r\n`);
      return file;
    }
    const file = path.join(sandbox, 'apra-fleet');
    fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
    return file;
  }

  function runMember(command: string): Promise<Run> {
    const enc = /^powershell -EncodedCommand (\S+)$/.exec(command);
    const [file, args] = enc ? ['powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc[1]]] : ['/bin/sh', ['-c', command]];
    return new Promise((resolve) => {
      execFile(file, args, { env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir }, cwd: sandbox, timeout: 60_000, encoding: 'utf-8' },
        (err, stdout, stderr) => resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout, stderr }));
    });
  }

  const targetOs = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

  it('stores the staged value with its expiry, removes the staged file, and passes a failure exit code on', async () => {
    const staged = path.join(sandbox, 'staged-token');
    fs.writeFileSync(staged, TOKEN);
    const exp = new Date(Date.now() + 3_600_000).toISOString();
    const ok = await runMember(buildPushSecretCommand(wrapper(), NAME, exp, staged, targetOs, undefined));
    expect(ok.code).toBe(0);
    expect(fs.existsSync(staged)).toBe(false);
    expect(record()?.expiresAt).toBe(exp);
    // The stored value is the staged one: the KB server accepts it.
    const url = await startKb();
    expect(lastJson(await cli(['kb-setup', '--remote', url, '--token-ref', NAME])).verification).toBe('verified');

    fs.writeFileSync(staged, TOKEN);
    const bad = await runMember(buildPushSecretCommand(wrapper(), NAME, '2000-01-01T00:00:00Z', staged, targetOs, undefined));
    expect(bad.code).toBe(1);
    expect(fs.existsSync(staged)).toBe(false);
    expect(`${bad.stdout}${bad.stderr}`).toContain('--expires-at');
  }, 60_000);
});

describe('kb-setup (real CLI)', () => {
  it('writes the config with the secret reference, checks it with one KB call, and installs no git hook', async () => {
    const url = await startKb();
    await setSecret();
    const repo = path.join(sandbox, 'repo');
    fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
    const r = await cli(['kb-setup', '--remote', url, '--token-ref', NAME], '', repo);
    expect(r.code).toBe(0);
    expect(lastJson(r)).toEqual({ kbSetup: 'written', verification: 'verified' });
    expect(JSON.parse(fs.readFileSync(kbConfigPath(), 'utf-8'))).toMatchObject({ provider: 'http', url, token_ref: `{{secret.${NAME}}}` });
    expect(requests).toEqual([{ url: '/api/kb/query?limit=1', auth: `Bearer ${TOKEN}` }]);
    expect(fs.readdirSync(path.join(repo, '.git', 'hooks'))).toEqual([]);
    expect(`${r.stdout}${r.stderr}`).not.toContain(TOKEN);
  });

  it('an existing matching config is left alone, and a config for another remote is replaced', async () => {
    const url = await startKb();
    await setSecret();
    await cli(['kb-setup', '--remote', url, '--token-ref', NAME]);
    const before = fs.statSync(kbConfigPath()).mtimeMs;
    await new Promise((r) => setTimeout(r, 50));
    const again = await cli(['kb-setup', '--remote', `${url}/`, '--token-ref', NAME]);
    expect(lastJson(again)).toEqual({ kbSetup: 'unchanged', verification: 'verified' });
    expect(fs.statSync(kbConfigPath()).mtimeMs).toBe(before);
    fs.writeFileSync(kbConfigPath(), JSON.stringify({ provider: 'http', url: 'http://127.0.0.1:1', token_ref: `{{secret.${NAME}}}` }));
    const moved = await cli(['kb-setup', '--remote', url, '--token-ref', NAME]);
    expect(lastJson(moved)).toEqual({ kbSetup: 'written', verification: 'verified' });
  });

  it('a token the server refuses is reported as rejected, an unreachable server as unreachable', async () => {
    const url = await startKb();
    serverToken = 'something-else';
    await setSecret();
    expect(lastJson(await cli(['kb-setup', '--remote', url, '--token-ref', NAME])).verification).toBe('rejected');
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    expect(lastJson(await cli(['kb-setup', '--remote', url, '--token-ref', NAME])).verification).toBe('unreachable');
  });

  it('a deny secret is refused like the kb_setup tool: nothing written, and refused again once a matching config exists', async () => {
    const url = await startKb();
    await setSecret();
    expect((await cli(['secret', '--update', NAME, '--deny'])).code).toBe(0);
    const r = await cli(['kb-setup', '--remote', url, '--token-ref', NAME]);
    expect(r.code).toBe(1);
    expect(lastJson(r)).toEqual({ error: 'refused' });
    expect(r.stderr).toContain('network_policy=deny');
    expect(fs.existsSync(kbConfigPath())).toBe(false);
    fs.mkdirSync(path.dirname(kbConfigPath()), { recursive: true });
    fs.writeFileSync(kbConfigPath(), JSON.stringify({ provider: 'http', url, token_ref: `{{secret.${NAME}}}` }));
    expect((await cli(['kb-setup', '--remote', url, '--token-ref', NAME])).code).toBe(1);
    expect(requests).toHaveLength(0);
  });

  it('a missing secret is refused', async () => {
    const url = await startKb();
    const r = await cli(['kb-setup', '--remote', url, '--token-ref', NAME]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('does not exist');
  });
});

describe('E-KB-HTTP-AUTH remediation', () => {
  it('on a member install it says renewal comes from the orchestrator, not to set the secret by hand', () => {
    writeMemberInstallMarker('0.4.5');
    const onMember = new KbHttpAuthError(NAME, 'rejected', 'p');
    expect(onMember.remediation).toContain('renewed from the orchestrator');
    expect(onMember.remediation).not.toContain('secret --set');
    clearMemberInstallMarker();
    expect(new KbHttpAuthError(NAME, 'rejected', 'p').remediation).toContain(`apra-fleet secret --set ${NAME} --persist -y`);
  });
});
