// Tests for src/verbs/ingest.mjs -- fake beads client, fake adapter; one
// dedicated test wires the REAL beads-client (src/beads-client.mjs) with a
// fake execBdSync/execBdAsync pair to prove the synthetic-epic's free-text
// title actually routes through execBdSync, per
// fleet-bridge-implementation-plan.md's hard sync/async routing rule.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  runIngest,
  validateIngestOpts,
  normalizePulledItem,
  pullWorkItems,
  findNaturalParent,
  resolveRoot,
  assertHasChildren,
  auditAcceptanceCriteria,
  assertCriteriaComplete,
} from '../src/verbs/ingest.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';
import { createBeadsClient } from '../src/beads-client.mjs';
import { selectCarryOver } from '../src/carry-over.mjs';

// -- fakes --------------------------------------------------------------------

/** A fake beads client recording create()/setParent() calls. */
function makeFakeBeads({ createResult, createError, createIdSeq } = {}) {
  const createCalls = [];
  const setParentCalls = [];
  let seq = 0;
  return {
    createCalls,
    setParentCalls,
    async create(opts) {
      createCalls.push(opts);
      if (createError) throw createError;
      if (createIdSeq) {
        seq += 1;
        return { id: `${createIdSeq}-${seq}`, title: opts.title };
      }
      return createResult !== undefined ? createResult : { id: 'epic-synth-1', title: opts.title };
    },
    async setParent(childId, parentId) {
      setParentCalls.push({ childId, parentId });
      return { id: childId, parent: parentId };
    },
  };
}

/**
 * A STATEFUL fake beads client backing create()/setParent()/list() with an
 * in-memory row store -- close enough to a real beads DB (unlike
 * makeFakeBeads above, which has no list() at all) to exercise resolveRoot's
 * reuse lookup across multiple resolveRoot/runIngest calls against the SAME
 * store, the shape two live `ingest` runs against one local DB actually see.
 */
function makeStatefulFakeBeads(seedRows = []) {
  const rows = seedRows.map((r) => ({ ...r }));
  const createCalls = [];
  const setParentCalls = [];
  const listCalls = [];
  let seq = rows.length;
  return {
    rows,
    createCalls,
    setParentCalls,
    listCalls,
    async create({ title, issueType, priority, parent, metadata } = {}) {
      createCalls.push({ title, issueType, priority, parent, metadata });
      seq += 1;
      const row = {
        id: `epic-${seq}`,
        title,
        issue_type: issueType || 'task',
        metadata,
        parent: parent || null,
        created_at: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
      };
      rows.push(row);
      return { id: row.id, title: row.title };
    },
    async setParent(childId, parentId) {
      setParentCalls.push({ childId, parentId });
      let row = rows.find((r) => r.id === childId);
      if (!row) {
        row = { id: childId, issue_type: 'task', parent: parentId };
        rows.push(row);
      } else {
        row.parent = parentId;
      }
      return { id: childId, parent: parentId };
    },
    async list({ type, limit } = {}) {
      listCalls.push({ type, limit });
      return rows.filter((r) => !type || r.issue_type === type).map((r) => ({ ...r }));
    },
  };
}

/** A fake bridge adapter whose ingest() returns/throws whatever `result` says. */
function makeFakeAdapter(result) {
  const calls = [];
  return {
    calls,
    async ingest(opts, deps) {
      calls.push({ opts, deps });
      if (result instanceof Error) throw result;
      return typeof result === 'function' ? result(opts, deps) : result;
    },
  };
}

function pulledItem(overrides = {}) {
  return {
    beadId: 'mem-1',
    externalRef: 'WI-1',
    title: 'some work',
    acceptanceCriteria: 'given/when/then',
    ...overrides,
  };
}

// -- validateIngestOpts --------------------------------------------------------

describe('validateIngestOpts', () => {
  test('throws CONFIG_MISSING when refs is missing', () => {
    assert.throws(() => validateIngestOpts({ secretName: 'azdevops_pat' }), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
  });

  test('throws CONFIG_MISSING when refs is an empty array', () => {
    assert.throws(() => validateIngestOpts({ refs: [], secretName: 'azdevops_pat' }), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
  });

  test('throws CONFIG_INVALID when a ref begins with a dash (flag injection)', () => {
    assert.throws(() => validateIngestOpts({ refs: ['-x'], secretName: 'azdevops_pat' }), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      return true;
    });
  });

  test('throws CONFIG_MISSING when secretName is missing', () => {
    assert.throws(() => validateIngestOpts({ refs: ['WI-1'] }), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
  });

  test('requireCriteria defaults to true', () => {
    const v = validateIngestOpts({ refs: ['WI-1'], secretName: 's' });
    assert.strictEqual(v.requireCriteria, true);
  });

  test('allowMissingCriteria overrides requireCriteria to false', () => {
    const v = validateIngestOpts({ refs: ['WI-1'], secretName: 's', requireCriteria: true, allowMissingCriteria: true });
    assert.strictEqual(v.requireCriteria, false);
  });

  test('explicit requireCriteria: false is honored without allowMissingCriteria', () => {
    const v = validateIngestOpts({ refs: ['WI-1'], secretName: 's', requireCriteria: false });
    assert.strictEqual(v.requireCriteria, false);
  });

  test('epicTitle passes through when a non-empty string, else undefined', () => {
    assert.strictEqual(validateIngestOpts({ refs: ['WI-1'], secretName: 's', epicTitle: 'My Epic' }).epicTitle, 'My Epic');
    assert.strictEqual(validateIngestOpts({ refs: ['WI-1'], secretName: 's', epicTitle: '' }).epicTitle, undefined);
    assert.strictEqual(validateIngestOpts({ refs: ['WI-1'], secretName: 's' }).epicTitle, undefined);
  });

  test('returns a frozen object', () => {
    const v = validateIngestOpts({ refs: ['WI-1'], secretName: 's' });
    assert.throws(() => { v.secretName = 'other'; }, TypeError);
  });
});

// -- normalizePulledItem -------------------------------------------------------

describe('normalizePulledItem', () => {
  test('throws INGEST_PULL_FAILED for a non-object entry', () => {
    assert.throws(() => normalizePulledItem('not-an-object', 0), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.INGEST_PULL_FAILED);
      return true;
    });
  });

  test('throws INGEST_PULL_FAILED when beadId is missing', () => {
    assert.throws(() => normalizePulledItem({ title: 'x' }, 2), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.INGEST_PULL_FAILED);
      assert.match(err.message, /index 2/);
      return true;
    });
  });

  test('hasAcceptanceCriteria is true from an explicit boolean flag', () => {
    const item = normalizePulledItem({ beadId: 'a', hasAcceptanceCriteria: true }, 0);
    assert.strictEqual(item.hasAcceptanceCriteria, true);
  });

  test('hasAcceptanceCriteria is true from a non-empty acceptanceCriteria string', () => {
    const item = normalizePulledItem({ beadId: 'a', acceptanceCriteria: 'given/when/then' }, 0);
    assert.strictEqual(item.hasAcceptanceCriteria, true);
  });

  test('hasAcceptanceCriteria is false when absent or blank', () => {
    assert.strictEqual(normalizePulledItem({ beadId: 'a' }, 0).hasAcceptanceCriteria, false);
    assert.strictEqual(normalizePulledItem({ beadId: 'a', acceptanceCriteria: '   ' }, 0).hasAcceptanceCriteria, false);
  });

  test('parent normalizes to null when absent, non-string, or empty', () => {
    assert.strictEqual(normalizePulledItem({ beadId: 'a' }, 0).parent, null);
    assert.strictEqual(normalizePulledItem({ beadId: 'a', parent: '' }, 0).parent, null);
    assert.strictEqual(normalizePulledItem({ beadId: 'a', parent: 42 }, 0).parent, null);
    assert.strictEqual(normalizePulledItem({ beadId: 'a', parent: 'epic-1' }, 0).parent, 'epic-1');
  });
});

