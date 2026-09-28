import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../../paths.js';
import { decryptPassword } from '../../utils/crypto.js';

/**
 * Result of reading FLEET_DIR/knowledge/config.json (the file src/tools/kb-setup.ts
 * writes). Deliberately a standalone shape, NOT ProviderConfig from ./types.js --
 * kb-providers.ts (owned by another lane) decides how/whether to consume this.
 */
export interface KbConfigResult {
  provider: 'sqlite' | 'http';
  url?: string;
  token?: string;
  // apra-fleet-i9ag.15.13.2: only meaningful for provider "http" -- whether a
  // configured-but-unreachable remote falls back to the local SqliteProvider
  // ("local", today's only behaviour) or hard-fails every read/write instead
  // ("error"). Always resolved to a concrete value (never left undefined) so
  // every call site can read it directly without its own default.
  offlineFallback?: 'local' | 'error';
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
  bible?: { autoCommit?: boolean };
  // apra-fleet-i9ag.15.13.2: explicit, persisted, defaulted switch for a
  // configured-but-unreachable http remote. "local" (default, unset) keeps
  // today's silent-fallback-with-stderr-warning behaviour; "error" hard-fails
  // instead. Never read from an environment variable -- see
  // readKbConfigFromDisk below.
  offline_fallback?: 'local' | 'error';
  [key: string]: unknown;
}

export const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');

/**
 * Read the KB provider config kb_setup wrote (provider/url/token_encrypted). Nothing
 * currently reads this file back -- this restores that capability as a pure reader with
 * no side effects, so a later task can wire it into getKbProviders.
 *
 * - Absent file, or provider missing/"sqlite" -> { provider: 'sqlite', offlineFallback: 'local' }
 *   (or the persisted offline_fallback value, if set and valid), silently, without ever
 *   touching token_encrypted (a corrupt token must never break the stock sqlite path).
 * - provider "http" -> decrypts token_encrypted and returns { provider: 'http', url, token }.
 *   Missing url, missing token_encrypted, or a decryption failure all throw a
 *   descriptive Error naming this config path and the failing key -- never a silent
 *   fallback to sqlite.
 * - Malformed JSON throws an Error naming this config path.
 */
export function readKbConfigFromDisk(): KbConfigResult {
  if (!fs.existsSync(KB_CONFIG_PATH)) {
    return { provider: 'sqlite', offlineFallback: 'local' };
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

  // apra-fleet-i9ag.15.13.2 (review fix): validated and resolved BEFORE the
  // provider branch below, so offlineFallback is always a concrete value on
  // every returned KbConfigResult -- including the "sqlite" early return --
  // matching the doc comment on KbConfigResult above. Previously this ran
  // only on the http path, so a stale/typo'd offline_fallback left over from
  // an earlier http config was silently ignored once the file said "sqlite".
  // Absent key -> 'local' (today's only behaviour, unchanged).
  const offlineFallbackRaw = parsed.offline_fallback;
  let offlineFallback: 'local' | 'error' = 'local';
  if (offlineFallbackRaw !== undefined) {
    if (offlineFallbackRaw !== 'local' && offlineFallbackRaw !== 'error') {
      throw new Error(
        `KB config at ${KB_CONFIG_PATH} has invalid "offline_fallback" value ${JSON.stringify(offlineFallbackRaw)}; expected "local" or "error"`,
      );
    }
    offlineFallback = offlineFallbackRaw;
  }

  if (parsed.provider !== 'http') {
    // Stock path: sqlite, or provider key absent. Deliberately never touches
    // token_encrypted here -- see module doc.
    return { provider: 'sqlite', offlineFallback };
  }

  const url = typeof parsed.url === 'string' ? parsed.url : undefined;
  if (!url) {
    throw new Error(
      `KB config at ${KB_CONFIG_PATH} selects provider "http" but is missing required key "url"`,
    );
  }

  const tokenEncrypted = typeof parsed.token_encrypted === 'string' ? parsed.token_encrypted : undefined;
  if (!tokenEncrypted) {
    throw new Error(
      `KB config at ${KB_CONFIG_PATH} selects provider "http" but is missing required key "token_encrypted"`,
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

  // offlineFallback was already resolved/validated above, before the provider
  // branch, so it needs no re-derivation here.
  return { provider: 'http', url, token, offlineFallback };
}
