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
// Claimed scope's bead count answers the SAME "how many beads does this
// sprint currently claim" question eft.5.3's expandScope() (./scope-
// overlap.mjs) answers for the launch-time overlap guard -- but, as of
// apra-fleet-c4s.1, computed purely IN-MEMORY off the single bulk
// `listAllBeads()` fetch this render already makes below, via
// `expandScopeInMemory()`/`buildChildIndex()` (backlog.mjs), the SAME
// migration backlog.mjs's own buildClaimedBy() already made for this same
// "one `bd` subprocess per discovered node" bug. `deps.expandScope` remains
// the injectable test seam (and, if a caller still supplies it, the actual
// expansion path used verbatim) -- production wiring (bin/serve.mjs) injects
// nothing, so it always takes the in-memory path.
// =============================================================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { escapeHtml } from '@apralabs/apra-fleet-workflow/viewer/html-utils';
import { WATCHDOG_STATUS } from './watchdog.mjs';
import { renderLaunchFormHtml, formatLaunchError } from './launch-form.mjs';
import { renderBacklogPanelHtml, bdListAllBeads, expandScopeInMemory, buildChildIndex } from './backlog.mjs';
// apra-fleet-x8r.2: the SAME closed/required helper apra-fleet-x8r.1 landed
// for the fleet-sprint viewer's Sprint Stack widget (and its HTML renderer) --
// deliberately reused here rather than a second count implementation, so
// there is exactly one closed/required computation in the package.
import { computeSprintProgress } from '../../fleet-sprint/sprint-progress.mjs';
import { renderProgressBarHtml } from '../../fleet-sprint/viewer-extensions.mjs';
// apra-fleet-x8r.4: goalPriorityMax() is the SAME pure priority-tier parser
// runner.js's own completion gate uses (goalMax = goalPriorityMax(goal)) --
// reused here rather than a second parser, so the supervisor's progress bar
// excludes below-goal beads the identical way the per-sprint viewer's does.
import { goalPriorityMax } from '../../fleet-sprint/runner.js';

const execFileAsync = promisify(execFile);

/**
 * (apra-fleet-p2to.3.1) Base-drift indicator: how many commits the sprint's
 * base branch (e.g. `main`) has picked up that are NOT yet reachable from the
 * sprint's own branch -- `git rev-list --count <branch>..<base>` -- i.e. how
 * far the sprint has fallen behind its base since it forked. Returns `null`
 * (NEVER throws) when either ref is unknown, the local git checkout has no
 * knowledge of one of them (a remote branch never fetched into this
 * checkout, a sprint whose worktree lives elsewhere), or the git invocation
 * otherwise fails -- "cannot determine drift" is always rendered distinctly
 * from "zero drift" (renderSprintSection below), never conflated as 0.
 * @param {string|null|undefined} branch
 * @param {string|null|undefined} base
 * @param {{ cwd?: string, exec?: (cmd: string, args: string[], opts: object) => Promise<{ stdout: string }> }} [opts]
 * @returns {Promise<number|null>}
 */
export async function computeBaseDrift(branch, base, opts = {}) {
    if (typeof branch !== 'string' || branch.length === 0) return null;
    if (typeof base !== 'string' || base.length === 0) return null;
    const cwd = opts.cwd ?? process.cwd();
    const exec = opts.exec ?? execFileAsync;
    try {
        const { stdout } = await exec('git', ['rev-list', '--count', `${branch}..${base}`], { cwd, encoding: 'utf-8' });
        const n = parseInt(String(stdout).trim(), 10);
        return Number.isFinite(n) && n >= 0 ? n : null;
    } catch {
        return null;
    }
}

/**
 * Renders the base-drift indicator for one row. `driftCount === null` means
 * "unknown" (base/branch missing, or the git check failed/could not
 * resolve either ref locally) -- rendered distinctly from a confirmed-zero
 * drift, never silently coerced to either extreme.
 * @param {number|null} driftCount
 * @param {string|null} base
 * @returns {string}
 */
function baseDriftIndicator(driftCount, base) {
    const baseLabel = base ? escapeHtml(base) : 'base';
    if (typeof driftCount !== 'number') {
        return '<span style="color:#71717a; font-size:11px; font-style:italic;">Base drift: unknown</span>';
    }
    if (driftCount === 0) {
        return '<span style="color:var(--success); font-size:11px;">Up to date with ' + baseLabel + '</span>';
    }
    return '<span style="color:var(--warning); font-size:11px;" title="commits on ' + baseLabel +
        ' not yet merged into this branch">Base drift: ' + driftCount + ' commit(s) behind ' + baseLabel + '</span>';
}

/**
 * Badge color per classifier status value; unknown values fall back to
 * grey. Uses the same `var(--success)`/`var(--warning)`/`var(--danger)`
 * tokens DASHBOARD_CSS defines below (and fleet-sprint's renderBeadsHtml
 * badges already reference) rather than independent hardcoded hex, so a live
 * sprint's health badge and its beads-tree status badges read as one system.
 */
