// Tests for src/cli/flags.mjs -- the per-verb flag declaration, and the proof
// that it equals what each verb actually reads.
//
// WHY THE EQUALITY TEST DRIVES THE REAL COMPOSITION ROOT: a hand-maintained
// list of accepted flags is exactly the kind of document that drifted into
// the broken pipeline template. So instead of trusting VERB_FLAGS, this file
// runs each verb's REAL buildOpts/buildDeps from bin/fleet-bridge.mjs, over a
// context built from the REAL createRealContext() (only network, MCP and bd
// are swapped for fakes -- the config-resolution closures that read
// --supervisor-url / --spool-dir stay real), and records every flag name the
// code asks about. The recorded set must EQUAL the declaration:
//   - a name read but not declared throws FLAG_UNDECLARED (declaredFlagsView);
//   - a name declared but never read fails the equality (a stale entry).
// For `daemon`, whose watch/finalize collaborators are only built per sprint,
// the bound runWatch/runFinalize closures are invoked too, so their reads
// count.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync as spawnSyncRaw } from 'node:child_process';

import {
  VERB_FLAGS, GLOBAL_FLAGS, assertKnownFlags, declaredFlagsView, suggestFlag,
} from '../src/cli/flags.mjs';
import { VERBS } from '../src/cli/args.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';
import { buildVerbTable, createRealContext } from '../bin/fleet-bridge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binPath = path.join(__dirname, '..', 'bin', 'fleet-bridge.mjs');

function usageError(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof BridgeError, `expected a BridgeError, got ${err}`);
    assert.strictEqual(err.code, BRIDGE_ERROR_CODES.USAGE);
    return err;
  }
  assert.fail('expected assertKnownFlags to throw');
}

describe('VERB_FLAGS shape', () => {
  test('declares every verb in VERBS, and nothing else', () => {
    assert.deepStrictEqual(Object.keys(VERB_FLAGS).sort(), [...VERBS].sort());
  });

  test('no verb re-declares a global flag', () => {
    for (const [verb, names] of Object.entries(VERB_FLAGS)) {
      for (const g of GLOBAL_FLAGS) assert.ok(!names.includes(g), `${verb} declares global --${g}`);
    }
  });
});

