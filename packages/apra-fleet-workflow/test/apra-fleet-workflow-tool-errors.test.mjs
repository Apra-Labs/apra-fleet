import { test, describe } from 'node:test';
import assert from 'node:assert';
import { FleetWorkflow, AgentDispatchError } from '../src/workflow/index.mjs';

// agent()'s onToolErrors: execute_prompt's structuredContent.toolErrors reaches
// the caller on a successful dispatch and on a failed one, which is how
// fleet-sprint learns that the agent hit an E-KB-HTTP-AUTH it never reported.

const MEMBER = 'fleet-mock';
const REPORT = { available: true, sinceSeconds: 9, total: 1, entries: [{ tool: 'kb_query', code: 'E-KB-HTTP-AUTH', reason: 'expired' }] };

describe('agent() onToolErrors', () => {
    test('a successful dispatch hands its toolErrors to the callback', async () => {
        const wf = new FleetWorkflow({
            async executePrompt() {
                return { content: [{ text: 'answer' }], structuredContent: { response: 'answer', toolErrors: REPORT } };
            },
        });
        const seen = [];
        const out = await wf.agent('p', { member_name: MEMBER, onToolErrors: (r, meta) => seen.push([r, meta.member]) });
        assert.strictEqual(out, 'answer');
        assert.deepStrictEqual(seen, [[REPORT, MEMBER]]);
    });

    test('a failed dispatch hands its toolErrors over before throwing', async () => {
        const wf = new FleetWorkflow({
            async executePrompt() {
                return { content: [{ text: 'boom' }], structuredContent: { isError: true, reason: 'server', toolErrors: REPORT } };
            },
        });
        const seen = [];
        await assert.rejects(
            () => wf.agent('p', { member_name: MEMBER, onToolErrors: (r) => seen.push(r) }),
            (err) => err instanceof AgentDispatchError,
        );
        assert.deepStrictEqual(seen, [REPORT]);
    });

    test('a throwing callback does not break the dispatch', async () => {
        const wf = new FleetWorkflow({
            async executePrompt() {
                return { content: [{ text: 'answer' }], structuredContent: { response: 'answer', toolErrors: REPORT } };
            },
        });
        const out = await wf.agent('p', { member_name: MEMBER, onToolErrors: () => { throw new Error('cb'); } });
        assert.strictEqual(out, 'answer');
    });
});
