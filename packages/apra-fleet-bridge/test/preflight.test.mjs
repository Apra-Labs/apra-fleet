// Tests for src/verbs/preflight.mjs -- see that file's header for the
// throw-vs-report rule and the injected-I/O contract this suite pins down.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { runPreflight, PREFLIGHT_CHECK_IDS } from '../src/verbs/preflight.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREFLIGHT_SOURCE_PATH = path.join(__dirname, '..', 'src', 'verbs', 'preflight.mjs');

// -- fixtures ----------------------------------------------------------------

const MEMBER_NAME = 'member-a';
const REPO_PATH = path.join('C:', 'repo', 'local', 'path');
const BASE_BRANCH = 'main';
const REMOTE_URL = 'https://github.com/acme/widgets.git';
const REQUIRED_CREDS = ['azdevops_pat'];

function makeHealth(overrides = {}) {
  return {
    status: 'ok',
    uptimeSeconds: 42,
    pid: 999,
    seams: { ledger: 'wired', spawner: 'wired', watchdog: 'wired', dashboard: 'wired' },
    ...overrides,
  };
}

function makeMembers(list) {
  return { members: list };
}

/** Mirrors the raw MCP callTool() shape parseToolJson() expects:
 *  `{ content: [{ type: 'text', text }] }`. `extraFields` lets a test attach
 *  fields beyond `name` (e.g. a bogus `value`) to prove they are never read. */
function makeCredentialListResult(names, extraFields = {}) {
  return {
    content: [
      { type: 'text', text: JSON.stringify(names.map((name) => ({ name, scope: 'user', ...extraFields }))) },
    ],
  };
}

/** Same raw MCP callTool() shape, for `member_detail({ format: 'json' })`. */
function makeMemberDetailResult(fields) {
  return {
    content: [
      { type: 'text', text: JSON.stringify(fields) },
    ],
  };
}

/** A fresh happy-path opts object -- every check should pass against this. */
function makeHappyOpts() {
  return {
    member: MEMBER_NAME,
    repo: { remoteUrl: REMOTE_URL, localPath: REPO_PATH },
    baseBranch: BASE_BRANCH,
    requiredCredentials: [...REQUIRED_CREDS],
    playbooksDir: REPO_PATH,
    spawn: 'supervisor',
  };
}

/** A fresh happy-path deps object, with a `calls` counter so tests can assert
 *  which collaborators were (or were NOT) invoked. Every collaborator is a
 *  fake -- no real fs, git, fetch, or bd anywhere in this suite. */
function makeHappyDeps() {
  const calls = {
    getHealth: 0, getMembers: 0, credentialStoreList: 0, doltPullProbe: 0, memberDetail: 0, doltRemoteList: 0,
  };
  const logLines = [];

  const knownPaths = new Set([
    REPO_PATH,
    path.join(REPO_PATH, 'deploy.md'),
    path.join(REPO_PATH, 'integ-test-playbook.md'),
  ]);

  return {
    calls,
    logLines,
    supervisorClient: {
      async getHealth() {
        calls.getHealth += 1;
        return makeHealth();
      },
      async getMembers() {
        calls.getMembers += 1;
        // Deliberately carries NO vcsProvider field, matching the real
        // GET /api/members response -- member-vcs-provider must never read
        // this record (see the defect this fixes).
        return makeMembers([{ name: MEMBER_NAME, reserved: false }]);
      },
    },
    beads: {
      async doltPullProbe() {
        calls.doltPullProbe += 1;
        return { ok: true, stdout: '', stderr: '' };
      },
      async doltRemoteList() {
        calls.doltRemoteList += 1;
        return [];
      },
    },
    fleetApi: {
      async credentialStoreList() {
        calls.credentialStoreList += 1;
        return makeCredentialListResult(REQUIRED_CREDS);
      },
      async memberDetail({ member_name, format }) {
        calls.memberDetail += 1;
        assert.strictEqual(member_name, MEMBER_NAME);
        assert.strictEqual(format, 'json');
        return makeMemberDetailResult({ name: MEMBER_NAME, vcsProvider: 'github' });
      },
    },
    git: {
      async resolveRef(ref, opts) {
        if (ref === BASE_BRANCH && opts && opts.cwd === REPO_PATH) return 'deadbeef';
        const err = new Error(`unknown ref "${ref}" in "${opts && opts.cwd}"`);
        throw err;
      },
    },
    fs: {
      async stat(p) {
        if (knownPaths.has(p)) return { isDirectory: () => true, isFile: () => true };
        const err = new Error(`ENOENT: no such file or directory, stat '${p}'`);
        err.code = 'ENOENT';
        throw err;
      },
    },
    adapter: { name: 'azure-devops' },
    log(msg) {
      logLines.push(msg);
    },
  };
}

