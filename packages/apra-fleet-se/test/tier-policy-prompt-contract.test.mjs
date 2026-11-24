// Tier policy contract: the planner and plan-reviewer role prompts and the
// plan-reviewer output schema carry the owner-approved hard-bucket tier rules.
// Default doer tier standard, premium only with a tierReason naming one of the
// hard criteria H1-H6, cheap only for mechanical work, split first, single-tier
// lanes with riding [test] beads, and the premium cap from the dispatch prompt.
// Reads the SHIPPED markdown and schema files, not a copy of them.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { FALLBACK_SCHEMAS } from '../fleet-sprint/contracts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = path.join(ROOT, 'apra-pm/agents');
const read = (rel) => fs.readFileSync(path.join(AGENTS, rel), 'utf8');
// Collapse whitespace and drop markdown emphasis so a rule wrapped across lines
// or bolded still matches as one phrase.
const norm = (s) => s.replace(/\*\*/g, '').replace(/\s+/g, ' ');

const PLANNER = norm(read('planner.md'));
const REVIEWER = norm(read('plan-reviewer.md'));
const SCHEMA = JSON.parse(read('schemas/plan-reviewer-output.json'));

const HARD = [
    ['H1', 'Contract change'],
    ['H2', 'Concurrency or durability semantics'],
    ['H3', 'Security or trust boundary'],
    ['H4', 'Open design'],
    ['H5', 'Cross-cutting invariant'],
    ['H6', 'Diagnosis-first'],
];
const NEW_KINDS = ['tier_cap', 'tier_reason', 'tier_split', 'lane_tier'];

describe('planner.md encodes the tier policy', () => {
    test('names each hard criterion H1-H6 with its exact title', () => {
        for (const [id, name] of HARD) {
            assert.ok(PLANNER.includes(`${id} ${name}:`), `planner.md must define "${id} ${name}"`);
        }
    });

    test('standard is the default and premium needs a hard criterion', () => {
        assert.match(PLANNER, /standard is the DEFAULT doer tier/);
        assert.match(PLANNER, /premium -- ONLY when the bead meets at least one hard criterion H1-H6/);
    });

    test('tierReason is required for premium, in the same metadata channel as model', () => {
        assert.match(PLANNER, /tierReason \(required for every premium task\)/);
        assert.match(PLANNER, /SAME `--metadata` channel as `model`, key `tierReason`/);
        assert.match(PLANNER, /\{"model": "premium", "tierReason": "H2"\}/);
        assert.match(PLANNER, /`tierReason` is optional on cheap and standard tasks/);
    });

    test('split first, and an unsplittable bead keeps premium and counts toward the cap', () => {
        assert.match(PLANNER, /Split first\./);
        assert.match(PLANNER, /keep only the core on premium/);
        assert.match(PLANNER, /cannot be separated keeps premium and counts toward the premium cap/);
    });

    test('file count, size L, low KB coverage and [test] beads never force premium', () => {
        assert.match(PLANNER, /These NEVER force premium by themselves:/);
        assert.match(PLANNER, /File count or size `L`\. Size drives lane sizing \(below\), not the tier\./);
        assert.match(PLANNER, /Low or absent KB coverage\. It means "read more source first"/);
        assert.match(PLANNER, /A test bead is standard, unless it builds new test infrastructure that itself meets H1, H2 or H3/);
    });

    test('cheap is limited to mechanical work, never code logic', () => {
        assert.match(PLANNER, /cheap -- mechanical work ONLY: rename, move, config key, boilerplate, doc-only/);
        assert.match(PLANNER, /Never use cheap for a bead that writes or changes code logic/);
    });

    test('lanes are single-tier and a riding [test] bead takes the impl tier', () => {
        assert.match(PLANNER, /Single-tier lanes\./);
        assert.match(PLANNER, /Every work bead in a lane must carry the SAME `model` tier/);
        assert.match(PLANNER, /A `\[test\]` bead rides its impl bead's session at the impl's tier/);
        assert.match(PLANNER, /exempt from the premium cap and from this single-tier check/);
        // The effort formula no longer takes a maximum over mixed tiers.
        assert.doesNotMatch(PLANNER, /max model weight/);
        assert.match(PLANNER, /never take a maximum over mixed tiers/);
    });

    test('respects the premium cap given in the dispatch prompt', () => {
        assert.match(PLANNER, /`PREMIUM CAP` line/);
        assert.match(PLANNER, /ceil\(pct x task beads \/ 100\)/);
        assert.match(PLANNER, /cumulative across re-plans/);
        assert.match(PLANNER, /`tierEscalatedFrom` set\) and `\[test\]` beads riding an impl lane do not count/);
        assert.match(PLANNER, /No cap line in the prompt = no cap\./);
    });

    test('the coverage < 0.3 -> lean premium rule is gone', () => {
        assert.doesNotMatch(PLANNER, /coverage\s*<\s*0\.3/);
        assert.doesNotMatch(PLANNER, /lean (toward )?premium/i);
        assert.doesNotMatch(PLANNER, /lean toward a stronger model tier/);
    });
});

