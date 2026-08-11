import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    createMemberReservationClient,
    resyncReacquiredMember,
    decideEnsureBranchAction,
    commandResultToSoftGit,
} from '../fleet-sprint/runner.js';
import { MemberReservationResumeError } from '../fleet-sprint/errors.mjs';

// apra-fleet-p2to.4.2 -- reservation handling across a cooperative pause/resume
// plus the unconditional per-member resume re-sync. The prior review round
// reopened this bead because the shipped behavior had ZERO tests of its own:
// releaseForPause(), reReserveForResume()'s owner-checked re-acquire + partial
// rollback + MemberReservationResumeError naming, resyncReacquiredMember()'s
// git-fetch/probe/dolt-pull reconcile (including its abort-on-divergence and
// soft branch-fetch paths), and the exit-code classification the resync's tip
// comparison depends on. These are pure units over injected I/O -- no `bd`
// shell-out, no live fleet -- mirroring runner-member-reservation.test.mjs.

// ---------------------------------------------------------------------------
// releaseForPause(): hand every member back, best-effort, exactly like
// releaseAll(), so a different sprint may claim it while this one is parked.
// ---------------------------------------------------------------------------
describe('apra-fleet-p2to.4.2: releaseForPause()', () => {
    test('calls member_reservation action=release for EVERY member, using the bound sprintId', async () => {
        const calls = [];
        const client = createMemberReservationClient({
            callTool: async (name, args) => { calls.push({ name, args }); return '[OK] released'; },
            members: ['alice', 'bob', 'carol'],
            sprintId: 'feat/pause-resume',
        });
        await client.releaseForPause();
        assert.deepEqual(calls, [
            { name: 'member_reservation', args: { member_name: 'alice', action: 'release', sprint_id: 'feat/pause-resume' } },
            { name: 'member_reservation', args: { member_name: 'bob', action: 'release', sprint_id: 'feat/pause-resume' } },
            { name: 'member_reservation', args: { member_name: 'carol', action: 'release', sprint_id: 'feat/pause-resume' } },
        ]);
    });

    test('is best-effort: a rejected release for one member is logged, never thrown, and later members still run', async () => {
        const seen = [];
        const logs = [];
        const client = createMemberReservationClient({
            callTool: async (name, args) => {
                seen.push(args.member_name);
                if (args.member_name === 'alice') throw new Error('transport down');
                return '[OK] released';
            },
            members: ['alice', 'bob'],
            sprintId: 'feat/pause-resume',
            log: (msg) => logs.push(msg),
        });
        await assert.doesNotReject(() => client.releaseForPause());
        assert.deepEqual(seen, ['alice', 'bob'], 'a hiccup on the first member must not abort the release of the rest');
        assert.equal(logs.length, 1);
        assert.match(logs[0], /release failed for member 'alice'.*non-fatal/);
    });

    test('is a no-op (never calls callTool) when the client is inactive (no members)', async () => {
        const calls = [];
        const client = createMemberReservationClient({
            callTool: async (name, args) => { calls.push(args); },
            members: [],
            sprintId: 'feat/pause-resume',
        });
        await client.releaseForPause();
        assert.equal(calls.length, 0);
    });
});

