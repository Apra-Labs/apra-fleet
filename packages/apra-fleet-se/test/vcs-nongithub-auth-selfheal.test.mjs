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
