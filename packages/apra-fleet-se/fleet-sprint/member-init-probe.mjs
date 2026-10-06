// =============================================================================
// Per-member sprint-init probe (parent bug apra-fleet-b4g.51).
//
// At sprint init, for every sprint member and in this order, each step
// recorded independently (a failing step records its reason and one-line fix
// and the probe moves on):
//
//   0. resolve   -- member_detail (format:'json') on the orchestrator's own
//                   session: the member's id, type and LLM provider. Not a
//                   kb_* / code_* tool, so the orchestrator session is the
//                   right one for it.
//   1. server    -- REMOTE members only: is the member's own fleet server
//                   running? `apra-fleet status` on the member; when it
//                   reports stopped, `apra-fleet start`. Both command strings
//                   are built here by getSeCommands(target).wrapForMember for
//                   the member's {os, shell} -- no shell-level expansion.
//                   Local members share the orchestrator's server: skipped.
//   2. tools     -- listTools(member) on the MEMBER session must list kb_*
//                   and code_* tools; then the member's recorded fleetMcp
//                   status is refreshed server-side through member_detail
//                   with refresh:true (the server re-probes the path a
//                   dispatched session actually uses -- for a claude member
//                   the per-session member config, so no per-folder entry is
//                   required -- heals what it can (registration on the
//                   member's own install, role-file grants) and RECORDS the
//                   result; see src/tools/member-detail.ts).
//   3. overrides -- the member is UNVERIFIED even when its member session
//                   lists the tools when: provider opencode
//                   (no-per-tool-deny: opencode cannot deny individual tools,
//                   engine-side because the server reports opencode
//                   available); provider agy (no-per-project-mcp); the
//                   refreshed fleetMcp is unavailable or flagged unverified
//                   (e.g. mcp-entry-missing: a provider that reads the
//                   per-folder MCP entry has none ending with ?member=<uuid>;
//                   role-agents-hide-member-tools: the role files a
//                   dispatched --agent <role> session loads filter the
//                   member tools out and could not be healed).
//   4. count     -- kb_stats AS the member: totals.by_confidence.CONFIRMED.
//   5. code      -- code_reindex AS the member, then code_status polled until
//                   the first tick or the bound (30 s by default) elapses.
//                   A code-intelligence "disabled" answer is `unavailable`,
//                   never ok; the bound elapsing is `timeout`, not fatal.
//   6. maintainer-- the kb_maintainer selection made at sprint setup is READ
//                   (never re-selected): which member maintains the probed
//                   member's repository.
//
// TRANSPORT RULE: every kb_* / code_* call goes through the injected
// memberCall (a member-scoped session). The orchestrator's callTool is used
// ONLY for member_detail; this module never calls a kb_* or code_* tool on it.
//
// Never throws, never blocks: probeAll() returns one record per member even
// when every step of every member fails.
// =============================================================================

import { resolveMemberTarget } from './member-target.mjs';
import { getSeCommands } from './se-os-commands.mjs';
import { resultText } from './mcp-result.mjs';

/** Log prefix of every init line. */
export const MEMBER_INIT_LOG_PREFIX = '[member-init]';

/** publishState namespace for the per-member init records (viewer). */
export const MEMBER_INIT_STATE_NAMESPACE = 'memberInit';

/** Upper bound on waiting for the first code-index tick. */
export const CODE_INDEX_FIRST_TICK_BOUND_MS = 30000;

/** Delay between code_status polls. */
export const CODE_STATUS_POLL_MS = 2000;

/** codeIndex states. */
export const CODE_INDEX_STATES = Object.freeze({
    OK: 'ok',
    UNAVAILABLE: 'unavailable',
    TIMEOUT: 'timeout',
    FAILED: 'failed',
});

/**
 * One-line fixes, keyed by machine-readable reason. Every non-verified record
 * (and every recorded step failure) carries one of these.
 */
