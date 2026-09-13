import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultMockCallTool, buildMockFleetApi } from './helpers/mock-sprint-harness.mjs';

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
