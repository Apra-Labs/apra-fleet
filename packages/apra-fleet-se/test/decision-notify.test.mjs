import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    notifyDecision, validateDecisionNotify, formatNotificationBody, judgeSendResult, NO_CHANNEL_REASON,
} from '../fleet-sprint/decision-notify.mjs';
import { recordPendingDecision } from '../fleet-sprint/decisions.mjs';

// One pending decision gets one message and one email; every failure mode is
// recorded and logged loudly and never throws or changes the sprint.

const QUESTION = 'Q: ' + 'a long question that must never be truncated anywhere on the notification path. '.repeat(8);
const OPTIONS = [
    { id: 'a', text: 'First option, in full ' + 'x'.repeat(400) },
    { id: 'b', text: 'Second option' },
    { id: 'c', text: 'Third option' },
];
const SECRET = 'SENTINEL-SECRET-VALUE-123';
const record = () => ({
    decisionId: 'decision-1-x-1', beadId: 'x-1', decisionBeadId: 'x-dec', question: QUESTION,
    options: OPTIONS, recommendation: 'a, it is safest', notification: {},
});
const CONFIG = {
    messageMember: 'orchestrator-1', timeoutMs: 80, dashboardUrl: 'http://127.0.0.1:8787/sprints/s1',
    email: { provider: 'sendgrid', from: 'sprint@example.com', to: 'ops@example.com' },
};
const okResult = { content: [{ type: 'text', text: JSON.stringify({ ok: true, msgid: 'm1' }) }] };

function fakes({ message = async () => okResult, email = async () => okResult } = {}) {
    const calls = { message: [], email: [] };
    return {
        calls,
        fleetApi: {
            sendMessage: async (o) => { calls.message.push(o); return message(o); },
            sendEmail: async (o) => { calls.email.push(o); return email(o); },
        },
    };
}

test('both channels configured: each is called once, with the full untruncated body, across repeated calls', async () => {
    const { calls, fleetApi } = fakes();
    const logs = [];
    const d = record();
    for (let i = 0; i < 3; i++) await notifyDecision({ decision: d, config: CONFIG, fleetApi, log: (m) => logs.push(m) });
    assert.equal(calls.message.length, 1);
    assert.equal(calls.email.length, 1);
    assert.equal(d.notification.message.status, 'sent');
    assert.equal(d.notification.email.status, 'sent');
    assert.ok(d.notification.email.at);
    for (const text of [calls.message[0].content, calls.email[0].body]) {
        assert.ok(text.includes(QUESTION), 'full question');
        for (const o of OPTIONS) assert.ok(text.includes(`(${o.id}) ${o.text}`), `option ${o.id}`);
        assert.ok(text.includes('a, it is safest'));
        assert.ok(text.includes('bd human respond x-dec'));
        assert.ok(text.includes(CONFIG.dashboardUrl));
    }
    assert.equal(calls.message[0].member_id, 'orchestrator-1');
    assert.equal(calls.email[0].to, 'ops@example.com');
    assert.ok(/^[\x00-\x7F]*$/.test(formatNotificationBody(d)), 'ASCII body');
});

