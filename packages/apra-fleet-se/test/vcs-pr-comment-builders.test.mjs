import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    VCSModule,
    buildCommentCommand,
    buildListCommentsCommand,
    buildUpdateCommentCommand,
    buildDeleteCommentCommand,
} from '../fleet-sprint/vcs-module.mjs';
import { POSIX_PAYLOAD_PATH, WINDOWS_PAYLOAD_PATH, posixDataBinaryArg } from './helpers/vcs-payload-test.mjs';

// =============================================================================
// PR comment builders: create / list / update / delete, per hosted provider.
//
// These are the building blocks of the PR-body overflow comments (and their
// relaunch upsert): GitHub issue comments, Azure DevOps PR threads, Bitbucket
// PR comments. Pinned here, with no network: the exact method, URL and
// header set of every command; that a body travels only as a staged file
// (--data-binary @<path>, never inline JSON); the list mapping to the
// provider-neutral { id, body, ref } shape; that update/delete take that
// `ref` back as comment_ref; and that bad ids fail with a typed ERROR.
//
// ASCII only.
// =============================================================================

const TOKEN = 'TOK-comment-builders';
const REDACTED = '***REDACTED***';
const W = "\n%{http_code}";

const PROVIDERS = {
    github: { provider: 'github', repo: 'acme/widgets' },
    'azure-devops': { provider: 'azure-devops', repoRef: { org: 'acme', project: 'proj one', repo: 'widgets' } },
    bitbucket: { provider: 'bitbucket', repoRef: { workspace: 'acme', repo: 'widgets' } },
};
const ADO_BASE = 'https://dev.azure.com/acme/proj%20one/_apis/git/repositories/widgets/pullrequests/7';
const BB_BASE = 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/7';
const GH_HEADERS = (body) => [
    `-H 'Authorization: Bearer ${TOKEN}'`,
    "-H 'Accept: application/vnd.github+json'",
    ...(body ? ["-H 'Content-Type: application/json'"] : []),
    "-H 'X-GitHub-Api-Version: 2022-11-28'",
];

/** Every built command: token only in `command`, redacted log twin, and no inline -d body. */
function assertCommandHygiene(built) {
    assert.ok(built.command.includes(TOKEN), 'the dispatched command carries the token');
    assert.ok(!built.logSafeCommand.includes(TOKEN) && built.logSafeCommand.includes(REDACTED), built.logSafeCommand);
    assert.equal(built.command.replace(TOKEN, REDACTED), built.logSafeCommand);
    assert.ok(!JSON.stringify({ ...built, command: undefined, mapResponse: undefined }).includes(TOKEN), 'token only in command');
    assert.ok(!/ -d /.test(built.command), `no inline -d body: ${built.command}`);
    assert.ok(built.command.includes(`-w '${W}'`), 'keeps the -w status-line convention');
}

