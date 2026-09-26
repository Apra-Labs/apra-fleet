import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNetworkShapedCommand, redactNetworkCommandForLog, defaultMockCallTool, buildMockFleetApi } from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// apra-fleet-5co8.32 -- guards the fix that relaxed
// mock-sprint-harness.mjs's network-shaped-command guard from an anchored
// "curl/wget is the literal first token of the whole string" regex to
// isNetworkShapedCommand(), which now detects an unquoted curl/wget token at
// ANY position in the command (not just the start of a top-level
// sub-command), plus a curl/wget wrapped one level inside a
// `bash`/`sh -c|-lc|... "..."` script argument -- closing the exact
// slip-through class apra-fleet-5co8.16 exists to guard against for any
// composed command shape (cd/&&, env, timeout, nohup, time, bash -lc, an
// unbalanced quote elsewhere in the string, ...), not just the handful of
// wrappers a position/wrapper-allowlist approach would have to keep
// enumerating one at a time.
// =============================================================================

test('isNetworkShapedCommand', async (t) => {
    await t.test('matches a bare leading curl/wget command (pre-existing behavior)', () => {
        assert.equal(isNetworkShapedCommand('curl https://example.com/api'), true);
        assert.equal(isNetworkShapedCommand('wget https://example.com/file'), true);
        assert.equal(isNetworkShapedCommand('curl.exe https://example.com/api'), true);
    });

    await t.test('matches curl composed after a cd && prefix', () => {
        assert.equal(
            isNetworkShapedCommand('cd /tmp && curl https://example.com/api'),
            true,
            'a curl composed via `cd X && curl ...` must be detected',
        );
    });

    await t.test('matches curl wrapped inside a bash -c "..." script', () => {
        assert.equal(
            isNetworkShapedCommand('bash -c "curl https://example.com/api"'),
            true,
            'a curl wrapped inside bash -c "..." must be detected',
        );
        assert.equal(
            isNetworkShapedCommand("sh -c 'curl https://example.com/api'"),
            true,
            'a curl wrapped inside sh -c \'...\' must be detected',
        );
    });

    await t.test('matches curl composed after an env VAR=1 prefix', () => {
        assert.equal(
            isNetworkShapedCommand('VAR=1 curl https://example.com/api'),
            true,
            'a curl composed after an env VAR=1 prefix must be detected',
        );
    });

    await t.test('matches curl chained after ; or ||', () => {
        assert.equal(isNetworkShapedCommand('echo hi ; curl https://example.com'), true);
        assert.equal(isNetworkShapedCommand('false || curl https://example.com'), true);
    });

    // apra-fleet-5co8.32 round 2: the first fix (isNetworkShapedTokens gated
    // on an "at command start" cursor plus a wrapper allowlist) still missed
    // any wrapper it did not special-case. These pin the three composed
    // shapes the bead's own description enumerates, none of which are
    // env-assignment or bash/sh -c.
    await t.test('matches curl composed after an env prefix with no assignment', () => {
        assert.equal(isNetworkShapedCommand('env curl https://example.com'), true);
    });

    await t.test('matches curl composed after a timeout retry wrapper', () => {
        assert.equal(isNetworkShapedCommand('timeout 30 curl https://example.com'), true);
    });

    await t.test('matches curl composed after nohup/time wrappers', () => {
        assert.equal(isNetworkShapedCommand('nohup curl https://example.com &'), true);
        assert.equal(isNetworkShapedCommand('time curl https://example.com'), true);
    });

    await t.test('matches curl wrapped inside a bash -lc "..." login-shell script', () => {
        assert.equal(isNetworkShapedCommand('bash -lc "curl https://example.com/api"'), true);
    });

    await t.test('matches curl after an unbalanced quote elsewhere in the command', () => {
        assert.equal(
            isNetworkShapedCommand("echo it's fine && curl https://example.com"),
            true,
            'an unbalanced quote must not swallow the rest of the command and hide a later curl',
        );
    });

    await t.test('does not false-positive on a literal "curl" inside another command\'s payload/message', () => {
        assert.equal(
            isNetworkShapedCommand('git commit -m "mention curl in the message, not a real call"'),
            false,
            'curl mentioned only as quoted payload text for an unrelated command must not match',
        );
        assert.equal(
            isNetworkShapedCommand('node -e "console.log(\'curl\')"'),
            false,
        );
    });

    await t.test('does not match an unrelated command', () => {
        assert.equal(isNetworkShapedCommand('git status'), false);
        assert.equal(isNetworkShapedCommand('bd show apra-fleet-5co8.32'), false);
    });

    // apra-fleet-5co8.40 -- CURL_WGET_TOKEN_RE anchored the WHOLE token, so a
    // path-prefixed curl/wget invocation slipped past this guard to the real
    // runCmd() fallback and out to the host network. The fix matches on the
    // command BASENAME (text after the last `/` or `\`) instead.
    await t.test('matches a path-prefixed curl/wget invocation (basename match)', () => {
        assert.equal(isNetworkShapedCommand('/usr/bin/curl https://example.com/api'), true);
        assert.equal(isNetworkShapedCommand('./curl https://example.com/api'), true);
        assert.equal(isNetworkShapedCommand('C:\\Windows\\System32\\curl.exe https://example.com/api'), true);
        assert.equal(isNetworkShapedCommand('/usr/bin/wget https://example.com/file'), true);
        assert.equal(isNetworkShapedCommand('./wget https://example.com/file'), true);
        assert.equal(isNetworkShapedCommand('C:\\Windows\\System32\\wget.exe https://example.com/file'), true);
    });

    await t.test('does not false-positive on a basename that merely contains curl/wget as a substring', () => {
        assert.equal(isNetworkShapedCommand('curlybrace https://example.com'), false);
        assert.equal(isNetworkShapedCommand('wgetter https://example.com'), false);
        assert.equal(isNetworkShapedCommand('/usr/bin/curlybrace https://example.com'), false);
        assert.equal(isNetworkShapedCommand('./wgetter https://example.com'), false);
    });
});

