/**
 * Shared child-env builder for every test that spawns the real `bd` CLI into
 * a scratch/fixture directory (tempDir, toy-repo clone, sandbox, etc).
 *
 * bd resolves
 * BEADS_DIR before it ever looks at cwd. On a dev host that exports
 * BEADS_DIR globally (e.g. via a shell profile pointing at a real beads
 * workspace), a `bd` child that inherits process.env verbatim finds that
 * ambient workspace instead of the scratch directory the test built for it
 * -- silently querying/mutating the wrong database. This already rewrote a
 * real beads remote via one test harness that forgot to strip it.
 *
 * Every test spawning a real `bd` process must build its child env through
 * this helper (or delete BEADS_DIR itself) rather than handing a bare
 * `bd`/`execFileSync(..., { cwd })` call `process.env` unmodified.
 */
export function bdChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BEADS_DIR;
  return env;
}
