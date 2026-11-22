import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHeartbeat, heartbeatPath, resolveHeartbeatIntervalMs, writeHeartbeatFile, HEARTBEAT_INTERVAL_ENV, DEFAULT_HEARTBEAT_INTERVAL_MS } from '../src/supervisor/heartbeat.mjs';

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
const read = (dir) => JSON.parse(fs.readFileSync(heartbeatPath(dir), 'utf8'));

test('start writes supervisor.json with pid, port, beadsDir, updatedAt, intervalMs and updatedAt advances', async () => {
    const dir = mkTmp();
    const hb = createHeartbeat({ dataDir: dir, port: 4321, beadsDir: '/x/.beads', version: '9.9.9', intervalMs: 40 });
    try {
        hb.start();
        const first = read(dir);
        assert.equal(first.pid, process.pid);
        assert.equal(first.port, 4321);
        assert.equal(first.beadsDir, '/x/.beads');
        assert.equal(first.intervalMs, 40);
        assert.equal(first.version, '9.9.9');
        assert.ok(first.startedAt && first.updatedAt);
        assert.equal(first.stoppedAt, undefined);
        await sleep(200);
        const later = read(dir);
        assert.ok(Date.parse(later.updatedAt) > Date.parse(first.updatedAt), 'updatedAt advances on the next interval');
        assert.equal(later.startedAt, first.startedAt);
    } finally {
        hb.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('clean stop leaves the documented final record: file kept, stoppedAt set, no further writes', async () => {
    const dir = mkTmp();
    const hb = createHeartbeat({ dataDir: dir, port: 1, intervalMs: 30 });
    try {
        hb.start();
        hb.stop();
        const fin = read(dir);
        assert.ok(fin.stoppedAt, 'final record carries stoppedAt');
        hb.stop(); // idempotent
        await sleep(120);
        assert.deepEqual(read(dir), fin, 'no writes after stop');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('writes are atomic: a tight reader never sees partial JSON and no temp file is left behind', () => {
    const dir = mkTmp();
    const file = heartbeatPath(dir);
    try {
        writeHeartbeatFile(file, { n: 0 });
        const big = 'x'.repeat(200000);
        for (let i = 1; i <= 200; i += 1) {
            writeHeartbeatFile(file, { n: i, big });
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            assert.equal(parsed.n, i);
        }
        assert.deepEqual(fs.readdirSync(dir), ['supervisor.json']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('a failing write is logged, never thrown', () => {
    const dir = mkTmp();
    const logs = [];
    // dataDir is an existing FILE, so mkdir/write fails.
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const hb = createHeartbeat({ dataDir: blocker, port: 1, log: (m) => logs.push(m) });
    try {
        assert.doesNotThrow(() => hb.start());
        assert.ok(logs.some((l) => /heartbeat write/.test(l)));
    } finally {
        hb.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('interval env override is honoured and defaults when invalid', () => {
    assert.equal(resolveHeartbeatIntervalMs({ [HEARTBEAT_INTERVAL_ENV]: '250' }), 250);
    assert.equal(resolveHeartbeatIntervalMs({ [HEARTBEAT_INTERVAL_ENV]: 'abc' }), DEFAULT_HEARTBEAT_INTERVAL_MS);
    assert.equal(resolveHeartbeatIntervalMs({}), DEFAULT_HEARTBEAT_INTERVAL_MS);
});
