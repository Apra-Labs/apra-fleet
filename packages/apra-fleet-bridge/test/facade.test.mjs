// Tests for src/adapters/facade.mjs.
//
// The load-bearing test in this file is 'the contract test' below: it wires
// the REAL registry adapter (adapters/azure-devops.mjs, reached through
// adapters/index.mjs's getBridgeAdapter() -- never reimplemented or forked
// here) together with the REAL facade, with a fake `restClient` as the only
// fake on the wire. Per this package's build log ("adapter.comment has
// three incompatible signatures"), fakes on both sides of a producer/
// consumer seam are exactly how three incompatible `comment()` shapes
// diverged unnoticed -- this test exists so a fourth divergence cannot do
// the same.
//
// The remaining describe blocks use a minimal fake registry-adapter shape
// (capabilities()/comment()/emitProgress()/setBuildStatus() as plain
// functions) where the behaviour under test does not depend on
// azure-devops.mjs specifically -- e.g. capabilities().canComment: false,
// which the real adapter never declares.
//
// ASCII only.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createAdapterFacade, resolveTargetWorkItem } from '../src/adapters/facade.mjs';
import { getBridgeAdapter } from '../src/adapters/index.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakeRestClient(response = { status: 200 }) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    return response;
  };
  fn.calls = calls;
  return fn;
}

/** Mirrors adapters.test.mjs's own fixture exactly -- valid Azure DevOps
 *  pipeline env for AzureDevOpsBridgeAdapter.resolveRequest(). */
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

function makeLog() {
  const lines = [];
  const log = (msg) => lines.push(msg);
  log.lines = lines;
  return log;
}

/** A minimal registry-adapter-shaped fake -- used only where the behaviour
 *  under test is independent of azure-devops.mjs's specific request/response
 *  shapes (e.g. capabilities().canComment: false, which the real adapter
 *  never declares). */
function makeFakeRegistryAdapter({ canComment = true, hasEmitProgress = false, hasSetBuildStatus = false, commentThrows = false } = {}) {
  const commentCalls = [];
  const emitProgressCalls = [];
  const setBuildStatusCalls = [];
  const impl = {
    capabilities: () => ({ canComment }),
    async comment(opts) {
      commentCalls.push(opts);
      if (commentThrows) throw new Error('REST 503');
      return { ok: true };
    },
  };
  if (hasEmitProgress) {
    impl.emitProgress = async (snapshot) => { emitProgressCalls.push(snapshot); };
  }
  if (hasSetBuildStatus) {
    impl.setBuildStatus = async (opts) => { setBuildStatusCalls.push(opts); };
  }
  impl.commentCalls = commentCalls;
  impl.emitProgressCalls = emitProgressCalls;
  impl.setBuildStatusCalls = setBuildStatusCalls;
  return impl;
}

// ---------------------------------------------------------------------------
// THE CONTRACT TEST -- real registry adapter + real facade, fake restClient only.
// ---------------------------------------------------------------------------

