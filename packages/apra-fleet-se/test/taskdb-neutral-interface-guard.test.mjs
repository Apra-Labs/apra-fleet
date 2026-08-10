import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DoltSync } from '../fleet-sprint/dolt-sync.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(__dirname, '../fleet-sprint/runner.js');

// =============================================================================
// apra-fleet-417.5 -- docs/adr-taskdb-backend-neutral-interface.md Decision 4:
// "a static guard test asserts that runner.js references only the neutral
// method names on the module handle, and that no file outside the backend's
// own module spawns that backend's commands. That guard is what makes this
// criterion testable rather than aspirational."
//
// This file owns the first half of that sentence: the NEUTRAL METHOD NAME
// pin on runner.js's `DoltSync.<method>` call sites. (The second half -- no
// file outside dolt-sync.mjs spawning `bd dolt ...` -- is already covered by
// test/dispatch-safety-guard.test.mjs's command()/agent() member_name guard
// and by the module-header invariant that only dolt-sync.mjs is permitted to
// issue `bd dolt` commands.)
//
// Purely static: reads runner.js as text and regexes it. Never shells out to
// `bd`, so no bd-recording fixture is needed for this test.
// =============================================================================

// The TaskDBModule interface (ADR Decision 2's seven-method table) plus the
// two visibility helpers (getDegradedSyncRecords / clearDegradedSyncRecords)
// that the module additionally exposes on the DoltSync handle. None of these
// names contain 'dolt', 'beads', 'bd', 'pull' or 'push' -- the vocabulary the
// ADR reserves for adapter internals (doltPullBefore, doltPushAfter,
// classifyDoltFailure, ...), which are exported separately from dolt-sync.mjs
// and are never reached through the DoltSync handle.
const NEUTRAL_METHOD_NAMES = new Set([
    'syncBefore',
    'syncAfter',
    'status',
    'refreshView',
    'ensureReady',
    'flush',
    'repair',
    'capabilities',
    'getDegradedSyncRecords',
    'clearDegradedSyncRecords',
]);

// Vocabulary that Decision 2 says must not appear in an interface method or
// parameter name -- checked case-sensitively against camelCase identifiers so
// e.g. 'Dolt' inside 'DoltSync' (the module/handle name itself, not a method)
// is not what this scans.
const BACKEND_FLAVORED_WORDS = /dolt|beads|\bpull\b|\bpush\b/i;

function readSource(p) {
    return fs.readFileSync(p, 'utf-8');
}

test('DoltSync export surface is exactly the neutral TaskDBModule method set', () => {
    const keys = Object.keys(DoltSync);
    for (const key of keys) {
        assert.ok(
            NEUTRAL_METHOD_NAMES.has(key),
            `DoltSync.${key} is not in the neutral method allowlist -- either it is a new ` +
            `backend-flavored leak onto the interface handle, or NEUTRAL_METHOD_NAMES needs updating.`,
        );
    }
    // The full seven-method contract must be present, not just a subset.
    for (const method of ['syncBefore', 'syncAfter', 'status', 'refreshView', 'ensureReady', 'flush', 'repair', 'capabilities']) {
        assert.equal(typeof DoltSync[method], 'function', `DoltSync.${method} must be a function`);
    }
});

test('runner.js references only neutral method names on the DoltSync module handle (ADR Decision 4)', () => {
    const source = readSource(RUNNER_PATH);
    const callSites = [...source.matchAll(/\bDoltSync\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]);
    assert.ok(callSites.length > 0, 'expected at least one DoltSync.<method>(...) call site in runner.js');
    const offenders = callSites.filter((name) => !NEUTRAL_METHOD_NAMES.has(name));
    assert.deepEqual(
        offenders, [],
        `runner.js calls DoltSync.<method>() with non-neutral method name(s): ${offenders.join(', ')}. ` +
        'Only the backend-neutral TaskDBModule surface (syncBefore/syncAfter/status/refreshView/' +
        'ensureReady/flush/repair/capabilities/getDegradedSyncRecords/clearDegradedSyncRecords) may be ' +
        'called on the DoltSync handle from runner.js.',
    );
});

test('runner.js opts passed to DoltSync.syncBefore/syncAfter use the renamed neutral parameter spellings', () => {
    const source = readSource(RUNNER_PATH);
    assert.doesNotMatch(
        source, /DoltSync\.syncBefore\([^)]*\bskipPull\s*:/s,
        "runner.js must pass 'skipRefresh', not the retired 'skipPull', to DoltSync.syncBefore()",
    );
    assert.doesNotMatch(
        source, /DoltSync\.syncBefore\([^)]*\bhealthGate\s*:/s,
        "runner.js must pass 'readinessGate', not the retired 'healthGate', to DoltSync.syncBefore()",
    );
    assert.doesNotMatch(
        source, /DoltSync\.syncAfter\([^)]*\bmutatedBeads\s*:/s,
        "runner.js must not pass the backend-flavored 'mutatedBeads' -- use 'mutatedItemIds' if threading mutation ids through",
    );
});

test('the DoltSync interface method/parameter names carry no backend-flavored vocabulary', () => {
    for (const method of NEUTRAL_METHOD_NAMES) {
        assert.doesNotMatch(
            method, BACKEND_FLAVORED_WORDS,
            `DoltSync.${method} contains backend-flavored vocabulary the ADR reserves for adapter internals`,
        );
    }
});
