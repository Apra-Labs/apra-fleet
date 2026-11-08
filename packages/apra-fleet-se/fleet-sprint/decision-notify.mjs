// =============================================================================
// OPERATOR NOTIFICATION FOR A PENDING DECISION.
//
// When decisions.mjs records a NEEDS-DECISION request, the operator must hear
// about it: this module sends ONE message (send_message to the orchestrating
// session) and ONE email (send_email) per decision, and records the outcome
// per channel on the pending decision:
//
//   decision.notification = {
//     message: { status: 'sent' | 'failed', reason?, at },
//     email:   { status: 'sent' | 'failed', reason?, at },
//   }
//
// HARD CONTRACT: a notification problem NEVER changes the sprint. Every
// failure path -- channel not configured, tool error, an error result such as
// "member not connected", a thrown exception, a timeout -- is caught, logged as
// one loud line, recorded as `failed` with the reason, and the caller carries
// on exactly as if the send had worked. notifyDecision() itself never throws.
//
// ONCE PER DECISION: a channel whose outcome is already recorded on the
// decision (sent OR failed) is never attempted again, so later rounds, a
// pause/resume or a repeated call do not re-send. Never retried in a loop.
//
// MESSAGE TARGET, resolved ONCE at launch (resolveNotifyTargets): an explicit
// decision_notify.message_member is honoured as-is; otherwise the default is
// DEFAULT_MESSAGE_TARGET ("orchestrator"), the stable id under which the fleet
// server registers the operator's own orchestrating session (a session with no
// member identity that declared the claude/channel capability; newest wins).
// The sprint therefore reaches the session that launched or orchestrates it
// with no configuration. A run with no fleet client has no resolvable target:
// that, and any channel that is not configured, is logged ONCE at launch with
// how to configure it; per decision the channel is still recorded `failed`
// but the warning is not repeated.
//
// CONFIGURATION is explicit (the `decision_notify` sprint arg, validated by
// validateDecisionNotify): { message_member, email: { provider, from, to,
// host, port, user, secure }, dashboard_url, timeout_s }. Credentials are
// never part of it: the fleet server resolves them from its credential store
// (sendgrid_api_key / smtp_password), so no secret value is ever read,
// logged or sent here. A channel that is not configured is a recorded
// failure ("no channel configured"), logged loudly, never silent.
// =============================================================================

export const DEFAULT_NOTIFY_TIMEOUT_MS = 30_000;
export const NO_CHANNEL_REASON = 'no channel configured';
/** Registry id of the operator's orchestrating session on the fleet server. */
export const DEFAULT_MESSAGE_TARGET = 'orchestrator';
export const NO_MESSAGE_TARGET_LOG_PREFIX = 'Decision notification: no message target';

const ALLOWED_KEYS = new Set(['message_member', 'email', 'dashboard_url', 'timeout_s']);
const ALLOWED_EMAIL_KEYS = new Set(['provider', 'from', 'to', 'host', 'port', 'user', 'secure']);

/**
 * Validates the raw `decision_notify` arg (a JSON string or an object).
 * Unknown keys are rejected (so a literal password cannot be smuggled in).
 * Returns the normalized config, or undefined when absent.
 * @param {unknown} raw
 * @returns {{ messageMember?: string, email?: object, dashboardUrl?: string, timeoutMs: number }|undefined}
 */
