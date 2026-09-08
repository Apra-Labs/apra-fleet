// Coordination clients for fleet-sprint: the supervisor-owned global dolt
// push mutex, the global child-id allocator, and the fleet server's own
// per-member reservation ledger (apra-fleet-3swo.4.3). Moved verbatim out of
// runner.js -- runner.js re-exports every symbol it previously exported from
// this region, so existing importers of fleet-sprint/runner.js resolve
// unchanged.
//
// Every client here speaks a coordination surface that is EXTERNAL to this
// process (a supervisor HTTP route, the fleet MCP server's own tools, or
// both) and is implemented INLINE rather than imported from its
// server-side counterpart, because runner.js (and this module alongside it)
// is copied verbatim next to the shipped bundle and loaded via
// engine.executeFile(), never bundled -- a cross-package relative import
// would not resolve in the shipped layout.
//
// `sprintId`/`sprint_id` on every client here is the SAME opaque sprint-
// identity token (derived in runner.js from the sprint's branch name, see
// sprintMutexId) -- it is passed through verbatim by every client below,
// never re-derived, reformatted, prefixed or namespaced, so a dispatch and
// the reservation/mutex/allocator calls that gate it always agree on who
// "this sprint" is.

import { resultText } from './mcp-result.mjs';
import { MemberReservationResumeError } from './errors.mjs';

/**
 * Child-side HTTP client for the supervisor-owned global dolt push mutex
 * (src/supervisor/dolt-mutex.mjs). The mutex object lives in the always-on
 * supervisor process, but each detached sprint child runs in its OWN process
 * and can only reach it over HTTP. Speaks the routes
 * registerDoltMutexRoutes() exposes:
 *
 *   POST {serviceUrl}/api/dolt-push-mutex/{sprintId}/acquire  body { pid }
 *   POST {serviceUrl}/api/dolt-push-mutex/{sprintId}/release  body { token }
 *
 * The acquire route long-polls -- it does not answer until this sprint
 * genuinely owns the mutex (FIFO after every earlier waiter) -- so a resolved
 * acquire() means this child holds it and no sibling sprint is pushing.
 *
 * Implemented INLINE rather than imported from src/supervisor/dolt-mutex.mjs
 * because runner.js is copied verbatim next to the bundle and loaded via
 * engine.executeFile(), never bundled -- a cross-package relative import would
 * not resolve in the shipped layout. The { acquire, release } surface is
 * exactly what doltPushAfter() calls.
 *
 * @param {{ serviceUrl: string, sprintId: string, fetch?: typeof fetch, log?: Function }} opts
 * @returns {{ acquire: (sprintId: string, o?: { pid?: number|null }) => Promise<{ token: string|null }>, release: (token: string|null) => Promise<boolean> }}
 */
export function createHttpDoltPushMutexClient(opts = {}) {
    const base = String(opts.serviceUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('createHttpDoltPushMutexClient requires a serviceUrl');
    const boundSprintId = opts.sprintId;
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new Error('createHttpDoltPushMutexClient requires a fetch implementation (Node >=18 global fetch or an injected one)');
    }
    const log = opts.log ?? (() => {});
    const routeFor = (sprintId, action) =>
        `${base}/api/dolt-push-mutex/${encodeURIComponent(sprintId)}/${action}`;

    async function postJson(url, body) {
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
        });
        if (!res || !res.ok) {
            const status = res ? res.status : 'no-response';
            throw new Error(`[dolt-mutex] ${url} returned HTTP ${status}`);
        }
        return res.json();
    }

    return {
        async acquire(sprintId, o = {}) {
            const id = sprintId || boundSprintId;
            if (!id) throw new Error('[dolt-mutex] acquire requires a sprintId');
            const payload = await postJson(routeFor(id, 'acquire'), { pid: o.pid ?? null });
            return { token: payload.token ?? null, sprintId: payload.sprintId, expiresAt: payload.expiresAt };
        },
        async release(token) {
            if (token == null) return true;
            const id = boundSprintId;
            if (!id) throw new Error('[dolt-mutex] release requires a bound sprintId');
            try {
                const payload = await postJson(routeFor(id, 'release'), { token });
                return Boolean(payload.released);
            } catch (err) {
                // Non-fatal: the holder's lease expiry will reclaim the mutex
                // even if this release never lands. Surface it for diagnostics.
                log(`[dolt-mutex] release failed (non-fatal; lease will expire): ${err.message}`);
                return false;
            }
        },
        // Lease renewal (docs/dolt-sync-redesign.md Part 3.4): doltPushAfter()
        // renews on an interval while it holds the mutex, so a legitimately
        // long hold (push + reconcile + settle) is never force-evicted by the
        // supervisor's 60s lease expiry while this sprint is still pushing.
        async renew(token) {
            if (token == null) return false;
            const id = boundSprintId;
            if (!id) throw new Error('[dolt-mutex] renew requires a bound sprintId');
            try {
                const payload = await postJson(routeFor(id, 'renew'), { token });
                return Boolean(payload.renewed);
            } catch (err) {
                log(`[dolt-mutex] renew failed (non-fatal; the lease may expire): ${err.message}`);
                return false;
            }
        },
    };
}

