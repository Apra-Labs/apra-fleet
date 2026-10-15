import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { TestProject } from 'vitest/node';
// @ts-expect-error -- plain .mjs helper shared with the node --test runners
import { ensureTestSandbox } from '../scripts/test-sandbox.mjs';

// apra-fleet-2xs.9: tests/setup.ts used to point EVERY test run at the SAME fixed
// os.tmpdir()/apra-fleet-test-data directory, never cleaned up between runs.
// `fileParallelism: false` in vitest.config.ts only serializes test FILES within one
// vitest process -- it does nothing to stop two concurrent vitest processes (e.g. two
// overlapping orchestrator-dispatched sessions in the same checkout) from reading and
// writing the exact same registry.json at once, which is what caused the
// non-deterministic suite failures during the 2026-07-02 git-loss incident.
//
// Fix: globalSetup runs once in the MAIN vitest process (before any per-file worker is
// forked) and computes ONE unique directory per `vitest run` invocation
// (pid + random suffix), then hands it to every worker via `provide`/`inject` so all
// test files in this run agree on the same path (required -- tests share
// registry.json across files within a single run) while two concurrent `npm test`
// invocations never collide. The directory is removed in the returned teardown hook.

// A test must never write into THIS checkout's git hooks (worktrees share them):
// a leaked kb_setup once left the KB post-commit hook in the developer's real
// repo, running `kb invalidate` on every commit. Snapshot the hooks dir before
// the run; the teardown restores it and FAILS naming every hook a test added
// or changed, so the leak is caught by the suite instead of noticed by hand.
function repoHooksDir(): string | null {
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
    return path.resolve(process.cwd(), common, 'hooks');
  } catch {
    return null; // not a git checkout: nothing to protect
  }
}

function snapshotHooks(dir: string): Map<string, Buffer> {
  const snap = new Map<string, Buffer>();
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return snap; }
  for (const name of names) {
    if (name.endsWith('.sample')) continue;
    try {
      const file = path.join(dir, name);
      if (fs.statSync(file).isFile()) snap.set(name, fs.readFileSync(file));
    } catch { /* raced away */ }
  }
  return snap;
}

/** Restores `dir` to `before` and returns the hooks a test added or changed. */
export function restoreLeakedHooks(dir: string, before: Map<string, Buffer>): string[] {
  const leaked: string[] = [];
  for (const [name, content] of snapshotHooks(dir)) {
    const prior = before.get(name);
    if (prior && prior.equals(content)) continue;
    leaked.push(`${name} (${prior ? 'changed' : 'added'})`);
    try {
      if (prior) fs.writeFileSync(path.join(dir, name), prior);
      else fs.rmSync(path.join(dir, name), { force: true });
    } catch { /* still reported below */ }
  }
  return leaked;
}

export default function globalSetup(project: TestProject) {
  // Sandbox HOME/USERPROFILE/APRA_FLEET_DATA_DIR in the MAIN process before
  // any worker forks, so a bare `npx vitest` is as hermetic as `npm test`
  // (scripts/test-sandbox.mjs). Reused when the runner already made one.
  const sandbox = ensureTestSandbox(process.env);
  const dataDir = path.join(
    os.tmpdir(),
    `apra-fleet-test-data-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  );
  fs.mkdirSync(dataDir, { recursive: true });
  project.provide('APRA_FLEET_TEST_DATA_DIR', dataDir);
  const hooksDir = repoHooksDir();
  const hooksBefore = hooksDir ? snapshotHooks(hooksDir) : new Map<string, Buffer>();

  return () => {
    sandbox.cleanup();
    const leaked = hooksDir ? restoreLeakedHooks(hooksDir, hooksBefore) : [];
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; a leftover temp dir is not fatal
    }
    if (leaked.length > 0) {
      throw new Error(
        `A test wrote into this checkout's git hooks (${hooksDir}): ${leaked.join(', ')}. ` +
        'Restored. Point the test at a temp repo (an explicit KB anchor or a temp cwd), never the checkout.',
      );
    }
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    APRA_FLEET_TEST_DATA_DIR: string;
  }
}
