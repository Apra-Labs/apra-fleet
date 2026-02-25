import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { encryptPassword, decryptPassword } from '../src/utils/crypto.js';

const FLEET_DIR = path.join(os.homedir(), '.claude-fleet');
const SALT_PATH = path.join(FLEET_DIR, 'salt');

describe('crypto', () => {
  it('encrypts and decrypts a password round-trip', () => {
    const original = 'my-secret-password-123!@#';
    const encrypted = encryptPassword(original);
    const decrypted = decryptPassword(encrypted);

    expect(decrypted).toBe(original);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const password = 'same-password';
    const enc1 = encryptPassword(password);
    const enc2 = encryptPassword(password);

    expect(enc1).not.toBe(enc2);
    expect(decryptPassword(enc1)).toBe(password);
    expect(decryptPassword(enc2)).toBe(password);
  });

  it('encrypted output has three colon-separated hex parts (iv:tag:data)', () => {
    const encrypted = encryptPassword('test');
    const parts = encrypted.split(':');

    expect(parts).toHaveLength(3);
    // IV is 16 bytes = 32 hex chars
    expect(parts[0]).toHaveLength(32);
    // Auth tag is 16 bytes = 32 hex chars
    expect(parts[1]).toHaveLength(32);
    // Data should be non-empty hex
    expect(parts[2].length).toBeGreaterThan(0);
    expect(/^[0-9a-f]+$/.test(parts[2])).toBe(true);
  });

  it('handles empty string', () => {
    const encrypted = encryptPassword('');
    const decrypted = decryptPassword(encrypted);
    expect(decrypted).toBe('');
  });

  it('handles unicode characters', () => {
    const password = '密码パスワード🔑';
    const encrypted = encryptPassword(password);
    const decrypted = decryptPassword(encrypted);
    expect(decrypted).toBe(password);
  });

  it('handles long passwords', () => {
    const password = 'a'.repeat(10000);
    const encrypted = encryptPassword(password);
    const decrypted = decryptPassword(encrypted);
    expect(decrypted).toBe(password);
  });

  it('throws on tampered ciphertext', () => {
    const encrypted = encryptPassword('secret');
    const parts = encrypted.split(':');
    // Tamper with the encrypted data
    parts[2] = 'ff' + parts[2].slice(2);
    const tampered = parts.join(':');

    expect(() => decryptPassword(tampered)).toThrow();
  });

  it('creates a salt file on first encryption', () => {
    // The salt file should exist after any encrypt/decrypt call
    expect(fs.existsSync(SALT_PATH)).toBe(true);
    const salt = fs.readFileSync(SALT_PATH, 'utf-8').trim();
    // 32 random bytes = 64 hex chars
    expect(salt).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(salt)).toBe(true);
  });

  it('uses consistent salt across encrypt/decrypt cycles', () => {
    const salt1 = fs.readFileSync(SALT_PATH, 'utf-8').trim();
    const encrypted = encryptPassword('test-consistent');
    const salt2 = fs.readFileSync(SALT_PATH, 'utf-8').trim();
    expect(salt1).toBe(salt2);
    expect(decryptPassword(encrypted)).toBe('test-consistent');
  });
});
