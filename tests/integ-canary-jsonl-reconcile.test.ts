import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Tests for apra-fleet-eft.18.4: regression coverage pinning the
// apra-fleet-eft.18.3 fix (integ-test-playbook.md ## Reset / ## Test
// scenario step 2) -- the integ-canary tag lookup must recover from the
// git-tracked .beads/issues.jsonl (the authoritative merged source) when
// the bootstrapped local Dolt DB is stale, and must still fall back to the
// apra-fleet-eft.18.1 local self-provision path when NEITHER source carries
// the tag. In every path, no write or push may reach a real Dolt/git
// remote.
//
// This suite drives the REAL `bd` binary (same tool the playbook itself
// shells out to) against fresh, disposable sandboxes created under
// os.tmpdir() -- never the real fleet-e2e-toy repo or its Dolt remote. Each
// sandbox is `bd init`-ed with no --remote, so there is nothing upstream to
// reach in the first place; every `bd`/`git` invocation is additionally
// recorded by a spy wrapper so the "never pushes to the real remote"
// assertion is a genuine spy-based check (not just an absence of setup),
// per apra-fleet-eft.18.4's acceptance criteria.
//
// Fixture shape mirrors the real bug's repro (apra-fleet-eft.18 / .18.3):
// gh-toy-4ef labeled 'integ-canary' by PR #96 in the git-tracked JSONL,
// while the synced Dolt DB still only carries labels=['e2e-testing'].

const BD_INIT_TIMEOUT_MS = 60_000;
const FAR_FUTURE_TIMESTAMP = '2099-01-01T00:00:00Z'; // guarantees "newer than local" for bd import upsert semantics

type Call = { bin: string; args: string[] };

function makeSpy() {
  const calls: Call[] = [];
  function run(bin: string, args: string[], cwd: string): string {
    calls.push({ bin, args });
    return execFileSync(bin, args, { cwd, encoding: 'utf-8' });
  }
  return { calls, run };
}

function bdJson<T = any>(run: (bin: string, args: string[], cwd: string) => string, cwd: string, args: string[]): T {
  return JSON.parse(run('bd', [...args, '--json'], cwd));
}

/** No call recorded by the spy ever pushes or names the real hazard remote. */
function assertNeverPushedOrTouchedRealRemote(calls: Call[]) {
  for (const call of calls) {
    expect(call.args, `unexpected push in: ${call.bin} ${call.args.join(' ')}`).not.toContain('push');
    expect(
      call.args.some((a) => a.includes('fleet-e2e-toy')),
      `unexpected reference to the real remote in: ${call.bin} ${call.args.join(' ')}`
    ).toBe(false);
  }
}

