// =============================================================================
// /api/projects route module (apra-fleet-972p.4.1)
// =============================================================================
//
// `registerProjectRoutes(supervisor, { store, client })` registers the
// /api/projects CRUD endpoints over the existing `route()` table
// (../../supervisor/server.mjs). NOT called from bin/serve.mjs yet -- wiring
// the mount is 972p.4.2's job, alongside its own round-trip test coverage.
//
// Collaborators
// -------------
// `store` is an OPEN supervisor.sqlite handle -- the shape ../store/db.mjs's
// `openStore()` returns (`{ db, path, version, applied, close }`). This
// module calls the ../store/projects.mjs repository functions directly
// against `store.db`; it does not open, migrate, or close the connection
// itself.
//
// `client` is a fleet MCP client exposing `executeCommand({command,
// member_name})` -- the SAME shape `fleetApi.executeCommand()` already
// returns elsewhere in this package (`{isError, content:[{text}],
// structuredContent:{exitCode, stdout, stderr}}`); see
// ../../supervisor/fleet-members.mjs's `executeFleetCommand()` and
// bin/cli.mjs's `runProbe()` for the established unwrap pattern this reuses,
// so there is one shape for "did a fleet-run command succeed", not several.
//
// Member binding + overview (apra-fleet-vcnl.1.1)
// ------------------------------------------------
// Four more endpoints live here, all delegating to ../projects.mjs: POST /:id/
// members (bind), DELETE /:id/members/:member (unbind), POST /:id/members/
// :member/refresh (re-probe) and GET /:id/overview (the wireframe-W2 read
// model). They are registered INSIDE registerProjectRoutes on purpose -- the
// mount in bin/serve.mjs stays a single call, so adding an endpoint here never
// costs a serve.mjs edit. The related health/git-drawer endpoints get the same
// treatment one level down, via ./git.mjs (called at the end of this function).
//
// The constructor contract did NOT widen for them: registerProjectRoutes still
// requires only `client.executeCommand`, and the bind-specific client methods
// (listMembers/memberOwner/updateMember/memberGitStatus) are checked
// per-request, answering 501 client-missing-method. See
// missingClientMethod()'s own note for why that is per-request rather than at
// construction.
//
// DQ-12 (the console never creates remotes)
// ------------------------------------------
// When a create payload's `beads.remote` is supplied, `create` PROBES it with
// `git ls-remote <remote> refs/dolt/data` run on the project's
// `backlogMember` via `client.executeCommand` -- it never runs `git remote
// add` or otherwise creates anything server- or member-side. A failed probe
// (a non-zero exit, an MCP-level error, or a transport failure) 400s the
// whole create on field `beads.remote` before any row is written. A project
// with no remote (a purely local beads dir -- see ../store/projects.mjs's
// own header doc) skips the probe entirely; there is nothing to verify.
// =============================================================================

import {
    StoreValidationError,
    createProject,
    getProject,
    listProjects,
    updateProject,
    deleteProject,
} from '../store/projects.mjs';
import { readJsonBody, sendJson } from '../../supervisor/server.mjs';
import {
    ProjectBindError,
    bindMember,
    unbindMember,
    refreshMember,
    buildOverview,
    listBoundMembers,
    parseMemberList,
} from '../projects.mjs';
import {
    addCheckout,
    suggestCheckoutName,
    originSlugFromUrl,
    quoteArg,
    shellMetaCharError,
} from '../checkout.mjs';
import { registerGitRoutes } from './git.mjs';

/** The Dolt-backed beads sync ref every remote probe checks for. */
const DOLT_DATA_REF = 'refs/dolt/data';

/**
 * The target member's own listMembers record, or null when the client has no
 * `listMembers` method, the call throws, or the member is not (yet) found.
 * `probeBeadsRemote`'s command runs ON `member`, so `quoteArg` below must
 * branch on THAT member's registered shell rather than assume POSIX
 * (apra-fleet-vcnl.15). A missing/failing `listMembers` is tolerated as a
 * `null` record: `registerProjectRoutes`'s constructor contract requires only
 * `executeCommand` (see this module's own header), so a caller wired before
 * `listMembers` existed still gets a working probe -- `quoteArg(value, null)`
 * defaults to POSIX quoting -- rather than a thrown TypeError.
 *
 * @param {{ listMembers?: (opts: {format: string}) => Promise<any> }} client
 * @param {string} member
 * @returns {Promise<object | null>}
 */
