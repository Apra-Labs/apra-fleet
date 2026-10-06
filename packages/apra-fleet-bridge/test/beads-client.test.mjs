import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createBeadsClient, assertNoBareSync, buildTrackerCommand } from '../src/beads-client.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';
import { BD_MAX_BUFFER_BYTES } from '@apralabs/apra-fleet-se/src/supervisor/lib/exec-bd.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = path.join(__dirname, '..', 'src', 'beads-client.mjs');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Records every call; returns a canned stdout (default '[]'). */
function makeFakeExecBdSync(stdout = '[]') {
  const calls = [];
  const fn = (args, options) => {
    calls.push({ args, options });
    return stdout;
  };
  fn.calls = calls;
  return fn;
}

function makeFakeExecBdAsync(stdout = '[]', stderr = '') {
  const calls = [];
  const fn = async (args, options) => {
    calls.push({ args, options });
    return { stdout, stderr };
  };
  fn.calls = calls;
  return fn;
}

function makeFakeCallTool(result = { text: 'ok' }) {
  const calls = [];
  const fn = async (name, args) => {
    calls.push({ name, args });
    return result;
  };
  fn.calls = calls;
  return fn;
}

function makeClient(overrides = {}) {
  const execBdSync = overrides.execBdSync ?? makeFakeExecBdSync();
  const execBdAsync = overrides.execBdAsync ?? makeFakeExecBdAsync();
  const callTool = overrides.callTool ?? null;
  const clientOpts = {
    execBdSync,
    execBdAsync,
    callTool,
    memberName: overrides.memberName ?? null,
    targetOs: overrides.targetOs ?? null,
    shell: overrides.shell ?? null,
    log: overrides.log ?? (() => {}),
  };
  if (Object.prototype.hasOwnProperty.call(overrides, 'cwd')) clientOpts.cwd = overrides.cwd;
  const client = createBeadsClient(clientOpts);
  return { client, execBdSync, execBdAsync, callTool };
}

// ---------------------------------------------------------------------------
// Requirement 1: sync/async routing
// ---------------------------------------------------------------------------

test('list() with no free-text filters routes to execBdAsync', async () => {
  const { client, execBdSync, execBdAsync } = makeClient();
  await client.list();
  assert.equal(execBdAsync.calls.length, 1);
  assert.equal(execBdSync.calls.length, 0);
  assert.deepEqual(execBdAsync.calls[0].args, ['list', '--json', '--limit', '0']);
});

test('create({title: free text with spaces}) routes to execBdSync', async () => {
  const { client, execBdSync, execBdAsync } = makeClient();
  await client.create({ title: 'a title with spaces' });
  assert.equal(execBdSync.calls.length, 1);
  assert.equal(execBdAsync.calls.length, 0);
  assert.deepEqual(execBdSync.calls[0].args, ['create', '--title', 'a title with spaces', '--json']);
});

test('list({createdAfter: ISO timestamp}) routes to execBdSync (colon fails the async charset check)', async () => {
  const { client, execBdSync, execBdAsync } = makeClient();
  const iso = '2026-09-18T00:00:00Z';
  await client.list({ createdAfter: iso });
  assert.equal(execBdSync.calls.length, 1, 'colon in the ISO timestamp must force the sync path');
  assert.equal(execBdAsync.calls.length, 0);
  assert.ok(execBdSync.calls[0].args.includes(iso));
});

test('show(id) with a plain id routes to execBdAsync', async () => {
  const { client, execBdSync, execBdAsync } = makeClient();
  await client.show('mem-1i4');
  assert.equal(execBdAsync.calls.length, 1);
  assert.equal(execBdSync.calls.length, 0);
  assert.deepEqual(execBdAsync.calls[0].args, ['show', 'mem-1i4', '--json']);
});

test('update() with only safe-charset fields routes to execBdAsync', async () => {
  const { client, execBdSync, execBdAsync } = makeClient();
  await client.update('mem-1i4', { status: 'closed', priority: 1 });
  assert.equal(execBdAsync.calls.length, 1);
  assert.equal(execBdSync.calls.length, 0);
});

