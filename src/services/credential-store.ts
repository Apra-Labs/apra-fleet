import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { encryptPassword, decryptPassword } from '../utils/crypto.js';
import { enforceOwnerOnly } from '../utils/file-permissions.js';
import { FLEET_DIR } from '../paths.js';
import { findExecutableOnPath } from '../utils/find-on-path.js';
import { knownTokenFormat } from '../utils/redact-known-secrets.js';
import {
  DEFAULT_PATHEXT,
  defaultIsFile,
  envValue,
  findOnAbsoluteWindowsPath,
} from '../os/windows-executable.js';
import { appendLogRecord } from '../utils/log-helpers.js';
import { findSecretTokens, formatSecretToken, hasSecretToken, legacyTokenWarning } from './secret-token.js';
import { envVarForSecret, type LiveSecretBinding } from './live-secret-runner.js';

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
  allowedMembers: string[] | '*';
  expiresAt?: string;
  /** Present on a live secret: its value is minted on demand, so scope and expiresAt do not describe a stored value. */
  kind?: 'live';
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
  allowedMembers: string[] | '*';
  expiresAt?: string;
}

/**
 * A live secret: a script the orchestrator runs to mint a token on demand.
 * Registered from the CLI only; it shares the name space with static secrets (a
 * name is one or the other), and carries the same policy fields. The record
 * holds no value: inline script text keeps its {{secret.R}} placeholders, and
 * `bindings` names the bound secrets only.
 */
export interface LiveSecretRecord {
  kind: 'live';
  name: string;
  /** An inline script, with {{secret.R}} placeholders. Otherwise program + args. */
  inline?: string;
  program?: string;
  args?: string[];
  bindings: LiveSecretBinding[];
  network_policy: 'allow' | 'confirm' | 'deny';
  allowedMembers: string[] | '*';
  created_at: string;
}

type StoredRecord = PersistentRecord | LiveSecretRecord;

function isLiveRecord(rec: StoredRecord | undefined): rec is LiveSecretRecord {
  return !!rec && (rec as LiveSecretRecord).kind === 'live';
}

interface CredentialFile {
  version: string;
  credentials: Record<string, StoredRecord>;
}

// ---------------------------------------------------------------------------
// Session store (in-memory)
// ---------------------------------------------------------------------------
const sessionStore = new Map<string, SessionEntry>();

// ---------------------------------------------------------------------------
// Persistent store (credentials.json)
// ---------------------------------------------------------------------------
/** The folder that holds credentials.json. */
export function credentialDataDir(): string {
  return process.env.APRA_FLEET_DATA_DIR ?? FLEET_DIR;
}

