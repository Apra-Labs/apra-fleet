import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vetKbWork as runnerVet } from '../fleet-sprint/runner.js';
import { KB_CAPTURE_TRIGGERS as engineTriggers } from '../fleet-sprint/kb.mjs';
import { vetKbWork as pmVet, KB_CAPTURE_TRIGGERS as pmTriggers } from '../apra-pm/lib/vet-kb-work.mjs';

// apra-fleet-4wz.9: the KB payload vetting rules exist in THREE places and no
// two of them can import each other:
//
//   1. apra-pm/.claude/workflows/auto-sprint.js -- executed by Claude's Workflow
//      tool in a VM with no filesystem and no require(), so it cannot import
//      anything at all.
//   2. apra-pm/lib/vet-kb-work.mjs -- its testable mirror (the established
//      lib/parse-sprint-args.mjs precedent).
//   3. fleet-sprint/runner.js -- a separate package with no shared module.
//
// A shared module is therefore not available, so this is the drift guard
// instead: the two IMPORTABLE copies must agree on every rule, and the third
// (the workflow script, reachable only as text) must carry the same constants.
// Modelled on apra-pm's auto-sprint-schemas-drift.test.mjs, which guards the
// inlined role schemas the same way.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTO_SPRINT = path.join(__dirname, '..', 'apra-pm', '.claude', 'workflows', 'auto-sprint.js');

const GOOD_CAPTURE = {
    type: 'knowledge',
    title: 'A durable claim title',
    summary: 'A summary long enough to be meaningful about the repo.',
    trigger: 'hidden-invariant',
    source_files: ['src/real.ts'],
    symbols: ['realSymbol'],
};
const LONG_CONTENT = 'Context: the retry budget is read once at startup. Rule/Fix: restart the '
    + 'service after editing the budget, a live reload never picks it up.';
const FAILED_CONTENT = 'Cause: the cache is keyed by tenant only.\nRule/Fix: key it by tenant and id.';
const GOOD_REASON = 'Verified against src/real.ts: the retry budget is read once at startup.';