test('update() with a free-text description routes to execBdSync', async () => {
  const { client, execBdSync, execBdAsync } = makeClient();
  await client.update('mem-1i4', { description: 'has a space' });
  assert.equal(execBdSync.calls.length, 1);
  assert.equal(execBdAsync.calls.length, 0);
});

test('update() maps externalRef onto --external-ref (the carry-over idempotency stamp)', async () => {
  const { client, execBdSync, execBdAsync } = makeClient();
  const ref = 'https://example.invalid/org/project/_workitems/edit/5';
  await client.update('mem-1i4', { externalRef: ref });
  // A tracker URL is free text (':' and '/'), so this must take the sync
  // route -- execBdAsync would throw on it.
  assert.equal(execBdSync.calls.length, 1);
  assert.equal(execBdAsync.calls.length, 0);
  assert.deepEqual(execBdSync.calls[0].args, ['update', 'mem-1i4', '--external-ref', ref, '--json']);
});

test('doltPullProbe() routes to execBdAsync (all safe-charset args)', async () => {
  const { client, execBdSync, execBdAsync } = makeClient();
  const result = await client.doltPullProbe();
  assert.equal(execBdAsync.calls.length, 1);
  assert.equal(execBdSync.calls.length, 0);
  assert.deepEqual(execBdAsync.calls[0].args, ['dolt', 'pull']);
  assert.equal(result.ok, true);
});

test('doltRemoteList() routes to execBdAsync (all safe-charset args) and parses JSON', async () => {
  const { client, execBdSync, execBdAsync } = makeClient({ execBdAsync: makeFakeExecBdAsync('[]') });
  const result = await client.doltRemoteList();
  assert.equal(execBdAsync.calls.length, 1);
  assert.equal(execBdSync.calls.length, 0);
  assert.deepEqual(execBdAsync.calls[0].args, ['dolt', 'remote', 'list', '--json']);
  assert.deepEqual(result, []);
});

test('setParent() delegates to update() and routes to execBdAsync', async () => {
  const { client, execBdAsync } = makeClient();
  await client.setParent('child-1', 'parent-1');
  assert.equal(execBdAsync.calls.length, 1);
  assert.deepEqual(execBdAsync.calls[0].args, ['update', 'child-1', '--parent', 'parent-1', '--json']);
});

// ---------------------------------------------------------------------------
// Requirement 3: BD_MAX_BUFFER_BYTES always forwarded
// ---------------------------------------------------------------------------

test('BD_MAX_BUFFER_BYTES is forwarded as maxBuffer on the execBdAsync path', async () => {
  const { client, execBdAsync } = makeClient();
  await client.list();
  assert.equal(execBdAsync.calls[0].options.maxBuffer, BD_MAX_BUFFER_BYTES);
});

test('BD_MAX_BUFFER_BYTES is forwarded as maxBuffer on the execBdSync path', async () => {
  const { client, execBdSync } = makeClient();
  await client.create({ title: 'free text title' });
  assert.equal(execBdSync.calls[0].options.maxBuffer, BD_MAX_BUFFER_BYTES);
});

// ---------------------------------------------------------------------------
// Requirement 4: JSON parsing helper
// ---------------------------------------------------------------------------

test('empty stdout parses as []', async () => {
  const { client } = makeClient({ execBdAsync: makeFakeExecBdAsync('') });
  const result = await client.list();
  assert.deepEqual(result, []);
});

test('malformed JSON throws a labelled BridgeError(BEADS_FAILED) with a raw-output snippet', async () => {
  const { client } = makeClient({ execBdAsync: makeFakeExecBdAsync('not json') });
  await assert.rejects(
    () => client.list(),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, BRIDGE_ERROR_CODES.BEADS_FAILED);
      assert.match(err.message, /bd list --json --limit 0/);
      assert.match(err.message, /not json/);
      return true;
    }
  );
});

