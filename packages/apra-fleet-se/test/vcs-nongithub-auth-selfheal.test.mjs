import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyFailure } from '../fleet-sprint/vcs-module.mjs';
import { VCS_FAILURE_KINDS as K } from '../fleet-sprint/errors.mjs';
import { classifyGitFailure, syncMemberAfter } from '../fleet-sprint/runner.js';
import { GitSyncError } from '../fleet-sprint/errors.mjs';

// apra-fleet-647.1.3.4 -- non-GitHub auth texts classify and self-heal
// instead of aborting the sprint.
//
// Companion suites this one deliberately does NOT duplicate:
//   - packages/apra-fleet-se/test/vcs-classify-failure.test.mjs already
//     covers "every legacy GIT_AUTH_PATTERNS/DOLT_AUTH_PATTERNS string still
//     classifies as auth" via its ALL_AUTH_SAMPLES/PARITY_CORPUS tests (AC2).
//   - packages/apra-fleet-se/test/git-sync-brackets.test.mjs (the "(fmu)"
//     block) already covers the bounded one-shot self-heal + single retry
//     mechanics for a GitHub credential failure.
// This suite's own job is the FOUR non-GitHub provider texts named in the
// bead, plus the "genuinely unrecognized string" retry-then-fail case, plus
// the source-literal guard that runner.js carries no VCS stderr regex list.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_SRC = fs.readFileSync(path.join(__dirname, '../fleet-sprint/runner.js'), 'utf8');

const OK = { ok: true, output: '', error: null };
const fail = (error) => ({ ok: false, output: '', error });

// Tiny scripted command() mock (same shape as git-sync-brackets.test.mjs's
// makeCommandMock): a map from cmd-substring to a queue of results.
function makeCommandMock(script) {
    const calls = [];
    const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
    const command = async (cmd, opts = {}) => {
        calls.push({ cmd, opts });
        for (const [key, queue] of queues) {
            if (cmd.includes(key)) {
                const next = queue.length > 1 ? queue.shift() : queue[0];
                return next;
            }
        }
        return { ok: true, output: '', error: null };
    };
    return { command, calls };
}

// Realistic full stderr for each named provider's expired/invalid-credential
// case over git-over-HTTPS -- each carries git's own generic
// "fatal: Authentication failed for '<url>'" tail line (git's universal
// reaction to a 401 challenge failure on a credentialed HTTPS transport,
// regardless of which host issued the challenge), plus that provider's own
// distinguishing "remote:" line named in the bead.
const NON_GITHUB_AUTH_TEXTS = {
    'Azure DevOps (TF401019)': "remote: TF401019: The Git repository with name or identifier 'core' does not exist, or you do not have permission to perform this operation.\nfatal: Authentication failed for 'https://dev.azure.com/org/project/_git/core/'",
    'GitLab (HTTP Basic: Access denied)': "remote: HTTP Basic: Access denied\nfatal: Authentication failed for 'https://gitlab.com/acme/widgets.git/'",
    'Bitbucket (Invalid or expired app password)': "remote: Invalid or expired app password.\nfatal: Authentication failed for 'https://bitbucket.org/acme/widgets.git/'",
    'Gitea (401 Unauthorized)': "remote: 401 Unauthorized\nfatal: Authentication failed for 'https://gitea.example.com/acme/widgets.git/'",
};