// -- pullWorkItems --------------------------------------------------------------

describe('pullWorkItems', () => {
  test('calls adapter.ingest with the pinned contract shape: { refs, secretName }, { beads }', async () => {
    const beads = makeFakeBeads();
    const adapter = makeFakeAdapter([]);
    await pullWorkItems({ refs: ['WI-1', 'WI-2'], secretName: 'azdevops_pat' }, { adapter, beads, log: () => {} });

    assert.strictEqual(adapter.calls.length, 1);
    assert.deepStrictEqual(adapter.calls[0].opts, { refs: ['WI-1', 'WI-2'], secretName: 'azdevops_pat' });
    assert.deepStrictEqual(adapter.calls[0].deps, { beads });
  });

  test('accepts a bare array return from the adapter', async () => {
    const adapter = makeFakeAdapter([pulledItem({ beadId: 'a' }), pulledItem({ beadId: 'b' })]);
    const pulled = await pullWorkItems({ refs: ['a', 'b'], secretName: 's' }, { adapter, beads: makeFakeBeads(), log: () => {} });
    assert.strictEqual(pulled.length, 2);
  });

  test('accepts a { pulled: [...] } envelope return from the adapter', async () => {
    const adapter = makeFakeAdapter({ pulled: [pulledItem({ beadId: 'a' })] });
    const pulled = await pullWorkItems({ refs: ['a'], secretName: 's' }, { adapter, beads: makeFakeBeads(), log: () => {} });
    assert.strictEqual(pulled.length, 1);
    assert.strictEqual(pulled[0].beadId, 'a');
  });

  test('an adapter that returns nothing usable pulls zero items, not an error', async () => {
    const adapter = makeFakeAdapter({ stdout: 'irrelevant command output' });
    const pulled = await pullWorkItems({ refs: ['a'], secretName: 's' }, { adapter, beads: makeFakeBeads(), log: () => {} });
    assert.deepStrictEqual(pulled, []);
  });

  test('wraps a non-BridgeError adapter failure as INGEST_PULL_FAILED', async () => {
    const adapter = makeFakeAdapter(new Error('member unreachable'));
    await assert.rejects(
      () => pullWorkItems({ refs: ['a'], secretName: 's' }, { adapter, beads: makeFakeBeads(), log: () => {} }),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.INGEST_PULL_FAILED);
        assert.match(err.message, /member unreachable/);
        return true;
      }
    );
  });

  test('a BridgeError thrown by the adapter propagates unchanged', async () => {
    const original = new BridgeError(BRIDGE_ERROR_CODES.SUPERVISOR_UNAVAILABLE, 'down');
    const adapter = makeFakeAdapter(original);
    await assert.rejects(
      () => pullWorkItems({ refs: ['a'], secretName: 's' }, { adapter, beads: makeFakeBeads(), log: () => {} }),
      (err) => {
        assert.strictEqual(err, original);
        return true;
      }
    );
  });
});

// -- findNaturalParent ----------------------------------------------------------

describe('findNaturalParent', () => {
  test('three items, one is parent of the other two -> returns that parent', () => {
    const pulled = [
      { beadId: 'epic-a', parent: null },
      { beadId: 'task-b', parent: 'epic-a' },
      { beadId: 'task-c', parent: 'epic-a' },
    ];
    const found = findNaturalParent(pulled);
    assert.strictEqual(found.beadId, 'epic-a');
  });

  test('three flat siblings with no parent links -> null', () => {
    const pulled = [
      { beadId: 'a', parent: null },
      { beadId: 'b', parent: null },
      { beadId: 'c', parent: null },
    ];
    assert.strictEqual(findNaturalParent(pulled), null);
  });

  test('a single item is trivially its own natural parent (no others to fail against)', () => {
    const pulled = [{ beadId: 'solo', parent: null }];
    assert.strictEqual(findNaturalParent(pulled).beadId, 'solo');
  });

  test('empty input -> null', () => {
    assert.strictEqual(findNaturalParent([]), null);
  });

  test('a partial hierarchy (one child parented, one orphan) is not a natural parent', () => {
    const pulled = [
      { beadId: 'epic-a', parent: null },
      { beadId: 'task-b', parent: 'epic-a' },
      { beadId: 'task-c', parent: null },
    ];
    assert.strictEqual(findNaturalParent(pulled), null);
  });
});

// -- resolveRoot ------------------------------------------------------------------