describe('github PR comment builders (issue comments API)', () => {
    const p = { ...PROVIDERS.github, token: TOKEN, os: 'linux' };

    test('comment: POST .../issues/{n}/comments, body staged; pull_request_id is accepted as the issue number', () => {
        const built = buildCommentCommand({ ...p, pull_request_id: 7, body: 'chunk 1', payload_path: POSIX_PAYLOAD_PATH });
        assert.equal(built.command, ['curl -sS -X POST', ...GH_HEADERS(true), posixDataBinaryArg(), `-w '${W}'`,
            'https://api.github.com/repos/acme/widgets/issues/7/comments'].join(' '));
        assert.deepEqual(built.payload, { path: POSIX_PAYLOAD_PATH, content: JSON.stringify({ body: 'chunk 1' }) });
        assertCommandHygiene(built);
    });

    test('list-comments: GET .../issues/{n}/comments?per_page=100 and maps to { id, body, ref }', () => {
        const built = buildListCommentsCommand({ ...p, pull_request_id: 7 });
        assert.equal(built.action, 'list-comments');
        assert.equal(built.command, ['curl -sS -X GET', ...GH_HEADERS(false), `-w '${W}'`,
            "'https://api.github.com/repos/acme/widgets/issues/7/comments?per_page=100'"].join(' '));
        assert.equal(built.payload, undefined, 'a GET carries no body');
        assertCommandHygiene(built);
        assert.deepEqual(built.mapResponse([{ id: 11, body: 'a' }, { id: 12, body: null }, { body: 'no id' }]), [
            { id: '11', body: 'a', ref: { id: 11 } },
            { id: '12', body: '', ref: { id: 12 } },
        ]);
        assert.deepEqual(built.mapResponse({ message: 'not a list' }), []);
    });

    test('update-comment: PATCH .../issues/comments/{id} with the staged { body }; an empty body is allowed', () => {
        const built = buildUpdateCommentCommand({ ...p, pull_request_id: 7, comment_ref: { id: 11 }, body: '', payload_path: POSIX_PAYLOAD_PATH });
        assert.equal(built.command, ['curl -sS -X PATCH', ...GH_HEADERS(true), posixDataBinaryArg(), `-w '${W}'`,
            'https://api.github.com/repos/acme/widgets/issues/comments/11'].join(' '));
        assert.deepEqual(JSON.parse(built.payload.content), { body: '' });
        assertCommandHygiene(built);
    });

    test('delete-comment: DELETE .../issues/comments/{id}, no body', () => {
        const built = buildDeleteCommentCommand({ ...p, pull_request_id: 7, comment_ref: { id: 11 } });
        assert.equal(built.command, ['curl -sS -X DELETE', ...GH_HEADERS(false), `-w '${W}'`,
            'https://api.github.com/repos/acme/widgets/issues/comments/11'].join(' '));
        assert.equal(built.payload, undefined);
        assertCommandHygiene(built);
    });
});

describe('azure-devops PR comment builders (PR threads)', () => {
    const p = { ...PROVIDERS['azure-devops'], token: TOKEN, os: 'linux', pull_request_id: 7 };
    const AUTH = `-u ':${TOKEN}'`;

    test('comment: POST .../threads with one active text comment, body staged', () => {
        const built = buildCommentCommand({ ...p, body: 'chunk 1', payload_path: POSIX_PAYLOAD_PATH });
        assert.equal(built.command, ['curl -sS -X POST', AUTH, "-H 'Content-Type: application/json'", "-H 'Accept: application/json'",
            posixDataBinaryArg(), `-w '${W}'`, `${ADO_BASE}/threads?api-version=7.1`].join(' '));
        assert.deepEqual(JSON.parse(built.payload.content), { comments: [{ parentCommentId: 0, content: 'chunk 1', commentType: 'text' }], status: 'active' });
        assertCommandHygiene(built);
    });

    test('list-comments: GET .../threads; maps each live thread root comment, skipping deleted and system ones', () => {
        const built = buildListCommentsCommand(p);
        assert.equal(built.command, ['curl -sS -X GET', AUTH, "-H 'Accept: application/json'", `-w '${W}'`,
            `'${ADO_BASE}/threads?api-version=7.1'`].join(' '));
        assertCommandHygiene(built);
        const body = {
            value: [
                { id: 3, comments: [{ id: 1, parentCommentId: 0, content: 'engine chunk', commentType: 'text' }, { id: 2, parentCommentId: 1, content: 'a reply' }] },
                { id: 4, isDeleted: true, comments: [{ id: 1, parentCommentId: 0, content: 'gone' }] },
                { id: 5, comments: [{ id: 1, parentCommentId: 0, content: 'voted', commentType: 'system' }] },
                { id: 6, comments: [{ id: 1, parentCommentId: 0, content: 'removed', isDeleted: true }] },
                { id: 7, comments: [] },
            ],
        };
        assert.deepEqual(built.mapResponse(body), [{ id: '3/1', body: 'engine chunk', ref: { threadId: 3, commentId: 1 } }]);
        assert.deepEqual(built.mapResponse(null), []);
    });

    test('update-comment: PATCH .../threads/{t}/comments/{c} with the staged { content }', () => {
        const built = buildUpdateCommentCommand({ ...p, comment_ref: { threadId: 3, commentId: 1 }, body: 'chunk 1 v2', payload_path: POSIX_PAYLOAD_PATH });
        assert.equal(built.command, ['curl -sS -X PATCH', AUTH, "-H 'Content-Type: application/json'", "-H 'Accept: application/json'",
            posixDataBinaryArg(), `-w '${W}'`, `${ADO_BASE}/threads/3/comments/1?api-version=7.1`].join(' '));
        assert.deepEqual(JSON.parse(built.payload.content), { content: 'chunk 1 v2' });
        assertCommandHygiene(built);
    });

    test('delete-comment: DELETE .../threads/{t}/comments/{c}, no body', () => {
        const built = buildDeleteCommentCommand({ ...p, comment_ref: { threadId: 3, commentId: 1 } });
        assert.equal(built.command, ['curl -sS -X DELETE', AUTH, "-H 'Accept: application/json'", `-w '${W}'`,
            `${ADO_BASE}/threads/3/comments/1?api-version=7.1`].join(' '));
        assert.equal(built.payload, undefined);
        assertCommandHygiene(built);
    });
});

