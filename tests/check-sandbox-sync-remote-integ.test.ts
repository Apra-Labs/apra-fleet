import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

// apra-fleet-eft.18.7 (retire/adjust, split out of eft.18.5's plan-review
// criterion 4): apra-fleet-eft.39.2's original fixture built a "bd bootstrap
// --yes then neutralize" arrangement -- an active sync.remote pointing at
// the real hazard, then three sed/git-remote-set-url "neutralize" steps
// patching it back to safe afterward. apra-fleet-eft.18.5 retired that whole
// bootstrap-then-neutralize flow: integ-test-playbook.md's `## Setup` now
// wires both the sandbox-local git origin mirror AND the sandbox-local
// throwaway Dolt file:// remote BEFORE any `bd` command ever runs (see its
// "Seed the sandbox beads DB (structural isolation, no bootstrap, no
// neutralize)" section), then seeds the local beads DB straight from the
// git-tracked `.beads/issues.jsonl`.
//
// This suite is retargeted accordingly: the fixture now builds the actual
// documented `## Setup` wiring (bare-clone git mirror + file:// Dolt config)
// instead of the retired bootstrap+neutralize dance, and still drives the
// REAL exported checks from scripts/check-sandbox-sync-remote.mjs (as a
// subprocess, not just in-process -- see tests/check-sandbox-sync-
// remote.test.ts for the in-process unit coverage apra-fleet-eft.18.6
// added) against that arrangement end-to-end, both the happy path and a
// mutation where the wiring is skipped.
//
// Hermetic: every "remote" here is a local file:// / plain-path git repo
// created fresh under os.tmpdir(); nothing ever touches the network or the
// real fleet-e2e-toy repo. This suite does not stand up a real `bd`/Dolt
// database (no real `bd` binary dependency), so check 3 (Dolt-level remote)
// always reports vacuously OK here regardless of the git-level wiring below
// -- scripts/check-sandbox-sync-remote.mjs's own checkDoltRemoteAbsent()
// treats an unavailable `bd` command as vacuously OK (see that file), and
// apra-fleet-eft.18.6's tests/check-sandbox-sync-remote.test.ts covers that
// check's resolves-inside-sandbox logic directly with injected fixtures.
//
// INCONSISTENCY FOUND (reported, not fixed here): scripts/check-sandbox-
// sync-remote.mjs gates its own `main()` call with
//   if (import.meta.url === `file://${process.argv[1]}`) { main(); }
// On Windows, process.argv[1] is a drive-letter path ('C:\...' or
// 'C:/...'), and `file://${process.argv[1]}` is a MALFORMED file URL (it is
// missing the extra '/' a drive-letter path needs -- the correct form,
// e.g. via pathToFileURL(), is 'file:///C:/...'). That raw string never
// equals the real `import.meta.url`, so on Windows `node
// scripts/check-sandbox-sync-remote.mjs "$HOME/toy-repo"` (the exact
// command integ-test-playbook.md's `## Setup` documents) silently exits 0
// with NO output -- main() never runs, and the missing check looks like a
// clean pass. This is the same class of bug apra-fleet-eft.41.1 fixed
// elsewhere (bin/cli.mjs's isMainModule(), which now falls back to
// realpath'd comparisons) but is NOT yet fixed here. Verified directly:
// `spawnSync(process.execPath, [scriptPath, repoPath])` on this Windows
// machine returns status 0 with empty stdout/stderr regardless of the
// underlying repo state.
//
// To still exercise the real, exported check functions from the real
// script file end-to-end as a subprocess (rather than just in-process, and
// without touching the script itself), this suite drives them through a
// tiny disposable harness module that imports
// scripts/check-sandbox-sync-remote.mjs's actual exports and reproduces
// main()'s own console.log/exit-code logic verbatim (including the
// apra-fleet-eft.18.6 sandboxPath argument). The harness has no "is this
// the entrypoint" guard of its own to trip over -- it IS the entrypoint,
// always -- so it exercises the identical check logic on every platform.

