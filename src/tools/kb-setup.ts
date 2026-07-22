import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FLEET_DIR } from '../paths.js';
import { installKbPostCommitHook } from './kb-invalidate.js';
import { encryptPassword } from '../utils/crypto.js';
import { detectProviderAvailability } from '../services/knowledge/pre-init.js';
import { readRepoCodeIntelConfig, writeRepoCodeIntelConfig } from '../services/knowledge/repo-config.js';

// Generous ceiling on how long a first-time index can run before kb_setup
// gives up and reports failure -- long enough for large repos, short enough
// to not hang the calling process forever.
const INDEX_TIMEOUT_MS = 10 * 60 * 1000;

export const kbSetupSchema = z.object({
  repo_path: z.string().optional()
    .describe('Path to git repository for post-commit hook installation (default: current directory)'),
  provider: z.enum(['sqlite', 'http']).optional()
    .describe('KB provider type (default: sqlite)'),
  remote: z.string().optional()
    .describe('Remote KB server URL (required when provider=http)'),
  token: z.string().optional()
    .describe('Authentication token for remote KB server (stored encrypted, never logged)'),
});

export type KbSetupInput = z.infer<typeof kbSetupSchema>;

const KB_CONFIG_DIR = path.join(FLEET_DIR, 'knowledge');
const KB_CONFIG_PATH = path.join(KB_CONFIG_DIR, 'config.json');

export async function kbSetup(input: KbSetupInput): Promise<string> {
  const steps: string[] = [];

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

  // First-time code-intel indexing: skip if already indexed (idempotent),
  // skip if the provider isn't installed, otherwise index and record the
  // result in .apra-fleet/code-intel.json.
  let indexError: string | undefined;
  const existingCodeIntelConfig = readRepoCodeIntelConfig(repoPath);
  if (existingCodeIntelConfig?.indexedAt) {
    steps.push(`Code intelligence already indexed at ${existingCodeIntelConfig.indexedAt}, skipping re-index`);
  } else {
    const availability = detectProviderAvailability();
    if (!availability.available) {
      steps.push(`Skipped code-intel indexing: provider not available (${availability.error})`);
    } else {
      try {
        execFileSync(availability.provider, ['cli', 'index_repository', JSON.stringify({ repo_path: repoPath })], {
          encoding: 'utf-8',
          timeout: INDEX_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        writeRepoCodeIntelConfig(repoPath, { enabled: true, indexedAt: new Date().toISOString() });
        steps.push('Indexed repository for code intelligence');
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        indexError =
          `Code-intel indexing failed: ${detail}. Run '${availability.provider} cli index_repository ` +
          `\'{"repo_path": "${repoPath}"}\'' manually and retry kb_setup.`;
        steps.push(indexError);
      }
    }
  }

  return JSON.stringify({ success: !indexError, steps, ...(indexError ? { error: indexError } : {}) });
}
