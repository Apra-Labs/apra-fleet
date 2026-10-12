#!/usr/bin/env node
// Stand-in for `bin/cli.mjs` in the launch-to-Sprints-page e2e (apra-fleet-i9ag.3.10):
// a short-lived "mock sprint" that does what the real child does for the
// supervisor -- listens on its --viewer-port and answers GET /state -- without
// needing fleet members, beads, or a model. Exits by itself after a bounded
// lifetime so an orphan can never outlive a crashed test run.
import http from 'node:http';

const idx = process.argv.indexOf('--viewer-port');
const port = idx >= 0 ? Number(process.argv[idx + 1]) : 0;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'running', tree: [] }));
});
server.listen(port, '127.0.0.1', () => { console.log('MOCK SPRINT LISTENING ' + port); });
setTimeout(() => { server.close(); process.exit(0); }, 120000).unref?.();
setInterval(() => {}, 60000);
