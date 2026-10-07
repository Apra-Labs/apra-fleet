import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemberCall, buildRemoteCallCommand, MemberCallError } from '../fleet-sprint/member-call.mjs';
import { getSeCommands } from '../fleet-sprint/se-os-commands.mjs';

const POSIX = getSeCommands({ os: 'linux', shell: '' });

const MID = '11111111-2222-4333-8444-555555555555';
const local = { id: MID, name: 'm-local', type: 'local' };
const remote = { id: MID, name: 'm-remote', type: 'remote' };
const relay = { id: MID, name: 'm-relay', type: 'relay' };

function text(t, isError = false) { return { content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) }; }

function makeFleetApi(order, { execText = '{"content":[{"type":"text","text":"ok"}]}', execError = false } = {}) {
    return {
        sendFiles: async (o) => { order.push({ op: 'send_files', o, content: fs.readFileSync(o.local_paths[0], 'utf8') }); return text('sent'); },
        executeCommand: async (o) => { order.push({ op: 'execute_command', o }); return text(execText, execError); },
    };
}

const tmpBefore = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('member-call-')).length;

describe('memberCall local adapter', () => {
    test('opens an in-process MEMBER session and spawns no process / no remote calls', async () => {
        const calls = [];
        let stopped = false;
        const order = [];
        const mc = createMemberCall({
            fleetApi: makeFleetApi(order),
            connectLocal: async (id) => {
                calls.push(['connect', id]);
                return {
                    mcpClient: { callTool: async (t, a) => { calls.push(['callTool', t, a]); return text('{"ok":1}'); }, listTools: async () => ({ tools: [] }) },
                    close: async () => { stopped = true; },
                };
            },
        });
        const res = await mc.memberCall(local, 'kb_query', { query: 'x' });
        assert.deepStrictEqual(calls, [['connect', MID], ['callTool', 'kb_query', { query: 'x' }]]);
        assert.deepStrictEqual(order, [], 'no send_files/execute_command (nothing spawned) for a local member');
        assert.strictEqual(stopped, true);
        assert.strictEqual(res.content[0].text, '{"ok":1}');
    });

    test('releases the server session via close() even when the call throws', async () => {
        let closed = 0;
        const mc = createMemberCall({ connectLocal: async () => ({
            mcpClient: { callTool: async () => { throw new Error('boom'); } },
            close: async () => { closed++; },
            transport: { stop: () => { throw new Error('stop must not be used when close exists'); } },
        }) });
        await assert.rejects(() => mc.memberCall(local, 'version', {}), /boom/);
        assert.strictEqual(closed, 1);
    });

    test('a 403 on connect is a typed E-MEMBER-FORBIDDEN error', async () => {
        const mc = createMemberCall({ connectLocal: async () => { const e = new Error('x'); e.status = 403; throw e; } });
        await assert.rejects(() => mc.memberCall(local, 'version', {}), (e) => e instanceof MemberCallError && e.code === 'E-MEMBER-FORBIDDEN');
    });

    test('a tool isError result becomes a typed E-TOOL error', async () => {
        const mc = createMemberCall({ connectLocal: async () => ({ mcpClient: { callTool: async () => text('bad args', true) } }) });
        await assert.rejects(() => mc.memberCall(local, 'kb_query', {}), (e) => e.code === 'E-TOOL' && /bad args/.test(e.message));
    });

    test('listTools uses an in-process member session', async () => {
        const seen = [];
        const mc = createMemberCall({ connectLocal: async (id) => { seen.push(id); return { mcpClient: { listTools: async () => ({ tools: [{ name: 'version' }] }) } }; } });
        assert.deepStrictEqual(await mc.listTools(local), { tools: [{ name: 'version' }] });
        assert.deepStrictEqual(seen, [MID]);
    });
});