const STATUS_BADGE_COLORS = Object.freeze({
    [WATCHDOG_STATUS.RUNNING_HEALTHY]: 'var(--success)',
    // (apra-fleet-p2to.3.1) A live, engine-paused run is an intentional,
    // operator-visible state -- not a health problem -- but still worth
    // calling out at a glance, so it shares running-unresponsive's amber
    // rather than success green or danger red.
    [WATCHDOG_STATUS.PAUSED]: 'var(--warning)',
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
 * apra-fleet-x8r.2: the Sprint Stack row's progress-bar markup, or a neutral
 * placeholder when `view.progress` is unavailable (e.g. the bulk beads fetch
 * or scope expansion failed for this sprint this render -- see
 * buildSprintViews() below). Never NaN/a crash: `renderProgressBarHtml()`
 * itself only ever receives an already-computed `{closed, required,
 * fraction}` object here, never null passed through to it, so its own
 * divide-by-zero guard is not what's protecting this path.
 * @param {{ closed: number, required: number, fraction: number }|null|undefined} progress
 * @returns {string}
 */
function renderSprintProgressHtml(progress) {
    if (!progress || typeof progress.required !== 'number') {
        return '<div style="padding: 8px 0; font-size: 12px; color: #71717a; font-style: italic;">progress unavailable</div>';
    }
    return renderProgressBarHtml(progress);
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
    const progressHtml = renderSprintProgressHtml(view.progress);
    const scopeRoots = (view.issueRoots ?? []).map((id) => escapeHtml(id)).join(', ') || 'none';
    const members = (view.members ?? []);
    const membersHtml = members.length > 0
        ? members.map(memberChip).join('')
        : '<span style="color:#71717a; font-style: italic;">no members recorded</span>';
    // Supervisor-relative path ONLY -- never a bare child port (Plan Part 2.3:
    // bare child-port links leak port allocation and break across hosts).
    const liveHref = '/sprints/' + encodeURIComponent(view.sprintId) + '/live';
    // apra-fleet-ou7.2: the raw stdout/stderr log link -- present for EVERY
    // row this stack renders, including a CRASHED sprint (the live SSE
    // viewer above is gone/unresponsive for that status; the raw log is the
    // one remaining way to see what the child actually printed).
    const logHref = '/sprints/' + encodeURIComponent(view.sprintId) + '/log';

    // (apra-fleet-p2to.3.1) Pause/Resume is only meaningful for a sprint the
    // watchdog currently sees as a LIVE pid (running-healthy/running-
    // unresponsive: Pause may still be attempted against an unresponsive
    // child -- the request itself is what the live proxy forwards, its
    // success is not gated on the watchdog's last HTTP probe) or already
    // PAUSED (Resume). A crashed/finished/launch-failed row has no live
    // child to pause/resume, so neither button renders for it -- unlike
    // Stop/Restart, which remain meaningful (releasing/relaunching a stale
    // reservation) regardless of live-pid state.
    const livePidStatuses = new Set([WATCHDOG_STATUS.RUNNING_HEALTHY, WATCHDOG_STATUS.RUNNING_UNRESPONSIVE]);
    let pauseResumeButton = '';
    if (view.status === WATCHDOG_STATUS.PAUSED) {
        // apra-fleet-p2to.3.1: proxies to the child viewer's OWN POST /resume
        // (apra-fleet-p2to.2.1) via the live-view reverse proxy (proxy.mjs's
        // handleResume, /sprints/:id/live/resume) -- never the kill+force-
        // release route Stop/Restart use.
        pauseResumeButton = '<button type="button" class="btn btn-secondary btn-resume-sprint" data-sprint-id="' + sprintId + '" ' +
            'style="font-size: 12px;">Resume</button>';
    } else if (livePidStatuses.has(view.status)) {
        // apra-fleet-p2to.3.1: proxies to the child viewer's OWN POST /pause
        // (apra-fleet-p2to.2.1) via the SAME live-view reverse proxy
        // (proxy.mjs's handlePause, /sprints/:id/live/pause) -- a cooperative
        // request the engine may defer, never an immediate kill.
        pauseResumeButton = '<button type="button" class="btn btn-secondary btn-pause-sprint" data-sprint-id="' + sprintId + '" ' +
            'style="font-size: 12px;">Pause</button>';
    }

    return (
        '<section data-sprint-id="' + sprintId + '" style="border: 1px solid rgba(255,255,255,0.1); ' +
        'border-radius: 6px; padding: 12px 14px; margin-bottom: 12px;">' +
        '<div style="display:flex; align-items:center; gap: 10px; flex-wrap: wrap;">' +
        '<strong style="font-size: 14px;">' + sprintId + '</strong>' +
        statusBadge(view.status) +
        '<a href="' + liveHref + '" target="_blank" rel="noopener" style="margin-left:auto; font-size: 12px;">Open live view</a>' +
        '<a href="' + logHref + '" target="_blank" rel="noopener" style="font-size: 12px;">Raw log</a>' +
        // apra-fleet-3i3.1: kills the still-live child AND releases the
        // member+scope reservation in one action (POST /api/reservations/
        // :sprintId/force-release, extended -- see reconcile.mjs). A plain
        // button (not a form submit) wired up by SPRINT_STOP_SCRIPT below via
        // event delegation on data-sprint-id, matching the Launch Sprint
        // form's formatLaunchError() inline-feedback convention.
        '<button type="button" class="btn btn-secondary btn-stop-sprint" data-sprint-id="' + sprintId + '" ' +
        'style="font-size: 12px;">Stop</button>' +
        pauseResumeButton +
        // apra-fleet-3i3.3: releases the SAME reservation (via the SAME
        // force-release route Stop uses) then re-launches the SAME sprint via
        // POST /api/sprints, without a separate manual Stop first -- see
        // SPRINT_RESTART_SCRIPT below and reconcile.mjs's forceRelease(),
        // which now echoes back branch/base/goal/members/issueRoots for
        // exactly this purpose.
        '<button type="button" class="btn btn-secondary btn-restart-sprint" data-sprint-id="' + sprintId + '" ' +
        'style="font-size: 12px;">Restart</button>' +
        '</div>' +
        progressHtml +
        '<div style="margin-top: 8px; font-size: 13px; color: #d4d4d8;">' +
        '<div><span style="color:#a1a1aa;">Branch:</span> ' + branch + '</div>' +
        '<div><span style="color:#a1a1aa;">Goal:</span> ' + goal + '</div>' +
        // apra-fleet-vk0a.3: explicitly labeled 'total in scope' -- distinct
        // from the progress bar's OWN, differently-scoped 'Required: M/N'
        // widget a few lines above (renderProgressBarHtml(), goal+
        // decomposedParentIds-filtered). This raw count legitimately GROWS
        // over a sprint's life (planners/reviewers add tasks under an
        // already-claimed root); labeling it distinguishes that from a
        // glitch and from the filtered 'Required' count staying flat.
        '<div><span style="color:#a1a1aa;">Claimed scope:</span> ' + beadCount + ' bead(s) total in scope, unfiltered (roots: ' + scopeRoots + ')</div>' +
        // (apra-fleet-p2to.3.1) base-drift indicator -- see baseDriftIndicator()'s
        // doc comment for the "unknown" vs "0 drift" distinction.
        '<div>' + baseDriftIndicator(view.baseDrift ?? null, view.base ?? null) + '</div>' +
        '</div>' +
        '<div style="margin-top: 8px;">' +
        '<span style="color:#a1a1aa; font-size: 12px;">Members:</span><br/>' +
        membersHtml +
        '</div>' +
        '<div class="stop-result" data-sprint-id="' + sprintId + '" style="margin-top: 6px; font-size: 12px;"></div>' +
        '<div class="restart-result" data-sprint-id="' + sprintId + '" style="margin-top: 6px; font-size: 12px;"></div>' +
        '<div class="pause-result" data-sprint-id="' + sprintId + '" style="margin-top: 6px; font-size: 12px;"></div>' +
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
 * exact code shipped to the browser). Event-delegated on `document` -- as of
 * apra-fleet-siqi.1.2, SPRINT_STACK_LIVE_SCRIPT below DOES periodically
 * rebuild each `<section data-sprint-id>` row (a fresh /state poll may
 * replace this exact button element), but delegation on `document` still
 * catches every click regardless of which concrete button element it landed
 * on, so a single listener wired once at page load remains sufficient -- no
 * re-wiring needed after a live rebuild: a click on any `.btn-stop-sprint`
 * button confirms with the operator, then POSTs
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
        var section = btn.closest('section[data-sprint-id]');
        // apra-fleet-3i3.3: also disable Restart while a Stop is in flight on
        // the SAME row, so the two controls can never race each other into
        // two concurrent force-release calls for the same sprintId.
        var restartBtn = section ? section.querySelector('.btn-restart-sprint') : null;
        btn.disabled = true;
        if (restartBtn) restartBtn.disabled = true;
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
                if (section) section.remove();
            } else {
                btn.disabled = false;
                if (restartBtn) restartBtn.disabled = false;
                if (resultEl) { resultEl.style.color = '#ef4444'; resultEl.textContent = formatStopError(r.status, r.json); }
            }
        }).catch(function (err) {
            btn.disabled = false;
            if (restartBtn) restartBtn.disabled = false;
            if (resultEl) { resultEl.style.color = '#ef4444'; resultEl.textContent = 'Stop request failed: ' + err.message; }
        });
    });
