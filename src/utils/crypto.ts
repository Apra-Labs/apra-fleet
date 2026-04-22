import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../paths.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_PATH = path.join(FLEET_DIR, 'salt');
const CREDENTIALS_PATH = path.join(FLEET_DIR, 'credentials.json');

/**
 * Get or create a per-installation random AES-256-GCM key.
 * The key is stored in ~/.apra-fleet/data/salt (32 random bytes, hex-encoded, mode 0o600).
 * On first run a fresh random key is generated; subsequent runs load from file.
 */
function getOrCreateKey(): Buffer {
  try {
    if (fs.existsSync(SALT_PATH)) {
      return Buffer.from(fs.readFileSync(SALT_PATH, 'utf-8').trim(), 'hex');
    }
  } catch {
    // Fall through to create new key
  }

  if (!fs.existsSync(FLEET_DIR)) {
    fs.mkdirSync(FLEET_DIR, { recursive: true, mode: 0o700 });
  }
  const key = crypto.randomBytes(KEY_LENGTH);
  fs.writeFileSync(SALT_PATH, key.toString('hex'), { mode: 0o600 });

  // Migration: if credentials.json already exists, it was encrypted with the
  // old deriveKey() scheme and cannot be decrypted with the new random key.
  // Back it up so the user's data isn't silently lost.
  if (fs.existsSync(CREDENTIALS_PATH)) {
    fs.renameSync(CREDENTIALS_PATH, CREDENTIALS_PATH + '.bak');
    console.warn(
      '[apra-fleet] Encryption key upgraded to random persistent key. ' +
      'Existing stored credentials could not be migrated and have been backed up to credentials.json.bak. ' +
      'Please re-enter any stored API keys via credential_store_set.',
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
  const [ivHex, authTagHex, encrypted] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const key = getOrCreateKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
