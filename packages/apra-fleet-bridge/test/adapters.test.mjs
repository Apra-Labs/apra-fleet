// Tests for the bridge adapter registry (src/adapters/index.mjs), the
// shared native-beads-sync implementation (src/adapters/lib/
// native-beads-sync.mjs), and the Azure DevOps adapter
// (src/adapters/azure-devops.mjs).
//
// No process.env, node:fs writes, or real fetch anywhere in this file's
// fakes -- every dependency the modules under test take (execBd, callTool,
// beads client, REST transport) is a fake defined here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  BRIDGE_ADAPTER_CONTRACT_VERSION,
  registerBridgeAdapter,
  getBridgeAdapter,
  listBridgeAdapters,
  resetBridgeAdapters,
  AzureDevOpsBridgeAdapter,
} from '../src/adapters/index.mjs';
import { createNativeBeadsSync, extractCriteriaFromDescription } from '../src/adapters/lib/native-beads-sync.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const ADAPTERS_DIR = path.join(pkgRoot, 'src', 'adapters');
const AZURE_DEVOPS_SOURCE_PATH = path.join(ADAPTERS_DIR, 'azure-devops.mjs');
const NATIVE_BEADS_SYNC_SOURCE_PATH = path.join(ADAPTERS_DIR, 'lib', 'native-beads-sync.mjs');
const INDEX_SOURCE_PATH = path.join(ADAPTERS_DIR, 'index.mjs');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeValidCaps(overrides = {}) {
  return {
    nativeBeadsSync: false,
    canCreateWorkItem: false,
    canComment: false,
    supportsAttached: false,
    maxJobMinutes: null,
    ...overrides,
  };
}

/** A minimal, valid bridge-adapter descriptor for registry tests -- deliberately
 *  unrelated to azure-devops.mjs, so registry tests never depend on the real
 *  adapter's behavior. */
function makeAdapter(overrides = {}) {
  const base = {
    name: 'fake-adapter',
    resolveRequest: () => ({}),
    ingest: async () => ({}),
    publishCarryOver: async () => ({}),
    // Present in the BASE descriptor because makeValidCaps() declares
    // canCreateWorkItem: true, and registerBridgeAdapter now enforces that
    // lockstep (a capability flag with nothing behind it is what shipped).
    createWorkItem: async () => ({}),
    capabilities: () => makeValidCaps(),
  };
  return { ...base, ...overrides };
}

/** Records every trackerPull/trackerPush/list/show call; mirrors
 *  beads-client.mjs's real trackerPull(namespace, refs, {secretName})/
 *  trackerPush(namespace, beadIds, {secretName, dryRun})/list(opts)/show(id)
 *  signatures exactly.
 *
 *  `listRows` seeds what `list()` returns (the local-DB read-back's data
 *  source); `showRows` is a Map/object keyed by bead id for `show()`'s
 *  read-back. Both default to empty so a test that never sets them up
 *  exercises the "pull succeeded, nothing found locally" -> missing-ref path. */
function makeFakeBeadsClient({ listRows = [], showRows = {} } = {}) {
  const calls = { trackerPull: [], trackerPush: [], list: [], show: [], update: [] };
  return {
    calls,
    async trackerPull(namespace, refs, opts) {
      calls.trackerPull.push({ namespace, refs, opts });
      return { ok: true };
    },
    async trackerPush(namespace, beadIds, opts) {
      calls.trackerPush.push({ namespace, beadIds, opts });
      return { ok: true };
    },
    async list(opts) {
      calls.list.push(opts);
      return listRows;
    },
    async show(id) {
      calls.show.push(id);
      const row = showRows[id] ?? null;
      // A REAL `bd show --json` prints an ARRAY of one row. Honoured here
      // so the array-unwrapping the production code now does is actually
      // exercised, not assumed away by a friendlier fake.
      return row === null ? [] : [row];
    },
    async update(id, fields) {
      calls.update.push({ id, fields });
      if (fields && typeof fields.externalRef === 'string') {
        showRows[id] = { ...(showRows[id] || { id }), external_ref: fields.externalRef };
      }
      return { id };
    },
  };
}

function makeFakeRestClient(response = { status: 200 }) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    return response;
  };
  fn.calls = calls;
  return fn;
}

function validAdoEnv(overrides = {}) {
  return {
    adoOrgUrl: 'https://example.invalid/fake-org',
    adoProject: 'fake-project',
    repoPath: '/repo',
    agentPool: 'fake-pool',
    member: 'member-a',
    targetBranch: 'feature/x',
    baseBranch: 'main',
    workItems: ['WI-1'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// registerBridgeAdapter: required/optional function validation
// ---------------------------------------------------------------------------

describe('registerBridgeAdapter: required/optional function validation', () => {
  test('missing required function `ingest` is rejected (ADAPTER_INVALID, names the field)', () => {
    resetBridgeAdapters();
    const impl = makeAdapter();
    delete impl.ingest;
    assert.throws(
      () => registerBridgeAdapter(impl),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, BRIDGE_ERROR_CODES.ADAPTER_INVALID);
        assert.match(err.message, /ingest/);
        assert.equal(err.details.field, 'ingest');
        return true;
      }
    );
  });

  test('missing required function `resolveRequest`, `publishCarryOver`, or `capabilities` is likewise rejected', () => {
    for (const fn of ['resolveRequest', 'publishCarryOver', 'capabilities']) {
      resetBridgeAdapters();
      const impl = makeAdapter();
      delete impl[fn];
      assert.throws(
        () => registerBridgeAdapter(impl),
        (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.ADAPTER_INVALID && err.details.field === fn
      );
    }
  });

  test('a non-function `comment` is rejected', () => {
    resetBridgeAdapters();
    const impl = makeAdapter({ comment: 'not-a-function' });
    assert.throws(
      () => registerBridgeAdapter(impl),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, BRIDGE_ERROR_CODES.ADAPTER_INVALID);
        assert.match(err.message, /comment/);
        return true;
      }
    );
  });

  test('a non-function `setBuildStatus` or `emitProgress` is likewise rejected', () => {
    for (const fn of ['setBuildStatus', 'emitProgress']) {
      resetBridgeAdapters();
      const impl = makeAdapter({ [fn]: 123 });
      assert.throws(
        () => registerBridgeAdapter(impl),
        (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.ADAPTER_INVALID
      );
    }
  });

  test('a missing/empty `name` is rejected', () => {
    resetBridgeAdapters();
    assert.throws(() => registerBridgeAdapter(makeAdapter({ name: '' })), BridgeError);
    assert.throws(() => registerBridgeAdapter(makeAdapter({ name: undefined })), BridgeError);
    assert.throws(() => registerBridgeAdapter(null), BridgeError);
  });
});

// ---------------------------------------------------------------------------
// registerBridgeAdapter: capabilities() shape + lockstep rules
// ---------------------------------------------------------------------------

describe('registerBridgeAdapter: capabilities() validation and lockstep rules', () => {
  test('a non-boolean capability field is rejected', () => {
    resetBridgeAdapters();
    const impl = makeAdapter({ capabilities: () => makeValidCaps({ canComment: 'yes' }) });
    assert.throws(
      () => registerBridgeAdapter(impl),
      (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.ADAPTER_INVALID
    );
  });

  test('maxJobMinutes must be a positive integer or null (0, negative, and non-integer rejected)', () => {
    for (const bad of [0, -5, 1.5, 'soon']) {
      resetBridgeAdapters();
      const impl = makeAdapter({ capabilities: () => makeValidCaps({ maxJobMinutes: bad }) });
      assert.throws(
        () => registerBridgeAdapter(impl),
        (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.ADAPTER_INVALID
      );
    }
  });

  test('LOCKSTEP: canComment === true without a `comment` function is rejected at registration', () => {
    resetBridgeAdapters();
    const impl = makeAdapter({ capabilities: () => makeValidCaps({ canComment: true }) });
    assert.throws(
      () => registerBridgeAdapter(impl),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, BRIDGE_ERROR_CODES.ADAPTER_INVALID);
        assert.match(err.message, /canComment/);
        return true;
      }
    );
  });

  test('LOCKSTEP: canComment === true WITH a `comment` function registers cleanly', () => {
    resetBridgeAdapters();
    const impl = makeAdapter({
      capabilities: () => makeValidCaps({ canComment: true }),
      comment: async () => {},
    });
    assert.doesNotThrow(() => registerBridgeAdapter(impl));
  });

  // The explicit boundary case called out in the task: supportsAttached:true
  // with maxJobMinutes:120 must PASS (the rule is `>= 120`, inclusive),
  // and 119 must FAIL.
  test('LOCKSTEP BOUNDARY: supportsAttached:true with maxJobMinutes:120 registers cleanly (inclusive floor)', () => {
    resetBridgeAdapters();
    const impl = makeAdapter({ capabilities: () => makeValidCaps({ supportsAttached: true, maxJobMinutes: 120 }) });
    assert.doesNotThrow(() => registerBridgeAdapter(impl));
  });

  test('LOCKSTEP BOUNDARY: supportsAttached:true with maxJobMinutes:119 is rejected (one below the floor)', () => {
    resetBridgeAdapters();
    const impl = makeAdapter({ capabilities: () => makeValidCaps({ supportsAttached: true, maxJobMinutes: 119 }) });
    assert.throws(
      () => registerBridgeAdapter(impl),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, BRIDGE_ERROR_CODES.ADAPTER_INVALID);
        assert.match(err.message, /supportsAttached/);
        return true;
      }
    );
  });

  test('LOCKSTEP: supportsAttached:true with maxJobMinutes:null registers cleanly', () => {
    resetBridgeAdapters();
    const impl = makeAdapter({ capabilities: () => makeValidCaps({ supportsAttached: true, maxJobMinutes: null }) });
    assert.doesNotThrow(() => registerBridgeAdapter(impl));
  });

  test('supportsAttached:false imposes no maxJobMinutes floor', () => {
    resetBridgeAdapters();
    const impl = makeAdapter({ capabilities: () => makeValidCaps({ supportsAttached: false, maxJobMinutes: 5 }) });
    assert.doesNotThrow(() => registerBridgeAdapter(impl));
  });
});

