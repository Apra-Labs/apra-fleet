import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    buildCreatePrCommand,
    buildUpdatePrCommand,
    buildCommentCommand,
    buildListCommentsCommand,
    buildUpdateCommentCommand,
    getProviderTextLimits,
    getVcsProvider,
} from '../fleet-sprint/vcs-module.mjs';
import {
    execVcsWithPayload,
    joinMemberPayloadDir,
    memberPayloadPath,
    resolveVcsPayloadDir,
    VCS_PAYLOAD_SUBDIR,
} from '../fleet-sprint/vcs-payload.mjs';
import { runPublishPrPhase } from '../fleet-sprint/phases/publish-pr.mjs';
import { createStagedFileRecorder } from './helpers/vcs-payload-test.mjs';

// =============================================================================
// Request bodies travel from a member-side FILE, never inline on the command
// line.
//
// A JSON body passed as `curl -d '<json>'` puts the whole PR description on
// the member's command line, where a Windows member caps it (powershell.exe
// via CreateProcess: 32767 chars; cmd.exe over SSH: 8191) long before any
// provider's own limit. Every body-carrying builder now emits
// `curl --data-binary @<path>` and the engine stages the body there with
// send_files, deleting it after the call. Pinned here:
//   (1) every provider's create/update PR and create/list/update comment
//       builder: --data-binary @<path> for a body, and no JSON or body text
//       anywhere on the command line;
//   (2) a mock Windows (PowerShell) member publishes a sprint whose final
//       review is 20k chars: every dispatched command stays far below 8191
//       chars and send_files carries the body;
//   (3) the staged file sits in the engine's own git-excluded staging
//       directory inside the work folder, its path is resolved in JS (no
//       shell expansion), and it is deleted after the call -- even when the
//       call or the staging fails;
//   (4) the per-provider description/comment limits on each descriptor.
//
// ASCII only.
// =============================================================================

const TOKEN = 'TOK-transport';
const BODY = 'Reviewer notes: it\'s "fine" -- see `log` and $(nothing) 100%\nsecond line';
const POSIX_PATH = '/work/repo/.apra-call/vcs-body-0123456789abcdef.json';
const WIN_PATH = 'C:\\work\\repo\\.apra-call\\vcs-body-0123456789abcdef.json';
const WINDOWS_CMD_LIMIT = 8191;

const PROVIDERS = {
    github: { provider: 'github', repo: 'acme/widgets' },
    'azure-devops': { provider: 'azure-devops', repoRef: { org: 'acme', project: 'proj', repo: 'widgets' } },
    bitbucket: { provider: 'bitbucket', repoRef: { workspace: 'acme', repo: 'widgets' } },
};
const TARGETS = [
    { label: 'linux', os: 'linux', shell: '', path: POSIX_PATH },
    { label: 'windows+powershell5', os: 'windows', shell: 'powershell5', path: WIN_PATH },
    { label: 'windows+gitbash', os: 'windows', shell: 'gitbash', path: WIN_PATH },
];