// =============================================================================
// apra-fleet-5co8.31 -- guards the fix that widened
// redactNetworkCommandForLog() beyond its original four-shape allowlist
// (-u user:token, Authorization: Bearer|Basic <t>, URL userinfo,
// token=/access_token=) to also redact:
//   - any -H/--header '<name>: <value>' whose header name looks
//     credential-shaped (token/auth/key/secret), not just Authorization --
//     e.g. GitLab's PRIVATE-TOKEN or a generic X-Api-Key.
//   - a "token"/"password" JSON field carried in a -d/--data body.
// The guard this feeds (mock-sprint-harness.mjs's unmocked network-command
// error) fires precisely when an UNKNOWN provider/endpoint was added
// without a mock, so the whole point is to catch a credential shape NOT
// already on the list -- these tests pin exactly that class of shape.
// =============================================================================

test('redactNetworkCommandForLog', async (t) => {
    await t.test('still redacts the original four shapes (regression)', () => {
        assert.equal(
            redactNetworkCommandForLog("curl -u :abc123PAT https://dev.azure.com/x"),
            "curl -u :***REDACTED*** https://dev.azure.com/x",
        );
        assert.equal(
            redactNetworkCommandForLog("curl -H 'Authorization: Bearer ghp_secrettoken' https://api.github.com"),
            "curl -H 'Authorization: ***REDACTED***' https://api.github.com",
        );
        assert.equal(
            redactNetworkCommandForLog("curl https://user:hunter2@example.com/repo.git"),
            "curl https://user:***REDACTED***@example.com/repo.git",
        );
        assert.equal(
            redactNetworkCommandForLog("curl https://api.example.com?access_token=abc123"),
            "curl https://api.example.com?access_token=***REDACTED***",
        );
    });

    await t.test('redacts a GitLab-style PRIVATE-TOKEN header', () => {
        assert.equal(
            redactNetworkCommandForLog("curl -H 'PRIVATE-TOKEN: XYZSECRET' https://gitlab.example.com/api"),
            "curl -H 'PRIVATE-TOKEN: ***REDACTED***' https://gitlab.example.com/api",
        );
    });

    await t.test('redacts a generic X-Api-Key header', () => {
        assert.equal(
            redactNetworkCommandForLog('curl -H "X-Api-Key: abc123secret" https://example.com/api'),
            'curl -H "X-Api-Key: ***REDACTED***" https://example.com/api',
        );
    });

    await t.test('redacts a bespoke X-...-Token header via --header', () => {
        assert.equal(
            redactNetworkCommandForLog("curl --header 'X-Custom-Token: sekrit' https://example.com/api"),
            "curl --header 'X-Custom-Token: ***REDACTED***' https://example.com/api",
        );
    });

    await t.test('does not redact an unrelated -H header', () => {
        assert.equal(
            redactNetworkCommandForLog("curl -H 'Content-Type: application/json' https://example.com/api"),
            "curl -H 'Content-Type: application/json' https://example.com/api",
        );
    });

    await t.test('redacts a "token" JSON field in a -d body', () => {
        assert.equal(
            redactNetworkCommandForLog(`curl -d '{"token":"abc123","other":"val"}' https://example.com/api`),
            `curl -d '{"token":"***REDACTED***","other":"val"}' https://example.com/api`,
        );
    });

    await t.test('redacts a "password" JSON field (with a space after the colon) in a -d body', () => {
        assert.equal(
            redactNetworkCommandForLog(`curl -d '{"password": "hunter2"}' https://example.com/api`),
            `curl -d '{"password": "***REDACTED***"}' https://example.com/api`,
        );
    });

    await t.test('does not redact an unrelated JSON field', () => {
        assert.equal(
            redactNetworkCommandForLog(`curl -d '{"note":"nothing secret here"}' https://example.com/api`),
            `curl -d '{"note":"nothing secret here"}' https://example.com/api`,
        );
    });
});

