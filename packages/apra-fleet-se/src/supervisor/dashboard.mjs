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
// DATA AVAILABILITY NOTE: the reservation ledger (eft.5.1,
// src/supervisor/ledger.mjs) durably stores only `members` (a flat union,
// role information already folded away) and `issueRoots` -- it does not
// (yet) persist `branch`, `goal`, or a per-member role map. This module does
// NOT reach into the ledger's on-disk schema or into cli.mjs's launch argv to
// backfill that (both are out of this task's file scope, and either is
// actively being touched by other in-flight work). Instead, `branch`/`goal`/
// per-member roles are sourced from an INJECTED `getSprintMeta(sprintId)`
// collaborator that defaults to returning `{}` -- every field the page needs
// still renders (with an explicit "unknown" fallback, never a blank/throw),
// and wiring a real metadata source later is a pure dependency-injection
// swap, no template change required.
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

/** Badge color per four-status classifier value; unknown values fall back to grey. */
const STATUS_BADGE_COLORS = Object.freeze({
    [WATCHDOG_STATUS.RUNNING_HEALTHY]: '#22c55e',
    [WATCHDOG_STATUS.RUNNING_UNRESPONSIVE]: '#f59e0b',
    [WATCHDOG_STATUS.CRASHED]: '#ef4444',
    [WATCHDOG_STATUS.FINISHED]: '#71717a',
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

/**
 * Renders the full index page (`GET /` document). The sprint-stack section
 * (Plan Part 2.3, first block) is rendered FIRST; the Backlog-last tree
 * (eft.6.2) is rendered ALWAYS LAST, after every running sprint's section, so
 * the operator reads live sprints top-down and the free/backlog picker sits at
 * the bottom. The Launch Sprint form (eft.6.3) and History link (eft.6.5) are
 * separate tasks that attach to this same single page.
 * @param {SprintView[]} [views]
 * @param {string} [backlogHtml] - pre-rendered Backlog tree HTML (eft.6.2)
 * @returns {string}
 */
export function renderIndexPageHtml(views, backlogHtml) {
    const backlogSection = typeof backlogHtml === 'string'
        ? backlogHtml
        : '<p style="color:#71717a; font-style: italic;">No unclaimed work in the backlog.</p>';
    return (
        '<!DOCTYPE html>\n' +
        '<html lang="en">\n' +
        '<head>\n' +
        '<meta charset="utf-8"/>\n' +
        '<title>Auto-Sprint Supervisor</title>\n' +
        '<style>body{background:#18181b;color:#e4e4e7;font-family:system-ui,sans-serif;margin:24px;}' +
        'a{color:#60a5fa;}</style>\n' +
        '</head>\n' +
        '<body>\n' +
        '<h1>Sprint Stack</h1>\n' +
        '<div id="sprint-stack">\n' + renderSprintStackHtml(views) + '\n</div>\n' +
        // Backlog is ALWAYS LAST on the page (eft.6.2 acceptance criterion).
        '<h1>Backlog</h1>\n' +
        '<div id="backlog">\n' + backlogSection + '\n</div>\n' +
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
 *   ledger: { list: () => Array<{ sprintId: string, members: string[], issueRoots: string[], childPid: number|null }> },
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
    // Best-effort per-sprint metadata (branch/goal/member roles). See the
    // module doc for why this defaults to an empty object rather than
    // reaching into the ledger's current on-disk schema.
    const getSprintMeta = deps.getSprintMeta ?? (() => ({}));
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
            // Render the sprint stack and the Backlog concurrently; the Backlog
            // is placed LAST by renderIndexPageHtml. A Backlog render failure is
            // isolated so it can never take the whole page down.
            let backlogHtml;
            if (backlog && typeof backlog.renderHtml === 'function') {
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
