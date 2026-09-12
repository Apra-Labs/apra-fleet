import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// apra-fleet-3swo.4.3: coordination.mjs owns the dolt-push-mutex clients, the
// child-id-allocator clients and the member-reservation-ledger client,
// extracted move-only out of runner.js. Imported directly from
// coordination.mjs (not the runner.js facade) so this suite proves the new
// module -- not just runner.js's re-export -- actually holds the
// implementation.
import {
    createHttpDoltPushMutexClient,
    createHttpChildIdAllocatorClient,
    createMcpDoltPushMutexClient,
    createMcpChildIdAllocatorClient,
    createMemberReservationClient,
} from '../fleet-sprint/coordination.mjs';
// Same symbols, resolved through the runner.js facade -- must be the exact
// same function objects (re-exported, not re-implemented).
import * as runner from '../fleet-sprint/runner.js';
// apra-fleet-3swo.4.5: the CLI->runner arg contract runner.js's real dispatch
// path validates `branch` through -- used by the new describe block below,
// which ties sprintMutexId back to this and to the documented cli.mjs
// ledger-key contract.
import { validateArgs } from '../fleet-sprint/sprint-args.mjs';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

describe('coordination.mjs is the single source of truth runner.js re-exports (apra-fleet-3swo.4.3)', () => {
    test('runner.js re-exports the identical function objects, not copies', () => {
        assert.equal(runner.createHttpDoltPushMutexClient, createHttpDoltPushMutexClient);
        assert.equal(runner.createHttpChildIdAllocatorClient, createHttpChildIdAllocatorClient);
        assert.equal(runner.createMcpDoltPushMutexClient, createMcpDoltPushMutexClient);
        assert.equal(runner.createMcpChildIdAllocatorClient, createMcpChildIdAllocatorClient);
        assert.equal(runner.createMemberReservationClient, createMemberReservationClient);
    });
});

describe('constructor error messages are byte-identical to the pre-move text (apra-fleet-3swo.4.3)', () => {
    test('createHttpDoltPushMutexClient requires a serviceUrl', () => {
        assert.throws(
            () => createHttpDoltPushMutexClient({}),
            { message: 'createHttpDoltPushMutexClient requires a serviceUrl' },
        );
    });

    test('createHttpDoltPushMutexClient requires a fetch implementation', () => {
        // `opts.fetch ?? globalThis.fetch` only falls back on a NULLISH
        // opts.fetch, so a present-but-non-function value (not null/undefined)
        // is what actually exercises the typeof guard on a Node >=18 runtime
        // where globalThis.fetch always exists.
        assert.throws(
            () => createHttpDoltPushMutexClient({ serviceUrl: 'http://x', fetch: 'not-a-function' }),
            { message: 'createHttpDoltPushMutexClient requires a fetch implementation (Node >=18 global fetch or an injected one)' },
        );
    });

    test('createMcpDoltPushMutexClient requires a callTool function', () => {
        assert.throws(
            () => createMcpDoltPushMutexClient({}),
            { message: 'createMcpDoltPushMutexClient requires a callTool function' },
        );
    });
});

describe('sprintMutexId flows through every coordination client verbatim -- unmodified, unprefixed, unreformatted (apra-fleet-3swo.4.3)', () => {
    // A deliberately "ugly" fixed input: mixed case, a slash (real sprint
    // branches look like this) and characters that WOULD change shape under
    // any accidental reformat/namespace/prefix step.
    const FIXED_SPRINT_ID = 'feat/Runner-Refactor_2026';

    test('createHttpDoltPushMutexClient sends the fixed sprintId, percent-encoded but otherwise untouched, on acquire/release/renew', async () => {
        const calls = [];
        const fetchImpl = async (url, opts) => {
            calls.push({ url, body: JSON.parse(opts.body) });
            return { ok: true, status: 200, json: async () => ({ token: 'tok', granted: true, released: true, renewed: true }) };
        };
        const client = createHttpDoltPushMutexClient({ serviceUrl: 'http://svc', sprintId: FIXED_SPRINT_ID, fetch: fetchImpl });
        await client.acquire(FIXED_SPRINT_ID, { pid: 123 });
        await client.release('tok');
        await client.renew('tok');

        const expectedEncoded = encodeURIComponent(FIXED_SPRINT_ID);
        assert.equal(calls.length, 3);
        for (const call of calls) {
            assert.ok(
                call.url.includes(`/api/dolt-push-mutex/${expectedEncoded}/`),
                `expected the exact percent-encoded fixed sprintId in the URL, got: ${call.url}`,
            );
        }
    });

    test('createMcpDoltPushMutexClient sends the fixed sprintId verbatim as sprint_id', async () => {
        const calls = [];
        const callTool = async (name, args) => {
            calls.push({ name, args });
            return { content: [{ type: 'text', text: JSON.stringify({ granted: true, token: 'tok' }) }] };
        };
        const client = createMcpDoltPushMutexClient({ callTool });
        await client.acquire(FIXED_SPRINT_ID, { pid: 1 });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].args.sprint_id, FIXED_SPRINT_ID, 'sprint_id must be the exact fixed input, unmodified');
    });

    test('createHttpChildIdAllocatorClient sends the fixed sprintId verbatim on allocate', async () => {
        const calls = [];
        const fetchImpl = async (url, opts) => {
            calls.push({ url, body: JSON.parse(opts.body) });
            return { ok: true, status: 200, json: async () => ({ childId: 'apra-fleet-x.1', seq: 1, token: 'tok' }) };
        };
        const client = createHttpChildIdAllocatorClient({ serviceUrl: 'http://svc', sprintId: FIXED_SPRINT_ID, fetch: fetchImpl });
        await client.allocate('apra-fleet-x');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].body.sprintId, FIXED_SPRINT_ID, 'sprintId must be the exact fixed input, unmodified');
    });

    test('createMcpChildIdAllocatorClient sends the fixed sprintId verbatim as sprint_id', async () => {
        const calls = [];
        const callTool = async (name, args) => {
            calls.push({ name, args });
            return { content: [{ type: 'text', text: JSON.stringify({ childId: 'apra-fleet-x.1', seq: 1, token: 'tok' }) }] };
        };
        const client = createMcpChildIdAllocatorClient({ callTool, sprintId: FIXED_SPRINT_ID });
        await client.allocate('apra-fleet-x');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].args.sprint_id, FIXED_SPRINT_ID, 'sprint_id must be the exact fixed input, unmodified');
    });

    test('createMemberReservationClient sends the fixed sprintId verbatim as sprint_id on reserve/release', async () => {
        const calls = [];
        const callTool = async (name, args) => {
            calls.push({ name, args });
            return { content: [{ text: '[+] ok' }] };
        };
        const client = createMemberReservationClient({ callTool, members: ['solo'], sprintId: FIXED_SPRINT_ID });
        await client.reserveAll();
        await client.releaseAll();
        assert.equal(calls.length, 2);
        for (const call of calls) {
            assert.equal(call.args.sprint_id, FIXED_SPRINT_ID, 'sprint_id must be the exact fixed input, unmodified');
        }
    });
});

