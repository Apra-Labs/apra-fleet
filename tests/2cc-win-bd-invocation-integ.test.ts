import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { execBdSync } from '../scripts/lib/exec-bd.mjs';

// apra-fleet-2cc.3: integration coverage for apra-fleet-2cc's Windows fix
// streak (2cc.1: shell-safe bd invocation via scripts/lib/exec-bd.mjs; 2cc.2:
// check-toy-doer-credentials.mjs's pathToFileURL entrypoint guard). Unlike
// tests/exec-bd.test.ts and tests/check-toy-doer-credentials.test.ts (which
// exercise the exported functions in-process), every assertion below drives
// the REAL artifacts end to end -- a real 'bd --version' invocation, a real
// scratch sandbox seeded via a real spawned sandbox-seed-beads.mjs, and
// check-toy-doer-credentials.mjs spawned as an actual child process -- and
// asserts on PROCESS EXIT CODES, not just stdout text, per the bead's
// acceptance criteria. ASCII only.

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const SANDBOX_SEED_SCRIPT = path.join(SCRIPTS_DIR, 'sandbox-seed-beads.mjs');
const CHECK_TOY_DOER_CREDS_SCRIPT = path.join(SCRIPTS_DIR, 'check-toy-doer-credentials.mjs');

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    // Best-effort cleanup: the embedded Dolt engine sandbox-seed-beads.mjs
    // drives can hold a brief file lock on Windows even after its
    // synchronous child process has returned (observed EBUSY/ENOTEMPTY on an
    // immediate rmSync, surviving fs.rmSync's own maxRetries/retryDelay
    // budget too -- the same pre-existing Windows temp-dir-cleanup-race class
    // as e.g. k7b7-exit-detail-integration.test.mjs's ENOTEMPTY flake). A
    // leftover directory under os.tmpdir() is OS-reclaimed eventually and is
    // not itself evidence of a test failure, so cleanup failure here must
    // never fail the test or mask its (already-evaluated) assertions.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[2cc-win-bd-invocation-integ] best-effort cleanup left '${dir}' behind: ${(err as Error).message}`);
    }
  }
});

describe('the shared bd-invocation helper (scripts/lib/exec-bd.mjs) on the host platform', () => {
  // apra-fleet-2cc.1's actual root-cause fix: execFileSync('bd', ...) without
  // shell:true throws 'spawnSync bd ENOENT' on win32 because Windows'
  // CreateProcess cannot exec the npm-installed bd.cmd shim directly.
  // execBdSync must never surface that specific failure mode on Windows.
  // Skipped (with reason, not silently) on non-Windows CI, since the
  // regression this pins is Windows-specific by construction.
  it.skipIf(process.platform !== 'win32')(
    'on win32: execBdSync does not throw ENOENT (skipped on non-Windows platforms, where this regression cannot reproduce)',
    () => {
      let threw: unknown = null;
      let out = '';
      try {
        out = String(execBdSync(['--version'], { encoding: 'utf-8' }));
      } catch (err) {
        threw = err;
      }
      expect(threw).toBeNull();
      expect((threw as { code?: string } | null)?.code).not.toBe('ENOENT');
      expect(out).toMatch(/bd version/);
    },
  );
});

