import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    VCSModule,
    resolveProvider,
    classifyFailure,
    buildCreatePrCommand,
    capabilities,
    registerVcsProvider,
    unregisterVcsProvider,
    listVcsProviders,
    listVcsAuthProviders,
} from '../fleet-sprint/vcs-module.mjs';
import { VCS_FAILURE_KINDS as K } from '../fleet-sprint/errors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VCS_MODULE_PATH = path.join(__dirname, '../fleet-sprint/vcs-module.mjs');

// =============================================================================
// apra-fleet-647.1.5.2 -- a synthetic VCS provider works end-to-end with zero
// edits outside vcs-providers/ (and this test file itself).
//
// The provider descriptor below is a THROWAWAY -- defined entirely inside this
// test file, registered at runtime via registerVcsProvider(), and unregistered
// in a `finally` so it can never leak into a later test. No file under
// fleet-sprint/vcs-providers/ is added or edited to make this suite pass; that
// is the whole point of the extension contract apra-fleet-647.1.5.1 built.
// =============================================================================

const SYNTHETIC_NAME = 'test-synthetic-vcs';

function makeSyntheticProvider() {
    return {
        name: SYNTHETIC_NAME,
        extends: 'generic-git',
        // Its OWN classification rule, checked before the inherited generic set.
        rules: {
            [K.AUTH_DENIED]: [/SYNTH_ACCESS_REFUSED/],
        },
        extractProviderCode(raw) {
            const m = String(raw == null ? '' : raw).match(/SYNTH-(\d+)/);
            return m ? m[1] : null;
        },
        matchesHost(host) {
            return typeof host === 'string' && /synth-vcs\.example/i.test(host);
        },
        capabilitiesForHost(_host) {
            return { canOpenPullRequest: true };
        },
        // Declaring defaultAuthMode (even non-null) is what makes this an
        // auth-backend provider in resolveProvider()'s/buildVcsCommand()'s
        // known vocabulary -- see vcs-providers/index.mjs isAuthBackend().
        defaultAuthMode: 'synthetic-token',
        builders: {
            'create-pull-request': ({ repo, base, head, title, token }) => {
                if (!token) throw new Error('ERROR: VCSModule: no token supplied for synthetic provider.');
                const command = `synthetic-cli pr create --repo ${repo} --base ${base} --head ${head} --title "${title}" --token ${token}`;
                const logSafeCommand = command.replace(token, '***REDACTED***');
                return {
                    provider: SYNTHETIC_NAME,
                    action: 'create-pull-request',
                    command,
                    logSafeCommand,
                    interpret: { successStatusRange: [200, 299] },
                };
            },
        },
    };
}

