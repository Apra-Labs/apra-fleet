// Tests for src/verbs/finalize.mjs -- fake supervisorClient/beads/adapter/
// spool throughout; one dedicated test wires the REAL beads-client (src/
// beads-client.mjs) with a fake execBdSync/execBdAsync pair to prove
// queryCandidateRows()'s `bd list --created-after <ISO>` call actually
// routes through execBdSync, mirroring ingest.test.mjs's own "against the
// real beads-client" section.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertThrows } from './helpers.mjs';

import {
  runFinalize,
  validateFinalizeOpts,
  assertSprintTerminal,
  toIsoTimestamp,
  queryCandidateRows,
  publishOne,
  publishSelected,
  buildSuppressedSummaryBead,
  fileSuppressedSummary,
  analysisDocPathFor,
  buildFinalCommentBody,
  postFinalComment,
} from '../src/verbs/finalize.mjs';
import { BridgeError, BRIDGE_ERROR_CODES, exitCodeFor } from '../src/errors.mjs';
import { createBeadsClient } from '../src/beads-client.mjs';
// verdictFromSprint/prUrlFromSprint/spendUsdFromSprint are ../src/snapshot.mjs's
// to own and are unit-tested in snapshot.test.mjs; computeBranchSlug is the
// engine's own function (apra-fleet-se/fleet-sprint/sprint-report.mjs) --
// finalize.mjs imports both rather than keeping local copies (see that
// module's header), so these tests exercise the exact function it uses.
import { computeBranchSlug } from '@apralabs/apra-fleet-se/fleet-sprint/sprint-report.mjs';

// ---------------------------------------------------------------------------
// Fixtures and fakes
// ---------------------------------------------------------------------------

const STARTED_AT = Date.parse('2026-09-01T00:00:00.000Z');
const AFTER = new Date(STARTED_AT + 60_000).toISOString();

function makeHandle(overrides = {}) {
  return {
    version: 1,
    sprintId: 'spr-1',
    request: {
      platform: 'azure-devops',
      workItems: ['WI-100'],
      targetBranch: 'auto-sprint/spr-1',
      member: 'm1',
      goal: 'P1/P2',
      mode: 'detached',
    },
    syntheticRootId: 'root-epic-1',
    startedAt: STARTED_AT,
    ...overrides,
  };
}

function terminalSprint(overrides = {}) {
  return {
    sprintId: 'spr-1',
    live: false,
    terminal: true,
    state: {
      result: { verdict: 'PASS', prUrl: 'https://dev.azure.com/org/proj/_git/repo/pullrequest/42' },
      stats: { totalCost: 12.5 },
    },
    history: null,
    latest: null,
    ...overrides,
  };
}

function makeRow(overrides = {}) {
  return {
    id: 'row-1',
    title: 'a carry-over candidate',
    description: 'body text',
    acceptance_criteria: 'ac',
    issue_type: 'task',
    priority: 2,
    status: 'open',
    external_ref: null,
    created_at: AFTER,
    ...overrides,
  };
}

/** A fake beads client backed by a mutable in-memory store, shared with a
 *  fake adapter so publishing can stamp external_ref onto the same rows
 *  list() later reads back -- this is what makes the idempotence test work
 *  without a real bd binary. */
function makeFakeBeadsStore(initialRows = []) {
  const rows = new Map(initialRows.map((r) => [r.id, { ...r }]));
  const listCalls = [];
  const createCalls = [];
  return {
    rows,
    listCalls,
    createCalls,
    async list({ status, createdAfter } = {}) {
      listCalls.push({ status, createdAfter });
      const statuses = typeof status === 'string' ? status.split(',') : null;
      const afterMs = createdAfter !== undefined ? Date.parse(createdAfter) : null;
      return [...rows.values()]
        .filter((r) => !statuses || statuses.includes(r.status))
        .filter((r) => (afterMs === null ? true : Date.parse(r.created_at) > afterMs))
        .map((r) => ({ ...r }));
    },
    async create(fields) {
      createCalls.push(fields);
      const id = `summary-${createCalls.length}`;
      rows.set(id, {
        id,
        title: fields.title,
        description: fields.description,
        issue_type: fields.issueType,
        priority: 9,
        status: 'open',
        external_ref: null,
        created_at: new Date(STARTED_AT + 1_000 + createCalls.length).toISOString(),
      });
      return { id };
    },
  };
}

/** A fake adapter whose publishCarryOver stamps external_ref onto the given
 *  fake beads store's rows -- mirrors createNativeBeadsSync's real
 *  dispatch-then-read-back contract closely enough for these tests. */