// ---------------------------------------------------------------------------
// reReserveForResume(): owner-checked re-acquire. Happy path re-grabs every
// member and re-syncs each; any unavailable member fails the resume with a
// naming error AND hands back the ones already re-grabbed (partial rollback).
// ---------------------------------------------------------------------------
describe('apra-fleet-p2to.4.2: reReserveForResume()', () => {
    test('happy path: re-reserves every member, then runs resyncMember for each re-acquired member IN ORDER, and returns { reacquired }', async () => {
        const calls = [];
        const resynced = [];
        const client = createMemberReservationClient({
            callTool: async (name, args) => { calls.push(args); return '[OK] reserved'; },
            members: ['alice', 'bob'],
            sprintId: 'feat/pause-resume',
        });
        const result = await client.reReserveForResume({
            resyncMember: async (member) => { resynced.push(member); },
        });
        assert.deepEqual(result, { reacquired: ['alice', 'bob'] });
        // Only reserve calls -- no release, since nobody was unavailable.
        assert.deepEqual(calls.map((a) => a.action), ['reserve', 'reserve']);
        assert.deepEqual(resynced, ['alice', 'bob'], 'each re-acquired member must be re-synced, in member order');
    });

    test('resyncMember is optional -- a happy resume without one still re-reserves every member and does not throw', async () => {
        const client = createMemberReservationClient({
            callTool: async () => '[OK] reserved',
            members: ['alice', 'bob'],
            sprintId: 'feat/pause-resume',
        });
        const result = await client.reReserveForResume();
        assert.deepEqual(result, { reacquired: ['alice', 'bob'] });
    });

    test('single unavailable member: throws MemberReservationResumeError NAMING it, hands back the already-reacquired member(s), and never runs resyncMember', async () => {
        const calls = [];
        let resyncCalled = false;
        const client = createMemberReservationClient({
            callTool: async (name, args) => {
                calls.push({ action: args.action, member: args.member_name });
                if (args.action === 'reserve' && args.member_name === 'bob') {
                    return '[-] Member "bob" is already reserved by "other-sprint".';
                }
                return '[OK]';
            },
            members: ['alice', 'bob'],
            sprintId: 'feat/pause-resume',
        });
        await assert.rejects(
            () => client.reReserveForResume({ resyncMember: async () => { resyncCalled = true; } }),
            (err) => {
                assert.ok(err instanceof MemberReservationResumeError);
                assert.deepEqual(err.members, ['bob'], 'the error must name exactly the unavailable member');
                assert.match(err.message, /bob/);
                assert.equal(err.code, 'MEMBER_RESERVATION_RESUME_FAILED');
                return true;
            },
        );
        // alice was reserved, bob rejected, then alice released again (rollback).
        assert.deepEqual(calls, [
            { action: 'reserve', member: 'alice' },
            { action: 'reserve', member: 'bob' },
            { action: 'release', member: 'alice' },
        ], 'the already-reacquired alice must be released so a failed resume holds no partial reservation set');
        assert.equal(resyncCalled, false, 'no member may be re-synced when the resume is failing');
    });

    test('multiple unavailable members: names ALL of them and releases every member that WAS re-acquired', async () => {
        const releases = [];
        const client = createMemberReservationClient({
            callTool: async (name, args) => {
                if (args.action === 'release') releases.push(args.member_name);
                if (args.action === 'reserve' && (args.member_name === 'bob' || args.member_name === 'dave')) {
                    return { isError: true, content: [{ text: `[-] ${args.member_name} taken` }] };
                }
                return '[OK]';
            },
            members: ['alice', 'bob', 'carol', 'dave'],
            sprintId: 'feat/pause-resume',
        });
        await assert.rejects(
            () => client.reReserveForResume(),
            (err) => {
                assert.ok(err instanceof MemberReservationResumeError);
                assert.deepEqual(err.members, ['bob', 'dave'], 'both unavailable members must be named, in member order');
                return true;
            },
        );
        assert.deepEqual(releases, ['alice', 'carol'], 'exactly the re-acquired members (alice, carol) must be handed back');
    });

    test('is a no-op returning { reacquired: [] } when the client is inactive (no callTool)', async () => {
        const client = createMemberReservationClient({ members: ['alice'], sprintId: 'feat/pause-resume' });
        const result = await client.reReserveForResume({ resyncMember: async () => { throw new Error('must not run'); } });
        assert.deepEqual(result, { reacquired: [] });
    });
});

