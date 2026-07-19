// =============================================================================
// Auto-sprint supervisor -- Launch Sprint form (apra-fleet-eft.6.3, Plan Part 2.3)
// =============================================================================
//
// The index page (GET /, dashboard.mjs) attaches ONE Launch Sprint form after
// the Backlog-last tree (eft.6.2): an issue picker fed by clicking Backlog
// rows, member/role assignment, a goal selector, and branch/base-branch name
// inputs. Submitting POSTs to POST /api/sprints (eft.4.4, src/supervisor/api.mjs)
// -- the SAME validated launch endpoint the CLI uses -- so this module never
// re-implements id/branch/member validation; it only builds a request body and
// renders the server's response (including 400 field errors and 409 member-
// overlap conflicts) legibly.
//
// SINGLE-ROOT CONSTRAINT: POST /api/sprints (api.mjs's validateLaunchRequest)
// accepts exactly one `issue` root per launch -- issueRoots is always a
// single-element array. The Backlog tree lets the operator click MULTIPLE rows
// (a true multi-select, toggling each row's highlight), but submission is only
// valid with EXACTLY one row selected; buildLaunchRequestBody() below returns a
// clear client-side validation error (not a server round-trip) for zero or
// more-than-one selections, so the operator is steered to a single root without
// this module inventing a multi-root launch semantics the server doesn't have.
//
// TESTABLE WITHOUT A DOM: buildLaunchRequestBody() and formatLaunchError() are
// plain, side-effect-free functions -- unit-testable directly from Node -- and
// are ALSO embedded verbatim into the rendered page's <script> via
// `.toString()` (the same pattern apra-fleet-workflow's viewer/index.mjs uses
// for escapeHtml), so the exact code under test is the exact code shipped to
// the browser, never a hand-duplicated copy.
//
// MEMBERS ARE FETCHED CLIENT-SIDE (GET /api/members) rather than server-
// rendered at page-load time: the member/reservation list can change while the
// operator has the page open, and this keeps renderLaunchFormHtml() a pure,
// dependency-free function -- no new collaborator seam needed on
// createDashboard() to wire this in.
// =============================================================================

import { escapeHtml } from '@apralabs/apra-fleet-workflow/viewer/html-utils';
import { ROLES } from '../../auto-sprint/contracts.mjs';

/** The goal selector offers EXACTLY these three values (acceptance criterion). */
export const GOAL_OPTIONS = Object.freeze(['P1', 'P1+P2', 'P1+P2+P3']);

/**
 * `roleMap`'s application-level pseudo-role (see auto-sprint/runner.js's
 * ROLE_ORCHESTRATOR doc comment) -- not a vendored contracts.ROLES member, but
 * still a valid --role-map key the operator may want to assign.
 */
const ORCHESTRATOR_ROLE = 'orchestrator';

/** Every role assignable from the form's per-member role <select>. */
export const FORM_ROLE_OPTIONS = Object.freeze([...ROLES, ORCHESTRATOR_ROLE]);

/**
 * Pure client-side validation + request-body construction for the Launch
 * Sprint form. Never talks to the network -- callers POST `result.body` to
 * POST /api/sprints themselves. See the module doc for why exactly one
 * selected issue root is required.
 *
 * @param {{
 *   selectedRoots: string[],
 *   members: string[],
 *   roleMap?: Record<string, string[]>,
 *   goal: string,
 *   branch: string,
 *   base: string,
 * }} input
 * @returns {{ ok: true, body: object }|{ ok: false, error: string }}
 */
export function buildLaunchRequestBody(input) {
    const opts = input || {};
    const roots = Array.isArray(opts.selectedRoots) ? opts.selectedRoots : [];
    if (roots.length === 0) {
        return { ok: false, error: 'Select an issue from the Backlog to launch.' };
    }
    if (roots.length > 1) {
        return {
            ok: false,
            error: 'Select exactly one issue -- launching multiple issue roots in a single sprint is not yet supported.',
        };
    }
    const members = Array.isArray(opts.members) ? opts.members.filter((m) => typeof m === 'string' && m.length > 0) : [];
    if (members.length === 0) {
        return { ok: false, error: 'Select at least one member.' };
    }
    if (!GOAL_OPTIONS.includes(opts.goal)) {
        return { ok: false, error: `Goal must be one of: ${GOAL_OPTIONS.join(', ')}.` };
    }
    const branch = typeof opts.branch === 'string' ? opts.branch.trim() : '';
    if (branch.length === 0) {
        return { ok: false, error: 'Branch name is required.' };
    }
    const base = typeof opts.base === 'string' ? opts.base.trim() : '';
    if (base.length === 0) {
        return { ok: false, error: 'Base branch name is required.' };
    }
    const body = { issue: roots[0], members, branch, base, goal: opts.goal };
    if (opts.roleMap && typeof opts.roleMap === 'object' && Object.keys(opts.roleMap).length > 0) {
        body.roleMap = opts.roleMap;
    }
    return { ok: true, body };
}

