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
 * "The fleet member list could not be read" marker, attached to a
 * listFleetMembers() result as a NON-ENUMERABLE symbol-keyed property whose
 * value is the human-readable reason. Non-enumerable on purpose: the existing
 * callers (GET /api/members, the dolt orphan sweep, the member-overlap guard)
 * only read `.members` and keep seeing exactly `{ members: [] }` (deepEqual
 * included), while callers that MUST tell "fleet unreachable" apart from "no
 * members registered" (the backlog-member ensure and the launch-time backlog
 * pin) read it through fleetMembersUnavailableReason().
 */
export const FLEET_MEMBERS_UNAVAILABLE = Symbol.for('apra-fleet-se.fleetMembersUnavailable');

/**
 * Mark a listMembers()-shaped result as "unavailable". Returns the same
 * object (created as `{ members: [] }` when omitted), for use by
 * listFleetMembers() itself and by test fakes of the listMembers seam.
 * @param {object} [result]
 * @param {string} [reason]
 * @returns {object}
 */
export function markFleetMembersUnavailable(result = { members: [] }, reason = 'fleet member list unavailable') {
    Object.defineProperty(result, FLEET_MEMBERS_UNAVAILABLE, {
        value: String(reason), enumerable: false, configurable: true, writable: false,
    });
    return result;
}

/**
 * The unavailable reason carried by a listMembers()-shaped result, or null
 * when the list was actually read (an empty list included).
 * @param {*} result
 * @returns {string|null}
 */
export function fleetMembersUnavailableReason(result) {
    if (!result || (typeof result !== 'object' && typeof result !== 'function')) return null;
    const reason = result[FLEET_MEMBERS_UNAVAILABLE];
    return typeof reason === 'string' ? reason : null;
}

/** U+274C, the prefix fleet tools put on a refusal reply's text. */
const FLEET_TOOL_FAILURE_MARK = String.fromCodePoint(0x274c);

function errorText(err) {
    return err && err.message ? err.message : String(err);
}

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
        return markFleetMembersUnavailable({ members: [] }, `could not resolve the fleet server connection: ${errorText(err)}`);
    }
    if (!connection || connection.mode !== 'http') {
        logError(`[fleet-members] no reachable fleet HTTP singleton (${connection && connection.reason})`);
        return markFleetMembersUnavailable({ members: [] }, `no reachable fleet HTTP singleton (${connection && connection.reason})`);
    }

    const transport = new StreamableHttpTransport(connection.url);
    try {
        await transport.start();
        const mcpClient = new McpClient(transport);
        const fleetApi = new ApraFleet(mcpClient);
        const listRes = await fleetApi.listMembers({ format: 'json' });
        const text = listRes && listRes.content && listRes.content[0] ? listRes.content[0].text : JSON.stringify(listRes);
        const parsed = JSON.parse(text);
        if (!parsed || !Array.isArray(parsed.members)) {
            return markFleetMembersUnavailable({ members: [] }, 'list_members returned no members array');
        }
        return { members: parsed.members };
    } catch (err) {
        logError('[fleet-members] failed to list fleet members:', err);
        return markFleetMembersUnavailable({ members: [] }, `failed to list fleet members: ${errorText(err)}`);
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
        // The fleet server's execute_command does NOT set isError on a
        // non-zero exit; it reports the real exit code (and clean, unprefixed
        // stdout/stderr) in structuredContent instead, while `text` is the
        // display form `Exit code: N\n<output>`. Surface those fields
        // ADDITIVELY (only when the server sent them) so a caller that needs
        // exit-code truth -- the beads view's dolt command adapter
        // (beads-view.mjs) -- can read it, while `ok`/`output` keep their
        // existing meaning for the orphan sweep.
        const sc = res && res.structuredContent;
        if (sc && typeof sc.exitCode === 'number') {
            return {
                ok: true,
                output: String(text ?? ''),
                exitCode: sc.exitCode,
                stdout: typeof sc.stdout === 'string' ? sc.stdout : '',
                stderr: typeof sc.stderr === 'string' ? sc.stderr : '',
            };
        }
        return { ok: true, output: String(text ?? '') };
    } catch (err) {
        logError(`[fleet-members] execute_command failed on member '${member}':`, err);
        return { ok: false, error: err && err.message ? err.message : String(err) };
    } finally {
        try { transport.stop(); } catch { /* best-effort teardown */ }
    }
}

/**
 * Shared short-lived-connection tool call for registerFleetMember() /
 * updateFleetMember() below (same pattern as executeFleetCommand above).
 * Never throws: resolves `{ ok: true, output }` or `{ ok: false, error }`.
 * A tool reply flagged isError, or whose text starts with the fleet tools'
 * failure marker (U+274C), is a failure -- register_member/update_member
 * report refusals as text rather than isError.
 */
async function callFleetMemberTool(toolName, invoke, { resolveConnection, logger = console }) {
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);
    if (typeof resolveConnection !== 'function') {
        throw new TypeError(`${toolName} requires a resolveConnection() collaborator`);
    }
    let connection;
    try {
        connection = await resolveConnection();
    } catch (err) {
        return { ok: false, unavailable: true, error: `could not resolve fleet server connection: ${errorText(err)}` };
    }
    if (!connection || connection.mode !== 'http') {
        return { ok: false, unavailable: true, error: `no reachable fleet HTTP singleton (${connection && connection.reason})` };
    }
    const transport = new StreamableHttpTransport(connection.url);
    try {
        await transport.start();
        const fleetApi = new ApraFleet(new McpClient(transport));
        const res = await invoke(fleetApi);
        const text = res && res.content && res.content[0] ? res.content[0].text : (typeof res === 'string' ? res : JSON.stringify(res));
        const textStr = String(text ?? '');
        if ((res && res.isError) || textStr.trimStart().startsWith(FLEET_TOOL_FAILURE_MARK)) {
            return { ok: false, error: textStr || 'unknown error' };
        }
        return { ok: true, output: textStr };
    } catch (err) {
        logError(`[fleet-members] ${toolName} failed:`, err);
        return { ok: false, unavailable: true, error: errorText(err) };
    } finally {
        try { transport.stop(); } catch { /* best-effort teardown */ }
    }
}

/**
 * register_member over a short-lived connection. `options` is the
 * register_member input (friendly_name, member_type, work_folder, ...).
 * @param {{ options: object, resolveConnection: Function, logger?: object }} opts
 * @returns {Promise<{ ok: boolean, output?: string, error?: string, unavailable?: boolean }>}
 */
export async function registerFleetMember(opts = {}) {
    const { options, ...deps } = opts;
    if (!options || !options.friendly_name) throw new TypeError('registerFleetMember requires options.friendly_name');
    return callFleetMemberTool('register_member', (api) => api.registerMember(options), deps);
}

/**
 * update_member over a short-lived connection. `options` is the
 * update_member input (member_name or member_id plus the fields to change).
 * @param {{ options: object, resolveConnection: Function, logger?: object }} opts
 * @returns {Promise<{ ok: boolean, output?: string, error?: string, unavailable?: boolean }>}
 */
export async function updateFleetMember(opts = {}) {
    const { options, ...deps } = opts;
    if (!options || (!options.member_name && !options.member_id)) throw new TypeError('updateFleetMember requires options.member_name or options.member_id');
    return callFleetMemberTool('update_member', (api) => api.updateMember(options), deps);
}
