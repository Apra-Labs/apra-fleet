import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    vetKbWork, createKbWorkClient, KB_CAPTURE_TRIGGERS,
    KB_MAX_CAPTURE_TITLE, KB_MAX_CAPTURE_SUMMARY, KB_MAX_CAPTURE_CONTENT,
} from '../fleet-sprint/kb.mjs';
import { selfMaintainer } from './helpers/kb-maintainer-fakes.mjs';

// =============================================================================
// The engine's capture gate: a kb_captures entry must carry one of the six
// triggers and pass the capture lint (ASCII only, length caps, no content that
// repeats the summary, no line-number-only reference, no placeholder token, no
// first-person narrative, failed-attempt needs Cause and Rule/Fix sections).
// content is optional. Every refusal names the capture and the rule, and a
// refused capture never becomes a kb_capture call.
// =============================================================================

const GOOD = Object.freeze({
    type: 'knowledge',
    title: 'Retry budget is read once at startup',
    summary: 'The retry budget is read once at boot; editing it needs a service restart.',
    trigger: 'hidden-invariant',
    source_files: ['src/retry.ts'],
    symbols: ['loadRetryBudget'],
});

const one = (role, capture) => vetKbWork(role, { kb_captures: [capture] });

function refusedBy(capture, rule) {
    const { captures, refused } = one('doer', capture);
    assert.deepEqual(captures, [], `capture must be refused by rule ${rule}`);
    assert.equal(refused.length, 1);
    assert.ok(refused[0].includes(`"${capture.title}"`), `refusal names the capture title: ${refused[0]}`);
    assert.ok(refused[0].includes(`rule ${rule}`), `refusal names rule ${rule}: ${refused[0]}`);
}

describe('passing captures', () => {
    test('an env-quirk naming a hostname:port and a URL with no symbols is not a line reference', () => {
        for (const summary of [
            'npm install behind the corporate proxy fails until registry.npmjs.org:443 is allowlisted.',
            'The health probe calls https://ci.example.dev:8080/health and 10.0.0.5:5432 before boot.',
        ]) {
            const { captures, refused } = one('doer', { ...GOOD, trigger: 'env-quirk', symbols: [], summary });
            assert.deepEqual(refused, [], summary);
            assert.equal(captures.length, 1);
        }
    });

    test('a capture with no content is forwarded with trigger and no content key', () => {
        const { captures, refused } = one('doer', GOOD);
        assert.deepEqual(refused, []);
        assert.equal(captures.length, 1);
        assert.equal(captures[0].trigger, 'hidden-invariant');
        assert.ok(!('content' in captures[0]), 'no content key is forwarded');
    });

    test('empty or whitespace content forwards no content key', () => {
        for (const content of ['', '   ', null]) {
            const { captures, refused } = one('doer', { ...GOOD, content });
            assert.deepEqual(refused, [], `content ${JSON.stringify(content)} is accepted`);
            assert.ok(!('content' in captures[0]));
        }
    });

    test('a Windows path quirk with error signatures carrying digits passes and forwards cues', () => {
        const capture = {
            type: 'learning',
            title: 'Windows rejects long paths under node_modules',
            summary: 'On Windows a path over 260 chars under C:\\Users\\dev\\app fails to open unless long paths are enabled.',
            trigger: 'env-quirk',
            content: 'Symptom: npm ci fails with ENAMETOOLONG on deeply nested packages.\n'
                + 'Rule/Fix: enable LongPathsEnabled in the registry, or install from a shorter root such as C:\\w.',
            source_files: ['scripts/install.ps1'],
            symbols: [],
            recall_cues: ['long path', 'ENAMETOOLONG on Windows'],
            error_signatures: ['Error: ENAMETOOLONG: name too long', 'exit code 0x80070006', 'error TS2345'],
        };
        const { captures, refused } = one('doer', capture);
        assert.deepEqual(refused, []);
        assert.equal(captures.length, 1);
        assert.equal(captures[0].content, capture.content);
        assert.deepEqual(captures[0].recall_cues, capture.recall_cues);
        assert.deepEqual(captures[0].error_signatures, capture.error_signatures);
    });

    test('a failed-attempt capture with Cause and Rule/Fix sections passes', () => {
        const content = 'Tried (failed): raising the timeout.\nCause: the lock file is keyed on the branch name.\n'
            + 'Rule/Fix: run the two suites in separate invocations.';
        const { captures, refused } = one('reviewer', { ...GOOD, trigger: 'failed-attempt', content });
        assert.deepEqual(refused, []);
        assert.equal(captures[0].content, content);
    });

    test('a path:line reference passes when a symbol is named', () => {
        const { refused } = one('doer', { ...GOOD, summary: 'loadRetryBudget at src/retry.ts:42 reads the budget once at boot.' });
        assert.deepEqual(refused, []);
    });

    test('every one of the six triggers is accepted', () => {
        assert.equal(KB_CAPTURE_TRIGGERS.length, 6);
        for (const trigger of KB_CAPTURE_TRIGGERS) {
            const content = 'Cause: the budget is cached at boot.\nRule/Fix: restart the service after editing it.';
            assert.deepEqual(one('doer', { ...GOOD, trigger, content }).refused, [], trigger);
        }
    });
});

