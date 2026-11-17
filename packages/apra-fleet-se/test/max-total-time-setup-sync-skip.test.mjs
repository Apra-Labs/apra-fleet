import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDispatchError } from '@apralabs/apra-fleet-workflow';
import { createSyncBrackets, createGitSync } from '../fleet-sprint/git-sync.mjs';
import { isInfraDispatchFailure } from '../fleet-sprint/errors.mjs';
import { syncMemberBefore, syncMemberAfter, syncMemberAfterOrdered, isNoMutationDispatchFailure } from '../fleet-sprint/runner.js';

// A max_total_time the server marks dispatched:false ran out of budget during
// setup (cloud start, before the first attempt): nothing reached the member,
// so the post-dispatch G-push/D-push must be skipped -- no push, and no
// PostDispatchSyncError masking the real failure. A max_total_time WITHOUT
// that mark stopped a running agent, so its partial work is still published.
// Both stay infrastructure failures.

function runBracket(dispatchErr) {
    const commands = [];
    const logs = [];
    const command = async (member, cmd) => { commands.push(cmd); return { ok: true, output: '', error: null }; };
    const gitSync = createGitSync({
        brackets: createSyncBrackets(), command, log: (m) => logs.push(m), branch: 'feat/x', agent: undefined,
        doltPushMutex: undefined, sprintId: 'sprint-x', onAuthFailure: undefined, resolveMemberProvider: undefined,
        ensureVcsAuthFresh: async () => {},
        syncMemberBefore, syncMemberAfter, syncMemberAfterOrdered, isNoMutationDispatchFailure,
    });
    return gitSync.withGitSync('member-a', true, async () => { throw dispatchErr; }, { pushBeads: true, skipPreDispatchSync: true })
        .then(() => ({ thrown: null, commands, logs }), (thrown) => ({ thrown, commands, logs }));
}

describe('max_total_time before dispatch: post-dispatch sync is skipped', () => {
    test('dispatched:false -> the dispatch error surfaces, nothing is pushed', async () => {
        const err = new AgentDispatchError('exceeded max_total_s during setup', { details: { reason: 'max_total_time', dispatched: false } });
        const { thrown, commands, logs } = await runBracket(err);
        assert.equal(thrown, err, 'the dispatch error itself must surface, not a PostDispatchSyncError');
        assert.deepEqual(commands, [], `no git/dolt command may run, got: ${JSON.stringify(commands)}`);
        assert.ok(logs.some((m) => m.includes('Skipping post-dispatch G-push/D-push')), `expected the skip log, got: ${JSON.stringify(logs)}`);
    });

    test('a max_total_time that stopped a running agent still runs the post-dispatch sync', async () => {
        const err = new AgentDispatchError('exceeded max_total_s', { details: { reason: 'max_total_time' } });
        const { thrown, commands, logs } = await runBracket(err);
        assert.equal(thrown, err);
        assert.ok(commands.length > 0, 'the G-push/D-push teardown must run');
        assert.ok(!logs.some((m) => m.includes('Skipping post-dispatch G-push/D-push')));
    });

    test('max_total_time stays an infrastructure dispatch failure, marked or not', () => {
        assert.ok(isInfraDispatchFailure(new AgentDispatchError('x', { details: { reason: 'max_total_time', dispatched: false } })));
        assert.ok(isInfraDispatchFailure(new AgentDispatchError('x', { details: { reason: 'max_total_time' } })));
    });
});