/**
 * Renders a POST /api/sprints error response (api.mjs's ApiError JSON shape:
 * `{ error: string, field?: string }`) as a legible operator-facing message.
 * A 409 (eft.5.2 member-overlap guard) is passed through VERBATIM -- the
 * server's `formatMemberConflict()` message already names the conflicting
 * sprint id(s) and the overlapping member names, so no re-derivation happens
 * here (acceptance criterion: "not a generic error"). A 400 names the
 * offending field alongside the server's exact message (acceptance criterion:
 * "the server's field-level message shown").
 * @param {number} status
 * @param {{ error?: string, field?: string }|null|undefined} errJson
 * @returns {string}
 */
export function formatLaunchError(status, errJson) {
    const message = (errJson && typeof errJson.error === 'string' && errJson.error.length > 0)
        ? errJson.error
        : `Launch failed (HTTP ${status}).`;
    if (status === 409) {
        return `Conflict: ${message}`;
    }
    if (status === 400 && errJson && typeof errJson.field === 'string' && errJson.field.length > 0) {
        return `Invalid ${errJson.field}: ${message}`;
    }
    return message;
}

/**
 * The Launch Sprint form's embedded client-side behavior, as a source string
 * ready to inline into a `<script>` tag. Wires:
 *   - GET /api/members on load, rendering a checkbox + role <select> per
 *     member (DOM APIs / textContent only -- never innerHTML with untrusted
 *     member names, so no HTML-escaping helper is needed here);
 *   - click-to-toggle multi-select on `#backlog li[data-bead-id]` rows (event
 *     delegation -- backlog.mjs's markup is untouched, this module only reads
 *     its `data-bead-id` attribute);
 *   - submit -> buildLaunchRequestBody() -> POST /api/sprints -> render the
 *     201 success or the formatLaunchError() message.
 * @returns {string}
 */