`;

/**
 * The Sprint Stack's per-row Restart button behavior, as a source string
 * ready to inline into a `<script>` tag (same embedding pattern as
 * SPRINT_STOP_SCRIPT above). A click on any `.btn-restart-sprint` button:
 *
 *   1. Confirms with the operator (destructive-ish: discards the old
 *      sprint's history, same framing as Stop).
 *   2. POSTs the SAME POST /api/reservations/:sprintId/force-release route
 *      Stop uses (apra-fleet-3i3.1) -- releasing the reservation (and killing
 *      the child, if still alive) with NO separate manual Stop first
 *      (acceptance criterion).
 *   3. Reads branch/base/goal/members/issueRoots off THAT response's `audit`
 *      (apra-fleet-3i3.3's reconcile.mjs extension) rather than a second
 *      network round-trip. When branch or base -- both server-REQUIRED
 *      fields (api.mjs's validateLaunchRequest) -- is null (a pre-3i3.2
 *      legacy entry that never persisted it), prompts the operator to enter
 *      it; declining aborts the restart (the old reservation is already
 *      released either way, matching Stop's own irreversibility). `goal` is
 *      optional at launch, so a null goal only offers a prompt the operator
 *      may leave blank, never aborts.
 *   4. POSTs the reconstructed request to POST /api/sprints (the SAME
 *      validated launch endpoint the Launch Sprint form uses), surfacing a
 *      201 success (with a link to the new sprint's live view) or failure
 *      (via launch-form.mjs's OWN formatLaunchError(), consistent with that
 *      form's error-surfacing pattern per the acceptance criterion) INLINE in
 *      that row's `.restart-result` element.
 *
 * Every promise chain ends in a `.catch()` (never a silent no-op / unhandled
 * browser rejection). Unlike Stop, a successfully force-released row's
 * `<section>` is NOT removed from the DOM on success -- the freshly-launched
 * sprint has no server-rendered view model yet (branch/goal/bead-count/
 * members are all built server-side in buildSprintViews()), so removing it
 * would discard the only place left to show the success message and the new
 * sprint's live-view link; both buttons are left disabled instead, since the
 * old reservation is gone either way and a further click on either would only
 * ever 404.
 */
const SPRINT_RESTART_SCRIPT = `
    ${formatStopError.toString()}
    ${formatLaunchError.toString()}
    document.addEventListener('click', function (ev) {
        var btn = ev.target.closest('.btn-restart-sprint');
        if (!btn) return;
        var sprintId = btn.getAttribute('data-sprint-id');
        if (!sprintId) return;
        if (!confirm('Restart sprint ' + sprintId + '? This releases its current reservation and relaunches the same scope as a NEW sprint.')) return;
        var resultEl = document.querySelector('.restart-result[data-sprint-id="' + sprintId + '"]');
        var section = btn.closest('section[data-sprint-id]');
        var stopBtn = section ? section.querySelector('.btn-stop-sprint') : null;
        btn.disabled = true;
        if (stopBtn) stopBtn.disabled = true;
        if (resultEl) { resultEl.style.color = '#a1a1aa'; resultEl.textContent = 'Releasing old reservation...'; }
        fetch('/api/reservations/' + encodeURIComponent(sprintId) + '/force-release', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reason: 'restarted via Sprint Stack Restart button' }),
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (json) {
                return { status: res.status, json: json };
            });
        }).then(function (r) {
            if (r.status !== 200) {
                btn.disabled = false;
                if (stopBtn) stopBtn.disabled = false;
                if (resultEl) { resultEl.style.color = '#ef4444'; resultEl.textContent = formatStopError(r.status, r.json); }
                return;
            }
            var audit = (r.json && r.json.audit) || {};
            var issueRoots = Array.isArray(audit.issueRoots) ? audit.issueRoots : [];
            var members = Array.isArray(audit.members) ? audit.members : [];
            var issue = issueRoots.length > 0 ? issueRoots[0] : null;
            var branch = (typeof audit.branch === 'string' && audit.branch) ? audit.branch : null;
            var base = (typeof audit.base === 'string' && audit.base) ? audit.base : null;
            var goal = (typeof audit.goal === 'string' && audit.goal) ? audit.goal : null;

            if (!issue || members.length === 0) {
                if (resultEl) { resultEl.style.color = '#ef4444'; resultEl.textContent = 'Reservation released, but the original issue/members could not be recovered -- use the Launch Sprint form to relaunch manually.'; }
                return;
            }
            if (!branch) {
                branch = (window.prompt('Branch name is not recoverable for this sprint -- enter it to continue the restart (Cancel aborts; the old reservation is already released):') || '').trim();
                if (!branch) {
                    if (resultEl) { resultEl.style.color = '#ef4444'; resultEl.textContent = 'Restart cancelled: branch name is required. The old reservation has already been released -- use the Launch Sprint form to relaunch manually.'; }
                    return;
                }
            }
            if (!base) {
                base = (window.prompt('Base branch name is not recoverable for this sprint -- enter it to continue the restart (Cancel aborts; the old reservation is already released):') || '').trim();
                if (!base) {
                    if (resultEl) { resultEl.style.color = '#ef4444'; resultEl.textContent = 'Restart cancelled: base branch name is required. The old reservation has already been released -- use the Launch Sprint form to relaunch manually.'; }
                    return;
                }
            }
            if (!goal) {
                goal = (window.prompt('Goal (e.g. P1, P1/P2, P1/P2/P3) for the restarted sprint. Leave blank to launch without one:') || '').trim();
            }

            if (resultEl) { resultEl.style.color = '#a1a1aa'; resultEl.textContent = 'Relaunching...'; }
            var body = { issue: issue, members: members, branch: branch, base: base };
            if (goal) body.goal = goal;
            fetch('/api/sprints', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            }).then(function (res2) {
                return res2.json().catch(function () { return {}; }).then(function (json2) {
                    return { status: res2.status, json: json2 };
                });
            }).then(function (r2) {
                if (r2.status === 201) {
                    if (resultEl) {
                        resultEl.style.color = '#22c55e';
                        resultEl.textContent = 'Restarted as sprint ' + r2.json.sprintId + '. ';
                        var link = document.createElement('a');
                        link.href = '/sprints/' + encodeURIComponent(r2.json.sprintId) + '/live';
                        link.target = '_blank';
                        link.rel = 'noopener';
                        link.textContent = 'Open live view';
                        resultEl.appendChild(link);
                    }
                } else {
                    btn.disabled = false;
                    if (stopBtn) stopBtn.disabled = false;
                    if (resultEl) { resultEl.style.color = '#ef4444'; resultEl.textContent = 'Reservation released, but relaunch failed: ' + formatLaunchError(r2.status, r2.json); }
                }
            }).catch(function (err2) {
                btn.disabled = false;
                if (stopBtn) stopBtn.disabled = false;
                if (resultEl) { resultEl.style.color = '#ef4444'; resultEl.textContent = 'Reservation released, but the relaunch request failed: ' + err2.message; }
            });
        }).catch(function (err) {
            btn.disabled = false;
            if (stopBtn) stopBtn.disabled = false;
            if (resultEl) { resultEl.style.color = '#ef4444'; resultEl.textContent = 'Restart request failed: ' + err.message; }
        });
    });
