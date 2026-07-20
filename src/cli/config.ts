import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse, stringify } from 'smol-toml';
import type { LlmProvider } from '../types.js';

const home = os.homedir();
export const FLEET_BASE = path.join(home, '.apra-fleet');
export const BIN_DIR = path.join(FLEET_BASE, 'bin');
export const HOOKS_DIR = path.join(FLEET_BASE, 'hooks');
export const SCRIPTS_DIR = path.join(FLEET_BASE, 'scripts');
export const DATA_DIR = path.join(FLEET_BASE, 'data');
export const INSTALL_CONFIG_PATH = path.join(DATA_DIR, 'install-config.json');

// Claude entries use the bare family aliases (haiku/sonnet/opus) instead of
// dated model IDs -- the claude CLI/settings.json resolve these to the
// current generation automatically, so they never go stale as Anthropic
// ships new models. Other providers' CLIs don't share this alias support,
// so their entries stay pinned to literal model IDs.
export const CURATED_CHEAP_MODELS = [
  'gpt-oss-120b',
  'gpt-120',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite-preview',
  'haiku',
  'gpt-5.4-mini',
] as const;

export const CURATED_STANDARD_MODELS = [
  'gemini-3.5-flash',
  'gpt-oss-120b',
  'gpt-120',
  'sonnet',
  'gemini-3-flash-preview',
  'gpt-5.4',
] as const;

export const CURATED_PREMIUM_MODELS = [
  'sonnet',
  'opus',
  'gpt-oss-120b',
  'gemini-3.1-pro-preview',
] as const;

export const PROVIDER_STANDARD_MODELS: Record<string, string> = {
  claude: 'sonnet',
  gemini: 'gemini-3.5-flash',
  codex: 'gpt-5.4',
  copilot: 'claude-sonnet-4-5',
  agy: 'gemini-3.5-flash',
  opencode: 'ollama/qwen3-coder:30b',
};

export interface ProviderInstallConfig {
  configDir: string;
  settingsFile: string;
  skillsDir: string;
  fleetSkillsDir: string;
  agentsDir: string | undefined;
  name: string;
}

export interface MultiProviderInstallConfig {
  providers: Record<string, {
    skill: 'none' | 'all' | 'fleet' | 'pm';
    installedAt: string;
  }>;
}

export function getProviderInstallConfig(provider: LlmProvider): ProviderInstallConfig {
  switch (provider) {
    case 'agy':
      return {
        configDir: path.join(home, '.gemini', 'antigravity-cli'),
        settingsFile: path.join(home, '.gemini', 'antigravity-cli', 'settings.json'),
        skillsDir: path.join(home, '.gemini', 'antigravity-cli', 'skills', 'pm'),
        fleetSkillsDir: path.join(home, '.gemini', 'antigravity-cli', 'skills', 'fleet'),
        agentsDir: path.join(home, '.gemini', 'antigravity-cli', 'agents'),
        name: 'Antigravity',
      };
    case 'gemini':
      return {
        configDir: path.join(home, '.gemini'),
        settingsFile: path.join(home, '.gemini', 'settings.json'),
        skillsDir: path.join(home, '.gemini', 'skills', 'pm'),
        fleetSkillsDir: path.join(home, '.gemini', 'skills', 'fleet'),
        agentsDir: path.join(home, '.gemini', 'agents'),
        name: 'Gemini',
      };
    case 'codex':
      return {
        configDir: path.join(home, '.codex'),
        settingsFile: path.join(home, '.codex', 'config.toml'),
        skillsDir: path.join(home, '.codex', 'skills', 'pm'),
        fleetSkillsDir: path.join(home, '.codex', 'skills', 'fleet'),
        agentsDir: undefined,
        name: 'Codex',
      };
    case 'copilot':
      return {
        configDir: path.join(home, '.copilot'),
        settingsFile: path.join(home, '.copilot', 'settings.json'),
        skillsDir: path.join(home, '.copilot', 'skills', 'pm'),
        fleetSkillsDir: path.join(home, '.copilot', 'skills', 'fleet'),
        agentsDir: undefined,
        name: 'Copilot',
      };
    case 'opencode':
      return {
        configDir: path.join(home, '.config', 'opencode'),
        settingsFile: path.join(home, '.config', 'opencode', 'opencode.json'),
        skillsDir: path.join(home, '.config', 'opencode', 'skills', 'pm'),
        fleetSkillsDir: path.join(home, '.config', 'opencode', 'skills', 'fleet'),
        agentsDir: path.join(home, '.config', 'opencode', 'agents'),
        name: 'OpenCode',
      };
    case 'claude':
    default:
      return {
        configDir: path.join(home, '.claude'),
        settingsFile: path.join(home, '.claude', 'settings.json'),
        skillsDir: path.join(home, '.claude', 'skills', 'pm'),
        fleetSkillsDir: path.join(home, '.claude', 'skills', 'fleet'),
        agentsDir: path.join(home, '.claude', 'agents'),
        name: 'Claude',
      };
  }
}

/**
 * Home-relative agents dir for a provider (e.g. '.claude/agents'), or undefined
 * when the provider has no agents dir (codex, copilot). Derived from
 * getProviderInstallConfig() so install and remote provisioning cannot drift.
 */
export function getAgentsDirRelative(provider: LlmProvider): string | undefined {
  const paths = getProviderInstallConfig(provider);
  if (!paths.agentsDir) return undefined;
  return path.relative(home, paths.agentsDir).replace(/\\/g, '/');
}

export function readConfig(paths: ProviderInstallConfig): any {
  if (!fs.existsSync(paths.settingsFile)) return {};
  const content = fs.readFileSync(paths.settingsFile, 'utf-8').trim();
  if (!content) return {};

  if (paths.settingsFile.endsWith('.toml')) {
    try {
      return parse(content);
    } catch {
      return {};
    }
  }
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export function writeConfig(paths: ProviderInstallConfig, config: any): void {
  fs.mkdirSync(paths.configDir, { recursive: true });
  let content = '';
  if (paths.settingsFile.endsWith('.toml')) {
    content = stringify(config);
  } else {
    content = JSON.stringify(config, null, 2) + '\n';
  }
  fs.writeFileSync(paths.settingsFile, content);
}

export function readInstallConfig(): MultiProviderInstallConfig {
  if (!fs.existsSync(INSTALL_CONFIG_PATH)) {
    return { providers: {} };
  }
  try {
    const data = JSON.parse(fs.readFileSync(INSTALL_CONFIG_PATH, 'utf-8'));
    // Handle old format migration
    if (data.llm && data.skill) {
      return {
        providers: {
          [data.llm]: {
            skill: data.skill,
            installedAt: new Date().toISOString()
          }
        }
      };
    }
    // Ensure providers object exists
    if (!data.providers || typeof data.providers !== 'object') {
      return { providers: {} };
    }
    return data as MultiProviderInstallConfig;
  } catch {
    return { providers: {} };
  }
}

export function writeInstallConfig(llm: string, skill: 'none' | 'all' | 'fleet' | 'pm'): void {
  const config = readInstallConfig();
  config.providers[llm] = {
    skill,
    installedAt: new Date().toISOString()
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(INSTALL_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}
