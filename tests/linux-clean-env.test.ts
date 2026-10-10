/**
 * The linux/macOS clean member env is rebuilt from login profiles only, so a
 * host whose node is on PATH only via ~/.bashrc gave every LocalStrategy child
 * "node: command not found". The env must keep the running node's dir on PATH.
 * No mocks: real login shell, real scratch HOME, real spawned child.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LinuxCommands } from '../src/os/linux.js';
import { ensureNodeDirOnPath } from '../src/os/node-path.js';
import { makeTestLocalAgent } from './test-helpers.js';

const nodeDir = path.dirname(process.execPath);

describe.skipIf(process.platform === 'win32')('linux clean env keeps running node on PATH (LinuxCommands is POSIX-only)', () => {
  let scratchHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-linux-clean-env-'));
    fs.writeFileSync(path.join(scratchHome, '.profile'), '# no node here\n');
    fs.writeFileSync(path.join(scratchHome, '.bash_profile'), '# no node here\n');
    process.env.HOME = scratchHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(scratchHome, { recursive: true, force: true });
  });

  describe('ensureNodeDirOnPath', () => {
    it('appends the dir as the last entry when absent', () => {
      expect(ensureNodeDirOnPath('/usr/bin:/bin', '/opt/node/bin')).toBe('/usr/bin:/bin:/opt/node/bin');
    });

    it('leaves PATH byte-identical when the dir is already an exact entry', () => {
      const p = '/usr/bin:/opt/node/bin:/bin';
      expect(ensureNodeDirOnPath(p, '/opt/node/bin')).toBe(p);
    });

    it('still appends when the dir is only a substring of another entry', () => {
      expect(ensureNodeDirOnPath('/opt/node22/bin:/bin', '/opt/node')).toBe('/opt/node22/bin:/bin:/opt/node');
    });

    it('returns just the dir for an empty PATH', () => {
      expect(ensureNodeDirOnPath(undefined, '/opt/node/bin')).toBe('/opt/node/bin');
    });
  });

  it('LinuxCommands.cleanExec PATH contains the running node dir as an exact entry', () => {
    const { env } = new LinuxCommands().cleanExec('true');
    expect(env!.PATH.split(':')).toContain(nodeDir);
  });

  // Host-independent: a login PATH may already hold a different node (the
  // running node dir is appended, never prepended), so the child's execPath is
  // not asserted. The child must run node (exit 0) and see the running node's
  // dir as an exact entry of its own PATH.
  it('a LocalStrategy child can run node and has the running node dir on its PATH', async () => {
    vi.resetModules(); // rebuild the cached singleton env under the scratch HOME
    const { getStrategy } = await import('../src/services/strategy.js');
    const agent = makeTestLocalAgent({ workFolder: scratchHome, os: 'linux' });
    const result = await getStrategy(agent).execCommand('node -e "console.log(process.env.PATH)"');
    expect(result.code).toBe(0);
    expect(result.stdout.trim().split(':')).toContain(nodeDir);
  });
});