describe('resolveRoot', () => {
  test('natural parent present: no bd mutation, syntheticRoot false, childCount = n-1', async () => {
    const beads = makeFakeBeads();
    const pulled = [
      { beadId: 'epic-a', parent: null },
      { beadId: 'task-b', parent: 'epic-a' },
      { beadId: 'task-c', parent: 'epic-a' },
    ];
    const result = await resolveRoot(pulled, { beads, log: () => {} });
    assert.deepStrictEqual(result, { rootBeadId: 'epic-a', syntheticRoot: false, childCount: 2 });
    assert.strictEqual(beads.createCalls.length, 0);
    assert.strictEqual(beads.setParentCalls.length, 0);
  });

  test('no natural parent: synthetic epic created and every item parented under it', async () => {
    const beads = makeFakeBeads({ createResult: { id: 'synthetic-epic-1' } });
    const pulled = [
      { beadId: 'a', externalRef: 'WI-1', parent: null },
      { beadId: 'b', externalRef: 'WI-2', parent: null },
      { beadId: 'c', externalRef: 'WI-3', parent: null },
    ];
    const result = await resolveRoot(pulled, { beads, log: () => {} });

    assert.strictEqual(result.rootBeadId, 'synthetic-epic-1');
    assert.strictEqual(result.syntheticRoot, true);
    assert.strictEqual(result.childCount, 3);

    assert.strictEqual(beads.createCalls.length, 1);
    assert.strictEqual(beads.createCalls[0].issueType, 'epic');
    assert.strictEqual(typeof beads.createCalls[0].title, 'string');

    assert.deepStrictEqual(
      beads.setParentCalls.map((c) => c.childId).sort(),
      ['a', 'b', 'c']
    );
    for (const call of beads.setParentCalls) {
      assert.strictEqual(call.parentId, 'synthetic-epic-1');
    }
  });

  test('a caller-supplied epicTitle overrides the deterministic default', async () => {
    const beads = makeFakeBeads();
    const pulled = [{ beadId: 'a', parent: null }, { beadId: 'b', parent: null }];
    await resolveRoot(pulled, { beads, log: () => {} }, { epicTitle: 'Pipeline run 42' });
    assert.strictEqual(beads.createCalls[0].title, 'Pipeline run 42');
  });

  test('zero pulled items: no bd mutation, childCount 0, rootBeadId null', async () => {
    const beads = makeFakeBeads();
    const result = await resolveRoot([], { beads, log: () => {} });
    assert.deepStrictEqual(result, { rootBeadId: null, syntheticRoot: false, childCount: 0 });
    assert.strictEqual(beads.createCalls.length, 0);
  });

  test('throws BEADS_FAILED when bd create does not return a usable id', async () => {
    const beads = makeFakeBeads({ createResult: { title: 'no id here' } });
    const pulled = [{ beadId: 'a', parent: null }, { beadId: 'b', parent: null }];
    await assert.rejects(
      () => resolveRoot(pulled, { beads, log: () => {} }),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.BEADS_FAILED);
        return true;
      }
    );
  });
});

// -- resolveRoot idempotency (synthetic-root REUSE) ----------------------------
//
// A pipeline retries -- a transient tracker/network failure followed by a
// re-run of the exact same `ingest --refs ...` is the normal case, not the
// exception. These cover the reuse rule end to end against a STATEFUL fake
// (makeStatefulFakeBeads), since the bug this fixes only shows up when
// create()/list() see the SAME underlying store across more than one call.

