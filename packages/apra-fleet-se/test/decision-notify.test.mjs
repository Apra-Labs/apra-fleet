import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    notifyDecision, validateDecisionNotify, formatNotificationBody, judgeSendResult, NO_CHANNEL_REASON,
    resolveNotifyTargets, DEFAULT_MESSAGE_TARGET, NO_MESSAGE_TARGET_LOG_PREFIX,
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

// --- The REAL send_message lookup -------------------------------------------
// The message channel's success path runs against the real fleet server code
// (the root build in dist/): the real HTTP transport registers sessions in the
// real session registry exactly as it does for an operator's Claude Code
// session (a FULL-scope session that declares claude/channel is registered
// under the stable 'orchestrator' id), and the real send_message handler looks
// the target up there. The sprint side reaches it over the real MCP wire from
// its own FULL-scope client. Only the channel notification is captured, on the
// orchestrator session's client. No accept-any-id fake is involved.
let realServerPromise = null;
function realServer() {
    realServerPromise ??= (async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-decision-notify-real-'));
        // dist modules capture the data dir at load: set it before importing.
        process.env.APRA_FLEET_DATA_DIR = dataDir;
        const { createHttpTransport } = await import('../../../dist/services/http-transport.js');
        const { sendMessage, sendMessageSchema } = await import('../../../dist/tools/send-message.js');
        const { getOrCreateMemberAccessSecret, MEMBER_SECRET_HEADER } = await import('../../../dist/services/member-access-secret.js');
        const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
        const secretPath = path.join(dataDir, 'member-access.key');
        const handle = await createHttpTransport({
            preferredPort: 0,
            memberSecretPath: secretPath,
            registerTools: (server) => {
                server.tool('send_message', 'send_message', sendMessageSchema.shape,
                    async (input) => ({ content: [{ type: 'text', text: await sendMessage(input) }] }));
            },
        });
        const headers = { [MEMBER_SECRET_HEADER]: getOrCreateMemberAccessSecret(secretPath) };
        const url = new URL(`http://127.0.0.1:${handle.port}/mcp`);
        const transportOf = () => new StreamableHTTPClientTransport(url, { requestInit: { headers }, reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 100, initialReconnectionDelay: 100, reconnectionDelayGrowFactor: 1 } });

        let sseGets = 0;
        handle.httpServer.on('request', (req) => { if (req.method === 'GET' && req.url === '/mcp') sseGets++; });
        // The operator's orchestrating session: no member identity, declares claude/channel.
        const orchestrator = new Client({ name: 'orchestrating-session', version: '1.0.0' }, { capabilities: { experimental: { 'claude/channel': {} } } });
        const received = [];
        orchestrator.fallbackNotificationHandler = async (n) => { if (n.method === 'notifications/claude/channel') received.push(n.params); };
        await orchestrator.connect(transportOf());
        const deadline = Date.now() + 5000;
        while (sseGets < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
        assert.ok(sseGets >= 1, 'orchestrator SSE stream established');
        // The sprint's own fleet client: FULL scope, not channel-capable.
        const sprintClient = new Client({ name: 'sprint-engine', version: '1.0.0' }, { capabilities: {} });
        await sprintClient.connect(transportOf());
        const fleetApi = {
            sendMessage: (o) => sprintClient.callTool({ name: 'send_message', arguments: o }),
        };
        const waitForReceived = async (n) => {
            const until = Date.now() + 5000;
            while (received.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
        };
        const close = async () => {
            for (const c of [sprintClient, orchestrator]) { try { await c.close(); } catch { /* ignore */ } }
            await handle.close();
            fs.rmSync(dataDir, { recursive: true, force: true });
        };
        return { fleetApi, received, waitForReceived, close };
    })();
    return realServerPromise;
}
after(async () => { if (realServerPromise) await (await realServerPromise).close(); });

// The message fake never accepts an id: message delivery success is only ever
// proven through the real send_message lookup above.
const NOT_CONNECTED = JSON.stringify({ error: 'member not connected or no MCP session' });
function fakes({ message = async () => NOT_CONNECTED, email = async () => okResult } = {}) {
    const calls = { message: [], email: [] };
    return {
        calls,
        fleetApi: {
            sendMessage: async (o) => { calls.message.push(o); return message(o); },
            sendEmail: async (o) => { calls.email.push(o); return email(o); },
        },
    };
}

test('launch-resolved default target: the message reaches the registered orchestrator session through the real send_message lookup, once, with the full body; email once', async () => {
    const real = await realServer();
    const { calls, fleetApi: emailFake } = fakes();
    const fleetApi = { sendMessage: real.fleetApi.sendMessage, sendEmail: emailFake.sendEmail };
    // No message_member configured: the target is resolved once at launch.
    const { config } = resolveNotifyTargets({ config: validateDecisionNotify({ dashboard_url: CONFIG.dashboardUrl, email: { provider: 'sendgrid', from: 'sprint@example.com', to: 'ops@example.com' } }), hasFleetClient: true });
    assert.equal(config.messageMember, DEFAULT_MESSAGE_TARGET);
    const logs = [];
    const d = record();
    const before = real.received.length;
    for (let i = 0; i < 3; i++) await notifyDecision({ decision: d, config, fleetApi, log: (m) => logs.push(m) });
    await real.waitForReceived(before + 1);
    assert.equal(d.notification.message.status, 'sent', JSON.stringify([d.notification, logs]));
    assert.equal(d.notification.email.status, 'sent');
    assert.ok(d.notification.email.at);
    assert.equal(real.received.length - before, 1, 'exactly one channel notification reached the orchestrator session');
    const delivered = real.received[real.received.length - 1].content;
    assert.equal(calls.email.length, 1);
    for (const text of [delivered, calls.email[0].body]) {
        assert.ok(text.includes(QUESTION), 'full question');
        for (const o of OPTIONS) assert.ok(text.includes(`(${o.id}) ${o.text}`), `option ${o.id}`);
        assert.ok(text.includes('a, it is safest'));
        assert.ok(text.includes('bd human respond x-dec'));
        assert.ok(text.includes(CONFIG.dashboardUrl));
    }
    assert.equal(calls.email[0].to, 'ops@example.com');
    assert.ok(/^[\x00-\x7F]*$/.test(formatNotificationBody(d)), 'ASCII body');
});

