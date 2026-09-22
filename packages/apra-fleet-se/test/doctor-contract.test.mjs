import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

// =============================================================================
// sprint-doctor verdict contract (design: fleet-sprint/docs/escalate-to-llm-
// design.md sections 2.3-2.4). This pins the output schema so a later prompt
// change to apra-pm/agents/sprint-doctor.md cannot quietly widen the contract:
// every valid classification shape validates, every out-of-contract shape is
// rejected, the schema is proven to load from the vendored agents/schemas
// directory (not the in-module fallback literal), and the fallback literal is
// proven to agree with the on-disk schema on every required/enum set so the
// two cannot silently drift apart.
//
// Entirely offline: ajv + fs only, no fleet dispatch, no network, no member.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'apra-pm', 'agents', 'schemas');

const {
    loadSchemaFileFrom,
    FALLBACK_sprintDoctorVerdict,
} = await import('../fleet-sprint/contracts.mjs');

const diskSchema = loadSchemaFileFrom(FIXTURES_DIR, 'sprint-doctor-output');

const ajv = new Ajv({ strict: false });
const validateOnDisk = ajv.compile(diskSchema);

// -----------------------------------------------------------------------------
// Fixture builder: a minimal complete base object, extended per case.
// -----------------------------------------------------------------------------
function baseVerdict(over = {}) {
    return {
        classification: 'ENVIRONMENT',
        confidence: 'high',
        evidence: ['at least one evidence bullet'],
        matchedRegistryEntry: null,
        notes: 'notes',
        ...over,
    };
}

describe('sprint-doctor-output.json loads from the vendored agents/schemas directory, not the fallback', () => {
    test('the on-disk schema exists and carries the versioned apra-pm $id (never the bare fallback $id)', () => {
        assert.ok(diskSchema, 'expected apra-pm/agents/schemas/sprint-doctor-output.json to load');
        assert.strictEqual(diskSchema.$id, 'apra-pm/sprint-doctor-output@1');
        assert.notStrictEqual(diskSchema.$id, FALLBACK_sprintDoctorVerdict.$id);
    });

    test('resolveOutputSchema actually resolves to the on-disk file when pointed at the real schemas dir (not the fallback object)', async () => {
        const previous = process.env.APRA_FLEET_SE_SCHEMAS_DIR;
        process.env.APRA_FLEET_SE_SCHEMAS_DIR = FIXTURES_DIR;
        try {
            const wired = await import(`../fleet-sprint/contracts.mjs?doctor-contract-test=${Date.now()}-${Math.random()}`);
            assert.strictEqual(wired.sprintDoctorVerdict.$id, 'apra-pm/sprint-doctor-output@1');
            assert.notStrictEqual(wired.sprintDoctorVerdict, wired.FALLBACK_sprintDoctorVerdict);
        } finally {
            if (previous === undefined) {
                delete process.env.APRA_FLEET_SE_SCHEMAS_DIR;
            } else {
                process.env.APRA_FLEET_SE_SCHEMAS_DIR = previous;
            }
        }
    });

    test('resolveOutputSchema degrades to the fallback literal when no schemas directory resolves at all', async () => {
        const previous = process.env.APRA_FLEET_SE_SCHEMAS_DIR;
        const emptyDir = path.join(__dirname, 'fixtures', 'nonexistent-schemas-dir-for-doctor-contract-test');
        process.env.APRA_FLEET_SE_SCHEMAS_DIR = emptyDir;
        try {
            const wired = await import(`../fleet-sprint/contracts.mjs?doctor-contract-test-empty=${Date.now()}-${Math.random()}`);
            assert.strictEqual(wired.sprintDoctorVerdict, wired.FALLBACK_sprintDoctorVerdict, 'expected the fallback literal when the schemas dir does not resolve');
        } finally {
            if (previous === undefined) {
                delete process.env.APRA_FLEET_SE_SCHEMAS_DIR;
            } else {
                process.env.APRA_FLEET_SE_SCHEMAS_DIR = previous;
            }
        }
    });
});