test('a real bd list result round-trips through list()', async () => {
  const rows = [{ id: 'mem-1i4', title: 'x' }];
  const { client } = makeClient({ execBdAsync: makeFakeExecBdAsync(JSON.stringify(rows)) });
  const result = await client.list();
  assert.deepEqual(result, rows);
});

// ---------------------------------------------------------------------------
// Requirement 2: assertNoBareSync + source scan
// ---------------------------------------------------------------------------

test('assertNoBareSync throws BEADS_BARE_SYNC_REFUSED for "bd ado sync"', () => {
  assert.throws(
    () => assertNoBareSync(['ado', 'sync', 'WI-1']),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, BRIDGE_ERROR_CODES.BEADS_BARE_SYNC_REFUSED);
      return true;
    }
  );
});

test('assertNoBareSync throws for "bd github sync" too', () => {
  assert.throws(() => assertNoBareSync(['github', 'sync']), BridgeError);
});

test('assertNoBareSync does not throw for pull/push or a non-tracker namespace', () => {
  assert.doesNotThrow(() => assertNoBareSync(['ado', 'pull', 'WI-1']));
  assert.doesNotThrow(() => assertNoBareSync(['ado', 'push', 'mem-1i4']));
  assert.doesNotThrow(() => assertNoBareSync(['github', 'pull']));
  assert.doesNotThrow(() => assertNoBareSync(['list', '--json']));
  assert.doesNotThrow(() => assertNoBareSync(undefined));
});

test('assertNoBareSync throws CONFIG_INVALID on malformed argv shape (non-string elements) -- caller input, not a bd-process failure', () => {
  assert.throws(
    () => assertNoBareSync(['ado', 123]),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      assert.match(err.message, /invalid argv shape/);
      return true;
    }
  );
});

test('buildTrackerCommand refuses verb "sync"', () => {
  assert.throws(
    () => buildTrackerCommand({ namespace: 'ado', verb: 'sync', refs: ['WI-1'], secretName: 'azdevops_pat', targetOs: 'linux' }),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, BRIDGE_ERROR_CODES.BEADS_BARE_SYNC_REFUSED);
      return true;
    }
  );
});

test('module source never constructs a bare "sync" verb literal outside assertNoBareSync\'s own guard', () => {
  // This is a supplementary source-code check only. The real behavioral guarantee
  // that a bare sync is never executed comes from the functional tests:
  // - assertNoBareSync throws BEADS_BARE_SYNC_REFUSED for "bd ado sync" (line 183-191)
  // - buildTrackerCommand refuses verb "sync" (line 206-215)
  // - trackerPush always uses 'push' and never constructs a bare 'sync' (line 332-339)
  // This test is a stray-literal guard; if assertNoBareSync were stubbed to do nothing,
  // the functional tests would still catch any attempt to call sync.
  const src = readFileSync(SOURCE_PATH, 'utf-8');
  // The ONLY place the single-quoted literal 'sync' may legitimately appear
  // is the guard's own comparison, which has to name the word to detect it.
  const withoutGuardComparison = src.replace(/verb === 'sync'/g, '');
  assert.ok(
    !withoutGuardComparison.includes("'sync'"),
    'found a bare \'sync\' string literal outside assertNoBareSync\'s own check -- this module must never construct a bare sync verb'
  );
});

// ---------------------------------------------------------------------------
// Requirement 5 + 6: the {{secret.NAME}} placeholder and cross-shell dialect
// ---------------------------------------------------------------------------

test('buildTrackerCommand (posix): token is bare, no adjacent quote characters', () => {
  const cmd = buildTrackerCommand({
    namespace: 'ado',
    verb: 'pull',
    refs: ['WI-123'],
    secretName: 'azdevops_pat',
    targetOs: 'linux',
  });
  const token = '{{secret.azdevops_pat}}';
  const idx = cmd.indexOf(token);
  assert.ok(idx >= 0, `expected token in command: ${cmd}`);
  const before = cmd[idx - 1];
  const after = cmd[idx + token.length];
  assert.notEqual(before, "'");
  assert.notEqual(before, '"');
  assert.notEqual(after, "'");
  assert.notEqual(after, '"');
  // POSIX inline env-assignment prefix form.
  assert.equal(cmd, `AZURE_DEVOPS_PAT=${token} bd ado pull WI-123`);
});