function checkById(result, id) {
  const found = result.checks.find((c) => c.id === id);
  assert.ok(found, `expected a check with id "${id}"`);
  return found;
}

// -- happy path ----------------------------------------------------------------

describe('runPreflight: happy path', () => {
  test('every check passes -> ok:true, no warnings, all 9 check ids present in order', async () => {
    const result = await runPreflight(makeHappyOpts(), makeHappyDeps());

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.warnings, []);
    assert.deepStrictEqual(result.checks.map((c) => c.id), [...PREFLIGHT_CHECK_IDS]);
    for (const c of result.checks) {
      assert.strictEqual(c.ok, true, `expected check "${c.id}" to pass: ${c.message}`);
      assert.ok(typeof c.remedy === 'string' && c.remedy.length > 0, `check "${c.id}" must carry a remedy string`);
      assert.ok(c.level === 'fail' || c.level === 'warn');
    }
  });

  test('every check id carries its own distinct, non-empty remedy', async () => {
    const result = await runPreflight(makeHappyOpts(), makeHappyDeps());
    const remedies = result.checks.map((c) => c.remedy);
    assert.strictEqual(new Set(remedies).size, remedies.length, 'remedies must all be distinct');
    for (const r of remedies) assert.ok(r.length > 0);
  });
});

// -- supervisor unreachable: the one throw-worthy case ------------------------

