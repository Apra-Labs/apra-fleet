import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseRunHistory } from '../fleet-sprint/pr-body.mjs';
import { getProviderTextLimits } from '../fleet-sprint/vcs-module.mjs';
import { runPublishPrPhase } from '../fleet-sprint/phases/publish-pr.mjs';
import { finalizeAbort } from '../fleet-sprint/runner.js';
import { SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';
import { createStagedFileRecorder, TEST_MEMBER_FOLDER } from './helpers/vcs-payload-test.mjs';

// =============================================================================
// Fleet owns only an engine-marked block of a PR description. On a relaunch
// (Publish PR) or an abort (finalizeAbort) against an EXISTING PR:
//   1/2. a human-written title and every byte of human text survive; the
//        verdict (ABORTED included) is in the fleet block;
//   3.   a PR fleet created (old layout without markers, or the marked
//        layout) gets its block updated in place, run history preserved;
//   4.   on Azure DevOps and Bitbucket, 3000 chars of human text: the block
//        fits the limit minus the human text and the whole description fits
//        the limit;
//   5.   the splice is idempotent: two relaunches leave the human text as it
//        was and exactly one block.
//
// The literal marker strings are used on purpose (not imported), so the test
// pins what lands on the PR. Each provider is faked at the REST level behind
// vcs_credential_exec: real builders, staged bodies, raiseVcsPrForMember,
// runPublishPrPhase and finalizeAbort.
//
// ASCII only.
// =============================================================================

const BLOCK_START = '<!-- fleet-sprint:pr-block v1 -->';
const BLOCK_END = '<!-- /fleet-sprint:pr-block v1 -->';
const PROVIDERS = ['github', 'bitbucket', 'azure-devops'];
const REMOTES = {
    github: 'https://github.com/acme/widgets.git',
    'azure-devops': 'https://dev.azure.com/acme/proj/_git/widgets',
    bitbucket: 'https://bitbucket.org/acme/widgets.git',
};
const HUMAN_TITLE = 'Add the widget store (reviewed by the team)';
const HUMAN_BODY = [
    '## Why',
    '',
    'The widget store replaces the old cache. Context: <https://example.invalid/design>.',
    '',
    '- [ ] reviewer: check the migration',
    '<!-- a human HTML comment that must survive -->',
    'Trailing line with spaces   ',
].join('\n');

/** Count of non-overlapping occurrences of `needle` in `hay`. */
const count = (hay, needle) => hay.split(needle).length - 1;

/** The fleet block of `body` (markers included); asserts exactly one. */
function blockOf(body) {
    assert.equal(count(body, BLOCK_START), 1, `exactly one opening marker:\n${body}`);
    assert.equal(count(body, BLOCK_END), 1, `exactly one closing marker:\n${body}`);
    const s = body.indexOf(BLOCK_START);
    const e = body.indexOf(BLOCK_END) + BLOCK_END.length;
    assert.ok(s < e);
    return { before: body.slice(0, s), block: body.slice(s, e), after: body.slice(e) };
}

/**
 * A REST-level fake of one hosting provider with ONE existing open PR
 * (`existing`, or none). Records every call; the Azure DevOps list response
 * truncates descriptions to 400 chars like the real endpoint.
 */
function fakeProvider(provider, existing = null) {
    const staged = createStagedFileRecorder();
    const state = { provider, pr: existing ? { ...existing } : null, calls: [] };
    const respond = (status, body) => ({
        content: [{ text: '' }],
        structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout: `${body === undefined ? '' : JSON.stringify(body)}\n${status}`, stderr: '' },
    });
    const urlOf = (cmd) => {
        const quoted = /'(https:\/\/[^']+)'\s*$/.exec(cmd);
        return quoted ? quoted[1] : cmd.trim().split(/\s+/).pop();
    };
    state.exec = (cmd) => {
        const method = /^curl(?:\.exe)? -sS -X (\w+)/.exec(cmd)[1];
        const url = urlOf(cmd);
        state.calls.push(`${method} ${url}`);
        const json = () => staged.json(cmd);
        const update = (title, body) => { state.pr = { title: title ?? state.pr.title, body: body ?? state.pr.body }; };
        if (provider === 'github') {
            if (method === 'POST' && /\/pulls$/.test(url)) {
                if (state.pr) return respond(422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for acme:feat/x.' }] });
                state.pr = { title: json().title, body: json().body };
                return respond(201, { number: 42, html_url: 'https://github.com/acme/widgets/pull/42' });
            }
            if (method === 'GET' && /\/pulls\?/.test(url)) {
                return respond(200, state.pr ? [{ number: 42, title: state.pr.title, body: state.pr.body, html_url: 'https://github.com/acme/widgets/pull/42' }] : []);
            }
            if (method === 'PATCH' && /\/pulls\/42$/.test(url)) { update(json().title, json().body); return respond(200, { number: 42 }); }
            if (method === 'GET' && /\/issues\/42\/comments\?/.test(url)) return respond(200, []);
        }
        if (provider === 'azure-devops') {
            if (method === 'POST' && /\/pullrequests\?api-version/.test(url)) {
                if (state.pr) return respond(409, { message: 'TF401179: An active pull request for the source and target branch already exists.' });
                state.pr = { title: json().title, body: json().description };
                return respond(201, { pullRequestId: 7 });
            }
            if (method === 'GET' && /\/pullrequests\?searchCriteria\./.test(url)) {
                return respond(200, { value: state.pr ? [{ pullRequestId: 7, title: state.pr.title, description: state.pr.body.slice(0, 400) }] : [] });
            }
            if (method === 'GET' && /\/pullrequests\/7\?api-version/.test(url)) {
                return respond(200, { pullRequestId: 7, title: state.pr.title, description: state.pr.body });
            }
            if (method === 'PATCH' && /\/pullrequests\/7\?api-version/.test(url)) { update(json().title, json().description); return respond(200, { pullRequestId: 7 }); }
            if (method === 'GET' && /\/pullrequests\/7\/threads\?api-version/.test(url)) return respond(200, { value: [] });
        }
        if (provider === 'bitbucket') {
            if (method === 'GET' && /\/pullrequests\?/.test(url)) {
                return respond(200, { values: state.pr ? [{ id: 9, title: state.pr.title, description: state.pr.body, links: { html: { href: 'https://bitbucket.org/acme/widgets/pull-requests/9' } } }] : [] });
            }
            if (method === 'POST' && /\/pullrequests$/.test(url)) {
                state.pr = { title: json().title, body: json().description };
                return respond(201, { id: 9, links: { html: { href: 'https://bitbucket.org/acme/widgets/pull-requests/9' } } });
            }
            if (method === 'PUT' && /\/pullrequests\/9$/.test(url)) { update(json().title, json().description); return respond(200, { id: 9 }); }
            if (method === 'GET' && /\/pullrequests\/9\/comments\?/.test(url)) return respond(200, { values: [] });
        }
        throw new Error(`fake ${provider}: unexpected ${method} ${url}`);
    };
    state.callTool = async (name, toolArgs) => {
        if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: provider, os: 'linux', shell: '', folder: TEST_MEMBER_FOLDER }) }] };
        if (name === 'send_files') return staged.record(toolArgs);
        if (name === 'provision_vcs_auth') return { content: [{ text: 'ok' }], structuredContent: { ok: true, expiresAt: null } };
        if (name === 'credential_store_list') return { content: [{ text: JSON.stringify([{ name: 'azdevops_pat', scope: 'persistent' }]) }] };
        if (name === 'vcs_credential_exec') return state.exec(toolArgs.command);
        throw new Error(`unexpected tool ${name}`);
    };
    state.command = async (cmd, opts = {}) => {
        const out = (output) => (opts.failSoft ? { ok: true, output, error: null } : output);
        if (/^git remote get-url origin\b/.test(cmd)) return out(REMOTES[provider]);
        if (/^git rev-list --count\b/.test(cmd)) return out('2');
        if (/^git push\b/.test(cmd)) return out('To mock-remote');
        return out('');
    };
    return state;
}

