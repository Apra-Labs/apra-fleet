import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    createVcsAuthPreflightCallback,
    createVcsAuthSelfHealCallback,
    syncMemberAfter,
} from '../fleet-sprint/runner.js';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(__dirname, '..', 'fleet-sprint', 'runner.js');
const runnerSource = fs.readFileSync(RUNNER_PATH, 'utf8');

// =============================================================================
// apra-fleet-glv.2: regression coverage for apra-fleet-glv's proactive VCS-
// auth PREFLIGHT (createVcsAuthPreflightCallback, runner.js) -- the
// counterpart to the REACTIVE self-heal covered by
// vcs-auth-self-heal.test.mjs. Four cases, per the bead:
//
//   1. mint-when-missing: a doer dispatch with NO prior credential mints one
//      via provision_vcs_auth exactly once before its turn starts.
//   2. skip-when-fresh: a dispatch with an already-fresh (non-expiring-soon)
//      credential triggers NO redundant provision call.
//   3. reactive-path-intact: fmu's reactive self-heal still fires (and
//      heals) for a genuinely long-running dispatch that outlasts the
//      preflight-minted token -- the two callbacks/caches are independent,
//      neither suppresses the other.
//   4. read-only-no-preflight: a read-only role dispatch (reviewer) never
//      triggers a preflight provision call, even when its member is
//      otherwise indistinguishable from a code-writing member.
//
// Cases 1-3 unit-test createVcsAuthPreflightCallback (and its coexistence
// with createVcsAuthSelfHealCallback) directly, mirroring the style of
// vcs-auth-self-heal.test.mjs / git-sync-brackets.test.mjs's (fmu) suite.
// Case 4 (plus a second look at case 1) drives the REAL runtime wiring --
// the `if (pushCode) { await ensureVcsAuthFresh(member); }` gate inside
// withGitSync, which is not itself an exported/unit-testable function --
// end to end via runDevelopLoopScenario with a real `args.callTool` and a
// `roleMap` that pins the read-only roles onto a member distinct from the
// doer, so "never triggers a preflight call" is a genuine runtime
// assertion, not just a static source-code check.
// =============================================================================

const OK = { ok: true, output: '', error: null };
const fail = (error) => ({ ok: false, output: '', error });

// Same tiny scripted command() mock used by git-sync-brackets.test.mjs's
// (fmu) self-heal suite: pass a map from cmd-substring -> a sequence of
// results (each { ok } or { ok:false, error }).
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

const remoteCommand = async (cmd) => {
    if (cmd === 'git remote get-url origin') {
        return { ok: true, output: 'https://github.com/acme/widgets.git', error: null };
    }
    return { ok: true, output: '', error: null };
};

const farFutureExpiry = () => new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h out

// apra-fleet-647.1.2.1: provisionVcsAuthForMember now resolves the member's
// provider via VCSModule.resolveProvider(), which itself calls
// fleetApi.memberDetail() (the 'member_detail' MCP tool) BEFORE ever calling
// provision_vcs_auth. Every callTool mock below must therefore answer
// 'member_detail' with a JSON body carrying a registered 'github' provider
// (mirroring src/tools/member-detail.ts's real json-format response) -- this
// resolver call is intercepted and answered here, NOT counted alongside the
// provision_vcs_auth calls each test tracks, so every existing call-count
// assertion below stays meaningful.
const MEMBER_DETAIL_GITHUB = { content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] };