describe('resolveRoot idempotency (synthetic-root reuse)', () => {
  test('second call with the same refs reuses the root and creates no new epic', async () => {
    const beads = makeStatefulFakeBeads();
    const pulled = [
      { beadId: 'a', externalRef: '2', parent: null },
      { beadId: 'b', externalRef: '3', parent: null },
      { beadId: 'c', externalRef: '4', parent: null },
    ];
    const opts = { refs: ['2', '3', '4'] };

    const first = await resolveRoot(pulled, { beads, log: () => {} }, opts);
    assert.strictEqual(first.syntheticRoot, true);
    assert.strictEqual(beads.createCalls.length, 1);

    const second = await resolveRoot(pulled, { beads, log: () => {} }, opts);
    assert.strictEqual(second.rootBeadId, first.rootBeadId, 'the second run must resolve to the SAME root id');
    assert.strictEqual(second.syntheticRoot, true);
    assert.strictEqual(beads.createCalls.length, 1, 'no second bd create -- the existing root was reused');

    const epics = beads.rows.filter((r) => r.issue_type === 'epic');
    assert.strictEqual(epics.length, 1, 'exactly one synthetic epic exists in the DB after two runs');
  });

  test('refs given in a different order still resolve to the same canonical identity', async () => {
    const beads = makeStatefulFakeBeads();
    const pulled = [{ beadId: 'a', parent: null }, { beadId: 'b', parent: null }, { beadId: 'c', parent: null }];

    const first = await resolveRoot(pulled, { beads, log: () => {} }, { refs: ['2', '3', '4'] });
    const second = await resolveRoot(pulled, { beads, log: () => {} }, { refs: ['4', '2', '3'] });

    assert.strictEqual(second.rootBeadId, first.rootBeadId);
    assert.strictEqual(beads.createCalls.length, 1);
  });

  test('different refs create a separate root -- never hijacking the existing one', async () => {
    const beads = makeStatefulFakeBeads();
    const pulledFull = [
      { beadId: 'a', externalRef: '2', parent: null },
      { beadId: 'b', externalRef: '3', parent: null },
      { beadId: 'c', externalRef: '4', parent: null },
    ];
    const first = await resolveRoot(pulledFull, { beads, log: () => {} }, { refs: ['2', '3', '4'] });

    const pulledSubset = [
      { beadId: 'a', externalRef: '2', parent: null },
      { beadId: 'b', externalRef: '3', parent: null },
    ];
    const second = await resolveRoot(pulledSubset, { beads, log: () => {} }, { refs: ['2', '3'] });

    assert.notStrictEqual(second.rootBeadId, first.rootBeadId, 'a different ref set must get its own root, not adopt the first');
    assert.strictEqual(beads.createCalls.length, 2);

    const epics = beads.rows.filter((r) => r.issue_type === 'epic');
    assert.strictEqual(epics.length, 2, 'both roots persist -- the subset run did not orphan or reuse the full-set root');
  });

  test('a natural parent still wins over an existing reusable synthetic root', async () => {
    const beads = makeStatefulFakeBeads();
    // Seed a reusable synthetic root for refs [2,3,4], as a prior no-natural-
    // parent run would have left behind.
    await beads.create({
      title: 'Ingest epic for 3 item(s): 2, 3, 4',
      issueType: 'epic',
      metadata: { fleetBridgeIngestRoot: true, fleetBridgeIngestRefsKey: '2,3,4' },
    });
    beads.createCalls.length = 0; // that seed call is not part of what this test asserts

    const pulled = [
      { beadId: 'epic-natural', parent: null },
      { beadId: 'task-b', parent: 'epic-natural' },
      { beadId: 'task-c', parent: 'epic-natural' },
    ];
    const result = await resolveRoot(pulled, { beads, log: () => {} }, { refs: ['2', '3', '4'] });

    assert.strictEqual(result.rootBeadId, 'epic-natural');
    assert.strictEqual(result.syntheticRoot, false);
    assert.strictEqual(beads.createCalls.length, 0);
    assert.strictEqual(beads.listCalls.length, 0, 'the natural-parent path returns before the reuse lookup ever runs');
  });

  test('an unrelated epic with a lookalike title but no marker metadata is never adopted', async () => {
    const beads = makeStatefulFakeBeads([
      {
        id: 'ado-toy-gtl',
        title: 'Ingest epic for 3 item(s): 2, 3, 4', // same title a synthetic epic would get
        issue_type: 'epic',
        // no metadata at all -- an ordinary, unrelated tracker epic, not ours
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const pulled = [
      { beadId: 'a', externalRef: '2', parent: null },
      { beadId: 'b', externalRef: '3', parent: null },
      { beadId: 'c', externalRef: '4', parent: null },
    ];
    const result = await resolveRoot(pulled, { beads, log: () => {} }, { refs: ['2', '3', '4'] });

    assert.notStrictEqual(result.rootBeadId, 'ado-toy-gtl', 'the lookalike epic must never be adopted as the root');
    assert.strictEqual(beads.createCalls.length, 1, 'a NEW synthetic epic is created instead');
  });

  test('an epic whose metadata marker is set but refsKey differs is not adopted either', async () => {
    const beads = makeStatefulFakeBeads([
      {
        id: 'epic-other-scope',
        issue_type: 'epic',
        metadata: { fleetBridgeIngestRoot: true, fleetBridgeIngestRefsKey: '99,100' },
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const pulled = [{ beadId: 'a', parent: null }, { beadId: 'b', parent: null }];
    const result = await resolveRoot(pulled, { beads, log: () => {} }, { refs: ['2', '3'] });

    assert.notStrictEqual(result.rootBeadId, 'epic-other-scope');
    assert.strictEqual(beads.createCalls.length, 1);
  });

  test('first run on an empty DB still works and stamps the identity metadata', async () => {
    const beads = makeStatefulFakeBeads();
    const pulled = [{ beadId: 'a', parent: null }, { beadId: 'b', parent: null }];

    const result = await resolveRoot(pulled, { beads, log: () => {} }, { refs: ['10', '11'] });

    assert.strictEqual(result.syntheticRoot, true);
    assert.strictEqual(typeof result.rootBeadId, 'string');
    assert.strictEqual(beads.createCalls.length, 1);
    assert.deepStrictEqual(beads.createCalls[0].metadata, {
      fleetBridgeIngestRoot: true,
      fleetBridgeIngestRefsKey: '10,11',
    });
  });

  test('multiple pre-existing matches (a pre-fix duplicate state): reuses the oldest deterministically and warns', async () => {
    const beads = makeStatefulFakeBeads([
      {
        id: 'epic-newer',
        issue_type: 'epic',
        metadata: { fleetBridgeIngestRoot: true, fleetBridgeIngestRefsKey: '2,3,4' },
        created_at: '2026-02-01T00:00:00.000Z',
      },
      {
        id: 'epic-older',
        issue_type: 'epic',
        metadata: { fleetBridgeIngestRoot: true, fleetBridgeIngestRefsKey: '2,3,4' },
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const logs = [];
    const pulled = [{ beadId: 'a', parent: null }, { beadId: 'b', parent: null }];

    const result = await resolveRoot(pulled, { beads, log: (m) => logs.push(m) }, { refs: ['2', '3', '4'] });

    assert.strictEqual(result.rootBeadId, 'epic-older');
    assert.strictEqual(beads.createCalls.length, 0);
    assert.ok(logs.some((m) => m.includes('WARNING')), 'the ambiguity must be surfaced, not silently resolved');
  });

  test('a beads client with no list() cannot dedupe -- degrades to the old always-create behavior, not a crash', async () => {
    const beads = makeFakeBeads({ createIdSeq: 'epic-nolist' });
    const pulled = [{ beadId: 'a', parent: null }, { beadId: 'b', parent: null }];

    const first = await resolveRoot(pulled, { beads, log: () => {} }, { refs: ['2', '3'] });
    const second = await resolveRoot(pulled, { beads, log: () => {} }, { refs: ['2', '3'] });

    assert.notStrictEqual(first.rootBeadId, second.rootBeadId);
    assert.strictEqual(beads.createCalls.length, 2);
  });

  test('runIngest end to end: a second run over the same store converges to the same rootBeadId', async () => {
    const beads = makeStatefulFakeBeads();
    const adapter = makeFakeAdapter([
      pulledItem({ beadId: 'a', externalRef: '2' }),
      pulledItem({ beadId: 'b', externalRef: '3' }),
      pulledItem({ beadId: 'c', externalRef: '4' }),
    ]);
    const opts = { refs: ['2', '3', '4'], secretName: 's' };

    const first = await runIngest(opts, { beads, adapter, log: () => {} });
    const second = await runIngest(opts, { beads, adapter, log: () => {} });

    assert.strictEqual(second.rootBeadId, first.rootBeadId);
    assert.strictEqual(second.syntheticRootId, first.syntheticRootId);
    assert.strictEqual(beads.rows.filter((r) => r.issue_type === 'epic').length, 1);
  });
});

// -- assertHasChildren --------------------------------------------------------

describe('assertHasChildren', () => {
  test('throws INGEST_NO_CHILDREN for 0', () => {
    assert.throws(() => assertHasChildren(0), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.INGEST_NO_CHILDREN);
      return true;
    });
  });

  test('does not throw for >= 1', () => {
    assert.doesNotThrow(() => assertHasChildren(1));
    assert.doesNotThrow(() => assertHasChildren(5));
  });
});

// -- acceptance-criteria audit --------------------------------------------------

describe('auditAcceptanceCriteria / assertCriteriaComplete', () => {
  test('audit lists missing bead ids and the total pulled count', () => {
    const pulled = [
      { beadId: 'a', hasAcceptanceCriteria: true },
      { beadId: 'b', hasAcceptanceCriteria: false },
      { beadId: 'c', hasAcceptanceCriteria: false },
    ];
    assert.deepStrictEqual(auditAcceptanceCriteria(pulled), { missing: ['b', 'c'], total: 3 });
  });

  test('assertCriteriaComplete throws INGEST_MISSING_CRITERIA naming the ids when required', () => {
    const audit = { missing: ['b', 'c'], total: 3 };
    assert.throws(() => assertCriteriaComplete(audit, true), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.INGEST_MISSING_CRITERIA);
      assert.match(err.message, /b/);
      assert.match(err.message, /c/);
      assert.deepStrictEqual(err.details.missing, ['b', 'c']);
      return true;
    });
  });

  test('assertCriteriaComplete is a no-op when requireCriteria is false', () => {
    assert.doesNotThrow(() => assertCriteriaComplete({ missing: ['b'], total: 1 }, false));
  });

  test('assertCriteriaComplete is a no-op when nothing is missing', () => {
    assert.doesNotThrow(() => assertCriteriaComplete({ missing: [], total: 3 }, true));
  });
});

// -- runIngest end-to-end ---------------------------------------------------------

describe('runIngest', () => {
  test('three items with one natural parent -> that parent is the root, syntheticRoot: false', async () => {
    const beads = makeFakeBeads();
    const adapter = makeFakeAdapter([
      pulledItem({ beadId: 'epic-a', parent: undefined }),
      pulledItem({ beadId: 'task-b', parent: 'epic-a' }),
      pulledItem({ beadId: 'task-c', parent: 'epic-a' }),
    ]);

    const result = await runIngest(
      { refs: ['epic-a', 'task-b', 'task-c'], secretName: 'azdevops_pat' },
      { beads, adapter, log: () => {} }
    );

    assert.strictEqual(result.rootBeadId, 'epic-a');
    assert.strictEqual(result.syntheticRoot, false);
    assert.strictEqual(result.childCount, 2);
    assert.strictEqual(result.pulled.length, 3);
    assert.strictEqual(beads.createCalls.length, 0);
  });

  test('no natural parent -> synthetic epic created, every item parented under it, id returned in the result', async () => {
    const beads = makeFakeBeads({ createResult: { id: 'synthetic-epic-9' } });
    const adapter = makeFakeAdapter([
      pulledItem({ beadId: 'a' }),
      pulledItem({ beadId: 'b' }),
      pulledItem({ beadId: 'c' }),
    ]);

    const result = await runIngest(
      { refs: ['a', 'b', 'c'], secretName: 's' },
      { beads, adapter, log: () => {} }
    );

    assert.strictEqual(result.syntheticRoot, true);
    assert.strictEqual(result.rootBeadId, 'synthetic-epic-9');
    // FIX 1: the string translation is done here, once, rather than left for
    // every downstream consumer (makeSprintHandle, selectCarryOver) to
    // reconstruct from syntheticRoot + rootBeadId.
    assert.strictEqual(result.syntheticRootId, 'synthetic-epic-9');
    assert.strictEqual(result.childCount, 3);
    // finalize excludes carry-over by this id -- it must be present and correct.
    assert.deepStrictEqual(
      beads.setParentCalls.map((c) => c.childId).sort(),
      ['a', 'b', 'c']
    );
    assert.ok(beads.setParentCalls.every((c) => c.parentId === 'synthetic-epic-9'));
  });

  test('a natural parent -> syntheticRootId is undefined, not the natural parent\'s id', async () => {
    const beads = makeFakeBeads();
    const adapter = makeFakeAdapter([
      pulledItem({ beadId: 'epic-a', parent: undefined }),
      pulledItem({ beadId: 'task-b', parent: 'epic-a' }),
    ]);

    const result = await runIngest(
      { refs: ['epic-a', 'task-b'], secretName: 's' },
      { beads, adapter, log: () => {} }
    );

    assert.strictEqual(result.syntheticRoot, false);
    assert.strictEqual(result.rootBeadId, 'epic-a');
    assert.strictEqual(result.syntheticRootId, undefined);
  });

  test('a single childless item -> INGEST_NO_CHILDREN', async () => {
    const beads = makeFakeBeads();
    const adapter = makeFakeAdapter([pulledItem({ beadId: 'solo' })]);

    await assert.rejects(
      () => runIngest({ refs: ['solo'], secretName: 's' }, { beads, adapter, log: () => {} }),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.INGEST_NO_CHILDREN);
        return true;
      }
    );
    // A lone item must never be wrapped in a synthetic epic just to dodge the check.
    assert.strictEqual(beads.createCalls.length, 0);
  });

  test('zero pulled items -> INGEST_NO_CHILDREN', async () => {
    const beads = makeFakeBeads();
    const adapter = makeFakeAdapter([]);
    await assert.rejects(
      () => runIngest({ refs: ['ghost'], secretName: 's' }, { beads, adapter, log: () => {} }),
      (err) => {
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.INGEST_NO_CHILDREN);
        return true;
      }
    );
  });

  test('criteria audit finds the gap and default requireCriteria fails, naming the ids', async () => {
    const beads = makeFakeBeads({ createResult: { id: 'synthetic-epic-1' } });
    const adapter = makeFakeAdapter([
      pulledItem({ beadId: 'a', acceptanceCriteria: 'has some' }),
      pulledItem({ beadId: 'b', acceptanceCriteria: '' }),
      pulledItem({ beadId: 'c', acceptanceCriteria: undefined }),
    ]);

    await assert.rejects(
      () => runIngest({ refs: ['a', 'b', 'c'], secretName: 's' }, { beads, adapter, log: () => {} }),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.INGEST_MISSING_CRITERIA);
        assert.match(err.message, /\bb\b/);
        assert.match(err.message, /\bc\b/);
        assert.deepStrictEqual(err.details.missing, ['b', 'c']);
        return true;
      }
    );
  });

  test('allowMissingCriteria proceeds despite missing criteria, reporting them in the audit', async () => {
    const beads = makeFakeBeads({ createResult: { id: 'synthetic-epic-1' } });
    const adapter = makeFakeAdapter([
      pulledItem({ beadId: 'a', acceptanceCriteria: 'has some' }),
      pulledItem({ beadId: 'b', acceptanceCriteria: '' }),
      pulledItem({ beadId: 'c', acceptanceCriteria: undefined }),
    ]);

    const result = await runIngest(
      { refs: ['a', 'b', 'c'], secretName: 's', allowMissingCriteria: true },
      { beads, adapter, log: () => {} }
    );

    assert.strictEqual(result.criteriaAudit.total, 3);
    assert.deepStrictEqual(result.criteriaAudit.missing, ['b', 'c']);
  });

  test('the pulled result strips internal `parent` bookkeeping down to the documented fields', async () => {
    const beads = makeFakeBeads();
    const adapter = makeFakeAdapter([
      pulledItem({ beadId: 'epic-a' }),
      pulledItem({ beadId: 'task-b', parent: 'epic-a' }),
    ]);
    const result = await runIngest({ refs: ['epic-a', 'task-b'], secretName: 's' }, { beads, adapter, log: () => {} });
    for (const item of result.pulled) {
      assert.deepStrictEqual(Object.keys(item).sort(), ['beadId', 'externalRef', 'hasAcceptanceCriteria', 'title']);
    }
  });

  test('result is frozen', async () => {
    const beads = makeFakeBeads();
    const adapter = makeFakeAdapter([pulledItem({ beadId: 'epic-a' }), pulledItem({ beadId: 'task-b', parent: 'epic-a' })]);
    const result = await runIngest({ refs: ['epic-a', 'task-b'], secretName: 's' }, { beads, adapter, log: () => {} });
    assert.throws(() => { result.rootBeadId = 'x'; }, TypeError);
  });

  test('throws CONFIG_MISSING when deps.beads is not injected', async () => {
    const adapter = makeFakeAdapter([]);
    await assert.rejects(
      () => runIngest({ refs: ['a'], secretName: 's' }, { adapter, log: () => {} }),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
        return true;
      }
    );
  });

  test('throws CONFIG_MISSING when deps.adapter is not injected', async () => {
    const beads = makeFakeBeads();
    await assert.rejects(
      () => runIngest({ refs: ['a'], secretName: 's' }, { beads, log: () => {} }),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
        return true;
      }
    );
  });

  test('a bad opts.refs entry fails before the adapter is ever called', async () => {
    const beads = makeFakeBeads();
    const adapter = makeFakeAdapter([]);
    await assert.rejects(
      () => runIngest({ refs: ['-bad'], secretName: 's' }, { beads, adapter, log: () => {} }),
      (err) => {
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
        return true;
      }
    );
    assert.strictEqual(adapter.calls.length, 0);
  });

  test('a genuine adapter/tracker failure surfaces as INGEST_PULL_FAILED', async () => {
    const beads = makeFakeBeads();
    const adapter = makeFakeAdapter(new Error('bd ado pull: 401 unauthorized'));
    await assert.rejects(
      () => runIngest({ refs: ['a'], secretName: 's' }, { beads, adapter, log: () => {} }),
      (err) => {
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.INGEST_PULL_FAILED);
        return true;
      }
    );
  });

  test('works with a plain array pulled from the adapter (no envelope)', async () => {
    const beads = makeFakeBeads();
    const adapter = makeFakeAdapter([
      pulledItem({ beadId: 'epic-a' }),
      pulledItem({ beadId: 'task-b', parent: 'epic-a' }),
      pulledItem({ beadId: 'task-c', parent: 'epic-a' }),
    ]);
    const result = await runIngest({ refs: ['epic-a', 'task-b', 'task-c'], secretName: 's' }, { beads, adapter, log: () => {} });
    assert.strictEqual(result.rootBeadId, 'epic-a');
  });
});

