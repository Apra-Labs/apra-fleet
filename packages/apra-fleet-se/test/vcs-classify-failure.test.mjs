import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
    VCSModule,
    classifyFailure,
    toGitVerdict,
    registerVcsProvider,
    unregisterVcsProvider,
    listVcsProviders,
    DEFAULT_VCS_PROVIDER,
} from '../fleet-sprint/vcs-module.mjs';
import { VCS_FAILURE_KINDS as K } from '../fleet-sprint/errors.mjs';
import { classifyGitFailure } from '../fleet-sprint/runner.js';

// apra-fleet-647.1.3.1 -- VCSModule.classifyFailure: the single place VCS
// stderr is parsed, its neutral taxonomy, and the GenericGitVCS/GitHubVCS
// provider split. Pure/deterministic: no I/O anywhere in this suite.
//
// The load-bearing suite here is PARITY (AC2). runner.js's GIT_*_PATTERNS and
// dolt-sync.mjs's DOLT_AUTH_PATTERNS are plain module-level consts and are not
// exported, so the corpus below is one hand-written representative string per
// pattern, each commented with the pattern it stands for. Parity is asserted
// against the LIVE classifyGitFailure() rather than a hardcoded expectation, so
// the day apra-fleet-647.1.3.2 deletes those tables and delegates, this suite
// is what proves no verdict moved.

// --- AUTH corpus -----------------------------------------------------------
// GIT_AUTH_PATTERNS and DOLT_AUTH_PATTERNS are IDENTICAL lists of the same 8
// regexes, so this one corpus covers both. Six are portable (GenericGitVCS);
// the last two are GitHub literals (GitHubVCS).
const PORTABLE_AUTH_SAMPLES = [
    // /could not read Username for/i
    "fatal: could not read Username for 'https://github.com': No such device or address",
    // /could not read Password for/i
    "fatal: could not read Password for 'https://x-access-token@github.com': terminal prompts disabled",
    // /Authentication failed/i
    "fatal: Authentication failed for 'https://github.com/Apra-Labs/apra-fleet.git/'",
    // /Permission denied \(publickey\)/i
    'git@github.com: Permission denied (publickey).',
    // /terminal prompts disabled/i
    'fatal: could not read Username: terminal prompts disabled',
    // /support for password authentication was removed/i
    'remote: Support for password authentication was removed on August 13, 2021.',
];

const GITHUB_ONLY_AUTH_SAMPLES = [
    // /remote: Invalid username or (token|password)/i
    'remote: Invalid username or token. Password authentication is not supported for Git operations.',
    // /Bad credentials/i
    '{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest"}',
];

const ALL_AUTH_SAMPLES = [...PORTABLE_AUTH_SAMPLES, ...GITHUB_ONLY_AUTH_SAMPLES];

// --- DIVERGED corpus (one per GIT_DIVERGED_PATTERNS entry) ------------------
const DIVERGED_SAMPLES = [
    'fatal: Not possible to fast-forward, aborting.',
    'hint: Updates were rejected because a pushed branch tip is behind (non-fast-forward)',
    'error: fast-forwards are not allowed on this branch',
    ' ! [rejected]        main -> main (fetch first)',
    'error: failed to push some refs to https://github.com/Apra-Labs/apra-fleet.git',
    'hint: Updates were rejected because the remote contains work that you do not have locally.',
    'error: Pulling is not possible because you have unmerged files.',
    'error: you need to resolve your current index first: path/to/file.txt: needs merge',
    'error: Your local changes to the following files would be overwritten by merge:',
    'CONFLICT (content): Merge conflict in packages/apra-fleet-se/fleet-sprint/runner.js',
    'Automatic merge failed; fix conflicts and then commit the result.',
    "Your branch and 'origin/main' have diverged,",
];

