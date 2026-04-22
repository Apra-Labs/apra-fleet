import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getStrategy } from '../src/services/strategy.js';
import { makeTestAgent, makeTestLocalAgent } from './test-helpers.js';

const makeLocalAgent = makeTestLocalAgent;

describe('LocalStrategy', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `fleet-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('execCommand() runs command locally and returns stdout/code', async () => {
    const agent = makeLocalAgent({ workFolder: tmpDir });
    const strategy = getStrategy(agent);

    const result = await strategy.execCommand('echo hello-fleet');
    expect(result.stdout.trim()).toBe('hello-fleet');
    expect(result.code).toBe(0);
  });

  it('execCommand() does not leak CLAUDECODE to child process', async () => {
    process.env.CLAUDECODE = 'test-leak-marker';
    try {
      const agent = makeLocalAgent({ workFolder: tmpDir });
      const strategy = getStrategy(agent);
      const echoCmd = process.platform === 'win32'
        ? 'if ($env:CLAUDECODE) { Write-Output $env:CLAUDECODE }'
        : 'printenv CLAUDECODE || true';
      const result = await strategy.execCommand(echoCmd);
      expect(result.stdout.trim()).toBe('');
    } finally {
      delete process.env.CLAUDECODE;
    }
  });

  it('execCommand() returns non-zero code for failed commands', async () => {
    const agent = makeLocalAgent({ workFolder: tmpDir });
    const strategy = getStrategy(agent);

    const result = await strategy.execCommand('exit 42');
    expect(result.code).not.toBe(0);
  });

  it('transferFiles() copies files to target folder', async () => {
    const agent = makeLocalAgent({ workFolder: tmpDir });
    const strategy = getStrategy(agent);

    const srcFile = path.join(os.tmpdir(), `fleet-src-${Date.now()}.txt`);
    fs.writeFileSync(srcFile, 'test content');

    try {
      const result = await strategy.transferFiles([srcFile]);
      expect(result.success).toContain(path.basename(srcFile));
      expect(result.failed).toHaveLength(0);

      const destFile = path.join(tmpDir, path.basename(srcFile));
      expect(fs.existsSync(destFile)).toBe(true);
      expect(fs.readFileSync(destFile, 'utf-8')).toBe('test content');
    } finally {
      fs.unlinkSync(srcFile);
    }
  });

  it('transferFiles() copies to subfolder', async () => {
    const agent = makeLocalAgent({ workFolder: tmpDir });
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
});
