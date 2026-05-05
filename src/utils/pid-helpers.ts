import type { OsCommands } from '../os/os-commands.js';
import type { AgentStrategy } from '../services/strategy.js';
import { getStoredPid, clearStoredPid } from './agent-helpers.js';
import { logLine, logWarn } from './log-helpers.js';

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
