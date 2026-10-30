import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../../paths.js';
import { decryptPassword } from '../../utils/crypto.js';
import { logWarn } from '../../utils/log-helpers.js';
import { findSecretTokens } from '../secret-token.js';

/** Bounds and default for request_timeout_ms, shared by kb_setup (write) and the reader. */
export const MIN_REQUEST_TIMEOUT_MS = 1000;
export const MAX_REQUEST_TIMEOUT_MS = 120000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/**
 * Result of reading FLEET_DIR/knowledge/config.json (the file src/tools/kb-setup.ts
 * writes). Deliberately a standalone shape, NOT ProviderConfig from ./types.js --
 * kb-providers.ts (owned by another lane) decides how/whether to consume this.
 */
export interface KbConfigResult {
  provider: 'sqlite' | 'http';
  url?: string;
  /** Literal token (decrypted token_encrypted). Absent when tokenSecretName is set. */
  token?: string;
  /**
   * Name of the fleet secret the token is read from on each request (from the
   * token_ref placeholder). Absent for a literal-token config.
   */
  tokenSecretName?: string;
  /** Socket idle timeout per request for the http provider; absent means the provider default. */
  requestTimeoutMs?: number;
}

/**
 * On-disk shape of FLEET_DIR/knowledge/config.json. One file, several owners:
 * kb_setup writes provider/url/token_encrypted, kb_export reads bible.autoCommit.
 * The index signature keeps keys this build does not know about, so a writer
 * that merges into the file never drops another owner's settings.
 */
export interface KbConfigFile {
  provider?: 'sqlite' | 'http';
  url?: string;
  token_encrypted?: string;
  /** Canonical {{secret.NAME}} placeholder written by kb_setup instead of token_encrypted. */
  token_ref?: string;
  request_timeout_ms?: number;
  bible?: { autoCommit?: boolean };
  [key: string]: unknown;
}

export const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');

/**
 * Read the KB provider config kb_setup wrote (provider/url/token_encrypted). Nothing
 * currently reads this file back -- this restores that capability as a pure reader with
 * no side effects other than a logged warning (see readRequestTimeout), so a later task can wire it into getKbProviders.
 *
 * - Absent file, or provider missing/"sqlite" -> { provider: 'sqlite' }, silently,
 *   without ever touching token_encrypted (a corrupt token must never break the
 *   stock sqlite path).
 * - provider "http" with token_ref ({{secret.NAME}}) -> { provider: 'http', url, tokenSecretName }.
 *   The secret itself is NOT read here: HttpKbProvider looks it up per request.
 * - provider "http" -> decrypts token_encrypted and returns { provider: 'http', url, token }.
 *   Missing url, missing token_encrypted, or a decryption failure all throw a
 *   descriptive Error naming this config path and the failing key -- never a silent
 *   fallback to sqlite.
 * - Malformed JSON throws an Error naming this config path.
 */
export function readKbConfigFromDisk(): KbConfigResult {
  if (!fs.existsSync(KB_CONFIG_PATH)) {
    return { provider: 'sqlite' };
  }

  const raw = fs.readFileSync(KB_CONFIG_PATH, 'utf-8');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Malformed JSON in KB config at ${KB_CONFIG_PATH}: ${(err as Error).message}`,
    );
  }

  if (parsed.provider !== 'http') {
    // Stock path: sqlite, or provider key absent. Deliberately never touches
    // token_encrypted here -- see module doc.
    return { provider: 'sqlite' };
  }

  const url = typeof parsed.url === 'string' ? parsed.url : undefined;
  if (!url) {
    throw new Error(
      `KB config at ${KB_CONFIG_PATH} selects provider "http" but is missing required key "url"`,
    );
  }

  const requestTimeoutField = 'request_timeout_ms' in parsed
    ? { requestTimeoutMs: readRequestTimeout(parsed.request_timeout_ms) }
    : {};

  // token_ref (a {{secret.NAME}} placeholder kb_setup stored instead of the
  // value) wins over token_encrypted: kb_setup never writes both, and the
  // reference is what the operator asked for most recently if a hand edit did.
  if (typeof parsed.token_ref === 'string') {
    return { provider: 'http', url, tokenSecretName: readTokenRef(parsed.token_ref), ...requestTimeoutField };
  }

  const tokenEncrypted = typeof parsed.token_encrypted === 'string' ? parsed.token_encrypted : undefined;
  if (!tokenEncrypted) {
    throw new Error(
      `KB config at ${KB_CONFIG_PATH} selects provider "http" but is missing required key "token_encrypted" (or "token_ref")`,
    );
  }

  let token: string;
  try {
    token = decryptPassword(tokenEncrypted);
  } catch (err) {
    throw new Error(
      `KB config at ${KB_CONFIG_PATH} has an undecryptable "token_encrypted": ${(err as Error).message}`,
    );
  }

  return { provider: 'http', url, token, ...requestTimeoutField };
}

/**
 * The secret name inside a token_ref value. It must be exactly one placeholder
 * ({{secret.NAME}}, or the legacy {{secure.NAME}}) and nothing else -- the
 * same rule kb_setup applies on write, re-checked here for hand edits.
 */
function readTokenRef(value: string): string {
  const matches = findSecretTokens(value);
  if (matches.length !== 1 || matches[0].raw !== value) {
    throw new Error(
      `KB config at ${KB_CONFIG_PATH} has a "token_ref" that is not exactly one secret placeholder of the form {{secret.NAME}}`,
    );
  }
  return matches[0].name;
}

/** True when value is an integer within the request_timeout_ms bounds. */
function isValidRequestTimeout(value: unknown): value is number {
  return Number.isInteger(value)
    && (value as number) >= MIN_REQUEST_TIMEOUT_MS
    && (value as number) <= MAX_REQUEST_TIMEOUT_MS;
}

/**
 * kb_setup refuses an out-of-range value on write, but the file can be edited
 * by hand. Applying the same bounds on read keeps a value like 3e9 from
 * effectively disabling the timeout; falling back (instead of throwing) keeps
 * an existing config working.
 */
function readRequestTimeout(value: unknown): number {
  if (isValidRequestTimeout(value)) return value;
  logWarn(
    'kb_config',
    `KB config at ${KB_CONFIG_PATH} has request_timeout_ms ${JSON.stringify(value)}, not an integer between ` +
    `${MIN_REQUEST_TIMEOUT_MS} and ${MAX_REQUEST_TIMEOUT_MS}; using the default ${DEFAULT_REQUEST_TIMEOUT_MS}`,
  );
  return DEFAULT_REQUEST_TIMEOUT_MS;
}
