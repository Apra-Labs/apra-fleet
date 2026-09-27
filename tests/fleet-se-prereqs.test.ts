import { describe, it, expect, vi } from 'vitest';
import { detectFleetSePrereqs, MIN_NODE_VERSION, type FleetSePrereqExec } from '../src/cli/fleet-se-prereqs.js';

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

  it('platform win32 resolves npm via "npm.cmd" with shell:true; the SAME exec under platform linux cannot satisfy it (non-vacuous, POSIX branch cannot pass)', () => {
    // This exec answers ONLY 'npm.cmd', never bare 'npm' -- so the assertion
    // below is only satisfiable if detectFleetSePrereqs actually spawned the
    // win32-specific file name, not a POSIX-compatible fallback.
    const exec = makeExec({ 'npm.cmd': '10.5.0\n' });

    const win32Result = detectFleetSePrereqs({ exec, platform: 'win32' });
    expect(win32Result.npm).toEqual({ present: true, version: '10.5.0' });
    // Confirms the win32 shim quirk this module exists to handle: spawned via
    // { shell: true }, unlike the POSIX branch.
    expect(exec).toHaveBeenCalledWith('npm.cmd', ['--version'], { shell: true });

    vi.mocked(exec).mockClear();

    // Same exec, POSIX platform: probeNpm() must ask for bare 'npm', which
    // this fake does not know how to answer -> npm.present false. This is
    // what makes the win32 assertion above non-vacuous: the POSIX branch
    // genuinely cannot satisfy the same fake.
    const linuxResult = detectFleetSePrereqs({ exec, platform: 'linux' });
    expect(linuxResult.npm).toEqual({ present: false, version: null });
    expect(exec).toHaveBeenCalledWith('npm', ['--version'], {});
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