// -- the free-text synthetic-epic title, against the REAL beads-client --------
//
// implementation-plan.md's hard requirement 1: `execBdAsync` validates every
// arg against a safe charset and throws on a space; `bd create --title
// "<free text>"` MUST route through `execBdSync` instead. beads-client.mjs
// already encodes this (hasFreeTextArg/runBd); this proves ingest.mjs's own
// synthetic-epic title -- built from pulled refs, so it always contains
// spaces and commas -- actually exercises that path without blowing up.

describe('synthetic epic title with spaces, against the real beads-client', () => {
  function makeRealBeadsClient() {
    const syncCalls = [];
    const asyncCalls = [];
    const execBdSync = (args) => {
      syncCalls.push(args);
      if (args[0] === 'create') {
        return JSON.stringify({ id: 'epic-real-1' });
      }
      return '';
    };
    const execBdAsync = async (args) => {
      asyncCalls.push(args);
      if (args.some((a) => typeof a === 'string' && /\s/.test(a))) {
        throw new Error('execBdAsync received a free-text arg -- this must never happen');
      }
      return { stdout: '', stderr: '' };
    };
    return { beads: createBeadsClient({ execBdSync, execBdAsync }), syncCalls, asyncCalls };
  }

  test('a title with spaces routes through execBdSync and does not blow up', async () => {
    const { beads, syncCalls, asyncCalls } = makeRealBeadsClient();
    const adapter = makeFakeAdapter([
      pulledItem({ beadId: 'a', externalRef: 'WI-1' }),
      pulledItem({ beadId: 'b', externalRef: 'WI-2' }),
    ]);

    const result = await runIngest(
      { refs: ['a', 'b'], secretName: 's', epicTitle: 'a title with spaces' },
      { beads, adapter, log: () => {} }
    );

    assert.strictEqual(result.rootBeadId, 'epic-real-1');
    assert.strictEqual(result.syntheticRoot, true);

    const createCall = syncCalls.find((c) => c[0] === 'create');
    assert.ok(createCall, 'expected bd create to route through execBdSync');
    assert.ok(createCall.includes('a title with spaces'));

    // setParent's ids ('a', 'b', 'epic-real-1') are all safe-charset, so those
    // two calls route through execBdAsync -- proving BOTH routing branches
    // were exercised, not just the free-text one.
    assert.ok(asyncCalls.some((c) => c[0] === 'update'));
  });
});