// The SAME four provider texts with git's generic "fatal: Authentication
// failed for '<url>'" tail STRIPPED -- isolates the provider-distinguishing
// signal itself. Before apra-fleet-417.6 landed its own AUTH_* pattern for
// each of these (azure-devops.mjs's TF401019 AUTH_DENIED rule, bitbucket.mjs's
// "Invalid or expired app password" AUTH_EXPIRED rule, and generic-git.mjs's
// portable "HTTP Basic: Access denied" / "401 Unauthorized" entries), every
// one of these bare lines classified UNKNOWN -- the earlier version of this
// suite passed on the tail alone and would have kept passing even if
// TF401019 were replaced with nonsense. These fixtures close that gap: they
// fail unless the provider's own pattern (not git's generic tail) is what
// classifies the line.
//
// `provider` here is the classifyFailure() opts.provider a caller who has
// actually resolved the member's VCS provider (e.g. via resolveProvider())
// would pass. TF401019 and the app-password literal are VENDOR-SPECIFIC
// patterns that live only on their own provider descriptor (azure-devops.mjs,
// bitbucket.mjs) -- not on generic-git.mjs -- so they are only reachable by
// naming that provider explicitly; they are NOT inherited by the 'github'
// chain's default rule set. apra-fleet-417.7 threaded the member's own
// resolved provider into classifyGitFailure() (it now takes an optional
// SECOND `provider` argument -- see runner.js's own doc comment on
// classifyGitFailure), so classifyGitFailure() is no longer unconditionally
// provider-agnostic: a caller (runGitStep, via resolveMemberProvider) that
// names the provider now reaches these vendor-specific rules end to end,
// same as GitHubVCS's own AUTH_EXPIRED literals are only reachable when
// 'github' (or no provider, since it is the default) is named. The GitLab/
// GitEA literals, by contrast, were added as PORTABLE entries directly on
// generic-git.mjs (see apra-fleet-417.6) specifically so they need no
// provider name at all -- 'github' (classifyGitFailure()'s no-provider
// default) inherits them like every other chain.
const NON_GITHUB_AUTH_TEXTS_BARE = {
    'Azure DevOps (TF401019)': {
        text: "remote: TF401019: The Git repository with name or identifier 'core' does not exist, or you do not have permission to perform this operation.",
        provider: 'azure-devops',
    },
    'GitLab (HTTP Basic: Access denied)': {
        text: 'remote: HTTP Basic: Access denied',
        provider: undefined,
    },
    'Bitbucket (Invalid or expired app password)': {
        text: 'remote: Invalid or expired app password.',
        provider: 'bitbucket',
    },
    'Gitea (401 Unauthorized)': {
        text: 'remote: 401 Unauthorized',
        provider: undefined,
    },
};

describe('non-GitHub provider auth texts classify as AUTH_* (apra-fleet-647.1.3.4)', () => {
    for (const [label, text] of Object.entries(NON_GITHUB_AUTH_TEXTS)) {
        test(`${label} classifies to an AUTH_* kind, not UNKNOWN`, () => {
            const { kind, retryable } = classifyFailure(text);
            assert.ok(
                kind === K.AUTH_EXPIRED || kind === K.AUTH_DENIED,
                `expected an AUTH_* kind for ${label}, got ${kind}`,
            );
            assert.notEqual(kind, K.UNKNOWN, `${label} must not classify UNKNOWN`);
            assert.equal(retryable, false, 'auth failures are never retryable without remediation first');
            assert.equal(classifyGitFailure(text), 'auth', `${label} must map to the legacy 'auth' verdict too`);
        });
    }
});

