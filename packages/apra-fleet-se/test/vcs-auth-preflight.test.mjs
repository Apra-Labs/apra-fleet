import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
    createVcsAuthPreflightCallback,
    createVcsAuthSelfHealCallback,
    syncMemberAfter,
} from '../fleet-sprint/runner.js';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

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

describe('createVcsAuthPreflightCallback', () => {
    test('(case 1: mint-when-missing) mints a fresh VCS credential exactly once when no prior credential is cached for the member', async () => {
        const calls = [];
        const callTool = async (name, args) => {
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
        const callTool = async () => {
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
        const callTool = async () => { calls.push(1); return { content: [{ text: 'Provisioned VCS credential (PAT mode, no expiry).' }] }; };
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

    test('(case 3: reactive-path-intact) a genuinely long-running dispatch that outlasts the preflight-minted token still heals via the REACTIVE self-heal, independently of the preflight cache', async () => {
        // The preflight mints a credential comfortably outside the
        // expiring-soon window -- on its own, this member's NEXT preflight
        // call (a later dispatch) would be skipped entirely on the cached
        // freshness alone.
        const preflightCalls = [];
        const preflightCallTool = async (name, args) => {
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
        const healCallTool = async (name, args) => { healCalls.push({ name, args }); return { content: [{ text: 'Provisioned.' }] }; };
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