/** No part of the request body -- JSON keys, the text, or any inline -d -- may reach the command line. */
function assertNothingInline(command) {
    assert.ok(!/ -d /.test(command), `no inline -d argument: ${command}`);
    // A JSON object opener -- `{"` or the PowerShell-escaped `{\"` -- never
    // appears (curl's own -w '%{http_code}' is not JSON).
    assert.ok(!/\{\\*"/.test(command), `no JSON on the command line: ${command}`);
    assert.ok(!command.includes('Reviewer notes') && !command.includes('fine'), `no body text on the command line: ${command}`);
}

// -----------------------------------------------------------------------------
// (1) Every body-carrying builder, every provider, every member shell.
// -----------------------------------------------------------------------------
describe('(1) create/update PR and create/list/update comment builders send the body from a file', () => {
    for (const [name, coords] of Object.entries(PROVIDERS)) {
        for (const t of TARGETS) {
            const base = { ...coords, token: TOKEN, os: t.os, shell: t.shell };
            const commentRef = name === 'azure-devops' ? { threadId: 3, commentId: 1 } : { id: 11 };
            const bodyBuilders = {
                'create-pull-request': () => buildCreatePrCommand({ ...base, base: 'main', head: 'feat/x', title: 'T', body: BODY, payload_path: t.path }),
                'update-pull-request': () => buildUpdatePrCommand({ ...base, pull_request_id: 7, title: 'T', body: BODY, payload_path: t.path }),
                comment: () => buildCommentCommand({ ...base, pull_request_id: 7, issue_number: 7, body: BODY, payload_path: t.path }),
                'update-comment': () => buildUpdateCommentCommand({ ...base, pull_request_id: 7, comment_ref: commentRef, body: BODY, payload_path: t.path }),
            };
            for (const [action, build] of Object.entries(bodyBuilders)) {
                test(`${name} ${action} (${t.label}): curl --data-binary @<path>, the staged JSON carries the body`, () => {
                    const built = build();
                    assert.ok(built.command.includes(`--data-binary '@${t.path}'`), built.command);
                    assertNothingInline(built.command);
                    assert.equal(built.payload.path, t.path);
                    assert.ok(JSON.stringify(JSON.parse(built.payload.content)).includes(JSON.stringify(BODY).slice(1, -1)),
                        `the staged JSON carries the body verbatim: ${built.payload.content}`);
                });
            }
            test(`${name} list-comments (${t.label}): a body-less GET, nothing inline`, () => {
                const built = buildListCommentsCommand({ ...base, pull_request_id: 7 });
                assert.ok(/ -X GET /.test(built.command), built.command);
                assert.ok(!built.command.includes('--data-binary'), built.command);
                assert.equal(built.payload, undefined);
                assertNothingInline(built.command);
            });
        }
    }

    test('a body-carrying builder with no payload_path fails closed with a typed ERROR, never falls back to inline', () => {
        for (const coords of Object.values(PROVIDERS)) {
            assert.throws(() => buildCreatePrCommand({ ...coords, token: TOKEN, base: 'main', head: 'x', title: 'T', body: BODY }),
                /^Error: ERROR: VCSModule: "payload_path"/);
        }
    });
});

// -----------------------------------------------------------------------------
// (2) A Windows (PowerShell) member publishes a 20k-char final review.
// -----------------------------------------------------------------------------
const TWENTY_K_NOTES = Array.from({ length: 400 }, (_, i) => `- finding ${String(i).padStart(3, '0')}: ${'reviewer detail '.repeat(2)}ok`)
    .join('\n').padEnd(20000, '.');

function fakeWindowsGitHub() {
    const staged = createStagedFileRecorder();
    const state = { staged, execCommands: [], memberCommands: [], pr: null };
    const respond = (status, body) => ({ content: [{ text: '' }], structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout: `${JSON.stringify(body)}\n${status}`, stderr: '' } });
    state.callTool = async (name, args) => {
        if (name === 'member_detail') {
            return { content: [{ text: JSON.stringify({ vcsProvider: 'github', os: 'windows', shell: 'powershell5', folder: 'C:\\Users\\builder\\work\\widgets' }) }] };
        }
        if (name === 'provision_vcs_auth') return { content: [{ text: 'ok' }], structuredContent: { ok: true, expiresAt: null } };
        if (name === 'credential_store_list') return { content: [{ text: '[]' }] };
        if (name === 'send_files') return staged.record(args);
        if (name === 'vcs_credential_exec') {
            state.execCommands.push(args.command);
            const method = /^curl\.exe -sS -X (\w+)/.exec(args.command)[1];
            assert.equal(method, 'POST');
            const p = staged.json(args.command);
            state.pr = { title: p.title, body: p.body };
            return respond(201, { number: 42, html_url: 'https://github.com/acme/widgets/pull/42' });
        }
        throw new Error(`unexpected tool ${name}`);
    };
    return state;
}

describe('(2) a Windows PowerShell member publishes a 20k-char final review', () => {
    test('Publish PR succeeds, every dispatched command stays far below 8191 chars, and send_files carries the body', async () => {
        assert.equal(TWENTY_K_NOTES.length, 20000);
        const gh = fakeWindowsGitHub();
        const logs = [];
        await runPublishPrPhase({
            phase: () => {},
            log: (m) => logs.push(m),
            command: async (cmd) => {
                gh.memberCommands.push(cmd);
                return cmd === 'git remote get-url origin'
                    ? { ok: true, output: 'https://github.com/acme/widgets.git', error: null }
                    : { ok: true, output: '', error: null };
            },
            args: { callTool: gh.callTool, run_id: 'run-20k' },
            validated: { branch: 'feat/x', baseBranch: 'main', goal: 'Ship X', runId: 'run-20k' },
            targetIssues: [],
            backlogMember: 'win-ps-20k',
            finalCycleLabel: '1',
            gitSync: { pushGitAfter: async () => {}, syncBeadsAfter: async () => {} },
            getMemberForRole: () => 'win-ps-20k',
            finalVerdictResult: { verdict: 'PASS', notes: TWENTY_K_NOTES },
        });

        assert.ok(logs.some((m) => m.includes('opened PR URL') && m.includes('/pull/42')), JSON.stringify(logs));
        assert.equal(gh.execCommands.length, 1);
        // Every member-bound command (the curl plus the engine's constant
        // staging bookkeeping) is independent of the review's size.
        for (const cmd of [...gh.execCommands, ...gh.memberCommands]) {
            assert.ok(cmd.length < WINDOWS_CMD_LIMIT / 2, `a dispatched command must stay far below ${WINDOWS_CMD_LIMIT} chars, got ${cmd.length}: ${cmd.slice(0, 200)}`);
        }
        const create = gh.execCommands[0];
        assert.ok(create.startsWith('curl.exe '), create);
        assert.ok(create.length < 1000, `the create-PR curl is ${create.length} chars`);
        assert.ok(!create.includes('finding 000'), 'the review text never reaches the command line');
        // send_files carried the whole request body the builder produced: the
        // staged JSON is exactly what the provider received, title and body.
        assert.equal(gh.staged.sends.length, 1);
        assert.equal(gh.staged.sends[0].dest_subdir, VCS_PAYLOAD_SUBDIR);
        assert.ok(gh.pr.body.startsWith('## Sprint verdict: PASS'), gh.pr.body.slice(0, 80));
        assert.ok(gh.pr.body.includes('finding 000'), 'the reviewer notes reached the staged body');
        assert.equal(gh.pr.title, 'fleet-sprint [PASS]: feat/x');
    });

    test('transport alone: a 20k body is staged byte-for-byte while the PowerShell command stays short', async () => {
        const staged = createStagedFileRecorder();
        const execs = [];
        const memberCommands = [];
        const built = buildCommentCommand({ ...PROVIDERS.github, issue_number: 7, body: TWENTY_K_NOTES, token: '{{vcs_token_inline}}', os: 'windows', shell: 'powershell5', payload_path: WIN_PATH });
        const res = await execVcsWithPayload({
            fleetApi: {
                sendFiles: async (a) => staged.record(a),
                vcsCredentialExec: async (a) => { execs.push(a); return { content: [{ text: '[OK]' }], structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout: '{}\n201', stderr: '' } }; },
            },
            command: async (cmd) => { memberCommands.push(cmd); return { ok: true, output: '', error: null }; },
            member: 'win-ps',
            label: 'github',
            built,
            target: { os: 'windows', shell: 'powershell5' },
        });
        assert.equal(res.structuredContent.ok, true);
        assert.equal(execs.length, 1);
        assert.equal(execs[0].command, built.command);
        assert.ok(built.command.length < 1000, `command length ${built.command.length}`);
        assert.equal(staged.body(built.command), JSON.stringify({ body: TWENTY_K_NOTES }), 'send_files carried the full body');
        assert.equal(JSON.parse(staged.body(built.command)).body.length, 20000);
    });
});

