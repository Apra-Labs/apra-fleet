import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFleetDataDir } from '@apralabs/apra-fleet-client/server-resolution';
import { ensureTestDataDir } from './helpers/mock-sprint-harness.mjs';
import { readFleetKbConfig } from '../fleet-sprint/kb-auth-keeper.mjs';

// Mock sprints must never see the real ~/.apra-fleet/data: the KB auth keeper
// reads the orchestrator's KB config there, and on a machine whose KB is HTTP
// it would switch on inside every mock sprint. The harness makes its own temp
// data dir in any lane that sets none (the slow lane runs plain `node --test`)
// and refuses the real one.

const here = path.dirname(fileURLToPath(import.meta.url));

test('this run\'s fleet data dir is a test dir, not the real one, and the keeper reads only it', () => {
    const dir = ensureTestDataDir();
    assert.equal(path.resolve(getFleetDataDir()), dir);
    assert.notEqual(dir, path.resolve(os.homedir(), '.apra-fleet', 'data'));
    assert.equal(readFleetKbConfig(), null, 'no KB config in a test data dir');
});

test('a mock sprint started with APRA_FLEET_DATA_DIR unset runs against a temp data dir, removed at exit', () => {
    // A fresh process with the variable unset, as in the slow lane.
    const script = `
        const { buildMockFleetApi } = await import(${JSON.stringify(pathToFileURL(path.join(here, 'helpers', 'mock-sprint-harness.mjs')).href)});
        const { readFleetKbConfig } = await import(${JSON.stringify(pathToFileURL(path.join(here, '..', 'fleet-sprint', 'kb-auth-keeper.mjs')).href)});
        buildMockFleetApi(${JSON.stringify(os.tmpdir())}, { id: 'epic-1' }, [], []);
        const dir = process.env.APRA_FLEET_DATA_DIR;
        console.log(JSON.stringify({ dir, exists: !!dir && (await import('node:fs')).existsSync(dir), kb: readFleetKbConfig() }));
    `;
    const env = { ...process.env };
    delete env.APRA_FLEET_DATA_DIR;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 60_000, cwd: path.join(here, '..') });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.ok(out.dir, 'the harness set APRA_FLEET_DATA_DIR');
    assert.ok(path.resolve(out.dir).startsWith(path.resolve(os.tmpdir())), `a temp dir, got ${out.dir}`);
    assert.notEqual(path.resolve(out.dir), path.resolve(os.homedir(), '.apra-fleet', 'data'));
    assert.equal(out.exists, true);
    assert.equal(out.kb, null);
    assert.equal(fs.existsSync(out.dir), false, 'removed when the process exited');
});

test('the real data dir is refused', () => {
    assert.throws(() => ensureTestDataDir({ APRA_FLEET_DATA_DIR: path.join(os.homedir(), '.apra-fleet', 'data') }), /real/);
    assert.throws(() => ensureTestDataDir({ APRA_TEST_REAL_HOME: '/real/home', APRA_FLEET_DATA_DIR: '/real/home/.apra-fleet/data' }), /real/);
    assert.equal(ensureTestDataDir({ APRA_FLEET_DATA_DIR: path.join(os.tmpdir(), 'x-data') }), path.resolve(os.tmpdir(), 'x-data'));
});
