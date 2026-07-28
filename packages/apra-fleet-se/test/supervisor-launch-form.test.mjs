import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
    GOAL_OPTIONS,
    FORM_ROLE_OPTIONS,
    buildLaunchRequestBody,
    formatLaunchError,
    renderLaunchFormHtml,
} from '../src/supervisor/launch-form.mjs';
import { renderIndexPageHtml } from '../src/supervisor/dashboard.mjs';

// apra-fleet-eft.6.3 -- Launch Sprint form: issue multi-select (click-to-toggle
// on the Backlog tree), member/role assignment, a goal selector offering
// exactly P1/P1+P2/P1+P2+P3, and branch/base-branch inputs. Submitting builds
// a POST /api/sprints body the server (eft.4.4, src/supervisor/api.mjs)
// accepts; 409 member-overlap conflicts and 400 field errors are surfaced
// legibly, never as a generic error.

describe('launch-form -- GOAL_OPTIONS', () => {
    test('offers exactly P1, P1+P2, P1+P2+P3', () => {
        assert.deepEqual(GOAL_OPTIONS, ['P1', 'P1+P2', 'P1+P2+P3']);
    });
});

describe('launch-form -- FORM_ROLE_OPTIONS', () => {
    test('includes the canonical sprint roles plus the orchestrator pseudo-role', () => {
        assert.ok(FORM_ROLE_OPTIONS.includes('doer'));
        assert.ok(FORM_ROLE_OPTIONS.includes('planner'));
        assert.ok(FORM_ROLE_OPTIONS.includes('orchestrator'));
    });
});

describe('launch-form -- buildLaunchRequestBody', () => {
    const base = {
        selectedRoots: ['apra-fleet-eft.9'],
        members: ['alice', 'bob'],
        roleMap: { doer: ['alice'] },
        goal: 'P1+P2',
        branch: 'feat/x',
        base: 'main',
    };

    test('valid input produces a body the server accepts (issue/members/branch/base/goal/roleMap)', () => {
        const result = buildLaunchRequestBody(base);
        assert.equal(result.ok, true);
        assert.deepEqual(result.body, {
            issue: 'apra-fleet-eft.9',
            members: ['alice', 'bob'],
            branch: 'feat/x',
            base: 'main',
            goal: 'P1+P2',
            roleMap: { doer: ['alice'] },
        });
    });

    test('omits roleMap when empty/absent', () => {
        const result = buildLaunchRequestBody({ ...base, roleMap: {} });
        assert.equal(result.ok, true);
        assert.ok(!('roleMap' in result.body));
    });

    test('zero selected issues -> client-side error, not a server round-trip', () => {
        const result = buildLaunchRequestBody({ ...base, selectedRoots: [] });
        assert.equal(result.ok, false);
        assert.ok(/select an issue/i.test(result.error));
    });

    test('more than one selected issue -> client-side error naming the single-root constraint', () => {
        const result = buildLaunchRequestBody({ ...base, selectedRoots: ['a', 'b'] });
        assert.equal(result.ok, false);
        assert.ok(/exactly one issue/i.test(result.error));
    });

    test('no members selected -> client-side error', () => {
        const result = buildLaunchRequestBody({ ...base, members: [] });
        assert.equal(result.ok, false);
        assert.ok(/member/i.test(result.error));
    });

    test('goal outside the exact three options -> client-side error', () => {
        const result = buildLaunchRequestBody({ ...base, goal: 'P4' });
        assert.equal(result.ok, false);
        assert.ok(result.error.includes('P1, P1+P2, P1+P2+P3'));
    });

    test('missing branch/base -> client-side error', () => {
        assert.equal(buildLaunchRequestBody({ ...base, branch: '' }).ok, false);
        assert.equal(buildLaunchRequestBody({ ...base, base: '  ' }).ok, false);
    });
});

describe('launch-form -- formatLaunchError', () => {
    test('409 member-overlap conflict is passed through verbatim -- names the sprint and overlapping members', () => {
        const msg = formatLaunchError(409, {
            error: "member overlap rejects launch: sprint 's-active' already claims [alice, bob]",
            field: 'members',
        });
        assert.ok(msg.includes('s-active'));
        assert.ok(msg.includes('alice'));
        assert.ok(msg.includes('bob'));
        assert.ok(!/^(error|failed)$/i.test(msg.trim()), 'must not degrade to a generic error string');
    });

    test('400 field error names the field and shows the server message verbatim', () => {
        const msg = formatLaunchError(400, {
            error: '[Arg Contract] Invalid branch "bad branch~name": must match /^[A-Za-z0-9._/-]+$/',
            field: 'branch',
        });
        assert.ok(msg.startsWith('Invalid branch:'));
        assert.ok(msg.includes('[Arg Contract] Invalid branch "bad branch~name"'));
    });

    test('missing/malformed error body still renders a message, never throws', () => {
        assert.doesNotThrow(() => formatLaunchError(500, null));
        assert.doesNotThrow(() => formatLaunchError(500, undefined));
        assert.ok(formatLaunchError(500, {}).length > 0);
    });
});

describe('launch-form -- renderLaunchFormHtml', () => {
    test('renders a goal <select> with exactly the three GOAL_OPTIONS', () => {
        const html = renderLaunchFormHtml();
        for (const g of GOAL_OPTIONS) {
            assert.ok(html.includes('<option value="' + g + '">' + g + '</option>'), `missing goal option: ${g}`);
        }
        const optionCount = (html.match(/<option value="P/g) || []).length;
        assert.equal(optionCount, GOAL_OPTIONS.length);
    });

    test('renders branch and base-branch inputs, a submit form, and a result area', () => {
        const html = renderLaunchFormHtml();
        assert.ok(html.includes('id="launch-branch"'));
        assert.ok(html.includes('id="launch-base"'));
        assert.ok(html.includes('id="launch-sprint-form"'));
        assert.ok(html.includes('id="launch-result"'));
        assert.ok(html.includes('id="launch-members"'));
        assert.ok(html.includes('id="launch-selected-issues"'));
    });

    test('embeds a client-side handler that reads Backlog rows and posts to /api/sprints', () => {
        const html = renderLaunchFormHtml();
        assert.ok(html.includes('<script>'));
        assert.ok(html.includes("data-bead-id"));
        assert.ok(html.includes("fetch('/api/sprints'"));
        assert.ok(html.includes("fetch('/api/members')"));
        assert.ok(html.includes('buildLaunchRequestBody'));
        assert.ok(html.includes('formatLaunchError'));
    });

    test('never throws', () => {
        assert.doesNotThrow(() => renderLaunchFormHtml());
    });
});

describe('launch-form -- attaches to the index page after the Backlog', () => {
    test('renderIndexPageHtml places the Launch Sprint form after the Backlog section', () => {
        const html = renderIndexPageHtml([], '<p>no backlog</p>');
        const backlogIdx = html.indexOf('id="backlog"');
        const launchIdx = html.indexOf('id="launch-form"');
        assert.ok(backlogIdx !== -1 && launchIdx !== -1);
        assert.ok(launchIdx > backlogIdx, 'Launch Sprint form must come after the Backlog');
        assert.ok(html.includes('id="launch-sprint-form"'));
    });

    test('an explicit launchFormHtml override is honored verbatim', () => {
        const html = renderIndexPageHtml([], '<p>no backlog</p>', '<p data-marker="custom-launch-form"/>');
        assert.ok(html.includes('data-marker="custom-launch-form"'));
    });
});