export const MEMBER_INIT_FIXES = Object.freeze({
    'member-unresolved': 'register the member with the fleet (member_detail returned no id for it), then rerun the sprint',
    'member-offline': 'bring the member back online (member_detail reports it offline), then rerun the sprint',
    'server-status-failed': "'apra-fleet status' failed on the member, so its fleet install is missing or broken: run update_member with fleet_install \"auto\" for the member (or install apra-fleet on it by hand), then rerun the sprint",
    'server-status-unreadable': "'apra-fleet status' on the member reported neither running nor stopped: run it by hand on the member and read its output, or run update_member with fleet_install \"auto\" for the member",
    'server-start-failed': "start the member's fleet server by hand ('apra-fleet start' on the member) and read its log, then rerun the sprint",
    'member-tools-failed': "the member session could not list tools for a reason not recognized as an old install or a refused session (see the problem detail): read it, correct that cause on the member, then rerun the sprint",
    'member-fleet-too-old': "the member's apra-fleet predates member mode (it has no 'call' command): run update_member with fleet_install \"auto\" for the member to upgrade it to the orchestrator version, then rerun the sprint",
    'member-session-refused': "the member server refused the member session (HTTP 403, the member id is not registered with the server the member talks to): run update_member with fleet_install \"auto\" for the member so it registers itself, then rerun the sprint",
    'no-llm-provider': "the member has provider none but is assigned an LLM role in this sprint: set a real llm_provider on it with update_member, or take it out of the LLM roles of the role map, then rerun the sprint",
    'member-tools-missing': "the member session does not list kb_* and code_* tools: run update_member with fleet_install \"auto\" for the member to upgrade its fleet install, then rerun the sprint",
    'fleet-mcp-refresh-failed': 'member_detail refresh:true failed for the member, so its fleet MCP status is unknown: read the reported error, correct that cause, then re-probe with member_detail refresh:true',
    'mcp-entry-missing': 'run compose_permissions for the member so its per-folder fleet MCP entry ends with ?member=<uuid>, then re-probe with member_detail refresh:true',
    'role-agents-hide-member-tools': "the role agent files the member's CLI loads (--agent <role>) do not grant the kb_* and code_* tools and the automatic rewrite failed: run update_member for a remote member, or make the role files writable (or re-install apra-fleet on the orchestrator) for a local one, then re-probe with member_detail refresh:true",
    'no-per-tool-deny': 'opencode cannot deny individual tools, so this member is never verified; use a claude member for verified knowledge-bank access',
    'no-per-project-mcp': 'agy has no per-project MCP config, so this member is never verified; use a claude member for verified knowledge-bank access',
    'fleet-mcp-unavailable': "the member's fleetMcp status is unavailable for a cause the server did not name: read member_detail fleetMcp.detail, correct that cause, then re-probe with member_detail refresh:true",
    'confirmed-count-unreadable': 'kb_stats failed on the member session, so the knowledge-bank entry count is unknown: run kb_stats on the member and read its error',
    'code-intel-disabled': 'code intelligence is off for this member; enable the gitnexus provider to get a code index',
    'code-provider-not-supported': "the member's code-intelligence provider manages its own index; nothing to do unless gitnexus is wanted",
    'code-index-timeout': 'the first code-index tick did not arrive within the bound; check code_status on the member (the index keeps building)',
    'code-intel-npx-missing': "npx or node is not on the apra-fleet service PATH, so code intelligence is unavailable: reinstall the service so it records node/npx (re-run the fleet installer on the host), or add node and npx to the service PATH and restart the server, then rerun code_reindex",
    'code-index-failed': 'code_reindex failed on the member: read its analyze log (code_status logPath) and rerun code_reindex',
    'code-index-unrecognized': 'code_reindex returned an unrecognized answer: run update_member with fleet_install "auto" for the member so its fleet install is current',
});

/** One-line fix for a reason (falls back to the fleetMcp generic fix). */
export function fixFor(reason) {
    return MEMBER_INIT_FIXES[reason] || MEMBER_INIT_FIXES['fleet-mcp-unavailable'];
}

/**
 * @typedef {Object} MemberInitProblem
 * @property {string} step    resolve | server | tools | fleetMcp | provider | count | code
 * @property {string} reason  machine-readable reason (a MEMBER_INIT_FIXES key or a server fleetMcp reason)
 * @property {string} fix     one human-readable line
 * @property {string} [detail]
 */

