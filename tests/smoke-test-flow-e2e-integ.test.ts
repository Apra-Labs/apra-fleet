import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

// apra-fleet-eft.18.8: the paired [test] for the rewritten smoke-test flow
// (apra-fleet-eft.18.5's playbook rewrite, apra-fleet-eft.18.6's guard
// retarget, apra-fleet-eft.18.7's test retirement/retarget). Those three
// tasks each verified a narrow slice of the new "wire sandbox-local remotes
// BEFORE any bd command runs, then seed straight from git-tracked JSONL"
// design in isolation -- eft.18.5 by hand-argued doc prose, eft.18.6/eft.18.7
// against hand-built fixtures with no real `bd`/Dolt dependency. This suite
// is the first to drive the REAL documented sequence end-to-end with the
// REAL `bd` CLI (git clone/init/config wiring, `bd init --from-jsonl`,
// `bd dolt push`, and the real `doltPushAfter`/`doltPullBefore` sync
// brackets from auto-sprint/runner.js) against a hermetic, fully local
// fixture standing in for the real https://github.com/Apra-Labs/fleet-e2e-toy
// repo -- never the network, never the real repo.
//
// Skipped entirely when `bd` is not on PATH: root-level `tests/` runs under
// plain `npm test` (`vitest run`), which in CI (.github/workflows/ci.yml)
// executes BEFORE the "Install bd CLI" step that only precedes the
// apra-fleet-se package's own `node --test` suite. Every other assertion in
// this repo that needs a real `bd` binary lives downstream of that install
// step; this suite instead degrades to a clean skip so it never flakes CI's
// earlier `npm test` run on a machine where `bd` genuinely isn't installed
// yet, while still running for real wherever `bd` IS present (this machine,
// and any CI lane that installs `bd` before `npm test`).
//
// apra-fleet-eft.18.8 FINDING (fixed alongside this test, not just
// asserted): running the documented flow for real surfaced that
// scripts/check-sandbox-sync-remote.mjs's check 2 (no outbound git commits
// ahead of origin/main) is UNCONDITIONALLY non-zero after a successful
// `## Setup`, because `bd init --from-jsonl` commits its own scaffolding
// into the sandbox clone after `origin` has already been re-pointed at the
// sandbox-local mirror -- see that script's own file-level comment for the
// full root-cause writeup and why the fix is "downgrade check 2 to
// informational" rather than "push origin in Setup" (the latter breaks
// `## Reset`'s later plain re-init). This suite pins the corrected,
// now-actually-passing guard behavior.
const BD_AVAILABLE = (() => {
  try {
    execFileSync('bd', ['--version'], { encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
})();

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'check-sandbox-sync-remote.mjs');
const RUNNER_PATH = pathToFileURL(
  path.join(REPO_ROOT, 'packages', 'apra-fleet-se', 'auto-sprint', 'runner.js'),
).href;

// The real hazard identity the whole sandbox design exists to keep out of
// reach -- see scripts/check-sandbox-sync-remote.mjs's own HAZARD_REMOTE.
const HAZARD_REMOTE = 'fleet-e2e-toy';
const CANARY_ID = 'gh-toy-4ef';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function bd(cwd: string, args: string[]): string {
  return execFileSync('bd', args, { cwd, encoding: 'utf-8' });
}

// Real, non-mocked command() for auto-sprint/runner.js's doltPushAfter /
// doltPullBefore -- shells the given "bd dolt push"/"bd dolt pull" (etc.)
// string out to the real bd CLI inside `cwd`, matching the shape those
// functions expect from their injected command() (see runDoltStep in
// runner.js): `{ ok, output, error }`.
function makeRealCommand(cwd: string) {
  return async (cmd: string) => {
    const [bin, ...args] = cmd.split(' ');
    try {
      const output = execFileSync(bin, args, { cwd, encoding: 'utf-8' });
      return { ok: true, output, error: null };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      const output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      return { ok: false, output, error: output || e.message };
    }
  };
}

describe.skipIf(!BD_AVAILABLE)(
  'integ-test-playbook.md hybrid e2e smoke-test flow: JSONL seed + hardcoded canary + throwaway file:// remote (apra-fleet-eft.18.8)',
  () => {
    let outerDir: string; // scratch root for the whole run
    let sandboxRoot: string; // stand-in for "$HOME"
    let realOriginDir: string; // local stand-in for the real fleet-e2e-toy remote, OUTSIDE the sandbox
    let toyRepo: string; // "$HOME/toy-repo"
    let gitMirror: string; // "$HOME/.apra-fleet-toy-origin.git"
    let doltRemote: string; // "$HOME/.apra-fleet-toy-dolt-remote"

    // Snapshots of every place the real hazard identity could leak into,
    // taken at multiple points across the flow (Setup, guard, D-push/D-pull,
    // post-close) -- the SAFETY INVARIANT bullet checks all of them at once.
    const hazardSnapshots: Record<string, string> = {};

    let canaryBeforeClose: { status: string; labels: string[] }[];
    let guardResult: { status: number; stdout: string; stderr: string };
    let pushResult: unknown;
    let pullResult: unknown;
    let doltLogs: string[];
    let canaryAfterClose: { status: string; labels: string[] }[];

    beforeAll(async () => {
      outerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-smoke-e2e-'));
      sandboxRoot = path.join(outerDir, 'home');
      fs.mkdirSync(sandboxRoot, { recursive: true });

      // A local bare repo standing in for the real
      // https://github.com/Apra-Labs/fleet-e2e-toy remote -- its path
      // literally contains the hazard identity, mirroring how apra-fleet-
      // eft.18.7's suites already exercise check-sandbox-sync-remote.mjs's
      // substring-based hazard detection without any network access.
      // Deliberately OUTSIDE sandboxRoot, same as the real remote is never
      // under $HOME.
      realOriginDir = path.join(outerDir, `${HAZARD_REMOTE}.git`);
      fs.mkdirSync(realOriginDir, { recursive: true });
      git(realOriginDir, ['init', '--bare', '-b', 'main']);

      // Fixture "real toy repo" content: a minimal repo with the
      // git-committed .beads/issues.jsonl containing exactly the hardcoded
      // canary (apra-fleet-eft.18.5's Test scenario step 2), the same
      // fixed-canary technique the actual fleet-e2e-toy repo uses.
      const seedDir = path.join(outerDir, 'seed');
      fs.mkdirSync(seedDir, { recursive: true });
      git(seedDir, ['init', '-b', 'main']);
      git(seedDir, ['config', 'user.email', 'test@example.com']);
      git(seedDir, ['config', 'user.name', 'Test']);
      fs.mkdirSync(path.join(seedDir, '.beads'), { recursive: true });
      fs.writeFileSync(
        path.join(seedDir, '.beads', 'issues.jsonl'),
        `${JSON.stringify({
          id: CANARY_ID,
          title: 'Add a --version flag to the CLI',
          status: 'open',
          labels: ['integ-canary'],
          issue_type: 'task',
          priority: 1,
        })}\n`,
        'utf-8',
      );
      fs.writeFileSync(path.join(seedDir, 'README.md'), 'toy repo\n', 'utf-8');
      git(seedDir, ['add', '-A']);
      git(seedDir, ['commit', '-m', 'seed']);
      git(seedDir, ['push', realOriginDir, 'main']);

      // ---- `## Setup`: "git clone https://github.com/Apra-Labs/fleet-e2e-toy $HOME/toy-repo" ----
      toyRepo = path.join(sandboxRoot, 'toy-repo');
      git(sandboxRoot, ['clone', realOriginDir, toyRepo]);
      git(toyRepo, ['config', 'user.email', 'test@example.com']);
      git(toyRepo, ['config', 'user.name', 'Test']);

      // ---- `## Setup` > "Seed the sandbox beads DB (structural isolation, no bootstrap, no neutralize)" ----
      // Wire BOTH sandbox-local remotes BEFORE any bd command ever runs --
      // ZERO bd bootstrap, ZERO neutralize steps, exactly as documented.
      gitMirror = path.join(sandboxRoot, '.apra-fleet-toy-origin.git');
      git(sandboxRoot, ['clone', '--bare', toyRepo, gitMirror]);
      git(toyRepo, ['remote', 'set-url', 'origin', `file://${gitMirror}`]);

      doltRemote = path.join(sandboxRoot, '.apra-fleet-toy-dolt-remote');
      bd(toyRepo, ['init', '--from-jsonl', '--prefix', 'gh-toy', '--remote', `file://${doltRemote}`, '--non-interactive']);
      bd(toyRepo, ['dolt', 'push']);

      hazardSnapshots['config.yaml after Setup'] = fs.readFileSync(
        path.join(toyRepo, '.beads', 'config.yaml'),
        'utf-8',
      );
      hazardSnapshots['git config after Setup'] = fs.readFileSync(path.join(toyRepo, '.git', 'config'), 'utf-8');
      hazardSnapshots['bd dolt remote list after Setup'] = bd(toyRepo, ['dolt', 'remote', 'list', '--json']);

      // ---- Test scenario step 2: hardcoded canary lookup, from the JSONL seed alone ----
      canaryBeforeClose = JSON.parse(bd(toyRepo, ['show', CANARY_ID, '--json']));

      // ---- `## Setup`'s pre-sprint guard ----
      guardResult = runGuard(toyRepo, sandboxRoot);
      hazardSnapshots['check-sandbox-sync-remote.mjs stdout'] = guardResult.stdout;

      // ---- Test scenario steps 3-5 surrogate: real D-push/D-pull sync brackets ----
      // Full LLM-driven `apra-fleet workflow auto-sprint` dispatch is out of
      // scope for a hermetic vitest suite (no network, no LLM credentials --
      // see docs/tools-infrastructure.md and this same constraint already
      // documented in tests/check-toy-doer-credentials.test.ts). What IS
      // exercised here for real is the exact mechanism that would carry the
      // sprint's writes to the sandbox-local remote: the real,
      // non-test-doubled doltPushAfter/doltPullBefore sync brackets from
      // auto-sprint/runner.js, run against the real bd CLI and the real
      // sandbox-local file:// Dolt remote wired above -- driving a real
      // `bd close` (the doer's mutation) through a real D-push then a real
      // D-pull, the same bracket pair every withGitSync() dispatch uses.
      const { doltPushAfter, doltPullBefore } = await import(RUNNER_PATH);
      const command = makeRealCommand(toyRepo);
      doltLogs = [];
      const log = (msg: string) => doltLogs.push(msg);

      bd(toyRepo, ['close', CANARY_ID, '--reason', 'apra-fleet-eft.18.8 e2e smoke test']);
      pushResult = await doltPushAfter('toy-doer', { command, log, sprintId: 'eft-18-8-e2e' });
      pullResult = await doltPullBefore('toy-doer', { command, log });

      canaryAfterClose = JSON.parse(bd(toyRepo, ['show', CANARY_ID, '--json']));

      hazardSnapshots['config.yaml after D-push/D-pull'] = fs.readFileSync(
        path.join(toyRepo, '.beads', 'config.yaml'),
        'utf-8',
      );
      hazardSnapshots['bd dolt remote list after D-push/D-pull'] = bd(toyRepo, ['dolt', 'remote', 'list', '--json']);
    }, 60_000);

    afterAll(() => {
      // Safety-net cleanup; the Teardown test below already removes
      // outerDir on its own success path, so this is a no-op then.
      fs.rmSync(outerDir, { recursive: true, force: true });
    });

    function runGuard(repoPath: string, sandboxPath: string): { status: number; stdout: string; stderr: string } {
      const res = spawnSync(process.execPath, [CHECK_SCRIPT_PATH, repoPath, sandboxPath], { encoding: 'utf-8' });
      return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
    }

    it('Setup: fresh sandbox clone with ZERO bd bootstrap and ZERO neutralize -- beads DB seeded from git-committed JSONL, and the hardcoded canary is present with the integ-canary label from git alone', () => {
      expect(canaryBeforeClose).toHaveLength(1);
      expect(canaryBeforeClose[0].status).toBe('open');
      expect(canaryBeforeClose[0].labels).toContain('integ-canary');
    });

    it('the pre-sprint check-sandbox-sync-remote.mjs guard passes with its retargeted (all-remotes-inside-sandbox) assertions', () => {
      expect(guardResult.status).toBe(0);
      expect(guardResult.stdout).toContain('OK: active sync.remote');
      expect(guardResult.stdout).toContain('resolves inside the sandbox path');
      expect(guardResult.stdout).toContain('OK: sandbox is isolated from the real fleet-e2e-toy Dolt remote.');
      // apra-fleet-eft.18.8 finding: check 2 (outbound commits) is always
      // non-zero here (bd init's own scaffolding commit never reaches the
      // sandbox-local git mirror) but is informational-only and must not
      // fail the guard -- see the file-level comment above.
      expect(guardResult.stdout).toMatch(/ahead of origin\/main.*informational only/);
    });

    it('D-push and D-pull SUCCEED against the sandbox-local throwaway file:// remote -- not skipped, and never touching the real remote', () => {
      expect(pushResult).toMatchObject({ ok: true, member: 'toy-doer', pushed: true });
      expect((pushResult as { skipped?: boolean }).skipped).toBeFalsy();
      expect(pullResult).toMatchObject({ ok: true, member: 'toy-doer' });
      expect((pullResult as { skipped?: boolean }).skipped).toBeFalsy();

      // Every logged line (if any -- doltPushAfter/doltPullBefore only log
      // on retry/skip/reconcile paths, none of which fired on this clean
      // run) must never claim a skip or reference the real remote.
      for (const line of doltLogs) {
        expect(line).not.toMatch(/skipped/i);
        expect(line).not.toContain(HAZARD_REMOTE);
      }
    });

    it('the real fleet-e2e-toy remote URL appears NOWHERE in the sandbox git or beads config at any point in the flow (SAFETY INVARIANT)', () => {
      expect(Object.keys(hazardSnapshots).length).toBeGreaterThan(0);
      for (const [label, snapshot] of Object.entries(hazardSnapshots)) {
        expect(snapshot, `${label} must never reference the real ${HAZARD_REMOTE} remote`).not.toContain(
          `github.com/Apra-Labs/${HAZARD_REMOTE}`,
        );
        // The realOriginDir fixture path itself contains the hazard
        // substring (see beforeAll) -- outside the sandbox by construction,
        // so no in-sandbox snapshot may reference it either.
        expect(snapshot, `${label} must never reference the local ${HAZARD_REMOTE} fixture path`).not.toContain(
          realOriginDir,
        );
      }
    });

    it('the smoke sprint reaches its verdict (canary closed via the real D-push/D-pull brackets), and Teardown deletes the throwaway remote with the sandbox', () => {
      expect(canaryAfterClose).toHaveLength(1);
      expect(canaryAfterClose[0].status).toBe('closed');

      // Sanity: the throwaway remotes exist right up until Teardown.
      expect(fs.existsSync(gitMirror)).toBe(true);
      expect(fs.existsSync(doltRemote)).toBe(true);

      // ---- `## Teardown` ----
      fs.rmSync(sandboxRoot, { recursive: true, force: true });

      expect(fs.existsSync(toyRepo)).toBe(false);
      expect(fs.existsSync(gitMirror)).toBe(false);
      expect(fs.existsSync(doltRemote)).toBe(false);
    });
  },
);