// =============================================================================
// apra-fleet-3swo.7.20 -- direct coverage for defaultMockCallTool()'s
// vcs_credential_exec branch (mockVcsCredentialExec, mock-sprint-harness.mjs),
// which apra-fleet-3swo.7.18 added and apra-fleet-3swo.7.19 migrated every
// hand-rolled per-file callTool mock onto. No production code dispatches
// vcs_credential_exec yet -- that lands with apra-fleet-3swo.7.6 -- so this
// simulator is otherwise UNREACHED by any currently-passing mock-sprint suite
// and a green suite proves nothing about it. This file drives the branch
// directly so a defect ships loud, here, rather than silently inside 7.6's
// own dispatch (which would burn a dispatch discovering it, exactly as
// apra-fleet-3swo.7.6's own history already did once for the sibling
// production defect this simulator exists to pre-empt).
//
// Every test below builds its OWN buildMockFleetApi(...) instance (a fresh
// tempDir string, epic bead stub, dispatched/commandLog arrays) and threads
// its `executeCommand` into defaultMockCallTool({ executeCommand }) -- the
// exact wiring contract mock-sprint-harness.mjs's own two internal call
// sites (runOnce/runDevelopLoopScenario) and every test apra-fleet-3swo.7.19
// migrated now use. `tempDir` is a bare string, never actually created on
// disk: every command this file dispatches is a curl POST /pulls (matched by
// buildMockFleetApi's own dedicated handler) or a custom in-file echo stub
// (property 4) -- neither ever reaches buildMockFleetApi's runCmd()
// fallback, so no real bd process, filesystem, or network call happens
// anywhere in this file (acceptance criterion e).
// =============================================================================

const TEMP_DIR = '/tmp/apra-fleet-vcs-credential-exec-test-unused';
const EPIC_BEAD = { id: 'bd-1-epic' };

function freshMockFleetApi(options = {}) {
    const dispatched = [];
    const commandLog = [];
    const mockFleetApi = buildMockFleetApi(TEMP_DIR, EPIC_BEAD, dispatched, commandLog, options);
    return { mockFleetApi, dispatched, commandLog };
}