test('the how-to-answer text says a bd human respond answer is picked up within the read poll interval, never to press Resume', () => {
    const d = record();
    const dflt = formatNotificationBody(d);
    assert.ok(
        dflt.includes('bd human respond x-dec "<chosen option id and any instructions>" (the paused sprint picks the answer up within 5 minutes and resumes on its own)'),
        dflt,
    );
    assert.doesNotMatch(dflt, /press Resume/i);
    assert.doesNotMatch(dflt, /Resume/);
    const custom = formatNotificationBody(d, { readPollIntervalMs: 90_000 });
    assert.ok(custom.includes('picks the answer up within 90 seconds'), custom);
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

test('a target that is not registered records failed with the real "not connected" reason from send_message', async () => {
    const real = await realServer();
    const logs = [];
    const d = record();
    const before = real.received.length;
    await notifyDecision({ decision: d, config: { messageMember: 'no-such-session', timeoutMs: 5000 }, fleetApi: real.fleetApi, log: (m) => logs.push(m) });
    assert.equal(d.notification.message.status, 'failed');
    assert.ok(d.notification.message.reason.includes('member not connected or no MCP session'), d.notification.message.reason);
    assert.equal(real.received.length, before, 'nothing delivered to the orchestrator session');
    assert.equal(logs.filter((l) => l.startsWith('NOTIFICATION FAILED (message)')).length, 1);
});

test('no resolvable target: the launch log has exactly one no-target line; recording two decisions adds none', async () => {
    const launchLog = [];
    const { config, launchLines } = resolveNotifyTargets({ config: undefined, hasFleetClient: false });
    for (const l of launchLines) launchLog.push(l);
    const noTarget = () => launchLog.filter((l) => l.startsWith(NO_MESSAGE_TARGET_LOG_PREFIX)).length;
    assert.equal(noTarget(), 1, JSON.stringify(launchLog));
    const command = async (cmd) => (cmd.startsWith('bd create') ? 'x-dec\n' : cmd.startsWith('node -e') ? '/tmp/f' : '');
    const sprintState = { notifyDecision: (rec) => notifyDecision({ decision: rec, config, fleetApi: null, log: (m) => launchLog.push(m) }) };
    const recs = [];
    for (const beadId of ['x-1', 'x-2']) {
        recs.push(await recordPendingDecision({
            sprintState, decision: { beadId, question: QUESTION, options: OPTIONS, recommendation: 'a' },
            raisedBy: 'doer', cycle: 1, round: 1, command, member: 'm',
            scopeBeads: [{ id: 'x-1', status: 'open' }, { id: 'x-2', status: 'open' }], log: (m) => launchLog.push(m),
        }));
    }
    for (const rec of recs) {
        assert.ok(rec, 'decision recorded');
        assert.equal(rec.notification.message.status, 'failed');
    }
    assert.equal(noTarget(), 1, 'no repeated no-target line');
    assert.equal(launchLog.filter((l) => /NOTIFICATION FAILED \(message\)/.test(l)).length, 0, JSON.stringify(launchLog));
});

test('resolveNotifyTargets: default message target is the orchestrator session; an explicit one is honoured', () => {
    const def = resolveNotifyTargets({ config: undefined, hasFleetClient: true });
    assert.equal(def.config.messageMember, DEFAULT_MESSAGE_TARGET);
    assert.equal(def.config.messageTargetSource, 'default');
    assert.equal(def.launchLines.filter((l) => l.startsWith(NO_MESSAGE_TARGET_LOG_PREFIX)).length, 0);
    const explicit = resolveNotifyTargets({ config: validateDecisionNotify({ message_member: 'ops-session' }), hasFleetClient: true });
    assert.equal(explicit.config.messageMember, 'ops-session');
    assert.equal(explicit.config.messageTargetSource, 'configured');
});

test('resolveNotifyTargets: no fleet client -> one launch line, and decisions record failed without repeating it', async () => {
    const { config, launchLines } = resolveNotifyTargets({ config: validateDecisionNotify({ message_member: 'm' }), hasFleetClient: false });
    assert.equal(config.messageMember, undefined);
    assert.equal(launchLines.filter((l) => l.startsWith(NO_MESSAGE_TARGET_LOG_PREFIX)).length, 1);
    assert.ok(launchLines.some((l) => l.includes('message_member')), 'names how to configure it');
    const logs = [];
    for (const d of [record(), record()]) {
        await notifyDecision({ decision: d, config, fleetApi: null, log: (m) => logs.push(m) });
        assert.equal(d.notification.message.status, 'failed');
        assert.equal(d.notification.message.reason, NO_CHANNEL_REASON);
        assert.equal(d.notification.email.status, 'failed');
    }
    assert.deepEqual(logs.filter((l) => l.startsWith('NOTIFICATION FAILED')), [], JSON.stringify(logs));
});