// -----------------------------------------------------------------------------
// (3) Where the staged file lives, how its path is resolved, and that it is
// always removed after the call.
// -----------------------------------------------------------------------------
describe('(3) the staged body: path resolved in JS, inside the git-excluded staging dir, deleted after the call', () => {
    test('the payload directory is resolved in JS from the absolute work folder, in the member OS path syntax', () => {
        assert.equal(joinMemberPayloadDir('/home/dev/repo', 'linux'), `/home/dev/repo/${VCS_PAYLOAD_SUBDIR}`);
        assert.equal(joinMemberPayloadDir('/home/dev/repo/', 'darwin'), `/home/dev/repo/${VCS_PAYLOAD_SUBDIR}`);
        assert.equal(joinMemberPayloadDir('C:\\Users\\dev\\repo', 'windows'), `C:\\Users\\dev\\repo\\${VCS_PAYLOAD_SUBDIR}`);
        assert.equal(joinMemberPayloadDir('C:/Users/dev/repo', 'windows'), `C:/Users/dev/repo/${VCS_PAYLOAD_SUBDIR}`);
        const { path: p, fileName } = memberPayloadPath(joinMemberPayloadDir('C:\\Users\\dev\\repo', 'windows'));
        assert.match(fileName, /^vcs-body-[0-9a-f]{16}\.json$/);
        assert.equal(p, `C:\\Users\\dev\\repo\\${VCS_PAYLOAD_SUBDIR}\\${fileName}`);
        assert.notEqual(memberPayloadPath('/x').fileName, memberPayloadPath('/x').fileName, 'every request gets its own file');
    });

    test('a relative, home-relative or missing work folder is a loud ERROR, never a shell-expanded guess', async () => {
        for (const [folder, memberOs] of [['~/repo', 'linux'], ['repo', 'linux'], ['$HOME/repo', 'linux'], ['%USERPROFILE%\\repo', 'windows'], ['', 'linux']]) {
            assert.throws(() => joinMemberPayloadDir(folder, memberOs), /^Error: ERROR: VCS payload staging:/, `folder ${JSON.stringify(folder)}`);
        }
        const res = await resolveVcsPayloadDir({ fleetApi: { memberDetail: async () => ({ content: [{ text: JSON.stringify({ os: 'linux' }) }] }) }, member: 'm', memberOs: 'linux' });
        assert.match(res.error, /reports no work folder/);
    });

    function harness({ execImpl, sendImpl } = {}) {
        const calls = [];
        const staged = createStagedFileRecorder();
        const fleetApi = {
            sendFiles: async (a) => { calls.push(['sendFiles', a.dest_subdir]); return sendImpl ? sendImpl(a) : staged.record(a); },
            vcsCredentialExec: async (a) => { calls.push(['exec']); return execImpl ? execImpl(a) : { content: [{ text: '[OK]' }], structuredContent: { ok: true, reason: 'ok', exitCode: 0, stdout: '{}\n200', stderr: '' } }; },
        };
        const command = async (cmd, opts) => { calls.push(['command', cmd, opts && opts.member_name]); return { ok: true, output: '', error: null }; };
        return { calls, staged, fleetApi, command };
    }
    const built = () => buildCreatePrCommand({ ...PROVIDERS.github, base: 'main', head: 'x', title: 'T', body: BODY, token: '{{vcs_token_inline}}', os: 'linux', payload_path: POSIX_PATH });
    const relPath = `${VCS_PAYLOAD_SUBDIR}/${path.basename(POSIX_PATH)}`;

    test('order: git-exclude the staging dir, stage, dispatch, then delete exactly the staged file (work-folder-relative)', async () => {
        const h = harness();
        await execVcsWithPayload({ fleetApi: h.fleetApi, command: h.command, member: 'm1', label: 'github', built: built(), target: { os: 'linux', shell: '' } });
        assert.deepEqual(h.calls.map((c) => c[0]), ['command', 'sendFiles', 'exec', 'command']);
        assert.ok(h.calls[0][1].includes(`'${VCS_PAYLOAD_SUBDIR}/'`) && h.calls[0][1].includes('info/exclude'), h.calls[0][1]);
        assert.equal(h.calls[1][1], VCS_PAYLOAD_SUBDIR);
        assert.equal(h.calls[3][1], `rm -f -- '${relPath}'`);
        assert.ok(h.calls.every((c) => c[0] !== 'command' || c[2] === 'm1'), 'every member command names the member');
    });

    test('the staged file is deleted even when the dispatch throws or send_files fails', async () => {
        const throwing = harness({ execImpl: async () => { throw new Error('transport down'); } });
        await assert.rejects(() => execVcsWithPayload({ fleetApi: throwing.fleetApi, command: throwing.command, member: 'm2', label: 'github', built: built(), target: { os: 'linux', shell: '' } }), /transport down/);
        assert.equal(throwing.calls.at(-1)[1], `rm -f -- '${relPath}'`);

        const failedSend = harness({ sendImpl: async () => ({ isError: true, content: [{ text: 'disk full' }] }) });
        const res = await execVcsWithPayload({ fleetApi: failedSend.fleetApi, command: failedSend.command, member: 'm3', label: 'github', built: built(), target: { os: 'linux', shell: '' } });
        assert.equal(res.structuredContent.ok, false);
        assert.equal(res.structuredContent.reason, 'dispatch_failed', 'a staging failure degrades like a failed dispatch');
        assert.match(res.structuredContent.stderr, /disk full/);
        assert.ok(!failedSend.calls.some((c) => c[0] === 'exec'), 'nothing is dispatched without its body');
        assert.equal(failedSend.calls.at(-1)[1], `rm -f -- '${relPath}'`, 'a partial delivery is still removed');
    });

    test('a fleet client with no send_files fails loudly instead of sending the body inline', async () => {
        const res = await execVcsWithPayload({
            fleetApi: { vcsCredentialExec: async () => { throw new Error('must not dispatch'); } },
            command: async () => ({ ok: true }), member: 'm4', label: 'github', built: built(), target: { os: 'linux', shell: '' },
        });
        assert.equal(res.structuredContent.reason, 'dispatch_failed');
        assert.match(res.structuredContent.stderr, /no send_files tool/);
    });

    test('a PowerShell member deletes the staged file through its own envelope, and the local temp copy is gone', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vcs-transport-test-'));
        try {
            const h = harness();
            const winBuilt = buildCreatePrCommand({ ...PROVIDERS.github, base: 'main', head: 'x', title: 'T', body: BODY, token: '{{vcs_token_inline}}', os: 'windows', shell: 'powershell5', payload_path: WIN_PATH });
            await execVcsWithPayload({ fleetApi: h.fleetApi, command: h.command, member: 'm5', label: 'github', built: winBuilt, target: { os: 'windows', shell: 'powershell5' }, tmpdir: tmp });
            const del = h.calls.at(-1)[1];
            assert.match(del, /^powershell -EncodedCommand /);
            const script = Buffer.from(del.split(' ').pop(), 'base64').toString('utf16le');
            assert.ok(script.includes(`Remove-Item -LiteralPath '${VCS_PAYLOAD_SUBDIR}/${path.basename(WIN_PATH.replace(/\\/g, '/'))}'`), script);
            assert.deepEqual(fs.readdirSync(tmp), [], 'the orchestrator-side temp copy is removed');
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});

// -----------------------------------------------------------------------------
// (4) Per-provider text limits on the descriptors.
// -----------------------------------------------------------------------------
describe('(4) descriptor text limits', () => {
    test('GitHub 60000/60000, Azure DevOps 3500/3500, Bitbucket 3500/3500', () => {
        assert.deepEqual(getProviderTextLimits('github'), { descriptionMaxLength: 60000, commentMaxLength: 60000 });
        assert.deepEqual(getProviderTextLimits('azure-devops'), { descriptionMaxLength: 3500, commentMaxLength: 3500 });
        assert.deepEqual(getProviderTextLimits('bitbucket'), { descriptionMaxLength: 3500, commentMaxLength: 3500 });
        for (const name of ['github', 'azure-devops', 'bitbucket']) {
            const impl = getVcsProvider(name);
            assert.equal(typeof impl.descriptionMaxLength, 'number', `${name} declares descriptionMaxLength on its descriptor`);
            assert.equal(typeof impl.commentMaxLength, 'number', `${name} declares commentMaxLength on its descriptor`);
        }
    });

    test('classification-only providers declare none; an unknown provider is a typed ERROR', () => {
        assert.deepEqual(getProviderTextLimits('generic-git'), { descriptionMaxLength: null, commentMaxLength: null });
        assert.deepEqual(getProviderTextLimits('dolt'), { descriptionMaxLength: null, commentMaxLength: null });
        assert.throws(() => getProviderTextLimits('gitlab'), /^Error: ERROR: VCSModule: unsupported VCS provider "gitlab"/);
    });
});
