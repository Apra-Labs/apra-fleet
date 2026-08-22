/**
 * Regression coverage for apra-fleet-7dir.4: a local member whose registered
 * shell is Git-for-Windows bash (`shell: 'gitbash'`) must have both its
 * timeout/abort process-tree kill and its clean-env dispatch actually work
 * through LocalStrategy.execCommand -- not just produce a command string
 * that looks right.
 *
 * Both bugs shared one root cause: LocalStrategy.execCommand's killTree
 * (src/services/strategy.ts) and LinuxCommands.getCleanEnv (src/os/linux.ts,
 * inherited by WindowsGitBashCommands) called execSync with no `shell`
 * option, so on Windows execSync fell back to cmd.exe -- which cannot
 * parse either the gitbash-flavoured kill string (`taskkill //F //T //PID
 * <n> >/dev/null 2>&1; true`) or the `env -i ... bash -l -c 'env -0'` probe.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getStrategy } from '../src/services/strategy.js';
import { makeTestLocalAgent } from './test-helpers.js';

describe.skipIf(process.platform !== 'win32')('LocalStrategy + gitbash shell (apra-fleet-7dir.4)', () => {
  let tmpDir: string;
  let heartbeatPath: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `fleet-test-7dir4-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    heartbeatPath = path.join(tmpDir, 'heartbeat.txt');
  });

  afterEach(async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 10000);

  it('actually kills the bash.exe wrapper (via the gitbash killPid string) after an inactivity timeout', async () => {
    const member = makeTestLocalAgent({ workFolder: tmpDir, shell: 'gitbash' });
    const strategy = getStrategy(member);

    const hbPath = heartbeatPath.replace(/\\/g, '/');
    // The wrapper bash.exe process (matches child.pid) itself heartbeats
    // forever, so it is straightforward to tell "still alive" (file keeps
    // growing) from "killed" (file stops growing) without depending on how
    // MSYS forks background jobs into the Windows process tree -- that is a
    // separate concern from this bug, which is specifically that killTree's
    // execSync call used to run under cmd.exe (default, no `shell` option)
    // and could not parse the gitbash-flavoured kill string at all, so
    // taskkill never even ran.
    const cmd = `while true; do date +%s%N >> '${hbPath}'; sleep 0.1; done`;

    const start = Date.now();
    await expect(strategy.execCommand(cmd, 800)).rejects.toThrow(/timed out/);
    expect(Date.now() - start).toBeLessThan(5000);

    await new Promise(r => setTimeout(r, 1000));
    const sizeAfterKill = fs.existsSync(heartbeatPath) ? fs.statSync(heartbeatPath).size : 0;
    await new Promise(r => setTimeout(r, 800));
    const sizeLater = fs.existsSync(heartbeatPath) ? fs.statSync(heartbeatPath).size : 0;

    expect(sizeLater).toBe(sizeAfterKill);
  }, 15000);

  it('strips the fleet server env (e.g. CLAUDE_SOURCE_METADATA) from a gitbash local dispatch instead of inheriting it wholesale', async () => {
    process.env.CLAUDE_SOURCE_METADATA = 'test-leak-marker';
    try {
      const member = makeTestLocalAgent({ workFolder: tmpDir, shell: 'gitbash' });
      const strategy = getStrategy(member);
      const result = await strategy.execCommand('echo "[$CLAUDE_SOURCE_METADATA]"');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('[]');
      expect(result.stdout).not.toContain('test-leak-marker');
    } finally {
      delete process.env.CLAUDE_SOURCE_METADATA;
    }
  }, 15000);
});
