// Tests for src/spa/archive.mjs -- fleet-bridge-implementation-plan.md
// Part D, section D1.
//
// PAYLOAD SHAPES were pinned by reading the two live route handlers
// verbatim in @apralabs/apra-fleet-workflow/src/viewer/index.mjs:
//
//   - GET /activities/:id/output (~lines 1472-1505): this module always
//     takes the `state.tree` FALLBACK branch (findActivityById + the
//     `typeof act.output === 'string'` / `typeof act.error === 'string'`
//     checks), because the route's PRIMARY branch reads
//     command-output-cap.mjs's in-memory, per-process, never-persisted
//     `getFullOutput()` store, which cannot exist once the sprint's process
//     has exited -- exactly the situation `finalize` runs in. The
//     response shape asserted below (`{ id, output?, error? }`, present
//     keys only) is copied from that fallback branch's own construction of
//     `fromState` and the final `res.end(JSON.stringify({ id, ...full }))`.
//   - GET /extensions/:extId/detail/:itemId (~lines 1432-1459): asserted
//     verbatim, including the `detail.text || ''` and
//     `detail.updatedAt ?? null` coercions:
//     `{ id: itemId, text: detail.text || '', updatedAt: detail.updatedAt ?? null }`.
//
// The extension contract (`{ id, detailLookup(state, itemId) }`) and the
// `state.extensions.<extId>` shape it reads are pinned against the REAL
// `beadsExtension` from @apralabs/apra-fleet-se/fleet-sprint/
// viewer-extensions.mjs (already a bridge-package dependency), not a
// reimplementation of it -- see the "real beadsExtension" describe block.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildArchiveBundle } from '../src/spa/archive.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';
import { assertThrows } from './helpers.mjs';
import { beadsExtension } from '@apralabs/apra-fleet-se/fleet-sprint/viewer-extensions.mjs';

/** A minimal but realistic terminal `old_runs/<id>.json`-shaped state. */
function realisticState(overrides = {}) {
    return {
        workflowName: 'auto-sprint',
        status: 'success',
        result: { verdict: 'MERGED', prUrl: 'https://github.com/example/repo/pull/42' },
        startedAt: '2026-09-01T00:00:00.000Z',
        endedAt: '2026-09-01T01:00:00.000Z',
        stats: { activitiesCount: 3, totalTokens: 100, totalCost: 0.1, unknownCostCount: 0, startTime: 0, durationMs: 3600000 },
        tree: [
            {
                title: 'Workflow',
                phases: [
                    {
                        title: 'Cycle 1',
                        phaseStartedAt: '2026-09-01T00:00:00.000Z',
                        phaseEndedAt: '2026-09-01T00:30:00.000Z',
                        events: [
                            { type: 'log', time: 1, msg: 'starting' },
                            {
                                type: 'activity',
                                id: 'act-command-1',
                                data: { type: 'command', title: 'bd list', isRunning: false, output: 'full stdout text', outputTruncated: false },
                            },
                            {
                                type: 'activity',
                                id: 'act-agent-1',
                                data: { type: 'agent', title: 'plan', isRunning: false, error: 'the agent blew up' },
                            },
                            {
                                type: 'activity',
                                id: 'act-empty-1',
                                data: { type: 'agent', title: 'no-op', isRunning: false },
                            },
                        ],
                    },
                ],
            },
        ],
        extensions: {
            beads: {
                sprintTasks: [
                    { id: 'bd-1', title: 'Do the thing', description: 'the full description', status: 'open', updated_at: '2026-07-21T00:00:00Z' },
                ],
                backlogTasks: [
                    { id: 'bd-2', title: 'Backlog thing', description: 'backlog description', status: 'open', updated_at: '2026-07-22T00:00:00Z' },
                ],
            },
        },
        ...overrides,
    };
}

function findFile(files, path) {
    return files.find((f) => f.path === path);
}

describe('buildArchiveBundle: index.html', () => {
    test('is non-empty and comes from the real history-mode template, not a stub', () => {
        const { files } = buildArchiveBundle({ state: realisticState() });
        const index = findFile(files, 'index.html');
        assert.ok(index, 'expected an index.html entry');
        assert.strictEqual(index.contentType, 'text/html; charset=utf-8');
        assert.ok(index.body.length > 0);
        // data-view="history" is HTML_TEMPLATE's own history-mode marker
        // (asserted the same way in apra-fleet-se's
        // eft-37-boundary-e2e.test.mjs) -- proof this came from the real,
        // shared template in history mode, not a second, hand-rolled page.
        assert.ok(index.body.includes('data-view="history"'), 'expected the real HTML_TEMPLATE history-mode marker');
        // History mode must never re-arm the live poll loop/SSE.
        assert.ok(!index.body.includes("new EventSource('/events')"));
    });

    test('embeds the frozen state (e.g. the verdict) directly, since the shell is data-carrying in archive/history mode', () => {
        const { files } = buildArchiveBundle({ state: realisticState() });
        const index = findFile(files, 'index.html');
        assert.ok(index.body.includes('MERGED'));
    });

    test('is produced even for an empty (but valid) state object', () => {
        const { files } = buildArchiveBundle({ state: {} });
        const index = findFile(files, 'index.html');
        assert.ok(index && index.body.length > 0);
    });
});

