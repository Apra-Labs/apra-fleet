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
import http from 'node:http';
import { escapeHtml } from '@apralabs/apra-fleet-workflow/viewer/html-utils';
import { WATCHDOG_STATUS } from './watchdog.mjs';
// (apra-fleet-i9ag.16.7) The single "did this run end badly?" answer shared
// with launch-form.mjs -- see run-outcome.mjs for why it is its own module.
import { FAILED_VERDICTS, FAILED_RUN_STATUSES, isFailedRunOutcome } from './run-outcome.mjs';
import { renderLaunchFormHtml, formatLaunchError } from './launch-form.mjs';
import { handleTokenExchange, authNoticeHtml, injectAuthNotice } from './dashboard-session.mjs';
import { renderBacklogPanelHtml, normalizeBead, expandScopeInMemory, buildChildIndex } from './backlog.mjs';
// apra-fleet-72o0 (dashboard follow-up): the claimed-scope count needs CLOSED
// beads present in the bulk fetch -- a closed intermediate parent must still
// surface its open descendants to expandScopeInMemory(), same correctness
// requirement scope-overlap.mjs's launch guard already has. backlog.mjs's own
// bdListAllBeads()/bdListAllBeadsRaw() deliberately omit `--all` (that fetch
// feeds the visible backlog BOARD, which intentionally shows open work only)
// -- reusing it here would repeat the closed-parent-hides-subtree hole. Use
// scope-overlap.mjs's `--all` fetcher instead; it is the one
// correctness-appropriate default.
import { bdListAllBeadsWithClosed } from './scope-overlap.mjs';
// The progress bar markup is shared with the fleet-sprint viewer; its
// NUMBERS come from each child's own published summary (GET
// /state?summary=1, see fetchChildSummary()/classifyChildSummary() below),
// never from a supervisor-side recompute over the supervisor's beads clone
// (vre7: that clone can be stale relative to the child's, rendering 0/N for
// a sprint that has in fact closed work).
import { renderProgressBarHtml } from '../../fleet-sprint/viewer-extensions.mjs';
import { toBeadsSummary } from './beads-identity.mjs';
// (apra-fleet-i9ag.3.2) Mount-aware app-paths: every absolute path this page
// emits -- header links, per-card live/log anchors, the client scripts' fetch()
// targets and the EventSource URL -- goes through mountHref() against the
// per-request prefix resolveMountPrefix() derives from the console proxy's
// mount-path header, so the SAME renderers serve the page correctly both
// directly (prefix '', paths unchanged) and inside the console's /ext/<id>
// iframe. See mount-prefix.mjs for the fail-closed validation rules.
import { mountHref, resolveMountPrefix } from './mount-prefix.mjs';
// (apra-fleet-i9ag.5.2) The SAME anchor-id derivation proxy.mjs's live-view
// back-link targets -- see sprint-anchor.mjs's doc comment for why this is
// the one shared source instead of two independent id schemes.
import { sprintCardAnchorId } from './sprint-anchor.mjs';
import { DASHBOARD_CSS } from './theme.mjs';
import { createChildPortResolver } from './child-port.mjs';

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
 * (apra-fleet-i9ag.4) Verdict badge colors -- the same outcome register as
 * fleet-sprint's renderResultExtrasHtml() (viewer-extensions.mjs), so a
 * verdict reads identically on the dashboard and in the History view.
 */
const VERDICT_BADGE_COLORS = Object.freeze({
    PASS: 'var(--success)',
    MERGED: 'var(--success)',
    APPROVED: 'var(--success)',
    FAIL: 'var(--danger)',
    CHANGES_NEEDED: 'var(--danger)',
    ABORTED: 'var(--danger)',
});

/**
 * (apra-fleet-i9ag.4) Renders a sprint's terminal verdict as a badge: the
 * verdict string verbatim (PASS / FAIL / ABORTED / ...), or 'unknown' when
 * no verdict was recorded.
 * @param {string|null|undefined} verdict
 * @returns {string}
 */
export function verdictBadge(verdict) {
    const known = typeof verdict === 'string' && verdict.length > 0;
    const label = known ? verdict : 'unknown';
    const color = (known && VERDICT_BADGE_COLORS[verdict.toUpperCase()]) || '#a1a1aa';
    return '<span class="verdict-badge" style="color: ' + color + '; font-weight: bold; font-size: 11px; ' +
        'border: 1px solid ' + color + '; border-radius: 3px; padding: 2px 6px; white-space: nowrap;">' +
        escapeHtml(label) + '</span>';
}

/**
 * (apra-fleet-i9ag.4) The sprint's PR link, or '' when it has none. Only an
 * http(s) URL ever becomes an href (never a `javascript:` or other scheme).
 * @param {string|null|undefined} prUrl
 * @returns {string}
 */
