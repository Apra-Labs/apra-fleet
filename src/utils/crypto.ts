import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const LEGACY_SALT = 'claude-fleet-salt';

const FLEET_DIR = path.join(os.homedir(), '.claude-fleet');
const SALT_PATH = path.join(FLEET_DIR, 'salt');

/**
 * Get or create a per-installation random salt.
 * The salt is stored in ~/.claude-fleet/salt (32 random bytes, hex-encoded).
 */
function getOrCreateSalt(): string {
  try {
    if (fs.existsSync(SALT_PATH)) {
      return fs.readFileSync(SALT_PATH, 'utf-8').trim();
    }
  } catch {
    // Fall through to create new salt
  }

  if (!fs.existsSync(FLEET_DIR)) {
    fs.mkdirSync(FLEET_DIR, { recursive: true, mode: 0o700 });
  }
  const salt = crypto.randomBytes(SALT_LENGTH).toString('hex');
  fs.writeFileSync(SALT_PATH, salt, { mode: 0o600 });
  return salt;
}

function deriveKey(salt?: string): Buffer {
  const machineId = `${os.hostname()}-${os.userInfo().username}-claude-fleet`;
  const actualSalt = salt ?? getOrCreateSalt();
  return crypto.scryptSync(machineId, actualSalt, KEY_LENGTH);
}

/**
 * Derive a key using the legacy static salt (for backward compatibility).
 */
function deriveLegacyKey(): Buffer {
  return deriveKey(LEGACY_SALT);
}

export function encryptPassword(plaintext: string): string {
  const key = deriveKey();
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

  // Try with per-installation salt first
  try {
    const key = deriveKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    // Fall back to legacy static salt for backward compatibility
    const legacyKey = deriveLegacyKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, legacyKey, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
