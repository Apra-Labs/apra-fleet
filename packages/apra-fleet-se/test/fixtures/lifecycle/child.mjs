#!/usr/bin/env node
// =============================================================================
// Fake sprint child for supervisor-lifecycle.test.mjs (apra-fleet-eft.4.6)
// =============================================================================
//
// A REAL OS process whose observable behavior stands in for a detached
// bin/cli.mjs sprint child, so the lifecycle test can exercise the watchdog's
// four statuses and PID re-adoption against genuine processes rather than
// mocks. It deliberately does NOT run the real fleet/beads/git machinery -- it
// only reproduces the two signals the watchdog keys off (PID liveness and the
// child's own `/state` HTTP endpoint) plus the terminal-state file a finished
// sprint leaves in old_sprints/.
//
// Modes (via --mode, default 'alive'):
//   healthy  - bind an HTTP server on --viewer-port answering any path (incl.
//              /state) with 200; then stay alive.
//   alive    - stay alive with NO HTTP server at all (a hung/unresponsive
//              child: PID alive, HTTP silent).
//   finished - write a terminal state file to
//              <APRA_FLEET_DATA_DIR>/old_sprints/<sprintId>.json, then exit 0
//              (a completed sprint that recorded a terminal state).
//
// It carries `--viewer-port <port>` in its own argv so the watchdog's PID-reuse
// guard (Linux /proc/<pid>/cmdline marker) and the re-adopter's port recovery
// (read from the live process's own command line) both see a genuine command
// line.
//
// Protocol: prints one line on stdout when ready -- `READY <port>` (port is the
// bound HTTP port for healthy, or 0 for alive), or `DONE` right before a
// finished child exits. `ERROR <msg>` on a setup failure.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

function argVal(flag, dflt) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

const mode = argVal('--mode', 'alive');
const viewerPort = Number(argVal('--viewer-port', '0'));
const sprintId = argVal('--sprint-id', 'sprint');
const dataDir = process.env.APRA_FLEET_DATA_DIR || '';

if (mode === 'finished') {
    try {
        const dir = path.join(dataDir, 'old_sprints');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            path.join(dir, `${sprintId}.json`),
            `${JSON.stringify({ sprintId, status: 'completed' })}\n`,
        );
        process.stdout.write('DONE\n');
        process.exit(0);
    } catch (err) {
        process.stdout.write(`ERROR ${err.message}\n`);
        process.exit(1);
    }
}

if (mode === 'healthy') {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sprintId, state: 'running' }));
    });
    server.on('error', (err) => {
        process.stdout.write(`ERROR ${err.message}\n`);
        process.exit(1);
    });
    server.listen(viewerPort, '127.0.0.1', () => {
        process.stdout.write(`READY ${server.address().port}\n`);
    });
} else {
    // 'alive' (hung/unresponsive): no HTTP server, just stay up until killed.
    process.stdout.write('READY 0\n');
}

// Keep the event loop alive for the healthy/alive modes until the test kills
// the process externally.
setInterval(() => {}, 1 << 30);