async function publish(fake, { runId, verdict = 'PASS', notes = 'All acceptance criteria met.' }) {
    const logs = [];
    const result = await runPublishPrPhase({
        phase: () => {},
        log: (m) => logs.push(m),
        command: fake.command,
        args: { callTool: fake.callTool, run_id: runId },
        validated: { branch: 'feat/x', baseBranch: 'main', goal: 'Ship X', runId },
        targetIssues: [],
        backlogMember: 'pub',
        finalCycleLabel: '1',
        gitSync: { pushGitAfter: async () => {}, syncBeadsAfter: async () => {} },
        getMemberForRole: () => 'pub',
        finalVerdictResult: { verdict, notes },
    });
    return { result, logs };
}

async function abort(fake, { runId = 'run-abort' } = {}) {
    const logs = [];
    const result = await finalizeAbort({
        error: new SprintPlanRejectedError('Plan rejected after 3 rounds', { notes: null }),
        branch: 'feat/x', baseBranch: 'main', member: 'abort-member', command: fake.command,
        log: (m) => logs.push(m), callTool: fake.callTool, runId,
    });
    return { result, logs };
}

describe('1. Publish PR relaunch on a human-written PR keeps the human title and text', () => {
    for (const provider of PROVIDERS) {
        test(`${provider}: human title and every byte of human text survive; the verdict is in the fleet block`, async () => {
            const fake = fakeProvider(provider, { title: HUMAN_TITLE, body: HUMAN_BODY });
            const { result } = await publish(fake, { runId: 'run-1', verdict: 'FAIL', notes: 'Gate failed: bead 1 open.' });
            assert.equal(result.pushed, true);
            assert.equal(fake.pr.title, HUMAN_TITLE, 'the human title is never replaced');
            assert.ok(fake.pr.body.startsWith(HUMAN_BODY), `the human text is kept byte-for-byte:\n${fake.pr.body}`);
            const { before, block, after } = blockOf(fake.pr.body);
            assert.equal(before, `${HUMAN_BODY}\n\n`, 'only a blank-line separator is added after the human text');
            assert.equal(after, '');
            assert.ok(block.startsWith(`${BLOCK_START}\n## Sprint verdict: FAIL`), block.slice(0, 120));
            assert.ok(block.includes('Gate failed: bead 1 open.'));
            assert.deepEqual(parseRunHistory(block).map((e) => `${e.run}:${e.verdict}`), ['run-1:FAIL']);
        });
    }
});

