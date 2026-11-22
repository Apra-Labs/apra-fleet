import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Namespace import on purpose: on a tree WITHOUT the overflow feature (whose
// pr-body.mjs truncates the notes and has none of the overflow exports) these
// tests must fail on their zero-loss assertions, not on a missing-export
// SyntaxError at link time -- so the overflow helpers are read with fallbacks.
import * as prBody from '../fleet-sprint/pr-body.mjs';

const { parseRunHistory, sanitizePrMarkdown } = prBody;
const parseOverflowComment = prBody.parseOverflowComment || (() => null);
const NOTES_CONTINUED_MARKER = prBody.NOTES_CONTINUED_MARKER || '*[... reviewer notes continue';
const OVERFLOW_MAX_COMMENTS = prBody.OVERFLOW_MAX_COMMENTS || 20;
const RUN_HISTORY_MARKER = prBody.RUN_HISTORY_MARKER || 'fleet-sprint:run-history v1';
import { getProviderTextLimits } from '../fleet-sprint/vcs-module.mjs';
import { runPublishPrPhase } from '../fleet-sprint/phases/publish-pr.mjs';
import { finalizeAbort } from '../fleet-sprint/runner.js';
import { SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';
import { createStagedFileRecorder, TEST_MEMBER_FOLDER } from './helpers/vcs-payload-test.mjs';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// Zero reviewer-note loss: a long final review on GitHub, Azure DevOps and
// Bitbucket reaches the PR in full -- the description (within that
// provider's limit) plus engine-marked overflow comments (each within the
// comment limit) concatenate to the full sanitized notes. Also: relaunch
// upsert, a failed comment post, the comment ceiling and the abort PR path.
//
// The providers are faked behind vcs_credential_exec at the REST level (the
// real builders, real staged request bodies, real raiseVcsPrForMember and
// runPublishPrPhase), so every request shape is the one production sends.
//
// ASCII only.
// =============================================================================

const REMOTES = {
    github: 'https://github.com/acme/widgets.git',
    'azure-devops': 'https://dev.azure.com/acme/proj/_git/widgets',
    bitbucket: 'https://bitbucket.org/acme/widgets.git',
};

/** A ~`size`-character multi-paragraph final review (ASCII, no fences). */
function longReview(size, tag = 'f') {
    const lines = [];
    let i = 0;
    let len = 0;
    while (len < size) {
        const line = i % 7 === 6 ? '' : `- ${tag}${i}: reviewer finding ${i} about module m${i % 13} -- ${'detail '.repeat(1 + (i % 9))}`.trimEnd();
        lines.push(line);
        len += line.length + 1;
        i++;
    }
    return lines.join('\n');
}

/**
 * A fake hosting provider at the REST level. Records the PR description, the
 * PR comments (id -> body) and every REST call; `failComments` makes comment
 * creation answer HTTP 500.
 */
function fakeProvider(provider, { failComments = false, failCommentAt = 0, pageSize = 0 } = {}) {
    const staged = createStagedFileRecorder();
    const state = { provider, pr: null, comments: new Map(), nextCommentId: 100, calls: [], staged, failComments, commentPosts: 0 };
    // failCommentAt: only the Nth comment POST fails (a partial failure).
    const postFails = () => { state.commentPosts++; return state.failComments || (failCommentAt > 0 && state.commentPosts === failCommentAt); };
    // pageSize: the list endpoints page like the real APIs (GitHub per_page/page,
    // Bitbucket pagelen + a `next` URL); 0 answers everything in one page.
    const pageOf = (url) => {
        const m = /[?&]page=(\d+)/.exec(url);
        return m ? Number(m[1]) : 1;
    };
    const respond = (status, body) => ({
        content: [{ text: '' }],
        structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout: `${body === undefined ? '' : JSON.stringify(body)}\n${status}`, stderr: '' },
    });
    const urlOf = (cmd) => {
        const quoted = /'(https:\/\/[^']+)'\s*$/.exec(cmd);
        return quoted ? quoted[1] : cmd.trim().split(/\s+/).pop();
    };
    const listOut = () => [...state.comments.entries()].map(([id, body]) => ({ id, body }));
    const addComment = (body) => {
        const id = state.nextCommentId++;
        state.comments.set(id, body);
        return id;
    };
    state.exec = (cmd) => {
        const method = /^curl(?:\.exe)? -sS -X (\w+)/.exec(cmd)[1];
        const url = urlOf(cmd);
        state.calls.push(`${method} ${url}`);
        const json = () => staged.json(cmd);
        if (provider === 'github') {
            if (method === 'POST' && /\/pulls$/.test(url)) {
                if (state.pr) return respond(422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for acme:feat/x.' }] });
                state.pr = { id: 42, title: json().title, body: json().body };
                return respond(201, { number: 42, html_url: 'https://github.com/acme/widgets/pull/42' });
            }
            if (method === 'GET' && /\/pulls\?/.test(url)) {
                return respond(200, state.pr ? [{ number: 42, title: state.pr.title, body: state.pr.body, html_url: 'https://github.com/acme/widgets/pull/42' }] : []);
            }
            if (method === 'PATCH' && /\/pulls\/42$/.test(url)) {
                state.pr = { ...state.pr, title: json().title, body: json().body };
                return respond(200, { number: 42, html_url: 'https://github.com/acme/widgets/pull/42' });
            }
            if (method === 'POST' && /\/issues\/42\/comments$/.test(url)) {
                if (postFails()) return respond(500, { message: 'Server Error' });
                return respond(201, { id: addComment(json().body) });
            }
            if (method === 'GET' && /\/issues\/42\/comments\?/.test(url)) {
                if (!pageSize) return respond(200, listOut());
                const pg = pageOf(url);
                return respond(200, listOut().slice((pg - 1) * pageSize, pg * pageSize));
            }
            const cm = /\/issues\/comments\/(\d+)$/.exec(url);
            if (cm && method === 'PATCH') { state.comments.set(Number(cm[1]), json().body); return respond(200, { id: Number(cm[1]) }); }
            if (cm && method === 'DELETE') { state.comments.delete(Number(cm[1])); return respond(204); }
        }
        if (provider === 'azure-devops') {
            if (method === 'POST' && /\/pullrequests\?api-version/.test(url)) {
                state.pr = { id: 7, title: json().title, body: json().description };
                return respond(201, { pullRequestId: 7 });
            }
            if (method === 'PATCH' && /\/pullrequests\/7\?api-version/.test(url)) {
                state.pr = { ...state.pr, title: json().title ?? state.pr.title, body: json().description ?? state.pr.body };
                return respond(200, { pullRequestId: 7 });
            }
            if (method === 'POST' && /\/pullrequests\/7\/threads\?api-version/.test(url)) {
                if (state.failComments) return respond(500, { message: 'Server Error' });
                const id = addComment(json().comments[0].content);
                return respond(200, { id, comments: [{ id: 1, parentCommentId: 0, content: state.comments.get(id) }] });
            }
            if (method === 'GET' && /\/pullrequests\/7\/threads\?api-version/.test(url)) {
                return respond(200, { value: listOut().map((c) => ({ id: c.id, comments: [{ id: 1, parentCommentId: 0, content: c.body, commentType: 'text' }] })) });
            }
            const tm = /\/threads\/(\d+)\/comments\/1\?api-version/.exec(url);
            if (tm && method === 'PATCH') { state.comments.set(Number(tm[1]), json().content); return respond(200, {}); }
            if (tm && method === 'DELETE') { state.comments.delete(Number(tm[1])); return respond(200); }
        }
        if (provider === 'bitbucket') {
            if (method === 'GET' && /\/pullrequests\?/.test(url)) {
                return respond(200, { values: state.pr ? [{ id: 9, title: state.pr.title, description: state.pr.body, links: { html: { href: 'https://bitbucket.org/acme/widgets/pull-requests/9' } } }] : [] });
            }
            if (method === 'POST' && /\/pullrequests$/.test(url)) {
                state.pr = { id: 9, title: json().title, body: json().description };
                return respond(201, { id: 9, links: { html: { href: 'https://bitbucket.org/acme/widgets/pull-requests/9' } } });
            }
            if (method === 'PUT' && /\/pullrequests\/9$/.test(url)) {
                state.pr = { ...state.pr, title: json().title ?? state.pr.title, body: json().description ?? state.pr.body };
                return respond(200, { id: 9 });
            }
            if (method === 'POST' && /\/pullrequests\/9\/comments$/.test(url)) {
                if (postFails()) return respond(500, { error: { message: 'Server Error' } });
                return respond(201, { id: addComment(json().content.raw) });
            }
            if (method === 'GET' && /\/pullrequests\/9\/comments\?/.test(url)) {
                const all = listOut().map((c) => ({ id: c.id, content: { raw: c.body } }));
                if (!pageSize) return respond(200, { values: all });
                const pg = pageOf(url);
                const base = url.replace(/[?&]page=\d+/, '');
                return respond(200, {
                    values: all.slice((pg - 1) * pageSize, pg * pageSize),
                    ...(pg * pageSize < all.length ? { next: `${base}${base.includes('?') ? '&' : '?'}page=${pg + 1}` } : {}),
                });
            }
            const bm = /\/pullrequests\/9\/comments\/(\d+)$/.exec(url);
            if (bm && method === 'PUT') { state.comments.set(Number(bm[1]), json().content.raw); return respond(200, {}); }
            if (bm && method === 'DELETE') { state.comments.delete(Number(bm[1])); return respond(204); }
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
    state.command = async (cmd) => (cmd === 'git remote get-url origin'
        ? { ok: true, output: REMOTES[provider], error: null }
        : { ok: true, output: '', error: null });
    /** Engine overflow comments, in chunk order. */
    state.overflowComments = () => [...state.comments.values()]
        .map((body) => ({ body, parsed: parseOverflowComment(body) }))
        .filter((c) => c.parsed && !c.parsed.superseded)
        .sort((a, b) => a.parsed.index - b.parsed.index);
    return state;
}

async function publish(fake, { notes, runId = 'run-1', verdict = 'PASS', mergeAssessment } = {}) {
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
        finalVerdictResult: mergeAssessment ? { verdict, notes, merge_assessment: mergeAssessment } : { verdict, notes },
    });
    return { result, logs };
}