describe('runPreflight: supervisor unreachable', () => {
  test('getHealth() rejecting throws BridgeError(PREFLIGHT_UNAVAILABLE), and no other check runs', async () => {
    const deps = makeHappyDeps();
    deps.supervisorClient.getHealth = async () => {
      deps.calls.getHealth += 1;
      throw new Error('ECONNREFUSED 127.0.0.1:8787');
    };

    await assert.rejects(
      () => runPreflight(makeHappyOpts(), deps),
      (err) => {
        assert.ok(err instanceof BridgeError, 'expected a BridgeError');
        assert.strictEqual(err.code, BRIDGE_ERROR_CODES.PREFLIGHT_UNAVAILABLE);
        assert.match(err.message, /ECONNREFUSED/);
        return true;
      }
    );

    assert.strictEqual(deps.calls.getHealth, 1);
    // The whole point: connectivity failure makes every OTHER check
    // meaningless too, so none of them ran.
    assert.strictEqual(deps.calls.getMembers, 0);
    assert.strictEqual(deps.calls.credentialStoreList, 0);
    assert.strictEqual(deps.calls.doltPullProbe, 0);
  });

  test('a plain rejection (non-BridgeError) is still wrapped as PREFLIGHT_UNAVAILABLE', async () => {
    const deps = makeHappyDeps();
    deps.supervisorClient.getHealth = async () => { throw new TypeError('fetch failed'); };

    await assert.rejects(
      () => runPreflight(makeHappyOpts(), deps),
      (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.PREFLIGHT_UNAVAILABLE
    );
  });

  test('missing deps.supervisorClient -> CONFIG_MISSING (never a raw TypeError)', async () => {
    await assert.rejects(
      () => runPreflight(makeHappyOpts(), {}),
      (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.CONFIG_MISSING
    );
  });
});

// -- each check, broken in isolation ------------------------------------------
//
// For every scenario: exactly ONE check must fail (or warn), every OTHER
// check must still run and pass -- proving "run every check; never
// short-circuit" -- and the overall `ok` must reflect fail-vs-warn severity
// correctly (a warn-only failure keeps `ok:true`).

const SCENARIOS = [
  {
    id: 'supervisor-health',
    expectOverallOk: false,
    apply(opts, deps) {
      deps.supervisorClient.getHealth = async () => makeHealth({
        seams: { ledger: 'wired', spawner: 'spawner:stub', watchdog: 'wired', dashboard: 'wired' },
      });
    },
  },
  {
    id: 'member-free',
    expectOverallOk: false,
    apply(opts, deps) {
      deps.supervisorClient.getMembers = async () => makeMembers([
        { name: MEMBER_NAME, reserved: true, reservedBy: 'some-other-sprint', vcsProvider: 'github' },
      ]);
    },
  },
  {
    id: 'member-vcs-provider',
    expectOverallOk: false,
    apply(opts, deps) {
      deps.fleetApi.memberDetail = async () => makeMemberDetailResult({ name: MEMBER_NAME });
    },
  },
  {
    id: 'credentials',
    expectOverallOk: false,
    apply(opts, deps) {
      deps.fleetApi.credentialStoreList = async () => makeCredentialListResult([]);
    },
  },
  {
    id: 'repo-and-base',
    expectOverallOk: false,
    apply(opts) {
      opts.baseBranch = 'no-such-branch';
    },
  },
  {
    id: 'beads-health',
    expectOverallOk: false,
    apply(opts, deps) {
      // A remote IS configured (non-empty doltRemoteList) but the pull
      // itself failed -- this must stay a hard `fail`, unlike the "no
      // remote configured" case (covered in its own describe block below).
      deps.beads.doltRemoteList = async () => [{ name: 'origin', url: 'https://example.invalid/beads.git' }];
      deps.beads.doltPullProbe = async () => { throw new Error('dolt remote unreachable'); };
    },
  },
  {
    id: 'pr-capability',
    expectOverallOk: true, // warn, not fail
    apply(opts) {
      opts.repo = { ...opts.repo, remoteUrl: undefined };
    },
  },
  {
    id: 'playbooks',
    expectOverallOk: true, // warn, not fail
    apply(opts) {
      opts.playbooksDir = path.join('C:', 'nowhere');
    },
  },
  {
    id: 'spawn-direct-warning',
    expectOverallOk: true, // warn, not fail
    apply(opts) {
      opts.spawn = 'direct';
    },
  },
];

describe('runPreflight: each check fails in isolation', () => {
  const remediesById = new Map();

  for (const scenario of SCENARIOS) {
    test(`breaking only "${scenario.id}" fails/warns just that check; every other check still runs and passes`, async () => {
      const opts = makeHappyOpts();
      const deps = makeHappyDeps();
      scenario.apply(opts, deps);

      const result = await runPreflight(opts, deps);

      // All 9 check ids ran, in the documented order -- never short-circuited.
      assert.deepStrictEqual(result.checks.map((c) => c.id), [...PREFLIGHT_CHECK_IDS]);

      const broken = checkById(result, scenario.id);
      assert.strictEqual(broken.ok, false, `expected "${scenario.id}" to fail/warn: got ok:true`);
      remediesById.set(scenario.id, broken.remedy);

      for (const c of result.checks) {
        if (c.id === scenario.id) continue;
        assert.strictEqual(c.ok, true, `expected unrelated check "${c.id}" to still pass: ${c.message}`);
      }

      assert.strictEqual(result.ok, scenario.expectOverallOk, `overall ok mismatch for scenario "${scenario.id}"`);
      if (broken.level === 'warn') {
        assert.ok(result.warnings.includes(broken.message));
      }
    });
  }

  test('after running every scenario above, all 9 remedies collected were mutually distinct', () => {
    // Populated by the loop above (node:test runs tests in a describe block
    // in declaration order), one entry per scenario/check id.
    assert.strictEqual(remediesById.size, SCENARIOS.length);
    const remedies = [...remediesById.values()];
    assert.strictEqual(new Set(remedies).size, remedies.length);
  });
});

describe('runPreflight: pr-capability is a warning, never a failure', () => {
  test('an unrecognized/missing remote does not flip overall ok to false', async () => {
    const opts = makeHappyOpts();
    opts.repo = { ...opts.repo, remoteUrl: undefined };
    const result = await runPreflight(opts, makeHappyDeps());

    const prCheck = checkById(result, 'pr-capability');
    assert.strictEqual(prCheck.level, 'warn');
    assert.strictEqual(prCheck.ok, false);
    assert.strictEqual(result.ok, true, 'a warn-level failure must not fail the whole preflight');
    assert.ok(result.warnings.some((w) => w === prCheck.message));
  });

  test('a host with no PR support (e.g. a bare local path) also just warns', async () => {
    const opts = makeHappyOpts();
    opts.repo = { ...opts.repo, remoteUrl: 'file:///C:/some/bare/repo.git' };
    const result = await runPreflight(opts, makeHappyDeps());

    const prCheck = checkById(result, 'pr-capability');
    assert.strictEqual(prCheck.ok, false);
    assert.strictEqual(prCheck.level, 'warn');
    assert.strictEqual(result.ok, true);
  });
});

describe('runPreflight: --spawn direct', () => {
  test('emits the spawn-direct-warning without failing the run', async () => {
    const opts = makeHappyOpts();
    opts.spawn = 'direct';
    const result = await runPreflight(opts, makeHappyDeps());

    const spawnCheck = checkById(result, 'spawn-direct-warning');
    assert.strictEqual(spawnCheck.level, 'warn');
    assert.strictEqual(spawnCheck.ok, false);
    assert.match(spawnCheck.message, /--spawn direct/);
    assert.strictEqual(result.ok, true);
  });

  test('any other (or absent) spawn mode does not warn', async () => {
    const opts = makeHappyOpts();
    delete opts.spawn;
    const result = await runPreflight(opts, makeHappyDeps());

    const spawnCheck = checkById(result, 'spawn-direct-warning');
    assert.strictEqual(spawnCheck.ok, true);
  });
});

// -- member-vcs-provider: sourced from member_detail, never GET /api/members -

describe('runPreflight: member-vcs-provider', () => {
  test('vcsProvider present via member_detail -> ok, and GET /api/members is never consulted for it', async () => {
    const opts = makeHappyOpts();
    const deps = makeHappyDeps();
    const result = await runPreflight(opts, deps);

    const vcsCheck = checkById(result, 'member-vcs-provider');
    assert.strictEqual(vcsCheck.ok, true);
    assert.match(vcsCheck.message, /"github"/);
    assert.strictEqual(deps.calls.memberDetail, 1);
  });

  test('vcsProvider absent from member_detail -> fail', async () => {
    const opts = makeHappyOpts();
    const deps = makeHappyDeps();
    deps.fleetApi.memberDetail = async () => makeMemberDetailResult({ name: MEMBER_NAME });

    const result = await runPreflight(opts, deps);
    const vcsCheck = checkById(result, 'member-vcs-provider');
    assert.strictEqual(vcsCheck.ok, false);
    assert.match(vcsCheck.message, /no registered vcsProvider/);
  });

  test('no fleetApi.memberDetail collaborator injected -> fail with a clear "not injected" message, never a throw', async () => {
    const opts = makeHappyOpts();
    const deps = makeHappyDeps();
    delete deps.fleetApi.memberDetail;

    const result = await runPreflight(opts, deps);
    const vcsCheck = checkById(result, 'member-vcs-provider');
    assert.strictEqual(vcsCheck.ok, false);
    assert.match(vcsCheck.message, /No fleetApi\.memberDetail collaborator was injected/);
  });

  test('the member_detail lookup throwing is reported as this check failing, never propagated', async () => {
    const opts = makeHappyOpts();
    const deps = makeHappyDeps();
    deps.fleetApi.memberDetail = async () => { throw new Error('ECONNRESET talking to the fleet MCP server'); };

    const result = await runPreflight(opts, deps);
    const vcsCheck = checkById(result, 'member-vcs-provider');
    assert.strictEqual(vcsCheck.ok, false);
    assert.match(vcsCheck.message, /ECONNRESET/);
    // Every other check still ran -- the no-throw rule holds.
    assert.deepStrictEqual(result.checks.map((c) => c.id), [...PREFLIGHT_CHECK_IDS]);
  });
});

// -- credentials: names only, never a value -----------------------------------

describe('runPreflight: credentials check never reads or logs a value', () => {
  const SECRET_MARKER = 'super-secret-token-should-never-appear-anywhere';

  test('a credential-store entry carrying a bogus value field never surfaces that value', async () => {
    const opts = makeHappyOpts();
    const deps = makeHappyDeps();
    deps.fleetApi.credentialStoreList = async () => makeCredentialListResult(REQUIRED_CREDS, { value: SECRET_MARKER, secret: SECRET_MARKER });

    const result = await runPreflight(opts, deps);

    const credCheck = checkById(result, 'credentials');
    assert.strictEqual(credCheck.ok, true, 'the name was present, so the check must still pass');

    const everyMessageAndRemedy = result.checks.flatMap((c) => [c.message, c.remedy]);
    for (const text of everyMessageAndRemedy) {
      assert.ok(!text.includes(SECRET_MARKER), `secret marker leaked into: ${text}`);
    }
    for (const line of deps.logLines) {
      assert.ok(!line.includes(SECRET_MARKER), `secret marker leaked into a log line: ${line}`);
    }
  });

  test('a missing required credential name fails the check, naming only the NAME, never a value', async () => {
    const opts = makeHappyOpts();
    opts.requiredCredentials = ['azdevops_pat', 'missing_cred_name'];
    const deps = makeHappyDeps();
    deps.fleetApi.credentialStoreList = async () => makeCredentialListResult(['azdevops_pat']);

    const result = await runPreflight(opts, deps);
    const credCheck = checkById(result, 'credentials');
    assert.strictEqual(credCheck.ok, false);
    assert.match(credCheck.message, /missing_cred_name/);
  });

  test('no required credentials -> the check trivially passes without calling the store', async () => {
    const opts = makeHappyOpts();
    opts.requiredCredentials = [];
    const deps = makeHappyDeps();
    const result = await runPreflight(opts, deps);

    assert.strictEqual(checkById(result, 'credentials').ok, true);
    assert.strictEqual(deps.calls.credentialStoreList, 0);
  });

  test('all required names present -> the success message names every one of them, not just a count', async () => {
    const opts = makeHappyOpts();
    opts.requiredCredentials = ['fleet_bridge_azdevops_pat', 'some_other_cred'];
    const deps = makeHappyDeps();
    deps.fleetApi.credentialStoreList = async () => makeCredentialListResult(['fleet_bridge_azdevops_pat', 'some_other_cred']);

    const result = await runPreflight(opts, deps);
    const credCheck = checkById(result, 'credentials');
    assert.strictEqual(credCheck.ok, true);
    assert.match(credCheck.message, /fleet_bridge_azdevops_pat/);
    assert.match(credCheck.message, /some_other_cred/);
  });

  test('a missing required credential fails with a remedy naming apra-fleet secret --set, never a value', async () => {
    const opts = makeHappyOpts();
    opts.requiredCredentials = ['fleet_bridge_azdevops_pat'];
    const deps = makeHappyDeps();
    deps.fleetApi.credentialStoreList = async () => makeCredentialListResult([]);

    const result = await runPreflight(opts, deps);
    const credCheck = checkById(result, 'credentials');
    assert.strictEqual(credCheck.ok, false);
    assert.match(credCheck.message, /fleet_bridge_azdevops_pat/);
    assert.match(credCheck.remedy, /apra-fleet secret --set <name> --persist/);
  });

  test('credentialStoreList() throwing is reported as this check failing, never propagated -- every other check still runs', async () => {
    const opts = makeHappyOpts();
    const deps = makeHappyDeps();
    deps.fleetApi.credentialStoreList = async () => { throw new Error('ECONNRESET talking to the fleet MCP server'); };

    const result = await runPreflight(opts, deps);
    const credCheck = checkById(result, 'credentials');
    assert.strictEqual(credCheck.ok, false);
    assert.match(credCheck.message, /ECONNRESET/);
    assert.deepStrictEqual(result.checks.map((c) => c.id), [...PREFLIGHT_CHECK_IDS]);
    for (const c of result.checks) {
      if (c.id === 'credentials') continue;
      assert.strictEqual(c.ok, true, `expected unrelated check "${c.id}" to still pass: ${c.message}`);
    }
  });
});

// -- beads-health: consumes doltPullProbe()'s unpinned contract as-is --------
//
// A `bd dolt pull` failure is a hard `fail` ONLY when a dolt remote is
// actually configured (doltRemoteList() returns a non-empty list below);
// when none is configured (the default in makeHappyDeps -- doltRemoteList()
// resolves `[]`), the same failure is a `warn` -- see the dedicated
// "no dolt remote configured" describe block further down.

describe('runPreflight: beads-health', () => {
  test('doltPullProbe() resolving {ok:false} (no throw), WITH a remote configured, is a failed check, not a crash', async () => {
    const opts = makeHappyOpts();
    const deps = makeHappyDeps();
    deps.beads.doltRemoteList = async () => [{ name: 'origin', url: 'https://example.invalid/beads.git' }];
    deps.beads.doltPullProbe = async () => ({ ok: false, stdout: '', stderr: 'divergent history' });

    const result = await runPreflight(opts, deps);
    const beadsCheck = checkById(result, 'beads-health');
    assert.strictEqual(beadsCheck.ok, false);
    assert.strictEqual(beadsCheck.level, 'fail');
    assert.strictEqual(result.ok, false);
  });

  test('doltPullProbe() throwing, WITH a remote configured, is caught, reported as a fail, never propagated', async () => {
    const opts = makeHappyOpts();
    const deps = makeHappyDeps();
    deps.beads.doltRemoteList = async () => [{ name: 'origin', url: 'https://example.invalid/beads.git' }];
    deps.beads.doltPullProbe = async () => { throw new Error("[beads-client] 'bd dolt pull' failed: exit 1"); };

    const result = await runPreflight(opts, deps);
    const beadsCheck = checkById(result, 'beads-health');
    assert.strictEqual(beadsCheck.ok, false);
    assert.strictEqual(beadsCheck.level, 'fail');
    assert.strictEqual(result.ok, false);
    assert.match(beadsCheck.message, /dolt pull/);
  });

  test('doltPullProbe() succeeding is ok:true regardless of remote configuration (doltRemoteList is never even consulted)', async () => {
    const opts = makeHappyOpts();
    const deps = makeHappyDeps();
    const result = await runPreflight(opts, deps);
    const beadsCheck = checkById(result, 'beads-health');
    assert.strictEqual(beadsCheck.ok, true);
    assert.strictEqual(deps.calls.doltRemoteList, 0);
  });
});

// -- beads-health: no dolt remote configured is a WARN, not a FAIL -----------

describe('runPreflight: beads-health -- no dolt remote configured', () => {
  test('bd dolt pull failing with no remote configured (doltRemoteList -> []) is a warn, and overall ok stays true', async () => {
    const opts = makeHappyOpts();
    const deps = makeHappyDeps();
    // makeHappyDeps' default doltRemoteList already resolves `[]`.
    deps.beads.doltPullProbe = async () => { throw new Error('fetch from origin/main: Error 1105: no remote'); };

    const result = await runPreflight(opts, deps);
    const beadsCheck = checkById(result, 'beads-health');
    assert.strictEqual(beadsCheck.ok, false);
    assert.strictEqual(beadsCheck.level, 'warn');
    assert.strictEqual(result.ok, true, 'a no-remote-configured beads-health warning must not fail the whole preflight');
    assert.ok(result.warnings.includes(beadsCheck.message));
    assert.match(beadsCheck.message, /single runner/);
  });

  test('a remote IS configured (doltRemoteList -> non-empty) keeps the same pull failure a hard fail', async () => {
    const opts = makeHappyOpts();
    const deps = makeHappyDeps();
    deps.beads.doltRemoteList = async () => [{ name: 'origin', url: 'https://example.invalid/beads.git' }];
    deps.beads.doltPullProbe = async () => { throw new Error('fetch from origin/main: Error 1105: no remote'); };

    const result = await runPreflight(opts, deps);
    const beadsCheck = checkById(result, 'beads-health');
    assert.strictEqual(beadsCheck.level, 'fail');
    assert.strictEqual(result.ok, false);
  });

  test('doltRemoteList() itself throwing falls back to the conservative fail (cannot determine remote config either way)', async () => {
    const opts = makeHappyOpts();
    const deps = makeHappyDeps();
    deps.beads.doltRemoteList = async () => { throw new Error('bd dolt remote list failed: exit 1'); };
    deps.beads.doltPullProbe = async () => { throw new Error('some pull failure'); };

    const result = await runPreflight(opts, deps);
    const beadsCheck = checkById(result, 'beads-health');
    assert.strictEqual(beadsCheck.level, 'fail');
    assert.strictEqual(beadsCheck.ok, false);
    assert.strictEqual(result.ok, false);
    assert.match(beadsCheck.message, /some pull failure/);
  });

  test('no doltRemoteList collaborator injected falls back to the conservative fail', async () => {
    const opts = makeHappyOpts();
    const deps = makeHappyDeps();
    delete deps.beads.doltRemoteList;
    deps.beads.doltPullProbe = async () => { throw new Error('some pull failure'); };

    const result = await runPreflight(opts, deps);
    const beadsCheck = checkById(result, 'beads-health');
    assert.strictEqual(beadsCheck.level, 'fail');
    assert.strictEqual(result.ok, false);
  });
});

// -- repo-and-base -------------------------------------------------------------

describe('runPreflight: repo-and-base', () => {
  test('a repo path that does not exist fails even when the base branch would resolve', async () => {
    const opts = makeHappyOpts();
    opts.repo = { ...opts.repo, localPath: path.join('C:', 'does', 'not', 'exist') };
    const result = await runPreflight(opts, makeHappyDeps());
    const c = checkById(result, 'repo-and-base');
    assert.strictEqual(c.ok, false);
    assert.match(c.message, /does not exist/);
  });

  test('missing baseBranch fails the check', async () => {
    const opts = makeHappyOpts();
    delete opts.baseBranch;
    const result = await runPreflight(opts, makeHappyDeps());
    assert.strictEqual(checkById(result, 'repo-and-base').ok, false);
  });
});

// -- source-scan guard: injected I/O only, nothing constructed here ----------
//
// Equivalent to await-gate.test.mjs's and spool.test.mjs's own guards. Every
// collaborator preflight.mjs needs (supervisor client, beads, fleetApi, git,
// fs, log) is injected via `deps`; the only imports allowed are the pure
// helpers this file's header explains reusing.

describe('source-scan guard: preflight.mjs', () => {
  const ALLOWED_PREFLIGHT_IMPORTS = [
    'node:path',
    '../errors.mjs',
    '@apralabs/apra-fleet-client',
    '@apralabs/apra-fleet-se/fleet-sprint/vcs-module.mjs',
  ];

  test('preflight.mjs imports only from the explicit allowlist', () => {
    const src = readFileSync(PREFLIGHT_SOURCE_PATH, 'utf-8');
    const specifiers = [...src.matchAll(/^import\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"];?\s*$/gm)].map((m) => m[1]);
    assert.ok(specifiers.length > 0, 'sanity check: the import scan must find at least one import');
    for (const spec of specifiers) {
      assert.ok(
        ALLOWED_PREFLIGHT_IMPORTS.includes(spec),
        `preflight.mjs imports an unexpected module "${spec}" -- must be one of: ${ALLOWED_PREFLIGHT_IMPORTS.join(', ')}`
      );
    }
  });

  test('preflight.mjs never reads process.env, imports a real node:fs, or calls fetch directly', () => {
    const src = readFileSync(PREFLIGHT_SOURCE_PATH, 'utf-8');
    assert.ok(!/process\.env[.[]/.test(src), 'preflight.mjs must not read process.env');
    assert.ok(
      !/from ['"]node:fs['"]/.test(src) && !/require\(['"]node:fs['"]\)/.test(src),
      'preflight.mjs must not import a real node:fs'
    );
    assert.ok(
      !/globalThis\.fetch\s*\(/.test(src) && !/(?<![.\w])fetch\s*\(/.test(src),
      'preflight.mjs must not call fetch directly'
    );
  });

  test('nothing is constructed inside -- no `new ` of a client/transport class', () => {
    const src = readFileSync(PREFLIGHT_SOURCE_PATH, 'utf-8');
    // The only `new` in this module should be BridgeError construction.
    const newUses = [...src.matchAll(/\bnew\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
    for (const cls of newUses) {
      assert.strictEqual(cls, 'BridgeError', `unexpected construction of "${cls}" in preflight.mjs -- every collaborator must be injected`);
    }
  });
});
