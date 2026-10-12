// =============================================================================
// GET /ui/projects -- the real project-folder page (apra-fleet-i9ag.17.2.2)
// =============================================================================
//
// Replaces the /ui placeholder at exactly ONE manifest-declared path
// (./manifest.mjs's PROJECTS_UI_PATH), via the staticHandler seam
// ./ui-placeholder.mjs documents: bin/serve.mjs's ONE registerUiRoutes()
// call site swaps createProjectsPageHandler()'s return value in as that
// override. Every OTHER placeholder path -- including the two-segment
// /ui/panels/git, which a single-level pattern route cannot match -- is
// delegated straight to ui-placeholder.mjs's own defaultPlaceholderHandler,
// unchanged.
//
// SCOPE: a single-folder setting (M1), not M2 project management -- no
// list, create, delete, or member binding. The sprint bug states full
// project management stays M2; the multi-project CRUD domain already at
// /api/projects (src/projects/routes/projects.mjs) is untouched by this
// page.
//
// DATA SOURCE: the guarded GET/POST /api/project route
// (../supervisor/project-route.mjs, apra-fleet-i9ag.17.2.1) built in the
// sibling task. This page renders no server-side state of its own -- it is
// a thin client-side script that calls that route.
//
// AUTH: this page is served under /ui, which requiresAuth() deliberately
// leaves UNGUARDED (../supervisor/auth.mjs) -- so the page itself must never
// embed or echo the bearer token, and an unauthenticated view sets NO
// cookie (apra-fleet-50j6.6). It shares ../supervisor/dashboard-session.mjs
// with the GET / index route: the paste-token sign-in form POSTs the token
// (in the body, never a URL -- apra-fleet-50j6.12) to /signin, which sets an
// HttpOnly `se_token` cookie carrying a DERIVED value (never the raw
// token), which the browser then attaches automatically to this page's own
// same-origin fetch('/api/project') calls.
//
// MOUNT-AWARE FETCH TARGETS: this page is reached either directly (the
// supervisor's own origin) or through the console's /ext/<id>/* reverse
// proxy (src/console/proxy.ts). resolveMountPrefix()/mountHref()
// (../supervisor/mount-prefix.mjs) compute the same per-request prefix
// dashboard.mjs already relies on, so this page's one inline fetch() target
// resolves correctly in both cases with zero special-casing here.
// mountHref()'s output is limited to a documented-safe character allowlist
// (see mount-prefix.mjs's own header), which is what makes interpolating it
// straight into a single-quoted JS string literal below safe without a
// second escaping layer.
// =============================================================================

import { PROJECTS_UI_PATH } from './manifest.mjs';
import { defaultPlaceholderHandler } from './ui-placeholder.mjs';
import { resolveMountPrefix, mountHref } from '../supervisor/mount-prefix.mjs';
import { handleTokenInUrl, authNoticeHtml, injectAuthNotice } from '../supervisor/dashboard-session.mjs';
import { THEME_CSS } from '../supervisor/theme.mjs';

function sendHtml(res, status, html, extraHeaders = {}) {
    const body = Buffer.from(html, 'utf-8');
    res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': body.length,
        ...extraHeaders,
    });
    res.end(body);
}

/**
 * The page body. All dynamic content (the current folder/source/beads-db
 * state, and any server-rejected message) is fetched and rendered
 * client-side via `.textContent` (never `.innerHTML`), so nothing this
 * module embeds server-side needs HTML-escaping except the already-
 * allowlisted `apiHref`.
 * @param {{ mountPrefix: string }} args
 * @returns {string}
 */
