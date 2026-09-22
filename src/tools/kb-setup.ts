import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { installKbPostCommitHook } from './kb-invalidate.js';
import { KB_CONFIG_PATH } from '../services/knowledge/kb-config.js';
import type { KbConfigFile } from '../services/knowledge/kb-config.js';
import { encryptPassword } from '../utils/crypto.js';
import { logWarn } from '../utils/log-helpers.js';

export const kbSetupSchema = z.object({
  repo_path: z.string().optional()
    .describe('Path to git repository for post-commit hook installation (default: current directory)'),
  provider: z.enum(['sqlite', 'http']).optional()
    .describe('KB provider type (default: sqlite)'),
  remote: z.string().optional()
    .describe('Remote KB server URL, http(s) only (required when provider=http). Use https for any non-loopback host: plain http sends the token in cleartext.'),
  token: z.string().optional()
    .describe('Authentication token for remote KB server (stored encrypted, never logged)'),
});

export type KbSetupInput = z.infer<typeof kbSetupSchema>;

const KB_CONFIG_FILE_MODE = 0o600;

// Hostnames (as URL.hostname normalizes them) that never leave this machine,
// so plain http to them cannot put the bearer token on the wire. 127.0.0.0/8
// is loopback in full; URL() already rewrites numeric forms like 2130706433
// or 127.1 to dotted quads. Exact matches only -- localhost.example.com is not
// loopback.
function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower);
}

/**
 * Parse the remote KB URL and return any transport warnings. Throws when the
 * value is not an http(s) URL. Messages name the field and at most the scheme
 * and host -- never the raw value, which may carry user:pass@ or a query token.
 *
 * my-beads-db-u00.6: plain http to a non-loopback host WARNS rather than being
 * refused. Refusing would break existing LAN deployments the next time they
 * re-run kb_setup, and configs already on disk are never re-validated, so a
 * refusal here would not close the hole for them anyway.
 */
function checkRemoteUrl(remote: string): string[] {
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    throw new Error('kb_setup: remote is not a valid URL; expected http(s)://host[:port]');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`kb_setup: remote must use http or https, got scheme "${url.protocol}"`);
  }
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) {
    return [
      `remote uses plain http to non-loopback host "${url.hostname}": any KB token is sent ` +
      'in cleartext on every KB call. Use an https:// remote.',
    ];
  }
  return [];
}

/**
 * The config kb_setup merges into. Absent -> empty. Malformed (bad JSON, or
 * not a JSON object) -> empty plus a warning: kb_setup is the tool an operator
 * runs to REPAIR the KB config, so an unreadable file must not make it throw.
 */
function readExistingConfig(warnings: string[]): KbConfigFile {
  if (!fs.existsSync(KB_CONFIG_PATH)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(KB_CONFIG_PATH, 'utf-8'));
  } catch {
    // The parser's message quotes part of the file, which may hold the
    // encrypted token, so it is not repeated here.
    return discardMalformed(warnings, 'it is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return discardMalformed(warnings, 'it is not a JSON object');
  }
  return parsed as KbConfigFile;
}

function discardMalformed(warnings: string[], reason: string): KbConfigFile {
  const warning = `existing KB config at ${KB_CONFIG_PATH} was discarded because ${reason}; ` +
    'any other settings it held (e.g. bible.autoCommit) must be set again.';
  logWarn('kb_setup', warning);
  warnings.push(warning);
  return {};
}

/**
 * Merge the keys kb_setup owns over the existing config; every other key is
 * left as it was.
 *
 * - provider is written only when provider or remote is passed, so a bare
 *   kb_setup run to install the hook in another repo does not flip an
 *   install already pointed at a remote back to sqlite. A fresh file still
 *   gets provider "sqlite", as before.
 * - token_encrypted is kept while the url is unchanged, so a re-run that only
 *   installs a hook or switches provider keeps working. When remote moves the
 *   url to a different server and no token is passed, the old token is
 *   dropped with a warning: sending one server's bearer token to another
 *   leaks the credential.
 */
function applySetupInput(config: KbConfigFile, input: KbSetupInput, steps: string[], warnings: string[]): void {
  if (input.provider || input.remote) {
    config.provider = input.provider || 'http';
  } else if (!config.provider) {
    config.provider = 'sqlite';
  }

  if (input.remote) {
    const urlChanged = config.url !== input.remote;
    config.url = input.remote;
    if (urlChanged && !input.token && config.token_encrypted) {
      delete config.token_encrypted;
      const warning = 'remote changed and no token was given: the token stored for the previous ' +
        'remote was removed rather than sent to the new one. Re-run kb_setup with a token.';
      logWarn('kb_setup', warning);
      warnings.push(warning);
    }
  }

  if (input.token) {
    config.token_encrypted = encryptPassword(input.token);
    steps.push('Stored remote token encrypted (AES-256-GCM)');
  }
}

// writeFileSync's mode applies only when it CREATES the file, and a merge
// usually rewrites an existing one, so the mode is set explicitly as well.
function writeConfig(config: KbConfigFile): void {
  fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: KB_CONFIG_FILE_MODE });
  fs.chmodSync(KB_CONFIG_PATH, KB_CONFIG_FILE_MODE);
}

export async function kbSetup(input: KbSetupInput): Promise<string> {
  const steps: string[] = [];
  // Validate before any side effect, so a bad remote installs no hook and
  // leaves any existing config untouched.
  const warnings = input.remote ? checkRemoteUrl(input.remote) : [];
  for (const warning of warnings) {
    logWarn('kb_setup', warning);
  }

  // Install git post-commit hook
  const repoPath = input.repo_path || process.cwd();
  const gitDir = path.join(repoPath, '.git');
  if (fs.existsSync(gitDir)) {
    installKbPostCommitHook(repoPath);
    steps.push('Installed git post-commit hook for KB invalidation');
  } else {
    steps.push('Skipped git hook: no .git directory found at ' + repoPath);
  }

  const config = readExistingConfig(warnings);
  applySetupInput(config, input, steps, warnings);
  writeConfig(config);
  steps.push('Wrote KB config to ' + KB_CONFIG_PATH);

  return JSON.stringify({ success: true, steps, warnings });
}
