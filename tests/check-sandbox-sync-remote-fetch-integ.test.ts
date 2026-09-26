import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

// apra-fleet-eft.18.7 (retire/adjust, split out of eft.18.5's plan-review
// criterion 4): the original apra-fleet-eft.47.2 suite pinned a fix to the
// retired "Neutralize sandbox sync.remote" step -- pointing git `origin` at
// a fetchable local bare clone instead of an unfetchable
// `file:///dev/null/...` placeholder, applied AFTER a `bd bootstrap --yes`
// had already wired `origin` at the real hazard remote. apra-fleet-eft.18.5
// retired that whole bootstrap-then-neutralize flow: integ-test-
// playbook.md's `## Setup` now wires git `origin` at a sandbox-local bare
// mirror (`$GIT_MIRROR`) BEFORE any `bd` command ever runs, so there is no
// separate "neutralize" step left to test, and no unfetchable placeholder
// value exists anywhere in the current flow to regress back to.
//
// The underlying property eft.47 cared about -- the sandbox's git `origin`
// must be BOTH fetchable (so the sprint engine's own 'git fetch origin
// main' in Ensure Sprint Branch, and this playbook's own '## Reset' step,
// keep working) AND fully isolated from the real
// https://github.com/Apra-Labs/fleet-e2e-toy remote -- is still load-
// bearing under the new flow, since `$GIT_MIRROR` is exactly what supplies
// it. This suite is retargeted to pin that property directly against the
// eft.18.5 wire-before-init arrangement, dropping the old placeholder-
// specific regression case entirely (it tested a value that no longer
// exists in the documented flow at all).
//
// Hermetic: every "remote" here is a local file:// / plain-path git repo
// created fresh under os.tmpdir(); nothing ever touches the network or the
// real fleet-e2e-toy repo.
//
// See tests/check-sandbox-sync-remote-integ.test.ts (apra-fleet-eft.18.7's
// retarget of apra-fleet-eft.39.2) for the sibling suite covering the four
// check-sandbox-sync-remote.mjs checks end-to-end against this same
// wire-before-init arrangement, and its file-level comment for why a small
// harness module (not a direct 'node scripts/...' invocation) is used to
// drive the script's exports -- the script's own main() entry guard is
// unreachable on Windows.

const SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'check-sandbox-sync-remote.mjs',
);

const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sync-remote-fetch-harness-'));
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
    '// checks, same message format, same exit-code rule, including the',
    '// apra-fleet-eft.18.6 sandboxPath argument and the apra-fleet-eft.18.8',
    '// downgrade of the outbound-commits check to informational-only (it is',
    '// always non-zero on a real bd init --from-jsonl run -- see that check\'s',
    '// own docstring in the real script).',
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
    'if (!syncCheck.ok || !doltRemoteCheck.ok || !gitOriginCheck.ok) {',
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

