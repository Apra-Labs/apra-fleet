// apra-fleet-i9ag.19.46: loud-failure guard for the serial-lane registry.
//
// scripts/run-tests.mjs's default run isolates the "heavy real-process" test
// files listed in test/helpers/serial-process-suites.mjs into their own
// serial (--test-concurrency=1) phase, so their real `bd init`/real
// `bin/serve.mjs` child spawns never contend with the rest of the suite (see
// that module's header for the full rationale). That protection is only as
// good as the registry staying in sync with reality: a new test file that
// spawns a real `bd init` bootstrap or a real child process
// (`spawn(process.execPath, ...)`) but is never added to the list would
// silently fall back into the concurrent lane, reintroducing exactly the
// contention bug apra-fleet-i9ag.19.46 fixed -- with no signal until it
// flakes again under load.
//
// This test is a static source scan (cheap, no real spawns of its own), so it
// stays in the concurrent lane, and fails LOUDLY the moment such a file is
// added without being registered -- rather than waiting for the next
// contention-triggered flake to rediscover the same gap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERIAL_PROCESS_TEST_FILES } from './helpers/serial-process-suites.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDir = __dirname;
const thisFile = path.basename(fileURLToPath(import.meta.url));

// The same real-process signatures test/helpers/serial-process-suites.mjs was
// built from: a real `bd` binary probe/bootstrap gate, or a real OS child
// process spawn of another node program (bin/serve.mjs, a nested `node
// --test`, a harness script, etc).
const REAL_PROCESS_SIGNATURES = [
    /function resolveBdBinary/,
    /spawn\(process\.execPath/,
];

function listTestFiles() {
    return fs
        .readdirSync(testDir)
        .filter((name) => name.endsWith('.test.mjs'))
        .sort();
}

function matchesRealProcessSignature(source) {
    return REAL_PROCESS_SIGNATURES.some((re) => re.test(source));
}

test('every test file spawning a real bd binary or a real child process is registered in serial-process-suites.mjs', () => {
    const allFiles = listTestFiles();
    const registered = new Set(SERIAL_PROCESS_TEST_FILES);

    const unregisteredHeavyFiles = [];
    for (const name of allFiles) {
        if (name === thisFile) continue;
        const source = fs.readFileSync(path.join(testDir, name), 'utf8');
        if (matchesRealProcessSignature(source) && !registered.has(name)) {
            unregisteredHeavyFiles.push(name);
        }
    }

    assert.deepEqual(
        unregisteredHeavyFiles,
        [],
        `found test file(s) that spawn a real bd binary or a real child process but are not ` +
        `registered in test/helpers/serial-process-suites.mjs (SERIAL_PROCESS_TEST_FILES): ` +
        `${unregisteredHeavyFiles.join(', ')}. Register them so scripts/run-tests.mjs isolates ` +
        `them into the serial lane -- otherwise they silently re-enter the concurrent lane and ` +
        `reintroduce the contention this registry exists to remove.`
    );
});

test('every serial-process-suites.mjs entry still refers to an existing test file', () => {
    const allFiles = new Set(listTestFiles());
    const stale = SERIAL_PROCESS_TEST_FILES.filter((name) => !allFiles.has(name));
    assert.deepEqual(
        stale,
        [],
        `test/helpers/serial-process-suites.mjs lists file(s) that no longer exist under test/: ` +
        `${stale.join(', ')}. Fix or remove the stale entry.`
    );
});