function getCredentialsPath(): string {
  return path.join(credentialDataDir(), 'credentials.json');
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
  // Write a temp file next to credentials.json, then rename it over: a
  // concurrent reader in another process sees either the old or the new
  // file, never a truncated one.
  const tmpPath = `${credentialsPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(file, null, 2), { mode: 0o600 });
    enforceOwnerOnly(tmpPath);
    renameWithRetry(tmpPath, credentialsPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* temp may not exist */ }
    throw err;
  }
}

const RENAME_RETRIES = 10;
const RENAME_RETRY_DELAY_MS = 20;

// On Windows, renaming over a file another process has open can fail
// transiently (EPERM / EACCES / EBUSY).
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt >= RENAME_RETRIES) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_DELAY_MS);
    }
  }
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
    // Persistent supersedes session
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

/** True when `name` is a registered live secret (not a static secret). */
export function isLiveSecret(name: string): boolean {
  return isLiveRecord(loadCredentialFile().credentials[name]);
}

/** The live secret registered under `name`, or null (static secrets and unknown names give null). */
export function lookupLiveSecret(name: string): LiveSecretRecord | null {
  const rec = loadCredentialFile().credentials[name];
  return isLiveRecord(rec) ? rec : null;
}

/** Every registered live secret, sorted by name. */
export function listLiveSecrets(): LiveSecretRecord[] {
  return Object.values(loadCredentialFile().credentials)
    .filter(isLiveRecord)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The live secrets bound to `name`, from an already loaded file. */
function consumersOf(file: CredentialFile, name: string): string[] {
  return Object.values(file.credentials)
    .filter(isLiveRecord)
    .filter((rec) => rec.bindings.some((b) => b.secret === name))
    .map((rec) => rec.name)
    .sort();
}

/** The named secret is bound to a live secret: it stays until the consuming live secret is deleted. */
export class SecretInUseError extends Error {
  readonly code = 'E-SECRET-IN-USE';
  constructor(readonly secret: string, readonly consumers: string[]) {
    super(`secret is in use by: ${consumers.join(', ')}`);
    this.name = 'SecretInUseError';
  }
}

export type LiveRegistrationReason =
  | 'name-in-use'
  | 'program-not-found'
  | 'placeholder-in-args'
  | 'cleartext-token'
  | 'bad-env'
  | 'binding-collision'
  | 'binding-self'
  | 'binding-missing'
  | 'binding-unreadable'
  | 'binding-session'
  | 'binding-live';

/** A live secret cannot be registered as given. The message carries names only, never script text or a value. */
export class LiveRegistrationError extends Error {
  constructor(readonly reasonCode: LiveRegistrationReason, message: string) {
    super(message);
    this.name = 'LiveRegistrationError';
  }
}

export type LiveSecretSpec =
  | { inline: string }
  | { program: string; args: string[]; env: Array<{ env: string; value: string }> };

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_ENV = 'FLEET_CREDENTIAL';

function rejectCleartext(text: string): void {
  const format = knownTokenFormat(text);
  if (format) {
    throw new LiveRegistrationError(
      'cleartext-token',
      `the script looks like it holds a ${format} in cleartext. Store it (apra-fleet secret --set NAME --persist) and reference it as a secret placeholder.`,
    );
  }
}

/** Bound env var names, refused when two differ only by case or by the - to _ mapping. */
function checkBindings(name: string, bindings: LiveSecretBinding[], file: CredentialFile): void {
  const seen = new Map<string, string>();
  for (const { env, secret } of bindings) {
    const folded = env.toUpperCase();
    const other = seen.get(folded);
    if (other !== undefined) {
      throw new LiveRegistrationError('binding-collision', `bound secrets "${other}" and "${secret}" map to the same env var ${env}: rename one`);
    }
    seen.set(folded, secret);
  }
  const persist = `store it with: apra-fleet secret --set`;
  for (const { secret } of bindings) {
    if (secret === name) {
      throw new LiveRegistrationError('binding-self', `live secret "${name}" cannot be bound to itself`);
    }
    const rec = file.credentials[secret];
    if (isLiveRecord(rec)) {
      throw new LiveRegistrationError('binding-live', `bound secret "${secret}" is a live secret: live secrets cannot be bound to another live secret`);
    }
    if (!rec) {
      if (sessionStore.has(secret)) {
        throw new LiveRegistrationError('binding-session', `bound secret "${secret}" is session-tier and disappears on restart: ${persist} ${secret} --persist`);
      }
      throw new LiveRegistrationError('binding-missing', `bound secret "${secret}" does not exist as a persistent secret: ${persist} ${secret} --persist`);
    }
    try {
      decryptPassword(rec.encryptedValue);
    } catch {
      throw new LiveRegistrationError('binding-unreadable', `bound secret "${secret}" could not be read: ${persist} ${secret} --persist`);
    }
  }
}

function checkNameFree(name: string, file: CredentialFile): void {
  const consumers = consumersOf(file, name);
  if (consumers.length > 0) throw new LiveRegistrationError('name-in-use', new SecretInUseError(name, consumers).message);
}

/**
 * Validate a live secret and build its record, without writing anything. Secrets
 * enter only by reference, and every bound secret must be persistent and static.
 * A name already in use keeps its policy fields; a new one gets the defaults of
 * `secret --set --persist`.
 */
export function prepareLiveSecret(name: string, spec: LiveSecretSpec): LiveSecretRecord {
  const file = loadCredentialFile();
  checkNameFree(name, file);
  const references = 'inline' in spec ? [spec.inline] : spec.env.map((e) => e.value);
  const legacyNames = findSecretTokens(references.join('\n')).filter((t) => t.legacy).map((t) => t.name);
  if (legacyNames.length > 0) {
    // The log only: the CLI prints nothing but the registration result.
    appendLogRecord('warn', { tag: 'live-secret', msg: legacyTokenWarning(legacyNames) });
  }
  const fields: Pick<LiveSecretRecord, 'inline' | 'program' | 'args' | 'bindings'> = 'inline' in spec
    ? inlineFields(spec.inline)
    : programFields(spec);
  checkBindings(name, fields.bindings, file);
  const previous = file.credentials[name];
  return {
    kind: 'live',
    name,
    ...fields,
    network_policy: previous?.network_policy ?? 'allow',
    allowedMembers: previous?.allowedMembers ?? '*',
    created_at: new Date().toISOString(),
  };
}

function inlineFields(script: string): Pick<LiveSecretRecord, 'inline' | 'bindings'> {
  rejectCleartext(script);
  // The legacy spelling is stored canonically, so a later rewrite has one form to match.
  let inline = script;
  const names = new Set<string>();
  for (const token of findSecretTokens(script)) {
    inline = inline.replaceAll(token.raw, formatSecretToken(token.name));
    names.add(token.name);
  }
  return { inline, bindings: [...names].map((secret) => ({ env: envVarForSecret(secret), secret })) };
}

function programFields(spec: Extract<LiveSecretSpec, { program: string }>): Pick<LiveSecretRecord, 'program' | 'args' | 'bindings'> {
  for (const text of [spec.program, ...spec.args]) {
    if (hasSecretToken(text)) {
      throw new LiveRegistrationError('placeholder-in-args', 'a secret placeholder is not allowed in the script path or its args: pass it with --env "VAR={{secret.NAME}}"');
    }
    rejectCleartext(text);
  }
  const bindings = spec.env.map(({ env, value }): LiveSecretBinding => {
    if (!ENV_NAME_RE.test(env)) {
      throw new LiveRegistrationError('bad-env', 'an --env name must match [A-Za-z_][A-Za-z0-9_]*');
    }
    if (env.toUpperCase() === RESERVED_ENV) {
      throw new LiveRegistrationError('bad-env', `--env ${env} is reserved: fleet sets it to the live secret's name`);
    }
    const tokens = findSecretTokens(value);
    if (tokens.length !== 1 || tokens[0].raw !== value) {
      throw new LiveRegistrationError('bad-env', `--env ${env} must be exactly one secret placeholder: secrets enter only by reference`);
    }
    return { env, secret: tokens[0].name };
  });
  const program = resolveLiveProgram(spec.program);
  if (!program) {
    throw new LiveRegistrationError('program-not-found', `script '${spec.program}' could not be resolved as a file or on an absolute PATH entry`);
  }
  return { program, args: [...spec.args], bindings };
}

