// =============================================================================
// apra-fleet-50j6.8: the supervisor harness cleans up exactly the temp dirs it
// created itself -- and never a caller-supplied dataDir/home.
// =============================================================================
//
// The harness returns no handle on the dirs it mkdtemp's, so this test finds
// them the way a leak would show up: by diffing the harness-prefixed entries
// in os.tmpdir() before and after construction. Other test files run
// CONCURRENTLY in sibling processes and share the real temp dir, so this file
// first points os.tmpdir() (TMPDIR on POSIX, TEMP/TMP on Windows -- read on
// every call) at a private root of its own; the only harness dirs that can
// appear there are this file's. It then asserts those exact paths are gone
// after stop()/dispose().
// =============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startTestSupervisor, createTestSupervisor } from './helpers/supervisor-harness.mjs';

const HARNESS_PREFIXES = ['eft-supervisor-harness-', 'eft-supervisor-harness-home-'];

const TMP_ENV_KEYS = ['TMPDIR', 'TEMP', 'TMP'];
const savedTmpEnv = {};
let privateTmp;

before(async () => {
    privateTmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'se-harness-cleanup-'));
    for (const k of TMP_ENV_KEYS) {
        savedTmpEnv[k] = process.env[k];
        process.env[k] = privateTmp;
    }
    assert.equal(os.tmpdir(), privateTmp, 'os.tmpdir() must resolve to the private root');
});

after(async () => {
    for (const k of TMP_ENV_KEYS) {
        if (savedTmpEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedTmpEnv[k];
    }
    if (privateTmp) {
        const leftovers = fs.readdirSync(privateTmp);
        await fsp.rm(privateTmp, { recursive: true, force: true });
        assert.deepEqual(leftovers, [], 'this file must leave nothing behind in its temp root');
    }
});

function harnessEntries() {
    return new Set(
        fs.readdirSync(os.tmpdir())
            .filter((name) => HARNESS_PREFIXES.some((p) => name.startsWith(p)))
            .map((name) => path.join(os.tmpdir(), name)),
    );
}

function newSince(before) {
    return [...harnessEntries()].filter((p) => !before.has(p));
}

describe('supervisor-harness temp-dir cleanup', () => {
    test('startTestSupervisor().stop() removes the dataDir and home it created', async () => {
        const before = harnessEntries();
        const sup = await startTestSupervisor({ logger: { log() {}, error() {} } });
        const created = newSince(before);
        assert.equal(created.length, 2, `expected the harness to create a dataDir and a home, got ${JSON.stringify(created)}`);
        for (const dir of created) assert.ok(fs.existsSync(dir), dir);
        await sup.stop();
        for (const dir of created) assert.equal(fs.existsSync(dir), false, `${dir} must be removed by stop()`);
    });

    test('createTestSupervisor().dispose() removes the dataDir and home it created', async () => {
        const before = harnessEntries();
        const built = await createTestSupervisor({ logger: { log() {}, error() {} } });
        assert.equal(typeof built.dispose, 'function');
        const created = newSince(before);
        assert.equal(created.length, 2, `expected the harness to create a dataDir and a home, got ${JSON.stringify(created)}`);
        await built.dispose();
        for (const dir of created) assert.equal(fs.existsSync(dir), false, `${dir} must be removed by dispose()`);
        await built.dispose(); // idempotent
    });

    test('a caller-supplied dataDir and home survive stop() and dispose() untouched', async () => {
        const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'se-harness-cleanup-caller-'));
        try {
            const dataDir = path.join(root, 'data');
            const home = path.join(root, 'home');
            await fsp.mkdir(dataDir);
            await fsp.mkdir(home);
            const marker = path.join(dataDir, 'marker.txt');
            await fsp.writeFile(marker, 'keep');

            const before = harnessEntries();
            const sup = await startTestSupervisor({ dataDir, home, logger: { log() {}, error() {} } });
            await sup.stop();
            const built = await createTestSupervisor({ dataDir, home, logger: { log() {}, error() {} } });
            await built.dispose();

            assert.ok(fs.existsSync(dataDir), 'caller dataDir must survive');
            assert.ok(fs.existsSync(home), 'caller home must survive');
            assert.equal(fs.readFileSync(marker, 'utf-8'), 'keep', 'caller dataDir contents must be untouched');
            assert.deepEqual(newSince(before), [], 'no harness dirs may be created (or left) when both are supplied');
        } finally {
            await fsp.rm(root, { recursive: true, force: true });
        }
    });

    test('only a caller-supplied dataDir: the harness-created home is removed, the dataDir kept', async () => {
        const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'se-harness-cleanup-data-'));
        try {
            const before = harnessEntries();
            const built = await createTestSupervisor({ dataDir, logger: { log() {}, error() {} } });
            const created = newSince(before);
            assert.equal(created.length, 1, `expected only a home dir to be created, got ${JSON.stringify(created)}`);
            await built.dispose();
            assert.equal(fs.existsSync(created[0]), false, 'the harness-created home must be removed');
            assert.ok(fs.existsSync(dataDir), 'the caller dataDir must survive');
        } finally {
            await fsp.rm(dataDir, { recursive: true, force: true });
        }
    });
});
