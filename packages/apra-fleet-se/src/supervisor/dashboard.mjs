// =============================================================================
// Auto-sprint supervisor -- sprint-stack index dashboard (apra-fleet-eft.6.1,
// Plan Part 2.3)
// =============================================================================
//
// Supervisor serves exactly ONE page at `GET /`. This module renders that
// page's sprint-stack section: one <section> per RUNNING sprint, showing its
// branch, goal, four-status classifier badge (apra-fleet-eft.4.3), claimed
// scope (bead count), claimed members (with roles where known), and an
// open-live-view link. Finished sprints (per the watchdog classifier) are
// excluded from the stack entirely -- they belong in the process-free
// History view (apra-fleet-eft.6.5), not here.
//
// DATA AVAILABILITY NOTE: as of apra-fleet-3i3.2 the reservation ledger
// (eft.5.1, src/supervisor/ledger.mjs) also durably persists `branch`,
// `base`, and `goal` at claim() time (alongside the `members`/`issueRoots`
// axes it always stored) -- a pre-existing on-disk entry written before those
// fields existed simply reads back as null for them, never an error. This
// module still does NOT reach into the ledger's on-disk schema directly for
// `branch`/`goal`: it sources them (and any per-member role map, which the
// ledger still does not persist) from an INJECTED `getSprintMeta(sprintId)`
// collaborator, defaulting to one that reads `branch`/`goal` straight off the
// ledger entry (see createDashboard() below) when the caller does not inject
// its own. Every field the page needs still renders (with an explicit
// "unknown" fallback, never a blank/throw) even when nothing is injected and
// the ledger entry itself predates these fields.
//
// Claimed scope's bead count reuses eft.5.3's live subtree expansion
// (`expandScope()` in ./scope-overlap.mjs) rather than a fresh reimplementation,
// since "how many beads does this sprint currently claim" is exactly the same
// live-expanded-subtree question that module already answers for overlap
// detection.
// =============================================================================

import { escapeHtml } from '@apralabs/apra-fleet-workflow/viewer/html-utils';
import { expandScope, bdListChildren } from './scope-overlap.mjs';
import { WATCHDOG_STATUS } from './watchdog.mjs';
import { renderLaunchFormHtml } from './launch-form.mjs';
import { renderBacklogPanelHtml } from './backlog.mjs';

/**
 * Badge color per four-status classifier value; unknown values fall back to
 * grey. Uses the same `var(--success)`/`var(--warning)`/`var(--danger)`
 * tokens DASHBOARD_CSS defines below (and fleet-sprint's renderBeadsHtml
 * badges already reference) rather than independent hardcoded hex, so a live
 * sprint's health badge and its beads-tree status badges read as one system.
 */
const STATUS_BADGE_COLORS = Object.freeze({
    [WATCHDOG_STATUS.RUNNING_HEALTHY]: 'var(--success)',
    [WATCHDOG_STATUS.RUNNING_UNRESPONSIVE]: 'var(--warning)',
    [WATCHDOG_STATUS.CRASHED]: 'var(--danger)',
    [WATCHDOG_STATUS.FINISHED]: 'var(--text-muted)',
});

/**
 * Renders a status badge. The label is the classifier's status string
 * VERBATIM (acceptance criterion: "badge text matches the four classifier
 * statuses exactly") -- never relabeled/renamed -- so a caller asserting on
 * the literal text 'running-healthy' / 'running-unresponsive' / 'crashed' /
 * 'finished' always finds it.
 * @param {string} status
 * @returns {string}
 */
export function statusBadge(status) {
    const safe = escapeHtml(status || 'unknown');
    const color = STATUS_BADGE_COLORS[status] ?? '#a1a1aa';
    return '<span style="color: ' + color + '; font-weight: bold; font-size: 11px; ' +
        'border: 1px solid ' + color + '; border-radius: 3px; padding: 2px 6px; ' +
        'white-space: nowrap;">' + safe + '</span>';
}

/**
 * Renders one member's chip: `name` alone, or `name (role)` when a role is
 * known for that member.
 * @param {{ name: string, role?: string|null }} member
 * @returns {string}
 */