// ---------------------------------------------------------------------------
// capabilities() invoked exactly once, at registration; result frozen
// ---------------------------------------------------------------------------

describe('registerBridgeAdapter: capabilities() is invoked exactly once and frozen', () => {
  test('the underlying capabilities() function is called exactly once, at registration', () => {
    resetBridgeAdapters();
    let calls = 0;
    const impl = makeAdapter({
      name: 'once',
      capabilities: () => {
        calls += 1;
        return makeValidCaps({ nativeBeadsSync: true });
      },
    });
    registerBridgeAdapter(impl);
    assert.equal(calls, 1);

    const entry = getBridgeAdapter('once');
    entry.capabilities();
    entry.capabilities();
    assert.equal(calls, 1, 'capabilities() must never be invoked again after registration');
  });

  test('the registered capabilities() result is frozen and stable across calls', () => {
    resetBridgeAdapters();
    const impl = makeAdapter({ name: 'frozen-caps', capabilities: () => makeValidCaps({ canCreateWorkItem: true }) });
    registerBridgeAdapter(impl);
    const entry = getBridgeAdapter('frozen-caps');
    const caps1 = entry.capabilities();
    const caps2 = entry.capabilities();
    assert.equal(caps1, caps2, 'the same frozen object must be returned every time');
    assert.ok(Object.isFrozen(caps1));
    assert.throws(() => {
      'use strict';
      caps1.canCreateWorkItem = false;
    }, TypeError);
  });

  test('an adapter returning extra fields in capabilities() is rejected at registration', () => {
    resetBridgeAdapters();
    const impl = makeAdapter({
      capabilities: () => ({
        ...makeValidCaps(),
        extraField: { mutable: 'nested object' },
      }),
    });
    assert.throws(
      () => registerBridgeAdapter(impl),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, BRIDGE_ERROR_CODES.ADAPTER_INVALID);
        assert.match(err.message, /extraField/);
        return true;
      }
    );
  });

  test('an adapter with a nested mutable object cannot be accessed via getBridgeAdapter().capabilities()', () => {
    resetBridgeAdapters();
    // After rejection, any extra field should not be accessible through the frozen capabilities
    const impl = makeAdapter({
      name: 'test-whitelist',
      capabilities: () => makeValidCaps({ nativeBeadsSync: true }),
    });
    registerBridgeAdapter(impl);
    const caps = getBridgeAdapter('test-whitelist').capabilities();
    // Verify only the five known fields are present
    const knownFields = ['nativeBeadsSync', 'canCreateWorkItem', 'canComment', 'supportsAttached', 'maxJobMinutes'];
    const actualFields = Object.keys(caps);
    assert.deepEqual(actualFields.sort(), knownFields.sort(), 'capabilities must contain only the five known fields');
    // Verify the object is truly frozen with no way to add properties
    assert.ok(Object.isFrozen(caps), 'capabilities must be frozen');
    assert.throws(
      () => {
        'use strict';
        caps.newField = 'should fail';
      },
      TypeError
    );
  });
});

// ---------------------------------------------------------------------------
// getBridgeAdapter / listBridgeAdapters / resetBridgeAdapters
// ---------------------------------------------------------------------------

describe('getBridgeAdapter / listBridgeAdapters / resetBridgeAdapters', () => {
  test('getBridgeAdapter on an unknown name throws ADAPTER_UNKNOWN listing every known name', () => {
    resetBridgeAdapters();
    registerBridgeAdapter(makeAdapter({ name: 'alpha' }));
    registerBridgeAdapter(makeAdapter({ name: 'beta' }));
    assert.throws(
      () => getBridgeAdapter('gamma'),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, BRIDGE_ERROR_CODES.ADAPTER_UNKNOWN);
        assert.match(err.message, /alpha/);
        assert.match(err.message, /beta/);
        return true;
      }
    );
  });

  test('getBridgeAdapter on an unknown name with an empty registry says so, rather than listing nothing silently', () => {
    resetBridgeAdapters();
    assert.throws(
      () => getBridgeAdapter('anything'),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, BRIDGE_ERROR_CODES.ADAPTER_UNKNOWN);
        assert.match(err.message, /none registered/);
        return true;
      }
    );
  });

  test('resetBridgeAdapters clears the registry', () => {
    registerBridgeAdapter(makeAdapter({ name: 'temp' }));
    resetBridgeAdapters();
    assert.deepEqual(listBridgeAdapters(), []);
  });

  test('re-registering the same name replaces the previous descriptor', async () => {
    resetBridgeAdapters();
    registerBridgeAdapter(makeAdapter({ name: 'dup', ingest: async () => 'v1' }));
    registerBridgeAdapter(makeAdapter({ name: 'dup', ingest: async () => 'v2' }));
    assert.deepEqual(listBridgeAdapters(), ['dup']);
    const entry = getBridgeAdapter('dup');
    assert.equal(await entry.ingest(), 'v2');
  });

  test('BRIDGE_ADAPTER_CONTRACT_VERSION is exported as 1', () => {
    assert.equal(BRIDGE_ADAPTER_CONTRACT_VERSION, 1);
  });
});

