import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildSprintPrBody, parseRunHistory, parseOverflowComment, buildOverflowComments, bodyHasOverflowPointer,
    RUN_HISTORY_MAX_ENTRIES, OVERFLOW_SUPERSEDED_COMMENT,
} from '../fleet-sprint/pr-body.mjs';
import { getProviderTextLimits } from '../fleet-sprint/vcs-module.mjs';
import { runPublishPrPhase } from '../fleet-sprint/phases/publish-pr.mjs';
import { createStagedFileRecorder, TEST_MEMBER_FOLDER } from './helpers/vcs-payload-test.mjs';

// =============================================================================
// Azure DevOps relaunch on a branch that already has a PR. The find (list)
// endpoint truncates every description to 400 characters, so the run-history
// block and the overflow pointer at the end of a long description are not in
// the list response. The update path must read the full PR by id first:
//   - every earlier run-history entry is carried forward;
//   - the earlier run's overflow comments are cleaned up;
//   - when the read-by-id fails, the PR is left as it was (no PATCH) and a
//     WARNING is logged -- never a rebuild from the truncated copy.
//
// The provider is faked at the REST level behind vcs_credential_exec (the
// real builders, staged request bodies and raiseVcsPrForMember run).
//
// ASCII only.
// =============================================================================

const ADO_LIST_TRUNCATE = 400;
const REMOTE = 'https://dev.azure.com/acme/proj/_git/widgets';
const PR_ID = 7;
const PR_URL = `https://dev.azure.com/acme/proj/_git/widgets/pullrequest/${PR_ID}`;

function longReview(size, tag) {
    const lines = [];
    let len = 0;
    for (let i = 0; len < size; i++) {
        const line = `- ${tag}${i}: reviewer finding ${i} -- ${'detail '.repeat(1 + (i % 7))}`.trimEnd();
        lines.push(line);
        len += line.length + 1;
    }
    return lines.join('\n');
}

/** The existing PR left by several earlier runs: a full run history and, from
 *  the last of them, overflow comments that the description points at. */
function earlierRuns() {
    const { descriptionMaxLength, commentMaxLength } = getProviderTextLimits('azure-devops');
    let body = '';
    let built = null;
    const runs = ['run-1', 'run-2', 'run-3', 'run-4', 'run-5'];
    runs.forEach((run, i) => {
        built = buildSprintPrBody({
            verdict: i % 2 ? 'PASS' : 'FAIL', goal: 'Ship X', branch: 'feat/x', baseBranch: 'main', runId: run,
            now: new Date(Date.UTC(2026, 9, 1 + i, 9, 30)),
            notes: i === runs.length - 1 ? longReview(9000, 'old') : 'short notes',
            previousBody: body, maxLength: descriptionMaxLength, commentMaxLength,
        });
        body = built.body;
    });
    assert.ok(built.comments.length >= 2, 'the last earlier run overflowed into comments');
    assert.ok(bodyHasOverflowPointer(body), 'the earlier description points at its overflow comments');
    assert.ok(body.length > ADO_LIST_TRUNCATE * 3, 'the earlier description is far past the list truncation');
    assert.equal(parseRunHistory(body.slice(0, ADO_LIST_TRUNCATE)).length, 0, 'the truncated copy carries no history');
    return { body, comments: built.comments, runs };
}