describe('memberCall remote/relay adapter', () => {
    for (const member of [remote, relay]) {
        test(`${member.type}: send_files delivers the args file, THEN execute_command runs apra-fleet call`, async () => {
            const order = [];
            const before = tmpBefore();
            const mc = createMemberCall({
                fleetApi: makeFleetApi(order),
                resolveTarget: async () => ({ os: 'linux', shell: '' }),
                connectLocal: async () => { throw new Error('local adapter must not be used'); },
            });
            const res = await mc.memberCall(member, 'kb_query', { query: 'hello' });
            assert.deepStrictEqual(order.map(o => o.op), ['execute_command', 'send_files', 'execute_command', 'execute_command']);
            assert.strictEqual(order[0].o.command, POSIX.ensureGitExcluded('.apra-call/'), 'exclude command first');
            assert.deepStrictEqual(JSON.parse(order[1].content), { query: 'hello' });
            assert.strictEqual(order[1].o.dest_subdir, '.apra-call');
            const fileName = path.basename(order[1].o.local_paths[0]);
            assert.strictEqual(order[2].o.command, `apra-fleet call --member ${MID} kb_query --args-file .apra-call/${fileName} --rm-args-file`);
            assert.strictEqual(order[3].o.command, `rm -f -- '.apra-call/${fileName}'`, 'engine-side delete of the same args path last');
            assert.strictEqual(res.content[0].text, 'ok');
            assert.strictEqual(tmpBefore(), before, 'local temp args dir cleaned up');
        });
    }

    test('remote args file is deleted by the member-side verb (--rm-args-file), on success and on a failed call', async () => {
        for (const fail of [false, true]) {
            const order = [];
            const mc = createMemberCall({
                fleetApi: makeFleetApi(order, fail ? { execText: '{"error":{"code":"E-TOOL","message":"bad"}}', execError: true } : {}),
                resolveTarget: async () => ({ os: 'linux', shell: '' }),
            });
            await mc.memberCall(remote, 'version', {}).catch(() => {});
            assert.match(order[2].o.command, / --rm-args-file$/);
        }
        const ps = buildRemoteCallCommand({ os: 'windows', shell: '' }, { memberId: MID, tool: 'version', argsPath: '.apra-call/c.json' });
        assert.ok(Buffer.from(ps.split(' ')[2], 'base64').toString('utf16le').includes('--rm-args-file'));
    });

    test('typed error from the remote call output is surfaced', async () => {
        const mc = createMemberCall({
            fleetApi: makeFleetApi([], { execText: 'noise\n{"error":{"code":"E-TOOL","message":"Input validation error"}}', execError: true }),
            resolveTarget: async () => ({ os: 'linux', shell: '' }),
        });
        await assert.rejects(() => mc.memberCall(remote, 'kb_query', { query: 1 }), (e) => e.code === 'E-TOOL' && /validation/.test(e.message));
    });

    test('listTools on a remote member runs --list-tools with no file delivery', async () => {
        const order = [];
        const mc = createMemberCall({
            fleetApi: makeFleetApi(order, { execText: '{"tools":[{"name":"version"}]}' }),
            resolveTarget: async () => ({ os: 'linux', shell: '' }),
        });
        const res = await mc.listTools(remote);
        assert.deepStrictEqual(order.map(o => o.op), ['execute_command']);
        assert.strictEqual(order[0].o.command, `apra-fleet call --member ${MID} --list-tools`);
        assert.deepStrictEqual(res.tools, [{ name: 'version' }]);
    });
});