// ---------------------------------------------------------------------------
// createNativeBeadsSync (src/adapters/lib/native-beads-sync.mjs)
// ---------------------------------------------------------------------------

describe('createNativeBeadsSync', () => {
  test('rejects an unknown namespace', () => {
    assert.throws(
      () => createNativeBeadsSync({ namespace: 'gitlab', beads: makeFakeBeadsClient() }),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, BRIDGE_ERROR_CODES.ADAPTER_INVALID);
        return true;
      }
    );
  });

  test('rejects a missing/incomplete injected beads client', () => {
    assert.throws(
      () => createNativeBeadsSync({ namespace: 'ado' }),
      (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.CONFIG_MISSING
    );
    assert.throws(
      () => createNativeBeadsSync({ namespace: 'ado', beads: { trackerPull: async () => {} } }),
      (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.CONFIG_MISSING
    );
  });

  test('ingest() delegates to beads.trackerPull with the configured namespace, then reads back via list()', async () => {
    const beads = makeFakeBeadsClient({
      listRows: [{ id: 'mem-1', title: 'x', parent: null, acceptance_criteria: 'given/when/then', external_ref: 'WI-1' }],
    });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    const result = await sync.ingest({ refs: ['WI-1'], secretName: 'azdevops_pat' });
    assert.equal(beads.calls.trackerPull.length, 1);
    assert.equal(beads.calls.trackerPull[0].namespace, 'ado');
    assert.deepEqual(beads.calls.trackerPull[0].refs, ['WI-1']);
    assert.equal(beads.calls.trackerPull[0].opts.secretName, 'azdevops_pat');

    // The read-back must be LOCAL (list()), never a second tracker dispatch.
    assert.equal(beads.calls.list.length, 1);
    assert.equal(beads.calls.trackerPull.length, 1, 'read-back must not dispatch a second trackerPull');

    assert.deepEqual(result, [{
      beadId: 'mem-1',
      externalRef: 'WI-1',
      title: 'x',
      parent: null,
      acceptanceCriteria: 'given/when/then',
    }]);
  });

  test('ingest() matches multiple refs against multiple listed rows by external_ref', async () => {
    const beads = makeFakeBeadsClient({
      listRows: [
        { id: 'mem-1', title: 'a', parent: 'mem-epic', acceptance_criteria: 'c1', external_ref: 'WI-1' },
        { id: 'mem-2', title: 'b', parent: 'mem-epic', acceptance_criteria: null, external_ref: 'WI-2' },
        { id: 'mem-9', title: 'unrelated', parent: null, acceptance_criteria: 'x', external_ref: 'WI-999' },
      ],
    });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    const result = await sync.ingest({ refs: ['WI-1', 'WI-2'], secretName: 'azdevops_pat' });
    assert.deepEqual(result.map((r) => r.beadId).sort(), ['mem-1', 'mem-2']);
    assert.deepEqual(result.map((r) => r.externalRef).sort(), ['WI-1', 'WI-2']);
  });

  test('ingest() throws INGEST_PULL_FAILED naming any ref that matches no bead after the pull -- never a silently short result', async () => {
    const beads = makeFakeBeadsClient({
      listRows: [{ id: 'mem-1', title: 'a', parent: null, acceptance_criteria: 'c1', external_ref: 'WI-1' }],
    });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    await assert.rejects(
      () => sync.ingest({ refs: ['WI-1', 'WI-2'], secretName: 'azdevops_pat' }),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, BRIDGE_ERROR_CODES.INGEST_PULL_FAILED);
        assert.match(err.message, /WI-2/);
        assert.deepEqual(err.details.missing, ['WI-2']);
        return true;
      }
    );
  });

  test('ingest() with zero refs never lists and returns an empty array', async () => {
    const beads = makeFakeBeadsClient();
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    const result = await sync.ingest({ refs: [], secretName: 'azdevops_pat' });
    assert.deepEqual(result, []);
    assert.equal(beads.calls.list.length, 0);
  });

  test('publishCarryOver() delegates to beads.trackerPush with the configured namespace, then reads back via show()', async () => {
    const beads = makeFakeBeadsClient({
      showRows: { 'mem-1i4': { id: 'mem-1i4', external_ref: 'WI-77' } },
    });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    const result = await sync.publishCarryOver({ beadIds: ['mem-1i4'], secretName: 'azdevops_pat' });
    assert.equal(beads.calls.trackerPush.length, 1);
    assert.equal(beads.calls.trackerPush[0].namespace, 'ado');
    assert.deepEqual(beads.calls.trackerPush[0].beadIds, ['mem-1i4']);

    // The read-back must be LOCAL (show()), never a second tracker dispatch.
    assert.deepEqual(beads.calls.show, ['mem-1i4']);
    assert.equal(beads.calls.trackerPush.length, 1, 'read-back must not dispatch a second trackerPush');

    assert.deepEqual(result, [{ beadId: 'mem-1i4', externalRef: 'WI-77', pushed: true }]);
  });

  test('publishCarryOver() under dryRun never reports pushed:true, even if the bead already carries an external_ref', async () => {
    const beads = makeFakeBeadsClient({
      showRows: { 'mem-1i4': { id: 'mem-1i4', external_ref: 'WI-77' } },
    });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    const result = await sync.publishCarryOver({ beadIds: ['mem-1i4'], secretName: 'azdevops_pat', dryRun: true });
    assert.equal(beads.calls.trackerPush[0].opts.dryRun, true);
    assert.deepEqual(result, [{ beadId: 'mem-1i4', externalRef: 'WI-77', pushed: false }]);
  });

  test('publishCarryOver() reports pushed:false and externalRef:null for a bead the push did not stamp', async () => {
    const beads = makeFakeBeadsClient({ showRows: {} });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    const result = await sync.publishCarryOver({ beadIds: ['mem-unstamped'], secretName: 'azdevops_pat' });
    assert.deepEqual(result, [{ beadId: 'mem-unstamped', externalRef: null, pushed: false }]);
  });

  test('publishCarryOver() with zero beadIds never calls show() and returns an empty array', async () => {
    const beads = makeFakeBeadsClient();
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    const result = await sync.publishCarryOver({ beadIds: [], secretName: 'azdevops_pat' });
    assert.deepEqual(result, []);
    assert.equal(beads.calls.show.length, 0);
  });

  test('the github namespace works identically -- proves Phase 4 is "namespace string only"', async () => {
    const beads = makeFakeBeadsClient({
      listRows: [{ id: 'mem-1', title: 'x', parent: null, acceptance_criteria: 'ac', external_ref: 'owner/repo#1' }],
    });
    const sync = createNativeBeadsSync({ namespace: 'github', beads });
    await sync.ingest({ refs: ['owner/repo#1'], secretName: 'github_pat' });
    assert.equal(beads.calls.trackerPull[0].namespace, 'github');
  });
});

// ---------------------------------------------------------------------------
// extractCriteriaFromDescription -- description-body fallback (why: Azure
// DevOps' dedicated AcceptanceCriteria field is process/type-specific and
// GitHub has no such field at all, so the criteria gate cannot rely on it
// alone -- see native-beads-sync.mjs's own comment for the full rationale)
// ---------------------------------------------------------------------------