// ---------------------------------------------------------------------------
// resyncReacquiredMember(): the unconditional per-member git-fetch + probe +
// dolt-pull reconcile. All I/O injected; asserts the ordered step sequence and
// the checkout / abort-on-divergence / soft-missing-ref branches.
// ---------------------------------------------------------------------------
describe('apra-fleet-p2to.4.2: resyncReacquiredMember()', () => {
    test('throws TypeError unless BOTH runGit and doltPull are injected', async () => {
        await assert.rejects(() => resyncReacquiredMember({ member: 'm', branch: 'b', baseBranch: 'main', doltPull: async () => {} }), TypeError);
        await assert.rejects(() => resyncReacquiredMember({ member: 'm', branch: 'b', baseBranch: 'main', runGit: async () => ({ ok: true }) }), TypeError);
    });

    // A programmable soft-git stub: keyed by substring match on the command,
    // records the ordered command log, defaults every unlisted command to ok.
    function makeRunGit(responses) {
        const log = [];
        const runGit = async (cmd) => {
            log.push(cmd);
            for (const [needle, res] of responses) {
                if (cmd.includes(needle)) return res;
            }
            return { ok: true };
        };
        return { runGit, log };
    }

    test('checkout path, local AHEAD of origin: reuses the local branch (plain `git checkout <branch>`, no reset) so unpushed commits survive, then dolt-pulls; steps run in order', async () => {
        const doltPulls = [];
        const { runGit, log } = makeRunGit([
            // branch fetch succeeds, local branch exists
            [`git fetch origin feat/x --quiet`, { ok: true }],
            [`git fetch origin main --quiet`, { ok: true }],
            [`rev-parse --verify --quiet refs/heads/feat/x`, { ok: true }],
            // local IS NOT an ancestor of origin (exit 1 -> ok:false),
            // origin IS an ancestor of local (exit 0 -> ok:true) => 'ahead'
            [`git merge-base --is-ancestor feat/x origin/feat/x`, { ok: false }],
            [`git merge-base --is-ancestor origin/feat/x feat/x`, { ok: true }],
        ]);
        await resyncReacquiredMember({
            member: 'alice', branch: 'feat/x', baseBranch: 'main',
            runGit, doltPull: async (m) => { doltPulls.push(m); },
        });
        assert.deepEqual(log, [
            'git fetch origin main --quiet',
            'git fetch origin feat/x --quiet',
            'git rev-parse --verify --quiet refs/heads/feat/x',
            'git merge-base --is-ancestor feat/x origin/feat/x',
            'git merge-base --is-ancestor origin/feat/x feat/x',
            'git checkout feat/x',
        ], 'ahead => reuse local branch as-is, and the reconcile must be the LAST git step before dolt pull');
        assert.deepEqual(doltPulls, ['alice'], 'the beads clone must be re-pulled for the member after the branch reconcile');
    });

    test('checkout path, local BEHIND-OR-EQUAL origin: hard-resets to origin (`git checkout -B <branch> origin/<branch>`)', async () => {
        const { runGit, log } = makeRunGit([
            [`rev-parse --verify --quiet refs/heads/feat/x`, { ok: true }],
            // local IS an ancestor of origin (exit 0) => 'behind-or-equal'
            [`git merge-base --is-ancestor feat/x origin/feat/x`, { ok: true }],
        ]);
        await resyncReacquiredMember({
            member: 'alice', branch: 'feat/x', baseBranch: 'main',
            runGit, doltPull: async () => {},
        });
        assert.ok(log.includes('git checkout -B feat/x origin/feat/x'), 'behind-or-equal must reset the local branch to origin\'s tip');
    });

    test('abort-on-divergence: local and origin tips diverged (neither an ancestor of the other) THROWS and never checks out or dolt-pulls', async () => {
        const doltPulls = [];
        const { runGit, log } = makeRunGit([
            [`rev-parse --verify --quiet refs/heads/feat/x`, { ok: true }],
            // neither direction is an ancestor => 'diverged'
            [`git merge-base --is-ancestor feat/x origin/feat/x`, { ok: false }],
            [`git merge-base --is-ancestor origin/feat/x feat/x`, { ok: false }],
        ]);
        await assert.rejects(
            () => resyncReacquiredMember({
                member: 'alice', branch: 'feat/x', baseBranch: 'main',
                runGit, doltPull: async (m) => { doltPulls.push(m); },
            }),
            /diverged|resume-resync/i,
        );
        assert.ok(!log.some((c) => c.startsWith('git checkout')), 'a diverged branch must never be checked out/reset');
        assert.deepEqual(doltPulls, [], 'dolt pull must not run when the resync aborts');
    });

    test('soft branch-fetch: a brand-new branch whose remote ref is missing does NOT abort -- it checks out from origin/<baseBranch>', async () => {
        const { runGit, log } = makeRunGit([
            // sprint-branch fetch fails with the specific "missing ref" error
            [`git fetch origin feat/new --quiet`, { ok: false, error: "fatal: couldn't find remote ref feat/new" }],
            // local branch does not exist yet
            [`rev-parse --verify --quiet refs/heads/feat/new`, { ok: false }],
        ]);
        await resyncReacquiredMember({
            member: 'alice', branch: 'feat/new', baseBranch: 'main',
            runGit, doltPull: async () => {},
        });
        assert.ok(log.includes('git checkout -B feat/new origin/main'), 'a genuinely-new branch must be created off origin/<baseBranch>, not aborted');
    });

    test('abort: a branch fetch that fails for a NON-"missing ref" reason (e.g. auth/network) THROWS rather than silently resetting to base', async () => {
        const { runGit } = makeRunGit([
            [`git fetch origin feat/x --quiet`, { ok: false, error: 'fatal: Authentication failed' }],
            [`rev-parse --verify --quiet refs/heads/feat/x`, { ok: true }],
        ]);
        await assert.rejects(
            () => resyncReacquiredMember({
                member: 'alice', branch: 'feat/x', baseBranch: 'main',
                runGit, doltPull: async () => {},
            }),
            /resume-resync/i,
        );
    });

    test('a HARD base-branch fetch failure throws before any probe (a missing base is a real problem)', async () => {
        const { runGit, log } = makeRunGit([
            [`git fetch origin main --quiet`, { ok: false, error: 'network down' }],
        ]);
        await assert.rejects(
            () => resyncReacquiredMember({
                member: 'alice', branch: 'feat/x', baseBranch: 'main',
                runGit, doltPull: async () => {},
            }),
            /resume-resync/i,
        );
        assert.deepEqual(log, ['git fetch origin main --quiet'], 'the base fetch failing must short-circuit before the branch fetch/probe');
    });
});