function memberChip(member) {
    const name = escapeHtml(member.name);
    if (member.role) {
        return '<span style="display:inline-block; margin: 0 6px 4px 0; padding: 1px 6px; ' +
            'border: 1px solid rgba(255,255,255,0.15); border-radius: 3px; font-size: 12px;">' +
            name + ' <span style="color:#a1a1aa;">(' + escapeHtml(member.role) + ')</span></span>';
    }
    return '<span style="display:inline-block; margin: 0 6px 4px 0; padding: 1px 6px; ' +
        'border: 1px solid rgba(255,255,255,0.15); border-radius: 3px; font-size: 12px;">' +
        name + '</span>';
}

/**
 * Renders one running sprint's section.
 * @param {SprintView} view
 * @returns {string}
 */
export function renderSprintSection(view) {
    const sprintId = escapeHtml(view.sprintId);
    const branch = view.branch ? escapeHtml(view.branch) : 'unknown';
    const goal = view.goal ? escapeHtml(view.goal) : 'unknown';
    const beadCount = Number.isInteger(view.beadCount) ? String(view.beadCount) : 'unknown';
    const scopeRoots = (view.issueRoots ?? []).map((id) => escapeHtml(id)).join(', ') || 'none';
    const members = (view.members ?? []);
    const membersHtml = members.length > 0
        ? members.map(memberChip).join('')
        : '<span style="color:#71717a; font-style: italic;">no members recorded</span>';
    // Supervisor-relative path ONLY -- never a bare child port (Plan Part 2.3:
    // bare child-port links leak port allocation and break across hosts).
    const liveHref = '/sprints/' + encodeURIComponent(view.sprintId) + '/live';

    return (
        '<section data-sprint-id="' + sprintId + '" style="border: 1px solid rgba(255,255,255,0.1); ' +
        'border-radius: 6px; padding: 12px 14px; margin-bottom: 12px;">' +
        '<div style="display:flex; align-items:center; gap: 10px; flex-wrap: wrap;">' +
        '<strong style="font-size: 14px;">' + sprintId + '</strong>' +
        statusBadge(view.status) +
        '<a href="' + liveHref + '" target="_blank" rel="noopener" style="margin-left:auto; font-size: 12px;">Open live view</a>' +
        // apra-fleet-3i3.1: kills the still-live child AND releases the
        // member+scope reservation in one action (POST /api/reservations/
        // :sprintId/force-release, extended -- see reconcile.mjs). A plain
        // button (not a form submit) wired up by SPRINT_STOP_SCRIPT below via
        // event delegation on data-sprint-id, matching the Launch Sprint
        // form's formatLaunchError() inline-feedback convention.
        '<button type="button" class="btn btn-secondary btn-stop-sprint" data-sprint-id="' + sprintId + '" ' +
        'style="font-size: 12px;">Stop</button>' +
        '</div>' +
        '<div style="margin-top: 8px; font-size: 13px; color: #d4d4d8;">' +
        '<div><span style="color:#a1a1aa;">Branch:</span> ' + branch + '</div>' +
        '<div><span style="color:#a1a1aa;">Goal:</span> ' + goal + '</div>' +
        '<div><span style="color:#a1a1aa;">Claimed scope:</span> ' + beadCount + ' bead(s) (roots: ' + scopeRoots + ')</div>' +
        '</div>' +
        '<div style="margin-top: 8px;">' +
        '<span style="color:#a1a1aa; font-size: 12px;">Members:</span><br/>' +
        membersHtml +
        '</div>' +
        '<div class="stop-result" data-sprint-id="' + sprintId + '" style="margin-top: 6px; font-size: 12px;"></div>' +
        '</section>'
    );
}

/**
 * Renders the full sprint-stack section: one <section> per running sprint, or
 * an explicit empty-state message when there are none. Never throws on an
 * empty/undefined input -- the page must render correctly with zero running
 * sprints (acceptance criterion).
 * @param {SprintView[]} [views]
 * @returns {string}
 */
export function renderSprintStackHtml(views) {
    const list = Array.isArray(views) ? views : [];
    if (list.length === 0) {
        return '<p style="color:#71717a; font-style: italic;">No sprints are currently running.</p>';
    }
    return list.map(renderSprintSection).join('\n');
}