/** The reviewer-notes text the description carries (the exact notes prefix). */
function descriptionNotes(body) {
    const start = body.indexOf('### Reviewer notes\n\n') + '### Reviewer notes\n\n'.length;
    const split = body.indexOf(`\n\n${NOTES_CONTINUED_MARKER}`, start);
    assert.ok(split > 0, 'a split description marks where the notes continue');
    return body.slice(start, split);
}

/** The visible description: everything before the hidden run-history block. */
function visibleDescription(body) {
    const at = body.indexOf(`<!-- ${RUN_HISTORY_MARKER}`);
    assert.ok(at > 0, 'the description carries the run-history marker block');
    return body.slice(0, at).trimEnd();
}

const ASSESSMENT = Object.freeze({
    value: 'v', risk: 'r', default_path_changes: 'none', blast_radius: 'b', upgrade_impact: 'none', proof: 'p',
    recommendation: 'merge_after_proof', reason: 'needs a live run',
});

describe('zero reviewer-note loss per provider with a 20k-character final review', () => {
    for (const provider of ['github', 'azure-devops', 'bitbucket']) {
        test(`${provider}: description within its limit + overflow comments concatenate to the full sanitized notes`, async () => {
            const fake = fakeProvider(provider);
            const notes = longReview(20000);
            const full = sanitizePrMarkdown(notes);
            const { descriptionMaxLength, commentMaxLength } = getProviderTextLimits(provider);
            const { logs } = await publish(fake, { notes, mergeAssessment: ASSESSMENT });
            const body = fake.pr.body;

            assert.ok(body.length <= descriptionMaxLength, `${provider}: description ${body.length} > ${descriptionMaxLength}`);
            assert.ok(body.startsWith('## Sprint verdict: PASS'), 'the description starts with the verdict');
            assert.ok(body.indexOf('### Merge assessment') < body.indexOf('### Reviewer notes'), 'merge assessment before the notes');
            assert.deepEqual(parseRunHistory(body).map((e) => e.run), ['run-1'], 'run-history marker block intact');
            assert.ok(body.trimEnd().endsWith('-->'), 'the hidden marker block closes the body');

            const comments = fake.overflowComments();
            if (descriptionMaxLength >= full.length + 2000) {
                // GitHub: the whole review fits its description.
                assert.equal(comments.length, 0);
                assert.ok(body.includes(full), 'all notes are in the description');
                return;
            }
            assert.ok(comments.length >= 1, `${provider}: overflow comments posted`);
            for (const c of comments) {
                assert.ok(c.body.length <= commentMaxLength, `${provider}: comment ${c.body.length} > ${commentMaxLength}`);
                assert.equal(c.parsed.total, comments.length);
            }
            assert.deepEqual(comments.map((c) => c.parsed.index), comments.map((_, i) => i + 1));
            const visible = visibleDescription(body);
            assert.ok(visible.endsWith(`Reviewer notes continued in ${comments.length} comment(s) below.`), visible.slice(-200));
            const joined = descriptionNotes(body) + comments.map((c) => c.parsed.text).join('');
            assert.equal(joined.length, full.length, `${provider}: zero characters dropped`);
            assert.equal(joined, full, `${provider}: description + comments concatenate to the full sanitized notes`);
            assert.ok(logs.some((l) => l.includes(full)), 'the full notes are in the run log');
        });
    }
});

