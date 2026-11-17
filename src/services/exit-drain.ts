/**
 * Windows dispatch completion: process exit, not pipe EOF.
 *
 * On Windows a grandchild started by the dispatched CLI (a sandbox server the
 * deployer launched, a runaway `find.exe`, a test runner) inherits the
 * dispatch's stdout/stderr handles. Those handles stay open for as long as the
 * grandchild lives, so the exec side never sees EOF on the pipe even though
 * the process we actually dispatched (claude.exe and its PowerShell wrapper)
 * exited minutes ago. Node's `child.on('close')` and ssh2's channel `close`
 * both wait for that EOF, which is why a deploy dispatch could sit "in flight"
 * for 25-70 minutes after the LLM had finished.
 *
 * The chosen strategy is BOTH sides, documented at each change site:
 *   - spawn side: scripts/sandbox-deploy.mjs already starts the sandbox pair
 *     with `detached: true` and its own log-file fds (never the inherited
 *     pipe), so long-lived servers we start ourselves no longer pin it;
 *   - read side (this module): treat the dispatched process's EXIT as the
 *     completion signal on Windows, drain whatever the pipe already produced
 *     for a short grace window, then settle -- instead of waiting for an EOF
 *     that an arbitrary grandchild can withhold indefinitely. The grandchild
 *     is deliberately left running: the integ phase expects the sandbox pair
 *     to survive the dispatch that started it.
 *
 * The grace window exists so output still buffered in the pipe at exit time is
 * collected before the promise settles (transcript / last-assistant-turn
 * capture depends on it). POSIX is unchanged: there the `nohup`/subshell path
 * already reaches EOF when the process exits, and `close` is the correct,
 * strictly-more-complete signal.
 */

/** Grace window (ms) between the dispatched process exiting and settling. */
export const DEFAULT_EXIT_DRAIN_MS = 2000;

/**
 * Resolved grace window. `FLEET_EXIT_DRAIN_MS` exists so tests (and an
 * operator debugging a slow member) can shorten or lengthen the window; a
 * missing or non-numeric value falls back to the default.
 */
export function exitDrainMs(): number {
  const raw = process.env.FLEET_EXIT_DRAIN_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_EXIT_DRAIN_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_EXIT_DRAIN_MS;
}

/**
 * Whether the exec side should complete on process exit rather than pipe EOF.
 * Windows only -- this is a Windows handle-inheritance problem, and on POSIX
 * settling early would be a behaviour change with no bug behind it.
 */
export function completesOnProcessExit(agentOs: string | undefined): boolean {
  return (agentOs ?? '').toLowerCase() === 'windows';
}
