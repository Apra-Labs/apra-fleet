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
    expect(readKbConfigFromDisk()).toEqual({ provider: 'sqlite', offlineFallback: 'local' });
  });

  it('returns sqlite and does not touch a corrupt token_encrypted when provider is sqlite', () => {
    writeConfig({ provider: 'sqlite', token_encrypted: 'aa:bb:cc' });
    expect(readKbConfigFromDisk()).toEqual({ provider: 'sqlite', offlineFallback: 'local' });
  });

  it('returns sqlite and does not touch a corrupt token_encrypted when provider key is absent', () => {
    writeConfig({ token_encrypted: 'aa:bb:cc' });
    expect(readKbConfigFromDisk()).toEqual({ provider: 'sqlite', offlineFallback: 'local' });
  });

  // apra-fleet-i9ag.15.13.2 (review fix): offline_fallback is validated BEFORE
  // the provider branch, so a stale/typo'd value left over from an earlier
  // http config is no longer silently ignored just because the file currently
  // says "sqlite" -- it fails loudly at config load like every other invalid
  // value, per KbConfigResult's "always resolved to a concrete value" contract.
  it('throws naming the config path and the invalid value when offline_fallback is invalid even though provider is sqlite', () => {
    writeConfig({ provider: 'sqlite', offline_fallback: 'ignore-errors' });
    expect(() => readKbConfigFromDisk()).toThrowError(/offline_fallback/);
    expect(() => readKbConfigFromDisk()).toThrowError(/ignore-errors/);
  });

  it('returns provider http with url and decrypted token when config is well-formed', () => {
    const tokenEncrypted = encryptPassword('super-secret-token');
    writeConfig({ provider: 'http', url: 'http://kb.example.internal:7878', token_encrypted: tokenEncrypted });
    expect(readKbConfigFromDisk()).toEqual({
      provider: 'http',
      url: 'http://kb.example.internal:7878',
      token: 'super-secret-token',
      offlineFallback: 'local',
    });
  });

  // apra-fleet-i9ag.15.13.2: offline_fallback is explicit, persisted, and
  // defaulted -- absent key resolves to 'local' (proven above), a valid
  // 'error' value passes through, and an unrecognised value fails loudly
  // rather than silently defaulting.
  it('returns offlineFallback "error" when the config explicitly opts in', () => {
    const tokenEncrypted = encryptPassword('super-secret-token');
    writeConfig({
      provider: 'http',
      url: 'http://kb.example.internal:7878',
      token_encrypted: tokenEncrypted,
      offline_fallback: 'error',
    });
    expect(readKbConfigFromDisk()).toEqual({
      provider: 'http',
      url: 'http://kb.example.internal:7878',
      token: 'super-secret-token',
      offlineFallback: 'error',
    });
  });

  it('throws naming the config path and the invalid value when offline_fallback is neither "local" nor "error"', () => {
    const tokenEncrypted = encryptPassword('super-secret-token');
    writeConfig({
      provider: 'http',
      url: 'http://kb.example.internal:7878',
      token_encrypted: tokenEncrypted,
      offline_fallback: 'ignore-errors',
    });
    expect(() => readKbConfigFromDisk()).toThrowError(/offline_fallback/);
    expect(() => readKbConfigFromDisk()).toThrowError(/ignore-errors/);
    expect(() => readKbConfigFromDisk()).toThrowError(new RegExp(KB_CONFIG_PATH.replace(/\\/g, '\\\\')));
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
