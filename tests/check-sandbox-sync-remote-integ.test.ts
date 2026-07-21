import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

// apra-fleet-eft.39.2: end-to-end coverage for scripts/check-sandbox-sync-remote.mjs
// -- runs the script's REAL exported checks, as a real subprocess (not just
// unit-testing the functions in-process, which tests/check-sandbox-sync-remote.test.ts
// already covers), against a scratch git repo arrangement that mimics
// integ-test-playbook.md's `## Setup` section, then applies that same
// section's documented "Neutralize sandbox sync.remote" steps VERBATIM
// (same git/sed commands), per apra-fleet-eft.39.1 (commit 08c9fad) which
// added the third (git-origin) neutralize step.
//
// Hermetic: every "remote" here is a local file:// / plain-path git repo
// created fresh under os.tmpdir(); nothing ever touches the network or the
// real fleet-e2e-toy repo. The playbook's Dolt-level neutralize step ("bd
// dolt remote remove") is NOT run here -- it requires a real `bd` binary
// and a materialized beads DB, neither of which this suite stands up. That
// is fine for hermeticity: check-sandbox-sync-remote.mjs's own
// checkDoltRemoteAbsent() treats an unavailable `bd` command as vacuously
// OK (see scripts/check-sandbox-sync-remote.mjs), so check 3 always reports
// OK in this suite regardless of whether the Dolt-level step ran -- only
// checks 1 (sync.remote YAML), 2 (no outbound commits) and 4 (git origin)
// are actually exercised by the Setup/Neutralize arrangement built below.
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
// main()'s own console.log/exit-code logic verbatim. The harness has no
// "is this the entrypoint" guard of its own to trip over -- it IS the
// entrypoint, always -- so it exercises the identical check logic on every
// platform.

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
    `} from ${JSON.stringify(pathToFileURL(SCRIPT_PATH).href)};`,
    '',
    '// Verbatim reproduction of check-sandbox-sync-remote.mjs main() -- same',
    "// checks, same message format, same exit-code rule. Exists only because",
    '// that main() is unreachable on Windows (see the test file header',
    '// comment) via its own broken argv[1]-vs-import.meta.url entry guard.',
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

/**
 * Runs the harness (which imports and drives the real, exported check
 * functions from scripts/check-sandbox-sync-remote.mjs) as a subprocess
 * against `repoPath`, reproducing what integ-test-playbook.md's `## Setup`
 * documents:
 *   node scripts/check-sandbox-sync-remote.mjs "$HOME/toy-repo"
 */
function runScript(repoPath: string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [harnessPath, repoPath], { encoding: 'utf-8' });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