// apra-fleet supervisor-viewer-parity: the SAME CSS custom-property names and
// header/tab/panel vocabulary as apra-fleet-workflow's per-sprint dashboard
// (packages/apra-fleet-workflow/src/viewer/index.mjs's HTML_TEMPLATE) -- one
// operator moving between "a single sprint's live view" and "the cross-sprint
// supervisor" should not have to re-learn a second visual language. fleet-
// sprint's own beads-tree extension (viewer-extensions.mjs's renderBeadsHtml,
// reused verbatim for the Backlog tab below) already styles its badges via
// `var(--accent)` / `var(--danger)` etc, so defining the SAME tokens here is
// what makes that reuse actually look right, not just share markup shape.
const DASHBOARD_CSS = `
    :root {
      --bg: #09090b; --bg-glass: rgba(24, 24, 27, 0.6); --border: rgba(255, 255, 255, 0.1);
      --text: #e4e4e7; --text-muted: #a1a1aa; --accent: #3b82f6; --accent-glow: rgba(59, 130, 246, 0.2);
      --success: #10b981; --warning: #f59e0b; --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body { background: var(--bg); color: var(--text); font-family: sans-serif; height: 100vh; height: 100dvh; overflow: hidden; display: flex; flex-direction: column; }
    a { color: var(--accent); }
    .header { flex-shrink: 0; display: flex; justify-content: space-between; align-items: center; padding: 12px 24px; background: var(--bg-glass); border-bottom: 1px solid var(--border); }
    .header h1 { font-size: 16px; font-weight: 600; margin: 0; }
    .header-actions { display: flex; gap: 12px; align-items: center; }
    .stats-banner { display: flex; gap: 16px; font-size: 12px; color: var(--text-muted); background: rgba(0,0,0,0.3); padding: 4px 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.05); }
    .stats-banner span strong { color: var(--text); font-weight: 600; }

    .btn { padding: 4px 12px; font-size: 12px; border-radius: 4px; border: none; cursor: pointer; font-weight: 600; transition: opacity 0.2s; }
    .btn:hover { opacity: 0.8; }
    .btn-secondary { background: rgba(255,255,255,0.1); color: var(--text); }

    .main-content { display: flex; flex: 1; overflow: hidden; min-height: 0; }
    .content-area { flex: 1; padding: 20px; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
    .panel { background: var(--bg-glass); border: 1px solid var(--border); border-radius: 6px; display: flex; flex-direction: column; flex: 1; overflow: hidden; min-height: 0; }
    .panel-header { flex-shrink: 0; padding: 10px 16px; font-size: 12px; font-weight: 600; color: var(--text-muted); border-bottom: 1px solid var(--border); background: rgba(255,255,255,0.02); text-transform: uppercase; letter-spacing: 0.5px; }
    .panel-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px; }

    .tab-bar { display: flex; gap: 8px; margin-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px; flex-shrink: 0; }
    .tab-btn { background: transparent; color: var(--text-muted); border: none; padding: 6px 12px; cursor: pointer; border-radius: 4px; font-size: 13px; }
    .tab-btn:hover { background: rgba(255,255,255,0.05); }
    .tab-btn.active { color: #fff; background: rgba(255,255,255,0.1); }
    .tab-content { display: none; }
    .tab-content.active { display: flex; min-height: 0; }

    .bead-row-selected { outline: 2px solid var(--accent); background: var(--accent-glow) !important; }
    table tr:hover { background: rgba(255,255,255,0.03); }
`;

const DASHBOARD_TAB_SCRIPT = `
    function switchTab(id) {
        document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
        event.currentTarget.classList.add('active');
        document.getElementById('tab-' + id).classList.add('active');
    }
`;

/**
 * Renders a POST /api/reservations/:sprintId/force-release error response
 * (reconcile.mjs's ApiError-shaped JSON: `{ error: string }`, e.g. a 404 for
 * an already-gone sprint) as a legible operator-facing message. Mirrors
 * launch-form.mjs's formatLaunchError() pattern exactly (acceptance
 * criterion: "inline success/error feedback consistent with the Launch
 * Sprint form's formatLaunchError() pattern") -- same pure, side-effect-free,
 * `.toString()`-embeddable shape.
 * @param {number} status
 * @param {{ error?: string }|null|undefined} errJson
 * @returns {string}
 */
export function formatStopError(status, errJson) {
    const message = (errJson && typeof errJson.error === 'string' && errJson.error.length > 0)
        ? errJson.error
        : `Stop failed (HTTP ${status}).`;
    if (status === 404) {
        return `Already gone: ${message}`;
    }
    return message;
}

