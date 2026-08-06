import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbPrimingClient, createKbWorkClient, vetKbWork } from '../fleet-sprint/runner.js';

// apra-fleet-e28 / KB trust pipeline Phase 2: the fleet-sprint engine had no KB
// priming -- it lived only in the Claude workflow copy.
//
// The property that matters most here is NEGATIVE: this engine has no repo path
// of its own, and kb_session_prime selects which project KB it reads from its
// repo_path argument. Calling it without one falls back to the fleet server's
// cwd, collapsing every member's knowledge into whichever repo the server sits
// in -- the apra-fleet-tm7 / apra-fleet-3zl repo-blindness defect. So a member
// whose work folder cannot be resolved must be SKIPPED, never primed blind.

function makeCallTool(folders, opts = {}) {
    const calls = [];
    return {
        calls,
        callTool: async (name, args) => {
            calls.push({ name, args });
            if (name === 'member_detail') {
                if (opts.throwOnDetail) throw new Error('transport exploded');
                const folder = folders[args.member_name];
                return folder === undefined ? {} : { folder };
            }
            if (name === 'kb_session_prime') {
                if (opts.throwOnPrime) throw new Error('kb unavailable');
                return { top_entries: [] };
            }
            return {};
        },
    };
}

describe('createKbPrimingClient (apra-fleet-e28)', () => {
    test('primes each member against its OWN work folder', async () => {
        const { calls, callTool } = makeCallTool({ alpha: '/srv/alpha/repo', beta: '/srv/beta/repo' });
        const client = createKbPrimingClient({ callTool, members: ['alpha', 'beta'], log: () => {} });

        const result = await client.primeAll();

        assert.equal(result.primed, 2);
        const primes = calls.filter((c) => c.name === 'kb_session_prime');
        assert.deepEqual(primes.map((c) => c.args.repo_path), ['/srv/alpha/repo', '/srv/beta/repo']);
    });

    test('NEVER calls kb_session_prime without a repo_path', async () => {
        const { calls, callTool } = makeCallTool({ alpha: '/srv/alpha/repo' });
        const client = createKbPrimingClient({ callTool, members: ['alpha'], log: () => {} });

        await client.primeAll();

        for (const c of calls.filter((c) => c.name === 'kb_session_prime')) {
            assert.ok(typeof c.args.repo_path === 'string' && c.args.repo_path.length > 0,
                'a prime call without repo_path would read the fleet server cwd');
        }
    });

    test('skips a member whose work folder cannot be resolved rather than priming blind', async () => {
        const { calls, callTool } = makeCallTool({ alpha: '/srv/alpha/repo' }); // beta has none
        const client = createKbPrimingClient({ callTool, members: ['alpha', 'beta'], log: () => {} });

        const result = await client.primeAll();

        assert.equal(result.primed, 1);
        assert.equal(result.skipped, 1);
        const primes = calls.filter((c) => c.name === 'kb_session_prime');
        assert.equal(primes.length, 1);
        assert.equal(primes[0].args.repo_path, '/srv/alpha/repo');
    });

    test('parses a member_detail result delivered as MCP content text', async () => {
        const calls = [];
        const callTool = async (name, args) => {
            calls.push({ name, args });
            if (name === 'member_detail') {
                return { content: [{ text: JSON.stringify({ folder: '/srv/wrapped/repo' }) }] };
            }
            return {};
        };
        const client = createKbPrimingClient({ callTool, members: ['alpha'], log: () => {} });

        const result = await client.primeAll();

        assert.equal(result.primed, 1);
        assert.equal(calls.find((c) => c.name === 'kb_session_prime').args.repo_path, '/srv/wrapped/repo');
    });

    // apra-fleet-n78: the mocks above answer member_detail with a folder no matter
    // what args they get, which is more generous than the real tool. member_detail's
    // `format` defaults to 'compact' (src/tools/member-detail.ts), and the compact
    // renderer emits no folder at all -- `folder: agent.workFolder` is set only on
    // the json path. So folderFor() has to ask for json explicitly, or it resolves
    // null for every member and the KB is never primed for anyone.
    test('asks member_detail for json -- compact carries no folder', async () => {
        const calls = [];
        const callTool = async (name, args) => {
            calls.push({ name, args });
            if (name === 'member_detail') {
                // Mirror the real tool: compact is prose, and has no folder in it.
                return args.format === 'json'
                    ? { content: [{ text: JSON.stringify({ folder: '/srv/alpha/repo' }) }] }
                    : { content: [{ text: '🤖 alpha (local) | online | os=linux | cli=2.1.223' }] };
            }
            return {};
        };
        const client = createKbPrimingClient({ callTool, members: ['alpha'], log: () => {} });

        const result = await client.primeAll();

        assert.equal(calls.find((c) => c.name === 'member_detail').args.format, 'json',
            'without format:json the compact text has no folder and every member is skipped');
        assert.equal(result.primed, 1);
        assert.equal(result.skipped, 0);
        assert.equal(calls.find((c) => c.name === 'kb_session_prime').args.repo_path, '/srv/alpha/repo');
    });

    test('is a no-op when callTool is absent (direct runSprintCycle/main test calls)', async () => {
        const client = createKbPrimingClient({ members: ['alpha'], log: () => {} });
        const result = await client.primeAll();
        assert.deepEqual(result, { primed: 0, skipped: 1 });
    });

    test('is a no-op when there are no members', async () => {
        const { calls, callTool } = makeCallTool({});
        const client = createKbPrimingClient({ callTool, members: [], log: () => {} });

        const result = await client.primeAll();

        assert.deepEqual(result, { primed: 0, skipped: 0 });
        assert.deepEqual(calls, []);
    });

    test('a failing prime is non-fatal and does not stop later members', async () => {
        const { callTool } = makeCallTool({ alpha: '/a', beta: '/b' }, { throwOnPrime: true });
        const client = createKbPrimingClient({ callTool, members: ['alpha', 'beta'], log: () => {} });

        const result = await client.primeAll();

        assert.equal(result.primed, 0);
        assert.equal(result.skipped, 2);
    });

    test('a failing member_detail is non-fatal', async () => {
        const { calls, callTool } = makeCallTool({ alpha: '/a' }, { throwOnDetail: true });
        const client = createKbPrimingClient({ callTool, members: ['alpha'], log: () => {} });

        const result = await client.primeAll();

        assert.equal(result.skipped, 1);
        assert.equal(calls.filter((c) => c.name === 'kb_session_prime').length, 0);
    });
});

