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
// embed or echo the bearer token. It reuses the SAME mechanism
// ../supervisor/dashboard.mjs's GET / index route already established: hand
// the token back as an HttpOnly `se_token` cookie (auth.mjs's
// TOKEN_COOKIE_NAME), which the browser then attaches AUTOMATICALLY to this
// page's own same-origin fetch('/api/project') calls with no script-visible
// credential at all -- auth.mjs's isAuthorized() accepts that cookie as a
// bearer alternative for exactly this reason.
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
import { TOKEN_COOKIE_NAME } from '../supervisor/auth.mjs';

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
<head><meta charset="utf-8"><title>Projects</title></head>
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
 * @param {{ token?: string|null }} [deps] `token` is the supervisor's own
 *   shared bearer token (`supervisor.token`, null when auth was never
 *   configured) -- handed back to the browser as an HttpOnly cookie exactly
 *   once per page load, never embedded in the HTML/script body itself.
 * @returns {(req: any, res: any, ctx: any) => Promise<void>}
 */
export function createProjectsPageHandler(deps = {}) {
    const token = typeof deps.token === 'string' && deps.token.length > 0 ? deps.token : null;

    return async function projectsPageHandler(req, res, ctx) {
        const pathname = ctx && ctx.url ? ctx.url.pathname : null;
        if (pathname !== PROJECTS_UI_PATH) {
            return defaultPlaceholderHandler(req, res, ctx);
        }
        const mountPrefix = resolveMountPrefix(req);
        const html = renderProjectsPageHtml({ mountPrefix });
        const headers = token
            ? { 'set-cookie': `${TOKEN_COOKIE_NAME}=${token}; Path=/; SameSite=Strict; HttpOnly` }
            : {};
        sendHtml(res, 200, html, headers);
    };
}