describe('relaunch on the same PR upserts the engine overflow comments', () => {
    test('bitbucket: run 2 updates marked comments in place, none duplicated, surplus removed; run 3 clears them all', async () => {
        const fake = fakeProvider('bitbucket');
        fake.comments.set(1, 'a human review comment');
        await publish(fake, { notes: longReview(20000, 'one'), runId: 'run-1' });
        const run1 = fake.overflowComments();
        const run1Ids = [...fake.comments.entries()].filter(([, b]) => parseOverflowComment(b)).map(([id]) => id);
        assert.ok(run1.length >= 4, `run 1 posted ${run1.length} overflow comments`);

        const notes2 = longReview(12000, 'two');
        const callsBefore = fake.calls.length;
        const { logs } = await publish(fake, { notes: notes2, runId: 'run-2' });
        const run2Calls = fake.calls.slice(callsBefore);
        const run2 = fake.overflowComments();
        assert.ok(run2.length >= 1 && run2.length < run1.length, `run 2 has ${run2.length} chunks`);
        const markedIds = [...fake.comments.entries()].filter(([, b]) => parseOverflowComment(b)).map(([id]) => id);
        assert.equal(markedIds.length, run2.length, 'exactly one engine comment per chunk -- no duplicates, surplus removed');
        assert.ok(markedIds.every((id) => run1Ids.includes(id)), 'marked comments were updated in place, not re-posted');
        assert.ok(!run2Calls.some((c) => /^POST .*\/comments$/.test(c)), `no new comment posted on the relaunch: ${run2Calls.join(', ')}`);
        assert.ok(run2Calls.some((c) => /^GET .*\/comments\?/.test(c)), 'the relaunch lists the PR comments first');
        assert.equal(descriptionNotes(fake.pr.body) + run2.map((c) => c.parsed.text).join(''), sanitizePrMarkdown(notes2));
        assert.deepEqual(parseRunHistory(fake.pr.body).map((e) => e.run), ['run-2', 'run-1']);
        assert.ok(logs.some((l) => /removed/.test(l) || /updated/.test(l)), logs.join('\n'));

        await publish(fake, { notes: 'short final review', runId: 'run-3' });
        assert.equal(fake.overflowComments().length, 0, 'notes that fit leave no engine comment behind');
        assert.ok(fake.comments.has(1) && fake.comments.get(1) === 'a human review comment', 'human comments are never touched');
    });
});

