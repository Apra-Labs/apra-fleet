// =============================================================================
// GET /ui and GET /ui/* -- placeholder page (apra-fleet-g6ap.3.1)
// =============================================================================
//
// Until the UI-bundle sprint lands, /ui answers a minimal static page instead
// of 404ing -- so the shell's iframe (registered via this package's manifest,
// see registration/manifest.mjs's nav entries) has somewhere to point. /ui
// stays OUTSIDE the /api guard (supervisor/auth.mjs's requiresAuth() only
// matches the /api/ prefix and POST .../live/ sub-routes), so this page is
// reachable with no token.
//
// `registerUiRoutes(supervisor, {staticHandler})` takes an optional
// `staticHandler` override (same (req, res, ctx) signature as any other
// route handler) so the later UI-bundle sprint can swap in its real
// static-file serving by changing its ONE call site in bin/serve.mjs,
// without touching this registration call or server.mjs's routing table
// again.
//
// server.mjs's route() only matches a `:param` against exactly one path
// segment (no multi-segment wildcard), so a single `/ui/:rest` pattern
// route only ever covers one level of sub-path. That is NOT sufficient on
// its own: this same feature's manifest (registration/manifest.mjs) already
// declares a TWO-segment panel path (`/ui/panels/git`), which `/ui/:rest`
// cannot match -- the shell's panel iframe would 404 instead of getting the
// placeholder page.
//
// Fix (apra-fleet-g6ap.11): in addition to the one-level pattern route
// (kept as a convenience fallback for ad hoc single-segment paths), read
// every nav[].path and panels[].path the manifest itself declares via
// buildManifest() and register an EXACT route for each one that the
// one-level pattern does not already cover. buildManifest() only needs a
// non-empty baseUrl to build the object; the placeholder value below is
// never used for anything (routing only reads the .nav/.panels path
// fields), so it never touches the network. This makes coverage a direct
// function of the manifest's OWN declared paths -- of whatever depth --
// instead of a routing-table constant that the manifest can silently
// outrun again the next time a path gains a segment. Exact routes are
// consulted before pattern routes (server.mjs's handleRequest), so this
// never conflicts with the one-level fallback.
// =============================================================================

import { buildManifest } from './manifest.mjs';

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>fleet-supervisor UI</title></head>
<body>
<p>fleet-supervisor UI arrives in a later sprint.</p>
</body>
</html>
`;

/** Never dialed -- buildManifest() only needs a non-empty string to build
 *  the manifest object; this placeholder's `baseUrl` field is discarded,
 *  only its nav[]/panels[] path fields are read below. */
const MANIFEST_PROBE_BASE_URL = 'http://ui-placeholder.invalid';

function sendHtml(res, status, html) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
}

function defaultPlaceholderHandler(req, res) {
    sendHtml(res, 200, PLACEHOLDER_HTML);
}

/** Every path this package's own manifest declares (nav + panels), so the
 *  placeholder can guarantee coverage regardless of how many segments a
 *  future manifest path adds. */
function manifestDeclaredPaths() {
    const manifest = buildManifest({ baseUrl: MANIFEST_PROBE_BASE_URL });
    const nav = Array.isArray(manifest.nav) ? manifest.nav : [];
    const panels = Array.isArray(manifest.panels) ? manifest.panels : [];
    return [...nav, ...panels]
        .map((entry) => entry && entry.path)
        .filter((path) => typeof path === 'string' && path !== '');
}

/**
 * Register GET /ui, GET /ui/:rest (one-level fallback for ad hoc paths),
 * plus an exact route for every nav/panel path the manifest declares --
 * covering any path depth the manifest ever ships, not just one segment.
 *
 * @param {{ route: (method: string, path: string, handler: Function) => void }} supervisor
 * @param {{ staticHandler?: (req: any, res: any, ctx: any) => Promise<void>|void }} [deps]
 */
export function registerUiRoutes(supervisor, { staticHandler } = {}) {
    const handler = typeof staticHandler === 'function' ? staticHandler : defaultPlaceholderHandler;
    supervisor.route('GET', '/ui', handler);
    supervisor.route('GET', '/ui/:rest', handler);
    for (const path of manifestDeclaredPaths()) {
        // Already covered by the one-level pattern above (e.g. /ui/projects).
        if (/^\/ui\/[^/]+$/.test(path)) continue;
        supervisor.route('GET', path, handler);
    }
}