describe('buildArchiveBundle: activities/<id>.json', () => {
    test('emits one file per activity carrying output and/or error, shaped { id, output?, error? }', () => {
        const { files } = buildArchiveBundle({ state: realisticState() });

        const cmd = findFile(files, 'activities/act-command-1.json');
        assert.ok(cmd, 'expected activities/act-command-1.json');
        assert.strictEqual(cmd.contentType, 'application/json');
        assert.deepStrictEqual(JSON.parse(cmd.body), { id: 'act-command-1', output: 'full stdout text' });

        const agent = findFile(files, 'activities/act-agent-1.json');
        assert.ok(agent, 'expected activities/act-agent-1.json');
        assert.deepStrictEqual(JSON.parse(agent.body), { id: 'act-agent-1', error: 'the agent blew up' });
    });

    test('an activity with neither output nor error emits NO file -- chosen to match the live route, which has nothing worth fetching for such an id (it would 404), so archiving an empty/near-empty blob would be pure waste', () => {
        const { files } = buildArchiveBundle({ state: realisticState() });
        assert.strictEqual(findFile(files, 'activities/act-empty-1.json'), undefined);
    });

    test('an activity with BOTH output and error includes both keys', () => {
        const state = realisticState();
        state.tree[0].phases[0].events.push({
            type: 'activity',
            id: 'act-both-1',
            data: { type: 'command', output: 'stdout', error: 'stderr' },
        });
        const { files } = buildArchiveBundle({ state });
        const both = findFile(files, 'activities/act-both-1.json');
        assert.deepStrictEqual(JSON.parse(both.body), { id: 'act-both-1', output: 'stdout', error: 'stderr' });
    });

    test('non-activity events (e.g. type: "log") are ignored entirely', () => {
        const { files } = buildArchiveBundle({ state: realisticState() });
        const activityFiles = files.filter((f) => f.path.startsWith('activities/'));
        assert.strictEqual(activityFiles.length, 2, 'expected exactly the two activities with output/error');
    });

    test('tolerates a missing tree/phases/events without throwing', () => {
        const { files } = buildArchiveBundle({ state: { tree: [{ title: 'g' }, { title: 'g2', phases: [{ title: 'p' }] }] } });
        assert.strictEqual(files.filter((f) => f.path.startsWith('activities/')).length, 0);
    });
});

