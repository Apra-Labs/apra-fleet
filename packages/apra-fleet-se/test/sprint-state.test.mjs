import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

import {
    createSprintState,
    sprintScopedFleetApi,
    resolveSettleShellWith,
    clearSprintStateClientCache,
    SPRINT_STATE_CLIENT_CONSTRUCTED_LOG,
} from '../fleet-sprint/sprint-state.mjs';
import { clearMemberOsCache } from '../fleet-sprint/member-target.mjs';
import { GUARDED_MODULES } from '../fleet-sprint/guarded-modules.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLEET_SPRINT_DIR = path.join(__dirname, '../fleet-sprint');
const RUNNER_PATH = path.join(FLEET_SPRINT_DIR, 'runner.js');
const SPRINT_STATE_PATH = path.join(FLEET_SPRINT_DIR, 'sprint-state.mjs');

// =============================================================================
// apra-fleet-3swo.6.1 -- sprint-state.mjs: the per-sprint resolved state.
//
// WHAT IS AND IS NOT WORTH ASSERTING HERE (the non-vacuity trap this bead
// calls out explicitly): "member_detail is dispatched at most once per member"
// was ALREADY true before this change, because member-target.mjs's
// memberOsCache is a module-level Map for the lifetime of the runner process,
// independent of which fleet client calls it. Asserting that would pass with
// this whole task reverted.
//
// The property this change actually creates is one level lower: the
// settle-shell path used to build a brand new fleet client
// (`new ApraFleet({ callTool })`) on EVERY invocation -- an object whose
// construction issues no MCP call at all, so it is invisible to a
// callTool-counting assertion. It is now built once per sprint. That is what
// the counting tests below pin, through the `createFleetApi` construction seam
// sprint-state.mjs exposes for exactly this reason, and each one carries a
// PRE-CHANGE CONTROL that re-runs the same resolutions with the old per-call
// construction shape so the "1" is demonstrably not a number that any
// implementation would produce.
// =============================================================================

/** A fleetApi stub with just the surface resolveMemberTarget uses. */
function fleetApiStub(memberDetail) {
    return { memberDetail };
}

/** member_detail JSON response carrying an os (and optionally a shell). */
const detail = (os, shell) => ({ content: [{ text: JSON.stringify(shell === undefined ? { os } : { os, shell }) }] });

/** A counting construction seam: records every client construction. */
function countingFactory(memberDetail) {
    const constructed = [];
    return {
        constructed,
        createFleetApi(opts) {
            constructed.push(opts);
            return fleetApiStub(memberDetail);
        },
    };
}