async function resolveMemberRecord(client, member) {
    if (typeof client.listMembers !== 'function') return null;
    try {
        const records = parseMemberList(await client.listMembers({ format: 'json' }));
        return records.find((r) => r && r.name === member) ?? null;
    } catch {
        return null;
    }
}

/**
 * Probe a beads remote via `git ls-remote <remote> refs/dolt/data`, run on
 * `member` through the injected fleet client. DQ-12: this only READS whether
 * the remote exists and is reachable -- it never creates one.
 *
 * `remote` is caller-supplied (a create/update request body's `beads.remote`,
 * or a stored project row's own value) and reaches a command string bound to
 * a fleet member, so it goes through the same two-layer policy
 * ../checkout.mjs's module header establishes: `shellMetaCharError` screens
 * it at the edge FIRST (a shell metacharacter refuses with zero
 * `executeCommand` calls, never a dispatched command), then `quoteArg` quotes
 * it unconditionally, branching on `member`'s own registered shell via
 * `resolveMemberRecord` above rather than assuming POSIX (apra-fleet-vcnl.15
 * -- this call site predates apra-fleet-vcnl.12's hardening of
 * ../checkout.mjs and ../health.mjs and was left unquoted then).
 *
 * @param {{ executeCommand: (opts: {command: string, member_name: string}) => Promise<any>, listMembers?: Function }} client
 * @param {string} member
 * @param {string} remote
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function probeBeadsRemote(client, member, remote) {
    const remoteError = shellMetaCharError(remote, 'remote');
    if (remoteError) {
        return { ok: false, error: remoteError };
    }
    const record = await resolveMemberRecord(client, member);
    const command = `git ls-remote ${quoteArg(remote, record)} ${DOLT_DATA_REF}`;
    let res;
    try {
        res = await client.executeCommand({ command, member_name: member });
    } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
    }
    const text = res && res.content && res.content[0] ? res.content[0].text : '';
    if (res && res.isError) {
        return { ok: false, error: text || 'unknown error' };
    }
    const exitCode = res && res.structuredContent && typeof res.structuredContent.exitCode === 'number'
        ? res.structuredContent.exitCode
        : 0;
    if (exitCode !== 0) {
        return { ok: false, error: text || `git ls-remote exited ${exitCode}` };
    }
    return { ok: true };
}

/** A 400 JSON payload for a `StoreValidationError`: `{error, errors, field, reason}`. */
function validationErrorPayload(err) {
    return { error: err.message, errors: err.errors, field: err.field, reason: err.reason };
}

/**
 * The shared `beads.remote` gate (DQ-12): format-checks `remote`, requires a
 * non-empty `backlogMember` to probe it on, and probes it via
 * `probeBeadsRemote()`. Used by POST (create) and PUT (972p.5) so both paths
 * shape the same 400 body on a failed/misconfigured probe.
 *
 * @param {{ executeCommand: (opts: {command: string, member_name: string}) => Promise<any> }} client
 * @param {{ remote: unknown, backlogMember: unknown }} opts
 * @returns {Promise<{ ok: true } | { ok: false, status: number, payload: object }>}
 */
export async function checkBeadsRemote(client, { remote, backlogMember } = {}) {
    if (typeof remote !== 'string' || remote.trim().length === 0) {
        return { ok: true };
    }
    if (typeof backlogMember !== 'string' || backlogMember.trim().length === 0) {
        const err = new StoreValidationError([
            { field: 'backlogMember', reason: 'must be a non-empty string (required to probe beads.remote)' },
        ]);
        return { ok: false, status: 400, payload: validationErrorPayload(err) };
    }
    const probe = await probeBeadsRemote(client, backlogMember, remote);
    if (!probe.ok) {
        return {
            ok: false,
            status: 400,
            payload: {
                error: `beads.remote probe failed on member '${backlogMember}': ${probe.error}`,
                field: 'beads.remote',
                reason: probe.error,
            },
        };
    }
    return { ok: true };
}

/** Whether `err` is the node:sqlite PRIMARY KEY / UNIQUE violation on `projects.id`. */
function isUniqueViolation(err) {
    return typeof err?.message === 'string' && /UNIQUE constraint failed/i.test(err.message);
}

