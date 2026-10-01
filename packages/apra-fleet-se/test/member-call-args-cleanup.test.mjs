import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemberCall, MemberCallError, MEMBER_CALL_ARGS_DIR } from '../fleet-sprint/member-call.mjs';
import { getSeCommands } from '../fleet-sprint/se-os-commands.mjs';

// Remote memberCall must never leave its args file behind, nor dirty
// `git status`, on the member -- even when the member-side `apra-fleet call`
// verb never runs (no call verb, timeout). The fake remote member here is
// backed by a REAL temp git repo as its work folder: send_files really copies
// the args file into <repo>/.apra-call/, and the engine's exclude/delete
// commands are really executed with bash in <repo>. Only the `apra-fleet call`
// outcome itself is simulated.

const MID = '11111111-2222-4333-8444-555555555555';
const remote = { id: MID, name: 'm-remote', type: 'remote' };
const POSIX = getSeCommands({ os: 'linux', shell: '' });
const PS = getSeCommands({ os: 'windows', shell: 'powershell' });

const isWin = process.platform === 'win32';
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'member-call-args-cleanup-'));
after(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
    assert.equal(fs.existsSync(sandbox), false, 'test sandbox removed');
});

function text(t, isError = false) { return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) }; }

let seq = 0;
/** A fresh real git repo (the member's work folder) plus a local temp root for the engine's own args file. */
function makeMember() {
    const dir = path.join(sandbox, `case-${seq++}`);
    const repo = path.join(dir, 'repo');
    const localTmp = path.join(dir, 'local-tmp');
    fs.mkdirSync(localTmp, { recursive: true });
    const r = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return { dir, repo, localTmp, env: { ...process.env, GIT_CEILING_DIRECTORIES: dir } };
}

function git(repo, args) {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
}

function argsFiles(repo) {
    const d = path.join(repo, MEMBER_CALL_ARGS_DIR);
    return fs.existsSync(d) ? fs.readdirSync(d) : [];
}

function excludeListsArgsDir(repo) {
    const file = path.resolve(repo, git(repo, ['rev-parse', '--git-path', 'info/exclude']).trim());
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').split(/\r?\n/).includes(`${MEMBER_CALL_ARGS_DIR}/`);
}

/**
 * Fake fleetApi for a remote member whose work folder is `m.repo`.
 *   call: 'success' | 'unknown-verb' | 'timeout' -- simulated `apra-fleet call` outcome. None of them
 *         performs the member-side --rm-args-file delete, so only the engine-side cleanup can remove the file.
 *   deleteFails: the engine's delete command is answered with an error and NOT executed.
 */
function fakeFleetApi(m, { call, deleteFails = false }) {
    const events = [];
    return {
        events,
        sendFiles: async (o) => {
            events.push({ op: 'send', excludedAtSend: excludeListsArgsDir(m.repo) });
            const dest = path.join(m.repo, o.dest_subdir);
            fs.mkdirSync(dest, { recursive: true });
            for (const p of o.local_paths) fs.copyFileSync(p, path.join(dest, path.basename(p)));
            return text('sent');
        },
        executeCommand: async (o) => {
            const c = o.command;
            if (c.startsWith('apra-fleet call ')) {
                events.push({ op: 'call' });
                if (call === 'success') return text('{"content":[{"type":"text","text":"ok"}]}');
                if (call === 'unknown-verb') return text("error: unknown option 'call'", true);
                throw new Error('Request timed out');
            }
            const kind = c === POSIX.ensureGitExcluded(`${MEMBER_CALL_ARGS_DIR}/`) ? 'exclude' : c.startsWith('rm -f -- ') ? 'delete' : null;
            assert.ok(kind, `unexpected member command: ${c}`);
            events.push({ op: kind });
            if (kind === 'delete' && deleteFails) return text('rm: simulated failure', true);
            const r = spawnSync('bash', ['-c', c], { cwd: m.repo, env: m.env, encoding: 'utf8' });
            return text(`${r.stdout}${r.stderr}`, r.status !== 0);
        },
    };
}

function makeCall(m, fleetApi, log = () => {}) {
    return createMemberCall({ fleetApi, resolveTarget: async () => ({ os: 'linux', shell: '' }), tmpdir: m.localTmp, log });
}

