// Tests for src/rest-client.mjs -- the member-dispatched REST transport
// azure-devops.mjs's comment()/setBuildStatus() consume as deps.restClient.
//
// No process.env, node:fs writes, or real fetch/curl anywhere in this file
// -- every dependency (callTool) is a fake defined here, and buildRestCommand
// is pure string construction exercised with no I/O at all.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createRestClient, buildRestCommand } from '../src/rest-client.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from '../src/errors.mjs';
import { assertThrows } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Records every call; resolves to a canned callTool result. */
function makeFakeCallTool(result = { structuredContent: { exitCode: 0, stdout: '{}\n200', stderr: '' } }) {
  const calls = [];
  const fn = async (name, args) => {
    calls.push({ name, args });
    return typeof result === 'function' ? result(name, args) : result;
  };
  fn.calls = calls;
  return fn;
}

const VALID_URL = 'https://example.invalid/org/project/_apis/wit/workItems/42/comments?api-version=7.1-preview.3';

// ---------------------------------------------------------------------------
// buildRestCommand: shape correctness, both dialects
// ---------------------------------------------------------------------------

describe('buildRestCommand: POSIX form', () => {
  test('builds a two-statement command: bare-token env assignment, then curl referencing it', () => {
    const cmd = buildRestCommand({
      method: 'POST',
      url: VALID_URL,
      secretName: 'azdevops_pat',
      body: { text: 'hello' },
      targetOs: 'linux',
      shell: null,
    });
    // The body travels base64-on-stdin, not as a --data-binary argument --
    // see buildRestCommand's "WHY THE POSIX BODY TRAVELS AS BASE64 ON
    // STDIN": the dispatch layer halves doubled backslashes in the command
    // text, which silently corrupts any JSON escape.
    assert.equal(
      cmd,
      'FLEET_BRIDGE_REST_SECRET={{secret.azdevops_pat}}; ' +
        `printf %s 'eyJ0ZXh0IjoiaGVsbG8ifQ==' | base64 -d | ` +
        'curl -sS -X POST -u ":$FLEET_BRIDGE_REST_SECRET" ' +
        `-H 'Content-Type: application/json' --data-binary @- '${VALID_URL}' -w '\\n%{http_code}'`
    );
  });

  test('gitbash on a windows member groups with posix (bash command text, not PowerShell)', () => {
    const cmd = buildRestCommand({
      method: 'GET',
      url: 'https://example.invalid/x',
      secretName: 'sec',
      targetOs: 'windows',
      shell: 'gitbash',
    });
    // curlBinary() is OS-keyed (windows -> curl.exe), independent of the
    // POSIX/PowerShell dialect choice -- both are exercised together here.
    assert.equal(
      cmd,
      'FLEET_BRIDGE_REST_SECRET={{secret.sec}}; curl.exe -sS -X GET -u ":$FLEET_BRIDGE_REST_SECRET" \'https://example.invalid/x\' -w \'\\n%{http_code}\''
    );
  });

  test('GET with no body omits Content-Type/--data-binary entirely', () => {
    const cmd = buildRestCommand({ method: 'GET', url: 'https://example.invalid/x', secretName: 'sec', targetOs: 'linux' });
    assert.ok(!cmd.includes('--data-binary'));
    assert.ok(!cmd.includes('Content-Type'));
  });
});