const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'check-sandbox-sync-remote.mjs',
);

const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sync-remote-harness-'));
const harnessPath = path.join(harnessDir, 'run-check.mjs');
fs.writeFileSync(
  harnessPath,
  [
    "import path from 'node:path';",
    `import {`,
    `  checkSyncRemoteInert,`,
    `  checkNoOutboundCommits,`,
    `  checkDoltRemoteAbsent,`,
    `  checkGitOriginNotHazard,`,
    `  defaultSandboxPath,`,
    `} from ${JSON.stringify(pathToFileURL(SCRIPT_PATH).href)};`,
    '',
    '// Verbatim reproduction of check-sandbox-sync-remote.mjs main() -- same',
    "// checks, same message format, same exit-code rule, including the",
    '// apra-fleet-eft.18.6 sandboxPath argument. Exists only because that',
    "// main() is unreachable on Windows (see the file-level comment above)",
    '// via its own broken argv[1]-vs-import.meta.url entry guard.',
    'const repoPath = process.argv[2];',
    'const sandboxPath = process.argv[3] ?? defaultSandboxPath(repoPath);',
    "const configPath = path.join(repoPath, '.beads', 'config.yaml');",
    'const syncCheck = checkSyncRemoteInert(configPath, sandboxPath);',
    "console.log(`[check-sandbox-sync-remote] ${syncCheck.message}`);",
    '',
    'const outboundCheck = checkNoOutboundCommits(repoPath);',
    "console.log(`[check-sandbox-sync-remote] ${outboundCheck.message}`);",
    '',
    'const doltRemoteCheck = checkDoltRemoteAbsent(repoPath, sandboxPath);',
    "console.log(`[check-sandbox-sync-remote] ${doltRemoteCheck.message}`);",
    '',
    'const gitOriginCheck = checkGitOriginNotHazard(repoPath, sandboxPath);',
    "console.log(`[check-sandbox-sync-remote] ${gitOriginCheck.message}`);",
    '',
    'if (!syncCheck.ok || !outboundCheck.ok || !doltRemoteCheck.ok || !gitOriginCheck.ok) {',
    '  process.exit(1);',
    '}',
    "console.log('[check-sandbox-sync-remote] OK: sandbox is isolated from the real fleet-e2e-toy Dolt remote.');",
    '',
  ].join('\n'),
  'utf-8',
);

