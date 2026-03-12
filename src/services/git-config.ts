import fs from 'node:fs';
import path from 'node:path';
import type { FleetGitConfig, GitHubAppConfig } from '../types.js';
import { enforceOwnerOnly } from '../utils/file-permissions.js';
import { FLEET_DIR } from '../paths.js';
const GIT_CONFIG_PATH = path.join(FLEET_DIR, 'git-config.json');

function ensureFleetDir(): void {
  if (!fs.existsSync(FLEET_DIR)) {
    fs.mkdirSync(FLEET_DIR, { recursive: true, mode: 0o700 });
  }
}

export function loadGitConfig(): FleetGitConfig {
  ensureFleetDir();
  if (!fs.existsSync(GIT_CONFIG_PATH)) return { version: '1.0' };
  const raw = fs.readFileSync(GIT_CONFIG_PATH, 'utf-8');
  return JSON.parse(raw) as FleetGitConfig;
}

export function saveGitConfig(config: FleetGitConfig): void {
  ensureFleetDir();
  fs.writeFileSync(GIT_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  enforceOwnerOnly(GIT_CONFIG_PATH);
}

export function getGitHubApp(): GitHubAppConfig | undefined {
  return loadGitConfig().github;
}

export function setGitHubApp(config: GitHubAppConfig): void {
  const gitConfig = loadGitConfig();
  gitConfig.github = config;
  saveGitConfig(gitConfig);
}