describe('check-sandbox-sync-remote.mjs (subprocess) -- all four checks after documented Setup+Neutralize (apra-fleet-eft.39.2)', () => {
  let tmpDir: string;
  let realOriginDir: string; // local stand-in for the real fleet-e2e-toy remote
  let toyRepo: string; // the "$HOME/toy-repo" sandbox clone

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sandbox-setup-'));

    // A local bare repo whose path itself contains the hazard identity
    // ("fleet-e2e-toy"), standing in for the real
    // https://github.com/Apra-Labs/fleet-e2e-toy remote that `## Setup`
    // clones from. check-sandbox-sync-remote.mjs's HAZARD_REMOTE check is a
    // substring match, so a local path containing that substring exercises
    // the same detection logic without any network access.
    realOriginDir = path.join(tmpDir, 'fleet-e2e-toy.git');
    fs.mkdirSync(realOriginDir);
    git(realOriginDir, ['init', '--bare', '-b', 'main']);

    // Seed the "real" origin with one commit so the clone below has a
    // resolvable origin/main to diff against (checkNoOutboundCommits).
    const seedDir = path.join(tmpDir, 'seed');
    fs.mkdirSync(seedDir);
    git(seedDir, ['init', '-b', 'main']);
    git(seedDir, ['config', 'user.email', 'test@example.com']);
    git(seedDir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(seedDir, 'README.md'), 'toy repo\n', 'utf-8');
    git(seedDir, ['add', 'README.md']);
    git(seedDir, ['commit', '-m', 'seed commit']);
    git(seedDir, ['push', realOriginDir, 'main']);

    // `## Setup`: `git clone https://github.com/Apra-Labs/fleet-e2e-toy "$HOME/toy-repo"`
    toyRepo = path.join(tmpDir, 'toy-repo');
    git(tmpDir, ['clone', realOriginDir, toyRepo]);
    git(toyRepo, ['config', 'user.email', 'test@example.com']);
    git(toyRepo, ['config', 'user.name', 'Test']);

    // The post-`bd bootstrap --yes` config.yaml shape from `## Setup`'s
    // "Neutralize sandbox sync.remote" section: a fresh ACTIVE sync.remote
    // block pointing at the hazard remote, with the pristine disabled line
    // left stale below it.
    fs.mkdirSync(path.join(toyRepo, '.beads'), { recursive: true });
    fs.writeFileSync(
      path.join(toyRepo, '.beads', 'config.yaml'),
      'sync:\n  remote: "git+https://github.com/Apra-Labs/fleet-e2e-toy"\n# sync.remote disabled -- no Dolt push for this toy project\n',
      'utf-8',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Applies integ-test-playbook.md's "## Setup" neutralize steps VERBATIM (the sed + git remote set-url commands). */
  function applyDocumentedNeutralize(repoPath: string): void {
    // Step 1 (sync.remote YAML, eft.25.1):
    //   sed -i.bak -E '/fleet-e2e-toy/{/^[[:space:]]*#/!s/^/# /;}' "$CONFIG"
    const configPath = path.join(repoPath, '.beads', 'config.yaml');
    execFileSync('sed', ['-i.bak', '-E', '/fleet-e2e-toy/{/^[[:space:]]*#/!s/^/# /;}', configPath]);
    fs.rmSync(`${configPath}.bak`, { force: true });

    // Step 2 (Dolt-level remote, eft.30.1) is skipped here -- requires a
    // real `bd` binary/beads DB. See the file-level comment above for why
    // that is hermetically safe to omit: checkDoltRemoteAbsent() treats a
    // missing `bd` command as vacuously OK either way.

    // Step 3 (git origin, eft.31):
    //   git remote set-url origin "file:///dev/null/neutralized-sandbox-origin"
    try {
      git(repoPath, ['remote', 'set-url', 'origin', 'file:///dev/null/neutralized-sandbox-origin']);
    } catch {
      // Documented as `|| true` -- idempotent no-op when there is no origin.
    }
  }

  it('PASSES (exit 0, all four checks OK) after the documented Setup+Neutralize steps run', () => {
    applyDocumentedNeutralize(toyRepo);

    const { status, stdout, stderr } = runScript(toyRepo);

    expect(status).toBe(0);
    expect(stdout).toContain('OK: sync.remote');
    expect(stdout).toContain('OK: sandbox clone at');
    expect(stdout).toMatch(/OK:.*(remote list|remote\(s\)|unavailable)/); // check 3 (Dolt-level, vacuously OK -- no bd binary)
    expect(stdout).toContain("OK: git 'origin' remote");
    expect(stdout).toContain('OK: sandbox is isolated from the real fleet-e2e-toy Dolt remote.');
    expect(stderr).toBe('');
  });

  it('mutation: WITHOUT the git-origin neutralize step, exits nonzero and identifies check 4 (origin still points at the real remote)', () => {
    // Apply only steps 1 (sync.remote YAML) -- deliberately omit step 3
    // (git remote set-url origin ...), so the clone's origin still points
    // at the local stand-in for the real fleet-e2e-toy remote.
    const configPath = path.join(toyRepo, '.beads', 'config.yaml');
    execFileSync('sed', ['-i.bak', '-E', '/fleet-e2e-toy/{/^[[:space:]]*#/!s/^/# /;}', configPath]);
    fs.rmSync(`${configPath}.bak`, { force: true });

    const { status, stdout } = runScript(toyRepo);

    expect(status).not.toBe(0);
    // Check 4's FAIL line names the origin explicitly.
    expect(stdout).toMatch(/FAIL: git 'origin' remote in .* fleet-e2e-toy/);
    // Checks 1 and 2 still pass -- only check 4 (git origin) is broken by
    // this omission, demonstrating the test isolates check 4 specifically.
    expect(stdout).toContain('OK: sync.remote');
    expect(stdout).toContain('OK: sandbox clone at');
    expect(stdout).not.toContain('OK: sandbox is isolated from the real fleet-e2e-toy Dolt remote.');
  });
});