describe('sprint-state: one fleet client per sprint on the settle-shell path', () => {
    test('serving many settle-shell resolutions, across several members and repeated members, constructs AT MOST ONE fleet client (pre-change control: the same resolutions built one per call)', async () => {
        clearMemberOsCache();
        clearSprintStateClientCache();
        const memberDetailCalls = [];
        const memberDetail = async ({ member_name }) => {
            memberDetailCalls.push(member_name);
            return detail('windows', 'gitbash');
        };
        const { constructed, createFleetApi } = countingFactory(memberDetail);
        const callTool = async () => ({ content: [{ text: 'unused' }] });

        // ONE sprint state, created once -- exactly as runSprintCycle does.
        const sprintState = createSprintState({ callTool, log: () => {}, createFleetApi });

        // Seven resolutions: the same count as the seven runner.js call sites
        // this hoist covers, over three distinct members (so the resolution
        // count is genuinely higher than the member count).
        const members = ['sprintstate-a', 'sprintstate-b', 'sprintstate-a', 'sprintstate-c', 'sprintstate-b', 'sprintstate-a', 'sprintstate-c'];
        const shells = [];
        for (const member of members) {
            shells.push(await sprintState.resolveSettleShell({ member }));
        }

        assert.deepEqual(shells, Array(7).fill('gitbash'), 'every resolution must still return the member\'s registered shell');
        assert.equal(
            constructed.length,
            1,
            `the settle-shell path must construct at most one fleet client per sprint; got ${constructed.length} for ${members.length} resolutions`,
        );

        // PRE-CHANGE CONTROL: the shape runner.js's resolveSettleShell used to
        // have -- construct a client, then resolve -- for the SAME seven
        // resolutions. If "1" above were an artifact of the counting rather
        // than of the hoist, this would report 1 too.
        const control = countingFactory(memberDetail);
        for (const member of members) {
            await resolveSettleShellWith({ fleetApi: control.createFleetApi({ callTool }), member, log: () => {} });
        }
        assert.equal(
            control.constructed.length,
            members.length,
            'pre-change control: per-call construction must report one client PER resolution -- otherwise the assertion above proves nothing',
        );

        clearMemberOsCache();
        clearSprintStateClientCache();
    });

    test('a call site handed only `callTool` (no sprint state -- syncMemberAfterOrdered, reached from git-sync\'s teardown) shares the sprint\'s single client instead of building its own', async () => {
        clearMemberOsCache();
        clearSprintStateClientCache();
        const memberDetail = async () => detail('linux', '');
        const { constructed, createFleetApi } = countingFactory(memberDetail);
        const callTool = async () => ({ content: [{ text: 'unused' }] });

        const sprintState = createSprintState({ callTool, log: () => {}, createFleetApi });
        await sprintState.resolveSettleShell({ member: 'sprintstate-shared' });

        // The no-sprint-state fallback: same callTool identity, so the memo
        // must hand back the client already built above.
        const fallback = sprintScopedFleetApi({ callTool, log: () => {}, createFleetApi });
        assert.equal(fallback, sprintState.fleetApi, 'the fallback path must reuse the sprint-scoped client, not a fresh one');
        assert.equal(constructed.length, 1, `expected one construction shared by both paths, got ${constructed.length}`);

        clearMemberOsCache();
        clearSprintStateClientCache();
    });

    test('the client construction is logged exactly once per sprint (the observable a whole-sprint run counts)', async () => {
        clearMemberOsCache();
        clearSprintStateClientCache();
        const logs = [];
        const { createFleetApi } = countingFactory(async () => detail('linux', ''));
        const callTool = async () => ({ content: [{ text: 'unused' }] });

        const sprintState = createSprintState({ callTool, log: (m) => logs.push(m), createFleetApi });
        for (const member of ['sprintstate-log-a', 'sprintstate-log-b', 'sprintstate-log-a']) {
            await sprintState.resolveSettleShell({ member });
        }

        assert.equal(
            logs.filter((l) => l === SPRINT_STATE_CLIENT_CONSTRUCTED_LOG).length,
            1,
            `expected exactly one client-construction log line, got: ${JSON.stringify(logs)}`,
        );

        clearMemberOsCache();
        clearSprintStateClientCache();
    });
});

