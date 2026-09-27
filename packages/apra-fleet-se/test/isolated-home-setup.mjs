// apra-fleet-v6t7.16: run-level home isolation for the WHOLE
// packages/apra-fleet-se `node --test` run (mock, real and record modes, see
// scripts/run-tests.mjs), not just the files that happen to remember to
// isolate themselves. Loaded via `node --test --import
// ./test/isolated-home-setup.mjs` so it applies BEFORE any test file's own
// top-level code runs -- follows the identical pattern
// packages/apra-fleet-workflow/test/isolated-home-setup.mjs established for
// apra-fleet-y3xp.3 (read that file first if this one is confusing).
//
// Root cause this closes: src/supervisor/spawner.mjs, history.mjs and
// ledger.mjs each default the SE data dir to os.homedir()/.apra-fleet-se
// when FLEET_SE_DATA_DIR is unset. A sentinel-home run measured this leaving
// 5+ new files under the REAL ~/.apra-fleet-se/logs (including
// supervisor.log) per `npm test`, on top of 100+ already accumulated from
// prior runs before this fix. applyIsolatedHome() (imported below) already
// redirects FLEET_SE_DATA_DIR alongside HOME/USERPROFILE/APRA_FLEET_DATA_DIR
// (see tests/helpers/isolated-home.mjs), so importing it here at run level
// is sufficient for the data-dir leak; APPDATA/LOCALAPPDATA are handled
// separately below since redirecting those in the SHARED helper would also
// change Git Bash discovery (src/os/git-bash-candidates.ts,
// src/services/shell-probe.ts) for root vitest and apra-fleet-workflow,
// which this task's scope does not need to touch.
//
// node --test spawns each test file in its OWN child process (each child
// re-receives the parent's execArgv, including this --import), so this
// module's top-level code runs once per test-file process. It applies the
// isolation immediately and registers a synchronous exit-time cleanup for
// the temp dir it created -- process 'exit' handlers must be synchronous,
// so this uses fs.rmSync rather than the (async) restore() this module
// otherwise re-exports for tests that want to call it explicitly.
import fs from 'node:fs';
import path from 'node:path';
import { applyIsolatedHome } from '../../../tests/helpers/isolated-home.mjs';

const home = await applyIsolatedHome('apra-fleet-se-test-run-');

// apra-fleet-v6t7.16 (review rework): stamp the owning process's pid into the
// temp home so scripts/run-tests.mjs's parent-side sweepStaleTempHomes() can
// tell a still-live sibling test-file process's home apart from a genuinely
// orphaned one, instead of relying solely on an age threshold. The prior
// age-only gate compared a dir's mtime against the SWEEPING run's own
// timeoutMs, not the OWNING run's -- so a short-bound invocation (e.g.
// tests/run-all-tests-timeout.test.ts's APRA_TEST_TIMEOUT_MS=1500 child)
// could delete a concurrent, still-running normal-bound run's live temp
// home. A liveness check has no such cross-run timing dependency: the sweep
// only ever deletes a dir once the pid that created it is actually gone.
fs.writeFileSync(path.join(home.tempHome, '.owner-pid'), String(process.pid), 'utf-8');

// AppData/Roaming and AppData/Local leftovers were observed under the real
// home during a sentinel-home run (see this lane's tracking bead). Nothing
// under packages/apra-fleet-se/src reads APPDATA/LOCALAPPDATA today (only
// the root src/os/git-bash-candidates.ts and src/services/shell-probe.ts
// do, for locating a Windows Git Bash install), but redirecting them here
// -- scoped to only the se package's own test run, not the shared helper --
// costs nothing and removes the leftover-directory risk if any dependency
// (npm, node-gyp, etc.) consults them during a real/record-mode run.
process.env.APPDATA = path.join(home.tempHome, 'AppData', 'Roaming');
process.env.LOCALAPPDATA = path.join(home.tempHome, 'AppData', 'Local');
fs.mkdirSync(process.env.APPDATA, { recursive: true });
fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });

// Several suites (phase0-4 golden-transcript completeness gates,
// vcs-auth-extraction-facade) run a REAL `git status --porcelain` against
// THIS checkout (not a fixture repo) to assert a fixture directory stays
// clean. Under the isolated HOME above, git has no ~/.gitconfig at all, so
// git >= 2.36's ownership check refuses with "detected dubious ownership in
// repository" for every one of those real invocations (empirically
// confirmed: this is what broke when the --import above was added, not an
// EPERM/symlink-privilege issue). Seed a minimal global gitconfig under the
// isolated home so `git status`/`git config` calls against the real repo
// (or any other real repo a test happens to touch) keep working exactly as
// they did before this file existed. `safe.directory = *` rather than
// naming the repo path explicitly, since a test may run git against paths
// other than this checkout (e.g. a temp fixture repo) and this setup has no
// way to enumerate them all up front. A user.name/user.email pair is seeded
// too so a real (non-mocked) `git commit`, if any test ever needs one
// against a real repo rather than test/helpers/git-repo-fixture.mjs's own
// hermetic identity, does not fail for a different reason (missing
// identity) the moment the ownership check above is satisfied.
fs.writeFileSync(
  path.join(home.tempHome, '.gitconfig'),
  '[safe]\n\tdirectory = *\n[user]\n\tname = apra-fleet-se test run\n\temail = apra-fleet-se-test@test.local\n',
  'utf-8',
);

process.on('exit', () => {
  try {
    fs.rmSync(home.tempHome, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // best effort -- a stray temp dir here is a leak to notice later, not a
    // reason to crash process teardown.
  }
});

export { home };