// apra-fleet-3swo.4.5: sprintMutexId (fleet-sprint/runner.js's
// `const sprintMutexId = (args && args.branch) ? String(args.branch) : 'sprint';`,
// stamped as `sprint_id` on every real agent() dispatch) is documented in
// bin/cli.mjs (~L744-755, the effectiveRunId/createMemberReservationClient
// comments) as the SAME opaque per-sprint identity as:
//   - cli.mjs's own `sprintId: branchName` member-reservation reserve call, and
//   - the supervisor ledger-key fallback (`effectiveRunId = values['run-id']
//     || branchName`) used for a direct/standalone launch that has no
//     supervisor --run-id.
// This pins a FIXED (not per-test-run-computed) branch literal through a real
// mock sprint end to end and proves the actual dispatch code path -- not a
// re-derivation of the formula -- stamps every dispatch with exactly that
// literal, and that it is the same string sprint-args.mjs's validateArgs()
// (the one arg contract both cli.mjs and runner.js share) resolves `branch`
// to, and the same string a coordination.mjs member-reservation client built
// the way cli.mjs builds it actually sends on the wire.
describe('sprintMutexId for a fixed branch matches the identity the supervisor reservation ledger would key by (apra-fleet-3swo.4.5)', () => {
    const FIXED_BRANCH = 'feat/pin-mutex-ledger-3swo-4-5';

    test('every real dispatch is stamped with the pinned branch as sprint_id, matching validateArgs and a coordination.mjs reservation client', async () => {
        await withScenarioMarkers('pin sprintMutexId to the ledger key', async () => {
            const result = await runDevelopLoopScenario('pinmutexledger', {
                members: ['local'],
                taskSpecs: [{ title: 'Task: pin sprintMutexId to the ledger key regression work' }],
                maxCycles: 2,
                branchOverride: FIXED_BRANCH,
            });

            assert.ok(!result.error, `scenario should not abort: ${result.error ? result.error.message : ''}`);
            assert.equal(result.branch, FIXED_BRANCH);
            assert.ok(result.dispatched.length > 0, 'expected at least one dispatched call to inspect');
            const wrongSprintId = result.dispatched.filter((d) => d.sprintId !== FIXED_BRANCH);
            assert.equal(
                wrongSprintId.length, 0,
                `every real dispatch must carry sprint_id '${FIXED_BRANCH}' (runner.js's sprintMutexId), but found ` +
                `${wrongSprintId.length} that did not: ${JSON.stringify(wrongSprintId.map((d) => ({ agent: d.agent, sprintId: d.sprintId })))}`,
            );

            // The shared CLI<->runner arg contract resolves `branch` to the
            // identical literal -- this is what bin/cli.mjs's own
            // `sprintId: branchName` member-reservation call and its
            // `effectiveRunId = values['run-id'] || branchName` ledger-key
            // fallback both key off of for a direct/standalone launch.
            const validated = validateArgs({
                target_issues: ['x-1'],
                members: ['local'],
                branch: FIXED_BRANCH,
                base_branch: 'main',
            });
            assert.equal(validated.branch, FIXED_BRANCH);

            // Tie it back to the real coordination.mjs client: the exact
            // same literal, used as sprintId the way cli.mjs constructs it,
            // is what actually goes out on the wire as sprint_id.
            const calls = [];
            const client = createMemberReservationClient({
                callTool: async (name, args) => { calls.push({ name, args }); return { content: [{ text: '{}' }] }; },
                members: ['local'],
                sprintId: validated.branch,
            });
            await client.reserveAll();
            assert.equal(calls.length, 1);
            assert.equal(calls[0].args.sprint_id, FIXED_BRANCH);
        });
    });
});