describe('sprint-state: the deliberately UNCACHED degrade must survive the hoist', () => {
    test('a member whose FIRST resolution degrades (member_detail fails) is re-resolved on a later call and observes the real os/shell, not a pinned linux/empty pair', async () => {
        clearMemberOsCache();
        clearSprintStateClientCache();
        let calls = 0;
        const memberDetail = async () => {
            calls += 1;
            if (calls === 1) throw new Error('transient: member briefly unreachable');
            return detail('windows', 'pwsh7');
        };
        const { constructed, createFleetApi } = countingFactory(memberDetail);
        const logs = [];
        const callTool = async () => ({ content: [{ text: 'unused' }] });
        const sprintState = createSprintState({ callTool, log: (m) => logs.push(m), createFleetApi });
        const member = 'sprintstate-flaky-windows';

        const first = await sprintState.resolveSettleShell({ member });
        assert.equal(first, '', 'a transient member_detail failure must degrade to the empty shell (POSIX-assumed) for THIS call');
        assert.equal(calls, 1);
        assert.ok(
            logs.some((l) => /Could not resolve OS for member 'sprintstate-flaky-windows'/.test(l)),
            `the degrade must be logged, not silent; got: ${JSON.stringify(logs)}`,
        );

        // THE assertion: sprint state must NOT have frozen that fallback.
        const second = await sprintState.resolveSettleShell({ member });
        assert.equal(second, 'pwsh7', 'the degrade must not be cached by sprint state -- the later call must re-resolve and see the real registered shell');
        assert.equal(calls, 2, 'member_detail must be re-dispatched after a degrade, not served from a sprint-state cache');

        // ...while a SUCCESSFUL resolution is still served from
        // member-target.mjs's cache, and the client is still built once.
        const third = await sprintState.resolveSettleShell({ member });
        assert.equal(third, 'pwsh7');
        assert.equal(calls, 2, 'a successful resolution IS cached by member-target.mjs -- no third member_detail');
        assert.equal(constructed.length, 1, 'the re-resolution must not cost an extra fleet client');

        clearMemberOsCache();
        clearSprintStateClientCache();
    });

    test('sprint-state holds NO per-member shell cache of its own -- the source carries no Map/cache on the resolution path', () => {
        const src = fs.readFileSync(SPRINT_STATE_PATH, 'utf8');
        // The one memo this module is allowed is the callTool -> client
        // WeakMap. A per-member Map here would cache the degrade by
        // construction (the exact regression the bead forbids), so its
        // absence is pinned mechanically, not just by the behavior above.
        assert.equal(
            (src.match(/new Map\(/g) || []).length,
            0,
            'sprint-state.mjs must not introduce a Map cache: member-target.mjs owns the { os, shell } cache and deliberately does not cache its degrade',
        );
        assert.equal(
            (src.match(/new WeakMap\(/g) || []).length,
            2,
            'the only memo here is the callTool -> client WeakMap (declared once, re-created once by the clear seam)',
        );
    });
});

describe('sprint-state: the resolved shell value set is unchanged for its downstream consumers', () => {
    // dolt-settle.mjs, vcs-providers/azure-devops.mjs and
    // vcs-providers/shell-helpers.mjs consume exactly these four values.
    for (const shell of ['gitbash', 'pwsh7', 'powershell5', '']) {
        test(`a member registered with shell '${shell}' still resolves to '${shell}'`, async () => {
            clearMemberOsCache();
            clearSprintStateClientCache();
            const { createFleetApi } = countingFactory(async () => detail('windows', shell));
            const callTool = async () => ({ content: [{ text: 'unused' }] });
            const sprintState = createSprintState({ callTool, log: () => {}, createFleetApi });

            const resolved = await sprintState.resolveSettleShell({ member: `sprintstate-shellset-${shell || 'empty'}` });
            assert.equal(resolved, shell);

            clearMemberOsCache();
            clearSprintStateClientCache();
        });
    }

    test('with no callTool wired (a mock-sprint scenario with no MCP client) the resolution is the pre-shell-aware empty string, and no client is built', async () => {
        clearMemberOsCache();
        clearSprintStateClientCache();
        const sprintState = createSprintState({ log: () => {} });
        assert.equal(sprintState.fleetApi, null, 'no callTool means there is nothing to build a client over');
        assert.equal(await sprintState.resolveSettleShell({ member: 'sprintstate-no-mcp' }), '');
        clearMemberOsCache();
        clearSprintStateClientCache();
    });
});

describe('sprint-state: the relocated VCS provider resolver', () => {
    test('is created once per sprint, resolves a member\'s provider, and caches per member', async () => {
        const calls = [];
        const callTool = async (name, toolArgs) => {
            calls.push({ name, member: toolArgs && toolArgs.member_name });
            if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'azure-devops' }) }] };
            throw new Error(`unexpected callTool: ${name}`);
        };
        const sprintState = createSprintState({ callTool, log: () => {} });

        assert.equal(typeof sprintState.resolveMemberProvider, 'function');
        assert.equal(await sprintState.resolveMemberProvider('sprintstate-ado'), 'azure-devops');
        assert.equal(await sprintState.resolveMemberProvider('sprintstate-ado'), 'azure-devops');
        assert.equal(calls.length, 1, `the relocated resolver must keep its own per-member cache, got: ${JSON.stringify(calls)}`);
    });

    test('an unresolvable provider still degrades to the default chain: undefined, logged non-fatally, never thrown, and cached exactly once', async () => {
        const calls = [];
        const logs = [];
        const callTool = async (name) => {
            calls.push(name);
            if (name === 'member_detail') return { content: [{ text: 'no member found matching "sprintstate-ghost"' }] };
            throw new Error(`unexpected callTool: ${name}`);
        };
        const sprintState = createSprintState({ callTool, log: (m) => logs.push(m) });

        let first;
        await assert.doesNotReject(async () => { first = await sprintState.resolveMemberProvider('sprintstate-ghost'); });
        const second = await sprintState.resolveMemberProvider('sprintstate-ghost');

        assert.equal(first, undefined, 'an unresolvable provider must fail closed to the default provider chain');
        assert.equal(second, undefined);
        assert.equal(calls.length, 1, 'the undefined must be cached exactly once, not re-queried per git failure');
        assert.ok(
            logs.some((l) => /could not resolve member 'sprintstate-ghost'/.test(l)),
            `the degrade must be logged non-fatally; got: ${JSON.stringify(logs)}`,
        );
    });

    test('with no callTool wired the resolver is undefined -- the pre-existing tier-3 default-chain behavior', () => {
        const sprintState = createSprintState({ log: () => {} });
        assert.equal(sprintState.resolveMemberProvider, undefined);
    });
});

