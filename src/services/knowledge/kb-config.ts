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
  [key: string]: unknown;
}

export const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');

/**
 * Read the KB provider config kb_setup wrote (provider/url/token_encrypted). Nothing
 * currently reads this file back -- this restores that capability as a pure reader with
 * no side effects, so a later task can wire it into getKbProviders.
 *
 * - Absent file, or provider missing/"sqlite" -> { provider: 'sqlite' }, silently,
 *   without ever touching token_encrypted (a corrupt token must never break the
 *   stock sqlite path).
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

  return { provider: 'http', url, token };
}
