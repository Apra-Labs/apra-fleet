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

export interface ProviderInstallConfig {
  configDir: string;
  settingsFile: string;
  skillsDir: string;
  fleetSkillsDir: string;
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
    case 'gemini':
      return {
        configDir: path.join(home, '.gemini'),
        settingsFile: path.join(home, '.gemini', 'settings.json'),
        skillsDir: path.join(home, '.gemini', 'skills', 'pm'),
        fleetSkillsDir: path.join(home, '.gemini', 'skills', 'fleet'),
        name: 'Gemini',
      };
    case 'codex':
      return {
        configDir: path.join(home, '.codex'),
        settingsFile: path.join(home, '.codex', 'config.toml'),
        skillsDir: path.join(home, '.codex', 'skills', 'pm'),
        fleetSkillsDir: path.join(home, '.codex', 'skills', 'fleet'),
        name: 'Codex',
      };
    case 'copilot':
      return {
        configDir: path.join(home, '.copilot'),
        settingsFile: path.join(home, '.copilot', 'settings.json'),
        skillsDir: path.join(home, '.copilot', 'skills', 'pm'),
        fleetSkillsDir: path.join(home, '.copilot', 'skills', 'fleet'),
        name: 'Copilot',
      };
    case 'claude':
    default:
      return {
        configDir: path.join(home, '.claude'),
        settingsFile: path.join(home, '.claude', 'settings.json'),
        skillsDir: path.join(home, '.claude', 'skills', 'pm'),
        fleetSkillsDir: path.join(home, '.claude', 'skills', 'fleet'),
        name: 'Claude',
      };
  }
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