describe("non-GitHub provider auth texts classify as AUTH_* on the BARE provider line alone, without git's generic tail (apra-fleet-647.1.3.4 / apra-fleet-417.6)", () => {
    for (const [label, { text, provider }] of Object.entries(NON_GITHUB_AUTH_TEXTS_BARE)) {
        test(`${label}: the bare provider line (no "fatal: Authentication failed" tail) still classifies to an AUTH_* kind`, () => {
            assert.ok(
                !/Authentication failed/i.test(text),
                `fixture bug: ${label}'s bare text must not itself contain git's generic tail`,
            );
            const opts = provider ? { provider } : undefined;
            const { kind, retryable } = classifyFailure(text, opts);
            assert.ok(
                kind === K.AUTH_EXPIRED || kind === K.AUTH_DENIED,
                `expected an AUTH_* kind for the bare ${label} line, got ${kind} -- the provider-distinguishing pattern must do the classifying, not git's generic tail`,
            );
            assert.notEqual(kind, K.UNKNOWN, `${label}'s bare line must not classify UNKNOWN`);
            assert.equal(retryable, false, 'auth failures are never retryable without remediation first');
        });
    }

    test("vendor-specific patterns (TF401019, app-password) are NOT reachable from the default provider chain (no provider named) -- they require naming the provider explicitly, unlike the portable GitLab/Gitea entries on generic-git.mjs", () => {
        const tf401019Bare = NON_GITHUB_AUTH_TEXTS_BARE['Azure DevOps (TF401019)'].text;
        const appPasswordBare = NON_GITHUB_AUTH_TEXTS_BARE['Bitbucket (Invalid or expired app password)'].text;
        assert.equal(classifyFailure(tf401019Bare).kind, K.UNKNOWN, 'TF401019 must not leak into the default/github chain');
        assert.equal(classifyFailure(appPasswordBare).kind, K.UNKNOWN, 'the app-password literal must not leak into the default/github chain');
        assert.equal(classifyGitFailure(tf401019Bare), 'unknown', 'classifyGitFailure() with no provider argument must still fall back to the default chain (no verdict change for callers that cannot resolve a provider)');
        assert.equal(classifyGitFailure(appPasswordBare), 'unknown', 'classifyGitFailure() with no provider argument must still fall back to the default chain (no verdict change for callers that cannot resolve a provider)');

        const gitlabBare = NON_GITHUB_AUTH_TEXTS_BARE['GitLab (HTTP Basic: Access denied)'].text;
        const giteaBare = NON_GITHUB_AUTH_TEXTS_BARE['Gitea (401 Unauthorized)'].text;
        assert.equal(classifyGitFailure(gitlabBare), 'auth', 'the portable GitLab literal must classify via the default provider chain (no opts.provider needed)');
        assert.equal(classifyGitFailure(giteaBare), 'auth', 'the portable Gitea literal must classify via the default provider chain (no opts.provider needed)');
    });

    // apra-fleet-417.7: the flip side of the guard above -- once a caller DOES
    // name the member's own resolved provider (as runGitStep now does via
    // resolveMemberProvider), classifyGitFailure() reaches these
    // vendor-specific rules and stops classifying them UNKNOWN.
    test('classifyGitFailure(text, provider): naming the member-resolved provider makes the vendor-specific rule reachable (TF401019 -> azure-devops, app-password -> bitbucket)', () => {
        const tf401019Bare = NON_GITHUB_AUTH_TEXTS_BARE['Azure DevOps (TF401019)'].text;
        const appPasswordBare = NON_GITHUB_AUTH_TEXTS_BARE['Bitbucket (Invalid or expired app password)'].text;
        assert.equal(classifyGitFailure(tf401019Bare, 'azure-devops'), 'auth', 'TF401019 must classify auth once the azure-devops provider is named');
        assert.equal(classifyGitFailure(appPasswordBare, 'bitbucket'), 'auth', 'the app-password literal must classify auth once the bitbucket provider is named');
    });
});

describe('non-GitHub provider auth texts drive exactly one self-heal + retry, not a sprint-fatal abort (apra-fleet-647.1.3.4)', () => {
    for (const [label, text] of Object.entries(NON_GITHUB_AUTH_TEXTS)) {
        test(`${label}: G-push self-heals once and the single bounded retry succeeds`, async () => {
            const { command, calls } = makeCommandMock({
                'git push': [fail(text), OK],
            });
            let healCalls = 0;
            const onAuthFailure = async () => { healCalls += 1; };

            const res = await syncMemberAfter('m1', { command, onAuthFailure });

            assert.equal(res.ok, true, `expected the push to ultimately succeed after self-heal, got: ${JSON.stringify(res)}`);
            assert.equal(healCalls, 1, `${label}: expected exactly one self-heal call, got ${healCalls}`);
            assert.equal(
                calls.filter((c) => c.cmd.includes('git push')).length,
                2,
                `${label}: expected exactly one bounded retry after self-heal (2 total push attempts)`,
            );
        });
    }
});