// -- FIX 1: a REAL runIngest() result threaded into the REAL selectCarryOver --
//
// finalize.test.mjs hand-writes `syntheticRootId` onto a fake handle, which
// would not catch a rename of either field. This proves the actual
// producer (runIngest) and the actual consumer (selectCarryOver) agree on
// the shape end to end: the synthetic root's local-only status is
// load-bearing (design.md 2.7/8 -- it must never reach the tracker).

describe('FIX 1: runIngest -> selectCarryOver, producer and consumer wired for real', () => {
  test('a real synthetic root is excluded from carry-over; a genuine local bead is not', async () => {
    const beads = makeFakeBeads({ createResult: { id: 'epic-real-carryover-1' } });
    const adapter = makeFakeAdapter([
      pulledItem({ beadId: 'a' }),
      pulledItem({ beadId: 'b' }),
    ]);
    const startedAt = Date.parse('2026-01-01T00:00:00.000Z');

    const result = await runIngest(
      { refs: ['a', 'b'], secretName: 's' },
      { beads, adapter, log: () => {} }
    );

    assert.strictEqual(result.syntheticRoot, true);
    assert.strictEqual(result.syntheticRootId, result.rootBeadId);

    // Stand-in for a `bd list --json` snapshot taken at sprint end: it
    // includes the synthetic epic itself (created locally by ingest, never
    // pushed to the tracker) plus one genuine local follow-up bead.
    const rows = [
      {
        id: result.rootBeadId,
        title: 'Ingest epic for 2 item(s): WI-1, WI-1',
        status: 'open',
        issue_type: 'epic',
        created_at: new Date(startedAt + 1000).toISOString(),
      },
      {
        id: 'mem-followup-1',
        title: 'genuine local follow-up',
        status: 'open',
        issue_type: 'task',
        priority: 1,
        created_at: new Date(startedAt + 2000).toISOString(),
      },
    ];

    const { selected, skipped } = selectCarryOver(rows, {
      startedAt,
      // This is the exact translation the (not-yet-written) launch.mjs is
      // expected to perform: pass runIngest's own syntheticRootId straight
      // through, no re-derivation.
      syntheticRootId: result.syntheticRootId,
    });

    assert.ok(
      !selected.some((item) => item.beadId === result.rootBeadId),
      'the synthetic root must never be selected for carry-over'
    );
    assert.ok(
      skipped.some((s) => s.beadId === result.rootBeadId && s.reason === 'synthetic-root'),
      'the synthetic root must be skipped for the synthetic-root reason specifically'
    );
    assert.ok(
      selected.some((item) => item.beadId === 'mem-followup-1'),
      'a genuine local follow-up bead must still be selected'
    );
  });

  test('without the translation (undefined syntheticRootId), a natural-parent root is never mistaken for synthetic', async () => {
    const beads = makeFakeBeads();
    const adapter = makeFakeAdapter([
      pulledItem({ beadId: 'epic-a', parent: undefined }),
      pulledItem({ beadId: 'task-b', parent: 'epic-a' }),
    ]);
    const startedAt = Date.parse('2026-01-01T00:00:00.000Z');

    const result = await runIngest(
      { refs: ['epic-a', 'task-b'], secretName: 's' },
      { beads, adapter, log: () => {} }
    );
    assert.strictEqual(result.syntheticRootId, undefined);

    const rows = [
      {
        id: result.rootBeadId,
        title: 'a natural-parent epic pulled from the tracker',
        status: 'open',
        issue_type: 'epic',
        external_ref: 'WI-epic-a',
        created_at: new Date(startedAt + 1000).toISOString(),
      },
    ];

    const { selected, skipped } = selectCarryOver(rows, {
      startedAt,
      syntheticRootId: result.syntheticRootId,
    });

    // Excluded anyway here (it has an external_ref, so rule 2 skips it) --
    // the point is it is skipped for THAT reason, not misclassified as
    // 'synthetic-root' just because syntheticRootId was undefined.
    assert.strictEqual(selected.length, 0);
    assert.ok(skipped.some((s) => s.beadId === result.rootBeadId && s.reason === 'external_ref'));
  });
});

