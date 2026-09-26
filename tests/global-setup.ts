import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { TestProject } from 'vitest/node';

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
export default function globalSetup(project: TestProject) {
  const dataDir = path.join(
    os.tmpdir(),
    `apra-fleet-test-data-${process.pid}-${crypto.randomBytes(4).toString('hex')}`
  );
  fs.mkdirSync(dataDir, { recursive: true });
  project.provide('APRA_FLEET_TEST_DATA_DIR', dataDir);

  return () => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; a leftover temp dir is not fatal
    }
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    APRA_FLEET_TEST_DATA_DIR: string;
  }
}
