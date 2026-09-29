import { runStop } from './stop.js';
import { runStart } from './start.js';

/**
 * Restart = stop + start of BOTH the MCP server and the fleet supervisor.
 * Unlike plain stop/start (best-effort for the supervisor), restart fails
 * loudly if the supervisor cannot be confirmed stopped, so it can never exit 0
 * having cycled nothing.
 */
export async function runRestart(args: string[]): Promise<void> {
  await runStop(args, { strictSupervisor: true });
  await runStart(args, { strictSupervisor: true });
}