describe('sprint-doctor verdict: valid shape per classification', () => {
    test('ENVIRONMENT with a plain action validates', () => {
        const verdict = baseVerdict({
            classification: 'ENVIRONMENT',
            action: { kind: 'retry_different_member', member: 'member-b', reason: 'discriminating probe' },
        });
        const ok = validateOnDisk(verdict);
        assert.strictEqual(ok, true, JSON.stringify(validateOnDisk.errors));
    });

    test('ENGINE_FLAW with an action AND the required engineFlawReport validates', () => {
        const verdict = baseVerdict({
            classification: 'ENGINE_FLAW',
            confidence: 'medium',
            action: { kind: 'retry_same', timeoutMultiplier: 2, reason: 'mitigation only' },
            engineFlawReport: {
                symptom: 'symptom text',
                suspectedComponent: 'component name',
                reproEvidence: ['row 1', 'row 2'],
                proposedBeadTitle: 'a title for the engine tracker',
            },
        });
        const ok = validateOnDisk(verdict);
        assert.strictEqual(ok, true, JSON.stringify(validateOnDisk.errors));
    });

    test('TASK_SHAPE with a defer_bead action validates', () => {
        const verdict = baseVerdict({
            classification: 'TASK_SHAPE',
            confidence: 'medium',
            action: { kind: 'defer_bead', beadIds: ['BD-1'], reason: 'oversized/ambiguous', salvageWip: false },
        });
        const ok = validateOnDisk(verdict);
        assert.strictEqual(ok, true, JSON.stringify(validateOnDisk.errors));
    });

    test('UNCLEAR with probes (instead of action) validates', () => {
        const verdict = baseVerdict({
            classification: 'UNCLEAR',
            confidence: 'low',
            probes: ['member_session_state', 'member_cli_version'],
        });
        const ok = validateOnDisk(verdict);
        assert.strictEqual(ok, true, JSON.stringify(validateOnDisk.errors));
    });

    test('a full pause_for_human verdict with a complete humanActionRequired referral validates', () => {
        const verdict = baseVerdict({
            classification: 'ENVIRONMENT',
            action: { kind: 'pause_for_human', reason: 'beyond bounds' },
            humanActionRequired: {
                summary: 's',
                suggestedCommands: ['cmd one'],
                relevantFiles: [],
                relevantBeadIds: [],
                whyBeyondBounds: 'w',
            },
        });
        const ok = validateOnDisk(verdict);
        assert.strictEqual(ok, true, JSON.stringify(validateOnDisk.errors));
    });
});

describe('sprint-doctor verdict: the eight out-of-contract rejection cases', () => {
    test('REJECTED: both action and probes present', () => {
        const verdict = baseVerdict({
            action: { kind: 'retry_same' },
            probes: ['member_cli_version'],
        });
        assert.strictEqual(validateOnDisk(verdict), false);
    });

    test('REJECTED: neither action nor probes present', () => {
        const verdict = baseVerdict();
        assert.strictEqual(validateOnDisk(verdict), false);
    });

    test('REJECTED: classification ENGINE_FLAW without engineFlawReport', () => {
        const verdict = baseVerdict({
            classification: 'ENGINE_FLAW',
            action: { kind: 'retry_same' },
        });
        assert.strictEqual(validateOnDisk(verdict), false);
    });

    test('REJECTED: action.kind pause_for_human without humanActionRequired', () => {
        const verdict = baseVerdict({
            action: { kind: 'pause_for_human' },
        });
        assert.strictEqual(validateOnDisk(verdict), false);
    });

    test('REJECTED: humanActionRequired present with an empty suggestedCommands', () => {
        const verdict = baseVerdict({
            action: { kind: 'pause_for_human' },
            humanActionRequired: {
                summary: 's',
                suggestedCommands: [],
                relevantFiles: [],
                relevantBeadIds: [],
                whyBeyondBounds: 'w',
            },
        });
        assert.strictEqual(validateOnDisk(verdict), false);
    });

    test('REJECTED: action.timeoutMultiplier of 3 (cap is 2)', () => {
        const verdict = baseVerdict({
            action: { kind: 'retry_same', timeoutMultiplier: 3 },
        });
        assert.strictEqual(validateOnDisk(verdict), false);
    });

    test('REJECTED: an unknown action.kind', () => {
        const verdict = baseVerdict({
            action: { kind: 'reformat_the_universe' },
        });
        assert.strictEqual(validateOnDisk(verdict), false);
    });

    test('REJECTED: an unknown probe string (including the explicitly-not-a-probe cross_member_redispatch)', () => {
        const verdictUnknown = baseVerdict({ probes: ['not_a_real_probe'] });
        assert.strictEqual(validateOnDisk(verdictUnknown), false);

        const verdictCrossMember = baseVerdict({ probes: ['cross_member_redispatch'] });
        assert.strictEqual(validateOnDisk(verdictCrossMember), false);
    });
});

