import type { OsCommands } from '../os/os-commands.js';
import type { AgentStrategy } from '../services/strategy.js';
import { getStoredPid, clearStoredPid } from './agent-helpers.js';
import { logLine, logWarn } from './log-helpers.js';

/**
 * Local PID liveness check (apra-fleet-eft.28.1). Only meaningful for a
 * process that lives on THIS machine -- the persistent interactive claude
 * session spawned by register_member is always local (interactive bootstrap
 * is gated to isLocal members), so this is safe to use for that session's
 * pid. Never throws: `process.kill(pid, 0)` sends no signal, it only probes
 * for the process's existence/permission.
 *
 * Conservative on ambiguity: only a definitive "no such process" (ESRCH)
 * counts as dead. EPERM (process exists, we lack permission to signal it)
 * and any other unexpected error are treated as "alive" -- a false "alive"
 * just falls back to the pre-existing wait/timeout behavior, whereas a false
 * "dead" would incorrectly discard a live, healthy session.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code !== 'ESRCH';
  }
}

/**
 * Kill the stored PID for an agent, then clear it.
 * Swallows errors — the process may already be dead.
 */
export async function tryKillPid(
  agent: { id: string; friendlyName: string },
  strategy: AgentStrategy,
  cmds: OsCommands,
): Promise<void> {
  const pid = getStoredPid(agent.id);
  if (pid === undefined) return;
  clearStoredPid(agent.id);
  logLine('pid_kill', `killing pid=${pid}`, agent);
  try {
    await strategy.execCommand(cmds.killPid(pid), 5000);
    logLine('pid_kill', `killed pid=${pid}`, agent);
  } catch (e: any) {
    logWarn('pid_kill', `kill failed pid=${pid}: ${String(e?.message ?? e)}`, agent);
  }
}
