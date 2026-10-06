// Pid-verifying readiness wait for the viewer-child fixture
// (test/fixtures/dashboard/viewer-child.mjs), shared by the integration suites
// that launch it through the REAL spawner.
//
// Why the pid check: a 200 from GET /state on the launched port only proves
// that SOMETHING answers there. When two suites raced for the same
// --viewer-port, the losing child died on EADDRINUSE while the other suite's
// child answered /state on that port -- the wait passed and the later
// isPidAlive() assertion failed. The fixture's /state reports its own pid, so
// only a 200 whose body pid equals the pid POST /api/sprints returned counts
// as "our child is up"; any foreign responder keeps the wait polling until it
// times out.
import http from 'node:http';

/** GET /state on 127.0.0.1:port, resolving { status, body }. */
function getState(port) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/state', method: 'GET' }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

/**
 * True when GET /state on `port` answers 200 with a JSON body whose `pid`
 * equals `expectedPid`; false for any other answer, a non-JSON body, or a
 * connection error.
 * @param {number} port
 * @param {number} expectedPid
 * @returns {Promise<boolean>}
 */
export async function isChildAnswering(port, expectedPid) {
    try {
        const r = await getState(port);
        if (r.status !== 200) return false;
        const json = JSON.parse(r.body);
        return Boolean(json) && json.pid === expectedPid;
    } catch {
        return false;
    }
}

/**
 * Polls until the viewer child with pid `expectedPid` answers GET /state on
 * `port`; throws `timed out waiting for <label> ...` once `timeoutMs` passes.
 * @param {number} port
 * @param {number} expectedPid
 * @param {{ timeoutMs: number, intervalMs?: number, label?: string }} opts
 */
export async function waitForChildUp(port, expectedPid, { timeoutMs, intervalMs = 50, label = 'viewer-child /state to answer' }) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new TypeError('waitForChildUp requires a positive timeoutMs');
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        if (await isChildAnswering(port, expectedPid)) return;
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${label} (pid ${expectedPid}, port ${port})`);
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, intervalMs); });
    }
}
