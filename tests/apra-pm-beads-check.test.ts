import { describe, it, expect } from 'vitest';
// @ts-expect-error -- plain build-free .mjs installer, no type declarations
import { checkBeads, checkBeadsVersion } from '../packages/apra-fleet-se/apra-pm/install.mjs';
import { BEADS_PACKAGE, BEADS_VERSION } from '../src/cli/beads-pin.js';

// The pm installer's beads step (checkBeads): auto-install when bd is missing,
// then compare bd --version's major.minor with its BEADS_PACKAGE pin. spawnSync
// is injected -- no real bd or npm runs.

interface Spawned { status: number | null; stdout?: string; error?: Error }

function run(bdOutputs: Array<Spawned>, npm: Spawned = { status: 0 }) {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let i = 0;
  const code = checkBeads({
    spawnSync: (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'npm') return npm;
      return bdOutputs[Math.min(i++, bdOutputs.length - 1)];
    },
    log: (m: string) => out.push(m),
    error: (m: string) => err.push(m),
    hostname: () => 'pm-test-host',
  });
  return { code, calls, out: out.join('\n'), err: err.join('\n') };
}

describe('apra-pm installer: bd version check', () => {
  it('bd matching the pin -> beads OK, exit 0', () => {
    const r = run([{ status: 0, stdout: 'bd version 1.3.0 (abc)\n' }]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('beads OK: bd version 1.3.0 (abc)');
    expect(r.err).toBe('');
  });

  it('bd 1.4.0 -> non-zero exit naming host, found, expected and the fix', () => {
    const r = run([{ status: 0, stdout: 'bd version 1.4.0 (newer)\n' }]);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('beads OK');
    expect(r.err).toContain('version mismatch on pm-test-host');
    expect(r.err).toContain('found 1.4.0');
    expect(r.err).toContain(`expected ${BEADS_VERSION}`);
    expect(r.err).toContain(`Fix: install the pinned ${BEADS_PACKAGE}`);
    expect(r.calls).toEqual(['bd --version']);
  });

  it('bd 1.2.x and unparseable output are mismatches too', () => {
    expect(run([{ status: 0, stdout: 'bd version 1.2.5\n' }]).code).toBe(1);
    const garbled = run([{ status: 0, stdout: 'bd dev build\n' }]);
    expect(garbled.code).toBe(1);
    expect(garbled.err).toContain('unparseable version output');
  });

  it('missing bd is auto-installed, then the installed version is checked', () => {
    const ok = run([{ status: 1, stdout: '' }, { status: 0, stdout: 'bd version 1.3.0\n' }]);
    expect(ok.code).toBe(0);
    expect(ok.calls).toContain(`npm install -g ${BEADS_PACKAGE}`);
    expect(ok.out).toContain('beads OK');
    const bad = run([{ status: 1, stdout: '' }, { status: 0, stdout: 'bd version 1.4.0\n' }]);
    expect(bad.code).toBe(1);
  });

  it('a failed auto-install keeps the long-standing non-fatal warning', () => {
    const r = run([{ status: 1, stdout: '' }], { status: 1 });
    expect(r.code).toBe(0);
    expect(r.err).toContain('beads install failed');
  });

  it('checkBeadsVersion compares major.minor against the package pin', () => {
    expect(checkBeadsVersion('bd version 1.3.9', BEADS_PACKAGE).ok).toBe(true);
    expect(checkBeadsVersion('bd version 1.4.0', BEADS_PACKAGE)).toMatchObject({ ok: false, found: '1.4.0', expected: BEADS_VERSION });
  });
});
