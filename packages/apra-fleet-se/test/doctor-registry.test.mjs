import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// =============================================================================
// The sprint-doctor SYMPTOM/REMEDY REGISTRY (design doc section 4).
//
// This is a pure-data module plus one matcher, so the pins here are:
//
//   1. SHAPE. Every entry carries the four mandatory field groups (detect,
//      remedy, verify, fallback) plus id and classification, and every
//      enum-shaped sub-field (classification/scope/fallback) is one of the
//      documented closed values.
//
//   2. VERBS ARE REAL. Every non-null remedy.verb names a verb the executor
//      actually knows how to run (KNOWN_REMEDY_VERBS) -- a registry entry
//      naming a fake verb would be a silent no-op the day the doctor picked
//      it, so this is asserted both by the module's own load-time self-check
//      and again here for a clear failure message.
//
//   3. THE EIGHT SEED ENTRIES ARE PRESENT, including the two landed for the
//      2026-09-22 incidents, and the Dolt exclusion is a comment only (never
//      an entry).
//
//   4. matchRegistry() IS PURE AND CORRECT: same input -> same output, no
//      entry it was not supposed to touch (module exports are frozen), and
//      its matching rules (reason+signature AND, scope gating, the
//      scope-summary path) behave as documented.
//
// Entirely offline: no I/O, no dispatch, nothing beyond importing the module.
// =============================================================================

const {
    REGISTRY_ENTRIES,
    KNOWN_REMEDY_VERBS,
    matchRegistry,
} = await import('../fleet-sprint/doctor-registry.mjs');

const KNOWN_CLASSIFICATIONS = ['ENVIRONMENT', 'ENGINE_FLAW', 'TASK_SHAPE', 'UNCLEAR'];
const KNOWN_SCOPES = ['member', 'bead', 'fleet'];
const KNOWN_FALLBACKS = ['retry-once', 'human', 'defer', 'escalate-unclear'];

const SEED_IDS = [
    'stale-llm-credential',
    'stale-vcs-credential',
    'wedged-reservation',
    'hung-remote-session',
    'branch-not-synced-false-alarm',
    'member-cli-version-drift',
    'deferred-in-scope-never-dispatched',
    'provider-tool-registry-mismatch',
];

const entryById = (id) => REGISTRY_ENTRIES.find((e) => e.id === id);

describe('doctor-registry: shape', () => {
    test('is a non-empty frozen array', () => {
        assert.ok(Array.isArray(REGISTRY_ENTRIES));
        assert.ok(REGISTRY_ENTRIES.length > 0);
        assert.ok(Object.isFrozen(REGISTRY_ENTRIES));
    });

    test('every entry and its sub-objects are frozen (pure data, no accidental mutation)', () => {
        for (const entry of REGISTRY_ENTRIES) {
            assert.ok(Object.isFrozen(entry), `entry '${entry.id}' is not frozen`);
            assert.ok(Object.isFrozen(entry.detect), `entry '${entry.id}'.detect is not frozen`);
            assert.ok(Object.isFrozen(entry.detect.reasons), `entry '${entry.id}'.detect.reasons is not frozen`);
            assert.ok(Object.isFrozen(entry.remedy), `entry '${entry.id}'.remedy is not frozen`);
            assert.ok(Object.isFrozen(entry.verify), `entry '${entry.id}'.verify is not frozen`);
        }
    });

    test('every entry carries the four mandatory field groups plus id/classification/humanReferralTemplate', () => {
        for (const entry of REGISTRY_ENTRIES) {
            assert.equal(typeof entry.id, 'string', `entry missing id: ${JSON.stringify(entry)}`);
            assert.ok(entry.id.length > 0);
            assert.ok(KNOWN_CLASSIFICATIONS.includes(entry.classification), `entry '${entry.id}' has bad classification`);

            assert.ok(entry.detect, `entry '${entry.id}' missing detect`);
            assert.ok(Array.isArray(entry.detect.reasons), `entry '${entry.id}'.detect.reasons must be an array`);
            assert.ok(
                entry.detect.signatureRe === null || entry.detect.signatureRe instanceof RegExp,
                `entry '${entry.id}'.detect.signatureRe must be a RegExp or null`,
            );
            assert.ok(KNOWN_SCOPES.includes(entry.detect.scope), `entry '${entry.id}'.detect.scope must be member|bead|fleet`);

            assert.ok(entry.remedy, `entry '${entry.id}' missing remedy`);
            assert.equal(typeof entry.remedy.latch, 'string', `entry '${entry.id}'.remedy.latch must be a string`);

            assert.ok(entry.verify, `entry '${entry.id}' missing verify`);
            assert.equal(typeof entry.verify.kind, 'string', `entry '${entry.id}'.verify.kind must be a string`);
            assert.ok(entry.verify.kind.length > 0);

            assert.ok(KNOWN_FALLBACKS.includes(entry.fallback), `entry '${entry.id}'.fallback must be one of ${KNOWN_FALLBACKS}`);

            assert.equal(typeof entry.humanReferralTemplate, 'string', `entry '${entry.id}' missing humanReferralTemplate`);
            assert.ok(entry.humanReferralTemplate.trim().length > 0);
        }
    });

    test('every id is unique', () => {
        const ids = REGISTRY_ENTRIES.map((e) => e.id);
        assert.equal(new Set(ids).size, ids.length, `duplicate ids in ${JSON.stringify(ids)}`);
    });
});