/**
 * The Sprint Stack's per-row Stop button behavior, as a source string ready
 * to inline into a `<script>` tag (same `.toString()`-embedding pattern as
 * launch-form.mjs's clientScriptSource(), so the exact code under test is the
 * exact code shipped to the browser). Event-delegated on `document` (no
 * client-side re-render of the Sprint Stack ever replaces these buttons, so a
 * single delegated listener wired once at page load is sufficient): a click
 * on any `.btn-stop-sprint` button confirms with the operator, then POSTs
 * POST /api/reservations/:sprintId/force-release (extended by apra-fleet-3i3.1
 * to also kill the child), surfacing success/failure INLINE in that row's
 * `.stop-result` element (never a silent no-op, and every promise chain ends
 * in a `.catch()` so a network failure can never surface as an unhandled
 * browser rejection). On success the whole `<section>` is removed from the
 * DOM so the stopped sprint no longer visually claims to still be running.
 */
const SPRINT_STOP_SCRIPT = `
    ${formatStopError.toString()}
    document.addEventListener('click', function (ev) {
        var btn = ev.target.closest('.btn-stop-sprint');
        if (!btn) return;
        var sprintId = btn.getAttribute('data-sprint-id');
        if (!sprintId) return;
        if (!confirm('Stop sprint ' + sprintId + '? This kills its process and releases its reservation.')) return;
        var resultEl = document.querySelector('.stop-result[data-sprint-id="' + sprintId + '"]');
        btn.disabled = true;
        if (resultEl) { resultEl.style.color = '#a1a1aa'; resultEl.textContent = 'Stopping...'; }
        fetch('/api/reservations/' + encodeURIComponent(sprintId) + '/force-release', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reason: 'stopped via Sprint Stack Stop button' }),
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (json) {
                return { status: res.status, json: json };
            });
        }).then(function (r) {
            if (r.status === 200) {
                if (resultEl) { resultEl.style.color = '#22c55e'; resultEl.textContent = 'Stopped.'; }
                var section = btn.closest('section[data-sprint-id]');
                if (section) section.remove();
            } else {
                btn.disabled = false;
                if (resultEl) { resultEl.style.color = '#ef4444'; resultEl.textContent = formatStopError(r.status, r.json); }
            }
        }).catch(function (err) {
            btn.disabled = false;
            if (resultEl) { resultEl.style.color = '#ef4444'; resultEl.textContent = 'Stop request failed: ' + err.message; }
        });
    });
`;

/**
 * Renders the full index page (`GET /` document): a header, then a Sprints
 * tab (Sprint Stack alone) and a separate Backlog tab (eft.6.2's cross-sprint
 * free-set view, followed by the Launch Sprint form -- launching starts from
 * picking rows out of the Backlog, so the two live in the same tab), using
 * the same tab-bar/panel chrome as apra-fleet-workflow's per-sprint viewer
 * (see DASHBOARD_CSS above). `id="sprint-stack"` still renders before
 * `id="backlog"`, which still renders before `id="launch-form"`, in the raw
 * HTML -- callers relying on that ordering (or on `data-bead-id`/`data-
 * sprint-id` markers anywhere in the body) are unaffected by which tab
 * happens to be visually active.
 * @param {SprintView[]} [views]
 * @param {string} [backlogHtml] - pre-rendered Backlog tab content (eft.6.2 / renderBacklogPanelHtml())
 * @param {string} [launchFormHtml] - pre-rendered Launch Sprint form HTML (eft.6.3)
 * @returns {string}
 */