function clientScriptSource() {
    const roleOptionsJson = JSON.stringify(FORM_ROLE_OPTIONS);
    return `
(function () {
    var selectedRoots = [];
    var membersContainer = document.getElementById('launch-members');
    var selectedIssuesEl = document.getElementById('launch-selected-issues');
    var resultEl = document.getElementById('launch-result');
    var form = document.getElementById('launch-sprint-form');
    var backlogEl = document.getElementById('backlog');
    var roleOptions = ${roleOptionsJson};

    function renderSelectedIssues() {
        selectedIssuesEl.textContent = selectedRoots.length > 0
            ? 'Selected issue(s): ' + selectedRoots.join(', ')
            : 'No issue selected -- click a Backlog row below to select one.';
    }
    renderSelectedIssues();

    if (backlogEl) {
        backlogEl.addEventListener('click', function (ev) {
            var li = ev.target.closest ? ev.target.closest('li[data-bead-id]') : null;
            if (!li) return;
            var id = li.getAttribute('data-bead-id');
            var idx = selectedRoots.indexOf(id);
            if (idx === -1) {
                selectedRoots.push(id);
                li.style.outline = '2px solid #60a5fa';
            } else {
                selectedRoots.splice(idx, 1);
                li.style.outline = '';
            }
            renderSelectedIssues();
        });
    }

    function memberRow(m) {
        var name = typeof m === 'string' ? m : (m && m.name) || '';
        var reserved = typeof m === 'object' && m && m.reserved;
        var wrap = document.createElement('div');
        wrap.style.margin = '4px 0';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = name;
        cb.className = 'launch-member-checkbox';
        cb.id = 'launch-member-' + name;
        var label = document.createElement('label');
        label.htmlFor = cb.id;
        label.style.marginLeft = '4px';
        label.textContent = name + (reserved ? ' (reserved)' : '');
        var roleSelect = document.createElement('select');
        roleSelect.className = 'launch-member-role';
        roleSelect.setAttribute('data-member', name);
        roleSelect.style.marginLeft = '8px';
        var noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = '(no role)';
        roleSelect.appendChild(noneOpt);
        roleOptions.forEach(function (r) {
            var o = document.createElement('option');
            o.value = r;
            o.textContent = r;
            roleSelect.appendChild(o);
        });
        wrap.appendChild(cb);
        wrap.appendChild(label);
        wrap.appendChild(roleSelect);
        return wrap;
    }

    if (membersContainer) {
        fetch('/api/members').then(function (r) { return r.json(); }).then(function (data) {
            var list = (data && Array.isArray(data.members)) ? data.members : [];
            membersContainer.innerHTML = '';
            if (list.length === 0) {
                membersContainer.textContent = 'No members registered.';
                return;
            }
            list.forEach(function (m) { membersContainer.appendChild(memberRow(m)); });
        }).catch(function (err) {
            membersContainer.textContent = 'Failed to load members: ' + err.message;
        });
    }

    ${buildLaunchRequestBody.toString()}
    ${formatLaunchError.toString()}

    if (form) {
        form.addEventListener('submit', function (ev) {
            ev.preventDefault();
            resultEl.style.color = '';
            resultEl.textContent = '';
            var members = [];
            var roleMap = {};
            membersContainer.querySelectorAll('.launch-member-checkbox').forEach(function (cb) {
                if (!cb.checked) return;
                members.push(cb.value);
                var roleSel = membersContainer.querySelector('.launch-member-role[data-member="' + cb.value + '"]');
                var role = roleSel ? roleSel.value : '';
                if (role) {
                    if (!roleMap[role]) roleMap[role] = [];
                    roleMap[role].push(cb.value);
                }
            });
            var goal = document.getElementById('launch-goal').value;
            var branch = document.getElementById('launch-branch').value;
            var base = document.getElementById('launch-base').value;
            var result = buildLaunchRequestBody({
                selectedRoots: selectedRoots,
                members: members,
                roleMap: roleMap,
                goal: goal,
                branch: branch,
                base: base,
            });
            if (!result.ok) {
                resultEl.style.color = '#ef4444';
                resultEl.textContent = result.error;
                return;
            }
            fetch('/api/sprints', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(result.body),
            }).then(function (res) {
                return res.json().catch(function () { return {}; }).then(function (json) {
                    return { status: res.status, json: json };
                });
            }).then(function (r) {
                if (r.status === 201) {
                    resultEl.style.color = '#22c55e';
                    resultEl.textContent = 'Launched sprint ' + r.json.sprintId + '.';
                    selectedRoots = [];
                    renderSelectedIssues();
                    document.querySelectorAll('#backlog li[data-bead-id]').forEach(function (li) {
                        li.style.outline = '';
                    });
                } else {
                    resultEl.style.color = '#ef4444';
                    resultEl.textContent = formatLaunchError(r.status, r.json);
                }
            }).catch(function (err) {
                resultEl.style.color = '#ef4444';
                resultEl.textContent = 'Launch request failed: ' + err.message;
            });
        });
    }
})();
`;
}

/**
 * Renders the Launch Sprint form section: issue-selection status line, a
 * member/role checklist (populated client-side from GET /api/members), the
 * goal selector (exactly GOAL_OPTIONS), branch/base-branch inputs, a submit
 * button, and a result/error line. Pure and dependency-free -- attaches to
 * dashboard.mjs's index page after the Backlog-last tree.
 * @returns {string}
 */
export function renderLaunchFormHtml() {
    const goalOptionsHtml = GOAL_OPTIONS
        .map((g) => '<option value="' + escapeHtml(g) + '">' + escapeHtml(g) + '</option>')
        .join('');
    return (
        '<p style="color:#a1a1aa; font-size: 13px;">Click one Backlog row above to select the issue to launch, ' +
        'choose members/roles, a goal, and branch names, then submit.</p>' +
        '<div id="launch-selected-issues" style="margin-bottom: 8px; font-size: 13px; color:#a1a1aa;"></div>' +
        '<div id="launch-members" style="margin-bottom: 12px; font-size: 13px;">Loading members...</div>' +
        '<form id="launch-sprint-form">' +
        '<div style="margin-bottom:8px;"><label>Goal: <select id="launch-goal">' + goalOptionsHtml + '</select></label></div>' +
        '<div style="margin-bottom:8px;"><label>Branch: <input id="launch-branch" type="text" placeholder="feat/my-topic"/></label></div>' +
        '<div style="margin-bottom:8px;"><label>Base branch: <input id="launch-base" type="text" placeholder="main" value="main"/></label></div>' +
        '<button type="submit">Launch Sprint</button>' +
        '</form>' +
        '<div id="launch-result" style="margin-top: 8px; font-size: 13px;"></div>' +
        '<script>' + clientScriptSource() + '</script>'
    );
}