describe('doctor-registry: remedy verbs are real', () => {
    test('every non-null remedy.verb is a known executor verb', () => {
        for (const entry of REGISTRY_ENTRIES) {
            if (entry.remedy.verb === null) continue;
            assert.ok(
                KNOWN_REMEDY_VERBS.includes(entry.remedy.verb),
                `entry '${entry.id}' names remedy verb '${entry.remedy.verb}', which is not in KNOWN_REMEDY_VERBS`,
            );
        }
    });

    test('KNOWN_REMEDY_VERBS itself is a non-empty frozen list of strings', () => {
        assert.ok(Object.isFrozen(KNOWN_REMEDY_VERBS));
        assert.ok(KNOWN_REMEDY_VERBS.length > 0);
        for (const v of KNOWN_REMEDY_VERBS) assert.equal(typeof v, 'string');
    });
});

describe('doctor-registry: the eight seed entries', () => {
    test('all eight seed ids are present, once each', () => {
        for (const id of SEED_IDS) {
            assert.ok(entryById(id), `missing seed entry '${id}'`);
        }
        assert.equal(REGISTRY_ENTRIES.length, SEED_IDS.length, 'registry should contain exactly the eight seed entries');
    });

    test('stale-dolt-clone is explicitly NOT a registry entry', () => {
        assert.equal(entryById('stale-dolt-clone'), undefined);
    });

    test('the module source records the Dolt exclusion as a comment, not data', () => {
        // Read via import.meta.resolve-free path: just re-derive from the
        // known relative location, matching how other fleet-sprint tests
        // read their own module source for a text-level assertion.
        const url = new URL('../fleet-sprint/doctor-registry.mjs', import.meta.url);
        const src = fs.readFileSync(url, 'utf8');
        assert.match(src, /EXPLICITLY EXCLUDED: stale-dolt-clone/);
        assert.match(src, /settleDoltConflicts/);
    });

    test('deferred-in-scope-never-dispatched: matches an aggregate scope-summary shape, not a single reason/signature', () => {
        const entry = entryById('deferred-in-scope-never-dispatched');
        assert.equal(entry.classification, 'ENGINE_FLAW');
        assert.equal(entry.detect.scope, 'fleet');
        assert.equal(entry.detect.requiresScopeSummary, true);
        assert.equal(entry.remedy.verb, null, 'no wired executor verb exists yet for undefer/credit-and-exclude');
        assert.equal(entry.fallback, 'human');
    });

    test('provider-tool-registry-mismatch: ENGINE_FLAW, no in-sprint remedy, human fallback', () => {
        const entry = entryById('provider-tool-registry-mismatch');
        assert.equal(entry.classification, 'ENGINE_FLAW');
        assert.equal(entry.remedy.verb, null);
        assert.equal(entry.fallback, 'human');
        assert.match(entry.humanReferralTemplate, /reinstall/i);
    });

    test('no entry quotes target-project-specific strings', () => {
        const bannedPatterns = [/apra-fleet-[a-z0-9]{2,}/i, /\bnpm run build\b/, /\bdist\/index\.js\b/, /localhost:8787/];
        for (const entry of REGISTRY_ENTRIES) {
            const haystack = JSON.stringify({
                id: entry.id,
                humanReferralTemplate: entry.humanReferralTemplate,
                remedyVerb: entry.remedy.verb,
            });
            for (const re of bannedPatterns) {
                assert.ok(!re.test(haystack), `entry '${entry.id}' quotes a target-specific string matching ${re}`);
            }
        }
    });
});

