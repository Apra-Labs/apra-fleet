import type { Agent } from '../types.js';
import type { AgentStrategy } from '../services/strategy.js';
import { getStrategy } from '../services/strategy.js';
import { getProvider } from '../providers/index.js';
import { logLine, logWarn } from './log-helpers.js';

/**
 * Idempotently seeds Claude workspace trust for `agent`'s work folder
 * (apra-fleet-eft.40.2). Wires the ensureWorkspaceTrusted(workFolder) provider-adapter
 * hook (apra-fleet-eft.40.1) into every call site that can leave a member's work folder
 * untrusted: register_member and update_member (once, at registration/update time) and
 * compose_permissions (on EVERY run, so an already-registered member -- e.g. one
 * created before this fix shipped -- is self-healed on its next compose).
 *
 * Best-effort and non-fatal: any failure (unreachable member, exec error, malformed
 * remote file) is caught and logged, never thrown -- a trust-seed hiccup must not
 * block registration, update, or permission composition. Non-Claude providers no-op
 * inside the adapter itself (see providers/*.ts), so this is cheap to call
 * unconditionally for every provider.
 *
 * @param agent The agent whose `workFolder` should be trusted, as resolved on the
 *   member (same path compose_permissions/deliverConfigFile already uses).
 * @param strategy Optional pre-resolved strategy (callers that already have one, e.g.
 *   compose_permissions, should pass it instead of paying for a second lookup).
 * @param tag Log tag identifying the call site (e.g. 'register_member').
 */
export async function seedWorkspaceTrust(agent: Agent, strategy?: AgentStrategy, tag = 'workspace-trust'): Promise<void> {
  try {
    const provider = getProvider(agent.llmProvider);
    const strat = strategy ?? getStrategy(agent);
    const result = await provider.ensureWorkspaceTrusted(
      agent.workFolder,
      (command: string, timeoutMs?: number) => strat.execCommand(command, timeoutMs),
      agent.os,
    );
    logLine(tag, `workspace trust for "${agent.friendlyName}": ${result.detail}`, agent);
  } catch (e: any) {
    logWarn(tag, `ensureWorkspaceTrusted failed for "${agent.friendlyName}" (non-fatal): ${e?.message ?? e}`, agent);
  }
}
