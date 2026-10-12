import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  runInstall,
  formatFleetSeBdPart,
  _setSeaOverride,
  _setManifestOverride,
  _setFleetSePrereqStepDeps,
  _resetFleetSePrereqStepDeps,
} from '../src/cli/install.js';
import { extractWorkflowSubsystemAssets } from '../src/cli/workflow-assets.js';
import { MIN_NODE_VERSION, FLEET_SE_PREREQ_FIX_LINE, type FleetSePrereqResult } from '../src/cli/fleet-se-prereqs.js';
import { BEADS_PACKAGE } from '../src/cli/beads-pin.js';
import { SUPERVISOR_SUBCOMMAND } from '../src/services/supervisor-service.js';
import { getOrCreateKey } from '../src/services/jwt.js';

// apra-fleet-i9ag.13.7.3 -- pins the fix for gap bug apra-fleet-i9ag.13.7 (the
// installer silently npm-installed beads via a non-fatal try/catch, exactly
// the "Beads install skipped" wording apra-fleet-i9ag.13.7.2 removed) so a
// future re-divergence between sprint branches is caught by a red test here,
// not by a manual integration run -- which is exactly how the original gap
// escaped undetected.
//
// REVERT CHECK (per this bead's acceptance criteria): reverting
// src/cli/install.ts's Beads install step back to the old non-fatal
//   } catch (err) {
//     console.warn('  - Beads install skipped - npm not available or install failed');
//   }
// makes the "prerequisites satisfied but npm install throws" case (case 6,
// "fails fatally when the @beads/bd npm install itself throws" below) FAIL:
// runInstall() would resolve instead of rejecting, because process.exit(1)
// would never be called. The "no reintroduction anywhere in src/" describe
// block at the bottom of this file is a second, independent canary for the
// same revert (it greps the real, unmocked src/ tree for the retired string).
//
// Sandbox/isolation note (criterion 8): unlike a handful of OTHER suites in
// this repo that exercise extractWorkflowSubsystemAssets() against a REAL
// temp HOME directory (see tests/install-workflows.test.ts's "eft86-2"
// suite), the tests below drive the FULL runInstall() pipeline -- binary/
// hooks/scripts/settings/MCP-registration/skills/agents/workflow/dolt/
// Beads/KB steps -- which reads and writes many real paths when node:fs is
// not mocked (see install.ts's extractAssetBuffer(), which reads real
// project files via findProjectRoot() in dev mode). Every other
// tests/install-*.test.ts suite that drives runInstall() therefore mocks
// node:fs and node:os entirely (mockHome = '/mock/home', never a real
// directory) rather than using a real mkdtempSync'd HOME -- this file
// follows that same, already-established convention for the SAME reason.
// With node:fs fully mocked, zero bytes are ever read from or written to a
// real path, so there is no real temp HOME to remove in teardown and the
// developer's real ~/.apra-fleet is provably untouched by construction, not
// merely by convention: the assertion at the end of each test in the first
// describe block below confirms every fs.writeFileSync/mkdirSync call target
// started with the mocked home, never a real path.

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/mock/home'),
    platform: vi.fn(() => 'linux'),
  },
}));
vi.mock('node:fs');
vi.mock('node:child_process');
vi.mock('../src/cli/workflow-assets.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/cli/workflow-assets.js')>();
  return { ...orig, extractWorkflowSubsystemAssets: vi.fn() };
});
// apra-fleet-i9ag.12.15: getOrCreateKey() is the FIRST irreversible act of an
// install (it mints ~/.apra-fleet/fleet.key), so "the gate runs before
// anything is written" is only checkable if this call is observable. Wrapped
// rather than stubbed -- the real implementation still runs for the happy
// path, exactly as before.
vi.mock('../src/services/jwt.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/services/jwt.js')>();
  return { ...orig, getOrCreateKey: vi.fn(orig.getOrCreateKey) };
});

const mockHome = '/mock/home';

