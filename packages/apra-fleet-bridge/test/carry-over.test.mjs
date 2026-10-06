// Tests for src/carry-over.mjs -- exhaustive, per the module's own
// justification for existing (pure + no I/O so it CAN be tested exhaustively).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertThrows } from './helpers.mjs';
import { selectCarryOver } from '../src/carry-over.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';

const STARTED_AT = Date.parse('2026-09-18T10:00:00Z');
const BEFORE = new Date(STARTED_AT - 60_000).toISOString();
const AT = new Date(STARTED_AT).toISOString();
const AFTER = new Date(STARTED_AT + 60_000).toISOString();
const LATER = new Date(STARTED_AT + 120_000).toISOString();

/** Table-driven row factory with sane carry-over-eligible defaults. */
function row(overrides = {}) {
  return {
    id: 'mem-001',
    title: 'fix the thing',
    description: 'body text',
    acceptance_criteria: 'criteria text',
    issue_type: 'bug',
    priority: 2,
    status: 'open',
    external_ref: null,
    created_at: AFTER,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rule 1 -- not closed
// ---------------------------------------------------------------------------

describe('rule 1: not closed', () => {
  test('closed status is excluded, reason "closed"', () => {
    const { selected, suppressed, skipped } = selectCarryOver([row({ status: 'closed' })], {
      startedAt: STARTED_AT,
    });
    assert.deepEqual(selected, []);
    assert.deepEqual(suppressed, []);
    assert.deepEqual(skipped, [{ beadId: 'mem-001', reason: 'closed' }]);
  });

  for (const status of ['open', 'in_progress', 'blocked', 'deferred']) {
    test(`status "${status}" is included (not excluded by rule 1)`, () => {
      const { selected, skipped } = selectCarryOver([row({ id: `mem-${status}`, status })], {
        startedAt: STARTED_AT,
      });
      assert.equal(skipped.length, 0);
      assert.equal(selected.length, 1);
      assert.equal(selected[0].beadId, `mem-${status}`);
    });
  }

  test('missing status is excluded, reason "closed" (unknown is never assumed open)', () => {
    const { selected, skipped } = selectCarryOver([row({ status: undefined })], { startedAt: STARTED_AT });
    assert.equal(selected.length, 0);
    assert.deepEqual(skipped, [{ beadId: 'mem-001', reason: 'closed' }]);
  });

  test('unrecognized status string is excluded, reason "closed"', () => {
    const { selected, skipped } = selectCarryOver([row({ status: 'wontfix' })], { startedAt: STARTED_AT });
    assert.equal(selected.length, 0);
    assert.deepEqual(skipped, [{ beadId: 'mem-001', reason: 'closed' }]);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 -- no external_ref, and the idempotence property it creates
// ---------------------------------------------------------------------------

describe('rule 2: no external_ref', () => {
  test('non-empty external_ref is excluded, reason "external_ref"', () => {
    const { selected, skipped } = selectCarryOver([row({ external_ref: 'WI-123' })], { startedAt: STARTED_AT });
    assert.equal(selected.length, 0);
    assert.deepEqual(skipped, [{ beadId: 'mem-001', reason: 'external_ref' }]);
  });

  test('null/undefined/empty-string external_ref does not exclude', () => {
    for (const value of [null, undefined, '']) {
      const { selected, skipped } = selectCarryOver([row({ external_ref: value })], { startedAt: STARTED_AT });
      assert.equal(skipped.length, 0, `external_ref=${JSON.stringify(value)} should not be excluded`);
      assert.equal(selected.length, 1);
    }
  });

  test('idempotence: re-running once external_ref has been stamped selects zero', () => {
    const rows = [row({ id: 'mem-a' }), row({ id: 'mem-b', priority: 1 })];
    const first = selectCarryOver(rows, { startedAt: STARTED_AT });
    assert.equal(first.selected.length, 2);

    // Simulate publishCarryOver stamping external_ref back onto the pushed beads.
    const republished = rows.map((r) => ({ ...r, external_ref: `WI-${r.id}` }));
    const second = selectCarryOver(republished, { startedAt: STARTED_AT });
    assert.deepEqual(second.selected, []);
    assert.deepEqual(second.suppressed, []);
    assert.equal(second.skipped.length, 2);
    assert.ok(second.skipped.every((s) => s.reason === 'external_ref'));
  });
});

// ---------------------------------------------------------------------------
// Rule 3 -- attributable to this sprint (created-after only; amendment 1)
// ---------------------------------------------------------------------------

describe('rule 3: created-after startedAt only', () => {
  test('created strictly after startedAt is included', () => {
    const { selected, skipped } = selectCarryOver([row({ created_at: AFTER })], { startedAt: STARTED_AT });
    assert.equal(skipped.length, 0);
    assert.equal(selected.length, 1);
  });

  test('created before startedAt is excluded, reason "not-attributable"', () => {
    const { selected, skipped } = selectCarryOver([row({ created_at: BEFORE })], { startedAt: STARTED_AT });
    assert.equal(selected.length, 0);
    assert.deepEqual(skipped, [{ beadId: 'mem-001', reason: 'not-attributable' }]);
  });

  test('created exactly at startedAt is excluded (strictly-after boundary)', () => {
    const { selected, skipped } = selectCarryOver([row({ created_at: AT })], { startedAt: STARTED_AT });
    assert.equal(selected.length, 0);
    assert.deepEqual(skipped, [{ beadId: 'mem-001', reason: 'not-attributable' }]);
  });

  test('missing created_at is excluded, reason "not-attributable"', () => {
    const { selected, skipped } = selectCarryOver([row({ created_at: undefined })], { startedAt: STARTED_AT });
    assert.equal(selected.length, 0);
    assert.deepEqual(skipped, [{ beadId: 'mem-001', reason: 'not-attributable' }]);
  });

  test('unparseable created_at is excluded, reason "not-attributable", no throw', () => {
    const { selected, skipped } = selectCarryOver([row({ created_at: 'not-a-date' })], { startedAt: STARTED_AT });
    assert.equal(selected.length, 0);
    assert.deepEqual(skipped, [{ beadId: 'mem-001', reason: 'not-attributable' }]);
  });

  test('startedAt accepted as either epoch-ms number or ISO-8601 string', () => {
    const a = selectCarryOver([row({ id: 'mem-a', created_at: AFTER })], { startedAt: STARTED_AT });
    const b = selectCarryOver([row({ id: 'mem-b', created_at: AFTER })], {
      startedAt: new Date(STARTED_AT).toISOString(),
    });
    assert.equal(a.selected.length, 1);
    assert.equal(b.selected.length, 1);
  });

  test('the other two disjuncts from the original design (scope, [carry-over] title) are NOT reintroduced', () => {
    // A bead titled '[carry-over]' (no regression marker) but created BEFORE
    // startedAt must still be excluded -- title alone no longer grants
    // attribution now that rule 3 is narrowed to created-after only.
    const { selected, skipped } = selectCarryOver(
      [row({ title: '[carry-over] something', created_at: BEFORE })],
      { startedAt: STARTED_AT }
    );
    assert.equal(selected.length, 0);
    assert.deepEqual(skipped, [{ beadId: 'mem-001', reason: 'not-attributable' }]);
  });
});

// ---------------------------------------------------------------------------
// Synthetic root -- always excluded, ahead of the three rules
// ---------------------------------------------------------------------------

describe('synthetic root exclusion', () => {
  test('excluded regardless of otherwise-qualifying status/external_ref/created_at', () => {
    const { selected, skipped } = selectCarryOver(
      [row({ id: 'mem-root', status: 'open', external_ref: null, created_at: AFTER })],
      { startedAt: STARTED_AT, syntheticRootId: 'mem-root' }
    );
    assert.equal(selected.length, 0);
    assert.deepEqual(skipped, [{ beadId: 'mem-root', reason: 'synthetic-root' }]);
  });

  test('a non-matching id is unaffected by syntheticRootId', () => {
    const { selected } = selectCarryOver([row({ id: 'mem-other' })], {
      startedAt: STARTED_AT,
      syntheticRootId: 'mem-root',
    });
    assert.equal(selected.length, 1);
  });

  test('omitted syntheticRootId excludes nothing extra', () => {
    const { selected, skipped } = selectCarryOver([row()], { startedAt: STARTED_AT });
    assert.equal(skipped.length, 0);
    assert.equal(selected.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Reason classification, including documented precedence for overlap
// ---------------------------------------------------------------------------

describe('reason classification', () => {
  test('title matching the regression marker classifies as "regression"', () => {
    const { selected } = selectCarryOver(
      [row({ status: 'open', title: '[regression][carry-over] checkout total wrong for zero-qty' })],
      { startedAt: STARTED_AT }
    );
    assert.equal(selected[0].reason, 'regression');
  });

  test('status "deferred" (no marker) classifies as "deferred"', () => {
    const { selected } = selectCarryOver([row({ status: 'deferred', title: 'low priority cleanup' })], {
      startedAt: STARTED_AT,
    });
    assert.equal(selected[0].reason, 'deferred');
  });

  for (const status of ['open', 'in_progress', 'blocked']) {
    test(`status "${status}" (no marker) classifies as "unfinished"`, () => {
      const { selected } = selectCarryOver([row({ status, title: 'still going' })], { startedAt: STARTED_AT });
      assert.equal(selected[0].reason, 'unfinished');
    });
  }

  test('PRECEDENCE: a title matching the regression marker on a deferred bead classifies as "regression", not "deferred"', () => {
    // Documented, deliberate choice (see classifyReason's doc comment in
    // carry-over.mjs): the title marker is the regression phase's explicit,
    // intentional signal and wins over the status-derived classification.
    const { selected } = selectCarryOver(
      [row({ status: 'deferred', title: '[regression][carry-over] flaky under load' })],
      { startedAt: STARTED_AT }
    );
    assert.equal(selected.length, 1);
    assert.equal(selected[0].reason, 'regression');
  });

  test('a bare "[carry-over]" title without the full regression marker does not classify as regression', () => {
    const { selected } = selectCarryOver([row({ status: 'open', title: '[carry-over] partial marker only' })], {
      startedAt: STARTED_AT,
    });
    assert.equal(selected[0].reason, 'unfinished');
  });
});

// ---------------------------------------------------------------------------
// CarryOverItem shape
// ---------------------------------------------------------------------------

describe('CarryOverItem shape', () => {
  test('selected item carries the fields derivable from a bd row, and is frozen', () => {
    const { selected } = selectCarryOver(
      [
        row({
          id: 'mem-shape',
          title: 'a title',
          description: 'a body',
          acceptance_criteria: 'given/when/then',
          issue_type: 'bug',
          priority: 1,
        }),
      ],
      { startedAt: STARTED_AT }
    );
    assert.deepEqual(selected[0], {
      beadId: 'mem-shape',
      title: 'a title',
      body: 'a body',
      acceptanceCriteria: 'given/when/then',
      issueType: 'bug',
      priority: 1,
      reason: 'unfinished',
    });
    assert.ok(Object.isFrozen(selected[0]));
  });
});

// ---------------------------------------------------------------------------
// maxCarryOver amendment: top-N selected, rest suppressed (never dropped)
// ---------------------------------------------------------------------------

describe('maxCarryOver: top-N selected, remainder suppressed', () => {
  function candidateRows(n) {
    return Array.from({ length: n }, (_, i) =>
      row({ id: `mem-${String(i).padStart(3, '0')}`, priority: (i % 3) + 1, created_at: AFTER })
    );
  }

  test('boundary: exactly N candidates with maxCarryOver=N selects all, suppresses none', () => {
    const rows = candidateRows(5);
    const { selected, suppressed, skipped } = selectCarryOver(rows, { startedAt: STARTED_AT, maxCarryOver: 5 });
    assert.equal(selected.length, 5);
    assert.equal(suppressed.length, 0);
    assert.equal(skipped.length, 0);
  });

  test('boundary: N+1 candidates with maxCarryOver=N selects N, suppresses exactly 1', () => {
    const rows = candidateRows(6);
    const { selected, suppressed } = selectCarryOver(rows, { startedAt: STARTED_AT, maxCarryOver: 5 });
    assert.equal(selected.length, 5);
    assert.equal(suppressed.length, 1);
  });

  test('default maxCarryOver is 25', () => {
    const rows = candidateRows(26);
    const { selected, suppressed } = selectCarryOver(rows, { startedAt: STARTED_AT });
    assert.equal(selected.length, 25);
    assert.equal(suppressed.length, 1);
  });

  test('maxCarryOver=0 selects none, suppresses all otherwise-qualifying candidates', () => {
    const rows = candidateRows(3);
    const { selected, suppressed } = selectCarryOver(rows, { startedAt: STARTED_AT, maxCarryOver: 0 });
    assert.equal(selected.length, 0);
    assert.equal(suppressed.length, 3);
  });

  test('selection is by priority ascending: lower Pn wins the cut first', () => {
    const rows = [
      row({ id: 'mem-p3', priority: 3, created_at: AFTER }),
      row({ id: 'mem-p1', priority: 1, created_at: AFTER }),
      row({ id: 'mem-p2', priority: 2, created_at: AFTER }),
    ];
    const { selected, suppressed } = selectCarryOver(rows, { startedAt: STARTED_AT, maxCarryOver: 2 });
    assert.deepEqual(
      selected.map((s) => s.beadId),
      ['mem-p1', 'mem-p2']
    );
    assert.deepEqual(
      suppressed.map((s) => s.beadId),
      ['mem-p3']
    );
  });

  test('missing/non-numeric priority sorts last (worst)', () => {
    const rows = [
      row({ id: 'mem-none', priority: undefined, created_at: AFTER }),
      row({ id: 'mem-p1', priority: 1, created_at: AFTER }),
    ];
    const { selected, suppressed } = selectCarryOver(rows, { startedAt: STARTED_AT, maxCarryOver: 1 });
    assert.deepEqual(selected.map((s) => s.beadId), ['mem-p1']);
    assert.deepEqual(suppressed.map((s) => s.beadId), ['mem-none']);
  });

  test('tiebreak on equal priority is by beadId ascending, and is stable regardless of input order', () => {
    const rowsInOrder = [
      row({ id: 'mem-b', priority: 1, created_at: AFTER }),
      row({ id: 'mem-a', priority: 1, created_at: AFTER }),
      row({ id: 'mem-c', priority: 1, created_at: AFTER }),
    ];
    const rowsShuffled = [rowsInOrder[2], rowsInOrder[0], rowsInOrder[1]];

    const first = selectCarryOver(rowsInOrder, { startedAt: STARTED_AT, maxCarryOver: 2 });
    const second = selectCarryOver(rowsShuffled, { startedAt: STARTED_AT, maxCarryOver: 2 });

    assert.deepEqual(
      first.selected.map((s) => s.beadId),
      ['mem-a', 'mem-b']
    );
    assert.deepEqual(
      first.suppressed.map((s) => s.beadId),
      ['mem-c']
    );
    // Same set of rows, different input order -> identical split and order.
    assert.deepEqual(first.selected, second.selected);
    assert.deepEqual(first.suppressed, second.suppressed);
  });

  test('suppressed candidates are never placed in skipped', () => {
    const rows = candidateRows(3);
    const { suppressed, skipped } = selectCarryOver(rows, { startedAt: STARTED_AT, maxCarryOver: 1 });
    assert.equal(suppressed.length, 2);
    assert.equal(skipped.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Empty input
// ---------------------------------------------------------------------------

describe('empty input', () => {
  test('empty rows array returns three empty arrays', () => {
    const result = selectCarryOver([], { startedAt: STARTED_AT });
    assert.deepEqual(result, { selected: [], suppressed: [], skipped: [] });
  });
});

// ---------------------------------------------------------------------------
// Malformed rows never throw
// ---------------------------------------------------------------------------

describe('malformed rows do not throw', () => {
  const malformedCases = [
    ['null row', null],
    ['undefined row', undefined],
    ['string row', 'not-an-object'],
    ['number row', 42],
    ['array row', ['unexpected', 'array']],
    ['row missing id', row({ id: undefined })],
    ['row with non-string id', row({ id: 12345 })],
    ['row missing title', row({ title: undefined })],
    ['row missing status', { id: 'mem-x', created_at: AFTER }],
    ['row missing created_at', { id: 'mem-x', status: 'open' }],
    ['row with non-string external_ref', row({ external_ref: 42 })],
    ['row with non-numeric priority', row({ priority: 'P1' })],
    ['completely empty object row', {}],
  ];

  for (const [label, badRow] of malformedCases) {
    test(`does not throw: ${label}`, () => {
      assert.doesNotThrow(() => selectCarryOver([badRow], { startedAt: STARTED_AT }));
    });
  }

  test('a mix of malformed and valid rows still processes the valid ones', () => {
    const rows = [null, undefined, 'garbage', row({ id: 'mem-good', created_at: AFTER })];
    const { selected, skipped } = selectCarryOver(rows, { startedAt: STARTED_AT });
    assert.equal(selected.length, 1);
    assert.equal(selected[0].beadId, 'mem-good');
    assert.equal(skipped.length, 3);
    assert.ok(skipped.every((s) => s.beadId === null && s.reason === 'invalid-row'));
  });

  test('a valid row with an unidentifiable id still reports a skip with beadId null, not a throw', () => {
    const { skipped } = selectCarryOver([row({ id: undefined, status: 'closed' })], { startedAt: STARTED_AT });
    assert.deepEqual(skipped, [{ beadId: null, reason: 'closed' }]);
  });
});

// ---------------------------------------------------------------------------
// Caller-contract validation (rows/opts themselves, not individual rows)
// ---------------------------------------------------------------------------

describe('caller-contract validation', () => {
  test('rows must be an array', () => {
    const err = assertThrows(() => selectCarryOver('not-an-array', { startedAt: STARTED_AT }));
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('opts.startedAt is required', () => {
    const err = assertThrows(() => selectCarryOver([], {}));
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });

  test('opts.startedAt must be a parseable timestamp', () => {
    const err = assertThrows(() => selectCarryOver([], { startedAt: 'not-a-date' }));
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('opts.maxCarryOver must be a non-negative integer', () => {
    for (const bad of [-1, 1.5, 'five', NaN, Infinity]) {
      const err = assertThrows(() => selectCarryOver([], { startedAt: STARTED_AT, maxCarryOver: bad }));
      assert.ok(err instanceof BridgeError, `maxCarryOver=${bad} should throw a BridgeError`);
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    }
  });

  test('every thrown error is a BridgeError (error-rule compliance from the caller side)', () => {
    const attempts = [
      () => selectCarryOver(null, { startedAt: STARTED_AT }),
      () => selectCarryOver([], null),
      () => selectCarryOver([], {}),
      () => selectCarryOver([], { startedAt: STARTED_AT, maxCarryOver: -1 }),
    ];
    for (const attempt of attempts) {
      const err = assertThrows(attempt);
      assert.ok(err instanceof BridgeError, `expected a BridgeError, got ${err && err.constructor && err.constructor.name}`);
    }
  });
});