describe('synthetic VCS provider -- end-to-end with zero edits outside vcs-providers/', () => {
    test('resolveProvider() accepts a member registered to the synthetic provider and returns ITS OWN defaultAuthMode', async () => {
        registerVcsProvider(makeSyntheticProvider());
        try {
            const fleetApi = {
                memberDetail: async () => ({ content: [{ text: JSON.stringify({ vcsProvider: SYNTHETIC_NAME }) }] }),
            };
            const result = await resolveProvider('fleet-synth', { fleetApi });
            assert.deepEqual(result, { provider: SYNTHETIC_NAME, authMode: 'synthetic-token' });
        } finally {
            unregisterVcsProvider(SYNTHETIC_NAME);
        }
    });

    test('classifyFailure() applies the synthetic provider\'s own rules/precedence to produce a neutral kind', () => {
        registerVcsProvider(makeSyntheticProvider());
        try {
            // Its own pattern wins...
            const own = classifyFailure('remote refused: SYNTH_ACCESS_REFUSED (SYNTH-42)', { provider: SYNTHETIC_NAME });
            assert.equal(own.kind, K.AUTH_DENIED);
            assert.equal(own.providerCode, '42');
            assert.equal(own.retryable, false);

            // ...and the inherited generic-git set still classifies too, with no
            // generic pattern copied into the synthetic descriptor.
            const inherited = classifyFailure('fatal: Authentication failed', { provider: SYNTHETIC_NAME });
            assert.equal(inherited.kind, K.AUTH_EXPIRED);
        } finally {
            unregisterVcsProvider(SYNTHETIC_NAME);
        }
    });

    test('buildCreatePrCommand()/capabilities() dispatch to the synthetic provider\'s own builders', () => {
        registerVcsProvider(makeSyntheticProvider());
        try {
            const result = buildCreatePrCommand({
                provider: SYNTHETIC_NAME,
                repo: 'acme/widgets',
                base: 'main',
                head: 'feature-x',
                title: 'synthetic PR',
                token: 'synth-secret-tok',
            });
            assert.equal(result.provider, SYNTHETIC_NAME);
            assert.equal(result.action, 'create-pull-request');
            assert.ok(result.command.includes('synth-secret-tok'));
            assert.ok(!result.logSafeCommand.includes('synth-secret-tok'));

            const caps = capabilities('https://synth-vcs.example/acme/widgets.git');
            assert.deepEqual(caps, { hasRemote: true, canOpenPullRequest: true, host: 'synth-vcs.example' });
        } finally {
            unregisterVcsProvider(SYNTHETIC_NAME);
        }
    });

    test('teardown: unregisterVcsProvider() removes the synthetic provider so it cannot leak into later cases', () => {
        registerVcsProvider(makeSyntheticProvider());
        assert.ok(listVcsProviders().includes(SYNTHETIC_NAME));
        unregisterVcsProvider(SYNTHETIC_NAME);
        assert.ok(!listVcsProviders().includes(SYNTHETIC_NAME));
        assert.ok(!listVcsAuthProviders().includes(SYNTHETIC_NAME));
    });

    // -------------------------------------------------------------------------
    // (2) Single-manifest assertion: listVcsProviders() and the vocabulary
    // resolveProvider() validates against (listVcsAuthProviders()) are the SAME
    // set -- an unregistered name is rejected, and the synthetic name is
    // accepted without editing vcs-module.mjs.
    // -------------------------------------------------------------------------
    describe('single-manifest assertion', () => {
        test('an unregistered provider name is rejected by resolveProvider()', async () => {
            const fleetApi = {
                memberDetail: async () => ({ content: [{ text: JSON.stringify({ vcsProvider: 'not-a-real-provider' }) }] }),
            };
            await assert.rejects(
                () => resolveProvider('fleet-x', { fleetApi }),
                (err) => {
                    assert.match(err.message, /^ERROR:/);
                    assert.match(err.message, /not a real provider|no registered VCS provider/);
                    return true;
                },
            );
        });

        test('the synthetic name is accepted the instant it is registered, with no edit to vcs-module.mjs', async () => {
            assert.ok(!listVcsProviders().includes(SYNTHETIC_NAME), 'must not be registered before this test');
            registerVcsProvider(makeSyntheticProvider());
            try {
                assert.ok(listVcsProviders().includes(SYNTHETIC_NAME));
                assert.ok(listVcsAuthProviders().includes(SYNTHETIC_NAME), 'declaring defaultAuthMode makes it part of the known vocabulary');

                const fleetApi = {
                    memberDetail: async () => ({ content: [{ text: JSON.stringify({ vcsProvider: SYNTHETIC_NAME }) }] }),
                };
                const result = await resolveProvider('fleet-synth', { fleetApi });
                assert.equal(result.provider, SYNTHETIC_NAME);
            } finally {
                unregisterVcsProvider(SYNTHETIC_NAME);
            }
        });

        test('listVcsProviders() (the registry) and listVcsAuthProviders() (resolveProvider()\'s known vocabulary) never drift apart for the synthetic provider', () => {
            registerVcsProvider(makeSyntheticProvider());
            try {
                assert.ok(listVcsProviders().includes(SYNTHETIC_NAME));
                assert.ok(listVcsAuthProviders().includes(SYNTHETIC_NAME));
            } finally {
                unregisterVcsProvider(SYNTHETIC_NAME);
            }
            assert.ok(!listVcsProviders().includes(SYNTHETIC_NAME));
            assert.ok(!listVcsAuthProviders().includes(SYNTHETIC_NAME));
        });
    });

    // -------------------------------------------------------------------------
    // (3) Source assertion: vcs-module.mjs contains no provider-name-keyed
    // object literal -- DEFAULT_AUTH_MODES and BUILDERS are gone, and no
    // 'github'/'bitbucket'/'azure-devops' lookup key remains.
    // -------------------------------------------------------------------------
    describe('source assertion', () => {
        const src = fs.readFileSync(VCS_MODULE_PATH, 'utf8');

        test('DEFAULT_AUTH_MODES and BUILDERS tables are gone from vcs-module.mjs', () => {
            assert.ok(!/\bDEFAULT_AUTH_MODES\b/.test(src), 'DEFAULT_AUTH_MODES must not exist in vcs-module.mjs');
            assert.ok(!/\bBUILDERS\b/.test(src), 'BUILDERS must not exist in vcs-module.mjs');
        });

        test('no github/bitbucket/azure-devops provider-name-keyed object literal remains', () => {
            const lookupKeyPattern = /['"]?\b(github|bitbucket|azure-devops)\b['"]?\s*:\s*[{[]/;
            assert.ok(
                !lookupKeyPattern.test(src),
                'vcs-module.mjs must not contain a provider-name-keyed object literal for github/bitbucket/azure-devops',
            );
        });
    });

    // -------------------------------------------------------------------------
    // (4) Regression: a github-registered member still resolves exactly as
    // before, buildCreatePrCommand()'s github output is unchanged, and every
    // previously-asserted classifyFailure verdict still holds -- registering
    // and tearing down the synthetic provider around these assertions changes
    // nothing about github's own behavior.
    // -------------------------------------------------------------------------
    describe('regression: github is unaffected by the synthetic provider\'s presence', () => {
        test('a github-registered member still resolves {provider: "github", authMode: "github-app"}', async () => {
            registerVcsProvider(makeSyntheticProvider());
            try {
                const fleetApi = {
                    memberDetail: async () => ({ content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] }),
                };
                const result = await resolveProvider('fleet-mac', { fleetApi });
                assert.deepEqual(result, { provider: 'github', authMode: 'github-app' });
            } finally {
                unregisterVcsProvider(SYNTHETIC_NAME);
            }
        });

        test('buildCreatePrCommand() output for github is unchanged', () => {
            registerVcsProvider(makeSyntheticProvider());
            try {
                const result = buildCreatePrCommand({
                    provider: 'github',
                    repo: 'Apra-Labs/apra-fleet',
                    base: 'main',
                    head: 'feature-x',
                    title: 'no change here',
                    token: 'ghs_tok',
                });
                assert.equal(result.provider, 'github');
                assert.ok(result.command.startsWith('curl -sS -X POST'));
                assert.ok(result.command.includes('https://api.github.com/repos/Apra-Labs/apra-fleet/pulls'));
            } finally {
                unregisterVcsProvider(SYNTHETIC_NAME);
            }
        });

        test('every previously-asserted classifyFailure verdict still holds with the synthetic provider registered', () => {
            registerVcsProvider(makeSyntheticProvider());
            try {
                assert.equal(classifyFailure('fatal: Authentication failed', { provider: 'github' }).kind, K.AUTH_EXPIRED);
                assert.equal(classifyFailure('git@github.com: Permission denied (publickey).', { provider: 'github' }).kind, K.AUTH_DENIED);
                assert.equal(classifyFailure('fatal: Not possible to fast-forward, aborting.', { provider: 'github' }).kind, K.DIVERGED);
                assert.equal(classifyFailure("ssh: connect to host github.com port 22: Connection timed out", { provider: 'github' }).kind, K.TRANSIENT);
                assert.equal(classifyFailure('something nobody has a pattern for', { provider: 'github' }).kind, K.UNKNOWN);
            } finally {
                unregisterVcsProvider(SYNTHETIC_NAME);
            }
        });

        test('VCSModule namespace object is unaffected', () => {
            assert.equal(VCSModule.resolveProvider, resolveProvider);
            assert.equal(VCSModule.buildCreatePrCommand, buildCreatePrCommand);
        });
    });
});
