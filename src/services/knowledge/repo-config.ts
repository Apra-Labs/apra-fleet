// ---------------------------------------------------------------------------
// Per-repo code-intel config: reads and writes .apra-fleet/code-intel.json,
// which records whether a repo has been indexed for code intelligence (see
// apra-fleet-t0d.2.1).
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface RepoCodeIntelConfig {
  enabled: boolean;
  indexedAt?: string;
}

function configPath(repoPath: string): string {
  return join(repoPath, '.apra-fleet', 'code-intel.json');
}

// Read .apra-fleet/code-intel.json for a repo. Returns null when the file is
// missing or unparseable.
export function readRepoCodeIntelConfig(repoPath: string): RepoCodeIntelConfig | null {
  const filePath = configPath(repoPath);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as RepoCodeIntelConfig;
  } catch {
    return null;
  }
}

// Write .apra-fleet/code-intel.json for a repo, creating the .apra-fleet
// directory if it does not already exist.
export function writeRepoCodeIntelConfig(repoPath: string, config: RepoCodeIntelConfig): void {
  const dir = join(repoPath, '.apra-fleet');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath(repoPath), JSON.stringify(config, null, 2));
}
