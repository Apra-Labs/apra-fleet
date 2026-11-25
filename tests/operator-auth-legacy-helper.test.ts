/**
 * `apra-fleet operator-auth github` on a host upgraded from 0.4.5 or older:
 * the global credential.https://github.com.helper key still holds the empty
 * reset entry, fleet's legacy helper path (whose file carries a stale token)
 * and a foreign value. Setup must remove ONLY fleet's legacy value, keep the
 * foreign one, register the refreshing fleet helper, and be idempotent.
 *
 * In-process only: HOME/USERPROFILE/GIT_CONFIG_GLOBAL point at a temp dir whose
 * path holds a space (and, on POSIX, an apostrophe), FLEET_DIR is the per-run
 * test data dir, fetch is stubbed. git is run only against the temp global
 * config (config reads/writes, never `git credential fill`).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { FLEET_DIR } from './test-helpers.js';
import { runGitCredential, runOperatorAuth, operatorTokenCachePath, OPERATOR_HELPER_KEY } from '../src/cli/operator-auth.js';

const GIT_CONFIG_PATH = path.join(FLEET_DIR, 'git-config.json');
const RECORD_PATH = path.join(FLEET_DIR, 'operator-auth.json');
const FOREIGN = '!gh auth git-credential';
const STALE_TOKEN = 'ghs_STALElegacyTOKEN000';
const FRESH_TOKEN = 'ghs_FRESHmintedTOKEN111';

let root: string;
let home: string;
let globalConfig: string;
let systemConfig: string;
const SYSTEM_HELPER = 'system-stub-helper';
let legacyValue: string;
let selfCommand: string[];
let savedEnv: Record<string, string | undefined>;
let gitConfigBackup: string | null = null;
let fetchCalls = 0;

function getAll(): string[] {
  try {
    return execFileSync('git', ['config', '--global', '-z', '--get-all', OPERATOR_HELPER_KEY], { encoding: 'utf8' })
      .split('\0').slice(0, -1);
  } catch (err) {
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

function io(stdinText = '') {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out, err,
    io: {
      readStdin: async () => stdinText,
      stdout: (s: string) => { out.push(s); },
      stderr: (s: string) => { err.push(s); },
      selfCommand,
    },
  };
}

/** Split a POSIX shell command line (as git's `!` helper shell would) into words. */
function shellWords(s: string): string[] {
  const words: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Error('unterminated quote');
      cur = (cur ?? '') + s.slice(i + 1, end);
      i = end;
    } else if (c === '\\') {
      cur = (cur ?? '') + s[++i];
    } else if (c === ' ' || c === '\t') {
      if (cur !== null) { words.push(cur); cur = null; }
    } else {
      cur = (cur ?? '') + c;
    }
  }
  if (cur !== null) words.push(cur);
  return words;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'op-legacy-'));
  home = path.join(root, process.platform === 'win32' ? 'home dir' : "home dir's");
  fs.mkdirSync(home, { recursive: true });
  globalConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  // A temp system config holding a generic helper, standing in for the
  // credential.helper a Git for Windows install sets system-wide.
  systemConfig = path.join(root, 'gitconfig-system');
  fs.writeFileSync(systemConfig, `[credential]\n\thelper = ${SYSTEM_HELPER}\n`);
  savedEnv = {
    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_SYSTEM = systemConfig;

  // The legacy helper exactly as 0.4.5 and older wrote it (docs/design-git-auth.md).
  const stem = '.fleet-git-credential-github';
  const legacyFile = process.platform === 'win32' ? path.join(home, `${stem}.bat`) : path.join(home, stem);
  legacyValue = process.platform === 'win32' ? `${home.replace(/\\/g, '/')}/${stem}.bat` : `${home}/${stem}`;
  fs.writeFileSync(legacyFile, process.platform === 'win32'
    ? `@echo off\r\necho protocol=https\r\necho host=github.com\r\necho username=x-access-token\r\necho password=${STALE_TOKEN}\r\n`
    : `#!/bin/sh\necho "protocol=https"\necho "host=github.com"\necho "username=x-access-token"\necho "password=${STALE_TOKEN}"\n`);
  for (const v of ['', legacyValue, FOREIGN]) {
    execFileSync('git', ['config', '--global', '--add', OPERATOR_HELPER_KEY, v]);
  }

  // A stub "fleet binary" inside the temp home (never the real one).
  selfCommand = [path.join(home, 'bin', 'apra-fleet')];

  if (fs.existsSync(GIT_CONFIG_PATH)) gitConfigBackup = fs.readFileSync(GIT_CONFIG_PATH, 'utf8');
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const keyPath = path.join(root, 'app.pem');
  fs.writeFileSync(keyPath, privateKey);
  fs.mkdirSync(FLEET_DIR, { recursive: true });
  fs.writeFileSync(GIT_CONFIG_PATH, JSON.stringify({
    version: '1.0',
    github: { appId: '777', privateKeyPath: keyPath, installationId: 99, createdAt: new Date().toISOString() },
  }));
  fs.rmSync(RECORD_PATH, { force: true });
  fs.rmSync(operatorTokenCachePath('github'), { force: true });

  vi.stubGlobal('fetch', vi.fn(async () => {
    fetchCalls++;
    return { ok: true, status: 201, json: async () => ({ token: FRESH_TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() }) };
  }));
});

