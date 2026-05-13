import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initBlindfold, resetConfig } from '../src/config.js';
import { encryptPassword, decryptPassword } from '../src/crypto.js';

describe('crypto', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blindfold-crypto-'));
    resetConfig();
    initBlindfold({ dataDir: testDir });
  });

  afterEach(() => {
    resetConfig();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('encrypts and decrypts a password', () => {
    const plaintext = 'hunter2';
    const encrypted = encryptPassword(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted.split(':')).toHaveLength(3);
    expect(decryptPassword(encrypted)).toBe(plaintext);
  });

  it('produces different ciphertext for the same plaintext', () => {
    const plaintext = 'same-value';
    const a = encryptPassword(plaintext);
    const b = encryptPassword(plaintext);
    expect(a).not.toBe(b);
    expect(decryptPassword(a)).toBe(plaintext);
    expect(decryptPassword(b)).toBe(plaintext);
  });

  it('creates salt file with 0o600 permissions', () => {
    encryptPassword('trigger-salt-creation');
    const saltPath = path.join(testDir, 'salt');
    expect(fs.existsSync(saltPath)).toBe(true);
    if (process.platform !== 'win32') {
      const stat = fs.statSync(saltPath);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('persists key across calls', () => {
    const encrypted = encryptPassword('persist-test');
    // Decrypt should work because the same key file is used
    expect(decryptPassword(encrypted)).toBe('persist-test');
  });

  it('handles special characters in plaintext', () => {
    const specials = 'p@$$w0rd!#%^&*(){}[]|\\:";\'<>?,./~`';
    const encrypted = encryptPassword(specials);
    expect(decryptPassword(encrypted)).toBe(specials);
  });

  it('handles unicode in plaintext', () => {
    const unicode = '密码テスト🔐';
    const encrypted = encryptPassword(unicode);
    expect(decryptPassword(encrypted)).toBe(unicode);
  });

  it('handles empty string', () => {
    const encrypted = encryptPassword('');
    expect(decryptPassword(encrypted)).toBe('');
  });
});