// --- The execution half: the engine makes the calls, the role only decides ---

const GOOD_CAPTURE = {
    type: 'knowledge',
    title: 'getKbProviders is the only KB accessor',
    summary: 'Every kb_* tool routes through getKbProviders so the KB is repo-scoped.',
    content: 'getKbProviders(repo_path) resolves the per-repo sqlite store; every kb_* tool goes through it.',
    source_files: ['src/services/knowledge/kb-providers.ts'],
    symbols: ['getKbProviders'],
};
const GOOD_REASON = 'Verified against src/services/knowledge/kb-providers.ts: cache is keyed per slug.';

function recorder() {
    const calls = [];
    return { calls, callTool: async (name, args) => { calls.push({ name, args }); return {}; } };
}

// An MCP client's callTool RESOLVES with {isError:true} for a tool-level failure --
// it does not throw. A recorder that only ever returns {} cannot see that, which is
// why the apra-fleet-23c phantom-success bug was invisible to these tests.
function errorRecorder(message) {
    const calls = [];
    return {
        calls,
        callTool: async (name, args) => {
            calls.push({ name, args });
            return { isError: true, content: [{ type: 'text', text: message }] };
        },
    };
}

describe('createKbWorkClient (KB trust pipeline Phase 2, fleet-sprint half)', () => {
    test('a vetted capture becomes a real kb_capture call scoped to the repo', async () => {
        const { calls, callTool } = recorder();
        const client = createKbWorkClient({ callTool, log: () => {} });

        const out = await client.apply('doer', '/srv/alpha/repo', { kb_captures: [GOOD_CAPTURE] });

        assert.equal(out.captured, 1);
        const capture = calls.find((c) => c.name === 'kb_capture');
        assert.equal(capture.args.repo_path, '/srv/alpha/repo');
        assert.equal(capture.args.title, GOOD_CAPTURE.title);
    });

    test('a reviewer promotion becomes a real kb_promote call', async () => {
        const { calls, callTool } = recorder();
        const client = createKbWorkClient({ callTool, log: () => {} });

        const out = await client.apply('reviewer', '/srv/a', {
            kb_promotions: [{ id: 'abc123', reason: GOOD_REASON }],
        });

        assert.equal(out.promoted, 1);
        assert.deepEqual(calls.find((c) => c.name === 'kb_promote').args, { id: 'abc123', reason: GOOD_REASON });
    });

    // apra-fleet-23c: kbCaptureSchema requires content (z.string().min(1)), but
    // vetKbWork built its capture object from type/title/summary/source_files/symbols
    // only. Every kb_capture the sprint engine sent therefore failed zod validation
    // at the MCP boundary and persisted nothing, while the engine logged success.
    test('a capture carries content through -- kb_capture requires it', async () => {
        const { calls, callTool } = recorder();
        const client = createKbWorkClient({ callTool, log: () => {} });

        const out = await client.apply('doer', '/srv/a', { kb_captures: [GOOD_CAPTURE] });

        assert.equal(out.captured, 1);
        const capture = calls.find((c) => c.name === 'kb_capture');
        assert.equal(capture.args.content, GOOD_CAPTURE.content,
            'content is required by kbCaptureSchema; dropping it makes every capture a no-op');
    });

    test('a capture with no content is refused rather than sent to fail server-side', async () => {
        const { calls, callTool } = recorder();
        const client = createKbWorkClient({ callTool, log: () => {} });
        const { content, ...noContent } = GOOD_CAPTURE;

        const out = await client.apply('doer', '/srv/a', { kb_captures: [noContent] });

        assert.equal(out.captured, 0);
        assert.equal(calls.filter((c) => c.name === 'kb_capture').length, 0);
        assert.equal(out.refused, 1);
    });

    // apra-fleet-23c, second half: an MCP error result resolves, so `captured++` ran
    // on calls that wrote nothing and the run reported "captured 3, promoted 0".
    test('an MCP isError result counts as a failure, not a capture', async () => {
        const { calls, callTool } = errorRecorder('kb capture rejected: an entry must cite at least one source file');
        const client = createKbWorkClient({ callTool, log: () => {} });

        const out = await client.apply('doer', '/srv/a', { kb_captures: [GOOD_CAPTURE] });

        assert.equal(calls.length, 1, 'the call is still attempted');
        assert.equal(out.captured, 0, 'a tool-level error must not be counted as a successful capture');
    });

    test('an MCP isError result on kb_promote is not counted as promoted', async () => {
        const { callTool } = errorRecorder('no such entry');
        const client = createKbWorkClient({ callTool, log: () => {} });

        const out = await client.apply('reviewer', '/srv/a', {
            kb_promotions: [{ id: 'abc123', reason: GOOD_REASON }],
        });

        assert.equal(out.promoted, 0);
    });

    test('an unverifiable payload results in NO tool call', async () => {
        const { calls, callTool } = recorder();
        const client = createKbWorkClient({ callTool, log: () => {} });

        const out = await client.apply('doer', '/srv/a', {
            kb_captures: [{ ...GOOD_CAPTURE, source_files: [] }],
        });

        assert.equal(out.captured, 0);
        assert.equal(calls.length, 0);
    });

    test('kb_promotions from a non-reviewer role results in NO promote call', async () => {
        for (const role of ['doer', 'planner', 'harvester']) {
            const { calls, callTool } = recorder();
            const client = createKbWorkClient({ callTool, log: () => {} });

            const out = await client.apply(role, '/srv/a', {
                kb_promotions: [{ id: 'abc123', reason: GOOD_REASON }],
            });

            assert.equal(out.promoted, 0, `${role} must not promote`);
            assert.equal(calls.filter((c) => c.name === 'kb_promote').length, 0);
        }
    });

    test('without a repo path nothing is captured -- never resolved against the server cwd', async () => {
        const { calls, callTool } = recorder();
        const client = createKbWorkClient({ callTool, log: () => {} });

        const out = await client.apply('doer', null, { kb_captures: [GOOD_CAPTURE] });

        assert.equal(out.captured, 0);
        assert.equal(calls.length, 0);
    });

    test('a failing kb_capture is non-fatal and later entries still run', async () => {
        let n = 0;
        const callTool = async (name) => {
            if (name === 'kb_capture' && n++ === 0) throw new Error('rejected');
            return {};
        };
        const client = createKbWorkClient({ callTool, log: () => {} });

        const out = await client.apply('doer', '/srv/a', {
            kb_captures: [GOOD_CAPTURE, { ...GOOD_CAPTURE, title: 'A second durable claim' }],
        });

        assert.equal(out.captured, 1);
    });

    test('vetKbWork here agrees with apra-pm lib/vet-kb-work.mjs on the reviewer-only rule', () => {
        assert.deepEqual(vetKbWork('doer', { kb_promotions: [{ id: 'x', reason: GOOD_REASON }] }).promotions, []);
        assert.equal(vetKbWork('reviewer', { kb_promotions: [{ id: 'x', reason: GOOD_REASON }] }).promotions.length, 1);
    });
});
