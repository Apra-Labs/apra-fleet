/**
 * End-to-end: `apra-fleet secret --live` through the real built CLI (node
 * dist/index.js secret ...), as a child process, with APRA_FLEET_DATA_DIR
 * pointed at a per-test temp dir. Requires `npm run build`.
 *
 * The scripts are real node files. Every script prints TOKEN_CANARY as its
 * token and echoes the bound value to its own stderr and stdout where the mode
 * says so, so one sweep proves neither reached the CLI's output or the log.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { credentialStoreSet } from '../src/tools/credential-store-set.js';
import { credentialStoreUpdate } from '../src/tools/credential-store-update.js';
import { credentialStoreDelete } from '../src/tools/credential-store-delete.js';
import { registerMember } from '../src/tools/register-member.js';
import { credentialResolve, lookupServerSecret } from '../src/services/credential-store.js';
import { backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

const CLI = path.resolve(__dirname, '..', 'dist', 'index.js');
const ARG_WITH_SPACE = 'arg with space';
const TOKEN_CANARY = 'tok-CLI-CANARY-7f3a91c2';
const SECRET_CANARY = 'secret-CLI-CANARY-b2e84d06';
const OK_LINE = /^OK: expires \d{4}-\d{2}-\d{2}T[\d:.]+Z\n$/;

let sandbox: string;
let dataDir: string;
let okScript: string;
const savedDataDir = process.env.APRA_FLEET_DATA_DIR;

function cli(args: string[], input?: string) {
  return spawnSync(process.execPath, [CLI, 'secret', ...args], {
    env: { ...process.env, APRA_FLEET_DATA_DIR: dataDir },
    input: input ?? '',
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

/** A node script: `body` runs with fs available, and `future` is an expiry one hour out. */
function script(name: string, body: string): string {
  const file = path.join(sandbox, name);
  fs.writeFileSync(file, `const fs=require("fs");const future=new Date(Date.now()+3600000).toISOString();${body}`);
  return file;
}

const printToken = `process.stdout.write(JSON.stringify({token:${JSON.stringify(TOKEN_CANARY)},expires_at:future}));`;

function register(name: string, file: string = okScript, ...args: string[]) {
  return cli(['--live', name, '--', 'node', file, ...args]);
}

function setStatic(name: string, value: string = SECRET_CANARY) {
  const r = cli(['--set', name, '--persist', '-y'], `${value}\n`);
  expect(r.status).toBe(0);
}

/** Every file under the data dir except the two that may hold ciphertext-free text we assert on separately. */
function logText(): string {
  const logs = path.join(dataDir, 'logs');
  if (!fs.existsSync(logs)) return '';
  return fs.readdirSync(logs).map((f) => fs.readFileSync(path.join(logs, f), 'utf-8')).join('\n');
}

function expectNoCanary(...texts: string[]): void {
  for (const text of [...texts, logText()]) {
    expect(text).not.toContain(TOKEN_CANARY);
    expect(text).not.toContain(SECRET_CANARY);
  }
  if (fs.existsSync(credentialsPath())) {
    const raw = fs.readFileSync(credentialsPath(), 'utf-8');
    expect(raw).not.toContain(TOKEN_CANARY);
    expect(raw).not.toContain(SECRET_CANARY);
  }
}

