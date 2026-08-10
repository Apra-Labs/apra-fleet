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
// spawned. apra-fleet-ymf.1: `issue` accepts the SAME comma-separated
// multi-root form as the CLI's `--issue` flag (splitIssueIds() mirrors
// bin/cli.mjs:468's split/trim/filter exactly) -- each id is validated
// individually and forwarded as `issueRoots` (a string[], one root per
// entry), never as one opaque joined string.
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
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readJsonBody, sendJson } from './server.mjs';
import { validateIssueId, validateBranchName } from '../../fleet-sprint/runner.js';
import { resolveRoleMap } from '../../bin/cli.mjs';
import { isDeterministicTerminalReason } from './history.mjs';
import { defaultHasTerminalState } from './watchdog.mjs';

/** This module's own on-disk path -- the default build-version stamp's source (see defaultBuildVersion() below). */
const API_MODULE_PATH = fileURLToPath(import.meta.url);

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

/**
 * apra-fleet-ymf.1: split a request's `issue` field into individual ids,
 * mirroring bin/cli.mjs:468's `values.issue.split(',').map(s =>
 * s.trim()).filter(Boolean)` exactly -- so a comma-separated multi-root
 * request (`{"issue": "epic-1,epic-2"}`) reaches the same targetIssues shape
 * the CLI path already feeds runner.js, instead of 400ing on the whole
 * opaque string. A non-string `value` (including `undefined`) returns `[]`
 * so the caller falls through to `validateIssueId(value)` for byte-identical
 * error text on the missing/malformed cases this never used to split.
 * @param {*} value
 * @returns {string[]}
 */
