import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMemberInitProbe } from '../fleet-sprint/member-init-probe.mjs';
import { createDispatchAccounting, memberToolsReason } from '../fleet-sprint/dispatch-accounting.mjs';
import { renderKbCodeIntelHtml } from '../fleet-sprint/viewer-extensions.mjs';
import { buildAnalysisText } from '../fleet-sprint/sprint-report.mjs';
import { lowerQuality } from '../fleet-sprint/lower-quality.mjs';

// KB and code unavailability diagnostics, end to end per cause: the member-init
// WARN line names the cause and a concrete action; the viewer state carries the
// same reason for every unknown count of that member; the sprint report says
// why the counts are unknown.

const ID = '0b9d3a1e-5f2c-4c6e-9a7b-000000000001';

/** A one-member fleet whose member session cannot list tools. */
function failingMember({ listToolsError, fleetMcp, fleetMcpFix }) {
    const logs = [];
    const callTool = async (name, args) => {
        assert.equal(name, 'member_detail');
        const body = { id: ID, type: 'local', llmProvider: 'claude' };
        if (args.refresh) {
            body.fleetMcp = fleetMcp;
            if (fleetMcpFix) body.fleetMcpFix = fleetMcpFix;
        }
        return { content: [{ text: JSON.stringify(body) }] };
    };
    const memberCall = async () => { throw listToolsError; };
    const listTools = async () => { throw listToolsError; };
    const probe = createMemberInitProbe({ members: ['m1'], callTool, memberCall, listTools, log: (l) => logs.push(l) });
    return { probe, logs, memberCall };
}

const CAUSES = [
    {
        name: 'old apra-fleet without member mode',
        listToolsError: new Error("Error: unknown option 'call'"),
        fleetMcp: { state: 'available', version: 'v0.1.9' },
        reason: 'member-fleet-too-old',
        action: /update_member with fleet_install "auto"/,
    },
    {
        name: 'install not fleet-owned',
        listToolsError: new Error("Error: unknown option 'call'"),
        fleetMcp: { state: 'unavailable', reason: 'full-install-running', detail: 'no member-install marker at /bin/apra-fleet' },
        fleetMcpFix: 'Ask the install owner to hand it over: run update_member {member_id, fleet_install: "auto"}.',
        reason: 'full-install-running',
        action: /run update_member \{member_id, fleet_install: "auto"\}/,
    },
    {
        name: 'unsupported platform',
        listToolsError: new Error("Error: unknown option 'call'"),
        fleetMcp: { state: 'unavailable', reason: 'unsupported-platform', detail: 'no release asset for freebsd/riscv64' },
        fleetMcpFix: 'Install apra-fleet on the member by hand; no release asset exists for its OS/arch.',
        reason: 'unsupported-platform',
        action: /Install apra-fleet on the member by hand/,
    },
    {
        name: 'member session refused',
        listToolsError: new Error('server refused member 0b9d: not a registered member (HTTP 403)'),
        fleetMcp: { state: 'available' },
        reason: 'member-session-refused',
        action: /update_member with fleet_install "auto"/,
    },
    {
        name: 'member access secret refused (E-MEMBER-SECRET)',
        listToolsError: new Error('E-MEMBER-SECRET: member access secret missing or mismatched'),
        fleetMcp: { state: 'available' },
        reason: 'member-secret-refused',
        action: /member-access\.key[\s\S]*own data directory[\s\S]*own user/,
    },
    {
        name: 'member access secret refused (bare HTTP 401)',
        listToolsError: new Error('member server returned HTTP 401'),
        fleetMcp: { state: 'available' },
        reason: 'member-secret-refused',
        action: /member-access\.key[\s\S]*own data directory[\s\S]*own user/,
    },
];