describe('secret --live (real CLI)', () => {
  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-live-e2e-'));
    dataDir = path.join(sandbox, 'data');
    fs.mkdirSync(dataDir);
    okScript = script('ok.js', printToken);
    process.env.APRA_FLEET_DATA_DIR = dataDir;
    backupAndResetRegistry();
  });

  afterEach(() => {
    restoreRegistry();
    if (savedDataDir === undefined) delete process.env.APRA_FLEET_DATA_DIR;
    else process.env.APRA_FLEET_DATA_DIR = savedDataDir;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  describe('registration test', () => {
    it('on pass prints only OK: expires <time>, and stores the absolute program and argv element for element', () => {
      const r = register('azlive', okScript, ARG_WITH_SPACE);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(OK_LINE);
      expect(r.stderr).toBe('');

      const rec = readRecords().azlive;
      expect(rec.kind).toBe('live');
      expect(path.isAbsolute(rec.program)).toBe(true);
      expect(path.basename(rec.program).toLowerCase()).toMatch(/^node(\.exe)?$/);
      expect(rec.args).toEqual([okScript, ARG_WITH_SPACE]);
      expect(rec.network_policy).toBe('allow');
      expect(rec.allowedMembers).toBe('*');
      expectNoCanary(r.stdout, r.stderr);
    });

    it('prints nothing from the helper when it passes, even when the helper writes to stderr', () => {
      setStatic('R');
      const noisy = script('noisy.js',
        `process.stderr.write(process.env.BOUND+" ${TOKEN_CANARY}\\n");${printToken}`);
      const r = cli(['--live', 'quiet', '--env', 'BOUND={{secret.R}}', '--', 'node', noisy]);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(OK_LINE);
      expect(r.stderr).toBe('');
      expectNoCanary(r.stdout, r.stderr);
    });

    const FAILURES: Array<{ mode: string; body: string; expected: RegExp }> = [
      { mode: 'exit', body: `process.stdout.write(process.env.BOUND);process.stderr.write(process.env.BOUND);process.exit(7);`, expected: /^FAILED: exit-nonzero exit=7\n$/ },
      { mode: 'notjson', body: `process.stdout.write("accessToken: "+process.env.BOUND+" ${TOKEN_CANARY}");`, expected: /^FAILED: output-not-json\n$/ },
      { mode: 'notoken', body: `process.stdout.write(JSON.stringify({bound:process.env.BOUND,expires_at:future}));`, expected: /^FAILED: no-token\n$/ },
      { mode: 'past', body: `process.stdout.write(JSON.stringify({token:${JSON.stringify(TOKEN_CANARY)},expires_at:"2001-01-01T00:00:00Z"}));`, expected: /^FAILED: past-expiry\n$/ },
      { mode: 'multiline', body: `process.stdout.write(JSON.stringify({token:${JSON.stringify(`${TOKEN_CANARY} x`)},expires_at:future}));`, expected: /^FAILED: bad-token\n$/ },
    ];

    for (const { mode, body, expected } of FAILURES) {
      it(`on failure '${mode}' prints only a reason code, writes nothing, and leaves an existing record byte-identical`, () => {
        setStatic('R');
        register('existing');
        const before = fs.readFileSync(credentialsPath());
        const bad = script(`bad-${mode}.js`, body);

        for (const name of ['existing', 'fresh']) {
          const r = cli(['--live', name, '--env', 'BOUND={{secret.R}}', '--', 'node', bad]);
          expect(r.status).toBe(1);
          expect(r.stdout).toBe('');
          expect(r.stderr).toMatch(expected);
          expect(fs.readFileSync(credentialsPath()).equals(before)).toBe(true);
          expectNoCanary(r.stdout, r.stderr);
        }
        expect(readRecords().fresh).toBeUndefined();
      });
    }

    it('an inline script that fails prints nothing of the script', () => {
      const marker = 'INLINE-SCRIPT-TEXT-MARKER';
      const r = cli(['--live', 'inl', '--inline', `exit 3 # ${marker}`]);
      expect(r.status).toBe(1);
      expect(r.stderr + r.stdout).not.toContain(marker);
      expect(fs.existsSync(credentialsPath())).toBe(false);
    });

    it('an inline script with a bound secret passes and stores placeholders only', () => {
      setStatic('sp-secret');
      const node = JSON.stringify(process.execPath);
      const js = `process.stdout.write(JSON.stringify({token:process.argv[1].length+"x",expires_at:new Date(Date.now()+3600000).toISOString()}))`;
      // The value goes to node on stdin-free env only: the script checks its own env var.
      const inline = process.platform === 'win32'
        ? `$v={{secret.sp-secret}}; if ($v -ne '${SECRET_CANARY}') { exit 9 }; & ${node} -e '${js.replace(/"/g, '\\"')}' ok`
        : `v={{secret.sp-secret}}; [ "$v" = '${SECRET_CANARY}' ] || exit 9; ${node} -e '${js}' ok`;
      // The canary in this script text is only there to compare with the delivered value.
      const r = cli(['--live', 'inl', '--inline', inline]);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(OK_LINE);
      const rec = readRecords().inl;
      expect(rec.inline).toContain('{{secret.sp-secret}}');
      expect(rec.bindings).toEqual([{ env: 'FLEET_SECRET_sp_secret', secret: 'sp-secret' }]);
    });
  });

  describe('binding checks run before the script', () => {
    /** A script that leaves a marker when it runs. */
    function markerScript(): { file: string; marker: string } {
      const marker = path.join(sandbox, 'ran.marker');
      return { file: script('marker.js', `fs.writeFileSync(${JSON.stringify(marker)},"1");${printToken}`), marker };
    }

    it('names a missing secret, says to use --persist, and does not run the script', () => {
      const { file, marker } = markerScript();
      const r = cli(['--live', 'L', '--env', 'X={{secret.nosuch}}', '--', 'node', file]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('binding-missing');
      expect(r.stderr).toContain('"nosuch"');
      expect(r.stderr).toContain('--persist');
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('refuses a live secret as a binding', () => {
      register('other');
      const { file, marker } = markerScript();
      const r = cli(['--live', 'L', '--env', 'X={{secret.other}}', '--', 'node', file]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('binding-live');
      expect(r.stderr).toContain('"other"');
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('refuses binding a live secret to itself', () => {
      setStatic('selfy');
      const r = cli(['--live', 'selfy', '--env', 'X={{secret.selfy}}', '--', 'node', okScript]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('binding-self');
    });

    it('refuses two inline secrets that map to one env var', () => {
      setStatic('a-b');
      setStatic('a_b');
      const r = cli(['--live', 'L', '--inline', 'echo {{secret.a-b}} {{secret.a_b}}']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('binding-collision');
      expect(r.stderr).toContain('"a-b"');
    });

    it('refuses a placeholder in args, naming no value', () => {
      setStatic('R');
      const r = cli(['--live', 'L', '--', 'node', okScript, '--tok={{secret.R}}']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('placeholder-in-args');
    });

    it('refuses --env with anything but one placeholder, without echoing the value', () => {
      const literal = 'LITERAL-ENV-VALUE-1234';
      for (const value of [literal, `x{{secret.R}}`, '{{secret.R}}{{secret.S}}']) {
        const r = cli(['--live', 'L', '--env', `X=${value}`, '--', 'node', okScript]);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('bad-env');
        expect(r.stderr).not.toContain(literal);
      }
    });

    it('refuses --env FLEET_CREDENTIAL and an invalid env name', () => {
      setStatic('R');
      for (const env of ['fleet_credential', 'FLEET_CREDENTIAL', '1BAD', 'A-B']) {
        const r = cli(['--live', 'L', '--env', `${env}={{secret.R}}`, '--', 'node', okScript]);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('bad-env');
      }
    });

    it('refuses text that looks like a known token in the script or args, without echoing it', () => {
      const pat = `ghp_${'a1B2'.repeat(10)}`;
      const inline = cli(['--live', 'L', '--inline', `curl -H "Authorization: token ${pat}" https://x`]);
      expect(inline.status).toBe(1);
      expect(inline.stderr).toContain('cleartext-token');
      expect(inline.stderr).not.toContain(pat);

      const args = cli(['--live', 'L', '--', 'node', okScript, pat]);
      expect(args.status).toBe(1);
      expect(args.stderr).toContain('cleartext-token');
      expect(args.stderr).not.toContain(pat);
    });

    it('refuses an unresolvable program, and leaves the file byte-identical', () => {
      register('keep');
      const before = fs.readFileSync(credentialsPath());
      const r = cli(['--live', 'keep', '--', 'no-such-program-xyz-12345', 'a']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('program-not-found');
      expect(fs.readFileSync(credentialsPath()).equals(before)).toBe(true);
    });

    it('prints usage for malformed forms', () => {
      for (const args of [['--live'], ['--live', 'L'], ['--live', 'L', '--inline'], ['--live', 'L', '--inline', 'x', 'y'], ['--live', 'L', '--env', 'NOEQ', '--', 'x'], ['--live', 'L', '--']]) {
        const r = cli(args);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('Usage');
      }
    });
  });

  describe('bindings are permanent', () => {
    function bind(): void {
      setStatic('R');
      const r = cli(['--live', 'consumer', '--env', 'X={{secret.R}}', '--', 'node', okScript]);
      expect(r.status).toBe(0);
    }

    it('secret --delete fails with secret is in use by, until the live secret is deleted', () => {
      bind();
      const refused = cli(['--delete', 'R']);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('secret is in use by: consumer');
      expect(readRecords().R).toBeDefined();

      expect(cli(['--delete', 'consumer']).status).toBe(0);
      expect(cli(['--delete', 'R']).status).toBe(0);
      expect(readRecords().R).toBeUndefined();
    });

    it('registering a live secret over a bound name is refused and leaves the file unchanged', () => {
      bind();
      const before = fs.readFileSync(credentialsPath());
      const r = register('R');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('name-in-use');
      expect(r.stderr).toContain('secret is in use by: consumer');
      expect(fs.readFileSync(credentialsPath()).equals(before)).toBe(true);
    });

    it('--delete --all removes live secrets first, then the secrets they were bound to', () => {
      bind();
      const r = cli(['--delete', '--all'], 'yes\n');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Deleted 2 credential(s)');
      expect(readRecords()).toEqual({});
    });

    it('updating a bound value is allowed and does not re-run the script', () => {
      const marker = path.join(sandbox, 'runs.log');
      const counting = script('counting.js', `fs.appendFileSync(${JSON.stringify(marker)},"x");${printToken}`);
      setStatic('R');
      expect(cli(['--live', 'consumer', '--env', 'X={{secret.R}}', '--', 'node', counting]).status).toBe(0);
      expect(fs.readFileSync(marker, 'utf-8')).toBe('x');

      setStatic('R', 'rotated-value');
      expect(fs.readFileSync(marker, 'utf-8')).toBe('x');
      expect(readRecords().consumer.kind).toBe('live');
    });

    it('session-tier: without --persist the CLI cannot see the secret and says to use --persist', () => {
      const r = cli(['--live', 'L', '--inline', 'echo {{secret.session_only}}']);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('--persist');
    });
  });

  it('the first key creation after a key-less live-only store does not move the live secret aside', () => {
    expect(register('first').status).toBe(0);
    expect(fs.existsSync(path.join(dataDir, 'salt'))).toBe(true);
    setStatic('later');
    expect(fs.existsSync(`${credentialsPath()}.bak`)).toBe(false);
    expect(readRecords().first.kind).toBe('live');
  });

  it('--set replaces a live secret and a live secret replaces an unbound static one', () => {
    register('swap');
    expect(cli(['--set', 'swap', '--persist', '-y'], 'static-value\n').status).toBe(0);
    expect(readRecords().swap.kind).toBeUndefined();
    expect(readRecords().swap.program).toBeUndefined();
    expect(readRecords().swap.encryptedValue).toBeTruthy();

    expect(register('swap').status).toBe(0);
    expect(readRecords().swap.kind).toBe('live');
    expect(readRecords().swap.encryptedValue).toBeUndefined();
    expect(lookupServerSecret('swap').status).toBe('missing');
  });

  it('--update changes the policy fields, keeps the script, and refuses --ttl', () => {
    register('upd');
    const args = readRecords().upd.args;
    expect(cli(['--update', 'upd', '--deny', '--members', 'a,b']).status).toBe(0);
    const rec = readRecords().upd;
    expect(rec.network_policy).toBe('deny');
    expect(rec.allowedMembers).toEqual(['a', 'b']);
    expect(rec.args).toEqual(args);

    const ttl = cli(['--update', 'upd', '--ttl', '60']);
    expect(ttl.status).toBe(1);
    expect(ttl.stderr).toContain('--ttl does not apply');
  });

  it('re-registering keeps policy fields set with --update', () => {
    register('kept');
    cli(['--update', 'kept', '--deny', '--members', 'a']);
    expect(register('kept').status).toBe(0);
    expect(readRecords().kept).toMatchObject({ network_policy: 'deny', allowedMembers: ['a'] });
  });

  it('--list marks a live secret', () => {
    register('listed');
    const r = cli(['--list']);
    expect(r.stdout).toMatch(/listed\s+live\s+allow/);
    expectNoCanary(r.stdout);
  });

  it('secret --delete removes the live record', () => {
    register('gone');
    expect(readRecords().gone).toBeDefined();
    expect(cli(['--delete', 'gone']).status).toBe(0);
    expect(readRecords().gone).toBeUndefined();
  });

  it('MCP set/update/delete handlers refuse a live name and leave the record unchanged', async () => {
    register('locked');
    const before = fs.readFileSync(credentialsPath());

    expect(await credentialStoreSet({ name: 'locked', prompt: 'x', persist: true, network_policy: 'allow', members: '*' })).toContain('live secret');
    expect(await credentialStoreUpdate({ name: 'locked', network_policy: 'deny' })).toContain('live secret');
    expect(await credentialStoreDelete({ name: 'locked' })).toContain('live secret');

    expect(fs.readFileSync(credentialsPath()).equals(before)).toBe(true);
  });

  it('every other {{secret.NAME}} caller is refused by credentialResolve, whose text names no script', () => {
    register('handed');
    const out = credentialResolve('handed', '*');
    expect(out).toHaveProperty('denied');
    const text = (out as { denied: string }).denied;
    expect(text).toContain('live secret');
    expect(text).not.toContain(okScript);
  });

  it('register_member with a live secret token refuses and leaves credentials.json byte-identical', async () => {
    register('rmlive');
    const before = fs.readFileSync(credentialsPath());
    const out = await registerMember({
      friendly_name: 'rm-target', member_type: 'remote', host: '10.0.0.9', port: 22,
      username: 'u', auth_type: 'password', password: '{{secret.rmlive}}',
      work_folder: '/home/u/work', llm_provider: 'claude', fleet_install: 'skip',
      cloud_region: 'us-east-1', cloud_idle_timeout_min: 30,
    } as any);
    expect(out).toContain('live secret');
    expect(out).toContain('NOT registered');
    expect(fs.readFileSync(credentialsPath()).equals(before)).toBe(true);
  });

  it('leaves no temp files in the data dir', () => {
    register('tidy');
    expect(fs.readdirSync(dataDir).sort()).toEqual(['credentials.json', 'salt']);
  });
});
