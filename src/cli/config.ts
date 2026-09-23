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
// Workflow subsystem (apra-fleet workflow <name>) -- see
// docs/workflow-subsystem-plan.md Section 2.1 for the on-disk layout.
export const NODE_MODULES_DIR = path.join(FLEET_BASE, 'node_modules');
export const SCHEMAS_DIR = path.join(FLEET_BASE, 'schemas');
export const WORKFLOWS_DIR = path.join(FLEET_BASE, 'workflows');

// Claude entries use the bare family aliases (haiku/sonnet/opus) instead of
// dated model IDs -- the claude CLI/settings.json resolve these to the
// current generation automatically, so they never go stale as Anthropic
// ships new models. Other providers' CLIs don't share this alias support,
// so their entries stay pinned to literal model IDs.
// The gemini-*/claude-*-thinking entries are AGY's (Antigravity's) own model
// ids, not the removed gemini provider's -- AGY is built on Google's Gemini
// stack and inherits its model catalog. They are the STABLE slug ids `agy
// models` prints, and must stay in step with AGY_MODEL_FOR_TIER in
// src/providers/agy.ts: a slug AGY does not recognize is not a soft fallback,
// it fails the dispatch outright with "invalid model selection".
export const CURATED_CHEAP_MODELS = [
  'gpt-oss-120b',
  'gpt-120',
  'gemini-3.8-flash-low',
  'haiku',
  'gpt-5.4-mini',
] as const;

export const CURATED_STANDARD_MODELS = [
  'gemini-3.1-pro-low',
  'gpt-oss-120b',
  'gpt-120',
  'sonnet',
  'gpt-5.4',
] as const;

export const CURATED_PREMIUM_MODELS = [
  'sonnet',
  'opus',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b',
] as const;

export const PROVIDER_STANDARD_MODELS: Record<string, string> = {
  claude: 'sonnet',
  codex: 'gpt-5.4',
  copilot: 'claude-sonnet-4-5',
  agy: 'gemini-3.1-pro-low',
  opencode: 'ollama/qwen3-coder:30b',
};

/** Supported install targets, in deterministic profile-discovery fallback order. */
export const INSTALLABLE_LLM_PROVIDERS: readonly LlmProvider[] = [
  'claude', 'codex', 'copilot', 'agy', 'opencode',
];

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
    // Optional for backward compatibility -- older install-config.json files
    // (written before the workflow subsystem existed) won't have this field.
    workflowsMode?: 'all' | 'none';
    installedAt: string;
  }>;
}

export function getProviderInstallConfig(provider: LlmProvider, homeDir = home): ProviderInstallConfig {
  switch (provider) {
    case 'agy':
      return {
        configDir: path.join(homeDir, '.gemini', 'antigravity-cli'),
        settingsFile: path.join(homeDir, '.gemini', 'antigravity-cli', 'settings.json'),
        skillsDir: path.join(homeDir, '.gemini', 'antigravity-cli', 'skills', 'pm'),
        fleetSkillsDir: path.join(homeDir, '.gemini', 'antigravity-cli', 'skills', 'fleet'),
        agentsDir: path.join(homeDir, '.gemini', 'antigravity-cli', 'agents'),
        name: 'Antigravity',
      };
    case 'codex':
      return {
        configDir: path.join(homeDir, '.codex'),
        settingsFile: path.join(homeDir, '.codex', 'config.toml'),
        skillsDir: path.join(homeDir, '.codex', 'skills', 'pm'),
        fleetSkillsDir: path.join(homeDir, '.codex', 'skills', 'fleet'),
        agentsDir: undefined,
        name: 'Codex',
      };
    case 'copilot':
      return {
        configDir: path.join(homeDir, '.copilot'),
        settingsFile: path.join(homeDir, '.copilot', 'settings.json'),
        skillsDir: path.join(homeDir, '.copilot', 'skills', 'pm'),
        fleetSkillsDir: path.join(homeDir, '.copilot', 'skills', 'fleet'),
        agentsDir: undefined,
        name: 'Copilot',
      };
    case 'opencode':
      return {
        configDir: path.join(homeDir, '.config', 'opencode'),
        settingsFile: path.join(homeDir, '.config', 'opencode', 'opencode.json'),
        skillsDir: path.join(homeDir, '.config', 'opencode', 'skills', 'pm'),
        fleetSkillsDir: path.join(homeDir, '.config', 'opencode', 'skills', 'fleet'),
        agentsDir: path.join(homeDir, '.config', 'opencode', 'agents'),
        name: 'OpenCode',
      };
    case 'claude':
    default:
      return {
        configDir: path.join(homeDir, '.claude'),
        settingsFile: path.join(homeDir, '.claude', 'settings.json'),
        skillsDir: path.join(homeDir, '.claude', 'skills', 'pm'),
        fleetSkillsDir: path.join(homeDir, '.claude', 'skills', 'fleet'),
        agentsDir: path.join(homeDir, '.claude', 'agents'),
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

export function readInstallConfig(installConfigPath = INSTALL_CONFIG_PATH): MultiProviderInstallConfig {
  if (!fs.existsSync(installConfigPath)) {
    return { providers: {} };
  }
  try {
    const data = JSON.parse(fs.readFileSync(installConfigPath, 'utf-8'));
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

export function writeInstallConfig(
  llm: string,
  skill: 'none' | 'all' | 'fleet' | 'pm',
  workflowsMode: 'all' | 'none' = 'all'
): void {
  const config = readInstallConfig();
  config.providers[llm] = {
    skill,
    workflowsMode,
    installedAt: new Date().toISOString()
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(INSTALL_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}
