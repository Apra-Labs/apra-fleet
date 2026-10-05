/**
 * KB #605 (bd user-prefix install) x v0.5 #561 (recorded bdPath), as resolved
 * by the feat/kb-redesign -> v0.5_dashboard merge ruling:
 *
 *   npm -g not writable -> the Beads step installs bd's NATIVE binary into
 *   BIN_DIR -> the install records bdPath = <BIN_DIR>/bd[.exe] (not the PATH
 *   lookup, which finds nothing) -> the supervisor reads that bdPath back and
 *   runs THAT binary directly (never via the recorded node; bd.exe on
 *   Windows, never a bd.cmd shim).
 *
 * Unit-level: fake install transports, an in-memory supervisor.config.json,
 * an injected execFileSync. No npm, no bd, no real install.
 */
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { installBeads, type BeadsInstallDeps } from '../src/cli/beads-install.js';
import { recordedBdFromBeadsStep } from '../src/cli/install.js';
import { seedSupervisorToolchain, supervisorConfigPath } from '../src/cli/supervisor.js';
import type { FleetSeToolchainPaths } from '../src/cli/fleet-se-prereqs.js';
import { readSupervisorConfig } from '../packages/apra-fleet-se/src/supervisor/project-config.mjs';
import {
  configureBdInvocation,
  execBdSync,
  resolveConfiguredWindowsBdScript,
} from '../packages/apra-fleet-se/src/supervisor/lib/exec-bd.mjs';

const NODE_PATH = '/opt/node/bin/node';

/** npm -g fails with EACCES; the user-level --prefix install yields the native binary. */
function npmGlobalNotWritable(platform: NodeJS.Platform, binDir: string): BeadsInstallDeps {
  const bin = platform === 'win32' ? 'bd.exe' : 'bd';
  const files = new Set<string>();
  const native = path.join(path.dirname(binDir), 'staging', 'beads', 'node_modules', '@beads', 'bd', 'bin', bin);
  const binPath = path.join(binDir, bin);
  return {
    platform,
    exec: (cmd, args) => {
      if (cmd === 'bd') throw new Error('bd: command not found');
      if (cmd === binPath) {
        if (files.has(binPath)) return 'bd version 1.3.0 (fleet)\n';
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      }
      if (cmd === 'npm' && args.includes('-g')) {
        throw Object.assign(new Error('Command failed: npm install -g'), {
          stderr: "npm error code EACCES\nnpm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@beads'\n",
        });
      }
      if (cmd === 'npm' && args.includes('--prefix')) { files.add(native); return ''; }
      throw new Error(`unexpected exec ${cmd}`);
    },
    existsSync: p => files.has(p),
    mkdirSync: () => {},
    rmSync: () => {},
    copyFileSync: (_src, dest) => { files.add(dest); },
    chmodSync: () => {},
  };
}

/** What the PATH lookup (resolveFleetSeToolchainPaths) sees: node, but no bd on PATH. */
const PATH_LOOKUP: FleetSeToolchainPaths = {
  node: { path: NODE_PATH, version: '22.16.0', ok: true, reason: null },
  bd: { path: null, version: null, ok: false, reason: 'bd not found on PATH (which bd failed)' },
};

function memFs() {
  const files = new Map<string, string>();
  return {
    files,
    impl: {
      existsSync: (p: unknown) => files.has(String(p)),
      mkdirSync: () => undefined,
      readFileSync: (p: unknown) => {
        const v = files.get(String(p));
        if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return v;
      },
      writeFileSync: (p: unknown, c: unknown) => { files.set(String(p), String(c)); },
      renameSync: (a: unknown, b: unknown) => { files.set(String(b), files.get(String(a))!); files.delete(String(a)); },
    },
  };
}

afterEach(() => {
  configureBdInvocation({});
});

describe('npm -g not writable -> recorded bdPath = BIN_DIR/bd and the supervisor runs it', () => {
  for (const platform of ['linux', 'win32'] as const) {
    it(`${platform}: records <BIN_DIR>/${platform === 'win32' ? 'bd.exe' : 'bd'} and execs it directly`, async () => {
      const binDir = platform === 'win32'
        ? path.join('C:', 'Users', 'member', '.apra-fleet', 'bin')
        : path.join('/home/member', '.apra-fleet', 'bin');
      const expected = path.join(binDir, platform === 'win32' ? 'bd.exe' : 'bd');

      // 1. The Beads step falls back to the user-level install into BIN_DIR.
      const beads = installBeads(binDir, npmGlobalNotWritable(platform, binDir));
      expect(beads).toMatchObject({ state: 'installed', location: 'bin-dir', binPath: expected });

      // 2. The recorded bd is the BIN_DIR binary, not the (empty) PATH lookup.
      const toolchain = recordedBdFromBeadsStep(PATH_LOOKUP, beads);
      expect(toolchain.bd).toEqual({ path: expected, version: '1.3.0', ok: true, reason: null });
      expect(toolchain.node).toEqual(PATH_LOOKUP.node);

      // 3. Written to supervisor.config.json and read back by the REAL supervisor reader.
      const dataDir = '/mock/supervisor-data';
      const mem = memFs();
      expect(seedSupervisorToolchain(toolchain, dataDir, mem.impl as any).ok).toBe(true);
      const parsed = await readSupervisorConfig({
        dataDir,
        fs: { readFile: async () => mem.files.get(supervisorConfigPath(dataDir))! },
      });
      expect(parsed.toolchain?.bdPath).toBe(expected);

      // 4. The supervisor configures bd from the recording and runs THAT file
      //    directly -- never `node <script>` (only an npm .cmd shim goes via node).
      configureBdInvocation({ bdPath: parsed.toolchain!.bdPath, nodePath: NODE_PATH });
      const calls: Array<{ file: string; args: string[] }> = [];
      const fakeExec = ((file: string, args: string[]) => {
        calls.push({ file, args });
        return '[]';
      }) as any;
      execBdSync(['list', '--json'], {}, fakeExec, () => null, resolveConfiguredWindowsBdScript, platform);
      expect(calls).toHaveLength(1);
      expect(calls[0].file).toBe(expected);
      expect(calls[0].file).not.toBe(NODE_PATH);
      expect(calls[0].args).toEqual(['list', '--json']);
      if (platform === 'win32') expect(calls[0].file.endsWith('bd.exe')).toBe(true);
    });
  }

  it('a bd that resolves on PATH keeps the PATH lookup (the Beads step left it untouched)', () => {
    const onPath: FleetSeToolchainPaths = {
      ...PATH_LOOKUP,
      bd: { path: '/usr/local/bin/bd', version: '1.3.0', ok: true, reason: null },
    };
    expect(recordedBdFromBeadsStep(onPath, { state: 'present', version: 'bd version 1.3.0', location: 'path' })).toEqual(onPath);
    expect(recordedBdFromBeadsStep(onPath, { state: 'installed', version: 'bd version 1.3.0', location: 'npm-global' })).toEqual(onPath);
    expect(recordedBdFromBeadsStep(PATH_LOOKUP, { state: 'missing', reason: 'x', fix: 'y' })).toEqual(PATH_LOOKUP);
    expect(recordedBdFromBeadsStep(PATH_LOOKUP, null)).toEqual(PATH_LOOKUP);
  });
});