// ---------------------------------------------------------------------------
// commandResultToSoftGit(): pins the classification the resync tip-comparison
// depends on. execute_command NEVER sets isError on a non-zero exit, so `ok`
// MUST come from the exit code -- otherwise `git merge-base --is-ancestor`
// exit 1 (not-ancestor) is misread as success and unpushed work is reset.
// ---------------------------------------------------------------------------
describe('apra-fleet-p2to.4.2: commandResultToSoftGit() exit-code classification', () => {
    test('structuredContent.exitCode === 0 => ok:true', () => {
        const res = commandResultToSoftGit({ content: [{ text: 'Exit code: 0\n' }], structuredContent: { exitCode: 0 } });
        assert.equal(res.ok, true);
        assert.equal(res.error, undefined);
    });

    test('THE PIN: a non-zero exit (exit 1 = not-ancestor) => ok:false, EVEN when no isError flag is present (execute_command never sets one)', () => {
        // Exactly the shape execute_command returns for `git merge-base
        // --is-ancestor` when the branch is NOT an ancestor: exitCode 1, no
        // isError. Reading isError here would wrongly report success.
        const res = commandResultToSoftGit({ content: [{ text: 'Exit code: 1\n' }], structuredContent: { exitCode: 1 } });
        assert.equal(res.ok, false, 'a non-ancestor exit-1 must classify as NOT ok so the tip comparison is correct');
    });

    test('falls back to parsing the "Exit code: N" text line when structuredContent is absent', () => {
        assert.equal(commandResultToSoftGit({ content: [{ text: 'Exit code: 0\nup to date' }] }).ok, true);
        assert.equal(commandResultToSoftGit({ content: [{ text: 'Exit code: 1\nnot an ancestor' }] }).ok, false);
        assert.equal(commandResultToSoftGit('Exit code: 128\nfatal: bad').ok, false);
    });

    test('with no recoverable exit code at all, falls back to the isError flag (transport-level failure)', () => {
        assert.equal(commandResultToSoftGit({ isError: true, content: [{ text: 'transport blew up' }] }).ok, false);
        assert.equal(commandResultToSoftGit({ content: [{ text: 'no exit code here' }] }).ok, true);
    });

    test('exposes the command text as stdout for downstream error messages', () => {
        const res = commandResultToSoftGit({ content: [{ text: 'Exit code: 1\ncouldn\'t find remote ref feat/x' }], structuredContent: { exitCode: 1 } });
        assert.match(res.stdout, /couldn't find remote ref/);
        assert.match(res.error, /couldn't find remote ref/);
    });
});

// ---------------------------------------------------------------------------
// Guard: prove the end-to-end wiring the resync's classification relies on --
// a non-ancestor exit-1 result flowing through commandResultToSoftGit into
// resyncReacquiredMember yields the SAFE (non-destructive) decision, not a
// spurious reset. This is the concrete regression the review flagged.
// ---------------------------------------------------------------------------
describe('apra-fleet-p2to.4.2: exit-code classification feeds the resync decision safely', () => {
    test('execute_command-shaped results (exitCode only, no isError) classify local-ahead correctly and REUSE the branch instead of resetting it', async () => {
        // Emulate the fleet execute_command result shape for each git command.
        const asExec = (exitCode) => ({ content: [{ text: `Exit code: ${exitCode}\n` }], structuredContent: { exitCode } });
        const exitCodeFor = (cmd) => {
            if (cmd.includes('git fetch')) return 0;
            if (cmd.includes('rev-parse --verify')) return 0; // local branch exists
            if (cmd.includes('merge-base --is-ancestor feat/x origin/feat/x')) return 1; // local NOT ancestor of origin
            if (cmd.includes('merge-base --is-ancestor origin/feat/x feat/x')) return 0; // origin IS ancestor of local => ahead
            return 0;
        };
        const commands = [];
        const runGit = async (cmd) => {
            commands.push(cmd);
            return commandResultToSoftGit(asExec(exitCodeFor(cmd)));
        };
        await resyncReacquiredMember({ member: 'alice', branch: 'feat/x', baseBranch: 'main', runGit, doltPull: async () => {} });
        assert.ok(commands.includes('git checkout feat/x'), 'local-ahead must reuse the branch (git checkout <branch>)');
        assert.ok(!commands.includes('git checkout -B feat/x origin/feat/x'), 'must NOT hard-reset a locally-ahead branch to origin');
    });
});

// Belt-and-braces: decideEnsureBranchAction is the pure helper the resync feeds;
// pin the 'ahead' reuse decision it hands back so the resync's non-destructive
// behavior above cannot silently regress through a helper change.
describe('apra-fleet-p2to.4.2: decideEnsureBranchAction ahead-reuse contract (referenced by the resync)', () => {
    test("localTipStatus='ahead' => reuse local branch with a plain checkout (no -B reset)", () => {
        const d = decideEnsureBranchAction({
            branch: 'feat/x', baseBranch: 'main', branchFetchOk: true,
            localBranchExists: true, localTipStatus: 'ahead',
        });
        assert.equal(d.action, 'checkout');
        assert.equal(d.reused, true);
        assert.equal(d.command, 'git checkout feat/x');
    });
});