// =============================================================================
// SOURCE PINS. Two of this bead's criteria are about there being exactly ONE
// construction site each -- a property no behavioral test can observe, because
// a second construction site produces identical behavior (just extra clients /
// a second cold provider cache). They are pinned by scanning the source, the
// same technique the guard tests in this directory use.
// =============================================================================

/** Every .mjs/.js file under fleet-sprint/, recursively. */
function fleetSprintSources(dir = FLEET_SPRINT_DIR, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) fleetSprintSources(full, acc);
        else if (/\.(mjs|js)$/.test(entry.name)) acc.push(full);
    }
    return acc;
}

/**
 * Call sites of `name` across fleet-sprint/: lines containing `name(` that are
 * neither the function's own declaration nor a comment. An import/export list
 * never writes the name with an open paren, so it cannot match.
 */
function callSites(name) {
    const found = [];
    for (const file of fleetSprintSources()) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
            if (new RegExp(`\\b(export\\s+)?(async\\s+)?function\\s+${name}\\s*\\(`).test(trimmed)) return;
            if (new RegExp(`\\b${name}\\s*\\(`).test(line)) found.push(`${path.basename(file)}:${i + 1}`);
        });
    }
    return found;
}

describe('sprint-state: exactly one construction site each', () => {
    test('createSprintState is called from exactly one place -- runner.js (once per sprint), not per phase or per call site', () => {
        const sites = callSites('createSprintState');
        assert.deepEqual(
            sites.map((s) => s.split(':')[0]),
            ['runner.js'],
            `sprint state must be created exactly once, in runner.js; found: ${JSON.stringify(sites)}`,
        );
    });

    test('createMemberVcsProviderResolver is constructed in exactly one place -- sprint-state.mjs. No phase module may build a second resolver', () => {
        const sites = callSites('createMemberVcsProviderResolver');
        assert.deepEqual(
            sites.map((s) => s.split(':')[0]),
            ['sprint-state.mjs'],
            `the provider resolver must have exactly one construction site (sprint-state.mjs); found: ${JSON.stringify(sites)}`,
        );
    });

    test('runner.js\'s resolveSettleShell no longer constructs a fleet client of its own', () => {
        const src = fs.readFileSync(RUNNER_PATH, 'utf8');
        const start = src.indexOf('async function resolveSettleShell(');
        assert.ok(start > 0, 'resolveSettleShell must still exist in runner.js (anchor by symbol, not line number)');
        const end = src.indexOf('\n}\n', start);
        assert.ok(end > start, 'failed to slice resolveSettleShell\'s body');
        const body = src.slice(start, end);
        assert.ok(
            !/new ApraFleet\(/.test(body),
            `resolveSettleShell must resolve through sprint state, not build a client per call; body was:\n${body}`,
        );
        assert.ok(/sprintState/.test(body), 'resolveSettleShell must accept and prefer the threaded sprint state');
    });

    test('sprint-state.mjs is registered in the shared guarded-module list (registration is part of the extraction, not a follow-up)', () => {
        assert.ok(
            GUARDED_MODULES.includes('sprint-state.mjs'),
            `sprint-state.mjs must be registered in GUARDED_MODULES or all five mechanical guards silently skip it; got: ${JSON.stringify(GUARDED_MODULES)}`,
        );
    });
});
