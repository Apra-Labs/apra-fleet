// Retry salvage driven against a REAL git repository (GitHub #716).
//
// THE BUG. A retried doer dispatch runs syncMemberBefore with
// resetToRemoteTip, which hard-resets the member checkout onto the remote
// tip. When the prior attempt was killed mid-work (a stall kill, a dropped
// transport) its unpublished commits survived only in the reflog and its
// uncommitted tracked edits were destroyed outright.
//
// THE FIX UNDER TEST. Before the reset, member-sync.mjs's salvageBeforeReset()
// pins that work on a LOCAL fleet-salvage/<branch-slug>/<short-sha> ref
// (git stash create + git branch -f), never moving the sprint branch, never
// staging or committing, never touching untracked files, and refusing to
// reset at all when the salvage cannot be completed.
//
// HOW. helpers/git-repo-fixture.mjs stands up a bare origin plus a member
// clone in a temp dir (no network, no credentials, hermetic git config). Its
// command() runs every git string the code composes VERBATIM as real git in
// the member clone, so every assertion here is about real repository state
// afterwards. Each test removes its own fixture; the whole file is ~seconds.
//
// HOST GATING: a host without a usable git skips WITH THE REASON attached
// (probeGitRepoFixtureSupport), never a silent pass.
//
// ASCII only.

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { syncMemberBefore } from '../fleet-sprint/member-sync.mjs';
import { GitSyncError } from '../fleet-sprint/errors.mjs';
import { createGitRepoFixture, probeGitRepoFixtureSupport } from './helpers/git-repo-fixture.mjs';

const support = probeGitRepoFixtureSupport();
if (!support.ok) {
    console.error(`[retry-salvage-real-repo] DEGRADED -- real-git retry salvage coverage did NOT run on this host: ${support.reason}`);
}

const SLUG = 'feat-real-git-bracket'; // salvage slug of the fixture's default branch
const ENV_BODY = 'SECRET_TOKEN=do-not-commit\n';
const SETTINGS_BODY = '{"permissions":{"allow":["Bash(git status)"]}}\n';