test('buildTrackerCommand (powershell / windows non-gitbash): token is bare, no adjacent quote characters', () => {
  const cmd = buildTrackerCommand({
    namespace: 'github',
    verb: 'push',
    refs: ['mem-1i4', 'mem-a2c'],
    secretName: 'github_pat',
    targetOs: 'windows',
    shell: 'powershell5',
  });
  const token = '{{secret.github_pat}}';
  const idx = cmd.indexOf(token);
  assert.ok(idx >= 0, `expected token in command: ${cmd}`);
  const before = cmd[idx - 1];
  const after = cmd[idx + token.length];
  assert.notEqual(before, "'");
  assert.notEqual(before, '"');
  assert.notEqual(after, "'");
  assert.notEqual(after, '"');
  assert.equal(cmd, `$env:GITHUB_TOKEN = ${token}; bd github push mem-1i4 mem-a2c`);
});

test('buildTrackerCommand (windows + gitbash shell) uses the POSIX dialect, not PowerShell', () => {
  const cmd = buildTrackerCommand({
    namespace: 'ado',
    verb: 'pull',
    refs: ['WI-1'],
    secretName: 'azdevops_pat',
    targetOs: 'windows',
    shell: 'gitbash',
  });
  assert.match(cmd, /^AZURE_DEVOPS_PAT=\{\{secret\.azdevops_pat\}\} bd ado pull WI-1$/);
});

test('buildTrackerCommand rejects an unsafe ref (CONFIG_INVALID: caller-provided bad input, not a bd-process failure)', () => {
  assert.throws(
    () => buildTrackerCommand({ namespace: 'ado', verb: 'pull', refs: ["WI-1; rm -rf /"], secretName: 'azdevops_pat', targetOs: 'linux' }),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      return true;
    }
  );
});

test('buildTrackerCommand rejects a ref beginning with --all (flag injection, CONFIG_INVALID)', () => {
  assert.throws(
    () => buildTrackerCommand({ namespace: 'ado', verb: 'pull', refs: ['--all'], secretName: 'azdevops_pat', targetOs: 'linux' }),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      assert.match(err.message, /may not begin with a dash/);
      return true;
    }
  );
});

test('buildTrackerCommand rejects a ref beginning with -f (flag injection, CONFIG_INVALID)', () => {
  assert.throws(
    () => buildTrackerCommand({ namespace: 'ado', verb: 'pull', refs: ['-f'], secretName: 'azdevops_pat', targetOs: 'linux' }),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      assert.match(err.message, /may not begin with a dash/);
      return true;
    }
  );
});

test('buildTrackerCommand rejects --dry-run as a ref (module-added flag must not be in user refs, CONFIG_INVALID)', () => {
  assert.throws(
    () => buildTrackerCommand({ namespace: 'ado', verb: 'push', refs: ['--dry-run'], secretName: 'azdevops_pat', targetOs: 'linux' }),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      assert.match(err.message, /may not begin with a dash/);
      return true;
    }
  );
});

test('buildTrackerCommand accepts legitimate refs: WI-123, owner/repo#123, mem-1i4', () => {
  assert.doesNotThrow(() => buildTrackerCommand({ namespace: 'ado', verb: 'pull', refs: ['WI-123'], secretName: 'azdevops_pat', targetOs: 'linux' }));
  assert.doesNotThrow(() => buildTrackerCommand({ namespace: 'github', verb: 'pull', refs: ['owner/repo#123'], secretName: 'github_pat', targetOs: 'linux' }));
  assert.doesNotThrow(() => buildTrackerCommand({ namespace: 'ado', verb: 'push', refs: ['mem-1i4', 'mem-a2c'], secretName: 'azdevops_pat', targetOs: 'linux' }));
});

