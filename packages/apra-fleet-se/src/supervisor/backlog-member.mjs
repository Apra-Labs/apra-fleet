// =============================================================================
// Auto-sprint supervisor -- its OWN backlog member
// =============================================================================
//
// A supervisor runs against exactly one beads tracker (its --beads-dir, or
// the .beads discovered from its cwd). Every sprint it launches plans and
// mutates beads through the fleet-sprint "backlog" role, so the supervisor
// owns one fleet member for that role: a LOCAL member whose work folder is
// the project folder X holding the .beads, with NO LLM (llm_provider none --
// it only ever runs bd/git via execute_command) and flagged unreservable (so
// every concurrent sprint can share it; overlap guards skip it).
//
// ensureBacklogMember() makes that true at startup:
//   * a local member at X already exists, LLM-less  -> adopted (name kept;
//     the backlog tag and unreservable flag are added via update_member when
//     missing -- tags are sent as existing + backlog because update_member
//     REPLACES the whole tag list);
//   * a local member at X has an LLM               -> REFUSED: an LLM member
//     cannot be converted (update_member has no llm_provider none), and its
//     agent would be editing the very clone the backlog role mutates; the
//     operator must point the supervisor at a separate clone;
//   * no member at X                               -> exactly one
//     register_member (backlog-<camelCaseFolderName>);
//   * the fleet member list cannot be read         -> DEGRADED: the
//     supervisor still starts and serves read-only views, launches answer
//     503 with the reason, and a background retry flips the state to ready
//     once the fleet answers.
//
// Every collaborator (listMembers/registerMember/updateMember, platform,
// scheduler) is injected so the whole decision table is unit-testable with
// fakes -- including the Windows path-comparison branch on a POSIX host.
// =============================================================================

import path from 'node:path';

import { fleetMembersUnavailableReason } from './fleet-members.mjs';
import { normalizeMsysPathForPlatform } from './dolt-orphan-sweep.mjs';

export const BACKLOG_MEMBER_TAG = 'backlog';
export const BACKLOG_MEMBER_NAME_PREFIX = 'backlog-';
export const DEFAULT_BACKLOG_RETRY_MS = 30_000;

export const BACKLOG_STATUS = Object.freeze({ READY: 'ready', DEGRADED: 'degraded' });

/** A condition the supervisor must refuse to start under (exit 1). */
export class BacklogMemberRefusedError extends Error {
    /**
     * @param {string} message
     * @param {{ code: string, member?: string }} [details]
     */
    constructor(message, details = {}) {
        super(message);
        this.name = 'BacklogMemberRefusedError';
        this.code = details.code ?? 'BACKLOG_MEMBER_REFUSED';
        if (details.member) this.member = details.member;
    }
}

/**
 * backlog- + the folder basename reduced to ASCII alphanumerics in camelCase:
 * split on every run of non-[A-Za-z0-9] characters (punctuation, spaces and
 * non-ASCII letters alike), first word lowercased, each following word
 * capitalized. Throws BacklogMemberRefusedError when nothing survives.
 * @param {string} folderName
 * @returns {string}
 */