describe('sprint-doctor verdict: an additional documented (non-enumerated) rejection', () => {
    test('REJECTED: abort_sprint + classification ENGINE_FLAW without humanActionRequired', () => {
        const verdict = baseVerdict({
            classification: 'ENGINE_FLAW',
            action: { kind: 'abort_sprint', reason: 'whole remaining scope is broken' },
            engineFlawReport: {
                symptom: 's',
                suspectedComponent: 'c',
                reproEvidence: ['r'],
                proposedBeadTitle: 't',
            },
        });
        assert.strictEqual(validateOnDisk(verdict), false);
    });

    test('REJECTED: abort_sprint + classification UNCLEAR without humanActionRequired', () => {
        const verdict = baseVerdict({
            classification: 'UNCLEAR',
            confidence: 'low',
            action: { kind: 'abort_sprint', reason: 'evidence never resolved' },
        });
        assert.strictEqual(validateOnDisk(verdict), false);
    });
});

// -----------------------------------------------------------------------------
// Fallback/on-disk drift guard: walks both schema objects and collects every
// `required` array and every `enum` array, keyed by its structural path
// (properties/definitions/allOf are all walked identically since both files
// were authored with the same $ref-based shape). If a future edit to either
// file adds, removes, or renames a required field or an enum member without
// updating its sibling, this test fails.
// -----------------------------------------------------------------------------
function collectRequiredAndEnums(node, pathParts, out) {
    if (node === null || typeof node !== 'object') return;

    if (Array.isArray(node.required)) {
        out.push([pathParts.join('/') + '#required', [...node.required].sort()]);
    }
    if (Array.isArray(node.enum)) {
        out.push([pathParts.join('/') + '#enum', [...node.enum].sort()]);
    }

    for (const key of ['properties', 'definitions']) {
        if (node[key] && typeof node[key] === 'object') {
            for (const [childKey, childVal] of Object.entries(node[key])) {
                collectRequiredAndEnums(childVal, [...pathParts, key, childKey], out);
            }
        }
    }
    if (node.items) {
        collectRequiredAndEnums(node.items, [...pathParts, 'items'], out);
    }
    for (const key of ['allOf', 'oneOf', 'anyOf']) {
        if (Array.isArray(node[key])) {
            node[key].forEach((child, i) => collectRequiredAndEnums(child, [...pathParts, key, String(i)], out));
        }
    }
    for (const key of ['if', 'then', 'else']) {
        if (node[key]) {
            collectRequiredAndEnums(node[key], [...pathParts, key], out);
        }
    }
}

function factsOf(schema) {
    const out = [];
    collectRequiredAndEnums(schema, [], out);
    out.sort(([a], [b]) => a.localeCompare(b));
    return out;
}

describe('fallback/on-disk agreement (the anti-drift guard)', () => {
    test('the fallback literal and the on-disk schema declare identical required/enum sets at every path', () => {
        const diskFacts = factsOf(diskSchema);
        const fallbackFacts = factsOf(FALLBACK_sprintDoctorVerdict);
        assert.deepStrictEqual(
            fallbackFacts,
            diskFacts,
            'FALLBACK_sprintDoctorVerdict (contracts.mjs) has drifted from apra-pm/agents/schemas/sprint-doctor-output.json -- '
            + 'update whichever one is stale so a packaging failure never silently falls back to a looser or stricter contract.',
        );
        assert.ok(diskFacts.length > 0, 'sanity: the walk must actually find required/enum facts to compare');
    });

    test('both schemas compile under ajv (strict:false) and agree on every fixture in this file', () => {
        const validateFallback = new Ajv({ strict: false }).compile(FALLBACK_sprintDoctorVerdict);
        const cases = [
            baseVerdict({ action: { kind: 'retry_different_member' } }),
            baseVerdict({ action: { kind: 'retry_same', timeoutMultiplier: 3 } }), // invalid
            baseVerdict({ probes: ['not_a_real_probe'] }), // invalid
            baseVerdict({
                classification: 'ENGINE_FLAW',
                action: { kind: 'retry_same' },
                engineFlawReport: { symptom: 's', suspectedComponent: 'c', reproEvidence: ['r'], proposedBeadTitle: 't' },
            }),
        ];
        for (const data of cases) {
            assert.strictEqual(validateFallback(data), validateOnDisk(data), `disk/fallback disagreed on: ${JSON.stringify(data)}`);
        }
    });
});