// apra-fleet-417.7: end to end -- a member whose resolved provider is
// 'azure-devops'/'bitbucket' must classify the bare vendor literal (no git
// generic tail) as 'auth', not 'unknown', once runGitStep is given a
// resolveMemberProvider that resolves it. The observable that distinguishes
// 'auth' from 'unknown' at the syncMemberAfter/runGitStep boundary is
// runGitStep's own log line ("<kind> git failure ..."), since both kinds
// share the SAME bounded self-heal + single retry mechanics (so healCalls/
// push-attempt counts alone would pass whether or not the fix worked --
// see the log-line assertion below, not just the outcome).
describe('a member whose resolved VCS provider is azure-devops/bitbucket classifies the bare vendor literal as auth, not unknown, end to end through runGitStep (apra-fleet-417.7)', () => {
    const CASES = [
        {
            label: 'Azure DevOps (TF401019, bare)',
            text: NON_GITHUB_AUTH_TEXTS_BARE['Azure DevOps (TF401019)'].text,
            provider: 'azure-devops',
        },
        {
            label: 'Bitbucket (app-password, bare)',
            text: NON_GITHUB_AUTH_TEXTS_BARE['Bitbucket (Invalid or expired app password)'].text,
            provider: 'bitbucket',
        },
    ];

    for (const { label, text, provider } of CASES) {
        test(`${label}: syncMemberAfter's G-push logs an 'auth git failure' (not 'unknown'), self-heals once, and the retry succeeds`, async () => {
            const { command } = makeCommandMock({
                'git push': [fail(text), OK],
            });
            let healCalls = 0;
            const onAuthFailure = async () => { healCalls += 1; };
            const logLines = [];
            const log = (msg) => logLines.push(msg);
            const resolveMemberProvider = async () => provider;

            const res = await syncMemberAfter('m1', { command, onAuthFailure, log, resolveMemberProvider });

            assert.equal(res.ok, true, `expected the push to ultimately succeed after self-heal, got: ${JSON.stringify(res)}`);
            assert.equal(healCalls, 1, `${label}: expected exactly one self-heal call, got ${healCalls}`);
            assert.ok(
                logLines.some((l) => l.includes('auth git failure')),
                `${label}: expected an 'auth git failure' log line (provider threading must classify auth, not unknown) -- got: ${JSON.stringify(logLines)}`,
            );
            assert.ok(
                !logLines.some((l) => l.includes('unknown git failure')),
                `${label}: must NOT classify unknown once the member's own provider is resolved -- got: ${JSON.stringify(logLines)}`,
            );
        });
    }

    test("a member whose provider cannot be resolved (resolveMemberProvider throws) fails closed to the default chain -- TF401019 still classifies unknown, no throw, self-heal still bounded", async () => {
        const text = NON_GITHUB_AUTH_TEXTS_BARE['Azure DevOps (TF401019)'].text;
        const { command } = makeCommandMock({
            'git push': [fail(text), OK],
        });
        let healCalls = 0;
        const onAuthFailure = async () => { healCalls += 1; };
        const logLines = [];
        const log = (msg) => logLines.push(msg);
        const resolveMemberProvider = async () => { throw new Error('member registry unreachable'); };

        const res = await syncMemberAfter('m1', { command, onAuthFailure, log, resolveMemberProvider });

        assert.equal(res.ok, true, 'an unresolvable provider must not abort the sync -- it degrades to the default chain');
        assert.equal(healCalls, 1, 'the default-chain UNKNOWN classification still gets its one bounded self-heal + retry');
        assert.ok(
            logLines.some((l) => l.includes('unknown git failure')),
            `expected the default-chain 'unknown git failure' classification when the provider cannot be resolved -- got: ${JSON.stringify(logLines)}`,
        );
    });
});

