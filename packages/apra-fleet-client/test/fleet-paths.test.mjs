import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    dataDirOverride,
    fleetDataDir,
    fleetKeyPath,
    supervisorIdDir,
    installConfigPath,
    codeIntelligenceDir,
} from '../src/fleet-paths.mjs';
import { readLocalToken, TOKEN_BYTES } from '../src/auth/local-token.mjs';

// apra-fleet-q1ku: the single resolver for every fleet-owned per-instance path.
// Every case passes an explicit env object, so nothing here depends on (or
// mutates) this process's own APRA_FLEET_DATA_DIR.

const tmpDirs = new Set();
async function mkTmp(prefix) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
    tmpDirs.add(dir);
    return dir;
}
after(async () => {
    for (const dir of tmpDirs) {
        // eslint-disable-next-line no-await-in-loop
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
});

describe('fleet-paths: APRA_FLEET_DATA_DIR unset keeps the pre-resolver paths byte-for-byte', () => {
    const home = os.homedir();
    for (const env of [{}, { APRA_FLEET_DATA_DIR: '' }]) {
        const label = 'APRA_FLEET_DATA_DIR' in env ? 'empty' : 'unset';
        test(`${label}: every path is under ~/.apra-fleet exactly as before`, () => {
            assert.equal(dataDirOverride(env), null);
            assert.equal(fleetDataDir(env), path.join(home, '.apra-fleet', 'data'));
            assert.equal(fleetKeyPath(env), path.join(home, '.apra-fleet', 'fleet.key'));
            assert.equal(supervisorIdDir(env), path.join(home, '.apra-fleet', 'supervisor'));
            assert.equal(installConfigPath(env), path.join(home, '.apra-fleet', 'data', 'install-config.json'));
            assert.equal(codeIntelligenceDir(env), path.join(home, '.apra-fleet', 'data', 'code-intelligence'));
        });
    }
});

describe('fleet-paths: APRA_FLEET_DATA_DIR set puts every path inside that dir', () => {
    test('all paths resolve under <D>, none under the home dir', () => {
        const d = path.join(os.tmpdir(), 'fleet-paths-instance');
        const env = { APRA_FLEET_DATA_DIR: d };
        assert.equal(fleetDataDir(env), d);
        assert.equal(fleetKeyPath(env), path.join(d, 'fleet.key'));
        assert.equal(supervisorIdDir(env), path.join(d, 'supervisor'));
        assert.equal(installConfigPath(env), path.join(d, 'install-config.json'));
        assert.equal(codeIntelligenceDir(env), path.join(d, 'code-intelligence'));
    });

    test('APRA_FLEET_DATA_DIR naming the default data dir is the default instance (fleet.key stays beside data/)', () => {
        const home = os.homedir();
        const env = { APRA_FLEET_DATA_DIR: path.join(home, '.apra-fleet', 'data') };
        assert.equal(fleetKeyPath(env), path.join(home, '.apra-fleet', 'fleet.key'));
        assert.equal(supervisorIdDir(env), path.join(home, '.apra-fleet', 'supervisor'));
        assert.equal(installConfigPath(env), path.join(home, '.apra-fleet', 'data', 'install-config.json'));
    });

    test('an explicit home (test seam) roots the default layout there and wins over APRA_FLEET_DATA_DIR', () => {
        const home = path.join(os.tmpdir(), 'fleet-paths-home');
        const env = { APRA_FLEET_DATA_DIR: path.join(os.tmpdir(), 'ignored') };
        assert.equal(fleetKeyPath(env, { home }), path.join(home, '.apra-fleet', 'fleet.key'));
        assert.equal(fleetDataDir(env, { home }), path.join(home, '.apra-fleet', 'data'));
        assert.equal(supervisorIdDir(env, { home }), path.join(home, '.apra-fleet', 'supervisor'));
    });
});

describe('readLocalToken locates fleet.key through the resolver', () => {
    test('with APRA_FLEET_DATA_DIR in opts.env it reads <D>/fleet.key (source fleet-key)', async () => {
        const d = await mkTmp('fleet-paths-d-');
        const key = 'c'.repeat(TOKEN_BYTES * 2);
        await fsp.writeFile(path.join(d, 'fleet.key'), key, { mode: 0o600 });
        const result = readLocalToken(path.join(d, 'se'), { env: { APRA_FLEET_DATA_DIR: d }, createIfMissing: false });
        assert.equal(result.source, 'fleet-key');
        assert.equal(result.path, fleetKeyPath({ APRA_FLEET_DATA_DIR: d }));
        assert.equal(result.token, key);
    });
});
