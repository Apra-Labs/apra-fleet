// =============================================================================
// Auto-sprint supervisor -- operator HTTP endpoints (apra-fleet-eft.4.4)
// members / backlog / sprints CRUD / stop proxy
// =============================================================================
//
// The six operator-facing endpoints the always-on supervisor (server.mjs)
// exposes on top of its lifecycle-owned /api/health and /api/shutdown:
//
//   GET  /api/members          list_members plus a live-reservation overlay
//   GET  /api/backlog          the fleet backlog
//   POST /api/sprints          validated launch; forwards the per-request goal
//                              into the detached child's argv (eft.4.2 spawner)
//   GET  /api/sprints          every live sprint (from the reservation ledger)
//   GET  /api/sprints/:id      LIVE child state proxied from the child's /state
//                              when running, else the historical record
//   POST /api/sprints/:id/stop proxy the child's own cooperative /stop endpoint
//
// SINGLE SOURCE OF TRUTH FOR VALIDATION (acceptance criterion): request
// validation REUSES the exported runner.js helpers validateIssueId /
// validateBranchName and the cli.mjs resolveRoleMap helper -- it never
// re-implements the id/branch regexes here. A malformed issue id or branch name
// is rejected with a 400 that names the offending field, before any child is
// spawned.
//
// COLLABORATOR SEAMS: every side-effecting collaborator (spawner, ledger,
// history, member/backlog sources, and the child HTTP proxies) is injected, so
// this module is unit-testable without real processes, sockets, or a live
// fleet transport. eft.5.2's all-or-nothing member-union overlap check (409 on
// conflict, see defaultMemberOverlapGuard() below) is the DEFAULT `beforeLaunch`
// -- it runs unless a caller injects its own, e.g. to compose it with the
// eft.5.3 issue-scope guard. The check runs strictly BEFORE ledger.claim(), so
// a rejected launch never touches the ledger (byte-identical, no partial claim).
// =============================================================================

import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { readJsonBody, sendJson } from './server.mjs';
import { validateIssueId, validateBranchName } from '../../auto-sprint/runner.js';
import { resolveRoleMap } from '../../bin/cli.mjs';

/** A controller error carrying an HTTP status and (optionally) the bad field. */
export class ApiError extends Error {
    /**
     * @param {number} status
     * @param {string} message
     * @param {string} [field]
     */
    constructor(status, message, field) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        if (field) this.field = field;
    }
}

/** Normalize a `members` request value (array OR comma string) into a deduped array. */
function normalizeMembers(value) {
    let items;
    if (Array.isArray(value)) items = value;
    else if (typeof value === 'string') items = value.split(',');
    else return [];
    const out = [];
    const seen = new Set();
    for (const raw of items) {
        if (typeof raw !== 'string') continue;
        const m = raw.trim();
        if (m.length === 0 || seen.has(m)) continue;
        seen.add(m);
        out.push(m);
    }
    return out;
}

/** The full member set a reservation covers: the union of --members and every roleMap value. */
function memberUnion(members, roleMap) {
    const seen = new Set();
    const out = [];
    const add = (m) => {
        if (typeof m === 'string' && m.length > 0 && !seen.has(m)) { seen.add(m); out.push(m); }
    };
    for (const m of members) add(m);
    if (roleMap && typeof roleMap === 'object') {
        for (const list of Object.values(roleMap)) {
            if (Array.isArray(list)) for (const m of list) add(m);
        }
    }
    return out;
}

/**
 * Human-readable rejection message naming every conflicting sprint and the
 * overlapping member names, for surfacing to the launch caller / API response.
 * @param {Array<{ sprintId: string, members: string[] }>} conflicts
 * @returns {string}
 */
export function formatMemberConflict(conflicts) {
    const parts = conflicts.map(
        (c) => `sprint '${c.sprintId}' already claims [${c.members.join(', ')}]`,
    );
    return `member overlap rejects launch: ${parts.join('; ')}`;
}

