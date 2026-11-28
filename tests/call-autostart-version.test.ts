// `apra-fleet call` from a SEA member install (--workflows none) must be able
// to auto-start its own server: the client finds no version.json or
// workflows/.installed.json near the binary there, so the verb has to pass its
// own version (memberConnectOptions) or the client refuses with
// AUTOSTART_VERSION_UNKNOWN.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memberConnectOptions } from '../src/cli/call.js';
import { serverVersion } from '../src/version.js';
import { resolveFleetStartCommand } from '../packages/apra-fleet-client/src/client/auto-start.mjs';

let tmp: string | undefined;
afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = undefined; });

/** A member install layout: <home>/.apra-fleet/bin/apra-fleet, and no version file anywhere. */
function memberInstallDeps() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'call-autostart-'));
  const home = path.join(tmp, 'home');
  const binDir = path.join(home, '.apra-fleet', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const installed = path.join(binDir, 'apra-fleet');
  return {
    installed,
    deps: {
      clientDir: binDir, // a SEA's bundled client sits next to the executable
      exists: (p: string) => p === installed,
      homedir: () => home,
      execPath: path.join(tmp, 'node'),
      platform: 'linux',
      env: {},
      probeVersion: () => 'v9.8.7_abc123',
    },
  };
}

describe('apra-fleet call: client auto-start version', () => {
  it('passes this binary\'s own version to the client', () => {
    expect(memberConnectOptions(false)).toEqual({ origin: 'engine', expectedVersion: serverVersion });
    expect(memberConnectOptions(true)).toEqual({ origin: 'engine', kbMaintainer: true, expectedVersion: serverVersion });
  });

  it('a member install without a version file can resolve the server to start', () => {
    const { installed, deps } = memberInstallDeps();
    // Without the verb's version the client cannot tell which server to start.
    expect(() => resolveFleetStartCommand(deps)).toThrow(expect.objectContaining({ code: 'AUTOSTART_VERSION_UNKNOWN' }));
    const r = resolveFleetStartCommand({ ...deps, ...memberConnectOptions(false, 'v9.8.7_abc123') });
    expect(r.command).toBe(installed);
    expect(r.args).toEqual(['start']);
  });
});
