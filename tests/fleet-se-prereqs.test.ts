import { describe, it, expect, vi } from 'vitest';
import {
  detectFleetSePrereqs,
  resolveFleetSeToolchainPaths,
  MIN_NODE_VERSION,
  PREREQ_PROBE_TIMEOUT_MS,
  type FleetSePrereqExec,
} from '../src/cli/fleet-se-prereqs.js';

// apra-fleet-i9ag.12.8: detectFleetSePrereqs() itself had ZERO direct test
// coverage -- tests/install-fleet-se-prereqs.test.ts replaces it entirely
// with a fake, so a regression in the detection logic (in particular the
// version-compare and the win32 npm.cmd/shell branch, which no POSIX CI host
// can ever exercise) would ship undetected. These tests drive
// detectFleetSePrereqs({ exec, platform }) directly, with no mocking of
// node:child_process or node:os -- `exec` and `platform` are the module's own
// injection seam.

/**
 * Builds a fake FleetSePrereqExec keyed by the spawned `file` argument (e.g.
 * 'node', 'npm', 'npm.cmd'). A file with no entry in `responses` throws
 * ENOENT, mirroring a real failed spawn for a command that does not exist on
 * PATH -- never a falsy/empty success value (see the module's own doc
 * comment on FleetSePrereqExec).
 */
function makeExec(responses: Record<string, string | Error>): FleetSePrereqExec {
  return vi.fn((file: string) => {
    const resp = responses[file];
    if (resp === undefined) {
      throw Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
    }
    if (resp instanceof Error) throw resp;
    return resp;
  });
}