test('buildTrackerCommand appends --dry-run when dryRun is true (not as a ref, but as a module-added flag)', () => {
  const cmd = buildTrackerCommand({ namespace: 'ado', verb: 'push', refs: ['mem-1i4'], secretName: 'azdevops_pat', dryRun: true, targetOs: 'linux' });
  assert.match(cmd, /bd ado push mem-1i4 --dry-run$/);
});

test('buildTrackerCommand rejects a missing secretName', () => {
  assert.throws(
    () => buildTrackerCommand({ namespace: 'ado', verb: 'pull', refs: ['WI-1'], targetOs: 'linux' }),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    }
  );
});

test('buildTrackerCommand rejects a verb that is neither pull, push, nor sync (CONFIG_INVALID: caller input, not a bd-process failure)', () => {
  assert.throws(
    () => buildTrackerCommand({ namespace: 'ado', verb: 'delete', refs: [], secretName: 'azdevops_pat', targetOs: 'linux' }),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      assert.match(err.message, /verb must be 'pull' or 'push'/);
      return true;
    }
  );
});

test('buildTrackerCommand rejects an unknown namespace', () => {
  assert.throws(
    () => buildTrackerCommand({ namespace: 'gitlab', verb: 'pull', refs: [], secretName: 'x', targetOs: 'linux' }),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, BRIDGE_ERROR_CODES.ADAPTER_UNKNOWN);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// create(): title validation taxonomy (the flagged sixth instance)
// ---------------------------------------------------------------------------

test('create() rejects a missing/empty title with CONFIG_INVALID, not BEADS_FAILED (caller input, not an internal defect)', async () => {
  const { client } = makeClient();
  await assert.rejects(
    () => client.create({}),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      assert.match(err.message, /non-empty title/);
      return true;
    }
  );
  await assert.rejects(
    () => client.create({ title: '' }),
    (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.CONFIG_INVALID
  );
});

// ---------------------------------------------------------------------------
// trackerPull / trackerPush dispatch via callTool
// ---------------------------------------------------------------------------

test('trackerPull dispatches execute_command to the configured member with the built command', async () => {
  const { client, callTool } = makeClient({
    callTool: makeFakeCallTool(),
    memberName: 'member-a',
    targetOs: 'linux',
  });
  await client.trackerPull('ado', ['WI-1', 'WI-2'], { secretName: 'azdevops_pat' });
  assert.equal(callTool.calls.length, 1);
  assert.equal(callTool.calls[0].name, 'execute_command');
  assert.equal(callTool.calls[0].args.member_name, 'member-a');
  assert.equal(callTool.calls[0].args.command, 'AZURE_DEVOPS_PAT={{secret.azdevops_pat}} bd ado pull WI-1 WI-2');
});

test('trackerPush with dryRun appends --dry-run and never calls a bare sync', async () => {
  const { client, callTool } = makeClient({
    callTool: makeFakeCallTool(),
    memberName: 'member-a',
    targetOs: 'linux',
  });
  await client.trackerPush('ado', ['mem-1i4'], { secretName: 'azdevops_pat', dryRun: true });
  assert.equal(callTool.calls[0].args.command, 'AZURE_DEVOPS_PAT={{secret.azdevops_pat}} bd ado push mem-1i4 --dry-run');
});

test('trackerPull throws CONFIG_MISSING when no callTool was injected', async () => {
  const { client } = makeClient({ memberName: 'member-a' });
  await assert.rejects(
    () => client.trackerPull('ado', ['WI-1'], { secretName: 'azdevops_pat' }),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    }
  );
});

test('trackerPush throws CONFIG_MISSING when no memberName was injected', async () => {
  const { client } = makeClient({ callTool: makeFakeCallTool() });
  await assert.rejects(
    () => client.trackerPush('ado', ['mem-1i4'], { secretName: 'azdevops_pat' }),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Requirement 7: no ambient I/O in the module
// ---------------------------------------------------------------------------

test('module source never touches process.env, node:fs, or globalThis.fetch', () => {
  const src = readFileSync(SOURCE_PATH, 'utf-8');
  // Property-access/import forms only, so a doc comment that merely NAMES
  // these APIs (to say the module avoids them) doesn't trip the check.
  assert.ok(!/process\.env[.[]/.test(src), 'must not read process.env');
  assert.ok(!/from ['"]node:fs['"]/.test(src) && !/require\(['"]node:fs['"]\)/.test(src), 'must not import node:fs');
  assert.ok(!/globalThis\.fetch\s*\(/.test(src), 'must not call globalThis.fetch');
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

test('createBeadsClient requires execBdSync and execBdAsync', () => {
  assert.throws(
    () => createBeadsClient({ execBdAsync: async () => ({ stdout: '[]', stderr: '' }) }),
    (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.CONFIG_MISSING && err.details.param === 'execBdSync'
  );
  assert.throws(
    () => createBeadsClient({ execBdSync: () => '[]' }),
    (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.CONFIG_MISSING && err.details.param === 'execBdAsync'
  );
});

// ---------------------------------------------------------------------------
// cwd: the beads DB lives in the repo under test, not wherever the bridge
// process happens to be running from -- see beads-client.mjs's own comments
// on createBeadsClient({ cwd }) and runBd() for the full rationale.
// ---------------------------------------------------------------------------

test('cwd is forwarded to execBdSync when the free-text branch is taken', async () => {
  const { client, execBdSync } = makeClient({ cwd: 'C:\\ak\\aztoy' });
  await client.create({ title: 'a title with spaces' });
  assert.equal(execBdSync.calls.length, 1);
  assert.deepEqual(execBdSync.calls[0].options, { maxBuffer: BD_MAX_BUFFER_BYTES, cwd: 'C:\\ak\\aztoy' });
});

test('cwd is forwarded to execBdAsync when the safe-charset branch is taken', async () => {
  const { client, execBdAsync } = makeClient({ cwd: 'C:\\ak\\aztoy' });
  await client.list();
  assert.equal(execBdAsync.calls.length, 1);
  assert.deepEqual(execBdAsync.calls[0].options, { maxBuffer: BD_MAX_BUFFER_BYTES, cwd: 'C:\\ak\\aztoy' });
});

test('omitting cwd leaves the options object unchanged from today\'s behavior (no cwd key at all)', async () => {
  const { client, execBdSync, execBdAsync } = makeClient();
  await client.list();
  assert.deepEqual(execBdAsync.calls[0].options, { maxBuffer: BD_MAX_BUFFER_BYTES });
  await client.create({ title: 'free text title' });
  assert.deepEqual(execBdSync.calls[0].options, { maxBuffer: BD_MAX_BUFFER_BYTES });
});

test('createBeadsClient rejects an empty-string cwd with CONFIG_INVALID', () => {
  assert.throws(
    () => createBeadsClient({ execBdSync: () => '[]', execBdAsync: async () => ({ stdout: '[]', stderr: '' }), cwd: '' }),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      assert.equal(err.details.param, 'cwd');
      return true;
    }
  );
});

test('createBeadsClient rejects a non-string cwd with CONFIG_INVALID', () => {
  assert.throws(
    () => createBeadsClient({ execBdSync: () => '[]', execBdAsync: async () => ({ stdout: '[]', stderr: '' }), cwd: 42 }),
    (err) => {
      assert.ok(err instanceof BridgeError);
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
      assert.equal(err.details.param, 'cwd');
      assert.equal(err.details.actualType, 'number');
      return true;
    }
  );
});

test('createBeadsClient accepts a valid cwd without throwing', () => {
  assert.doesNotThrow(() => createBeadsClient({
    execBdSync: () => '[]',
    execBdAsync: async () => ({ stdout: '[]', stderr: '' }),
    cwd: 'C:\\ak\\aztoy',
  }));
});
