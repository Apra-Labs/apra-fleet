import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { encryptPassword, decryptPassword } from '../src/utils/crypto.js';

const SALT_PATH = path.join(
  process.env.APRA_FLEET_DATA_DIR ?? path.join(os.homedir(), '.apra-fleet', 'data'),
  'salt',
);

describe('crypto', () => {
  it('encrypts and decrypts a password round-trip', () => {
    const original = 'my-secret-password-123!@#';
    const encrypted = encryptPassword(original);
    expect(decryptPassword(encrypted)).toBe(original);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const password = 'same-password';
    const enc1 = encryptPassword(password);
    const enc2 = encryptPassword(password);

    expect(enc1).not.toBe(enc2);
    expect(decryptPassword(enc1)).toBe(password);
    expect(decryptPassword(enc2)).toBe(password);
  });

  it('handles edge cases: empty string and unicode', () => {
    expect(decryptPassword(encryptPassword(''))).toBe('');
    const unicode = '密码パスワード🔑';
    expect(decryptPassword(encryptPassword(unicode))).toBe(unicode);
  });

  it('throws on tampered ciphertext', () => {
    const encrypted = encryptPassword('secret');
    const parts = encrypted.split(':');
    const firstByte = parseInt(parts[2].slice(0, 2), 16);
    const tamperedByte = ((firstByte ^ 0xff) || 0x01).toString(16).padStart(2, '0');
    parts[2] = tamperedByte + parts[2].slice(2);
    expect(() => decryptPassword(parts.join(':'))).toThrow();
  });

  it('creates and reuses a per-installation salt file', () => {
    expect(fs.existsSync(SALT_PATH)).toBe(true);
    const salt = fs.readFileSync(SALT_PATH, 'utf-8').trim();
    expect(salt).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(salt)).toBe(true);

    // Salt stays consistent across calls
    const encrypted = encryptPassword('test-consistent');
    const salt2 = fs.readFileSync(SALT_PATH, 'utf-8').trim();
    expect(salt).toBe(salt2);
    expect(decryptPassword(encrypted)).toBe('test-consistent');
  });
});