/**
 * The per-member init record. STABLE OUTPUT CONTRACT: consumed by the
 * KNOWLEDGE BANK injection (only verified=true members count as verified) and
 * by the lower-quality-of-service visibility work (viewer, banner).
 *
 * @typedef {Object} MemberInitRecord
 * @property {string} member            member name
 * @property {string|null} memberId
 * @property {string|null} type         local | remote | relay
 * @property {string|null} provider     the member's LLM provider (claude, opencode, agy, ...)
 * @property {boolean} verified         true only when every verification check passed
 * @property {'up'|'started'|'skipped'|'failed'} server   step 1 outcome
 * @property {{state: string, reason: string|null}|null} fleetMcp  refreshed fleetMcp status
 * @property {boolean|null} kbTools     member session lists kb_* tools (null when not checked)
 * @property {boolean|null} codeTools   member session lists code_* tools (null when not checked)
 * @property {number|null} confirmedCount  CONFIRMED bible entries (null when unreadable)
 * @property {'ok'|'unavailable'|'timeout'|'failed'} codeIndex
 * @property {string|null} codeIndexReason  null when codeIndex is ok
 * @property {string|null} repo         normalized repository of the member's work folder
 * @property {string|null} maintainer   kb_maintainer of that repository (from the sprint-setup selection)
 * @property {string|null} reason       machine-readable; null when verified
 * @property {string|null} fix          one human-readable line; null when verified
 * @property {MemberInitProblem[]} problems  every recorded step failure, in step order
 * @property {string[]} steps           the steps actually run, in order
 */

/**
 * The members that run an LLM role in this sprint. A member named ONLY in the
 * backlog role list (roleMap.backlog) runs no LLM role: it only runs bd
 * commands, so probing it and counting it as unverified is a false alarm.
 * A member named in any other role list, or in no list at all, is kept.
 * Applicability comes from the role assignment, not from the provider name.
 *
 * @param {string[]} members
 * @param {Record<string,string[]>|null|undefined} roleMap
 * @returns {string[]}
 */
export function llmRoleMembersOf(members, roleMap) {
    const list = Array.isArray(members) ? members : [];
    if (!roleMap || typeof roleMap !== 'object') return list.slice();
    const backlog = new Set(Array.isArray(roleMap.backlog) ? roleMap.backlog : []);
    const otherRole = new Set();
    for (const [role, names] of Object.entries(roleMap)) {
        if (role === 'backlog' || !Array.isArray(names)) continue;
        for (const m of names) otherRole.add(m);
    }
    return list.filter((m) => !backlog.has(m) || otherRole.has(m));
}

function errText(err) {
    return err && err.message ? err.message : String(err);
}

/** Parse a tool result (MCP content text, a raw JSON string, or an object). */
export function parseToolJson(result) {
    if (result && typeof result === 'string') { try { return JSON.parse(result); } catch { return null; } }
    if (result && Array.isArray(result.content)) {
        const text = resultText(result);
        if (!text) return null;
        try { return JSON.parse(text); } catch { return null; }
    }
    return (result && typeof result === 'object') ? result : null;
}

/** Tool names out of a tools/list answer ({tools:[{name}]} or a bare array). */
export function toolNamesOf(list) {
    const tools = Array.isArray(list) ? list : (list && Array.isArray(list.tools) ? list.tools : []);
    return tools.map((t) => (typeof t === 'string' ? t : (t && t.name))).filter((n) => typeof n === 'string');
}

