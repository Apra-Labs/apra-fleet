import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbPrimingClient } from '../fleet-sprint/kb.mjs';
import { createMemberCall } from '../fleet-sprint/member-call.mjs';
import { toolsOfAnswer, lastJsonValue, RAW_ANSWER_WARN_CHARS } from '../fleet-sprint/tools-list.mjs';

// =============================================================================
// The maintainer's tools/list answer gates the sprint-start bible import
// (kb_import must advertise `ref`). Every valid answer shape must be read; a
// genuinely unparseable one is retried once, then WARNed with the member name
// and the first 200 chars of the raw answer, and the import skip is reported.
// =============================================================================

const MAINT = { id: 'id-maint', name: 'maint', type: 'remote' };
const KB_IMPORT = { name: 'kb_import', inputSchema: { type: 'object', properties: { path: {}, ref: {}, skip_sweep: {} } } };
const KB_QUERY = { name: 'kb_query', inputSchema: { type: 'object', properties: { query: {} } } };
const TOOLS = [KB_IMPORT, KB_QUERY];
const NAMES = ['kb_import', 'kb_query'];

const PRETTY = JSON.stringify({ tools: TOOLS }, null, 2);

/** One entry per answer shape the reader must accept. */
const SHAPES = {
    'bare array': TOOLS,
    '{tools}': { tools: TOOLS },
    'JSON-RPC envelope': { jsonrpc: '2.0', id: 7, result: { tools: TOOLS } },
    'MCP content-text wrapper': { content: [{ type: 'text', text: JSON.stringify({ tools: TOOLS }) }] },
    'pretty-printed multi-line JSON': PRETTY,
    'JSON with leading and trailing log lines': `[info] starting member session\nwarn: something {odd}\n${PRETTY}\n[info] session closed\n`,
};

function primingHarness(listTools) {
    const calls = [];
    const logs = [];
    const memberCall = async (member, tool, args) => {
        calls.push({ tool, args, member: member.name });
        if (tool === 'kb_session_prime') return { top_entries: [] };
        return { imported: 1, bible_source: args && args.ref };
    };
    const callTool = async (name, args) => (name === 'member_detail'
        ? { id: `id-${args.member_name}`, type: 'remote', folder: `/srv/${args.member_name}` }
        : {});
    const priming = createKbPrimingClient({
        callTool, memberCall, members: ['maint'], listTools, baseBranch: 'main',
        maintainers: { maintainerForMember: () => ({ repo: 'example.com/repo', member: MAINT.name, record: MAINT }) },
        log: (m) => logs.push(m),
    });
    return { priming, calls, logs, imports: () => calls.filter((c) => c.tool === 'kb_import') };
}

describe('tools/list answer shapes', () => {
    for (const [shape, answer] of Object.entries(SHAPES)) {
        test(`${shape}: the tool names are read and the bible import proceeds`, async () => {
            assert.deepEqual(toolsOfAnswer(answer).map((t) => t.name), NAMES);
            let lists = 0;
            const h = primingHarness(async () => { lists += 1; return answer; });
            await h.priming.primeAll();
            assert.equal(lists, 1, 'a readable answer is not retried');
            assert.equal(h.imports().length, 1, h.logs.join('\n'));
            assert.equal(h.imports()[0].args.ref, 'refs/remotes/origin/main');
            assert.ok(!h.logs.some((l) => /WARN/.test(l)), h.logs.join('\n'));
        });
    }

    test('a remote member whose --list-tools output is pretty-printed between log lines is read', async () => {
        const out = SHAPES['JSON with leading and trailing log lines'];
        const mc = createMemberCall({
            fleetApi: { executeCommand: async () => ({ content: [{ type: 'text', text: out }] }) },
            resolveTarget: async () => ({ os: 'linux', shell: '' }),
        });
        const answer = await mc.listTools({ id: '11111111-2222-4333-8444-555555555555', name: 'maint', type: 'remote' });
        assert.deepEqual(toolsOfAnswer(answer).map((t) => t.name), NAMES);
    });

    test('lastJsonValue returns the last top-level object, skipping braces inside strings', () => {
        assert.deepEqual(lastJsonValue('log {not json}\n{"a":"}{"}\n{\n  "b": [1, {"c": 2}]\n}\ntrailer'), { b: [1, { c: 2 }] });
        assert.equal(lastJsonValue('no json here'), null);
        assert.equal(lastJsonValue('[1,2]'), null, 'arrays only when asked');
        assert.deepEqual(lastJsonValue('[1,2]', { arrays: true }), [1, 2]);
    });
});

describe('unparseable tools/list answers', () => {
    test('garbage then a valid answer: exactly one retry, then the import proceeds', async () => {
        let lists = 0;
        const h = primingHarness(async () => { lists += 1; return lists === 1 ? 'garbage <html>' : { tools: TOOLS }; });
        await h.priming.primeAll();
        assert.equal(lists, 2);
        assert.equal(h.imports().length, 1, h.logs.join('\n'));
        assert.ok(!h.logs.some((l) => /WARN/.test(l)), h.logs.join('\n'));
    });

    test('a remote E-REMOTE-PARSE then a valid answer: exactly one retry, then the import proceeds', async () => {
        let execs = 0;
        const mc = createMemberCall({
            fleetApi: { executeCommand: async () => { execs += 1; return { content: [{ type: 'text', text: execs === 1 ? 'Segmentation fault' : JSON.stringify({ tools: TOOLS }) }] }; } },
            resolveTarget: async () => ({ os: 'linux', shell: '' }),
        });
        const h = primingHarness((member) => mc.listTools({ ...member, id: '11111111-2222-4333-8444-555555555555' }));
        await h.priming.primeAll();
        assert.equal(execs, 2);
        assert.equal(h.imports().length, 1, h.logs.join('\n'));
    });

    test('garbage twice: a WARN names the member and exactly the first 200 chars of the raw answer; the skip is reported', async () => {
        const raw = 'X'.repeat(150) + '<' + 'Y'.repeat(150) + 'TAIL-NEVER-QUOTED';
        let lists = 0;
        const h = primingHarness(async () => { lists += 1; return raw; });
        await h.priming.primeAll();
        assert.equal(lists, 2, 'one call plus exactly one retry');
        assert.equal(h.imports().length, 0);
        const warn = h.logs.find((l) => /WARN tools\/list answer/.test(l));
        assert.ok(warn, h.logs.join('\n'));
        assert.ok(warn.includes("member 'maint'"), warn);
        const quoted = warn.slice(warn.indexOf('): ') + 3);
        assert.equal(RAW_ANSWER_WARN_CHARS, 200);
        assert.equal(quoted, raw.slice(0, 200));
        assert.ok(!warn.includes('TAIL-NEVER-QUOTED'));
        assert.ok(h.logs.some((l) => /WARN bible import skipped for 'maint': its tools\/list answer was unreadable$/.test(l)), h.logs.join('\n'));
    });

    test('a thrown (non-parse) listTools failure is not retried', async () => {
        let lists = 0;
        const h = primingHarness(async () => { lists += 1; throw new Error('unreachable'); });
        await h.priming.primeAll();
        assert.equal(lists, 1);
        assert.ok(h.logs.some((l) => /bible import skipped for 'maint': its tools could not be listed \(unreachable\)$/.test(l)), h.logs.join('\n'));
    });
});