describe('extractCriteriaFromDescription', () => {
  test('extracts a bold-as-heading ("**Acceptance criteria**") section', () => {
    const description = [
      '**Problem**',
      'PUT /api/notes/:id leaves updatedAt unchanged.',
      '',
      '**Acceptance criteria**',
      '',
      '- After a successful PUT, updatedAt is later than before.',
      '- createdAt is unchanged.',
    ].join('\n');
    const result = extractCriteriaFromDescription(description);
    assert.match(result, /After a successful PUT/);
    assert.match(result, /createdAt is unchanged/);
    assert.doesNotMatch(result, /Problem/);
  });

  test('extracts an ATX heading ("## Acceptance criteria") section', () => {
    const description = [
      '## Problem',
      'Some prose here.',
      '',
      '## Acceptance criteria',
      '- item one',
      '- item two',
    ].join('\n');
    const result = extractCriteriaFromDescription(description);
    assert.match(result, /item one/);
    assert.match(result, /item two/);
    assert.doesNotMatch(result, /Problem|Some prose/);
  });

  test('matches recognized heading spellings case-insensitively (AC, Acceptance, mixed case)', () => {
    assert.match(extractCriteriaFromDescription('**ac**\n- x'), /x/);
    assert.match(extractCriteriaFromDescription('**Acceptance**\n- y'), /y/);
    assert.match(extractCriteriaFromDescription('**ACCEPTANCE CRITERIA**\n- z'), /z/);
    assert.match(extractCriteriaFromDescription('### acceptance criteria\n- w'), /w/);
  });

  test('stops at the next heading and does not swallow following sections', () => {
    const description = [
      '**Acceptance criteria**',
      '- only this line belongs to criteria',
      '',
      '**Notes**',
      'This section must never appear in the extracted result.',
    ].join('\n');
    const result = extractCriteriaFromDescription(description);
    assert.match(result, /only this line belongs to criteria/);
    assert.doesNotMatch(result, /Notes|must never appear/);
  });

  test('an ATX section includes a nested deeper-level subheading rather than stopping at it', () => {
    const description = [
      '## Acceptance criteria',
      '### Edge cases',
      '- covers a nested subsection',
      '',
      '## Out of scope',
      'not part of criteria',
    ].join('\n');
    const result = extractCriteriaFromDescription(description);
    assert.match(result, /Edge cases/);
    assert.match(result, /covers a nested subsection/);
    assert.doesNotMatch(result, /not part of criteria/);
  });

  test('no recognized heading at all -> undefined, never falls back to the whole description', () => {
    const description = 'Just a plain description with no headings of any kind, however long.';
    assert.equal(extractCriteriaFromDescription(description), undefined);
  });

  test('an unrelated heading (e.g. "Problem") with no criteria heading anywhere -> undefined', () => {
    const description = '**Problem**\nSomething is broken and needs fixing.';
    assert.equal(extractCriteriaFromDescription(description), undefined);
  });

  test('a criteria heading with only whitespace under it -> undefined, not an empty match', () => {
    const description = '**Acceptance criteria**\n\n   \n\t\n';
    assert.equal(extractCriteriaFromDescription(description), undefined);
  });

  test('a criteria heading as the very last line with nothing under it -> undefined', () => {
    assert.equal(extractCriteriaFromDescription('**Problem**\ntext\n**Acceptance criteria**'), undefined);
  });

  test('description absent, null, or non-string -> undefined', () => {
    assert.equal(extractCriteriaFromDescription(undefined), undefined);
    assert.equal(extractCriteriaFromDescription(null), undefined);
    assert.equal(extractCriteriaFromDescription(42), undefined);
    assert.equal(extractCriteriaFromDescription(''), undefined);
  });
});

// ---------------------------------------------------------------------------
// createNativeBeadsSync.ingest() -- acceptance-criteria resolution (dedicated
// field vs. description-body fallback)
// ---------------------------------------------------------------------------

describe('createNativeBeadsSync.ingest() -- acceptance-criteria resolution', () => {
  test('a non-empty dedicated field wins over description, even when description also has a criteria heading', async () => {
    const beads = makeFakeBeadsClient({
      listRows: [{
        id: 'mem-1',
        title: 'x',
        parent: null,
        external_ref: 'WI-1',
        acceptance_criteria: 'dedicated-field wins',
        description: '**Acceptance criteria**\n- should not be used',
      }],
    });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    const [result] = await sync.ingest({ refs: ['WI-1'], secretName: 'azdevops_pat' });
    assert.equal(result.acceptanceCriteria, 'dedicated-field wins');
  });

  test('falls back to the description body when the dedicated field is absent (real Azure DevOps Basic-process shape)', async () => {
    const beads = makeFakeBeadsClient({
      listRows: [{
        id: 'mem-1',
        title: 'x',
        parent: null,
        external_ref: 'WI-1',
        // No acceptance_criteria key at all -- matches the live `bd show
        // --json` shape this fix was written against.
        description: '**Problem**\nSomething broken.\n\n**Acceptance criteria**\n- fix it\n- test it',
      }],
    });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    const [result] = await sync.ingest({ refs: ['WI-1'], secretName: 'azdevops_pat' });
    assert.match(result.acceptanceCriteria, /fix it/);
    assert.match(result.acceptanceCriteria, /test it/);
  });

  test('falls back to the description body when the dedicated field is present but empty', async () => {
    const beads = makeFakeBeadsClient({
      listRows: [{
        id: 'mem-1',
        title: 'x',
        parent: null,
        external_ref: 'WI-1',
        acceptance_criteria: '   ',
        description: '## Acceptance criteria\n- from description',
      }],
    });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    const [result] = await sync.ingest({ refs: ['WI-1'], secretName: 'azdevops_pat' });
    assert.match(result.acceptanceCriteria, /from description/);
  });

  test('neither field nor description heading present -> acceptanceCriteria is undefined, the gate still fires', async () => {
    const beads = makeFakeBeadsClient({
      listRows: [{
        id: 'mem-1',
        title: 'x',
        parent: null,
        external_ref: 'WI-1',
        description: 'No headings here at all.',
      }],
    });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    const [result] = await sync.ingest({ refs: ['WI-1'], secretName: 'azdevops_pat' });
    assert.equal(result.acceptanceCriteria, undefined);
  });
});

// ---------------------------------------------------------------------------
// createNativeBeadsSync.ingest() -- ref normalization
//
// beads stamps `external_ref` with the FULL tracker URL (verified live
// against a real Azure DevOps project), but the caller supplies a bare work
// item id -- that mismatch is the reproduced defect. These tests pin the
// normalizing match down: exact equality first, then whole-trailing-segment
// comparison in both directions, and -- because a false match here is worse
// than a missed one -- proof that a digit merely appearing inside a URL
// (the GUID, the org, a longer id) is never enough to match.
// ---------------------------------------------------------------------------

