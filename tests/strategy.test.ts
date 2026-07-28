import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getStrategy } from '../src/services/strategy.js';
import { getOsCommands } from '../src/os/index.js';
import { ClaudeProvider } from '../src/providers/claude.js';
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
    const member = makeLocalAgent({ workFolder: tmpDir });
    const strategy = getStrategy(member);

    const result = await strategy.execCommand('echo hello-fleet');
    expect(result.stdout.trim()).toBe('hello-fleet');
    expect(result.code).toBe(0);
  });

  it('execCommand() does not leak CLAUDECODE to child process', async () => {
    process.env.CLAUDECODE = 'test-leak-marker';
    try {
      const member = makeLocalAgent({ workFolder: tmpDir });
      const strategy = getStrategy(member);
      const echoCmd = process.platform === 'win32'
        ? 'if ($env:CLAUDECODE) { Write-Output $env:CLAUDECODE }'
        : 'printenv CLAUDECODE || true';
      const result = await strategy.execCommand(echoCmd);
      expect(result.stdout.trim()).toBe('');
    } finally {
      delete process.env.CLAUDECODE;
    }
  });

  // apra-fleet-eft.65.3: pins apra-fleet-eft.65.1's fix -- a coding agent
  // dispatched via LocalStrategy's clean-env exec must receive a
  // tool-permission configuration that grants Edit/Write for a brand-new
  // file in its own work folder (no hard-block), via the surgical
  // `--permission-mode acceptEdits` flag rather than the broad
  // `--dangerously-skip-permissions` bypass. Per eft.65.3's acceptance
  // criteria, this asserts the deterministic, testable surface -- the
  // composed permission config actually reaching the spawned process through
  // LocalStrategy's real clean-env exec pipeline -- not live agent
  // free-behavior (no real `claude` binary is required: the actual CLI name
  // is substituted with `echo` so the test can inspect exactly what argv
  // LocalStrategy hands to the child process).
  it('LocalStrategy clean-env exec preserves the provider-composed Edit/Write permission-parity flag for a headless coding-agent dispatch', async () => {
    const provider = new ClaudeProvider();
    const cmds = getOsCommands(os.platform() === 'win32' ? 'windows' : 'linux');
    const built = cmds.buildAgentPromptCommand(provider, { folder: tmpDir, promptFile: '.fleet-task.md' });
    // Same command LocalStrategy would actually spawn for a real coding-agent
    // dispatch, except the `claude` binary is swapped for `echo` so this test
    // doesn't depend on a real CLI being installed -- we only need to prove
    // the permission flag survives LocalStrategy's clean-env wrapping intact.
    const echoCmd = built.replace(/claude(\.cmd)?\s+-p/, 'echo -p');

    const member = makeLocalAgent({ workFolder: tmpDir });
    const strategy = getStrategy(member);
    const result = await strategy.execCommand(echoCmd);
    console.log('strategy.test.ts result:', result);
    expect(result.code).toBe(0);
    // The tool-permission configuration handed to the dispatched agent
    // grants Edit/Write parity for the work folder (no hard-block)...
    const stdoutNormalized = result.stdout.replace(/\s+/g, ' ');
    expect(stdoutNormalized).toContain('--permission-mode acceptEdits');
    // ...via the surgical flag, never the broad permission-bypass escape hatch.
    expect(stdoutNormalized).not.toContain('--dangerously-skip-permissions');
  });

  it('execCommand() returns non-zero code for failed commands', async () => {
    const member = makeLocalAgent({ workFolder: tmpDir });
    const strategy = getStrategy(member);

    const result = await strategy.execCommand('exit 42');
    expect(result.code).not.toBe(0);
  });

  it('transferFiles() copies files to target folder', async () => {
    const member = makeLocalAgent({ workFolder: tmpDir });
    const strategy = getStrategy(member);

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
    const member = makeLocalAgent({ workFolder: tmpDir });
    const strategy = getStrategy(member);

    const filePath = path.join(tmpDir, 'to-delete.txt');
    fs.writeFileSync(filePath, 'bye');

    await strategy.deleteFiles(['to-delete.txt']);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('deleteFiles() handles folder paths with spaces', async () => {
    const spacedDir = path.join(os.tmpdir(), `fleet test dir ${Date.now()}`);
    fs.mkdirSync(spacedDir, { recursive: true });
    try {
      const member = makeLocalAgent({ workFolder: spacedDir });
      const strategy = getStrategy(member);

      fs.writeFileSync(path.join(spacedDir, 'spaced.txt'), 'content');
      await strategy.deleteFiles(['spaced.txt']);
      expect(fs.existsSync(path.join(spacedDir, 'spaced.txt'))).toBe(false);
    } finally {
      fs.rmSync(spacedDir, { recursive: true, force: true });
    }
  });

  it('deleteFiles() handles file names with spaces', async () => {
    const member = makeLocalAgent({ workFolder: tmpDir });
    const strategy = getStrategy(member);

    const filePath = path.join(tmpDir, 'my file.txt');
    fs.writeFileSync(filePath, 'content');

    await strategy.deleteFiles(['my file.txt']);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('deleteFiles() handles both folder and file names with spaces', async () => {
    const spacedDir = path.join(os.tmpdir(), `fleet test ${Date.now()}`);
    fs.mkdirSync(spacedDir, { recursive: true });
    try {
      const member = makeLocalAgent({ workFolder: spacedDir });
      const strategy = getStrategy(member);

      fs.writeFileSync(path.join(spacedDir, 'my file.txt'), 'content');
      await strategy.deleteFiles(['my file.txt']);
      expect(fs.existsSync(path.join(spacedDir, 'my file.txt'))).toBe(false);
    } finally {
      fs.rmSync(spacedDir, { recursive: true, force: true });
    }
  });

  it('deleteFiles() is a no-op for empty list', async () => {
    const member = makeLocalAgent({ workFolder: tmpDir });
    const strategy = getStrategy(member);
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
    const member = makeLocalAgent({ workFolder: tmpDir });
    const strategy = getStrategy(member);

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