describe('createVcsAuthPreflightCallback', () => {
    test('(case 1: mint-when-missing) mints a fresh VCS credential exactly once when no prior credential is cached for the member', async () => {
        const calls = [];
        const callTool = async (name, args) => {
            if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
            calls.push({ name, args });
            return { content: [{ text: `Provisioned VCS credential.\n  expiresAt: ${farFutureExpiry()}` }] };
        };
        const logs = [];
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({ callTool, command: remoteCommand, log: (m) => logs.push(m) });

        await ensureVcsAuthFresh('fleet-mac');

        assert.equal(calls.length, 1, `expected exactly one provision_vcs_auth call, got ${calls.length}`);
        assert.equal(calls[0].name, 'provision_vcs_auth');
        assert.deepEqual(calls[0].args, {
            member_name: 'fleet-mac',
            provider: 'github',
            github_mode: 'github-app',
            git_access: 'push',
            repos: ['acme/widgets'],
        });
        assert.ok(logs.some((l) => /preflight/.test(l) && /ensuring member 'fleet-mac'/.test(l)), `expected a preflight log entry, got: ${JSON.stringify(logs)}`);
        assert.ok(logs.some((l) => /preflight: provision_vcs_auth succeeded for member 'fleet-mac'/.test(l)), `expected a preflight success log entry, got: ${JSON.stringify(logs)}`);
    });

    test('(case 2: skip-when-fresh) repeated calls for the SAME member with a still-fresh (non-expiring-soon) cached credential trigger NO redundant provision_vcs_auth call', async () => {
        const calls = [];
        const callTool = async (name) => {
            if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
            calls.push(name);
            return { content: [{ text: `Provisioned.\n  expiresAt: ${farFutureExpiry()}` }] };
        };
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({ callTool, command: remoteCommand });

        await ensureVcsAuthFresh('fleet-mac');
        await ensureVcsAuthFresh('fleet-mac');
        await ensureVcsAuthFresh('fleet-mac');

        assert.equal(calls.length, 1, `expected exactly one mint call -- the two later calls must skip since the cached credential is not expiring soon, got ${calls.length}`);
    });

    test('a DIFFERENT member has its own independent cache entry (a fresh credential for one member never masks a missing one for another)', async () => {
        const calls = [];
        const callTool = async (name, args) => {
            if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
            calls.push(args.member_name);
            return { content: [{ text: `Provisioned.\n  expiresAt: ${farFutureExpiry()}` }] };
        };
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({ callTool, command: remoteCommand });

        await ensureVcsAuthFresh('member-a');
        await ensureVcsAuthFresh('member-b');
        await ensureVcsAuthFresh('member-a'); // cached, skipped
        await ensureVcsAuthFresh('member-b'); // cached, skipped

        assert.deepEqual(calls, ['member-a', 'member-b']);
    });

    test('re-provisions once the cached credential enters the expiring-soon window (mirrors the server-side EXPIRY_WARNING_MS threshold)', async () => {
        const calls = [];
        let nowMs = Date.now();
        const now = () => nowMs;
        const callTool = async (name) => {
            if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
            calls.push(nowMs);
            // Each mint expires 12 minutes out from "now" -- comfortably
            // outside the 10-minute preflight window until the clock below
            // advances far enough to eat into that margin.
            return { content: [{ text: `Provisioned.\n  expiresAt: ${new Date(nowMs + 12 * 60 * 1000).toISOString()}` }] };
        };
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({ callTool, command: remoteCommand, now });

        await ensureVcsAuthFresh('fleet-mac');
        assert.equal(calls.length, 1, 'first call always mints (no cache yet)');

        await ensureVcsAuthFresh('fleet-mac');
        assert.equal(calls.length, 1, 'still-fresh cached credential (12 min out) must not trigger a redundant call');

        // Advance the clock by 5 minutes: only 7 minutes remain on the
        // cached credential, inside the 10-minute expiring-soon window.
        nowMs += 5 * 60 * 1000;
        await ensureVcsAuthFresh('fleet-mac');
        assert.equal(calls.length, 2, 'a credential that has entered the expiring-soon window must trigger exactly one re-provision call');
    });

    test('a credential response carrying no expiry (PAT mode) is cached as "known-good, never needs refresh" -- never re-provisioned', async () => {
        const calls = [];
        const callTool = async (name) => {
            if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
            calls.push(1);
            return { content: [{ text: 'Provisioned VCS credential (PAT mode, no expiry).' }] };
        };
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({ callTool, command: remoteCommand });

        await ensureVcsAuthFresh('fleet-mac');
        await ensureVcsAuthFresh('fleet-mac');
        await ensureVcsAuthFresh('fleet-mac');

        assert.equal(calls.length, 1, 'a no-expiry (PAT) credential must be cached as permanently fresh, same "no expiry tracked -> OK" semantics as checkVcsTokenExpiry');
    });

    test('a provision_vcs_auth failure during preflight is logged and swallowed -- NEVER throws, never blocks the dispatch (the reactive self-heal remains the real safety net)', async () => {
        const callTool = async () => { throw new Error('provision_vcs_auth: fleet server unreachable'); };
        const logs = [];
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({ callTool, command: remoteCommand, log: (m) => logs.push(m) });

        await assert.doesNotReject(() => ensureVcsAuthFresh('fleet-mac'));
        assert.ok(
            logs.some((l) => /preflight: provision_vcs_auth failed for member 'fleet-mac'/.test(l) && /fleet server unreachable/.test(l)),
            `expected a swallowed-failure log entry, got: ${JSON.stringify(logs)}`,
        );
    });

    // =========================================================================
    // apra-fleet-647.1.2.2: the PROACTIVE preflight caller goes through
    // VCSModule.resolveProvider() too (via provisionVcsAuthForMember), exactly
    // like the reactive self-heal covered above and in
    // vcs-auth-self-heal.test.mjs. Same two cases the module-level
    // resolveProvider suite (vcs-module.test.mjs) cannot exercise on its own:
    // a non-GitHub-registered member, and a member with no registered
    // provider -- proven here through runner.js's real preflight call site,
    // not just resolveProvider() in isolation.
    // =========================================================================
    test('a member registered with a non-GitHub provider (bitbucket) resolves to that provider with NO github literal anywhere in the preflight call', async () => {
        const calls = [];
        const callTool = async (name, args) => {
            if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'bitbucket' }) }] };
            calls.push({ name, args });
            return { content: [{ text: `Provisioned.\n  expiresAt: ${farFutureExpiry()}` }] };
        };
        const bitbucketCommand = async (cmd) => {
            if (cmd === 'git remote get-url origin') {
                return { ok: true, output: 'https://bitbucket.org/acme/widgets.git', error: null };
            }
            return { ok: true, output: '', error: null };
        };
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({ callTool, command: bitbucketCommand });

        await ensureVcsAuthFresh('bb-member');

        assert.equal(calls.length, 1, `expected exactly one provision_vcs_auth call, got ${calls.length}`);
        assert.equal(calls[0].name, 'provision_vcs_auth');
        assert.deepEqual(calls[0].args, {
            member_name: 'bb-member',
            provider: 'bitbucket',
            git_access: 'push',
            repos: ['acme/widgets'],
        });
        assert.ok(!('github_mode' in calls[0].args), `expected no github_mode field for a non-GitHub provider, got: ${JSON.stringify(calls[0].args)}`);
        assert.ok(
            JSON.stringify(calls[0].args).indexOf('github') === -1,
            `expected no 'github' literal anywhere in a bitbucket member's preflight call, got: ${JSON.stringify(calls[0].args)}`,
        );
    });

    test('a member with NO registered VCS provider degrades silently (typed error logged, never thrown) and never calls provision_vcs_auth -- no silent GitHub default', async () => {
        const calls = [];
        const callTool = async (name, args) => {
            if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: undefined }) }] };
            calls.push({ name, args });
            return { content: [{ text: `Provisioned.\n  expiresAt: ${farFutureExpiry()}` }] };
        };
        const logs = [];
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({ callTool, command: remoteCommand, log: (m) => logs.push(m) });

        await assert.doesNotReject(() => ensureVcsAuthFresh('unprovisioned-member'));

        assert.equal(calls.length, 0, `expected NO provision_vcs_auth call for a member with no registered provider, got: ${JSON.stringify(calls)}`);
        assert.ok(
            logs.some((l) => /preflight: provision_vcs_auth failed for member 'unprovisioned-member'/.test(l) && /^.*ERROR:.*unprovisioned-member/.test(l)),
            `expected a swallowed typed-error log entry naming the member, got: ${JSON.stringify(logs)}`,
        );
    });

    test('(case 3: reactive-path-intact) a genuinely long-running dispatch that outlasts the preflight-minted token still heals via the REACTIVE self-heal, independently of the preflight cache', async () => {
        // The preflight mints a credential comfortably outside the
        // expiring-soon window -- on its own, this member's NEXT preflight
        // call (a later dispatch) would be skipped entirely on the cached
        // freshness alone.
        const preflightCalls = [];
        const preflightCallTool = async (name, args) => {
            if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
            preflightCalls.push({ name, args });
            return { content: [{ text: `Provisioned.\n  expiresAt: ${farFutureExpiry()}` }] };
        };
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({ callTool: preflightCallTool, command: remoteCommand });
        await ensureVcsAuthFresh('fleet-mac');
        assert.equal(preflightCalls.length, 1, 'preflight mints exactly once before the dispatch turn starts');

        // Simulate the actual long-running dispatch's G-push: the
        // preflight-minted credential turns out to have already lapsed by
        // the time the push runs (revoked out-of-band, or a real TTL
        // shorter than advertised) -- an auth-classified push failure that
        // fmu's REACTIVE self-heal (a separate callback/cache, wired
        // independently of the preflight above) must still catch and heal.
        const { command: pushCommand, calls: pushCalls } = makeCommandMock({
            'git push': [fail("fatal: could not read Username for 'https://github.com': Device not configured"), OK],
        });
        const healCalls = [];
        const healCallTool = async (name, args) => {
            if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
            healCalls.push({ name, args });
            return { content: [{ text: 'Provisioned.' }] };
        };
        const onAuthFailure = createVcsAuthSelfHealCallback({ callTool: healCallTool, command: pushCommand });

        const res = await syncMemberAfter('fleet-mac', { command: pushCommand, onAuthFailure });

        assert.equal(res.ok, true, `expected the push to ultimately succeed after the reactive heal, got: ${JSON.stringify(res)}`);
        assert.equal(res.pushed, true);
        assert.equal(healCalls.length, 1, 'the reactive self-heal must still fire and provision exactly once, independent of the preflight cache');
        assert.equal(
            pushCalls.filter((c) => /git push/.test(c.cmd)).length,
            2,
            'push retried exactly once after the reactive heal (bounded, not a loop)',
        );

        // Across BOTH paths: one preflight mint + one reactive heal -- the
        // preflight cache never suppresses the reactive path, and the
        // reactive path never duplicates the preflight's own call.
        assert.equal(preflightCalls.length + healCalls.length, 2);
    });
});