afterAll(() => {
  vi.unstubAllGlobals();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (gitConfigBackup !== null) fs.writeFileSync(GIT_CONFIG_PATH, gitConfigBackup);
  else fs.rmSync(GIT_CONFIG_PATH, { force: true });
  fs.rmSync(RECORD_PATH, { force: true });
  fs.rmSync(operatorTokenCachePath('github'), { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('operator-auth github on an upgraded host with a stale legacy global helper', () => {
  let helperValue = '';

  it('1: removes only fleet\'s legacy value, keeps the foreign one, and registers the fleet git-credential helper', async () => {
    expect(getAll()).toEqual(['', legacyValue, FOREIGN]);
    const a = io();
    expect(await runOperatorAuth(['github'], a.io)).toBe(0);
    const values = getAll();
    expect(values).not.toContain(legacyValue);
    expect(values).toContain(FOREIGN);
    // The empty reset entry stays: a non-fleet value is still on the key.
    expect(values[0]).toBe('');
    const ours = values.filter(v => v.includes('git-credential --label github') && v !== FOREIGN);
    expect(ours).toHaveLength(1);
    helperValue = ours[0];
    expect(a.out.join('')).toMatch(/Removed 1 legacy fleet helper value/);
    expect(a.out.join('')).toContain('GH_TOKEN=');
  });

  it('2: a second run leaves the global config and the record byte-identical', async () => {
    const configBefore = fs.readFileSync(globalConfig);
    const recordBefore = fs.readFileSync(RECORD_PATH);
    const a = io();
    expect(await runOperatorAuth(['github'], a.io)).toBe(0);
    expect(fs.readFileSync(globalConfig).equals(configBefore)).toBe(true);
    expect(fs.readFileSync(RECORD_PATH).equals(recordBefore)).toBe(true);
    expect(a.out.join('')).toContain('nothing changed');
  });

  it('3: the git-credential handler returns the freshly minted token, not the stale legacy one', async () => {
    const a = io('protocol=https\nhost=github.com\n\n');
    expect(await runGitCredential(['--label', 'github', 'get'], a.io)).toBe(0);
    const out = a.out.join('');
    expect(out).toContain(`password=${FRESH_TOKEN}\n`);
    expect(out).not.toContain(STALE_TOKEN);
    expect(fetchCalls).toBe(1);
  });

  it('5: the helper value round-trips through shell quoting to the absolute binary path and arguments', () => {
    expect(helperValue.startsWith('!')).toBe(true);
    const words = shellWords(helperValue.slice(1));
    const expectedBinary = process.platform === 'win32' ? selfCommand[0].replace(/\\/g, '/') : selfCommand[0];
    expect(words).toEqual([expectedBinary, 'git-credential', '--label', 'github']);
    expect(path.isAbsolute(words[0])).toBe(true);
    if (process.platform !== 'win32') {
      // The real POSIX shell agrees with the parse (git runs `!` helpers through sh).
      const printed = execFileSync('sh', ['-c', `set -- ${helperValue.slice(1)}; printf '%s\\n' "$@"`], { encoding: 'utf8' });
      expect(printed.split('\n').slice(0, -1)).toEqual(words);
    }
  });

  it('4: --remove removes only the fleet helper it added', async () => {
    const a = io();
    expect(await runOperatorAuth(['github', '--remove'], a.io)).toBe(0);
    expect(getAll()).toEqual(['', FOREIGN]);
    expect(fs.existsSync(RECORD_PATH) ? JSON.parse(fs.readFileSync(RECORD_PATH, 'utf8')).github.github : undefined).toBeUndefined();

    const b = io('protocol=https\nhost=github.com\n\n');
    expect(await runGitCredential(['get'], b.io)).not.toBe(0);
    expect(b.err.join('')).toContain('apra-fleet operator-auth github');
  });
});

/** Replace the temp global helper key with `values` and drop the operator record. */
function resetGlobal(values: string[]): void {
  fs.writeFileSync(globalConfig, '');
  for (const v of values) execFileSync('git', ['config', '--global', '--add', OPERATOR_HELPER_KEY, v]);
  fs.rmSync(RECORD_PATH, { force: true });
}

describe('operator-auth github keeps an empty reset entry ahead of the fleet helper', () => {
  it('6: reset + legacy only: the reset stays first, the fleet helper follows, a rerun is byte-identical, --remove clears both', async () => {
    resetGlobal(['', legacyValue]);
    const a = io();
    expect(await runOperatorAuth(['github'], a.io)).toBe(0);
    const values = getAll();
    expect(values).toHaveLength(2);
    expect(values[0]).toBe('');
    expect(values[1]).toContain('git-credential --label github');
    // The system helper is reset for github.com, so nothing is asked first.
    expect(a.out.join('')).not.toMatch(/asked before it/);

    const configBefore = fs.readFileSync(globalConfig);
    const recordBefore = fs.readFileSync(RECORD_PATH);
    const b = io();
    expect(await runOperatorAuth(['github'], b.io)).toBe(0);
    expect(fs.readFileSync(globalConfig).equals(configBefore)).toBe(true);
    expect(fs.readFileSync(RECORD_PATH).equals(recordBefore)).toBe(true);
    expect(b.out.join('')).toContain('nothing changed');

    const c = io();
    expect(await runOperatorAuth(['github', '--remove'], c.io)).toBe(0);
    expect(getAll()).toEqual([]);
  });

  it('7: a foreign value with no reset keeps its place after a reset put first, ahead of the fleet helper', async () => {
    resetGlobal([FOREIGN]);
    const a = io();
    expect(await runOperatorAuth(['github'], a.io)).toBe(0);
    const values = getAll();
    expect(values.slice(0, 2)).toEqual(['', FOREIGN]);
    expect(values).toHaveLength(3);
    expect(values[2]).toContain('git-credential --label github');
    // Only the foreign URL-scoped value is asked first; the system one is reset.
    expect(a.out.join('')).toMatch(/Note: 1 other helper\(s\) are asked before it/);

    const c = io();
    expect(await runOperatorAuth(['github', '--remove'], c.io)).toBe(0);
    // Only what setup added goes: the helper and the reset it put first.
    expect(getAll()).toEqual([FOREIGN]);
  });
});