`;

/**
 * (apra-fleet-p2to.3.1) The Sprint Stack's per-row Pause/Resume button
 * behavior, as a source string ready to inline into a `<script>` tag (same
 * `.toString()`-embedding pattern as SPRINT_STOP_SCRIPT/SPRINT_RESTART_SCRIPT
 * above). Event-delegated on `document`, same discipline as those two: a
 * click on `.btn-pause-sprint` POSTs `/sprints/:id/live/pause`, a click on
 * `.btn-resume-sprint` POSTs `/sprints/:id/live/resume` -- BOTH via the
 * live-view reverse proxy (proxy.mjs), which forwards to the child viewer's
 * OWN `/pause`/`/resume` (apra-fleet-p2to.2.1), never the kill+force-release
 * route Stop/Restart use. Unlike Stop, a click here does not remove or
 * relabel the row: the requested transition is COOPERATIVE and may be
 * deferred by the engine (apra-fleet-p2to.1's requestPause()), so the button
 * is only disabled (to prevent a double-submit) and an inline status message
 * is shown -- the row's own Pause/Resume button + status badge only reflect
 * the ACTUAL new state once the watchdog's own `/state`-based pause probe
 * (watchdog.mjs) has observed it. Pre-apra-fleet-siqi.1.2 that meant "on the
 * next full page load"; as of siqi.1.2, SPRINT_STACK_LIVE_SCRIPT's own
 * periodic /state poll rebuilds this row too, so the correct button/badge
 * typically appears within a poll cycle with no manual reload needed -- this
 * script itself still does not attempt to predict or race that outcome, it
 * only reports the request as submitted. Every promise chain ends in a
 * `.catch()`, matching the other two scripts' discipline.
 */
const SPRINT_PAUSE_SCRIPT = `
    ${formatStopError.toString()}
    function requestPauseResume(btn, action) {
        var sprintId = btn.getAttribute('data-sprint-id');
        if (!sprintId) return;
        var resultEl = document.querySelector('.pause-result[data-sprint-id="' + sprintId + '"]');
        btn.disabled = true;
        if (resultEl) { resultEl.style.color = '#a1a1aa'; resultEl.textContent = (action === 'pause' ? 'Pause' : 'Resume') + ' requested...'; }
        fetch('/sprints/' + encodeURIComponent(sprintId) + '/live/' + action, { method: 'POST' })
            .then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (json) {
                    return { status: res.status, json: json };
                });
            }).then(function (r) {
                if (r.status === 200) {
                    if (resultEl) {
                        resultEl.style.color = '#22c55e';
                        resultEl.textContent = (action === 'pause' ? 'Pause' : 'Resume') + ' requested -- reload to see the updated status.';
                    }
                    // Deliberately left disabled: the cooperative transition may
                    // still be in flight (a deferred pause) or has already
                    // happened (a resume) -- either way, this row's button/badge
                    // are only accurate again after a reload, and re-enabling
                    // it here would let an operator fire the SAME request twice
                    // before that reload happens.
                } else {
                    btn.disabled = false;
                    if (resultEl) { resultEl.style.color = '#ef4444'; resultEl.textContent = formatStopError(r.status, r.json); }
                }
            }).catch(function (err) {
                btn.disabled = false;
                if (resultEl) { resultEl.style.color = '#ef4444'; resultEl.textContent = (action === 'pause' ? 'Pause' : 'Resume') + ' request failed: ' + err.message; }
            });
    }
    document.addEventListener('click', function (ev) {
        var pauseBtn = ev.target.closest('.btn-pause-sprint');
        if (pauseBtn) { requestPauseResume(pauseBtn, 'pause'); return; }
        var resumeBtn = ev.target.closest('.btn-resume-sprint');
        if (resumeBtn) { requestPauseResume(resumeBtn, 'resume'); return; }
    });
