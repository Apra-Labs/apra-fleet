// =============================================================================
// /api/projects git + health route module (apra-fleet-vcnl.1.1 skeleton)
// =============================================================================
//
// `registerGitRoutes(supervisor, {store, client})` is the mount point for the
// health-panel and git-drawer endpoints (screens S5 health / S10, wireframe
// W3). It is deliberately EMPTY right now.
//
// Why an empty module instead of no module
// -----------------------------------------
// ./projects.mjs's `registerProjectRoutes` already calls this at the end of
// its own registration, and bin/serve.mjs wires only `registerProjectRoutes`.
// So the health/git-drawer feature adds its routes HERE and they are mounted
// the moment they exist -- with no edit to routes/projects.mjs and no edit to
// bin/serve.mjs, which is the whole point of the seam. A follow-on feature
// that had to touch both files to add one route would make every concurrent
// track on this area conflict over the same two lines.
//
// Same collaborators as registerProjectRoutes
// --------------------------------------------
// `store` is an OPEN supervisor.sqlite handle (`{db, ...}` from
// ../store/db.mjs's `openStore()`) and `client` is a fleet MCP client. This
// module does not open, migrate, or close the connection. Deps are validated
// by the caller, not re-validated here: `registerProjectRoutes` has already
// thrown on a bad store/client before it reaches this call, and re-checking
// would let this skeleton reject a client the caller accepted.
// =============================================================================

/**
 * Register the project health / git-drawer endpoints against a supervisor
 * (../../supervisor/server.mjs's `route()` table).
 *
 * @param {{ route: (method: string, path: string, handler: Function) => void }} supervisor
 * @param {{ store: { db: any }, client: object }} [deps]
 * @returns {void}
 */
export function registerGitRoutes(supervisor, deps = {}) {
    // Intentionally no routes yet -- see the module header. Referencing the
    // parameters keeps the contract visible (and linters quiet) without
    // pretending to validate what the caller already validated.
    void supervisor;
    void deps;
}