describe('createAdapterFacade: contract test against the REAL registry adapter', () => {
  test('the facade drives the real azure-devops adapter through comment()', async () => {
    const AzureDevOpsBridgeAdapter = getBridgeAdapter('azure-devops');
    const resolved = AzureDevOpsBridgeAdapter.resolveRequest(validAdoEnv());
    const restClient = makeFakeRestClient();

    const facade = createAdapterFacade({
      adapter: AzureDevOpsBridgeAdapter,
      resolved,
      restClient,
      log: makeLog(),
    });

    assert.strictEqual(facade.targetWorkItem, 'WI-1', 'resolved from resolved.sprintRequest.workItems[0]');

    await facade.comment('hello from the facade');

    assert.strictEqual(restClient.calls.length, 1);
    assert.match(restClient.calls[0].url, /_apis\/wit\/workItems\/WI-1\/comments/);
    assert.strictEqual(restClient.calls[0].secretName, 'fleet_bridge_azdevops_pat');
    assert.strictEqual(restClient.calls[0].body.text, 'hello from the facade');
  });

  test('the facade prefers the handle over resolved for targeting, against the real adapter', async () => {
    const AzureDevOpsBridgeAdapter = getBridgeAdapter('azure-devops');
    // resolved carries WI-1 (from resolveRequest's own validation), but a
    // SprintHandle written by launch is the authoritative record of what
    // this specific sprint launched against -- see facade.mjs's
    // "WORK-ITEM TARGETING". Give it a different work item to prove
    // precedence.
    const resolved = AzureDevOpsBridgeAdapter.resolveRequest(validAdoEnv({ workItems: ['WI-1'] }));
    const handle = { sprintId: 'spr-9', request: { workItems: ['WI-77'] } };
    const restClient = makeFakeRestClient();

    const facade = createAdapterFacade({ adapter: AzureDevOpsBridgeAdapter, resolved, handle, restClient, log: makeLog() });

    assert.strictEqual(facade.targetWorkItem, 'WI-77');
    await facade.comment('body');
    assert.match(restClient.calls[0].url, /_apis\/wit\/workItems\/WI-77\/comments/);
  });

  test('a REST failure inside the real adapter\'s comment() is caught and never rethrown', async () => {
    const AzureDevOpsBridgeAdapter = getBridgeAdapter('azure-devops');
    const resolved = AzureDevOpsBridgeAdapter.resolveRequest(validAdoEnv());
    const throwingRestClient = async () => { throw new Error('ADO 503'); };
    const log = makeLog();

    const facade = createAdapterFacade({ adapter: AzureDevOpsBridgeAdapter, resolved, restClient: throwingRestClient, log });

    // Must resolve, not reject -- see facade.mjs's "COMMENT NEVER THROWS".
    await assert.doesNotReject(() => facade.comment('body'));
    assert.ok(log.lines.some((l) => /comment\(\) failed/.test(l) && /ADO 503/.test(l)));
  });

  test('setBuildStatus() also delegates to the real adapter with the injected restClient', async () => {
    const AzureDevOpsBridgeAdapter = getBridgeAdapter('azure-devops');
    const resolved = AzureDevOpsBridgeAdapter.resolveRequest(validAdoEnv());
    const restClient = makeFakeRestClient();
    const facade = createAdapterFacade({ adapter: AzureDevOpsBridgeAdapter, resolved, restClient, log: makeLog() });

    await facade.setBuildStatus('succeeded', 'https://example.invalid/build/1');

    assert.strictEqual(restClient.calls.length, 1);
    assert.match(restClient.calls[0].url, /_apis\/build\/builds/);
    assert.strictEqual(restClient.calls[0].body.state, 'succeeded');
    assert.strictEqual(restClient.calls[0].body.targetUrl, 'https://example.invalid/build/1');
  });
});

// ---------------------------------------------------------------------------
// A non-2xx result is DATA, not a throw (rest-client.mjs / azure-devops.mjs)
// -- so the try/catch above never fires for a 401/403/404. Before this fix
// that made every such failure completely invisible: no log line at all.
// These tests drive the REAL registry adapter (same rationale as the
// contract-test block above) so the exact `{ status, body }` shape a real
// REST failure resolves to is what is under test, not a fake's guess at it.
// ---------------------------------------------------------------------------

