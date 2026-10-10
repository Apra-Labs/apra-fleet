/**
 * `apra-fleet call` on a MEMBER install always knows which apra-fleet version
 * it belongs to, so its client auto-start can compare versions and start the
 * member's server instead of refusing with AUTOSTART_VERSION_UNKNOWN.
 *
 * Simulated member-install layout (install --member --workflows none, run as
 * the single-executable binary): the client module sits in
 * <home>/.apra-fleet/bin with NO version.json above it and NO
 * workflows/.installed.json -- clientServerVersion() alone finds nothing.
 *
 * Revert check (stated, and re-run by hand when this file changes): with
 * expectedVersion removed from memberCallConnectDeps() (src/cli/call.ts),
 * "a member-install layout resolves the expected version ..." fails with
 * AUTOSTART_VERSION_UNKNOWN.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memberCallConnectDeps } from '../src/cli/call.js';
import { clientExpectedVersion, serverVersion } from '../src/version.js';
import { resolveFleetServerConnection } from '../packages/apra-fleet-client/src/client/server-resolution.mjs';
import { clientServerVersion, resolveFleetStartCommand } from '../packages/apra-fleet-client/src/client/auto-start.mjs';

/** A member-install layout on disk: <home>/.apra-fleet/bin/apra-fleet and a
 *  client dir beside it, with no version.json and no workflows marker. */
function memberLayout(): { home: string; bin: string; clientDir: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'member-layout-'));
  const binDir = path.join(home, '.apra-fleet', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, process.platform === 'win32' ? 'apra-fleet.exe' : 'apra-fleet');
  fs.writeFileSync(bin, '');
  return { home, bin, clientDir: binDir, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

describe('apra-fleet call on a member install knows its own version', () => {
  it('the layout alone yields no version (the cause of AUTOSTART_VERSION_UNKNOWN)', () => {
    const l = memberLayout();
    try {
      expect(clientServerVersion({ clientDir: l.clientDir })).toBeNull();
    } finally { l.cleanup(); }
  });

  it('the CLI passes the running binary version to the client', () => {
    expect(clientExpectedVersion()).toBe(serverVersion);
    expect(memberCallConnectDeps({ kbMaintainer: false })).toMatchObject({ origin: 'engine', expectedVersion: serverVersion });
    expect(memberCallConnectDeps({ kbMaintainer: true })).toMatchObject({ kbMaintainer: true });
  });

  it('a member-install layout resolves the expected version and auto-starts the matching binary', async () => {
    const l = memberLayout();
    try {
      let up = false;
      const starts: Array<{ command: string; args: string[] }> = [];
      const r = await resolveFleetServerConnection({
        ...memberCallConnectDeps({ kbMaintainer: false }),
        env: { APRA_FLEET_DATA_DIR: path.join(l.home, '.apra-fleet', 'data'), APRA_TEST_SANDBOX_ROOT: l.home },
        clientDir: l.clientDir,
        execPath: l.bin,
        exists: (p: string) => p === l.bin,
        homedir: () => l.home,
        probeVersion: () => serverVersion,
        checkRunningInstance: async () => (up ? { running: true, state: 'running', url: 'http://127.0.0.1:7599/mcp', pid: 77 } : { running: false, state: 'gone' }),
        runStart: (command: string, args: string[]) => { starts.push({ command, args }); up = true; return { done: Promise.resolve({ code: 0, output: 'Server started' }) }; },
        healthVersion: async () => serverVersion,
        sleep: async () => {},
        timeoutMs: 5000,
      });
      expect(r).toMatchObject({ mode: 'http', url: 'http://127.0.0.1:7599/mcp', started: true });
      expect(starts).toEqual([{ command: l.bin, args: ['start'] }]);
    } finally { l.cleanup(); }
  });

  it('a version-skewed candidate is still refused (AUTOSTART_VERSION_SKEW)', () => {
    const l = memberLayout();
    try {
      expect(() => resolveFleetStartCommand({
        ...memberCallConnectDeps({ kbMaintainer: false }),
        clientDir: l.clientDir, execPath: l.bin, exists: (p: string) => p === l.bin, homedir: () => l.home,
        probeVersion: () => 'v0.0.1_deadbe',
      })).toThrow(expect.objectContaining({ code: 'AUTOSTART_VERSION_SKEW' }));
    } finally { l.cleanup(); }
  });

  it('a detached client with no version source still refuses, naming where it looked', () => {
    const l = memberLayout();
    try {
      let err: { code?: string; message?: string } | undefined;
      try {
        resolveFleetStartCommand({ clientDir: l.clientDir, execPath: l.bin, exists: (p: string) => p === l.bin, homedir: () => l.home, probeVersion: () => serverVersion });
      } catch (e) { err = e as { code?: string; message?: string }; }
      expect(err?.code).toBe('AUTOSTART_VERSION_UNKNOWN');
      expect(err?.message).toContain(path.join(fs.realpathSync(l.clientDir), 'version.json'));
      expect(err?.message).toContain(path.join(fs.realpathSync(l.clientDir), 'workflows', '.installed.json'));
    } finally { l.cleanup(); }
  });
});
