// =============================================================================
// GET /api/owner-refs -- known owner references for this workflow package
// (apra-fleet-g6ap.2.2)
// =============================================================================
//
// Consulted by the apra-fleet server's checkOwnerRef() (src/services/workflow-packages.ts,
// src/tools/member-owner.ts) with the derived per-package credential, to
// validate an `owner.ref` naming one of THIS package's own projects.
//
// Backed by src/projects/store/projects.mjs's listProjects() over the
// supervisor.sqlite store (src/projects/store/db.mjs). `store` is the whole
// openStore()-shaped handle ({db, path, version, applied, close}), matching
// src/projects/routes/projects.mjs's registerProjectRoutes() convention, so
// bin/serve.mjs can hand the SAME opened store to both route modules.
//
// A store that could not be opened (no node:sqlite on this Node runtime,
// see db.mjs's NodeSqliteUnavailableError) answers 503 -- NEVER an empty
// `refs: []`, which would wrongly read as "no known refs" rather than "refs
// are unknown right now".
// =============================================================================

import { sendJson } from '../supervisor/server.mjs';
import { listProjects } from '../projects/store/projects.mjs';

/**
 * Register `GET /api/owner-refs`.
 *
 * @param {{ route: Function }} supervisor
 * @param {{ store?: { db: object } | null }} deps `store` is the openStore()
 *   handle, or omitted/null when the store could not be opened.
 */
export function registerOwnerRefsRoute(supervisor, { store } = {}) {
    supervisor.route('GET', '/api/owner-refs', async (req, res) => {
        if (!store || !store.db) {
            sendJson(res, 503, { error: 'store-unavailable' });
            return;
        }
        const projects = listProjects(store.db);
        const refs = projects.map((p) => ({ id: p.id, name: p.name }));
        sendJson(res, 200, { refs });
    });
}