// =============================================================================
// (case 4: read-only-no-preflight, plus a second, end-to-end look at case 1)
//
// Drives the REAL runner.js wiring: a real `args.callTool` (source 2 of the
// three-source `ensureVcsAuthFresh` precedence -- see runner.js's doc
// comment above its construction in runSprintCycle) through a full mock
// sprint cycle, with `roleMap` pinning the read-only roles onto a member
// distinct from the doer. The `if (pushCode) { await ensureVcsAuthFresh(
// member); }` gate lives inline in withGitSync (not itself an exported,
// unit-testable function), so this is the only way to assert its runtime
// behavior rather than just the callback's own internals above.
// =============================================================================
describe('runSprintCycle: the real withGitSync pushCode-gated preflight wiring', () => {
    test('a doer dispatch with no prior credential mints exactly once before its turn starts; read-only role dispatches never trigger a preflight call', async () => {
        await withScenarioMarkers('glv.2 preflight end-to-end', async () => {
            const vcsCalls = [];
            const callTool = async (name, args) => {
                if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
                if (name === 'provision_vcs_auth') {
                    vcsCalls.push(args);
                    return { content: [{ text: `Provisioned.\n  expiresAt: ${farFutureExpiry()}` }] };
                }
                return { content: [{ text: 'ok' }] };
            };

            const result = await runDevelopLoopScenario('glv2preflight', {
                members: ['member-doer'],
                roleMap: {
                    reviewer: ['member-reviewer'],
                    deployer: ['member-reviewer'],
                    'integ-test-runner': ['member-reviewer'],
                },
                taskSpecs: [{ title: 'Task: exercise the VCS-auth preflight' }],
                callTool,
                reviewerHandler: async () => ({
                    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
                }),
            });

            assert.ok(!result.error, `scenario should not abort: ${result.error ? result.error.message : ''}`);
            // apra-fleet-tfx.8/tfx.8.4: raiseVcsPrForMember() mints its OWN
            // just-in-time push+pr credential immediately before the PR
            // dispatch, IN ADDITION to any push preflight -- so this
            // scenario (which runs to a successful PR-raising Publish PR
            // step) now expects exactly TWO provision_vcs_auth calls: the
            // withGitSync preflight's 'push' mint before the doer's first
            // pushCode:true dispatch, and the PR step's separate 'push+pr'
            // mint. Both target the same code-writing member; the harvester's
            // later dispatch still skips on the cached-fresh 'push'
            // credential (proof the preflight cache itself is unaffected).
            assert.equal(
                vcsCalls.length,
                2,
                `expected exactly two provision_vcs_auth calls (the doer's preflight 'push' mint, and the PR step's just-in-time 'push+pr' mint; the harvester's later dispatch on the SAME member must still skip on the cached-fresh 'push' credential), got ${vcsCalls.length}: ${JSON.stringify(vcsCalls)}`,
            );
            assert.ok(
                vcsCalls.every((c) => c.member_name === 'member-doer'),
                `expected both preflight and JIT PR-provisioning calls to target the code-writing member, got: ${JSON.stringify(vcsCalls)}`,
            );
            assert.ok(
                vcsCalls.some((c) => c.git_access === 'push'),
                `expected one call to be the withGitSync preflight's 'push' mint, got: ${JSON.stringify(vcsCalls)}`,
            );
            assert.ok(
                vcsCalls.some((c) => c.git_access === 'push+pr'),
                `expected one call to be the PR step's just-in-time 'push+pr' mint, got: ${JSON.stringify(vcsCalls)}`,
            );
            assert.ok(
                vcsCalls.every((c) => c.member_name !== 'member-reviewer'),
                `a read-only role member must never trigger a preflight provision_vcs_auth call, got: ${JSON.stringify(vcsCalls)}`,
            );

            const doerClosed = [...result.finalBeadsById.values()].some((b) => b.status === 'closed');
            assert.ok(doerClosed, 'sanity check: the doer dispatch actually ran and closed its assigned task');
        });
    });
});