describe('remote memberCall leaves no args file and a clean git status on the member', { skip: isWin ? 'real-bash member simulation is POSIX-only; skipped on win32 hosts' : false }, () => {
    test('member without the call verb: after memberCall rejects, .apra-call/ holds no files', async () => {
        const m = makeMember();
        const api = fakeFleetApi(m, { call: 'unknown-verb' });
        await assert.rejects(() => makeCall(m, api).memberCall(remote, 'kb_query', { query: 'x' }),
            (e) => e instanceof MemberCallError && /unknown option 'call'/.test(e.message));
        assert.deepEqual(api.events.map(e => e.op), ['exclude', 'send', 'call', 'delete']);
        assert.deepEqual(argsFiles(m.repo), []);
        assert.deepEqual(fs.readdirSync(m.localTmp), [], 'engine-local args temp dir removed');
    });

    test('successful call: no args file remains', async () => {
        const m = makeMember();
        const api = fakeFleetApi(m, { call: 'success' });
        const res = await makeCall(m, api).memberCall(remote, 'kb_query', { query: 'x' });
        assert.equal(res.content[0].text, 'ok');
        assert.deepEqual(argsFiles(m.repo), []);
        assert.deepEqual(fs.readdirSync(m.localTmp), []);
    });

    test('timed-out call (executeCommand throws): no args file remains', async () => {
        const m = makeMember();
        const api = fakeFleetApi(m, { call: 'timeout' });
        await assert.rejects(() => makeCall(m, api).memberCall(remote, 'kb_query', {}), /Request timed out/);
        assert.deepEqual(argsFiles(m.repo), []);
        assert.deepEqual(fs.readdirSync(m.localTmp), []);
    });

    test('.apra-call/ is excluded before the first send; with the delete forced to fail, git status stays clean', async () => {
        const m = makeMember();
        const api = fakeFleetApi(m, { call: 'unknown-verb', deleteFails: true });
        const logs = [];
        await assert.rejects(() => makeCall(m, api, (l) => logs.push(l)).memberCall(remote, 'kb_query', {}), MemberCallError);
        assert.equal(api.events.find(e => e.op === 'send').excludedAtSend, true, '.apra-call/ listed in the exclude file before send_files');
        assert.equal(argsFiles(m.repo).length, 1, 'the delete really failed, so the args file is still there');
        assert.equal(git(m.repo, ['status', '--porcelain', '--untracked-files=all']), '', 'git status --porcelain must be empty');
        assert.ok(logs.some(l => /could not delete args file/.test(l)), 'the failed delete is logged');
    });
});

describe('cleanup commands are built per member shell', () => {
    async function captureCommands(target) {
        const cmds = [];
        const localTmp = fs.mkdtempSync(path.join(sandbox, 'shape-'));
        const mc = createMemberCall({
            fleetApi: { sendFiles: async () => text('sent'), executeCommand: async (o) => { cmds.push(o.command); return text('{"content":[]}'); } },
            resolveTarget: async () => target,
            tmpdir: localTmp,
        });
        await mc.memberCall(remote, 'version', {});
        assert.equal(cmds.length, 3, 'exclude, call, delete');
        return cmds;
    }
    const decode = (c) => {
        const m = /^powershell -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(c);
        assert.ok(m, `expected a PowerShell -EncodedCommand envelope: ${c}`);
        return Buffer.from(m[1], 'base64').toString('utf16le');
    };
    const noMemberEnv = (s) => {
        for (const bad of ['$env:', '$HOME', '~/', String.fromCharCode(96)]) assert.ok(!s.includes(bad), `no ${bad} in ${s}`);
    };

    test('bash member: exclude and delete are plain strings', async () => {
        const [exclude, call, del] = await captureCommands({ os: 'linux', shell: '' });
        assert.equal(exclude, POSIX.ensureGitExcluded('.apra-call/'));
        assert.ok(exclude.startsWith('if excl=$(git rev-parse --git-path info/exclude'), exclude);
        const argsPath = /--args-file (\S+)/.exec(call)[1];
        assert.equal(del, `rm -f -- '${argsPath}'`);
        noMemberEnv(exclude);
        noMemberEnv(del);
    });

    test('PowerShell member: exclude and delete are -EncodedCommand envelopes holding the PowerShell scripts', async () => {
        const [exclude, call, del] = await captureCommands({ os: 'windows', shell: 'powershell' });
        const ex = decode(exclude);
        assert.ok(ex.includes('git rev-parse --git-path info/exclude') && ex.includes("Add-Content -LiteralPath $excl"), ex);
        assert.ok(ex.includes("'.apra-call/'"), ex);
        const argsPath = /--args-file (\S+)/.exec(decode(call))[1];
        const rm = decode(del);
        assert.ok(rm.includes(`Remove-Item -LiteralPath '${argsPath}' -Force`), rm);
        assert.equal(del, PS.removeFile(argsPath));
        noMemberEnv(ex);
        noMemberEnv(rm);
    });
});