describe('bitbucket PR comment builders (PR comments API)', () => {
    const p = { ...PROVIDERS.bitbucket, token: TOKEN, os: 'linux', pull_request_id: 7 };
    const AUTH = `-H 'Authorization: Bearer ${TOKEN}'`;

    test('comment: POST .../comments with the staged { content: { raw } } (new: Bitbucket had no comment builder)', () => {
        const built = buildCommentCommand({ ...p, body: 'chunk 1', payload_path: POSIX_PAYLOAD_PATH });
        assert.equal(built.action, 'comment');
        assert.equal(built.command, ['curl -sS -X POST', AUTH, "-H 'Content-Type: application/json'", "-H 'Accept: application/json'",
            posixDataBinaryArg(), `-w '${W}'`, '-D -', `'${BB_BASE}/comments'`].join(' '));
        assert.deepEqual(JSON.parse(built.payload.content), { content: { raw: 'chunk 1' } });
        assertCommandHygiene(built);
    });

    test('list-comments: GET .../comments with pagelen/fields; skips deleted and inline comments', () => {
        const built = buildListCommentsCommand(p);
        const fields = encodeURIComponent('next,values.id,values.content.raw,values.deleted,values.inline');
        assert.equal(built.command, ['curl -sS -X GET', AUTH, "-H 'Accept: application/json'", `-w '${W}'`, '-D -',
            `'${BB_BASE}/comments?pagelen=100&fields=${fields}'`].join(' '));
        assertCommandHygiene(built);
        const body = { values: [
            { id: 21, content: { raw: 'engine chunk' } },
            { id: 22, content: { raw: 'gone' }, deleted: true },
            { id: 23, content: { raw: 'on a line' }, inline: { path: 'a.js', to: 3 } },
            { id: 'x', content: { raw: 'bad id' } },
        ] };
        assert.deepEqual(built.mapResponse(body), [{ id: '21', body: 'engine chunk', ref: { id: 21 } }]);
    });

    test('update-comment: PUT .../comments/{id} with the staged { content: { raw } }', () => {
        const built = buildUpdateCommentCommand({ ...p, comment_ref: { id: 21 }, body: 'chunk 1 v2', payload_path: POSIX_PAYLOAD_PATH });
        assert.equal(built.command, ['curl -sS -X PUT', AUTH, "-H 'Content-Type: application/json'", "-H 'Accept: application/json'",
            posixDataBinaryArg(), `-w '${W}'`, '-D -', `'${BB_BASE}/comments/21'`].join(' '));
        assert.deepEqual(JSON.parse(built.payload.content), { content: { raw: 'chunk 1 v2' } });
        assertCommandHygiene(built);
    });

    test('delete-comment: DELETE .../comments/{id}, no body', () => {
        const built = buildDeleteCommentCommand({ ...p, comment_ref: { id: 21 } });
        assert.equal(built.command, ['curl -sS -X DELETE', AUTH, "-H 'Accept: application/json'", `-w '${W}'`, '-D -',
            `'${BB_BASE}/comments/21'`].join(' '));
        assert.equal(built.payload, undefined);
        assertCommandHygiene(built);
    });
});

