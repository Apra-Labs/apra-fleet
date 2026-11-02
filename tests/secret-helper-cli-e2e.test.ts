/**
 * End-to-end: credential helper registration through the real built CLI
 * (node dist/index.js secret ...), as a child process, with
 * APRA_FLEET_DATA_DIR pointed at a per-test temp dir. Requires `npm run build`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { credentialStoreSet } from '../src/tools/credential-store-set.js';
import { credentialStoreUpdate } from '../src/tools/credential-store-update.js';
import { credentialResolve, lookupServerSecret } from '../src/services/credential-store.js';
import { executeCommand } from '../src/tools/execute-command.js';
import { makeTestAgent, backupAndResetRegistry, restoreRegistry, resultText } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';

const CLI = path.resolve(__dirname, '..', 'dist', 'index.js');
const ARG_WITH_SPACE = 'arg with space';

let sandbox: string;
let dataDir: string;
let helperScript: string;
const savedDataDir = process.env.APRA_FLEET_DATA_DIR;

function cli(args: string[], input?: string) {
  return spawnSync(process.execPath, [CLI, 'secret', ...args], {
    env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir },
    input,
    encoding: 'utf-8',
    timeout: 60_000,
  });
}

function credentialsPath(): string {
  return path.join(dataDir, 'credentials.json');
}

function readRecords(): Record<string, any> {
  return JSON.parse(fs.readFileSync(credentialsPath(), 'utf-8')).credentials;
}

describe('secret --helper (real CLI)', () => {
  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-helper-e2e-'));
    dataDir = path.join(sandbox, 'data');
    fs.mkdirSync(dataDir);
    helperScript = path.join(sandbox, 'helper.js');
    fs.writeFileSync(helperScript, 'console.log("token");\n');
    process.env.APRA_FLEET_DATA_DIR = dataDir;
    backupAndResetRegistry();
  });

  afterEach(() => {
    restoreRegistry();
    if (savedDataDir === undefined) delete process.env.APRA_FLEET_DATA_DIR;
    else process.env.APRA_FLEET_DATA_DIR = savedDataDir;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  function register(name: string) {
    return cli(['--helper', name, '--', 'node', helperScript, ARG_WITH_SPACE]);
  }

  it('stores the absolute program and argv element for element, no joined string', () => {
    const r = register('azhelper');
    expect(r.status).toBe(0);

    const rec = readRecords().azhelper;
    expect(path.isAbsolute(rec.program)).toBe(true);
    expect(path.basename(rec.program).toLowerCase()).toMatch(/^node(\.exe)?$/);
    expect(rec.args).toEqual([helperScript, ARG_WITH_SPACE]);

    const raw = fs.readFileSync(credentialsPath(), 'utf-8');
    expect(raw).not.toContain(`${helperScript} ${ARG_WITH_SPACE}`);
    expect(raw).not.toContain(`node ${helperScript}`);
  });

  it('re-registering replaces; --set replaces a helper and the reverse', () => {
    register('swap');
    const second = cli(['--helper', 'swap', '--', 'node', helperScript, 'other']);
    expect(second.status).toBe(0);
    expect(readRecords().swap.args).toEqual([helperScript, 'other']);

    const set = cli(['--set', 'swap', '--persist', '-y'], 'static-value\n');
    expect(set.status).toBe(0);
    expect(readRecords().swap.kind).toBeUndefined();
    expect(readRecords().swap.program).toBeUndefined();
    expect(readRecords().swap.encryptedValue).toBeTruthy();

    const back = register('swap');
    expect(back.status).toBe(0);
    expect(readRecords().swap.kind).toBe('helper');
    expect(readRecords().swap.encryptedValue).toBeUndefined();
    expect(lookupServerSecret('swap').status).toBe('missing');
  });

  it('refuses an unresolvable program, names it, and leaves the file byte-identical', () => {
    register('keep');
    const before = fs.readFileSync(credentialsPath());

    const r = cli(['--helper', 'keep', '--', 'no-such-program-xyz-12345', 'a']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no-such-program-xyz-12345');
    expect(fs.readFileSync(credentialsPath()).equals(before)).toBe(true);

    const fresh = cli(['--helper', 'never', '--', 'no-such-program-xyz-12345']);
    expect(fresh.status).not.toBe(0);
    expect(readRecords().never).toBeUndefined();
  });

  it('secret --delete removes the helper record', () => {
    register('gone');
    expect(readRecords().gone).toBeDefined();
    const r = cli(['--delete', 'gone']);
    expect(r.status).toBe(0);
    expect(readRecords().gone).toBeUndefined();
  });

  it('MCP set/update handlers refuse a helper name and leave the record unchanged', async () => {
    register('locked');
    const before = fs.readFileSync(credentialsPath());

    const setOut = await credentialStoreSet({
      name: 'locked', prompt: 'x', persist: true, network_policy: 'allow', members: '*',
    });
    expect(setOut).toContain('credential helper');

    const updOut = await credentialStoreUpdate({ name: 'locked', network_policy: 'allow' });
    expect(updOut).toContain('credential helper');

    expect(fs.readFileSync(credentialsPath()).equals(before)).toBe(true);
    expect(readRecords().locked.kind).toBe('helper');
  });

  it('a member command referencing the helper name receives nothing', async () => {
    register('handed');
    const rec = readRecords().handed;
    expect(credentialResolve('handed', '*')).toBeNull();

    const member = makeTestAgent({ os: 'linux' });
    addAgent(member);
    const out = resultText(await executeCommand({
      member_id: member.id,
      command: 'echo {{secret.handed}}',
      timeout_s: 5,
    }));
    expect(out).toContain('not found');
    expect(out).not.toContain(rec.program);
    expect(out).not.toContain(helperScript);
  });

  it('leaves only credentials.json in the data dir (no temp files)', () => {
    register('tidy');
    expect(fs.readdirSync(dataDir)).toEqual(['credentials.json']);
  });
});