/**
 * apra-fleet-eft.5.2: the DEFAULT member-axis overlap guard used as
 * `beforeLaunch` when the caller does not inject its own. All-or-nothing:
 * ANY member in the incoming union (members + every roleMap value, INCLUDING
 * the orchestrator role -- memberUnion() already folds that in) that is also
 * held by any OTHER active reservation rejects the ENTIRE launch with a 409,
 * naming the conflicting sprint id(s) and the specific overlapping member
 * names. This throws BEFORE ledger.claim() is ever called, so a rejected
 * launch leaves the ledger byte-identical -- no partial claim.
 * @param {{ list: () => Array<{ sprintId: string, members?: string[] }> }} ledger
 * @returns {(ctx: { members: string[], issueRoots: string[] }) => Promise<void>}
 */
export function defaultMemberOverlapGuard(ledger) {
    return async ({ members: requestMembers }) => {
        const requestSet = new Set(requestMembers ?? []);
        const conflicts = [];
        for (const reservation of ledger.list()) {
            const overlapping = (reservation.members ?? []).filter((m) => requestSet.has(m));
            if (overlapping.length > 0) {
                conflicts.push({ sprintId: reservation.sprintId, members: overlapping.sort() });
            }
        }
        if (conflicts.length > 0) {
            throw new ApiError(409, formatMemberConflict(conflicts), 'members');
        }
    };
}

/** Default child HTTP proxy: GET the child's viewer `/state` and JSON-parse it. */
export function proxyChildState(port, opts = {}) {
    const host = opts.host ?? '127.0.0.1';
    const timeoutMs = Number.isInteger(opts.timeoutMs) ? opts.timeoutMs : 2000;
    return new Promise((resolve, reject) => {
        const req = http.request({ host, port, path: '/state', method: 'GET', timeout: timeoutMs }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf-8');
                try { resolve(body.length ? JSON.parse(body) : {}); }
                catch (err) { reject(new Error(`child /state returned invalid JSON: ${err.message}`)); }
            });
        });
        req.on('timeout', () => { req.destroy(new Error('child /state timed out')); });
        req.on('error', reject);
        req.end();
    });
}

/** Default child HTTP proxy: POST the child's cooperative `/stop` endpoint. */
export function proxyChildStop(port, opts = {}) {
    const host = opts.host ?? '127.0.0.1';
    const timeoutMs = Number.isInteger(opts.timeoutMs) ? opts.timeoutMs : 2000;
    return new Promise((resolve, reject) => {
        const req = http.request({ host, port, path: '/stop', method: 'POST', timeout: timeoutMs }, (res) => {
            res.resume();
            res.on('end', () => resolve({ statusCode: res.statusCode }));
        });
        req.on('timeout', () => { req.destroy(new Error('child /stop timed out')); });
        req.on('error', reject);
        req.end();
    });
}

/**
 * Create the supervisor sprint/member/backlog controller. All collaborators are
 * injected.
 *
 * @param {{
 *   ledger: {
 *     list: () => Array<object>,
 *     get: (id: string) => object|undefined,
 *     claim: (id: string, r: object) => Promise<object>,
 *   },
 *   spawner: {
 *     spawnSprint: (opts: object) => Promise<{ pid: number, port: number, args?: string[] }>,
 *     getLiveEntry?: (pid: number) => { port: number }|undefined,
 *   },
 *   history?: { latestFor: (id: string) => object|undefined, forSprint: (id: string) => object[] },
 *   listMembers: () => Promise<object|object[]>|object|object[],
 *   getBacklog: () => Promise<any>|any,
 *   proxyState?: (port: number) => Promise<object>,
 *   proxyStop?: (port: number) => Promise<object>,
 *   resolvePort?: (pid: number|null) => number|undefined,
 *   beforeLaunch?: (ctx: { members: string[], issueRoots: string[] }) => Promise<void>|void,
 *     Defaults to defaultMemberOverlapGuard(ledger) (eft.5.2): rejects with a
 *     409 ApiError on any member overlap with an active reservation. Inject to
 *     override or compose (e.g. with the eft.5.3 issue-scope guard).
 *   generateSprintId?: (issue: string) => string,
 *   resolveRoleMap?: (raw: string|undefined) => Promise<object|undefined>,
 * }} deps
 */
