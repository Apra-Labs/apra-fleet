// =============================================================================
// KB auth keeper: keeps a member's KB token fresh around each dispatch and
// reacts when the agent hit a KB auth error. The KB counterpart of the VCS
// auth self-heal (onAuthFailure / onLlmAuthFailure in runner.js).
//
// Active only when the orchestrator's KB config (fleet_status json,
// kbHealth.credential) selects an HTTP KB whose token comes from a fleet
// secret, static or live: that gives the remote URL and the secret name every
// provision_kb_auth call here uses. A literal token or a sqlite KB turns it
// off for the run.
//
// - Remote member, dispatch starts: provision_kb_auth when the member's
//   recorded refresh time has passed, or nothing is recorded yet.
// - Remote member, dispatch running: a timer at that refresh time runs
//   provision_kb_auth again; it stops when the member's last dispatch ends.
//   A timed push that fails is logged and tried again KB_AUTH_PUSH_RETRY_MS
//   later.
// - Dispatch ends with E-KB-HTTP-AUTH in execute_prompt's toolErrors: remote
//   member, provision_kb_auth (reason rejected when the KB server refused the
//   token); local member, provision_kb_auth too, whose local path is one
//   resolve in the orchestrator's fleet server. On success the same session is
//   resumed once with KB_AUTH_RESUME_NOTE (a fresh dispatch of the prompt plus
//   the note when no session id came back); on failure there is no resume and
//   one error is logged per member per run. A failed dispatch is healed but
//   not resumed: its own retry ladder follows.
// - toolErrors unavailable (an older member install, a skipped read): no heal.
//
// The recorded refresh time is provision_kb_auth's refreshAt (expiresAt minus
// T, computed by the fleet server from config.json liveSecrets.*). It lives in
// this process only: after a sprint restart nothing is recorded, so the first
// dispatch on each remote member pushes again.
// =============================================================================

import { resultText } from './mcp-result.mjs';

export const KB_AUTH_ERROR_CODE = 'E-KB-HTTP-AUTH';
/** Delay before a failed timed push is tried again. */
export const KB_AUTH_PUSH_RETRY_MS = 60_000;
/** What the resumed (or re-dispatched) agent is told after a successful heal. */
export const KB_AUTH_RESUME_NOTE =
    'KB auth is restored: the knowledge bank calls that failed with E-KB-HTTP-AUTH will work now. ' +
    'Redo any KB lookups or captures you needed, finish the task, and give your final answer again in the same format as before.';

function parseJson(text) {
    try { return JSON.parse(text); } catch { return null; }
}

/**
 * The KB auth errors in a dispatch's toolErrors reports, or null when there is
 * none or no report could be read. `rejected` is true when the KB server
 * refused a token (reason rejected).
 * @param {Array<{available?: boolean, entries?: Array<{code?: string, reason?: string|null}>}>} reports
 * @returns {{ rejected: boolean, count: number } | null}
 */
export function kbAuthErrorsOf(reports) {
    let count = 0;
    let rejected = false;
    for (const r of reports) {
        if (!r || r.available !== true || !Array.isArray(r.entries)) continue;
        for (const e of r.entries) {
            if (!e || e.code !== KB_AUTH_ERROR_CODE) continue;
            count += 1;
            if (e.reason === 'rejected') rejected = true;
        }
    }
    return count > 0 ? { rejected, count } : null;
}

/**
 * @param {{
 *   callTool: (name: string, args: object) => Promise<any>,
 *   log?: (line: string) => void,
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (handle: any) => void,
 *   retryMs?: number,
 * }} opts
 */
