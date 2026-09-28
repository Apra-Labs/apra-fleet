import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    ISOLATED_HOME_SETUP_PATH, ISOLATED_HOME_SETUP_IMPORT, ISOLATED_HOME_IMPORT_FLAG,
} from '../scripts/isolated-home-import.mjs';
import { defaultDataDir as spawnerDefaultDataDir } from '../src/supervisor/spawner.mjs';
import { defaultDataDir as historyDefaultDataDir } from '../src/supervisor/history.mjs';
import { defaultDataDir as ledgerDefaultDataDir } from '../src/supervisor/ledger.mjs';

// apra-fleet-v6t7.18: pins the run-level home isolation added by
// apra-fleet-v6t7.16 (test/isolated-home-setup.mjs, wired into
// scripts/run-tests.mjs via --import) so a future change cannot silently
// regress it back to writing under the real developer home / real
// ~/.apra-fleet-se data dir. This file itself runs as one of the
// `node --test` child processes spawned by run-tests.mjs (each child
// re-receives the parent's execArgv, including the --import), so by the
// time this file's own top-level code runs, the isolation hook has already
// applied for THIS process too -- no setup/teardown of its own is needed to
// observe it, and it writes nothing to disk itself.

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// applyIsolatedHome() (tests/helpers/isolated-home.mjs) realpaths the temp
// dir it creates (fsp.realpath(mkdtemp(...))), so on macOS os.tmpdir()
// (/var/folders/...) and its realpath (/private/var/folders/...) differ --
// a plain os.tmpdir() prefix check would false-negative there. Resolve the
// same way applyIsolatedHome does (native realpath) so this test compares
// against what the isolated home actually resolves to on every platform.
const REAL_TMPDIR = fs.realpathSync.native(os.tmpdir());

/** True if `p` is os.tmpdir() itself or lives underneath it, comparing by
 *  relative path rather than string prefix (avoids the `/tmp` vs `/tmp2`
 *  false-match a bare startsWith() would allow). */