describe('retry salvage against a real git repo (no network, no credentials)', { skip: support.ok ? false : support.reason }, () => {
    let fixture;

    afterEach(() => {
        if (fixture) fixture.cleanup();
        fixture = null;
    });

    /** Real git in the member clone, outside the code under test's call log. */
    async function git(...args) {
        const before = fixture.calls.length;
        const res = await fixture.command(`git ${args.join(' ')}`);
        fixture.calls.splice(before);
        return res;
    }
    async function gitOut(...args) {
        const res = await git(...args);
        assert.ok(res.ok, `git ${args.join(' ')} failed: ${res.error}`);
        return res.output.trim();
    }
    async function salvageRefs() {
        const out = await gitOut('for-each-ref', '--format=%(refname:short)', 'refs/heads/fleet-salvage');
        return out.split(/\r?\n/).filter(Boolean);
    }
    function writeIn(rel, body) {
        const abs = path.join(fixture.clonePath, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, body, 'utf-8');
    }
    function readIn(rel) {
        return fs.readFileSync(path.join(fixture.clonePath, rel), 'utf-8');
    }
    /** Two unpublished commits, a tracked edit and two untracked files. */
    function dirtyClone() {
        const c1 = fixture.memberCommit('unpublished-one');
        const c2 = fixture.memberCommit('unpublished-two');
        writeIn('README.md', 'seed\nuncommitted tracked edit\n');
        writeIn('.env', ENV_BODY);
        writeIn(path.join('.claude', 'settings.local.json'), SETTINGS_BODY);
        return { c1, c2 };
    }

    test('commits ahead + tracked WIP + untracked files: branch lands on the remote tip, a fleet-salvage ref recovers both commits and the edit, untracked files are untouched and in no commit', async () => {
        fixture = createGitRepoFixture({ member: 'salvage-member', prefix: 'retry-salvage-1-' });
        const { c1, c2 } = dirtyClone();
        const logs = [];

        const res = await syncMemberBefore(fixture.member, {
            command: fixture.command, branch: fixture.branch, resetToRemoteTip: true, log: (m) => logs.push(m),
        });

        assert.equal(fixture.localTip(), fixture.originTip(), 'the sprint branch equals the remote tip after the retry sync');
        assert.equal(fixture.localTip(), fixture.seedSha, 'the remote tip is the seed (nothing was published)');

        const refs = await salvageRefs();
        assert.equal(refs.length, 1, `exactly one salvage ref, got ${JSON.stringify(refs)}`);
        const ref = refs[0];
        assert.ok(ref.startsWith(`fleet-salvage/${SLUG}/`), `salvage ref is named fleet-salvage/<branch-slug>/<short-sha>, got ${ref}`);
        assert.equal(res.salvageRef, ref, 'syncMemberBefore reports the salvage ref');
        assert.ok(fixture.isAncestor(c1, ref) && fixture.isAncestor(c2, ref), 'both unpublished commits are reachable from the salvage ref');
        assert.notEqual(await gitOut('rev-parse', ref), c2, 'the ref points at the WIP snapshot, which sits on top of the commits');

        // The sprint branch was never moved onto a salvage commit.
        assert.equal(fixture.isAncestor(c2, 'HEAD'), false, 'the sprint branch does not contain the salvaged commits');

        // The tracked edit is gone from the work tree but recoverable.
        assert.equal(readIn('README.md'), 'seed\n', 'the reset restored the tracked file');
        const stashSha = await gitOut('rev-parse', ref);
        await gitOut('stash', 'apply', stashSha);
        assert.equal(readIn('README.md'), 'seed\nuncommitted tracked edit\n', 'git stash apply <sha> restores the uncommitted tracked edit');

        // Untracked files: same content, never committed anywhere.
        assert.equal(readIn('.env'), ENV_BODY, '.env survives with its original content');
        assert.equal(readIn(path.join('.claude', 'settings.local.json')), SETTINGS_BODY, 'the provider permission file survives with its original content');
        assert.equal(await gitOut('rev-list', '--all', '--', '.env'), '', '.env appears in no commit');
        assert.equal(await gitOut('rev-list', '--all', '--', '.claude/settings.local.json'), '', 'settings.local.json appears in no commit');

        // Case 5 on the same run: the log names the ref and recovery commands.
        const line = logs.find((l) => l.includes(ref));
        assert.ok(line, `a log line names the side ref ${ref}; logs: ${JSON.stringify(logs)}`);
        assert.ok(line.includes(`git stash apply ${stashSha}`), `log gives the WIP recovery command: ${line}`);
        assert.ok(line.includes(`git cherry-pick ${fixture.seedSha}..${c2}`), `log gives the commit recovery range: ${line}`);
        assert.ok(line.includes(`git log ${ref}`), `log gives git log <ref>: ${line}`);

        // Never pushed.
        assert.equal(fixture.commandsOf('git push').length, 0, 'the salvage never pushes');
    });

    test('clean clone with nothing ahead: no salvage ref is created', async () => {
        fixture = createGitRepoFixture({ member: 'clean-member', prefix: 'retry-salvage-2-' });
        writeIn('.env', ENV_BODY); // untracked only: nothing to salvage

        const res = await syncMemberBefore(fixture.member, { command: fixture.command, branch: fixture.branch, resetToRemoteTip: true });

        assert.deepEqual(await salvageRefs(), [], 'no fleet-salvage ref for a clean, up-to-date checkout');
        assert.equal(res.salvageRef, undefined);
        assert.equal(fixture.localTip(), fixture.originTip());
        assert.equal(readIn('.env'), ENV_BODY, 'the untracked file is untouched');
    });

    test('reset failure: the sprint branch stays at its prior tip (not a salvage commit) and the work tree keeps its edit', async () => {
        fixture = createGitRepoFixture({ member: 'reset-fail-member', prefix: 'retry-salvage-3-' });
        const { c2 } = dirtyClone();
        const failingReset = async (cmd, opts) => {
            if (/git reset --hard/.test(cmd)) {
                fixture.calls.push({ cmd, opts });
                return { ok: false, output: '', error: 'fatal: simulated reset failure' };
            }
            return fixture.command(cmd, opts);
        };

        await assert.rejects(
            syncMemberBefore(fixture.member, { command: failingReset, branch: fixture.branch, resetToRemoteTip: true }),
            (err) => err instanceof GitSyncError && /left at its prior tip/.test(err.message),
        );

        assert.equal(fixture.localTip(), c2, 'HEAD is exactly the prior tip');
        const refs = await salvageRefs();
        assert.equal(refs.length, 1, 'the salvage ref was still created before the attempted reset');
        assert.notEqual(fixture.localTip(), await gitOut('rev-parse', refs[0]), 'HEAD is not the salvage commit');
        assert.equal(readIn('README.md'), 'seed\nuncommitted tracked edit\n', 'the tracked edit is still in the work tree');
    });

    test('pre-existing conflicting ref name (D/F conflict): fails closed with an actionable message and never resets', async () => {
        fixture = createGitRepoFixture({ member: 'df-member', prefix: 'retry-salvage-4-' });
        await gitOut('branch', `fleet-salvage/${SLUG}`, 'HEAD');
        const { c2 } = dirtyClone();

        await assert.rejects(
            syncMemberBefore(fixture.member, { command: fixture.command, branch: fixture.branch, resetToRemoteTip: true }),
            (err) => {
                assert.ok(err instanceof GitSyncError, `GitSyncError, got ${err && err.name}`);
                assert.ok(err.message.includes(`'fleet-salvage/${SLUG}'`), `names the conflicting ref: ${err.message}`);
                assert.ok(err.message.includes(`git branch -D fleet-salvage/${SLUG}`), `says how to delete it: ${err.message}`);
                return true;
            },
        );

        assert.equal(fixture.commandsOf('git reset --hard').length, 0, 'the reset never ran');
        assert.equal(fixture.localTip(), c2, 'the sprint branch is unchanged');
        assert.equal(readIn('README.md'), 'seed\nuncommitted tracked edit\n', 'the tracked edit is untouched');
    });

    test('every emitted command is shell-neutral: no $, backtick, ~ or command substitution', async () => {
        fixture = createGitRepoFixture({ member: 'neutral-member', prefix: 'retry-salvage-6-' });
        dirtyClone();

        await syncMemberBefore(fixture.member, { command: fixture.command, branch: fixture.branch, resetToRemoteTip: true });

        const cmds = fixture.calls.map((c) => c.cmd);
        assert.ok(cmds.some((c) => /stash create/.test(c)) && cmds.some((c) => /git branch -f fleet-salvage\//.test(c)), `the salvage commands ran: ${JSON.stringify(cmds)}`);
        for (const c of cmds) {
            assert.ok(!/[$`~]/.test(c), `command must not rely on shell expansion: ${c}`);
            assert.ok(!/\$\(/.test(c), `command must not use command substitution: ${c}`);
        }
    });
});