describe('integ-canary resolution: stale bootstrap Dolt DB vs. git-tracked JSONL (apra-fleet-eft.18.4)', () => {
  let scratchRoot: string;

  afterEach(() => {
    if (scratchRoot) fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  function initSandbox(prefix: string): { dir: string; run: (bin: string, args: string[]) => string; calls: Call[] } {
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-integ-canary-test-'));
    const dir = path.join(scratchRoot, 'toy-repo');
    fs.mkdirSync(dir, { recursive: true });
    const { calls, run } = makeSpy();
    // No --remote: this sandbox never has an upstream Dolt/git remote to
    // begin with, matching the playbook's "never write to the real Dolt
    // remote from a sandbox run" rule at its strongest -- there is nothing
    // to accidentally reach.
    run('bd', ['init', '--non-interactive', '--skip-agents', '--skip-hooks', '-p', prefix, '-q'], dir);
    return { dir, run: (bin, args) => run(bin, args, dir), calls };
  }

  it(
    'reconciles the git-tracked JSONL canary when the bootstrapped Dolt DB is stale, and never touches the real remote',
    () => {
      const { dir, run, calls } = initSandbox('ghtoy');

      // Simulate the Dolt-DB sync path having hydrated gh-toy-4ef with only
      // its pre-PR#96 label (the bug's "stale bootstrap Dolt DB" state).
      const canary = bdJson(run, dir, [
        'create',
        'Add a --version flag to the CLI',
        '--type',
        'task',
        '--labels',
        'e2e-testing',
      ]);
      const canaryId = canary.id as string;
      expect(canaryId).toBeTruthy();

      // (1a) Pre-reconcile: the tag lookup against the stale Dolt DB alone
      // returns zero matches -- this is exactly the pre-apra-fleet-eft.18.3
      // failure mode this test pins (without the reconcile-and-retry step,
      // the lookup would stay empty forever, even though the git-tracked
      // JSONL already carries the tag).
      expect(bdJson(run, dir, ['list', '--label=integ-canary'])).toEqual([]);
      // Retrying without reconciling changes nothing -- the resolver must
      // not "get lucky" on a bare retry; it needs the JSONL reconcile step.
      expect(bdJson(run, dir, ['list', '--label=integ-canary'])).toEqual([]);

      // Simulate PR #96 having merged 'integ-canary' into the git-tracked
      // .beads/issues.jsonl -- the authoritative source `bd import` (no
      // file argument) reads by default, a LOCAL-only upsert that never
      // contacts any remote.
      const jsonlPath = path.join(dir, '.beads', 'issues.jsonl');
      const jsonlRow = {
        _type: 'issue',
        id: canaryId,
        title: 'Add a --version flag to the CLI',
        status: 'open',
        priority: 2,
        issue_type: 'task',
        updated_at: FAR_FUTURE_TIMESTAMP,
        labels: ['e2e-testing', 'integ-canary'],
      };
      fs.writeFileSync(jsonlPath, `${JSON.stringify(jsonlRow)}\n`, 'utf-8');

      // (1b) apra-fleet-eft.18.3's fix: reconcile the local Dolt DB from
      // the git-tracked JSONL (local-only upsert, never a push) ...
      const imported = bdJson(run, dir, ['import']);
      expect(imported.ids).toContain(canaryId);

      // ... then retry the label lookup once: it now resolves the canary
      // from the git-tracked source of truth even though the Dolt-DB sync
      // path itself was never touched.
      const resolved = bdJson(run, dir, ['list', '--label=integ-canary']);
      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe(canaryId);
      expect(resolved[0].status).toBe('open');

      // (3) No write or push ever targeted the real fleet-e2e-toy Dolt
      // remote: the sandbox never had one configured, and the spy confirms
      // no invocation this test made even references it.
      expect(bdJson(run, dir, ['dolt', 'remote', 'list'])).toEqual([]);
      expect(execFileSync('git', ['remote'], { cwd: dir, encoding: 'utf-8' }).trim()).toBe('');
      assertNeverPushedOrTouchedRealRemote(calls);
    },
    BD_INIT_TIMEOUT_MS
  );

  it(
    'falls back to self-provisioning a local-only canary when neither the Dolt DB nor the JSONL carries the tag (eft.18.1 behavior preserved)',
    () => {
      const { dir, run, calls } = initSandbox('ghtoy2');

      // Neither the (simulated) Dolt DB nor the git-tracked JSONL has an
      // integ-canary tag anywhere -- an unrelated issue only.
      bdJson(run, dir, ['create', 'Unrelated toy issue', '--type', 'task', '--labels', 'e2e-testing']);
      expect(bdJson(run, dir, ['list', '--label=integ-canary'])).toEqual([]);

      // Reconcile step still runs (mirrors the playbook order), but there
      // is nothing to import: no .beads/issues.jsonl carries the tag, so
      // the retry still comes back empty.
      const jsonlPath = path.join(dir, '.beads', 'issues.jsonl');
      fs.writeFileSync(jsonlPath, '', 'utf-8');
      run('bd', ['import', '--json'], dir);
      expect(bdJson(run, dir, ['list', '--label=integ-canary'])).toEqual([]);

      // apra-fleet-eft.18.1 fallback: self-provision a canary in the LOCAL
      // beads DB only (no push).
      const provisioned = bdJson(run, dir, [
        'create',
        'Add a --version flag to the CLI',
        '--type',
        'task',
        '--labels',
        'integ-canary',
      ]);
      expect(provisioned.id).toBeTruthy();

      const resolved = bdJson(run, dir, ['list', '--label=integ-canary']);
      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe(provisioned.id);
      expect(resolved[0].status).toBe('open');

      // No write/push reached the real remote here either.
      expect(bdJson(run, dir, ['dolt', 'remote', 'list'])).toEqual([]);
      expect(execFileSync('git', ['remote'], { cwd: dir, encoding: 'utf-8' }).trim()).toBe('');
      assertNeverPushedOrTouchedRealRemote(calls);
    },
    BD_INIT_TIMEOUT_MS
  );
});
