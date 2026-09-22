import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../paths.js';
import { installKbPostCommitHook } from './kb-invalidate.js';
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

const KB_CONFIG_DIR = path.join(FLEET_DIR, 'knowledge');
const KB_CONFIG_PATH = path.join(KB_CONFIG_DIR, 'config.json');

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

  // Write provider config
  if (!fs.existsSync(KB_CONFIG_DIR)) {
    fs.mkdirSync(KB_CONFIG_DIR, { recursive: true });
  }

  const config: Record<string, string> = {
    provider: input.provider || (input.remote ? 'http' : 'sqlite'),
  };

  if (input.remote) {
    config.url = input.remote;
  }

  if (input.token) {
    config.token_encrypted = encryptPassword(input.token);
    steps.push('Stored remote token encrypted (AES-256-GCM)');
  }

  fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  steps.push('Wrote KB config to ' + KB_CONFIG_PATH);

  return JSON.stringify({ success: true, steps, warnings });
}
