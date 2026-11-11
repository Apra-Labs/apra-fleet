import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getFleetDataDir } from '@apralabs/apra-fleet-client/server-resolution';
import { assertSandboxedDataDir } from './helpers/mock-sprint-harness.mjs';
import { readOrchestratorKbConfig } from '../fleet-sprint/kb-auth-keeper.mjs';

// Mock sprints must never see the real ~/.apra-fleet/data: the KB auth keeper
// reads the orchestrator's KB config there, and on a machine whose KB is HTTP
// it would switch on inside every mock sprint.

test('this run\'s fleet data dir is a test dir, not the real one, and the keeper reads only it', () => {
    const dir = assertSandboxedDataDir();
    assert.equal(path.resolve(getFleetDataDir()), dir);
    assert.notEqual(dir, path.resolve(os.homedir(), '.apra-fleet', 'data'));
    assert.equal(readOrchestratorKbConfig(), null, 'no KB config in a fresh test data dir');
});

test('the harness refuses an unset or real data dir', () => {
    assert.throws(() => assertSandboxedDataDir({}), /must name a test data dir/);
    assert.throws(() => assertSandboxedDataDir({ APRA_FLEET_DATA_DIR: path.join(os.homedir(), '.apra-fleet', 'data') }), /must name a test data dir/);
    assert.throws(() => assertSandboxedDataDir({ APRA_TEST_REAL_HOME: '/real/home', APRA_FLEET_DATA_DIR: '/real/home/.apra-fleet/data' }), /must name a test data dir/);
    assert.ok(assertSandboxedDataDir({ APRA_FLEET_DATA_DIR: path.join(os.tmpdir(), 'x-data') }));
});