describe('memberCall remote engine-side args-file cleanup', () => {
    const isExclude = (c) => c === POSIX.ensureGitExcluded('.apra-call/');
    const isDelete = (c) => c.startsWith('rm -f -- ');
    const isCall = (c) => c.startsWith('apra-fleet call ');

    /** Fake fleetApi with a per-op call log; `callOutcome` decides the apra-fleet call result. */
    function cleanupApi(log, { callOutcome, deleteFails = false, excludeFails = false, sendFails = false } = {}) {
        return {
            sendFiles: async (o) => {
                log.push({ op: 'send', path: `.apra-call/${path.basename(o.local_paths[0])}` });
                if (sendFails === 'throw') throw new Error('send transport down');
                return sendFails ? text('send_files failed', true) : text('sent');
            },
            executeCommand: async (o) => {
                const c = o.command;
                if (isExclude(c)) { log.push({ op: 'exclude' }); if (excludeFails) throw new Error('exclude boom'); return text(''); }
                if (isDelete(c)) { log.push({ op: 'delete', path: /'(.*)'/.exec(c)[1] }); if (deleteFails === 'throw') throw new Error('delete boom'); return deleteFails ? text('rm failed', true) : text(''); }
                if (c.includes('--list-tools')) { log.push({ op: 'list' }); return text('{"tools":[]}'); }
                if (isCall(c)) { log.push({ op: 'call', path: /--args-file (\S+)/.exec(c)?.[1] ?? null }); return callOutcome(); }
                throw new Error(`unexpected command ${c}`);
            },
        };
    }
    const resolveTarget = async () => ({ os: 'linux', shell: '' });
    const outcomes = {
        success: () => text('{"content":[{"type":"text","text":"ok"}]}'),
        'unknown call verb (non-JSON error)': () => text("error: unknown option 'call'", true),
        'isError with typed JSON': () => text('{"error":{"code":"E-TOOL","message":"bad"}}', true),
        'thrown timeout': () => { throw new Error('Request timed out'); },
    };

    for (const [name, callOutcome] of Object.entries(outcomes)) {
        test(`order exclude -> send -> call -> delete(same argsPath) on ${name}`, async () => {
            const log = [];
            const mc = createMemberCall({ fleetApi: cleanupApi(log, { callOutcome }), resolveTarget });
            await mc.memberCall(remote, 'version', {}).catch(() => {});
            assert.deepStrictEqual(log.map(e => e.op), ['exclude', 'send', 'call', 'delete']);
            assert.strictEqual(log[2].path, log[1].path);
            assert.strictEqual(log[3].path, log[1].path);
        });
    }

    test('the caller sees the original typed error / result even when the delete fails (isError or throw)', async () => {
        for (const deleteFails of [true, 'throw']) {
            const msgs = [];
            let mc = createMemberCall({ fleetApi: cleanupApi([], { callOutcome: outcomes['unknown call verb (non-JSON error)'], deleteFails }), resolveTarget, log: (m) => msgs.push(m) });
            await assert.rejects(() => mc.memberCall(remote, 'version', {}), (e) => e instanceof MemberCallError && e.code === 'E-REMOTE' && /unknown option 'call'/.test(e.message));
            assert.ok(msgs.some(m => /could not delete args file \.apra-call\/call-/.test(m)), 'delete failure is logged');

            mc = createMemberCall({ fleetApi: cleanupApi([], { callOutcome: outcomes['isError with typed JSON'], deleteFails }), resolveTarget });
            await assert.rejects(() => mc.memberCall(remote, 'version', {}), (e) => e instanceof MemberCallError && e.code === 'E-TOOL');

            mc = createMemberCall({ fleetApi: cleanupApi([], { callOutcome: outcomes['thrown timeout'], deleteFails }), resolveTarget });
            await assert.rejects(() => mc.memberCall(remote, 'version', {}), /Request timed out/);

            mc = createMemberCall({ fleetApi: cleanupApi([], { callOutcome: outcomes.success, deleteFails }), resolveTarget });
            assert.strictEqual((await mc.memberCall(remote, 'version', {})).content[0].text, 'ok');
        }
    });

    test('exclude runs only before the first call to a member (per instance); listTools issues no exclude/delete', async () => {
        const log = [];
        const mc = createMemberCall({ fleetApi: cleanupApi(log, { callOutcome: outcomes.success }), resolveTarget });
        await mc.listTools(remote);
        assert.deepStrictEqual(log.map(e => e.op), ['list']);
        await mc.memberCall(remote, 'version', {});
        await mc.memberCall(remote, 'version', {});
        await mc.listTools(remote);
        assert.deepStrictEqual(log.map(e => e.op), ['list', 'exclude', 'send', 'call', 'delete', 'send', 'call', 'delete', 'list']);
        const other = { ...remote, id: '99999999-2222-4333-8444-555555555555', name: 'm-other' };
        log.length = 0;
        await mc.memberCall(other, 'version', {});
        assert.deepStrictEqual(log.map(e => e.op), ['exclude', 'send', 'call', 'delete'], 'a different member gets its own exclude');
    });

    test('an exclude failure is logged loudly, does not break the call, and is retried next call', async () => {
        const log = [];
        const msgs = [];
        const mc = createMemberCall({ fleetApi: cleanupApi(log, { callOutcome: outcomes.success, excludeFails: true }), resolveTarget, log: (m) => msgs.push(m) });
        assert.strictEqual((await mc.memberCall(remote, 'version', {})).content[0].text, 'ok');
        await mc.memberCall(remote, 'version', {});
        assert.deepStrictEqual(log.map(e => e.op), ['exclude', 'send', 'call', 'delete', 'exclude', 'send', 'call', 'delete']);
        assert.ok(msgs.some(m => /WARNING: could not add \.apra-call\/ to the git exclude file/.test(m)), msgs.join('\n'));
    });

    test('a failed send_files (isError or thrown) still attempts the delete and surfaces the send error', async () => {
        for (const sendFails of [true, 'throw']) {
            const log = [];
            const mc = createMemberCall({ fleetApi: cleanupApi(log, { callOutcome: outcomes.success, sendFails }), resolveTarget });
            await assert.rejects(() => mc.memberCall(remote, 'version', {}), sendFails === true ? (e) => e.code === 'E-SEND-FILES' : /send transport down/);
            assert.deepStrictEqual(log.map(e => e.op), ['exclude', 'send', 'delete']);
            assert.strictEqual(log[2].path, log[1].path);
        }
    });

    test('cleanup commands follow the member dialect (PowerShell member gets -EncodedCommand envelopes)', async () => {
        const cmds = [];
        const mc = createMemberCall({
            fleetApi: { sendFiles: async () => text('sent'), executeCommand: async (o) => { cmds.push(o.command); return text('{"content":[]}'); } },
            resolveTarget: async () => ({ os: 'windows', shell: 'powershell' }),
        });
        await mc.memberCall(remote, 'version', {});
        const ps = getSeCommands({ os: 'windows', shell: 'powershell' });
        assert.strictEqual(cmds.length, 3);
        assert.strictEqual(cmds[0], ps.ensureGitExcluded('.apra-call/'));
        const argsPath = /--args-file (\S+)/.exec(Buffer.from(cmds[1].split(' ')[2], 'base64').toString('utf16le'))[1];
        assert.strictEqual(cmds[2], ps.removeFile(argsPath));
    });
});