/**
 * The isolation predicate used by the afterEach check below, factored out so it
 * can be exercised under an explicit path flavour (see the win32 assertion at
 * the bottom of this file). `impl` is a path module flavour -- node:path on the
 * host under test, or path.win32/path.posix in that assertion.
 *
 * Separator-agnostic on purpose (apra-fleet-i9ag.13): mockHome is written with
 * '/', but install.ts builds its targets with path.join(), so on win32 they
 * come back as '\\mock\\home\\...'. A literal startsWith('/mock/home') therefore
 * rejected a perfectly in-sandbox path and turned the whole suite red on
 * Windows CI. Resolving both sides normalizes the separators (and the drive
 * root win32 prepends) without weakening the check: a target that really is
 * outside the mocked home resolves outside it and still fails.
 */
function isInsideMockHome(target: string, impl: path.PlatformPath = path): boolean {
  // A relative target cannot name the developer's real HOME, so it was always
  // accepted here -- keep that, unchanged.
  if (!impl.isAbsolute(target)) return true;
  const home = impl.resolve(mockHome);
  const resolved = impl.resolve(target);
  return resolved === home || resolved.startsWith(home + impl.sep);
}

const BASE_MANIFEST = {
  version: '0.1.0', hooks: {}, scripts: {}, skills: {}, fleetSkills: {}, agents: {}, workflows: {},
};

function makeFsMock() {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (ps.includes('version.json')) return true;
    if (ps.includes('hooks-config.json')) return true;
    return false;
  });
  vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
    const ps = p.toString();
    if (ps.includes('version.json')) return JSON.stringify({ version: '0.1.0' });
    if (ps.includes('hooks-config.json')) return JSON.stringify({ hooks: { PostToolUse: [] } });
    return '';
  });
  vi.mocked(fs.readdirSync).mockReturnValue([] as any);
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
  vi.mocked(fs.chmodSync).mockImplementation(() => {});
  vi.mocked(fs.copyFileSync).mockImplementation(() => {});
  vi.mocked(fs.writeFileSync).mockImplementation(() => {});
  vi.mocked(fs.rmSync).mockImplementation(() => undefined as any);
}

function fakeDetector(result: FleetSePrereqResult) {
  return vi.fn().mockReturnValue(result);
}

const SATISFIED: FleetSePrereqResult = {
  node: { present: true, version: '22.16.0', satisfiesMin: true },
  npm: { present: true, version: '10.5.0' },
  ok: true,
  missing: [],
};