/**
 * Store a prepared live secret, replacing any unbound record of that name. The
 * checks run again on the current file, because the registration test ran in
 * between.
 */
export function saveLiveSecret(record: LiveSecretRecord): void {
  // A live secret holds no ciphertext, so the store may have no key yet. Create
  // it now: the first key creation renames an existing credentials.json aside
  // (crypto.ts), which later on would take this record with it.
  encryptPassword('');
  const file = loadCredentialFile();
  checkNameFree(record.name, file);
  checkBindings(record.name, record.bindings, file);
  file.credentials[record.name] = record;
  saveCredentialFile(file);
  sessionStore.delete(record.name);
}

/**
 * The absolute path of a script file. A name with a path separator is taken as
 * a file; a bare name is looked up on absolute PATH entries only, so neither the
 * cwd nor a relative PATH entry can supply it.
 */
function resolveLiveProgram(program: string): string | null {
  if (program.includes('/') || program.includes('\\')) {
    const abs = path.resolve(program);
    try { return fs.statSync(abs).isFile() ? abs : null; } catch { return null; }
  }
  if (process.platform === 'win32') {
    const pathExts = (envValue(process.env, 'PATHEXT') || DEFAULT_PATHEXT).split(';').map((e) => e.trim().toLowerCase()).filter(Boolean);
    const lower = program.toLowerCase();
    const exts = lower.endsWith('.ps1') || pathExts.some((ext) => lower.endsWith(ext)) ? [''] : pathExts;
    return findOnAbsoluteWindowsPath(program, exts, { pathValue: envValue(process.env, 'PATH'), isFile: defaultIsFile });
  }
  const absoluteEntries = (process.env.PATH ?? '').split(':').filter((d) => path.isAbsolute(d)).join(':');
  return findExecutableOnPath(program, { envPath: absoluteEntries });
}

export type BoundSecretRead =
  | { status: 'ok'; value: string; expiresAt?: string }
  | { status: 'missing' };

/**
 * A bound secret's value for a live secret run. Ignores allowedMembers, never
 * deletes, and still returns the value of an expired record: the binding is to
 * the name, and the caller warns. Only a persistent static record qualifies.
 */
