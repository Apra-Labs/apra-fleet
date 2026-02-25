import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getStrategy } from '../src/services/strategy.js';
import type { Agent } from '../src/types.js';

function makeLocalAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'local-test',
    friendlyName: 'local-dev',
    agentType: 'local',
    remoteFolder: path.join(os.tmpdir(), `fleet-test-${Date.now()}`),
    os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRemoteAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'remote-test',
    friendlyName: 'remote-dev',
    agentType: 'remote',
    host: '192.168.1.100',
    port: 22,
    username: 'testuser',
    authType: 'password',
    encryptedPassword: 'fake-encrypted',
    remoteFolder: '/home/testuser/project',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('getStrategy() factory', () => {
  it('returns LocalStrategy for local agents', () => {
    const agent = makeLocalAgent();
    const strategy = getStrategy(agent);
    // LocalStrategy.testConnection() always returns ok: true, latencyMs: 0
    expect(strategy).toBeDefined();
    expect(strategy.testConnection).toBeTypeOf('function');
    expect(strategy.execCommand).toBeTypeOf('function');
    expect(strategy.transferFiles).toBeTypeOf('function');
    expect(strategy.close).toBeTypeOf('function');
  });

  it('returns RemoteStrategy for remote agents', () => {
    const agent = makeRemoteAgent();
    const strategy = getStrategy(agent);
    expect(strategy).toBeDefined();
    expect(strategy.testConnection).toBeTypeOf('function');
    expect(strategy.execCommand).toBeTypeOf('function');
    expect(strategy.transferFiles).toBeTypeOf('function');
    expect(strategy.close).toBeTypeOf('function');
  });
});

describe('LocalStrategy', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `fleet-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('testConnection() always returns ok:true with latencyMs:0', async () => {
    const agent = makeLocalAgent({ remoteFolder: tmpDir });
    const strategy = getStrategy(agent);
    const result = await strategy.testConnection();
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('execCommand() runs command locally and returns stdout/code', async () => {
    const agent = makeLocalAgent({ remoteFolder: tmpDir });
    const strategy = getStrategy(agent);

    const result = await strategy.execCommand('echo hello-fleet');
    expect(result.stdout.trim()).toBe('hello-fleet');
    expect(result.code).toBe(0);
  });

  it('execCommand() returns non-zero code for failed commands', async () => {
    const agent = makeLocalAgent({ remoteFolder: tmpDir });
    const strategy = getStrategy(agent);

    const result = await strategy.execCommand('exit 42');
    expect(result.code).not.toBe(0);
  });

  it('transferFiles() copies files to target folder', async () => {
    const agent = makeLocalAgent({ remoteFolder: tmpDir });
    const strategy = getStrategy(agent);

    // Create a source file
    const srcFile = path.join(os.tmpdir(), `fleet-src-${Date.now()}.txt`);
    fs.writeFileSync(srcFile, 'test content');

    try {
      const result = await strategy.transferFiles([srcFile]);
      expect(result.success).toContain(path.basename(srcFile));
      expect(result.failed).toHaveLength(0);

      // Verify file was copied
      const destFile = path.join(tmpDir, path.basename(srcFile));
      expect(fs.existsSync(destFile)).toBe(true);
      expect(fs.readFileSync(destFile, 'utf-8')).toBe('test content');
    } finally {
      fs.unlinkSync(srcFile);
    }
  });

  it('transferFiles() copies to subfolder', async () => {
    const agent = makeLocalAgent({ remoteFolder: tmpDir });
    const strategy = getStrategy(agent);

    const srcFile = path.join(os.tmpdir(), `fleet-src-${Date.now()}.txt`);
    fs.writeFileSync(srcFile, 'sub content');

    try {
      const result = await strategy.transferFiles([srcFile], 'sub');
      expect(result.success).toContain(path.basename(srcFile));

      const destFile = path.join(tmpDir, 'sub', path.basename(srcFile));
      expect(fs.existsSync(destFile)).toBe(true);
    } finally {
      fs.unlinkSync(srcFile);
    }
  });

  it('close() is a no-op and does not throw', () => {
    const agent = makeLocalAgent({ remoteFolder: tmpDir });
    const strategy = getStrategy(agent);
    expect(() => strategy.close()).not.toThrow();
  });
});