function makeFakeAdapter({ beads, failFor = new Set(), commentImpl } = {}) {
  const publishCalls = [];
  const commentCalls = [];
  return {
    publishCalls,
    commentCalls,
    async publishCarryOver({ beadIds, secretName, dryRun }) {
      publishCalls.push({ beadIds: [...beadIds], secretName, dryRun });
      const results = [];
      for (const beadId of beadIds) {
        if (!dryRun && failFor.has(beadId)) {
          throw new Error(`publish failed for ${beadId}`);
        }
        const row = beads.rows.get(beadId);
        if (!dryRun && row) row.external_ref = `WI-${beadId}`;
        results.push({
          beadId,
          externalRef: row ? row.external_ref : null,
          pushed: !dryRun && Boolean(row && row.external_ref),
        });
      }
      return results;
    },
    async comment(markdown) {
      commentCalls.push(markdown);
      if (commentImpl) return commentImpl(markdown);
      return { ok: true };
    },
  };
}

function makeFakeSupervisorClient(sprint) {
  let current = sprint;
  const calls = [];
  return {
    calls,
    async getSprint(id) {
      calls.push(id);
      return current;
    },
    setSprint(s) {
      current = s;
    },
  };
}

function makeFakeSpool() {
  const completeCalls = [];
  return {
    completeCalls,
    async complete(sprintId, result) {
      completeCalls.push({ sprintId, result });
      return { sprintId };
    },
  };
}

function noop() {}

// ---------------------------------------------------------------------------
// validateFinalizeOpts
// ---------------------------------------------------------------------------

