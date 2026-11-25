// Launch pull: a non-backlog beads-reading member that ALREADY has a beads
// database on the expected sync.remote is pulled once at launch through the
// health-gate path, so a flattened remote is recovered (or refused, naming the
// member) in verifyBeadsIdentity -- before any dispatch -- instead of at its
// first pre-dispatch pull.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { verifyBeadsIdentity } from '../fleet-sprint/beads-identity-check.mjs';
import { BEADS_IDENTITY_PROBES } from '../fleet-sprint/beads-identity.mjs';
import { BeadsFlattenRecoveryRefusedError } from '../fleet-sprint/errors.mjs';
import { FLATTEN_RECOVERY_WARNING_PREFIX } from '../fleet-sprint/beads-flatten-recovery.mjs';
import { getSeCommands } from '../fleet-sprint/se-os-commands.mjs';
import { REMOTE, makeMember } from './helpers/flatten-member.mjs';

const posix = getSeCommands({ os: 'linux', shell: 'bash' });
const T = '2026-11-20T10:00:00Z';
const issue = (id, updatedAt = T) => ({ _type: 'issue', id, title: id, status: 'open', updated_at: updatedAt });
const SAME = () => [issue('p-1'), issue('p-2')];
const EXPECTED = { prefix: 'proj', syncRemote: REMOTE, repoRemote: REMOTE };

// Identity probes answered statically (the database "exists" on both
// members); every other command goes to the simulated member folder.
function harness(member) {
    const calls = [];
    const command = async (cmd, opts = {}) => {
        calls.push({ cmd, member: opts.member_name });
        if (cmd === BEADS_IDENTITY_PROBES.where) return { ok: true, output: JSON.stringify({ database_path: '/w/.beads/dolt', path: '/w/.beads', prefix: 'proj' }), error: null };
        if (cmd === BEADS_IDENTITY_PROBES.syncRemote) return { ok: true, output: JSON.stringify({ key: 'sync.remote', value: REMOTE }), error: null };
        if (cmd === BEADS_IDENTITY_PROBES.repoRemote) return { ok: true, output: `${REMOTE}\n`, error: null };
        if (opts.member_name === 'orch') return { ok: true, output: '', error: null };
        return member.command(cmd, opts);
    };
    return { command, calls };
}

const run = (h, logs, extra = {}) => verifyBeadsIdentity({
    command: h.command, log: (l) => logs.push(l), backlogMember: 'orch', members: ['m2'], expected: EXPECTED,
    memberShell: async () => posix, ...extra,
});

describe('launch pull of members that already have a beads database', () => {
    test('a healthy member gets one pull and nothing else destructive', async () => {
        const member = makeMember({ local: SAME(), remote: SAME() });
        member.fsx.get('.beads').db.unrelated = false;
        const h = harness(member);
        await run(h, []);
        const pulls = h.calls.filter((c) => c.member === 'm2' && /^bd dolt pull/.test(c.cmd));
        assert.equal(pulls.length, 1);
        assert.ok(!member.texts().includes('bd bootstrap --yes'));
        assert.ok(!h.calls.some((c) => c.member === 'orch' && /^bd dolt pull/.test(c.cmd)), 'the backlog member is left to its own health gate');
    });

    test('a flattened remote is recovered at launch: the member is re-bootstrapped and bd reads the rebuilt beads', async () => {
        const rebuilt = [issue('p-1'), issue('p-2'), issue('p-7')];
        const member = makeMember({ local: SAME(), remote: rebuilt });
        const h = harness(member);
        const logs = [];
        const res = await run(h, logs);
        const beads = member.fsx.get('.beads');
        assert.equal(beads.db.original, false, 're-bootstrapped from the remote');
        assert.deepEqual(beads.db.records.map((r) => r.id), ['p-1', 'p-2', 'p-7']);
        assert.ok(logs.some((l) => l.startsWith(FLATTEN_RECOVERY_WARNING_PREFIX) && l.includes("'m2'")), logs.join('\n'));
        assert.ok(res.setUp.includes('m2'));
        assert.ok(member.texts().includes('bd bootstrap --yes'));
    });

    test('unpushed local work refuses the launch naming the member; nothing is replaced', async () => {
        const member = makeMember({ local: [...SAME(), issue('p-9', '2026-11-23T00:00:00Z')], remote: SAME() });
        const original = member.fsx.get('.beads');
        const h = harness(member);
        await assert.rejects(
            () => run(h, []),
            (err) => err instanceof BeadsFlattenRecoveryRefusedError && err.message.includes("'m2'") && err.message.includes('p-9') && /Fix:/.test(err.message),
        );
        assert.strictEqual(member.fsx.get('.beads'), original, '.beads left intact');
        assert.deepEqual([...member.fsx.keys()], ['.beads']);
    });

    test('a launchPull seam is called for the non-backlog member only, after the mismatch check', async () => {
        const member = makeMember({ local: SAME(), remote: SAME() });
        const h = harness(member);
        const pulled = [];
        await run(h, [], { launchPull: async (m, opts) => { pulled.push([m, typeof opts.flattenRecovery]); return { ok: true, member: m }; } });
        assert.deepEqual(pulled, [['m2', 'function']]);
    });

    test('without memberShell (no recovery primitives) no launch pull is issued', async () => {
        const member = makeMember({ local: SAME(), remote: SAME() });
        const h = harness(member);
        await run(h, [], { memberShell: undefined, launchPull: async () => assert.fail('must not pull') });
    });
});
