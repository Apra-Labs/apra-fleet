import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir, getLogger } from './config.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

function getSaltPath(): string {
  return path.join(getDataDir(), 'salt');
}

function getCredentialsPath(): string {
  return path.join(getDataDir(), 'credentials.json');
}

function getOrCreateKey(): Buffer {
  const saltPath = getSaltPath();
  try {
    if (fs.existsSync(saltPath)) {
      return Buffer.from(fs.readFileSync(saltPath, 'utf-8').trim(), 'hex');
    }
  } catch {
    // Fall through to create new key
  }

  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
  const key = crypto.randomBytes(KEY_LENGTH);
  fs.writeFileSync(saltPath, key.toString('hex'), { mode: 0o600 });

  const credentialsPath = getCredentialsPath();
  if (fs.existsSync(credentialsPath)) {
    fs.renameSync(credentialsPath, credentialsPath + '.bak');
    getLogger().warn(
      'crypto',
      'Encryption key upgraded to random persistent key. ' +
      'Existing stored credentials could not be migrated and have been backed up to credentials.json.bak. ' +
      'Please re-enter any stored secrets via credential_store_set.',
    );
  }

  return key;
}

export function encryptPassword(plaintext: string): string {
  const key = getOrCreateKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decryptPassword(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length < 3 || !parts[0] || !parts[1]) {
    throw new Error('Invalid ciphertext format: expected iv:authTag:encrypted');
  }
  const [ivHex, authTagHex, encrypted] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const key = getOrCreateKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
