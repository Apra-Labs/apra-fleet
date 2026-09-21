// composition-root.test.mjs -- the real deliverable of this unit
// (bin/fleet-bridge.mjs). See that file's own header for the dispatch
// design; this test proves it against a FAKE module graph: every collaborator
// `buildVerbTable(ctx)`'s `buildDeps` functions would otherwise construct for
// real (an MCP connection, a supervisor HTTP client, `bd`, a REST transport)
// is replaced by a fake `ctx`, and each verb's own `run<Verb>` is replaced by
// a spy -- so this test exercises the REAL `buildOpts`/`buildDeps` wiring
// logic without ever touching a live fleet server, supervisor, or `bd`
// binary.
//
// WHY THIS APPROACH ("say what you did", per the task brief): `buildVerbTable`
// takes `ctx` as a plain argument and returns a plain object keyed by verb
// name -- nothing in `bin/fleet-bridge.mjs` hardcodes which `ctx`/`table` a
// dispatch runs against. That is the "injectable dispatch table": this file
// calls `buildVerbTable(fakeCtx)` to get real `buildOpts`/`buildDeps`
// closures bound to a fake context, then overwrites each entry's `run` with
// a spy before handing the result to `dispatch()`. No verb module
// (`src/verbs/*.mjs`) is mocked at the import level -- `bin/fleet-bridge.mjs`
// still imports the real ones -- but none of them actually EXECUTE here,
// because `run` is what got replaced.
//
// REQUIRED_DEPS_BY_VERB below is hand-derived by reading each verb's own
// (unexported) `validate*Deps` function -- see the citations inline. None of
// them are exported (only each verb's `validate<Verb>Opts` is), and this
// task's file allowlist does not include src/verbs/*.mjs, so this table
// cannot import and call the real validators directly. It is the mechanical
// transcription of what each one throws CONFIG_MISSING for; if a verb's own
// validator ever changes what it requires, this table (and the citation
// comment next to it) needs a matching update -- same as any other pinned
// cross-module contract in this package (see fleet-bridge-build-log.md's
// "Pinned contracts between units").

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildVerbTable, dispatch, createRealContext } from '../bin/fleet-bridge.mjs';
import { VERBS } from '../src/cli/args.mjs';
import { BridgeError, BRIDGE_ERROR_CODES, exitCodeFor } from '../src/errors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.join(__dirname, '..', 'bin', 'fleet-bridge.mjs');

// ---------------------------------------------------------------------------
// The required-deps citations.
// ---------------------------------------------------------------------------
//
//   preflight -- src/verbs/preflight.mjs's runPreflight() (no separate
//     validateDeps helper): throws CONFIG_MISSING only when
//     `!supervisorClient || typeof supervisorClient.getHealth !== 'function'`.
//     Every other collaborator (beads/fleetApi/git/fs) is duck-typed per
//     CHECK, reported as a failed `check` entry rather than thrown.
//   ingest -- validateIngestDeps(): throws unless `deps.beads` exposes
//     create()+setParent() AND `deps.adapter` exposes ingest().
//   launch -- validateLaunchDeps(): throws unless `deps.supervisorClient`
//     exposes postSprint()+getSprint(), `deps.spool` exposes write(),
//     `deps.sleep` is a function, `deps.now` is a function.
//   watch -- validateWatchDeps(): throws unless `deps.supervisorClient`
//     exposes getSprint()+getLog(), `deps.sinks` is an Array, `deps.sleep`
//     and `deps.now` are functions.
//   finalize -- validateFinalizeDeps(): throws unless `deps.supervisorClient`
//     exposes getSprint(), `deps.beads` exposes list()+create(),
//     `deps.adapter` exposes publishCarryOver(), `deps.spool` exposes
//     complete().
//   daemon -- validateDaemonDeps(): throws unless `deps.spool` exposes
//     list()+claim()+release()+patch(), `deps.runWatch` and
//     `deps.runFinalize` are functions, `deps.sleep` and `deps.now` are
//     functions.
//   viewer -- validateViewerDeps(): throws unless `deps.readTokenFile` and
//     `deps.createServer` are functions.
//   status -- validateStatusDeps(): throws unless `deps.supervisorClient`
//     exposes getSprint()+getLog(), `deps.now` is a function.
const REQUIRED_DEPS_BY_VERB = Object.freeze({
  preflight: ['supervisorClient'],
  ingest: ['beads', 'adapter'],
  launch: ['supervisorClient', 'spool', 'sleep', 'now'],
  watch: ['supervisorClient', 'sinks', 'sleep', 'now'],
  finalize: ['supervisorClient', 'beads', 'adapter', 'spool'],
  daemon: ['spool', 'runWatch', 'runFinalize', 'sleep', 'now'],
  viewer: ['readTokenFile', 'createServer'],
  status: ['supervisorClient', 'now'],
});

