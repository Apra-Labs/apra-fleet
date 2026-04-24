import { z } from 'zod';
import { memberIdentifier, resolveMember } from '../utils/resolve-member.js';
import { getStoredPid, setAgentStopped } from '../utils/agent-helpers.js';
import { getAgentOS } from '../utils/agent-helpers.js';
import { getStrategy } from '../services/strategy.js';
import { getOsCommands } from '../os/index.js';
import { tryKillPid } from '../utils/pid-helpers.js';

export const stopPromptSchema = z.object({
  ...memberIdentifier,
});

export type StopPromptInput = z.infer<typeof stopPromptSchema>;

export async function stopPrompt(input: StopPromptInput): Promise<string> {
  const agentOrError = resolveMember(input.member_id, input.member_name);
  if (typeof agentOrError === 'string') return agentOrError;
  const agent = agentOrError;

  const strategy = getStrategy(agent);
  const cmds = getOsCommands(getAgentOS(agent));

  const pid = getStoredPid(agent.id);

  // Kill active process (if any) before setting the stopped flag
  await tryKillPid(agent.id, strategy, cmds);

  // Mark agent stopped to prevent re-dispatch
  setAgentStopped(agent.id);

  if (pid !== undefined) {
    return `🛑 Agent "${agent.friendlyName}" stopped (killed PID ${pid}). Next execute_prompt will require explicit intent.`;
  }
  return `🛑 Agent "${agent.friendlyName}" marked stopped (no active session was running). Next execute_prompt will require explicit intent.`;
}