function isUnderRealTmpdir(p) {
    const rel = path.relative(REAL_TMPDIR, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

test('inside the se npm test run, os.homedir() resolves under os.tmpdir(), not the real developer home', () => {
    const home = os.homedir();
    assert.ok(
        isUnderRealTmpdir(home),
        `expected os.homedir() (${home}) to resolve under os.tmpdir() (${REAL_TMPDIR}) -- the run-level ` +
            `--import isolation (test/isolated-home-setup.mjs) should have applied before this test file's own code ran`,
    );
});

test('FLEET_SE_DATA_DIR resolves under os.tmpdir(), not the real developer home', () => {
    const dataDir = process.env.FLEET_SE_DATA_DIR;
    assert.ok(dataDir, 'expected FLEET_SE_DATA_DIR to be set by the run-level isolation setup');
    assert.ok(
        isUnderRealTmpdir(dataDir),
        `expected FLEET_SE_DATA_DIR (${dataDir}) to resolve under os.tmpdir() (${REAL_TMPDIR})`,
    );
});

if (process.platform === 'win32') {
    test('APPDATA/LOCALAPPDATA resolve under os.tmpdir() on win32', () => {
        for (const varName of ['APPDATA', 'LOCALAPPDATA']) {
            const value = process.env[varName];
            assert.ok(value, `expected ${varName} to be set by the run-level isolation setup`);
            assert.ok(
                isUnderRealTmpdir(value),
                `expected ${varName} (${value}) to resolve under os.tmpdir() (${REAL_TMPDIR})`,
            );
        }
    });
}

test('spawner/history/ledger defaultDataDir() all resolve to FLEET_SE_DATA_DIR under the isolated temp home', () => {
    const expected = path.resolve(process.env.FLEET_SE_DATA_DIR);
    assert.equal(spawnerDefaultDataDir(), expected);
    assert.equal(historyDefaultDataDir(), expected);
    assert.equal(ledgerDefaultDataDir(), expected);
    assert.ok(isUnderRealTmpdir(expected));
});

// ---------------------------------------------------------------------------
// Static check: scripts/run-tests.mjs must wire the --import isolation setup
// into every `node --test` invocation block, for ALL of mock/real/record.
// Today MODES only ever changes the APRA_FLEET_BD_MOCK env value passed to a
// single shared spawn (the argv array itself never forks per mode), so one
// assertion covers all three -- but this walks EVERY `--test` invocation
// block in the file (not just the first) so a future refactor that forks
// per-mode spawn logic and forgets the import on one branch is still caught.
// ---------------------------------------------------------------------------

function extractExecPathArgBlocks(source) {
    const blocks = [];
    const marker = 'process.execPath';
    let searchFrom = 0;
    for (;;) {
        const idx = source.indexOf(marker, searchFrom);
        if (idx === -1) break;
        const bracketStart = source.indexOf('[', idx);
        if (bracketStart === -1) break;
        let depth = 0;
        let end = -1;
        for (let i = bracketStart; i < source.length; i += 1) {
            if (source[i] === '[') depth += 1;
            else if (source[i] === ']') {
                depth -= 1;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }
        if (end === -1) break;
        blocks.push(source.slice(bracketStart, end + 1));
        searchFrom = end + 1;
    }
    return blocks;
}

test('run-tests.mjs: MODES still funnels mock/real/record through one shared invocation path', () => {
    const runTestsPath = path.join(PKG_ROOT, 'scripts', 'run-tests.mjs');
    const source = fs.readFileSync(runTestsPath, 'utf8');

    assert.match(
        source,
        /MODES\s*=\s*{\s*mock:\s*'1',\s*real:\s*'0',\s*record:\s*'record',?\s*}/,
        'expected run-tests.mjs to still define MODES with mock/real/record keys sharing one invocation path',
    );
});

test('run-tests.mjs: every node --test invocation block carries the run-level home-isolation --import', () => {
    const runTestsPath = path.join(PKG_ROOT, 'scripts', 'run-tests.mjs');
    const source = fs.readFileSync(runTestsPath, 'utf8');

    const blocks = extractExecPathArgBlocks(source).filter((b) => b.includes("'--test'"));
    assert.ok(blocks.length > 0, 'expected at least one node --test invocation in run-tests.mjs');

    // apra-fleet-y3xp: the flag is now the shared ISOLATED_HOME_IMPORT_FLAG
    // constant (scripts/isolated-home-import.mjs), so that the OTHER entry point
    // into this suite -- the repo root's scripts/run-integ-suites.mjs real-bd
    // lanes, which had drifted and lost the preload entirely -- resolves the same
    // value instead of re-deriving it. Either shape satisfies this pin; removing
    // the preload from an invocation block does not.
    for (const block of blocks) {
        assert.match(
            block,
            /ISOLATED_HOME_IMPORT_FLAG|--import=\$\{isolatedHomeSetupImport\}/,
            `expected every node --test invocation block to carry the run-level ` +
                `home-isolation --import (ISOLATED_HOME_IMPORT_FLAG), got:\n${block}`,
        );
    }
});

test('the shared isolated-home import flag resolves to test/isolated-home-setup.mjs via a file:// URL', () => {
    // Asserted against the module's real exported values rather than the source
    // text that computes them, so a refactor that keeps the contract passes and
    // one that breaks the resolved path fails.
    assert.equal(ISOLATED_HOME_SETUP_PATH, path.join(PKG_ROOT, 'test', 'isolated-home-setup.mjs'));
    assert.ok(fs.existsSync(ISOLATED_HOME_SETUP_PATH), `${ISOLATED_HOME_SETUP_PATH} does not exist`);
    assert.equal(ISOLATED_HOME_SETUP_IMPORT, pathToFileURL(ISOLATED_HOME_SETUP_PATH).href);
    assert.ok(
        ISOLATED_HOME_SETUP_IMPORT.startsWith('file://'),
        `expected a file:// URL (a bare relative path would resolve against the spawning ` +
            `process's cwd), got ${ISOLATED_HOME_SETUP_IMPORT}`,
    );
    assert.equal(ISOLATED_HOME_IMPORT_FLAG, `--import=${ISOLATED_HOME_SETUP_IMPORT}`);
});