/**
 * The first of `methods` the client does not implement, or null when it
 * implements all of them.
 *
 * The CONSTRUCTOR contract is deliberately narrower than what the bind routes
 * need: `registerProjectRoutes` requires only `executeCommand` (see its own
 * doc), so a caller wired before member_owner/member_git_status existed still
 * gets a working CRUD surface. The extra methods are therefore checked
 * per-REQUEST, and a request that needs one the client lacks answers 501
 * `client-missing-method` naming the method -- a precise, actionable answer,
 * versus the TypeError-at-construction alternative that would take the whole
 * /api/projects surface down for every caller.
 *
 * @param {object} client
 * @param {string[]} methods
 * @returns {string | null}
 */
function missingClientMethod(client, methods) {
    for (const method of methods) {
        if (typeof client?.[method] !== 'function') return method;
    }
    return null;
}

/**
 * Register the /api/projects CRUD endpoints against a supervisor
 * (../../supervisor/server.mjs's `route()` table).
 *
 * @param {{ route: (method: string, path: string, handler: Function) => void }} supervisor
 * @param {{ store: { db: any }, client: { executeCommand: Function } }} deps
 */
export function registerProjectRoutes(supervisor, deps = {}) {
    const { store, client } = deps;
    if (!store || !store.db) {
        throw new TypeError('registerProjectRoutes requires a store with an open db handle');
    }
    if (!client || typeof client.executeCommand !== 'function') {
        throw new TypeError('registerProjectRoutes requires a client with an executeCommand() method');
    }
    const db = store.db;

    // -- POST /api/projects : validate, probe beads.remote (DQ-12), create ---
    supervisor.route('POST', '/api/projects', async (req, res) => {
        const body = (await readJsonBody(req)) ?? {};
        const remoteCheck = await checkBeadsRemote(client, {
            remote: body?.beads?.remote,
            backlogMember: body.backlogMember,
        });
        if (!remoteCheck.ok) {
            sendJson(res, remoteCheck.status, remoteCheck.payload);
            return;
        }
        try {
            // Strip createdAt (and updatedAt) from the request body before
            // delegating to createProject(): that store function now accepts
            // an explicit createdAt so bin/se.mjs's importProject() can
            // restore a project's ORIGINAL creation time on a fresh-store
            // import (apra-fleet-vcnl.8), but an HTTP client is untrusted --
            // it must not be able to spoof a project's creation timestamp
            // through this route.
            const { createdAt, updatedAt, ...safeBody } = body;
            const project = createProject(db, safeBody);
            sendJson(res, 201, project);
        } catch (err) {
            if (err instanceof StoreValidationError) {
                sendJson(res, 400, validationErrorPayload(err));
                return;
            }
            if (isUniqueViolation(err)) {
                sendJson(res, 409, { error: `project already exists: '${body.id}'`, field: 'id' });
                return;
            }
            throw err;
        }
    });

    // -- GET /api/projects : list every project -------------------------------
    supervisor.route('GET', '/api/projects', async (req, res) => {
        sendJson(res, 200, { projects: listProjects(db) });
    });

    // -- GET /api/projects/:id : fetch one, 404 if unknown ---------------------
    supervisor.route('GET', '/api/projects/:id', async (req, res, ctx) => {
        const project = getProject(db, ctx.params.id);
        if (!project) {
            sendJson(res, 404, { error: `no project '${ctx.params.id}'` });
            return;
        }
        sendJson(res, 200, project);
    });

    // -- PUT /api/projects/:id : patch, 404 if unknown, 400 on bad fields ------
    // DQ-12 (972p.5): a patch that CHANGES beads.remote to a new non-empty
    // value is probed the same way create is, via the shared checkBeadsRemote
    // gate -- an absent or unchanged remote skips the probe (no network round
    // trip for an unrelated rename), and a failed probe 400s before
    // updateProject() ever runs, so the stored row is left untouched.
    supervisor.route('PUT', '/api/projects/:id', async (req, res, ctx) => {
        const body = (await readJsonBody(req)) ?? {};
        const existing = getProject(db, ctx.params.id);
        if (existing) {
            const beadsPatch = body?.beads ?? {};
            const hasRemote = Object.prototype.hasOwnProperty.call(beadsPatch, 'remote');
            const nextRemote = beadsPatch.remote;
            const remoteChanged = hasRemote
                && typeof nextRemote === 'string' && nextRemote.trim().length > 0
                && nextRemote !== existing.beads.remote;
            if (remoteChanged) {
                const backlogMember = Object.prototype.hasOwnProperty.call(body, 'backlogMember')
                    ? body.backlogMember : existing.backlogMember;
                const remoteCheck = await checkBeadsRemote(client, { remote: nextRemote, backlogMember });
                if (!remoteCheck.ok) {
                    sendJson(res, remoteCheck.status, remoteCheck.payload);
                    return;
                }
            }
        }
        try {
            const project = updateProject(db, ctx.params.id, body);
            sendJson(res, 200, project);
        } catch (err) {
            if (err instanceof StoreValidationError) {
                sendJson(res, 400, validationErrorPayload(err));
                return;
            }
            if (err && err.code === 'ERR_PROJECT_NOT_FOUND') {
                sendJson(res, 404, { error: err.message });
                return;
            }
            throw err;
        }
    });

    // -- DELETE /api/projects/:id : delete, 404 if unknown ---------------------
    supervisor.route('DELETE', '/api/projects/:id', async (req, res, ctx) => {
        const deleted = deleteProject(db, ctx.params.id);
        if (!deleted) {
            sendJson(res, 404, { error: `no project '${ctx.params.id}'` });
            return;
        }
        sendJson(res, 200, { deleted: true, id: ctx.params.id });
    });

    // == Member binding + overview (apra-fleet-vcnl.1.1) =====================
    //
    // The four endpoints over ../projects.mjs. Each one: (1) 501s early when
    // the injected client lacks a method it needs, (2) delegates the whole
    // decision to the domain module, and (3) translates a ProjectBindError's
    // `status`/payload verbatim. No status code is decided twice -- the domain
    // module owns "what went wrong", this layer owns only "as HTTP".
    // ------------------------------------------------------------------------

    /**
     * Run `fn`, mapping a ProjectBindError onto its own status/payload.
     * Anything else rethrows to handleRequest's 500, which is correct: an
     * unclassified failure here is a bug, not an operator-actionable answer.
     */
    async function withBindErrors(res, fn) {
        try {
            await fn();
        } catch (err) {
            if (err instanceof ProjectBindError) {
                sendJson(res, err.status, err.toPayload());
                return;
            }
            throw err;
        }
    }

    /** 501s and returns true when `client` lacks any of `methods`. */
    function guardClient(res, methods) {
        const method = missingClientMethod(client, methods);
        if (method === null) return false;
        sendJson(res, 501, { error: 'client-missing-method', method });
        return true;
    }

    // -- POST /api/projects/:id/members : bind one member ---------------------
    supervisor.route('POST', '/api/projects/:id/members', async (req, res, ctx) => {
        if (guardClient(res, ['listMembers', 'memberOwner', 'updateMember', 'memberGitStatus'])) return;
        const body = (await readJsonBody(req)) ?? {};
        if (typeof body.member !== 'string' || body.member.trim().length === 0) {
            sendJson(res, 400, { error: 'invalid body', field: 'member', reason: 'must be a non-empty string' });
            return;
        }
        if (body.beadsDir !== undefined && (typeof body.beadsDir !== 'string' || body.beadsDir.trim().length === 0)) {
            sendJson(res, 400, { error: 'invalid body', field: 'beadsDir', reason: 'must be a non-empty string when given' });
            return;
        }
        await withBindErrors(res, async () => {
            const row = await bindMember({ db, client }, ctx.params.id, {
                member: body.member,
                beadsDir: body.beadsDir,
            });
            sendJson(res, 200, row);
        });
    });

    // -- DELETE /api/projects/:id/members/:member : unbind one member ---------
    supervisor.route('DELETE', '/api/projects/:id/members/:member', async (req, res, ctx) => {
        if (guardClient(res, ['listMembers', 'memberOwner', 'updateMember'])) return;
        await withBindErrors(res, async () => {
            const result = await unbindMember({ db, client }, ctx.params.id, ctx.params.member);
            sendJson(res, 200, result);
        });
    });

    // -- POST /api/projects/:id/members/:member/refresh : re-probe one member -
    supervisor.route('POST', '/api/projects/:id/members/:member/refresh', async (req, res, ctx) => {
        if (guardClient(res, ['memberGitStatus'])) return;
        await withBindErrors(res, async () => {
            const row = await refreshMember({ db, client }, ctx.params.id, ctx.params.member);
            sendJson(res, 200, row);
        });
    });

    // -- GET /api/projects/:id/overview : the W2 read model -------------------
    // Cache read by default. `?refresh=1` re-probes every bound member FIRST,
    // sequentially and fault-tolerantly: one member's probe failure is already
    // recorded as a probe-failed warning on its own row by refreshMember, so
    // it must not abort the remaining members -- a single unreachable machine
    // would otherwise make the whole panel unrefreshable.
    supervisor.route('GET', '/api/projects/:id/overview', async (req, res, ctx) => {
        if (guardClient(res, ['listMembers'])) return;
        const wantsRefresh = ctx.url && ctx.url.searchParams.get('refresh') === '1';
        if (wantsRefresh && guardClient(res, ['memberGitStatus'])) return;
        await withBindErrors(res, async () => {
            if (wantsRefresh && getProject(db, ctx.params.id)) {
                for (const member of listBoundMembers(db, ctx.params.id)) {
                    try {
                        await refreshMember({ db, client }, ctx.params.id, member);
                    } catch (err) {
                        console.error(`[projects] overview refresh failed for member '${member}' on project '${ctx.params.id}': ${err && err.message ? err.message : err}`);
                    }
                }
            }
            sendJson(res, 200, await buildOverview({ db, client }, ctx.params.id));
        });
    });

    // == Add checkout on a machine (apra-fleet-vcnl.2, DQ-16 / A10) ==========
    //
    // Two more endpoints delegating to ../checkout.mjs. Reuses guardClient/
    // withBindErrors above -- addCheckout throws the SAME ProjectBindError
    // shape the bind routes do, translated the same way.
    // ------------------------------------------------------------------------

    // -- GET /api/projects/:id/checkouts/suggest : DQ-16 name suggestion ------
    supervisor.route('GET', '/api/projects/:id/checkouts/suggest', async (req, res, ctx) => {
        const project = getProject(db, ctx.params.id);
        if (!project) {
            sendJson(res, 404, { error: `no project '${ctx.params.id}'` });
            return;
        }
        const sibling = ctx.url ? ctx.url.searchParams.get('sibling') : null;
        const origin = ctx.url ? ctx.url.searchParams.get('origin') : null;
        if (!sibling || !origin) {
            sendJson(res, 400, { error: 'invalid query', reason: "'sibling' and 'origin' query params are required" });
            return;
        }
        const roleHint = (ctx.url && ctx.url.searchParams.get('roleHint')) || undefined;
        const name = suggestCheckoutName({
            projectId: ctx.params.id,
            machineMember: sibling,
            originSlug: originSlugFromUrl(origin),
            roleHint,
        });
        sendJson(res, 200, { name });
    });

    // -- POST /api/projects/:id/checkouts : the five-step A10 flow ------------
    // 200 {name, steps} when every step is done/skipped, 422 with the same
    // body when a step failed (the request was understood but the flow could
    // not complete), 400 on bad input, 404 unknown project (both raised by
    // addCheckout itself as a ProjectBindError).
    supervisor.route('POST', '/api/projects/:id/checkouts', async (req, res, ctx) => {
        const body = (await readJsonBody(req)) ?? {};
        const methods = ['listMembers', 'memberDetail', 'memberGitStatus', 'executeCommand', 'registerMember', 'memberOwner', 'updateMember'];
        if (body.provisionVcs) methods.push('provisionVcsAuth');
        if (body.provisionLlm) methods.push('provisionLlmAuth');
        if (body.composePermissions) methods.push('composePermissions');
        if (guardClient(res, methods)) return;

        await withBindErrors(res, async () => {
            const result = await addCheckout({ db, client }, ctx.params.id, body);
            const allOk = result.steps.every((s) => s.status === 'done' || s.status === 'skipped');
            sendJson(res, allOk ? 200 : 422, result);
        });
    });

    // The health / git-drawer seam: routes added in ./git.mjs are mounted by
    // this single call, so that feature needs no edit here and none in
    // bin/serve.mjs. See ./git.mjs's header.
    registerGitRoutes(supervisor, { store, client });
}