export function validateDecisionNotify(raw) {
    if (raw === undefined || raw === null || raw === '') return undefined;
    let cfg = raw;
    if (typeof raw === 'string') {
        try { cfg = JSON.parse(raw); } catch { throw new Error('[Arg Contract] Invalid decision_notify: not valid JSON.'); }
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        throw new Error('[Arg Contract] Invalid decision_notify: must be a JSON object.');
    }
    for (const k of Object.keys(cfg)) {
        if (!ALLOWED_KEYS.has(k)) throw new Error(`[Arg Contract] Invalid decision_notify: unknown key "${k}" (credentials are never passed here; the fleet credential store holds them).`);
    }
    const out = { timeoutMs: DEFAULT_NOTIFY_TIMEOUT_MS };
    if (cfg.message_member !== undefined) {
        if (typeof cfg.message_member !== 'string' || !cfg.message_member.trim()) throw new Error('[Arg Contract] Invalid decision_notify.message_member: must be a non-empty string.');
        out.messageMember = cfg.message_member.trim();
    }
    if (cfg.dashboard_url !== undefined) {
        if (typeof cfg.dashboard_url !== 'string' || !/^https?:\/\/\S+$/.test(cfg.dashboard_url)) throw new Error('[Arg Contract] Invalid decision_notify.dashboard_url: must be an http(s) URL.');
        out.dashboardUrl = cfg.dashboard_url;
    }
    if (cfg.timeout_s !== undefined) {
        if (!Number.isInteger(cfg.timeout_s) || cfg.timeout_s < 1) throw new Error('[Arg Contract] Invalid decision_notify.timeout_s: must be an integer >= 1.');
        out.timeoutMs = cfg.timeout_s * 1000;
    }
    if (cfg.email !== undefined) {
        const e = cfg.email;
        if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error('[Arg Contract] Invalid decision_notify.email: must be an object.');
        for (const k of Object.keys(e)) {
            if (!ALLOWED_EMAIL_KEYS.has(k)) throw new Error(`[Arg Contract] Invalid decision_notify.email: unknown key "${k}" (credentials are never passed here; the fleet credential store holds them).`);
        }
        const provider = e.provider === undefined ? 'sendgrid' : e.provider;
        if (provider !== 'sendgrid' && provider !== 'smtp') throw new Error('[Arg Contract] Invalid decision_notify.email.provider: must be "sendgrid" or "smtp".');
        if (typeof e.from !== 'string' || !e.from.trim()) throw new Error('[Arg Contract] Invalid decision_notify.email.from: required.');
        const to = Array.isArray(e.to) ? e.to : [e.to];
        if (to.length === 0 || to.some((t) => typeof t !== 'string' || !t.trim())) throw new Error('[Arg Contract] Invalid decision_notify.email.to: required (address or list).');
        if (provider === 'smtp' && (typeof e.host !== 'string' || !e.host || typeof e.user !== 'string' || !e.user)) {
            throw new Error('[Arg Contract] Invalid decision_notify.email: smtp needs host and user.');
        }
        if (e.port !== undefined && !Number.isInteger(e.port)) throw new Error('[Arg Contract] Invalid decision_notify.email.port: must be an integer.');
        out.email = { provider, from: e.from.trim(), to: Array.isArray(e.to) ? to.map((t) => t.trim()) : to[0].trim() };
        for (const k of ['host', 'port', 'user', 'secure']) if (e[k] !== undefined) out.email[k] = e[k];
    }
    return out;
}

/**
 * Resolves the notification targets ONCE at sprint launch.
 *
 * message: the explicit message_member when configured, else
 * DEFAULT_MESSAGE_TARGET -- both only when the run has a fleet client to send
 * through. email: as configured. Returns the config notifyDecision() should
 * use plus the launch log lines (one per channel that has no target, each
 * naming how to configure it). Channels reported here are marked in
 * `launchReported` so notifyDecision() records them failed without repeating
 * the warning per decision.
 *
 * @param {{ config?: object, hasFleetClient: boolean }} opts
 * @returns {{ config: object, launchLines: string[] }}
 */
export function resolveNotifyTargets({ config, hasFleetClient }) {
    const resolved = { timeoutMs: DEFAULT_NOTIFY_TIMEOUT_MS, ...(config || {}) };
    const launchReported = new Set();
    const launchLines = [];
    if (!hasFleetClient) {
        delete resolved.messageMember;
        launchReported.add('message');
        launchLines.push(`${NO_MESSAGE_TARGET_LOG_PREFIX} can be resolved: this run has no fleet client to send through, so needs-decision messages will not be sent. Launch the sprint through the fleet server (CLI or supervisor) and set decision_notify.message_member (--decision-notify, or the decisionNotify launch field) to a connected session id; the default "${DEFAULT_MESSAGE_TARGET}" is the operator's own channel-capable session.`);
    } else if (config && config.messageMember) {
        resolved.messageTargetSource = 'configured';
    } else {
        resolved.messageMember = DEFAULT_MESSAGE_TARGET;
        resolved.messageTargetSource = 'default';
    }
    if (!resolved.email) {
        launchReported.add('email');
        launchLines.push('Decision notification: no email channel configured; needs-decision emails will not be sent. Set decision_notify.email (--decision-notify, or the decisionNotify launch field) to enable it.');
    }
    resolved.launchReported = launchReported;
    return { config: resolved, launchLines };
}

/** Plain-text notification body: bead, full question, every option, recommendation, how to answer. */
export function formatNotificationBody(decision, { dashboardUrl } = {}) {
    const lines = [
        `A sprint is waiting for an operator decision on bead ${decision.beadId}.`,
        '',
        'Question:',
        decision.question,
        '',
        'Options:',
        ...decision.options.map((o) => `(${o.id}) ${o.text}`),
        '',
        'Recommendation:',
        decision.recommendation,
        '',
        'How to answer:',
    ];
    if (decision.decisionBeadId) lines.push(`- bd human respond ${decision.decisionBeadId} "<chosen option id and any instructions>"`);
    else lines.push('- the decision bead could not be filed; record the decision in the work bead notes and re-run the sprint');
    if (dashboardUrl) lines.push(`- or answer in the sprint dashboard: ${dashboardUrl}`);
    return lines.join('\n');
}