// -- reparent guard + closed-root visibility ----------------------------------
//
// Both of these cover the SECOND run of a pipeline, which is where ingest's
// re-run behaviour actually bites: the first run is always a clean create.

/**
 * A stateful fake that, unlike makeStatefulFakeBeads above, models the two
 * things these tests turn on: bd's OPEN-ONLY list default (honoured unless
 * the caller passes `all`), and `show()` reporting a bead's CURRENT parent
 * (which may have been set by a previous ingest, not by the tracker).
 */
function makeStatusAwareBeads(seedRows = []) {
  const rows = seedRows.map((r) => ({ ...r }));
  const createCalls = [];
  const setParentCalls = [];
  const listCalls = [];
  let seq = 1000;
  return {
    rows,
    createCalls,
    setParentCalls,
    listCalls,
    async create({ title, issueType, metadata } = {}) {
      createCalls.push({ title, issueType, metadata });
      seq += 1;
      const row = {
        id: `epic-${seq}`,
        title,
        issue_type: issueType || 'task',
        status: 'open',
        metadata,
        parent: null,
        created_at: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
      };
      rows.push(row);
      return { id: row.id, title: row.title };
    },
    async setParent(childId, parentId) {
      setParentCalls.push({ childId, parentId });
      const row = rows.find((r) => r.id === childId);
      if (row) row.parent = parentId;
      else rows.push({ id: childId, issue_type: 'task', status: 'open', parent: parentId });
      return { id: childId, parent: parentId };
    },
    async show(id) {
      return rows.find((r) => r.id === id) || null;
    },
    async list(opts = {}) {
      listCalls.push(opts);
      return rows
        // this is the whole point: without `all`, closed rows are INVISIBLE,
        // exactly as `bd list` behaves.
        .filter((r) => (opts.all ? true : r.status !== 'closed'))
        .filter((r) => !opts.type || r.issue_type === opts.type)
        .map((r) => ({ ...r }));
    },
  };
}

function makeFakeSupervisor(sprints, { fail } = {}) {
  const calls = [];
  return {
    calls,
    async listSprints() {
      calls.push('listSprints');
      if (fail) throw fail;
      return { sprints };
    },
  };
}

