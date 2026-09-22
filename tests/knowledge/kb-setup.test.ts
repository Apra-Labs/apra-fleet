import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { FLEET_DIR } from '../../src/paths.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-setup-test-'));
  fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

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
    const configPath = path.join(FLEET_DIR, 'knowledge', 'config.json');
    const stored = fs.readFileSync(configPath, 'utf-8');
    expect(stored).not.toContain('secret-token-123');
    expect(JSON.parse(stored).token_encrypted).toBeTruthy();
  });
});

// my-beads-db-u00.6: remote must parse as an http(s) URL, and plain http to a
// non-loopback host must surface a warning to the caller (the returned JSON is
// all an MCP caller sees), because the bearer token would go out in cleartext.
describe('kb_setup remote validation', () => {
  const configPath = path.join(FLEET_DIR, 'knowledge', 'config.json');
  const hookPath = () => path.join(tmpDir, '.git', 'hooks', 'post-commit');

  // FLEET_DIR is shared by every test file in the run. Restore the config so
  // an http remote written here (some deliberately unroutable) never becomes
  // the provider a later file's getKbProviders() selects.
  let savedConfig: string | null;
  beforeEach(() => {
    savedConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
  });
  afterEach(() => {
    if (savedConfig === null) fs.rmSync(configPath, { force: true });
    else fs.writeFileSync(configPath, savedConfig);
  });

  function writeExistingConfig(): string {
    const content = JSON.stringify({ provider: 'sqlite', marker: crypto.randomUUID() });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, content);
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
