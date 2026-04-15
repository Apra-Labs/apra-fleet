import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { encryptPassword, decryptPassword } from '../src/utils/crypto.js';
import { FLEET_DIR } from '../src/paths.js';

const KEY_PATH = path.join(FLEET_DIR, 'salt');

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

  it('creates and reuses a per-installation key file', () => {
    // First encryption call creates the key file if it does not exist
    encryptPassword('init');

    expect(fs.existsSync(KEY_PATH)).toBe(true);
    const key1 = fs.readFileSync(KEY_PATH, 'utf-8').trim();
    expect(key1).toHaveLength(64); // 32 random bytes, hex-encoded
    expect(/^[0-9a-f]+$/.test(key1)).toBe(true);

    // Key stays consistent across subsequent calls
    const encrypted = encryptPassword('test-consistent');
    const key2 = fs.readFileSync(KEY_PATH, 'utf-8').trim();
    expect(key1).toBe(key2);
    expect(decryptPassword(encrypted)).toBe('test-consistent');
  });
});