// --- TRANSIENT corpus (one per GIT_TRANSIENT_PATTERNS entry) ----------------
const TRANSIENT_SAMPLES = [
    "fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com",
    "fatal: unable to access 'https://github.com/x/y.git/': Failed to connect",
    'ssh: connect to host github.com port 22: Connection timed out',
    'fatal: the remote end hung up unexpectedly: operation timed out',
    'error: RPC failed; curl 56 GnuTLS recv error: connection timed out',
    'fatal: protocol error: timeout waiting for the pack',
    'ssh: Could not resolve hostname github.com: Temporary failure in name resolution',
    'fatal: early EOF',
    'error: RPC failed; HTTP 502 curl 22',
    'fatal: the remote end hung up unexpectedly',
    "fatal: Unable to create '/repo/.git/index.lock': File exists.",
    "fatal: Unable to create '/repo/.git/shallow.lock': File exists.",
    'error: cannot lock ref refs/heads/main: is at 0123456 but expected 89abcde',
    'ssh_exchange_identification: Connection closed by remote host',
    'transport failure while executing command on member doer-1',
    'TypeError: fetch failed',
];

// --- Texts that are 'unknown' today and MUST stay that way ------------------
const UNKNOWN_TODAY_SAMPLES = [
    'error 1105: no remote configured for this database',   // -> NO_REMOTE
    "fatal: No such remote 'origin'",                        // -> NO_REMOTE
    'ERROR: VCSModule: unsupported VCS provider "gitea"',    // -> UNSUPPORTED_OPERATION
    'ERROR: VCSModule: provider "bitbucket" does not yet implement action "comment"',
    'error: pathspec did not match any file(s) known to git',
    'fatal: not a git repository (or any of the parent directories): .git',
    'remote: Repository not found.',
    'API rate limit exceeded for user ID 1234',
    '',
];

const PARITY_CORPUS = [
    ...ALL_AUTH_SAMPLES,
    ...DIVERGED_SAMPLES,
    ...TRANSIENT_SAMPLES,
    ...UNKNOWN_TODAY_SAMPLES,
];

describe('VCSModule.classifyFailure -- parity with runner.js classifyGitFailure (AC2)', () => {
    test('every corpus sample maps to the SAME verdict as the live classifier (github)', () => {
        for (const sample of PARITY_CORPUS) {
            const { kind } = classifyFailure(sample, { provider: 'github' });
            assert.strictEqual(
                toGitVerdict(kind),
                classifyGitFailure(sample),
                `verdict drift for: ${JSON.stringify(sample)} (kind ${kind})`,
            );
        }
    });

    test('the default provider (no opts at all) is the full-parity one', () => {
        assert.strictEqual(DEFAULT_VCS_PROVIDER, 'github');
        for (const sample of PARITY_CORPUS) {
            assert.strictEqual(
                toGitVerdict(classifyFailure(sample).kind),
                classifyGitFailure(sample),
                `verdict drift with default provider for: ${JSON.stringify(sample)}`,
            );
        }
    });

    test('all 8 auth patterns produce an auth kind and the legacy auth verdict', () => {
        for (const sample of ALL_AUTH_SAMPLES) {
            const { kind, retryable } = classifyFailure(sample, { provider: 'github' });
            assert.ok(
                kind === K.AUTH_EXPIRED || kind === K.AUTH_DENIED,
                `expected an AUTH kind for ${JSON.stringify(sample)}, got ${kind}`,
            );
            assert.strictEqual(toGitVerdict(kind), 'auth');
            assert.strictEqual(retryable, false, 'auth failures are never retryable without remediation');
        }
    });

    test('diverged samples classify DIVERGED and are never retryable', () => {
        for (const sample of DIVERGED_SAMPLES) {
            const result = classifyFailure(sample);
            assert.strictEqual(result.kind, K.DIVERGED, `for ${JSON.stringify(sample)}`);
            assert.strictEqual(result.retryable, false);
        }
    });

    test('transient samples classify TRANSIENT and are the only retryable kind', () => {
        for (const sample of TRANSIENT_SAMPLES) {
            const result = classifyFailure(sample);
            assert.strictEqual(result.kind, K.TRANSIENT, `for ${JSON.stringify(sample)}`);
            assert.strictEqual(result.retryable, true);
        }
    });
});