// Every entry in REQUIRED_DEPS_BY_VERB must itself be one of VERBS, and vice
// versa -- if this ever drifts (a verb added to cli/args.mjs's VERBS without
// a matching citation here), fail loudly rather than silently skipping it.
assert.deepStrictEqual(
  [...VERBS].sort(),
  Object.keys(REQUIRED_DEPS_BY_VERB).sort(),
  'REQUIRED_DEPS_BY_VERB citations are out of sync with cli/args.mjs VERBS -- update the citation list above',
);

// Minimal CLI flags that let each verb's real `buildOpts` succeed without
// throwing (a missing required flag is that verb's OWN concern, already
// covered by its own opts-validation tests -- this file only needs to get
// past buildOpts so buildDeps can run).
const MIN_ARGS_BY_VERB = Object.freeze({
  preflight: [],
  ingest: ['--refs', 'WI-1,WI-2'],
  launch: ['--request-file', 'fake-request.json'],
  watch: ['--sprint-id', 'sprint-1'],
  finalize: ['--sprint-id', 'sprint-1'],
  status: ['--sprint-id', 'sprint-1'],
  daemon: [],
  viewer: [],
});

// ---------------------------------------------------------------------------
// The fake context -- every collaborator buildDeps could reach for, real I/O
// nowhere in sight.
// ---------------------------------------------------------------------------

function makeFakeCtx() {
  const calls = { mcp: 0 };

  const fakeSpoolDoc = {
    handle: {
      sprintId: 'sprint-1',
      request: { platform: 'azure-devops', member: 'fake-member', workItems: ['WI-1'], targetBranch: 'feat/x', baseBranch: 'main' },
      startedAt: Date.now(),
    },
  };

  const fakeSpool = {
    write: async () => fakeSpoolDoc,
    read: async () => fakeSpoolDoc,
    list: async () => [],
    claim: async () => true,
    release: async () => {},
    complete: async () => {},
    fail: async () => {},
    patch: async () => {},
  };

  const fakeBeads = {
    create: async () => ({ id: 'bead-1' }),
    setParent: async () => {},
    list: async () => [],
    show: async () => ({}),
    update: async () => ({}),
    doltPullProbe: async () => ({ ok: true, stdout: '', stderr: '' }),
    trackerPull: async () => ({}),
    trackerPush: async () => ({}),
  };

  const fakeAdapter = {
    capabilities: () => ({ nativeBeadsSync: true, canCreateWorkItem: true, canComment: false, supportsAttached: false, maxJobMinutes: 60 }),
    resolveRequest: (env) => ({ sprintRequest: env }),
    ingest: async () => ({ pulled: [] }),
    publishCarryOver: async () => ([]),
  };

  const fakeFacade = {
    emitProgress: async () => {},
    comment: async () => {},
    setBuildStatus: async () => {},
    ingest: async () => ({ pulled: [] }),
    publishCarryOver: async () => ([]),
    capabilities: () => fakeAdapter.capabilities(),
    targetWorkItem: 'WI-1',
  };

  const fakeSupervisorClient = {
    getHealth: async () => ({ status: 'ok', seams: {} }),
    getMembers: async () => ({ members: [] }),
    listSprints: async () => ({}),
    getSprint: async () => null,
    postSprint: async () => ({ sprintId: 'sprint-1', pid: 1, port: 9999 }),
    stopSprint: async () => true,
    getLog: async () => null,
    forceRelease: async () => true,
  };

  const fakeRestClient = async () => ({ status: 200, body: '{}' });

  const fakeServer = {
    listen(_port, _host, cb) { if (cb) cb(); },
    close(cb) { if (cb) cb(); },
    address() { return { port: 4321 }; },
    on() {},
    once() {},
    removeListener() {},
  };

  return {
    calls,
    env: {},
    clock: { now: () => 0, sleep: async () => {}, setTimeout: (fn) => setTimeout(fn, 0), clearTimeout: () => {} },
    git: { resolveRef: async () => 'deadbeef' },
    fs: {
      readFile: async () => JSON.stringify({
        platform: 'azure-devops', member: 'fake-member', workItems: ['WI-1'], targetBranch: 'feat/x', baseBranch: 'main',
      }),
      writeFile: async () => {},
      mkdir: async () => {},
      rename: async () => {},
      readdir: async () => [],
      stat: async () => ({}),
    },
    log: () => {},
    dataDir: '/fake/data-dir',
    tokenPath: '/fake/data-dir/private/token',
    readTokenFile: () => null,
    async getRepoConfig() { return {}; },
    async configValue(spec) {
      if (spec.default !== undefined) return spec.default;
      // Mirrors resolveConfigValue()'s real contract: an OPTIONAL value
      // absent from every tier resolves to undefined, not to a string.
      // Faking it as a string would make every optional coordinate --
      // including the blob destination -- look configured in every test.
      if (spec.required === false) return undefined;
      return 'fake-config-value';
    },
    async supervisorClient() { return fakeSupervisorClient; },
    async spool() { return fakeSpool; },
    async jsonlPathFor(sprintId) { return `/fake/logs/${sprintId}.jsonl`; },
    openAppendStream: () => ({ write() {}, end(cb) { if (cb) cb(); } }),
    // The Azure transport seam. Every call is recorded (including the URL
    // the real append-blob-http layer would have built) so a test can
    // assert both that the sink was constructed AND that nothing leaked.
    blobCalls: [],
    blobHttp() {
      const rec = (op) => async (args) => {
        this.blobCalls.push({ op, ...args });
        return { status: 201, appendOffset: 0, committedBlockCount: 1, headers: {}, body: '' };
      };
      return {
        createAppendBlob: rec('createAppendBlob'),
        appendBlock: rec('appendBlock'),
        getProperties: rec('getProperties'),
        putBlockBlob: rec('putBlockBlob'),
      };
    },
    async mcp() {
      calls.mcp += 1;
      return { fleetApi: { credentialStoreList: async () => '[]', memberDetail: async () => '{}' }, callTool: async () => ({}), mcpClient: {} };
    },
    async memberDialectFor() { return { targetOs: null, shell: null }; },
    async beadsClientFor(beadsClientForOpts) {
      calls.beadsClientFor = calls.beadsClientFor || [];
      calls.beadsClientFor.push(beadsClientForOpts);
      return fakeBeads;
    },
    async restClientFor() { return fakeRestClient; },
    adapterFor: () => fakeAdapter,
    facadeFor: () => fakeFacade,
    isAliveFn: () => true,
    createServer: () => fakeServer,
  };
}