`;

/**
 * (apra-fleet-siqi.1.2) The Sprint Stack's live-refresh client loop, as a
 * source string ready to inline into a `<script>` tag (same
 * `.toString()`-embedding pattern as the three button scripts above). Mirrors
 * apra-fleet-workflow's per-sprint viewer client loop
 * (packages/apra-fleet-workflow/src/viewer/index.mjs, ~lines 478-504) in
 * shape exactly: a debounced `schedulePoll()` guard (`POLL_COALESCE_MS`), an
 * `EventSource('/events')` whose `onmessage` calls `schedulePoll()` (this
 * dashboard's own GET /events -- apra-fleet-siqi.1.1 -- emits a generic
 * `{ type: 'update' }` signal on every message, so the payload itself is
 * never inspected here, unlike the per-run viewer's namespaced
 * `workflow:state:*` dispatch), and a `setInterval` heartbeat that ALSO calls
 * `schedulePoll()` so a dropped/unavailable EventSource still polls (the
 * SAME `apra-fleet-36l.1` fallback discipline) -- ONE polling mechanism
 * (`schedulePoll()` -> `poll()`), never two independent pollers.
 *
 * `poll()` fetches GET /state (apra-fleet-siqi.1.1's `buildStatePayload()`
 * shape: `{ generatedAt, runningCount, sprints }`) and re-renders the Sprint
 * Stack rows FROM that payload -- never a one-shot server render, and never
 * `location.reload()`. Row rendering itself reuses `renderSprintSection()`
 * (and its own escapeHtml/statusBadge/renderSprintProgressHtml/memberChip/
 * baseDriftIndicator/renderProgressBarHtml dependencies, all embedded
 * verbatim via `.toString()` below, plus WATCHDOG_STATUS/STATUS_BADGE_COLORS
 * as inline JSON) -- the EXACT SAME markup-building function GET / uses for
 * the initial server render, so a live-refreshed row can never visually
 * drift from a freshly-loaded one. Reconciliation against the current DOM is
 * by `data-sprint-id`: an existing `<section>` is replaced in place (its
 * Stop/Restart/Pause buttons come back correctly wired since those three
 * scripts delegate their click handling on `document`, not on the button
 * elements themselves -- see SPRINT_STOP_SCRIPT's doc comment), a newly
 * appeared sprintId is appended, and a row whose sprintId is no longer in
 * the payload (finished/force-released/restarted-away since the last poll)
 * is removed -- falling back to the SAME empty-state message
 * `renderSprintStackHtml()` renders server-side when the list goes to zero.
 */
const SPRINT_STACK_LIVE_SCRIPT = `
    ${escapeHtml.toString()}
    ${memberChip.toString()}
    ${baseDriftIndicator.toString()}
    var WATCHDOG_STATUS = ${JSON.stringify(WATCHDOG_STATUS)};
    var STATUS_BADGE_COLORS = ${JSON.stringify(STATUS_BADGE_COLORS)};
    ${statusBadge.toString()}
    ${renderProgressBarHtml.toString()}
    ${renderSprintProgressHtml.toString()}
    ${renderSprintSection.toString()}

    // Re-renders #sprint-stack's rows from a GET /state 'sprints' array,
    // in place, by data-sprint-id -- see this const's doc comment above.
    function renderSprintStackFromState(sprints) {
        var container = document.getElementById('sprint-stack');
        if (!container) return;
        var list = Array.isArray(sprints) ? sprints : [];
        var existingSections = {};
        Array.prototype.forEach.call(container.querySelectorAll('section[data-sprint-id]'), function (s) {
            existingSections[s.getAttribute('data-sprint-id')] = s;
        });
        if (list.length === 0) {
            container.innerHTML = '<p style="color:#71717a; font-style: italic;">No sprints are currently running.</p>';
            return;
        }
        var seenIds = {};
        list.forEach(function (view) {
            seenIds[view.sprintId] = true;
            var existing = existingSections[view.sprintId];
            var html = renderSprintSection(view);
            if (existing) {
                existing.outerHTML = html;
            } else {
                // First real row ever renders here (not the empty-state
                // placeholder text) -- clear that placeholder, if present,
                // before appending.
                var placeholder = container.querySelector('p');
                if (placeholder && container.querySelectorAll('section[data-sprint-id]').length === 0) {
                    container.innerHTML = '';
                }
                container.insertAdjacentHTML('beforeend', html);
            }
        });
        Object.keys(existingSections).forEach(function (id) {
            if (!seenIds[id]) existingSections[id].remove();
        });
    }

    // apra-fleet-workflow's viewer client loop (index.mjs ~478-504), same
    // shape: debounced schedulePoll() -> poll(), driven by BOTH an
    // EventSource('/events') message and a setInterval heartbeat fallback.
    var POLL_COALESCE_MS = 400;
    var pollTimer = null;
    function schedulePoll() {
        if (pollTimer) return;
        pollTimer = setTimeout(function () { pollTimer = null; poll(); }, POLL_COALESCE_MS);
    }

    async function poll() {
        try {
            var res = await fetch('/state?_t=' + Date.now(), { cache: 'no-store' });
            var data = await res.json();
            renderSprintStackFromState(data.sprints);
        } catch (e) {
            console.error('Poll Error:', e);
        }
    }

    if (typeof EventSource !== 'undefined') {
        var source = new EventSource('/events');
        // Every /events message is the same generic 'go poll /state' signal
        // (apra-fleet-siqi.1.1) -- never inspected, just a trigger.
        source.onmessage = function () { schedulePoll(); };
    }

    // apra-fleet-36l.1-style heartbeat fallback: independent of EventSource
    // state (unavailable, never connected, or silently dropped without an
    // onerror the browser surfaces), this keeps calling the SAME
    // schedulePoll()/poll() path on a fixed cadence so the dashboard can
    // never sit silently stale.
    var HEARTBEAT_INTERVAL_MS = 7000;
    setInterval(function () { schedulePoll(); }, HEARTBEAT_INTERVAL_MS);

    poll();
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
        '<div class="header-actions"><div class="stats-banner"><span><strong>' + runningCount + '</strong> running</span></div>' +
        '<a href="/supervisor/log" target="_blank" rel="noopener" style="font-size: 12px;">Supervisor log</a></div>' +
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
        '<script>' + SPRINT_RESTART_SCRIPT + '</script>\n' +
        '<script>' + SPRINT_PAUSE_SCRIPT + '</script>\n' +
        // (apra-fleet-siqi.1.2) Live-refresh loop -- registered LAST so the
        // Stop/Restart/Pause scripts' own `document`-level delegated click
        // listeners (which SPRINT_STACK_LIVE_SCRIPT's poll-driven rebuilds
        // rely on) are already wired before this script's first poll() can
        // possibly replace any row.
        '<script>' + SPRINT_STACK_LIVE_SCRIPT + '</script>\n' +
        '</body>\n' +
        '</html>\n'
    );
}

