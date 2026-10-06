import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildSprintPrBody } from '../fleet-sprint/pr-body.mjs';
import { runPublishPrPhase } from '../fleet-sprint/phases/publish-pr.mjs';
import { computeOwedTriage, formatOwedTriageLines } from '../fleet-sprint/owed-triage.mjs';

// =============================================================================
// Owed triage in the sprint PR body: an 'Owed triage' section naming every
// item, and a verdict heading that says a PASS carrying owed triage is not
// clean -- rendered only when the triage is non-empty. The verdict itself is
// never changed. ASCII only.
// =============================================================================

const NOW = new Date('2026-10-05T12:00:00Z');

function fullTriage() {
    return computeOwedTriage({
        targetIds: ['ROOT'],
        scopeBeads: [
            { id: 'ROOT', title: 'Sprint root', status: 'open', issue_type: 'epic' },
            { id: 'ROOT.1', title: 'Follow-up with no lane', status: 'open', issue_type: 'task', parent: 'ROOT' },
            { id: 'ROOT.2', title: 'Rollup left open', status: 'open', issue_type: 'feature', parent: 'ROOT' },
            { id: 'ROOT.2.1', title: 'done child', status: 'closed', issue_type: 'task', parent: 'ROOT.2', close_reason: 'done' },
            { id: 'ROOT.3', title: 'Gave up on this', status: 'closed', issue_type: 'task', parent: 'ROOT', close_reason: 'blocked: missing secret X' },
        ],
        rejectedNewTasks: [{ cycle: 2, reason: 'priority out of range', raw: { title: 'Rejected finding title' } }],
    });
}

describe('buildSprintPrBody owed triage section', () => {
    test('non-empty triage: section names each item and the PASS heading says not clean', () => {
        const triage = fullTriage();
        assert.equal(triage.total, 4);
        const body = buildSprintPrBody({
            verdict: 'PASS', branch: 'feat/x', baseBranch: 'main', now: NOW, notes: 'ok',
            owedTriageLines: formatOwedTriageLines(triage), owedTriageTotal: triage.total,
        });
        assert.ok(body.startsWith('## Sprint verdict: PASS (owed triage: 4 item(s) -- PASS is NOT clean)'), body.split('\n')[0]);
        assert.ok(body.includes('\n### Owed triage\n'), body);
        for (const needle of ['ROOT.1', 'Follow-up with no lane', 'ROOT.2', 'Rollup left open', 'Rejected finding title', 'ROOT.3', 'blocked: missing secret X']) {
            assert.ok(body.includes(needle), `PR body is missing ${needle}:\n${body}`);
        }
        // The section sits before the human-review footer and the history block.
        assert.ok(body.indexOf('### Owed triage') < body.indexOf('Do NOT auto-merge'));
    });

    test('a FAIL with owed triage keeps FAIL and still renders the section', () => {
        const triage = fullTriage();
        const body = buildSprintPrBody({
            verdict: 'FAIL', branch: 'feat/x', now: NOW, notes: 'bad',
            owedTriageLines: formatOwedTriageLines(triage), owedTriageTotal: triage.total,
        });
        assert.ok(body.startsWith('## Sprint verdict: FAIL (owed triage: 4 item(s) -- not clean)'));
        assert.ok(body.includes('### Owed triage'));
    });

    test('an incomplete triage (failed bead read) is never rendered as nothing owed', () => {
        const partial = { ...computeOwedTriage({ rejectedNewTasks: [] }), incomplete: true };
        const lines = formatOwedTriageLines(partial);
        assert.equal(lines.length, 1);
        assert.match(lines[0], /^owed triage: INCOMPLETE/);
        const body = buildSprintPrBody({
            verdict: 'PASS', branch: 'feat/x', now: NOW, notes: 'ok',
            owedTriageLines: lines, owedTriageTotal: partial.total,
        });
        assert.ok(body.startsWith('## Sprint verdict: PASS (owed triage: incomplete -- PASS is NOT clean)'), body.split('\n')[0]);
        assert.ok(body.includes('### Owed triage') && body.includes('may be incomplete'), body);
    });

    test('empty triage: no section and an unchanged heading', () => {
        const empty = computeOwedTriage({});
        const withEmpty = buildSprintPrBody({
            verdict: 'PASS', branch: 'feat/x', now: NOW, notes: 'ok',
            owedTriageLines: formatOwedTriageLines(empty), owedTriageTotal: empty.total,
        });
        const without = buildSprintPrBody({ verdict: 'PASS', branch: 'feat/x', now: NOW, notes: 'ok' });
        assert.equal(withEmpty, without, 'an empty triage must not change the body at all');
        assert.ok(!withEmpty.includes('Owed triage'));
        assert.ok(withEmpty.startsWith('## Sprint verdict: PASS\n'));
    });
});

