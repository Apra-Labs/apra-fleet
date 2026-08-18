import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';

// Per-repo control file for the code-intelligence opt-out story
// (apra-fleet-le1.1). Lives at <repoPath>/.apra-fleet/code-intel.json.
// Absence of the file means enabled -- see isCodeIntelEnabled().
export interface RepoCodeIntelConfig {
  enabled: boolean;
  indexedAt?: string;
}

export function repoCodeIntelConfigPath(repoPath: string): string {
  return join(repoPath, '.apra-fleet', 'code-intel.json');
}

export async function readRepoCodeIntelConfig(repoPath: string): Promise<RepoCodeIntelConfig | null> {
  try {
    const raw = await readFile(repoCodeIntelConfigPath(repoPath), 'utf8');
    return JSON.parse(raw) as RepoCodeIntelConfig;
  } catch {
    // Missing file, unreadable, or malformed JSON -- treat as "no config".
    return null;
  }
}

export async function writeRepoCodeIntelConfig(repoPath: string, config: RepoCodeIntelConfig): Promise<void> {
  const configPath = repoCodeIntelConfigPath(repoPath);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

// Backward compat: a repo with no config file (or an unreadable/malformed
// one) defaults to enabled. Only an explicit enabled=false opts out.
export async function isCodeIntelEnabled(repoPath: string): Promise<boolean> {
  const config = await readRepoCodeIntelConfig(repoPath);
  return config?.enabled !== false;
}
