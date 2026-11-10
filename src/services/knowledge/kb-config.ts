import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../../paths.js';
import { decryptPassword } from '../../utils/crypto.js';
import { logWarn } from '../../utils/log-helpers.js';
import { findSecretTokens } from '../secret-token.js';
import { FULL_KB_TOOL_PROFILE, makeKbToolProfile, type KbToolProfile } from '../kb-tool-profile.js';

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
  /**
   * Install-wide KB tool profile for FULL sessions (src/services/kb-tool-profile.ts):
   * "full" (default when absent), "developer", or "custom" with the kb_* names
   * in tool_profile_tools. Read by readKbToolProfileFromDisk.
   */
  tool_profile?: 'full' | 'developer' | 'custom';
  /** The kb_* tool names a "custom" tool_profile serves; ignored otherwise. */
  tool_profile_tools?: string[];
  [key: string]: unknown;
}

export const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');

/**
 * The KB config file cannot be read or parsed, as opposed to holding a bad
 * value. The way out is a hand edit: anything that rewrites the file would
 * lose what it holds (url, token_ref, ...). The message never quotes the file:
 * a JSON parser's message can repeat part of it, including the encrypted token.
 */
export class KbConfigUnreadableError extends Error {
  constructor(problem: string) {
    super(`KB config at ${KB_CONFIG_PATH} ${problem}`);
    this.name = 'KbConfigUnreadableError';
  }
}

/** What to do about a KbConfigUnreadableError. */
export const KB_CONFIG_HAND_FIX = 'Fix that file by hand (other settings in it, such as the remote url and token, are still there).';

/** Parse the KB config, or throw KbConfigUnreadableError. Undefined when the file is absent. */
function parseKbConfigFile(): unknown {
  if (!fs.existsSync(KB_CONFIG_PATH)) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(KB_CONFIG_PATH, 'utf-8');
  } catch (err) {
    throw new KbConfigUnreadableError(`cannot be read (${(err as NodeJS.ErrnoException).code ?? 'unknown error'})`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new KbConfigUnreadableError('is not valid JSON');
  }
}

/**
 * The KB config as an object to merge into and write back: {} when absent.
 * Throws KbConfigUnreadableError when the file cannot be read, is not valid
 * JSON or is not a JSON object, so a writer never overwrites what it could not
 * parse.
 */
export function readKbConfigForMerge(): KbConfigFile {
  const parsed = parseKbConfigFile();
  if (parsed === undefined) return {};
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new KbConfigUnreadableError('is not a JSON object');
  }
  return parsed as KbConfigFile;
}

/**
 * Read the install-wide KB tool profile from the KB config.
 *
 * - Absent file, or no tool_profile key -> full, silently (the stock path is
 *   never broken by this reader; it does not look at provider/token keys).
 * - A known profile -> that profile; "custom" validates tool_profile_tools
 *   against the registered kb_* tool names.
 * - An unreadable or malformed file throws KbConfigUnreadableError; an unknown
 *   profile name or an invalid custom list throws an Error naming this config
 *   path and the problem (for a custom list: the unknown names and the valid
 *   ones).
 */
export function readKbToolProfileFromDisk(): KbToolProfile {
  const parsed = parseKbConfigFile();
  if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return FULL_KB_TOOL_PROFILE;
  const config = parsed as KbConfigFile;
  if (config.tool_profile === undefined) return FULL_KB_TOOL_PROFILE;
  try {
    return makeKbToolProfile(config.tool_profile, config.tool_profile_tools);
  } catch (err) {
    throw new Error(`KB config at ${KB_CONFIG_PATH}: ${(err as Error).message}`);
  }
}

/**
 * The line fleet_status shows when the configured KB tool profile is invalid,
 * or undefined when it is fine. An invalid profile never stops anything: FULL
 * sessions fall back to every kb_* tool (tool-registry.ts), and this line is
 * how a user or agent learns the setting they made is not applied. Never throws.
 */
export function kbToolProfileWarning(): string | undefined {
  try {
    readKbToolProfileFromDisk();
    return undefined;
  } catch (err) {
    const fix = err instanceof KbConfigUnreadableError
      ? KB_CONFIG_HAND_FIX
      : 'Set a valid one with: apra-fleet kb profile <full | developer | custom tool1,tool2>.';
    return `KB tool profile not applied, serving every kb_* tool. ${(err as Error).message}. ${fix} Reconnect to pick up the change.`;
  }
}

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

/** How this install's KB config relates to a remote KB url and the secret its token should come from. */
export type KbConfigMatch = 'match' | 'missing' | 'not-http' | 'other-remote' | 'other-token' | 'unreadable';

/**
 * Whether the KB config selects provider http at `remote` (a trailing slash is
 * ignored) with its token from secret `secretName`. Read only. `missing`: no
 * config file. `not-http`: sqlite. `other-token`: the right remote with a literal token or
 * another secret.
 */
export function kbConfigMatch(remote: string, secretName: string): KbConfigMatch {
  if (!fs.existsSync(KB_CONFIG_PATH)) return 'missing';
  let config: KbConfigResult;
  try {
    config = readKbConfigFromDisk();
  } catch {
    return 'unreadable';
  }
  if (config.provider !== 'http' || !config.url) return 'not-http';
  const norm = (u: string) => u.replace(/\/+$/, '');
  if (norm(config.url) !== norm(remote)) return 'other-remote';
  return config.tokenSecretName === secretName ? 'match' : 'other-token';
}
