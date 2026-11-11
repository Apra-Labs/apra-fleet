import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { KB_AUTH_RESUME_NOTE } from '../fleet-sprint/kb-auth-keeper.mjs';

// The KB auth keeper through the REAL runner.js agent() wrapper: with an
// orchestrator KB that takes its token from a live secret, a remote doer gets
// provision_kb_auth before its dispatch, and a doer whose toolErrors show a
// rejected KB token is healed (reason rejected) and resumed once in the same
// session. kb-auth-keeper.test.mjs covers the keeper's rules in isolation;
// this guards the line that wires it into every dispatch.

test('mock sprint: a remote doer gets its KB token before dispatch, and a rejected token is healed with one resume', { timeout: scaledTimeout(180000) }, async () => {
    await withScenarioMarkers('kb auth keeper wiring', async () => {
        const provisions = [];
        const doerCalls = [];
        const callToolFactory = (executeCommand) => {
            const base = defaultMockCallTool({ executeCommand });
            return async (name, args) => {
                if (name === 'fleet_status') {
                    return { content: [{ type: 'text', text: JSON.stringify({ members: [], kbHealth: { credential: { kind: 'live', url: 'https://kb.example.test', secretName: 'kb-live' } } }) }] };
                }
                if (name === 'member_detail') {
                    return { content: [{ text: JSON.stringify({ vcsProvider: 'github', id: '0b9d3a1e-5f2c-4c6e-9a7b-1c2d3e4f5a6b', type: 'remote', os: 'linux', folder: '/srv/mock/widget' }) }] };
                }
                if (name === 'provision_kb_auth') {
                    provisions.push(args);
                    const exp = Date.now() + 3600_000;
                    return { content: [{ type: 'text', text: '[OK]' }], structuredContent: { ok: true, expiresAt: new Date(exp).toISOString(), refreshAt: new Date(exp - 360_000).toISOString() } };
                }
                return base(name, args);
            };
        };
        const doerHandler = async ({ opts, tempDir, runCmd }) => {
            doerCalls.push({ prompt: opts.prompt, resume: opts.resume });
            const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
            const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
            for (const id of ids) await runCmd(`bd close ${id}`, tempDir);
            const first = doerCalls.length === 1;
            return {
                content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: first ? ids : [], notes: first ? 'done' : 'redid the KB lookups' }) }],
                ...(first ? { structuredContent: { toolErrors: { available: true, sinceSeconds: 30, total: 1, entries: [{ tool: 'kb_query', code: 'E-KB-HTTP-AUTH', reason: 'rejected', origin: 'session' }] } } } : {}),
            };
        };

        await runDevelopLoopScenario('kbauthkeeper', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: exercise the KB auth keeper through a real dispatch' }],
            maxCycles: 1,
            callToolFactory,
            doerHandler,
        });

        assert.ok(provisions.length >= 2, `expected a pre-dispatch push and a heal, got ${JSON.stringify(provisions)}`);
        assert.deepEqual(provisions[0], { member_name: 'local', secret: 'kb-live', remote: 'https://kb.example.test' });
        const heals = provisions.filter((p) => p.reason === 'rejected');
        assert.equal(heals.length, 1, 'one heal with reason rejected');
        assert.ok(doerCalls.length >= 2, 'the doer was resumed');
        assert.equal(doerCalls[1].prompt.startsWith(KB_AUTH_RESUME_NOTE), true, 'the resume carries the note');
        assert.equal(typeof doerCalls[1].resume, 'string', 'the resume targets the explicit session id');
        assert.equal(doerCalls.filter((c) => c.prompt.startsWith(KB_AUTH_RESUME_NOTE)).length, 1, 'resumed only once');
    });
});
