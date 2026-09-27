import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { FLEET_DIR } from '../../src/paths.js';
import { decryptPassword } from '../../src/utils/crypto.js';

let tmpDir: string;
const configPath = path.join(FLEET_DIR, 'knowledge', 'config.json');

// FLEET_DIR is shared by every test file in the run, and getKbProviders
// reselects the project provider whenever this config changes. Every test here
// starts from no config and puts back whatever was there, so an http remote
// written here (some deliberately unroutable) never becomes the provider a
// later file's getKbProviders() selects.
let savedConfig: string | null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-setup-test-'));
  fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
  savedConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
  fs.rmSync(configPath, { force: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedConfig === null) fs.rmSync(configPath, { force: true });
  else fs.writeFileSync(configPath, savedConfig);
});

function readConfig(): Record<string, any> {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function writeConfig(content: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, content);
}

describe('kb_setup', () => {
  it('installs post-commit hook in repo', async () => {
    const result = JSON.parse(await kbSetup({ repo_path: tmpDir }));
    expect(result.success).toBe(true);
    const hookPath = path.join(tmpDir, '.git', 'hooks', 'post-commit');
    expect(fs.existsSync(hookPath)).toBe(true);
    const hookContent = fs.readFileSync(hookPath, 'utf-8');
    expect(hookContent).toContain('kb invalidate');
  });

  it('writes config file with provider', async () => {
    const result = JSON.parse(await kbSetup({ repo_path: tmpDir, provider: 'sqlite' }));
    expect(result.success).toBe(true);
    expect(result.steps.some((s: string) => s.includes('config'))).toBe(true);
  });

  it('stores remote token encrypted (never plaintext)', async () => {
    const result = JSON.parse(await kbSetup({
      repo_path: tmpDir,
      provider: 'http',
      remote: 'http://localhost:7878',
      token: 'secret-token-123',
    }));
    expect(result.success).toBe(true);
    expect(result.steps.some((s: string) => s.includes('encrypted'))).toBe(true);

    // Assert on the file kb_setup actually WROTE, not on its return value. The
    // returned steps array never carries the token under any implementation, so
    // asserting against it cannot fail -- it would stay green if kbSetup wrote
    // config.token = input.token verbatim. The stored config is where the
    // plaintext-leak risk lives, so that is what has to be read back.
    const stored = fs.readFileSync(configPath, 'utf-8');
    expect(stored).not.toContain('secret-token-123');
    expect(JSON.parse(stored).token_encrypted).toBeTruthy();
  });
});

