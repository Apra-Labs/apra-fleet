import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { FLEET_DIR } from './test-helpers.js';
import { credentialSet, credentialDelete } from '../src/services/credential-store.js';
import { setupGitApp } from '../src/tools/setup-git-app.js';
const GIT_CONFIG_PATH = path.join(FLEET_DIR, 'git-config.json');
const STORED_KEY_PATH = path.join(FLEET_DIR, 'github-app.pem');

// Generate a test key for valid PEM tests
const { privateKey: testPrivateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

let gitConfigBackup: string | null = null;
let storedKeyBackup: string | null = null;

// Mock the GitHub API verification
vi.mock('../src/services/github-app.js', async () => {
  const actual = await vi.importActual<typeof import('../src/services/github-app.js')>('../src/services/github-app.js');
  return {
    ...actual,
    verifyAppConnectivity: vi.fn(),
  };
});

import { verifyAppConnectivity } from '../src/services/github-app.js';
const mockVerify = vi.mocked(verifyAppConnectivity);

beforeEach(() => {
  vi.clearAllMocks();
  if (fs.existsSync(GIT_CONFIG_PATH)) {
    gitConfigBackup = fs.readFileSync(GIT_CONFIG_PATH, 'utf-8');
    fs.unlinkSync(GIT_CONFIG_PATH);
  }
  if (fs.existsSync(STORED_KEY_PATH)) {
    storedKeyBackup = fs.readFileSync(STORED_KEY_PATH, 'utf-8');
    fs.unlinkSync(STORED_KEY_PATH);
  }
});

afterEach(() => {
  if (gitConfigBackup !== null) {
    fs.writeFileSync(GIT_CONFIG_PATH, gitConfigBackup);
    gitConfigBackup = null;
  } else if (fs.existsSync(GIT_CONFIG_PATH)) {
    fs.unlinkSync(GIT_CONFIG_PATH);
  }
  if (storedKeyBackup !== null) {
    fs.writeFileSync(STORED_KEY_PATH, storedKeyBackup);
    storedKeyBackup = null;
  } else if (fs.existsSync(STORED_KEY_PATH)) {
    fs.unlinkSync(STORED_KEY_PATH);
  }
});

describe('setupGitApp', () => {
  it('rejects when PEM file does not exist', async () => {
    const result = await setupGitApp({
      app_id: '12345',
      private_key_path: '/nonexistent/key.pem',
      installation_id: 99999,
    });
    expect(result).toContain('❌');
    expect(result).toContain('not found');
  });

  it('rejects invalid PEM content', async () => {
    const tmpFile = path.join(os.tmpdir(), `fleet-test-bad-${Date.now()}.pem`);
    fs.writeFileSync(tmpFile, 'this is not a key');
    try {
      const result = await setupGitApp({
        app_id: '12345',
        private_key_path: tmpFile,
        installation_id: 99999,
      });
      expect(result).toContain('❌');
      expect(result).toContain('does not start with');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('returns error when GitHub API verification fails', async () => {
    const tmpFile = path.join(os.tmpdir(), `fleet-test-key-${Date.now()}.pem`);
    fs.writeFileSync(tmpFile, testPrivateKey);
    mockVerify.mockResolvedValue({ ok: false, error: 'GET /app failed (401): Bad credentials' });

    try {
      const result = await setupGitApp({
        app_id: '12345',
        private_key_path: tmpFile,
        installation_id: 99999,
      });
      expect(result).toContain('❌');
      expect(result).toContain('verification failed');
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('stores config and copies PEM on successful verification', async () => {
    const tmpFile = path.join(os.tmpdir(), `fleet-test-key-${Date.now()}.pem`);
    fs.writeFileSync(tmpFile, testPrivateKey);
    mockVerify.mockResolvedValue({ ok: true, appName: 'claude-fleet-git', orgName: 'Apra-Labs' });

    try {
      const result = await setupGitApp({
        app_id: '12345',
        private_key_path: tmpFile,
        installation_id: 99999,
      });

      expect(result).toContain('✅');
      expect(result).toContain('claude-fleet-git');
      expect(result).toContain('Apra-Labs');
      expect(result).toContain('99999');

      // Verify PEM was copied
      expect(fs.existsSync(STORED_KEY_PATH)).toBe(true);
      const storedKey = fs.readFileSync(STORED_KEY_PATH, 'utf-8').trim();
      expect(storedKey).toBe(testPrivateKey.trim());

      // Verify config was stored
      expect(fs.existsSync(GIT_CONFIG_PATH)).toBe(true);
      const config = JSON.parse(fs.readFileSync(GIT_CONFIG_PATH, 'utf-8'));
      expect(config.github.appId).toBe('12345');
      expect(config.github.installationId).toBe(99999);
      expect(config.github.privateKeyPath).toBe(STORED_KEY_PATH);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('is idempotent — overwrites previous config on re-run', async () => {
    const tmpFile = path.join(os.tmpdir(), `fleet-test-key-${Date.now()}.pem`);
    fs.writeFileSync(tmpFile, testPrivateKey);
    mockVerify.mockResolvedValue({ ok: true, appName: 'app-v1', orgName: 'org-v1' });

    try {
      await setupGitApp({ app_id: '111', private_key_path: tmpFile, installation_id: 1 });
      mockVerify.mockResolvedValue({ ok: true, appName: 'app-v2', orgName: 'org-v2' });
      const result = await setupGitApp({ app_id: '222', private_key_path: tmpFile, installation_id: 2 });

      expect(result).toContain('app-v2');
      const config = JSON.parse(fs.readFileSync(GIT_CONFIG_PATH, 'utf-8'));
      expect(config.github.appId).toBe('222');
      expect(config.github.installationId).toBe(2);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  // --- {{secure.NAME}} token resolution ---

  it('resolves {{secure.NAME}} in private_key_path to PEM content and deletes temp file', async () => {
    credentialSet('TEST_PEM', testPrivateKey, false, 'allow');
    mockVerify.mockResolvedValue({ ok: true, appName: 'fleet-app', orgName: 'TestOrg' });

    const tmpBefore = fs.readdirSync(os.tmpdir()).filter(
      f => f.startsWith('apra-fleet-gitapp-') && f.endsWith('.pem'),
    );

    const result = await setupGitApp({
      app_id: '12345',
      private_key_path: '{{secure.TEST_PEM}}',
      installation_id: 99999,
    });

    expect(result).toContain('✅');
    expect(result).toContain('fleet-app');
    expect(result).toContain('TestOrg');

    const tmpAfter = fs.readdirSync(os.tmpdir()).filter(
      f => f.startsWith('apra-fleet-gitapp-') && f.endsWith('.pem'),
    );
    expect(tmpAfter.length).toBe(tmpBefore.length);

    credentialDelete('TEST_PEM');
  });

  it('returns error when {{secure.NAME}} credential is not found for private_key_path', async () => {
    const result = await setupGitApp({
      app_id: '12345',
      private_key_path: '{{secure.NONEXISTENT_PEM}}',
      installation_id: 99999,
    });
    expect(result).toContain('❌');
    expect(result).toContain('NONEXISTENT_PEM');
  });
});