describe('a failed comment post never fails the sprint', () => {
    test('azure-devops: WARN logged naming the PR and chunk, the description points at the run log, publish completes', async () => {
        const fake = fakeProvider('azure-devops', { failComments: true });
        const notes = longReview(20000);
        const { result, logs } = await publish(fake, { notes });
        assert.deepEqual(result, { pushed: true }, 'the publish phase completes normally');
        assert.ok(logs.some((l) => /WARNING: could not post reviewer-notes overflow comment 1 of \d+ on PR https:\/\/dev\.azure\.com\/acme\/proj\/_git\/widgets\/pullrequest\/7/.test(l)), logs.join('\n'));
        const visible = visibleDescription(fake.pr.body);
        assert.match(visible, /Reviewer notes continued: \d+ characters did not fit this description and could not be posted as PR comments -- the full notes are in the sprint run log\.$/);
        assert.ok(fake.pr.body.length <= getProviderTextLimits('azure-devops').descriptionMaxLength);
        assert.deepEqual(parseRunHistory(fake.pr.body).map((e) => e.run), ['run-1']);
        assert.ok(logs.some((l) => l.includes(sanitizePrMarkdown(notes))), 'the full notes are in the run log');
    });
});

describe('the 20-comment ceiling', () => {
    test('azure-devops: past the ceiling the last comment names the characters not posted; the full notes are in the run log', async () => {
        const fake = fakeProvider('azure-devops');
        const notes = longReview(90000);
        const full = sanitizePrMarkdown(notes);
        const { logs } = await publish(fake, { notes });
        const comments = fake.overflowComments();
        assert.equal(comments.length, OVERFLOW_MAX_COMMENTS);
        const last = comments[comments.length - 1].parsed.text;
        const m = /\*\[\.\.\. (\d+) characters of reviewer notes not posted: the 20-comment limit was reached -- the full notes are in the sprint run log \.\.\.\]\*$/.exec(last);
        assert.ok(m, last.slice(-300));
        const posted = descriptionNotes(fake.pr.body) + comments.map((c) => c.parsed.text).join('').replace(/\n\n\*\[\.\.\. \d+ characters of reviewer notes not posted[^\n]*$/, '');
        assert.equal(posted.length + Number(m[1]), full.length, 'posted + not posted = the full notes');
        assert.ok(full.startsWith(posted));
        assert.ok(logs.some((l) => l.includes(full)), 'the full notes are in the run log');
        assert.ok(logs.some((l) => l.includes(`${m[1]} characters past the comment ceiling are not posted`)), logs.join('\n'));
    });
});

describe('the abort PR path uses the same overflow behaviour', () => {
    test('azure-devops: long abort details go to overflow comments; description + comments carry them in full', async () => {
        const fake = fakeProvider('azure-devops');
        const message = `Plan rejected: ${'reason segment '.repeat(900)}`.trim();
        const logs = [];
        const command = async (cmd, opts = {}) => {
            const out = (output) => (opts.failSoft ? { ok: true, output, error: null } : output);
            if (/^git fetch origin\b/.test(cmd)) return out('');
            if (/^git rev-list --count\b/.test(cmd)) return out('2');
            if (/^git push\b/.test(cmd)) return out('To mock-remote');
            if (/^git remote get-url origin\b/.test(cmd)) return out(REMOTES['azure-devops']);
            return out('');
        };
        const result = await finalizeAbort({
            error: new SprintPlanRejectedError(message, { notes: null }),
            branch: 'feat/x', baseBranch: 'main', member: 'abort-ovf', command,
            log: (m) => logs.push(m), callTool: fake.callTool, runId: 'run-abort',
        });
        assert.equal(result.reason, 'aborted-pr-created', JSON.stringify(result));
        const body = fake.pr.body;
        assert.ok(body.startsWith('## Sprint verdict: ABORTED'));
        assert.ok(body.length <= getProviderTextLimits('azure-devops').descriptionMaxLength);
        const comments = fake.overflowComments();
        assert.ok(comments.length >= 1, 'abort details overflow into comments');
        const start = body.indexOf('### Abort details\n\n') + '### Abort details\n\n'.length;
        const inBody = body.slice(start, body.indexOf(`\n\n${NOTES_CONTINUED_MARKER}`, start));
        const joined = inBody + comments.map((c) => c.parsed.text).join('');
        assert.ok(joined.includes(message), 'the full abort message is on the PR');
        assert.ok(logs.some((l) => l.includes('[Publish Abort PR]') && l.includes(message)), 'the full abort details are in the run log');
    });
});

describe('github: a final review past the 60000-character description limit', () => {
    test('description = verdict + merge assessment + notes prefix; overflow in ordered engine comments; relaunch upserts', async () => {
        const fake = fakeProvider('github');
        fake.comments.set(1, 'a human review comment');
        const { descriptionMaxLength, commentMaxLength } = getProviderTextLimits('github');
        const notes = longReview(150000, 'gh');
        const full = sanitizePrMarkdown(notes);
        assert.ok(full.length > descriptionMaxLength, 'the review exceeds the GitHub description limit');
        const { logs } = await publish(fake, { notes, mergeAssessment: ASSESSMENT, runId: 'run-1' });
        const body = fake.pr.body;

        assert.ok(body.length <= descriptionMaxLength, `description ${body.length} > ${descriptionMaxLength}`);
        assert.ok(body.startsWith('## Sprint verdict: PASS'), 'the description starts with the verdict');
        const ma = body.indexOf('### Merge assessment');
        assert.ok(ma > 0 && ma < body.indexOf('### Reviewer notes'), 'merge assessment right after the verdict, before the notes');
        assert.deepEqual(parseRunHistory(body).map((e) => e.run), ['run-1'], 'run-history marker block intact');

        const run1 = fake.overflowComments();
        assert.ok(run1.length >= 2, `overflow spans several comments (got ${run1.length})`);
        for (const c of run1) {
            assert.ok(c.body.length <= commentMaxLength, `comment ${c.body.length} > ${commentMaxLength}`);
            assert.equal(c.parsed.total, run1.length);
        }
        assert.deepEqual(run1.map((c) => c.parsed.index), run1.map((_, i) => i + 1), 'chunks in order');
        assert.ok(visibleDescription(body).endsWith(`Reviewer notes continued in ${run1.length} comment(s) below.`));
        const joined = descriptionNotes(body) + run1.map((c) => c.parsed.text).join('');
        assert.equal(joined, full, 'description + comments concatenate to the full sanitized notes');
        assert.ok(logs.some((l) => l.includes(full)), 'the full notes are in the run log');

        const run1Ids = [...fake.comments.entries()].filter(([, b]) => parseOverflowComment(b)).map(([id]) => id);
        const notes2 = longReview(150000, 'gh2');
        const callsBefore = fake.calls.length;
        await publish(fake, { notes: notes2, mergeAssessment: ASSESSMENT, runId: 'run-2' });
        const run2Calls = fake.calls.slice(callsBefore);
        const run2 = fake.overflowComments();
        const markedIds = [...fake.comments.entries()].filter(([, b]) => parseOverflowComment(b)).map(([id]) => id);
        assert.equal(markedIds.length, run2.length, 'one engine comment per chunk -- no duplicates');
        assert.ok(markedIds.every((id) => run1Ids.includes(id)), 'engine comments were updated in place');
        assert.ok(!run2Calls.some((c) => /^POST .*\/issues\/42\/comments$/.test(c)), `no new comment posted on the relaunch: ${run2Calls.join(', ')}`);
        assert.ok(run2Calls.some((c) => /^PATCH .*\/issues\/comments\/\d+$/.test(c)), 'the relaunch patches the existing comments');
        assert.equal(descriptionNotes(fake.pr.body) + run2.map((c) => c.parsed.text).join(''), sanitizePrMarkdown(notes2));
        assert.deepEqual(parseRunHistory(fake.pr.body).map((e) => e.run), ['run-2', 'run-1']);
        assert.equal(fake.comments.get(1), 'a human review comment', 'human comments are never touched');
    });
});

describe('mock-sprint publish on GitHub with a 20k-character final review', () => {
    test('zero characters of the final review are dropped from the PR', async () => {
        const notes = longReview(20000, 'ms');
        const full = sanitizePrMarkdown(notes);
        const records = new Map();
        const branch = 'auto-sprint/mock-pr-overflow-zero-loss';
        const run = await withScenarioMarkers('provf', () => runDevelopLoopScenario('provf', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: long final review' }],
            maxCycles: 1,
            prRecordState: records,
            branchOverride: branch,
            finalReviewHandler: () => ({ content: [{ text: JSON.stringify({ verdict: 'PASS', notes }) }] }),
        }));
        assert.ok(!run.error, run.error && run.error.message);
        const rec = records.get(branch);
        assert.ok(rec && typeof rec.body === 'string', `a PR was raised for ${branch}`);
        assert.ok(rec.body.length <= getProviderTextLimits('github').descriptionMaxLength);
        assert.ok(rec.body.includes(full), 'the whole sanitized final review is in the GitHub PR description');
        assert.ok(!rec.body.includes(NOTES_CONTINUED_MARKER), 'nothing had to overflow on GitHub');
    });
});

