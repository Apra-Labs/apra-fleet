// =============================================================================
// KB auth keeper: keeps a member's KB token fresh around each dispatch and
// reacts when the agent hit a KB auth error. The KB counterpart of the VCS
// auth self-heal (onAuthFailure / onLlmAuthFailure in runner.js).
//
// Active only when the orchestrator's KB config (<data dir>/knowledge/config.json,
// read once per run, no tool call) selects an HTTP KB whose token comes from a fleet
// secret, static or live: that gives the remote URL and the secret name every
// provision_kb_auth call here uses. A literal token or a sqlite KB turns it
// off for the run.
//
// - Members: every remote call passes keep_member_kb, so a member whose own KB
//   config names another remote, uses its local store or cannot be read is
//   refused before any mint and skipped for the run (one log line): it is
//   never rewired.
// - Remote member, dispatch starts: provision_kb_auth when the member's
//   recorded refresh time has passed, or nothing is recorded yet.
// - Remote member, dispatch running: a timer at that refresh time runs
//   provision_kb_auth again; it stops when the member's last dispatch ends.
//   A timed push that fails, or brings a live secret's same token back, is
//   logged and tried again KB_AUTH_PUSH_RETRY_MS later. A static secret that
//   comes back with the same expiry is not pushed again for that member in the
//   run. With no successful push recorded there is no timer: the next check is
//   the next dispatch start.
// - The heal and the resume renew the dispatch watchdog's lease once, so they
//   run under a fresh budget of their own.
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

import fs from 'node:fs';
import path from 'node:path';
import { getFleetDataDir } from '@apralabs/apra-fleet-client/server-resolution';
import { resultText } from './mcp-result.mjs';

export const KB_AUTH_ERROR_CODE = 'E-KB-HTTP-AUTH';
/** Delay before a failed timed push is tried again. */
export const KB_AUTH_PUSH_RETRY_MS = 60_000;
/** The longest delay setTimeout honours (2^31-1 ms); anything longer fires at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;
/** What the resumed (or re-dispatched) agent is told after a successful heal. */
export const KB_AUTH_RESUME_NOTE =
    'KB auth is restored: the knowledge bank calls that failed with E-KB-HTTP-AUTH will work now. ' +
    'Redo any KB lookups or captures you needed, finish the task, and give your final answer again in the same format as before.';

/**
 * provision_kb_auth refusals that hold for the whole run: the member's own KB
 * config is set up for something else (never rewired), or its install cannot
 * take the token. The member is skipped for the run after the first one.
 */
const PERMANENT_REFUSALS = {
    'member-kb-other-remote': 'its KB config names another remote',
    'member-kb-other-token': 'its KB config names this remote with its own token source',
    'member-kb-local-store': 'its KB config uses its local store',
    'member-kb-unreadable': 'its KB config cannot be read',
    'not-member-install': 'it runs a full fleet install, not a member install',
    'install-too-old': 'its fleet install is missing or too old (update_member fleet_install auto)',
    'relay-unsupported': 'it is a relay member, which cannot receive a secret file',
};

const TOKEN_REF_RE = /^\{\{(?:secret|secure)\.([a-zA-Z0-9_-]{1,64})\}\}$/;

/**
 * The orchestrator's KB config file (<data dir>/knowledge/config.json, the
 * file kb_setup writes), read directly: no tool call, no member probe. Null
 * when there is none. Throws when it cannot be read or parsed.
 */
export function readOrchestratorKbConfig(env = process.env) {
    const file = path.join(getFleetDataDir(env), 'knowledge', 'config.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

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
 *   readKbConfig?: () => object|null,
 * }} opts
 */