describe('buildRestCommand: PowerShell form', () => {
  // The PowerShell body path used to be a quoted --data-binary argument and
  // was PROVEN broken live: a body carrying /^\d+$/ reached Azure DevOps as
  // invalid JSON (HTTP 400, Newtonsoft.Json.JsonReaderException) because the
  // dispatch layer halves doubled backslashes in the command TEXT. It now
  // decodes shared base64 into a temp file. See buildRestCommand's doc.
  const PS_BODY_PREFIX =
    "$FleetBridgeRestBody = Join-Path ([IO.Path]::GetTempPath()) " +
    "('fleet-bridge-body-' + [guid]::NewGuid().ToString('N') + '.json'); ";
  const PS_CLEANUP =
    ' } finally { Remove-Item -LiteralPath $FleetBridgeRestBody -Force -ErrorAction SilentlyContinue }';

  test('builds $env: assignment, a base64 temp-file write, then curl.exe reading the file', () => {
    const cmd = buildRestCommand({
      method: 'POST',
      url: 'https://example.invalid/x',
      secretName: 'azdevops_pat',
      body: { text: 'hello' },
      targetOs: 'windows',
      shell: null,
    });
    assert.equal(
      cmd,
      '$env:FLEET_BRIDGE_REST_SECRET = {{secret.azdevops_pat}}; ' +
        PS_BODY_PREFIX +
        "[IO.File]::WriteAllBytes($FleetBridgeRestBody, [Convert]::FromBase64String('eyJ0ZXh0IjoiaGVsbG8ifQ==')); " +
        'try { curl.exe -sS -X POST -u ":$env:FLEET_BRIDGE_REST_SECRET" ' +
        "-H 'Content-Type: application/json' --data-binary ('@' + $FleetBridgeRestBody) " +
        "'https://example.invalid/x' -w '\\n%{http_code}'" +
        PS_CLEANUP
    );
  });

  test('no fragment of the JSON body appears as literal text in the command', () => {
    const cmd = buildRestCommand({
      method: 'POST',
      url: 'https://example.invalid/x',
      secretName: 'sec',
      body: { text: 'hello world' },
      targetOs: 'windows',
    });
    // The whole point: the dispatch layer can only corrupt what it can see.
    assert.ok(!cmd.includes('hello'), 'the body must not appear as literal text');
    assert.ok(!cmd.includes('"text"'), 'the JSON must not appear as literal text');
  });

  test('the temp file is deleted in a finally, so a failed curl cannot leave the body on disk', () => {
    const cmd = buildRestCommand({
      method: 'POST', url: 'https://example.invalid/x', secretName: 'sec',
      body: { text: 'hello' }, targetOs: 'windows',
    });
    assert.ok(cmd.includes('try { curl.exe'), 'the curl call must be inside the try block');
    assert.ok(cmd.endsWith(PS_CLEANUP), 'cleanup must be the trailing finally block');
    // -LiteralPath so a path is never read as a wildcard; -Force so a
    // read-only file still goes; SilentlyContinue so cleanup can never turn
    // a successful REST call into a failed command.
    assert.ok(cmd.includes('-LiteralPath'));
    assert.ok(cmd.includes('-ErrorAction SilentlyContinue'));
  });

  test('the temp-file name is a fresh GUID, so concurrent dispatches to one member cannot collide', () => {
    const cmd = buildRestCommand({
      method: 'POST', url: 'https://example.invalid/x', secretName: 'sec',
      body: { text: 'hello' }, targetOs: 'windows',
    });
    assert.ok(cmd.includes("[guid]::NewGuid().ToString('N')"), 'expected a member-side GUID, not a name chosen here');
    assert.ok(cmd.includes('[IO.Path]::GetTempPath()'), 'the body belongs in the temp dir, not the work folder');
  });

  test('a GET with no body emits no temp file, no try/finally -- a plain one-liner', () => {
    const cmd = buildRestCommand({ method: 'GET', url: 'https://example.invalid/x', secretName: 'sec', targetOs: 'windows', shell: 'powershell5' });
    assert.ok(!cmd.includes('FleetBridgeRestBody'));
    assert.ok(!cmd.includes('finally'));
    assert.equal(
      cmd,
      '$env:FLEET_BRIDGE_REST_SECRET = {{secret.sec}}; ' +
        'curl.exe -sS -X GET -u ":$env:FLEET_BRIDGE_REST_SECRET" ' +
        "'https://example.invalid/x' -w '\\n%{http_code}'"
    );
  });

  test('pwsh7/powershell5 member (unresolved shell on windows) also produces the PowerShell form', () => {
    const cmd = buildRestCommand({ method: 'GET', url: 'https://example.invalid/x', secretName: 'sec', targetOs: 'windows', shell: 'pwsh7' });
    assert.match(cmd, /^\$env:FLEET_BRIDGE_REST_SECRET = /);
  });
});

// ---------------------------------------------------------------------------
// The two dialects must not drift: one encoding step, two decoders
// ---------------------------------------------------------------------------