/**
 * @typedef {object} SprintView
 * @property {string} sprintId
 * @property {string|null} branch
 * @property {string|null} goal
 * @property {string} status - one of WATCHDOG_STATUS's six values
 * @property {string[]} issueRoots
 * @property {number|null} beadCount
 * @property {{ closed: number, required: number, fraction: number }|null} progress
 * @property {Array<{ name: string, role: string|null }>} members
 * @property {string|null} base - (apra-fleet-p2to.3.1) the sprint's launch `--base` branch, as recorded on the ledger entry
 * @property {number|null} baseDrift - (apra-fleet-p2to.3.1) commits on `base` not yet reachable from `branch`; `null` when unknown (see computeBaseDrift())
 */

/**
 * (apra-fleet-siqi.1.1) Lean JSON payload for GET /state -- the SAME
 * sprint-stack view data `renderSprintStackHtml()`/`renderSprintSection()`
 * render into HTML above (ids, statuses, claimed-scope/progress counts,
 * members), but as plain JSON for the dashboard's poll('/state') client path
 * -- never the full HTML shell `GET /` serves. Mirrors
 * apra-fleet-workflow/src/viewer/lean-state.mjs's buildListStatePayload() in
 * spirit (a lean, wire-shaped transform of the same view model a full page
 * render already computes) without pulling in that module's string-dedup
 * machinery, which targets a much larger per-activity payload than this
 * small, per-sprint list ever grows to.
 * @param {SprintView[]} [views]
 * @returns {{ generatedAt: string, runningCount: number, sprints: Array<object> }}
 */
export function buildStatePayload(views) {
    const list = Array.isArray(views) ? views : [];
    return {
        generatedAt: new Date().toISOString(),
        runningCount: list.length,
        sprints: list.map((v) => ({
            sprintId: v.sprintId,
            branch: v.branch ?? null,
            goal: v.goal ?? null,
            status: v.status,
            issueRoots: v.issueRoots ?? [],
            beadCount: v.beadCount ?? null,
            progress: v.progress ?? null,
            members: v.members ?? [],
            base: v.base ?? null,
            baseDrift: v.baseDrift ?? null,
        })),
    };
}

