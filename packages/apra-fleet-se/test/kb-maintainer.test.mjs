import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createKbMaintainerSelector,
    createMemberDetailResolver,
    orderMaintainerCandidates,
    roleMappedMembers,
    ROLE_KB_MAINTAINER,
    KB_MAINTAINER_RULES,
} from '../fleet-sprint/kb-maintainer.mjs';
import { validateArgs } from '../fleet-sprint/sprint-args.mjs';

// Unit tests for per-repository kb_maintainer selection. Every dependency is a
// fake: origins are a plain map, the availability probe fails for the members
// listed in `down`. Each test asserts the logged selection line as well as the
// returned selection.

const REPO_A = 'https://github.com/acme/alpha.git';
const REPO_B = 'git@github.com:acme/beta.git';
const A = 'github.com/acme/alpha';
const B = 'github.com/acme/beta';

function makeSelector({ members, origins, roleMap, down = [], unresolved = [] }) {
    const logs = [];
    const probed = [];
    const selector = createKbMaintainerSelector({
        members,
        roleMap,
        resolveMember: async (m) => (unresolved.includes(m) ? null : { id: `id-${m}`, name: m, type: 'local' }),
        probeOrigin: async (m) => {
            const o = origins[m];
            if (o instanceof Error) throw o;
            return o || '';
        },
        probeMember: async (record) => {
            probed.push(record.name);
            if (down.includes(record.name)) throw new Error(`member ${record.name} offline`);
            return {};
        },
        log: (l) => logs.push(l),
    });
    return { selector, logs, probed };
}