describe('buildRestCommand: both dialects encode the body identically', () => {
  const BS = String.fromCharCode(92);
  const TRICKY = { text: `regex /^${BS}d+$/ and path C:${BS}Users${BS}x` };

  /** Pull the base64 blob out of whichever decode form the dialect used. */
  function extractBase64(cmd) {
    const posix = cmd.match(/printf %s '([A-Za-z0-9+/=]+)'/);
    if (posix) return posix[1];
    const ps = cmd.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/);
    return ps ? ps[1] : null;
  }

  test('a body with a regex and a Windows path round-trips byte-for-byte in BOTH dialects', () => {
    for (const target of [
      { targetOs: 'windows', shell: 'gitbash' },
      { targetOs: 'windows', shell: 'powershell5' },
      { targetOs: 'linux', shell: null },
    ]) {
      const cmd = buildRestCommand({ method: 'POST', url: VALID_URL, secretName: 'sec', body: TRICKY, ...target });
      const b64 = extractBase64(cmd);
      assert.ok(b64, `expected a base64 body for ${JSON.stringify(target)}`);
      assert.deepEqual(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')), TRICKY);
      // And nothing backslash-bearing from the payload is left in the text
      // for the dispatch layer's halving pass to find.
      assert.ok(!cmd.includes(`${BS}${BS}d`), 'no doubled backslash may reach the command text');
      assert.ok(!cmd.includes('Users'), 'no payload fragment may reach the command text');
    }
  });

  test('the shared encoding step produces the identical blob for every dialect', () => {
    const blobs = [
      buildRestCommand({ method: 'POST', url: VALID_URL, secretName: 'sec', body: TRICKY, targetOs: 'linux' }),
      buildRestCommand({ method: 'POST', url: VALID_URL, secretName: 'sec', body: TRICKY, targetOs: 'windows', shell: 'gitbash' }),
      buildRestCommand({ method: 'POST', url: VALID_URL, secretName: 'sec', body: TRICKY, targetOs: 'windows', shell: 'powershell5' }),
    ].map(extractBase64);
    assert.equal(new Set(blobs).size, 1, 'the dialects must share one encoding step, not two copies of the rule');
  });
});

// ---------------------------------------------------------------------------
// The load-bearing bare-placeholder invariant
// ---------------------------------------------------------------------------

describe('buildRestCommand: the {{secret.NAME}} placeholder is bare', () => {
  test('the placeholder has no adjacent quote character on either side, in both dialects', () => {
    for (const targetOs of ['linux', 'windows']) {
      const cmd = buildRestCommand({ method: 'GET', url: 'https://example.invalid/x', secretName: 'azdevops_pat', targetOs });
      const token = '{{secret.azdevops_pat}}';
      const idx = cmd.indexOf(token);
      assert.ok(idx > -1, `expected to find ${token} in: ${cmd}`);
      const before = cmd[idx - 1];
      const after = cmd[idx + token.length];
      assert.notEqual(before, "'", `token must not be preceded by a quote (${targetOs})`);
      assert.notEqual(before, '"', `token must not be preceded by a quote (${targetOs})`);
      assert.notEqual(after, "'", `token must not be followed by a quote (${targetOs})`);
      assert.notEqual(after, '"', `token must not be followed by a quote (${targetOs})`);
    }
  });

  test('the secret NAME appears in the command; no secret VALUE can, since this module never receives one', () => {
    const cmd = buildRestCommand({ method: 'GET', url: 'https://example.invalid/x', secretName: 'my_pat_name', targetOs: 'linux' });
    assert.match(cmd, /\{\{secret\.my_pat_name\}\}/);
  });

  test('the command never routes through a PowerShell -EncodedCommand blob (that would hide the placeholder from server-side substitution)', () => {
    const cmd = buildRestCommand({ method: 'GET', url: 'https://example.invalid/x', secretName: 'sec', targetOs: 'windows' });
    assert.ok(!cmd.includes('-EncodedCommand'));
  });
});

// ---------------------------------------------------------------------------
// Charset guards: url, secretName -- mirroring TRACKER_REF_PATTERN's shape
// ---------------------------------------------------------------------------

