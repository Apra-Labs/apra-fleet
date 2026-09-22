import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { raiseVcsPrForMember } from '../fleet-sprint/vcs-auth.mjs';

// apra-fleet-j918.8.10: raiseVcsPrForMember (fleet-sprint/vcs-auth.mjs:603)
// had NO direct test anywhere in the suite -- only comments referencing it
// and indirect exercise through the full mock-sprint scenario apparatus.
// These tests drive it directly with a minimal fake fleetApi/command, and
// assert on its RETURNED VALUES (never source text), matching the contract
// documented on the function itself: { ok, alreadyExists, prUrl, error,
// authFailure }.
//
// Response shapes mirror the real collaborators exactly:
//   - fleetApi.memberDetail() -> VCSModule.resolveProvider() /
//     resolveMemberTarget() (member-target.mjs) both read
//     { content: [{ text: JSON.stringify({ vcsProvider, os, shell }) }] }.
//   - fleetApi.provisionVcsAuth() -> provisionOutcome() reads
//     structuredContent.ok (apra-fleet-3swo.13).
//   - fleetApi.vcsCredentialExec() -> structuredContent shape is
//     { ok, reason, exitCode, stdout, stderr } (src/tools/vcs-credential-exec.ts);
//     `stdout` is "<json body>\n<http status>" because VCSModule's
//     buildCreatePrCommand always appends `-w '\n%{http_code}'`
//     (parseVcsCurlOutput in vcs-auth.mjs).

function memberDetailResult() {
    return { content: [{ text: JSON.stringify({ vcsProvider: 'github', os: 'linux', shell: '' }) }] };
}

function credExecResult({ status, body, ok = true, reason = 'ok' }) {
    return {
        content: [{ text: '' }],
        structuredContent: {
            ok, reason, exitCode: 0,
            stdout: `${JSON.stringify(body)}\n${status}`,
            stderr: '',
        },
    };
}

// Real command() mock: only 'git remote get-url origin' is ever dispatched by
// this call path (provisionVcsAuthForMember derives `repos`/`repo` from it).
const command = async (cmd) => {
    if (cmd === 'git remote get-url origin') {
        return { ok: true, output: 'https://github.com/acme/widgets.git', error: null };
    }
    return { ok: true, output: '', error: null };
};

function makeFleetApi({ vcsCredentialExecImpl, provisionOk = true }) {
    const provisionCalls = [];
    const vcsCredentialExecCalls = [];
    return {
        provisionCalls,
        vcsCredentialExecCalls,
        async memberDetail() {
            return memberDetailResult();
        },
        async provisionVcsAuth(args) {
            provisionCalls.push(args);
            return {
                content: [{ text: provisionOk ? 'ok' : '[FAIL] boom' }],
                structuredContent: { ok: provisionOk, expiresAt: null },
            };
        },
        async vcsCredentialExec(args) {
            vcsCredentialExecCalls.push(args);
            return vcsCredentialExecImpl(args, vcsCredentialExecCalls.length);
        },
    };
}