// Every rule both copies must decide identically. Each case is (role, payload).
const CASES = [
    ['doer', { kb_captures: [GOOD_CAPTURE] }],
    ['reviewer', { kb_captures: [GOOD_CAPTURE] }],
    ['planner', { kb_captures: [GOOD_CAPTURE] }],
    ['harvester', { kb_captures: [GOOD_CAPTURE] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, source_files: [] }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, source_files: undefined }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, type: 'user-directive' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, type: 'context-cache' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, type: 'nonsense' }] }],
    ['doer', { kb_captures: [{ type: 'knowledge', source_files: ['src/a.ts'] }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, symbols: undefined }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, source_files: [] }, GOOD_CAPTURE] }],
    ['reviewer', { kb_promotions: [{ id: 'abc', reason: GOOD_REASON }] }],
    ['reviewer', { kb_promotions: [{ id: 'abc', reason: 'ok' }] }],
    ['reviewer', { kb_promotions: [{ id: 'abc', reason: '' }] }],
    ['reviewer', { kb_promotions: [{ id: 'abc', reason: '   ' }] }],
    ['reviewer', { kb_promotions: [{ reason: GOOD_REASON }] }],
    ['reviewer', { kb_promotions: [{ id: 'abc', reason: 'x'.repeat(20) }] }],
    ['reviewer', { kb_promotions: [{ id: 'abc', reason: 'x'.repeat(19) }] }],
    ['doer', { kb_promotions: [{ id: 'abc', reason: GOOD_REASON }] }],
    ['planner', { kb_promotions: [{ id: 'abc', reason: GOOD_REASON }] }],
    ['harvester', { kb_promotions: [{ id: 'abc', reason: GOOD_REASON }] }],
    ['deployer', { kb_promotions: [{ id: 'abc', reason: GOOD_REASON }] }],
    ['doer', { kb_captures: [GOOD_CAPTURE], kb_promotions: [{ id: 'abc', reason: GOOD_REASON }] }],
    ['doer', {}],
    ['doer', null],
    ['doer', undefined],
    ['doer', { kb_captures: [], kb_promotions: [] }],
    // trigger: required, one of the six values.
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, trigger: undefined }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, trigger: 'describes-the-change' }] }],
    ...['failed-attempt', 'review-finding', 'test-failure', 'env-quirk', 'hidden-invariant', 'design-rationale']
        .map((trigger) => ['doer', { kb_captures: [{ ...GOOD_CAPTURE, trigger, content: FAILED_CONTENT }] }]),
    // content optional: absent, empty and whitespace are accepted with no content key.
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, content: '' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, content: '   ' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, content: LONG_CONTENT }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, content: 42 }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, recall_cues: ['retry budget'], error_signatures: ['E-CODE-404: not found'] }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, recall_cues: 'retry budget' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, error_signatures: [7] }] }],
    // wrong JSON types the permissive report schema lets through.
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, source_files: [1] }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, source_files: 'src/real.ts' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, symbols: 'x' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, symbols: [1] }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, symbols: null }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, content: null }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, recall_cues: null }] }],
    ['doer', { kb_captures: [null, 42, 'x', [], GOOD_CAPTURE] }],
    // lint rules, one failing case each.
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, summary: 'A summary with a non-ASCII dash \u2014 in it.' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, recall_cues: ['caf\u00e9'] }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, title: 't'.repeat(160) }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, title: 't'.repeat(161) }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, title: 't'.repeat(7) }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, summary: 's'.repeat(500) }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, summary: 's'.repeat(501) }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, summary: 's'.repeat(19) }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, content: 'too short' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, content: 'c '.repeat(1001) + 'end' }] }],
    // first-person precision.
    ...['Deploy only in the US region, the EU one lacks it.', 'Phase I and Type I builds skip the check step.', 'The poll waits 50 us between reads of the flag.',
        'Intel ME holds the port, so WE pin is unrelated.', 'The tool prints "We could not find that package" and exits.', 'The error text `my key is bad` comes from the agent.']
        .map((summary) => ['doer', { kb_captures: [{ ...GOOD_CAPTURE, summary }] }]),
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, summary: 'Our retries stall once the budget is read at boot.' }] }],
    // section headings: CRLF and Root cause.
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, trigger: 'failed-attempt', content: 'Cause\r\nthe cache is keyed by tenant only.\r\nRule/Fix\r\nkey it by tenant and id.' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, trigger: 'failed-attempt', content: 'Root cause: the cache is keyed by tenant only.\nFix: key it by tenant and id.' }] }],
    // ccTLD hosts are not line references; multi-dot file names still are.
    ...['Connect to api.example.pl:443 fails behind the proxy.', 'Mirror mirror.example.sh:22 rejects keys at the gate.', 'The registry example.pl:443 needs an allowlist entry.', 'The image ghcr.io/org/app.server:20 pins the runtime.',
        'The budget is read at a.test.ts:42 during boot.', 'The budget is read at kb.md:130 during boot.', 'The budget is read at example.py:17 during boot.']
        .map((summary) => ['doer', { kb_captures: [{ ...GOOD_CAPTURE, trigger: 'env-quirk', symbols: [], summary }] }]),
    // near-duplicate content.
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, summary: 'The retry budget is read once at boot. Editing the budget needs a service restart.', content: 'Editing the budget needs a service restart. The retry budget is read once at boot.' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, summary: 'The retry budget is read once at boot. Editing the budget needs a service restart.', content: 'The retry budget is loaded once at startup. Editing the budget needs a service restart.' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, summary: 'The retry budget is read once at boot. Editing the budget needs a service restart.', content: 'The retry budget is read once at boot. Editing the budget' }] }],
    // secrets, built by concatenation.
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, summary: `The job authenticates with ${'gh' + 'p_' + 'a'.repeat(36)} in the header.` }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, content: `The header is Authorization: ${'Bear' + 'er ' + 'b'.repeat(40)} on every request made.` }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, content: GOOD_CAPTURE.summary }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, content: `${GOOD_CAPTURE.summary} Also true.` }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, symbols: [], summary: 'The budget is read at src/real.ts:42 during boot.' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, symbols: [], summary: 'The budget is read on line 42 of the boot file.' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, symbols: [], summary: 'The budget is read at kb.mjs:130 during boot.' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, symbols: [], summary: 'The budget is read at C:\\src\\boot.cs:7 during boot.' }] }],
    // hostname:port and URL authorities are not line references.
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, trigger: 'env-quirk', symbols: [], summary: 'npm install behind the corporate proxy fails until registry.npmjs.org:443 is allowlisted.' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, trigger: 'env-quirk', symbols: [], summary: 'The health probe calls https://ci.example.dev:8080/health and 10.0.0.5:5432 before boot.' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, summary: 'The budget is read at src/real.ts:42 in realSymbol.' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, summary: 'The token is passed as {{vault.API_KEY}} in the deploy step.' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, summary: 'We found the retry budget is read once at startup.' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, summary: 'Then I restarted the service and the budget changed.' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, summary: 'Deploys to us-east-1 read my.cnf from C:\\Users\\me\\app.' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, trigger: 'failed-attempt' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, trigger: 'failed-attempt', content: 'Cause: the cache is keyed by tenant only, so ids collide.' }] }],
    ['doer', { kb_captures: [{ ...GOOD_CAPTURE, trigger: 'failed-attempt', content: 'Rule/Fix: key the cache by tenant and id, never by tenant only.' }] }],
    // kb_rejects: reviewer-only, needs evidence, conflicts with a promotion.
    ['reviewer', { kb_rejects: [{ id: 'abc', reason: GOOD_REASON }] }],
    ['reviewer', { kb_rejects: [{ id: 'abc', reason: 'too short' }] }],
    ['reviewer', { kb_rejects: [{ reason: GOOD_REASON }] }],
    ['reviewer', { kb_rejects: [{ id: 'abc', reason: 'x'.repeat(19) }] }],
    ['doer', { kb_rejects: [{ id: 'abc', reason: GOOD_REASON }] }],
    ['planner', { kb_rejects: [{ id: 'abc', reason: GOOD_REASON }] }],
    ['reviewer', { kb_promotions: [{ id: 'abc', reason: GOOD_REASON }], kb_rejects: [{ id: 'abc', reason: GOOD_REASON }] }],
    ['reviewer', { kb_promotions: [{ id: 'abc', reason: GOOD_REASON }], kb_rejects: [{ id: 'def', reason: GOOD_REASON }] }],
];