// -----------------------------------------------------------------------------
// Publish PR phase: the body handed to the VCS layer carries the section.
// -----------------------------------------------------------------------------
function posixDashD(command) {
    const m = /-d '((?:[^']|'\\'')*)' -w/.exec(command);
    assert.ok(m, `no POSIX -d payload in: ${command}`);
    return JSON.parse(m[1].replace(/'\\''/g, "'"));
}

async function publish({ verdict, owedTriage, member }) {
    const posted = [];
    const callTool = async (name, toolArgs) => {
        if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'github', os: 'linux', shell: '' }) }] };
        if (name === 'provision_vcs_auth') return { content: [{ text: 'ok' }], structuredContent: { ok: true, expiresAt: null } };
        if (name === 'credential_store_list') return { content: [{ text: '[]' }] };
        if (name === 'vcs_credential_exec') {
            if (/^curl -sS -X POST /.test(toolArgs.command)) posted.push(posixDashD(toolArgs.command));
            return {
                content: [{ text: '' }],
                structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout: `${JSON.stringify({ number: 7, html_url: 'https://github.com/acme/widgets/pull/7' })}\n201`, stderr: '' },
            };
        }
        throw new Error(`unexpected tool ${name}`);
    };
    const command = async (cmd) => (cmd === 'git remote get-url origin'
        ? { ok: true, output: 'https://github.com/acme/widgets.git', error: null }
        : { ok: true, output: '', error: null });
    await runPublishPrPhase({
        phase: () => {}, log: () => {}, command,
        args: { callTool, run_id: 'run-owed' },
        validated: { branch: 'feat/x', baseBranch: 'main', goal: 'Ship X', runId: 'run-owed' },
        targetIssues: [], backlogMember: member, finalCycleLabel: '1',
        gitSync: { pushGitAfter: async () => {}, syncBeadsAfter: async () => {} },
        getMemberForRole: () => member,
        finalVerdictResult: { verdict, notes: 'notes' },
        owedTriage,
    });
    assert.equal(posted.length, 1, 'exactly one create-PR call');
    return posted[0];
}

describe('runPublishPrPhase passes owed triage to the VCS layer', () => {
    test('non-empty triage reaches the created PR body; the PASS title is unchanged', async () => {
        const pr = await publish({ verdict: 'PASS', owedTriage: fullTriage(), member: 'owed-pub-1' });
        assert.equal(pr.title, 'Auto-sprint [PASS]: feat/x');
        assert.ok(pr.body.includes('### Owed triage'), pr.body);
        assert.ok(pr.body.includes('ROOT.1') && pr.body.includes('ROOT.2') && pr.body.includes('ROOT.3') && pr.body.includes('Rejected finding title'));
        assert.match(pr.body, /^## Sprint verdict: PASS \(owed triage: 4 item\(s\) -- PASS is NOT clean\)/);
    });

    test('empty or missing triage leaves the PR body without the section', async () => {
        const a = await publish({ verdict: 'PASS', owedTriage: computeOwedTriage({}), member: 'owed-pub-2' });
        const b = await publish({ verdict: 'PASS', owedTriage: undefined, member: 'owed-pub-3' });
        for (const pr of [a, b]) {
            assert.ok(!pr.body.includes('Owed triage'), pr.body);
            assert.ok(pr.body.startsWith('## Sprint verdict: PASS\n'));
        }
    });
});
