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

  it('deleteFiles() removes a file from the work folder', async () => {
    const agent = makeLocalAgent({ workFolder: tmpDir });
    const strategy = getStrategy(agent);

    const filePath = path.join(tmpDir, 'to-delete.txt');
    fs.writeFileSync(filePath, 'bye');

    await strategy.deleteFiles(['to-delete.txt']);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('deleteFiles() handles folder paths with spaces', async () => {
    const spacedDir = path.join(os.tmpdir(), `fleet test dir ${Date.now()}`);
    fs.mkdirSync(spacedDir, { recursive: true });
    try {
      const agent = makeLocalAgent({ workFolder: spacedDir });
      const strategy = getStrategy(agent);

      fs.writeFileSync(path.join(spacedDir, 'spaced.txt'), 'content');
      await strategy.deleteFiles(['spaced.txt']);
      expect(fs.existsSync(path.join(spacedDir, 'spaced.txt'))).toBe(false);
    } finally {
      fs.rmSync(spacedDir, { recursive: true, force: true });
    }
  });

  it('deleteFiles() handles file names with spaces', async () => {
    const agent = makeLocalAgent({ workFolder: tmpDir });
    const strategy = getStrategy(agent);

    const filePath = path.join(tmpDir, 'my file.txt');
    fs.writeFileSync(filePath, 'content');

    await strategy.deleteFiles(['my file.txt']);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('deleteFiles() handles both folder and file names with spaces', async () => {
    const spacedDir = path.join(os.tmpdir(), `fleet test ${Date.now()}`);
    fs.mkdirSync(spacedDir, { recursive: true });
    try {
      const agent = makeLocalAgent({ workFolder: spacedDir });
      const strategy = getStrategy(agent);

      fs.writeFileSync(path.join(spacedDir, 'my file.txt'), 'content');
      await strategy.deleteFiles(['my file.txt']);
      expect(fs.existsSync(path.join(spacedDir, 'my file.txt'))).toBe(false);
    } finally {
      fs.rmSync(spacedDir, { recursive: true, force: true });
    }
  });

  it('deleteFiles() is a no-op for empty list', async () => {
    const agent = makeLocalAgent({ workFolder: tmpDir });
    const strategy = getStrategy(agent);
    await expect(strategy.deleteFiles([])).resolves.toBeUndefined();
  });

  it('execCommand() passes windowsHide:true to spawn to suppress cmd.exe flashes on Windows', async () => {
    // ESM namespace is not configurable, so we verify the option via source inspection.
    // This directly asserts the fix is present in LocalStrategy.execCommand.
    const src = await fs.promises.readFile(
      new URL('../src/services/strategy.ts', import.meta.url),
      'utf-8'
    );
    expect(src).toMatch(/windowsHide:\s*true/);
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