/**
 * Child-side HTTP client for the supervisor-owned global child-id allocator
 * (src/supervisor/id-allocator.mjs), used by the orchestrator's bead-creation
 * path. Without a single minting authority, two sprints that each `bd create
 * --parent X` in their own dolt clone independently derive the SAME next child
 * id and their D-pushes hard-conflict; with it, each creator gets an EXPLICIT
 * distinct id passed to `bd create --id <childId>`, so the creates target
 * different rows. Speaks the routes registerIdAllocatorRoutes() exposes:
 *
 *   POST {serviceUrl}/api/child-id-allocator/{parentId}/allocate  body { pid, sprintId, floor }
 *   POST {serviceUrl}/api/child-id-allocator/confirm              body { token }
 *   POST {serviceUrl}/api/child-id-allocator/release              body { token }
 *
 * Implemented INLINE for the same shipped-layout reason as the dolt push mutex
 * client above. The { allocate, confirm, release } surface is exactly what the
 * bead-creation path calls.
 *
 * @param {{ serviceUrl: string, sprintId?: string, fetch?: typeof fetch, log?: Function }} opts
 * @returns {{ allocate: Function, confirm: Function, release: Function }}
 */
export function createHttpChildIdAllocatorClient(opts = {}) {
    const base = String(opts.serviceUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('createHttpChildIdAllocatorClient requires a serviceUrl');
    const boundSprintId = opts.sprintId;
    const fetchImpl = opts.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new Error('createHttpChildIdAllocatorClient requires a fetch implementation (Node >=18 global fetch or an injected one)');
    }
    const log = opts.log ?? (() => {});

    async function postJson(url, body) {
        const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
        });
        if (!res || !res.ok) {
            const status = res ? res.status : 'no-response';
            throw new Error(`[id-allocator] ${url} returned HTTP ${status}`);
        }
        return res.json();
    }

    return {
        async allocate(parentId, o = {}) {
            if (!parentId) throw new Error('[id-allocator] allocate requires a parentId');
            const url = `${base}/api/child-id-allocator/${encodeURIComponent(parentId)}/allocate`;
            const payload = await postJson(url, {
                pid: o.pid ?? null,
                sprintId: o.sprintId ?? boundSprintId ?? null,
                floor: o.floor,
            });
            return { childId: payload.childId ?? null, seq: payload.seq, token: payload.token ?? null, expiresAt: payload.expiresAt };
        },
        async confirm(token) {
            if (token == null) return true;
            try {
                const payload = await postJson(`${base}/api/child-id-allocator/confirm`, { token });
                return Boolean(payload.confirmed);
            } catch (err) {
                // Non-fatal: the reservation's lease expiry reclaims it even if
                // this confirm never lands. Surface it for diagnostics.
                log(`[id-allocator] confirm failed (non-fatal; lease will expire): ${err.message}`);
                return false;
            }
        },
        async release(token) {
            if (token == null) return true;
            try {
                const payload = await postJson(`${base}/api/child-id-allocator/release`, { token });
                return Boolean(payload.released);
            } catch (err) {
                log(`[id-allocator] release failed (non-fatal; lease will expire): ${err.message}`);
                return false;
            }
        },
    };
}

