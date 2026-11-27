import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
    FleetWorkflow, AgentDispatchError, AgentOutputError,
    AGENT_ERROR_LOG_MAX_CHARS, AGENT_ERROR_LOG_TRUNCATION_MARKER, isErrorLogged,
} from '../src/workflow/index.mjs';

// An agent() failure's text is written to the console once, cut to
// AGENT_ERROR_LOG_MAX_CHARS, whatever the failure kind; the thrown error keeps
// the full text. Before this, a dispatch failure printed its full payload
// twice (at the dispatch site and again in agent()'s catch).

const MEMBER = 'm1';
const SENTINEL = 'LOGONCESENTINEL';
const PAYLOAD = (SENTINEL + ' ').repeat(60); // ~960 chars

function wfWith(executePromptImpl) {
    return new FleetWorkflow({
        async executePrompt(payload) { return executePromptImpl(payload); },
        async executeCommand() { return { content: [{ text: '' }] }; },
    });
}

async function captureErrors(fn) {
    const lines = [];
    const orig = console.error;
    console.error = (...a) => { lines.push(a.map(String).join(' ')); };
    try { await fn(); } finally { console.error = orig; }
    return lines;
}

function assertOnceTruncated(lines) {
    const hits = lines.filter((l) => l.includes(SENTINEL));
    assert.strictEqual(hits.length, 1, `payload appears in ${hits.length} console lines:\n${hits.join('\n')}`);
    assert.ok(hits[0].includes(AGENT_ERROR_LOG_TRUNCATION_MARKER), hits[0]);
    const body = hits[0].slice(hits[0].indexOf(SENTINEL));
    assert.ok(body.length <= AGENT_ERROR_LOG_MAX_CHARS + AGENT_ERROR_LOG_TRUNCATION_MARKER.length, `${body.length} chars logged`);
}

describe('agent() logs a failure payload at most once, truncated', () => {
    for (const reason of ['nonzero_exit', 'usage_limit', 'dispatch_failed']) {
        test(`structured dispatch failure (${reason}): one truncated line; the error keeps the full text`, async () => {
            const wf = wfWith(async () => ({ content: [{ text: PAYLOAD }], structuredContent: { isError: true, reason } }));
            let caught;
            const lines = await captureErrors(async () => {
                await wf.agent('hi', { member_name: MEMBER }).catch((e) => { caught = e; });
            });
            assert.ok(caught instanceof AgentDispatchError);
            assert.strictEqual(caught.details.reason, reason);
            assert.ok(caught.message.includes(PAYLOAD.trim()), 'the thrown error keeps the full text');
            assert.ok(isErrorLogged(caught), 'the error is marked as already logged');
            assertOnceTruncated(lines);
            assert.ok(lines.some((l) => l.startsWith('[Agent API Error]')));
        });
    }

    test('transport failure: one truncated line', async () => {
        const wf = wfWith(async () => ({ content: [{ type: 'text', text: PAYLOAD }], isError: true }));
        const lines = await captureErrors(async () => {
            await wf.agent('hi', { member_name: MEMBER }).catch(() => {});
        });
        assertOnceTruncated(lines);
    });

    test('a thrown transport exception (not classified at a site) is still logged once, truncated', async () => {
        const wf = wfWith(async () => { throw new Error(PAYLOAD); });
        const lines = await captureErrors(async () => {
            await wf.agent('hi', { member_name: MEMBER }).catch(() => {});
        });
        assertOnceTruncated(lines);
    });

    test('schema repairs exhausted: the final error is still logged (no regression for other errors)', async () => {
        const wf = wfWith(async () => ({ content: [{ text: 'not json at all' }] }));
        let caught;
        const lines = await captureErrors(async () => {
            await wf.agent('give json', { member_name: MEMBER, schema: { type: 'object', required: ['v'], properties: { v: { type: 'string' } } } })
                .catch((e) => { caught = e; });
        });
        assert.ok(caught instanceof AgentOutputError);
        assert.ok(lines.some((l) => l.startsWith('[Agent API Error]') && l.includes('[Workflow Error]')), lines.join('\n'));
    });
});