describe('relaunch on a PR with 150 existing comments (overflow on page 2)', () => {
    const MARKED = /^(PATCH .*\/issues\/comments\/\d+|PUT .*\/pullrequests\/9\/comments\/\d+)$/;
    const POSTED = /^POST .*\/(issues\/42|pullrequests\/9)\/comments$/;
    for (const [provider, size] of [['github', 150000], ['bitbucket', 20000]]) {
        test(`${provider}: the relaunch finds the engine comments on page 2 and updates them in place -- none posted, none duplicated`, async () => {
            const fake = fakeProvider(provider, { pageSize: 100 });
            fake.nextCommentId = 1000;
            for (let i = 1; i <= 150; i++) fake.comments.set(i, `human comment ${i}`);
            await publish(fake, { notes: longReview(size, 'one'), runId: 'run-1' });
            const run1Ids = [...fake.comments.entries()].filter(([, b]) => parseOverflowComment(b)).map(([id]) => id);
            assert.ok(run1Ids.length >= 2, `run 1 posted ${run1Ids.length} overflow comments`);
            assert.ok([...fake.comments.keys()].indexOf(run1Ids[0]) >= 100, 'the engine comments sit past page 1');

            const callsBefore = fake.calls.length;
            await publish(fake, { notes: longReview(size, 'two'), runId: 'run-2' });
            const run2Calls = fake.calls.slice(callsBefore);
            const markedIds = [...fake.comments.entries()].filter(([, b]) => parseOverflowComment(b)).map(([id]) => id);
            assert.deepEqual(markedIds, run1Ids, 'the same engine comments, none duplicated');
            assert.ok(!run2Calls.some((c) => POSTED.test(c)), `no new comment posted on the relaunch: ${run2Calls.join(', ')}`);
            assert.equal(run2Calls.filter((c) => MARKED.test(c)).length, run1Ids.length, 'every existing engine comment updated in place');
            assert.ok(run2Calls.filter((c) => /^GET .*\/comments\?/.test(c)).length >= 2, 'the comment list was paged');
            assert.equal(fake.comments.get(1), 'human comment 1');
            assert.equal(fake.comments.size, 150 + run1Ids.length);
        });
    }
});

describe('a partial overflow-comment post failure', () => {
    test('bitbucket: the 2nd post fails -> the description pointer names how many comments were posted', async () => {
        const fake = fakeProvider('bitbucket', { failCommentAt: 2 });
        const { result, logs } = await publish(fake, { notes: longReview(20000) });
        assert.deepEqual(result, { pushed: true });
        assert.ok(logs.some((l) => /WARNING: could not post reviewer-notes overflow comment 2 of \d+/.test(l)), logs.join('\n'));
        const visible = visibleDescription(fake.pr.body);
        assert.match(visible, /Reviewer notes continued: \d+ characters did not fit this description; 1 of \d+ overflow comment\(s\) were posted and \d+ could not be -- the rest of the notes are in the sprint run log\.$/);
        assert.ok(fake.pr.body.length <= getProviderTextLimits('bitbucket').descriptionMaxLength);
    });
});
