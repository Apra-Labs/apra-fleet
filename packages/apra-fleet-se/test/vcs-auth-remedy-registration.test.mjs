import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    registerVcsProvider,
    unregisterVcsProvider,
    getVcsProvider,
} from '../fleet-sprint/vcs-providers/index.mjs';

// =============================================================================
// apra-fleet-5co8.12 -- registration-time validation for the optional
// `authRemedy` descriptor field (apra-fleet-5co8.4.2), added in commit
// 2a4d186f to registerVcsProvider() in fleet-sprint/vcs-providers/index.mjs,
// mirroring the structurally identical `pullRequestResponse` registration
// coverage in vcs-pr-response-mapping.test.mjs (apra-fleet-lzfv.4): a
// throwaway descriptor registered via registerVcsProvider and always removed
// via unregisterVcsProvider so it cannot leak into another test file.
// =============================================================================

test('registerVcsProvider: a non-object authRemedy fails at registration', () => {
    assert.throws(
        () => registerVcsProvider({ name: 'throwaway-auth-remedy', extends: 'generic-git', authRemedy: 'nope' }),
        (err) => err.message.startsWith('ERROR: VCSModule:') && /non-object `authRemedy`/.test(err.message),
    );
});

test('registerVcsProvider: a non-boolean serverSideReMintable fails at registration', () => {
    assert.throws(
        () => registerVcsProvider({
            name: 'throwaway-auth-remedy',
            extends: 'generic-git',
            authRemedy: { serverSideReMintable: 'nope', hint: 'do the thing' },
        }),
        (err) => err.message.startsWith('ERROR: VCSModule:') && /non-boolean `serverSideReMintable`/.test(err.message),
    );
});

test('registerVcsProvider: a missing or blank hint fails at registration', () => {
    for (const authRemedy of [
        { serverSideReMintable: false },
        { serverSideReMintable: false, hint: '' },
        { serverSideReMintable: false, hint: '   ' },
        { serverSideReMintable: false, hint: 42 },
    ]) {
        assert.throws(
            () => registerVcsProvider({ name: 'throwaway-auth-remedy', extends: 'generic-git', authRemedy }),
            (err) => err.message.startsWith('ERROR: VCSModule:') && /no non-empty string `hint`/.test(err.message),
            `expected the no-non-empty-string-hint error for authRemedy ${JSON.stringify(authRemedy)}`,
        );
    }
});

test('registerVcsProvider: a well-formed authRemedy descriptor registers cleanly and is removed with unregisterVcsProvider', () => {
    registerVcsProvider({
        name: 'throwaway-auth-remedy',
        extends: 'generic-git',
        authRemedy: { serverSideReMintable: false, hint: 'create a new credential and redeploy it' },
    });
    try {
        const impl = getVcsProvider('throwaway-auth-remedy');
        assert.ok(impl, 'expected the well-formed provider to be registered');
        assert.equal(impl.authRemedy.serverSideReMintable, false);
        assert.equal(impl.authRemedy.hint, 'create a new credential and redeploy it');
    } finally {
        assert.equal(unregisterVcsProvider('throwaway-auth-remedy'), true);
    }
    assert.equal(getVcsProvider('throwaway-auth-remedy'), undefined, 'the throwaway provider must not leak into another test file');
});

test('registerVcsProvider: a provider omitting authRemedy entirely registers fine (the documented "assume re-mintable" default)', () => {
    registerVcsProvider({ name: 'throwaway-auth-remedy-omitted', extends: 'generic-git' });
    try {
        const impl = getVcsProvider('throwaway-auth-remedy-omitted');
        assert.ok(impl);
        assert.equal(impl.authRemedy, undefined);
    } finally {
        assert.equal(unregisterVcsProvider('throwaway-auth-remedy-omitted'), true);
    }
});

test('registerVcsProvider: a provider declaring serverSideReMintable:true registers fine', () => {
    registerVcsProvider({
        name: 'throwaway-auth-remedy-remintable',
        extends: 'generic-git',
        authRemedy: { serverSideReMintable: true, hint: 'unused when re-mintable, but still validated' },
    });
    try {
        const impl = getVcsProvider('throwaway-auth-remedy-remintable');
        assert.ok(impl);
        assert.equal(impl.authRemedy.serverSideReMintable, true);
    } finally {
        assert.equal(unregisterVcsProvider('throwaway-auth-remedy-remintable'), true);
    }
});

// Both providers above (omitted authRemedy, serverSideReMintable:true) cause
// runner.js's createVcsAuthSelfHealCallback to log nothing extra beyond the
// base self-heal lines -- see runner.js's own guard
// `impl.authRemedy && impl.authRemedy.serverSideReMintable === false` and
// mock-sprint-vcs-selfheal-remedy.test.mjs's github-unaffected case (a
// provider with no authRemedy at all) for the end-to-end proof; this suite's
// job is only the registration-time validation.
