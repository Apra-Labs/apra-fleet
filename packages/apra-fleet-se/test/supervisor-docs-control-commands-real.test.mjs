// The documented supervisor control commands, run VERBATIM from SKILL.md
// through the system curl against a real `serve` process on an ephemeral
// port. Only host:port and the sprint id placeholder are substituted.
//
// Falsifiability: reverting the SKILL.md fix (no -d body) makes the extracted
// commands get the 415 Content-Type refusal, so the assertions fail.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { exec, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBeadsFixture, envWithoutBeadsDir } from './helpers/beads-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVE_BIN = path.join(here, '../bin/serve.mjs');
const FLEET_DIST_INDEX = path.resolve(here, '..', '..', '..', 'dist', 'index.js');
const SKILL = path.join(here, '../fleet-sprint/skills/fleet-supervisor/SKILL.md');

function curlAvailable() {
    try { execFileSync('curl', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
const SKIP = !fs.existsSync(FLEET_DIST_INDEX) ? 'dist/index.js missing -- run npm run build first' : !curlAvailable() ? 'curl is not installed' : (process.platform === 'win32' ? 'the documented commands are POSIX shell lines' : false);

const cleanups = [];
after(async () => { for (const c of cleanups.splice(0)) await c(); });

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    });
}

/** The documented `curl ... -X POST` line for a route, taken from SKILL.md at test time. */
function documentedCommand(routeRe) {
    const line = fs.readFileSync(SKILL, 'utf8').split(/\r?\n/).find((l) => /^\s*curl\b/.test(l) && /-X\s+POST\b/.test(l) && routeRe.test(l));
    assert.ok(line, `SKILL.md documents a curl POST for ${routeRe}`);
    return line.trim();
}

function sh(cmd) {
    return new Promise((resolve) => exec(cmd, { windowsHide: true }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));
}

/** Run a documented command with `-w` appended so the HTTP status is observable. */
async function runDocumented(cmd) {
    const r = await sh(`${cmd} -w "\\nHTTP_STATUS=%{http_code}"`);
    const m = /HTTP_STATUS=(\d+)/.exec(r.stdout);
    return { status: m ? Number(m[1]) : 0, body: r.stdout, stderr: r.stderr };
}

test('documented shutdown and stop commands, run verbatim, control a real supervisor', { skip: SKIP }, async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'doccmd-'));
    cleanups.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    const home = path.join(root, 'home');
    const fleetData = path.join(root, 'fleet-data');
    const seData = path.join(root, 'se-data');
    for (const d of [home, fleetData, seData]) await fsp.mkdir(d, { recursive: true });
    const fx = await createBeadsFixture();
    cleanups.push(fx.cleanup);
    const fleetPort = await freePort();
    const port = await freePort();
    const sharedEnv = {
        HOME: home, USERPROFILE: home, APRA_FLEET_DATA_DIR: fleetData,
        APRA_FLEET_PORT: String(fleetPort), APRA_FLEET_TRANSPORT: 'http',
    };
    // A sandboxed fleet server (empty registry) so the supervisor never reaches an ambient one.
    const fleet = spawn(process.execPath, [FLEET_DIST_INDEX, 'run', '--transport', 'http'], {
        cwd: root, stdio: 'ignore', windowsHide: true, env: envWithoutBeadsDir(sharedEnv),
    });
    cleanups.push(async () => { if (fleet.exitCode === null && fleet.signalCode === null) fleet.kill('SIGKILL'); });
    const fleetDeadline = Date.now() + 30_000;
    for (;;) {
        const r = await sh(`curl -s -o /dev/null -w "%{http_code}" -m 2 http://127.0.0.1:${fleetPort}/health`);
        if (r.stdout.trim() === '200' && fs.existsSync(path.join(fleetData, 'server.json'))) break;
        assert.ok(Date.now() < fleetDeadline, 'sandbox fleet server came up');
        await new Promise((r2) => setTimeout(r2, 100));
    }
    const serve = spawn(process.execPath, [SERVE_BIN, '--port', String(port), '--beads-dir', fx.dir], {
        cwd: path.join(here, '..'), stdio: 'ignore', windowsHide: true,
        env: envWithoutBeadsDir({ ...sharedEnv, FLEET_SE_DATA_DIR: seData }),
    });
    const exited = new Promise((resolve) => serve.once('exit', (code, signal) => resolve({ code, signal })));
    cleanups.push(async () => { if (serve.exitCode === null && serve.signalCode === null) serve.kill('SIGKILL'); });

    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    for (;;) {
        const r = await sh(`curl -s -o /dev/null -w "%{http_code}" -m 2 ${base}/api/health`);
        if (r.stdout.trim() === '200') break;
        assert.ok(Date.now() < deadline, 'supervisor came up');
        await new Promise((r2) => setTimeout(r2, 100));
    }

    const localize = (cmd, sprintId) => cmd.replace('http://localhost:8787', base).replace('<sprintId>', sprintId);

    // Control: the bare form is still refused by the request guard.
    const bare = await sh(`curl -s -o /dev/null -w "%{http_code}" -X POST ${base}/api/shutdown`);
    assert.equal(bare.stdout.trim(), '415', 'bare POST is refused with 415 (the guard is exercised)');
    assert.equal(serve.exitCode, null, 'the refused request did not stop the supervisor');

    // Documented stop: accepted by the route (its own not-found for an unknown sprint), never the 415.
    const stop = await runDocumented(localize(documentedCommand(/\/api\/sprints\/<sprintId>\/stop/), 'no-such-sprint'));
    assert.notEqual(stop.status, 415, `documented stop command was not refused for Content-Type: ${stop.body}`);
    assert.ok([200, 404, 409].includes(stop.status), `documented stop answered by the route itself, got ${stop.status}: ${stop.body}`);

    // Documented shutdown: makes the supervisor exit 0.
    const shut = await runDocumented(localize(documentedCommand(/\/api\/shutdown/)));
    assert.equal(shut.status, 200, `documented shutdown accepted: ${shut.body}`);
    const result = await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('serve did not exit after the documented shutdown')), 15_000))]);
    assert.equal(result.code, 0, 'serve exits 0');
});