describe('scripts/sandbox-seed-beads.mjs reaches completion of its bd steps against a real scratch sandbox', () => {
  /**
   * Builds a minimal but REAL toy-repo fixture standing in for a checked-out
   * fleet-e2e-toy clone: a real bd-initialized git repo with one seeded
   * issue exported to the default .beads/issues.jsonl import path, matching
   * what a real toy-repo clone commits (config.yaml + issues.jsonl; the
   * live embeddeddolt state is regenerated fresh by --from-jsonl, so it is
   * removed here too -- mirroring sandbox-seed-beads.mjs's own first two
   * rmSync calls, which assume exactly this shape on entry).
   */
  function buildToyRepoFixture(toyRepo: string, prefix: string): void {
    fs.mkdirSync(toyRepo, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: toyRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: toyRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: toyRepo, stdio: 'ignore' });

    execBdSync(['init', '--prefix', prefix, '--non-interactive'], { cwd: toyRepo, stdio: 'ignore' });
    execBdSync(['create', 'scratch fixture seed issue', '--priority=2'], { cwd: toyRepo, stdio: 'ignore' });
    execBdSync(['export', '-o', '.beads/issues.jsonl'], { cwd: toyRepo, stdio: 'ignore' });

    // Simulate the git-committed subset of a real toy-repo clone (config.yaml
    // + issues.jsonl), stripping the live local Dolt state the real seed
    // script's own first two rmSync calls expect to remove.
    fs.rmSync(path.join(toyRepo, '.beads', 'embeddeddolt'), { recursive: true, force: true });
    fs.rmSync(path.join(toyRepo, '.beads', '.local_version'), { force: true });

    execFileSync('git', ['add', '-A'], { cwd: toyRepo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'scratch fixture seed'], { cwd: toyRepo, stdio: 'ignore' });
  }

  it(
    'a real spawned sandbox-seed-beads.mjs run seeds the toy repo and pushes to the sandbox-local Dolt remote (exit 0)',
    () => {
      const prefix = 'cc3scratch';
      const sandboxRoot = mkTmp('apra-fleet-2cc3-sandbox-');
      const toyRepo = path.join(sandboxRoot, 'toy-repo');
      buildToyRepoFixture(toyRepo, prefix);

      const res = spawnSync(
        process.execPath,
        [SANDBOX_SEED_SCRIPT, '--sandbox-root', sandboxRoot, '--toy-repo', toyRepo, '--prefix', prefix],
        { encoding: 'utf-8' },
      );

      expect(res.status, `stdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(0);
      expect(res.stdout).toContain('[sandbox-seed] OK');

      // The bd steps genuinely completed, not just "exited 0 with no-ops":
      // a fresh local Dolt DB was initialized (embeddeddolt regenerated) and
      // the seeded issue survived the --from-jsonl import.
      expect(fs.existsSync(path.join(toyRepo, '.beads', 'embeddeddolt'))).toBe(true);
      const listed = execBdSync(['list', '--json', '--limit', '0'], { cwd: toyRepo, encoding: 'utf-8' });
      expect(String(listed)).toContain('scratch fixture seed issue');

      // 'bd dolt push' genuinely reached the sandbox-local Dolt remote (a
      // real Dolt storage directory now has real content), not a silent
      // no-op -- the exact hazard this whole streak (apra-fleet-2cc) guards
      // sandbox-seed-beads.mjs against.
      const doltRemoteDir = path.join(sandboxRoot, '.apra-fleet-toy-dolt-remote');
      expect(fs.existsSync(doltRemoteDir)).toBe(true);
      expect(fs.readdirSync(doltRemoteDir).length).toBeGreaterThan(0);
    },
    120000,
  );
});

describe('scripts/check-toy-doer-credentials.mjs, spawned as a real child process, proves main() actually ran', () => {
  function encryptForFixture(plaintext: string, key: Buffer): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  function runScript(memberName: string, fleetHome: string): { status: number; stdout: string; stderr: string } {
    const res = spawnSync(process.execPath, [CHECK_TOY_DOER_CREDS_SCRIPT, memberName, fleetHome], {
      encoding: 'utf-8',
      env: { ...process.env, APRA_FLEET_DATA_DIR: path.join(fleetHome, '.apra-fleet', 'data') },
    });
    return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
  }

  it('exits non-zero for a member whose encryptedEnvVars.CLAUDE_CODE_OAUTH_TOKEN decrypts to a JSON blob (the apra-fleet-vak regression)', () => {
    const fleetHome = mkTmp('apra-fleet-2cc3-creds-badblob-');
    const dataDir = path.join(fleetHome, '.apra-fleet', 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const key = crypto.randomBytes(32);
    fs.writeFileSync(path.join(dataDir, 'salt'), key.toString('hex'));

    const ciphertext = encryptForFixture(
      JSON.stringify({ accessToken: 'sk-leaked', expiresAt: 1999999999999 }),
      key,
    );
    fs.writeFileSync(
      path.join(dataDir, 'registry.json'),
      JSON.stringify({
        version: '1.0',
        agents: [{ friendlyName: 'toy-doer', encryptedEnvVars: { CLAUDE_CODE_OAUTH_TOKEN: ciphertext } }],
      }),
    );

    const { status, stdout, stderr } = runScript('toy-doer', fleetHome);

    // main() genuinely ran (proving the pathToFileURL entrypoint guard
    // fires): before apra-fleet-2cc.2, the old `file://${argv[1]}` guard
    // never matched on Windows, main() silently never ran, and the process
    // ALWAYS exited 0 regardless of provisioning state -- this assertion is
    // exactly what would have stayed green (falsely) under that bug.
    expect(status).not.toBe(0);
    expect(stdout + stderr).toMatch(/JSON-shaped blob/);
  });

  it('exits zero for a healthy member (a valid clean-env credentials file with a sufficient session shape)', () => {
    const fleetHome = mkTmp('apra-fleet-2cc3-creds-healthy-');
    fs.mkdirSync(path.join(fleetHome, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(fleetHome, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-healthy-probe', expiresAt: 1999999999999 } }),
    );

    const { status, stdout, stderr } = runScript('toy-doer', fleetHome);

    expect(status, `stdout: ${stdout}\nstderr: ${stderr}`).toBe(0);
    expect(stdout).toMatch(/OK: member 'toy-doer' credential is provisioned/);
  });
});
