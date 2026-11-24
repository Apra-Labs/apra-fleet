import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDispatchError } from '@apralabs/apra-fleet-workflow';

import { createModelReporter } from '../fleet-sprint/model-log.mjs';
import { dispatchConflictResolutionAgent } from '../fleet-sprint/conflict-ladder.mjs';
import { createUsageLimitPauseController } from '../fleet-sprint/usage-limit-controller.mjs';

// Dispatches made outside dispatchRole (the conflict-resolution runbook and
// the usage-limit re-probe) log the model that served them, same as roles.

test('createModelReporter labels reported, resolved, error-detail and unknown models', () => {
    const r = createModelReporter();
    assert.equal(r.describe(), 'actual model unknown');
    r.onModelId('claude-x', { source: 'reported' });
    assert.match(r.describe(), /claude-x \(provider-reported\)/);
    const r2 = createModelReporter();
    r2.onModelId('opus', { source: 'resolved' });
    assert.match(r2.describe(), /opus \(resolved alias/);
    const r3 = createModelReporter();
    r3.onModelId('gpt-5.4', { source: 'resolved' });
    assert.match(r3.describe(), /gpt-5\.4 \(resolved id, provider reported none\)/);
    const err = new AgentDispatchError('boom', { details: { model: 'claude-y', modelSource: 'reported' } });
    assert.match(createModelReporter().describe(err), /claude-y \(provider-reported\)/);
});

test('the conflict-resolution dispatch logs its model on success and on failure', async () => {
    const logs = [];
    await dispatchConflictResolutionAgent({
        agent: async (_p, o) => { o.onModelId('claude-c', { source: 'reported' }); return {}; },
        member: 'm', branch: 'b', unmergedPaths: ['a.txt'], log: (l) => logs.push(l), model: 'standard',
    });
    assert.ok(logs.some((l) => l.includes('requested tier standard') && l.includes('claude-c') && l.includes('provider-reported')), JSON.stringify(logs));

    const failLogs = [];
    await assert.rejects(dispatchConflictResolutionAgent({
        agent: async () => { throw new AgentDispatchError('x', { details: { reason: 'dispatch_failed', model: 'opus', modelSource: 'resolved' } }); },
        member: 'm', branch: 'b', unmergedPaths: ['a.txt'], log: (l) => failLogs.push(l),
    }));
    assert.ok(failLogs.some((l) => l.includes('actual model opus') && l.includes('resolved alias')), JSON.stringify(failLogs));
});

test('the usage-limit re-probe logs its model, labelled by source', async () => {
    const T0 = Date.UTC(2026, 0, 1);
    const logs = [];
    const controller = createUsageLimitPauseController({
        requestPause: () => {},
        requestResume: async () => {},
        agent: async (_p, o) => { o.onModelId('claude-p', { source: 'reported' }); return 'ok'; },
        sleep: async () => {},
        now: () => T0,
        log: (m) => logs.push(m),
    });
    const out = await controller({
        member: 'bob', roleLabel: 'Doer', tier: 'cheap',
        signal: { resumeAt: new Date(T0 + 3600000).toISOString(), resumeAtSource: 'parsed' },
    });
    assert.deepEqual(out, { resumed: true });
    assert.ok(
        logs.some((l) => l.includes('usage-limit re-probe') && l.includes('requested tier cheap') && l.includes('claude-p') && l.includes('provider-reported')),
        JSON.stringify(logs),
    );
});