describe('remote command shape per shell', () => {
    const spec = { memberId: MID, tool: 'kb_query', argsPath: '.apra-call/call-ab12.json' };

    test('bash member: plain command, no wrapper, no shell expansion', () => {
        const cmd = buildRemoteCallCommand({ os: 'linux', shell: '' }, spec);
        assert.strictEqual(cmd, `apra-fleet call --member ${MID} kb_query --args-file .apra-call/call-ab12.json --rm-args-file`);
        assert.ok(!/[$`~]/.test(cmd), 'no $VAR, backtick or ~ expansion');
        assert.strictEqual(buildRemoteCallCommand({ os: 'windows', shell: 'gitbash' }, spec), cmd);
    });

    test('PowerShell member: -EncodedCommand envelope holding the same plain script', () => {
        const cmd = buildRemoteCallCommand({ os: 'windows', shell: '' }, spec);
        assert.match(cmd, /^powershell -EncodedCommand [A-Za-z0-9+/=]+$/);
        const decoded = Buffer.from(cmd.split(' ')[2], 'base64').toString('utf16le');
        assert.ok(decoded.includes(`apra-fleet call --member ${MID} kb_query --args-file .apra-call/call-ab12.json --rm-args-file`));
        assert.ok(!/\$env:|\$HOME|~\//.test(decoded.replace(/\$ErrorActionPreference|\$LASTEXITCODE|\$_/g, '')), 'no member-side expansion in the script');
    });

    test('unsafe tool name / member id / path are refused rather than interpolated', () => {
        assert.throws(() => buildRemoteCallCommand({ os: 'linux' }, { ...spec, tool: 'x; rm -rf /' }), MemberCallError);
        assert.throws(() => buildRemoteCallCommand({ os: 'linux' }, { ...spec, memberId: '$HOME' }), MemberCallError);
        assert.throws(() => buildRemoteCallCommand({ os: 'linux' }, { ...spec, argsPath: '$HOME/a.json' }), MemberCallError);
    });
});

describe('memberCall kb_maintainer grant', () => {
    test('local: the grant reaches connectLocal only when asked', async () => {
        const seen = [];
        const mc = createMemberCall({
            connectLocal: async (id, opts) => {
                seen.push([id, opts]);
                return { mcpClient: { callTool: async () => text('{"ok":1}') }, close: async () => {} };
            },
        });
        await mc.memberCall(local, 'kb_query', { query: 'x' });
        await mc.memberCall(local, 'kb_promote', { id: 'e1', reason: 'r' }, { kbMaintainer: true });
        await mc.memberCall(local, 'kb_promote', { id: 'e1', reason: 'r' }, { kbMaintainer: 'yes' });
        assert.deepStrictEqual(seen, [
            [MID, { kbMaintainer: false }],
            [MID, { kbMaintainer: true }],
            [MID, { kbMaintainer: false }],
        ]);
    });

    test('remote: the grant adds --kb-maintainer to the apra-fleet call command, and only then', async () => {
        for (const grant of [false, true]) {
            const order = [];
            const mc = createMemberCall({
                fleetApi: makeFleetApi(order),
                resolveTarget: async () => ({ os: 'linux', shell: '' }),
            });
            await mc.memberCall(remote, 'kb_promote', { id: 'e1', reason: 'r' }, grant ? { kbMaintainer: true } : undefined);
            const fileName = path.basename(order[1].o.local_paths[0]);
            const flag = grant ? ' --kb-maintainer' : '';
            assert.strictEqual(order[2].o.command, `apra-fleet call --member ${MID}${flag} kb_promote --args-file .apra-call/${fileName} --rm-args-file`);
        }
        const ps = buildRemoteCallCommand({ os: 'windows', shell: '' }, { memberId: MID, tool: 'kb_promote', argsPath: '.apra-call/c.json', kbMaintainer: true });
        assert.ok(Buffer.from(ps.split(' ')[2], 'base64').toString('utf16le').includes(`--member ${MID} --kb-maintainer kb_promote`));
    });
});
