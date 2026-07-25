import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Per-repo code-intelligence config, stored at <repoPath>/.apra-fleet/code-intel.json.
 * Lets a repo opt out of code-intelligence tooling (indexing, code_graph/impact/
 * query/etc.) without touching global fleet config.
 */
export interface RepoCodeIntelConfig {
  enabled?: boolean;
}

const CONFIG_DIR_NAME = '.apra-fleet';
const CONFIG_FILE_NAME = 'code-intel.json';

function configPath(repoPath: string): string {
  return path.join(repoPath, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

/**
 * Reads .apra-fleet/code-intel.json from the given repo path.
 * Returns null when the file is missing or unparseable.
 */
export async function readRepoCodeIntelConfig(repoPath: string): Promise<RepoCodeIntelConfig | null> {
  try {
    const raw = await readFile(configPath(repoPath), 'utf8');
    return JSON.parse(raw) as RepoCodeIntelConfig;
  } catch {
    return null;
  }
}

/**
 * Writes .apra-fleet/code-intel.json under the given repo path, creating the
 * .apra-fleet directory if needed.
 */
export async function writeRepoCodeIntelConfig(repoPath: string, config: RepoCodeIntelConfig): Promise<void> {
  await mkdir(path.join(repoPath, CONFIG_DIR_NAME), { recursive: true });
  await writeFile(configPath(repoPath), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/**
 * Whether code-intelligence tooling is enabled for the given repo. Missing
 * config defaults to true (backward compat); only an explicit enabled:false
 * turns it off.
 */
export async function isCodeIntelEnabled(repoPath: string): Promise<boolean> {
  const config = await readRepoCodeIntelConfig(repoPath);
  if (!config) return true;
  return config.enabled !== false;
}