function renderProjectsPageHtml({ mountPrefix }) {
    const apiHref = mountHref(mountPrefix, '/api/project');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Projects</title>
<style>
${THEME_CSS}
body { padding: 24px; overflow-y: auto; }
h1 { font-size: 20px; font-weight: 600; margin-bottom: 16px; }
dl { margin-bottom: 24px; }
dt { color: var(--text-muted); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 8px; }
dd { color: var(--text); margin-top: 2px; }
label { display: block; color: var(--text-muted); font-size: 13px; margin-bottom: 8px; }
input[type="text"] { background: var(--bg-glass); border: 1px solid var(--border); color: var(--text); padding: 6px 12px; border-radius: 4px; font-size: 13px; width: 100%; max-width: 480px; margin-bottom: 12px; }
button { padding: 6px 16px; font-size: 13px; border-radius: 4px; border: none; cursor: pointer; font-weight: 600; background: var(--accent); color: var(--text); }
button:hover { opacity: 0.8; }
#message { margin-top: 12px; font-size: 13px; }
</style>
</head>
<body>
<h1>Project folder</h1>
<dl>
  <dt>Current</dt>
  <dd id="current-value">loading...</dd>
  <dt>Source</dt>
  <dd id="current-source">-</dd>
  <dt>Beads DB</dt>
  <dd id="current-beads">-</dd>
</dl>
<form id="save-form">
  <label for="path-input">New project folder (or its .beads directory)</label>
  <input id="path-input" name="projectDir" type="text" autocomplete="off">
  <button type="submit">Save</button>
</form>
<p id="message" role="status"></p>
<script>
(function () {
  var apiHref = '${apiHref}';
  var currentValueEl = document.getElementById('current-value');
  var currentSourceEl = document.getElementById('current-source');
  var currentBeadsEl = document.getElementById('current-beads');
  var messageEl = document.getElementById('message');
  var inputEl = document.getElementById('path-input');
  var formEl = document.getElementById('save-form');

  function renderCurrent(data) {
    if (!data || typeof data.projectDir !== 'string' || data.projectDir === '') {
      currentValueEl.textContent = 'none configured -- enter a project folder below and save';
      currentSourceEl.textContent = '-';
      currentBeadsEl.textContent = '-';
      return;
    }
    currentValueEl.textContent = data.projectDir;
    currentSourceEl.textContent = data.source || 'unknown';
    currentBeadsEl.textContent = data.hasBeadsDb ? 'found' : 'not found';
  }

  function load() {
    fetch(apiHref)
      .then(function (res) {
        if (!res.ok) throw new Error('failed to load (status ' + res.status + ')');
        return res.json();
      })
      .then(renderCurrent)
      .catch(function (err) {
        // A failure to reach the guarded API degrades only this page's
        // display, never a thrown/unhandled error -- there is no second
        // surface here to protect.
        currentValueEl.textContent = 'unknown (could not reach the supervisor: ' + err.message + ')';
        currentSourceEl.textContent = '-';
        currentBeadsEl.textContent = '-';
      });
  }

  formEl.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var value = inputEl.value;
    messageEl.textContent = 'saving...';
    fetch(apiHref, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectDir: value })
    })
      .then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (result) {
        if (!result.ok) {
          // Rejected: the displayed CURRENT value is left untouched --
          // renderCurrent() is deliberately not called here.
          messageEl.textContent = 'rejected: ' + (result.body && result.body.error ? result.body.error : 'unknown error');
          return;
        }
        renderCurrent(result.body);
        inputEl.value = '';
        messageEl.textContent = (result.body && result.body.note) || 'saved';
      })
      .catch(function (err) {
        messageEl.textContent = 'save failed: ' + err.message;
      });
  });

  load();
})();
</script>
</body>
</html>
`;
}

/**
 * Builds the `staticHandler` override for `registerUiRoutes()`
 * (./ui-placeholder.mjs): the real page at exactly PROJECTS_UI_PATH,
 * `defaultPlaceholderHandler` for every other manifest-declared path.
 *
 * @param {{ token?: string|null|(() => string|null|undefined) }} [deps]
 *   `token` is the supervisor's own shared bearer token, or a provider of it
 *   (`() => supervisor.token`; null when auth was never configured) -- used
 *   only to decide whether to show the sign-in form; never embedded in the
 *   HTML/script body or a cookie.
 * @returns {(req: any, res: any, ctx: any) => Promise<void>}
 */
export function createProjectsPageHandler(deps = {}) {
    // A provider function is read per request, so the page follows the
    // supervisor's LIVE token (server.mjs re-resolves it) instead of a
    // startup snapshot.
    const token = typeof deps.token === 'function'
        ? deps.token
        : (typeof deps.token === 'string' && deps.token.length > 0 ? deps.token : null);

    return async function projectsPageHandler(req, res, ctx) {
        const pathname = ctx && ctx.url ? ctx.url.pathname : null;
        if (pathname !== PROJECTS_UI_PATH) {
            return defaultPlaceholderHandler(req, res, ctx);
        }
        // apra-fleet-50j6.12: a `?token=` in the URL is refused (400, no
        // cookie); a plain view sets NO cookie and shows the paste-token
        // sign-in form, which posts to the supervisor's POST /signin.
        if (handleTokenInUrl(req, res, token)) return;
        const mountPrefix = resolveMountPrefix(req);
        const html = renderProjectsPageHtml({ mountPrefix });
        sendHtml(res, 200, injectAuthNotice(html, authNoticeHtml(req, token)));
    };
}