describe('installer fleet-se prerequisite gate (apra-fleet-i9ag.13.7.3)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    makeFsMock();
    _setSeaOverride(false);
    _setManifestOverride(BASE_MANIFEST as any);
    // Opt in to the real prereq-check code path under NODE_ENV=test (see
    // fleetSePrereqCheckEnabled() in install.ts) -- mirrors
    // APRA_FLEET_ENABLE_DOLT_INSTALL's identical escape hatch for the dolt
    // step in tests/install-dolt.test.ts.
    process.env.APRA_FLEET_ENABLE_FLEET_SE_PREREQ_CHECK = '1';
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    _setSeaOverride(null);
    _setManifestOverride(null);
    _resetFleetSePrereqStepDeps();
    delete process.env.APRA_FLEET_ENABLE_FLEET_SE_PREREQ_CHECK;
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();

    // Criterion 8's isolation guarantee, made explicit rather than merely
    // structural: every write this run attempted stayed under the mocked
    // home, never fell through to a real path (e.g. via an unmocked
    // os.homedir() call slipping past the mock above).
    const allWriteTargets = [
      ...vi.mocked(fs.writeFileSync).mock.calls.map(c => String(c[0])),
      ...vi.mocked(fs.mkdirSync).mock.calls.map(c => String(c[0])),
    ];
    for (const target of allWriteTargets) {
      expect(isInsideMockHome(target), `write target escaped the mocked home: ${target}`).toBe(true);
    }
  });

  it('case 1: node absent, --workflows all -- exits non-zero, names node, prints the fix line verbatim, never extracts workflow assets', async () => {
    _setFleetSePrereqStepDeps({
      detectFleetSePrereqs: fakeDetector({
        node: { present: false, version: null, satisfiesMin: false },
        npm: { present: true, version: '10.5.0' },
        ok: false,
        missing: ['node'],
      }),
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as any);

    await expect(runInstall(['--skill', 'none'])).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errors = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errors).toContain('node');
    expect(errors).toContain(FLEET_SE_PREREQ_FIX_LINE);
    expect(vi.mocked(extractWorkflowSubsystemAssets)).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('case 2: node too old (22.9.0), --workflows all -- exits non-zero, names both the detected and minimum versions, never extracts workflow assets', async () => {
    _setFleetSePrereqStepDeps({
      detectFleetSePrereqs: fakeDetector({
        node: { present: true, version: '22.9.0', satisfiesMin: false },
        npm: { present: true, version: '10.5.0' },
        ok: false,
        missing: ['node'],
      }),
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as any);

    await expect(runInstall(['--skill', 'none'])).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errors = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errors).toContain('22.9.0');
    expect(errors).toContain(MIN_NODE_VERSION);
    expect(vi.mocked(extractWorkflowSubsystemAssets)).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  it('case 3: npm absent, --workflows all -- exits non-zero, names npm, prints the fix line verbatim, never extracts workflow assets', async () => {
    _setFleetSePrereqStepDeps({
      detectFleetSePrereqs: fakeDetector({
        node: { present: true, version: '22.16.0', satisfiesMin: true },
        npm: { present: false, version: null },
        ok: false,
        missing: ['npm'],
      }),
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as any);

    await expect(runInstall(['--skill', 'none'])).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errors = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errors).toContain('npm');
    expect(errors).toContain(FLEET_SE_PREREQ_FIX_LINE);
    expect(vi.mocked(extractWorkflowSubsystemAssets)).not.toHaveBeenCalled();

    exitSpy.mockRestore();
  });

  // apra-fleet-i9ag.12.15: the gate is a hard failure an operator can only
  // avoid by knowing the requirement in advance, so `install --help` has to
  // state it. The byte-for-byte fixture guard in
  // tests/install-multi-provider.test.ts pins the whole help surface; this
  // asserts the CLAIM itself, so a future fixture refresh cannot quietly
  // drop the line.
  it('`install --help` states the fleet-se Node/npm requirement under --workflows', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as any);

    await expect(runInstall(['--help'])).rejects.toThrow('exit');

    const help = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(help).toContain('fleet-se requires Node.js 22.16+ and npm.');
    // It belongs to --workflows, the flag that turns the requirement on/off,
    // not to some unrelated part of the help. (Search for the NEXT '--force'
    // after --workflows: the examples block above the flag list mentions
    // --force too.)
    const wfStart = help.indexOf('  --workflows <mode>');
    expect(wfStart).toBeGreaterThan(-1);
    const workflowsSection = help.slice(wfStart, help.indexOf('  --force ', wfStart));
    expect(workflowsSection).toContain('fleet-se requires Node.js 22.16+ and npm.');

    exitSpy.mockRestore();
  });

  // The Services block used to tell operators the supervisor service runs
  // 'workflows/fleet-sprint/bin/serve.mjs'. src/services/supervisor-service.ts
  // stopped registering it that way (the unit runs the binary's own
  // SUPERVISOR_SUBCOMMAND, so a fresh machine needs no node on PATH to boot
  // it), which is exactly what the fresh-install smoke on apra-fleet-i9ag.13
  // exercises -- so the help was describing a shape the installer no longer
  // produces.
  it('`install --help` describes the supervisor service as the binary subcommand, not a serve.mjs path', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as any);

    await expect(runInstall(['--help'])).rejects.toThrow('exit');

    const help = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    const svcStart = help.indexOf('Services (SEA');
    expect(svcStart).toBeGreaterThan(-1);
    const servicesSection = help.slice(svcStart);
    expect(servicesSection).toContain(`'apra-fleet ${SUPERVISOR_SUBCOMMAND}'`);
    expect(servicesSection).not.toContain('serve.mjs');
    expect(servicesSection).toContain('--workflows none');

    exitSpy.mockRestore();
  });

  // The pure renderer behind the ready line, tested directly: the doubling was
  // only ever visible in the fully-composed summary string.
  describe('formatFleetSeBdPart()', () => {
    it("strips bd's own leading name from the raw `bd --version` output", () => {
      expect(formatFleetSeBdPart('bd version 1.3.0 (f45b249ce)')).toBe('version 1.3.0 (f45b249ce)');
      expect(formatFleetSeBdPart('bd 1.3.0')).toBe('1.3.0');
    });

    it('passes the non-version fallback summaries through untouched', () => {
      expect(formatFleetSeBdPart('installed')).toBe('installed');
      expect(formatFleetSeBdPart('not available')).toBe('not available');
    });

    it('strips only ONE leading name, so a version that itself starts with bd survives', () => {
      expect(formatFleetSeBdPart('bd bd-next 2.0.0')).toBe('bd-next 2.0.0');
    });
  });

  // apra-fleet-i9ag.13 / apra-fleet-i9ag.12.15: the gate used to run MID-
  // install -- after the fleet.key mint, the binary copy, hooks, scripts and
  // settings had already been written -- so a machine missing Node was left
  // half-installed by the very command that then told it to install Node.
  // The gate now runs immediately after --workflows is parsed, before the
  // running-process guard stops anything and before the first byte is
  // written. These two cases pin that ORDERING, which cases 1-3 (message
  // content) cannot: they would still pass with the gate back in its old
  // mid-install position.
  it('case 8 (ORDERING): a failed gate mints no fleet.key and performs no write of any kind', async () => {
    _setFleetSePrereqStepDeps({
      detectFleetSePrereqs: fakeDetector({
        node: { present: false, version: null, satisfiesMin: false },
        npm: { present: false, version: null },
        ok: false,
        missing: ['node', 'npm'],
      }),
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as any);

    await expect(runInstall(['--skill', 'none'])).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);

    // The key mint is the install's first irreversible act -- never reached.
    expect(vi.mocked(getOrCreateKey)).not.toHaveBeenCalled();
    // ...and neither is any other mutation of the filesystem: no directory
    // created, no file written, no binary copied, no mode changed, nothing
    // removed. An empty HOME stays empty.
    expect(vi.mocked(fs.mkdirSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.copyFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.chmodSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.rmSync)).not.toHaveBeenCalled();
    // The gate also precedes the "Installing Apra Fleet ..." banner, so the
    // operator is never told an install started that then did not happen.
    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).not.toContain('Installing Apra Fleet');

    exitSpy.mockRestore();
  });

  it('case 9 (ORDERING, non-vacuous control): the SAME run with prerequisites satisfied does mint the key and write', async () => {
    // Without this control, case 8 would also pass if runInstall() simply
    // never wrote anything under these mocks. Same args, same mocks, only the
    // detector verdict flipped.
    _setFleetSePrereqStepDeps({ detectFleetSePrereqs: fakeDetector(SATISFIED) });
    vi.mocked(execFileSync).mockReturnValue('bd 1.3.0\n' as any);

    await expect(runInstall(['--skill', 'none'])).resolves.toBeUndefined();

    expect(vi.mocked(getOrCreateKey)).toHaveBeenCalled();
    expect(vi.mocked(fs.writeFileSync).mock.calls.length).toBeGreaterThan(0);
    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).toContain('Installing Apra Fleet');
  });

  it('case 4: prerequisites satisfied, --workflows all (happy path) -- exits 0 and the summary reports fleet-se ready with versions', async () => {
    _setFleetSePrereqStepDeps({ detectFleetSePrereqs: fakeDetector(SATISFIED) });
    // bd already installed -- no npm install attempted.
    vi.mocked(execFileSync).mockReturnValue('bd 1.3.0\n' as any);

    await expect(runInstall(['--skill', 'none'])).resolves.toBeUndefined();

    expect(vi.mocked(extractWorkflowSubsystemAssets)).toHaveBeenCalledTimes(1);
    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).toMatch(/fleet-se:\s+ready/);
    expect(logs).toContain('node 22.16.0');
    expect(logs).toContain('npm 10.5.0');
    // The bd version on the ready line is the one this install actually
    // probed, never the placeholder 'not available' (apra-fleet-i9ag.13.7.2):
    // 'ready' and 'bd not available' must not be able to co-occur.
    // The literal 'bd ' prefix on this line plus bd's own self-naming
    // `--version` output used to render 'bd bd 1.3.0' (the real binary prints
    // 'bd version <v> (<sha>)', so a fresh install read 'bd bd version ...').
    // formatFleetSeBdPart() strips the duplicate, so bd is named exactly once.
    expect(logs).toMatch(/fleet-se:\s+ready \(node 22\.16\.0, npm 10\.5\.0, bd 1\.3\.0\)/);
    expect(logs).not.toContain('bd bd');
    expect(logs).not.toContain('bd not available');
    // bd was already present, so no npm install was attempted.
    const npmInstallCall = vi.mocked(execFileSync).mock.calls.find(
      c => c[0] === 'npm' && Array.isArray(c[1]) && c[1].includes(BEADS_PACKAGE),
    );
    expect(npmInstallCall).toBeUndefined();
  });

  it('case 5: prerequisites absent, --workflows none -- exits 0, the Beads step never runs, and the summary reports fleet-se NOT INSTALLED with the fix line', async () => {
    // Even though the injected detector would fail the gate, --workflows
    // none must never call it at all -- the gate is conditioned on
    // installWorkflows, not merely "disabled when prereqs are bad".
    const detector = fakeDetector({
      node: { present: false, version: null, satisfiesMin: false },
      npm: { present: false, version: null },
      ok: false,
      missing: ['node', 'npm'],
    });
    _setFleetSePrereqStepDeps({ detectFleetSePrereqs: detector });

    await expect(runInstall(['--skill', 'none', '--workflows', 'none'])).resolves.toBeUndefined();

    expect(detector).not.toHaveBeenCalled();
    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).not.toContain('Installing Beads task tracker');
    // apra-fleet-3t9b: skipped by choice -- no fix line suggesting the flag
    // the operator already used, and no /auto-sprint advertised.
    expect(logs).toMatch(/fleet-se:\s+skipped by choice/);
    expect(logs).not.toContain(FLEET_SE_PREREQ_FIX_LINE);
    expect(logs).not.toContain('--workflows none for the core console only');
    expect(logs).not.toContain('/auto-sprint');
    // No npm install of @beads/bd was ever attempted.
    const npmInstallCall = vi.mocked(execFileSync).mock.calls.find(
      c => c[0] === 'npm' && Array.isArray(c[1]) && c[1].includes(BEADS_PACKAGE),
    );
    expect(npmInstallCall).toBeUndefined();
  });

  it('case 5b (3t9b): the closing banner lists /auto-sprint in default mode and omits it with --workflows none', async () => {
    _setFleetSePrereqStepDeps({ detectFleetSePrereqs: fakeDetector(SATISFIED) });
    vi.mocked(execFileSync).mockReturnValue('bd 1.3.0\n' as any);
    await expect(runInstall(['--llm', 'claude'])).resolves.toBeUndefined();
    const defaultLogs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(defaultLogs).toMatch(/fleet-se:\s+ready/);
    expect(defaultLogs).toContain('/auto-sprint BD-1');

    logSpy.mockClear();
    await expect(runInstall(['--llm', 'claude', '--workflows', 'none'])).resolves.toBeUndefined();
    const noneLogs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(noneLogs).not.toContain('/auto-sprint');
    expect(noneLogs).toMatch(/fleet-se:\s+skipped by choice/);
  });

  it('case 6: prerequisites satisfied but the @beads/bd npm install itself throws -- exits non-zero and surfaces npm\'s own error text (REVERT CANARY)', async () => {
    _setFleetSePrereqStepDeps({ detectFleetSePrereqs: fakeDetector(SATISFIED) });
    // bd --version throws (not installed), then the npm install throws too.
    //
    // FIDELITY (apra-fleet-i9ag.13.7.2): the thrown error is shaped the way a
    // REAL failed execFileSync is -- a generic 'Command failed: ...' message
    // with npm's diagnostics on err.stderr, NOT baked into err.message. An
    // earlier version of this test put npm's text in the message, which passed
    // even though install.ts used stdio 'inherit' and therefore could never
    // have recovered that text itself. Asserting on a string that appears ONLY
    // in stderr is what makes "surfaces npm's own error text" a real claim.
    vi.mocked(execFileSync).mockImplementation(((file: string) => {
      if (file === 'npm') {
        throw Object.assign(new Error(`Command failed: npm install -g ${BEADS_PACKAGE}`), {
          stdout: '',
          stderr: 'npm ERR! network timeout',
          status: 1,
        });
      }
      throw new Error('bd: command not found');
    }) as any);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as any);

    await expect(runInstall(['--skill', 'none'])).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errors = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errors).toContain('npm ERR! network timeout');
    const warns = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warns).not.toContain('Beads install skipped');
    // The install never reached the summary, so it cannot have claimed ready.
    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).not.toMatch(/fleet-se:\s+ready/);

    exitSpy.mockRestore();
    // See the reset comment on the equivalent test in tests/install.test.ts --
    // execFileSync is an automock, not a vi.spyOn; clearAllMocks() does not
    // reset a custom .mockImplementation(), so a throwing implementation set
    // here would otherwise leak into whichever test runs next.
    vi.mocked(execFileSync).mockReset();
  });

  it('case 7: npm install succeeds but bd is still not runnable -- exits non-zero and never claims fleet-se ready', async () => {
    // apra-fleet-i9ag.13.7.2: npm exiting 0 does not mean bd works. npm's
    // global bin directory is routinely off PATH (nvm, volta, most Windows
    // setups), and the installer used to go on to print
    // 'fleet-se: ready (node X, npm Y, bd not available)' and exit 0 -- a
    // false success of exactly the shape this lane exists to delete.
    _setFleetSePrereqStepDeps({ detectFleetSePrereqs: fakeDetector(SATISFIED) });
    vi.mocked(execFileSync).mockImplementation(((file: string) => {
      // npm happily reports success...
      if (file === 'npm') return '' as any;
      // ...but bd still cannot be spawned, before OR after the install.
      throw new Error('bd: command not found');
    }) as any);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as any);

    await expect(runInstall(['--skill', 'none'])).rejects.toThrow('exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    // The install really was attempted -- this is the post-install check
    // failing, not the pre-check short-circuiting past npm.
    const npmInstallCall = vi.mocked(execFileSync).mock.calls.find(
      c => c[0] === 'npm' && Array.isArray(c[1]) && c[1].includes(BEADS_PACKAGE),
    );
    expect(npmInstallCall).toBeDefined();
    const errors = errorSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errors).toContain(BEADS_PACKAGE);
    expect(errors).toContain('PATH');
    const logs = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logs).not.toMatch(/fleet-se:\s+ready/);
    expect(logs).not.toContain('bd not available');

    exitSpy.mockRestore();
    // See the reset comment on case 6 -- same automock leak risk.
    vi.mocked(execFileSync).mockReset();
  });
});

