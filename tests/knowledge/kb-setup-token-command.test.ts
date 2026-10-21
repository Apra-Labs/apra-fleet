import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { kbSetup, kbSetupSchema } from '../../src/tools/kb-setup.js';
import { readKbConfigFromDisk } from '../../src/services/knowledge/kb-config.js';
import { FLEET_DIR } from '../../src/paths.js';
import { encryptPassword } from '../../src/utils/crypto.js';

// No mocks: real kbSetup writing the real config path, real readKbConfigFromDisk.
// The config file is saved and restored around every test (FLEET_DIR is shared).

const configPath = path.join(FLEET_DIR, 'knowledge', 'config.json');
const COMMAND = 'my-token-cli print-access-token --marker CMD_PLAINTEXT_MARKER';
const REMOTE = 'http://127.0.0.1:59999';

let tmpDir: string;
let savedConfig: string | null;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-setup-token-command-'));
  fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });
  savedConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
  fs.rmSync(configPath, { force: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedConfig === null) fs.rmSync(configPath, { force: true });
  else fs.writeFileSync(configPath, savedConfig);
});

function readConfig(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function setup(input: Parameters<typeof kbSetup>[0]): Promise<string> {
  return kbSetup(input, { folder: tmpDir });
}

describe('kb_setup token_command', () => {
  it('stores token_command_encrypted and never the plaintext command', async () => {
    await setup({ provider: 'http', remote: REMOTE, token_command: COMMAND });
    const raw = fs.readFileSync(configPath, 'utf-8');
    expect(raw).not.toContain('CMD_PLAINTEXT_MARKER');
    expect(raw).not.toContain('my-token-cli');
    const cfg = readConfig();
    expect(typeof cfg.token_command_encrypted).toBe('string');
    expect(cfg.token_encrypted).toBeUndefined();
  });

  it('refuses token and token_command together and leaves the config unchanged', async () => {
    await setup({ provider: 'http', remote: REMOTE, token: 'static-one' });
    const before = fs.readFileSync(configPath, 'utf-8');
    await expect(setup({ remote: REMOTE, token: 'x', token_command: COMMAND })).rejects.toThrow(/not both/);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('refuses both on a fresh install without creating a config file', async () => {
    await expect(setup({ provider: 'http', remote: REMOTE, token: 'x', token_command: COMMAND })).rejects.toThrow();
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('switching token -> token_command removes token_encrypted, and back', async () => {
    await setup({ provider: 'http', remote: REMOTE, token: 'static-one' });
    expect(readConfig().token_encrypted).toBeDefined();

    await setup({ remote: REMOTE, token_command: COMMAND, token_ttl_seconds: 60 });
    let cfg = readConfig();
    expect(cfg.token_encrypted).toBeUndefined();
    expect(cfg.token_command_encrypted).toBeDefined();
    expect(cfg.token_ttl_seconds).toBe(60);

    await setup({ remote: REMOTE, token: 'static-two' });
    cfg = readConfig();
    expect(cfg.token_command_encrypted).toBeUndefined();
    expect(cfg.token_ttl_seconds).toBeUndefined();
    expect(cfg.token_encrypted).toBeDefined();
  });

  it('changing remote with no new source drops token_command_encrypted with the existing warning', async () => {
    await setup({ provider: 'http', remote: REMOTE, token_command: COMMAND, token_ttl_seconds: 60 });
    const result = JSON.parse(await setup({ remote: 'http://127.0.0.1:59998' }));
    const cfg = readConfig();
    expect(cfg.token_command_encrypted).toBeUndefined();
    expect(cfg.token_ttl_seconds).toBeUndefined();
    expect(result.warnings.join('\n')).toContain('remote changed and no token was given');
  });

  it('keeps token_command_encrypted when the remote is unchanged', async () => {
    await setup({ provider: 'http', remote: REMOTE, token_command: COMMAND });
    await setup({ remote: REMOTE });
    expect(readConfig().token_command_encrypted).toBeDefined();
  });

  it('schema rejects a non-positive or non-integer token_ttl_seconds', () => {
    expect(kbSetupSchema.safeParse({ token_ttl_seconds: 0 }).success).toBe(false);
    expect(kbSetupSchema.safeParse({ token_ttl_seconds: 1.5 }).success).toBe(false);
    expect(kbSetupSchema.safeParse({ token_ttl_seconds: 30 }).success).toBe(true);
  });
});

describe('readKbConfigFromDisk with token_command', () => {
  it('returns tokenCommand and tokenTtlSeconds for a command config', async () => {
    await setup({ provider: 'http', remote: REMOTE, token_command: COMMAND, token_ttl_seconds: 123 });
    expect(readKbConfigFromDisk()).toEqual({
      provider: 'http', url: REMOTE, tokenCommand: COMMAND, tokenTtlSeconds: 123,
    });
  });

  it('defaults tokenTtlSeconds to 2700', async () => {
    await setup({ provider: 'http', remote: REMOTE, token_command: COMMAND });
    expect(readKbConfigFromDisk().tokenTtlSeconds).toBe(2700);
  });

  it('still returns a static token config unchanged', async () => {
    await setup({ provider: 'http', remote: REMOTE, token: 'static-one' });
    expect(readKbConfigFromDisk()).toEqual({ provider: 'http', url: REMOTE, token: 'static-one' });
  });

  it('throws naming token_encrypted when http has neither source', () => {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ provider: 'http', url: REMOTE }));
    expect(() => readKbConfigFromDisk()).toThrow(/token_encrypted/);
    expect(() => readKbConfigFromDisk()).toThrow(/token_command_encrypted/);
  });

  it('throws without echoing ciphertext when token_command_encrypted is undecryptable', () => {
    const bad = encryptPassword('some-command').slice(0, -6) + 'zzzzzz';
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ provider: 'http', url: REMOTE, token_command_encrypted: bad }));
    let message = '';
    try { readKbConfigFromDisk(); } catch (err) { message = (err as Error).message; }
    expect(message).toMatch(/undecryptable "token_command_encrypted"/);
    expect(message).not.toContain(bad);
    expect(message).not.toContain('some-command');
  });
});
