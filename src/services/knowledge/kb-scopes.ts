import fs from 'fs';
import path from 'path';
import { FLEET_DIR } from '../../paths.js';

// Enumerates the KB scopes that exist on disk under FLEET_DIR/knowledge/.
//
// The fleet server is ONE long-lived process serving every project a user
// works on, so anything that reports on "the KB" server-side must look at
// every scope rather than derive one from the server's own process.cwd()
// (which is arbitrary -- e.g. C:\Windows\System32 for a detached launch).
// Each scope is a directory named by its project slug (see project-slug.ts)
// holding a kb.sqlite; `global` is the single shared cross-project KB, and
// `default` is where captures from non-git directories land. Other entries in
// the knowledge dir (config.json, kb-server token files) are not scopes and
// are ignored: only a directory containing kb.sqlite counts.

export const GLOBAL_KB_SCOPE = 'global';
export const DEFAULT_KB_SCOPE = 'default';

export interface KbScopeLocation {
  slug: string;
  dbPath: string;
}

export function knowledgeRootDir(): string {
  return path.join(FLEET_DIR, 'knowledge');
}

/**
 * List every scope directory under `knowledgeDir` that holds a kb.sqlite,
 * sorted by slug. Never throws: an absent or unreadable knowledge dir yields
 * an empty list. Read-only -- never creates a directory or database.
 */
export function listKbScopes(knowledgeDir: string = knowledgeRootDir()): KbScopeLocation[] {
  let names: string[];
  try {
    names = fs.readdirSync(knowledgeDir);
  } catch {
    return [];
  }
  const scopes: KbScopeLocation[] = [];
  for (const name of names) {
    const dbPath = path.join(knowledgeDir, name, 'kb.sqlite');
    try {
      if (fs.statSync(path.join(knowledgeDir, name)).isDirectory() && fs.statSync(dbPath).isFile()) {
        scopes.push({ slug: name, dbPath });
      }
    } catch {
      // Not a scope (plain file, missing kb.sqlite, or unreadable) -- skip.
    }
  }
  return scopes.sort((a, b) => a.slug.localeCompare(b.slug));
}