export function readBoundSecret(name: string): BoundSecretRead {
  const rec = loadCredentialFile().credentials[name];
  if (!rec || isLiveRecord(rec)) return { status: 'missing' };
  return { status: 'ok', value: decryptPassword(rec.encryptedValue), expiresAt: rec.expiresAt };
}

export function credentialList(): CredentialMeta[] {
  const results: CredentialMeta[] = [];

  for (const entry of sessionStore.values()) {
    results.push({ name: entry.name, scope: entry.scope, network_policy: entry.network_policy, created_at: entry.created_at, allowedMembers: entry.allowedMembers, expiresAt: entry.expiresAt });
  }

  const file = loadCredentialFile();
  for (const record of Object.values(file.credentials)) {
    // List what is in force: the session row stays when it has replaced this record.
    if (!isLiveRecord(record) && !effectivePersistent(record, record.name)) continue;
    const existing = results.findIndex(r => r.name === record.name);
    const meta: CredentialMeta = isLiveRecord(record) ? {
      name: record.name,
      scope: 'persistent',
      kind: 'live',
      network_policy: record.network_policy,
      created_at: record.created_at,
      allowedMembers: record.allowedMembers,
    } : {
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

/**
 * Delete a credential from both tiers. Throws SecretInUseError, deleting
 * nothing, while a live secret is bound to it.
 */
export function credentialDelete(name: string): boolean {
  const file = loadCredentialFile();
  const consumers = consumersOf(file, name);
  if (consumers.length > 0) throw new SecretInUseError(name, consumers);
  let found = false;
  if (sessionStore.has(name)) {
    sessionStore.delete(name);
    found = true;
  }
  if (name in file.credentials) {
    delete file.credentials[name];
    saveCredentialFile(file);
    found = true;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Task-scoped credential registry for long-running task output redaction (H2)
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

/**
 * Resolve a credential name to its plaintext value.
 * Persistent store takes precedence over session store.
 *
 * Returns:
 *   - { plaintext, meta } on success
 *   - { denied } if callingMember is not in allowedMembers, or the name is a
 *     live secret (only execute_command and the KB provider consume those:
 *     every other caller would keep the value in a file or use it where a
 *     short-lived token cannot work)
 *   - { expired } if the credential has passed its TTL. A persistent record is
 *     kept: a live secret may be bound to it by name, and the startup purge
 *     removes the unbound ones. A session entry set after it expired is used
 *     instead of reporting it. An expired session entry is deleted.
 *   - null if the credential does not exist
 */
export function credentialResolve(
  name: string,
  callingMember?: string,
): { plaintext: string; meta: CredentialMeta } | { denied: string } | { expired: string } | null {
  // Persistent wins
  const file = loadCredentialFile();
  const stored = file.credentials[name];
  if (isLiveRecord(stored)) {
    return { denied: `Credential '${name}' is a live secret: only execute_command and the KB provider can use it, because its value must never be kept in a file.` };
  }
  const persistent = effectivePersistent(stored, name);
  if (persistent) {
    const allowedMembers = persistent.allowedMembers ?? '*';

    // TTL check
    if (persistent.expiresAt && Date.now() > new Date(persistent.expiresAt).getTime()) {
      return { expired: `Credential '${name}' has expired. Re-set with credential_store_set (persist: true to keep it across restarts).` };
    }

    // Scoping check ('*' as callingMember is a fleet-operator bypass)
    if (callingMember !== undefined && callingMember !== '*' && allowedMembers !== '*' && !allowedMembers.includes(callingMember)) {
      return { denied: `Credential '${name}' is not accessible to member '${callingMember}'. Allowed: ${allowedMembers.join(', ')}` };
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

    // TTL check
    if (session.expiresAt && Date.now() > new Date(session.expiresAt).getTime()) {
      sessionStore.delete(name);
      return { expired: `Credential '${name}' has expired. Re-set with credential_store_set.` };
    }

    // Scoping check ('*' as callingMember is a fleet-operator bypass)
    if (callingMember !== undefined && callingMember !== '*' && allowedMembers !== '*' && !allowedMembers.includes(callingMember)) {
      return { denied: `Credential '${name}' is not accessible to member '${callingMember}'. Allowed: ${allowedMembers.join(', ')}` };
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

export type ServerSecretMeta = Pick<CredentialMeta, 'name' | 'scope' | 'created_at' | 'expiresAt'>;

export type ServerSecretLookup =
  | { status: 'ok'; value: string; meta: ServerSecretMeta }
  | { status: 'missing' }
  | { status: 'expired'; expiresAt: string; meta: ServerSecretMeta };

export type ServerSecretStatus =
  | { status: 'ok'; meta: ServerSecretMeta }
  | { status: 'missing' }
  | { status: 'expired'; expiresAt: string; meta: ServerSecretMeta };

function isExpired(expiresAt: string | undefined): expiresAt is string {
  return !!expiresAt && Date.now() > new Date(expiresAt).getTime();
}

/**
 * The persistent record that speaks for `name`, if any. Persistent wins, except
 * that an expired record gives way to a session entry created after it expired:
 * that is what a re-set with the default persist: false creates. An older session
 * entry must not take over at expiry, with its older value and looser policy. The
 * record itself stays in the file.
 */
function effectivePersistent(rec: PersistentRecord | undefined, name: string): PersistentRecord | undefined {
  const session = sessionStore.get(name);
  const replaced = rec && isExpired(rec.expiresAt) && session
    && Date.parse(session.created_at) > Date.parse(rec.expiresAt);
  return replaced ? undefined : rec;
}

/**
 * Metadata-only server-side lookup (no decryption), for status reporting.
 * Persistent wins over session. allowedMembers is not checked and nothing is
 * deleted, so an expired record stays visible as expired.
 */
export function lookupServerSecretMeta(name: string): ServerSecretStatus {
  const stored = loadCredentialFile().credentials[name];
  // Live secrets are not static secrets; lookupLiveSecret reads them.
  if (isLiveRecord(stored)) return { status: 'missing' };
  const persistent = effectivePersistent(stored, name);
  const rec = persistent ?? sessionStore.get(name);
  if (!rec) return { status: 'missing' };
  const meta: ServerSecretMeta = {
    name: rec.name,
    scope: persistent ? 'persistent' : 'session',
    created_at: rec.created_at,
    expiresAt: rec.expiresAt,
  };
  if (isExpired(rec.expiresAt)) return { status: 'expired', expiresAt: rec.expiresAt, meta };
  return { status: 'ok', meta };
}

/**
 * Server-side named-secret lookup for fleet-server callers (not a member
 * command): ignores allowedMembers, never deletes a record, never logs the value.
 */
export function lookupServerSecret(name: string): ServerSecretLookup {
  const found = lookupServerSecretMeta(name);
  if (found.status !== 'ok') return found;
  const stored = loadCredentialFile().credentials[name];
  const persistent = isLiveRecord(stored) ? undefined : effectivePersistent(stored, name);
  let value: string;
  if (persistent) {
    value = decryptPassword(persistent.encryptedValue);
  } else {
    const session = sessionStore.get(name);
    if (!session) return { status: 'missing' };
    value = sessionDecrypt(session.encryptedValue);
  }
  return { status: 'ok', value, meta: found.meta };
}

export interface CredentialUpdatePatch {
  members?: string;
  expiresAt?: number | null;
  network_policy?: 'allow' | 'confirm' | 'deny';
}

export interface CredentialUpdateResult {
  members: string;
  network_policy: 'allow' | 'confirm' | 'deny';
  expiresAt?: number;
}

function membersToAllowed(members: string): string[] | '*' {
  return members === '*' ? '*' : members.split(',').map(m => m.trim()).filter(Boolean);
}

function allowedToMembers(allowed: string[] | '*'): string {
  return allowed === '*' ? '*' : allowed.join(',');
}

export function credentialUpdate(name: string, patch: CredentialUpdatePatch): CredentialUpdateResult | null {
  const file = loadCredentialFile();
  const stored = file.credentials[name];
  if (isLiveRecord(stored)) {
    // A live secret's expiry comes from its token, so patch.expiresAt does not apply.
    if (patch.members !== undefined) stored.allowedMembers = membersToAllowed(patch.members);
    if (patch.network_policy !== undefined) stored.network_policy = patch.network_policy;
    saveCredentialFile(file);
    return { members: allowedToMembers(stored.allowedMembers), network_policy: stored.network_policy };
  }
  const persistent = effectivePersistent(stored, name);
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

/**
 * Purge expired credentials from the persistent store, except those bound to a
 * live secret. Called at server startup to clean up stale entries.
 */
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
    if (isLiveRecord(record) || consumersOf(file, name).length > 0) continue;
    if (record.expiresAt && now > new Date(record.expiresAt).getTime()) {
      // A session entry that replaced this record stays; an older one goes with it.
      if (effectivePersistent(record, name)) sessionStore.delete(name);
      delete file.credentials[name];
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