describe('raiseVcsPrForMember (fleet-sprint/vcs-auth.mjs)', () => {
    test('a 2xx PR-creation response returns ok:true with the prUrl mapped from the body (GitHub html_url)', async () => {
        const fleetApi = makeFleetApi({
            vcsCredentialExecImpl: () => credExecResult({
                status: 201,
                body: { number: 42, html_url: 'https://github.com/acme/widgets/pull/42' },
            }),
        });
        const res = await raiseVcsPrForMember({
            fleetApi, command, member: 'fleet-raise-pr-success', base: 'main', head: 'feat/x', title: 't', body: 'b', logPrefix: 'test',
        });
        assert.deepEqual(res, { ok: true, alreadyExists: false, prUrl: 'https://github.com/acme/widgets/pull/42', error: null, authFailure: false });
        assert.equal(fleetApi.provisionCalls.length, 1, 'exactly one provision call for a first-attempt success');
        assert.equal(fleetApi.vcsCredentialExecCalls.length, 1, 'exactly one PR-creation dispatch for a first-attempt success');
    });

    test('a 422 "already exists" response is idempotent success, with the existing PR URL extracted from the error text', async () => {
        const fleetApi = makeFleetApi({
            vcsCredentialExecImpl: () => credExecResult({
                status: 422,
                body: {
                    message: 'Validation Failed',
                    errors: [{ message: 'A pull request already exists for acme:feat/x. See https://github.com/acme/widgets/pull/7.' }],
                },
            }),
        });
        const res = await raiseVcsPrForMember({
            fleetApi, command, member: 'fleet-raise-pr-exists', base: 'main', head: 'feat/x', title: 't', body: 'b', logPrefix: 'test',
        });
        assert.equal(res.ok, true);
        assert.equal(res.alreadyExists, true);
        assert.equal(res.prUrl, 'https://github.com/acme/widgets/pull/7');
        assert.equal(res.authFailure, false);
    });

    test('a 401 "Bad credentials" response self-heals once (re-provisions) and retries, succeeding on the retry', async () => {
        const fleetApi = makeFleetApi({
            vcsCredentialExecImpl: (args, callNum) => (callNum === 1
                ? credExecResult({ status: 401, body: { message: 'Bad credentials' } })
                : credExecResult({ status: 201, body: { number: 9, html_url: 'https://github.com/acme/widgets/pull/9' } })),
        });
        const res = await raiseVcsPrForMember({
            fleetApi, command, member: 'fleet-raise-pr-selfheal', base: 'main', head: 'feat/y', title: 't', body: 'b', logPrefix: 'test',
        });
        assert.equal(res.ok, true);
        assert.equal(res.prUrl, 'https://github.com/acme/widgets/pull/9');
        assert.equal(res.authFailure, false);
        assert.equal(fleetApi.provisionCalls.length, 2, 'expected the initial provision plus exactly one self-heal re-provision');
        assert.equal(fleetApi.vcsCredentialExecCalls.length, 2, 'expected the original attempt plus exactly one retry (bounded one-shot)');
    });

    test('a 401 that persists through the self-heal retry returns ok:false, authFailure:true, and does not retry a second time', async () => {
        const fleetApi = makeFleetApi({
            vcsCredentialExecImpl: () => credExecResult({ status: 401, body: { message: 'Bad credentials' } }),
        });
        const res = await raiseVcsPrForMember({
            fleetApi, command, member: 'fleet-raise-pr-selfheal-fails', base: 'main', head: 'feat/y2', title: 't', body: 'b', logPrefix: 'test',
        });
        assert.equal(res.ok, false);
        assert.equal(res.authFailure, true);
        assert.match(res.error, /401/);
        assert.equal(fleetApi.vcsCredentialExecCalls.length, 2, 'bounded one-shot: original attempt plus exactly one retry, never more');
    });

    test('a non-auth failure (500) returns ok:false, authFailure:false, and is never retried', async () => {
        const fleetApi = makeFleetApi({
            vcsCredentialExecImpl: () => credExecResult({ status: 500, body: { message: 'Internal Server Error' } }),
        });
        const res = await raiseVcsPrForMember({
            fleetApi, command, member: 'fleet-raise-pr-500', base: 'main', head: 'feat/z', title: 't', body: 'b', logPrefix: 'test',
        });
        assert.equal(res.ok, false);
        assert.equal(res.authFailure, false);
        assert.match(res.error, /500/);
        assert.equal(fleetApi.vcsCredentialExecCalls.length, 1, 'a non-auth failure must not trigger a self-heal retry');
    });

    test('FALSIFICATION: a provider response-mapping regression (wrong URL field) is caught -- flips the success test red', async () => {
        // Proves the success test above is not vacuous: simulate what a
        // provider-mapping bug would produce (the PR URL under the WRONG
        // field name, e.g. a hypothetical rename of html_url) and confirm
        // raiseVcsPrForMember reports prUrl: null instead of silently
        // passing.
        const fleetApi = makeFleetApi({
            vcsCredentialExecImpl: () => credExecResult({
                status: 201,
                body: { number: 42, wrong_url_field: 'https://github.com/acme/widgets/pull/42' },
            }),
        });
        const res = await raiseVcsPrForMember({
            fleetApi, command, member: 'fleet-raise-pr-falsify', base: 'main', head: 'feat/x', title: 't', body: 'b', logPrefix: 'test',
        });
        assert.equal(res.ok, true);
        assert.notEqual(res.prUrl, 'https://github.com/acme/widgets/pull/42', 'a response missing the real url field must NOT yield the expected prUrl -- if it does, the mapping assertion above is not exercising real behavior');
        assert.equal(res.prUrl, null);
    });
});
