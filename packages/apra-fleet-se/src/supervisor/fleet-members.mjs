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

/**
 * Runs one shell command on one member via the same SHORT-LIVED MCP connection
 * pattern as listFleetMembers() above (the supervisor holds no standing fleet
 * transport, deliberately). Added for the orphaned-`dolt sql-server` sweep
 * (dolt-orphan-sweep.mjs, docs/dolt-sync-redesign.md Part 3.3), which is the
 * only supervisor-side thing that must touch a member directly.
 *
 * Never throws: a failure resolves to `{ ok: false, error }` so the sweep --
 * a safety net -- can log and move on rather than taking the supervisor down.
 *
 * @param {{ member: string, command: string, timeoutSeconds?: number,
 *   resolveConnection?: () => Promise<{ mode: string, url?: string, reason?: string }>,
 *   logger?: { log?: Function, error?: Function } }} opts
 * @returns {Promise<{ ok: boolean, output?: string, error?: string }>}
 */
export async function executeFleetCommand(opts = {}) {
    const { member, command, timeoutSeconds = 60, resolveConnection, logger = console } = opts;
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);
    if (typeof resolveConnection !== 'function') {
        throw new TypeError('executeFleetCommand requires a resolveConnection() collaborator');
    }
    if (!member || !command) throw new TypeError('executeFleetCommand requires a member and a command');

    let connection;
    try {
        connection = await resolveConnection();
    } catch (err) {
        return { ok: false, error: `could not resolve fleet server connection: ${err && err.message ? err.message : err}` };
    }
    if (!connection || connection.mode !== 'http') {
        return { ok: false, error: `no reachable fleet HTTP singleton (${connection && connection.reason})` };
    }

    const transport = new StreamableHttpTransport(connection.url);
    try {
        await transport.start();
        const fleetApi = new ApraFleet(new McpClient(transport));
        const res = await fleetApi.executeCommand({ command, member_name: member, timeout_s: timeoutSeconds });
        const text = res && res.content && res.content[0] ? res.content[0].text : (typeof res === 'string' ? res : JSON.stringify(res));
        if (res && res.isError) {
            return { ok: false, error: String(text ?? 'unknown error') };
        }
        return { ok: true, output: String(text ?? '') };
    } catch (err) {
        logError(`[fleet-members] execute_command failed on member '${member}':`, err);
        return { ok: false, error: err && err.message ? err.message : String(err) };
    } finally {
        try { transport.stop(); } catch { /* best-effort teardown */ }
    }
}