describe('validateFinalizeOpts', () => {
  test('throws CONFIG_MISSING when handle is missing', () => {
    assert.throws(() => validateFinalizeOpts({ secretName: 's' }), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
  });

  test('throws CONFIG_INVALID when handle.sprintId is missing', () => {
    assert.throws(() => validateFinalizeOpts({ handle: { startedAt: 1 }, secretName: 's' }), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      return true;
    });
  });

  test('throws CONFIG_MISSING when handle.startedAt is missing', () => {
    assert.throws(() => validateFinalizeOpts({ handle: { sprintId: 's1' }, secretName: 's' }), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
  });

  test('throws CONFIG_MISSING when secretName is missing', () => {
    assert.throws(() => validateFinalizeOpts({ handle: makeHandle() }), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
  });

  test('throws CONFIG_INVALID for a negative maxCarryOver', () => {
    assert.throws(() => validateFinalizeOpts({ handle: makeHandle(), secretName: 's', maxCarryOver: -1 }), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      return true;
    });
  });

  test('dryRun defaults to false and normalizes to a strict boolean', () => {
    assert.strictEqual(validateFinalizeOpts({ handle: makeHandle(), secretName: 's' }).dryRun, false);
    assert.strictEqual(validateFinalizeOpts({ handle: makeHandle(), secretName: 's', dryRun: 'yes' }).dryRun, false);
    assert.strictEqual(validateFinalizeOpts({ handle: makeHandle(), secretName: 's', dryRun: true }).dryRun, true);
  });

  test('returns a frozen object', () => {
    const v = validateFinalizeOpts({ handle: makeHandle(), secretName: 's' });
    assert.throws(() => { v.secretName = 'x'; }, TypeError);
  });
});

// ---------------------------------------------------------------------------
// assertSprintTerminal
// ---------------------------------------------------------------------------

describe('assertSprintTerminal', () => {
  test('returns the sprint when terminal', async () => {
    const sc = makeFakeSupervisorClient(terminalSprint());
    const sprint = await assertSprintTerminal('spr-1', sc);
    assert.strictEqual(sprint.terminal, true);
  });

  test('throws FINALIZE_NOT_TERMINAL when the sprint is still live', async () => {
    const sc = makeFakeSupervisorClient({ sprintId: 'spr-1', live: true, terminal: false, state: {} });
    await assert.rejects(() => assertSprintTerminal('spr-1', sc), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.FINALIZE_NOT_TERMINAL);
      return true;
    });
  });

  test('throws FINALIZE_NOT_TERMINAL when the sprint is not found', async () => {
    const sc = makeFakeSupervisorClient(null);
    await assert.rejects(() => assertSprintTerminal('spr-ghost', sc), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.FINALIZE_NOT_TERMINAL);
      assert.strictEqual(err.details.found, false);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// toIsoTimestamp / queryCandidateRows
// ---------------------------------------------------------------------------

describe('toIsoTimestamp', () => {
  test('an epoch-ms number becomes an ISO-8601 string', () => {
    assert.strictEqual(toIsoTimestamp(STARTED_AT), new Date(STARTED_AT).toISOString());
  });

  test('an ISO string passes through unchanged', () => {
    assert.strictEqual(toIsoTimestamp(AFTER), AFTER);
  });

  test('throws CONFIG_INVALID for an unparseable value', () => {
    const err = assertThrows(() => toIsoTimestamp('not-a-date'));
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('throws CONFIG_INVALID for null/undefined/NaN', () => {
    assert.strictEqual(assertThrows(() => toIsoTimestamp(null)).code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    assert.strictEqual(assertThrows(() => toIsoTimestamp(undefined)).code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    assert.strictEqual(assertThrows(() => toIsoTimestamp(Number.NaN)).code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });
});

describe('queryCandidateRows', () => {
  test('lists with the comma-joined open-statuses filter and an ISO createdAfter', async () => {
    const beads = makeFakeBeadsStore([makeRow({ id: 'a' })]);
    await queryCandidateRows(makeHandle(), beads);
    assert.strictEqual(beads.listCalls.length, 1);
    assert.strictEqual(beads.listCalls[0].status, 'open,in_progress,blocked,deferred');
    assert.strictEqual(beads.listCalls[0].createdAfter, new Date(STARTED_AT).toISOString());
  });

  test('returns [] when beads.list resolves to something non-array', async () => {
    const beads = { async list() { return undefined; } };
    const rows = await queryCandidateRows(makeHandle(), beads);
    assert.deepStrictEqual(rows, []);
  });
});

// ---------------------------------------------------------------------------
// queryCandidateRows against the REAL beads-client -- the load-bearing
// sync-vs-async routing assertion the task calls out explicitly: getting
// this wrong breaks carry-over at runtime against the real `bd` binary, not
// in a test built only against a hand-rolled fake.
// ---------------------------------------------------------------------------

describe('queryCandidateRows against the real beads-client', () => {
  function makeRealBeadsClient() {
    const syncCalls = [];
    const asyncCalls = [];
    const execBdSync = (args) => {
      syncCalls.push(args);
      if (args[0] === 'list') return JSON.stringify([makeRow({ id: 'real-1' })]);
      return '';
    };
    const execBdAsync = async (args) => {
      asyncCalls.push(args);
      // The real execBdAsync throws on any free-text/unsafe-charset arg; a
      // test double that did NOT throw here would hide the exact defect
      // this test exists to catch, so it faithfully reproduces that check.
      if (args.some((a) => typeof a !== 'string' || /[^A-Za-z0-9_.-]/.test(a))) {
        throw new Error('execBdAsync received an unsafe-charset arg -- this must never happen for `bd list --created-after`');
      }
      return { stdout: '[]', stderr: '' };
    };
    return { beads: createBeadsClient({ execBdSync, execBdAsync }), syncCalls, asyncCalls };
  }

  test('the --created-after call routes through execBdSync, never execBdAsync', async () => {
    const { beads, syncCalls, asyncCalls } = makeRealBeadsClient();
    const rows = await queryCandidateRows(makeHandle(), beads);

    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].id, 'real-1');

    const listCall = syncCalls.find((c) => c[0] === 'list');
    assert.ok(listCall, 'expected `bd list` to route through execBdSync');
    assert.ok(listCall.includes('--created-after'));
    assert.ok(listCall.includes(new Date(STARTED_AT).toISOString()));

    assert.strictEqual(asyncCalls.length, 0, 'expected no `bd list` call on the execBdAsync path');
  });
});

// ---------------------------------------------------------------------------
// publishOne / publishSelected
// ---------------------------------------------------------------------------

describe('publishOne / publishSelected', () => {
  test('publishOne reports pushed:true and the stamped externalRef on success', async () => {
    const beads = makeFakeBeadsStore([makeRow({ id: 'a', external_ref: null })]);
    const adapter = makeFakeAdapter({ beads });
    const outcome = await publishOne('a', { adapter, beads, secretName: 's', log: noop });
    assert.deepStrictEqual(outcome, { beadId: 'a', externalRef: 'WI-a', pushed: true, error: null });
  });

  test('publishOne captures a genuine failure per-item, never throws', async () => {
    const beads = makeFakeBeadsStore([makeRow({ id: 'a' })]);
    const adapter = makeFakeAdapter({ beads, failFor: new Set(['a']) });
    const outcome = await publishOne('a', { adapter, beads, secretName: 's', log: noop });
    assert.strictEqual(outcome.pushed, false);
    assert.strictEqual(outcome.externalRef, null);
    assert.match(outcome.error, /publish failed for a/);
  });

  test('publishSelected isolates one failure -- the rest still publish', async () => {
    const beads = makeFakeBeadsStore([makeRow({ id: 'a' }), makeRow({ id: 'b' }), makeRow({ id: 'c' })]);
    const adapter = makeFakeAdapter({ beads, failFor: new Set(['b']) });
    const published = await publishSelected(['a', 'b', 'c'], { adapter, beads, secretName: 's', log: noop });

    assert.strictEqual(published.length, 3);
    assert.strictEqual(published.find((p) => p.beadId === 'a').pushed, true);
    assert.strictEqual(published.find((p) => p.beadId === 'c').pushed, true);
    const failed = published.find((p) => p.beadId === 'b');
    assert.strictEqual(failed.pushed, false);
    assert.match(failed.error, /publish failed for b/);

    // adapter.publishCarryOver was called once PER bead (never batched for
    // the real publish), which is what makes b's failure unable to touch a/c.
    assert.strictEqual(adapter.publishCalls.length, 3);
    assert.ok(adapter.publishCalls.every((c) => c.beadIds.length === 1));
  });
});

// ---------------------------------------------------------------------------
// buildSuppressedSummaryBead / fileSuppressedSummary
// ---------------------------------------------------------------------------

describe('buildSuppressedSummaryBead', () => {
  test('names the count, the limit, and the retrieval remedy', () => {
    const fields = buildSuppressedSummaryBead([{ beadId: 'x' }, { beadId: 'y' }], 5);
    assert.match(fields.title, /2 more item\(s\)/);
    assert.match(fields.description, /--max-carry-over <bigger>/);
    assert.match(fields.description, /x/);
    assert.match(fields.description, /y/);
  });
});

describe('fileSuppressedSummary', () => {
  test('returns null and creates nothing when suppressed is empty', async () => {
    const beads = makeFakeBeadsStore();
    const adapter = makeFakeAdapter({ beads });
    const result = await fileSuppressedSummary([], { maxCarryOver: 5, dryRun: false }, { beads, adapter, secretName: 's', log: noop });
    assert.strictEqual(result, null);
    assert.strictEqual(beads.createCalls.length, 0);
  });

  test('dryRun: true creates no local bead and publishes nothing', async () => {
    const beads = makeFakeBeadsStore();
    const adapter = makeFakeAdapter({ beads });
    const result = await fileSuppressedSummary([{ beadId: 'x' }], { maxCarryOver: 1, dryRun: true }, { beads, adapter, secretName: 's', log: noop });
    assert.deepStrictEqual(result, { beadId: null, published: null });
    assert.strictEqual(beads.createCalls.length, 0);
    assert.strictEqual(adapter.publishCalls.length, 0);
  });

  test('files one local bead and publishes it when suppressed is non-empty', async () => {
    const beads = makeFakeBeadsStore();
    const adapter = makeFakeAdapter({ beads });
    const result = await fileSuppressedSummary(
      [{ beadId: 'x' }, { beadId: 'y' }],
      { maxCarryOver: 1, dryRun: false },
      { beads, adapter, secretName: 's', log: noop }
    );
    assert.strictEqual(beads.createCalls.length, 1);
    assert.strictEqual(result.beadId, 'summary-1');
    assert.strictEqual(result.published.pushed, true);
    assert.strictEqual(result.published.externalRef, 'WI-summary-1');
  });

  test('a beads.create() failure is swallowed, not thrown', async () => {
    const beads = makeFakeBeadsStore();
    beads.create = async () => { throw new Error('local DB write failed'); };
    const adapter = makeFakeAdapter({ beads });
    const result = await fileSuppressedSummary([{ beadId: 'x' }], { maxCarryOver: 1, dryRun: false }, { beads, adapter, secretName: 's', log: noop });
    assert.strictEqual(result, null);
    assert.strictEqual(adapter.publishCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// verdict / prUrl / spend extraction -- unit-tested in snapshot.test.mjs
// (their single owner is ../src/snapshot.mjs; see this file's import comment
// above). Covered here only indirectly, through runFinalize()'s end-to-end
// assertions on `result.verdict`/`result.prUrl`/`result.spendUsd` below.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// computeBranchSlug / analysisDocPathFor
// ---------------------------------------------------------------------------

describe('computeBranchSlug / analysisDocPathFor', () => {
  test('is deterministic for the same branch name', () => {
    assert.strictEqual(computeBranchSlug('feat/fleet-reorg'), computeBranchSlug('feat/fleet-reorg'));
  });

  test('disambiguates a slash vs a pre-existing hyphen at the same position', () => {
    const a = computeBranchSlug('feat/fleet-reorg');
    const b = computeBranchSlug('feat-fleet-reorg');
    assert.notStrictEqual(a, b);
  });

  test('analysisDocPathFor builds the docs/sprint-analysis-<slug>.md path', () => {
    const path = analysisDocPathFor('auto-sprint/spr-1');
    assert.strictEqual(path, `docs/sprint-analysis-${computeBranchSlug('auto-sprint/spr-1')}.md`);
  });

  test('analysisDocPathFor returns null with no targetBranch', () => {
    assert.strictEqual(analysisDocPathFor(undefined), null);
    assert.strictEqual(analysisDocPathFor(''), null);
  });
});

// ---------------------------------------------------------------------------
// buildFinalCommentBody / postFinalComment
// ---------------------------------------------------------------------------

describe('buildFinalCommentBody', () => {
  test('includes verdict, PR, analysis path, spend, and pushed carry-over items', () => {
    const body = buildFinalCommentBody({
      verdict: 'PASS',
      prUrl: 'https://example/pr/1',
      analysisDocPath: 'docs/sprint-analysis-x.md',
      spendUsd: 3.5,
      published: [{ beadId: 'a', externalRef: 'WI-1', pushed: true }, { beadId: 'b', externalRef: null, pushed: false }],
      suppressedSummary: null,
    });
    assert.match(body, /PASS/);
    assert.match(body, /https:\/\/example\/pr\/1/);
    assert.match(body, /docs\/sprint-analysis-x\.md/);
    assert.match(body, /\$3\.50/);
    assert.match(body, /a -> WI-1/);
    assert.doesNotMatch(body, /\bb -> /);
  });

  test('names the suppressed summary bead when present', () => {
    const body = buildFinalCommentBody({
      verdict: 'PASS', prUrl: null, analysisDocPath: null, spendUsd: null,
      published: [],
      suppressedSummary: { beadId: 'summary-1', published: { externalRef: 'WI-9' } },
    });
    assert.match(body, /summary-1/);
    assert.match(body, /WI-9/);
  });
});

// `deps.adapter` here is expected to be the per-sprint facade
// (../src/adapters/facade.mjs) -- which work item a comment targets, the
// resolved-config plumbing, and the REST transport are all THAT module's
// concern now (see facade.test.mjs), not finalize.mjs's. These tests only
// need to prove postFinalComment() calls `adapter.comment(markdown)` and
// tolerates a missing comment() or a comment() that throws -- exactly the
// shape a facade instance (or any object exposing that one method) presents.
describe('postFinalComment', () => {
  test('skips when the adapter has no comment()', async () => {
    const outcome = await postFinalComment('body', { adapter: {}, log: noop });
    assert.deepStrictEqual(outcome, { posted: false, error: null });
  });

  test('posts the given markdown body via adapter.comment()', async () => {
    const adapter = makeFakeAdapter({ beads: makeFakeBeadsStore() });
    const outcome = await postFinalComment('body text', { adapter, log: noop });
    assert.strictEqual(outcome.posted, true);
    assert.strictEqual(adapter.commentCalls[0], 'body text');
  });

  test('a comment failure is caught and reported, never thrown', async () => {
    const adapter = makeFakeAdapter({
      beads: makeFakeBeadsStore(),
      commentImpl: () => { throw new Error('ADO 503'); },
    });
    const outcome = await postFinalComment('body', { adapter, log: noop });
    assert.strictEqual(outcome.posted, false);
    assert.match(outcome.error, /ADO 503/);
  });
});

// ---------------------------------------------------------------------------
// runFinalize -- end to end
// ---------------------------------------------------------------------------

describe('runFinalize', () => {
  test('the full sequence: selects, publishes, comments, and records completion', async () => {
    const beads = makeFakeBeadsStore([makeRow({ id: 'a' }), makeRow({ id: 'b' })]);
    const adapter = makeFakeAdapter({ beads });
    const supervisorClient = makeFakeSupervisorClient(terminalSprint());
    const spool = makeFakeSpool();

    const result = await runFinalize(
      { handle: makeHandle(), secretName: 'azdevops_pat' },
      { supervisorClient, beads, adapter, spool, log: noop }
    );

    assert.strictEqual(result.verdict, 'PASS');
    assert.strictEqual(result.prUrl, 'https://dev.azure.com/org/proj/_git/repo/pullrequest/42');
    assert.strictEqual(result.spendUsd, 12.5);
    assert.strictEqual(result.analysisDocPath, `docs/sprint-analysis-${computeBranchSlug('auto-sprint/spr-1')}.md`);
    assert.strictEqual(result.dryRun, false);

    assert.strictEqual(result.carryOver.selected.length, 2);
    assert.strictEqual(result.carryOver.published.length, 2);
    assert.ok(result.carryOver.published.every((p) => p.pushed === true));
    assert.strictEqual(result.carryOver.suppressed.length, 0);

    // dry-run preview (batched) + 2 real per-item publishes = 3 calls.
    assert.strictEqual(adapter.publishCalls.length, 3);
    assert.strictEqual(adapter.publishCalls[0].dryRun, true);
    assert.strictEqual(adapter.publishCalls[0].beadIds.length, 2);

    assert.strictEqual(adapter.commentCalls.length, 1);
    assert.match(adapter.commentCalls[0], /PASS/);

    assert.strictEqual(spool.completeCalls.length, 1);
    assert.strictEqual(spool.completeCalls[0].sprintId, 'spr-1');
    assert.deepStrictEqual(spool.completeCalls[0].result, result);
  });

  test('excludes the synthetic root even though it otherwise qualifies', async () => {
    const beads = makeFakeBeadsStore([
      makeRow({ id: 'root-epic-1' }),
      makeRow({ id: 'a' }),
    ]);
    const adapter = makeFakeAdapter({ beads });
    const supervisorClient = makeFakeSupervisorClient(terminalSprint());
    const spool = makeFakeSpool();

    const result = await runFinalize(
      { handle: makeHandle(), secretName: 's' },
      { supervisorClient, beads, adapter, spool, log: noop }
    );

    assert.deepStrictEqual(result.carryOver.selected.map((s) => s.beadId), ['a']);
    assert.ok(result.carryOver.skipped.some((s) => s.beadId === 'root-epic-1' && s.reason === 'synthetic-root'));
  });

  test('idempotence: a second finalize over the now-stamped rows selects and publishes nothing', async () => {
    const beads = makeFakeBeadsStore([makeRow({ id: 'a' }), makeRow({ id: 'b' })]);
    const adapter = makeFakeAdapter({ beads });
    const supervisorClient = makeFakeSupervisorClient(terminalSprint());
    const spool = makeFakeSpool();
    const opts = { handle: makeHandle(), secretName: 's' };
    const deps = { supervisorClient, beads, adapter, spool, log: noop };

    const first = await runFinalize(opts, deps);
    assert.strictEqual(first.carryOver.selected.length, 2);
    assert.ok(first.carryOver.published.every((p) => p.pushed));

    const second = await runFinalize(opts, deps);
    assert.strictEqual(second.carryOver.selected.length, 0);
    assert.strictEqual(second.carryOver.published.length, 0);
    assert.ok(second.carryOver.skipped.every((s) => s.reason === 'external_ref'));

    // No new publish call was attempted for either bead on the second run
    // (the dry-run preview call is skipped too, since selectedBeadIds is empty).
    const secondRunPublishCalls = adapter.publishCalls.slice(3); // first run: 1 preview + 2 real
    assert.strictEqual(secondRunPublishCalls.length, 0);
  });

  test('dryRun: true previews only, creates/publishes/comments nothing, still records completion', async () => {
    const beads = makeFakeBeadsStore([makeRow({ id: 'a' }), makeRow({ id: 'b' }), makeRow({ id: 'c' })]);
    const adapter = makeFakeAdapter({ beads });
    const supervisorClient = makeFakeSupervisorClient(terminalSprint());
    const spool = makeFakeSpool();

    const result = await runFinalize(
      { handle: makeHandle(), secretName: 's', dryRun: true, maxCarryOver: 1 },
      { supervisorClient, beads, adapter, spool, log: noop }
    );

    assert.strictEqual(result.dryRun, true);
    assert.strictEqual(result.carryOver.selected.length, 1);
    assert.strictEqual(result.carryOver.suppressed.length, 2);
    assert.ok(result.carryOver.published.every((p) => p.pushed === false && p.error === null));

    // Only the dry-run preview call happened -- no real publish, ever.
    assert.strictEqual(adapter.publishCalls.length, 1);
    assert.strictEqual(adapter.publishCalls[0].dryRun, true);

    assert.strictEqual(beads.createCalls.length, 0, 'dry run must not file the suppressed-summary bead');
    assert.strictEqual(adapter.commentCalls.length, 0, 'dry run must not post the final comment');

    assert.strictEqual(spool.completeCalls.length, 1);
  });

  test('suppressed items produce exactly one summary work item', async () => {
    const beads = makeFakeBeadsStore([makeRow({ id: 'a', priority: 1 }), makeRow({ id: 'b', priority: 2 }), makeRow({ id: 'c', priority: 3 })]);
    const adapter = makeFakeAdapter({ beads });
    const supervisorClient = makeFakeSupervisorClient(terminalSprint());
    const spool = makeFakeSpool();

    const result = await runFinalize(
      { handle: makeHandle(), secretName: 's', maxCarryOver: 1 },
      { supervisorClient, beads, adapter, spool, log: noop }
    );

    assert.strictEqual(result.carryOver.selected.length, 1);
    assert.strictEqual(result.carryOver.suppressed.length, 2);
    assert.strictEqual(beads.createCalls.length, 1, 'exactly one summary bead, never one per suppressed item');

    // published: 1 real carry-over item + 1 summary bead = 2.
    assert.strictEqual(result.carryOver.published.length, 2);
    const summaryPublished = result.carryOver.published.find((p) => p.beadId === 'summary-1');
    assert.ok(summaryPublished);
    assert.strictEqual(summaryPublished.pushed, true);

    assert.match(adapter.commentCalls[0], /summary-1/);
  });

  test('non-terminal sprint is refused with FINALIZE_NOT_TERMINAL', async () => {
    const beads = makeFakeBeadsStore();
    const adapter = makeFakeAdapter({ beads });
    const supervisorClient = makeFakeSupervisorClient({ sprintId: 'spr-1', live: true, terminal: false, state: {} });
    const spool = makeFakeSpool();

    await assert.rejects(
      () => runFinalize({ handle: makeHandle(), secretName: 's' }, { supervisorClient, beads, adapter, spool, log: noop }),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.FINALIZE_NOT_TERMINAL);
        return true;
      }
    );
    assert.strictEqual(spool.completeCalls.length, 0);
    assert.strictEqual(beads.listCalls.length, 0, 'must never query candidate rows for a non-terminal sprint');
  });

  test('a not-found sprint is refused with FINALIZE_NOT_TERMINAL', async () => {
    const beads = makeFakeBeadsStore();
    const adapter = makeFakeAdapter({ beads });
    const supervisorClient = makeFakeSupervisorClient(null);
    const spool = makeFakeSpool();

    await assert.rejects(
      () => runFinalize({ handle: makeHandle(), secretName: 's' }, { supervisorClient, beads, adapter, spool, log: noop }),
      (err) => {
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.FINALIZE_NOT_TERMINAL);
        return true;
      }
    );
  });

  test('a per-item publish failure does not abort the batch, but DOES fail the verb', async () => {
    const beads = makeFakeBeadsStore([makeRow({ id: 'a' }), makeRow({ id: 'b' }), makeRow({ id: 'c' })]);
    const adapter = makeFakeAdapter({ beads, failFor: new Set(['b']) });
    const supervisorClient = makeFakeSupervisorClient(terminalSprint());
    const spool = makeFakeSpool();

    await assert.rejects(
      () => runFinalize({ handle: makeHandle(), secretName: 's' }, { supervisorClient, beads, adapter, spool, log: noop }),
      (err) => {
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CARRYOVER_PUBLISH_FAILED);
        assert.match(err.message, /1 of 3/);
        assert.match(err.message, /\bb\b/);
        assert.deepStrictEqual(err.details.unpublished, ['b']);
        return true;
      }
    );

    // The rest of the batch still ran, and the full (partial) outcome was
    // recorded BEFORE the throw -- isolation and loud failure, not either/or.
    assert.strictEqual(spool.completeCalls.length, 1);
    const published = spool.completeCalls[0].result.carryOver.published;
    assert.strictEqual(published.length, 3);
    assert.strictEqual(published.find((p) => p.beadId === 'a').pushed, true);
    assert.strictEqual(published.find((p) => p.beadId === 'c').pushed, true);
    assert.match(published.find((p) => p.beadId === 'b').error, /publish failed for b/);
  });

  test('NOTHING published while carry-over was selected fails loudly, naming every bead id', async () => {
    // The exact live shape this rule exists for: four entries, every one
    // pushed:false, every error:null, and the verb used to exit 0.
    const beads = makeFakeBeadsStore([makeRow({ id: 'a' }), makeRow({ id: 'b' })]);
    const adapter = makeFakeAdapter({ beads });
    adapter.publishCarryOver = async ({ beadIds }) => beadIds.map((beadId) => ({ beadId, externalRef: null, pushed: false }));
    const supervisorClient = makeFakeSupervisorClient(terminalSprint());
    const spool = makeFakeSpool();

    await assert.rejects(
      () => runFinalize({ handle: makeHandle(), secretName: 's' }, { supervisorClient, beads, adapter, spool, log: noop }),
      (err) => {
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CARRYOVER_PUBLISH_FAILED);
        assert.strictEqual(exitCodeFor(err), 6, 'the finalize/carry-over exit code, not a generic 1');
        assert.match(err.message, /2 of 2/);
        assert.deepStrictEqual(err.details.unpublished, ['a', 'b']);
        // No per-item error was reported, so the message must say so rather
        // than leaving the operator with a blank reason.
        assert.match(err.message, /no error reported/);
        return true;
      }
    );
    assert.strictEqual(spool.completeCalls.length, 1, 'the spool record still has to exist');
  });

  test('a dry run publishes nothing BY DESIGN and still succeeds', async () => {
    const beads = makeFakeBeadsStore([makeRow({ id: 'a' }), makeRow({ id: 'b' })]);
    const adapter = makeFakeAdapter({ beads });
    const supervisorClient = makeFakeSupervisorClient(terminalSprint());
    const spool = makeFakeSpool();

    const result = await runFinalize(
      { handle: makeHandle(), secretName: 's', dryRun: true },
      { supervisorClient, beads, adapter, spool, log: noop }
    );
    assert.strictEqual(result.dryRun, true);
    assert.ok(result.carryOver.published.every((p) => p.pushed === false));
  });

  test('a sprint with no carry-over at all succeeds -- nothing was lost', async () => {
    const beads = makeFakeBeadsStore([]);
    const adapter = makeFakeAdapter({ beads });
    const supervisorClient = makeFakeSupervisorClient(terminalSprint());
    const spool = makeFakeSpool();

    const result = await runFinalize(
      { handle: makeHandle(), secretName: 's' },
      { supervisorClient, beads, adapter, spool, log: noop }
    );
    assert.deepStrictEqual(result.carryOver.published, []);
  });

  test('a comment failure does not fail the verb', async () => {
    const beads = makeFakeBeadsStore([makeRow({ id: 'a' })]);
    const adapter = makeFakeAdapter({ beads, commentImpl: () => { throw new Error('ADO 503'); } });
    const supervisorClient = makeFakeSupervisorClient(terminalSprint());
    const spool = makeFakeSpool();

    const result = await runFinalize(
      { handle: makeHandle(), secretName: 's' },
      { supervisorClient, beads, adapter, spool, log: noop }
    );

    assert.strictEqual(result.carryOver.published[0].pushed, true);
    assert.strictEqual(spool.completeCalls.length, 1);
  });

  test('throws CONFIG_MISSING for each missing injected dependency', async () => {
    const beads = makeFakeBeadsStore();
    const adapter = makeFakeAdapter({ beads });
    const supervisorClient = makeFakeSupervisorClient(terminalSprint());
    const spool = makeFakeSpool();
    const opts = { handle: makeHandle(), secretName: 's' };

    await assert.rejects(() => runFinalize(opts, { beads, adapter, spool, log: noop }), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
    await assert.rejects(() => runFinalize(opts, { supervisorClient, adapter, spool, log: noop }), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
    await assert.rejects(() => runFinalize(opts, { supervisorClient, beads, spool, log: noop }), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
    await assert.rejects(() => runFinalize(opts, { supervisorClient, beads, adapter, log: noop }), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
  });

  test('result is frozen', async () => {
    const beads = makeFakeBeadsStore([makeRow({ id: 'a' })]);
    const adapter = makeFakeAdapter({ beads });
    const supervisorClient = makeFakeSupervisorClient(terminalSprint());
    const spool = makeFakeSpool();
    const result = await runFinalize({ handle: makeHandle(), secretName: 's' }, { supervisorClient, beads, adapter, spool, log: noop });
    assert.throws(() => { result.verdict = 'x'; }, TypeError);
  });
});


// ---------------------------------------------------------------------------
// The archive export (step 5b). See spa/archive-publisher.mjs for WHY the
// export cannot fail this verb and why it must nevertheless be loud.
// ---------------------------------------------------------------------------

describe('runFinalize archive export', () => {
  function baseDeps(extra = {}) {
    const beads = makeFakeBeadsStore([]);
    return {
      supervisorClient: makeFakeSupervisorClient(terminalSprint()),
      beads,
      adapter: makeFakeAdapter({ beads }),
      spool: makeFakeSpool(),
      log: noop,
      ...extra,
    };
  }

  test('no archive configured: the result says so and nothing is logged about it', async () => {
    const deps = baseDeps();
    const result = await runFinalize({ handle: makeHandle(), secretName: 's' }, deps);
    assert.strictEqual(result.archive, null);
    assert.ok(!/Archive:/.test(deps.adapter.commentCalls[0] || ''));
  });

  test('a successful export lands in the result, the spool record, and the final comment', async () => {
    const published = [];
    const deps = baseDeps({
      archive: { publish: async (args) => { published.push(args); return { attempted: 3, uploaded: 3, failures: [], indexUrl: 'https://acct.invalid/logs/sprints/spr-1/index.html', ok: true, error: null }; } },
    });

    const result = await runFinalize({ handle: makeHandle(), secretName: 's' }, deps);

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0].sprintId, 'spr-1');
    assert.ok(published[0].state, 'the publisher must receive the terminal state, not just the id');
    assert.strictEqual(result.archive.ok, true);
    assert.match(deps.adapter.commentCalls[0], /Archive: https:\/\/acct\.invalid\/logs\/sprints\/spr-1\/index\.html/);
    assert.deepStrictEqual(deps.spool.completeCalls[0].result.archive, result.archive);
  });

  test('a FAILED export does not fail finalize, but is impossible to miss', async () => {
    const logs = [];
    const deps = baseDeps({
      log: (m) => logs.push(String(m)),
      archive: { publish: async () => ({ attempted: 4, uploaded: 0, failures: [{ path: 'index.html', reason: 'status 403' }], indexUrl: null, ok: false, error: null }) },
    });

    const result = await runFinalize({ handle: makeHandle(), secretName: 's' }, deps);

    // Not fatal: the sprint result is intact.
    assert.strictEqual(result.verdict, 'PASS');
    assert.strictEqual(result.archive.ok, false);

    // Not quiet: a banner, and a line in the operator's own channel.
    const banner = logs.find((l) => l.includes('SPRINT ARCHIVE EXPORT FAILED'));
    assert.ok(banner, `expected a failure banner; logs were: ${logs.join(' | ')}`);
    assert.ok(banner.split('\n').length >= 6, 'a one-line warning is not visibility');
    assert.match(banner, /status 403/);
    assert.match(deps.adapter.commentCalls[0], /Archive: export FAILED/);
  });

  test('a publisher that throws anyway is absorbed and reported, never propagated', async () => {
    const deps = baseDeps({ archive: { publish: async () => { throw new Error('unexpected'); } } });
    const result = await runFinalize({ handle: makeHandle(), secretName: 's' }, deps);
    assert.strictEqual(result.archive.ok, false);
    assert.match(String(result.archive.error), /unexpected/);
  });

  test('a deps.archive that cannot publish is a wiring mistake, and fails loudly', async () => {
    const deps = baseDeps({ archive: { nope: true } });
    await assert.rejects(
      () => runFinalize({ handle: makeHandle(), secretName: 's' }, deps),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
        return true;
      },
    );
  });
});
