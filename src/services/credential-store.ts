import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { encryptPassword, decryptPassword } from '../utils/crypto.js';
import { enforceOwnerOnly } from '../utils/file-permissions.js';
import { FLEET_DIR } from '../paths.js';

// ---------------------------------------------------------------------------
// Session-tier encryption (AES-256-GCM, key lives only in this process)
// ---------------------------------------------------------------------------
const SESSION_KEY = crypto.randomBytes(32);
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

function sessionEncrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, SESSION_KEY, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function sessionDecrypt(ciphertext: string): string {
  const [ivHex, authTagHex, encrypted] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, SESSION_KEY, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface CredentialMeta {
  name: string;
  scope: 'session' | 'persistent';
  network_policy: 'allow' | 'confirm' | 'deny';
  created_at: string;
}

interface SessionEntry extends CredentialMeta {
  scope: 'session';
  encryptedValue: string;
}

interface PersistentRecord {
  name: string;
  network_policy: 'allow' | 'confirm' | 'deny';
  created_at: string;
  encryptedValue: string;
}

interface CredentialFile {
  version: string;
  credentials: Record<string, PersistentRecord>;
}

// ---------------------------------------------------------------------------
// Session store (in-memory)
// ---------------------------------------------------------------------------
const sessionStore = new Map<string, SessionEntry>();

// ---------------------------------------------------------------------------
// Persistent store (credentials.json)
// ---------------------------------------------------------------------------
const CREDENTIALS_PATH = path.join(FLEET_DIR, 'credentials.json');

function loadCredentialFile(): CredentialFile {
  if (!fs.existsSync(FLEET_DIR)) {
    fs.mkdirSync(FLEET_DIR, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    return { version: '1.0', credentials: {} };
  }
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8')) as CredentialFile;
}

function saveCredentialFile(file: CredentialFile): void {
  if (!fs.existsSync(FLEET_DIR)) {
    fs.mkdirSync(FLEET_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(file, null, 2), { mode: 0o600 });
  enforceOwnerOnly(CREDENTIALS_PATH);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function credentialSet(
  name: string,
  plaintext: string,
  persist: boolean,
  network_policy: 'allow' | 'confirm' | 'deny',
): CredentialMeta {
  const created_at = new Date().toISOString();

  if (persist) {
    const file = loadCredentialFile();
    file.credentials[name] = { name, network_policy, created_at, encryptedValue: encryptPassword(plaintext) };
    saveCredentialFile(file);
    // Persistent supersedes session
    sessionStore.delete(name);
    return { name, scope: 'persistent', network_policy, created_at };
  }

  sessionStore.set(name, {
    name,
    scope: 'session',
    network_policy,
    created_at,
    encryptedValue: sessionEncrypt(plaintext),
  });
  return { name, scope: 'session', network_policy, created_at };
}

export function credentialList(): CredentialMeta[] {
  const results: CredentialMeta[] = [];

  for (const entry of sessionStore.values()) {
    results.push({ name: entry.name, scope: entry.scope, network_policy: entry.network_policy, created_at: entry.created_at });
  }

  const file = loadCredentialFile();
  for (const record of Object.values(file.credentials)) {
    const existing = results.findIndex(r => r.name === record.name);
    const meta: CredentialMeta = { name: record.name, scope: 'persistent', network_policy: record.network_policy, created_at: record.created_at };
    if (existing !== -1) {
      results[existing] = meta;
    } else {
      results.push(meta);
    }
  }

  return results;
}

export function credentialDelete(name: string): boolean {
  if (sessionStore.has(name)) {
    sessionStore.delete(name);
    return true;
  }
  const file = loadCredentialFile();
  if (name in file.credentials) {
    delete file.credentials[name];
    saveCredentialFile(file);
    return true;
  }
  return false;
}

/**
 * Resolve a credential name to its plaintext value.
 * Persistent store takes precedence over session store.
 * Returns null if the credential does not exist.
 */
export function credentialResolve(name: string): { plaintext: string; meta: CredentialMeta } | null {
  // Persistent wins
  const file = loadCredentialFile();
  const persistent = file.credentials[name];
  if (persistent) {
    return {
      plaintext: decryptPassword(persistent.encryptedValue),
      meta: { name: persistent.name, scope: 'persistent', network_policy: persistent.network_policy, created_at: persistent.created_at },
    };
  }

  const session = sessionStore.get(name);
  if (session) {
    return {
      plaintext: sessionDecrypt(session.encryptedValue),
      meta: { name: session.name, scope: 'session', network_policy: session.network_policy, created_at: session.created_at },
    };
  }

  return null;
}