export function createKbAuthKeeper(opts) {
    const { callTool, log = () => {} } = opts;
    const now = opts.now ?? Date.now;
    const setTimer = opts.setTimer ?? ((fn, ms) => { const h = setTimeout(fn, ms); if (h && h.unref) h.unref(); return h; });
    const clearTimer = opts.clearTimer ?? clearTimeout;
    const retryMs = opts.retryMs ?? KB_AUTH_PUSH_RETRY_MS;
    const readKbConfig = opts.readKbConfig ?? readOrchestratorKbConfig;

    /** Resolved once: {remote, secret}, or null when the KB needs no keeping. */
    let kbConfig;
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
    /** member name -> in-flight heal promise. */
    const healing = new Map();
    /** members whose failed heal was already logged. */
    const healFailuresLogged = new Set();
    /** member name -> the permanent refusal it got: no push, timer or heal for the run. */
    const skipped = new Map();
    /** members whose static secret came back with the same expiry: no more pushes this run. */
    const staticSettled = new Set();

    /**
     * The KB the sprint keeps tokens for, read once per run from the
     * orchestrator's KB config: provider http with a {{secret.NAME}} token_ref.
     * Anything else, or a config that cannot be read (logged once), is null
     * for the whole run.
     */
    function sprintKb() {
        if (kbConfig !== undefined) return kbConfig;
        let raw;
        try {
            raw = readKbConfig();
        } catch (err) {
            log(`[kb-auth] WARN: could not read the orchestrator's KB config (${err && err.message ? err.message : err}); KB tokens are not kept fresh in this run.`);
            kbConfig = null;
            return kbConfig;
        }
        const ref = raw && typeof raw.token_ref === 'string' ? TOKEN_REF_RE.exec(raw.token_ref) : null;
        if (raw && raw.provider === 'http' && typeof raw.url === 'string' && raw.url && ref) {
            kbConfig = { remote: raw.url, secret: ref[1] };
            log(`[kb-auth] the KB at ${raw.url} takes its token from secret '${ref[1]}': members' tokens are kept fresh with provision_kb_auth.`);
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

    /**
     * One provision_kb_auth call; {ok, expiresAt, refreshAtMs, reason}. Never throws.
     * A remote member's call passes keep_member_kb, so a member KB config set up
     * for another remote or the local store is refused before any mint, and the
     * member is skipped for the run.
     */
    async function provision(member, cfg, remote, reason) {
        let res;
        try {
            res = await callTool('provision_kb_auth', {
                member_name: member, secret: cfg.secret, remote: cfg.remote,
                ...(remote ? { keep_member_kb: true } : {}), ...(reason ? { reason } : {}),
            });
        } catch (err) {
            return { ok: false, reason: `call failed: ${err && err.message ? err.message : err}` };
        }
        const sc = res && res.structuredContent;
        if (!res || res.isError || !sc || sc.ok !== true) {
            const why = sc && typeof sc.reason === 'string' ? sc.reason
                : (sc && sc.verification && sc.verification.reason) || resultText(res) || 'no result';
            if (Object.hasOwn(PERMANENT_REFUSALS, why) && !skipped.has(member)) {
                skipped.set(member, why);
                log(`[kb-auth] member '${member}' is not kept: ${PERMANENT_REFUSALS[why]} (${why}). The sprint leaves it as it is: no KB token push, timer or heal for it in this run.`);
            }
            return { ok: false, reason: String(why) };
        }
        const expiresAt = typeof sc.expiresAt === 'string' ? sc.expiresAt : null;
        const refreshAtMs = typeof sc.refreshAt === 'string' && Number.isFinite(Date.parse(sc.refreshAt)) ? Date.parse(sc.refreshAt) : null;
        // The member's KB config was rewritten to use this KB: said in the log, never silent.
        if (sc.memberChange && typeof sc.memberChange.detail === 'string') {
            log(`[kb-auth] member '${member}': ${sc.memberChange.detail}`);
        }
        return { ok: true, expiresAt, refreshAtMs, secretKind: sc.secretKind === 'static' ? 'static' : 'live' };
    }

    /** Push the token to a remote member and record its refresh time. Single-flight per member. */
    function push(member, cfg, why) {
        const inFlight = pushing.get(member);
        if (inFlight) return inFlight;
        const run = (async () => {
            const before = records.get(member);
            const r = await provision(member, cfg, true);
            if (!r.ok) {
                if (skipped.has(member)) return { ok: false, changed: false };
                const key = `${member}|${r.reason}`;
                if (!pushFailuresLogged.has(key)) {
                    pushFailuresLogged.add(key);
                    log(`[kb-auth] WARN: provision_kb_auth for member '${member}' (${why}) failed: ${r.reason}. Tried again at the next check.`);
                }
                return { ok: false, changed: false };
            }
            records.set(member, { expiresAt: r.expiresAt, refreshAtMs: r.refreshAtMs });
            log(`[kb-auth] provision_kb_auth for member '${member}' (${why}): token expires ${r.expiresAt ?? 'never'}.`);
            const changed = !before || before.expiresAt !== r.expiresAt;
            // A static secret with the same expiry again: nobody rotated it, so
            // pushing it again cannot help. Stopped for the rest of the run.
            if (!changed && r.secretKind === 'static' && !staticSettled.has(member)) {
                staticSettled.add(member);
                log(`[kb-auth] member '${member}': static secret '${cfg.secret}' still expires ${r.expiresAt ?? 'never'}; not pushed again in this run (rotate it to renew).`);
            }
            return { ok: true, changed };
        })();
        const shared = run.finally(() => { if (pushing.get(member) === shared) pushing.delete(member); });
        pushing.set(member, shared);
        return shared;
    }

    /** Dispatch start on a remote member: push unless the recorded token is still fresh. */
    async function ensureFresh(member, cfg) {
        if (staticSettled.has(member)) return;
        const rec = records.get(member);
        if (rec && (rec.refreshAtMs === null || now() < rec.refreshAtMs)) return;
        await push(member, cfg, rec ? 'token within its refresh window' : 'no token recorded in this sprint process');
    }

    function arm(member, cfg, delayMs) {
        const t = timers.get(member);
        if (!t || t.active === 0) return;
        if (t.handle !== null) clearTimer(t.handle);
        // setTimeout fires at once above 2^31-1 ms (about 24.8 days): longer
        // delays are capped, and fire() re-arms from the record when early.
        t.handle = setTimer(() => { t.handle = null; void fire(member, cfg); }, Math.min(Math.max(0, delayMs), MAX_TIMER_MS));
    }

    /**
     * Arm the member's timer at its recorded refresh time. Nothing recorded (the
     * dispatch-start push failed) or no expiry: no timer; the next check is the
     * next dispatch start.
     */
    function armFromRecord(member, cfg) {
        const rec = records.get(member);
        if (!rec || rec.refreshAtMs === null) return;
        arm(member, cfg, rec.refreshAtMs - now());
    }

    async function fire(member, cfg) {
        const t = timers.get(member);
        if (!t || t.active === 0) return;
        const rec = records.get(member);
        // Woken before the refresh time (a capped delay): nothing to push yet.
        if (rec && rec.refreshAtMs !== null && now() < rec.refreshAtMs) return armFromRecord(member, cfg);
        const r = await push(member, cfg, 'refresh time reached during a dispatch');
        if (skipped.has(member)) return;
        if (!r.ok) return arm(member, cfg, retryMs);
        if (staticSettled.has(member)) return;
        if (!r.changed) {
            // The same expiry again from a live secret: its refresh failed or is
            // backing off, and the old token is still served. Tried again after
            // a fixed delay, so the retries never close in on the expiry.
            const key = `${member}|same-expiry`;
            if (!pushFailuresLogged.has(key)) {
                pushFailuresLogged.add(key);
                log(`[kb-auth] WARN: the timed push for member '${member}' brought no new token from live secret '${cfg.secret}' (it still expires ${records.get(member)?.expiresAt ?? 'never'}); tried again in ${Math.round(retryMs / 1000)} s. fleet_status shows the secret's state.`);
            }
            return arm(member, cfg, retryMs);
        }
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

    /**
     * provision_kb_auth after the agent hit a KB auth error. True when the token
     * is good again. Single-flight per member, like push(): a second heal on the
     * member while one runs waits for it instead of minting again.
     */
    function heal(member, type, cfg, auth) {
        const inFlight = healing.get(member);
        if (inFlight) return inFlight;
        const run = healOnce(member, type, cfg, auth);
        const shared = run.finally(() => { if (healing.get(member) === shared) healing.delete(member); });
        healing.set(member, shared);
        return shared;
    }

    async function healOnce(member, type, cfg, auth) {
        const remote = type !== 'local';
        // A local member's KB provider already retried in-line; its call only resolves the secret.
        const r = await provision(member, cfg, remote, remote && auth.rejected ? 'rejected' : undefined);
        if (!r.ok) {
            if (!healFailuresLogged.has(member)) {
                healFailuresLogged.add(member);
                log(`[kb-auth] ERROR: member '${member}' hit ${KB_AUTH_ERROR_CODE} and provision_kb_auth could not restore its KB token: ${r.reason}. Not resumed; fleet_status shows the secret's state. Logged once per member per run.`);
            }
            return false;
        }
        if (remote) {
            records.set(member, { expiresAt: r.expiresAt, refreshAtMs: r.refreshAtMs });
            // The running timer still points at the old token's refresh time.
            armFromRecord(member, cfg);
        }
        return true;
    }

    /**
     * Run one dispatch with the KB token kept fresh around it.
     * @param {{ member?: string, prompt: string, opts: object, run: (prompt: string, opts: object) => Promise<any> }} d
     */
    /**
     * The pre-dispatch work: KB config, member type and the dispatch-start
     * push. dispatch-role calls it before the agent() call, so outside the
     * watchdog race, and marks the lease so dispatch() does not do it again.
     */
    async function prepare({ member, lease } = {}) {
        const cfg = member ? sprintKb() : null;
        const type = cfg && !skipped.has(member) ? await memberType(member) : null;
        if (cfg && type && type !== 'local') await ensureFresh(member, cfg);
        if (lease && typeof lease === 'object') lease.kbPrepared = true;
    }

    async function dispatch({ member, prompt, opts: rawOpts, run }) {
        // The watchdog lease is the caller's, never a dispatch option.
        const { watchdogLease, ...dispatchOpts } = rawOpts || {};
        const cfg = member ? sprintKb() : null;
        const type = cfg && !skipped.has(member) ? await memberType(member) : null;
        if (!cfg || !type) return run(prompt, dispatchOpts);
        const remote = type !== 'local';
        if (remote) {
            if (!(watchdogLease && watchdogLease.kbPrepared)) await ensureFresh(member, cfg);
            // Refused at that push: this member's KB is its own business.
            if (skipped.has(member)) return run(prompt, dispatchOpts);
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
            if (!auth) return value;
            // The heal and the resume get a fresh watchdog budget of their own,
            // so a dispatch that ended near its max_total_s is not killed during
            // them. The lease renews once (dispatch-failure.mjs). A renew that
            // fails means the watchdog already gave up on this dispatch: the
            // engine has moved on, so nothing is healed or resumed outside it.
            if (watchdogLease && typeof watchdogLease.renew === 'function') {
                if (!watchdogLease.renew()) {
                    log(`[kb-auth] member '${member}' hit ${KB_AUTH_ERROR_CODE}, but its dispatch was already abandoned by the watchdog: no heal or resume.`);
                    return value;
                }
                log(`[kb-auth] member '${member}': the heal and resume run under a fresh dispatch watchdog budget.`);
            }
            if (!(await heal(member, type, cfg, auth))) return value;
            const label = dispatchOpts.label ? `${dispatchOpts.label} [KB auth restored]` : undefined;
            if (sessionId) {
                log(`[kb-auth] member '${member}' hit ${KB_AUTH_ERROR_CODE} ${auth.count} time(s); KB auth restored, resuming session '${sessionId}' once.`);
            } else {
                log(`[kb-auth] member '${member}' hit ${KB_AUTH_ERROR_CODE} ${auth.count} time(s); KB auth restored, and the provider reported no session to resume, so the prompt is dispatched again once with the note.`);
            }
            try {
                return sessionId
                    ? await run(KB_AUTH_RESUME_NOTE, { ...dispatchOpts, resume: sessionId, ...(label ? { label } : {}) })
                    : await run(`${prompt}\n\n${KB_AUTH_RESUME_NOTE}`, { ...dispatchOpts, resume: false, ...(label ? { label } : {}) });
            } catch (err) {
                // The first answer was usable: a failed resume (an expired
                // session, a busy member, a dropped transport) must not make the
                // role's retry ladder re-run the work.
                log(`[kb-auth] WARN: the resume after the KB auth heal on member '${member}' failed (${err && err.message ? err.message : err}); keeping the dispatch's first answer.`);
                return value;
            }
        } finally {
            if (remote) stopTimer(member);
        }
    }

    return { prepare, dispatch };
}