describe('KB/code unavailability: cause named at init, carried to the viewer and the sprint report', () => {
    for (const c of CAUSES) {
        test(c.name, async () => {
            const { probe, logs, memberCall } = failingMember(c);
            const [rec] = await probe.probeAll();

            // WARN line: the cause and a concrete action.
            const warn = logs.find((l) => /WARN member 'm1'/.test(l));
            assert.ok(warn, `no WARN line in ${JSON.stringify(logs)}`);
            assert.ok(warn.includes(`reason: ${c.reason}`), warn);
            assert.match(warn, c.action);
            assert.doesNotMatch(warn, /make '/);
            assert.equal(lowerQuality([rec]).unverified.length, 1);

            // Dispatches whose snapshot reads fail because of that cause.
            const store = [];
            const acct = createDispatchAccounting({
                memberCall,
                memberOf: () => ({ id: ID, name: 'm1' }),
                getMemberInit: () => rec,
                store,
            });
            await acct.around({ memberName: 'm1', role: 'doer' }, async () => {});
            await acct.around({ memberName: 'm1', role: 'reviewer' }, async () => {});
            const expected = memberToolsReason(rec);
            assert.match(expected, new RegExp(`^member tools unavailable: ${c.reason}`));

            // Viewer: every unknown count of the member carries the same reason.
            const html = renderKbCodeIntelHtml({ dispatches: store }, { members: [rec], banner: lowerQuality([rec]).banner });
            const cells = [...html.matchAll(/data-kb-panel-unknown="true"[^>]*title="([^"]*)"/g)].map((m) => m[1]);
            assert.ok(cells.length >= 4, `unknown cells: ${cells.length}`);
            for (const t of cells) assert.ok(t.includes(`member tools unavailable: ${c.reason}`), t);
            assert.match(html, new RegExp(`data-kb-unknown-reason="m1"[^>]*>[^<]*member tools unavailable: ${c.reason}`));

            // Sprint report: why the counts are unknown.
            const text = buildAnalysisText({
                targetIssues: ['X-1'], branch: 'feat/x', baseBranch: 'main', cyclesRun: 1,
                closedCountHistory: [1], highWaterClosedCount: 1, deployFailures: [], integFailures: [], rejectedNewTasks: [],
                finalVerdictResult: { verdict: 'APPROVED', notes: '' }, finalClosedCount: 1, finalOpenAtGoalCount: 0,
                dispatchToolCalls: store,
            });
            const dispatchLine = text.split('\n').find((l) => l.includes('Dispatch 1:'));
            assert.match(dispatchLine, new RegExp(`unknown: member tools unavailable: ${c.reason}`));
            const totalLine = text.split('\n').find((l) => l.includes("member 'm1':"));
            assert.match(totalLine, new RegExp(`\\(unknown: member tools unavailable: ${c.reason}`));
            assert.doesNotMatch(dispatchLine, /calls: 0/);
        });
    }
});

describe('unknown counts: the reason distinguishes member tools from a snapshot read error', () => {
    const verified = { member: 'm1', verified: true, reason: null, problems: [] };
    const unverified = { member: 'm1', verified: false, reason: 'member-fleet-too-old', problems: [{ step: 'tools', reason: 'member-fleet-too-old', detail: "unknown option 'call'" }] };

    async function runOne(init) {
        const store = [];
        const acct = createDispatchAccounting({
            memberCall: async () => { throw new Error('boom'); },
            memberOf: () => ({ id: ID, name: 'm1' }),
            getMemberInit: () => init,
            store,
        });
        await acct.around({ memberName: 'm1', role: 'doer' }, async () => {});
        return store[0];
    }

    test('unverified member: reason is the member-tools cause with its short cause', async () => {
        const r = await runOne(unverified);
        assert.equal(r.kb, 'unknown');
        assert.equal(r.reason, "member tools unavailable: member-fleet-too-old -- unknown option 'call'");
    });

    test('verified member whose snapshot read failed: labelled as a snapshot read failure, not member tools', async () => {
        const r = await runOne(verified);
        assert.equal(r.kb, 'unknown');
        assert.match(r.reason, /snapshot read failed/);
        assert.doesNotMatch(r.reason, /member tools/);
        const html = renderKbCodeIntelHtml({ dispatches: [r] }, { members: [verified], banner: null });
        assert.match(html, /title="before-snapshot read failed"/);
        assert.doesNotMatch(html, /member tools unavailable/);
    });

    test('viewer falls back to the init record when the dispatch record carries no reason', () => {
        const html = renderKbCodeIntelHtml(
            { dispatches: [{ index: 1, member: 'm1', role: 'doer', label: null, kb: 'unknown', code: 'unknown', reason: null }] },
            { members: [unverified], banner: null },
        );
        assert.match(html, /data-kb-unknown-reason="m1"[^>]*>[^<]*member tools unavailable: member-fleet-too-old/);
    });

    test('a fully known member shows no unknown-reason line', () => {
        const html = renderKbCodeIntelHtml(
            { dispatches: [{ index: 1, member: 'm1', role: 'doer', label: null, kb: 1, code: 2, reason: null }] },
            { members: [verified], banner: null },
        );
        assert.doesNotMatch(html, /data-kb-unknown-reason/);
    });
});
