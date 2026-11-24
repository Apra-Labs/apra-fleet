import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// Namespace import on purpose: on a tree without linked overflow (no
// overflowLinkedPointer / OVERFLOW_SECTION_STUB exports) the cases must fail
// on their assertions, not on a missing-export SyntaxError at link time.
import * as prBody from '../fleet-sprint/pr-body.mjs';
import { getProviderTextLimits } from '../fleet-sprint/vcs-module.mjs';
import { raiseVcsPrForMember } from '../fleet-sprint/vcs-auth.mjs';
import { ApraFleet } from '@apralabs/apra-fleet-client';
import { createStagedFileRecorder, TEST_MEMBER_FOLDER } from './helpers/vcs-payload-test.mjs';

const { buildSprintPrBody, sanitizePrMarkdown, parseOverflowComment, sprintPrTitleFor, buildSprintPrTitle, locateFleetBlock } = prBody;
const NOTES_CONTINUED_MARKER = prBody.NOTES_CONTINUED_MARKER;

// =============================================================================
// Fleet PR text that does not fit the description goes to PR comments that
// the description LINKS to -- every section, not only the reviewer notes, and
// nothing is truncated to fit. A relaunch on a human-written PR (2000
// characters of human text outside the fleet block) on Azure DevOps and
// Bitbucket (3500-character descriptions) with long merge assessment,
// details, set-aside, cost and reviewer notes:
//   1. block + comments together carry every section in full, with no
//      truncated-to-fit marker anywhere;
//   2. the block carries a markdown link whose target is the URL of the
//      comment the provider returned;
//   3. the whole description is within the provider limit;
//   4. GitHub (large limit) posts no comment for the same input;
//   5. a failed comment post falls back to the run-log pointer.
//
// The providers are faked at the REST level behind vcs_credential_exec: the
// real builders, staged request bodies and raiseVcsPrForMember run.
//
// ASCII only.
// =============================================================================

const REMOTES = {
    github: 'https://github.com/acme/widgets.git',
    'azure-devops': 'https://dev.azure.com/acme/proj/_git/widgets',
    bitbucket: 'https://bitbucket.org/acme/widgets.git',
};
const PR_URLS = {
    github: 'https://github.com/acme/widgets/pull/42',
    'azure-devops': 'https://dev.azure.com/acme/proj/_git/widgets/pullrequest/7',
    bitbucket: 'https://bitbucket.org/acme/widgets/pull-requests/9',
};
const HUMAN_TITLE = 'Widgets: rework the store';
const HUMAN_TEXT = (() => {
    const lines = [];
    let len = 0;
    for (let i = 0; len < 2000; i++) {
        const line = `Human context line ${i}: why the store needs reworking, ${'and more words '.repeat(1 + (i % 4))}`.trimEnd();
        lines.push(line);
        len += line.length + 1;
    }
    return lines.join('\n').slice(0, 2000);
})();

/** A ~`size`-character multi-line review (ASCII, no fences). */
function longText(size, tag) {
    const lines = [];
    let len = 0;
    for (let i = 0; len < size; i++) {
        const line = `- ${tag}${i}: finding ${i} -- ${'detail '.repeat(1 + (i % 6))}`.trimEnd();
        lines.push(line);
        len += line.length + 1;
    }
    return lines.join('\n');
}

const ASSESSMENT = Object.freeze({
    value: `value: ${'the store is faster and simpler '.repeat(9)}`.trim(),
    risk: `risk: ${'a migration touches every widget row '.repeat(8)}`.trim(),
    default_path_changes: `default path: ${'the read path now goes through the cache '.repeat(7)}`.trim(),
    blast_radius: `blast radius: ${'every consumer of the store module '.repeat(8)}`.trim(),
    upgrade_impact: `upgrade: ${'a one-off reindex on first start '.repeat(8)}`.trim(),
    proof: `proof: ${'unit and integration suites plus a live run '.repeat(6)}`.trim(),
    recommendation: 'merge_after_proof',
    reason: `reason: ${'needs a live run on a large store '.repeat(6)}`.trim(),
});
const DETAILS = Array.from({ length: 5 }, (_, i) => `Detail ${i}: ${'an engine-authored note about this run '.repeat(4)}`.trim());
const SET_ASIDE = Array.from({ length: 4 }, (_, i) => ({ id: `wid-${i}`, kind: 'blocked', reason: `blocked on an external service ${'that is not reachable from the member '.repeat(3)}`.trim(), cycle: 1, round: i + 1 }));
const COST = Array.from({ length: 14 }, (_, i) => `role-${i}  calls=${i + 3}  tokens=${(i + 1) * 12345}  cost=$${(i * 0.37).toFixed(2)}`).join('\n');
const NOTES = longText(3000, 'n');

