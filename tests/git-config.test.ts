import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadGitConfig, saveGitConfig, getGitHubApp, setGitHubApp } from '../src/services/git-config.js';
import type { FleetGitConfig, GitHubAppConfig } from '../src/types.js';

const FLEET_DIR = path.join(os.homedir(), '.claude-fleet');
const GIT_CONFIG_PATH = path.join(FLEET_DIR, 'git-config.json');

let backupContent: string | null = null;

beforeEach(() => {
  if (fs.existsSync(GIT_CONFIG_PATH)) {
    backupContent = fs.readFileSync(GIT_CONFIG_PATH, 'utf-8');
    fs.unlinkSync(GIT_CONFIG_PATH);
  }
});

afterEach(() => {
  if (backupContent !== null) {
    fs.writeFileSync(GIT_CONFIG_PATH, backupContent);
    backupContent = null;
  } else if (fs.existsSync(GIT_CONFIG_PATH)) {
    fs.unlinkSync(GIT_CONFIG_PATH);
  }
});

describe('git-config', () => {
  it('returns empty config when file does not exist', () => {
    const config = loadGitConfig();
    expect(config).toEqual({ version: '1.0' });
    expect(config.github).toBeUndefined();
  });

  it('round-trips a full config through save and load', () => {
    const config: FleetGitConfig = {
      version: '1.0',
      github: {
        appId: '12345',
        privateKeyPath: '/tmp/test.pem',
        installationId: 99999,
        createdAt: '2026-03-03T00:00:00Z',
      },
    };
    saveGitConfig(config);
    const loaded = loadGitConfig();
    expect(loaded).toEqual(config);
  });

  it('saves with restrictive file permissions', () => {
    saveGitConfig({ version: '1.0' });
    expect(fs.existsSync(GIT_CONFIG_PATH)).toBe(true);
    if (process.platform !== 'win32') {
      const stat = fs.statSync(GIT_CONFIG_PATH);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('setGitHubApp + getGitHubApp round-trip', () => {
    const appConfig: GitHubAppConfig = {
      appId: '12345',
      privateKeyPath: '/home/test/.claude-fleet/github-app.pem',
      installationId: 99999,
      createdAt: '2026-03-03T12:00:00Z',
    };
    setGitHubApp(appConfig);
    expect(getGitHubApp()).toEqual(appConfig);
  });

  it('getGitHubApp returns undefined when not configured', () => {
    expect(getGitHubApp()).toBeUndefined();
  });
});
