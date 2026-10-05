// =============================================================================
// A FAKE apra-fleet HTTP server for real-process supervisor tests
// =============================================================================
//
// WHY THIS EXISTS: since the supervisor ensures its own LLM-less backlog
// member (backlog-member.mjs) and refreshes its beads view through that
// member (beads-view.mjs), POST /api/sprints answers 503 unless a fleet
// server is reachable: it lists members, registers/adopts the backlog
// member, and runs the backlog member's tip-checked D-pull over
// execute_command. Tests that spawn the REAL bin/serve.mjs as a child process
// cannot inject collaborators, so they need a fleet server on the wire. This
// is that server, as small as the supervisor's actual use of it -- never a
// bypass of the backlog pin: the supervisor runs its production code path
// against it end to end.
//
// What it serves (everything the supervisor's own code paths call):
//   - GET  /health                          -> 200 (checkRunningInstance)
//   - POST /mcp initialize                  -> mcp-session-id header
//   - GET  /mcp                             -> a silent SSE keepalive stream
//   - POST /mcp tools/call:
//       list_members (format json)          -> { members: [...] }
//       register_member / update_member     -> mutate the in-memory registry
//       execute_command                     -> the command table below
//     any other tool                        -> isError "unknown tool"
//   - POST/DELETE /api/workflow-packages/*  -> 200 (registration convergence)
//
// execute_command answers (first match wins; `commands` option entries are
// tried before the defaults), always in the real server's shape: text
// `Exit code: N\n<stdout>` plus structuredContent { exitCode, stdout, stderr }:
//   - `bd config get sync.remote --json`    -> { value: <syncRemote> }
//   - `git ... ls-remote <url> refs/dolt/data` -> `<tipSha>\trefs/dolt/data`
//   - `bd dolt pull`                        -> exit 0
//   - anything else                         -> exit 0, empty output
// A member that is not registered gets the real server's refusal text
// (`Member "<x>" not found.`), with no exit code.
//
// Discovery is the product's own: start() writes <dataDir>/server.json
// ({ pid, port, url }) -- the file resolveFleetServerConnection() reads from
// APRA_FLEET_DATA_DIR. pid is THIS (test) process, which is alive for the
// fake's whole life. stop() closes every socket and removes server.json.
//
// Every call is recorded in `calls` ({ tool, args }) so a test can assert the
// supervisor really went through the fleet (e.g. that the backlog member was
// registered with llm_provider none).
//
// ASCII only.
// =============================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

/** Default remote-tip SHA the fake reports for refs/dolt/data. */
export const FAKE_DOLT_TIP = '0123456789abcdef0123456789abcdef01234567';
/** Default bd-level sync.remote the fake reports for every member. */
export const FAKE_SYNC_REMOTE = 'https://example.invalid/fake-beads.git';

function commandReply({ exitCode = 0, stdout = '', stderr = '' } = {}) {
    return {
        content: [{ type: 'text', text: `Exit code: ${exitCode}\n${stdout}${stderr ? `\n${stderr}` : ''}` }],
        structuredContent: { exitCode, stdout, stderr },
    };
}