describe('doctor-registry: matchRegistry()', () => {
    test('returns null for empty/garbage evidence', () => {
        assert.equal(matchRegistry(), null);
        assert.equal(matchRegistry({}), null);
        assert.equal(matchRegistry(null), null);
        assert.equal(matchRegistry({ reason: 'unrelated_reason' }), null);
    });

    test('matches stale-llm-credential on reason + signature (AND semantics)', () => {
        const hit = matchRegistry({ reason: 'auth', message: 'authentication failed: token expired', scope: 'member' });
        assert.equal(hit && hit.id, 'stale-llm-credential');
    });

    test('reason matches but signature does not -> no match for a reason+signature entry', () => {
        const hit = matchRegistry({ reason: 'auth', message: 'some unrelated failure text', scope: 'member' });
        assert.equal(hit, null);
    });

    test('matches stale-vcs-credential via vcsKind fallback token', () => {
        const hit = matchRegistry({ vcsKind: 'AUTH_EXPIRED', message: 'permission denied (publickey)', scope: 'member' });
        assert.equal(hit && hit.id, 'stale-vcs-credential');
    });

    test('matches wedged-reservation on reason + signature', () => {
        const hit = matchRegistry({ reason: 'reserved', message: 'Member "mac-01" is already reserved by "sprint-42"', scope: 'member' });
        assert.equal(hit && hit.id, 'wedged-reservation');
    });

    test('matches branch-not-synced-false-alarm on signature alone (no reasons listed)', () => {
        const hit = matchRegistry({ message: "fatal: couldn't find remote ref feat/some-branch", scope: 'member' });
        assert.equal(hit && hit.id, 'branch-not-synced-false-alarm');
    });

    test('scope mismatch prevents a match even when reason+signature both match', () => {
        const hit = matchRegistry({ reason: 'auth', message: 'authentication failed', scope: 'fleet' });
        assert.equal(hit, null);
    });

    test('member-cli-version-drift can never be mechanically matched from ledger evidence', () => {
        const hit = matchRegistry({ reason: null, message: 'anything at all', scope: 'member' });
        assert.notEqual(hit && hit.id, 'member-cli-version-drift');
    });

    test('deferred-in-scope-never-dispatched matches only a satisfying scope-summary', () => {
        const noMatch = matchRegistry({ scope: 'fleet', scopeSummary: { openAtGoalCount: 1, deferredAtGoalCount: 2, dispatchedSinceDeferCount: 0 } });
        assert.equal(noMatch, null);

        const hit = matchRegistry({
            scope: 'fleet',
            scopeSummary: { openAtGoalCount: 0, deferredAtGoalCount: 2, dispatchedSinceDeferCount: 0 },
        });
        assert.equal(hit && hit.id, 'deferred-in-scope-never-dispatched');
    });

    test('deferred-in-scope-never-dispatched does not match when deferred count is zero', () => {
        const hit = matchRegistry({
            scope: 'fleet',
            scopeSummary: { openAtGoalCount: 0, deferredAtGoalCount: 0, dispatchedSinceDeferCount: 0 },
        });
        assert.equal(hit, null);
    });

    test('matches provider-tool-registry-mismatch on signature alone', () => {
        const hit = matchRegistry({ message: 'Unknown tool "execute_command" requested by agent', scope: 'member' });
        assert.equal(hit && hit.id, 'provider-tool-registry-mismatch');
    });

    test('is pure: repeated calls with equivalent input return an entry from the same frozen registry, and evidence is untouched', () => {
        const evidence = Object.freeze({ reason: 'auth', message: 'authentication failed', scope: 'member' });
        const first = matchRegistry(evidence);
        const second = matchRegistry({ reason: 'auth', message: 'authentication failed', scope: 'member' });
        assert.equal(first, second);
        assert.ok(REGISTRY_ENTRIES.includes(first));
    });
});
