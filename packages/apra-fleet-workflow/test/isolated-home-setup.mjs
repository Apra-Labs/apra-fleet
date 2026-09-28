// apra-fleet-y3xp.3: run-level home isolation for the WHOLE
// apra-fleet-workflow node --test run, not just the files that happen to
// remember to isolate themselves. Loaded via `node --test --import
// ./test/isolated-home-setup.mjs` (see package.json's test script) so it
// applies BEFORE any test file's own top-level code runs.
//
// Root cause this closes: apra-fleet-workflow-viewer-pause-resume.test.mjs
// (and, before this task, some of its siblings) set no HOME/USERPROFILE/
// APRA_FLEET_DATA_DIR override at all, so a run on a machine sharing a live
// fleet's home wrote real files into the operator's actual data/running
// dir and rewrote their real fleet.key. A per-file guard cannot see a test
// that forgets isolation entirely -- only a run-level hook can.
//
// node --test spawns each test file in its OWN child process (each child
// re-receives the parent's execArgv, including this --import), so this
// module's top-level code runs once per test-file process. It applies the
// isolation immediately and registers a synchronous exit-time cleanup for
// the temp dir it created -- process 'exit' handlers must be synchronous,
// so this uses fs.rmSync rather than the (async) restore() this module
// otherwise re-exports for tests that want to call it explicitly.
import fs from 'node:fs';
import { applyIsolatedHome } from '../../../tests/helpers/isolated-home.mjs';

const home = await applyIsolatedHome('apra-fleet-workflow-test-run-');

process.on('exit', () => {
  try {
    fs.rmSync(home.tempHome, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // best effort -- a stray temp dir here is a leak to notice later, not a
    // reason to crash process teardown.
  }
});

export { home };