// apra-fleet-i9ag.13: the afterEach isolation check above used to compare write
// targets against the '/'-spelled mockHome literally, so on Windows CI -- where
// install.ts's path.join() returns '\\mock\\home\\...' -- every test in the suite
// above failed teardown on a path that was in fact inside the sandbox. These
// assertions run the predicate under BOTH path flavours explicitly, so the
// regression is caught on any host rather than only on a Windows runner.
describe('isInsideMockHome() is separator-agnostic (apra-fleet-i9ag.13)', () => {
  for (const [name, impl] of [['win32', path.win32], ['posix', path.posix]] as const) {
    it(`${name}: accepts targets the installer builds under the mocked home`, () => {
      expect(isInsideMockHome(impl.join(mockHome, '.apra-fleet', 'fleet.key'), impl)).toBe(true);
      expect(isInsideMockHome(impl.join(mockHome, '.apra-fleet'), impl)).toBe(true);
      // The mocked home itself (a bare mkdirSync of HOME) is inside it.
      expect(isInsideMockHome(impl.resolve(mockHome), impl)).toBe(true);
      // Relative targets never name a real HOME -- unchanged from before.
      expect(isInsideMockHome(impl.join('relative', 'dir'), impl)).toBe(true);
    });

    it(`${name}: still REJECTS a genuine write outside the mocked home`, () => {
      const outside = name === 'win32' ? 'C:\\Users\\real\\.apra-fleet\\fleet.key' : '/home/real/.apra-fleet/fleet.key';
      expect(isInsideMockHome(outside, impl)).toBe(false);
      // A sibling whose name merely STARTS with the mocked home is outside it
      // too -- the '/'-literal startsWith() check used to accept this one.
      expect(isInsideMockHome(impl.join(`${mockHome}evil`, 'fleet.key'), impl)).toBe(false);
      // ...and so is an escape spelled with '..' rather than absolutely.
      expect(isInsideMockHome(impl.join(mockHome, '..', 'elsewhere', 'fleet.key'), impl)).toBe(false);
    });
  }
});