/** CONFIRMED count out of a kb_stats answer, or null. */
export function confirmedCountOf(stats) {
    const n = stats && stats.totals && stats.totals.by_confidence && stats.totals.by_confidence.CONFIRMED;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** True when a code tool answer or error names a missing npx/node on the server PATH. */
function isNpxMissingText(text) {
    return /(?:npx|node)[^.]{0,40} was not found on the apra-fleet server's PATH/i.test(String(text || ''));
}

function isDisabledError(err) {
    return /E-CODE-INTEL-DISABLED|code intelligence is (?:off|disabled)|\bdisabled\b/i.test(errText(err));
}

/**
 * Classify a code_reindex answer.
 * @returns {{ state: 'ok'|'unavailable'|'failed'|'pending', reason: string|null, detail?: string }}
 */
export function classifyReindex(res) {
    if (!res || typeof res !== 'object' || typeof res.outcome !== 'string') {
        return { state: 'failed', reason: 'code-index-unrecognized' };
    }
    if (/disabled/i.test(String(res.reason || '')) || res.disabled === true) return { state: 'unavailable', reason: 'code-intel-disabled' };
    switch (res.outcome) {
        case 'started':
        case 'up-to-date':
        case 'already-running':
            return { state: 'ok', reason: null };
        case 'starting':
            return { state: 'pending', reason: null };
        case 'not-started':
            if (res.reason === 'npx-not-found' || isNpxMissingText(res.detail)) return { state: 'unavailable', reason: 'code-intel-npx-missing', detail: res.detail };
            if (res.reason === 'provider-not-supported') return { state: 'unavailable', reason: 'code-provider-not-supported', detail: res.detail };
            return { state: 'failed', reason: 'code-index-failed', detail: [res.reason, res.detail].filter(Boolean).join(': ') };
        default:
            return { state: 'failed', reason: 'code-index-unrecognized' };
    }
}

/**
 * Classify a code_status answer polled after a 'starting' reindex.
 * @returns {{ state: 'ok'|'unavailable'|'failed'|'pending', reason: string|null, detail?: string }}
 */
export function classifyStatus(res) {
    if (!res || typeof res !== 'object') return { state: 'pending', reason: null };
    if (res.outcome === 'not-started' && res.reason === 'provider-not-supported') return { state: 'unavailable', reason: 'code-provider-not-supported' };
    const a = res.analyze && typeof res.analyze === 'object' ? res.analyze : null;
    if (a && a.phase === 'done' && a.result === 'failed') return { state: 'failed', reason: 'code-index-failed', detail: a.lastLine || 'analyze failed' };
    if (res.ready === true || res.lockHeld === true) return { state: 'ok', reason: null };
    if (a && (a.phase === 'done' || (typeof a.lineCount === 'number' && a.lineCount > 0) || a.lockHeld === true)) return { state: 'ok', reason: null };
    return { state: 'pending', reason: null };
}

/** Classify the `apra-fleet status` output: 'running' | 'stopped' | null. */
export function parseServerState(text) {
    const m = /State:\s*(running|stopped)/i.exec(String(text || ''));
    return m ? m[1].toLowerCase() : null;
}

/** The one init line logged per member. */
export function formatMemberInitLine(rec) {
    if (rec.verified) {
        const count = rec.confirmedCount === null ? 'unreadable' : String(rec.confirmedCount);
        const code = rec.codeIndex === CODE_INDEX_STATES.OK ? 'ok' : `${rec.codeIndex} (${rec.codeIndexReason}: ${fixFor(rec.codeIndexReason)})`;
        const maint = rec.maintainer ? `; kb_maintainer: '${rec.maintainer}'` : '';
        return `${MEMBER_INIT_LOG_PREFIX} OK member '${rec.member}': verified (kb_* and code_* tools on its member session); CONFIRMED entries: ${count}; code index: ${code}${maint}`;
    }
    return `${MEMBER_INIT_LOG_PREFIX} WARN member '${rec.member}': unverified -- reason: ${rec.reason}; fix: ${rec.fix}`;
}

/**
 * @param {{
 *   members: string[],
 *   callTool?: (name: string, args: object) => Promise<any>,   orchestrator session -- member_detail ONLY
 *   memberCall?: (member: object, tool: string, args: object) => Promise<any>,
 *   listTools?: (member: object) => Promise<any>,
 *   fleetApi?: { executeCommand: Function },                   remote server start-if-down
 *   resolveTarget?: Function,                                  defaults to resolveMemberTarget
 *   kbMaintainers?: { maintainerForMember?: Function, repoOf?: Function } | (() => object),
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   codeIndexBoundMs?: number,
 *   pollMs?: number,
 *   log?: Function,
 * }} opts
 * @returns {{ probeMember(name: string): Promise<MemberInitRecord>, probeAll(): Promise<MemberInitRecord[]> }}
 */
export function createMemberInitProbe(opts = {}) {
    const {
        members: allMembers = [],
        roleMap = null,
        callTool,
        memberCall,
        listTools,
        fleetApi,
        log = () => {},
        codeIndexBoundMs = CODE_INDEX_FIRST_TICK_BOUND_MS,
        pollMs = CODE_STATUS_POLL_MS,
    } = opts;
    const members = llmRoleMembersOf(allMembers, roleMap);
    const resolveTarget = opts.resolveTarget || resolveMemberTarget;
    const now = opts.now || (() => Date.now());
    const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const maintainers = () => (typeof opts.kbMaintainers === 'function' ? opts.kbMaintainers() : opts.kbMaintainers) || null;

    async function memberDetail(name, extra = {}) {
        if (typeof callTool !== 'function') throw new Error('no orchestrator session to read member_detail');
        const res = await callTool('member_detail', { member_name: name, format: 'json', ...extra });
        if (res && res.isError) throw new Error(resultText(res) || 'member_detail returned an error');
        const d = parseToolJson(res);
        return d && d.member && typeof d.member === 'object' ? { ...d.member, ...d } : d;
    }

    async function runCommand(record, script) {
        const target = await resolveTarget({ fleetApi, member: record.name, log });
        const command = getSeCommands(target).wrapForMember(script);
        const res = await fleetApi.executeCommand({ member_id: record.id, command });
        return { ok: !(res && res.isError), text: resultText(res) };
    }

    async function ensureServer(record, rec, problem) {
        if (String(record.type || '').toLowerCase() === 'local') {
            rec.server = 'skipped';
            return;
        }
        rec.steps.push('server');
        if (!fleetApi || typeof fleetApi.executeCommand !== 'function') {
            rec.server = 'failed';
            problem('server', 'server-status-failed', 'no member command channel');
            return;
        }
        try {
            const status = await runCommand(record, 'apra-fleet status');
            const state = status.ok ? parseServerState(status.text) : null;
            if (!status.ok) {
                rec.server = 'failed';
                problem('server', 'server-status-failed', status.text);
                return;
            }
            if (state === 'running') {
                rec.server = 'up';
                return;
            }
            if (state !== 'stopped') {
                rec.server = 'failed';
                problem('server', 'server-status-unreadable', status.text);
                return;
            }
            const started = await runCommand(record, 'apra-fleet start');
            if (!started.ok) {
                rec.server = 'failed';
                problem('server', 'server-start-failed', started.text);
                return;
            }
            rec.server = 'started';
        } catch (err) {
            rec.server = 'failed';
            problem('server', 'server-status-failed', errText(err));
        }
    }

    async function checkTools(record, rec, problem) {
        rec.steps.push('tools');
        try {
            if (typeof listTools !== 'function') throw new Error('no member session channel');
            const names = toolNamesOf(parseToolJson(await listTools(record)));
            rec.kbTools = names.some((n) => n.startsWith('kb_'));
            rec.codeTools = names.some((n) => n.startsWith('code_'));
            if (!rec.kbTools || !rec.codeTools) {
                const missing = [!rec.kbTools && 'kb_*', !rec.codeTools && 'code_*'].filter(Boolean).join(' and ');
                problem('tools', 'member-tools-missing', `member session tools/list lacks ${missing} (got ${names.length} tools)`);
            }
        } catch (err) {
            const text = errText(err);
            if (/unknown (?:option|command) '?call\b/i.test(text)) problem('tools', 'member-fleet-too-old', text);
            else if (/E-MEMBER-FORBIDDEN|HTTP 403|server refused member/i.test(text)) problem('tools', 'member-session-refused', text);
            else problem('tools', 'member-tools-failed', text);
        }
        // Record the member's fleetMcp status from a fresh server-side probe.
        rec.steps.push('fleetMcp');
        try {
            const d = await memberDetail(record.name, { refresh: true });
            const f = d && d.fleetMcp && typeof d.fleetMcp === 'object' ? d.fleetMcp : null;
            rec.fleetMcp = f ? { state: String(f.state || 'unavailable'), reason: f.reason ? String(f.reason) : null } : null;
            if (!f) {
                problem('fleetMcp', 'fleet-mcp-refresh-failed', 'member_detail refresh:true returned no fleetMcp status');
            } else if (f.state !== 'available' || f.unverified === true) {
                const reason = f.reason ? String(f.reason) : 'fleet-mcp-unavailable';
                // The server owns the remedy text for its own reasons: forward it.
                const serverFix = typeof d.fleetMcpFix === 'string' && d.fleetMcpFix.trim() ? d.fleetMcpFix.trim() : null;
                problem('fleetMcp', reason, f.detail ? String(f.detail) : undefined, serverFix);
            }
            // Name the version seen when the member's install predates member mode.
            const ver = f && f.version ? String(f.version).replace(/^v/, '') : null;
            const old = rec.problems.find((p) => p.reason === 'member-fleet-too-old');
            if (old && ver) old.fix = `${old.fix} (version seen on the member: ${ver})`;
        } catch (err) {
            problem('fleetMcp', 'fleet-mcp-refresh-failed', errText(err));
        }
    }

    async function readCount(record, rec, problem) {
        rec.steps.push('count');
        try {
            if (typeof memberCall !== 'function') throw new Error('no member session channel');
            rec.confirmedCount = confirmedCountOf(parseToolJson(await memberCall(record, 'kb_stats', {})));
            if (rec.confirmedCount === null) problem('count', 'confirmed-count-unreadable', 'kb_stats answer carried no totals.by_confidence.CONFIRMED');
        } catch (err) {
            problem('count', 'confirmed-count-unreadable', errText(err));
        }
    }

    async function indexCode(record, rec, problem) {
        rec.steps.push('code');
        const setCode = (state, reason, detail) => {
            rec.codeIndex = state;
            rec.codeIndexReason = reason;
            if (reason) problem('code', reason, detail);
        };
        const deadline = now() + codeIndexBoundMs;
        let verdict;
        try {
            if (typeof memberCall !== 'function') throw new Error('no member session channel');
            verdict = classifyReindex(parseToolJson(await memberCall(record, 'code_reindex', {})));
        } catch (err) {
            if (isDisabledError(err)) return setCode(CODE_INDEX_STATES.UNAVAILABLE, 'code-intel-disabled', errText(err));
            if (isNpxMissingText(errText(err))) return setCode(CODE_INDEX_STATES.UNAVAILABLE, 'code-intel-npx-missing', errText(err));
            return setCode(CODE_INDEX_STATES.FAILED, 'code-index-failed', errText(err));
        }
        while (verdict.state === 'pending') {
            if (now() >= deadline) return setCode(CODE_INDEX_STATES.TIMEOUT, 'code-index-timeout', `no first tick within ${Math.round(codeIndexBoundMs / 1000)}s`);
            await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
            if (now() >= deadline) return setCode(CODE_INDEX_STATES.TIMEOUT, 'code-index-timeout', `no first tick within ${Math.round(codeIndexBoundMs / 1000)}s`);
            try {
                verdict = classifyStatus(parseToolJson(await memberCall(record, 'code_status', {})));
            } catch (err) {
                if (isDisabledError(err)) return setCode(CODE_INDEX_STATES.UNAVAILABLE, 'code-intel-disabled', errText(err));
                if (isNpxMissingText(errText(err))) return setCode(CODE_INDEX_STATES.UNAVAILABLE, 'code-intel-npx-missing', errText(err));
                return setCode(CODE_INDEX_STATES.FAILED, 'code-index-failed', errText(err));
            }
        }
        if (verdict.state === 'ok') return setCode(CODE_INDEX_STATES.OK, null);
        if (verdict.state === 'unavailable') return setCode(CODE_INDEX_STATES.UNAVAILABLE, verdict.reason, verdict.detail);
        return setCode(CODE_INDEX_STATES.FAILED, verdict.reason || 'code-index-failed', verdict.detail);
    }

    function recordMaintainer(name, rec) {
        try {
            const sel = maintainers();
            if (!sel) return;
            if (typeof sel.repoOf === 'function') rec.repo = sel.repoOf(name) || null;
            const m = typeof sel.maintainerForMember === 'function' ? sel.maintainerForMember(name) : null;
            rec.maintainer = m && m.member ? m.member : null;
        } catch { /* informational only */ }
    }

    /** Provider overrides: never verified regardless of what the session lists. */
    function providerOverride(provider) {
        const p = String(provider || '').toLowerCase();
        if (p === 'opencode') return 'no-per-tool-deny';
        if (p === 'agy') return 'no-per-project-mcp';
        if (p === 'none') return 'no-llm-provider';
        return null;
    }

    async function probeMember(name) {
        /** @type {MemberInitRecord} */
        const rec = {
            member: name, memberId: null, type: null, provider: null,
            verified: false, server: 'skipped', fleetMcp: null,
            kbTools: null, codeTools: null, confirmedCount: null,
            codeIndex: CODE_INDEX_STATES.FAILED, codeIndexReason: null,
            repo: null, maintainer: null,
            reason: null, fix: null, problems: [], steps: [],
        };
        const problem = (step, reason, detail, fix) => {
            rec.problems.push({ step, reason, fix: fix || fixFor(reason), ...(detail ? { detail: String(detail).slice(0, 300) } : {}) });
        };
        try {
            recordMaintainer(name, rec);
            rec.steps.push('resolve');
            let d = null;
            try {
                d = await memberDetail(name);
            } catch (err) {
                problem('resolve', 'member-unresolved', errText(err));
            }
            const id = d && typeof d.id === 'string' && d.id.length > 0 ? d.id : null;
            if (!id) {
                if (rec.problems.length === 0) problem('resolve', 'member-unresolved');
                rec.codeIndexReason = 'member-unresolved';
                return finish(rec);
            }
            rec.memberId = id;
            rec.type = typeof d.type === 'string' ? d.type : null;
            rec.provider = typeof d.llmProvider === 'string' ? d.llmProvider : null;
            const override = providerOverride(rec.provider);
            if (override) problem('provider', override, `provider ${rec.provider}`);
            if (d.offline === true) {
                problem('resolve', 'member-offline', d.connectivity && d.connectivity.error);
                rec.codeIndexReason = 'member-offline';
                return finish(rec);
            }
            const record = { id, name, type: rec.type || undefined };
            await ensureServer(record, rec, problem);
            await checkTools(record, rec, problem);
            await readCount(record, rec, problem);
            await indexCode(record, rec, problem);
        } catch (err) {
            problem('probe', 'member-tools-failed', `probe threw: ${errText(err)}`);
        }
        return finish(rec);
    }

    const GENERIC_FLEET_MCP_REASONS = new Set(['fleet-mcp-refresh-failed', 'fleet-mcp-unavailable']);

    /** Steps whose failure makes a member unverified (count/code are reported, not gating). */
    const GATING_STEPS = new Set(['resolve', 'provider', 'server', 'tools', 'fleetMcp', 'probe']);

    function finish(rec) {
        const gating = rec.problems.filter((p) => GATING_STEPS.has(p.step));
        // A provider override is permanent, so it is the reason a human sees first.
        // A cause the server named for the fleetMcp refresh supersedes the
        // generic member-session tools failures, which are only symptoms of it.
        const serverCause = gating.find((p) => p.step === 'fleetMcp' && !GENERIC_FLEET_MCP_REASONS.has(p.reason));
        const symptom = (p) => p.step === 'tools' && p.reason !== 'member-session-refused';
        const primary = gating.find((p) => p.step === 'provider')
            || (serverCause && gating[0] && symptom(gating[0]) ? serverCause : null)
            || gating[0] || null;
        rec.verified = !primary && rec.kbTools === true && rec.codeTools === true
            && !!rec.fleetMcp && rec.fleetMcp.state === 'available';
        if (rec.verified) {
            rec.reason = null;
            rec.fix = null;
        } else {
            const p = primary || { reason: 'member-tools-failed', fix: fixFor('member-tools-failed') };
            rec.reason = p.reason;
            rec.fix = p.fix;
        }
        return rec;
    }

    return {
        probeMember,
        async probeAll() {
            const out = [];
            for (const name of members) {
                let rec;
                try {
                    rec = await probeMember(name);
                } catch (err) {
                    // probeMember never throws; belt and braces for the never-block contract.
                    rec = finish({
                        member: name, memberId: null, type: null, provider: null, verified: false, server: 'skipped',
                        fleetMcp: null, kbTools: null, codeTools: null, confirmedCount: null,
                        codeIndex: CODE_INDEX_STATES.FAILED, codeIndexReason: 'member-tools-failed', repo: null, maintainer: null,
                        reason: null, fix: null, steps: [],
                        problems: [{ step: 'probe', reason: 'member-tools-failed', fix: fixFor('member-tools-failed'), detail: errText(err) }],
                    });
                }
                out.push(rec);
                try { log(formatMemberInitLine(rec)); } catch { /* logging never blocks */ }
            }
            return out;
        },
    };
}

/**
 * The per-member verified lookup the sprint context exposes
 * (context.isMemberVerified): true only for a member whose init record says
 * verified. A member with no init record is unverified. `getRecords` is read
 * on every call so a later refresh of the records is seen.
 *
 * @param {() => Array<{member: string, verified: boolean}>} getRecords
 * @returns {(memberName: string) => boolean}
 */
export function createMemberVerifiedLookup(getRecords) {
    return (memberName) => {
        const records = typeof getRecords === 'function' ? getRecords() : [];
        return Array.isArray(records) && records.some((r) => r && r.member === memberName && r.verified === true);
    };
}