function runCheckScript(repoPath: string, sandboxPath?: string): { status: number; stdout: string; stderr: string } {
  const args = sandboxPath ? [harnessPath, repoPath, sandboxPath] : [harnessPath, repoPath];
  const res = spawnSync(process.execPath, args, { encoding: 'utf-8' });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

describe('eft.18.5 wire-before-init Setup: sandbox git origin is fetchable-yet-isolated (apra-fleet-eft.18.7 retarget of apra-fleet-eft.47.2)', () => {
  let outerDir: string; // scratch root for this test only
  let sandboxRoot: string; // stand-in for "$HOME" -- outerDir/home
  let realOriginDir: string; // local stand-in for the real fleet-e2e-toy remote, OUTSIDE sandboxRoot
  let toyRepo: string; // the "$HOME/toy-repo" sandbox clone
  let gitMirror: string; // the "$HOME/.apra-fleet-toy-origin.git" bare mirror

  beforeEach(() => {
    outerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-eft47-sandbox-'));
    sandboxRoot = path.join(outerDir, 'home');
    fs.mkdirSync(sandboxRoot, { recursive: true });

    // A local bare repo whose path itself contains the hazard identity
    // ("fleet-e2e-toy"), standing in for the real
    // https://github.com/Apra-Labs/fleet-e2e-toy remote that '## Setup'
    // clones from. Deliberately placed OUTSIDE sandboxRoot, same as the
    // real remote is never under $HOME.
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

    // '## Setup': `git clone https://github.com/Apra-Labs/fleet-e2e-toy "$HOME/toy-repo"`
    toyRepo = path.join(sandboxRoot, 'toy-repo');
    git(sandboxRoot, ['clone', realOriginDir, toyRepo]);
    git(toyRepo, ['config', 'user.email', 'test@example.com']);
    git(toyRepo, ['config', 'user.name', 'Test']);

    gitMirror = path.join(sandboxRoot, '.apra-fleet-toy-origin.git');
  });

  afterEach(() => {
    fs.rmSync(outerDir, { recursive: true, force: true });
  });

  /**
   * Applies integ-test-playbook.md's '## Setup' > "Seed the sandbox beads DB
   * (structural isolation, no bootstrap, no neutralize)" steps VERBATIM
   * (the git mirror clone + remote set-url, plus a hand-written config.yaml
   * standing in for what `bd init --from-jsonl --remote "file://$DOLT_
   * REMOTE"` would persist -- this suite has no real `bd`/Dolt dependency,
   * same as its sibling apra-fleet-eft.18.7 suite):
   *   GIT_MIRROR="$HOME/.apra-fleet-toy-origin.git"
   *   git clone --bare "$TOY_REPO" "$GIT_MIRROR"
   *   git -C "$TOY_REPO" remote set-url origin "file://$GIT_MIRROR"
   *   DOLT_REMOTE="$HOME/.apra-fleet-toy-dolt-remote"
   *   # bd init --from-jsonl --prefix gh-toy --remote "file://$DOLT_REMOTE" --non-interactive
   */
  function applyDocumentedWireBeforeInit(repoPath: string, sandboxPath: string): void {
    git(sandboxPath, ['clone', '--bare', repoPath, gitMirror]);
    git(repoPath, ['remote', 'set-url', 'origin', `file://${gitMirror}`]);

    const doltRemote = path.join(sandboxPath, '.apra-fleet-toy-dolt-remote');
    fs.mkdirSync(path.join(repoPath, '.beads'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, '.beads', 'config.yaml'), `sync:\n  remote: "file://${doltRemote}"\n`, 'utf-8');
  }

  it('is fetchable AND isolated: all four checks OK, git fetch origin main exits 0, and origin never resolves to the real remote', () => {
    applyDocumentedWireBeforeInit(toyRepo, sandboxRoot);

    // Assertion (1): check-sandbox-sync-remote.mjs exits 0 with all 4
    // checks OK.
    const { status: checkStatus, stdout } = runCheckScript(toyRepo, sandboxRoot);
    expect(checkStatus).toBe(0);
    expect(stdout).toContain('OK: active sync.remote');
    expect(stdout).toContain('OK: sandbox clone at');
    expect(stdout).toMatch(/OK:.*(remote list|remote\(s\)|unavailable)/); // Dolt-level check, vacuously OK -- no real beads DB in this scratch fixture
    expect(stdout).toContain("OK: git 'origin' remote");
    expect(stdout).toContain('OK: sandbox is isolated from the real fleet-e2e-toy Dolt remote.');

    // Assertion (2): 'git fetch origin main' against the sandbox-local
    // mirror exits 0 -- the sprint engine's own Ensure-Sprint-Branch fetch
    // (and this playbook's own '## Reset' step) can run.
    const fetchResult = spawnSync('git', ['fetch', 'origin', 'main'], {
      cwd: toyRepo,
      encoding: 'utf-8',
    });
    expect(fetchResult.status).toBe(0);

    // Assertion (3): the sandbox-local mirror URL does NOT resolve to the
    // real remote -- still isolated, no push/fetch can reach real GitHub.
    const originUrl = git(toyRepo, ['remote', 'get-url', 'origin']).trim();
    expect(originUrl).not.toContain('github.com/Apra-Labs/fleet-e2e-toy');
    expect(originUrl).not.toBe('https://github.com/Apra-Labs/fleet-e2e-toy');
    expect(originUrl).toBe(`file://${gitMirror}`);
  });

  it('mutation: if origin is left pointed at the real remote (wire-before-init step skipped), the guard fails closed and git fetch would reach the real remote', () => {
    // Deliberately skip the git-origin re-wire (the eft.18.5 structural
    // fix): origin is still whatever the initial clone left it as -- the
    // local stand-in for the real fleet-e2e-toy remote. Only the Dolt-level
    // sync.remote is wired sandbox-local, isolating this case to the
    // git-origin gap specifically.
    const doltRemote = path.join(sandboxRoot, '.apra-fleet-toy-dolt-remote');
    fs.mkdirSync(path.join(toyRepo, '.beads'), { recursive: true });
    fs.writeFileSync(path.join(toyRepo, '.beads', 'config.yaml'), `sync:\n  remote: "file://${doltRemote}"\n`, 'utf-8');

    const { status, stdout } = runCheckScript(toyRepo, sandboxRoot);
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/FAIL: git 'origin' remote in .* fleet-e2e-toy/);

    // The guard's FAIL is the only thing standing between this state and a
    // real fetch reaching the (stand-in) hazard remote -- confirm the
    // hazard is real, not just theoretical, in this fixture.
    const originUrl = git(toyRepo, ['remote', 'get-url', 'origin']).trim();
    expect(originUrl).toContain('fleet-e2e-toy');
  });
});