describe('2. finalizeAbort on a human-written PR keeps the human title and text', () => {
    for (const provider of PROVIDERS) {
        test(`${provider}: no [ABORTED] title over the human title; the abort status is in the fleet block`, async () => {
            const fake = fakeProvider(provider, { title: HUMAN_TITLE, body: HUMAN_BODY });
            const { result, logs } = await abort(fake);
            assert.equal(result.reason, 'already-exists', JSON.stringify({ result, logs }));
            assert.equal(fake.pr.title, HUMAN_TITLE, 'no [ABORTED] title is written over a human title');
            assert.ok(!fake.pr.title.includes('[ABORTED]'));
            assert.ok(fake.pr.body.startsWith(HUMAN_BODY), `the human text is kept byte-for-byte:\n${fake.pr.body}`);
            const { before, block } = blockOf(fake.pr.body);
            assert.equal(before, `${HUMAN_BODY}\n\n`);
            assert.ok(block.startsWith(`${BLOCK_START}\n## Sprint verdict: ABORTED`), block.slice(0, 120));
            assert.ok(block.includes('### Abort details') && block.includes('- Error code: SPRINT_PLAN_REJECTED'));
        });
    }
});

describe('3. a PR fleet created gets its block updated in place, history preserved', () => {
    for (const provider of PROVIDERS) {
        test(`${provider}: old layout (no markers) is fully fleet-owned -- replaced by the block, history and fleet title carried`, async () => {
            const oldLayout = [
                '## Sprint verdict: FAIL',
                '',
                '- **Branch:** `feat/x` -> `main`',
                '',
                '### Reviewer notes',
                '',
                'old notes',
                '',
                '<!-- fleet-sprint:run-history v1',
                '[{"run":"run-old","date":"2026-09-30T08:00Z","verdict":"FAIL"}]',
                '-->',
            ].join('\n');
            const fake = fakeProvider(provider, { title: 'fleet-sprint [FAIL]: feat/x', body: oldLayout });
            await publish(fake, { runId: 'run-new', verdict: 'PASS' });
            assert.equal(fake.pr.title, 'fleet-sprint [PASS]: feat/x', 'a fleet-written title is updated');
            const { before, block, after } = blockOf(fake.pr.body);
            assert.equal(before, '', 'nothing of the old fleet layout is kept outside the block');
            assert.equal(after, '');
            assert.ok(!fake.pr.body.includes('old notes'));
            assert.deepEqual(parseRunHistory(block).map((e) => `${e.run}:${e.verdict}`), ['run-new:PASS', 'run-old:FAIL']);
        });

        test(`${provider}: marked layout -- the block is replaced in place; text a human added around it survives`, async () => {
            const fake = fakeProvider(provider);
            await publish(fake, { runId: 'run-1', verdict: 'FAIL' });
            assert.equal(fake.pr.title, 'fleet-sprint [FAIL]: feat/x');
            const created = blockOf(fake.pr.body);
            assert.equal(created.before, '');
            // A human adds text above and below fleet's block.
            const above = 'Human note above the fleet block.\n\n';
            const below = '\n\nHuman note below the fleet block.\n';
            fake.pr = { ...fake.pr, body: `${above}${fake.pr.body}${below}` };
            await publish(fake, { runId: 'run-2', verdict: 'PASS', notes: 'Fixed and verified.' });
            assert.equal(fake.pr.title, 'fleet-sprint [PASS]: feat/x');
            const { before, block, after } = blockOf(fake.pr.body);
            assert.equal(before, above);
            assert.equal(after, below);
            assert.ok(block.startsWith(`${BLOCK_START}\n## Sprint verdict: PASS`));
            assert.ok(block.includes('Fixed and verified.'));
            assert.deepEqual(parseRunHistory(block).map((e) => `${e.run}:${e.verdict}`), ['run-2:PASS', 'run-1:FAIL']);
            assert.ok(block.includes('### Previous runs\n\n- `run-1`'), 'the earlier run is listed under Previous runs');
        });
    }
});

