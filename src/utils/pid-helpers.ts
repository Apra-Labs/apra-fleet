import type { OsCommands } from '../os/os-commands.js';
import type { AgentStrategy } from '../services/strategy.js';
import { getStoredPid, clearStoredPid } from './agent-helpers.js';

/**
 * Kill the stored PID for an agent, then clear it.
 * Swallows errors — the process may already be dead.
 */
export async function tryKillPid(
  agentId: string,
  strategy: AgentStrategy,
  cmds: OsCommands,
): Promise<void> {
  const pid = getStoredPid(agentId);
  if (pid === undefined) return;
  clearStoredPid(agentId);
  try {
    await strategy.execCommand(cmds.killPid(pid), 5000);
  } catch {
    // Swallow — process may already be dead or unreachable
  }
}