// Criterion 7 (a second, independent revert canary -- see the REVERT CHECK
// note at the top of this file): scans the REAL, unmocked src/ tree for the
// retired non-fatal wording, so a reintroduction anywhere in the file is
// caught even if every runInstall()-driving test above somehow missed it.
// node:fs/node:child_process are unmocked here (vi.doUnmock + vi.resetModules,
// the same real-filesystem pattern tests/install-workflows.test.ts's
// "eft.19"/"eft.84" suites already use) since this check reads real files on
// disk, not the mocked install.ts pipeline.
describe('no reintroduction of the old non-fatal Beads wording in src/ (apra-fleet-i9ag.13.7.3 criterion 7)', () => {
  afterEach(() => {
    vi.doMock('node:fs');
    vi.doMock('node:child_process');
  });

  it('grep -r "Beads install skipped" src/ returns zero matches', async () => {
    vi.resetModules();
    vi.doUnmock('node:fs');
    vi.doUnmock('node:child_process');

    const fsReal = await vi.importActual<typeof import('node:fs')>('node:fs');
    const pathReal = await vi.importActual<typeof import('node:path')>('node:path');
    const { fileURLToPath } = await vi.importActual<typeof import('node:url')>('node:url');

    const testDir = pathReal.dirname(fileURLToPath(import.meta.url));
    const srcDir = pathReal.resolve(testDir, '..', 'src');

    const offenders: string[] = [];
    function walk(dir: string): void {
      for (const entry of fsReal.readdirSync(dir, { withFileTypes: true })) {
        const full = pathReal.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && /\.(ts|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
          const content = fsReal.readFileSync(full, 'utf-8');
          if (content.includes('Beads install skipped')) {
            offenders.push(full);
          }
        }
      }
    }
    walk(srcDir);

    expect(offenders, `found the retired non-fatal wording in: ${JSON.stringify(offenders)}`).toEqual([]);
  });
});
