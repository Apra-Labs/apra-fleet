import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemberCall, buildRemoteCallCommand, MemberCallError } from '../fleet-sprint/member-call.mjs';

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
            assert.deepStrictEqual(order.map(o => o.op), ['send_files', 'execute_command']);
            assert.deepStrictEqual(JSON.parse(order[0].content), { query: 'hello' });
            assert.strictEqual(order[0].o.dest_subdir, '.apra-call');
            const fileName = path.basename(order[0].o.local_paths[0]);
            assert.strictEqual(order[1].o.command, `apra-fleet call --member ${MID} kb_query --args-file .apra-call/${fileName} --rm-args-file`);
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
            assert.match(order[1].o.command, / --rm-args-file$/);
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