/** Wraps every table entry's `run` in a spy that records `(opts, deps)` and
 *  resolves to a benign value, WITHOUT changing `buildOpts`/`buildDeps` --
 *  those stay the real production closures under test. */
function spyOnRuns(table) {
  const calls = {};
  const spied = {};
  for (const [verb, entry] of Object.entries(table)) {
    spied[verb] = {
      ...entry,
      async run(opts, deps) {
        calls[verb] = { opts, deps };
        return { ok: true };
      },
    };
  }
  return { table: spied, calls };
}

function fakeArgv(verb, extraArgs = []) {
  return ['node', 'fleet-bridge.mjs', verb, ...extraArgs];
}

async function runDispatch({ table, ctx, argv, waitForLongLived = false }) {
  let exitCode;
  const out = [];
  const err = [];
  await dispatch({
    argv,
    table,
    ctx,
    exit: (code) => { exitCode = code; },
    out: (msg) => out.push(msg),
    err: (msg) => err.push(msg),
    waitForLongLived,
    signalTarget: { once() {} },
  });
  return { exitCode, out, err };
}

// ---------------------------------------------------------------------------
// Every verb: dispatched to the right run*, with a deps object containing
// every key its own validator requires.
// ---------------------------------------------------------------------------

describe('composition root: every VERBS entry is wired', () => {
  for (const verb of VERBS) {
    test(`"${verb}" dispatches to its own run function with a complete deps object`, async () => {
      const ctx = makeFakeCtx();
      const table = buildVerbTable(ctx);

      // This is the assertion that catches an unwired verb: if `verb` was
      // added to cli/args.mjs's VERBS but never given an entry in
      // buildVerbTable()'s returned table, `table[verb]` is undefined and
      // everything below fails loudly instead of silently no-op'ing.
      assert.ok(table[verb], `buildVerbTable() has no entry for verb "${verb}" -- it is in VERBS but not wired`);
      assert.strictEqual(typeof table[verb].run, 'function', `"${verb}"'s table entry has no run() function`);
      assert.strictEqual(typeof table[verb].buildOpts, 'function', `"${verb}"'s table entry has no buildOpts()`);
      assert.strictEqual(typeof table[verb].buildDeps, 'function', `"${verb}"'s table entry has no buildDeps()`);

      const { table: spiedTable, calls } = spyOnRuns(table);
      const argv = fakeArgv(verb, MIN_ARGS_BY_VERB[verb]);

      const { exitCode, err } = await runDispatch({ table: spiedTable, ctx, argv });

      assert.ok(calls[verb], `dispatch("${verb}") never reached that verb's run() -- got exit ${exitCode}, stderr: ${err.join('\n')}`);
      assert.strictEqual(exitCode, 0, `dispatch("${verb}") should have exited 0 once its (spied) run() resolved; stderr: ${err.join('\n')}`);

      const deps = calls[verb].deps;
      const required = REQUIRED_DEPS_BY_VERB[verb];
      for (const key of required) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(deps, key) && deps[key] !== undefined,
          `"${verb}"'s deps object is missing required key "${key}" (per its own validate${verb[0].toUpperCase()}${verb.slice(1)}Deps) -- got keys: ${Object.keys(deps).join(', ')}`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Unknown verb, thrown BridgeError, --help/status never touching MCP.
// ---------------------------------------------------------------------------

describe('composition root: dispatch behaviour', () => {
  test('an unknown verb exits 2', async () => {
    const ctx = makeFakeCtx();
    const table = buildVerbTable(ctx);
    const { exitCode, err } = await runDispatch({ table, ctx, argv: fakeArgv('not-a-real-verb') });
    assert.strictEqual(exitCode, 2);
    assert.ok(err.some((line) => line.includes('unknown verb')), `expected an "unknown verb" message, got: ${err.join('\n')}`);
  });

  test('a thrown BridgeError exits with exitCodeFor(code)', async () => {
    const ctx = makeFakeCtx();
    const table = buildVerbTable(ctx);
    const thrownCode = BRIDGE_ERROR_CODES.BEADS_FAILED;
    const failingTable = {
      ...table,
      ingest: {
        ...table.ingest,
        async run() {
          throw new BridgeError(thrownCode, 'synthetic failure for the composition-root test', { remedy: 'nothing to do, this is a test' });
        },
      },
    };
    const { exitCode, err } = await runDispatch({
      table: failingTable,
      ctx,
      argv: fakeArgv('ingest', MIN_ARGS_BY_VERB.ingest),
    });
    assert.strictEqual(exitCode, exitCodeFor(thrownCode));
    assert.ok(err.some((line) => line.includes('synthetic failure')), `expected the thrown message to be printed, got: ${err.join('\n')}`);
  });

  test('--help does not construct an MCP connection', async () => {
    const ctx = makeFakeCtx();
    const table = buildVerbTable(ctx);
    const { exitCode } = await runDispatch({ table, ctx, argv: fakeArgv(undefined, ['--help']).filter(Boolean) });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(ctx.calls.mcp, 0, '--help must never resolve the MCP connection');
  });

  test('no verb at all (bare invocation) does not construct an MCP connection', async () => {
    const ctx = makeFakeCtx();
    const table = buildVerbTable(ctx);
    const { exitCode } = await runDispatch({ table, ctx, argv: ['node', 'fleet-bridge.mjs'] });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(ctx.calls.mcp, 0);
  });

  test('--version does not construct an MCP connection', async () => {
    const ctx = makeFakeCtx();
    const table = buildVerbTable(ctx);
    const { exitCode, out } = await runDispatch({ table, ctx, argv: ['node', 'fleet-bridge.mjs', '--version'] });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(ctx.calls.mcp, 0);
    assert.ok(out.length > 0);
  });

  test('status does not construct an MCP connection (needsMcp: false)', async () => {
    const ctx = makeFakeCtx();
    const table = buildVerbTable(ctx);
    const { table: spiedTable, calls } = spyOnRuns(table);
    const { exitCode } = await runDispatch({ table: spiedTable, ctx, argv: fakeArgv('status', MIN_ARGS_BY_VERB.status) });
    assert.strictEqual(exitCode, 0);
    assert.ok(calls.status, 'status verb was not dispatched');
    assert.strictEqual(ctx.calls.mcp, 0, 'status must never resolve the MCP connection (it only needs the supervisor HTTP client)');
    assert.strictEqual(table.status.needsMcp, false);
  });

  test('launch and viewer are also marked needsMcp: false (neither needs the fleet MCP connection)', () => {
    const ctx = makeFakeCtx();
    const table = buildVerbTable(ctx);
    assert.strictEqual(table.launch.needsMcp, false);
    assert.strictEqual(table.viewer.needsMcp, false);
  });

  test('every verb needing tracker/member dispatch (preflight, ingest, watch, finalize, daemon) is marked needsMcp: true', () => {
    const ctx = makeFakeCtx();
    const table = buildVerbTable(ctx);
    for (const verb of ['preflight', 'ingest', 'watch', 'finalize', 'daemon']) {
      assert.strictEqual(table[verb].needsMcp, true, `"${verb}" should be needsMcp: true`);
    }
  });
});

// ---------------------------------------------------------------------------
// preflight's buildDeps threads --repo-local-path through to beadsClientFor
// as repoLocalPath (which createRealContext's real beadsClientFor forwards
// on to createBeadsClient({ cwd }) -- see the createRealContext() describe
// block below for that half of the proof). This is the exact call site
// preflight's own live repro hit ("beads-health: bd dolt pull failed: no
// beads database found").
// ---------------------------------------------------------------------------

describe('composition root: repo-local-path reaches beadsClientFor', () => {
  test('preflight buildDeps forwards --repo-local-path as beadsClientFor({ repoLocalPath })', async () => {
    const ctx = makeFakeCtx();
    const table = buildVerbTable(ctx);
    const { table: spiedTable, calls } = spyOnRuns(table);
    const argv = fakeArgv('preflight', ['--repo-local-path', 'C:\\ak\\aztoy']);

    const { exitCode, err } = await runDispatch({ table: spiedTable, ctx, argv });
    assert.strictEqual(exitCode, 0, err.join('\n'));
    assert.ok(calls.preflight, 'preflight run() was never reached');
    assert.ok(ctx.calls.beadsClientFor && ctx.calls.beadsClientFor.length === 1);
    assert.strictEqual(ctx.calls.beadsClientFor[0].repoLocalPath, 'C:\\ak\\aztoy');
  });

  test('ingest buildDeps forwards --repo-local-path as beadsClientFor({ repoLocalPath })', async () => {
    const ctx = makeFakeCtx();
    const table = buildVerbTable(ctx);
    const { table: spiedTable, calls } = spyOnRuns(table);
    const argv = fakeArgv('ingest', ['--refs', 'WI-1,WI-2', '--repo-local-path', 'C:\\ak\\aztoy']);

    const { exitCode, err } = await runDispatch({ table: spiedTable, ctx, argv });
    assert.strictEqual(exitCode, 0, err.join('\n'));
    assert.ok(calls.ingest, 'ingest run() was never reached');
    assert.ok(ctx.calls.beadsClientFor && ctx.calls.beadsClientFor.length === 1);
    assert.strictEqual(ctx.calls.beadsClientFor[0].repoLocalPath, 'C:\\ak\\aztoy');
  });

  test('watch buildDeps prefers the spool handle\'s request.repo.localPath over --repo-local-path', async () => {
    const ctx = makeFakeCtx();
    ctx.spool = async () => ({
      read: async () => ({
        handle: {
          sprintId: 'sprint-1',
          request: {
            platform: 'azure-devops', member: 'fake-member', workItems: ['WI-1'],
            targetBranch: 'feat/x', baseBranch: 'main',
            repo: { localPath: 'C:\\from\\handle' },
          },
        },
      }),
    });
    const table = buildVerbTable(ctx);
    const { table: spiedTable, calls } = spyOnRuns(table);
    const argv = fakeArgv('watch', ['--sprint-id', 'sprint-1', '--repo-local-path', 'C:\\from\\flag']);

    const { exitCode, err } = await runDispatch({ table: spiedTable, ctx, argv });
    assert.strictEqual(exitCode, 0, err.join('\n'));
    assert.ok(calls.watch, 'watch run() was never reached');
    assert.ok(ctx.calls.beadsClientFor && ctx.calls.beadsClientFor.length === 1);
    assert.strictEqual(ctx.calls.beadsClientFor[0].repoLocalPath, 'C:\\from\\handle');
  });
});

// ---------------------------------------------------------------------------
// preflight defaults the resolved PAT secret name into requiredCredentials.
// This is the fix for the vacuous "credentials: ok -- No credential names
// were required for this launch" pass: a real sprint died on its first git
// operation because the wrong PAT was provisioned, and preflight had nothing
// to say about it since nothing populated opts.requiredCredentials unless an
// operator remembered --required-credentials. See preflight.mjs's file
// header for the full incident writeup.
// ---------------------------------------------------------------------------

describe('composition root: preflight defaults the PAT secret name into requiredCredentials', () => {
  test('no CLI flags at all -> requiredCredentials still includes the default secretName', async () => {
    const ctx = makeFakeCtx();
    const table = buildVerbTable(ctx);
    const { table: spiedTable, calls } = spyOnRuns(table);
    const argv = fakeArgv('preflight', []);

    const { exitCode, err } = await runDispatch({ table: spiedTable, ctx, argv });
    assert.strictEqual(exitCode, 0, err.join('\n'));
    assert.ok(calls.preflight, 'preflight run() was never reached');
    assert.deepStrictEqual(calls.preflight.opts.requiredCredentials, ['fleet_bridge_azdevops_pat']);
  });

  test('--required-credentials is ADDITIVE to the default secretName, not a replacement', async () => {
    const ctx = makeFakeCtx();
    const table = buildVerbTable(ctx);
    const { table: spiedTable, calls } = spyOnRuns(table);
    const argv = fakeArgv('preflight', ['--required-credentials', 'other_cred,another_cred']);

    const { exitCode, err } = await runDispatch({ table: spiedTable, ctx, argv });
    assert.strictEqual(exitCode, 0, err.join('\n'));
    assert.deepStrictEqual(
      calls.preflight.opts.requiredCredentials,
      ['fleet_bridge_azdevops_pat', 'other_cred', 'another_cred'],
    );
  });

  test('an explicit --required-credentials entry duplicating the default secretName is not repeated', async () => {
    const ctx = makeFakeCtx();
    const table = buildVerbTable(ctx);
    const { table: spiedTable, calls } = spyOnRuns(table);
    const argv = fakeArgv('preflight', ['--required-credentials', 'fleet_bridge_azdevops_pat,other_cred']);

    const { exitCode, err } = await runDispatch({ table: spiedTable, ctx, argv });
    assert.strictEqual(exitCode, 0, err.join('\n'));
    assert.deepStrictEqual(
      calls.preflight.opts.requiredCredentials,
      ['fleet_bridge_azdevops_pat', 'other_cred'],
    );
  });
});

// ---------------------------------------------------------------------------
// createRealContext() smoke-check -- proves the production factory at least
// constructs without throwing and exposes the shape buildVerbTable expects,
// without ever calling mcp()/supervisorClient() (which would need a live
// fleet server / bd binary).
// ---------------------------------------------------------------------------

describe('createRealContext()', () => {
  test('builds a context exposing every collaborator buildVerbTable reads', () => {
    const ctx = createRealContext({ env: {} });
    for (const key of [
      'clock', 'git', 'fs', 'log', 'readTokenFile', 'configValue', 'supervisorClient',
      'spool', 'jsonlPathFor', 'openAppendStream', 'blobHttp', 'mcp', 'beadsClientFor', 'restClientFor',
      'adapterFor', 'facadeFor', 'isAliveFn', 'createServer',
    ]) {
      assert.ok(key in ctx, `createRealContext() result is missing "${key}"`);
    }
  });

  // beadsClientFor's `repoLocalPath` option is threaded straight through to
  // beads-client.mjs's createBeadsClient({ cwd }) (the fix for "bd dolt pull
  // failed: no beads database found" when the bridge runs from a different
  // directory than the repo under test). Proven here WITHOUT a live `bd`
  // binary or MCP connection: passing `memberName: null` short-circuits
  // memberDialectFor before it ever calls ctx.mcp(), so this reaches
  // createBeadsClient()'s real constructor validation. An invalid
  // repoLocalPath surfacing createBeadsClient's own CONFIG_INVALID/"cwd"
  // error is only possible if beadsClientFor actually forwarded it.
  test('beadsClientFor threads repoLocalPath through to createBeadsClient as cwd', async () => {
    const ctx = createRealContext({ env: {} });

    await assert.rejects(
      () => ctx.beadsClientFor({ memberName: null, callTool: null, repoLocalPath: 42 }),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
        assert.strictEqual(err.details.param, 'cwd');
        return true;
      },
    );

    // A valid repoLocalPath must not throw -- the client is constructed
    // successfully with cwd wired in (no real `bd` invocation happens here).
    const beads = await ctx.beadsClientFor({ memberName: null, callTool: null, repoLocalPath: 'C:\\ak\\aztoy' });
    assert.strictEqual(typeof beads.doltPullProbe, 'function');
  });
});

// ---------------------------------------------------------------------------
// The append-blob sink and the archive exporter are actually WIRED.
//
// WHY THESE TESTS AND NOT MORE SINK UNIT TESTS: ~970 lines of sink and
// archive code shipped with a full unit suite and no call site at all --
// `bin/fleet-bridge.mjs` imported only createJsonlFileSink, and
// buildArchiveBundle was referenced by nothing but its own test. Tests
// passing against unreachable code read as coverage and are not. So every
// assertion below goes through the REAL `buildVerbTable(ctx)` closures from
// bin/fleet-bridge.mjs, exactly like the rest of this file: the only fake
// is the transport underneath.
// ---------------------------------------------------------------------------

/** A fake ctx with blob storage configured the way an operator would configure it. */
function makeBlobCtx() {
  const ctx = makeFakeCtx();
  const realConfigValue = ctx.configValue.bind(ctx);
  ctx.env = { FLEET_BRIDGE_BLOB_SAS: 'sv=2022-11-02&sp=racw&sig=SUPERSECRETSIGNATURE' };
  ctx.configValue = async (spec, flags) => {
    if (spec.name === 'blobAccountUrl') return 'https://fakeacct.blob.core.windows.invalid';
    if (spec.name === 'blobContainer') return 'sprint-logs';
    return realConfigValue(spec, flags);
  };
  ctx.logged = [];
  ctx.log = (msg) => { ctx.logged.push(String(msg)); };
  return ctx;
}

const FAKE_SAS_SIGNATURE = 'SUPERSECRETSIGNATURE';

describe('composition root: the append-blob sink is selectable and actually selected', () => {
  test('watch runs with the local JSONL sink ONLY when no blob destination is configured', async () => {
    const ctx = makeFakeCtx();
    const table = buildVerbTable(ctx);
    const { table: spiedTable, calls } = spyOnRuns(table);

    const { exitCode, err } = await runDispatch({ table: spiedTable, ctx, argv: fakeArgv('watch', ['--sprint-id', 'sprint-1']) });
    assert.strictEqual(exitCode, 0, err.join('\n'));
    assert.deepStrictEqual(calls.watch.deps.sinks.map((e) => e.name), ['jsonl-file']);
  });

  test('watch adds the append-blob sink ALONGSIDE the local one when configured', async () => {
    const ctx = makeBlobCtx();
    const table = buildVerbTable(ctx);
    const { table: spiedTable, calls } = spyOnRuns(table);

    const { exitCode, err } = await runDispatch({ table: spiedTable, ctx, argv: fakeArgv('watch', ['--sprint-id', 'sprint-1']) });
    assert.strictEqual(exitCode, 0, err.join('\n'));

    const names = calls.watch.deps.sinks.map((e) => e.name);
    assert.deepStrictEqual(names, ['jsonl-file', 'append-blob'], 'the blob sink must be ADDED, never substituted for the local mirror');

    const blobEntry = calls.watch.deps.sinks.find((e) => e.name === 'append-blob');
    assert.strictEqual(blobEntry.shared, true, 'the remote sink must be shared:true so watch.mjs\'s single-writer gate can disable it');
    assert.strictEqual(typeof blobEntry.sink.emit, 'function');
    assert.strictEqual(typeof blobEntry.sink.health, 'function');
  });

  test('the wired blob sink really writes through the injected transport, and the SAS never reaches the log', async () => {
    const ctx = makeBlobCtx();
    const table = buildVerbTable(ctx);
    const { table: spiedTable, calls } = spyOnRuns(table);
    await runDispatch({ table: spiedTable, ctx, argv: fakeArgv('watch', ['--sprint-id', 'sprint-1']) });

    const blobEntry = calls.watch.deps.sinks.find((e) => e.name === 'append-blob');
    blobEntry.sink.start();
    blobEntry.sink.emit({ sprintId: 'sprint-1', phase: 'Plan C1 R1' });
    await blobEntry.sink.flushNow();

    const ops = ctx.blobCalls.map((c) => c.op);
    assert.ok(ops.includes('appendBlock'), `expected an appendBlock through the real sink; saw ${JSON.stringify(ops)}`);
    const append = ctx.blobCalls.find((c) => c.op === 'appendBlock');
    assert.strictEqual(append.blobName, 'sprint-1.jsonl');
    assert.strictEqual(append.containerName, 'sprint-logs');
    assert.match(String(append.body), /Plan C1 R1/);

    // The SAS is handed to the transport (it has to be) and to nothing else.
    assert.ok(String(append.sas).includes(FAKE_SAS_SIGNATURE));
    for (const line of ctx.logged) {
      assert.ok(!line.includes(FAKE_SAS_SIGNATURE), `a log line carried the SAS signature: ${line}`);
    }
    assert.ok(!String(append.body).includes(FAKE_SAS_SIGNATURE), 'a SAS reached a record body');

    // The sink owns a periodic flush timer on the injected clock; `watch`
    // stops it in its own `finally`, and a test that constructed one
    // directly has to do the same or the runner never exits.
    await blobEntry.sink.stop();
  });

  test('a half-configured destination is a startup error, not a silent downgrade to local-only', async () => {
    const ctx = makeFakeCtx();
    const realConfigValue = ctx.configValue.bind(ctx);
    ctx.configValue = async (spec, flags) => (spec.name === 'blobAccountUrl'
      ? 'https://fakeacct.blob.core.windows.invalid'
      : realConfigValue(spec, flags));

    const table = buildVerbTable(ctx);
    await assert.rejects(
      () => table.watch.buildDeps({ sprintId: 'sprint-1' }, ctx, new Map()),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
        assert.match(err.message, /half-configured/);
        return true;
      },
    );
  });

  test('a configured destination with no FLEET_BRIDGE_BLOB_SAS fails loudly, naming the env var and never a value', async () => {
    const ctx = makeBlobCtx();
    ctx.env = {};
    const table = buildVerbTable(ctx);
    await assert.rejects(
      () => table.watch.buildDeps({ sprintId: 'sprint-1' }, ctx, new Map()),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
        assert.match(err.message, /FLEET_BRIDGE_BLOB_SAS/);
        assert.strictEqual(err.details.envVar, 'FLEET_BRIDGE_BLOB_SAS');
        return true;
      },
    );
  });

  test('the blob sink resumes from the cursor the spool holds, and never recreates (overwrites) the blob', async () => {
    const ctx = makeBlobCtx();
    const patched = [];
    ctx.spool = async () => ({
      read: async () => ({
        handle: { sprintId: 'sprint-1', request: {}, startedAt: 0 },
        sinkCursors: { appendBlob: { version: 1, sprintId: 'sprint-1', blobName: 'sprint-1.jsonl', partNumber: 1, appendPos: 512, committedBlockCount: 4, parts: [] } },
      }),
      write: async () => {},
      list: async () => [],
      claim: async () => true,
      release: async () => {},
      complete: async () => {},
      fail: async () => {},
      patch: async (sprintId, mutate) => { const draft = {}; mutate(draft); patched.push({ sprintId, draft }); },
    });

    const deps = await buildVerbTable(ctx).watch.buildDeps({ sprintId: 'sprint-1' }, ctx, new Map());
    const blobEntry = deps.sinks.find((e) => e.name === 'append-blob');
    blobEntry.sink.emit({ tick: 1 });
    await blobEntry.sink.flushNow();

    assert.ok(!ctx.blobCalls.some((c) => c.op === 'createAppendBlob'), 'a resumed sink must never re-create the blob -- Azure would overwrite it');
    const append = ctx.blobCalls.find((c) => c.op === 'appendBlock');
    assert.strictEqual(append.appendPos, 512, 'the resumed byte offset must come from the persisted cursor');
    assert.strictEqual(patched.length, 1, 'the cursor must be written back after a flush');
    assert.strictEqual(patched[0].draft.sinkCursors.appendBlob.appendPos, 512 + Buffer.byteLength(append.body, 'utf8'));
    await blobEntry.sink.stop();
  });
});

describe('composition root: the archive exporter is wired into finalize', () => {
  test('finalize gets no archive publisher when no blob destination is configured', async () => {
    const ctx = makeFakeCtx();
    const table = buildVerbTable(ctx);
    const { table: spiedTable, calls } = spyOnRuns(table);
    const { exitCode } = await runDispatch({ table: spiedTable, ctx, argv: fakeArgv('finalize', ['--sprint-id', 'sprint-1']) });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(calls.finalize.deps.archive, null);
  });

  test('finalize gets a working archive publisher when blob storage is configured', async () => {
    const ctx = makeBlobCtx();
    const table = buildVerbTable(ctx);
    const { table: spiedTable, calls } = spyOnRuns(table);
    const { exitCode, err } = await runDispatch({ table: spiedTable, ctx, argv: fakeArgv('finalize', ['--sprint-id', 'sprint-1']) });
    assert.strictEqual(exitCode, 0, err.join('\n'));

    const { archive } = calls.finalize.deps;
    assert.ok(archive && typeof archive.publish === 'function', 'finalize must receive an archive publisher when storage is configured');

    const result = await archive.publish({ sprintId: 'sprint-1', state: { tree: [], extensions: {} } });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    const uploads = ctx.blobCalls.filter((c) => c.op === 'putBlockBlob');
    assert.ok(uploads.some((u) => u.blobName === 'sprints/sprint-1/index.html'), `expected the archive page upload; saw ${uploads.map((u) => u.blobName).join(', ')}`);

    // The URL handed back for a work-item comment must be unsigned.
    assert.ok(!result.indexUrl.includes(FAKE_SAS_SIGNATURE), 'the archive URL must never carry the SAS -- it is pasted into a work item');
    assert.ok(!result.indexUrl.includes('sig='));
  });
});

// ---------------------------------------------------------------------------
// End-to-end binary checks (subprocess) -- mirrors smoke.test.mjs's own
// NODE_TEST_CONTEXT-stripping pattern (see that file for why it is required).
// ---------------------------------------------------------------------------

describe('bin/fleet-bridge.mjs end-to-end', () => {
  function spawnBin(args) {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, [binPath, ...args], { encoding: 'utf8', env });
  }

  test('--help exits 0 and lists all eight verbs', () => {
    const result = spawnBin(['--help']);
    assert.strictEqual(result.status, 0, result.stderr);
    for (const verb of VERBS) {
      assert.match(result.stdout, new RegExp(`\\b${verb}\\b`));
    }
    assert.strictEqual(VERBS.length, 8, 'this task states all eight verbs now exist -- VERBS drifted from that count');
  });

  test('an unknown verb exits 2', () => {
    const result = spawnBin(['definitely-not-a-verb']);
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, /unknown verb/);
  });
});