// =============================================================================
// apra-fleet-417.4: coverage for withGitSync's `needsVcsAuth` preflight
// gating -- apra-fleet-647.1.1.2 extended the proactive preflight from a bare
// `if (pushCode)` check to `needsVcsAuth = pushCode || pushBeads` (default),
// so a READ-SIDE bracket that still mutates beads (planner, integ-test-
// runner, regression-test-runner -- each D-pushes via `bd dolt push`, which
// shells out to git and hits the exact same credential surface as `git
// push`) gets the same proactive refresh a code-writing bracket always had,
// while a genuinely pure read-only bracket (reviewer, plan-reviewer,
// deployer) still gets none. This was landed with NO test pinning it (see
// this bead's description) -- the suite above only ever exercised pushCode
// (the doer) and the read-only default (reviewer), never a pushBeads:true
// bracket that pushes NO code, which is the entire point of the widened
// gate. The tests below close that gap.
//
// Same technique as the 'runSprintCycle: the real withGitSync pushCode-gated
// preflight wiring' describe block above: withGitSync is an inner function
// of runSprintCycle and cannot be imported directly, so the ONLY way to
// assert its runtime gating behavior is end to end, via a real mock-sprint
// cycle with `roleMap` pinning each role under test onto its OWN dedicated
// member -- so "this member never got a preflight call" is a genuine
// per-member runtime assertion, not a static source-code check.
// =============================================================================
describe('runSprintCycle: the real withGitSync needsVcsAuth (pushBeads-only) preflight wiring', () => {
    // One dedicated member per role under test, so every assertion below is
    // "did a preflight call/log line name THIS member", never ambiguous
    // about which role produced it.
    const ROLE_MEMBERS = {
        planner: 'member-planner',
        'integ-test-runner': 'member-integ',
        'regression-test-runner': 'member-regression',
        reviewer: 'member-readonly',
        'plan-reviewer': 'member-readonly',
        deployer: 'member-readonly',
    };

    const preflightLineFor = (member) =>
        new RegExp(`\\[Sync\\] preflight: member '${member}' needs a fresh VCS credential before this dispatch \\(pushCode=false, pushBeads=true, needsVcsAuth=true\\)`);

    test('(criteria 1 & 2, MUTATION CHECK target) a pushBeads:true READ-SIDE bracket (planner, integ-test-runner, regression-test-runner) emits the preflight log line AND calls provision_vcs_auth for its OWN member; a pure read-only bracket (reviewer, plan-reviewer, deployer) sharing one member emits NEITHER, for any of the three roles routed onto it', async () => {
        await withScenarioMarkers('417.4 pushBeads-only preflight', async () => {
            const vcsCalls = [];
            const callTool = async (name, args) => {
                if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
                if (name === 'provision_vcs_auth') {
                    vcsCalls.push(args);
                    return { content: [{ text: `Provisioned.\n  expiresAt: ${farFutureExpiry()}` }] };
                }
                return { content: [{ text: 'ok' }] };
            };

            const result = await runDevelopLoopScenario('417_4pushbeads', {
                members: ['member-doer'],
                roleMap: {
                    planner: [ROLE_MEMBERS.planner],
                    'integ-test-runner': [ROLE_MEMBERS['integ-test-runner']],
                    'regression-test-runner': [ROLE_MEMBERS['regression-test-runner']],
                    reviewer: [ROLE_MEMBERS.reviewer],
                    'plan-reviewer': [ROLE_MEMBERS['plan-reviewer']],
                    deployer: [ROLE_MEMBERS.deployer],
                },
                withRunbooks: true,
                withRegressionPlaybook: true,
                taskSpecs: [{ title: 'Task: exercise the pushBeads-only preflight gating' }],
                callTool,
                reviewerHandler: async () => ({
                    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
                }),
            });

            assert.ok(!result.error, `scenario should not abort: ${result.error ? result.error.message : ''}`);

            // --- criterion 1: each pushBeads:true read-side role dispatched
            //     to its own member, and THAT member got a preflight. If
            //     runner.js's needsVcsAuth gate is ever reverted from
            //     `pushCode || pushBeads` to plain `if (pushCode)` (the
            //     bead's stated MUTATION CHECK), every assertion in this
            //     block fails: none of these three roles ever sets
            //     pushCode:true.
            for (const role of ['planner', 'integ-test-runner', 'regression-test-runner']) {
                const member = ROLE_MEMBERS[role];
                assert.ok(
                    result.dispatched.some((d) => d.agent === role && d.member === member),
                    `expected role '${role}' to have actually dispatched to its dedicated member '${member}', got: ${JSON.stringify(result.dispatched.map((d) => ({ agent: d.agent, member: d.member })))}`,
                );
                assert.ok(
                    result.logs.some((l) => preflightLineFor(member).test(l)),
                    `expected a '[Sync] preflight:' log line for pushBeads:true role '${role}' (member '${member}'), got logs: ${JSON.stringify(result.logs.filter((l) => l.includes('[Sync] preflight')))}`,
                );
                assert.ok(
                    vcsCalls.some((c) => c.member_name === member),
                    `expected a provision_vcs_auth call for pushBeads:true role '${role}' (member '${member}'), got calls: ${JSON.stringify(vcsCalls)}`,
                );
            }

            // --- criterion 2: the shared read-only member (reviewer +
            //     plan-reviewer + deployer, all dispatched to it this
            //     scenario) never triggers a preflight log line or a
            //     provision_vcs_auth call, despite handling three different
            //     roles across the cycle.
            for (const role of ['reviewer', 'plan-reviewer', 'deployer']) {
                assert.ok(
                    result.dispatched.some((d) => d.agent === role && d.member === ROLE_MEMBERS[role]),
                    `sanity check: expected read-only role '${role}' to have actually dispatched to '${ROLE_MEMBERS[role]}'`,
                );
            }
            assert.ok(
                !result.logs.some((l) => l.includes('[Sync] preflight') && l.includes(`'${ROLE_MEMBERS.reviewer}'`)),
                `expected NO '[Sync] preflight:' log line naming the read-only member '${ROLE_MEMBERS.reviewer}', got: ${JSON.stringify(result.logs.filter((l) => l.includes('[Sync] preflight')))}`,
            );
            assert.ok(
                !vcsCalls.some((c) => c.member_name === ROLE_MEMBERS.reviewer),
                `expected NO provision_vcs_auth call for the read-only member '${ROLE_MEMBERS.reviewer}', got: ${JSON.stringify(vcsCalls)}`,
            );

            const doerClosed = [...result.finalBeadsById.values()].some((b) => b.status === 'closed');
            assert.ok(doerClosed, 'sanity check: the doer dispatch actually ran and closed its assigned task');
        });
    });

    test('(criterion 4) a preflight FAILURE at a pushBeads:true read-side bracket is logged and swallowed -- the dispatch still runs and the sprint still completes', async () => {
        await withScenarioMarkers('417.4 preflight failure swallowed', async () => {
            const vcsCalls = [];
            const callTool = async (name, args) => {
                if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
                if (name === 'provision_vcs_auth') {
                    if (args.member_name === ROLE_MEMBERS.planner) {
                        throw new Error('provision_vcs_auth: fleet server unreachable (injected)');
                    }
                    vcsCalls.push(args);
                    return { content: [{ text: `Provisioned.\n  expiresAt: ${farFutureExpiry()}` }] };
                }
                return { content: [{ text: 'ok' }] };
            };

            const result = await runDevelopLoopScenario('417_4preflightfail', {
                members: ['member-doer'],
                roleMap: {
                    planner: [ROLE_MEMBERS.planner],
                    reviewer: [ROLE_MEMBERS.reviewer],
                    'plan-reviewer': [ROLE_MEMBERS['plan-reviewer']],
                    deployer: [ROLE_MEMBERS.deployer],
                },
                taskSpecs: [{ title: 'Task: exercise a swallowed preflight failure' }],
                callTool,
                reviewerHandler: async () => ({
                    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
                }),
            });

            assert.ok(!result.error, `a preflight failure must never abort the sprint: ${result.error ? result.error.message : ''}`);
            assert.ok(
                result.dispatched.some((d) => d.agent === 'planner' && d.member === ROLE_MEMBERS.planner),
                'the planner dispatch itself must still run despite its own preflight mint failing',
            );
            assert.ok(
                result.logs.some((l) => l.includes(`preflight: provision_vcs_auth failed for member '${ROLE_MEMBERS.planner}'`) && l.includes('fleet server unreachable (injected)')),
                `expected a swallowed-failure log entry naming '${ROLE_MEMBERS.planner}', got: ${JSON.stringify(result.logs.filter((l) => l.includes('preflight')))}`,
            );
            const doerClosed = [...result.finalBeadsById.values()].some((b) => b.status === 'closed');
            assert.ok(doerClosed, 'sanity check: the sprint ran to completion (doer closed its task) despite the swallowed preflight failure');
        });
    });
});