describe('plan-reviewer.md checks the tier policy', () => {
    test('names each hard criterion H1-H6 with its exact title', () => {
        for (const [id, name] of HARD) {
            assert.ok(REVIEWER.includes(`${id} ${name}:`), `plan-reviewer.md must define "${id} ${name}"`);
        }
    });

    test('the tier criterion runs under every policy and counts toward APPROVED', () => {
        assert.match(REVIEWER, /Model tier policy \(checked under every tier policy\)/);
        assert.match(REVIEWER, /all fourteen criteria in Step 2 pass/);
    });

    test('rejects an over-cap plan naming the beads, their tierReason and how many must move', () => {
        assert.match(REVIEWER, /Premium cap exceeded \(`kind: "tier_cap"`\)/);
        assert.match(REVIEWER, /one finding per premium bead, each naming its `tierReason`/);
        assert.match(REVIEWER, /how many premium beads must move/);
        assert.match(REVIEWER, /No cap line in the prompt = no cap check\./);
    });

    test('rejects a mixed-tier lane naming the lane, riding [test] beads exempt', () => {
        assert.match(REVIEWER, /Mixed-tier lane \(`kind: "lane_tier"`\)/);
        assert.match(REVIEWER, /name the lane \(`streak` id\) and each bead with its tier/);
        assert.match(REVIEWER, /`\[test\]` beads riding the lane at the impl tier are exempt/);
    });

    test('rejects a premium bead with missing or invalid tierReason', () => {
        assert.match(REVIEWER, /Missing or invalid tierReason \(`kind: "tier_reason"`\): a premium bead with no `tierReason` metadata, a value outside H1-H6, or a cited criterion its own text does not support/);
    });

    test('rejects a standard bead with an uncited H1-H6 signal', () => {
        assert.match(REVIEWER, /Uncited hard signal \(`kind: "tier_reason"`\): a standard \(or cheap\) bead whose text shows an H1-H6 signal it does not cite/);
    });

    test('flags a premium bead with separable non-hard parts as a split finding', () => {
        assert.match(REVIEWER, /Separable non-hard work \(`kind: "tier_split"`\)/);
    });

    test('lists every new kind in the Step 4 findings vocabulary', () => {
        for (const kind of NEW_KINDS) assert.ok(REVIEWER.includes(`\`${kind}\``), `plan-reviewer.md must list ${kind}`);
    });
});

describe('plan-reviewer-output.json accepts the tier finding kinds', () => {
    const verdict = (kind) => ({
        verdict: 'CHANGES_NEEDED',
        notes: 'Expected review rounds: 1.',
        findings: [{ id: 'BD-1', kind, detail: 'tier finding' }],
        taskAssignments: [{ id: 'BD-1', bucket: 'M', model: 'premium' }],
    });
    const shipped = new Ajv({ strict: false }).compile(SCHEMA);
    const fallback = new Ajv({ strict: false }).compile(FALLBACK_SCHEMAS.planReviewerVerdict);

    for (const kind of NEW_KINDS) {
        test(`accepts a finding of kind ${kind} (shipped schema and engine fallback)`, () => {
            assert.equal(shipped(verdict(kind)), true, JSON.stringify(shipped.errors));
            assert.equal(fallback(verdict(kind)), true, JSON.stringify(fallback.errors));
        });
    }

    test('still rejects an unknown kind', () => {
        assert.equal(shipped(verdict('tier_vibes')), false);
        assert.equal(fallback(verdict('tier_vibes')), false);
    });
});

describe('the tier prompts stay generic', () => {
    test('neither prompt file contains a bead id', () => {
        for (const file of ['planner.md', 'plan-reviewer.md']) {
            assert.doesNotMatch(read(file), /\bapra-fleet-[a-z0-9]{2,}(\.\d+)*\b/i, `${file} cites a bead id`);
        }
    });
});
