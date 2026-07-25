import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

export interface RepoCodeIntelConfig {
  enabled?: boolean;
}

function configPath(repoPath: string): string {
  return join(repoPath, '.apra-fleet', 'code-intel.json');
}

export async function readRepoCodeIntelConfig(repoPath: string): Promise<RepoCodeIntelConfig | null> {
  try {
    const raw = await readFile(configPath(repoPath), 'utf8');
    return JSON.parse(raw) as RepoCodeIntelConfig;
  } catch {
    return null;
  }
}

export async function writeRepoCodeIntelConfig(repoPath: string, config: RepoCodeIntelConfig): Promise<void> {
  await mkdir(join(repoPath, '.apra-fleet'), { recursive: true });
  await writeFile(configPath(repoPath), JSON.stringify(config, null, 2));
}

// Backward compat: a repo with no config file has code intelligence enabled.
export async function isCodeIntelEnabled(repoPath: string): Promise<boolean> {
  const config = await readRepoCodeIntelConfig(repoPath);
  if (!config) return true;
  return config.enabled !== false;
}