describe('every refusal rule', () => {
    test('trigger missing', () => {
        const { trigger, ...noTrigger } = GOOD;
        refusedBy(noTrigger, 'trigger');
    });
    test('trigger not one of the six', () => refusedBy({ ...GOOD, trigger: 'describes-the-change' }, 'trigger'));
    test('content not a string', () => refusedBy({ ...GOOD, content: 42 }, 'content'));
    test('recall_cues not an array of strings', () => refusedBy({ ...GOOD, recall_cues: 'retry' }, 'cues'));
    test('error_signatures not an array of strings', () => refusedBy({ ...GOOD, error_signatures: [404] }, 'cues'));
    test('non-ASCII in the summary', () => refusedBy({ ...GOOD, summary: 'The budget \u2014 read once at boot.' }, 'ascii-only'));
    test('non-ASCII in an error signature', () => refusedBy({ ...GOOD, error_signatures: ['caf\u00e9 failed'] }, 'ascii-only'));
    test('title over the cap', () => refusedBy({ ...GOOD, title: 't'.repeat(KB_MAX_CAPTURE_TITLE + 1) }, 'length'));
    test('summary over the cap', () => refusedBy({ ...GOOD, summary: 's'.repeat(KB_MAX_CAPTURE_SUMMARY + 1) }, 'length'));
    test('content over the cap', () => refusedBy({ ...GOOD, content: 'c'.repeat(KB_MAX_CAPTURE_CONTENT + 1) }, 'length'));
    test('content equal to the summary after normalisation', () => {
        refusedBy({ ...GOOD, content: GOOD.summary.toUpperCase().replace(/;/g, ' ,') }, 'content-repeats-summary');
    });
    test('content that is the summary plus fewer than 40 extra chars', () => {
        refusedBy({ ...GOOD, content: `${GOOD.summary} See the boot path.` }, 'content-repeats-summary');
    });
    test('a path:digits reference with no symbol named', () => {
        refusedBy({ ...GOOD, symbols: [], summary: 'The budget is read at src/retry.ts:42 during boot.' }, 'line-number-only');
    });
    test('a bare source file name:digits or a Windows path:digits with no symbol named', () => {
        refusedBy({ ...GOOD, symbols: [], summary: 'The budget is read at kb.mjs:130 during boot.' }, 'line-number-only');
        refusedBy({ ...GOOD, symbols: [], summary: 'The budget is read at C:\\src\\boot.cs:7 during boot.' }, 'line-number-only');
    });
    test('the phrase "line N" with no symbol named', () => {
        refusedBy({ ...GOOD, symbols: undefined, summary: 'The budget is read on line 42 of the boot file.' }, 'line-number-only');
    });
    test('a double-brace placeholder token', () => {
        refusedBy({ ...GOOD, content: 'Deploy passes the token as {{vault.API_KEY}} through the environment of the job.' }, 'placeholder');
    });
    test('a first-person word (we)', () => refusedBy({ ...GOOD, summary: 'We found the budget is read once at boot.' }, 'first-person'));
    test('a first-person word (I, case-sensitive)', () => refusedBy({ ...GOOD, summary: 'After that I restarted the service and it worked.' }, 'first-person'));
    test('a first-person word in recall_cues', () => refusedBy({ ...GOOD, recall_cues: ['why our retries stall'] }, 'first-person'));
    test('failed-attempt with no content', () => refusedBy({ ...GOOD, trigger: 'failed-attempt' }, 'failed-attempt-sections'));
    test('failed-attempt with Cause but no Rule/Fix', () => {
        refusedBy({ ...GOOD, trigger: 'failed-attempt', content: 'Cause: the lock file is keyed on the branch name only.' }, 'failed-attempt-sections');
    });
    test('failed-attempt with Rule/Fix but no Cause', () => {
        refusedBy({ ...GOOD, trigger: 'failed-attempt', content: 'Rule/Fix: run the two suites in separate test invocations.' }, 'failed-attempt-sections');
    });
});

describe('lint does not reject reasonable text', () => {
    test('lowercase i, dotted names, region names and Windows home paths are not first-person', () => {
        const summary = 'for i in range: us-east-1 reads my.cnf from C:\\Users\\me\\app and I/O stays bounded.';
        assert.deepEqual(one('doer', { ...GOOD, summary }).refused, []);
    });
});

describe('a refused capture never becomes a kb_capture call', () => {
    test('only the good capture is forwarded; the bad one is logged with its rule', async () => {
        const MAINT = { id: 'm-1', name: 'maint', type: 'remote' };
        const calls = [];
        const logs = [];
        const client = createKbWorkClient({
            maintainers: selfMaintainer(MAINT, ['doer', 'maint']),
            memberCall: async (member, tool, args) => { calls.push({ tool, args }); return {}; },
            gPull: async () => {},
            log: (m) => logs.push(m),
        });
        const bad = { ...GOOD, title: 'A capture with no trigger at all', trigger: undefined };
        const out = await client.apply('doer', 'doer', { kb_captures: [bad, GOOD] });
        assert.equal(out.refused, 1);
        assert.equal(out.captured, 1);
        const captureCalls = calls.filter((c) => c.tool === 'kb_capture');
        assert.equal(captureCalls.length, 1);
        assert.equal(captureCalls[0].args.title, GOOD.title);
        assert.equal(captureCalls[0].args.trigger, 'hidden-invariant');
        assert.ok(!('content' in captureCalls[0].args));
        assert.ok(logs.some((l) => l.includes('refused') && l.includes(bad.title) && l.includes('rule trigger')), logs.join('\n'));
    });

    test('a payload of only refused captures makes no member call at all', async () => {
        const calls = [];
        const client = createKbWorkClient({
            maintainers: selfMaintainer({ id: 'm-1', name: 'maint', type: 'remote' }, ['doer', 'maint']),
            memberCall: async (member, tool) => { calls.push(tool); return {}; },
            gPull: async () => { calls.push('gpull'); },
            log: () => {},
        });
        const out = await client.apply('doer', 'doer', { kb_captures: [{ ...GOOD, trigger: 'nope' }] });
        assert.equal(out.refused, 1);
        assert.deepEqual(calls, []);
        assert.equal(client.pendingCount(), 0, 'nothing was enqueued');
    });
});
