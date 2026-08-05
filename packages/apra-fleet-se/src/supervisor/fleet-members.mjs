// =============================================================================
// Auto-sprint supervisor -- fleet-backed member listing (apra-fleet-eft.4.8.1
// wiring helper)
// =============================================================================
//
// api.mjs's createSprintController() accepts an injected `listMembers()`
// collaborator (defaults to `() => ({ members: [] })` when omitted) used by:
//   * GET /api/members (the raw list, overlaid with THIS supervisor's own
//     ledger reservations), and
//   * the default eft.5.2/eft.26.2 member-overlap guard's second reservation
//     source (the fleet server's own `reservedBy` record).
//
// The supervisor process itself is NOT a fleet MCP client (it has no
// standing transport -- bin/cli.mjs's per-sprint children own that), so this
// module opens a SHORT-LIVED StreamableHttp connection per call, mirroring
// bin/cli.mjs's own `fleetApi.listMembers({ format: 'json' })` call (the
// single source of truth for that request shape), and tears the connection
// down again immediately after. This is deliberately NOT connected once at
// supervisor boot: `fleet-se serve` must stay independently up (and answer
// GET /api/health) even when no fleet HTTP singleton is reachable yet -- the
// supervisor's OWN lifecycle never depends on the fleet server's.
// =============================================================================

import { StreamableHttpTransport } from '@apralabs/apra-fleet-client/transport';
import { McpClient } from '@apralabs/apra-fleet-client/client';
import { ApraFleet } from '@apralabs/apra-fleet-client';

/**
 * Fetches the fleet's registered members via a short-lived MCP connection.
 * Never throws: any resolution/connection/parse failure resolves to an empty
 * member list rather than taking down the caller (GET /api/members degrades
 * to "no members known" instead of a hard failure; the member-overlap guard
 * that also consumes this already treats it as a best-effort second source).
 *
 * @param {{
 *   resolveConnection?: () => Promise<{ mode: string, url?: string, reason?: string }>,
 *   logger?: { log?: Function, error?: Function },
 * }} [deps]
 * @returns {Promise<{ members: Array<object> }>}
 */
export async function listFleetMembers(deps = {}) {
    const logger = deps.logger ?? console;
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);
    const resolveConnection = deps.resolveConnection;
    if (typeof resolveConnection !== 'function') {
        throw new TypeError('listFleetMembers requires a resolveConnection() collaborator');
    }

    let connection;
    try {
        connection = await resolveConnection();
    } catch (err) {
        logError('[fleet-members] failed to resolve fleet server connection:', err);
        return { members: [] };
    }
    if (!connection || connection.mode !== 'http') {
        logError(`[fleet-members] no reachable fleet HTTP singleton (${connection && connection.reason})`);
        return { members: [] };
    }

    const transport = new StreamableHttpTransport(connection.url);
    try {
        await transport.start();
        const mcpClient = new McpClient(transport);
        const fleetApi = new ApraFleet(mcpClient);
        const listRes = await fleetApi.listMembers({ format: 'json' });
        const text = listRes && listRes.content && listRes.content[0] ? listRes.content[0].text : JSON.stringify(listRes);
        const parsed = JSON.parse(text);
        return { members: Array.isArray(parsed.members) ? parsed.members : [] };
    } catch (err) {
        logError('[fleet-members] failed to list fleet members:', err);
        return { members: [] };
    } finally {
        try { transport.stop(); } catch { /* best-effort teardown */ }
    }
}