describe('buildRestCommand: input validation', () => {
  test('missing method throws CONFIG_MISSING', () => {
    const err = assertThrows(() => buildRestCommand({ url: VALID_URL, secretName: 'sec' }));
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });

  test('unsupported method throws CONFIG_INVALID', () => {
    const err = assertThrows(() => buildRestCommand({ method: 'TRACE', url: VALID_URL, secretName: 'sec' }));
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('lowercase method is normalized (not rejected)', () => {
    const cmd = buildRestCommand({ method: 'post', url: VALID_URL, secretName: 'sec', targetOs: 'linux' });
    assert.match(cmd, /-X POST/);
  });

  test('missing url throws CONFIG_MISSING', () => {
    const err = assertThrows(() => buildRestCommand({ method: 'GET', secretName: 'sec' }));
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });

  test('url starting with a dash is rejected (would be parsed as a flag)', () => {
    const err = assertThrows(() => buildRestCommand({ method: 'GET', url: '-X', secretName: 'sec' }));
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    assert.match(err.message, /dash/);
  });

  test('a non-http(s) url is rejected', () => {
    const err = assertThrows(() => buildRestCommand({ method: 'GET', url: 'ftp://example.invalid/x', secretName: 'sec' }));
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('a url attempting to break out of its quoted token is rejected', () => {
    const attempts = [
      "https://example.invalid/x' ; rm -rf / #",
      'https://example.invalid/x" ; rm -rf / #',
      'https://example.invalid/x`id`',
      'https://example.invalid/x\ninjected',
      'https://example.invalid/x\tinjected',
    ];
    for (const url of attempts) {
      const err = assertThrows(() => buildRestCommand({ method: 'GET', url, secretName: 'sec' }));
      assert.ok(err instanceof BridgeError, `expected a throw for ${JSON.stringify(url)}`);
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    }
  });

  test('missing secretName throws CONFIG_MISSING', () => {
    const err = assertThrows(() => buildRestCommand({ method: 'GET', url: VALID_URL }));
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });

  test('secretName starting with a dash is rejected', () => {
    const err = assertThrows(() => buildRestCommand({ method: 'GET', url: VALID_URL, secretName: '--all' }));
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('a secretName attempting to break out of the {{secret.NAME}} placeholder is rejected', () => {
    const attempts = ['sec}}; rm -rf /', 'sec}} extra', "sec' ; rm -rf #", 'sec name with spaces', 'sec\n'];
    for (const secretName of attempts) {
      const err = assertThrows(() => buildRestCommand({ method: 'GET', url: VALID_URL, secretName }));
      assert.ok(err instanceof BridgeError, `expected a throw for ${JSON.stringify(secretName)}`);
      assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
    }
  });

  test('a body that cannot be JSON-serialized (a bigint) throws CONFIG_INVALID', () => {
    const err = assertThrows(() => buildRestCommand({ method: 'POST', url: VALID_URL, secretName: 'sec', body: { n: 10n } }));
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('a body that serializes to undefined (a bare function) throws CONFIG_INVALID', () => {
    const err = assertThrows(() => buildRestCommand({ method: 'POST', url: VALID_URL, secretName: 'sec', body: function boom() {} }));
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
  });

  test('a string body is accepted and travels as base64 of its JSON form', () => {
    const cmd = buildRestCommand({ method: 'POST', url: VALID_URL, secretName: 'sec', body: 'plain text', targetOs: 'linux' });
    assert.match(cmd, /--data-binary @-/);
    assert.ok(cmd.includes("printf %s 'InBsYWluIHRleHQi'"));
  });

  test('a body containing a backslash survives byte-for-byte (the live 400 this closes)', () => {
    const body = [{ op: 'add', path: '/fields/System.Description', value: 'regex /^\\d+$/ here' }];
    const cmd = buildRestCommand({ method: 'POST', url: VALID_URL, secretName: 'sec', body, contentType: 'application/json-patch+json', targetOs: 'windows', shell: 'gitbash' });
    // NOTHING in the command text may carry a backslash from the payload:
    // that is exactly what the dispatch layer mangles.
    const encoded = cmd.match(/printf %s '([A-Za-z0-9+/=]+)'/);
    assert.ok(encoded, 'the body must be base64 on stdin');
    assert.deepEqual(JSON.parse(Buffer.from(encoded[1], 'base64').toString('utf8')), body);
  });
});

// ---------------------------------------------------------------------------
// createRestClient: constructor validation
// ---------------------------------------------------------------------------

describe('createRestClient: constructor validation', () => {
  test('missing callTool throws CONFIG_MISSING', () => {
    const err = assertThrows(() => createRestClient({ memberName: 'member-a' }));
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });

  test('missing memberName throws CONFIG_MISSING', () => {
    const err = assertThrows(() => createRestClient({ callTool: makeFakeCallTool() }));
    assert.ok(err instanceof BridgeError);
    assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_MISSING);
  });
});

// ---------------------------------------------------------------------------
// createRestClient: dispatch shape
// ---------------------------------------------------------------------------

describe('createRestClient: dispatch', () => {
  test('dispatches execute_command with the built command to the configured member', async () => {
    const callTool = makeFakeCallTool();
    const restClient = createRestClient({ callTool, memberName: 'member-a', targetOs: 'linux' });
    await restClient({ method: 'POST', url: VALID_URL, secretName: 'azdevops_pat', body: { text: 'hi' } });

    assert.equal(callTool.calls.length, 1);
    assert.equal(callTool.calls[0].name, 'execute_command');
    assert.equal(callTool.calls[0].args.member_name, 'member-a');
    assert.equal(
      callTool.calls[0].args.command,
      'FLEET_BRIDGE_REST_SECRET={{secret.azdevops_pat}}; ' +
        `printf %s 'eyJ0ZXh0IjoiaGkifQ==' | base64 -d | ` +
        'curl -sS -X POST -u ":$FLEET_BRIDGE_REST_SECRET" ' +
        `-H 'Content-Type: application/json' --data-binary @- '${VALID_URL}' -w '\\n%{http_code}'`
    );
  });

  test('propagates a rejected callTool as-is (mirrors beads-client.dispatchTrackerCommand -- the facade layer catches this)', async () => {
    const boom = new Error('member unreachable');
    const restClient = createRestClient({
      callTool: async () => { throw boom; },
      memberName: 'member-a',
      targetOs: 'linux',
    });
    await assert.rejects(
      () => restClient({ method: 'GET', url: VALID_URL, secretName: 'sec' }),
      (err) => err === boom
    );
  });

  test('a malformed request (e.g. bad method) throws before callTool is ever invoked', async () => {
    const callTool = makeFakeCallTool();
    const restClient = createRestClient({ callTool, memberName: 'member-a', targetOs: 'linux' });
    await assert.rejects(
      () => restClient({ method: 'TRACE', url: VALID_URL, secretName: 'sec' }),
      (err) => err instanceof BridgeError && err.code === BRIDGE_ERROR_CODES.CONFIG_INVALID
    );
    assert.equal(callTool.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Response parsing: {status, body}, non-2xx is data not a throw
// ---------------------------------------------------------------------------

describe('createRestClient: response parsing', () => {
  test('a 2xx response parses into {status, body} from structuredContent.stdout', async () => {
    const callTool = makeFakeCallTool({ structuredContent: { exitCode: 0, stdout: '{"id":7}\n201', stderr: '' } });
    const restClient = createRestClient({ callTool, memberName: 'member-a', targetOs: 'linux' });
    const result = await restClient({ method: 'POST', url: VALID_URL, secretName: 'sec', body: { text: 'hi' } });
    assert.deepEqual(result, { status: 201, body: '{"id":7}' });
  });

  test('a non-2xx status is returned as data, not thrown', async () => {
    const callTool = makeFakeCallTool({ structuredContent: { exitCode: 0, stdout: '{"message":"not found"}\n404', stderr: '' } });
    const restClient = createRestClient({ callTool, memberName: 'member-a', targetOs: 'linux' });
    const result = await restClient({ method: 'GET', url: VALID_URL, secretName: 'sec' });
    assert.deepEqual(result, { status: 404, body: '{"message":"not found"}' });
  });

  test('a body containing embedded newlines is still split correctly (split on the LAST newline)', async () => {
    const callTool = makeFakeCallTool({ structuredContent: { exitCode: 0, stdout: 'line one\nline two\n500', stderr: '' } });
    const restClient = createRestClient({ callTool, memberName: 'member-a', targetOs: 'linux' });
    const result = await restClient({ method: 'GET', url: VALID_URL, secretName: 'sec' });
    assert.deepEqual(result, { status: 500, body: 'line one\nline two' });
  });

  test('an empty body with just a status line parses to an empty body string', async () => {
    const callTool = makeFakeCallTool({ structuredContent: { exitCode: 0, stdout: '\n204', stderr: '' } });
    const restClient = createRestClient({ callTool, memberName: 'member-a', targetOs: 'linux' });
    const result = await restClient({ method: 'DELETE', url: VALID_URL, secretName: 'sec' });
    assert.deepEqual(result, { status: 204, body: '' });
  });

  test('falls back to a bare {stdout} shape when structuredContent is absent', async () => {
    const callTool = makeFakeCallTool({ stdout: 'ok\n200', stderr: '' });
    const restClient = createRestClient({ callTool, memberName: 'member-a', targetOs: 'linux' });
    const result = await restClient({ method: 'GET', url: VALID_URL, secretName: 'sec' });
    assert.deepEqual(result, { status: 200, body: 'ok' });
  });

  test('falls back to stripping the "Exit code: N" text prefix when only {text} is present', async () => {
    const callTool = makeFakeCallTool({ text: 'Exit code: 0\nok\n200' });
    const restClient = createRestClient({ callTool, memberName: 'member-a', targetOs: 'linux' });
    const result = await restClient({ method: 'GET', url: VALID_URL, secretName: 'sec' });
    assert.deepEqual(result, { status: 200, body: 'ok' });
  });

  test('output with no parseable trailing status line is returned as best-effort data, never thrown', async () => {
    const callTool = makeFakeCallTool({ structuredContent: { exitCode: 1, stdout: '', stderr: 'curl: command not found' } });
    const restClient = createRestClient({ callTool, memberName: 'member-a', targetOs: 'linux' });
    const result = await restClient({ method: 'GET', url: VALID_URL, secretName: 'sec' });
    assert.equal(result.status, null);
  });
});

// ---------------------------------------------------------------------------
// contentType -- a parameter, because Azure DevOps work item CREATE accepts
// only application/json-patch+json (see buildRestCommand's own note).
// ---------------------------------------------------------------------------

describe('buildRestCommand: contentType', () => {
  test('defaults to application/json, so every pre-existing call site is unchanged', () => {
    const cmd = buildRestCommand({ method: 'POST', url: VALID_URL, secretName: 'sec', body: { a: 1 }, targetOs: 'linux' });
    assert.match(cmd, /Content-Type: application\/json(?![-+])/);
  });

  test('carries application/json-patch+json through when asked for', () => {
    const cmd = buildRestCommand({
      method: 'POST', url: VALID_URL, secretName: 'sec', body: [{ op: 'add' }],
      contentType: 'application/json-patch+json', targetOs: 'linux',
    });
    assert.match(cmd, /Content-Type: application\/json-patch\+json/);
  });

  test('an unlisted media type is CONFIG_INVALID, never passed through to a header', () => {
    assert.throws(
      () => buildRestCommand({
        method: 'POST', url: VALID_URL, secretName: 'sec', body: { a: 1 },
        contentType: 'text/plain\nX-Injected: 1', targetOs: 'linux',
      }),
      (err) => {
        assert.equal(err.code, BRIDGE_ERROR_CODES.CONFIG_INVALID);
        return true;
      }
    );
  });

  test('createRestClient forwards contentType to the built command', async () => {
    const callTool = makeFakeCallTool({ structuredContent: { exitCode: 0, stdout: '{}\n201', stderr: '' } });
    const restClient = createRestClient({ callTool, memberName: 'member-a', targetOs: 'linux' });
    await restClient({ method: 'POST', url: VALID_URL, secretName: 'sec', body: [{ op: 'add' }], contentType: 'application/json-patch+json' });
    assert.match(callTool.calls[0].args.command, /application\/json-patch\+json/);
  });
});