/** A fake hosting provider holding an existing PR with a human-written title
 *  and description; records the description and the comments (id -> body). */
function fakeProvider(provider, { failComments = false } = {}) {
    const staged = createStagedFileRecorder();
    const state = {
        provider,
        pr: { title: HUMAN_TITLE, body: HUMAN_TEXT },
        comments: new Map(),
        commentUrls: new Map(),
        nextCommentId: 100,
        calls: [],
        prPatches: 0,
    };
    const respond = (status, body) => ({
        content: [{ text: '' }],
        structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout: `${body === undefined ? '' : JSON.stringify(body)}\n${status}`, stderr: '' },
    });
    const urlOf = (cmd) => {
        const quoted = /'(https:\/\/[^']+)'\s*$/.exec(cmd);
        return quoted ? quoted[1] : cmd.trim().split(/\s+/).pop();
    };
    const addComment = (body, url) => {
        const id = state.nextCommentId++;
        state.comments.set(id, body);
        if (url) state.commentUrls.set(id, url(id));
        return id;
    };
    state.exec = (cmd) => {
        const method = /^curl(?:\.exe)? -sS -X (\w+)/.exec(cmd)[1];
        const url = urlOf(cmd);
        state.calls.push(`${method} ${url}`);
        const json = () => staged.json(cmd);
        if (provider === 'github') {
            if (method === 'POST' && /\/pulls$/.test(url)) {
                return respond(422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for acme:feat/x.' }] });
            }
            if (method === 'GET' && /\/pulls\?/.test(url)) {
                return respond(200, [{ number: 42, title: state.pr.title, body: state.pr.body, html_url: PR_URLS.github }]);
            }
            if (method === 'PATCH' && /\/pulls\/42$/.test(url)) {
                state.prPatches++;
                state.pr = { title: json().title, body: json().body };
                return respond(200, { number: 42, html_url: PR_URLS.github });
            }
            if (method === 'GET' && /\/issues\/42\/comments\?/.test(url)) {
                return respond(200, [...state.comments.entries()].map(([id, body]) => ({ id, body, html_url: state.commentUrls.get(id) })));
            }
            if (method === 'POST' && /\/issues\/42\/comments$/.test(url)) {
                if (failComments) return respond(500, { message: 'Server Error' });
                const id = addComment(json().body, (n) => `${PR_URLS.github}#issuecomment-gh${n}`);
                return respond(201, { id, html_url: state.commentUrls.get(id) });
            }
        }
        if (provider === 'azure-devops') {
            if (method === 'POST' && /\/pullrequests\?api-version/.test(url)) {
                return respond(409, { message: 'TF401179: An active pull request for the source and target branch already exists.' });
            }
            if (method === 'GET' && /\/pullrequests\?searchCriteria\./.test(url)) {
                return respond(200, { value: [{ pullRequestId: 7, title: state.pr.title, description: state.pr.body.slice(0, 400) }] });
            }
            if (method === 'GET' && /\/pullrequests\/7\?api-version/.test(url)) {
                return respond(200, { pullRequestId: 7, title: state.pr.title, description: state.pr.body });
            }
            if (method === 'PATCH' && /\/pullrequests\/7\?api-version/.test(url)) {
                state.prPatches++;
                state.pr = { title: json().title ?? state.pr.title, body: json().description ?? state.pr.body };
                return respond(200, { pullRequestId: 7 });
            }
            if (method === 'GET' && /\/pullrequests\/7\/threads\?api-version/.test(url)) {
                return respond(200, { value: [...state.comments.entries()].map(([id, body]) => ({ id, comments: [{ id: 1, parentCommentId: 0, content: body, commentType: 'text' }] })) });
            }
            if (method === 'POST' && /\/pullrequests\/7\/threads\?api-version/.test(url)) {
                if (failComments) return respond(500, { message: 'Server Error' });
                // The real create response is the new thread: no browser link,
                // so the link is built from the PR URL and this thread id.
                const id = addComment(json().comments[0].content, (n) => `${PR_URLS['azure-devops']}?_a=overview&discussionId=${n}`);
                return respond(200, { id, comments: [{ id: 1, parentCommentId: 0, content: state.comments.get(id) }] });
            }
        }
        if (provider === 'bitbucket') {
            if (method === 'GET' && /\/pullrequests\?/.test(url)) {
                return respond(200, { values: [{ id: 9, title: state.pr.title, description: state.pr.body, links: { html: { href: PR_URLS.bitbucket } } }] });
            }
            if (method === 'PUT' && /\/pullrequests\/9$/.test(url)) {
                state.prPatches++;
                state.pr = { title: json().title ?? state.pr.title, body: json().description ?? state.pr.body };
                return respond(200, { id: 9 });
            }
            if (method === 'GET' && /\/pullrequests\/9\/comments\?/.test(url)) {
                return respond(200, { values: [...state.comments.entries()].map(([id, body]) => ({ id, content: { raw: body }, links: { html: { href: state.commentUrls.get(id) } } })) });
            }
            if (method === 'POST' && /\/pullrequests\/9\/comments$/.test(url)) {
                if (failComments) return respond(500, { error: { message: 'Server Error' } });
                // A distinctive links.html.href, so the test proves the
                // returned link (not a built anchor) is what gets linked.
                const id = addComment(json().content.raw, (n) => `${PR_URLS.bitbucket}/overview#returned-comment-${n}`);
                return respond(201, { id, links: { html: { href: state.commentUrls.get(id) } } });
            }
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
    /** Engine overflow comments in chunk order, with their ids. */
    state.overflowComments = () => [...state.comments.entries()]
        .map(([id, body]) => ({ id, body, parsed: parseOverflowComment(body) }))
        .filter((c) => c.parsed && !c.parsed.superseded)
        .sort((a, b) => a.parsed.index - b.parsed.index);
    return state;
}

/** One relaunch publish on the fake's existing PR, built like Publish PR. */
async function relaunch(fake) {
    const logs = [];
    let last = null;
    const fleetTitle = buildSprintPrTitle({ verdict: 'FAIL', branch: 'feat/x' });
    const build = (previousBody, limits = {}) => (last = buildSprintPrBody({
        verdict: 'FAIL', goal: 'Ship X', branch: 'feat/x', baseBranch: 'main', runId: 'run-2',
        now: new Date(Date.UTC(2026, 10, 1, 9, 30)),
        notes: NOTES, mergeAssessment: ASSESSMENT, details: DETAILS, setAside: SET_ASIDE, costAnalysis: COST,
        previousBody,
        ...(limits.descriptionMaxLength ? { maxLength: limits.descriptionMaxLength } : {}),
        ...(limits.commentMaxLength ? { commentMaxLength: limits.commentMaxLength } : {}),
    }));
    const result = await raiseVcsPrForMember({
        fleetApi: new ApraFleet({ callTool: fake.callTool }),
        command: fake.command,
        member: 'pub',
        base: 'main',
        head: 'feat/x',
        title: fleetTitle,
        body: (limits) => build('', limits),
        log: (m) => logs.push(m),
        logPrefix: '[Publish PR]',
        remoteUrlOverride: REMOTES[fake.provider],
        updateExisting: ({ title, body }, limits) => ({ title: sprintPrTitleFor(title, fleetTitle), body: build(body, limits) }),
    });
    return { result, logs, last };
}

/** Every section's full text, as the PR must carry it somewhere. */
function expectedSections() {
    const inline = (t) => sanitizePrMarkdown(t).replace(/\s*\n\s*/g, ' ');
    return [
        ...Object.entries(ASSESSMENT).filter(([k]) => k !== 'recommendation').map(([k, v]) => [`merge assessment ${k}`, inline(v)]),
        ...DETAILS.map((d, i) => [`detail ${i}`, inline(d)]),
        ...SET_ASIDE.map((e) => [`set-aside ${e.id}`, inline(`${e.id}: ${e.reason}`)]),
        ['cost', sanitizePrMarkdown(COST)],
    ];
}

/** The fleet block of a description. */
function blockOf(body) {
    const loc = locateFleetBlock(body);
    assert.ok(loc, 'the description carries a fleet block');
    return loc;
}

describe('a relaunch on a human-written PR moves every section that does not fit to linked PR comments', () => {
    for (const provider of ['azure-devops', 'bitbucket']) {
        test(`${provider}: block + comments carry every section in full, description within the limit`, async () => {
            const fake = fakeProvider(provider);
            const { descriptionMaxLength, commentMaxLength } = getProviderTextLimits(provider);
            assert.equal(descriptionMaxLength, 3500, 'the small-description providers under test');
            const { result } = await relaunch(fake);
            assert.equal(result.ok, true, JSON.stringify(result));
            const body = fake.pr.body;
            const { before, block } = blockOf(body);
            assert.equal(before.replace(/\n+$/, ''), HUMAN_TEXT, 'the human text is kept byte-for-byte above the block');
            assert.equal(fake.pr.title, HUMAN_TITLE, 'the human title is kept');

            // (3) within the provider limit.
            assert.ok(body.length <= descriptionMaxLength, `description ${body.length} > ${descriptionMaxLength}`);

            const comments = fake.overflowComments();
            assert.ok(comments.length >= 1, 'the overflow is posted as engine comments');
            for (const c of comments) assert.ok(c.body.length <= commentMaxLength, `comment ${c.body.length} > ${commentMaxLength}`);
            const joined = comments.map((c) => c.parsed.text).join('');

            // (1) block + comments carry every section in full; nothing is
            // truncated to fit anywhere.
            const union = `${block}\n${joined}`;
            assert.doesNotMatch(union, /truncated/i, 'no truncated marker in the block or the comments');
            for (const [what, text] of expectedSections()) {
                assert.ok(union.includes(text), `${provider}: ${what} is on the PR in full`);
            }
            const fullNotes = sanitizePrMarkdown(NOTES);
            if (block.includes(NOTES_CONTINUED_MARKER)) {
                const start = block.indexOf('### Reviewer notes\n\n') + '### Reviewer notes\n\n'.length;
                const prefix = block.slice(start, block.indexOf(`\n\n${NOTES_CONTINUED_MARKER}`, start));
                assert.ok((prefix + joined).startsWith(fullNotes), 'notes prefix + comments continue the notes exactly');
            } else {
                assert.ok(union.includes(fullNotes), 'the notes are on the PR in full');
            }
            assert.ok(block.includes(prBody.OVERFLOW_SECTION_STUB), 'a moved section leaves a stub under its heading');
        });

        test(`${provider}: the block carries a markdown link to the URL returned for the posted comment`, async () => {
            const fake = fakeProvider(provider);
            const { result } = await relaunch(fake);
            assert.equal(result.ok, true, JSON.stringify(result));
            const { block } = blockOf(fake.pr.body);
            const comments = fake.overflowComments();
            assert.ok(comments.length >= 1, 'the overflow is posted as engine comments');
            // (2) the block links to the URL the provider returned for the
            // posted comment.
            const firstUrl = fake.commentUrls.get(comments[0].id);
            assert.ok(firstUrl, 'the fake recorded the posted comment link');
            assert.ok(block.includes(`](${firstUrl})`), `the block links to ${firstUrl}:\n${block.slice(-700)}`);
            assert.ok(result.overflow && result.overflow.linked === true, JSON.stringify(result.overflow));
        });
    }

    test('github (large limit): the same input posts no comment and the description carries everything', async () => {
        const fake = fakeProvider('github');
        const { result } = await relaunch(fake);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(fake.overflowComments().length, 0, 'no overflow comment');
        assert.equal(fake.comments.size, 0, 'no comment at all');
        const { block } = blockOf(fake.pr.body);
        for (const [what, text] of expectedSections()) assert.ok(block.includes(text), `github: ${what} in the description`);
        assert.ok(block.includes(sanitizePrMarkdown(NOTES)), 'github: the notes in full');
        assert.ok(!block.includes(prBody.OVERFLOW_SECTION_STUB), 'no section moved');
        assert.equal(fake.prPatches, 1, 'one description update, no second linking update');
    });

    for (const provider of ['azure-devops', 'bitbucket']) {
        test(`${provider}: a failed comment post falls back to the run-log pointer, with no link`, async () => {
            const fake = fakeProvider(provider, { failComments: true });
            const { result, logs } = await relaunch(fake);
            assert.equal(result.ok, true, 'the publish never fails over the comments');
            const { block } = blockOf(fake.pr.body);
            const visible = block.slice(0, block.indexOf('<!-- fleet-sprint:run-history')).trimEnd();
            assert.match(visible, /Sprint text continued: \d+ characters did not fit this description and could not be posted as PR comments -- the full text is in the sprint run log\.$/);
            assert.doesNotMatch(block, /\]\(https:/, 'no comment link');
            assert.ok(fake.pr.body.length <= getProviderTextLimits(provider).descriptionMaxLength);
            assert.ok(logs.some((l) => /WARNING: could not post reviewer-notes overflow comment 1 of \d+/.test(l)), logs.join('\n'));
        });
    }
});