export function createKbAuthKeeper(opts) {
    const { callTool, log = () => {} } = opts;
    const now = opts.now ?? Date.now;
    const setTimer = opts.setTimer ?? ((fn, ms) => { const h = setTimeout(fn, ms); if (h && h.unref) h.unref(); return h; });
    const clearTimer = opts.clearTimer ?? clearTimeout;
    const retryMs = opts.retryMs ?? KB_AUTH_PUSH_RETRY_MS;

    /** Resolved once: {remote, secret}, or null when the KB needs no keeping. */
    let kbConfig;
    let kbConfigFailureLogged = false;
    /** member name -> {type} from member_detail. */
    const memberTypes = new Map();
    /** member name -> {expiresAt: string|null, refreshAtMs: number|null}: the last successful push. */
    const records = new Map();
    /** member name -> in-flight push promise (one push per member at a time). */
    const pushing = new Map();
    /** member name -> {active: number, handle: any}. */
    const timers = new Map();
    /** `${member}|${reason}` already logged for a failed push. */
    const pushFailuresLogged = new Set();
    /** members whose failed heal was already logged. */
    const healFailuresLogged = new Set();

    async function sprintKb() {
        if (kbConfig !== undefined) return kbConfig;
        let status;
        try {
            status = parseJson(resultText(await callTool('fleet_status', { format: 'json' })));
        } catch (err) {
            if (!kbConfigFailureLogged) log(`[kb-auth] WARN: could not read the KB config from fleet_status (${err && err.message ? err.message : err}); KB tokens are not kept fresh until it can be read.`);
            kbConfigFailureLogged = true;
            return null;
        }
        if (!status || typeof status !== 'object') {
            // Not a transport failure: asking again would get the same answer.
            log('[kb-auth] WARN: fleet_status returned no JSON; KB tokens are not kept fresh in this run.');
            kbConfig = null;
            return null;
        }
        const c = status.kbHealth && status.kbHealth.credential;
        if (c && (c.kind === 'secret' || c.kind === 'live') && typeof c.url === 'string' && typeof c.secretName === 'string') {
            kbConfig = { remote: c.url, secret: c.secretName };
            log(`[kb-auth] the KB at ${c.url} takes its token from secret '${c.secretName}': members' tokens are kept fresh with provision_kb_auth.`);
        } else {
            kbConfig = null;
        }
        return kbConfig;
    }

    async function memberType(member) {
        if (memberTypes.has(member)) return memberTypes.get(member);
        let type = null;
        try {
            const detail = parseJson(resultText(await callTool('member_detail', { member_name: member, format: 'json' })));
            const d = detail && (detail.member && typeof detail.member === 'object' ? { ...detail.member, ...detail } : detail);
            if (d && typeof d.type === 'string') type = d.type.toLowerCase();
        } catch {
            type = null;
        }
        // An unknown type is not cached, so the next dispatch asks again.
        if (type) memberTypes.set(member, type);
        return type;
    }

    /** One provision_kb_auth call; {ok, expiresAt, refreshAtMs, reason}. Never throws. */
    async function provision(member, cfg, reason) {
        let res;
        try {
            res = await callTool('provision_kb_auth', {
                member_name: member, secret: cfg.secret, remote: cfg.remote, ...(reason ? { reason } : {}),
            });
        } catch (err) {
            return { ok: false, reason: `call failed: ${err && err.message ? err.message : err}` };
        }
        const sc = res && res.structuredContent;
        if (!res || res.isError || !sc || sc.ok !== true) {
            const why = sc && typeof sc.reason === 'string' ? sc.reason
                : (sc && sc.verification && sc.verification.reason) || resultText(res) || 'no result';
            return { ok: false, reason: String(why) };
        }
        const expiresAt = typeof sc.expiresAt === 'string' ? sc.expiresAt : null;
        const refreshAtMs = typeof sc.refreshAt === 'string' && Number.isFinite(Date.parse(sc.refreshAt)) ? Date.parse(sc.refreshAt) : null;
        return { ok: true, expiresAt, refreshAtMs };
    }

    /** Push the token to a remote member and record its refresh time. Single-flight per member. */
    function push(member, cfg, why) {
        const inFlight = pushing.get(member);
        if (inFlight) return inFlight;
        const run = (async () => {
            const before = records.get(member);
            const r = await provision(member, cfg);
            if (!r.ok) {
                const key = `${member}|${r.reason}`;
                if (!pushFailuresLogged.has(key)) {
                    pushFailuresLogged.add(key);
                    log(`[kb-auth] WARN: provision_kb_auth for member '${member}' (${why}) failed: ${r.reason}. Tried again at the next check.`);
                }
                return { ok: false, changed: false };
            }
            records.set(member, { expiresAt: r.expiresAt, refreshAtMs: r.refreshAtMs });
            log(`[kb-auth] provision_kb_auth for member '${member}' (${why}): token expires ${r.expiresAt ?? 'never'}.`);
            return { ok: true, changed: !before || before.expiresAt !== r.expiresAt };
        })();
        const shared = run.finally(() => { if (pushing.get(member) === shared) pushing.delete(member); });
        pushing.set(member, shared);
        return shared;
    }

    /** Dispatch start on a remote member: push unless the recorded token is still fresh. */
    async function ensureFresh(member, cfg) {
        const rec = records.get(member);
        if (rec && (rec.refreshAtMs === null || now() < rec.refreshAtMs)) return;
        await push(member, cfg, rec ? 'token within its refresh window' : 'no token recorded in this sprint process');
    }

    function arm(member, cfg, delayMs) {
        const t = timers.get(member);
        if (!t || t.active === 0) return;
        if (t.handle !== null) clearTimer(t.handle);
        t.handle = setTimer(() => { t.handle = null; void fire(member, cfg); }, Math.max(0, delayMs));
    }

    /** Arm the member's timer from its record: at the refresh time, or a retry when nothing is recorded. */
    function armFromRecord(member, cfg) {
        const rec = records.get(member);
        if (!rec) return arm(member, cfg, retryMs);
        if (rec.refreshAtMs === null) return; // no expiry: nothing to keep fresh
        arm(member, cfg, rec.refreshAtMs - now());
    }

    async function fire(member, cfg) {
        const t = timers.get(member);
        if (!t || t.active === 0) return;
        const r = await push(member, cfg, 'refresh time reached during a dispatch');
        if (!r.ok) return arm(member, cfg, retryMs);
        // The same expiry again (a static secret nobody rotated): another push
        // cannot help, so the timer stops; the next dispatch start checks again.
        if (!r.changed) return;
        armFromRecord(member, cfg);
    }

    function startTimer(member, cfg) {
        const t = timers.get(member) ?? { active: 0, handle: null };
        timers.set(member, t);
        t.active += 1;
        if (t.active === 1) armFromRecord(member, cfg);
    }

    function stopTimer(member) {
        const t = timers.get(member);
        if (!t) return;
        t.active = Math.max(0, t.active - 1);
        if (t.active === 0 && t.handle !== null) {
            clearTimer(t.handle);
            t.handle = null;
        }
    }

    /** provision_kb_auth after the agent hit a KB auth error. True when the token is good again. */
    async function heal(member, type, cfg, auth) {
        const remote = type !== 'local';
        // A local member's KB provider already retried in-line; its call only resolves the secret.
        const r = await provision(member, cfg, remote && auth.rejected ? 'rejected' : undefined);
        if (!r.ok) {
            if (!healFailuresLogged.has(member)) {
                healFailuresLogged.add(member);
                log(`[kb-auth] ERROR: member '${member}' hit ${KB_AUTH_ERROR_CODE} and provision_kb_auth could not restore its KB token: ${r.reason}. Not resumed; fleet_status shows the secret's state. Logged once per member per run.`);
            }
            return false;
        }
        if (remote) records.set(member, { expiresAt: r.expiresAt, refreshAtMs: r.refreshAtMs });
        return true;
    }

    /**
     * Run one dispatch with the KB token kept fresh around it.
     * @param {{ member?: string, prompt: string, opts: object, run: (prompt: string, opts: object) => Promise<any> }} d
     */
    async function dispatch({ member, prompt, opts: dispatchOpts, run }) {
        const cfg = member ? await sprintKb() : null;
        const type = cfg ? await memberType(member) : null;
        if (!cfg || !type) return run(prompt, dispatchOpts);
        const remote = type !== 'local';
        if (remote) {
            await ensureFresh(member, cfg);
            startTimer(member, cfg);
        }
        try {
            const reports = [];
            let sessionId = null;
            const watched = {
                ...dispatchOpts,
                onToolErrors: (report, meta) => {
                    reports.push(report);
                    if (typeof dispatchOpts.onToolErrors === 'function') dispatchOpts.onToolErrors(report, meta);
                },
                onSessionId: (id, meta) => {
                    sessionId = id;
                    if (typeof dispatchOpts.onSessionId === 'function') dispatchOpts.onSessionId(id, meta);
                },
            };
            let value;
            try {
                value = await run(prompt, watched);
            } catch (err) {
                const auth = kbAuthErrorsOf(reports);
                if (auth) await heal(member, type, cfg, auth);
                throw err;
            }
            const auth = kbAuthErrorsOf(reports);
            if (!auth || !(await heal(member, type, cfg, auth))) return value;
            const label = dispatchOpts.label ? `${dispatchOpts.label} [KB auth restored]` : undefined;
            if (sessionId) {
                log(`[kb-auth] member '${member}' hit ${KB_AUTH_ERROR_CODE} ${auth.count} time(s); KB auth restored, resuming session '${sessionId}' once.`);
                return await run(KB_AUTH_RESUME_NOTE, { ...dispatchOpts, resume: sessionId, ...(label ? { label } : {}) });
            }
            log(`[kb-auth] member '${member}' hit ${KB_AUTH_ERROR_CODE} ${auth.count} time(s); KB auth restored, and the provider reported no session to resume, so the prompt is dispatched again once with the note.`);
            return await run(`${prompt}\n\n${KB_AUTH_RESUME_NOTE}`, { ...dispatchOpts, resume: false, ...(label ? { label } : {}) });
        } finally {
            if (remote) stopTimer(member);
        }
    }

    return { dispatch };
}
