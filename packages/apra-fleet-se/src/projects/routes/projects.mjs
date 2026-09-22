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

/** The Dolt-backed beads sync ref every remote probe checks for. */
const DOLT_DATA_REF = 'refs/dolt/data';

/**
 * Probe a beads remote via `git ls-remote <remote> refs/dolt/data`, run on
 * `member` through the injected fleet client. DQ-12: this only READS whether
 * the remote exists and is reachable -- it never creates one.
 *
 * @param {{ executeCommand: (opts: {command: string, member_name: string}) => Promise<any> }} client
 * @param {string} member
 * @param {string} remote
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function probeBeadsRemote(client, member, remote) {
    const command = `git ls-remote ${remote} ${DOLT_DATA_REF}`;
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
            const project = createProject(db, body);
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
}