// (apra-fleet-siqi.1.1) Default interval, in ms, at which GET /events emits a
// generic "state may have changed, go poll /state" signal to every connected
// SSE client -- see createDashboard()'s changeEmitter below. The supervisor
// has no single internal event stream the way one workflow run does
// (apra-fleet-workflow's viewer broadcasts on its own workflow.on(...)
// handlers); its RUNNING-sprint view model instead changes via many disjoint
// HTTP routes (POST /api/sprints, force-release, a watchdog reclassification
// on the NEXT renderIndexPage()/buildSprintViews() call, etc.). Rather than
// threading a notify() call into every one of those call sites (out of scope
// for this task -- see the bead's file list), GET /events emits this same
// generic signal on a fixed cadence, mirroring the per-sprint viewer's own
// client-side heartbeat fallback (apra-fleet-36l.1) -- just server-side,
// since the supervisor has no per-mutation push events to relay yet. The
// client (apra-fleet-siqi.1.2) treats every signal identically: refetch
// /state and re-render, so a period-driven signal here is indistinguishable
// from a real per-mutation push from the client's point of view.
const DEFAULT_EVENTS_INTERVAL_MS = 5000;

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
 *   expandScope?: (roots: string[]) => Promise<Set<string>>, // test seam only -- production leaves this unset and expands in-memory (apra-fleet-c4s.1)

 *   listAllBeads?: () => Promise<Array<{ id: string, status: string }>>,
 *   getSprintMeta?: (sprintId: string) => Promise<{ branch?: string, goal?: string, roles?: Record<string,string> }>|{ branch?: string, goal?: string, roles?: Record<string,string> },
 *   driftCheck?: (branch: string|null, base: string|null) => Promise<number|null>|number|null,
 *   backlog?: { renderHtml: () => Promise<string>|string },
 *   logger?: { log?: Function, error?: Function },
 *   eventsIntervalMs?: number, // (apra-fleet-siqi.1.1) GET /events signal cadence; defaults to DEFAULT_EVENTS_INTERVAL_MS
 * }} [deps]
 * @returns {{
 *   name: string,
 *   start(): Promise<void>,
 *   stop(): Promise<void>,
 *   buildSprintViews(): Promise<SprintView[]>,
 *   renderIndexPage(): Promise<string>,
 *   onChange(listener: () => void): () => void,
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
    // apra-fleet-c4s.1: `deps.expandScope`, when injected, is called verbatim
    // (the pre-existing test seam -- see the module doc comment above). When
    // absent (production default, bin/serve.mjs), buildSprintViews() below
    // expands EVERY sprint's scope in-memory off the single listAllBeads()
    // fetch it already makes for progress bars, via buildChildIndex() +
    // expandScopeInMemory() -- never a subprocess walker.
    const explicitExpand = deps.expandScope ?? null;
    // apra-fleet-x8r.2: one bulk `bd list --json` fetch per renderIndexPage()
    // call (reused across every sprint row below), not one per row -- same
    // "one query fewer" discipline bdListScoped('') documents in runner.js.
    // Reuses backlog.mjs's already-tested bdListAllBeads() (normalizeBead()
    // shape: `{ id, status, ... }`) rather than a second bulk-fetch
    // implementation.
    const listAllBeads = deps.listAllBeads ?? bdListAllBeads;
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
    // (apra-fleet-p2to.3.1) Base-drift check, injectable so a test can drive a
    // deterministic commit count without a real git checkout. Defaults to
    // computeBaseDrift() above, which never throws (resolves to `null` on any
    // failure -- unresolvable ref, no local git repo, etc).
    const driftCheck = deps.driftCheck ?? computeBaseDrift;
    // Backlog-last tree (eft.6.2). Injected so the dashboard renders it as the
    // final page section without owning its full-tracker/claim computation. When
    // absent, renderIndexPageHtml() falls back to an explicit empty state.
    const backlog = deps.backlog ?? null;

    // (apra-fleet-siqi.1.1) GET /events plumbing -- see DEFAULT_EVENTS_INTERVAL_MS
    // above for why this is a periodic signal rather than a per-mutation push.
    // Lifecycle-owned by THIS seam's own start()/stop() (below), the same
    // pattern every other supervisor seam already follows (server.mjs calls
    // seam.start()/stop() for every entry in `seams`, dashboard included) --
    // registerDashboardRoutes() never touches the timer directly, only
    // subscribes/unsubscribes SSE clients via `onChange()`.
    const changeEmitter = new EventEmitter();
    // An SSE stream may stay open indefinitely (one per connected dashboard
    // tab); the default 10-listener cap is not a "too many listeners" leak
    // here, it's the expected steady state.
    changeEmitter.setMaxListeners(0);
    const eventsIntervalMs = Number.isInteger(deps.eventsIntervalMs) && deps.eventsIntervalMs > 0
        ? deps.eventsIntervalMs
        : DEFAULT_EVENTS_INTERVAL_MS;
    let eventsTimer = null;

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
        // apra-fleet-x8r.2: fetched ONCE for the whole page render (not once
        // per sprint row) -- a failure here is isolated to "no progress bar
        // this round" for every row (each falls back to its own placeholder
        // below), never a thrown page render.
        let allBeads = null;
        try {
            allBeads = await listAllBeads();
        } catch (err) {
            logError('[dashboard] bulk beads fetch failed (progress bars will show placeholders this round):', err);
        }
        // apra-fleet-x8r.4: structural, project-wide, ANY status -- the same
        // "is this id someone's .parent" check runner.js's own
        // decomposedParentIds() applies, built off the same bulk fetch
        // buildSprintViews() already made above (no extra `bd` call, and
        // shared across every sprint row rather than recomputed per row).
        const decomposedParentIdsAll = Array.isArray(allBeads)
            ? new Set(allBeads.filter((b) => b && b.parentId).map((b) => b.parentId))
            : null;
        // apra-fleet-c4s.1: built ONCE off the same bulk fetch above (not one
        // subprocess walk per sprint row) -- `null` when either a test injects
        // its own `explicitExpand` (childIndex would be unused) or the bulk
        // fetch itself failed this round (each row's own try/catch below then
        // falls back to an empty Map, i.e. "scope is just the roots
        // themselves" rather than a crash).
        const childIndex = (!explicitExpand && Array.isArray(allBeads)) ? buildChildIndex(allBeads) : null;
        const built = await Promise.all(entries.map(async (entry) => {
            const classification = await watchdog.classifySprint(entry);

            let meta = {};
            try {
                meta = (await getSprintMeta(entry.sprintId)) || {};
            } catch (err) {
                logError(`[dashboard] getSprintMeta failed for sprint '${entry.sprintId}':`, err);
            }
            const roles = meta.roles && typeof meta.roles === 'object' ? meta.roles : {};
            const branch = meta.branch ?? null;
            // (apra-fleet-p2to.3.1) `base` lives directly on the ledger entry
            // (ledger.mjs's Reservation.base), the same axis as issueRoots/
            // members below -- unlike branch/goal, no getSprintMeta
            // indirection exists for it (nothing has ever needed to override
            // it independently of the ledger).
            const base = entry.base ?? null;

            let baseDrift = null;
            try {
                baseDrift = (await driftCheck(branch, base)) ?? null;
            } catch (err) {
                logError(`[dashboard] base-drift check failed for sprint '${entry.sprintId}':`, err);
            }

            let beadCount = null;
            let progress = null;
            try {
                const roots = entry.issueRoots ?? [];
                // apra-fleet-c4s.1: in-memory expansion off `childIndex`
                // (built once above) is the production path -- zero `bd`
                // subprocess spawns. `explicitExpand`, when a caller injects
                // one, is used verbatim instead (test seam).
                const scope = explicitExpand
                    ? await explicitExpand(roots)
                    : expandScopeInMemory(roots, childIndex ?? new Map());
                beadCount = scope.size;
                if (Array.isArray(allBeads)) {
                    const beadsInScope = allBeads.filter((b) => b && scope.has(b.id));
                    // apra-fleet-x8r.4: goalMax is derived from THIS sprint's
                    // own goal (falls back to no priority filtering when the
                    // goal is not recoverable, same as the pre-x8r.4 "every
                    // bead in scope" behavior) -- never a project-wide
                    // constant, since two concurrent sprints can have
                    // different goal bands.
                    const goalMax = typeof meta.goal === 'string' && meta.goal.length > 0
                        ? Number(goalPriorityMax(meta.goal).slice(1))
                        : undefined;
                    progress = computeSprintProgress(beadsInScope, {
                        goalMax,
                        decomposedParentIds: decomposedParentIdsAll,
                    });
                }
            } catch (err) {
                logError(`[dashboard] scope expansion failed for sprint '${entry.sprintId}':`, err);
            }

            return {
                sprintId: entry.sprintId,
                branch,
                goal: meta.goal ?? null,
                status: classification.status,
                issueRoots: entry.issueRoots ?? [],
                beadCount,
                progress,
                members: (entry.members ?? []).map((name) => ({ name, role: roles[name] ?? null })),
                base,
                baseDrift,
            };
        }));
        return built.filter((v) => v.status !== WATCHDOG_STATUS.FINISHED);
    }

    return {
        name: 'dashboard',
        async start() {
            // Idempotent -- a second start() (e.g. a supervisor restart-in-
            // place test) must not leak a second interval.
            if (eventsTimer) return;
            eventsTimer = setInterval(() => changeEmitter.emit('change'), eventsIntervalMs);
        },
        async stop() {
            if (eventsTimer) {
                clearInterval(eventsTimer);
                eventsTimer = null;
            }
        },
        buildSprintViews,
        /**
         * (apra-fleet-siqi.1.1) Subscribe to the periodic "state may have
         * changed, go poll /state" signal GET /events (registerDashboardRoutes
         * below) relays to connected clients. Returns an unsubscribe function.
         * Exposed here (rather than reaching into this closure's private
         * `changeEmitter` from outside) so registerDashboardRoutes() only ever
         * talks to the dashboard seam's own public surface, the same
         * discipline `buildSprintViews`/`renderIndexPage` already follow.
         * @param {() => void} listener
         * @returns {() => void} unsubscribe
         */
        onChange(listener) {
            changeEmitter.on('change', listener);
            return () => changeEmitter.off('change', listener);
        },
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

    // (apra-fleet-siqi.1.1) GET /state -- the lean JSON poll endpoint: the
    // SAME sprint-stack view model GET / renders into HTML (acceptance
    // criterion: ids, statuses, claimed-scope/progress counts), but as
    // application/json and WITHOUT the page shell -- never the GET / HTML.
    // Built via buildStatePayload() above off the SAME buildSprintViews()
    // GET / already calls: there is exactly one "how do I compute the
    // running sprint list" implementation; this route and GET / only format
    // it differently, mirroring apra-fleet-workflow's own GET /state
    // (src/viewer/index.mjs) being a lean transform of the same `state` its
    // GET / embeds into HTML_TEMPLATE.
    supervisor.route('GET', '/state', async (req, res) => {
        const views = await dashboard.buildSprintViews();
        const body = Buffer.from(JSON.stringify(buildStatePayload(views)), 'utf-8');
        res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': body.length,
            'cache-control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        });
        res.end(body);
    });

    // (apra-fleet-siqi.1.1) GET /events -- Server-Sent-Events change-signal
    // stream, the SAME shape as apra-fleet-workflow's own GET /events
    // (src/viewer/index.mjs): text/event-stream, one connection held open per
    // client, each message a bare `data: <json>\n\n` line. Unlike that
    // per-run viewer (which broadcasts on its own workflow.on(...) engine
    // events), the supervisor has no single internal event stream to relay,
    // so every message here is the SAME generic `{ type: 'update' }` signal
    // -- see DEFAULT_EVENTS_INTERVAL_MS above for why a periodic cadence
    // stands in for per-mutation push. Client (apra-fleet-siqi.1.2) reacts to
    // ANY message identically: schedule a poll('/state'). This handler never
    // calls res.end() itself -- the connection only ever closes via the
    // client disconnecting (req 'close', which unsubscribes from further
    // signals) or the supervisor process exiting.
    supervisor.route('GET', '/events', async (req, res) => {
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'connection': 'keep-alive',
            'cache-control': 'no-cache',
        });
        const send = () => {
            res.write(`data: ${JSON.stringify({ type: 'update' })}\n\n`);
        };
        // Immediate signal on connect: a freshly-opened stream has no
        // guarantee any prior /state fetch is still current, so the client
        // should poll once right away rather than wait a full
        // eventsIntervalMs for the first periodic signal.
        send();
        const unsubscribe = dashboard.onChange(send);
        req.on('close', unsubscribe);
    });
}