export function createSprintController(deps = {}) {
    const { ledger, spawner } = deps;
    if (!ledger || typeof ledger.list !== 'function' || typeof ledger.get !== 'function' || typeof ledger.claim !== 'function') {
        throw new TypeError('createSprintController requires a ledger with list()/get()/claim()');
    }
    if (!spawner || typeof spawner.spawnSprint !== 'function') {
        throw new TypeError('createSprintController requires a spawner with spawnSprint()');
    }
    const history = deps.history ?? { latestFor: () => undefined, forSprint: () => [] };
    const listMembers = deps.listMembers ?? (() => ({ members: [] }));
    const getBacklog = deps.getBacklog ?? (() => ({ tasks: [] }));
    const proxyState = deps.proxyState ?? proxyChildState;
    const proxyStop = deps.proxyStop ?? proxyChildStop;
    const roleMapResolver = deps.resolveRoleMap ?? resolveRoleMap;
    // eft.5.2: the default beforeLaunch is the all-or-nothing member-axis
    // overlap guard (409 on conflict), not a no-op. Callers may still inject
    // their own beforeLaunch (e.g. to compose it with the eft.5.3 issue-scope
    // guard) -- this default is what runs when nothing is injected.
    const beforeLaunch = deps.beforeLaunch ?? defaultMemberOverlapGuard(ledger);
    const generateSprintId = deps.generateSprintId ?? ((issue) => `${issue}-${randomUUID()}`);
    const resolvePort = deps.resolvePort
        ?? ((pid) => (pid != null && spawner.getLiveEntry ? spawner.getLiveEntry(pid)?.port : undefined));

    /** Validate a launch request against the SHARED runner.js helpers. */
    function validateLaunchRequest(body) {
        const issue = body.issue ?? body.target_issue;
        const branch = body.branch;
        const base = body.base ?? body.base_branch;
        const members = normalizeMembers(body.members);

        try { validateIssueId(issue); }
        catch (err) { throw new ApiError(400, err.message, 'issue'); }
        try { validateBranchName(branch, 'branch'); }
        catch (err) { throw new ApiError(400, err.message, 'branch'); }
        try { validateBranchName(base, 'base'); }
        catch (err) { throw new ApiError(400, err.message, 'base'); }
        if (members.length === 0) {
            throw new ApiError(400, 'members must be a non-empty list of member names', 'members');
        }
        return { issue, branch, base, members };
    }

    // -- GET /api/members : list_members + live-reservation overlay -----------
    async function members() {
        const raw = await listMembers();
        const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.members) ? raw.members : []);
        // member name -> sprintId that reserves it (first reservation wins).
        const reservedBy = new Map();
        for (const r of ledger.list()) {
            for (const m of (r.members ?? [])) {
                if (!reservedBy.has(m)) reservedBy.set(m, r.sprintId);
            }
        }
        return {
            members: list.map((m) => {
                const base = typeof m === 'string' ? { name: m } : { ...m };
                const sid = reservedBy.get(base.name) ?? null;
                return { ...base, reserved: sid != null, reservedBy: sid };
            }),
        };
    }

    // -- GET /api/backlog -----------------------------------------------------
    async function backlog() {
        const result = await getBacklog();
        const freshness = ledger.getScopeFreshness();
        return { ...result, scopeFreshness: freshness };
    }

    // -- POST /api/sprints : validated, goal-forwarding launch ----------------
    async function launch(body = {}) {
        const { issue, branch, base, members } = validateLaunchRequest(body);
        const rawRoleMap = body.roleMap === undefined
            ? undefined
            : (typeof body.roleMap === 'string' ? body.roleMap : JSON.stringify(body.roleMap));
        const roleMap = await roleMapResolver(rawRoleMap);
        const union = memberUnion(members, roleMap);
        const issueRoots = [issue];

        // eft.5.2 seam: reject overlapping launches (409) BEFORE spawning a child.
        await beforeLaunch({ members: union, issueRoots });

        // Forward the per-request goal straight into the child argv (buildSprintArgv
        // pushes `--goal <goal>` when goal !== undefined).
        const spawnOpts = {
            issue,
            members: members.join(','),
            branch,
            base,
            goal: body.goal,
            maxCycles: body.maxCycles,
            allowMissingMembers: body.allowMissingMembers,
            requirementsFile: body.requirementsFile,
            roleMap,
            budget: body.budget,
        };
        const spawned = await spawner.spawnSprint(spawnOpts);
        const sprintId = generateSprintId(issue);
        await ledger.claim(sprintId, { members: union, issueRoots, childPid: spawned.pid });

        return {
            sprintId,
            pid: spawned.pid,
            port: spawned.port,
            issueRoots,
            members: union,
            goal: body.goal ?? null,
        };
    }

    // -- GET /api/sprints : every live sprint ---------------------------------
    async function listSprints() {
        const freshness = ledger.getScopeFreshness();
        return {
            sprints: ledger.list().map((r) => ({
                sprintId: r.sprintId,
                members: r.members,
                issueRoots: r.issueRoots,
                childPid: r.childPid ?? null,
                port: resolvePort(r.childPid ?? null) ?? null,
            })),
            scopeFreshness: freshness,
        };
    }

    // -- GET /api/sprints/:id : live child state, else history ----------------
    async function getSprint(id) {
        const reservation = ledger.get(id);
        if (reservation) {
            const port = resolvePort(reservation.childPid ?? null);
            if (port != null) {
                const state = await proxyState(port);
                return { sprintId: id, live: true, state };
            }
        }
        // Not live (finished/gone, or port unknown): return the historical record.
        const latest = history.latestFor(id);
        if (latest) {
            return { sprintId: id, live: false, history: history.forSprint(id), latest };
        }
        throw new ApiError(404, `no sprint '${id}' is live or in history`);
    }

    // -- POST /api/sprints/:id/stop : proxy the child's /stop -----------------
    async function stopSprint(id) {
        const reservation = ledger.get(id);
        if (!reservation) {
            throw new ApiError(404, `no live sprint '${id}' to stop`);
        }
        const port = resolvePort(reservation.childPid ?? null);
        if (port == null) {
            throw new ApiError(409, `sprint '${id}' has no reachable child (port unknown)`);
        }
        const result = await proxyStop(port);
        return { sprintId: id, status: 'stopping', child: result ?? null };
    }

    return {
        name: 'sprint-controller',
        members,
        backlog,
        launch,
        listSprints,
        getSprint,
        stopSprint,
    };
}