export function renderIndexPageHtml(views, backlogHtml, launchFormHtml) {
    const backlogSection = typeof backlogHtml === 'string'
        ? backlogHtml
        : '<p style="color:var(--text-muted); font-style: italic;">No unclaimed work in the backlog.</p>';
    const launchFormSection = typeof launchFormHtml === 'string' ? launchFormHtml : renderLaunchFormHtml();
    const runningCount = Array.isArray(views) ? views.length : 0;
    return (
        '<!DOCTYPE html>\n' +
        '<html lang="en">\n' +
        '<head>\n' +
        '<meta charset="utf-8"/>\n' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
        '<title>Fleet-Sprint Supervisor</title>\n' +
        '<style>' + DASHBOARD_CSS + '</style>\n' +
        '</head>\n' +
        '<body>\n' +
        '<div class="header">' +
        '<h1>Fleet-Sprint Supervisor</h1>' +
        '<div class="header-actions"><div class="stats-banner"><span><strong>' + runningCount + '</strong> running</span></div></div>' +
        '</div>\n' +
        '<div class="main-content"><div class="content-area">' +
        '<div class="tab-bar" id="tab-bar">' +
        '<button class="tab-btn active" onclick="switchTab(\'sprints\')">Sprints</button>' +
        '<button class="tab-btn" onclick="switchTab(\'backlog\')">Backlog</button>' +
        '</div>\n' +
        '<div id="tab-sprints" class="tab-content active panel">' +
        '<div class="panel-header">Sprint Stack</div>' +
        '<div id="sprint-stack" class="panel-body">\n' + renderSprintStackHtml(views) + '\n</div>' +
        '</div>\n' +
        // Backlog is its own tab (this file's tab restructuring) -- still
        // ALWAYS rendered after the sprint stack in raw document order (the
        // original eft.6.2 acceptance criterion), regardless of which tab a
        // viewer happens to have active. Launch Sprint now lives HERE too
        // (below the backlog table, in the same tab) -- launching starts
        // from picking rows out of the Backlog, so the two belong together;
        // it renders after `id="backlog"` in raw document order.
        '<div id="tab-backlog" class="tab-content panel">' +
        '<div class="panel-header">Backlog</div>' +
        '<div id="backlog" class="panel-body">\n' + backlogSection +
        '\n<div class="panel-header" style="border-top: 1px solid var(--border); margin: 12px -14px -14px; border-radius: 0 0 6px 6px;">Launch Sprint</div>' +
        '<div id="launch-form" style="padding-top: 12px;">\n' + launchFormSection + '\n</div>' +
        '\n</div>' +
        '</div>\n' +
        '</div></div>\n' +
        '<script>' + DASHBOARD_TAB_SCRIPT + '</script>\n' +
        '<script>' + SPRINT_STOP_SCRIPT + '</script>\n' +
        '</body>\n' +
        '</html>\n'
    );
}

/**
 * @typedef {object} SprintView
 * @property {string} sprintId
 * @property {string|null} branch
 * @property {string|null} goal
 * @property {string} status - one of WATCHDOG_STATUS's four values
 * @property {string[]} issueRoots
 * @property {number|null} beadCount
 * @property {Array<{ name: string, role: string|null }>} members
 */

/**
 * Create the dashboard seam (see src/supervisor/server.mjs's seam docs).
 * Builds the list of RUNNING (non-finished) sprint view models from the
 * ledger + watchdog classifier, and renders the index page HTML.
 *
 * @param {{
 *   ledger: {
 *     list: () => Array<{ sprintId: string, members: string[], issueRoots: string[], childPid: number|null }>,
 *     get?: (sprintId: string) => { branch?: string|null, goal?: string|null }|undefined,
 *   },
 *   watchdog: { classifySprint: (entry: object) => Promise<{ status: string }> },
 *   listChildren?: (parentId: string) => Promise<string[]>,
 *   expandScope?: (roots: string[]) => Promise<Set<string>>,
 *   getSprintMeta?: (sprintId: string) => Promise<{ branch?: string, goal?: string, roles?: Record<string,string> }>|{ branch?: string, goal?: string, roles?: Record<string,string> },
 *   backlog?: { renderHtml: () => Promise<string>|string },
 *   logger?: { log?: Function, error?: Function },
 * }} [deps]
 * @returns {{
 *   name: string,
 *   start(): Promise<void>,
 *   stop(): Promise<void>,
 *   buildSprintViews(): Promise<SprintView[]>,
 *   renderIndexPage(): Promise<string>,
 * }}
 */