// =============================================================================
// apra-fleet-417.4, criterion 3: the `needsVcsAuth` DEFAULT is pinned to
// exactly `pushCode || pushBeads` at withGitSync's own signature (a source
// assertion, since withGitSync cannot be imported), and its OR semantics are
// unit-mirrored across the full truth table -- including the one combination
// no CURRENT runner.js call site exercises: an explicit `needsVcsAuth: true`
// override with BOTH pushCode:false and pushBeads:false. withGitSync's own
// doc comment (just above its definition) describes this shape as reserved
// for "a bracket that will raise a PR (or otherwise needs a fresh
// credential) even with pushCode:false and pushBeads:false" -- no such
// bracket exists in runner.js today (grep for `needsVcsAuth: true` across
// the file finds none), so it cannot be driven end to end via the mock-
// sprint harness the way criteria 1/2/4 above are. The mirror below is tied
// back to the real source by the regex assertion immediately preceding it:
// if the two ever diverge (e.g. the real signature is edited but this mirror
// is not), that assertion fails first, so the mirror can never quietly test
// something the real function no longer does. Given that tie, ordinary JS
// default-parameter semantics (an explicitly-passed value always wins over a
// default) are what guarantee the override behaves identically in the real
// withGitSync.
// =============================================================================
describe('withGitSync needsVcsAuth default: pinned to the source, OR semantics unit-mirrored', () => {
    test("withGitSync's signature computes needsVcsAuth as exactly `pushCode || pushBeads` by default", () => {
        assert.match(
            runnerSource,
            /async function withGitSync\(member, pushCode, dispatchFn, \{ pushBeads = false, needsVcsAuth = pushCode \|\| pushBeads,/,
            "withGitSync's needsVcsAuth default must stay exactly `pushCode || pushBeads` (apra-fleet-647.1.1.2) -- reverting to a plain `pushCode` check (or any other expression) silently drops the preflight for every pushBeads-only bracket (planner, integ-test-runner, regression-test-runner).",
        );
    });

    // Mirrors withGitSync's exact default-parameter destructuring, pinned to
    // the source by the assertion above.
    function computeNeedsVcsAuth(pushCode, { pushBeads = false, needsVcsAuth = pushCode || pushBeads } = {}) {
        return needsVcsAuth;
    }

    test('OR truth table -- both false: a pure read-only bracket (reviewer/plan-reviewer/deployer) computes needsVcsAuth=false', () => {
        assert.equal(computeNeedsVcsAuth(false, {}), false);
    });

    test('OR truth table -- pushCode:true, pushBeads:false: a code-writing-only bracket still computes needsVcsAuth=true (pre-existing pushCode gate, unchanged)', () => {
        assert.equal(computeNeedsVcsAuth(true, { pushBeads: false }), true);
    });

    test('OR truth table -- pushCode:false, pushBeads:true: the apra-fleet-647.1.1.2 fix itself -- a read-side-but-beads-pushing bracket (planner/integ-test-runner/regression-test-runner) computes needsVcsAuth=true even though it never touches code', () => {
        assert.equal(computeNeedsVcsAuth(false, { pushBeads: true }), true);
    });

    test('OR truth table -- both true: a bracket that pushes both code and beads (doer/harvester) computes needsVcsAuth=true', () => {
        assert.equal(computeNeedsVcsAuth(true, { pushBeads: true }), true);
    });

    test('(criterion 3) an explicit needsVcsAuth:true override still triggers the preflight even with pushCode:false AND pushBeads:false -- the one combination no current runner.js call site exercises, reserved for a bracket that must proactively refresh credentials for a reason other than pushing code/beads (e.g. it will raise a PR)', () => {
        assert.equal(computeNeedsVcsAuth(false, { pushBeads: false, needsVcsAuth: true }), true);
    });

    test('an explicit needsVcsAuth:false override suppresses the preflight even when the default alone would have computed true (pushBeads:true)', () => {
        assert.equal(computeNeedsVcsAuth(false, { pushBeads: true, needsVcsAuth: false }), false);
    });
});