/**
 * Register the six operator endpoints against a supervisor (server.mjs). Each
 * handler maps an ApiError to its status (naming the bad field on a 400) and
 * lets any other error bubble to the supervisor's 500 isolation wrapper.
 *
 * @param {{ route: (method: string, path: string, handler: Function) => void }} supervisor
 * @param {ReturnType<typeof createSprintController>} controller
 */
export function registerSprintRoutes(supervisor, controller) {
    const onApiError = (res, err) => {
        if (err instanceof ApiError) {
            const payload = { error: err.message };
            if (err.field) payload.field = err.field;
            sendJson(res, err.status, payload);
            return true;
        }
        return false;
    };

    supervisor.route('GET', '/api/members', async (req, res) => {
        sendJson(res, 200, await controller.members());
    });

    supervisor.route('GET', '/api/backlog', async (req, res) => {
        sendJson(res, 200, await controller.backlog());
    });

    supervisor.route('POST', '/api/sprints', async (req, res) => {
        const body = (await readJsonBody(req)) ?? {};
        try {
            sendJson(res, 201, await controller.launch(body));
        } catch (err) {
            if (!onApiError(res, err)) throw err;
        }
    });

    supervisor.route('GET', '/api/sprints', async (req, res) => {
        sendJson(res, 200, await controller.listSprints());
    });

    supervisor.route('GET', '/api/sprints/:id', async (req, res, ctx) => {
        try {
            sendJson(res, 200, await controller.getSprint(ctx.params.id));
        } catch (err) {
            if (!onApiError(res, err)) throw err;
        }
    });

    supervisor.route('POST', '/api/sprints/:id/stop', async (req, res, ctx) => {
        try {
            sendJson(res, 200, await controller.stopSprint(ctx.params.id));
        } catch (err) {
            if (!onApiError(res, err)) throw err;
        }
    });
}
