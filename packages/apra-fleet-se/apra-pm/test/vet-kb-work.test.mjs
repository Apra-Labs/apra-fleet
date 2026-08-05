// Phase 2 of docs/superpowers/specs/2026-08-03-kb-trust-pipeline-design.md.
//
// The engine validates a role's KB payload and makes the calls itself, so a
// payload that would be refused downstream must produce NO tool call at all.
// These pin the three properties the design names: a well-formed payload
// survives vetting, a malformed or unverifiable one does not, and kb_promotions
// from a non-reviewer role is refused outright.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { vetKbWork, KB_MIN_PROMOTE_REASON } from '../lib/vet-kb-work.mjs';

const GOOD_CAPTURE = {
  type: 'knowledge',
  title: 'getKbProviders is the only KB accessor',
  summary: 'Every kb_* tool routes through getKbProviders so the KB is repo-scoped.',
  source_files: ['src/services/knowledge/kb-providers.ts'],
  symbols: ['getKbProviders'],
};

const GOOD_PROMOTION = {
  id: 'abc123',
  reason: 'Verified against src/services/knowledge/kb-providers.ts: the cache is keyed per slug.',
};

describe('a well-formed payload survives vetting', () => {
  test('a valid capture is kept verbatim', () => {
    const { captures, rejected } = vetKbWork('doer', { kb_captures: [GOOD_CAPTURE] });
    assert.equal(captures.length, 1);
    assert.deepEqual(captures[0].source_files, ['src/services/knowledge/kb-providers.ts']);
    assert.deepEqual(rejected, []);
  });

  test('a reviewer promotion with recorded evidence is kept', () => {
    const { promotions, rejected } = vetKbWork('reviewer', { kb_promotions: [GOOD_PROMOTION] });
    assert.equal(promotions.length, 1);
    assert.equal(promotions[0].id, 'abc123');
    assert.deepEqual(rejected, []);
  });

  test('capture is accepted from all four capture roles', () => {
    for (const role of ['doer', 'reviewer', 'planner', 'harvester']) {
      const { captures } = vetKbWork(role, { kb_captures: [GOOD_CAPTURE] });
      assert.equal(captures.length, 1, `${role} should be able to capture`);
    }
  });

  test('a missing or empty payload yields no work and no complaint', () => {
    for (const result of [null, undefined, {}, { kb_captures: [], kb_promotions: [] }]) {
      const { captures, promotions, rejected } = vetKbWork('doer', result);
      assert.deepEqual(captures, []);
      assert.deepEqual(promotions, []);
      assert.deepEqual(rejected, []);
    }
  });
});

describe('an unverifiable payload produces no tool call', () => {
  test('a capture citing no source files is dropped', () => {
    const { captures, rejected } = vetKbWork('doer', {
      kb_captures: [{ ...GOOD_CAPTURE, source_files: [] }],
    });
    assert.deepEqual(captures, []);
    assert.match(rejected[0], /cites no source files/);
  });

  test('a capture with no source_files key at all is dropped', () => {
    const c = { ...GOOD_CAPTURE };
    delete c.source_files;
    const { captures, rejected } = vetKbWork('doer', { kb_captures: [c] });
    assert.deepEqual(captures, []);
    assert.equal(rejected.length, 1);
  });

  test('a capture missing title or summary is dropped', () => {
    const { captures, rejected } = vetKbWork('doer', {
      kb_captures: [{ type: 'knowledge', source_files: ['src/a.ts'] }],
    });
    assert.deepEqual(captures, []);
    assert.match(rejected[0], /missing title\/summary/);
  });

  test('a capture of an unsupported type is dropped', () => {
    // user-directive is CLI-terminal and must never be mintable by a role.
    for (const type of ['user-directive', 'context-cache', 'nonsense']) {
      const { captures, rejected } = vetKbWork('doer', {
        kb_captures: [{ ...GOOD_CAPTURE, type }],
      });
      assert.deepEqual(captures, [], `${type} must not be capturable by a role`);
      assert.match(rejected[0], /unsupported type/);
    }
  });

  test('one bad capture does not discard the good ones beside it', () => {
    const { captures, rejected } = vetKbWork('doer', {
      kb_captures: [{ ...GOOD_CAPTURE, source_files: [] }, GOOD_CAPTURE],
    });
    assert.equal(captures.length, 1);
    assert.equal(rejected.length, 1);
  });

  test('a promotion with a trivial reason is dropped', () => {
    for (const reason of ['', '   ', 'ok', 'lgtm', 'verified']) {
      const { promotions, rejected } = vetKbWork('reviewer', {
        kb_promotions: [{ id: 'abc123', reason }],
      });
      assert.deepEqual(promotions, [], `reason ${JSON.stringify(reason)} must be refused`);
      assert.match(rejected[0], /no recorded evidence/);
    }
  });

  test('the reason floor matches the provider gate', () => {
    const { promotions } = vetKbWork('reviewer', {
      kb_promotions: [{ id: 'abc123', reason: 'x'.repeat(KB_MIN_PROMOTE_REASON) }],
    });
    assert.equal(promotions.length, 1);
    const short = vetKbWork('reviewer', {
      kb_promotions: [{ id: 'abc123', reason: 'x'.repeat(KB_MIN_PROMOTE_REASON - 1) }],
    });
    assert.deepEqual(short.promotions, []);
  });

  test('a promotion missing an id is dropped', () => {
    const { promotions, rejected } = vetKbWork('reviewer', {
      kb_promotions: [{ reason: GOOD_PROMOTION.reason }],
    });
    assert.deepEqual(promotions, []);
    assert.match(rejected[0], /missing id/);
  });
});

describe('promotion stays reviewer-only', () => {
  test('kb_promotions from a non-reviewer role is refused outright', () => {
    for (const role of ['doer', 'planner', 'harvester', 'deployer']) {
      const { promotions, rejected } = vetKbWork(role, { kb_promotions: [GOOD_PROMOTION] });
      assert.deepEqual(promotions, [], `${role} must not be able to promote`);
      assert.match(rejected[0], /promotion is reviewer-only/);
    }
  });

  test('a non-reviewer keeps its captures even when its promotions are refused', () => {
    const { captures, promotions, rejected } = vetKbWork('doer', {
      kb_captures: [GOOD_CAPTURE],
      kb_promotions: [GOOD_PROMOTION],
    });
    assert.equal(captures.length, 1);
    assert.deepEqual(promotions, []);
    assert.equal(rejected.length, 1);
  });
});