export function createDashboard(deps = {}) {
    const ledger = deps.ledger;
    if (!ledger || typeof ledger.list !== 'function') {
        throw new TypeError('createDashboard requires a ledger with a list() method');
    }
    const watchdog = deps.watchdog;
    if (!watchdog || typeof watchdog.classifySprint !== 'function') {
        throw new TypeError('createDashboard requires a watchdog with classifySprint()');
    }
    const logger = deps.logger ?? console;
    const logError = (...a) => (logger.error ?? logger.log)?.(...a);
    const listChildren = deps.listChildren ?? bdListChildren;
    const expand = deps.expandScope ?? ((roots) => expandScope(roots, listChildren));
    // apra-fleet-3i3.2: best-effort per-sprint metadata (branch/goal/member
    // roles). Defaults to reading branch/goal straight off the ledger entry
    // (which now persists them -- see ledger.mjs) when the caller injects
    // nothing; per-member roles still have no ledger-backed source, so this
    // default never populates `roles`, matching the pre-existing "no roles ->
    // every member's role renders null" fallback. `ledger.get` is OPTIONAL on
    // the injected ledger (some tests only implement list()) -- guarded so
    // this default is a safe no-op, not a throw, against those.
    const getSprintMeta = deps.getSprintMeta ?? ((sprintId) => {
        if (typeof ledger.get !== 'function') return {};
        const entry = ledger.get(sprintId);
        return entry ? { branch: entry.branch ?? null, goal: entry.goal ?? null } : {};
    });
    // Backlog-last tree (eft.6.2). Injected so the dashboard renders it as the
    // final page section without owning its full-tracker/claim computation. When
    // absent, renderIndexPageHtml() falls back to an explicit empty state.
    const backlog = deps.backlog ?? null;

    /**
     * Builds every RUNNING sprint's view model. A sprint classified `finished`
     * by the watchdog is dropped entirely (acceptance criterion: finished
     * sprints must not appear in the live stack). Per-entry failures (a
     * transient `bd` error while expanding scope, a throwing getSprintMeta)
     * are isolated to that one entry -- rendered with graceful "unknown"
     * fallbacks -- rather than taking the whole page down.
     * @returns {Promise<SprintView[]>}
     */
    async function buildSprintViews() {
        const entries = ledger.list();
        const built = await Promise.all(entries.map(async (entry) => {
            const classification = await watchdog.classifySprint(entry);

            let beadCount = null;
            try {
                const scope = await expand(entry.issueRoots ?? []);
                beadCount = scope.size;
            } catch (err) {
                logError(`[dashboard] scope expansion failed for sprint '${entry.sprintId}':`, err);
            }

            let meta = {};
            try {
                meta = (await getSprintMeta(entry.sprintId)) || {};
            } catch (err) {
                logError(`[dashboard] getSprintMeta failed for sprint '${entry.sprintId}':`, err);
            }
            const roles = meta.roles && typeof meta.roles === 'object' ? meta.roles : {};

            return {
                sprintId: entry.sprintId,
                branch: meta.branch ?? null,
                goal: meta.goal ?? null,
                status: classification.status,
                issueRoots: entry.issueRoots ?? [],
                beadCount,
                members: (entry.members ?? []).map((name) => ({ name, role: roles[name] ?? null })),
            };
        }));
        return built.filter((v) => v.status !== WATCHDOG_STATUS.FINISHED);
    }

    return {
        name: 'dashboard',
        async start() {},
        async stop() {},
        buildSprintViews,
        async renderIndexPage() {
            // Render the sprint stack and the Backlog tab content concurrently
            // with the page shell; a Backlog render failure is isolated so it
            // can never take the whole page down (renderIndexPageHtml falls
            // back to an explicit empty state when backlogHtml is undefined).
            //
            // Prefers buildBacklogTasks() (the flat, filterable, renderBeadsHtml-
            // shaped data createBacklog() now exposes -- see backlog.mjs) over
            // the older renderHtml() (the plain <ul>/<li> tree), so the real
            // supervisor renders the SAME beads-tree UI fleet-sprint's own
            // viewer uses. A caller injecting a minimal backlog stub that only
            // implements renderHtml() (as some tests still do) still works via
            // that fallback.
            let backlogHtml;
            if (backlog && typeof backlog.buildBacklogTasks === 'function') {
                try {
                    const { tasks, filterOptions } = await backlog.buildBacklogTasks();
                    backlogHtml = renderBacklogPanelHtml(tasks, filterOptions);
                } catch (err) {
                    logError('[dashboard] backlog render failed:', err);
                }
            } else if (backlog && typeof backlog.renderHtml === 'function') {
                try {
                    backlogHtml = await backlog.renderHtml();
                } catch (err) {
                    logError('[dashboard] backlog render failed:', err);
                }
            }
            return renderIndexPageHtml(await buildSprintViews(), backlogHtml);
        },
    };
}

/**
 * Registers `GET /` against a supervisor (server.mjs), mirroring the
 * registration pattern of registerSprintRoutes()/registerReservationRoutes().
 * @param {{ route: (method: string, path: string, handler: Function) => void }} supervisor
 * @param {ReturnType<typeof createDashboard>} dashboard
 */
export function registerDashboardRoutes(supervisor, dashboard) {
    supervisor.route('GET', '/', async (req, res) => {
        const html = await dashboard.renderIndexPage();
        const body = Buffer.from(html, 'utf-8');
        res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': body.length,
        });
        res.end(body);
    });
}