test('rule (b): first role-less member of each repository is selected, one logged line per repository', async () => {
    const { selector, logs } = makeSelector({
        members: ['m1', 'm2', 'm3', 'm4'],
        origins: { m1: REPO_A, m2: REPO_A, m3: REPO_B, m4: 'https://github.com/ACME/beta' },
        roleMap: { doer: ['m1'] },
    });
    await selector.selectAll();
    assert.equal(selector.getKbMaintainer(REPO_A).member, 'm2');
    assert.equal(selector.getKbMaintainer(REPO_A).rule, KB_MAINTAINER_RULES.ROLELESS);
    assert.equal(selector.getKbMaintainer('ssh://git@github.com/acme/beta').member, 'm3', 'lookup normalizes any remote form');
    assert.equal(selector.maintainerForMember('m4').member, 'm3', 'differently-cased clone URL is the same repository');
    const lines = logs.filter((l) => /maintainer '/.test(l));
    assert.deepEqual(lines, [
        `[kb-maintainer] repository ${A}: maintainer 'm2' (rule: role-less)`,
        `[kb-maintainer] repository ${B}: maintainer 'm3' (rule: role-less)`,
    ]);
});

test('rule (a): explicit roleMap.kb_maintainer wins over a role-less member of the same repository', async () => {
    const { selector, logs } = makeSelector({
        members: ['free', 'pinned'],
        origins: { free: REPO_A, pinned: REPO_A },
        roleMap: { kb_maintainer: ['pinned'] },
    });
    await selector.selectAll();
    assert.equal(selector.getKbMaintainer(A).member, 'pinned');
    assert.ok(logs.includes(`[kb-maintainer] repository ${A}: maintainer 'pinned' (rule: explicit)`), logs.join('\n'));
});

test('rule (a) is per repository: an explicit maintainer of A does not claim B', async () => {
    const { selector, logs } = makeSelector({
        members: ['pinned', 'bfree'],
        origins: { pinned: REPO_A, bfree: REPO_B },
        roleMap: { kb_maintainer: ['pinned'] },
    });
    await selector.selectAll();
    assert.equal(selector.getKbMaintainer(A).member, 'pinned');
    assert.equal(selector.getKbMaintainer(B).member, 'bfree');
    assert.ok(logs.includes(`[kb-maintainer] repository ${B}: maintainer 'bfree' (rule: role-less)`));
});

test('rule (c): with no role-less member, a role-mapped member with access to the repository is selected', async () => {
    const { selector, logs } = makeSelector({
        members: ['dev', 'rev'],
        origins: { dev: REPO_A, rev: REPO_A },
        roleMap: { doer: ['dev'], reviewer: ['rev'] },
    });
    await selector.selectAll();
    assert.equal(selector.getKbMaintainer(A).member, 'dev');
    assert.equal(selector.getKbMaintainer(A).rule, KB_MAINTAINER_RULES.ACCESS);
    assert.ok(logs.includes(`[kb-maintainer] repository ${A}: maintainer 'dev' (rule: access)`), logs.join('\n'));
});

test('an unavailable first choice is replaced by the next eligible member and the replacement is logged', async () => {
    const { selector, logs, probed } = makeSelector({
        members: ['pinned', 'free', 'dev'],
        origins: { pinned: REPO_A, free: REPO_A, dev: REPO_A },
        roleMap: { kb_maintainer: ['pinned'], doer: ['dev'] },
        down: ['pinned'],
    });
    await selector.selectAll();
    assert.deepEqual(probed, ['pinned', 'free']);
    const sel = selector.getKbMaintainer(A);
    assert.equal(sel.member, 'free');
    assert.equal(sel.rule, KB_MAINTAINER_RULES.ROLELESS);
    assert.deepEqual(sel.replaced.map((r) => r.member), ['pinned']);
    assert.ok(logs.some((l) => l === `[kb-maintainer] repository ${A}: maintainer candidate 'pinned' (rule: explicit) is unavailable (member pinned offline); replaced by 'free' (rule: role-less)`), logs.join('\n'));
    assert.ok(logs.includes(`[kb-maintainer] repository ${A}: maintainer 'free' (rule: role-less)`));
});

test('every eligible member unavailable: no maintainer, logged, getKbMaintainer returns null', async () => {
    const { selector, logs } = makeSelector({
        members: ['only'],
        origins: { only: REPO_A },
        down: ['only'],
    });
    await selector.selectAll();
    assert.equal(selector.getKbMaintainer(A), null);
    assert.ok(logs.some((l) => l.startsWith(`[kb-maintainer] repository ${A}: no available maintainer`)), logs.join('\n'));
});

test('a member whose work folder is not a repository is never selected and is flagged', async () => {
    const { selector, logs, probed } = makeSelector({
        members: ['scratch', 'broken', 'unreg', 'real'],
        origins: { scratch: '', broken: new Error('fatal: not a git repository'), real: REPO_A },
        roleMap: { kb_maintainer: ['scratch'] },
        unresolved: ['unreg'],
    });
    await selector.selectAll();
    assert.equal(selector.getKbMaintainer(A).member, 'real');
    assert.deepEqual(probed, ['real'], 'a non-repository member is never probed as a candidate');
    for (const m of ['scratch', 'broken', 'unreg']) assert.equal(selector.isNonRepoMember(m), true, m);
    assert.equal(selector.isNonRepoMember('real'), false);
    assert.equal(selector.maintainerForMember('scratch'), null);
    assert.ok(logs.some((l) => l.includes("member 'scratch': work folder is not a repository")));
    assert.ok(logs.some((l) => l.includes("roleMap.kb_maintainer names 'scratch', whose work folder is not a repository -- ignored")));
    assert.deepEqual([...selector.maintainers().keys()], [A]);
});

test('selection is computed once: a second selectAll() issues no further probes', async () => {
    const { selector, probed } = makeSelector({ members: ['m'], origins: { m: REPO_A } });
    await selector.selectAll();
    await selector.selectAll();
    assert.deepEqual(probed, ['m']);
});

test('without member access the selector is inert and says so', async () => {
    const logs = [];
    const selector = createKbMaintainerSelector({ members: ['m'], log: (l) => logs.push(l) });
    await selector.selectAll();
    assert.equal(selector.getKbMaintainer(A), null);
    assert.ok(logs.some((l) => l.includes('selection skipped')));
});

test('orderMaintainerCandidates: explicit, then role-less, then access, no duplicates', () => {
    const repoOf = new Map([['x', A], ['y', A], ['z', A], ['w', B]]);
    const order = orderMaintainerCandidates({
        repo: A, members: ['x', 'y', 'z', 'w'], repoOf,
        roleMap: { kb_maintainer: ['z', 'w'], doer: ['x', 'z'] },
    });
    assert.deepEqual(order, [
        { member: 'z', rule: 'explicit' },
        { member: 'y', rule: 'role-less' },
        { member: 'x', rule: 'access' },
    ]);
});

test('roleMappedMembers ignores the kb_maintainer key (not a dispatched role)', () => {
    assert.deepEqual([...roleMappedMembers({ kb_maintainer: ['a'], doer: ['b'] })], ['b']);
});

test('createMemberDetailResolver: asks for json and returns {id, name, type}, null without an id', async () => {
    const calls = [];
    const resolve = createMemberDetailResolver(async (name, args) => {
        calls.push([name, args]);
        const body = args.member_name === 'known' ? { id: 'u-1', type: 'remote' } : { vcsProvider: 'github' };
        return { content: [{ text: JSON.stringify(body) }] };
    });
    assert.deepEqual(await resolve('known'), { id: 'u-1', name: 'known', type: 'remote' });
    assert.equal(await resolve('other'), null);
    assert.deepEqual(calls[0], ['member_detail', { member_name: 'known', format: 'json' }]);
});

const BASE_ARGS = { target_issue: 'proj-1', members: ['a', 'b'], branch: 'feat/x', base_branch: 'main', goal: 'P1', max_cycles: 1 };

test('sprint-args: kb_maintainer is an accepted roleMap key (any casing) naming sprint members', () => {
    const v = validateArgs({ ...BASE_ARGS, roleMap: { ' KB_Maintainer ': ['b'] } });
    assert.deepEqual(v.roleMap[ROLE_KB_MAINTAINER], ['b']);
});

test('sprint-args: kb_maintainer naming a non-member or a non-array is rejected', () => {
    assert.throws(() => validateArgs({ ...BASE_ARGS, roleMap: { kb_maintainer: ['zz'] } }), /kb_maintainer.*"zz" not in members/);
    assert.throws(() => validateArgs({ ...BASE_ARGS, roleMap: { kb_maintainer: 'a' } }), /kb_maintainer: must be an array/);
});
