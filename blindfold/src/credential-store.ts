import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { encryptPassword, decryptPassword } from './crypto.js';
import { enforceOwnerOnly } from './file-permissions.js';
import { getDataDir } from './config.js';
import type { CredentialMeta, CredentialUpdatePatch, CredentialUpdateResult } from './types.js';

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
interface SessionEntry extends CredentialMeta {
  scope: 'session';
  encryptedValue: string;
}

interface PersistentRecord {
  name: string;
  network_policy: 'allow' | 'confirm' | 'deny';
  created_at: string;
  encryptedValue: string;
  allowedMembers: string[] | '*';
  expiresAt?: string;
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
function getCredentialsPath(): string {
  return path.join(getDataDir(), 'credentials.json');
}

function loadCredentialFile(): CredentialFile {
  const credentialsPath = getCredentialsPath();
  const dataDir = path.dirname(credentialsPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
  if (!fs.existsSync(credentialsPath)) {
    return { version: '1.0', credentials: {} };
  }
  return JSON.parse(fs.readFileSync(credentialsPath, 'utf-8')) as CredentialFile;
}

function saveCredentialFile(file: CredentialFile): void {
  const credentialsPath = getCredentialsPath();
  const dataDir = path.dirname(credentialsPath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(credentialsPath, JSON.stringify(file, null, 2), { mode: 0o600 });
  enforceOwnerOnly(credentialsPath);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function credentialSet(
  name: string,
  plaintext: string,
  persist: boolean,
  network_policy: 'allow' | 'confirm' | 'deny',
  allowedMembers: string[] | '*' = '*',
  ttl_seconds?: number,
): CredentialMeta {
  const created_at = new Date().toISOString();
  const expiresAt = ttl_seconds !== undefined
    ? new Date(Date.now() + ttl_seconds * 1000).toISOString()
    : undefined;

  if (persist) {
    const file = loadCredentialFile();
    file.credentials[name] = { name, network_policy, created_at, encryptedValue: encryptPassword(plaintext), allowedMembers, expiresAt };
    saveCredentialFile(file);
    sessionStore.delete(name);
    return { name, scope: 'persistent', network_policy, created_at, allowedMembers, expiresAt };
  }

  sessionStore.set(name, {
    name,
    scope: 'session',
    network_policy,
    created_at,
    encryptedValue: sessionEncrypt(plaintext),
    allowedMembers,
    expiresAt,
  });
  return { name, scope: 'session', network_policy, created_at, allowedMembers, expiresAt };
}

export function credentialList(): CredentialMeta[] {
  const results: CredentialMeta[] = [];

  for (const entry of sessionStore.values()) {
    results.push({ name: entry.name, scope: entry.scope, network_policy: entry.network_policy, created_at: entry.created_at, allowedMembers: entry.allowedMembers, expiresAt: entry.expiresAt });
  }

  const file = loadCredentialFile();
  for (const record of Object.values(file.credentials)) {
    const existing = results.findIndex(r => r.name === record.name);
    const meta: CredentialMeta = {
      name: record.name,
      scope: 'persistent',
      network_policy: record.network_policy,
      created_at: record.created_at,
      allowedMembers: record.allowedMembers ?? '*',
      expiresAt: record.expiresAt,
    };
    if (existing !== -1) {
      results[existing] = meta;
    } else {
      results.push(meta);
    }
  }

  return results;
}

export function credentialDelete(name: string): boolean {
  let found = false;
  if (sessionStore.has(name)) {
    sessionStore.delete(name);
    found = true;
  }
  const file = loadCredentialFile();
  if (name in file.credentials) {
    delete file.credentials[name];
    saveCredentialFile(file);
    found = true;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Task-scoped credential registry for output redaction
// ---------------------------------------------------------------------------
interface TaskCredential { name: string; plaintext: string; }
const taskCredentials = new Map<string, TaskCredential[]>();

export function registerTaskCredentials(taskId: string, credentials: { name: string; plaintext: string }[]): void {
  if (credentials.length > 0) {
    taskCredentials.set(taskId, credentials.map(c => ({ name: c.name, plaintext: c.plaintext })));
  }
}

export function getTaskCredentials(taskId: string): TaskCredential[] {
  return taskCredentials.get(taskId) ?? [];
}

export function credentialResolve(
  name: string,
  callingMember?: string,
): { plaintext: string; meta: CredentialMeta } | { denied: string } | { expired: string } | null {
  // Persistent wins
  const file = loadCredentialFile();
  const persistent = file.credentials[name];
  if (persistent) {
    const allowedMembers = persistent.allowedMembers ?? '*';

    if (persistent.expiresAt && Date.now() > new Date(persistent.expiresAt).getTime()) {
      delete file.credentials[name];
      saveCredentialFile(file);
      sessionStore.delete(name);
      return { expired: `Credential '${name}' has expired. Re-set with credential_store_set.` };
    }

    if (callingMember !== undefined && callingMember !== '*' && allowedMembers !== '*' && !allowedMembers.includes(callingMember)) {
      return { denied: `Credential '${name}' is not accessible to member '${callingMember}'. Allowed: ${(allowedMembers as string[]).join(', ')}` };
    }

    return {
      plaintext: decryptPassword(persistent.encryptedValue),
      meta: {
        name: persistent.name,
        scope: 'persistent',
        network_policy: persistent.network_policy,
        created_at: persistent.created_at,
        allowedMembers,
        expiresAt: persistent.expiresAt,
      },
    };
  }

  const session = sessionStore.get(name);
  if (session) {
    const allowedMembers = session.allowedMembers;

    if (session.expiresAt && Date.now() > new Date(session.expiresAt).getTime()) {
      sessionStore.delete(name);
      return { expired: `Credential '${name}' has expired. Re-set with credential_store_set.` };
    }

    if (callingMember !== undefined && callingMember !== '*' && allowedMembers !== '*' && !allowedMembers.includes(callingMember)) {
      return { denied: `Credential '${name}' is not accessible to member '${callingMember}'. Allowed: ${(allowedMembers as string[]).join(', ')}` };
    }

    return {
      plaintext: sessionDecrypt(session.encryptedValue),
      meta: {
        name: session.name,
        scope: 'session',
        network_policy: session.network_policy,
        created_at: session.created_at,
        allowedMembers: session.allowedMembers,
        expiresAt: session.expiresAt,
      },
    };
  }

  return null;
}

function membersToAllowed(members: string): string[] | '*' {
  return members === '*' ? '*' : members.split(',').map(m => m.trim()).filter(Boolean);
}

function allowedToMembers(allowed: string[] | '*'): string {
  return allowed === '*' ? '*' : allowed.join(',');
}

export function credentialUpdate(name: string, patch: CredentialUpdatePatch): CredentialUpdateResult | null {
  const file = loadCredentialFile();
  const persistent = file.credentials[name];
  if (persistent) {
    if (patch.members !== undefined) {
      persistent.allowedMembers = membersToAllowed(patch.members);
    }
    if (patch.network_policy !== undefined) {
      persistent.network_policy = patch.network_policy;
    }
    if (patch.expiresAt !== undefined) {
      persistent.expiresAt = patch.expiresAt === null ? undefined : new Date(patch.expiresAt).toISOString();
    }
    file.credentials[name] = persistent;
    saveCredentialFile(file);
    return {
      members: allowedToMembers(persistent.allowedMembers),
      network_policy: persistent.network_policy,
      expiresAt: persistent.expiresAt ? new Date(persistent.expiresAt).getTime() : undefined,
    };
  }

  const session = sessionStore.get(name);
  if (session) {
    if (patch.members !== undefined) {
      session.allowedMembers = membersToAllowed(patch.members);
    }
    if (patch.network_policy !== undefined) {
      session.network_policy = patch.network_policy;
    }
    if (patch.expiresAt !== undefined) {
      session.expiresAt = patch.expiresAt === null ? undefined : new Date(patch.expiresAt).toISOString();
    }
    sessionStore.set(name, session);
    return {
      members: allowedToMembers(session.allowedMembers),
      network_policy: session.network_policy,
      expiresAt: session.expiresAt ? new Date(session.expiresAt).getTime() : undefined,
    };
  }

  return null;
}

export function purgeExpiredCredentials(): void {
  let file: CredentialFile;
  try {
    file = loadCredentialFile();
  } catch {
    return;
  }

  const now = Date.now();
  let changed = false;
  for (const [name, record] of Object.entries(file.credentials)) {
    if (record.expiresAt && now > new Date(record.expiresAt).getTime()) {
      delete file.credentials[name];
      sessionStore.delete(name);
      changed = true;
    }
  }

  if (changed) {
    try {
      saveCredentialFile(file);
    } catch {
      // best-effort
    }
  }
}

export function _clearSessionStore(): void {
  sessionStore.clear();
}