describe('VCSModule.classifyFailure -- taxonomy and precedence', () => {
    test('AUTH is split into expired (re-provisionable) and denied (needs access)', () => {
        assert.strictEqual(
            classifyFailure("fatal: Authentication failed for 'https://github.com/x/y.git/'").kind,
            K.AUTH_EXPIRED,
        );
        assert.strictEqual(
            classifyFailure('git@github.com: Permission denied (publickey).').kind,
            K.AUTH_DENIED,
        );
    });

    test('NO_REMOTE and UNSUPPORTED_OPERATION are distinct kinds that collapse to the legacy unknown verdict', () => {
        const noRemote = classifyFailure('error 1105: no remote configured for this database');
        assert.strictEqual(noRemote.kind, K.NO_REMOTE);
        assert.strictEqual(noRemote.retryable, false);
        assert.strictEqual(toGitVerdict(noRemote.kind), 'unknown');

        const unsupported = classifyFailure('ERROR: VCSModule: provider "bitbucket" does not yet implement action "comment"');
        assert.strictEqual(unsupported.kind, K.UNSUPPORTED_OPERATION);
        assert.strictEqual(toGitVerdict(unsupported.kind), 'unknown');
    });

    test('an unmatched stderr is explicitly UNKNOWN, never a guess', () => {
        const result = classifyFailure('something nobody has a pattern for');
        assert.strictEqual(result.kind, K.UNKNOWN);
        assert.strictEqual(result.retryable, false);
        assert.strictEqual(result.providerCode, null);
    });

    test('DIVERGED wins over a credential or lock word in the same stderr', () => {
        const mixed = 'error: failed to push some refs -- Authentication failed, index.lock exists';
        assert.strictEqual(classifyFailure(mixed).kind, K.DIVERGED);
    });

    test('AUTH wins over a transient word in the same stderr', () => {
        const mixed = "fatal: Authentication failed; connection reset by peer";
        assert.strictEqual(classifyFailure(mixed).kind, K.AUTH_EXPIRED);
    });
});