describe('createAdapterFacade: a non-2xx response is logged, not swallowed', () => {
  test('comment() logs a 403, naming the operation, the work item, and the status', async () => {
    const AzureDevOpsBridgeAdapter = getBridgeAdapter('azure-devops');
    const resolved = AzureDevOpsBridgeAdapter.resolveRequest(validAdoEnv());
    const restClient = makeFakeRestClient({ status: 403, body: '{"message":"Access Denied: no permission to comment"}' });
    const log = makeLog();
    const facade = createAdapterFacade({ adapter: AzureDevOpsBridgeAdapter, resolved, restClient, log });

    await facade.comment('hello');

    const line = log.lines.find((l) => /comment\(\)/.test(l) && /status=403/.test(l));
    assert.ok(line, `expected a logged non-2xx line naming comment() and status=403; got: ${JSON.stringify(log.lines)}`);
    assert.match(line, /workItemId=WI-1/);
    assert.match(line, /Access Denied/);
  });

  test('comment() logs a 404 distinctly from a 403 -- permission vs wrong id must read differently', async () => {
    const AzureDevOpsBridgeAdapter = getBridgeAdapter('azure-devops');
    const resolved = AzureDevOpsBridgeAdapter.resolveRequest(validAdoEnv());
    const restClient = makeFakeRestClient({ status: 404, body: 'work item WI-1 does not exist' });
    const log = makeLog();
    const facade = createAdapterFacade({ adapter: AzureDevOpsBridgeAdapter, resolved, restClient, log });

    await facade.comment('hello');

    const line = log.lines.find((l) => /comment\(\)/.test(l) && /status=404/.test(l));
    assert.ok(line, `expected a logged non-2xx line naming comment() and status=404; got: ${JSON.stringify(log.lines)}`);
    assert.ok(!log.lines.some((l) => /status=403/.test(l)), 'a 404 must never be reported as a 403');
  });

  test('a 2xx comment() response stays quiet -- no non-2xx line is logged', async () => {
    const AzureDevOpsBridgeAdapter = getBridgeAdapter('azure-devops');
    const resolved = AzureDevOpsBridgeAdapter.resolveRequest(validAdoEnv());
    const restClient = makeFakeRestClient({ status: 201, body: '{"id":1}' });
    const log = makeLog();
    const facade = createAdapterFacade({ adapter: AzureDevOpsBridgeAdapter, resolved, restClient, log });

    await facade.comment('hello');

    assert.ok(!log.lines.some((l) => /non-2xx/.test(l)), `expected no non-2xx log line for a 2xx result; got: ${JSON.stringify(log.lines)}`);
  });

  test('setBuildStatus() is covered symmetrically -- a 403 is logged naming the operation and status', async () => {
    const AzureDevOpsBridgeAdapter = getBridgeAdapter('azure-devops');
    const resolved = AzureDevOpsBridgeAdapter.resolveRequest(validAdoEnv());
    const restClient = makeFakeRestClient({ status: 403, body: 'Access Denied' });
    const log = makeLog();
    const facade = createAdapterFacade({ adapter: AzureDevOpsBridgeAdapter, resolved, restClient, log });

    await facade.setBuildStatus('succeeded', 'https://example.invalid/build/1');

    const line = log.lines.find((l) => /setBuildStatus\(\)/.test(l) && /status=403/.test(l));
    assert.ok(line, `expected a logged non-2xx line naming setBuildStatus() and status=403; got: ${JSON.stringify(log.lines)}`);
  });

  test('a 2xx setBuildStatus() response stays quiet too', async () => {
    const AzureDevOpsBridgeAdapter = getBridgeAdapter('azure-devops');
    const resolved = AzureDevOpsBridgeAdapter.resolveRequest(validAdoEnv());
    const restClient = makeFakeRestClient({ status: 200, body: '' });
    const log = makeLog();
    const facade = createAdapterFacade({ adapter: AzureDevOpsBridgeAdapter, resolved, restClient, log });

    await facade.setBuildStatus('succeeded');

    assert.ok(!log.lines.some((l) => /non-2xx/.test(l)), `expected no non-2xx log line for a 2xx result; got: ${JSON.stringify(log.lines)}`);
  });

  test('a non-2xx body is redacted before it reaches the log -- a SAS signature must never leak', async () => {
    const AzureDevOpsBridgeAdapter = getBridgeAdapter('azure-devops');
    const resolved = AzureDevOpsBridgeAdapter.resolveRequest(validAdoEnv());
    const leakedBody = 'see https://acct.blob.core.windows.net/c/b?sv=2025-01-01&sig=super-secret-signature for details';
    const restClient = makeFakeRestClient({ status: 500, body: leakedBody });
    const log = makeLog();
    const facade = createAdapterFacade({ adapter: AzureDevOpsBridgeAdapter, resolved, restClient, log });

    await facade.comment('hello');

    const all = log.lines.join('\n');
    assert.ok(!all.includes('super-secret-signature'), `a SAS signature leaked into the log: ${all}`);
    assert.match(all, /sig=\[REDACTED\]/);
  });
});

// ---------------------------------------------------------------------------
// capabilities().canComment: false -- comment() must degrade to a no-op.
// ---------------------------------------------------------------------------