/** Extracts the text of a raw callTool() result (string, { content: [{ text }] }, or object). */
function resultText(res) {
    if (typeof res === 'string') return res;
    if (res && Array.isArray(res.content)) return res.content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('');
    return '';
}

/**
 * Whether a send_message / send_email result reports success. Returns
 * { ok: true } or { ok: false, reason }.
 */
export function judgeSendResult(res) {
    if (res && typeof res === 'object' && res.isError === true) {
        return { ok: false, reason: `tool error: ${resultText(res).slice(0, 300) || 'unknown'}` };
    }
    const text = resultText(res).trim();
    let parsed = null;
    if (text) { try { parsed = JSON.parse(text); } catch { /* plain text */ } }
    else if (res && typeof res === 'object' && !Array.isArray(res.content)) parsed = res;
    if (parsed && typeof parsed === 'object') {
        if (parsed.error) return { ok: false, reason: String(parsed.error).slice(0, 300) };
        if (parsed.ok === false) return { ok: false, reason: 'tool reported ok=false' };
        return { ok: true };
    }
    if (/^error\b|\bfailed\b/i.test(text)) return { ok: false, reason: text.slice(0, 300) };
    return { ok: true };
}

function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Sends the notifications for one pending decision (once per channel) and
 * records the outcomes on decision.notification. Never throws.
 *
 * @param {object} opts
 * @param {object} opts.decision a sprintState.pendingDecisions record
 * @param {{ messageMember?: string, email?: object, dashboardUrl?: string, timeoutMs?: number }|undefined} opts.config
 * @param {{ sendMessage?: Function, sendEmail?: Function }|null} opts.fleetApi
 * @param {Function} [opts.log]
 * @param {() => number} [opts.now]
 * @returns {Promise<object>} decision.notification
 */
export async function notifyDecision({ decision, config, fleetApi, log = () => {}, now = () => Date.now() }) {
    try {
        decision.notification = decision.notification && typeof decision.notification === 'object' ? decision.notification : {};
        const note = decision.notification;
        const timeoutMs = (config && config.timeoutMs) || DEFAULT_NOTIFY_TIMEOUT_MS;
        const body = formatNotificationBody(decision, { dashboardUrl: config && config.dashboardUrl });
        const subject = `Sprint decision needed: ${decision.beadId}`;

        const channels = [
            ['message', config && config.messageMember, () => fleetApi.sendMessage({ member_id: config.messageMember, content: `${subject}\n\n${body}` })],
            ['email', config && config.email, () => fleetApi.sendEmail({ ...config.email, subject, body })],
        ];
        for (const [channel, configured, send] of channels) {
            if (note[channel]) continue; // once per decision, whatever the earlier outcome
            const record = (status, reason) => {
                note[channel] = { status, ...(reason ? { reason } : {}), at: new Date(now()).toISOString() };
            };
            let reason = null;
            if (!configured) reason = NO_CHANNEL_REASON;
            else if (!fleetApi || typeof (channel === 'message' ? fleetApi.sendMessage : fleetApi.sendEmail) !== 'function') reason = 'no fleet client available';
            else {
                try {
                    const verdict = judgeSendResult(await withTimeout(Promise.resolve().then(send), timeoutMs));
                    if (!verdict.ok) reason = verdict.reason;
                } catch (err) {
                    reason = err && err.message ? err.message : String(err);
                }
            }
            if (reason) {
                record('failed', reason);
                // A channel reported at launch as having no target is recorded
                // but not re-warned per decision.
                const reportedAtLaunch = reason === NO_CHANNEL_REASON && config && config.launchReported instanceof Set && config.launchReported.has(channel);
                if (!reportedAtLaunch) log(`NOTIFICATION FAILED (${channel}) for decision ${decision.decisionId} on bead '${decision.beadId}': ${reason}. The sprint continues unchanged; answer with bd human respond ${decision.decisionBeadId || '<decision bead>'}.`);
            } else {
                record('sent');
                log(`Notification sent (${channel}) for decision ${decision.decisionId} on bead '${decision.beadId}'.`);
            }
        }
        return note;
    } catch (err) {
        try { log(`NOTIFICATION FAILED for decision ${decision && decision.decisionId}: unexpected error ${err && err.message}. The sprint continues unchanged.`); } catch { /* never throw */ }
        return (decision && decision.notification) || {};
    }
}
