import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// apra-fleet-i9ag.12.1 -- `apra-fleet install` must MINT ~/.apra-fleet/fleet.key.
//
// Before this step getOrCreateKey() (src/services/jwt.ts) had zero call sites in
// src/cli/install.ts, so nothing in the install sequence or CLI startup created
// the key: on a fresh machine it only appeared the first time some request
// happened to need it. A supervisor started before that point found no key and
// skipped workflow-package registration (the bug this lane fixes).
//
// This suite runs the REAL install against a REAL temp HOME on the REAL fs --
// not a mocked fs -- because two of the acceptance criteria (file mode 0600 and
// byte-for-byte stability across a second install) are only meaningful against
// a real filesystem. node:os is mocked for the dynamically re-imported module
// graph so that os.homedir() -- which install.ts, paths.ts and jwt.ts all read
// lazily -- resolves to the temp dir.

const REAL_HOME_FLEET_DIR = path.join(os.homedir(), '.apra-fleet');

/**
 * Fingerprint of the developer's REAL ~/.apra-fleet, so the final criterion
 * ("no write lands in the developer's real HOME/.apra-fleet") is measured
 * rather than assumed. Records each entry's name, size and mtime, so a
 * rewrite-in-place of fleet.key would show up even though the name list did not
 * change.
 */
function realHomeFingerprint(): string {
  if (!fs.existsSync(REAL_HOME_FLEET_DIR)) return 'ABSENT';
  return fs
    .readdirSync(REAL_HOME_FLEET_DIR)
    .sort()
    .map(name => {
      try {
        const st = fs.statSync(path.join(REAL_HOME_FLEET_DIR, name));
        return `${name}:${st.isDirectory() ? 'dir' : st.size}:${st.mtimeMs}`;
      } catch {
        return `${name}:unreadable`;
      }
    })
    .join('|');
}

describe('install mints fleet.key (apra-fleet-i9ag.12.1)', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let savedCwd: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let logged: string[];
  let installMod: typeof import('../src/cli/install.js');

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-key-install-home-'));
    // A cwd with NO .git, so install.ts's KB/code-intelligence step takes its
    // "not in a git repository" branch instead of touching this repo's .mcp.json.
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-key-install-cwd-'));
    savedCwd = process.cwd();
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    process.chdir(tmpCwd);

    vi.resetModules();
    vi.doMock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:os')>();
      return { ...actual, default: { ...actual, homedir: () => tmpHome }, homedir: () => tmpHome };
    });
    installMod = await import('../src/cli/install.js');
    installMod._setSeaOverride(false); // dev mode -- no binary copy
    // Minimal manifest: only hooks-config.json, which install.ts's step 4 reads
    // back out of HOOKS_DIR unconditionally (so an empty hooks map would ENOENT
    // before the assertions below are reached). In dev mode extractAsset()
    // resolves asset keys against findProjectRoot() -- derived from
    // import.meta.url, NOT cwd -- so this is a read of the repo's own file and
    // writes nothing into it.
    installMod._setManifestOverride({
      version: '0.1.0',
      hooks: { 'hooks-config.json': 'hooks/hooks-config.json' },
      scripts: {}, skills: {}, fleetSkills: {},
    } as any);

    // Capture everything the install prints so the "key value is never logged"
    // criterion can be checked against real output.
    logged = [];
    const sink = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(sink);
    vi.spyOn(console, 'warn').mockImplementation(sink);
    vi.spyOn(console, 'error').mockImplementation(sink);
  });

  afterEach(() => {
    process.chdir(savedCwd);
    installMod?._setManifestOverride(null);
    installMod?._setSeaOverride(null);
    vi.doUnmock('node:os');
    vi.resetModules();
    vi.restoreAllMocks();
    if (savedHome !== undefined) process.env.HOME = savedHome; else delete process.env.HOME;
    if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile;
    else delete process.env.USERPROFILE;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('creates HOME/.apra-fleet/fleet.key as 64 lowercase hex chars, mode 0600, without logging the key or touching the real HOME', async () => {
    const keyPath = path.join(tmpHome, '.apra-fleet', 'fleet.key');
    expect(fs.existsSync(keyPath)).toBe(false); // fresh HOME: nothing there yet
    const realHomeBefore = realHomeFingerprint();

    await installMod.runInstall([]);

    // --- criterion: exists, exactly 64 lowercase hex characters ---
    expect(fs.existsSync(keyPath)).toBe(true);
    const raw = fs.readFileSync(keyPath, 'utf8');
    expect(raw).toMatch(/^[0-9a-f]{64}$/);

    // --- criterion: mode 0600 on POSIX ---
    if (process.platform !== 'win32') {
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    }

    // --- criterion: the key value never appears in stdout/stderr ---
    const output = logged.join('\n');
    expect(output).not.toContain(raw.trim());
    // ...but the install does say where the key is, so a failure is diagnosable.
    expect(output).toContain(keyPath);

    // --- criterion: no write landed in the developer's real ~/.apra-fleet ---
    expect(realHomeFingerprint()).toBe(realHomeBefore);
  }, 30000);

  it('is idempotent: a second install leaves the key bytes unchanged', async () => {
    const keyPath = path.join(tmpHome, '.apra-fleet', 'fleet.key');

    await installMod.runInstall([]);
    const firstBytes = fs.readFileSync(keyPath);

    await installMod.runInstall([]);
    const secondBytes = fs.readFileSync(keyPath);

    expect(secondBytes.equals(firstBytes)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    }
  }, 30000);

  it('warns loudly, naming the path and the reason, when the key cannot be written', async () => {
    if (process.platform === 'win32') return; // chmod-based denial is POSIX-only
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores 0o500

    // Make HOME/.apra-fleet exist but be unwritable, so getOrCreateKey()'s
    // writeFileSync fails (mkdirSync recursive on an existing dir succeeds).
    const fleetDir = path.join(tmpHome, '.apra-fleet');
    fs.mkdirSync(fleetDir, { recursive: true });
    fs.chmodSync(fleetDir, 0o500);

    try {
      // The mint step is non-fatal and runs BEFORE step 1, so its warning is
      // emitted first. The install itself still dies later -- an unwritable
      // ~/.apra-fleet also blocks the hooks/scripts dirs -- which is correct and
      // loud; what this test pins is that the KEY step did not fail SILENTLY.
      await expect(installMod.runInstall([])).rejects.toThrow(/EACCES|EPERM/);

      const output = logged.join('\n');
      expect(output).toMatch(/Could not create the fleet key/);
      expect(output).toContain(path.join(fleetDir, 'fleet.key')); // names the path
      expect(output).toMatch(/EACCES|permission denied/);          // names the reason
      expect(fs.existsSync(path.join(fleetDir, 'fleet.key'))).toBe(false);
    } finally {
      fs.chmodSync(fleetDir, 0o700); // so afterEach's rmSync can clean up
    }
  }, 30000);
});