describe('resolveRoot reparent guard (live-sprint scope protection)', () => {
  test('a bead parented on a LIVE sprint issue root is never reparented, and the refusal names everything', async () => {
    const beads = makeStatusAwareBeads([
      { id: 'live-root', issue_type: 'epic', status: 'open', parent: null, created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'task-a', issue_type: 'task', status: 'open', parent: 'live-root' },
      { id: 'task-b', issue_type: 'task', status: 'open', parent: null },
    ]);
    const supervisorClient = makeFakeSupervisor([
      { sprintId: 'sprint-42', members: ['m1'], issueRoots: ['live-root'] },
    ]);
    const pulled = [
      { beadId: 'task-a', externalRef: '2', parent: null },
      { beadId: 'task-b', externalRef: '3', parent: null },
    ];

    let caught;
    try {
      await resolveRoot(pulled, { beads, supervisorClient, log: () => {} }, { refs: ['2', '3'] });
    } catch (e) { caught = e; }
    assert.ok(caught instanceof BridgeError, 'the hijack must be refused, not performed');
    assert.strictEqual(caught.code, BRIDGE_ERROR_CODES.LAUNCH_CONFLICT);
    assert.match(caught.message, /task-a/);
    assert.match(caught.message, /live-root/);
    assert.match(caught.message, /sprint-42/);

    // and, critically, NOTHING was moved -- the guard runs before any write.
    assert.strictEqual(beads.setParentCalls.length, 0, 'no bead may be reparented once the batch is refused');
    assert.strictEqual(beads.rows.find((r) => r.id === 'task-a').parent, 'live-root');
  });

  test('a bead whose current parent is NOT reserved reparents exactly as before', async () => {
    const beads = makeStatusAwareBeads([
      { id: 'stale-root', issue_type: 'epic', status: 'open', parent: null, created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'task-a', issue_type: 'task', status: 'open', parent: 'stale-root' },
      { id: 'task-b', issue_type: 'task', status: 'open', parent: null },
    ]);
    const supervisorClient = makeFakeSupervisor([
      { sprintId: 'sprint-42', issueRoots: ['some-other-root'] },
    ]);
    const pulled = [
      { beadId: 'task-a', externalRef: '2', parent: null },
      { beadId: 'task-b', externalRef: '3', parent: null },
    ];

    const result = await resolveRoot(pulled, { beads, supervisorClient, log: () => {} }, { refs: ['2', '3'] });

    assert.strictEqual(result.syntheticRoot, true);
    assert.deepStrictEqual(
      beads.setParentCalls.map((c) => c.childId).sort(),
      ['task-a', 'task-b'],
      'both beads still get reparented -- the guard only blocks RESERVED parents'
    );
    assert.strictEqual(beads.rows.find((r) => r.id === 'task-a').parent, result.rootBeadId);
  });

  test('an idempotent re-run (no bead changes parent) never asks the supervisor at all', async () => {
    const beads = makeStatusAwareBeads();
    const supervisorClient = makeFakeSupervisor([]);
    const pulled = [
      { beadId: 'task-a', externalRef: '2', parent: null },
      { beadId: 'task-b', externalRef: '3', parent: null },
    ];

    const first = await resolveRoot(pulled, { beads, supervisorClient, log: () => {} }, { refs: ['2', '3'] });
    const second = await resolveRoot(pulled, { beads, supervisorClient, log: () => {} }, { refs: ['2', '3'] });

    assert.strictEqual(second.rootBeadId, first.rootBeadId);
    assert.strictEqual(supervisorClient.calls.length, 0, 'a no-op reparent is not a hijack -- no reservation lookup is needed');
  });

  test('an UNREACHABLE supervisor stops the run -- it is not the same answer as "no reservations"', async () => {
    const seed = () => makeStatusAwareBeads([
      { id: 'other-root', issue_type: 'epic', status: 'open', parent: null, created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'task-a', issue_type: 'task', status: 'open', parent: 'other-root' },
      { id: 'task-b', issue_type: 'task', status: 'open', parent: null },
    ]);
    const pulled = [
      { beadId: 'task-a', externalRef: '2', parent: null },
      { beadId: 'task-b', externalRef: '3', parent: null },
    ];

    // unreachable: the client WAS wired, and it failed.
    const down = makeFakeSupervisor([], { fail: new Error('connect ECONNREFUSED 127.0.0.1:8787') });
    const beadsDown = seed();
    let caught;
    try {
      await resolveRoot(pulled, { beads: beadsDown, supervisorClient: down, log: () => {} }, { refs: ['2', '3'] });
    } catch (e) { caught = e; }
    assert.ok(caught instanceof BridgeError);
    assert.strictEqual(caught.code, BRIDGE_ERROR_CODES.SUPERVISOR_UNAVAILABLE);
    assert.match(caught.message, /ECONNREFUSED/);
    assert.strictEqual(beadsDown.setParentCalls.length, 0);

    // distinguishable from an EMPTY ledger, which proceeds normally.
    const empty = makeFakeSupervisor([]);
    const beadsEmpty = seed();
    const ok = await resolveRoot(pulled, { beads: beadsEmpty, supervisorClient: empty, log: () => {} }, { refs: ['2', '3'] });
    assert.strictEqual(beadsEmpty.setParentCalls.length, 2);
    assert.strictEqual(beadsEmpty.rows.find((r) => r.id === 'task-a').parent, ok.rootBeadId);
  });

  test('no supervisor client wired at all: proceeds, but warns per moved bead', async () => {
    const beads = makeStatusAwareBeads([
      { id: 'other-root', issue_type: 'epic', status: 'open', parent: null, created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'task-a', issue_type: 'task', status: 'open', parent: 'other-root' },
      { id: 'task-b', issue_type: 'task', status: 'open', parent: null },
    ]);
    const logs = [];
    const pulled = [
      { beadId: 'task-a', externalRef: '2', parent: null },
      { beadId: 'task-b', externalRef: '3', parent: null },
    ];

    const result = await resolveRoot(pulled, { beads, log: (m) => logs.push(m) }, { refs: ['2', '3'] });

    assert.strictEqual(beads.setParentCalls.length, 2, 'ingest still works with no supervisor in the deployment');
    assert.strictEqual(beads.rows.find((r) => r.id === 'task-a').parent, result.rootBeadId);
    const warning = logs.find((m) => m.includes('WARNING'));
    assert.ok(warning, 'the skipped check must be announced, not silent');
    assert.match(warning, /task-a from other-root/);
  });

  test('runIngest refuses CONFIG_INVALID for a supervisorClient with no listSprints()', async () => {
    await assert.rejects(
      () => runIngest(
        { refs: ['2'], secretName: 'tok' },
        { beads: makeStatusAwareBeads(), adapter: makeFakeAdapter([]), supervisorClient: {} }
      ),
      (e) => e instanceof BridgeError && e.code === BRIDGE_ERROR_CODES.CONFIG_INVALID
    );
  });
});

describe('findReusableRoot closed-root visibility', () => {
  test('the reuse scan asks for ALL statuses, not just open', async () => {
    const beads = makeStatusAwareBeads();
    await resolveRoot(
      [{ beadId: 'a', parent: null }, { beadId: 'b', parent: null }],
      { beads, log: () => {} },
      { refs: ['2', '3'] }
    );
    assert.strictEqual(beads.listCalls.length, 1);
    assert.strictEqual(beads.listCalls[0].all, true, 'a closed root must be visible to the lookup');
  });

  test('a CLOSED root matching the refsKey is found and refused -- never silently duplicated or revived', async () => {
    const beads = makeStatusAwareBeads([
      {
        id: 'epic-closed-root',
        issue_type: 'epic',
        status: 'closed',
        closed_at: '2026-02-01T00:00:00.000Z',
        metadata: { fleetBridgeIngestRoot: true, fleetBridgeIngestRefsKey: '2,3' },
        created_at: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const pulled = [{ beadId: 'a', parent: null }, { beadId: 'b', parent: null }];

    let caught;
    try {
      await resolveRoot(pulled, { beads, log: () => {} }, { refs: ['2', '3'] });
    } catch (e) { caught = e; }

    assert.ok(caught instanceof BridgeError);
    assert.strictEqual(caught.code, BRIDGE_ERROR_CODES.INGEST_REF_AMBIGUOUS);
    assert.match(caught.message, /epic-closed-root/);
    assert.deepStrictEqual(caught.details.closedRoots, ['epic-closed-root']);
    assert.strictEqual(beads.createCalls.length, 0, 'no duplicate root may be created behind the operator back');
    assert.strictEqual(beads.rows.find((r) => r.id === 'epic-closed-root').status, 'closed', 'and the closed root stays closed');
  });

  test('an OPEN match still wins even when a closed match also exists', async () => {
    const beads = makeStatusAwareBeads([
      {
        id: 'epic-closed-root',
        issue_type: 'epic',
        status: 'closed',
        metadata: { fleetBridgeIngestRoot: true, fleetBridgeIngestRefsKey: '2,3' },
        created_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'epic-open-root',
        issue_type: 'epic',
        status: 'open',
        metadata: { fleetBridgeIngestRoot: true, fleetBridgeIngestRefsKey: '2,3' },
        created_at: '2026-01-02T00:00:00.000Z',
      },
    ]);
    const pulled = [{ beadId: 'a', parent: null }, { beadId: 'b', parent: null }];

    const result = await resolveRoot(pulled, { beads, log: () => {} }, { refs: ['2', '3'] });

    assert.strictEqual(result.rootBeadId, 'epic-open-root');
    assert.strictEqual(beads.createCalls.length, 0);
  });
});