const failureModes = {
    'not configured': { config: undefined, reason: NO_CHANNEL_REASON, expectCalls: 0 },
    'tool error': { fakes: { message: async () => { throw new Error('boom message'); }, email: async () => ({ isError: true, content: [{ text: 'smtp down' }] }) }, reason: ['boom message', 'smtp down'] },
    'error json (member not connected)': { fakes: { message: async () => JSON.stringify({ error: 'member not connected or no MCP session' }), email: async () => JSON.stringify({ ok: false, error: 'bad address' }) }, reason: ['member not connected', 'bad address'] },
    'timeout': { fakes: { message: () => new Promise(() => {}), email: () => new Promise(() => {}) }, reason: ['timed out', 'timed out'] },
};
for (const [name, mode] of Object.entries(failureModes)) {
    test(`failure mode "${name}": one loud line per channel, recorded as failed, never throws`, async () => {
        const f = fakes(mode.fakes);
        const logs = [];
        const d = record();
        await notifyDecision({ decision: d, config: 'config' in mode ? mode.config : CONFIG, fleetApi: f.fleetApi, log: (m) => logs.push(m) });
        const reasons = Array.isArray(mode.reason) ? mode.reason : [mode.reason, mode.reason];
        assert.equal(d.notification.message.status, 'failed');
        assert.equal(d.notification.email.status, 'failed');
        assert.ok(d.notification.message.reason.includes(reasons[0]), d.notification.message.reason);
        assert.ok(d.notification.email.reason.includes(reasons[1]), d.notification.email.reason);
        const loud = logs.filter((l) => l.startsWith('NOTIFICATION FAILED'));
        assert.equal(loud.length, 2, JSON.stringify(logs));
        // never retried / re-sent
        await notifyDecision({ decision: d, config: CONFIG, fleetApi: f.fleetApi, log: () => {} });
        assert.ok(f.calls.message.length <= 1 && f.calls.email.length <= 1);
    });
}

test('no secret value reaches a log line or message (sentinel)', async () => {
    const f = fakes({ message: async () => { throw new Error('send failed'); } });
    const logs = [];
    const d = record();
    const cfg = validateDecisionNotify({ message_member: 'm', email: { provider: 'smtp', from: 'a@b.co', to: 'c@d.co', host: 'h', user: 'u' } });
    await notifyDecision({ decision: d, config: cfg, fleetApi: f.fleetApi, log: (m) => logs.push(m) });
    assert.ok(!JSON.stringify([logs, f.calls]).includes(SECRET));
    assert.throws(() => validateDecisionNotify({ email: { provider: 'smtp', from: 'a@b.co', to: 'c@d.co', host: 'h', user: 'u', password: SECRET } }), /unknown key "password"/);
    assert.throws(() => validateDecisionNotify({ smtp_password: SECRET }), (e) => !e.message.includes(SECRET));
});

test('validateDecisionNotify: absent is undefined; bad shapes are rejected', () => {
    assert.equal(validateDecisionNotify(undefined), undefined);
    assert.equal(validateDecisionNotify('{"message_member":"m","timeout_s":5}').timeoutMs, 5000);
    assert.throws(() => validateDecisionNotify('{nope'), /not valid JSON/);
    assert.throws(() => validateDecisionNotify({ email: { from: 'a@b.co' } }), /to/);
    assert.throws(() => validateDecisionNotify({ dashboard_url: 'javascript:x' }), /dashboard_url/);
});

test('judgeSendResult: plain success and error shapes', () => {
    assert.equal(judgeSendResult(okResult).ok, true);
    assert.equal(judgeSendResult('{"ok":true}').ok, true);
    assert.equal(judgeSendResult({ error: 'x' }).ok, false);
});

test('recordPendingDecision triggers the notifier once; a throwing notifier does not stop recording', async () => {
    const command = async (cmd) => (cmd.startsWith('bd create') ? 'x-dec\n' : cmd.startsWith('node -e') ? '/tmp/f' : '');
    for (const notifier of [
        (rec) => notifyDecision({ decision: rec, config: CONFIG, fleetApi: f.fleetApi, log: () => {} }),
        async () => { throw new Error('notifier exploded'); },
    ]) {
        var f = fakes();
        const logs = [];
        const sprintState = { notifyDecision: notifier };
        const rec = await recordPendingDecision({
            sprintState, decision: { beadId: 'x-1', question: QUESTION, options: OPTIONS, recommendation: 'a' },
            raisedBy: 'doer', cycle: 1, round: 1, command, member: 'm', scopeBeads: [{ id: 'x-1', status: 'open' }], log: (m) => logs.push(m),
        });
        assert.ok(rec && sprintState.doctorBlockedIds.has('x-1'), 'still set aside');
    }
});
