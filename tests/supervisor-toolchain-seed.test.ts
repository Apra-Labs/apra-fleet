/**
 * seedSupervisorToolchain() (apra-fleet-i9ag.19.2) -- the writer half of
 * "record the resolved node/bd paths at install time so the supervisor can
 * read them back after a reboot, when its service manager does not inherit
 * the login shell's PATH."
 *
 * Exercised directly against the function (no runInstall() harness needed):
 * it takes an already-resolved FleetSeToolchainPaths and an injectable fs, so
 * every case here is a pure unit test with no real disk I/O.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  seedSupervisorToolchain,
  supervisorConfigPath,
  SUPERVISOR_DATA_DIR,
} from '../src/cli/supervisor.js';
import type { FleetSeToolchainPaths } from '../src/cli/fleet-se-prereqs.js';

const DATA_DIR = '/mock/data-dir';
const CONFIG_PATH = supervisorConfigPath(DATA_DIR);
const CONFIG_TMP_PATH = `${CONFIG_PATH}.tmp`;

const RESOLVED: FleetSeToolchainPaths = {
  node: { path: '/opt/nvm/versions/node/v22.16.0/bin/node', version: '22.16.0', ok: true, reason: null },
  bd: { path: '/usr/local/bin/bd', version: '1.3.0', ok: true, reason: null },
};

const NODE_UNRESOLVED: FleetSeToolchainPaths = {
  node: { path: null, version: null, ok: false, reason: 'node -p process.execPath failed: spawn node ENOENT' },
  bd: { path: '/usr/local/bin/bd', version: '1.3.0', ok: true, reason: null },
};

const BD_UNRESOLVED: FleetSeToolchainPaths = {
  node: { path: '/usr/bin/node', version: '22.16.0', ok: true, reason: null },
  bd: { path: null, version: null, ok: false, reason: 'bd not found on PATH (which bd failed: ...)' },
};

/** Injectable fs double -- an in-memory map keyed by exact path. */
function makeFsDouble(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const writeCalls: Array<[string, string]> = [];
  const renameCalls: Array<[string, string]> = [];
  const mkdirCalls: string[] = [];
  const fsImpl = {
    existsSync: vi.fn((p: unknown) => files.has(String(p))),
    mkdirSync: vi.fn((p: unknown) => {
      mkdirCalls.push(String(p));
      return undefined as any;
    }),
    readFileSync: vi.fn((p: unknown) => {
      const key = String(p);
      if (!files.has(key)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(key)!;
    }),
    writeFileSync: vi.fn((p: unknown, content: unknown) => {
      const key = String(p);
      writeCalls.push([key, String(content)]);
      files.set(key, String(content));
    }),
    renameSync: vi.fn((from: unknown, to: unknown) => {
      const fromKey = String(from);
      const toKey = String(to);
      renameCalls.push([fromKey, toKey]);
      const content = files.get(fromKey);
      files.delete(fromKey);
      if (content !== undefined) files.set(toKey, content);
    }),
  };
  return { fsImpl, files, writeCalls, renameCalls, mkdirCalls };
}

describe('seedSupervisorToolchain()', () => {
  it('writes an absolute nodePath and bdPath under a top-level "toolchain" key', () => {
    const { fsImpl, files } = makeFsDouble();
    const result = seedSupervisorToolchain(RESOLVED, DATA_DIR, fsImpl as any);
    expect(result.ok).toBe(true);

    const written = JSON.parse(files.get(CONFIG_PATH)!);
    expect(written.toolchain.nodePath).toBe(RESOLVED.node.path);
    expect(written.toolchain.nodeVersion).toBe('22.16.0');
    expect(written.toolchain.bdPath).toBe(RESOLVED.bd.path);
    expect(written.toolchain.bdVersion).toBe('1.3.0');
    expect(typeof written.toolchain.recordedAt).toBe('string');
    expect(Number.isNaN(Date.parse(written.toolchain.recordedAt))).toBe(false);
  });

  it('node unresolved: fails (ok:false) with the reason, and writes nothing at all', () => {
    const { fsImpl, writeCalls, mkdirCalls } = makeFsDouble();
    const result = seedSupervisorToolchain(NODE_UNRESOLVED, DATA_DIR, fsImpl as any);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ENOENT');
    expect(writeCalls).toHaveLength(0);
    expect(mkdirCalls).toHaveLength(0);
  });

  it('bd unresolved: does NOT fail -- records a null bdPath/bdVersion and still writes', () => {
    const { fsImpl, files } = makeFsDouble();
    const result = seedSupervisorToolchain(BD_UNRESOLVED, DATA_DIR, fsImpl as any);
    expect(result.ok).toBe(true);

    const written = JSON.parse(files.get(CONFIG_PATH)!);
    expect(written.toolchain.nodePath).toBe(BD_UNRESOLVED.node.path);
    expect(written.toolchain.bdPath).toBeNull();
    expect(written.toolchain.bdVersion).toBeNull();
  });

  it('idempotent: writing the same toolchain twice leaves no duplicated or lost keys', () => {
    const { fsImpl, files } = makeFsDouble();
    seedSupervisorToolchain(RESOLVED, DATA_DIR, fsImpl as any);
    const firstWrite = JSON.parse(files.get(CONFIG_PATH)!);
    seedSupervisorToolchain(RESOLVED, DATA_DIR, fsImpl as any);
    const secondWrite = JSON.parse(files.get(CONFIG_PATH)!);

    expect(Object.keys(secondWrite).sort()).toEqual(Object.keys(firstWrite).sort());
    expect(Object.keys(secondWrite.toolchain).sort()).toEqual(['bdPath', 'bdVersion', 'nodePath', 'nodeVersion', 'recordedAt']);
    expect(secondWrite.toolchain.nodePath).toBe(RESOLVED.node.path);
    expect(secondWrite.toolchain.bdPath).toBe(RESOLVED.bd.path);
  });

  it('unknown top-level keys (e.g. a projectDir set from the console) are preserved across a toolchain write', () => {
    const { fsImpl, files } = makeFsDouble({
      [CONFIG_PATH]: JSON.stringify({ projectDir: '/mock/project-a', futureSetting: { nested: [1, 2] } }),
    });
    const result = seedSupervisorToolchain(RESOLVED, DATA_DIR, fsImpl as any);
    expect(result.ok).toBe(true);

    const written = JSON.parse(files.get(CONFIG_PATH)!);
    expect(written.projectDir).toBe('/mock/project-a');
    expect(written.futureSetting).toEqual({ nested: [1, 2] });
    expect(written.toolchain.nodePath).toBe(RESOLVED.node.path);
  });

  it('a later projectDir-shaped write on top preserves the toolchain key (the two writers must never clobber each other)', () => {
    const { fsImpl, files } = makeFsDouble();
    seedSupervisorToolchain(RESOLVED, DATA_DIR, fsImpl as any);

    // Simulate seedSupervisorProjectDir()'s own merge-and-write, reusing the
    // same "read existing, spread under the new key, write" shape it uses.
    const existing = JSON.parse(files.get(CONFIG_PATH)!);
    const merged = { ...existing, projectDir: '/mock/project-a' };
    files.set(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`);

    const finalWritten = JSON.parse(files.get(CONFIG_PATH)!);
    expect(finalWritten.projectDir).toBe('/mock/project-a');
    expect(finalWritten.toolchain.nodePath).toBe(RESOLVED.node.path);
  });

  it('a malformed existing config is replaced by a good one rather than blocking the write', () => {
    const { fsImpl, files } = makeFsDouble({ [CONFIG_PATH]: '{ this is not json' });
    const result = seedSupervisorToolchain(RESOLVED, DATA_DIR, fsImpl as any);
    expect(result.ok).toBe(true);

    const written = JSON.parse(files.get(CONFIG_PATH)!);
    expect(written.toolchain.nodePath).toBe(RESOLVED.node.path);
    expect(Object.keys(written)).toEqual(['toolchain']);
  });

  it('the write is atomic: a temp file in the config directory, then a rename onto the real path', () => {
    const { fsImpl, writeCalls, renameCalls } = makeFsDouble();
    seedSupervisorToolchain(RESOLVED, DATA_DIR, fsImpl as any);

    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0][0]).toBe(CONFIG_TMP_PATH);
    expect(renameCalls).toEqual([[CONFIG_TMP_PATH, CONFIG_PATH]]);
  });

  it('defaults to SUPERVISOR_DATA_DIR when no dataDir is given', () => {
    const { fsImpl, files } = makeFsDouble();
    seedSupervisorToolchain(RESOLVED, undefined, fsImpl as any);
    expect(files.has(supervisorConfigPath(SUPERVISOR_DATA_DIR))).toBe(true);
  });
});