export function sanitizeBacklogMemberName(folderName) {
    const words = String(folderName ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (words.length === 0) {
        throw new BacklogMemberRefusedError(
            `cannot derive a backlog member name from folder name '${folderName}': it has no ASCII letters or digits. ` +
            'Rename the project folder (or point --beads-dir at a clone whose folder name has ASCII letters or digits).',
            { code: 'BACKLOG_MEMBER_NAME_EMPTY' },
        );
    }
    const camel = words.map((w, i) => (i === 0
        ? w.toLowerCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join('');
    return `${BACKLOG_MEMBER_NAME_PREFIX}${camel}`;
}

function pathApiFor(platform) {
    return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * The native, absolute form of a project folder for `platform`: MSYS
 * /c/... converted on win32, resolved, trailing separators dropped, and a
 * trailing .beads segment stripped (--beads-dir may name the .beads dir).
 * @param {string} folder
 * @param {string} platform
 * @returns {string}
 */
export function normalizeProjectFolder(folder, platform = process.platform) {
    const p = pathApiFor(platform);
    let out = p.resolve(normalizeMsysPathForPlatform(String(folder), platform));
    const root = p.parse(out).root;
    while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1);
    if (p.basename(out) === '.beads') out = p.dirname(out);
    return out;
}

/**
 * Whether two folders name the same project folder on `platform` (win32
 * compares case-insensitively; every other platform exactly).
 */
export function sameProjectFolder(a, b, platform = process.platform) {
    if (!a || !b) return false;
    const na = normalizeProjectFolder(a, platform);
    const nb = normalizeProjectFolder(b, platform);
    return platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function memberList(raw) {
    return Array.isArray(raw) ? raw : (raw && Array.isArray(raw.members) ? raw.members : []);
}

function hasLlm(member) {
    // list_members reports llmProvider defaulting to 'claude'; only an
    // explicit 'none' is an LLM-less command executor.
    return (member.llmProvider ?? 'claude') !== 'none';
}

const defaultScheduler = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
};

/**
 * One ensure pass. Resolves { status: 'ready', member } or { status:
 * 'degraded', reason, retry } (retry false when only a restart can fix it);
 * throws BacklogMemberRefusedError for a refuse-to-start condition.
 */
async function ensureOnce({ folder, listMembers, registerMember, updateMember, platform, log }) {
    if (!folder) {
        return {
            status: BACKLOG_STATUS.DEGRADED,
            retry: false,
            reason: 'no beads database was found, so this supervisor has no backlog member and cannot launch sprints. ' +
                'Restart it with --beads-dir <project-or-.beads-path> (or from inside the project folder).',
        };
    }
    const work = normalizeProjectFolder(folder, platform);

    let raw;
    try {
        raw = await listMembers();
    } catch (err) {
        return { status: BACKLOG_STATUS.DEGRADED, retry: true, reason: `fleet member list unavailable: ${err && err.message ? err.message : err}` };
    }
    const unavailable = fleetMembersUnavailableReason(raw);
    if (unavailable) {
        return { status: BACKLOG_STATUS.DEGRADED, retry: true, reason: `fleet member list unavailable: ${unavailable}` };
    }
    const members = memberList(raw).filter((m) => m && typeof m === 'object' && typeof m.name === 'string');

    const atFolder = members.filter((m) => (m.type ?? 'local') === 'local' && sameProjectFolder(m.folder, work, platform));
    const llmAtFolder = atFolder.find(hasLlm);
    if (llmAtFolder) {
        throw new BacklogMemberRefusedError(
            `member '${llmAtFolder.name}' is an LLM member (llm provider '${llmAtFolder.llmProvider ?? 'claude'}') whose work folder is ` +
            `this supervisor's project folder '${work}'. The supervisor's backlog member must be LLM-less and own that folder, ` +
            'and an LLM member cannot be converted. Use a separate clone: start the supervisor with --beads-dir pointing at a ' +
            `different clone of the project, or move '${llmAtFolder.name}' to its own clone.`,
            { code: 'BACKLOG_MEMBER_WRONG_KIND', member: llmAtFolder.name },
        );
    }

    if (atFolder.length > 0) {
        const member = atFolder.find((m) => Array.isArray(m.tags) && m.tags.includes(BACKLOG_MEMBER_TAG)) ?? atFolder[0];
        const tags = Array.isArray(member.tags) ? member.tags : [];
        const update = {};
        if (!tags.includes(BACKLOG_MEMBER_TAG)) update.tags = [...tags, BACKLOG_MEMBER_TAG];
        if (member.unreservable !== true) update.unreservable = true;
        if (Object.keys(update).length === 0) {
            log(`[backlog-member] adopted existing member '${member.name}' at '${work}'.`);
            return { status: BACKLOG_STATUS.READY, member: { ...member } };
        }
        const res = await updateMember({ member_name: member.name, ...update });
        if (!res || !res.ok) {
            const why = res && res.error ? res.error : 'update_member failed';
            if (res && res.unavailable) {
                return { status: BACKLOG_STATUS.DEGRADED, retry: true, reason: `fleet unavailable while fixing backlog member '${member.name}': ${why}` };
            }
            throw new BacklogMemberRefusedError(
                `could not mark existing member '${member.name}' at '${work}' as this supervisor's backlog member: ${why}`,
                { code: 'BACKLOG_MEMBER_UPDATE_FAILED', member: member.name },
            );
        }
        log(`[backlog-member] adopted existing member '${member.name}' at '${work}' (set: ${Object.keys(update).join(', ')}).`);
        return {
            status: BACKLOG_STATUS.READY,
            member: { ...member, tags: update.tags ?? tags, unreservable: true },
        };
    }

    const name = sanitizeBacklogMemberName(pathApiFor(platform).basename(work));
    const clash = members.find((m) => m.name === name);
    if (clash) {
        throw new BacklogMemberRefusedError(
            `cannot register backlog member '${name}' for '${work}': a member with that name already exists ` +
            `for a different folder ('${clash.folder ?? 'unknown'}'). Rename or remove that member, or rename this project folder.`,
            { code: 'BACKLOG_MEMBER_NAME_TAKEN', member: name },
        );
    }
    const options = {
        friendly_name: name,
        member_type: 'local',
        work_folder: work,
        llm_provider: 'none',
        unreservable: true,
        tags: [BACKLOG_MEMBER_TAG],
    };
    const res = await registerMember(options);
    if (!res || !res.ok) {
        const why = res && res.error ? res.error : 'register_member failed';
        if (res && res.unavailable) {
            return { status: BACKLOG_STATUS.DEGRADED, retry: true, reason: `fleet unavailable while registering backlog member '${name}': ${why}` };
        }
        throw new BacklogMemberRefusedError(
            `could not register backlog member '${name}' for '${work}': ${why}`,
            { code: 'BACKLOG_MEMBER_REGISTER_FAILED', member: name },
        );
    }
    log(`[backlog-member] registered backlog member '${name}' at '${work}'.`);
    return {
        status: BACKLOG_STATUS.READY,
        member: { name, type: 'local', folder: work, llmProvider: 'none', unreservable: true, tags: [BACKLOG_MEMBER_TAG] },
    };
}

/**
 * Ensure the supervisor's backlog member for project folder `beadsDir`.
 *
 * Resolves a state handle once the FIRST attempt settles:
 *   get()      -> { member, status: 'ready'|'degraded', reason }
 *   retryNow() -> runs one more attempt now (also what the timer calls)
 *   stop()     -> cancels any pending background retry
 * Rejects with BacklogMemberRefusedError when the first attempt hits a
 * refuse-to-start condition. A refusal found by a LATER background retry
 * cannot stop an already-running process: the state stays degraded with
 * that refusal as its reason and retrying stops.
 *
 * @param {{
 *   beadsDir: string|null,
 *   listMembers: () => Promise<object>,
 *   registerMember: (options: object) => Promise<{ ok: boolean, error?: string, unavailable?: boolean }>,
 *   updateMember: (options: object) => Promise<{ ok: boolean, error?: string, unavailable?: boolean }>,
 *   platform?: string,
 *   logger?: { log?: Function, warn?: Function, error?: Function },
 *   scheduler?: { setTimeout: Function, clearTimeout: Function },
 *   retryIntervalMs?: number,
 * }} deps
 */
export async function ensureBacklogMember(deps = {}) {
    const { beadsDir = null, listMembers, registerMember, updateMember } = deps;
    for (const [k, v] of Object.entries({ listMembers, registerMember, updateMember })) {
        if (typeof v !== 'function') throw new TypeError(`ensureBacklogMember requires a ${k}() collaborator`);
    }
    const platform = deps.platform ?? process.platform;
    const logger = deps.logger ?? console;
    const log = (...a) => (logger.log ?? (() => {}))(...a);
    const warn = (...a) => (logger.warn ?? logger.log ?? (() => {}))(...a);
    const logError = (...a) => (logger.error ?? logger.log ?? (() => {}))(...a);
    const scheduler = deps.scheduler ?? defaultScheduler;
    const retryIntervalMs = Number.isFinite(deps.retryIntervalMs) && deps.retryIntervalMs > 0
        ? deps.retryIntervalMs : DEFAULT_BACKLOG_RETRY_MS;

    let state = { member: null, status: BACKLOG_STATUS.DEGRADED, reason: 'backlog member not yet ensured' };
    let timer = null;
    let stopped = false;
    let inFlight = null;

    const attemptArgs = { folder: beadsDir, listMembers, registerMember, updateMember, platform, log };

    function schedule() {
        if (stopped || timer) return;
        timer = scheduler.setTimeout(() => {
            timer = null;
            return attempt({ fromRetry: true });
        }, retryIntervalMs);
        if (timer && typeof timer.unref === 'function') timer.unref();
    }

    async function attempt({ fromRetry }) {
        if (inFlight) return inFlight;
        if (timer) {
            scheduler.clearTimeout(timer);
            timer = null;
        }
        inFlight = (async () => {
            try {
                const out = await ensureOnce(attemptArgs);
                if (out.status === BACKLOG_STATUS.READY) {
                    const wasDegraded = state.status !== BACKLOG_STATUS.READY;
                    state = { member: out.member, status: BACKLOG_STATUS.READY, reason: null };
                    if (fromRetry && wasDegraded) log(`[backlog-member] backlog member '${out.member.name}' is ready; sprint launches are enabled.`);
                } else {
                    state = { member: null, status: BACKLOG_STATUS.DEGRADED, reason: out.reason };
                    warn(`[backlog-member] WARNING: degraded -- ${out.reason}${out.retry && !stopped ? ` Retrying every ${Math.round(retryIntervalMs / 1000)}s.` : ''}`);
                    if (out.retry) schedule();
                }
            } catch (err) {
                if (!fromRetry) throw err;
                const reason = err && err.message ? err.message : String(err);
                state = { member: null, status: BACKLOG_STATUS.DEGRADED, reason };
                logError(`[backlog-member] ERROR: ${reason} Sprint launches stay disabled until the supervisor is restarted.`);
            }
            return { ...state };
        })();
        try {
            return await inFlight;
        } finally {
            inFlight = null;
        }
    }

    await attempt({ fromRetry: false });

    return {
        get: () => ({ ...state }),
        retryNow: () => attempt({ fromRetry: true }),
        stop() {
            stopped = true;
            if (timer) {
                scheduler.clearTimeout(timer);
                timer = null;
            }
        },
    };
}