function textReply(text, isError = false) {
    return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

/**
 * @param {{
 *   dataDir: string,
 *   members?: Array<object>,
 *   syncRemote?: string,
 *   tipSha?: string,
 *   commands?: Array<{ match: RegExp, reply: (cmd: string, member: object) => { exitCode?: number, stdout?: string, stderr?: string } }>,
 * }} opts
 */
export async function startFakeFleet(opts = {}) {
    const { dataDir } = opts;
    if (!dataDir) throw new TypeError('startFakeFleet requires the APRA_FLEET_DATA_DIR it serves (opts.dataDir)');
    const members = (opts.members ?? []).map((m) => ({ ...m }));
    const syncRemote = opts.syncRemote ?? FAKE_SYNC_REMOTE;
    const tipSha = opts.tipSha ?? FAKE_DOLT_TIP;
    const commandTable = [
        ...(opts.commands ?? []),
        { match: /^bd config get sync\.remote --json$/, reply: () => ({ stdout: `${JSON.stringify({ key: 'sync.remote', value: syncRemote })}\n` }) },
        { match: /\bls-remote\b.*\brefs\/dolt\/data\b/, reply: () => ({ stdout: `${tipSha}\trefs/dolt/data\n` }) },
        { match: /^bd dolt pull\b/, reply: () => ({ stdout: 'Pulled.\n' }) },
        { match: /[\s\S]*/, reply: () => ({}) },
    ];
    /** @type {Array<{ tool: string, args: object }>} */
    const calls = [];
    const sockets = new Set();
    const streams = new Set();
    let sessionSeq = 0;

    function findMember(args) {
        if (!args) return undefined;
        if (args.member_id) return members.find((m) => m.id === args.member_id);
        return members.find((m) => m.name === args.member_name);
    }

    function callTool(name, args = {}) {
        calls.push({ tool: name, args });
        switch (name) {
            case 'list_members':
                return textReply(JSON.stringify({ members }));
            case 'register_member': {
                if (members.some((m) => m.name === args.friendly_name)) {
                    return textReply(`❌ A member named "${args.friendly_name}" already exists.`);
                }
                const member = {
                    id: `fake-${members.length + 1}`,
                    name: args.friendly_name,
                    type: args.member_type ?? 'local',
                    folder: args.work_folder,
                    llmProvider: args.llm_provider ?? 'claude',
                    unreservable: args.unreservable === true,
                    tags: Array.isArray(args.tags) ? [...args.tags] : [],
                };
                members.push(member);
                return textReply(`Member "${member.name}" registered.`);
            }
            case 'update_member': {
                const member = findMember(args);
                if (!member) return textReply(`❌ Member "${args.member_name ?? args.member_id}" not found.`);
                if (Array.isArray(args.tags)) member.tags = [...args.tags];
                if (typeof args.unreservable === 'boolean') member.unreservable = args.unreservable;
                if (typeof args.llm_provider === 'string') member.llmProvider = args.llm_provider;
                return textReply(`Member "${member.name}" updated.`);
            }
            case 'execute_command': {
                const member = findMember(args);
                if (!member) return textReply(`Member "${args.member_name ?? args.member_id}" not found.`);
                const cmd = String(args.command ?? '');
                const entry = commandTable.find((e) => e.match.test(cmd));
                return commandReply(entry.reply(cmd, member));
            }
            default:
                return textReply(`unknown tool: ${name}`, true);
        }
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === '/health') {
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'ok', fake: true }));
            return;
        }
        if (url.pathname.startsWith('/api/workflow-packages/')) {
            req.resume();
            calls.push({ tool: `${req.method} ${url.pathname}`, args: {} });
            res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
            return;
        }
        if (url.pathname !== '/mcp') {
            req.resume();
            res.writeHead(404).end();
            return;
        }
        if (req.method === 'GET') {
            // Silent keepalive stream; responses travel on each POST's own SSE body.
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
            streams.add(res);
            res.on('close', () => streams.delete(res));
            return;
        }
        if (req.method === 'DELETE') {
            res.writeHead(200).end();
            return;
        }
        let body = '';
        for await (const chunk of req) body += chunk;
        let msg;
        try {
            msg = JSON.parse(body);
        } catch {
            res.writeHead(400).end();
            return;
        }
        if (msg.method === 'initialize') {
            sessionSeq += 1;
            res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': `fake-session-${sessionSeq}` })
                .end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-apra-fleet', version: '0.0.0' } } }));
            return;
        }
        if (msg.id === undefined || msg.id === null) {
            res.writeHead(202).end(); // a notification
            return;
        }
        let result;
        if (msg.method === 'tools/call') result = callTool(msg.params?.name, msg.params?.arguments ?? {});
        else if (msg.method === 'tools/list') result = { tools: [] };
        else result = {};
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n\n`);
        res.end();
    });
    server.on('connection', (s) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/mcp`;
    const serverJson = path.join(dataDir, 'server.json');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(serverJson, `${JSON.stringify({ pid: process.pid, port, url }, null, 2)}\n`, 'utf-8');

    async function stop() {
        try { fs.rmSync(serverJson, { force: true }); } catch { /* best-effort */ }
        for (const s of streams) { try { s.end(); } catch { /* ignore */ } }
        for (const s of sockets) { try { s.destroy(); } catch { /* ignore */ } }
        await new Promise((resolve) => server.close(() => resolve()));
    }

    return { port, url, members, calls, stop };
}

/**
 * Make `projectDir` a beads project as the supervisor's discovery sees one:
 * a `.beads` directory holding bd init's metadata.json (isProjectBeadsDir).
 * Returns the .beads path.
 */
export function writeProjectBeadsDir(projectDir) {
    const beadsDir = path.join(projectDir, '.beads');
    fs.mkdirSync(beadsDir, { recursive: true });
    fs.writeFileSync(path.join(beadsDir, 'metadata.json'), `${JSON.stringify({ database: 'beads.db' }, null, 2)}\n`, 'utf-8');
    return beadsDir;
}