describe('vetKbWork copies do not drift (apra-fleet-4wz.9)', () => {
    for (const [role, payload] of CASES) {
        test(`${role} :: ${JSON.stringify(payload)?.slice(0, 70) ?? String(payload)}`, () => {
            const a = runnerVet(role, payload);
            const b = pmVet(role, payload);
            assert.deepEqual(a.captures, b.captures, 'captures differ between the two copies');
            assert.deepEqual(a.promotions, b.promotions, 'promotions differ between the two copies');
            assert.deepEqual(a.rejects, b.rejects, 'rejects differ between the two copies');
            // The refusal REASONS are prose and may be worded per engine, but the
            // COUNT of refusals must match -- a rule that fires in one copy and
            // not the other is exactly the drift this guards.
            assert.equal(
                (a.refused ?? a.rejected).length,
                (b.refused ?? b.rejected).length,
                'refusal count differs between the two copies',
            );
        });
    }
});

describe('the workflow copy carries the same constants', () => {
    const src = fs.readFileSync(AUTO_SPRINT, 'utf-8');

    test('auto-sprint.js restricts promotion to the reviewer', () => {
        assert.match(src, /KB_PROMOTER_ROLES\s*=\s*new Set\(\['reviewer'\]\)/);
    });

    test('auto-sprint.js uses the same minimum promote-reason length', () => {
        assert.match(src, /KB_MIN_PROMOTE_REASON\s*=\s*20/);
    });

    test('auto-sprint.js allows exactly the same capture types', () => {
        assert.match(src, /\['knowledge',\s*'learning',\s*'runbook'\]/);
    });

    test('auto-sprint.js still refuses a capture with no source files', () => {
        assert.match(src, /cites no source files/);
    });

    test('auto-sprint.js still refuses a promotion with no recorded evidence', () => {
        assert.match(src, /no recorded evidence/);
    });

    test('every copy carries the same six capture triggers as the output schema', () => {
        const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'apra-pm', 'agents', 'schemas', 'doer-output.json'), 'utf-8'));
        const schemaTriggers = schema.properties.kb_captures.items.properties.trigger.examples;
        assert.deepEqual([...engineTriggers], schemaTriggers);
        assert.deepEqual([...pmTriggers], schemaTriggers);
        const m = src.match(/KB_CAPTURE_TRIGGERS\s*=\s*\[([^\]]*)\]/);
        assert.ok(m, 'auto-sprint.js declares KB_CAPTURE_TRIGGERS');
        assert.deepEqual(m[1].split(',').map((t) => t.trim().replace(/'/g, '')).filter(Boolean), schemaTriggers);
    });

    const pmSrc = fs.readFileSync(path.join(__dirname, '..', 'apra-pm', 'lib', 'vet-kb-work.mjs'), 'utf-8');
    const kbSrc = fs.readFileSync(path.join(__dirname, '..', 'fleet-sprint', 'kb.mjs'), 'utf-8');
    const copies = [['auto-sprint.js', src], ['vet-kb-work.mjs', pmSrc], ['kb.mjs', kbSrc]];

    // Every lint constant and regex, as its declaration text with any export
    // keyword dropped, in all three copies.
    const LINT_CONSTANTS = [
        'KB_MIN_CAPTURE_TITLE', 'KB_MAX_CAPTURE_TITLE', 'KB_MIN_CAPTURE_SUMMARY', 'KB_MAX_CAPTURE_SUMMARY',
        'KB_MIN_CAPTURE_CONTENT', 'KB_MAX_CAPTURE_CONTENT', 'KB_MIN_CONTENT_EXTRA',
        'KB_REPEAT_MIN_OVERLAP', 'KB_REPEAT_MAX_NEW_WORDS',
        'KB_PLACEHOLDER_RE', 'KB_SECRET_RE', 'KB_FIRST_PERSON_RE', 'KB_FIRST_PERSON_I_RE', 'KB_LINE_REF_RE',
        'KB_CAUSE_SECTION_RE', 'KB_RULE_FIX_SECTION_RE',
    ];
    for (const name of LINT_CONSTANTS) {
        test(`${name} is declared identically in every copy`, () => {
            const declaration = (text) => {
                const m = text.match(new RegExp(`^(?:export )?const ${name} = (.*)$`, 'm'));
                assert.ok(m, `${name} found`);
                return m[1].trimEnd();
            };
            const [[, first], ...rest] = copies;
            for (const [file, text] of rest) assert.equal(declaration(text), declaration(first), `${name} differs in ${file}`);
        });
    }

    // Every lint function, compared with indentation normalised: kb.mjs indents
    // by 4, the other two by 2, and all three are otherwise byte-identical.
    for (const fn of ['kbNormText', 'kbWithoutQuoted', 'kbRepeatsSummary', 'lintKbCapture']) {
        test(`${fn} is identical in every copy`, () => {
            const body = (text) => {
                const m = text.match(new RegExp(`\\nfunction ${fn}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n\\}\\n`));
                assert.ok(m, `${fn} found`);
                return m[0].replace(/^ +/gm, '');
            };
            const [[, first], ...rest] = copies;
            for (const [file, text] of rest) assert.equal(body(text), body(first), `${fn} differs in ${file}`);
        });
    }

    test('auto-sprint.js still refuses kb_promotions from a non-reviewer role', () => {
        assert.match(src, /promotion is reviewer-only/);
    });
});
