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
// segment (no multi-segment wildcard) -- this placeholder therefore covers
// the bare page (`/ui`) and one level of sub-path (`/ui/<anything>`, e.g.
// `/ui/projects`). That is sufficient for a placeholder; the real
// static-file handler the UI-bundle sprint supplies replaces both routes'
// behavior wholesale via `staticHandler`, so it is free to serve arbitrarily
// deep paths itself.
// =============================================================================

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>fleet-supervisor UI</title></head>
<body>
<p>fleet-supervisor UI arrives in a later sprint.</p>
</body>
</html>
`;

function sendHtml(res, status, html) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
}

function defaultPlaceholderHandler(req, res) {
    sendHtml(res, 200, PLACEHOLDER_HTML);
}

/**
 * Register GET /ui and GET /ui/:rest.
 *
 * @param {{ route: (method: string, path: string, handler: Function) => void }} supervisor
 * @param {{ staticHandler?: (req: any, res: any, ctx: any) => Promise<void>|void }} [deps]
 */
export function registerUiRoutes(supervisor, { staticHandler } = {}) {
    const handler = typeof staticHandler === 'function' ? staticHandler : defaultPlaceholderHandler;
    supervisor.route('GET', '/ui', handler);
    supervisor.route('GET', '/ui/:rest', handler);
}