describe('detectFleetSePrereqs (apra-fleet-i9ag.12.8)', () => {
  it('exec throws ENOENT for node -> node.present false, ok false, missing includes "node"', () => {
    const exec = makeExec({ npm: '10.5.0\n' });

    const result = detectFleetSePrereqs({ exec, platform: 'linux' });

    expect(result.node).toEqual({ present: false, version: null, satisfiesMin: false });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('node');
    // npm resolved fine -- isolates this case to the node branch only.
    expect(result.missing).not.toContain('npm');
  });

  it('node v22.9.0 -> satisfiesMin false, ok false (numeric-vs-string compare regression guard)', () => {
    // A naive STRING compare of '22.9.0' vs MIN_NODE_VERSION ('22.16.0')
    // would wrongly conclude '22.9.0' > '22.16.0' (character '9' > '1'),
    // reporting satisfiesMin true for a version that is actually too old.
    // This pins the numeric compareVersions() implementation instead.
    const exec = makeExec({ node: 'v22.9.0\n', npm: '10.5.0\n' });

    const result = detectFleetSePrereqs({ exec, platform: 'linux' });

    expect(result.node.present).toBe(true);
    expect(result.node.version).toBe('22.9.0');
    expect(result.node.satisfiesMin).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('node');
  });

  it('node v22.16.0 plus working npm -> ok true, missing []', () => {
    const exec = makeExec({ node: 'v22.16.0\n', npm: '10.5.0\n' });

    const result = detectFleetSePrereqs({ exec, platform: 'linux' });

    expect(result.node).toEqual({ present: true, version: '22.16.0', satisfiesMin: true });
    expect(result.npm).toEqual({ present: true, version: '10.5.0' });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('platform win32 resolves npm via "npm.cmd"; the SAME exec under platform linux cannot satisfy it (non-vacuous, POSIX branch cannot pass)', () => {
    // This exec answers ONLY 'npm.cmd', never bare 'npm' -- so the assertion
    // below is only satisfiable if detectFleetSePrereqs actually spawned the
    // win32-specific file name, not a POSIX-compatible fallback.
    const exec = makeExec({ 'npm.cmd': '10.5.0\n' });

    const win32Result = detectFleetSePrereqs({ exec, platform: 'win32' });
    expect(win32Result.npm).toEqual({ present: true, version: '10.5.0' });
    // The win32 shim quirk this module exists to handle: the `.cmd` file name.
    // (The `shell: true` that makes a `.cmd` spawnable is now platform-
    // independent -- see the probe-options test below.)
    expect(exec).toHaveBeenCalledWith('npm.cmd', ['--version'], {
      shell: true,
      timeout: PREREQ_PROBE_TIMEOUT_MS,
    });

    vi.mocked(exec).mockClear();

    // Same exec, POSIX platform: probeNpm() must ask for bare 'npm', which
    // this fake does not know how to answer -> npm.present false. This is
    // what makes the win32 assertion above non-vacuous: the POSIX branch
    // genuinely cannot satisfy the same fake.
    const linuxResult = detectFleetSePrereqs({ exec, platform: 'linux' });
    expect(linuxResult.npm).toEqual({ present: false, version: null });
    expect(exec).toHaveBeenCalledWith('npm', ['--version'], {
      shell: true,
      timeout: PREREQ_PROBE_TIMEOUT_MS,
    });
  });

  // apra-fleet-i9ag.12.15: both probes must spawn through a shell (node itself
  // is a `.cmd` shim under nvm-windows, so a shell-less probe reports a
  // perfectly good toolchain as NOT INSTALLED) and both must carry a wall-clock
  // timeout, so a wedged interpreter can never hang `apra-fleet install`.
  it('BOTH probes spawn with shell:true and a 15s timeout, on every platform', () => {
    expect(PREREQ_PROBE_TIMEOUT_MS).toBe(15_000);
    const expected = { shell: true, timeout: PREREQ_PROBE_TIMEOUT_MS };

    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const npmFile = platform === 'win32' ? 'npm.cmd' : 'npm';
      const exec = makeExec({ node: 'v22.16.0\n', [npmFile]: '10.5.0\n' });

      const result = detectFleetSePrereqs({ exec, platform });

      expect(result.ok).toBe(true);
      expect(exec).toHaveBeenCalledWith('node', ['--version'], expected);
      expect(exec).toHaveBeenCalledWith(npmFile, ['--version'], expected);
    }
  });

  it('a probe that exceeds the timeout (execFileSync throws ETIMEDOUT) is reported NOT INSTALLED, never rethrown', () => {
    // execFileSync signals a timeout kill by throwing -- detectFleetSePrereqs
    // must absorb that into a plain "not present" verdict so the installer
    // prints the fix line and exits 1 rather than crashing with a stack trace.
    const timedOut = Object.assign(new Error('spawnSync node ETIMEDOUT'), {
      code: 'ETIMEDOUT',
      signal: 'SIGTERM',
    });
    const exec = makeExec({ node: timedOut, npm: '10.5.0\n' });

    const result = detectFleetSePrereqs({ exec, platform: 'linux' });

    expect(result.node).toEqual({ present: false, version: null, satisfiesMin: false });
    expect(result.npm).toEqual({ present: true, version: '10.5.0' });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['node']);
  });

  it('boundary: node v21.99.99 (major below MIN_NODE_VERSION) -> satisfiesMin false', () => {
    const exec = makeExec({ node: 'v21.99.99\n', npm: '10.5.0\n' });

    const result = detectFleetSePrereqs({ exec, platform: 'linux' });

    expect(result.node.version).toBe('21.99.99');
    expect(result.node.satisfiesMin).toBe(false);
    expect(result.ok).toBe(false);
  });

  it('boundary: node v22.16.1 (patch above MIN_NODE_VERSION, same major.minor) -> satisfiesMin true', () => {
    expect(MIN_NODE_VERSION).toBe('22.16.0');
    const exec = makeExec({ node: 'v22.16.1\n', npm: '10.5.0\n' });

    const result = detectFleetSePrereqs({ exec, platform: 'linux' });

    expect(result.node.version).toBe('22.16.1');
    expect(result.node.satisfiesMin).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('boundary: node v23.0.0 (major above MIN_NODE_VERSION) -> satisfiesMin true', () => {
    const exec = makeExec({ node: 'v23.0.0\n', npm: '10.5.0\n' });

    const result = detectFleetSePrereqs({ exec, platform: 'linux' });

    expect(result.node.version).toBe('23.0.0');
    expect(result.node.satisfiesMin).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('npm output with no version-like substring -> npm.present false, version null, ok false, missing includes "npm"', () => {
    const exec = makeExec({ node: 'v22.16.0\n', npm: 'command not found\n' });

    const result = detectFleetSePrereqs({ exec, platform: 'linux' });

    expect(result.npm).toEqual({ present: false, version: null });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('npm');
    // node resolved fine -- isolates this case to the npm branch only.
    expect(result.missing).not.toContain('node');
  });
});

// apra-fleet-i9ag.19.1: resolveFleetSeToolchainPaths() resolves the ABSOLUTE
// path of the node and bd the installer itself successfully probed, so a
// later step can record that path for a service manager (macOS launchd, a
// Windows scheduled task) that does not inherit the login shell's PATH.
// Unlike makeExec() above (keyed only by `file`), these fakes need to
// distinguish node's two different probes (`-p process.execPath` vs
// `--version`) by their full argv, so they key on `${file} ${args.join(' ')}`.

/**
 * Builds a fake FleetSePrereqExec keyed by `${file} ${args.join(' ')}`. A
 * key with no entry in `responses` throws ENOENT, mirroring a real failed
 * spawn -- never a falsy/empty success value.
 */
function makeArgvExec(responses: Record<string, string | Error>): FleetSePrereqExec {
  return vi.fn((file: string, args: string[]) => {
    const key = [file, ...args].join(' ');
    const resp = responses[key];
    if (resp === undefined) {
      throw Object.assign(new Error(`spawn ${key} ENOENT`), { code: 'ENOENT' });
    }
    if (resp instanceof Error) throw resp;
    return resp;
  });
}

describe('resolveFleetSeToolchainPaths (apra-fleet-i9ag.19.1)', () => {
  it('healthy host -> absolute node and bd paths with ok:true', () => {
    const exec = makeArgvExec({
      'node -p process.execPath': '/opt/nvm/versions/node/v22.16.0/bin/node\n',
      'node --version': 'v22.16.0\n',
      'which bd': '/usr/local/bin/bd\n',
      'bd --version': 'bd version 1.2.3\n',
    });

    const result = resolveFleetSeToolchainPaths({ exec, platform: 'linux' });

    expect(result.node).toEqual({
      path: '/opt/nvm/versions/node/v22.16.0/bin/node',
      version: '22.16.0',
      ok: true,
      reason: null,
    });
    expect(result.bd).toEqual({
      path: '/usr/local/bin/bd',
      version: '1.2.3',
      ok: true,
      reason: null,
    });
  });

  it('win32 resolves bd via "where bd" (first non-empty line); the SAME exec under linux cannot satisfy it', () => {
    const exec = makeArgvExec({
      'node -p process.execPath': 'C:\\nvm4w\\nodejs\\node.exe\n',
      'node --version': 'v22.16.0\n',
      'where bd': '\nC:\\Users\\dev\\AppData\\Roaming\\npm\\bd.cmd\r\nC:\\other\\bd.cmd\n',
      'bd --version': '1.2.3\n',
    });

    const win32Result = resolveFleetSeToolchainPaths({ exec, platform: 'win32' });
    expect(win32Result.bd.path).toBe('C:\\Users\\dev\\AppData\\Roaming\\npm\\bd.cmd');
    expect(win32Result.bd.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('where', ['bd'], { shell: true, timeout: PREREQ_PROBE_TIMEOUT_MS });

    vi.mocked(exec).mockClear();

    // Same exec, POSIX platform: resolveBdPath() must ask 'which bd', which
    // this fake does not know how to answer -> bd.ok false. This is what
    // makes the win32 assertion above non-vacuous.
    const linuxResult = resolveFleetSeToolchainPaths({ exec, platform: 'linux' });
    expect(linuxResult.bd.ok).toBe(false);
    expect(linuxResult.bd.path).toBeNull();
    expect(exec).toHaveBeenCalledWith('which', ['bd'], { shell: true, timeout: PREREQ_PROBE_TIMEOUT_MS });
  });

  it('node -p process.execPath throws -> node.ok false with a reason naming the probe, never thrown out of the function', () => {
    const exec = makeArgvExec({
      'node --version': 'v22.16.0\n',
      'which bd': '/usr/local/bin/bd\n',
      'bd --version': '1.2.3\n',
    });

    let result: ReturnType<typeof resolveFleetSeToolchainPaths> | undefined;
    expect(() => {
      result = resolveFleetSeToolchainPaths({ exec, platform: 'linux' });
    }).not.toThrow();

    expect(result!.node.ok).toBe(false);
    expect(result!.node.path).toBeNull();
    expect(result!.node.reason).toMatch(/process\.execPath/);
  });

  it('node below MIN_NODE_VERSION -> node.ok false, reason names the found version and the minimum', () => {
    const exec = makeArgvExec({
      'node -p process.execPath': '/usr/bin/node\n',
      'node --version': 'v22.9.0\n',
      'which bd': '/usr/local/bin/bd\n',
      'bd --version': '1.2.3\n',
    });

    const result = resolveFleetSeToolchainPaths({ exec, platform: 'linux' });

    expect(result.node.ok).toBe(false);
    expect(result.node.path).toBe('/usr/bin/node');
    expect(result.node.version).toBe('22.9.0');
    expect(result.node.reason).toContain('22.9.0');
    expect(result.node.reason).toContain(MIN_NODE_VERSION);
  });

  it('bd absent -> bd.ok false with a reason, and does not affect node\'s result', () => {
    const exec = makeArgvExec({
      'node -p process.execPath': '/usr/bin/node\n',
      'node --version': 'v22.16.0\n',
    });

    const result = resolveFleetSeToolchainPaths({ exec, platform: 'linux' });

    expect(result.bd.ok).toBe(false);
    expect(result.bd.path).toBeNull();
    expect(result.bd.reason).not.toBeNull();
    expect(result.node).toEqual({
      path: '/usr/bin/node',
      version: '22.16.0',
      ok: true,
      reason: null,
    });
  });

  it('bd found on PATH but "bd --version" throws -> bd.ok stays true (path is what matters), version is null', () => {
    const exec = makeArgvExec({
      'node -p process.execPath': '/usr/bin/node\n',
      'node --version': 'v22.16.0\n',
      'which bd': '/usr/local/bin/bd\n',
      'bd --version': Object.assign(new Error('spawn bd ENOENT'), { code: 'ENOENT' }),
    });

    const result = resolveFleetSeToolchainPaths({ exec, platform: 'linux' });

    // Path resolution succeeded -- bd IS on PATH -- so ok reflects that,
    // even though its version could not be determined.
    expect(result.bd.path).toBe('/usr/local/bin/bd');
    expect(result.bd.ok).toBe(true);
    expect(result.bd.version).toBeNull();
  });
});