// ---------------------------------------------------------------------------
// memberDialectFor() must never answer a NAMED member with a POSIX guess.
//
// getSeCommands normalises a null targetOs straight into its POSIX branch
// (packages/apra-fleet-se/fleet-sprint/se-os-commands.mjs), so the old
// `catch { return { targetOs: null, shell: null } }` turned one transient
// member_detail failure into POSIX quoting and {{secret.NAME}} placement
// dispatched at what may well be a PowerShell member -- a mangled command,
// or a mangled credential, reported as success. These two tests pin the
// asymmetry the fix depends on: a NAMED member whose dialect cannot be
// established is fatal; a member-LESS call (local `bd` via execBdSync with a
// cwd, no remote shell anywhere) still legitimately answers nulls.
//
// APRA_FLEET_TRANSPORT=stdio makes the lookup fail deterministically and
// offline: server-resolution.mjs honours the override and returns
// `{mode:'stdio'}`, which mcp() refuses outright (this bridge never
// self-spawns a stdio server), so no network, no live fleet server and no
// dependence on whether one happens to be running on the test machine.
// ---------------------------------------------------------------------------

describe('createRealContext(): member dialect lookup failures are fatal, not a POSIX guess', () => {
  test('a NAMED member whose os/shell cannot be resolved rejects with a BridgeError naming it', async () => {
    const ctx = createRealContext({ env: { APRA_FLEET_TRANSPORT: 'stdio' } });

    await assert.rejects(
      () => ctx.beadsClientFor({ memberName: 'some-windows-member', callTool: null }),
      (err) => {
        assert.ok(err instanceof BridgeError, 'must be a BridgeError, not a raw throw');
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
        assert.match(err.message, /some-windows-member/);
        assert.strictEqual(err.details.memberName, 'some-windows-member');
        return true;
      },
    );
  });

  test('a member-LESS call still returns nulls and builds a local beads client', async () => {
    const ctx = createRealContext({ env: { APRA_FLEET_TRANSPORT: 'stdio' } });
    const beads = await ctx.beadsClientFor({ memberName: null, callTool: null });
    assert.strictEqual(typeof beads.doltPullProbe, 'function');
  });
});
