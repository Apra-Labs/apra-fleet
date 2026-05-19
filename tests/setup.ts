import path from 'node:path';
import os from 'node:os';

// APRA_FLEET_DATA_DIR is set by vitest.config.ts via both top-level
// process.env mutation AND the test.env config option. Both must point
// at a tmp dir; if either is missing or names the real home dir, abort
// the run BEFORE any test code can write to ~/.apra-fleet/data.
const expectedTestDir = path.join(os.tmpdir(), 'apra-fleet-test-data');
const actual = process.env.APRA_FLEET_DATA_DIR;
if (!actual || actual !== expectedTestDir) {
  // eslint-disable-next-line no-console
  console.error(
    `[test-setup] FATAL: APRA_FLEET_DATA_DIR is "${actual ?? '<unset>'}", expected "${expectedTestDir}". ` +
    `Refusing to run - tests would write to the real fleet data dir. ` +
    `Check vitest.config.ts top-level env wiring.`,
  );
  process.exit(2);
}

process.env.NODE_ENV = 'test';

import { initFleetBlindfold } from '../src/services/blindfold-init.js';
initFleetBlindfold();
