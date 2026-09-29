import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readKbConfigFromDisk } from '../../src/services/knowledge/kb-config.js';
import { encryptPassword } from '../../src/utils/crypto.js';
import { FLEET_DIR } from '../../src/paths.js';

const KB_CONFIG_DIR = path.join(FLEET_DIR, 'knowledge');
const KB_CONFIG_PATH = path.join(KB_CONFIG_DIR, 'config.json');

function writeConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify(config, null, 2));
}

function writeRawConfig(raw: string): void {
  fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(KB_CONFIG_PATH, raw);
}

beforeEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
});

afterEach(() => {
  fs.rmSync(KB_CONFIG_PATH, { force: true });
});

describe('readKbConfigFromDisk', () => {
  it('returns the sqlite default when the config file is absent, no throw', () => {
    expect(fs.existsSync(KB_CONFIG_PATH)).toBe(false);
    expect(readKbConfigFromDisk()).toEqual({ provider: 'sqlite' });
  });

  it('returns sqlite and does not touch a corrupt token_encrypted when provider is sqlite', () => {
    writeConfig({ provider: 'sqlite', token_encrypted: 'aa:bb:cc' });
    expect(readKbConfigFromDisk()).toEqual({ provider: 'sqlite' });
  });

  it('returns sqlite and does not touch a corrupt token_encrypted when provider key is absent', () => {
    writeConfig({ token_encrypted: 'aa:bb:cc' });
    expect(readKbConfigFromDisk()).toEqual({ provider: 'sqlite' });
  });

  it('returns provider http with url and decrypted token when config is well-formed', () => {
    const tokenEncrypted = encryptPassword('super-secret-token');
    writeConfig({ provider: 'http', url: 'http://kb.example.internal:7878', token_encrypted: tokenEncrypted });
    expect(readKbConfigFromDisk()).toEqual({
      provider: 'http',
      url: 'http://kb.example.internal:7878',
      token: 'super-secret-token',
    });
  });

  it('throws naming the config path and the missing key when provider is http but url is missing', () => {
    writeConfig({ provider: 'http', token_encrypted: encryptPassword('token') });
    expect(() => readKbConfigFromDisk()).toThrowError(/url/);
    expect(() => readKbConfigFromDisk()).toThrowError(new RegExp(KB_CONFIG_PATH.replace(/\\/g, '\\\\')));
  });

  it('throws naming the config path and the missing key when provider is http but token_encrypted is missing', () => {
    writeConfig({ provider: 'http', url: 'http://kb.example.internal:7878' });
    expect(() => readKbConfigFromDisk()).toThrowError(/token_encrypted/);
  });

  it('throws, never downgrades to sqlite, when provider is http but token_encrypted fails to decrypt', () => {
    writeConfig({ provider: 'http', url: 'http://kb.example.internal:7878', token_encrypted: 'aa:bb:cc' });
    expect(() => readKbConfigFromDisk()).toThrowError(/token_encrypted/);
  });

  it('throws naming the config path when the file contains malformed JSON', () => {
    writeRawConfig('{ this is not valid json');
    expect(() => readKbConfigFromDisk()).toThrowError(new RegExp(KB_CONFIG_PATH.replace(/\\/g, '\\\\')));
  });
});
