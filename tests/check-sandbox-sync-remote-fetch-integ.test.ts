import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

// apra-fleet-eft.47.2: end-to-end coverage for the eft.47 fix -- the
// neutralized sandbox git origin (a fetchable local bare clone, per eft.47.1)
// must be BOTH fetchable (so the sprint engine's own 'git fetch origin main'
// in Ensure Sprint Branch, and this playbook's own '## Reset' step, keep
// working) AND still fully isolated from the real
// https://github.com/Apra-Labs/fleet-e2e-toy remote.
//
// This drives the REAL exported checks from
// scripts/check-sandbox-sync-remote.mjs, as a subprocess, against a scratch
// git arrangement that mimics integ-test-playbook.md's '## Setup' section,
// then applies that section's documented "Neutralize sandbox sync.remote"
// steps VERBATIM -- including the eft.47.1 git-origin step, which now points
// origin at a second, throwaway local BARE clone of the sandbox toy-repo's
// own content rather than the old, unfetchable
// 'file:///dev/null/neutralized-sandbox-origin' placeholder.
//
// Hermetic: every "remote" here is a local file:// / plain-path git repo
// created fresh under os.tmpdir(); nothing ever touches the network or the
// real fleet-e2e-toy repo.
//
// See tests/check-sandbox-sync-remote-integ.test.ts (apra-fleet-eft.39.2) for
// the sibling suite covering the four check-sandbox-sync-remote.mjs checks in
// isolation, and its file-level comment for why a small harness module (not
// a direct 'node scripts/...' invocation) is used to drive the script's
// exports -- the script's own main() entry guard is unreachable on Windows.

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
    `} from ${JSON.stringify(pathToFileURL(SCRIPT_PATH).href)};`,
    '',
    '// Verbatim reproduction of check-sandbox-sync-remote.mjs main() -- same',
    "// checks, same message format, same exit-code rule.",
    'const repoPath = process.argv[2];',
    "const configPath = path.join(repoPath, '.beads', 'config.yaml');",
    'const syncCheck = checkSyncRemoteInert(configPath);',
    "console.log(`[check-sandbox-sync-remote] ${syncCheck.message}`);",
    '',
    'const outboundCheck = checkNoOutboundCommits(repoPath);',
    "console.log(`[check-sandbox-sync-remote] ${outboundCheck.message}`);",
    '',
    'const doltRemoteCheck = checkDoltRemoteAbsent(repoPath);',
    "console.log(`[check-sandbox-sync-remote] ${doltRemoteCheck.message}`);",
    '',
    'const gitOriginCheck = checkGitOriginNotHazard(repoPath);',
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

function runCheckScript(repoPath: string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [harnessPath, repoPath], { encoding: 'utf-8' });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