/**
 * Shared MCP tool-result-to-JSON parser for the two fleet-MCP-hosted
 * coordination clients below. Tool handlers return a JSON STRING wrapped in
 * the standard content[] envelope, so both clients need the same
 * extract-then-parse step.
 * @param {any} result
 * @param {string} label
 * @returns {object}
 */
function parseCoordinationToolResult(result, label) {
    let text = result;
    if (typeof text !== 'string') {
        text = (result && Array.isArray(result.content) && result.content[0] && typeof result.content[0].text === 'string')
            ? result.content[0].text
            : '';
    }
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        throw new Error(`${label} returned a non-JSON response: ${String(text).slice(0, 200) || '(empty)'}`);
    }
    if (payload && payload.error) throw new Error(`${label} error: ${payload.error}`);
    return payload ?? {};
}

/**
 * MCP-transport counterpart to createHttpDoltPushMutexClient above, for the
 * SUPERVISOR-LESS topology: a standalone/detached-binary CLI launch has no
 * supervisor to reach, so `--service-url` is absent and the HTTP client cannot
 * be built, but the launcher always holds a connected MCP client to the shared
 * fleet HTTP singleton, making the fleet server's own `dolt_push_mutex` tool
 * (src/tools/dolt-push-mutex.ts) the reachable coordination point.
 *
 * Ticketed acquire, not long-poll: an MCP tool call cannot block indefinitely,
 * so `acquire` waits a bounded slice per call and then RE-POLLS the same
 * ticket. The server keeps the waiter enqueued across polls, preserving FIFO
 * order (a cancel-and-retry loop would send every timed-out waiter to the back
 * of the queue). The caller's real pid is threaded through so a crashed holder
 * is reclaimed by the server's dead-pid probe rather than wedging the mutex.
 *
 * Implemented INLINE for the same shipped-layout reason as the HTTP clients
 * above.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, sprintId?: string, waitMs?: number, timeoutMs?: number, log?: Function }} opts
 * @returns {{ acquire: Function, release: Function }}
 */
export function createMcpDoltPushMutexClient(opts = {}) {
    const { callTool, sprintId: boundSprintId, log = () => {} } = opts;
    if (typeof callTool !== 'function') throw new Error('createMcpDoltPushMutexClient requires a callTool function');
    const waitMs = Number.isFinite(opts.waitMs) && opts.waitMs > 0 ? opts.waitMs : 5000;
    // Overall ceiling on how long a single acquire may keep re-polling before
    // giving up (a wedged peer is bounded by the server-side lease anyway).
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 15 * 60 * 1000;

    async function call(args) {
        return parseCoordinationToolResult(await callTool('dolt_push_mutex', args), '[dolt-mutex/mcp]');
    }

    return {
        async acquire(sprintId, o = {}) {
            const id = sprintId || boundSprintId;
            if (!id) throw new Error('[dolt-mutex/mcp] acquire requires a sprintId');
            const deadline = Date.now() + timeoutMs;
            let payload = await call({ action: 'acquire', sprint_id: id, pid: o.pid ?? undefined, wait_ms: waitMs });
            while (!payload.granted) {
                if (Date.now() >= deadline) {
                    try { await call({ action: 'cancel', ticket: payload.ticket }); } catch { /* best effort */ }
                    throw new Error(`[dolt-mutex/mcp] timed out after ${timeoutMs} ms waiting for the push mutex (sprint '${id}')`);
                }
                log(`[dolt-mutex/mcp] waiting for the global push mutex (sprint '${id}', ticket ${payload.ticket})`);
                payload = await call({ action: 'poll', ticket: payload.ticket, wait_ms: waitMs });
            }
            return { token: payload.token ?? null, sprintId: id, expiresAt: payload.expiresAt };
        },
        async release(token) {
            if (token == null) return true;
            try {
                const payload = await call({ action: 'release', token });
                return Boolean(payload.released);
            } catch (err) {
                // Non-fatal: the holder's lease expiry reclaims the mutex even
                // if this release never lands (same posture as the HTTP client).
                log(`[dolt-mutex/mcp] release failed (non-fatal; lease will expire): ${err.message}`);
                return false;
            }
        },
        // Same lease-renewal contract as the HTTP client above (design doc
        // Part 3.4); the fleet tool exposes action 'renew'.
        async renew(token) {
            if (token == null) return false;
            try {
                const payload = await call({ action: 'renew', token });
                return Boolean(payload.renewed);
            } catch (err) {
                log(`[dolt-mutex/mcp] renew failed (non-fatal; the lease may expire): ${err.message}`);
                return false;
            }
        },
    };
}

