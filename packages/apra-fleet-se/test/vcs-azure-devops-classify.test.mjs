import { test, describe } from 'node:test';
import assert from 'node:assert';
import { classifyFailure, toGitVerdict } from '../fleet-sprint/vcs-module.mjs';
import { VCS_FAILURE_KINDS as K } from '../fleet-sprint/errors.mjs';

// apra-fleet-5co8.4.1 -- kind-level coverage for the Azure DevOps auth rules.
//
// WHY A CLASSIFY-LEVEL SUITE AND NOT AN END-TO-END ONE: toGitVerdict()
// collapses AUTH_EXPIRED and AUTH_DENIED to the single 'auth' verdict, so the
// existing real-bd end-to-end assertion in vcs-nongithub-auth-selfheal.test.mjs
// would stay green even if one of these rules flipped kind. The kind IS the
// remedy split (re-mint the PAT vs widen its scopes), so it has to be pinned
// here, one assertion per rule.
//
// Every sample below is DELIBERATELY BARE of git's own "fatal: Authentication
// failed" tail. classifyFailure() iterates KIND_PRECEDENCE in the outer loop
// and the provider chain in the inner loop (vcs-module.mjs), so generic-git's
// inherited /Authentication failed/i AUTH_EXPIRED rule outranks azure-devops'
// own TF401019 AUTH_DENIED rule whenever real stderr carries both signals.
// That precedence predates this task and is NOT changed by it -- the samples
// stay bare so each assertion pins the Azure rule it names rather than the
// inherited one.
//
// The trailing-status-line samples model VCSModule's curl convention
// (`-w '\n%{http_code}'`, same as github.mjs), i.e. a status-code-only LAST
// line. Pure/deterministic: no I/O anywhere in this suite.

const AZ = { provider: 'azure-devops' };

describe('azure-devops auth classification (apra-fleet-5co8.4.1)', () => {
    test('bare TF401019 still classifies AUTH_DENIED', () => {
        const raw = 'remote: TF401019: The Git repository with name or identifier fleet-e2e-toy does not exist, or you do not have permission to perform this operation.';
        const res = classifyFailure(raw, AZ);
        assert.equal(res.kind, K.AUTH_DENIED);
        assert.equal(res.providerCode, 'TF401019');
    });

    test('TF400813 classifies AUTH_EXPIRED (expired/revoked PAT -- re-mint)', () => {
        const raw = 'remote: TF400813: The user \'\' is not authorized to access this resource.';
        const res = classifyFailure(raw, AZ);
        assert.equal(res.kind, K.AUTH_EXPIRED);
        assert.equal(res.providerCode, 'TF400813');
    });

    test('a trailing REST 401 status line classifies AUTH_EXPIRED', () => {
        // The sample carries no TF code, so providerCode must come from the
        // trailing-status-line fallback rather than from a TF match.
        const res = classifyFailure('{"message":"Unauthorized"}\n401', AZ);
        assert.equal(res.kind, K.AUTH_EXPIRED);
        assert.equal(res.providerCode, '401');
    });

    test('a trailing REST 403 status line classifies AUTH_DENIED (missing scope -- widen)', () => {
        const res = classifyFailure('{"message":"Forbidden"}\n403', AZ);
        assert.equal(res.kind, K.AUTH_DENIED);
        assert.equal(res.providerCode, '403');
    });

    test('an inline mid-sentence 401/403 is NOT matched by the anchored rules', () => {
        for (const raw of [
            'note: a 401 response can also mean the organization URL is wrong',
            'hint: the 403 code in the scope table refers to Code (Read) only',
        ]) {
            const res = classifyFailure(raw, AZ);
            assert.equal(res.kind, K.UNKNOWN, `inline status must not classify: ${raw}`);
            assert.equal(res.providerCode, null);
        }
    });

    test('toGitVerdict still collapses both azure auth kinds to auth', () => {
        assert.equal(toGitVerdict(K.AUTH_EXPIRED), 'auth');
        assert.equal(toGitVerdict(K.AUTH_DENIED), 'auth');
        for (const raw of [
            'remote: TF401019: ... does not exist, or you do not have permission ...',
            'remote: TF400813: The user is not authorized to access this resource.',
            '{"message":"Unauthorized"}\n401',
            '{"message":"Forbidden"}\n403',
        ]) {
            assert.equal(toGitVerdict(classifyFailure(raw, AZ).kind), 'auth', raw);
        }
    });
});