describe('buildArchiveBundle: extensions/<extId>/<itemId>.json', () => {
    test('with no extensions supplied, emits index.html only (no extensions/ files)', () => {
        const { files } = buildArchiveBundle({ state: realisticState() });
        assert.strictEqual(files.filter((f) => f.path.startsWith('extensions/')).length, 0);
    });

    test('materialises detail for every candidate id a supplied extension recognises, via a local fake extension', () => {
        const fakeExt = {
            id: 'fake',
            detailLookup(state, id) {
                const item = (state.extensions?.fake?.items || []).find((i) => String(i.id) === String(id));
                return item ? { text: item.body, updatedAt: item.ts } : null;
            },
        };
        const state = realisticState({ extensions: { fake: { items: [{ id: 'x1', body: 'hello', ts: '2026-01-01' }] } } });
        const { files } = buildArchiveBundle({ state, extensions: [fakeExt] });

        const file = findFile(files, 'extensions/fake/x1.json');
        assert.ok(file, 'expected extensions/fake/x1.json');
        assert.strictEqual(file.contentType, 'application/json');
        assert.deepStrictEqual(JSON.parse(file.body), { id: 'x1', text: 'hello', updatedAt: '2026-01-01' });
    });

    test('an extension without detailLookup is skipped without error', () => {
        const state = realisticState();
        const { files } = buildArchiveBundle({ state, extensions: [{ id: 'no-hook' }] });
        assert.strictEqual(files.filter((f) => f.path.startsWith('extensions/')).length, 0);
    });

    test('a candidate id the extension does not recognise (detailLookup returns null) produces no file', () => {
        const fakeExt = { id: 'fake', detailLookup: () => null };
        const state = realisticState({ extensions: { fake: { items: [{ id: 'ghost' }] } } });
        const { files } = buildArchiveBundle({ state, extensions: [fakeExt] });
        assert.strictEqual(files.filter((f) => f.path.startsWith('extensions/')).length, 0);
    });

    describe('against the real beadsExtension (@apralabs/apra-fleet-se/fleet-sprint/viewer-extensions.mjs)', () => {
        test('materialises both a sprintTasks and a backlogTasks bead, field-for-field with detailLookup\'s own return shape', () => {
            const state = realisticState();
            const { files } = buildArchiveBundle({ state, extensions: [beadsExtension] });

            const bd1 = findFile(files, 'extensions/beads/bd-1.json');
            assert.ok(bd1, 'expected extensions/beads/bd-1.json');
            assert.deepStrictEqual(JSON.parse(bd1.body), { id: 'bd-1', text: 'the full description', updatedAt: '2026-07-21T00:00:00Z' });

            const bd2 = findFile(files, 'extensions/beads/bd-2.json');
            assert.ok(bd2, 'expected extensions/beads/bd-2.json (backlogTasks, not just sprintTasks)');
            assert.deepStrictEqual(JSON.parse(bd2.body), { id: 'bd-2', text: 'backlog description', updatedAt: '2026-07-22T00:00:00Z' });
        });

        test('a bead with no description still materialises with text: "" (matching detailLookup\'s `bead.description || \'\'`)', () => {
            const state = realisticState({
                extensions: { beads: { sprintTasks: [{ id: 'bd-3', title: 'no description' }], backlogTasks: [] } },
            });
            const { files } = buildArchiveBundle({ state, extensions: [beadsExtension] });
            const bd3 = findFile(files, 'extensions/beads/bd-3.json');
            assert.ok(bd3);
            assert.deepStrictEqual(JSON.parse(bd3.body), { id: 'bd-3', text: '', updatedAt: null });
        });

        test('renders the SAME beads state into index.html via the injected extensions list (no second renderer)', () => {
            const state = realisticState();
            const { files } = buildArchiveBundle({ state, extensions: [beadsExtension] });
            const index = findFile(files, 'index.html');
            assert.ok(index.body.includes('Do the thing'), 'expected the beads panel HTML to render the sprint task title');
        });
    });
});

describe('buildArchiveBundle: malformed/missing state', () => {
    test('missing `state` entirely throws BridgeError CONFIG_MISSING', () => {
        const err = assertThrows(() => buildArchiveBundle({}));
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
    });

    test('`state: null` throws BridgeError CONFIG_INVALID', () => {
        const err = assertThrows(() => buildArchiveBundle({ state: null }));
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    });

    test('`state` as a non-object (string) throws BridgeError CONFIG_INVALID', () => {
        const err = assertThrows(() => buildArchiveBundle({ state: 'not-an-object' }));
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    });

    test('`state` as an array throws BridgeError CONFIG_INVALID', () => {
        const err = assertThrows(() => buildArchiveBundle({ state: [] }));
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    });

    test('`extensions` as a non-array throws BridgeError CONFIG_INVALID', () => {
        const err = assertThrows(() => buildArchiveBundle({ state: realisticState(), extensions: { not: 'an array' } }));
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    });

    test('an empty object state still produces a usable bundle (index.html, no activities/extensions files) rather than throwing', () => {
        const { files } = buildArchiveBundle({ state: {} });
        assert.strictEqual(files.length, 1);
        assert.strictEqual(files[0].path, 'index.html');
    });
});

describe('buildArchiveBundle: purity', () => {
    test('is synchronous and returns plain data -- no Promise, no side effects to assert against', () => {
        const result = buildArchiveBundle({ state: realisticState() });
        assert.ok(!(result instanceof Promise));
        assert.ok(Array.isArray(result.files));
        for (const f of result.files) {
            assert.strictEqual(typeof f.path, 'string');
            assert.strictEqual(typeof f.contentType, 'string');
            assert.strictEqual(typeof f.body, 'string');
        }
    });

    test('calling it twice with the same input produces the same index.html and the same set of activity/extension paths', () => {
        const state = realisticState();
        const a = buildArchiveBundle({ state, extensions: [beadsExtension] });
        const b = buildArchiveBundle({ state, extensions: [beadsExtension] });
        assert.strictEqual(a.files.find((f) => f.path === 'index.html').body, b.files.find((f) => f.path === 'index.html').body);
        assert.deepStrictEqual(a.files.map((f) => f.path).sort(), b.files.map((f) => f.path).sort());
    });
});