describe('createAdapterFacade: respecting capabilities()', () => {
  test('canComment: false makes comment() a logged no-op, never a throw', async () => {
    const registryAdapter = makeFakeRegistryAdapter({ canComment: false });
    const log = makeLog();
    const facade = createAdapterFacade({ adapter: registryAdapter, handle: { request: { workItems: ['WI-1'] } }, log });

    await facade.comment('should not be sent');

    assert.strictEqual(registryAdapter.commentCalls.length, 0, 'the underlying adapter.comment() was never called');
    assert.ok(log.lines.some((l) => /canComment is false/.test(l)));
  });

  test('capabilities() passes through the adapter\'s own frozen snapshot', () => {
    const registryAdapter = makeFakeRegistryAdapter({ canComment: true });
    const facade = createAdapterFacade({ adapter: registryAdapter });
    assert.deepStrictEqual(facade.capabilities(), { canComment: true });
  });

  test('emitProgress() is a logged no-op when the adapter has none', async () => {
    const registryAdapter = makeFakeRegistryAdapter({ hasEmitProgress: false });
    const log = makeLog();
    const facade = createAdapterFacade({ adapter: registryAdapter, log });
    await assert.doesNotReject(() => facade.emitProgress({ phase: 'x' }));
    assert.ok(log.lines.some((l) => /no emitProgress/.test(l)));
  });

  test('emitProgress() passes through when the adapter has one', async () => {
    const registryAdapter = makeFakeRegistryAdapter({ hasEmitProgress: true });
    const facade = createAdapterFacade({ adapter: registryAdapter, log: makeLog() });
    await facade.emitProgress({ phase: 'x' });
    assert.strictEqual(registryAdapter.emitProgressCalls.length, 1);
  });

  test('setBuildStatus() is a logged no-op when the adapter has none', async () => {
    const registryAdapter = makeFakeRegistryAdapter({ hasSetBuildStatus: false });
    const log = makeLog();
    const facade = createAdapterFacade({ adapter: registryAdapter, log });
    await assert.doesNotReject(() => facade.setBuildStatus('succeeded'));
    assert.ok(log.lines.some((l) => /no setBuildStatus/.test(l)));
  });
});

// ---------------------------------------------------------------------------
// Work-item targeting: resolveTargetWorkItem() and construction-time binding.
// ---------------------------------------------------------------------------

describe('resolveTargetWorkItem', () => {
  test('prefers handle.request.workItems[0] over resolved.sprintRequest.workItems[0]', () => {
    const target = resolveTargetWorkItem({
      resolved: { sprintRequest: { workItems: ['WI-9'] } },
      handle: { request: { workItems: ['WI-1', 'WI-2'] } },
    });
    assert.strictEqual(target, 'WI-1');
  });

  test('falls back to resolved.sprintRequest.workItems[0] when no handle is given', () => {
    const target = resolveTargetWorkItem({ resolved: { sprintRequest: { workItems: ['WI-9'] } } });
    assert.strictEqual(target, 'WI-9');
  });

  test('returns null when neither source has a usable workItems list', () => {
    assert.strictEqual(resolveTargetWorkItem({}), null);
    assert.strictEqual(resolveTargetWorkItem({ handle: { request: { workItems: [] } } }), null);
    assert.strictEqual(resolveTargetWorkItem(), null);
  });
});

describe('createAdapterFacade: both verbs agree on the same work item, by construction', () => {
  test('one facade instance targets the same work item whether "watch" or "finalize" calls comment()', async () => {
    const registryAdapter = makeFakeRegistryAdapter({ canComment: true });
    const handle = { sprintId: 'spr-1', request: { workItems: ['WI-100', 'WI-200'] } };
    const facade = createAdapterFacade({ adapter: registryAdapter, handle, log: makeLog() });

    // Simulate watch.mjs's call site: adapter.comment(markdown) on a phase
    // transition.
    await facade.comment('phase transition comment');
    // Simulate finalize.mjs's call site: adapter.comment(markdown) as the
    // final comment.
    await facade.comment('final comment');

    assert.strictEqual(registryAdapter.commentCalls.length, 2);
    assert.strictEqual(registryAdapter.commentCalls[0].workItemId, 'WI-100');
    assert.strictEqual(registryAdapter.commentCalls[1].workItemId, 'WI-100');
    assert.strictEqual(facade.targetWorkItem, 'WI-100');
  });

  test('a facade built from resolved only (no handle) still agrees with itself across calls', async () => {
    const registryAdapter = makeFakeRegistryAdapter({ canComment: true });
    const resolved = { sprintRequest: { workItems: ['WI-55'] } };
    const facade = createAdapterFacade({ adapter: registryAdapter, resolved, log: makeLog() });

    await facade.comment('a');
    await facade.comment('b');

    assert.strictEqual(registryAdapter.commentCalls[0].workItemId, 'WI-55');
    assert.strictEqual(registryAdapter.commentCalls[1].workItemId, 'WI-55');
  });
});