function splitIssueIds(value) {
    if (typeof value !== 'string') return [];
    return value.split(',').map((s) => s.trim()).filter(Boolean);
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
 * apra-fleet-eft.5.2 (extended by eft.26.2, Hole 2): the DEFAULT member-axis
 * overlap guard used as `beforeLaunch` when the caller does not inject its
 * own. All-or-nothing: ANY member in the incoming union (members + every
 * roleMap value, INCLUDING the orchestrator role -- memberUnion() already
 * folds that in) that is also held by any OTHER active reservation rejects
 * the ENTIRE launch with a 409, naming the conflicting sprint id(s) and the
 * specific overlapping member names. This throws BEFORE ledger.claim() is
 * ever called, so a rejected launch leaves the ledger byte-identical -- no
 * partial claim.
 *
 * Two reservation sources are consulted, merged into ONE conflict set:
 *   1. This supervisor's OWN ledger (`ledger.list()`) -- reservations made by
 *      launches routed through THIS supervisor's POST /api/sprints.
 *   2. (eft.26.2) The fleet server's OWN per-member `reservedBy` record, read
 *      via the injected `listMembers` (the same collaborator GET /api/members
 *      already uses) -- reservations made by ANY OTHER means, e.g. a
 *      workflow/cli-launched sprint that reserved directly via
 *      `member_reservation` (apra-fleet-eft.26.1) and was never routed
 *      through this ledger at all. Without this second source, a launch could
 *      land a member ALREADY reserved server-side and the two sprints would
 *      interleave dispatches on it.
 *
 * `listMembers` is optional (backward compatible: omitting it checks only the
 * local ledger, exactly as before eft.26.2).
 *
 * @param {{ list: () => Array<{ sprintId: string, members?: string[] }> }} ledger
 * @param {() => Promise<object|object[]>|object|object[]} [listMembers]
 * @returns {(ctx: { members: string[], issueRoots: string[] }) => Promise<void>}
 */
export function defaultMemberOverlapGuard(ledger, listMembers) {
    return async ({ members: requestMembers }) => {
        const requestSet = new Set(requestMembers ?? []);
        // sprintId -> Set<member>, merged across both sources so a member
        // conflicting via both the local ledger AND the server record is
        // named once, not twice.
        const conflictsBySprint = new Map();
        const addConflict = (sprintId, member) => {
            if (!sprintId) return;
            if (!conflictsBySprint.has(sprintId)) conflictsBySprint.set(sprintId, new Set());
            conflictsBySprint.get(sprintId).add(member);
        };

        for (const reservation of ledger.list()) {
            for (const m of (reservation.members ?? [])) {
                if (requestSet.has(m)) addConflict(reservation.sprintId, m);
            }
        }

        // eft.26.2: also consult the fleet server's own reservedBy record so
        // a server-side reservation made by other means (not this ledger) is
        // still caught. Best-effort: a failure to reach listMembers must not
        // block the local-ledger check above from still protecting the launch.
        if (typeof listMembers === 'function') {
            try {
                const raw = await listMembers();
                const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.members) ? raw.members : []);
                for (const m of list) {
                    if (!m || typeof m !== 'object') continue;
                    if (m.name && m.reservedBy && requestSet.has(m.name)) {
                        addConflict(m.reservedBy, m.name);
                    }
                }
            } catch {
                // Non-fatal: fall through with whatever the local ledger
                // already found. The server-side check is defense in depth on
                // top of the ledger, not a replacement for it.
            }
        }

        if (conflictsBySprint.size > 0) {
            const conflicts = [...conflictsBySprint.entries()]
                .map(([sprintId, members]) => ({ sprintId, members: [...members].sort() }))
                .sort((a, b) => a.sprintId.localeCompare(b.sprintId));
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
 * apra-fleet-gey.2: default build-version stamp -- this module's own on-disk
 * mtime. This package runs directly from source (no separate compiled
 * artifact, no reliable package.json version bump per fix), and api.mjs IS
 * where the launch/relaunch logic this gate protects lives, so its mtime is
 * a fast, dependency-free proxy for "has the code changed since this process
 * started". Deliberately fs.statSync(), NOT a subprocess (e.g. `git
 * rev-parse HEAD`) -- this runs on every controller creation AND every
 * launch(), and a spawned subprocess there measurably added contention under
 * concurrent test/supervisor boots. Called ONCE at controller creation
 * (captures what this RUNNING process was started from) and again on every
 * launch() (reads what's on disk RIGHT NOW) -- see createSprintController()'s
 * `stampedBuildVersion` below. Returns `null` (never throws) when the file is
 * unreadable, so a stamp failure only skips the stale-build warning, it never
 * blocks a launch.
 * @returns {string|null}
 */
export function defaultBuildVersion() {
    try {
        return `${statSync(API_MODULE_PATH).mtimeMs}`;
    } catch {
        return null;
    }
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
 *     spawnSprint: (opts: object) => Promise<{ pid: number, port: number, args?: string[], logPath?: string }>,
 *     getLiveEntry?: (pid: number) => { port: number, logPath?: string }|undefined,
 *   },
 *   history?: {
 *     latestFor: (id: string) => object|undefined,
 *     forSprint: (id: string) => object[],
 *     latestForIssueRoot?: (issue: string) => object|undefined,
 *   },
 *   listMembers: () => Promise<object|object[]>|object|object[],
 *   getBacklog: () => Promise<any>|any,
 *   proxyState?: (port: number) => Promise<object>,
 *   proxyStop?: (port: number) => Promise<object>,
 *   resolvePort?: (pid: number|null) => number|undefined,
 *   hasTerminalState?: (sprintId: string, branch: string|null) => object|null,
 *     apra-fleet-2l4.1: defaults to watchdog.mjs's defaultHasTerminalState()
 *     (a pure on-disk read of the engine's own persisted old_runs/<runId>.json
 *     terminal record). getSprint()/stopSprint() consult this BEFORE
 *     resolvePort()/proxyState()/proxyStop() -- a persisted terminal state can
 *     exist while the child's OS process is still alive in its post-terminal
 *     dashboard-linger window (its embedded HTTP viewer server closes before
 *     the process itself exits), a window PID-liveness-based resolvePort()
 *     cannot see on its own and would otherwise proxy into a closed port
 *     (ECONNREFUSED surfacing as a raw 500). Inject to stub without real fs
 *     reads in tests.
 *   beforeLaunch?: (ctx: { members: string[], issueRoots: string[] }) => Promise<void>|void,
 *     Defaults to defaultMemberOverlapGuard(ledger) (eft.5.2): rejects with a
 *     409 ApiError on any member overlap with an active reservation. Inject to
 *     override or compose (e.g. with the eft.5.3 issue-scope guard).
 *   generateSprintId?: (issue: string) => string,
 *   resolveRoleMap?: (raw: string|undefined) => Promise<object|undefined>,
 *   getBuildVersion?: () => string|null,
 *     apra-fleet-gey.2: defaults to defaultBuildVersion() (this module's own
 *     on-disk mtime via fs.statSync() -- deliberately NOT a `git rev-parse
 *     HEAD` subprocess; see defaultBuildVersion()'s own doc comment for why).
 *     Called once at controller creation to stamp what this process is
 *     running, and again on every launch() to read what's on disk now --
 *     see launch()'s buildVersionWarning below.
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
    const history = deps.history ?? { latestFor: () => undefined, forSprint: () => [], latestForIssueRoot: () => undefined };
    const listMembers = deps.listMembers ?? (() => ({ members: [] }));
    const getBacklog = deps.getBacklog ?? (() => ({ tasks: [] }));
    const proxyState = deps.proxyState ?? proxyChildState;
    const proxyStop = deps.proxyStop ?? proxyChildStop;
    const roleMapResolver = deps.resolveRoleMap ?? resolveRoleMap;
    // eft.5.2: the default beforeLaunch is the all-or-nothing member-axis
    // overlap guard (409 on conflict), not a no-op. Callers may still inject
    // their own beforeLaunch (e.g. to compose it with the eft.5.3 issue-scope
    // guard) -- this default is what runs when nothing is injected.
    const beforeLaunch = deps.beforeLaunch ?? defaultMemberOverlapGuard(ledger, listMembers);
    const generateSprintId = deps.generateSprintId ?? ((issue) => `${issue}-${randomUUID()}`);
    const resolvePort = deps.resolvePort
        ?? ((pid) => (pid != null && spawner.getLiveEntry ? spawner.getLiveEntry(pid)?.port : undefined));
    // apra-fleet-2l4.1: same collaborator watchdog.mjs's classifySprint() uses
    // to distinguish CRASHED from FINISHED -- reused here so getSprint()/
    // stopSprint() can detect "already terminal" independently of PID
    // liveness, before ever touching the child's viewer port.
    const hasTerminalState = deps.hasTerminalState ?? defaultHasTerminalState;
    const getBuildVersion = deps.getBuildVersion ?? defaultBuildVersion;
    // apra-fleet-gey.2: stamped ONCE, at controller creation (supervisor
    // startup) -- deliberately never re-read afterward, so this stays "what
    // code this running process was actually started from", distinct from
    // launch()'s own re-read of getBuildVersion() for "what's on disk now".
    const stampedBuildVersion = getBuildVersion();

    /** Validate a launch request against the SHARED runner.js helpers. */
    function validateLaunchRequest(body) {
        const rawIssue = body.issue ?? body.target_issue;
        const branch = body.branch;
        const base = body.base ?? body.base_branch;
        const members = normalizeMembers(body.members);

        // apra-fleet-ymf.1: `issue` may be a single id OR a comma-separated
        // list of ids (mirroring bin/cli.mjs:468's --issue flag / runner.js's
        // targetIssues), so it is split and EACH id validated individually
        // rather than passing the whole raw string to validateIssueId (whose
        // ISSUE_ID_PATTERN has no comma in its charset and would 400 the
        // entire multi-root request). When the split yields nothing (missing,
        // non-string, empty, whitespace-only, or comma-only input),
        // validateIssueId(rawIssue) is called directly on the ORIGINAL value
        // so the error text for those edge cases is byte-identical to the
        // pre-fix single-id behavior.
        const issueIds = splitIssueIds(rawIssue);
        if (issueIds.length === 0) {
            try { validateIssueId(rawIssue); }
            catch (err) { throw new ApiError(400, err.message, 'issue'); }
            // validateIssueId only throws on a falsy/malformed value, so an
            // empty split with a value it accepts should be unreachable --
            // guarded anyway so a launch can never proceed with zero roots.
            throw new ApiError(400, `[Arg Contract] issue must contain at least one id, got "${rawIssue}".`, 'issue');
        }
        for (const id of issueIds) {
            try { validateIssueId(id); }
            catch (err) { throw new ApiError(400, err.message, 'issue'); }
        }
        try { validateBranchName(branch, 'branch'); }
        catch (err) { throw new ApiError(400, err.message, 'branch'); }
        try { validateBranchName(base, 'base'); }
        catch (err) { throw new ApiError(400, err.message, 'base'); }
        if (members.length === 0) {
            throw new ApiError(400, 'members must be a non-empty list of member names', 'members');
        }
        // `issue` stays a single comma-joined string (the exact shape
        // buildSprintArgv/cli.mjs's --issue flag expects, and byte-identical
        // to the input for the single-id case); `issueIds` is the split array
        // callers use for issueRoots / per-root history lookups.
        return { issue: issueIds.join(','), issueIds, branch, base, members };
    }

    // -- GET /api/members : list_members + live-reservation overlay -----------
    // apra-fleet-eft.26.2 (Hole 2): the overlay now surfaces BOTH reservation
    // sources -- this supervisor's own ledger (local launches) AND the fleet
    // server's own `reservedBy` record already present on each raw member
    // (e.g. set by a workflow/cli-launched sprint via `member_reservation`,
    // apra-fleet-eft.26.1, which never touches this ledger at all). The local
    // ledger wins when both are present (it is this supervisor's own,
    // most-specific knowledge); the server record is the fallback so a
    // member reserved by some OTHER means is still shown as reserved here,
    // not silently reported as free.
    async function members() {
        const raw = await listMembers();
        const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.members) ? raw.members : []);
        // member name -> sprintId that reserves it (first LOCAL reservation wins).
        const reservedBy = new Map();
        for (const r of ledger.list()) {
            for (const m of (r.members ?? [])) {
                if (!reservedBy.has(m)) reservedBy.set(m, r.sprintId);
            }
        }
        return {
            members: list.map((m) => {
                const base = typeof m === 'string' ? { name: m } : { ...m };
                const sid = reservedBy.get(base.name) ?? base.reservedBy ?? null;
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
        const { issue, issueIds, branch, base, members } = validateLaunchRequest(body);
        const rawRoleMap = body.roleMap === undefined
            ? undefined
            : (typeof body.roleMap === 'string' ? body.roleMap : JSON.stringify(body.roleMap));
        const roleMap = await roleMapResolver(rawRoleMap);
        const union = memberUnion(members, roleMap);
        // apra-fleet-ymf.1: issueRoots is the SPLIT array of individual ids
        // (never the raw comma-joined string) -- the same shape the CLI path
        // already feeds runner.js's targetIssues, and what the ledger schema,
        // history.latestForIssueRoot(), and the eft.5.3 issue-scope overlap
        // guard all expect: one root id per array entry, not one entry
        // holding every root joined together.
        const issueRoots = issueIds;

        // apra-fleet-gey.2 (extended by ymf.1 for multi-root requests): gate
        // this relaunch on the prior incarnation's terminal record, BEFORE
        // the member-overlap guard/spawn -- a deterministic, unaddressed
        // prior failure (e.g. the engine's own BEADS_SYNC_CONFLICT, or a
        // gey.1 LAUNCH_FAILED fast-exit) will almost certainly recur on an
        // identical relaunch, so there is no reason to burn a
        // spawn/reservation attempt re-hitting it. Checked per-root (in
        // request order) since a multi-root request's ledger history is keyed
        // by INDIVIDUAL root ids, not the joined string -- the first root
        // with a deterministic prior terminal record gates the whole launch.
        // The request's `overrideRelaunchGate: true` is the documented,
        // explicit escape hatch -- never a silent bypass.
        let priorTerminal;
        let priorTerminalRoot;
        if (typeof history.latestForIssueRoot === 'function') {
            for (const root of issueRoots) {
                const found = history.latestForIssueRoot(root);
                if (found && isDeterministicTerminalReason(found)) {
                    priorTerminal = found;
                    priorTerminalRoot = root;
                    break;
                }
            }
        }
        if (priorTerminal && body.overrideRelaunchGate !== true) {
            const namedReason = priorTerminal.terminalReason ?? priorTerminal.reason ?? priorTerminal.event;
            throw new ApiError(
                409,
                `relaunch of '${priorTerminalRoot}' refused: its prior incarnation ('${priorTerminal.sprintId}') ended with ` +
                `'${namedReason}', which is treated as deterministic and unaddressed -- pass ` +
                `overrideRelaunchGate: true to relaunch anyway.`,
                'issue',
            );
        }

        // eft.5.2 seam: reject overlapping launches (409) BEFORE spawning a child.
        await beforeLaunch({ members: union, issueRoots });

        // apra-fleet-k7b.1: generate the sprintId BEFORE spawning (not after,
        // as before) so it can be forwarded into the child's own argv as
        // --run-id (buildSprintArgv) -- the SAME incarnation-unique id this
        // ledger reservation uses, so the engine's run-state and the ledger
        // agree on one identity for this launch instead of the child falling
        // back to reusing the (relaunch-shared) branch name.
        const sprintId = generateSprintId(issue);

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
            runId: sprintId,
        };
        const spawned = await spawner.spawnSprint(spawnOpts);
        // apra-fleet-gey.2: best-effort stale-process detection -- compare
        // the build this supervisor process STAMPED at startup against
        // what's on disk RIGHT NOW. A mismatch means code changed after this
        // process started (the apra-fleet-bnb-e828ded6 incident: a relaunch
        // re-hit an already-fixed-on-disk bug because it ran against the
        // stale pre-fix process) -- reported here, never blocking, since the
        // launch itself is not wrong, only worth a supervisor restart first.
        const currentBuildVersion = getBuildVersion();
        const buildVersionWarning = (stampedBuildVersion != null && currentBuildVersion != null && stampedBuildVersion !== currentBuildVersion)
            ? `running supervisor build (${stampedBuildVersion}) differs from the on-disk build (${currentBuildVersion}) -- ` +
              `if code changed after this process started, restart the supervisor before relying on this relaunch.`
            : null;
        // apra-fleet-3i3.2: persist enough launch metadata (branch/base/goal,
        // alongside the two reservation axes already claimed here) that a
        // future Restart control can reconstruct this exact POST /api/sprints
        // request without operator re-entry. `goal` normalizes `undefined`
        // (the "no goal supplied" case validateLaunchRequest/buildSprintArgv
        // already treat as omitted) to `null`, matching how the ledger treats
        // a pre-existing entry that predates this field.
        // apra-fleet-ou7.1: spawner.spawnSprint() always opens a per-sprint
        // raw stdout/stderr log file before spawning -- record its path on
        // the SAME claim() call that sets childPid, so a dashboard/consumer
        // reading the ledger can find it for a live OR crashed sprint alike.
        // apra-fleet-k7b.2: also record the launch branch on the reservation --
        // hasTerminalState()'s legacy fallback needs it as a lookup key for
        // reservations claimed before k7b.1's run-id plumbing shipped.
        await ledger.claim(sprintId, {
            members: union,
            issueRoots,
            childPid: spawned.pid,
            logPath: spawned.logPath,
            branch,
            base,
            goal: body.goal ?? null,
        });

        return {
            sprintId,
            pid: spawned.pid,
            port: spawned.port,
            logPath: spawned.logPath,
            issueRoots,
            members: union,
            goal: body.goal ?? null,
            buildVersionWarning,
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
            // apra-fleet-2l4.1: check FIRST whether the engine has already
            // persisted a terminal run-state for this sprint (old_runs/
            // <runId>.json) -- independent of PID liveness, so a child in its
            // post-terminal dashboard-linger window (OS process still alive,
            // but its embedded HTTP viewer server has already closed) is
            // reported cleanly here instead of proxying into a closed port
            // and surfacing a raw ECONNREFUSED-derived 500.
            const terminalState = hasTerminalState(id, reservation.branch ?? null);
            if (terminalState) {
                return { sprintId: id, live: false, terminal: true, state: terminalState };
            }
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
        // apra-fleet-2l4.1: same terminal-state check as getSprint() above,
        // BEFORE resolving/proxying the child's viewer port -- a persisted
        // terminal run-state means there is genuinely nothing left to stop,
        // even while the child's OS process is still alive in its
        // post-terminal dashboard-linger window. Returns a clean no-op
        // success instead of a doomed proxyStop() call against an
        // already-closed port (previously surfaced as a raw 500
        // ECONNREFUSED -- apra-fleet-2l4).
        const terminalState = hasTerminalState(id, reservation.branch ?? null);
        if (terminalState) {
            return { sprintId: id, status: 'already-terminal', child: null };
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