describe('createNativeBeadsSync.ingest() -- ref normalization', () => {
  const LIVE_URL_2 = 'https://dev.azure.com/apralabs/cf92b860-87bf-49f1-9400-b26a2963a20c/_workitems/edit/2';
  const LIVE_URL_3 = 'https://dev.azure.com/apralabs/cf92b860-87bf-49f1-9400-b26a2963a20c/_workitems/edit/3';
  const LIVE_URL_12 = 'https://dev.azure.com/apralabs/cf92b860-87bf-49f1-9400-b26a2963a20c/_workitems/edit/12';

  test('a bare id matches a bead whose external_ref is the full tracker URL', async () => {
    const beads = makeFakeBeadsClient({
      listRows: [{ id: 'mem-1', title: 'x', parent: null, acceptance_criteria: 'ac', external_ref: LIVE_URL_2 }],
    });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    const result = await sync.ingest({ refs: ['2'], secretName: 'azdevops_pat' });
    assert.deepEqual(result, [{
      beadId: 'mem-1',
      externalRef: '2',
      title: 'x',
      parent: null,
      acceptanceCriteria: 'ac',
    }]);
  });

  test('a full URL ref matches the same bead as its bare id would', async () => {
    const beads = makeFakeBeadsClient({
      listRows: [{ id: 'mem-1', title: 'x', parent: null, acceptance_criteria: 'ac', external_ref: LIVE_URL_2 }],
    });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    const result = await sync.ingest({ refs: [LIVE_URL_2], secretName: 'azdevops_pat' });
    assert.deepEqual(result.map((r) => r.beadId), ['mem-1']);
  });

  test('literal equality still matches without any normalization involved', async () => {
    const beads = makeFakeBeadsClient({
      listRows: [{ id: 'mem-1', title: 'x', parent: null, acceptance_criteria: 'ac', external_ref: 'WI-1' }],
    });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    const result = await sync.ingest({ refs: ['WI-1'], secretName: 'azdevops_pat' });
    assert.deepEqual(result.map((r) => r.beadId), ['mem-1']);
  });

  test('"2" does NOT match a bead whose ref ends in "12" -- no partial/suffix match', async () => {
    const beads = makeFakeBeadsClient({
      listRows: [{ id: 'mem-12', title: 'x', parent: null, acceptance_criteria: 'ac', external_ref: LIVE_URL_12 }],
    });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    await assert.rejects(
      () => sync.ingest({ refs: ['2'], secretName: 'azdevops_pat' }),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, BRIDGE_ERROR_CODES.INGEST_PULL_FAILED);
        assert.deepEqual(err.details.missing, ['2']);
        return true;
      }
    );
  });

  test('"2" does not match via a digit inside the org/GUID portion of the URL -- no substring match', async () => {
    // The GUID cf92b860-...-b26a2963a20c contains "2" many times over, and
    // the final path segment here is "20", not "2".
    const beads = makeFakeBeadsClient({
      listRows: [{
        id: 'mem-20',
        title: 'x',
        parent: null,
        acceptance_criteria: 'ac',
        external_ref: 'https://dev.azure.com/apralabs/cf92b860-87bf-49f1-9400-b26a2963a20c/_workitems/edit/20',
      }],
    });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    await assert.rejects(
      () => sync.ingest({ refs: ['2'], secretName: 'azdevops_pat' }),
      (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.INGEST_PULL_FAILED
    );
  });

  test('a query string or fragment on the URL does not defeat the match', async () => {
    const beads = makeFakeBeadsClient({
      listRows: [
        { id: 'mem-q', title: 'q', parent: null, acceptance_criteria: 'ac', external_ref: `${LIVE_URL_2}?_a=edit&witd=Bug` },
        { id: 'mem-f', title: 'f', parent: null, acceptance_criteria: 'ac', external_ref: `${LIVE_URL_3}#comments` },
      ],
    });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    const result = await sync.ingest({ refs: ['2', '3'], secretName: 'azdevops_pat' });
    assert.deepEqual(result.map((r) => r.beadId).sort(), ['mem-f', 'mem-q']);
  });

  test('unmatched refs still throw INGEST_PULL_FAILED listing them, with the message showing what they normalized to', async () => {
    const beads = makeFakeBeadsClient({
      listRows: [{ id: 'mem-1', title: 'x', parent: null, acceptance_criteria: 'ac', external_ref: LIVE_URL_2 }],
    });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    await assert.rejects(
      () => sync.ingest({ refs: ['2', '404'], secretName: 'azdevops_pat' }),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, BRIDGE_ERROR_CODES.INGEST_PULL_FAILED);
        assert.deepEqual(err.details.missing, ['404']);
        assert.match(err.message, /404/);
        assert.match(err.message, /normalized "404"/);
        return true;
      }
    );
  });

  test('two beads normalizing to the same identity as one supplied ref throws INGEST_REF_AMBIGUOUS naming both bead ids, not a silent pick-first', async () => {
    const beads = makeFakeBeadsClient({
      listRows: [
        { id: 'mem-a', title: 'a', parent: null, acceptance_criteria: 'ac', external_ref: LIVE_URL_2 },
        { id: 'mem-b', title: 'b', parent: null, acceptance_criteria: 'ac', external_ref: 'https://github.com/some/other-repo/issues/2' },
      ],
    });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    await assert.rejects(
      () => sync.ingest({ refs: ['2'], secretName: 'azdevops_pat' }),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, BRIDGE_ERROR_CODES.INGEST_REF_AMBIGUOUS);
        assert.match(err.message, /mem-a/);
        assert.match(err.message, /mem-b/);
        assert.equal(err.details.ambiguous.length, 1);
        assert.deepEqual(err.details.ambiguous[0].beadIds.sort(), ['mem-a', 'mem-b']);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Contract test: createNativeBeadsSync's ingest() output satisfies EXACTLY
// what verbs/ingest.mjs's normalizePulledItem() expects -- imports both so
// the two cannot drift apart the way they already did once (the bug this
// task exists to fix).
// ---------------------------------------------------------------------------

describe('CONTRACT: createNativeBeadsSync.ingest() output vs verbs/ingest.mjs.normalizePulledItem()', () => {
  test('a real createNativeBeadsSync, fed a realistic fake beads client, produces records normalizePulledItem() accepts and reads correctly', async () => {
    const { normalizePulledItem } = await import('../src/verbs/ingest.mjs');

    const beads = makeFakeBeadsClient({
      listRows: [
        { id: 'mem-1', title: 'first', parent: 'mem-epic', acceptance_criteria: 'given/when/then', external_ref: 'WI-1' },
        { id: 'mem-2', title: 'second', parent: 'mem-epic', acceptance_criteria: null, external_ref: 'WI-2' },
      ],
    });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    const rawPulled = await sync.ingest({ refs: ['WI-1', 'WI-2'], secretName: 'azdevops_pat' });

    const normalized = rawPulled.map((raw, index) => normalizePulledItem(raw, index));

    assert.equal(normalized.length, 2);
    assert.equal(normalized[0].beadId, 'mem-1');
    assert.equal(normalized[0].externalRef, 'WI-1');
    assert.equal(normalized[0].parent, 'mem-epic');
    assert.equal(normalized[0].hasAcceptanceCriteria, true, 'a non-empty acceptanceCriteria string must be read as having criteria');

    assert.equal(normalized[1].beadId, 'mem-2');
    assert.equal(normalized[1].hasAcceptanceCriteria, false, 'a null acceptanceCriteria must be read as missing criteria, not throw');
  });

  test('a ref with no matching bead never reaches normalizePulledItem() as a malformed/short item -- it fails first, at the sync boundary', async () => {
    const beads = makeFakeBeadsClient({ listRows: [] });
    const sync = createNativeBeadsSync({ namespace: 'ado', beads });
    await assert.rejects(
      () => sync.ingest({ refs: ['WI-404'], secretName: 'azdevops_pat' }),
      (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.INGEST_PULL_FAILED
    );
  });
});

// ---------------------------------------------------------------------------
// azure-devops adapter: capabilities()
// ---------------------------------------------------------------------------

describe('azure-devops adapter: capabilities()', () => {
  test('reports the descriptor from the implementation plan', () => {
    assert.deepEqual(AzureDevOpsBridgeAdapter.capabilities(), {
      nativeBeadsSync: true,
      canCreateWorkItem: true,
      canComment: true,
      maxJobMinutes: null,
      supportsAttached: true,
    });
  });

  test('registers cleanly through the real registry (its own capabilities satisfy the lockstep rules)', () => {
    resetBridgeAdapters();
    assert.doesNotThrow(() => registerBridgeAdapter(AzureDevOpsBridgeAdapter));
    assert.ok(listBridgeAdapters().includes('azure-devops'));
  });
});

// ---------------------------------------------------------------------------
// azure-devops adapter: resolveRequest (Part C -- no ambient defaults)
// ---------------------------------------------------------------------------

describe('azure-devops adapter: resolveRequest (Part C -- no ambient defaults)', () => {
  test('a fully-populated env resolves cleanly and defaults the PAT secret name', () => {
    const resolved = AzureDevOpsBridgeAdapter.resolveRequest(validAdoEnv());
    assert.equal(resolved.adoOrgUrl, 'https://example.invalid/fake-org');
    assert.equal(resolved.adoProject, 'fake-project');
    assert.equal(resolved.agentPool, 'fake-pool');
    assert.equal(resolved.adoPatSecretName, 'fleet_bridge_azdevops_pat');
    assert.deepEqual(resolved.sprintRequest.workItems, ['WI-1']);
  });

  test('an explicit adoPatSecretName overrides the default', () => {
    const resolved = AzureDevOpsBridgeAdapter.resolveRequest(validAdoEnv({ adoPatSecretName: 'custom_pat' }));
    assert.equal(resolved.adoPatSecretName, 'custom_pat');
  });

  for (const { key, param } of [
    { key: 'adoOrgUrl', param: 'adoOrgUrl' },
    { key: 'adoProject', param: 'adoProject' },
    { key: 'agentPool', param: 'agentPool' },
    { key: 'repoPath', param: 'repoPath' },
    { key: 'member', param: 'member' },
    { key: 'targetBranch', param: 'targetBranch' },
    { key: 'baseBranch', param: 'baseBranch' },
    { key: 'workItems', param: 'workItems' },
  ]) {
    test(`missing "${key}" throws CONFIG_MISSING naming the value and the pipeline parameter "${param}" -- no fallback`, () => {
      const env = validAdoEnv();
      delete env[key];
      assert.throws(
        () => AzureDevOpsBridgeAdapter.resolveRequest(env),
        (err) => {
          assert.ok(err instanceof BridgeError);
          assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
          assert.match(err.message, new RegExp(key));
          assert.match(err.message, new RegExp(param));
          return true;
        }
      );
    });
  }

  test('an empty workItems array is treated as missing, not as "no work"', () => {
    assert.throws(
      () => AzureDevOpsBridgeAdapter.resolveRequest(validAdoEnv({ workItems: [] })),
      (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.CONFIG_MISSING
    );
  });
});

// ---------------------------------------------------------------------------
// azure-devops adapter: ingest/publishCarryOver delegate to the injected
// beads client with namespace 'ado'
// ---------------------------------------------------------------------------

describe('azure-devops adapter: ingest/publishCarryOver delegate to the injected beads client', () => {
  test('ingest() delegates to beads.trackerPull with namespace "ado", then returns the local read-back', async () => {
    const beads = makeFakeBeadsClient({
      listRows: [
        { id: 'mem-1', title: 'a', parent: null, acceptance_criteria: 'c1', external_ref: 'WI-1' },
        { id: 'mem-2', title: 'b', parent: null, acceptance_criteria: 'c2', external_ref: 'WI-2' },
      ],
    });
    const result = await AzureDevOpsBridgeAdapter.ingest({ refs: ['WI-1', 'WI-2'], secretName: 'azdevops_pat' }, { beads });
    assert.equal(beads.calls.trackerPull.length, 1);
    assert.equal(beads.calls.trackerPull[0].namespace, 'ado');
    assert.deepEqual(beads.calls.trackerPull[0].refs, ['WI-1', 'WI-2']);
    assert.equal(beads.calls.trackerPull[0].opts.secretName, 'azdevops_pat');
    assert.deepEqual(result.map((r) => r.beadId).sort(), ['mem-1', 'mem-2']);
  });

  test('ingest() surfaces INGEST_PULL_FAILED (never a short list) when a ref matches no bead after the pull', async () => {
    const beads = makeFakeBeadsClient({ listRows: [] });
    await assert.rejects(
      () => AzureDevOpsBridgeAdapter.ingest({ refs: ['WI-1'], secretName: 'azdevops_pat' }, { beads }),
      (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.INGEST_PULL_FAILED
    );
  });

  test('publishCarryOver() delegates an ALREADY-LINKED bead to beads.trackerPush with namespace "ado"', async () => {
    // Already linked (external_ref present) means the work item exists, so
    // this is the UPDATE path and stays with beads exactly as before.
    const beads = makeFakeBeadsClient({
      showRows: { 'mem-1i4': { id: 'mem-1i4', external_ref: 'https://example.invalid/fake-org/fake-project/_workitems/edit/9' } },
    });
    await AzureDevOpsBridgeAdapter.publishCarryOver({ beadIds: ['mem-1i4'], secretName: 'azdevops_pat', dryRun: true }, { beads });
    assert.equal(beads.calls.trackerPush.length, 1);
    assert.equal(beads.calls.trackerPush[0].namespace, 'ado');
    assert.deepEqual(beads.calls.trackerPush[0].beadIds, ['mem-1i4']);
    assert.equal(beads.calls.trackerPush[0].opts.secretName, 'azdevops_pat');
    assert.equal(beads.calls.trackerPush[0].opts.dryRun, true);
  });

  test('ingest() without an injected beads client throws CONFIG_MISSING', async () => {
    await assert.rejects(
      () => AzureDevOpsBridgeAdapter.ingest({ refs: [] }, {}),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// azure-devops adapter: comment/setBuildStatus (declared-but-minimal,
// injected REST transport, never a real fetch)
// ---------------------------------------------------------------------------

describe('azure-devops adapter: comment/setBuildStatus (injected REST transport)', () => {
  test('comment() delegates to deps.restClient and includes the secret NAME, never a value', async () => {
    const restClient = makeFakeRestClient();
    const resolved = { adoOrgUrl: 'https://example.invalid/fake-org', adoProject: 'fake-project', adoPatSecretName: 'azdevops_pat' };
    await AzureDevOpsBridgeAdapter.comment({ resolved, workItemId: 42, body: 'hello' }, { restClient });
    assert.equal(restClient.calls.length, 1);
    assert.match(restClient.calls[0].url, /_apis\/wit\/workItems\/42\/comments/);
    assert.equal(restClient.calls[0].secretName, 'azdevops_pat');
    assert.equal(restClient.calls[0].body.text, 'hello');
  });

  test('comment() without an injected restClient throws CONFIG_MISSING', async () => {
    await assert.rejects(
      () => AzureDevOpsBridgeAdapter.comment({ resolved: {}, workItemId: 1 }, {}),
      (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.CONFIG_MISSING
    );
  });

  test('setBuildStatus() delegates to deps.restClient', async () => {
    const restClient = makeFakeRestClient();
    const resolved = { adoOrgUrl: 'https://example.invalid/fake-org', adoProject: 'fake-project' };
    await AzureDevOpsBridgeAdapter.setBuildStatus({ resolved, state: 'succeeded' }, { restClient });
    assert.equal(restClient.calls.length, 1);
    assert.match(restClient.calls[0].url, /_apis\/build\/builds/);
    assert.equal(restClient.calls[0].secretName, 'fleet_bridge_azdevops_pat');
  });

  test('comment() with missing workItemId throws CONFIG_INVALID', async () => {
    const restClient = makeFakeRestClient();
    const resolved = { adoOrgUrl: 'https://example.invalid/fake-org', adoProject: 'fake-project' };
    await assert.rejects(
      () => AzureDevOpsBridgeAdapter.comment({ resolved, body: 'hello' }, { restClient }),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
        assert.match(err.message, /workItemId/);
        return true;
      }
    );
  });

  test('comment() with null/empty workItemId throws CONFIG_INVALID', async () => {
    const restClient = makeFakeRestClient();
    const resolved = { adoOrgUrl: 'https://example.invalid/fake-org', adoProject: 'fake-project' };
    for (const val of [null, '', undefined]) {
      await assert.rejects(
        () => AzureDevOpsBridgeAdapter.comment({ resolved, workItemId: val, body: 'hello' }, { restClient }),
        (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.CONFIG_INVALID
      );
    }
  });

  test('setBuildStatus() with missing state throws CONFIG_MISSING', async () => {
    const restClient = makeFakeRestClient();
    const resolved = { adoOrgUrl: 'https://example.invalid/fake-org', adoProject: 'fake-project' };
    await assert.rejects(
      () => AzureDevOpsBridgeAdapter.setBuildStatus({ resolved }, { restClient }),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
        assert.match(err.message, /state/);
        return true;
      }
    );
  });

  test('setBuildStatus() with null/empty state throws CONFIG_MISSING', async () => {
    const restClient = makeFakeRestClient();
    const resolved = { adoOrgUrl: 'https://example.invalid/fake-org', adoProject: 'fake-project' };
    for (const val of [null, '', undefined]) {
      await assert.rejects(
        () => AzureDevOpsBridgeAdapter.setBuildStatus({ resolved, state: val }, { restClient }),
        (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.CONFIG_MISSING
      );
    }
  });

  test('setBuildStatus() with wrong-type state throws CONFIG_INVALID', async () => {
    const restClient = makeFakeRestClient();
    const resolved = { adoOrgUrl: 'https://example.invalid/fake-org', adoProject: 'fake-project' };
    for (const val of [123, true, { state: 'succeeded' }, ['succeeded']]) {
      await assert.rejects(
        () => AzureDevOpsBridgeAdapter.setBuildStatus({ resolved, state: val }, { restClient }),
        (err) => {
          assert.ok(err instanceof BridgeError);
          assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
          assert.match(err.message, /string/);
          return true;
        }
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Source-scan guard 1: nativeBeadsSync is declarative-only
// ---------------------------------------------------------------------------

test('SOURCE SCAN: nativeBeadsSync is referenced only inside src/adapters/ -- no caller above the adapter layer branches on it', () => {
  const srcRoot = path.join(pkgRoot, 'src');
  const binRoot = path.join(pkgRoot, 'bin');
  const offenders = [];

  function scanDir(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full === ADAPTERS_DIR) continue; // excluded by design -- this is where it may live
        scanDir(full);
      } else if (entry.isFile() && full.endsWith('.mjs')) {
        const content = readFileSync(full, 'utf-8');
        if (content.includes('nativeBeadsSync')) offenders.push(full);
      }
    }
  }

  scanDir(srcRoot);
  scanDir(binRoot);

  assert.deepEqual(offenders, [], `nativeBeadsSync referenced outside src/adapters/: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Source-scan guard 2: no dev.azure.com/<org> literal, no hardcoded org/project
// ---------------------------------------------------------------------------

test('SOURCE SCAN: azure-devops.mjs contains no literal dev.azure.com org-URL and no hardcoded org/project string', () => {
  const src = readFileSync(AZURE_DEVOPS_SOURCE_PATH, 'utf-8');

  // No literal "dev.azure.com/<something>" segment anywhere in the file.
  assert.ok(
    !/dev\.azure\.com\/[A-Za-z0-9]/.test(src),
    'found a literal Azure DevOps org-URL segment (dev.azure.com/<org>) -- org URLs must always be caller-supplied'
  );

  // adoOrgUrl / adoProject must never be assigned a string literal -- every
  // occurrence must read from caller-supplied data (env.*, resolved.*, r.*).
  assert.ok(
    !/adoOrgUrl\s*[:=]\s*['"`]/.test(src),
    'adoOrgUrl must never be assigned a literal string'
  );
  assert.ok(
    !/adoProject\s*[:=]\s*['"`]/.test(src),
    'adoProject must never be assigned a literal string'
  );
});

// ---------------------------------------------------------------------------
// No ambient I/O in the three new modules
// ---------------------------------------------------------------------------

test('none of the new adapter modules touch process.env, node:fs, or call fetch directly', () => {
  for (const file of [INDEX_SOURCE_PATH, NATIVE_BEADS_SYNC_SOURCE_PATH, AZURE_DEVOPS_SOURCE_PATH]) {
    const src = readFileSync(file, 'utf-8');
    assert.ok(!/process\.env[.[]/.test(src), `${file} must not read process.env`);
    assert.ok(
      !/from ['"]node:fs['"]/.test(src) && !/require\(['"]node:fs['"]\)/.test(src),
      `${file} must not import node:fs`
    );
    assert.ok(!/globalThis\.fetch\s*\(/.test(src) && !/(?<![.\w])fetch\s*\(/.test(src), `${file} must not call fetch directly`);
  }
});

// ---------------------------------------------------------------------------
// azure-devops adapter: carry-over CREATION over REST
//
// Why any of this exists: `bd ado push` creates work items with
// System.State hardcoded to 'New', which 400s on a Basic-process project
// (To Do / Doing / Done) while beads still exits 0. See the adapter's
// "BEADS CANNOT CREATE HERE" note.
// ---------------------------------------------------------------------------

const TYPES_BODY = JSON.stringify({
  value: [{ name: 'Issue' }, { name: 'Epic' }, { name: 'Task' }, { name: 'Test Case' }],
});

/** A REST fake that answers the two endpoints the create path uses, and
 *  records every request so a test can assert on the exact payload. */
function makeWitRestClient({ types = TYPES_BODY, createdId = 5, createStatus = 201 } = {}) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    if (req.url.includes('/_apis/wit/workitemtypes')) {
      return { status: 200, body: types };
    }
    return {
      status: createStatus,
      body: JSON.stringify({
        id: createdId,
        _links: { html: { href: `https://example.invalid/fake-org/fake-project/_workitems/edit/${createdId}` } },
      }),
    };
  };
  fn.calls = calls;
  return fn;
}

const CREATE_RESOLVED = Object.freeze({
  adoOrgUrl: 'https://example.invalid/fake-org',
  adoProject: 'fake-project',
  adoPatSecretName: 'azdevops_pat',
});

describe('azure-devops adapter: carry-over creation (REST, no System.State)', () => {
  test('the create payload carries Title and Description and NO System.State at all', async () => {
    const beads = makeFakeBeadsClient({ showRows: { 'mem-9': { id: 'mem-9', title: 'Leftover work', description: 'why' } } });
    const restClient = makeWitRestClient();

    await AzureDevOpsBridgeAdapter.publishCarryOver(
      { beadIds: ['mem-9'], secretName: 'azdevops_pat', dryRun: false },
      { beads, restClient, resolved: CREATE_RESOLVED }
    );

    const create = restClient.calls.find((c) => c.method === 'POST');
    assert.ok(create, 'a create POST must have been dispatched');
    assert.equal(create.contentType, 'application/json-patch+json');
    const paths = create.body.map((op) => op.path);
    assert.deepEqual(paths, ['/fields/System.Title', '/fields/System.Description']);
    // THE load-bearing assertion of this whole change.
    assert.ok(
      !JSON.stringify(create.body).includes('System.State'),
      'the create payload must never set System.State -- Azure DevOps applies the type\'s own initial state'
    );
    assert.equal(create.secretName, 'azdevops_pat', 'the secret NAME travels, never a value');
  });

  test('the work item type is discovered from the project, never hardcoded', async () => {
    const beads = makeFakeBeadsClient({ showRows: { 'mem-9': { id: 'mem-9', title: 'Leftover work' } } });
    // A project that offers NO 'Issue' -- the type must follow the project,
    // so the URL must name 'User Story', which appears nowhere as a default.
    const restClient = makeWitRestClient({ types: JSON.stringify({ value: [{ name: 'Bug' }, { name: 'User Story' }] }) });

    await AzureDevOpsBridgeAdapter.publishCarryOver(
      { beadIds: ['mem-9'], secretName: 'azdevops_pat', dryRun: false },
      { beads, restClient, resolved: CREATE_RESOLVED }
    );

    const create = restClient.calls.find((c) => c.method === 'POST');
    assert.match(create.url, /_apis\/wit\/workitems\/\$User%20Story/);
  });

  test('a configured work item type wins, but is validated against the project first', async () => {
    const beads = makeFakeBeadsClient({ showRows: { 'mem-9': { id: 'mem-9', title: 'Leftover work' } } });
    const restClient = makeWitRestClient();

    await AzureDevOpsBridgeAdapter.publishCarryOver(
      { beadIds: ['mem-9'], secretName: 'azdevops_pat', dryRun: false },
      { beads, restClient, resolved: { ...CREATE_RESOLVED, adoWorkItemType: 'Task' } }
    );
    assert.match(restClient.calls.find((c) => c.method === 'POST').url, /workitems\/\$Task\?/);
  });

  test('an unknown configured type FAILS, naming the types the project actually offers', async () => {
    const beads = makeFakeBeadsClient({ showRows: { 'mem-9': { id: 'mem-9', title: 'Leftover work' } } });
    const restClient = makeWitRestClient();

    await assert.rejects(
      () => AzureDevOpsBridgeAdapter.publishCarryOver(
        { beadIds: ['mem-9'], secretName: 'azdevops_pat', dryRun: false },
        { beads, restClient, resolved: { ...CREATE_RESOLVED, adoWorkItemType: 'Bug' } }
      ),
      (err) => {
        assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
        assert.match(err.message, /Issue, Epic, Task/);
        return true;
      }
    );
    assert.equal(restClient.calls.filter((c) => c.method === 'POST').length, 0, 'nothing may be created on an unknown type');
  });

  test('a project offering none of the known types FAILS rather than guessing', async () => {
    const beads = makeFakeBeadsClient({ showRows: { 'mem-9': { id: 'mem-9', title: 'Leftover work' } } });
    const restClient = makeWitRestClient({ types: JSON.stringify({ value: [{ name: 'Ticket' }] }) });

    await assert.rejects(
      () => AzureDevOpsBridgeAdapter.publishCarryOver(
        { beadIds: ['mem-9'], secretName: 'azdevops_pat', dryRun: false },
        { beads, restClient, resolved: CREATE_RESOLVED }
      ),
      (err) => {
        assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
        assert.match(err.message, /adoWorkItemType/);
        return true;
      }
    );
  });

  test('the tracker ref is stamped back onto the bead, and a re-run creates nothing', async () => {
    const beads = makeFakeBeadsClient({ showRows: { 'mem-9': { id: 'mem-9', title: 'Leftover work' } } });
    const restClient = makeWitRestClient({ createdId: 7 });

    const first = await AzureDevOpsBridgeAdapter.publishCarryOver(
      { beadIds: ['mem-9'], secretName: 'azdevops_pat', dryRun: false },
      { beads, restClient, resolved: CREATE_RESOLVED }
    );
    assert.equal(beads.calls.update.length, 1);
    assert.equal(beads.calls.update[0].fields.externalRef, 'https://example.invalid/fake-org/fake-project/_workitems/edit/7');
    assert.deepEqual(first, [{
      beadId: 'mem-9',
      externalRef: 'https://example.invalid/fake-org/fake-project/_workitems/edit/7',
      pushed: true,
      created: true,
    }]);

    // IDEMPOTENCY: the second run sees the stamp and takes the update path.
    const createsAfterFirst = restClient.calls.filter((c) => c.method === 'POST').length;
    const second = await AzureDevOpsBridgeAdapter.publishCarryOver(
      { beadIds: ['mem-9'], secretName: 'azdevops_pat', dryRun: false },
      { beads, restClient, resolved: CREATE_RESOLVED }
    );
    assert.equal(restClient.calls.filter((c) => c.method === 'POST').length, createsAfterFirst, 'a re-run must create no second work item');
    assert.equal(beads.calls.update.length, 1, 'a re-run must not re-stamp');
    assert.equal(second[0].pushed, true);
    assert.equal(second[0].created, false);
    assert.equal(beads.calls.trackerPush.length, 1, 'the re-run goes through the bd ado push UPDATE path');
  });

  test('dryRun creates nothing, stamps nothing, and dispatches no REST at all', async () => {
    const beads = makeFakeBeadsClient({ showRows: { 'mem-9': { id: 'mem-9', title: 'Leftover work' } } });
    const restClient = makeWitRestClient();

    const result = await AzureDevOpsBridgeAdapter.publishCarryOver(
      { beadIds: ['mem-9'], secretName: 'azdevops_pat', dryRun: true },
      { beads, restClient, resolved: CREATE_RESOLVED }
    );
    assert.equal(restClient.calls.length, 0);
    assert.equal(beads.calls.update.length, 0);
    assert.deepEqual(result, [{ beadId: 'mem-9', externalRef: null, pushed: false, created: false }]);
  });

  test('a non-2xx create is a THROW, never a silently unpublished row', async () => {
    const beads = makeFakeBeadsClient({ showRows: { 'mem-9': { id: 'mem-9', title: 'Leftover work' } } });
    const restClient = makeWitRestClient({ createStatus: 400 });

    await assert.rejects(
      () => AzureDevOpsBridgeAdapter.publishCarryOver(
        { beadIds: ['mem-9'], secretName: 'azdevops_pat', dryRun: false },
        { beads, restClient, resolved: CREATE_RESOLVED }
      ),
      (err) => {
        assert.equal(err.code, BRIDGE_ERROR_CODES.CARRYOVER_PUBLISH_FAILED);
        return true;
      }
    );
    assert.equal(beads.calls.update.length, 0, 'a failed create must not stamp a ref');
  });

  test('capabilities().canCreateWorkItem:true now has a createWorkItem function behind it', () => {
    assert.equal(AzureDevOpsBridgeAdapter.capabilities().canCreateWorkItem, true);
    assert.equal(typeof AzureDevOpsBridgeAdapter.createWorkItem, 'function');
  });

  test('registerBridgeAdapter refuses canCreateWorkItem:true with no createWorkItem', () => {
    resetBridgeAdapters();
    const impl = makeAdapter({ name: 'no-create', capabilities: () => makeValidCaps({ canCreateWorkItem: true }) });
    delete impl.createWorkItem;
    assert.throws(() => registerBridgeAdapter(impl), (err) => {
      assert.equal(err.code, BRIDGE_ERROR_CODES.ADAPTER_INVALID);
      assert.match(err.message, /canCreateWorkItem/);
      return true;
    });
    resetBridgeAdapters();
  });
});