/**
 * MCP-transport counterpart to createHttpChildIdAllocatorClient above, for the
 * SUPERVISOR-LESS topology. Speaks the fleet server's own
 * `child_id_allocator` tool (src/tools/child-id-allocator.ts); same rationale,
 * same inline-implementation constraint, and the same { allocate, confirm,
 * release } surface the bead-creation path already calls.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, sprintId?: string, log?: Function }} opts
 * @returns {{ allocate: Function, confirm: Function, release: Function }}
 */
export function createMcpChildIdAllocatorClient(opts = {}) {
    const { callTool, sprintId: boundSprintId, log = () => {} } = opts;
    if (typeof callTool !== 'function') throw new Error('createMcpChildIdAllocatorClient requires a callTool function');

    async function call(args) {
        return parseCoordinationToolResult(await callTool('child_id_allocator', args), '[id-allocator/mcp]');
    }

    return {
        async allocate(parentId, o = {}) {
            if (!parentId) throw new Error('[id-allocator/mcp] allocate requires a parentId');
            const payload = await call({
                action: 'allocate',
                parent_id: parentId,
                pid: o.pid ?? undefined,
                sprint_id: o.sprintId ?? boundSprintId ?? undefined,
                floor: o.floor,
            });
            return { childId: payload.childId ?? null, seq: payload.seq, token: payload.token ?? null, expiresAt: payload.expiresAt };
        },
        async confirm(token) {
            if (token == null) return true;
            try {
                const payload = await call({ action: 'confirm', token });
                return Boolean(payload.confirmed);
            } catch (err) {
                log(`[id-allocator/mcp] confirm failed (non-fatal; lease will expire): ${err.message}`);
                return false;
            }
        },
        async release(token) {
            if (token == null) return true;
            try {
                const payload = await call({ action: 'release', token });
                return Boolean(payload.released);
            } catch (err) {
                log(`[id-allocator/mcp] release failed (non-fatal; lease will expire): ${err.message}`);
                return false;
            }
        },
    };
}

/**
 * Reserves and releases every sprint member against the fleet server's OWN
 * per-member reservation record (the `member_reservation` tool), so that a
 * sprint launched directly from the CLI -- never routed through the
 * supervisor, and so absent from its ledger -- is still visible to
 * execute_prompt's dispatch-time reservedBy check and to the supervisor's
 * overlap guard.
 *
 * `callTool` is injected (the caller's MCP client) so this stays
 * transport-agnostic and unit-testable without a live fleet server.
 * Deliberately NOT built on the supervisor's HTTP routes, unlike the
 * dolt-mutex/id-allocator clients above: `member_reservation` lives on the
 * fleet MCP server every launch path already connects to, whereas the
 * supervisor is optional and unwired for direct CLI launches.
 *
 * `sprintId` should be the SAME opaque identity used for the dolt push mutex
 * and child-id allocator -- opaque and target-agnostic, with no assumption
 * about which repo the sprint develops.
 *
 * Reserve/release are BEST-EFFORT per member: a failure (transport error, or
 * the tool's own "already reserved by X" rejection) is logged and does NOT
 * throw. That is safe because execute_prompt independently rejects any
 * dispatch to a member this sprint failed to reserve, so an unreserved member
 * fails loudly at its first dispatch rather than silently interleaving with
 * another sprint.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, members?: string[], sprintId?: string, log?: Function }} opts
 * @returns {{ reserveAll: () => Promise<void>, releaseAll: () => Promise<void> }}
 */