describe('eft.47 end-to-end: neutralized sandbox origin is fetchable-yet-isolated (apra-fleet-eft.47.2)', () => {
  let tmpDir: string;
  let realOriginDir: string; // local stand-in for the real fleet-e2e-toy remote
  let toyRepo: string; // the "$HOME/toy-repo" sandbox clone
  let neutralOrigin: string; // the "$HOME/.apra-fleet-neutralized-origin.git" bare clone

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-eft47-sandbox-'));

    // A local bare repo whose path itself contains the hazard identity
    // ("fleet-e2e-toy"), standing in for the real
    // https://github.com/Apra-Labs/fleet-e2e-toy remote that '## Setup'
    // clones from.
    realOriginDir = path.join(tmpDir, 'fleet-e2e-toy.git');
    fs.mkdirSync(realOriginDir);
    git(realOriginDir, ['init', '--bare', '-b', 'main']);

    const seedDir = path.join(tmpDir, 'seed');
    fs.mkdirSync(seedDir);
    git(seedDir, ['init', '-b', 'main']);
    git(seedDir, ['config', 'user.email', 'test@example.com']);
    git(seedDir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(seedDir, 'README.md'), 'toy repo\n', 'utf-8');
    git(seedDir, ['add', 'README.md']);
    git(seedDir, ['commit', '-m', 'seed commit']);
    git(seedDir, ['push', realOriginDir, 'main']);

    // '## Setup': `git clone https://github.com/Apra-Labs/fleet-e2e-toy "$HOME/toy-repo"`
    toyRepo = path.join(tmpDir, 'toy-repo');
    git(tmpDir, ['clone', realOriginDir, toyRepo]);
    git(toyRepo, ['config', 'user.email', 'test@example.com']);
    git(toyRepo, ['config', 'user.name', 'Test']);

    // The post-`bd bootstrap --yes` config.yaml shape.
    fs.mkdirSync(path.join(toyRepo, '.beads'), { recursive: true });
    fs.writeFileSync(
      path.join(toyRepo, '.beads', 'config.yaml'),
      'sync:\n  remote: "git+https://github.com/Apra-Labs/fleet-e2e-toy"\n# sync.remote disabled -- no Dolt push for this toy project\n',
      'utf-8',
    );

    neutralOrigin = path.join(tmpDir, '.apra-fleet-neutralized-origin.git');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Applies integ-test-playbook.md's '## Setup' > 'Neutralize sandbox
   * sync.remote' steps VERBATIM, including the eft.47.1 git-origin step:
   *   NEUTRAL_ORIGIN="$HOME/.apra-fleet-neutralized-origin.git"
   *   rm -rf "$NEUTRAL_ORIGIN"
   *   git clone --bare "$TOY_REPO" "$NEUTRAL_ORIGIN"
   *   (cd "$TOY_REPO" && git remote set-url origin "file://$NEUTRAL_ORIGIN") || true
   */
  function applyDocumentedNeutralize(repoPath: string): void {
    // Step 1 (sync.remote YAML, eft.25.1):
    const configPath = path.join(repoPath, '.beads', 'config.yaml');
    execFileSync('sed', ['-i.bak', '-E', '/fleet-e2e-toy/{/^[[:space:]]*#/!s/^/# /;}', configPath]);
    fs.rmSync(`${configPath}.bak`, { force: true });

    // Step 2 (Dolt-level remote, eft.30.1) is skipped here -- requires a
    // real `bd` binary/beads DB; checkDoltRemoteAbsent() treats a missing
    // `bd` command as vacuously OK either way.

    // Step 3 (git origin, eft.47.1 remedy for eft.47): point origin at a
    // fresh local bare clone of the toy repo's own content instead of the
    // old unfetchable file:///dev/null/... placeholder.
    fs.rmSync(neutralOrigin, { recursive: true, force: true });
    git(tmpDir, ['clone', '--bare', repoPath, neutralOrigin]);
    try {
      git(repoPath, ['remote', 'set-url', 'origin', `file://${neutralOrigin}`]);
    } catch {
      // Documented as `|| true` -- idempotent no-op when there is no origin.
    }
  }

  it('is fetchable AND isolated: all four checks OK, git fetch origin main exits 0, and origin never resolves to the real remote', () => {
    applyDocumentedNeutralize(toyRepo);

    // Assertion (1): check-sandbox-sync-remote.mjs exits 0 with all 4
    // checks OK.
    const { status: checkStatus, stdout } = runCheckScript(toyRepo);
    expect(checkStatus).toBe(0);
    expect(stdout).toContain('OK: sync.remote');
    expect(stdout).toContain('OK: sandbox clone at');
    expect(stdout).toMatch(/OK:.*(remote list|remote\(s\)|unavailable)/); // Dolt-level check, vacuously OK -- no bd binary
    expect(stdout).toContain("OK: git 'origin' remote");
    expect(stdout).toContain('OK: sandbox is isolated from the real fleet-e2e-toy Dolt remote.');

    // Assertion (2): 'git fetch origin main' against the neutralized origin
    // exits 0 -- the sprint engine's own Ensure-Sprint-Branch fetch (and
    // this playbook's own '## Reset' step) can run.
    const fetchResult = spawnSync('git', ['fetch', 'origin', 'main'], {
      cwd: toyRepo,
      encoding: 'utf-8',
    });
    expect(fetchResult.status).toBe(0);

    // Assertion (3): the neutralized origin URL does NOT resolve to the
    // real remote -- still isolated, no push/fetch can reach real GitHub.
    const originUrl = git(toyRepo, ['remote', 'get-url', 'origin']).trim();
    expect(originUrl).not.toContain('github.com/Apra-Labs/fleet-e2e-toy');
    expect(originUrl).not.toBe('https://github.com/Apra-Labs/fleet-e2e-toy');
    expect(originUrl).toBe(`file://${neutralOrigin}`);
  });

  it('regression guard: the OLD file:///dev/null/... placeholder would have failed the fetchability assertion', () => {
    // Sanity-checks that this suite's fetch assertion actually discriminates
    // the eft.47 bug from its fix: applying only the eft.25.1/eft.30.1 steps
    // plus the OLD (pre-eft.47.1) git-origin neutralize value reproduces the
    // original 'git fetch origin main' exit-128 failure.
    const configPath = path.join(toyRepo, '.beads', 'config.yaml');
    execFileSync('sed', ['-i.bak', '-E', '/fleet-e2e-toy/{/^[[:space:]]*#/!s/^/# /;}', configPath]);
    fs.rmSync(`${configPath}.bak`, { force: true });
    git(toyRepo, ['remote', 'set-url', 'origin', 'file:///dev/null/neutralized-sandbox-origin']);

    const fetchResult = spawnSync('git', ['fetch', 'origin', 'main'], {
      cwd: toyRepo,
      encoding: 'utf-8',
    });
    expect(fetchResult.status).not.toBe(0);
  });
});