export function prLink(prUrl) {
    if (typeof prUrl !== 'string' || !/^https?:\/\//i.test(prUrl)) return '';
    return '<a class="pr-link" href="' + escapeHtml(prUrl) + '" target="_blank" rel="noopener noreferrer" ' +
        'style="font-size: 12px; white-space: nowrap;">PR</a>';
}

/**
 * (apra-fleet-i9ag.16.2) Renders the failure badge for a finished-runs row
 * whose sprint never produced a terminal state file (history-view.mjs's
 * `status: 'launch-failed'`). Deliberately a DIFFERENT CSS class
 * (`launch-failed-badge`, never `verdict-badge`) and a fixed `var(--danger)`
 * color -- never derived from VERDICT_BADGE_COLORS or the verdict string --
 * so this can never read as, or be mistaken for, a real terminal verdict.
 * @returns {string}
 */
export function launchFailedBadge() {
    return '<span class="launch-failed-badge" style="color: var(--danger); font-weight: bold; font-size: 11px; ' +
        'border: 1px solid var(--danger); border-radius: 3px; padding: 2px 6px; white-space: nowrap;">' +
        'LAUNCH FAILED</span>';
}

/**
 * (apra-fleet-i9ag.16.7) The "Reason: ..." line shown under a run that ended
 * badly -- on a Finished Sprints card (renderFinishedRunsHtml) and on a Sprint
 * Stack row (renderSprintSection). Returns '' for an absent/empty reason, so a
 * caller never has to guard, and a run with no recorded reason simply renders
 * no line at all.
 *
 * `className` exists purely to keep the pre-existing launch-failed
 * presentation byte-for-byte identical: that row has always carried
 * `class="launch-failed-reason"`, and apra-fleet-i9ag.16.7's whole point is to
 * REUSE that line for other failed runs rather than reclassify the launch
 * failure. Every other caller passes the neutral default. Both classes are
 * styled inline here, so neither needs a DASHBOARD_CSS rule.
 *
 * The reason text comes from a child process (a terminal state file's
 * terminalReason/lastError/notes, or a watchdog history event's reason), so it
 * is untrusted input and goes through escapeHtml() unconditionally -- never
 * interpolated raw.
 * @param {string|null|undefined} reason
 * @param {string} [className] - defaults to 'run-failure-reason'
 * @returns {string}
 */
export function failureReasonHtml(reason, className) {
    if (typeof reason !== 'string' || reason.length === 0) return '';
    var cls = (typeof className === 'string' && className.length > 0) ? className : 'run-failure-reason';
    return '<div class="' + cls + '" style="margin-top: 4px; font-size: 12px; color: #a1a1aa;">Reason: ' +
        escapeHtml(reason) + '</div>';
}

/**
 * (apra-fleet-i9ag.4) Renders the finished-sprints (History) list: one card
 * per finished run, newest first as supplied (history-view.mjs's
 * createFinishedRunsIndex() already orders them), each with its verdict
 * badge, its PR link when one exists, and a link to its
 * GET /sprints/:id/history page. Cards carry `data-finished-sprint-id`, never
 * `data-sprint-id` -- that attribute is the live Sprint Stack's row key
 * (renderSprintStackFromState() reconciles on it), and a finished run must
 * never be mistaken for a running one.
 *
 * (apra-fleet-i9ag.3.2 contract) The History link is an ABSOLUTE app-path run
 * through mountHref() against the per-request prefix, exactly like
 * renderSprintSection()'s live/log anchors -- never a relative './sprints/...'.
 * The PR link is an EXTERNAL https URL and is deliberately NOT prefixed (see
 * prLink(); mountHref() would leave it alone anyway, since it only rewrites
 * root-absolute paths).
 *
 * (apra-fleet-i9ag.16.2) A row whose sprint died in its launch window
 * (history-view.mjs's `status: 'launch-failed'`, `hasTerminalState: false`)
 * never produced a terminal state file, so GET /sprints/:id/history has
 * nothing to render for it and would 404 -- that row gets launchFailedBadge()
 * instead of verdictBadge(), its `reason` text, and a raw-log link
 * (/sprints/:id/log, the child's own stdout/stderr -- it exists because the
 * child at least started before it died) in place of the PR/History links.
 *
 * (apra-fleet-i9ag.16.7) A row that ended badly for ANY other reason -- a
 * failed status, or a failed terminal verdict such as the ABORTED one
 * fleet-sprint's fatal-diagnostics guard records -- now also renders its
 * `reason` (failureReasonHtml(), gated on isFailedRunOutcome()), keeping its
 * normal verdict badge and PR/History links. Before this, the reason line was
 * hard-gated on the launch-failed status, so such a row showed a red verdict
 * badge and no explanation anywhere on the page. A row that ended cleanly
 * renders exactly as it did before.
 * @param {Array<{ sprintId: string, verdict?: string|null, prUrl?: string|null, endedAt?: string|null, goal?: string|null, status?: string|null, reason?: string|null, hasTerminalState?: boolean }>} [runs]
 * @param {string} [mountPrefix] - mount-prefix.mjs's resolved prefix (e.g. '/ext/se'), or '' to serve direct
 * @returns {string}
 */
export function renderFinishedRunsHtml(runs, mountPrefix) {
    var list = Array.isArray(runs) ? runs : [];
    var prefix = typeof mountPrefix === 'string' ? mountPrefix : '';
    if (list.length === 0) {
        return '<p style="color:#71717a; font-style: italic;">No finished sprints yet.</p>';
    }
    return list.map(function (run) {
        var id = escapeHtml(run.sprintId);
        var isLaunchFailed = run.status === 'launch-failed';
        var badgeHtml = isLaunchFailed ? launchFailedBadge() : verdictBadge(run.verdict);
        var noTerminal = isLaunchFailed || run.hasTerminalState === false;
        var linksHtml = noTerminal
            ? '<a class="raw-log-link" href="' + mountHref(prefix, '/sprints/' + encodeURIComponent(run.sprintId) + '/log') + '" target="_blank" rel="noopener" style="margin-left:auto; font-size: 12px;">Raw log</a>'
            : prLink(run.prUrl) +
                '<a class="history-link" href="' + mountHref(prefix, '/sprints/' + encodeURIComponent(run.sprintId) + '/history') + '" target="_blank" rel="noopener" style="margin-left:auto; font-size: 12px;">History</a>';
        // (apra-fleet-i9ag.16.7) The reason line is no longer gated on the
        // launch-failed classification. It was, and that is exactly why the
        // ABORTED card the final M1 acceptance run produced showed no reason
        // at all: a run whose status is anything other than 'launch-failed'
        // took the verdictBadge() path and reasonHtml was hard-forced to ''
        // regardless of what reason data the row carried. Now ANY run that
        // ended badly (isFailedRunOutcome: a failed status, or a failed
        // terminal verdict such as ABORTED/FAIL) shows its reason, while the
        // launch-failed row keeps its original `launch-failed-reason` class
        // and therefore its exact original markup.
        var reasonHtml = isFailedRunOutcome(run.status, run.verdict)
            ? failureReasonHtml(run.reason, isLaunchFailed ? 'launch-failed-reason' : 'run-failure-reason')
            : '';
        return '<section class="finished-sprint" data-finished-sprint-id="' + id + '" style="border: 1px solid rgba(255,255,255,0.1); ' +
            'border-radius: 6px; padding: 8px 14px; margin-bottom: 8px;">' +
            '<div style="display:flex; align-items:center; gap: 10px; flex-wrap: wrap;">' +
            '<strong style="font-size: 13px;">' + id + '</strong>' +
            badgeHtml +
            linksHtml +
            '</div>' +
            reasonHtml +
            '<div style="margin-top: 4px; font-size: 12px; color: #a1a1aa;">' +
            'Finished: ' + (run.endedAt ? escapeHtml(run.endedAt) : 'unknown') +
            (run.goal ? ' | Goal: ' + escapeHtml(run.goal) : '') +
            '</div>' +
            '</section>';
    }).join('\n');
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
 * Compact "how long ago" label for a pulled summary's computedAt: `12s`,
 * `3m`, `2h`, `1d`. Returns null when the timestamp is missing/unparseable.
 * Self-contained (no module-level references) because it is embedded
 * verbatim into the client live-refresh script via `.toString()`.
 * @param {string|null|undefined} iso
 * @param {number} nowMs
 * @returns {string|null}
 */
function formatSummaryAge(iso, nowMs) {
    if (typeof iso !== 'string' || iso.length === 0) return null;
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    var secs = Math.max(0, Math.floor((nowMs - t) / 1000));
    if (secs < 60) return secs + 's';
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h';
    return Math.floor(hours / 24) + 'd';
}

/**
 * The Sprint Stack row's progress markup, driven by the summary view
 * buildSprintViews() pulls from the child (`view.progress`, see
 * classifyChildSummary()):
 *   - state 'ok'          -> the shared bar + "as of AGE"
 *   - state 'unreachable' -> the LAST GOOD bar + "as of AGE" + an
 *                            "unreachable" marker (only built when a last
 *                            good summary exists)
 *   - state 'no-summary'  -> "no summary yet"
 *   - anything else (state 'unavailable', null, a legacy shape) -> "status
 *     unavailable"
 * Never renders digits/digits for a non-ok state without its last-good
 * marker, and never a 0/N placeholder. Self-contained apart from
 * renderProgressBarHtml/formatSummaryAge/escapeHtml, which the client script
 * embeds alongside it.
 * @param {{ state: string, closed?: number, required?: number, fraction?: number, computedAt?: string|null, rejected?: boolean }|null|undefined} progress
 * @param {number} [nowMs] - pinned "now" for the age label; defaults to Date.now()
 * @returns {string}
 */
function renderSprintProgressHtml(progress, nowMs) {
    var placeholder = function (text, cls) {
        return '<div class="sprint-progress-status ' + cls + '" style="padding: 8px 0; font-size: 12px; color: #71717a; font-style: italic;">' + text + '</div>';
    };
    var state = progress && typeof progress === 'object' ? progress.state : null;
    var hasNumbers = !!progress && typeof progress.closed === 'number' && Number.isFinite(progress.closed) &&
        typeof progress.required === 'number' && Number.isFinite(progress.required);
    if (state === 'no-summary') {
        return placeholder('no summary yet', 'sprint-progress-no-summary');
    }
    if ((state !== 'ok' && state !== 'unreachable') || !hasNumbers) {
        return placeholder('status unavailable', 'sprint-progress-unavailable');
    }
    var now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
    var age = formatSummaryAge(progress.computedAt, now);
    var ageHtml = '<span class="sprint-progress-age" style="color: #a1a1aa; font-size: 12px; white-space: nowrap;">as of ' +
        (age === null ? 'unknown' : age) + '</span>';
    var markerHtml = state === 'unreachable'
        ? '<span class="sprint-progress-unreachable" style="color: #f59e0b; font-size: 12px; white-space: nowrap;">unreachable</span>'
        : '';
    return (
        '<div class="sprint-progress-row" style="display: flex; align-items: center; gap: 8px;">' +
        '<div style="flex: 1;">' +
        renderProgressBarHtml({ closed: progress.closed, required: progress.required, fraction: progress.fraction }) +
        '</div>' +
        ageHtml +
        markerHtml +
        '</div>'
    );
}

/**
 * Renders one running sprint's section.
 *
 * (apra-fleet-i9ag.3.2) `mountPrefix` is threaded in EXPLICITLY (never read
 * off module or global state) because this exact function is also shipped to
 * the browser via `.toString()` inside sprintStackLiveScript() and re-renders
 * rows there from GET /state -- a live-refreshed row must carry the same
 * mount-aware links the server-rendered one did, and the client has no way to
 * re-derive the prefix from the request. Omitted/'' -> paths exactly as before.
 * @param {SprintView} view
 * @param {string} [mountPrefix] - mount-prefix.mjs's resolved prefix (e.g. '/ext/se'), or '' to serve direct
 * @param {number} [nowMs] - pinned "now" for the progress "as of" label; defaults to Date.now()
 * @returns {string}
 */
export function renderSprintSection(view, mountPrefix, nowMs) {
    const sprintId = escapeHtml(view.sprintId);
    // (apra-fleet-i9ag.5.2) Stable, escaped anchor id for this card -- the
    // live-view proxy's injected back-link (proxy.mjs) targets this same id
    // via sprintCardAnchorId(), so the two can never drift apart. Already
    // safe as an HTML id / URL fragment; no further escaping needed.
    const anchorId = sprintCardAnchorId(view.sprintId);
    const branch = view.branch ? escapeHtml(view.branch) : 'unknown';
    const base = view.base ? escapeHtml(view.base) : '';
    const goal = view.goal ? escapeHtml(view.goal) : 'unknown';
    const beadCount = Number.isInteger(view.beadCount) ? String(view.beadCount) : 'unknown';
    const progressHtml = renderSprintProgressHtml(view.progress, nowMs);
    const scopeRoots = (view.issueRoots ?? []).map((id) => escapeHtml(id)).join(', ') || 'none';
    const members = (view.members ?? []);
    const membersHtml = members.length > 0
        ? members.map(memberChip).join('')
        : '<span style="color:#71717a; font-style: italic;">no members recorded</span>';
    // Supervisor-relative path ONLY -- never a bare child port (Plan Part 2.3:
    // bare child-port links leak port allocation and break across hosts).
    const liveHref = mountHref(mountPrefix, '/sprints/' + encodeURIComponent(view.sprintId) + '/live');
    // apra-fleet-ou7.2: the raw stdout/stderr log link -- present for EVERY
    // row this stack renders, including a CRASHED sprint (the live SSE
    // viewer above is gone/unresponsive for that status; the raw log is the
    // one remaining way to see what the child actually printed).
    const logHref = mountHref(mountPrefix, '/sprints/' + encodeURIComponent(view.sprintId) + '/log');
    // (apra-fleet-i9ag.4) Terminal outcome, once known: verdict badge plus PR
    // link, the same pair the finished-sprints list renders. Nothing renders
    // while the run has produced neither (the normal case for a live sprint).
    const hasOutcome = (typeof view.verdict === 'string' && view.verdict.length > 0) ||
        (typeof view.prUrl === 'string' && view.prUrl.length > 0);
    const outcomeHtml = hasOutcome ? verdictBadge(view.verdict) + prLink(view.prUrl) : '';
    // (apra-fleet-i9ag.16.7) A stack row for a run that ended badly (a CRASHED
    // or LAUNCH_FAILED classification, or a failed terminal verdict) surfaces
    // WHY right here, next to the status badge -- previously the reason existed
    // only on the live viewer / History page, so the one place an operator
    // actually watches showed a red badge with no explanation. A healthy row's
    // `reason` is null, so this renders nothing at all for it.
    const reasonHtml = isFailedRunOutcome(view.status, view.verdict)
        ? failureReasonHtml(view.reason)
        : '';

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
        '<section id="' + anchorId + '" data-sprint-id="' + sprintId + '" style="border: 1px solid rgba(255,255,255,0.1); ' +
        'border-radius: 6px; padding: 12px 14px; margin-bottom: 12px;">' +
        '<div style="display:flex; align-items:center; gap: 10px; flex-wrap: wrap;">' +
        '<strong style="font-size: 14px;">' + sprintId + '</strong>' +
        statusBadge(view.status) +
        outcomeHtml +
        '<a href="' + liveHref + '" target="_blank" rel="noopener" style="margin-left:auto; font-size: 12px;">Open live view</a>' +
        '<a href="' + logHref + '" target="_blank" rel="noopener" style="font-size: 12px;">Raw log</a>' +
        // apra-fleet-3i3.1: kills the still-live child AND releases the
        // member+scope reservation in one action (POST /api/reservations/
        // :sprintId/force-release, extended -- see reconcile.mjs). A plain
        // button (not a form submit) wired up by sprintStopScript() below via
        // event delegation on data-sprint-id, matching the Launch Sprint
        // form's formatLaunchError() inline-feedback convention.
        '<button type="button" class="btn btn-secondary btn-stop-sprint" data-sprint-id="' + sprintId + '" ' +
        'style="font-size: 12px;">Stop</button>' +
        pauseResumeButton +
        // apra-fleet-3i3.3: releases the SAME reservation (via the SAME
        // force-release route Stop uses) then re-launches the SAME sprint via
        // POST /api/sprints, without a separate manual Stop first -- see
        // sprintRestartScript() below and reconcile.mjs's forceRelease(),
        // which now echoes back branch/base/goal/members/issueRoots for
        // exactly this purpose.
        '<button type="button" class="btn btn-secondary btn-restart-sprint" data-sprint-id="' + sprintId + '" ' +
        'style="font-size: 12px;">Restart</button>' +
        '</div>' +
        reasonHtml +
        progressHtml +
        '<div style="margin-top: 8px; font-size: 13px; color: #d4d4d8;">' +
        '<div><span style="color:#a1a1aa;">Branch:</span> ' + branch + (base ? ' -> ' + base : '') + '</div>' +
        '<div><span style="color:#a1a1aa;">Goal:</span> ' + goal + '</div>' +
        // apra-fleet-vk0a.3: explicitly labeled 'total in scope' -- distinct
        // from the progress bar's OWN, differently-scoped 'Required: M/N'
        // widget a few lines above (the child's own published summary,
        // goal-filtered). This raw count legitimately GROWS
        // over a sprint's life (planners/reviewers add tasks under an
        // already-claimed root); labeling it distinguishes that from a
        // glitch and from the filtered 'Required' count staying flat.
        '<div><span style="color:#a1a1aa;">Claimed scope:</span> ' + beadCount + ' bead(s) total in scope, unfiltered (roots: ' + scopeRoots + ')</div>' +
        // (apra-fleet-p2to.3.1) base-drift indicator -- see baseDriftIndicator()'s
        // doc comment for the "unknown" vs "0 drift" distinction.
        '<div>' + baseDriftIndicator(view.baseDrift ?? null, view.base ?? null) + '</div>' +
        // The beads prefix the supervisor resolved when it launched this
        // sprint (ledger entry `beads`, see beads-identity.mjs); omitted for
        // a reservation predating that field.
        (view.beadsPrefix
            ? '<div><span style="color:#a1a1aa;">Beads prefix:</span> ' + escapeHtml(view.beadsPrefix) + '</div>'
            : '') +
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
 * @param {string} [mountPrefix] - (apra-fleet-i9ag.3.2) forwarded verbatim to renderSprintSection()
 * @returns {string}
 */
export function renderSprintStackHtml(views, mountPrefix) {
    const list = Array.isArray(views) ? views : [];
    if (list.length === 0) {
        return '<p style="color:#71717a; font-style: italic;">No sprints are currently running.</p>';
    }
    // NOT `list.map(renderSprintSection)`: Array#map passes (value, index,
    // array), which would hand the row index in as `mountPrefix`.
    return list.map((view) => renderSprintSection(view, mountPrefix)).join('\n');
}
// apra-fleet-i9ag.20.1: DASHBOARD_CSS extracted to ./theme.mjs as the single
// source of truth shared with console pages (such as /ui/projects).


// (apra-fleet-siqi.2.1) How old a tab's last fetch must be, in ms, before
// activating that tab triggers a fresh one -- rather than just showing
// whatever markup the last full-page load (or last poll/filter fetch)
// already produced. Deliberately shorter than sprintStackLiveScript()'s own
// HEARTBEAT_INTERVAL_MS (7000, above) so a tab switch shortly after that
// heartbeat's own poll does not double-fetch, but idling on one tab for even
// a few seconds before switching still gets a genuinely fresh fetch on
// activation rather than stale data.
const TAB_ACTIVATION_STALE_MS = 3000;

const DASHBOARD_TAB_SCRIPT = `
    var TAB_ACTIVATION_STALE_MS = ${TAB_ACTIVATION_STALE_MS};
    function switchTab(id) {
        document.querySelectorAll('.tab-btn').forEach(function (b) { b.classList.remove('active'); });
        document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
        event.currentTarget.classList.add('active');
        document.getElementById('tab-' + id).classList.add('active');
        // apra-fleet-siqi.2.1: activating a tab triggers a fresh fetch of
        // THAT tab's own data through the SAME fetch/poll plumbing each tab
        // already uses elsewhere (sprintStackLiveScript()'s schedulePoll()/
        // poll() for Sprints, backlogPanelClientScript()'s applyFilters() for
        // Backlog) -- never a separate one-off fetch call -- but only when
        // the last such fetch is stale (see TAB_ACTIVATION_STALE_MS above);
        // each tab tracks and refreshes independently of the other.
        if (id === 'sprints' && window.__fleetSeSprintStack && typeof window.__fleetSeSprintStack.refreshIfStale === 'function') {
            window.__fleetSeSprintStack.refreshIfStale(TAB_ACTIVATION_STALE_MS);
        } else if (id === 'backlog' && window.__fleetSeBacklog && typeof window.__fleetSeBacklog.refreshIfStale === 'function') {
            window.__fleetSeBacklog.refreshIfStale(TAB_ACTIVATION_STALE_MS);
        }
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
 * apra-fleet-siqi.1.2, sprintStackLiveScript() below DOES periodically
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
 *
 * (apra-fleet-i9ag.3.2) Built per render rather than once at module load: the
 * route target is interpolated through mountHref() against THIS request's
 * resolved mount prefix, so the same script works served direct and inside the
 * console's /ext/<id> iframe. Interpolating the prefix into a single-quoted JS
 * literal is safe because mount-prefix.mjs's allowlist rejects any value
 * containing a quote, backslash or angle bracket (fail-closed to '').
 * @param {string} [mountPrefix]
 * @returns {string}
 */
const sprintStopScript = (mountPrefix) => `
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
        fetch('${mountHref(mountPrefix, '/api/reservations/')}' + encodeURIComponent(sprintId) + '/force-release', {
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
 * sprintStopScript() above). A click on any `.btn-restart-sprint` button:
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
 *
 * (apra-fleet-i9ag.3.2) Built per render, same as sprintStopScript() above --
 * all three of its app-paths (force-release, POST /api/sprints, and the new
 * sprint's live-view link) are interpolated through mountHref().
 * @param {string} [mountPrefix]
 * @returns {string}
 */
const sprintRestartScript = (mountPrefix) => `
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
        fetch('${mountHref(mountPrefix, '/api/reservations/')}' + encodeURIComponent(sprintId) + '/force-release', {
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
            fetch('${mountHref(mountPrefix, '/api/sprints')}', {
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
                        link.href = '${mountHref(mountPrefix, '/sprints/')}' + encodeURIComponent(r2.json.sprintId) + '/live';
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
 * `.toString()`-embedding pattern as sprintStopScript()/sprintRestartScript()
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
 * next full page load"; as of siqi.1.2, sprintStackLiveScript()'s own
 * periodic /state poll rebuilds this row too, so the correct button/badge
 * typically appears within a poll cycle with no manual reload needed -- this
 * script itself still does not attempt to predict or race that outcome, it
 * only reports the request as submitted. Every promise chain ends in a
 * `.catch()`, matching the other two scripts' discipline.
 *
 * (apra-fleet-i9ag.3.2) Built per render, same as the two scripts above -- its
 * `/sprints/:id/live/(pause|resume)` target is interpolated through
 * mountHref().
 * @param {string} [mountPrefix]
 * @returns {string}
 */
const sprintPauseScript = (mountPrefix) => `
    ${formatStopError.toString()}
    function requestPauseResume(btn, action) {
        var sprintId = btn.getAttribute('data-sprint-id');
        if (!sprintId) return;
        var resultEl = document.querySelector('.pause-result[data-sprint-id="' + sprintId + '"]');
        btn.disabled = true;
        if (resultEl) { resultEl.style.color = '#a1a1aa'; resultEl.textContent = (action === 'pause' ? 'Pause' : 'Resume') + ' requested...'; }
        fetch('${mountHref(mountPrefix, '/sprints/')}' + encodeURIComponent(sprintId) + '/live/' + action, { method: 'POST' })
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
 * elements themselves -- see sprintStopScript()'s doc comment), a newly
 * appeared sprintId is appended, and a row whose sprintId is no longer in
 * the payload (finished/force-released/restarted-away since the last poll)
 * is removed -- falling back to the SAME empty-state message
 * `renderSprintStackHtml()` renders server-side when the list goes to zero.
 */
const sprintStackLiveScript = (mountPrefix) => `
    ${escapeHtml.toString()}
    // (apra-fleet-i9ag.3.2) The resolved mount prefix + the SAME mountHref()
    // helper the server render uses, shipped verbatim so renderSprintSection()
    // below (embedded via .toString()) builds a live-refreshed row's live/log
    // links exactly as the server-rendered row did. Declared AFTER escapeHtml
    // deliberately: supervisor-dashboard-live-refresh.test.mjs extracts this
    // script from its first embedded helper (the escapeHtml declaration) to
    // the closing script tag, so anything emitted before that helper would be
    // invisible to -- and therefore undefined in -- that harness.
    var MOUNT_PREFIX = '${mountPrefix || ''}';
    ${mountHref.toString()}
    ${memberChip.toString()}
    ${baseDriftIndicator.toString()}
    var WATCHDOG_STATUS = ${JSON.stringify(WATCHDOG_STATUS)};
    var STATUS_BADGE_COLORS = ${JSON.stringify(STATUS_BADGE_COLORS)};
    ${statusBadge.toString()}
    var VERDICT_BADGE_COLORS = ${JSON.stringify(VERDICT_BADGE_COLORS)};
    ${verdictBadge.toString()}
    ${prLink.toString()}
    // (apra-fleet-i9ag.16.2) launchFailedBadge() is renderFinishedRunsHtml()'s
    // OTHER badge dependency, alongside verdictBadge() above -- embedded here
    // so a launch-failed row in a /state poll response re-renders identically
    // to the server's first paint instead of throwing "launchFailedBadge is
    // not defined" inside renderFinishedRunsHtml() below (which poll()
    // swallows into a console-only 'Poll Error:', silently freezing the
    // Finished Sprints list from the first poll onward).
    ${launchFailedBadge.toString()}
    // (apra-fleet-i9ag.16.7) renderFinishedRunsHtml() AND renderSprintSection()
    // below both call isFailedRunOutcome()/failureReasonHtml() to decide and
    // render a failed run's reason line -- embedded here for exactly the same
    // reason launchFailedBadge() above is: a helper a toString-embedded
    // renderer calls but that was never embedded itself throws a
    // ReferenceError inside poll(), which swallows it into a console-only
    // 'Poll Error:' and silently freezes the list from the first poll onward.
    // The two frozen arrays go over as inline JSON (same as WATCHDOG_STATUS/
    // STATUS_BADGE_COLORS above) since isFailedRunOutcome() closes over them.
    var FAILED_VERDICTS = ${JSON.stringify(FAILED_VERDICTS)};
    var FAILED_RUN_STATUSES = ${JSON.stringify(FAILED_RUN_STATUSES)};
    ${isFailedRunOutcome.toString()}
    ${failureReasonHtml.toString()}
    ${renderFinishedRunsHtml.toString()}
    ${renderProgressBarHtml.toString()}
    ${formatSummaryAge.toString()}
    ${renderSprintProgressHtml.toString()}
    // (apra-fleet-i9ag.5.2) renderSprintSection() below now calls
    // sprintCardAnchorId() to stamp the card's anchor id -- embedded here,
    // BEFORE renderSprintSection() itself, for the exact same reason every
    // other renderSprintSection() dependency above is: this whole block is
    // shipped to the browser as inline script text via .toString(), never
    // imported, so anything it references must be declared in this same
    // script first.
    ${sprintCardAnchorId.toString()}
    ${renderSprintSection.toString()}
    ${renderBeadsFreshnessHtml.toString()}

    // Re-renders the "Beads as of" line from GET /state's beadsFreshness.
    function renderBeadsFreshnessFromState(f) {
        var el = document.getElementById('beads-freshness');
        if (!el || !f) return;
        el.outerHTML = renderBeadsFreshnessHtml(f);
    }

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
            var html = renderSprintSection(view, MOUNT_PREFIX);
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

    // apra-fleet-siqi.2.1: when this poll was last (attempted to be) run --
    // set up front, not just on success, so a Sprints-tab activation right
    // after a poll was already scheduled/kicked off never piles on a second,
    // redundant one; see window.__fleetSeSprintStack.refreshIfStale() below.
    var lastPollAt = 0;
    async function poll() {
        lastPollAt = Date.now();
        try {
            var res = await fetch('${mountHref(mountPrefix, '/state')}?_t=' + Date.now(), { cache: 'no-store' });
            var data = await res.json();
            // Each section is isolated so one section's render failure
            // (e.g. a malformed sprint view) never skips the others; the
            // error is still console.error-logged, never swallowed.
            try {
                var counterEl = document.getElementById('running-counter');
                if (counterEl) {
                    var running = Array.isArray(data.sprints) ? data.sprints.length : 0;
                    counterEl.innerHTML = '<strong>' + running + '</strong> running';
                }
            } catch (e) {
                console.error('Poll Error (counter):', e);
            }
            try {
                renderSprintStackFromState(data.sprints);
            } catch (e) {
                console.error('Poll Error (sprint stack):', e);
            }
            // apra-fleet-i9ag.4: the finished-sprints list rides the SAME
            // poll, so a sprint that just left the stack above shows up
            // below (with its verdict/PR) without a page reload.
            try {
                var finishedEl = document.getElementById('finished-sprints');
                if (finishedEl && Array.isArray(data.finished)) {
                    finishedEl.innerHTML = renderFinishedRunsHtml(data.finished, MOUNT_PREFIX);
                }
            } catch (e) {
                console.error('Poll Error (finished sprints):', e);
            }
            try {
                renderBeadsFreshnessFromState(data.beadsFreshness);
            } catch (e) {
                console.error('Poll Error (beads freshness):', e);
            }
        } catch (e) {
            console.error('Poll Error:', e);
        }
    }

    // apra-fleet-siqi.2.1: the Sprints-tab-activation refresh hook
    // (DASHBOARD_TAB_SCRIPT's switchTab()) reaches this SAME
    // schedulePoll()/poll() plumbing through here -- never a separate
    // one-off fetch -- and only when the last poll is stale. Guarded on
    // 'typeof window' (rather than a bare reference) so this script stays
    // runnable in a sandboxed Function-eval harness that never supplies a
    // 'window' global (e.g. supervisor-dashboard-live-refresh.test.mjs's
    // runLiveRefreshScript(), which only passes document/fetch/EventSource)
    // -- a real browser <script> tag always has 'window' defined, so this
    // guard is a no-op true branch there.
    if (typeof window !== 'undefined') {
        window.__fleetSeSprintStack = {
            refreshIfStale: function (maxAgeMs) {
                if (Date.now() - lastPollAt >= maxAgeMs) schedulePoll();
            },
        };
    }

    if (typeof EventSource !== 'undefined') {
        var source = new EventSource('${mountHref(mountPrefix, '/events')}');
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
 * (apra-fleet-i9ag.5.1) The header's "back to console" link: `<origin>/ui`,
 * `target="_top"` -- deliberately, since the dashboard is normally displayed
 * inside the console's `/ext/se/...` iframe (apra-fleet-i9ag.3) and this link
 * intentionally leaves that iframe rather than navigating inside it -- and
 * `rel="noopener"`, matching every other outbound link this module renders
 * (Supervisor log, Open live view, Raw log).
 *
 * `origin` is the ONLY source of the host/port in this link -- this function
 * never hardcodes one. It is resolved exactly once in bin/serve.mjs from the
 * SAME apra-fleet server connection workflow-package registration itself uses
 * (resolveFleetServerConnection()), so the link can never drift from where
 * this supervisor actually registered. Renders nothing (not a placeholder or
 * dead href) when `origin` is not a non-empty string -- bin/serve.mjs passes
 * nothing on its registration-skipped path (no fleet.key, or no apra-fleet
 * HTTP server URL configured), and a dead link is worse than no link.
 * @param {string|null|undefined} origin
 * @returns {string}
 */
export function renderConsoleLinkHtml(origin) {
    if (typeof origin !== 'string' || origin.length === 0) return '';
    return '<a href="' + escapeHtml(origin) + '/ui" target="_top" rel="noopener" style="font-size: 12px;">Console</a>';
}

/**
 * The single "which .beads is this supervisor running against" line shown
 * above the Sprint Stack: "Beads: <dir> | prefix <p> | <syncRemote>", every
 * field HTML-escaped, styled like the Supervisor-log link line in the header.
 * When the identity is UNKNOWN (no .beads found / probe failed) and
 * `warning` carries the reason, renders an amber "Beads: NOT RESOLVED --
 * <warning>" line instead (the warning text already says what to do).
 * Renders nothing when neither was supplied (tests, inert skeleton).
 * @param {{ dir?: string, prefix?: string, syncRemote?: string }|null|undefined} beads
 * @param {string|null|undefined} [warning]
 * @returns {string}
 */
export function renderBeadsHeaderHtml(beads, warning) {
    if (!beads || typeof beads !== 'object') {
        if (typeof warning !== 'string' || !warning.trim()) return '';
        return '<div class="beads-identity beads-identity-warning" style="font-size: 12px; color: #f59e0b; padding: 4px 16px;">' +
            '<strong>Beads: NOT RESOLVED</strong> -- ' + escapeHtml(warning) + '</div>\n';
    }
    const dir = escapeHtml(beads.dir || '(unknown)');
    const prefix = escapeHtml(beads.prefix || '?');
    const remote = escapeHtml(beads.syncRemote || '(sync.remote unset)');
    return '<div class="beads-identity" style="font-size: 12px; color: #a1a1aa; padding: 4px 16px;">' +
        'Beads: <span style="color:#d4d4d8;">' + dir + '</span> | prefix <span style="color:#d4d4d8;">' + prefix + '</span>' +
        ' | <span style="color:#d4d4d8;">' + remote + '</span></div>\n';
}

/**
 * apra-fleet-i9ag.19.12: the "which node and bd is this supervisor actually
 * using" header line, directly below the Beads identity line -- an operator
 * who just hit a 503 (node-runner.mjs's CONFIGURED-tier hard error) has no
 * other way to see the recorded pair without reading the service log.
 *
 * Renders nothing when there is no report at all (`toolchain` null/absent --
 * the inert skeleton, or a test that wires no toolchain dep) OR when the
 * report says nothing was ever recorded (`toolchain.configured === false`,
 * e.g. an older install or a foreground dev run) -- there is nothing an
 * operator needs to see in either case, matching `renderBeadsHeaderHtml()`'s
 * own "nothing to say -> nothing rendered" default just above.
 *
 * When there IS a recording, this always shows the resolved node/bd paths
 * and versions -- and additionally renders the SAME amber "problem" treatment
 * `renderBeadsHeaderHtml()` gives an unresolved beads identity whenever
 * `toolchain.problems` is non-empty (a broken node OR a broken bd; not
 * `!toolchain.ok` alone, which -- per toolchain.mjs's own contract -- tracks
 * NODE health only and would silently hide a bd-only problem from the
 * dashboard even though it is still real and still worth an operator's
 * attention, just not the launch-blocking severity that ALSO trips a 503 and
 * GET /api/health's `toolchainWarning`). The report's own `fixLine` is reused
 * verbatim -- never a second, hand-copied fix sentence here.
 * @param {{ configured?: boolean, nodePath?: string|null, nodeVersion?: string|null, bdPath?: string|null, bdVersion?: string|null, source?: string, ok?: boolean, problems?: string[], fixLine?: string }|null|undefined} toolchain
 * @returns {string}
 */
export function renderToolchainHeaderHtml(toolchain) {
    if (!toolchain || typeof toolchain !== 'object' || !toolchain.configured) return '';
    const node = escapeHtml(toolchain.nodePath || '(unknown)');
    const nodeVer = escapeHtml(toolchain.nodeVersion || '?');
    const bd = escapeHtml(toolchain.bdPath || '(unknown)');
    const bdVer = escapeHtml(toolchain.bdVersion || '?');
    const statusLine = '<div class="toolchain-status" style="font-size: 12px; color: #a1a1aa; padding: 4px 16px;">' +
        'Toolchain: node <span style="color:#d4d4d8;">' + node + '</span> (v' + nodeVer + ')' +
        ' | bd <span style="color:#d4d4d8;">' + bd + '</span> (v' + bdVer + ')</div>\n';
    if (!Array.isArray(toolchain.problems) || toolchain.problems.length === 0) return statusLine;
    const problemText = [...toolchain.problems, toolchain.fixLine].filter(Boolean).join(' ');
    return statusLine +
        '<div class="toolchain-status toolchain-status-warning" style="font-size: 12px; color: #f59e0b; padding: 4px 16px;">' +
        '<strong>Toolchain problem:</strong> ' + escapeHtml(problemText) + '</div>\n';
}

/**
 * Normalize the cached beads view's snapshot into the wire/render freshness
 * shape. ASCII only. `lastSkip` (a busy/lock round, rows kept) is carried
 * separately from `lastError` (a real failure).
 * @param {object|null} snap - beads-view snapshot()
 * @returns {{ asOf: string|null, lastError: {message:string, at:string}|null, lastSkip: {reason:string, at:string}|null }|null}
 */
export function toBeadsFreshness(snap) {
    if (!snap || typeof snap !== 'object') return null;
    const iso = (t) => (typeof t === 'number' && Number.isFinite(t) ? new Date(t).toISOString() : null);
    return {
        asOf: iso(snap.asOf),
        lastError: snap.lastError ? { message: String(snap.lastError.message ?? ''), at: iso(snap.lastError.at) } : null,
        lastSkip: snap.lastSkip ? { reason: String(snap.lastSkip.reason ?? ''), at: iso(snap.lastSkip.at) } : null,
    };
}

/**
 * Renders the "Beads as of <time>" line plus a visible failure notice when the
 * view's last refresh failed. A busy-skip renders as a muted note, NOT as an
 * error. Returns '' when no freshness is supplied.
 * @param {ReturnType<typeof toBeadsFreshness>} f
 * @returns {string}
 */
export function renderBeadsFreshnessHtml(f) {
    if (!f) return '';
    const asOf = f.asOf ? 'Beads as of ' + escapeHtml(f.asOf) : 'Beads as of (not yet synced)';
    let html = '<div id="beads-freshness" class="beads-freshness" style="font-size: 12px; color: #a1a1aa; padding: 4px 16px;">' + asOf;
    if (f.lastSkip && !f.lastError) {
        html += ' <span class="beads-refresh-busy" style="color:#a1a1aa;">(refresh deferred: ' + escapeHtml(f.lastSkip.reason) + '; will retry)</span>';
    }
    if (f.lastError) {
        html += '<div class="beads-refresh-error" style="color: #ef4444;"><strong>Beads refresh failed:</strong> ' + escapeHtml(f.lastError.message) + '</div>';
    }
    return html + '</div>\n';
}

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
 * @param {{ beads?: { dir?: string, prefix?: string, syncRemote?: string, repoRemote?: string }|null, beadsWarning?: string|null, consoleOrigin?: string|null, mountPrefix?: string, finishedRuns?: Array<object>, toolchain?: object|null }} [opts]
 *   `beads`: the supervisor's resolved .beads identity (beads-identity.mjs's
 *   toBeadsSummary()), rendered as one header line above the Sprint Stack;
 *   `beadsWarning`: when `beads` is null, why it is unknown (rendered as an
 *   amber warning line in its place).
 *   `toolchain`: (apra-fleet-i9ag.19.12) the startup toolchain-validation
 *   report (./toolchain.mjs's validateRecordedToolchain() result, the SAME
 *   object GET /api/health projects) -- rendered as its own header line via
 *   renderToolchainHeaderHtml() above, directly below the Beads line.
 *   `consoleOrigin`: (apra-fleet-i9ag.5.1) the console's own origin, rendered
 *   as a "Console" header link via renderConsoleLinkHtml() above -- omitted
 *   entirely when not a non-empty string.
 *   `mountPrefix`: (apra-fleet-i9ag.3.2) the mount path this request arrived
 *   under, already validated by mount-prefix.mjs (resolveMountPrefix(), called
 *   in registerDashboardRoutes() below). Every absolute app-path this page
 *   emits -- the Supervisor-log link, each sprint card's live/log anchors, the
 *   finished-sprints list's History links, and all four client scripts'
 *   fetch()/EventSource targets -- is built through mountHref() against it.
 *   Absent/'' (the serve-direct case, and every pre-existing caller) leaves
 *   every one of those paths exactly as it was.
 *   `finishedRuns`: (apra-fleet-i9ag.4) the finished-sprints list rendered
 *   below the Sprint Stack (history-view.mjs's createFinishedRunsIndex()
 *   rows); absent -> the list's empty state.
 * @returns {string}
 */
export function renderIndexPageHtml(views, backlogHtml, launchFormHtml, opts = {}) {
    // Normalised ONCE here so every renderer/script below can interpolate it
    // unconditionally: a non-string (or absent) opts.mountPrefix is the
    // serve-direct case, never the literal string 'undefined' in an href.
    const mountPrefix = (opts && typeof opts.mountPrefix === 'string') ? opts.mountPrefix : '';
    const backlogSection = typeof backlogHtml === 'string'
        ? backlogHtml
        : '<p style="color:var(--text-muted); font-style: italic;">No unclaimed work in the backlog.</p>';
    const launchFormSection = typeof launchFormHtml === 'string' ? launchFormHtml : renderLaunchFormHtml(mountPrefix);
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
        '<div class="header-actions"><div class="stats-banner"><span id="running-counter"><strong>' + runningCount + '</strong> running</span></div>' +
        renderConsoleLinkHtml(opts && opts.consoleOrigin) +
        '<a href="' + mountHref(mountPrefix, '/supervisor/log') + '" target="_blank" rel="noopener" style="font-size: 12px;">Supervisor log</a></div>' +
        '</div>\n' +
        renderBeadsHeaderHtml(opts && opts.beads, opts && opts.beadsWarning) +
        renderToolchainHeaderHtml(opts && opts.toolchain) +
        renderBeadsFreshnessHtml(opts && opts.beadsFreshness) +
        '<div class="main-content"><div class="content-area">' +
        '<div class="tab-bar" id="tab-bar">' +
        '<button class="tab-btn active" onclick="switchTab(\'sprints\')">Sprints</button>' +
        '<button class="tab-btn" onclick="switchTab(\'backlog\')">Backlog</button>' +
        '</div>\n' +
        '<div id="tab-sprints" class="tab-content active panel">' +
        '<div class="panel-header">Sprint Stack</div>' +
        '<div class="panel-body">' +
        '<div id="sprint-stack">\n' + renderSprintStackHtml(views, mountPrefix) + '\n</div>' +
        // apra-fleet-i9ag.4: finished sprints (old runs), newest first, so a
        // sprint that leaves the live stack stays in view with its verdict,
        // PR and History link. Same tab, below the stack.
        '<div class="panel-header" style="margin: 16px -14px 12px; border-top: 1px solid var(--border);">Finished Sprints</div>' +
        '<div id="finished-sprints">\n' + renderFinishedRunsHtml(opts && opts.finishedRuns, mountPrefix) + '\n</div>' +
        '</div>' +
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
        '<script>' + sprintStopScript(mountPrefix) + '</script>\n' +
        '<script>' + sprintRestartScript(mountPrefix) + '</script>\n' +
        '<script>' + sprintPauseScript(mountPrefix) + '</script>\n' +
        // (apra-fleet-siqi.1.2) Live-refresh loop -- registered LAST so the
        // Stop/Restart/Pause scripts' own `document`-level delegated click
        // listeners (which sprintStackLiveScript()'s poll-driven rebuilds
        // rely on) are already wired before this script's first poll() can
        // possibly replace any row.
        '<script>' + sprintStackLiveScript(mountPrefix) + '</script>\n' +
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
 * @property {SummaryView|null} progress - the child's pulled summary, classified (see classifyChildSummary())
 * @property {Array<{ name: string, role: string|null }>} members
 * @property {string|null} base - (apra-fleet-p2to.3.1) the sprint's launch `--base` branch, as recorded on the ledger entry
 * @property {number|null} baseDrift - (apra-fleet-p2to.3.1) commits on `base` not yet reachable from `branch`; `null` when unknown (see computeBaseDrift())
 * @property {string|null} beadsPrefix - the beads prefix recorded on the ledger entry at launch (`beads.prefix`, beads-identity.mjs); null when absent
 * @property {string|null} verdict - (apra-fleet-i9ag.4) terminal verdict once known (from the run's persisted terminal state); null while unknown
 * @property {string|null} prUrl - (apra-fleet-i9ag.4) the run's PR URL once known; null when none
 * @property {string|null} reason - (apra-fleet-i9ag.16.7) WHY the run ended, once it has ended badly (from the finished-runs row's own terminal-state reason, else the watchdog classification's exit detail); null while the run is healthy or no reason is recorded
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
 *
 * (apra-fleet-i9ag.4) `finished` carries the finished-sprints list (the same
 * rows the page renders below the stack) so the client poll can refresh it;
 * it is only present when the caller supplies it.
 * @param {SprintView[]} [views]
 * @param {Array<object>} [finishedRuns]
 * @returns {{ generatedAt: string, runningCount: number, sprints: Array<object>, finished?: Array<object> }}
 */
export function buildStatePayload(views, finishedRuns, opts = {}) {
    // Back-compat with the main-side two-argument form buildStatePayload(views, { beadsFreshness }):
    // a plain (non-array) object in the second slot is the options bag.
    if (finishedRuns && typeof finishedRuns === 'object' && !Array.isArray(finishedRuns)) {
        opts = finishedRuns;
        finishedRuns = undefined;
    }
    const list = Array.isArray(views) ? views : [];
    const payload = {
        generatedAt: new Date().toISOString(),
        runningCount: list.length,
        beadsFreshness: (opts && opts.beadsFreshness) ?? null,
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
            beadsPrefix: v.beadsPrefix ?? null,
            verdict: v.verdict ?? null,
            prUrl: v.prUrl ?? null,
            // (apra-fleet-i9ag.16.7) The ending reason travels on the stack
            // row too, not just on `finished` below, so renderSprintSection()
            // renders it identically in the server's first paint and after a
            // /state poll -- the client re-render calls the SAME function.
            reason: v.reason ?? null,
        })),
    };
    if (Array.isArray(finishedRuns)) {
        // (apra-fleet-i9ag.16.2) status/reason/hasTerminalState travel through
        // verbatim so the client's live-refresh re-render (which embeds
        // renderFinishedRunsHtml() via .toString(), see sprintStackLiveScript())
        // can render a launch-failed row identically to the server's first
        // paint, instead of silently dropping the failure once the first
        // /state poll lands.
        payload.finished = finishedRuns.map((r) => ({
            sprintId: r.sprintId,
            verdict: r.verdict ?? null,
            prUrl: r.prUrl ?? null,
            endedAt: r.endedAt ?? null,
            goal: r.goal ?? null,
            status: r.status ?? null,
            reason: r.reason ?? null,
            hasTerminalState: r.hasTerminalState ?? null,
        }));
    }
    return payload;
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

// Per-row budget for pulling a child's GET /state?summary=1. Rows are pulled
// concurrently, so a hung child delays the whole page by at most this much.
const DEFAULT_SUMMARY_TIMEOUT_MS = 2000;
// A summary is a few hundred bytes; an old child serving its FULL /state on
// ?summary=1 can be far larger. Past this cap the body is not worth reading --
// it cannot be a summary.
const MAX_SUMMARY_BYTES = 1024 * 1024;

/**
 * @typedef {object} SummaryView
 * @property {'ok'|'unreachable'|'no-summary'|'unavailable'} state
 * @property {number} [closed]
 * @property {number} [required]
 * @property {number} [fraction]
 * @property {string|null} [computedAt] - extensions.beads.computed_at (when the child FETCHED the beads)
 * @property {boolean} [rejected] - unreachable because the port answered for a different runId
 */

/**
 * Default `fetchSummary` seam: HTTP GET http://127.0.0.1:PORT/state?summary=1.
 * One overall timer (started before the request) covers connect, headers AND
 * body, so a child that accepts the connection and then stalls still times
 * out. `agent: false` -- no pooled keep-alive socket outlives the call.
 *
 * Resolves `{ status, json }` for ANY HTTP response (`json` is `undefined`
 * when the body is not valid JSON or exceeds MAX_SUMMARY_BYTES); rejects on
 * connection error or timeout (the caller classifies that as unreachable).
 * @param {number} port
 * @param {{ timeoutMs?: number, host?: string }} [opts]
 * @returns {Promise<{ status: number, json: any }>}
 */
export function fetchChildSummary(port, opts = {}) {
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_SUMMARY_TIMEOUT_MS;
    const host = opts.host ?? '127.0.0.1';
    return new Promise((resolve, reject) => {
        let settled = false;
        let req = null;
        let res = null;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        };
        const timer = setTimeout(() => {
            const err = new Error(`child summary request timed out after ${timeoutMs}ms`);
            err.code = 'ETIMEDOUT';
            finish(reject, err);
            try { if (res) res.destroy(); } catch { /* ignore */ }
            try { if (req) req.destroy(); } catch { /* ignore */ }
        }, timeoutMs);
        try {
            req = http.get({ host, port, path: '/state?summary=1', agent: false, headers: { accept: 'application/json' } }, (response) => {
                res = response;
                const chunks = [];
                let size = 0;
                let oversize = false;
                response.on('data', (chunk) => {
                    if (oversize) return;
                    size += chunk.length;
                    if (size > MAX_SUMMARY_BYTES) {
                        oversize = true;
                        chunks.length = 0;
                        finish(resolve, { status: response.statusCode, json: undefined });
                        response.destroy();
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('end', () => {
                    let json;
                    try {
                        json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    } catch {
                        json = undefined;
                    }
                    finish(resolve, { status: response.statusCode, json });
                });
                response.on('error', (err) => finish(reject, err));
            });
            req.on('error', (err) => finish(reject, err));
        } catch (err) {
            finish(reject, err);
        }
    });
}

/**
 * Classify one pulled child summary response against the pinned wire shape
 * (GET /state?summary=1 -> { summaryVersion, runId, ..., extensions: { beads:
 * { closed, required, fraction, computed_at } } }). Order matters:
 *   1. non-200 / non-JSON / no summaryVersion (an old child) -> unavailable
 *   2. runId !== sprintId (the port now belongs to another run) -> rejected,
 *      checked BEFORE beads presence so another run's empty summary never
 *      reads as "no summary yet" for this sprint
 *   3. no extensions.beads -> no-summary
 *   4. non-finite closed/required -> unavailable (never 0/N)
 *   5. otherwise ok
 * @param {{ status: number, json: any }} response
 * @param {string} sprintId
 * @returns {{ kind: 'ok', summary: SummaryView }|{ kind: 'rejected', runId: any }|{ kind: 'no-summary' }|{ kind: 'unavailable' }}
 */
export function classifyChildSummary(response, sprintId) {
    const json = response ? response.json : undefined;
    if (!response || response.status !== 200 || !json || typeof json !== 'object' || Array.isArray(json)) {
        return { kind: 'unavailable' };
    }
    if (json.summaryVersion === undefined || json.summaryVersion === null) return { kind: 'unavailable' };
    if (json.runId !== sprintId) return { kind: 'rejected', runId: json.runId };
    const ext = json.extensions && typeof json.extensions === 'object' ? json.extensions : null;
    const beads = ext && ext.beads && typeof ext.beads === 'object' ? ext.beads : null;
    if (!beads) return { kind: 'no-summary' };
    const { closed, required } = beads;
    if (typeof closed !== 'number' || !Number.isFinite(closed) || typeof required !== 'number' || !Number.isFinite(required)) {
        return { kind: 'unavailable' };
    }
    const fraction = typeof beads.fraction === 'number' && Number.isFinite(beads.fraction)
        ? beads.fraction
        : (required > 0 ? closed / required : 0);
    const computedAt = typeof beads.computed_at === 'string' ? beads.computed_at : null;
    return { kind: 'ok', summary: { state: 'ok', closed, required, fraction, computedAt } };
}

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
 *   resolvePort?: (sprintId: string) => number|undefined, // live child viewer port; production injects child-port.mjs's ledger+spawner resolver
 *   spawner?: { getLiveEntry: (pid: number) => { port?: number }|undefined }, // used to build the default resolvePort when none is injected
 *   fetchSummary?: (port: number, opts: { timeoutMs: number, sprintId: string }) => Promise<{ status: number, json: any }>, // test seam; defaults to fetchChildSummary()
 *   summaryTimeoutMs?: number, // per-row summary pull budget; defaults to DEFAULT_SUMMARY_TIMEOUT_MS

 *   listAllBeads?: () => Promise<Array<{ id: string, status: string }>>,
 *   beadsView?: { snapshot: () => object }, // cached beads view; supplies the freshness shown on the page and in GET /state
 *   getSprintMeta?: (sprintId: string) => Promise<{ branch?: string, goal?: string, roles?: Record<string,string> }>|{ branch?: string, goal?: string, roles?: Record<string,string> },
 *   driftCheck?: (branch: string|null, base: string|null) => Promise<number|null>|number|null,
 *   backlog?: { renderHtml: () => Promise<string>|string },
 *   logger?: { log?: Function, error?: Function },
 *   eventsIntervalMs?: number, // (apra-fleet-siqi.1.1) GET /events signal cadence; defaults to DEFAULT_EVENTS_INTERVAL_MS
 *   beadsIdentity?: { get: () => object|null, getWarning?: () => string|null }, // beads-identity.mjs handle; drives the "Beads: ..." header line (or its warning form)
 *   consoleOrigin?: string|null, // (apra-fleet-i9ag.5.1) the console's own origin (e.g. 'http://127.0.0.1:7500'), resolved by bin/serve.mjs; drives the header's "Console" back-link (renderConsoleLinkHtml() above). Absent/non-string -> no link.
 *   finishedRuns?: { list: () => Promise<Array<{ sprintId: string, verdict: string|null, prUrl: string|null, endedAt: string|null }>> }, // (apra-fleet-i9ag.4) history-view.mjs's createFinishedRunsIndex(); drives the finished-sprints list and each card's verdict/PR
 * }} [deps]
 * @returns {{
 *   name: string,
 *   start(): Promise<void>,
 *   stop(): Promise<void>,
 *   buildSprintViews(finished?: Array<object>): Promise<SprintView[]>,
 *   buildFinishedRuns(): Promise<Array<object>>,
 *   renderIndexPage(renderOpts?: { mountPrefix?: string }): Promise<string>,
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
    // Optional beads-identity handle (beads-identity.mjs's
    // createBeadsIdentityState(); bin/serve.mjs wires the real one) -- read
    // on every renderIndexPage() for the header line. Absent -> no line.
    const beadsIdentity = deps.beadsIdentity && typeof deps.beadsIdentity.get === 'function' ? deps.beadsIdentity : null;
    // (apra-fleet-i9ag.5.1) The console's own origin -- see renderConsoleLinkHtml()
    // above and this module's @param doc for `consoleOrigin` for the full
    // "why this must never be hardcoded" rationale. Validated here to a
    // non-empty string or null, once, so renderIndexPage() below can pass it
    // straight through without re-validating.
    const consoleOrigin = typeof deps.consoleOrigin === 'string' && deps.consoleOrigin.length > 0 ? deps.consoleOrigin : null;
    // apra-fleet-i9ag.19.12: the SAME startup toolchain-validation report
    // GET /api/health projects (server.mjs's `deps.toolchain`) -- read on
    // every renderIndexPage() for the header line below. `null` (the default)
    // renders nothing, exactly like `beadsIdentity` absent above.
    const toolchain = deps.toolchain && typeof deps.toolchain === 'object' ? deps.toolchain : null;
    // apra-fleet-c4s.1: `deps.expandScope`, when injected, is called verbatim
    // (the pre-existing test seam -- see the module doc comment above). When
    // absent (production default, bin/serve.mjs), buildSprintViews() below
    // expands EVERY sprint's scope in-memory off the single listAllBeads()
    // fetch it already makes for progress bars, via buildChildIndex() +
    // expandScopeInMemory() -- never a subprocess walker.
    const explicitExpand = deps.expandScope ?? null;
    // apra-fleet-x8r.2: one bulk `bd list --all --json` fetch per
    // renderIndexPage() call (reused across every sprint row below), not one
    // per row -- same "one query fewer" discipline bdListScoped('')
    // documents in runner.js. Reuses scope-overlap.mjs's already-tested
    // bdListAllBeadsWithClosed() (normalizeBead()-compatible raw rows, `--all`
    // included) rather than a second bulk-fetch implementation -- see the
    // apra-fleet-72o0 note on the import above for why this must NOT be
    // backlog.mjs's bdListAllBeads().
    const listAllBeads = deps.listAllBeads ?? bdListAllBeadsWithClosed;
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
    // (apra-fleet-i9ag.4) Finished-sprints source (old runs). Absent -> an
    // empty list and no card ever shows a verdict/PR.
    const finishedRuns = deps.finishedRuns && typeof deps.finishedRuns.list === 'function' ? deps.finishedRuns : null;

    /**
     * (apra-fleet-i9ag.4) The finished-sprints rows, newest first. A read
     * failure degrades to an empty list for this render, never a thrown page.
     * @returns {Promise<Array<object>>}
     */
    async function buildFinishedRuns() {
        if (!finishedRuns) return [];
        try {
            const rows = await finishedRuns.list();
            return Array.isArray(rows) ? rows : [];
        } catch (err) {
            logError('[dashboard] finished-sprints read failed:', err);
            return [];
        }
    }

    // Optional cached beads view (beads-view.mjs): only its snapshot() is read
    // here, for the "Beads as of" line / failure notice. Rows reach this seam
    // through the injected `listAllBeads` (the snapshot reader), never bd.
    const beadsView = deps.beadsView && typeof deps.beadsView.snapshot === 'function' ? deps.beadsView : null;
    function beadsFreshness() {
        if (!beadsView) return null;
        try {
            return toBeadsFreshness(beadsView.snapshot());
        } catch (err) {
            logError('[dashboard] beads view snapshot failed:', err);
            return null;
        }
    }

    // Per-row progress comes from the child's own published summary (GET
    // /state?summary=1), pulled on every buildSprintViews(). resolvePort
    // defaults to the shared ledger+spawner resolver (child-port.mjs);
    // without a spawner it resolves nothing and every row reads as
    // unreachable/status unavailable rather than a supervisor recompute.
    const resolvePort = typeof deps.resolvePort === 'function'
        ? deps.resolvePort
        : createChildPortResolver({ ledger, spawner: deps.spawner ?? null });
    const summaryTimeoutMs = Number.isFinite(deps.summaryTimeoutMs) && deps.summaryTimeoutMs > 0
        ? deps.summaryTimeoutMs
        : DEFAULT_SUMMARY_TIMEOUT_MS;
    const fetchSummary = typeof deps.fetchSummary === 'function'
        ? deps.fetchSummary
        : (port) => fetchChildSummary(port, { timeoutMs: summaryTimeoutMs });
    // Last good (state 'ok') summary per sprintId -- in memory only; entries
    // for sprints no longer in the ledger list are evicted each build.
    const lastGoodSummary = new Map();

    /**
     * Pull + classify one sprint's summary. Never throws.
     * @param {string} sprintId
     * @returns {Promise<SummaryView>}
     */
    async function pullSprintSummary(sprintId) {
        let port;
        try {
            port = resolvePort(sprintId);
        } catch (err) {
            logError(`[dashboard] resolvePort failed for sprint '${sprintId}':`, err);
            port = undefined;
        }
        const unreachable = (rejected) => {
            const last = lastGoodSummary.get(sprintId);
            if (!last) return { state: 'unavailable' };
            return { ...last, state: 'unreachable', ...(rejected ? { rejected: true } : {}) };
        };
        if (!Number.isInteger(port) || port <= 0) return unreachable(false);
        let response;
        try {
            response = await fetchSummary(port, { timeoutMs: summaryTimeoutMs, sprintId });
        } catch {
            return unreachable(false);
        }
        const verdict = classifyChildSummary(response, sprintId);
        switch (verdict.kind) {
            case 'ok':
                lastGoodSummary.set(sprintId, verdict.summary);
                return verdict.summary;
            case 'rejected':
                logError(`[dashboard] summary from port ${port} carries runId '${String(verdict.runId)}', not sprint '${sprintId}' -- port reused by another run; ignoring it`);
                return unreachable(true);
            case 'no-summary':
                return { state: 'no-summary' };
            default:
                return { state: 'unavailable' };
        }
    }

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
    async function buildSprintViews(finished) {
        const entries = ledger.list();
        // Last-good cache eviction: a sprint no longer in the ledger list
        // never comes back under the same id, so its cached summary is dead.
        const liveIds = new Set(entries.map((e) => e.sprintId));
        for (const id of lastGoodSummary.keys()) {
            if (!liveIds.has(id)) lastGoodSummary.delete(id);
        }
        // Every row's child summary is pulled CONCURRENTLY and started FIRST
        // (before the finished-runs read, the bulk beads fetch and any per-row await), so the page
        // waits at most one summary timeout, never a serial sum of them.
        // pullSprintSummary() never rejects.
        const summaryPulls = new Map(entries.map((e) => [e.sprintId, pullSprintSummary(e.sprintId)]));
        // (apra-fleet-i9ag.4) verdict/PR per sprint, once its terminal state
        // exists -- looked up in the finished-runs rows (reused when the
        // caller already fetched them for this render).
        const finishedRows = Array.isArray(finished) ? finished : await buildFinishedRuns();
        const outcomeById = new Map(finishedRows.map((r) => [r.sprintId, r]));
        // apra-fleet-x8r.2: fetched ONCE for the whole page render (not once
        // per sprint row) -- feeds only the claimed-scope bead count now; a
        // failure here is isolated to "unknown" counts this round, never a
        // thrown page render.
        let allBeads = null;
        try {
            const rawBeads = await listAllBeads();
            // The default fetcher (bdListAllBeadsWithClosed) returns RAW,
            // unnormalized `bd list` rows -- normalizeBead() derives
            // `parentId` (buildChildIndex() below needs it). A test-injected
            // `deps.listAllBeads` may already return normalized rows;
            // normalizeBead() is idempotent on its own fields, so mapping
            // unconditionally is safe either way.
            allBeads = (Array.isArray(rawBeads) ? rawBeads : []).map(normalizeBead).filter((b) => b.id.length > 0);
        } catch (err) {
            logError('[dashboard] bulk beads fetch failed (claimed-scope counts will show unknown this round):', err);
        }
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
            } catch (err) {
                logError(`[dashboard] scope expansion failed for sprint '${entry.sprintId}':`, err);
            }

            const progress = await summaryPulls.get(entry.sprintId);

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
                beadsPrefix: entry.beads && entry.beads.prefix ? entry.beads.prefix : null,
                verdict: outcomeById.get(entry.sprintId)?.verdict ?? null,
                prUrl: outcomeById.get(entry.sprintId)?.prUrl ?? null,
                // (apra-fleet-i9ag.16.7) WHY this run ended, for a row that
                // ended badly. Preferred source is the run's OWN finished-runs
                // row -- the SAME record the Finished Sprints card and the
                // History page read, so the two can never disagree. A CRASHED
                // run has no terminal state file and therefore no such row, so
                // it falls back to the watchdog classification's own `detail`
                // ("exited 1 at ...", the ledger-recorded exit), which is
                // genuinely all that is known about why it ended.
                reason: outcomeById.get(entry.sprintId)?.reason ?? classification.detail ?? null,
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
        buildFinishedRuns,
        beadsFreshness,
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
        /**
         * @param {{ mountPrefix?: string }} [renderOpts] - (apra-fleet-i9ag.3.2)
         *   the request's resolved mount prefix (registerDashboardRoutes()
         *   below passes resolveMountPrefix(req)). Per-CALL, never per-seam:
         *   the same supervisor process serves direct and console-embedded
         *   requests concurrently, so this can never be cached on the closure.
         *   Absent -> serve-direct paths, unchanged.
         */
        async renderIndexPage(renderOpts = {}) {
            const mountPrefix = (renderOpts && typeof renderOpts.mountPrefix === 'string') ? renderOpts.mountPrefix : '';
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
                    backlogHtml = renderBacklogPanelHtml(tasks, filterOptions, mountPrefix);
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
            let beads = null;
            let beadsWarning = null;
            if (beadsIdentity) {
                try {
                    beads = toBeadsSummary(beadsIdentity.get());
                    if (!beads && typeof beadsIdentity.getWarning === 'function') beadsWarning = beadsIdentity.getWarning() || null;
                } catch (err) {
                    logError('[dashboard] beads identity read failed:', err);
                }
            }
            const finished = await buildFinishedRuns();
            return renderIndexPageHtml(await buildSprintViews(finished), backlogHtml, undefined, { beads, beadsWarning, consoleOrigin, mountPrefix, finishedRuns: finished, toolchain, beadsFreshness: beadsFreshness() });
        },
    };
}

/**
 * Registers `GET /` (plus, when given, every path in `extraIndexPaths`
 * against the SAME handler) against a supervisor (server.mjs), mirroring
 * the registration pattern of registerSprintRoutes()/registerReservationRoutes().
 *
 * (apra-fleet-i9ag.3.3) `extraIndexPaths` lets bin/serve.mjs mount this
 * exact page at the manifest's Sprints nav path (registration/manifest.mjs's
 * SPRINTS_UI_PATH) too, so the shell's Sprints nav entry embeds the real
 * dashboard instead of the /ui placeholder -- one handler, served at
 * however many paths the caller wires it to, never a second hand-copied
 * implementation.
 *
 * @param {{ route: (method: string, path: string, handler: Function) => void }} supervisor
 * @param {ReturnType<typeof createDashboard>} dashboard
 * @param {{ extraIndexPaths?: string[] }} [opts]
 */
export function registerDashboardRoutes(supervisor, dashboard, { extraIndexPaths = [] } = {}) {
    const renderIndexRoute = async (req, res) => {
        // apra-fleet-50j6.6: `?token=<service token>` is a token exchange --
        // a match sets the DERIVED se_token cookie and 302s to this same
        // path without the token; a mismatch answers 401 with no cookie.
        // `supervisor.token` is null when auth was never configured, in
        // which case there is nothing to exchange.
        if (handleTokenExchange(req, res, supervisor.token)) return;
        // (apra-fleet-i9ag.3.2) The console's /ext/<id> proxy stamps this
        // request's mount path on it (mount-prefix.mjs's MOUNT_PATH_HEADER);
        // resolveMountPrefix() validates it and falls back to '' (serve-direct,
        // byte-for-byte the pre-i9ag.3.2 page) for an absent or hostile value.
        // Resolved PER REQUEST: one supervisor process answers both direct and
        // embedded hits, and nothing about the mount is process-wide state.
        const html = await dashboard.renderIndexPage({ mountPrefix: resolveMountPrefix(req) });
        // apra-fleet-50j6.6: this route is open (read-only view on a
        // loopback bind), so it NEVER sets a cookie: an unauthenticated GET
        // handing out a credential let any local process harvest it (and the
        // service token may be the shared fleet key). An unauthenticated
        // view instead carries a short notice explaining how to sign in.
        const body = Buffer.from(injectAuthNotice(html, authNoticeHtml(req, supervisor.token)), 'utf-8');
        const headers = {
            'content-type': 'text/html; charset=utf-8',
            'content-length': body.length,
        };
        res.writeHead(200, headers);
        res.end(body);
    };
    supervisor.route('GET', '/', renderIndexRoute);
    for (const extraPath of extraIndexPaths) {
        if (typeof extraPath === 'string' && extraPath !== '' && extraPath !== '/') {
            supervisor.route('GET', extraPath, renderIndexRoute);
        }
    }

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
        // apra-fleet-i9ag.4: the finished-sprints list rides the same poll.
        // Optional on the seam so a minimal injected dashboard still works.
        const finished = typeof dashboard.buildFinishedRuns === 'function' ? await dashboard.buildFinishedRuns() : undefined;
        const views = await dashboard.buildSprintViews(finished);
        const body = Buffer.from(JSON.stringify(buildStatePayload(views, finished, { beadsFreshness: typeof dashboard.beadsFreshness === 'function' ? dashboard.beadsFreshness() : null })), 'utf-8');
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