// ---------------------------------------------------------------------------
// A REST failure in comment() is non-fatal (fake-adapter version -- the
// real-adapter version lives in the contract-test block above).
// ---------------------------------------------------------------------------

describe('createAdapterFacade: comment() failures are never fatal', () => {
  test('an adapter.comment() throw is caught and logged, never rethrown', async () => {
    const registryAdapter = makeFakeRegistryAdapter({ commentThrows: true });
    const log = makeLog();
    const facade = createAdapterFacade({ adapter: registryAdapter, handle: { request: { workItems: ['WI-1'] } }, log });

    await assert.doesNotReject(() => facade.comment('body'));
    assert.strictEqual(registryAdapter.commentCalls.length, 1, 'the call was attempted');
    assert.ok(log.lines.some((l) => /comment\(\) failed/.test(l)));
  });

  test('no target work item resolved -- comment() is a no-op, never a throw', async () => {
    const registryAdapter = makeFakeRegistryAdapter();
    const log = makeLog();
    const facade = createAdapterFacade({ adapter: registryAdapter, log });

    assert.strictEqual(facade.targetWorkItem, null);
    await assert.doesNotReject(() => facade.comment('body'));
    assert.strictEqual(registryAdapter.commentCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// ingest / publishCarryOver -- pinned-shape passthrough.
// ---------------------------------------------------------------------------

describe('createAdapterFacade: ingest/publishCarryOver keep the pinned call shape', () => {
  function makeFakeAdapterWithSync() {
    const ingestCalls = [];
    const publishCalls = [];
    return {
      ingestCalls,
      publishCalls,
      capabilities: () => ({ canComment: false }),
      async ingest(opts, deps) { ingestCalls.push({ opts, deps }); return { ok: true }; },
      async publishCarryOver(opts, deps) { publishCalls.push({ opts, deps }); return { ok: true }; },
    };
  }

  test('ingest() forwards opts and deps verbatim when the caller supplies deps', async () => {
    const adapter = makeFakeAdapterWithSync();
    const facade = createAdapterFacade({ adapter, beads: { tag: 'facade-bound' } });
    const callerBeads = { tag: 'caller-supplied' };

    await facade.ingest({ refs: ['a'], secretName: 's' }, { beads: callerBeads });

    assert.deepStrictEqual(adapter.ingestCalls[0].opts, { refs: ['a'], secretName: 's' });
    assert.strictEqual(adapter.ingestCalls[0].deps.beads, callerBeads, 'caller-supplied deps win over the facade-bound default');
  });

  test('publishCarryOver() falls back to the facade-bound beads when the caller supplies no deps', async () => {
    const adapter = makeFakeAdapterWithSync();
    const facadeBeads = { tag: 'facade-bound' };
    const facade = createAdapterFacade({ adapter, beads: facadeBeads });

    await facade.publishCarryOver({ beadIds: ['a'], secretName: 's', dryRun: false });

    assert.deepStrictEqual(adapter.publishCalls[0].opts, { beadIds: ['a'], secretName: 's', dryRun: false });
    assert.strictEqual(adapter.publishCalls[0].deps.beads, facadeBeads);
  });
});

// ---------------------------------------------------------------------------
// Construction-time validation.
// ---------------------------------------------------------------------------

describe('createAdapterFacade: construction', () => {
  test('throws CONFIG_MISSING when ctx.adapter is missing', () => {
    assert.throws(() => createAdapterFacade({}), (err) => {
      assert.ok(err instanceof BridgeError);
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
  });

  test('throws CONFIG_MISSING when ctx.adapter has no capabilities()', () => {
    assert.throws(() => createAdapterFacade({ adapter: {} }), (err) => {
      assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    });
  });

  test('the returned facade is frozen', () => {
    const facade = createAdapterFacade({ adapter: makeFakeRegistryAdapter() });
    assert.throws(() => { facade.comment = null; }, TypeError);
  });
});
