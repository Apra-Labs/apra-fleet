// Test helper: createDoltMutex() instances that persist mutex.json into a
// private mkdtemp dir instead of the default data dir.
//
// scripts/run-tests.mjs gives every test file in a run ONE shared isolated
// HOME, so a mutex built with no dataDir would write <HOME>/.apra-fleet-se/
// mutex.json and a holder left by one test file could be restored into
// another. Every test that builds a real mutex goes through this factory.
//
// Usage (module scope of a test file):
//   const mutexes = tempDoltMutexFactory();
//   after(() => mutexes.cleanup());
//   const mutex = mutexes.make({ leaseMs: 100_000 });
//
// cleanup() flushes each mutex's queued holder writes BEFORE removing its dir:
// the writer mkdirs recursively, so a write landing after the rm would
// otherwise silently recreate (leak) the temp dir.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';

import { createDoltMutex } from '../../src/supervisor/dolt-mutex.mjs';

export function tempDoltMutexFactory(prefix = 'dolt-mutex-test-') {
    const made = [];
    return {
        /** Build a mutex on a fresh temp dataDir (unless opts.dataDir is given). */
        make(opts = {}) {
            const dataDir = opts.dataDir ?? mkdtempSync(path.join(os.tmpdir(), prefix));
            const mutex = createDoltMutex({ ...opts, dataDir });
            made.push({ mutex, dataDir, owned: opts.dataDir === undefined });
            return mutex;
        },
        async cleanup() {
            const all = made.splice(0);
            // Flush EVERY mutex before removing ANY dir -- two instances may
            // share one dataDir (restart tests).
            await Promise.all(all.map(({ mutex }) => mutex.flush()));
            for (const { dataDir, owned } of all) {
                // eslint-disable-next-line no-await-in-loop
                if (owned) await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
            }
        },
    };
}