// my-beads-db-u00.6: remote must parse as an http(s) URL, and plain http to a
// non-loopback host must surface a warning to the caller (the returned JSON is
// all an MCP caller sees), because the bearer token would go out in cleartext.
describe('kb_setup remote validation', () => {
  const hookPath = () => path.join(tmpDir, '.git', 'hooks', 'post-commit');

  function writeExistingConfig(): string {
    const content = JSON.stringify({ provider: 'sqlite', marker: crypto.randomUUID() });
    writeConfig(content);
    return content;
  }

  async function setupWith(remote: string, token = crypto.randomUUID()) {
    const raw = await kbSetup({ repo_path: tmpDir, provider: 'http', remote, token });
    return { raw, token, result: JSON.parse(raw) as { success: boolean; warnings: string[] } };
  }

  it.each([
    ['a non-URL string', 'not a url'],
    ['a scheme-less host:port (parses with protocol "localhost:")', 'localhost:7878'],
    ['a non-http(s) scheme', 'ftp://kb.example.com/'],
  ])('rejects %s, naming the field, before any side effect', async (_label, remote) => {
    const existing = writeExistingConfig();
    await expect(kbSetup({ repo_path: tmpDir, provider: 'http', remote, token: crypto.randomUUID() }))
      .rejects.toThrow(/kb_setup: remote /);
    expect(fs.existsSync(hookPath())).toBe(false);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(existing);
  });

  it('does not echo the raw remote (which may carry credentials) in the rejection', async () => {
    const secretish = `user-${crypto.randomUUID()}`;
    const err = await kbSetup({ repo_path: tmpDir, remote: `ftp://${secretish}@kb.example.com/` })
      .then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain(secretish);
  });

  it.each([
    'http://kb.example.com:7878',
    'http://10.0.0.5/',
    'http://localhost.example.com/',
    'http://127.0.0.1.nip.io/',
    'http://0.0.0.0:7878/',
  ])('warns on plain http to non-loopback %s, without the token, and still writes config', async (remote) => {
    const { raw, token, result } = await setupWith(remote);
    expect(result.success).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/plain http to non-loopback host/);
    expect(result.warnings[0]).toContain(new URL(remote).hostname);
    expect(raw).not.toContain(token);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).url).toBe(remote);
  });

  it.each([
    'http://127.0.0.1:7878',
    'http://127.5.6.7/',
    'http://localhost:7878',
    'http://LOCALHOST/',
    'http://[::1]:7878',
    'http://2130706433/',
    'https://kb.example.com/',
    'https://10.0.0.5:8443/',
  ])('does not warn for %s', async (remote) => {
    const { result } = await setupWith(remote);
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

// my-beads-db-0d3.3: kb_setup merges the keys it owns into the existing config
// instead of replacing the file, which used to drop bible.autoCommit (read by
// kb_export from this same file) on every run.
describe('kb_setup merges into the existing config', () => {
  const REMOTE_A = 'https://kb-a.example.com/';
  const REMOTE_B = 'https://kb-b.example.com/';

  type SetupResult = { success: boolean; warnings: string[] };
  async function setup(input: Parameters<typeof kbSetup>[0]): Promise<SetupResult> {
    return JSON.parse(await kbSetup({ repo_path: tmpDir, ...input }));
  }

  it('keeps bible.autoCommit and unknown keys when pointing at a remote', async () => {
    const marker = crypto.randomUUID();
    writeConfig(JSON.stringify({ provider: 'sqlite', bible: { autoCommit: true }, extra: marker }));

    await setup({ remote: REMOTE_A, token: crypto.randomUUID() });

    const stored = readConfig();
    expect(stored.bible).toEqual({ autoCommit: true });
    expect(stored.extra).toBe(marker);
    expect(stored.provider).toBe('http');
    expect(stored.url).toBe(REMOTE_A);
  });

  it('keeps the stored token when re-run for the same remote without a token', async () => {
    const token = crypto.randomUUID();
    await setup({ remote: REMOTE_A, token });

    const result = await setup({ remote: REMOTE_A });

    expect(result.warnings).toEqual([]);
    expect(decryptPassword(readConfig().token_encrypted)).toBe(token);
  });

  it('keeps the remote, provider and token when re-run bare (hook install only)', async () => {
    const token = crypto.randomUUID();
    await setup({ remote: REMOTE_A, token });

    const result = await setup({});

    expect(result.warnings).toEqual([]);
    const stored = readConfig();
    expect(stored.provider).toBe('http');
    expect(stored.url).toBe(REMOTE_A);
    expect(decryptPassword(stored.token_encrypted)).toBe(token);
  });

  it('drops the old token, with a warning, when the remote changes without a token', async () => {
    await setup({ remote: REMOTE_A, token: crypto.randomUUID() });

    const result = await setup({ remote: REMOTE_B });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/remote changed and no token was given/);
    const stored = readConfig();
    expect(stored.url).toBe(REMOTE_B);
    expect(stored).not.toHaveProperty('token_encrypted');
  });

  it('stores the new token when the remote changes with a token', async () => {
    await setup({ remote: REMOTE_A, token: crypto.randomUUID() });
    const tokenB = crypto.randomUUID();

    const result = await setup({ remote: REMOTE_B, token: tokenB });

    expect(result.warnings).toEqual([]);
    expect(decryptPassword(readConfig().token_encrypted)).toBe(tokenB);
  });

  it('writes provider sqlite into a fresh config', async () => {
    await setup({});

    expect(readConfig()).toEqual({ provider: 'sqlite' });
  });

  it.each([
    ['invalid JSON', '{ this is not json'],
    ['a JSON array', '["provider", "http"]'],
    ['JSON null', 'null'],
  ])('replaces %s with a valid config and reports it, without throwing', async (_label, content) => {
    writeConfig(content);

    const result = await setup({ provider: 'sqlite' });

    expect(result.success).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/was discarded because it is not/);
    expect(readConfig()).toEqual({ provider: 'sqlite' });
  });

  // POSIX permission bits only: on Windows fs.chmodSync can only toggle the
  // read-only flag, so a 0o600 check there is meaningless.
  it.skipIf(process.platform === 'win32')('rewrites an existing world-readable config at mode 0o600', async () => {
    writeConfig(JSON.stringify({ provider: 'sqlite' }));
    fs.chmodSync(configPath, 0o644);

    await setup({ remote: REMOTE_A, token: crypto.randomUUID() });

    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });
});