describe('4. a long human description on a small-limit provider', () => {
    for (const provider of ['azure-devops', 'bitbucket']) {
        test(`${provider}: with 3000 chars of human text the fleet block fits limit minus human text; the total stays within the limit`, async () => {
            const { descriptionMaxLength } = getProviderTextLimits(provider);
            assert.ok(descriptionMaxLength < 5000, `${provider} is a small-limit provider (${descriptionMaxLength})`);
            const line = 'Human-written context about this change, kept as is. ';
            const human = line.repeat(Math.ceil(3000 / line.length)).slice(0, 3000);
            const fake = fakeProvider(provider, { title: HUMAN_TITLE, body: human });
            const runs = [['1', 'short'], ['2', 'n '.repeat(1500)], ['3', 'Gate failed:\n- bead 1 open\n- bead 2 open'], ['4', 'ok']];
            for (const [i, [run, notes]] of runs.entries()) {
                await publish(fake, { runId: `run-${run}`, verdict: i % 2 ? 'PASS' : 'FAIL', notes });
                const body = fake.pr.body;
                assert.ok(body.startsWith(human), 'the human text is kept');
                const { before, block } = blockOf(body);
                assert.ok(block.length <= descriptionMaxLength - before.length,
                    `run ${run}: block ${block.length} > limit ${descriptionMaxLength} - outside ${before.length}`);
                assert.ok(body.length <= descriptionMaxLength, `run ${run}: description ${body.length} > ${descriptionMaxLength}`);
                assert.ok(parseRunHistory(block).length >= 1, 'the current run is always in the hidden history');
            }
            assert.equal(fake.pr.title, HUMAN_TITLE);
        });
    }
});

describe('5. the splice is idempotent', () => {
    for (const provider of PROVIDERS) {
        test(`${provider}: two consecutive relaunches leave the human text unchanged and exactly one block`, async () => {
            const fake = fakeProvider(provider, { title: HUMAN_TITLE, body: HUMAN_BODY });
            await publish(fake, { runId: 'run-1', verdict: 'FAIL' });
            const first = blockOf(fake.pr.body);
            await publish(fake, { runId: 'run-2', verdict: 'PASS' });
            const second = blockOf(fake.pr.body);
            assert.equal(second.before, first.before, 'the text outside the block is unchanged by the second relaunch');
            assert.equal(second.after, first.after);
            assert.ok(second.before.startsWith(HUMAN_BODY));
            assert.equal(fake.pr.title, HUMAN_TITLE);
            assert.deepEqual(parseRunHistory(second.block).map((e) => e.run), ['run-2', 'run-1']);
        });
    }
});
