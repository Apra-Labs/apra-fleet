/**
 * In-process facade over the fleet tool handlers (apra-fleet-v6t7.2.1).
 *
 * Console route modules call THIS, never the MCP wire: no HTTP self-call back
 * into the server's own /mcp endpoint, no spawned client, no child process.
 * The console runs inside the same process that owns the registry, so a
 * round trip would only buy latency, a second failure mode, and an auth
 * boundary we would then have to punch a hole through.
 *
 * Each function here is a thin adapter: pick the tool handler, pin the
 * machine-readable output format, return the payload. Shaping/formatting for
 * a specific screen belongs in the route module, not here.
 */
import { listMembers } from '../tools/list-members.js';

/**
 * The list_members tool's json payload, as a JSON string (exactly what the
 * tool produces -- parsing and re-stringifying it here would only risk
 * drifting from the tool's own contract).
 */
export async function getMembersJson(tags?: string[]): Promise<string> {
  return await listMembers({ format: 'json', tags });
}
