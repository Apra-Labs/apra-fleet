#!/usr/bin/env node
// =============================================================================
// Real per-sprint "viewer" child fixture for supervisor-dashboard-integration
// (apra-fleet-eft.6.6)
// =============================================================================
//
// A REAL OS process standing in for the detached bin/cli.mjs sprint child's
// HTTP viewer surface (GET /, GET /events SSE, GET /state, POST /stop), so the
// dashboard integration suite can exercise the live proxy (eft.6.4) and its
// history fallthrough (eft.6.5) against a genuine running child rather than an
// in-test http.createServer. It deliberately does NOT run any real
// fleet/beads/git machinery -- it only reproduces the endpoints the proxy and
// watchdog key off, plus a test-only /finish endpoint that lets the harness
// tell it which sprintId to record itself as (the supervisor generates the
// sprintId AFTER spawning, so the child cannot know it up front).
//
// Launched via src/supervisor/spawner.mjs's REAL createSpawner().spawnSprint()
// (this fixture stands in for bin/cli.mjs via injected `command`/`cliPath`
// deps), so it receives buildSprintArgv()'s real flags -- only --viewer-port is
// used here; --issue/--members/--branch/--base/--goal are accepted and ignored.
//
// Endpoints:
//   GET  /               HTML referencing /events, /state, /stop via absolute
//                        app-paths, exactly like the real viewer -- so the live
//                        proxy's rewriteChildHtml() has something to rewrite.
//   GET  /events         SSE: writes one event immediately, a second after a
//                        short delay -- proves incremental (non-buffered)
//                        delivery through the supervisor's proxy.
//   GET  /state          JSON state blob (also the watchdog's HTTP-reachability
//                        probe target).
//   POST /finish         Body: { sprintId, state? }. Writes a terminal state
//                        file to <APRA_FLEET_DATA_DIR>/old_sprints/<sprintId>.json
//                        (the eft.2.3 layout the watchdog + history-view read),
//                        responds 200, then exits the process shortly after (so
//                        the response has time to flush) -- modeling a sprint
//                        completing.
//
// Protocol: no stdout READY line -- spawner.spawnSprint() runs children with
// stdio:'ignore', so the harness polls GET /state on the returned port instead.
// =============================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

function argVal(flag, dflt) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

const viewerPort = Number(argVal('--viewer-port', '0'));
const dataDir = process.env.APRA_FLEET_DATA_DIR || '';

function readBody(req) {
    return new Promise((resolve, reject) => {
        let buf = '';
        req.on('data', (c) => { buf += c.toString('utf-8'); });
        req.on('end', () => resolve(buf));
        req.on('error', reject);
    });
}

function defaultTerminalState() {
    return {
        workflowName: 'itest sprint',
        status: 'success',
        verdict: 'PASS',
        startedAt: new Date(0).toISOString(),
        endedAt: new Date().toISOString(),
        stats: {
            activitiesCount: 1,
            totalTokens: 1,
            totalCost: 0,
            unknownCostCount: 0,
            startTime: 0,
            durationMs: 1,
        },
        tree: [],
        extensions: {},
    };
}

const server = http.createServer(async (req, res) => {
    try {
        if (req.method === 'GET' && req.url === '/') {
            const body = "<html><body><script>new EventSource('/events');" +
                "fetch('/state?_t=1');fetch('/stop',{method:'POST'});</script></body></html>";
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(body);
            return;
        }

        if (req.method === 'GET' && req.url === '/events') {
            res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
            });
            if (typeof res.flushHeaders === 'function') res.flushHeaders();
            res.write('data: one\n\n');
            const t = setTimeout(() => {
                try { res.write('data: two\n\n'); } catch { /* client gone */ }
            }, 150);
            req.on('close', () => clearTimeout(t));
            return;
        }

        if (req.method === 'GET' && (req.url === '/state' || req.url.startsWith('/state?'))) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ state: 'running' }));
            return;
        }

        if (req.method === 'POST' && req.url === '/finish') {
            const raw = await readBody(req);
            let payload = {};
            try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = {}; }
            const sprintId = typeof payload.sprintId === 'string' ? payload.sprintId : null;
            if (!sprintId) {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'sprintId required' }));
                return;
            }
            const state = (payload.state && typeof payload.state === 'object')
                ? payload.state
                : defaultTerminalState();
            try {
                const dir = path.join(dataDir, 'old_sprints');
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(path.join(dir, `${sprintId}.json`), `${JSON.stringify(state)}\n`);
            } catch (err) {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            // Give the response a beat to flush before this process exits, so the
            // harness's fetch() reliably observes the 200 before the pid dies.
            setTimeout(() => { server.close(); process.exit(0); }, 50);
            return;
        }

        res.writeHead(404);
        res.end();
    } catch (err) {
        try {
            res.writeHead(500);
            res.end(String((err && err.message) || err));
        } catch { /* response already gone */ }
    }
});

server.on('error', (err) => {
    process.stderr.write(`[viewer-child] server error: ${err && err.message}\n`);
    process.exit(1);
});

server.listen(viewerPort, '127.0.0.1');

// Keep the event loop alive until POST /finish exits us or the harness kills
// this pid directly (test cleanup on failure).
setInterval(() => {}, 1 << 30);