afterAll(() => {
  fs.rmSync(harnessDir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

/**
 * Runs the harness (which imports and drives the real, exported check
 * functions from scripts/check-sandbox-sync-remote.mjs) as a subprocess
 * against `repoPath`/`sandboxPath`, reproducing what integ-test-
 * playbook.md's `## Setup` documents:
 *   node scripts/check-sandbox-sync-remote.mjs "$HOME/toy-repo"
 */
function runScript(repoPath: string, sandboxPath?: string): { status: number; stdout: string; stderr: string } {
  const args = sandboxPath ? [harnessPath, repoPath, sandboxPath] : [harnessPath, repoPath];
  const res = spawnSync(process.execPath, args, { encoding: 'utf-8' });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

describe('check-sandbox-sync-remote.mjs (subprocess) -- all four checks against the eft.18.5 wire-before-init Setup flow (apra-fleet-eft.18.7 retarget of apra-fleet-eft.39.2)', () => {
  let outerDir: string; // scratch root for this test only
  let sandboxRoot: string; // stand-in for "$HOME" -- outerDir/home
  let realOriginDir: string; // local stand-in for the real fleet-e2e-toy remote, OUTSIDE sandboxRoot
  let toyRepo: string; // the "$HOME/toy-repo" sandbox clone

  beforeEach(() => {
    outerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sandbox-setup-'));
    sandboxRoot = path.join(outerDir, 'home');
    fs.mkdirSync(sandboxRoot, { recursive: true });

    // A local bare repo whose path itself contains the hazard identity
    // ("fleet-e2e-toy"), standing in for the real
    // https://github.com/Apra-Labs/fleet-e2e-toy remote that `## Setup`
    // clones from. check-sandbox-sync-remote.mjs's HAZARD_REMOTE check
    // treats a local path containing that substring the same as the real
    // URL, so this exercises the same detection logic without any network
    // access. Deliberately placed OUTSIDE sandboxRoot, same as the real
    // remote is never under $HOME.
    realOriginDir = path.join(outerDir, 'fleet-e2e-toy.git');
    fs.mkdirSync(realOriginDir, { recursive: true });
    git(realOriginDir, ['init', '--bare', '-b', 'main']);

    const seedDir = path.join(outerDir, 'seed');
    fs.mkdirSync(seedDir, { recursive: true });
    git(seedDir, ['init', '-b', 'main']);
    git(seedDir, ['config', 'user.email', 'test@example.com']);
    git(seedDir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(seedDir, 'README.md'), 'toy repo\n', 'utf-8');
    git(seedDir, ['add', 'README.md']);
    git(seedDir, ['commit', '-m', 'seed commit']);
    git(seedDir, ['push', realOriginDir, 'main']);

    // `## Setup`: `git clone https://github.com/Apra-Labs/fleet-e2e-toy "$HOME/toy-repo"`
    toyRepo = path.join(sandboxRoot, 'toy-repo');
    git(sandboxRoot, ['clone', realOriginDir, toyRepo]);
    git(toyRepo, ['config', 'user.email', 'test@example.com']);
    git(toyRepo, ['config', 'user.name', 'Test']);
  });

  afterEach(() => {
    fs.rmSync(outerDir, { recursive: true, force: true });
  });

  /**
   * Applies integ-test-playbook.md's `## Setup` > "Seed the sandbox beads DB
   * (structural isolation, no bootstrap, no neutralize)" steps VERBATIM
   * (the git mirror clone + remote set-url, plus a hand-written config.yaml
   * standing in for what `bd init --from-jsonl --remote "file://$DOLT_
   * REMOTE"` would persist -- this suite has no real `bd`/Dolt dependency,
   * see the file-level comment above):
   *   GIT_MIRROR="$HOME/.apra-fleet-toy-origin.git"
   *   git clone --bare "$TOY_REPO" "$GIT_MIRROR"
   *   git -C "$TOY_REPO" remote set-url origin "file://$GIT_MIRROR"
   *   DOLT_REMOTE="$HOME/.apra-fleet-toy-dolt-remote"
   *   # bd init --from-jsonl --prefix gh-toy --remote "file://$DOLT_REMOTE" --non-interactive
   */
  function applyDocumentedWireBeforeInit(repoPath: string, sandboxPath: string): { gitMirror: string; doltRemote: string } {
    const gitMirror = path.join(sandboxPath, '.apra-fleet-toy-origin.git');
    git(sandboxPath, ['clone', '--bare', repoPath, gitMirror]);
    git(repoPath, ['remote', 'set-url', 'origin', `file://${gitMirror}`]);

    const doltRemote = path.join(sandboxPath, '.apra-fleet-toy-dolt-remote');
    fs.mkdirSync(path.join(repoPath, '.beads'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, '.beads', 'config.yaml'), `sync:\n  remote: "file://${doltRemote}"\n`, 'utf-8');

    return { gitMirror, doltRemote };
  }

  it('PASSES (exit 0, all four checks OK) after the documented wire-before-init Setup steps run', () => {
    applyDocumentedWireBeforeInit(toyRepo, sandboxRoot);

    const { status, stdout, stderr } = runScript(toyRepo, sandboxRoot);

    expect(status).toBe(0);
    expect(stdout).toContain('OK: active sync.remote');
    expect(stdout).toContain('resolves inside the sandbox path');
    expect(stdout).toContain('OK: sandbox clone at');
    expect(stdout).toMatch(/OK:.*(remote list|remote\(s\)|unavailable)/); // check 3 (Dolt-level, vacuously OK -- no real beads DB in this scratch fixture)
    expect(stdout).toContain("OK: git 'origin' remote");
    expect(stdout).toContain('OK: sandbox is isolated from the real fleet-e2e-toy Dolt remote.');
    // No assertion on stderr being empty: on a machine with a real `bd`
    // binary on PATH (unlike a machine without one), 'bd dolt remote list'
    // against this fixture's DB-less scratch dir prints its own "no beads
    // database found" diagnostic to stderr before checkDoltRemoteAbsent()
    // catches the resulting error and treats it as vacuously OK (see
    // scripts/check-sandbox-sync-remote.mjs) -- that diagnostic is
    // harmless noise, not a check failure, so it must not be conflated
    // with stdout, which the assertions above already pin.
    void stderr;
  });

  it('mutation: WITHOUT wiring git origin to the sandbox-local mirror, exits nonzero and identifies check 4 (origin still points at the real remote)', () => {
    // Wire the Dolt-level sync.remote (config.yaml) but deliberately skip
    // the git-origin re-wire, so the clone's origin still points at the
    // local stand-in for the real fleet-e2e-toy remote -- the exact
    // structural-isolation gap apra-fleet-eft.18.5's `## Setup` closes by
    // doing the git-origin re-wire FIRST, before any bd command runs.
    const doltRemote = path.join(sandboxRoot, '.apra-fleet-toy-dolt-remote');
    fs.mkdirSync(path.join(toyRepo, '.beads'), { recursive: true });
    fs.writeFileSync(path.join(toyRepo, '.beads', 'config.yaml'), `sync:\n  remote: "file://${doltRemote}"\n`, 'utf-8');

    const { status, stdout } = runScript(toyRepo, sandboxRoot);

    expect(status).not.toBe(0);
    // Check 4's FAIL line names the origin explicitly.
    expect(stdout).toMatch(/FAIL: git 'origin' remote in .* fleet-e2e-toy/);
    // Checks 1 and 2 still pass -- only check 4 (git origin) is broken by
    // this omission, demonstrating the test isolates check 4 specifically.
    expect(stdout).toContain('OK: active sync.remote');
    expect(stdout).toContain('OK: sandbox clone at');
    expect(stdout).not.toContain('OK: sandbox is isolated from the real fleet-e2e-toy Dolt remote.');
  });

  it('mutation: WITHOUT wiring sync.remote to the sandbox-local Dolt remote, exits nonzero and identifies check 1 (sync.remote still points at the real remote)', () => {
    // Wire the git origin mirror but deliberately leave sync.remote
    // pointing at the real hazard identity -- the mirror-image gap of the
    // test above, isolating check 1 specifically.
    const gitMirror = path.join(sandboxRoot, '.apra-fleet-toy-origin.git');
    git(sandboxRoot, ['clone', '--bare', toyRepo, gitMirror]);
    git(toyRepo, ['remote', 'set-url', 'origin', `file://${gitMirror}`]);

    fs.mkdirSync(path.join(toyRepo, '.beads'), { recursive: true });
    fs.writeFileSync(
      path.join(toyRepo, '.beads', 'config.yaml'),
      'sync:\n  remote: "git+https://github.com/Apra-Labs/fleet-e2e-toy"\n',
      'utf-8',
    );

    const { status, stdout } = runScript(toyRepo, sandboxRoot);

    expect(status).not.toBe(0);
    expect(stdout).toMatch(/FAIL: active sync\.remote in .* fleet-e2e-toy/);
    expect(stdout).toContain("OK: git 'origin' remote");
    expect(stdout).not.toContain('OK: sandbox is isolated from the real fleet-e2e-toy Dolt remote.');
  });
});
