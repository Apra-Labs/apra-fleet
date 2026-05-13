import { getGbrainClient } from '../services/gbrain-client.js';
import type { Agent } from '../types.js';

/**
 * Check if gbrain is enabled on an agent.
 * Returns null if OK, or an error string if not enabled.
 */
export function assertGbrainEnabled(agent: Agent): string | null {
  if (!agent.gbrain) {
    return `gbrain is not enabled on this member. Use update_member to enable it.`;
  }
  return null;
}

/**
 * Proxy a tool call to the gbrain MCP server with standard error handling.
 */
export async function callGbrainTool(toolName: string, args: Record<string, unknown>): Promise<string> {
  const client = getGbrainClient();
  try {
    return await client.callTool(toolName, args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('gbrain is not available')) {
      return `gbrain server is not available. Ensure it is running — see docs.`;
    }
    return `gbrain tool '${toolName}' failed: ${msg}`;
  }
}
