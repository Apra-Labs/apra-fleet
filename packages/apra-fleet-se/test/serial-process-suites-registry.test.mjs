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
//
// apra-fleet-i9ag.19.46 rework: the original signature only matched the bare
// `spawn(process.execPath` call form. `spawnSync`/`execFile`/`execFileSync`
// of the same target -- equally a real OS child-process launch -- sailed
// past it undetected: a repo-wide scan at rework time found 13 files using
// those spellings, invisible to the guard. Widened below to catch all four
// child_process call forms.
const REAL_PROCESS_SIGNATURES = [
    /function resolveBdBinary/,
    /\b(?:spawn|spawnSync|execFile|execFileSync)\(\s*process\.execPath/,
];

// Widening REAL_PROCESS_SIGNATURES above (to close the spawnSync/execFileSync
// gap) also makes it match every file's process.execPath usage, including
// launches that are NOT a real bd/Dolt bootstrap, a real long-lived server,
// or a nested `node --test` over real target suite files -- the three
// categories test/helpers/serial-process-suites.mjs's own header documents as
// "real work". Each entry below was individually read at rework time and
// confirmed to be genuinely light (a synchronous, bounded, one-shot launch
// doing none of those three things), so it deliberately stays in the
// concurrent lane rather than being forced into the registry. This list is a
// reviewed EXCEPTION list, not a wildcard: a NEW file using spawn/spawnSync/
// execFile/execFileSync of process.execPath that is not already on this list
// AND not in SERIAL_PROCESS_TEST_FILES still fails the test below -- so the
// author must explicitly classify it (register it as heavy, or add it here
// with the same kind of justification) rather than the file silently
// escaping the guard the way the pre-rework gap allowed.
const KNOWN_LIGHT_PROCESS_SPAWNS = {
    // Inline `-e`/`--eval` one-liners that do no real work beyond exiting or
    // running a few in-process lines against an already-loaded module --
    // never a Dolt bootstrap, a long-lived server, or a nested real suite.
    '0j1-watchdog-reservation-release.test.mjs': "spawnSync(process.execPath, ['-e', 'process.exit(0)']) -- inert pid probe, exits immediately, no real work.",
    '4ul-run-state-paths-sanitize.test.mjs': "spawnSync(process.execPath, ['-e', 'process.exit(0)']) -- inert pid probe, exits immediately, no real work.",
    '4ul-terminal-state-runid-keying.test.mjs': "spawnSync(process.execPath, ['-e', 'process.exit(0)']) -- inert pid probe, exits immediately, no real work.",
    'k7b6-watchdog-finished-integration.test.mjs': "spawnSync(process.execPath, ['-e', 'process.exit(0)']) -- inert pid probe, exits immediately, no real work.",
    'k7b8-dolt-diverged-conflict-integration.test.mjs': "spawnSync(process.execPath, ['-e', 'process.exit(0)']) -- inert pid probe, exits immediately, no real work.",
    'sprint-lock.test.mjs': "spawnSync(process.execPath, ['-e', 'process.exit(0)']) -- inert pid probe, exits immediately, no real work.",
    'se-os-commands-shell-matrix.test.mjs': "spawnSync(process.execPath, ['--input-type=module', '-e', script], ...) -- the inline script only calls an already-imported pure function and writes JSON to stdout; no external target file, server, or Dolt bootstrap.",
    // String literals inside an assertion message, not real code -- this
    // file's source text happens to contain the signature spelled out as an
    // example of what the census it verifies would flag.
    'nested-mock-sprint-run-census.test.mjs': 'the signature only appears inside string-literal example text in an assertion message, not as executable code.',
    // One-shot invocations of a small standalone script -- not a Dolt
    // bootstrap, not a long-lived server, not a nested `node --test` of real
    // target suite files.
    'integration-gate-status.test.mjs': 'spawnSync(process.execPath, [SCRIPT, ...]) runs scripts/integration-gate-status.mjs once, offline, over inline example data -- a read-only status script, not a server or Dolt bootstrap.',
    'merge-kb-canonical.test.mjs': 'spawnSync(process.execPath, [SCRIPT, ...]) runs scripts/merge-kb-canonical.mjs once over local JSON fixtures -- a pure merge script, not a server or Dolt bootstrap.',
    'run-tests-script-wiring.test.mjs': "spawnSync(process.execPath, derivedArgs, ...) runs scripts/run-tests.mjs against exactly ONE lightweight probe file (test/helpers/run-tests-wiring-probe.mjs), not the real suite.",
};

function listTestFiles() {
    return fs
        .readdirSync(testDir)
        .filter((name) => name.endsWith('.test.mjs'))
        .sort();
}

function matchesRealProcessSignature(source) {
    return REAL_PROCESS_SIGNATURES.some((re) => re.test(source));
}

test('every test file spawning a real bd binary or a real child process is registered in serial-process-suites.mjs (or explicitly reviewed as light)', () => {
    const allFiles = listTestFiles();
    const registered = new Set(SERIAL_PROCESS_TEST_FILES);
    const knownLight = new Set(Object.keys(KNOWN_LIGHT_PROCESS_SPAWNS));

    const unregisteredHeavyFiles = [];
    for (const name of allFiles) {
        if (name === thisFile) continue;
        const source = fs.readFileSync(path.join(testDir, name), 'utf8');
        if (matchesRealProcessSignature(source) && !registered.has(name) && !knownLight.has(name)) {
            unregisteredHeavyFiles.push(name);
        }
    }

    assert.deepEqual(
        unregisteredHeavyFiles,
        [],
        `found test file(s) that spawn a real bd binary or a real child process but are not ` +
        `registered in test/helpers/serial-process-suites.mjs (SERIAL_PROCESS_TEST_FILES) and are not ` +
        `in this file's reviewed KNOWN_LIGHT_PROCESS_SPAWNS exception list: ${unregisteredHeavyFiles.join(', ')}. ` +
        `Either register them so scripts/run-tests.mjs isolates them into the serial lane (if they spawn a real ` +
        `bd/Dolt bootstrap, a real long-lived server, or a nested 'node --test' of real target suite files), or ` +
        `add them to KNOWN_LIGHT_PROCESS_SPAWNS with a one-line justification (if the spawn is a bounded, one-shot, ` +
        `no-real-work launch) -- do not leave a new process.execPath spawn unclassified.`
    );
});

test('every KNOWN_LIGHT_PROCESS_SPAWNS entry still refers to an existing test file that still matches a real-process signature', () => {
    const allFiles = new Set(listTestFiles());
    const stale = [];
    for (const name of Object.keys(KNOWN_LIGHT_PROCESS_SPAWNS)) {
        if (!allFiles.has(name)) {
            stale.push(`${name} (file no longer exists)`);
            continue;
        }
        const source = fs.readFileSync(path.join(testDir, name), 'utf8');
        if (!matchesRealProcessSignature(source)) {
            stale.push(`${name} (no longer matches any real-process signature)`);
        }
    }
    assert.deepEqual(
        stale,
        [],
        `test/serial-process-suites-registry.test.mjs's KNOWN_LIGHT_PROCESS_SPAWNS lists stale entry(ies): ` +
        `${stale.join(', ')}. Remove the entry (or update it) so this exception list does not accumulate dead weight.`
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