function fakeAzureDevOps({ existingBody, existingComments, failGet = false }) {
    const staged = createStagedFileRecorder();
    const state = {
        pr: { title: 'fleet-sprint [PASS]: feat/x', body: existingBody },
        comments: new Map(), calls: [], patches: 0,
    };
    let nextId = 500;
    for (const c of existingComments) state.comments.set(nextId++, c);
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
        if (method === 'POST' && /\/pullrequests\?api-version/.test(url)) {
            return respond(409, { message: 'TF401179: An active pull request for the source and target branch already exists.' });
        }
        if (method === 'GET' && /\/pullrequests\?searchCriteria\./.test(url)) {
            // The real list endpoint: description cut to 400 characters.
            return respond(200, { value: [{ pullRequestId: PR_ID, title: state.pr.title, description: state.pr.body.slice(0, ADO_LIST_TRUNCATE) }] });
        }
        if (method === 'GET' && new RegExp(`/pullrequests/${PR_ID}\\?api-version`).test(url)) {
            if (failGet) return respond(500, { message: 'Server Error' });
            return respond(200, { pullRequestId: PR_ID, title: state.pr.title, description: state.pr.body });
        }
        if (method === 'PATCH' && new RegExp(`/pullrequests/${PR_ID}\\?api-version`).test(url)) {
            state.patches++;
            state.pr = { title: json().title ?? state.pr.title, body: json().description ?? state.pr.body };
            return respond(200, { pullRequestId: PR_ID });
        }
        if (method === 'POST' && /\/threads\?api-version/.test(url)) {
            const id = nextId++;
            state.comments.set(id, json().comments[0].content);
            return respond(200, { id, comments: [{ id: 1, parentCommentId: 0, content: state.comments.get(id) }] });
        }
        if (method === 'GET' && /\/threads\?api-version/.test(url)) {
            return respond(200, { value: [...state.comments.entries()].map(([id, body]) => ({ id, comments: [{ id: 1, parentCommentId: 0, content: body, commentType: 'text' }] })) });
        }
        const tm = /\/threads\/(\d+)\/comments\/1\?api-version/.exec(url);
        if (tm && method === 'PATCH') { state.comments.set(Number(tm[1]), json().content); return respond(200, {}); }
        if (tm && method === 'DELETE') { state.comments.delete(Number(tm[1])); return respond(200); }
        throw new Error(`fake azure-devops: unexpected ${method} ${url}`);
    };
    state.callTool = async (name, toolArgs) => {
        if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'azure-devops', os: 'linux', shell: '', folder: TEST_MEMBER_FOLDER }) }] };
        if (name === 'send_files') return staged.record(toolArgs);
        if (name === 'provision_vcs_auth') return { content: [{ text: 'ok' }], structuredContent: { ok: true, expiresAt: null } };
        if (name === 'credential_store_list') return { content: [{ text: JSON.stringify([{ name: 'azdevops_pat', scope: 'persistent' }]) }] };
        if (name === 'vcs_credential_exec') return state.exec(toolArgs.command);
        throw new Error(`unexpected tool ${name}`);
    };
    state.command = async (cmd) => (cmd === 'git remote get-url origin'
        ? { ok: true, output: REMOTE, error: null }
        : { ok: true, output: '', error: null });
    state.liveOverflow = () => [...state.comments.values()].map(parseOverflowComment).filter((p) => p && !p.superseded);
    return state;
}

async function relaunch(fake, { runId = 'run-6', notes = 'All good on the relaunch.' } = {}) {
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
        finalVerdictResult: { verdict: 'PASS', notes },
    });
    return { result, logs };
}

describe('Azure DevOps relaunch reads the full existing PR, not the 400-char list copy', () => {
    test('every earlier run-history entry is carried forward and the stale overflow comments are cleaned up', async () => {
        const earlier = earlierRuns();
        const fake = fakeAzureDevOps({ existingBody: earlier.body, existingComments: [...earlier.comments, 'a human review comment'] });
        assert.equal(fake.liveOverflow().length, earlier.comments.length);

        const { logs } = await relaunch(fake);

        assert.equal(fake.patches, 1, 'the description is rewritten once');
        const history = parseRunHistory(fake.pr.body).map((e) => e.run);
        const expected = ['run-6', ...[...earlier.runs].reverse()].slice(0, RUN_HISTORY_MAX_ENTRIES);
        assert.deepEqual(history, expected, 'every earlier run (up to the cap) is in the rebuilt history');

        // The relaunch's notes fit the description: the earlier run's overflow
        // comments are removed (deleted, or emptied to the superseded stub).
        const threadCalls = fake.calls.filter((c) => /\/threads\/\d+\/comments\/1\?/.test(c));
        assert.equal(threadCalls.length, earlier.comments.length, `one cleanup call per stale overflow comment: ${threadCalls.join(', ')}`);
        assert.equal(fake.liveOverflow().length, 0, 'no stale overflow comment is left live');
        for (const body of fake.comments.values()) {
            const parsed = parseOverflowComment(body);
            assert.ok(!parsed || parsed.superseded, `stale overflow comment left: ${body.slice(0, 80)}`);
            if (parsed) assert.equal(body, OVERFLOW_SUPERSEDED_COMMENT);
        }
        assert.ok([...fake.comments.values()].includes('a human review comment'), 'human comments are never touched');
        assert.ok(logs.some((l) => /removed \d+ earlier reviewer-notes overflow comment/.test(l)), logs.join('\n'));
        assert.ok(fake.calls.includes(`GET https://dev.azure.com/acme/proj/_apis/git/repositories/widgets/pullrequests/${PR_ID}?api-version=7.1`),
            `the update path reads the PR by id: ${fake.calls.join(', ')}`);
    });

    test('a failed read-by-id leaves the PR as it was (no PATCH) and logs a WARNING', async () => {
        const earlier = earlierRuns();
        const fake = fakeAzureDevOps({ existingBody: earlier.body, existingComments: earlier.comments, failGet: true });
        const before = { ...fake.pr };

        const { result, logs } = await relaunch(fake);

        assert.deepEqual(result, { pushed: true });
        assert.ok(!fake.calls.some((c) => c.startsWith('PATCH ')), `no update call: ${fake.calls.join(', ')}`);
        assert.deepEqual(fake.pr, before, 'title and description unchanged');
        assert.equal(fake.liveOverflow().length, earlier.comments.length, 'the earlier overflow comments are untouched');
        assert.ok(logs.some((l) => l.includes('WARNING') && l.includes('could not read the full description') && l.includes('HTTP 500') && l.includes(PR_URL)), logs.join('\n'));
    });
});