describe('a genuinely unrecognized VCS failure classifies UNKNOWN, gets exactly one bounded retry, then fails (apra-fleet-647.1.3.4)', () => {
    test('classifyFailure/classifyGitFailure: a novel string classifies UNKNOWN, never AUTH/TRANSIENT/DIVERGED', () => {
        const novel = 'a completely novel VCS failure text nobody has ever seen before';
        assert.equal(classifyFailure(novel).kind, K.UNKNOWN);
        assert.equal(classifyGitFailure(novel), 'unknown');
    });

    test('G-push: self-heal is invoked EXACTLY ONCE on an UNKNOWN failure, and a still-failing retry surfaces GitSyncError (not a hang, not a second heal)', async () => {
        const novel = 'a completely novel VCS failure text nobody has ever seen before';
        const { command, calls } = makeCommandMock({
            // Single-entry queue -> makeCommandMock returns the same failure on
            // every call, so the first attempt and the post-heal retry both fail.
            'git push': [fail(novel)],
        });
        let healCalls = 0;
        const onAuthFailure = async () => { healCalls += 1; };

        await assert.rejects(() => syncMemberAfter('m1', { command, onAuthFailure }), GitSyncError);

        assert.equal(healCalls, 1, `self-heal must fire EXACTLY ONCE for an UNKNOWN failure (bounded, never a loop), got ${healCalls}`);
        assert.equal(
            calls.filter((c) => c.cmd.includes('git push')).length,
            2,
            'expected exactly one bounded retry after self-heal (2 total push attempts)',
        );
    });

    test('G-push: an UNKNOWN failure with no onAuthFailure injected still surfaces immediately, with no retry at all', async () => {
        const novel = 'a completely novel VCS failure text nobody has ever seen before';
        const { command, calls } = makeCommandMock({
            'git push': [fail(novel)],
        });

        await assert.rejects(() => syncMemberAfter('m1', { command }), GitSyncError);
        assert.equal(
            calls.filter((c) => c.cmd.includes('git push')).length,
            1,
            'no onAuthFailure injected -> no self-heal path -> no retry',
        );
    });
});

describe('source assertion: runner.js carries no VCS stderr regex list (apra-fleet-647.1.3.4 AC4)', () => {
    test('none of the deleted pattern-table identifiers are declared (as a const array) in runner.js', () => {
        // A bare mention (e.g. this suite's own header comment, or runner.js's
        // apra-fleet-647.1.3.2 doc comment explaining they are GONE) is fine;
        // only a live re-declaration would be a regression.
        for (const identifier of [
            'GIT_AUTH_PATTERNS',
            'GIT_DIVERGED_PATTERNS',
            'GIT_TRANSIENT_PATTERNS',
            'DOLT_AUTH_PATTERNS',
            'DOLT_TRANSIENT_PATTERNS',
        ]) {
            const declRe = new RegExp(`\\b(?:const|let|var)\\s+${identifier}\\s*=`);
            assert.ok(
                !declRe.test(RUNNER_SRC),
                `runner.js must not (re-)declare the deleted VCS stderr pattern table '${identifier}' -- classification must live only in vcs-module.mjs/vcs-providers/`,
            );
        }
    });

    test('classifyGitFailure delegates to VCSModule (no local regex parsing of VCS stderr)', () => {
        const fnSrc = RUNNER_SRC.slice(RUNNER_SRC.indexOf('export function classifyGitFailure'));
        const fnBody = fnSrc.slice(0, fnSrc.indexOf('\n}') + 2);
        assert.ok(/toGitVerdict\(\s*classifyFailure\(/.test(fnBody), `classifyGitFailure must delegate to classifyFailure/toGitVerdict, got: ${fnBody}`);
        assert.ok(!/\/(?:[^/\n]|\\\/)+\/[a-z]*\s*\.test\(/.test(fnBody), 'classifyGitFailure must not itself run a regex .test() over the stderr');
    });
});
