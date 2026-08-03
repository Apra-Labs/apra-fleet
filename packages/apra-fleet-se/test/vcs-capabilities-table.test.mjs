import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capabilities } from '../fleet-sprint/vcs-module.mjs';
import { finalizeAbort } from '../fleet-sprint/runner.js';
import { SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(__dirname, '../fleet-sprint/runner.js');

// =============================================================================
// apra-fleet-647.1.4.2 -- VCS capability decisions come from the provider, not
// a github.com literal.
//
// VCSModule.capabilities(remoteUrl) (apra-fleet-647.1.4.1, vcs-module.mjs)
// replaced runner.js's former isHostedGithubRemote() host-sniffing, dispatched
// through the SAME provider registry classifyGitFailure/classifyDoltFailure
// use (resolveVcsProviderForHost -> matchesHost/capabilitiesForHost). This
// suite pins:
//   1. a fuller capabilities() table across every remote shape/host class the
//      bead names (github.com's three URL shapes, GitHub Enterprise, Azure
//      DevOps, GitLab, file://, and empty/null);
//   2. the Publish-PR non-hosted-remote path (already pinned end-to-end in
//      publish-pr-non-hosted-remote.test.mjs -- cited here rather than
//      duplicated, see the note above its own capabilities() cases);
//   3. finalizeAbort()'s abort-PR gate consults the SAME capabilities() and
//      never throws when canOpenPullRequest is false;
//   4. a source assertion that runner.js contains no VCS host literal used
//      for a capability decision, and no isHostedGithubRemote definition --
//      reinstating either must fail this test.
// =============================================================================

// -----------------------------------------------------------------------------
// (1) capabilities() table.
// -----------------------------------------------------------------------------

test('capabilities: the three github.com URL shapes are all hasRemote:true, canOpenPullRequest:true, host:github.com', () => {
    for (const url of [
        'https://github.com/o/r',
        'https://github.com/o/r.git',
        'git@github.com:o/r.git',
        'ssh://git@github.com/o/r',
    ]) {
        const caps = capabilities(url);
        assert.deepEqual(caps, { hasRemote: true, canOpenPullRequest: true, host: 'github.com' }, `unexpected capabilities() for ${url}: ${JSON.stringify(caps)}`);
    }
});

test('capabilities: a GitHub Enterprise Server host is PR-capable via the "github" substring in its hostname, not a github.com literal', () => {
    const caps = capabilities('https://github.acme-corp.internal/o/r.git');
    assert.equal(caps.hasRemote, true);
    assert.equal(caps.canOpenPullRequest, true, 'a GitHub Enterprise host must be recognized as PR-capable, same as github.com');
    assert.equal(caps.host, 'github.acme-corp.internal');
});

test('capabilities: an Azure DevOps URL has a remote but is NOT PR-capable (no registered provider yet)', () => {
    const caps = capabilities('https://dev.azure.com/o/proj/_git/r');
    assert.equal(caps.hasRemote, true);
    assert.equal(caps.canOpenPullRequest, false);
    assert.equal(caps.host, 'dev.azure.com');
});

test('capabilities: a GitLab URL has a remote but is NOT PR-capable (no registered provider yet)', () => {
    const caps = capabilities('https://gitlab.com/o/r.git');
    assert.equal(caps.hasRemote, true);
    assert.equal(caps.canOpenPullRequest, false);
    assert.equal(caps.host, 'gitlab.com');
});

test('capabilities: a file:// bare mirror is hasRemote:true, canOpenPullRequest:false, host:null', () => {
    assert.deepEqual(
        capabilities('file:///path/to/bare.git'),
        { hasRemote: true, canOpenPullRequest: false, host: null },
    );
});

test('capabilities: empty string and null both fail closed to hasRemote:false, canOpenPullRequest:false, host:null', () => {
    assert.deepEqual(capabilities(''), { hasRemote: false, canOpenPullRequest: false, host: null });
    assert.deepEqual(capabilities(null), { hasRemote: false, canOpenPullRequest: false, host: null });
});

// -----------------------------------------------------------------------------
// (2) Publish-PR path: with a file:// remote the PR call is never attempted
// and the sprint still closes on the non-PR path. Already pinned end-to-end
// (mock sprint harness, real runSprintCycle Publish-PR step) by
// publish-pr-non-hosted-remote.test.mjs's 'mock sprint: non-hosted (file://)
// origin remote skips PR creation and closes the target issue directly' and
// its FAIL-verdict companion -- not duplicated here.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// (3) finalizeAbort path: same gate, does not throw when canOpenPullRequest
// is false.
// -----------------------------------------------------------------------------

function buildAbortMockCommand({ originUrl, commitCount = 2 }) {
    const log = [];
    const command = async (cmd, opts = {}) => {
        log.push(cmd);
        const failSoft = !!opts.failSoft;
        const ok = (output) => (failSoft ? { ok: true, output, error: null } : output);
        const fail = (error) => {
            if (failSoft) return { ok: false, output: '', error };
            throw new Error(error);
        };
        if (/^git fetch origin\b/.test(cmd)) return ok('');
        if (/^git rev-list --count\b/.test(cmd)) return ok(String(commitCount));
        if (/^git push\b/.test(cmd)) return ok('To mock-remote\n * [new branch] (mocked)');
        if (/^git remote get-url origin\b/.test(cmd)) return ok(originUrl);
        return fail(`buildAbortMockCommand: unexpected command dispatched: '${cmd}'`);
    };
    return { command, log };
}

test('finalizeAbort: a file:// origin remote is gated by capabilities() -- skips PR creation, never throws, branch is still pushed', async () => {
    const branch = 'auto-sprint/abort-non-hosted-remote';
    const { command, log } = buildAbortMockCommand({ originUrl: 'file:///path/to/bare.git', commitCount: 3 });
    const logs = [];
    const error = new SprintPlanRejectedError('Plan rejected after 3 rounds', { notes: null });

    let thrown = null;
    let result = null;
    try {
        result = await finalizeAbort({
            error,
            branch,
            baseBranch: 'main',
            member: 'local',
            command,
            log: (m) => logs.push(m),
        });
    } catch (e) {
        thrown = e;
    }

    assert.equal(thrown, null, `finalizeAbort() must never throw when the origin remote cannot open a PR, got: ${thrown && thrown.message}`);
    assert.equal(result.reason, 'non-hosted-remote');
    assert.equal(result.pushed, true, 'the branch is already pushed before the PR gate runs');
    assert.equal(result.prUrl, null);
    assert.ok(
        !log.some((c) => /^curl -sS -X POST\b/.test(c) && /\/pulls\b/.test(c)),
        `expected NO create-pull-request call for a non-hosted origin, command log: ${JSON.stringify(log)}`,
    );
    assert.ok(
        logs.some((m) => /cannot open a pull request/.test(m)),
        `expected a logged message explaining the skip, logs: ${JSON.stringify(logs)}`,
    );
});

// -----------------------------------------------------------------------------
// (4) Source assertion: runner.js contains no VCS host literal used for a
// capability decision, and no isHostedGithubRemote definition. Reinstating
// isHostedGithubRemote() at either consumer (Publish-PR, finalizeAbort) must
// fail at least one assertion below.
// -----------------------------------------------------------------------------

test('source: runner.js defines no isHostedGithubRemote() -- both call sites must go through VCSModule.capabilities()', () => {
    const src = fs.readFileSync(RUNNER_PATH, 'utf8');
    assert.ok(!/isHostedGithubRemote/.test(src), 'runner.js must not reference isHostedGithubRemote in any form (definition or call)');
});

test('source: runner.js contains no quoted github.com (or other VCS host) literal used for a capability decision', () => {
    const src = fs.readFileSync(RUNNER_PATH, 'utf8');
    // Any quoted (single/double/backtick) string literal containing a known
    // VCS host name would be a smoking gun for host-literal sniffing sneaking
    // back into a capability decision -- capabilities() is the only place
    // permitted to reason about hosts, and it lives in vcs-module.mjs /
    // vcs-providers/*, not runner.js.
    const hostLiteralPattern = /['"`][^'"`\n]*(github\.com|gitlab\.com|dev\.azure\.com|bitbucket\.org)[^'"`\n]*['"`]/gi;
    const matches = src.match(hostLiteralPattern) || [];
    assert.deepEqual(matches, [], `runner.js must not contain a quoted VCS host literal, found: ${JSON.stringify(matches)}`);
});

test('source: both Publish-PR and finalizeAbort call sites resolve capabilities via the imported vcsCapabilities (VCSModule.capabilities), not a local reimplementation', () => {
    const src = fs.readFileSync(RUNNER_PATH, 'utf8');
    assert.match(src, /capabilities as vcsCapabilities.*from '\.\/vcs-module\.mjs'/, 'runner.js must import capabilities as vcsCapabilities from vcs-module.mjs');
    const callSites = src.match(/vcsCapabilities\([^)]*\)/g) || [];
    assert.ok(callSites.length >= 2, `expected at least 2 vcsCapabilities(...) call sites (Publish-PR + finalizeAbort), found ${callSites.length}`);
});