describe('every provider: Windows members, typed errors and the VCSModule surface', () => {
    for (const [name, coords] of Object.entries(PROVIDERS)) {
        const ref = name === 'azure-devops' ? { threadId: 3, commentId: 1 } : { id: 11 };

        test(`${name}: on a Windows PowerShell member every comment builder emits curl.exe and stages the body at the Windows path`, () => {
            const base = { ...coords, token: TOKEN, os: 'windows', shell: 'powershell5', pull_request_id: 7 };
            for (const built of [
                buildCommentCommand({ ...base, body: "it's chunk 1", payload_path: WINDOWS_PAYLOAD_PATH }),
                buildUpdateCommentCommand({ ...base, comment_ref: ref, body: "it's chunk 1", payload_path: WINDOWS_PAYLOAD_PATH }),
            ]) {
                assert.ok(built.command.startsWith('curl.exe '), built.command);
                assert.ok(built.command.includes(`--data-binary '@${WINDOWS_PAYLOAD_PATH}'`), built.command);
                assert.ok(!built.command.includes('chunk'), 'the text never reaches the command line');
            }
            for (const built of [buildListCommentsCommand(base), buildDeleteCommentCommand({ ...base, comment_ref: ref })]) {
                assert.ok(built.command.startsWith('curl.exe '), built.command);
                assert.ok(!built.command.includes('--data-binary'), built.command);
            }
        });

        test(`${name}: a missing payload_path, a non-numeric PR id or a malformed comment_ref is a typed ERROR`, () => {
            const base = { ...coords, token: TOKEN, os: 'linux', pull_request_id: 7 };
            assert.throws(() => buildCommentCommand({ ...base, body: 'x' }), /^Error: ERROR: VCSModule: "payload_path"/);
            assert.throws(() => buildUpdateCommentCommand({ ...base, comment_ref: ref, body: 'x' }), /^Error: ERROR: VCSModule: "payload_path"/);
            assert.throws(() => buildListCommentsCommand({ ...base, pull_request_id: '7; rm' }), /^Error: ERROR: VCSModule: .*pull_request_id/);
            assert.throws(() => buildDeleteCommentCommand({ ...base, comment_ref: { id: '1; rm', threadId: '1; rm', commentId: 1 } }), /^Error: ERROR: VCSModule: .*comment_ref/);
            assert.throws(() => buildUpdateCommentCommand({ ...base, comment_ref: ref, body: undefined, payload_path: POSIX_PAYLOAD_PATH }), /^Error: ERROR: VCSModule: "body"/);
        });
    }

    test('the new actions are on the VCSModule default export, and a classification-only provider fails closed', () => {
        assert.equal(VCSModule.buildListCommentsCommand, buildListCommentsCommand);
        assert.equal(VCSModule.buildUpdateCommentCommand, buildUpdateCommentCommand);
        assert.equal(VCSModule.buildDeleteCommentCommand, buildDeleteCommentCommand);
        assert.throws(() => buildListCommentsCommand({ provider: 'dolt', pull_request_id: 7, token: TOKEN }), /ERROR: VCSModule: provider "dolt" does not yet implement action "list-comments"/);
    });
});
