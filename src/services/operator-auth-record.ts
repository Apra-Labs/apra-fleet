/**
 * Where `apra-fleet operator-auth github` records the operator's own GitHub
 * credential (src/cli/operator-auth.ts), and whether one is set up.
 *
 * The dispatch path (vcs-git-env.ts) reads it: once the operator helper sits
 * on the global credential.https://github.com.helper key, a local member's
 * git would fall through to it and silently push with the operator's
 * installation-wide token. Members never get the operator credential.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../paths.js';

/** The URL the operator helper is registered for. */
export const OPERATOR_SCOPE_URL = 'https://github.com';

export function operatorAuthRecordPath(): string {
  return path.join(FLEET_DIR, 'operator-auth.json');
}

/** True when operator-auth github has registered at least one label on this host. */
export function hasOperatorGithubCredential(file: string = operatorAuthRecordPath()): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { github?: unknown };
    return !!parsed && typeof parsed.github === 'object' && parsed.github !== null
      && Object.keys(parsed.github).length > 0;
  } catch {
    return false;
  }
}