// A GitHub create-pull-request-shaped command: matches buildMockFleetApi's
// `curl -sS -X POST ... /pulls` dedicated handler (mock-sprint-harness.mjs),
// so it is answered by that canned/queued response rather than falling
// through to a real exec(). `{{vcs_token}}` is placed OUTSIDE any quotes (as
// its own standalone arg) and `{{vcs_token_inline}}` is placed INSIDE the
// caller's own single quotes -- exactly the two placement contracts
// src/tools/vcs-credential-exec.ts documents.
function buildCreatePrCommand({ head = 'test-branch', includeBare = true, includeInline = true } = {}) {
    const parts = ['curl -sS -X POST'];
    if (includeInline) parts.push(`-H 'Authorization: Bearer {{vcs_token_inline}}'`);
    if (includeBare) parts.push('-d {{vcs_token}}');
    parts.push(`-w '\n%{http_code}' https://api.github.com/repos/mock-org/mock-repo/pulls`);
    // `head` is folded into the command text only so a scenario asserting on
    // it later (none here) could; unused otherwise, but keeps this builder
    // reusable without a second near-duplicate.
    void head;
    return parts.join(' ');
}

// -----------------------------------------------------------------------
// Property 1: placeholder asymmetry.
// -----------------------------------------------------------------------
test('placeholder asymmetry: {{vcs_token}} substitutes a shell-quoted token, {{vcs_token_inline}} substitutes a bare one, and both in one command each get their own treatment', async () => {
    const { mockFleetApi, commandLog } = freshMockFleetApi();
    const callTool = defaultMockCallTool({ executeCommand: mockFleetApi.executeCommand });

    await callTool('vcs_credential_exec', {
        command: buildCreatePrCommand({ includeInline: false }),
        label: 'github',
        member_name: 'local',
    });
    const bareDispatched = commandLog.at(-1);
    // Falsified: swapping the two replaceAll() lines in mockVcsCredentialExec
    // (mock-sprint-harness.mjs) -- so the BARE placeholder gets the INNER
    // (unquoted) escaping instead of the full shell-quoted one -- was applied
    // locally and re-run; this assertion went red (`-d mock-vcs-module-token`
    // with no surrounding quotes, not `-d 'mock-vcs-module-token'`), then the
    // swap was reverted (not committed). Confirms this is not vacuous.
    assert.match(bareDispatched, /-d 'mock-vcs-module-token'/, `expected {{vcs_token}} to substitute a fully shell-quoted token, got: ${bareDispatched}`);

    await callTool('vcs_credential_exec', {
        command: buildCreatePrCommand({ includeBare: false }),
        label: 'github',
        member_name: 'local',
    });
    const inlineDispatched = commandLog.at(-1);
    // Falsified (same swap as above, other direction): the INLINE placeholder
    // would instead get the fully-quoted escaping, producing `Bearer
    // 'mock-vcs-module-token'` (an extra, unwanted quote pair inside the
    // caller's own quotes) instead of the bare `Bearer mock-vcs-module-token`
    // this asserts -- observed red under the swap, reverted after.
    assert.match(inlineDispatched, /Authorization: Bearer mock-vcs-module-token'/, `expected {{vcs_token_inline}} to substitute bare (no quotes of its own), got: ${inlineDispatched}`);
    assert.doesNotMatch(inlineDispatched, /Bearer 'mock-vcs-module-token'/, `expected NO extra quote pair around the inline substitution, got: ${inlineDispatched}`);

    await callTool('vcs_credential_exec', {
        command: buildCreatePrCommand(),
        label: 'github',
        member_name: 'local',
    });
    const bothDispatched = commandLog.at(-1);
    assert.match(bothDispatched, /Authorization: Bearer mock-vcs-module-token'/, `expected the inline half of the combined command to stay bare, got: ${bothDispatched}`);
    assert.match(bothDispatched, /-d 'mock-vcs-module-token'/, `expected the bare half of the combined command to stay quoted, got: ${bothDispatched}`);
});

// -----------------------------------------------------------------------
// Property 2: real-tool field parity.
// -----------------------------------------------------------------------
test('real-tool field parity: structuredContent carries exactly the nine fields execResult() emits (src/tools/vcs-credential-exec.ts:147-161)', async () => {
    const { mockFleetApi } = freshMockFleetApi();
    const callTool = defaultMockCallTool({ executeCommand: mockFleetApi.executeCommand });

    const res = await callTool('vcs_credential_exec', {
        command: buildCreatePrCommand(),
        label: 'github',
        member_id: 'mem-1',
        member_name: 'local',
    });

    const EXPECTED_FIELDS = ['ok', 'reason', 'exitCode', 'stdout', 'stderr', 'tokenRedactions', 'credentialLabel', 'memberId', 'memberName'];
    const actualFields = Object.keys(res.structuredContent);
    assert.deepEqual(
        [...actualFields].sort(),
        [...EXPECTED_FIELDS].sort(),
        `expected exactly the real tool's nine structuredContent fields (key SET, order-independent), got: ${JSON.stringify(actualFields)}`,
    );
});

// -----------------------------------------------------------------------
// Property 3: delegation is real.
// -----------------------------------------------------------------------
test('delegation is real: a GitHub create-PR command routed through the simulator lands in the mock fleet api commandLog with its placeholder substituted, and prCurlResponseQueue answers it', async () => {
    const prUrl = 'https://github.com/mock-org/mock-repo/pull/777';
    const { mockFleetApi, commandLog } = freshMockFleetApi({
        prCurlResponseQueue: [{ status: 201, body: { number: 777, html_url: prUrl } }],
    });
    const callTool = defaultMockCallTool({ executeCommand: mockFleetApi.executeCommand });

    const res = await callTool('vcs_credential_exec', {
        command: buildCreatePrCommand({ includeBare: false }),
        label: 'github',
        member_name: 'local',
    });

    // The command genuinely reached the mock fleet api's own executeCommand
    // (not a canned response fabricated inside mockVcsCredentialExec itself):
    // it is recorded in commandLog, substituted, never carrying the
    // placeholder literal.
    assert.ok(
        commandLog.some((c) => c.includes('/pulls') && c.includes('Bearer mock-vcs-module-token') && !c.includes('{{vcs_token')),
        `expected the substituted create-PR command to appear in commandLog, got: ${JSON.stringify(commandLog)}`,
    );
    // Falsified: temporarily made mockVcsCredentialExec return a canned
    // success WITHOUT calling `executeCommand` at all (skipping STEP 3's
    // dispatch) -- both assertions in this test went red (commandLog stayed
    // empty; res.structuredContent.stdout never carried the queued 777/
    // prUrl body), proving this test cannot pass on a stubbed, non-dispatching
    // simulator. Reverted after observing the failure (not committed).
    assert.match(
        res.structuredContent.stdout,
        /"number":777/,
        `expected prCurlResponseQueue's canned response to come back through the tool result, got: ${res.structuredContent.stdout}`,
    );
    assert.equal(res.structuredContent.exitCode, 0);
});

// -----------------------------------------------------------------------
// Property 4: redaction.
// -----------------------------------------------------------------------
test('redaction: a dispatched command that echoes the credential back in stdout is redacted, with a nonzero tokenRedactions count', async () => {
    // buildMockFleetApi's own executeCommand never echoes a dispatched
    // command's own content back into stdout (its curl-POST-/pulls handler
    // always answers a FIXED canned/queued JSON body, independent of what
    // the command text was) -- so redaction has nothing to prove against it.
    // A minimal custom executeCommand stands in here instead, echoing the
    // (already-substituted) command straight back as stdout -- exactly the
    // shape a real `curl -v`/git error that quotes its own invocation would
    // produce, which is the live hazard tokenRedactions/redaction exists to
    // catch.
    const commandLog = [];
    const echoingExecuteCommand = async (opts) => {
        commandLog.push(opts.command);
        return { structuredContent: { exitCode: 0, stdout: opts.command, stderr: '' } };
    };
    const callTool = defaultMockCallTool({ executeCommand: echoingExecuteCommand });

    const res = await callTool('vcs_credential_exec', {
        command: buildCreatePrCommand({ includeInline: false }),
        label: 'github',
        member_name: 'local',
    });

    assert.doesNotMatch(res.structuredContent.stdout, /mock-vcs-module-token/, `expected no plaintext token in the returned stdout, got: ${res.structuredContent.stdout}`);
    assert.match(res.structuredContent.stdout, /\[REDACTED:vcs_token\]/, `expected a redaction marker in place of the token, got: ${res.structuredContent.stdout}`);
    assert.ok(res.structuredContent.tokenRedactions > 0, `expected a nonzero tokenRedactions count, got: ${res.structuredContent.tokenRedactions}`);
});

// -----------------------------------------------------------------------
// Property 5: label discrimination.
// -----------------------------------------------------------------------
test('label discrimination: github and azure-devops resolve to distinct mock tokens, and an unrecognised label fails rather than substituting an empty token', async () => {
    const { mockFleetApi, commandLog } = freshMockFleetApi();
    const callTool = defaultMockCallTool({ executeCommand: mockFleetApi.executeCommand });

    await callTool('vcs_credential_exec', {
        command: buildCreatePrCommand({ includeInline: false }),
        label: 'github',
        member_name: 'local',
    });
    await callTool('vcs_credential_exec', {
        command: buildCreatePrCommand({ includeInline: false }),
        label: 'azure-devops',
        member_name: 'local',
    });

    // Falsified: temporarily made the azure-devops entry in
    // MOCK_VCS_CREDENTIAL_TOKENS (mock-sprint-harness.mjs) equal to the
    // github entry's value ('mock-vcs-module-token') -- this pair of
    // assertions went red (both dispatched commands carried the SAME token,
    // so the "distinct" expectation failed), proving the label lookup is
    // actually exercised rather than the two labels coincidentally producing
    // the same answer. Reverted after observing the failure (not committed).
    assert.ok(commandLog.some((c) => c.includes('mock-vcs-module-token')), `expected the github-labelled call to carry its own token, got: ${JSON.stringify(commandLog)}`);
    assert.ok(commandLog.some((c) => c.includes('mock-azure-devops-pat')), `expected the azure-devops-labelled call to carry its OWN, distinct token, got: ${JSON.stringify(commandLog)}`);
    assert.ok(
        !commandLog.some((c) => c.includes('mock-vcs-module-token') && c.includes('mock-azure-devops-pat')),
        'sanity: no single dispatched command should ever carry BOTH labels\' tokens',
    );

    const badRes = await callTool('vcs_credential_exec', {
        command: buildCreatePrCommand({ includeInline: false }),
        label: 'bitbucket',
        member_name: 'local',
    });
    assert.equal(badRes.structuredContent.ok, false, `expected an unrecognised label to fail (ok:false), got: ${JSON.stringify(badRes.structuredContent)}`);
    assert.equal(badRes.structuredContent.reason, 'credential_read_failed', `expected reason 'credential_read_failed' for an unrecognised label, got: ${badRes.structuredContent.reason}`);
    assert.doesNotMatch(badRes.structuredContent.stdout ?? '', /\S/, 'expected no substituted/empty-token command to have been dispatched for an unrecognised label');
});

// -----------------------------------------------------------------------
// Property 6: backward compatibility.
// -----------------------------------------------------------------------
test('backward compatibility: defaultMockCallTool() invoked with no argument still answers member_detail, provision_vcs_auth, child_id_allocator and dolt_push_mutex exactly as before', async () => {
    const callTool = defaultMockCallTool();

    const memberDetail = await callTool('member_detail', {});
    assert.deepEqual(JSON.parse(memberDetail.content[0].text), { vcsProvider: 'github' });

    const provisioned = await callTool('provision_vcs_auth', { provider: 'github', member_name: 'local' });
    assert.match(provisioned.content[0].text, /^\[OK\] Mock github credentials deployed on "local"/);
    assert.match(provisioned.content[0].text, /expiresAt:/);
    assert.equal(provisioned.structuredContent.ok, true);
    assert.equal(provisioned.structuredContent.reason, 'ok');

    const allocate = await callTool('child_id_allocator', { action: 'allocate' });
    assert.deepEqual(JSON.parse(allocate.content[0].text), { childId: null, token: null });
    const release = await callTool('child_id_allocator', { action: 'release' });
    assert.deepEqual(JSON.parse(release.content[0].text), { confirmed: true, released: true });

    const acquire = await callTool('dolt_push_mutex', { action: 'acquire' });
    const acquireParsed = JSON.parse(acquire.content[0].text);
    assert.equal(acquireParsed.granted, true);
    assert.equal(typeof acquireParsed.token, 'string');
    const releaseMutex = await callTool('dolt_push_mutex', { action: 'release' });
    assert.deepEqual(JSON.parse(releaseMutex.content[0].text), { released: true });
});
