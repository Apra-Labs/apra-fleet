import type { Agent } from '../types.js';
import type { RemoteOS } from './platform.js';
import { decryptPassword } from './crypto.js';
import { escapeDoubleQuoted } from './shell-escape.js';

/**
 * Build a platform-correct inline export prefix for all stored auth env vars.
 * Returns empty string if the agent has no stored env vars.
 */
export function buildAuthEnvPrefix(agent: Agent, os: RemoteOS): string {
  const vars = agent.encryptedEnvVars;
  if (!vars || Object.keys(vars).length === 0) return '';

  const parts: string[] = [];

  for (const [name, encrypted] of Object.entries(vars)) {
    const value = decryptPassword(encrypted);

    if (os === 'windows') {
      // PowerShell: single-quote escaping (matching windows.ts envPrefix pattern)
      const escaped = value.replace(/'/g, "''");
      parts.push(`$env:${name}='${escaped}'`);
    } else {
      // Linux/macOS: double-quote escaping
      const escaped = escapeDoubleQuoted(value);
      parts.push(`export ${name}="${escaped}"`);
    }
  }

  if (os === 'windows') {
    return parts.join('; ') + '; ';
  }
  return parts.join(' && ') + ' && ';
}