export function createMemberReservationClient(opts = {}) {
    const { callTool, members = [], sprintId, log = () => {} } = opts;
    const active = typeof callTool === 'function' && typeof sprintId === 'string' && sprintId.length > 0 && members.length > 0;

    // Returns { ok, text } rather than throwing so BOTH the best-effort callers
    // (reserveAll/releaseAll, which ignore the outcome) and the owner-checked
    // resume caller (reReserveForResume, which MUST know per-member whether the
    // reserve was granted or rejected) can share one call path. `ok` is false
    // on a tool rejection ("already reserved by X") OR a transport throw; the
    // caller decides what a failure means for its own contract.
    async function callFor(action, member) {
        try {
            const result = await callTool('member_reservation', { member_name: member, action, sprint_id: sprintId });
            const text = resultText(result);
            if ((result && result.isError) || text.startsWith('[-]')) {
                log(`[member-reservation] ${action} rejected for member '${member}': ${text || '(no detail)'}`);
                return { ok: false, text };
            }
            return { ok: true, text };
        } catch (err) {
            log(`[member-reservation] ${action} failed for member '${member}' (non-fatal; execute_prompt's dispatch-time reservedBy check still applies): ${err.message}`);
            return { ok: false, text: err.message };
        }
    }

    async function releaseAll() {
        if (!active) return;
        for (const member of members) await callFor('release', member);
    }

    return {
        async reserveAll() {
            if (!active) return;
            for (const member of members) await callFor('reserve', member);
        },
        releaseAll,

        // (apra-fleet-p2to.4.2) Pause hand-back: release EVERY member so a
        // different sprint may claim it while this one is parked at a
        // cooperative pause. Best-effort per member, exactly like releaseAll()
        // -- a pause must never fail on a release hiccup, and execute_prompt's
        // dispatch-time reservedBy check still fails loudly on any member this
        // sprint later dispatches to without holding.
        //
        // (apra-fleet-p2to.4.4.1) releaseForPause() is intentionally the SAME
        // operation as releaseAll() -- both release every member,
        // best-effort, with no distinct behavior of their own -- so this
        // calls straight through to releaseAll() rather than keeping a
        // byte-identical second copy of the loop to drift out of sync. The
        // two names stay separate call sites (not aliased) because they mean
        // different things to a caller even though today they do the same
        // work: this is intended to change independently if a pause hand-back
        // ever needs behavior releaseAll() should not have (e.g. skipping a
        // member expected back imminently).
        releaseForPause: releaseAll,

        // (apra-fleet-p2to.4.2) Resume re-acquire, OWNER-CHECKED: re-reserve
        // every member released at pause. A member is "unavailable" when its
        // reserve is rejected -- another sprint claimed it while we were paused,
        // so it is no longer ours. We refuse to silently continue on top of a
        // member some other sprint now owns: collect every unavailable member
        // and, if any, fail the resume with a single clean error that NAMES
        // them (MemberReservationResumeError) so the operator knows exactly what
        // to free before retrying the resume.
        //
        // Every successfully re-acquired member then runs `resyncMember` (git
        // fetch + decideEnsureBranchAction probe + bd dolt pull) UNCONDITIONALLY
        // before any work continues -- while paused, origin and the beads DB can
        // have moved (another sprint, a human push), so the re-sync is never
        // gated on a "looks unchanged" heuristic.
        //
        // @param {{ resyncMember?: (member: string) => Promise<void> }} [opts]
        // @returns {Promise<{ reacquired: string[] }>}
        async reReserveForResume({ resyncMember } = {}) {
            if (!active) return { reacquired: [] };
            const reacquired = [];
            const unavailable = [];
            for (const member of members) {
                const res = await callFor('reserve', member);
                if (res.ok) reacquired.push(member);
                else unavailable.push(member);
            }
            if (unavailable.length > 0) {
                // Hand back the ones we DID re-grab so a failed resume does not
                // leave this sprint holding a partial, unusable reservation set
                // that blocks the very members another operator may need to free
                // up the unavailable ones. Best-effort -- the resume is failing
                // regardless.
                for (const member of reacquired) await callFor('release', member);
                throw new MemberReservationResumeError(unavailable);
            }
            if (typeof resyncMember === 'function') {
                for (const member of reacquired) await resyncMember(member);
            }
            return { reacquired };
        },
    };
}