describe('VCSModule.classifyFailure -- provider split and inheritance', () => {
    test('GenericGitVCS owns the portable texts', () => {
        for (const sample of PORTABLE_AUTH_SAMPLES) {
            const { kind } = classifyFailure(sample, { provider: 'generic-git' });
            assert.ok(kind === K.AUTH_EXPIRED || kind === K.AUTH_DENIED, `for ${JSON.stringify(sample)}`);
        }
    });

    test('the GitHub literals are GitHubVCS-only -- generic-git does not know them', () => {
        for (const sample of GITHUB_ONLY_AUTH_SAMPLES) {
            assert.strictEqual(
                classifyFailure(sample, { provider: 'generic-git' }).kind,
                K.UNKNOWN,
                `generic-git must not own the GitHub literal ${JSON.stringify(sample)}`,
            );
            const { kind } = classifyFailure(sample, { provider: 'github' });
            assert.strictEqual(kind, K.AUTH_EXPIRED);
        }
    });

    test('GitHubVCS inherits the generic set rather than duplicating it', () => {
        for (const sample of PORTABLE_AUTH_SAMPLES) {
            const { kind } = classifyFailure(sample, { provider: 'github' });
            assert.ok(kind === K.AUTH_EXPIRED || kind === K.AUTH_DENIED, `for ${JSON.stringify(sample)}`);
        }
    });

    test('providerCode carries provider detail without affecting kind', () => {
        const withCode = classifyFailure(
            "fatal: unable to access 'https://github.com/x/y.git/': The requested URL returned error: 403",
            { provider: 'github' },
        );
        assert.strictEqual(withCode.providerCode, '403');
        // Still branchable on kind alone -- the code is a diagnostic detail.
        assert.strictEqual(withCode.kind, K.TRANSIENT);
        // generic-git has no vendor codes to extract.
        assert.strictEqual(
            classifyFailure('The requested URL returned error: 403', { provider: 'generic-git' }).providerCode,
            null,
        );
    });

    test('an unknown provider falls back instead of throwing (asymmetry with buildVcsCommand)', () => {
        assert.doesNotThrow(() => classifyFailure('fatal: Authentication failed', { provider: 'gitea' }));
        assert.strictEqual(classifyFailure('fatal: Authentication failed', { provider: 'gitea' }).kind, K.AUTH_EXPIRED);
        // buildVcsCommand, by contrast, refuses loudly.
        assert.throws(
            () => VCSModule.buildCreatePrCommand({ provider: 'gitea', repo: 'a/b', base: 'main', head: 'x', title: 't', token: 'tok' }),
            /ERROR: VCSModule: unsupported VCS provider/,
        );
    });

    test('providers listed as known but unimplemented in BUILDERS still classify', () => {
        for (const provider of ['bitbucket', 'azure-devops']) {
            assert.strictEqual(
                classifyFailure('git@host: Permission denied (publickey).', { provider }).kind,
                K.AUTH_DENIED,
            );
        }
    });

    test('AC1: adding a provider is one implementation file -- classifyFailure is untouched', () => {
        // A throwaway provider registered exactly the way an in-tree file is.
        const AzureDevOpsVCS = {
            name: 'test-azure-devops',
            extends: 'generic-git',
            rules: {
                [K.AUTH_DENIED]: [/TF401019/],
            },
            extractProviderCode(raw) {
                const m = String(raw).match(/\b(TF\d{6})\b/);
                return m ? m[1] : null;
            },
        };
        registerVcsProvider(AzureDevOpsVCS);
        try {
            assert.ok(listVcsProviders().includes('test-azure-devops'));

            // Its own pattern is honored...
            const own = classifyFailure('TF401019: The Git repository does not exist or you do not have permission', {
                provider: 'test-azure-devops',
            });
            assert.strictEqual(own.kind, K.AUTH_DENIED);
            assert.strictEqual(own.providerCode, 'TF401019');
            assert.strictEqual(own.retryable, false);

            // ...and the generic set is inherited, with no generic pattern copied.
            const inherited = classifyFailure('fatal: Authentication failed', { provider: 'test-azure-devops' });
            assert.strictEqual(inherited.kind, K.AUTH_EXPIRED);
        } finally {
            unregisterVcsProvider('test-azure-devops');
        }
        assert.ok(!listVcsProviders().includes('test-azure-devops'));
    });

    test('a malformed provider is rejected at registration, not inside the classifier', () => {
        assert.throws(() => registerVcsProvider({}), /ERROR: VCSModule/);
        assert.throws(() => registerVcsProvider({ name: 'bad-rules', rules: 'nope' }), /ERROR: VCSModule/);
        assert.throws(
            () => registerVcsProvider({ name: 'bad-extract', extractProviderCode: 'nope' }),
            /ERROR: VCSModule/,
        );
    });
});

describe('VCSModule.classifyFailure -- purity (AC3)', () => {
    test('repeated calls on the same input are deeply equal (no /g lastIndex state)', () => {
        const samples = [...PARITY_CORPUS, 'TF401019 something', 'The requested URL returned error: 403'];
        for (const sample of samples) {
            const first = classifyFailure(sample, { provider: 'github' });
            const second = classifyFailure(sample, { provider: 'github' });
            const third = classifyFailure(sample, { provider: 'github' });
            assert.deepStrictEqual(first, second, `non-deterministic for ${JSON.stringify(sample)}`);
            assert.deepStrictEqual(second, third, `non-deterministic for ${JSON.stringify(sample)}`);
        }
    });

    test('null/undefined input is normalized, never thrown on', () => {
        for (const input of [null, undefined]) {
            const result = classifyFailure(input);
            assert.strictEqual(result.kind, K.UNKNOWN);
            assert.strictEqual(result.raw, '');
            assert.strictEqual(result.retryable, false);
        }
    });

    test('the return shape is exactly { kind, providerCode, retryable, raw }', () => {
        const result = classifyFailure('fatal: Authentication failed');
        assert.deepStrictEqual(Object.keys(result).sort(), ['kind', 'providerCode', 'raw', 'retryable']);
        assert.strictEqual(result.raw, 'fatal: Authentication failed');
    });

    test('classifyFailure is reachable both as a named export and off VCSModule', () => {
        assert.strictEqual(VCSModule.classifyFailure, classifyFailure);
        assert.strictEqual(VCSModule.toGitVerdict, toGitVerdict);
    });
});