describe('assertKnownFlags', () => {
  test('an unknown flag is a USAGE error naming it and listing what the verb accepts', () => {
    const err = usageError(() => assertKnownFlags('status', new Map([['sprint-id', 'x'], ['this-flag-does-not-exist', 'yes']])));
    assert.match(err.message, /unknown flag --this-flag-does-not-exist/);
    assert.match(err.message, /status accepts: .*--sprint-id/);
  });

  test('--work-items on ingest points at --refs', () => {
    const err = usageError(() => assertKnownFlags('ingest', new Map([['work-items', '9,10']])));
    assert.match(err.message, /--work-items \(did you mean --refs\?/);
  });

  test('--ado-pat-secret-name points at --secret-name; --adoOrgUrl at --ado-org-url', () => {
    assert.match(suggestFlag('ingest', 'ado-pat-secret-name'), /--secret-name/);
    assert.match(suggestFlag('watch', 'adoOrgUrl'), /--ado-org-url/);
  });

  test('a SprintRequest field passed to launch as a flag says where it belongs', () => {
    const err = usageError(() => assertKnownFlags('launch', new Map([['target-branch', 'feat/x'], ['max-cycles', '3']])));
    assert.match(err.message, /"targetBranch" as a SprintRequest field inside --request-file/);
    assert.match(err.message, /"maxCycles" as a SprintRequest field/);
  });

  test('a near-miss typo gets an edit-distance suggestion', () => {
    assert.match(suggestFlag('status', 'sprint-di'), /--sprint-id/);
  });

  test('global flags are accepted by every verb', () => {
    for (const verb of VERBS) {
      assert.doesNotThrow(() => assertKnownFlags(verb, new Map([['help', true], ['version', true]])));
    }
  });

  test('a boolean flag given a value is rejected (it used to read as "not set": --dry-run yes published for real)', () => {
    const err = usageError(() => assertKnownFlags('finalize', new Map([['sprint-id', 's'], ['dry-run', 'yes']])));
    assert.match(err.message, /--dry-run is a boolean flag/);
  });

  test("'true'/'false' on a boolean flag normalize to real booleans", () => {
    const out = assertKnownFlags('finalize', new Map([['sprint-id', 's'], ['dry-run', 'true']]));
    assert.strictEqual(out.get('dry-run'), true);
  });

  test('a value flag with no value is rejected', () => {
    const err = usageError(() => assertKnownFlags('ingest', new Map([['refs', true]])));
    assert.match(err.message, /--refs requires a value/);
  });

  test('a stray positional is rejected (no verb takes any)', () => {
    const err = usageError(() => assertKnownFlags('ingest', new Map([['refs', '9']]), ['10']));
    assert.match(err.message, /unexpected argument\(s\) "10"/);
  });
});

describe('declaredFlagsView', () => {
  test('reading an undeclared flag is FLAG_UNDECLARED (exit 9), not a silent undefined', () => {
    const view = declaredFlagsView('status', new Map());
    assert.throws(() => view.get('member'), (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.FLAG_UNDECLARED);
    assert.throws(() => view.has('member'), (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.FLAG_UNDECLARED);
    assert.strictEqual(view.get('sprint-id'), undefined);
  });
});

describe('the real binary rejects unknown flags', () => {
  // NODE_TEST_CONTEXT must be stripped or the binary's self-execution guard
  // treats the child as an import and exits 0 without running (smoke.test.mjs).
  function spawnSync(cmd, args, opts) {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return spawnSyncRaw(cmd, args, { ...opts, env });
  }
  test('status --this-flag-does-not-exist exits 2 and names the flag (it used to exit 0)', () => {
    const r = spawnSync(process.execPath, [binPath, 'status', '--sprint-id', 'x', '--this-flag-does-not-exist', 'yes'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /unknown flag --this-flag-does-not-exist/);
  });

  test('ingest --work-items exits 2 and suggests --refs', () => {
    const r = spawnSync(process.execPath, [binPath, 'ingest', '--work-items', '9,10'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /did you mean --refs/);
  });

  test('--help still works on every verb', () => {
    for (const verb of VERBS) {
      const r = spawnSync(process.execPath, [binPath, verb, '--help'], { encoding: 'utf8' });
      assert.strictEqual(r.status, 0, `${verb} --help: ${r.stderr}`);
    }
  });
});

// ---------------------------------------------------------------------------
// The equality proof.
// ---------------------------------------------------------------------------

function makeRecordingCtx() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'fb-flags-'));
  const real = createRealContext({ env: { APRA_FLEET_DATA_DIR: dataDir } });

  const fakeSupervisor = {
    getHealth: async () => ({ status: 'ok', seams: {} }),
    getMembers: async () => ({ members: [] }),
    getSprint: async () => null,
    postSprint: async () => ({ sprintId: 's1', pid: 1, port: 1 }),
    getLog: async () => null,
    listSprints: async () => ({}),
  };
  const state = { doc: undefined };
  const fakeSpool = {
    write: async (h) => h,
    read: async () => state.doc,
    list: async () => [],
    claim: async () => true,
    release: async () => {},
    complete: async () => {},
    fail: async () => {},
    patch: async () => {},
  };
  const fakeBeads = {
    create: async () => ({ id: 'b' }), setParent: async () => {}, list: async () => [], show: async () => ({}),
    update: async () => ({}), doltPullProbe: async () => ({ ok: true }),
  };

  const ctx = {
    ...real,
    // Keep the REAL config-resolving factories (they are what read
    // --supervisor-url / --spool-dir), but hand back fakes afterwards.
    supervisorClient: async (flags) => { await real.supervisorClient(flags); return fakeSupervisor; },
    spool: async (flags) => { await real.spool(flags); return fakeSpool; },
    openAppendStream: () => ({ write() {}, end(cb) { if (cb) cb(); } }),
    mcp: async () => ({
      fleetApi: { credentialStoreList: async () => '[]', memberDetail: async () => '{}' },
      callTool: async () => ({}),
      mcpClient: {},
    }),
    memberDialectFor: async () => ({ targetOs: null, shell: null }),
    beadsClientFor: async () => fakeBeads,
    restClientFor: async () => async () => ({ status: 200, body: '{}' }),
  };
  return { ctx, state, dataDir };
}

async function recordReads(verb, flagEntries, { doc, afterDeps } = {}) {
  const { ctx, state, dataDir } = makeRecordingCtx();
  state.doc = doc;
  const read = new Set();
  const flags = declaredFlagsView(verb, new Map(flagEntries), { onRead: (n) => read.add(n) });
  const entry = buildVerbTable(ctx)[verb];
  const opts = await entry.buildOpts(flags, [], ctx);
  const deps = await entry.buildDeps(opts, ctx, flags);
  if (afterDeps) await afterDeps(deps, { dataDir });
  return read;
}

const handleWithoutFallbacks = {
  sprintId: 's1',
  request: { workItems: ['9'] },
  startedAt: 0,
};

describe('VERB_FLAGS equals what each verb reads', () => {
  const scenarios = {
    preflight: { flags: [] },
    ingest: { flags: [['refs', '9'], ['member', 'm']] },
    launch: {
      flags: () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'fb-req-'));
        const file = path.join(dir, 'request.json');
        writeFileSync(file, JSON.stringify({ platform: 'azure-devops', member: 'm', workItems: ['9'] }));
        return [['request-file', file]];
      },
    },
    // No spool handle: the member/platform fallbacks are consulted.
    watch: { flags: [['sprint-id', 's1'], ['member', 'm']] },
    // A handle with no member/platform/repo: every fallback is consulted.
    finalize: { flags: [['sprint-id', 's1'], ['member', 'm']], doc: { handle: handleWithoutFallbacks } },
    status: { flags: [['sprint-id', 's1']] },
    daemon: {
      flags: [],
      async afterDeps(deps) {
        // A launch-written handle always carries member/platform; repo is optional.
        const handle = { sprintId: 's1', request: { platform: 'azure-devops', member: 'm', workItems: ['9'] }, startedAt: 0 };
        const aborted = new AbortController();
        aborted.abort();
        const swallowUnlessUndeclared = (err) => {
          if (err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.FLAG_UNDECLARED) throw err;
        };
        await deps.runWatch(handle, aborted.signal).catch(swallowUnlessUndeclared);
        await deps.runFinalize(handle).catch(swallowUnlessUndeclared);
      },
    },
    viewer: { flags: [] },
  };

  test('every verb has a scenario', () => {
    assert.deepStrictEqual(Object.keys(scenarios).sort(), [...VERBS].sort());
  });

  for (const [verb, sc] of Object.entries(scenarios)) {
    test(`${verb}: declared flags == flags read by bin/fleet-bridge.mjs`, async () => {
      const flagEntries = typeof sc.flags === 'function' ? sc.flags() : sc.flags;
      const read = await recordReads(verb, flagEntries, { doc: sc.doc, afterDeps: sc.afterDeps });
      assert.deepStrictEqual(
        [...read].sort(),
        [...VERB_FLAGS[verb]].sort(),
        `VERB_FLAGS.${verb} (src/cli/flags.mjs) is out of sync with what ${verb} reads`,
      );
    });
  }
});
