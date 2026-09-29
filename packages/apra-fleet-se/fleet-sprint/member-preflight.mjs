// =============================================================================
// SPRINT SETUP PER-MEMBER PREFLIGHT -- knowledge and code intelligence.
//
// At Sprint Setup, for EVERY participating member (local members included),
// three checks run and every outcome lands in one structured per-member record:
//
//   (a) index  -- START the code indexer over that member's OWN checkout,
//                 DETACHED, and record only whether the LAUNCH was issued.
//                 This check NEVER awaits indexing and never claims the index
//                 is current: indexing takes minutes and Sprint Setup must not
//                 block. The only two outcomes it can produce are
//                 'analyze-started' and 'analyze-not-started'.
//   (b) kb     -- prime that member's own project knowledge scope and obtain an
//                 ENTRY COUNT, which is PRINTED (not merely computed). Goes
//                 through the engine's existing per-member priming path
//                 (kb.mjs's createKbPrimingClient), which already resolves each
//                 member's work folder and repo origin URL via member_detail;
//                 this module only reads the per-member results back.
//   (c) code   -- ONE trivial code tool probe over the same seam, scoped to the
//                 same member repo. It asserts ONLY that the tool ANSWERS. It
//                 is deliberately INDEPENDENT of whether the index has any
//                 content: check (a) has only just started the indexer, so an
//                 absent or empty index is the NORMAL state here and is
//                 recorded as its own INFORMATIONAL outcome ('index-not-ready'),
//                 never as a warning and never as a failure.
//
// WARN, DO NOT BLOCK. A missing or broken kb/code tool must NOT fail the
// sprint. Every failure raises a VISIBLE warning naming (i) the member,
// (ii) the check, (iii) the cause and (iv) a user-actionable remediation, and
// the sprint continues. There is no blocking gate here, deliberately: the
// owner decision is warn-and-continue. The other half of that decision matters
// just as much -- a warning nobody sees is a false success -- which is why
// every warning is logged AND carried in the structured record the panel and
// the acceptance lane read back.
//
// NO MIRROR, NO TUNNEL, NO CREDENTIAL. Every member has its own fleet install
// serving its own knowledge scope plus a local code index over its own
// checkout. This module opens no new transport. It uses exactly two seams that
// already exist: the member exec seam (`command(cmd, { member_name })`, the
// same seam member-provisioning.mjs stages files over) for (a), and the
// engine's injected `callTool` for (b)/(c).
//
// THE UNSCOPED MEMBER IS NOT RE-PROBED. The member-config lane's resolver
// returns either a stdio launch descriptor for the member's own fleet install
// or a named, structured reason why that member has none, and
// compose_permissions persists that record. A member can therefore legitimately
// arrive at Sprint Setup already carrying a named 'unscoped' reason. This
// module carries that reason and its remediation VERBATIM into a warning rather
// than re-probing for the install or reporting a generic "tool unavailable" --
// 'unscoped', 'tool-unavailable' and 'kb-empty' are THREE distinct outcomes and
// none of them is ever reported as a clean pass. A scope that RESOLVES but
// holds zero entries is the exact silent failure this lane exists to remove.
//
// GENERIC ENGINE BOUNDARY: fleet-sprint drives a sprint against ANY target
// repo. No target-specific build command, env var, port, path layout or tracker
// id may appear in any string here. Every warning is produced by rendering one
// of the templates in PREFLIGHT_WARNING_TEMPLATES below with member-supplied
// values only, so a target-specific token baked into a template is a mechanical
// test failure rather than a judgement call.
//
// NO SHELL EXPANSION IN MEMBER-BOUND COMMANDS: the member's shell may be
// PowerShell or cmd.exe, not POSIX sh. The single member-bound command string
// this module builds (the detached index launch) contains no variable
// expansion, no leading tilde path, no backtick and no `$( )`: it is a
// `node -e` one-liner whose only argument is a base64 token, exactly the
// shell-agnostic recipe stageCommandBodyMemberSide already uses.
// =============================================================================

import { resultText, toolErrorText, isToolError } from './mcp-result.mjs';

/** The three checks, in the order they are recorded. */
export const PREFLIGHT_CHECK_INDEX = 'index';
export const PREFLIGHT_CHECK_KB = 'kb';
export const PREFLIGHT_CHECK_CODE = 'code';
export const PREFLIGHT_CHECKS = Object.freeze([
    PREFLIGHT_CHECK_INDEX,
    PREFLIGHT_CHECK_KB,
    PREFLIGHT_CHECK_CODE,
]);

/**
 * The CLOSED set of per-check outcome kinds. Every check records exactly one.
 * Adding a kind is a contract change: the panel lane renders these and the
 * acceptance lane asserts on them.
 *
 *   ok                  -- the check succeeded.
 *   analyze-started     -- (a) only. The indexer LAUNCH was issued. NOT a claim
 *                          that indexing finished or that the index is current.
 *   analyze-not-started -- (a) only. The launch could not be issued. WARNING.
 *   tool-unavailable    -- the kb or code tool did not answer at all. WARNING.
 *   kb-empty            -- (b) only. The scope RESOLVED and reported zero
 *                          entries. WARNING, distinct from tool-unavailable.
 *   unscoped            -- an upstream, named structured reason is already
 *                          attached to this member. WARNING, carrying that
 *                          reason and remediation verbatim. Never re-probed.
 *   index-not-ready     -- (c) only. The code tool ANSWERED but the index is
 *                          absent or empty. INFORMATIONAL: never a warning and
 *                          never a failure -- this is the normal state
 *                          immediately after (a).
 */
export const OUTCOME_OK = 'ok';
export const OUTCOME_ANALYZE_STARTED = 'analyze-started';
export const OUTCOME_ANALYZE_NOT_STARTED = 'analyze-not-started';
export const OUTCOME_TOOL_UNAVAILABLE = 'tool-unavailable';
export const OUTCOME_KB_EMPTY = 'kb-empty';
export const OUTCOME_UNSCOPED = 'unscoped';
export const OUTCOME_INDEX_NOT_READY = 'index-not-ready';

export const PREFLIGHT_OUTCOMES = Object.freeze([
    OUTCOME_OK,
    OUTCOME_ANALYZE_STARTED,
    OUTCOME_ANALYZE_NOT_STARTED,
    OUTCOME_TOOL_UNAVAILABLE,
    OUTCOME_KB_EMPTY,
    OUTCOME_UNSCOPED,
    OUTCOME_INDEX_NOT_READY,
]);

/** Outcomes that RAISE a visible warning. Everything else is silent or info. */
export const PREFLIGHT_WARNING_OUTCOMES = Object.freeze([
    OUTCOME_ANALYZE_NOT_STARTED,
    OUTCOME_TOOL_UNAVAILABLE,
    OUTCOME_KB_EMPTY,
    OUTCOME_UNSCOPED,
]);

/** Outcomes that are INFORMATIONAL only -- never a warning, never a failure. */
export const PREFLIGHT_INFORMATIONAL_OUTCOMES = Object.freeze([OUTCOME_INDEX_NOT_READY]);

/** publishState namespace the panel lane subscribes to. */
export const PREFLIGHT_STATE_NAMESPACE = 'member-preflight';

/** Log prefix every line this module emits carries, so it is greppable. */
export const PREFLIGHT_LOG_PREFIX = '[preflight]';

/**
 * The ONE warning-string template set. Every warning this module emits at
 * runtime is `PREFLIGHT_WARNING_TEMPLATES[outcome](values)` -- there is no
 * second, ad hoc string-building path, which is what makes "does any warning
 * carry a target-specific token?" a mechanical check instead of a review
 * opinion. Each template interpolates only the four member-supplied values the
 * warning contract requires: member, check, cause, remediation.
 */
export const PREFLIGHT_WARNING_TEMPLATES = Object.freeze({
    [OUTCOME_ANALYZE_NOT_STARTED]: ({ member, check, cause, remediation }) =>
        `${PREFLIGHT_LOG_PREFIX} WARNING member '${member}' check '${check}': the code index could not be started. `
        + `Cause: ${cause}. Fix: ${remediation}`,
    [OUTCOME_TOOL_UNAVAILABLE]: ({ member, check, cause, remediation }) =>
        `${PREFLIGHT_LOG_PREFIX} WARNING member '${member}' check '${check}': the tool did not answer. `
        + `Cause: ${cause}. Fix: ${remediation}`,
    [OUTCOME_KB_EMPTY]: ({ member, check, cause, remediation }) =>
        `${PREFLIGHT_LOG_PREFIX} WARNING member '${member}' check '${check}': the knowledge scope resolved but holds zero entries. `
        + `Cause: ${cause}. Fix: ${remediation}`,
    [OUTCOME_UNSCOPED]: ({ member, check, cause, remediation }) =>
        `${PREFLIGHT_LOG_PREFIX} WARNING member '${member}' check '${check}': this member has no usable tool scope of its own. `
        + `Cause: ${cause}. Fix: ${remediation}`,
});

/**
 * Renders the warning for `outcome`. Throws for an outcome that is not a
 * warning kind -- a caller that reaches here with 'ok' or 'index-not-ready'
 * has confused an informational outcome with a failure, which is exactly the
 * conflation this lane exists to prevent.
 * @param {string} outcome
 * @param {{ member: string, check: string, cause: string, remediation: string }} values
 * @returns {string}
 */
export function renderPreflightWarning(outcome, values) {
    const template = PREFLIGHT_WARNING_TEMPLATES[outcome];
    if (typeof template !== 'function') {
        throw new Error(`[member-preflight] '${outcome}' is not a warning outcome; warning kinds are: ${PREFLIGHT_WARNING_OUTCOMES.join(', ')}`);
    }
    return template(values);
}

/**
 * Generic remediations. Kept together so the generic-engine boundary is
 * reviewable in one place: none of these may name a target repo's build
 * command, env var, port, path layout or tracker id.
 */
const REMEDIATION = Object.freeze({
    indexLaunch: 'make the code indexer runnable on this member (its launcher must be on PATH there), then re-run sprint setup',
    noWorkFolder: 'register a work folder for this member so its repo scope can be resolved, then re-run sprint setup',
    noTransport: 'wire a fleet MCP client into this run so the knowledge and code tools can be reached',
    kbTool: 'make sure this member\'s knowledge scope can be primed (check the fleet MCP server is reachable and the repo scope resolves), then re-run sprint setup',
    kbEmpty: 'capture or import knowledge for this member\'s repo so its scope is not empty; until then roles start cold',
    codeTool: 'make sure the code intelligence tool is configured and reachable for this member\'s repo, then re-run sprint setup',
});

/**
 * The trivial probe query for check (c). Its ANSWER is what is asserted, never
 * its content, so the text only has to be well-formed and target-neutral.
 */
export const PREFLIGHT_CODE_PROBE_QUERY = 'preflight probe';

/**
 * argv of the detached code-index launch. Passed as an argv ARRAY (never a
 * shell string) so nothing is re-parsed by the member's shell.
 */
export const INDEX_LAUNCH_ARGV = Object.freeze(['npx', 'gitnexus', 'analyze']);

/**
 * Sentinel the launch one-liner prints, so a caller (and a test harness that
 * must not really spawn an indexer) can recognise this exact command. Lower
 * case and product-neutral on purpose.
 */
export const INDEX_LAUNCH_SENTINEL = 'code-index-launch';

/**
 * The member-side one-liner. It SPAWNS DETACHED and EXITS IMMEDIATELY -- it
 * never waits for the indexer, which is the whole point of check (a).
 *
 * Shell-agnostic by construction: no `$`-expansion, no backtick, no `$( )`, no
 * leading tilde, no template literal and no `%VAR%`. The only argument is a
 * base64 token whose alphabet is inert in POSIX sh, PowerShell and cmd.exe
 * alike, decoded back to the exact argv by node. `shell` is set only on
 * win32, where a launcher is typically a `.cmd` shim that cannot be exec'd
 * directly.
 */
const INDEX_LAUNCH_SCRIPT =
    "const cp=require('child_process');"
    + "const a=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));"
    + "let p='none';"
    + "try{const c=cp.spawn(a[0],a.slice(1),{detached:true,stdio:'ignore',shell:process.platform==='win32'});"
    + "c.on('error',function(){});c.unref();p=String(c.pid||'none');}"
    + "catch(e){p='none';}"
    + "process.stdout.write('code-index-launch:'+p)";

/**
 * Builds the member-bound detached index-launch command.
 * @param {readonly string[]} [argv]
 * @returns {string}
 */
export function buildIndexLaunchCommand(argv = INDEX_LAUNCH_ARGV) {
    const b64 = Buffer.from(JSON.stringify([...argv]), 'utf-8').toString('base64');
    return `node -e "${INDEX_LAUNCH_SCRIPT}" "${b64}"`;
}

/**
 * How long runAll() will wait, ONCE and at the very END, for an already-issued
 * launch dispatch to report back. It is not a wait ON THE INDEXER: the launch
 * command exits as soon as it has spawned the detached child, and every launch
 * is issued BEFORE the kb/code checks run, so in practice this window is
 * already elapsed by the time it is applied. It exists solely so a member whose
 * exec seam hangs cannot hold Sprint Setup open -- an unsettled dispatch is
 * recorded as started (the dispatch was issued; nothing more is claimed).
 */
export const DEFAULT_LAUNCH_SETTLE_MS = 2000;

/** Best-effort JSON out of an MCP result, mirroring kb.mjs's own parser. */
function parseToolJson(result) {
    if (typeof result === 'string') {
        try { return JSON.parse(result); } catch { return null; }
    }
    const text = resultText(result);
    if (text) {
        try { return JSON.parse(text); } catch { /* not JSON -- fall through */ }
    }
    return (result && typeof result === 'object' && !Array.isArray(result.content)) ? result : null;
}

/**
 * True when a WELL-FORMED code-tool answer says "there is nothing indexed
 * here". This is NOT a failure: check (a) has only just started the indexer,
 * so on a first sprint over a fresh checkout it is the expected answer.
 */
function looksLikeEmptyIndex(parsed, text) {
    if (parsed && typeof parsed === 'object') {
        if (parsed.indexed === false) return true;
        if (typeof parsed.total === 'number' && parsed.total === 0) return true;
        const buckets = ['results', 'matches', 'symbols', 'processes', 'flows'];
        const present = buckets.filter((k) => Array.isArray(parsed[k]));
        if (present.length > 0 && present.every((k) => parsed[k].length === 0)) return true;
    }
    return /\b(?:not indexed|no index\b|index (?:is )?(?:empty|missing|not found)|no results|0 results)\b/i.test(text || '');
}

/**
 * Races `promise` against a `ms` timer, resolving to `pendingValue` when the
 * timer wins. The timer is ALWAYS cleared afterwards -- an uncleared one would
 * hold the process open past the end of Sprint Setup, and an unref'd one lets
 * the event loop drain out from under a launch dispatch that never settles
 * (which is exactly the case this race exists to survive).
 */
function raceSettle(promise, ms, pendingValue) {
    let timer;
    const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve(pendingValue), ms);
    });
    return Promise.race([promise, deadline]).then(
        (value) => { clearTimeout(timer); return value; },
        (err) => { clearTimeout(timer); throw err; },
    );
}

/**
 * The Sprint Setup per-member preflight.
 *
 * Every dependency is injected so the whole thing is unit-testable with no real
 * fleet server, member connection, clone or index run:
 *   - `command`   the member exec seam, for check (a).
 *   - `callTool`  the engine's MCP client, for check (c).
 *   - `kbPriming` the existing per-member priming client, for check (b). This
 *                 module calls its primeAll() and then reads the per-member
 *                 results back; it never re-implements priming.
 *   - `log` / `publishState` the visibility surfaces.
 *
 * @param {{
 *   members?: string[],
 *   command?: Function,
 *   callTool?: (name: string, args: object) => Promise<any>,
 *   kbPriming?: object,
 *   log?: Function,
 *   publishState?: Function,
 *   launchSettleMs?: number,
 *   indexLaunchArgv?: readonly string[],
 * }} opts
 */
export function createMemberPreflight(opts = {}) {
    const {
        members = [],
        command,
        callTool,
        kbPriming,
        log = () => {},
        publishState,
        launchSettleMs = DEFAULT_LAUNCH_SETTLE_MS,
        indexLaunchArgv = INDEX_LAUNCH_ARGV,
    } = opts;

    /** @type {Map<string, object>} member -> its structured record. */
    const records = new Map();

    function warn(record, check, outcome, cause, remediation) {
        const values = { member: record.member, check, cause, remediation };
        const message = renderPreflightWarning(outcome, values);
        const warning = { ...values, outcome, message };
        record.warnings.push(warning);
        log(message);
        return warning;
    }

    /**
     * Records one check's single outcome, raising the warning when the outcome
     * is a warning kind. An informational or ok outcome raises nothing.
     */
    function record(rec, check, outcome, extra = {}) {
        const entry = { check, outcome, ...extra };
        rec.checks[check] = entry;
        if (PREFLIGHT_WARNING_OUTCOMES.includes(outcome)) {
            const w = warn(rec, check, outcome, extra.cause ?? '(no cause reported)', extra.remediation ?? '(no remediation available)');
            entry.warning = w.message;
        }
        return entry;
    }

    /**
     * Issues the detached launch for one member. Returns a promise that is
     * NEVER awaited inline -- runAll() only races it, bounded, at the end.
     */
    function issueIndexLaunch(member) {
        if (typeof command !== 'function') {
            return Promise.resolve({ ok: false, error: 'no member exec seam is wired into this run' });
        }
        let cmd;
        try {
            cmd = buildIndexLaunchCommand(indexLaunchArgv);
        } catch (err) {
            return Promise.resolve({ ok: false, error: err.message });
        }
        try {
            return Promise.resolve(command(cmd, {
                member_name: member,
                silent: true,
                failSoft: true,
                label: 'Start the code index (detached)',
            })).then(
                (res) => {
                    // failSoft gives { ok, output, error }; a caller-supplied
                    // stub may still hand back a bare string, which is a
                    // success by the same rule stageCommandBodyMemberSide uses.
                    if (typeof res === 'string') return { ok: true, error: null };
                    if (res && typeof res === 'object' && 'ok' in res) {
                        return { ok: !!res.ok, error: res.ok ? null : (res.error || 'the launch command reported a failure') };
                    }
                    return { ok: true, error: null };
                },
                (err) => ({ ok: false, error: err && err.message ? err.message : String(err) }),
            );
        } catch (err) {
            return Promise.resolve({ ok: false, error: err.message });
        }
    }

    /** Check (b): read back what the existing per-member priming path found. */
    function recordKbCheck(rec) {
        const scope = rec.mcpScope;
        if (scope && scope.scoped === false) {
            // The member-config lane already named WHY. Carry it verbatim --
            // do not re-probe and do not degrade it to a generic message.
            record(rec, PREFLIGHT_CHECK_KB, OUTCOME_UNSCOPED, {
                reason: scope.reason,
                cause: scope.reason ? String(scope.reason) : 'no reason was recorded upstream',
                remediation: scope.remediation ? String(scope.remediation) : '(no remediation was recorded upstream)',
            });
            log(`${PREFLIGHT_LOG_PREFIX} member '${rec.member}': KB entries = 0 (scope unavailable)`);
            return;
        }

        const outcome = typeof kbPriming?.primeOutcomeOf === 'function' ? kbPriming.primeOutcomeOf(rec.member) : null;
        const count = typeof kbPriming?.entryCountOf === 'function' ? kbPriming.entryCountOf(rec.member) : null;
        const entryCount = Number.isFinite(count) ? count : 0;

        // Criterion: the entry count is PRINTED, not merely computed -- for
        // every member, including the ones whose count is zero.
        log(`${PREFLIGHT_LOG_PREFIX} member '${rec.member}': KB entries = ${entryCount}`);
        rec.kbEntryCount = entryCount;

        if (outcome === 'no-folder') {
            record(rec, PREFLIGHT_CHECK_KB, OUTCOME_TOOL_UNAVAILABLE, {
                entryCount,
                cause: 'no work folder is registered for this member, so its knowledge scope could not be resolved and the tool was never asked',
                remediation: REMEDIATION.noWorkFolder,
            });
            return;
        }
        if (outcome === 'no-transport' || (outcome === null && typeof callTool !== 'function')) {
            record(rec, PREFLIGHT_CHECK_KB, OUTCOME_TOOL_UNAVAILABLE, {
                entryCount,
                cause: 'no fleet MCP transport is wired into this run, so the knowledge tool was never reached',
                remediation: REMEDIATION.noTransport,
            });
            return;
        }
        if (outcome === 'tool-unavailable') {
            record(rec, PREFLIGHT_CHECK_KB, OUTCOME_TOOL_UNAVAILABLE, {
                entryCount,
                cause: typeof kbPriming?.primeErrorOf === 'function' && kbPriming.primeErrorOf(rec.member)
                    ? String(kbPriming.primeErrorOf(rec.member))
                    : 'the knowledge tool did not answer',
                remediation: REMEDIATION.kbTool,
            });
            return;
        }
        if (entryCount === 0) {
            // RESOLVED but empty. A distinct kind on purpose: reporting this as
            // a pass is the silent failure this lane exists to eliminate, and
            // reporting it as 'tool-unavailable' would send the user after the
            // wrong fix.
            record(rec, PREFLIGHT_CHECK_KB, OUTCOME_KB_EMPTY, {
                entryCount,
                cause: 'the knowledge scope resolved for this member\'s repo and reported zero entries',
                remediation: REMEDIATION.kbEmpty,
            });
            return;
        }
        record(rec, PREFLIGHT_CHECK_KB, OUTCOME_OK, { entryCount });
    }

    /** Check (c): one trivial probe that the code tool ANSWERS. */
    async function recordCodeCheck(rec) {
        const scope = rec.mcpScope;
        if (scope && scope.scoped === false) {
            record(rec, PREFLIGHT_CHECK_CODE, OUTCOME_UNSCOPED, {
                reason: scope.reason,
                cause: scope.reason ? String(scope.reason) : 'no reason was recorded upstream',
                remediation: scope.remediation ? String(scope.remediation) : '(no remediation was recorded upstream)',
            });
            return;
        }
        if (typeof callTool !== 'function') {
            record(rec, PREFLIGHT_CHECK_CODE, OUTCOME_TOOL_UNAVAILABLE, {
                cause: 'no fleet MCP transport is wired into this run, so the code tool was never reached',
                remediation: REMEDIATION.noTransport,
            });
            return;
        }
        if (!rec.repoPath) {
            record(rec, PREFLIGHT_CHECK_CODE, OUTCOME_TOOL_UNAVAILABLE, {
                cause: 'no work folder is registered for this member, so the code tool had no repo to be scoped to and was never asked',
                remediation: REMEDIATION.noWorkFolder,
            });
            return;
        }
        let res;
        try {
            res = await callTool('code_query', { query: PREFLIGHT_CODE_PROBE_QUERY, repo: rec.repoPath });
        } catch (err) {
            record(rec, PREFLIGHT_CHECK_CODE, OUTCOME_TOOL_UNAVAILABLE, {
                cause: err && err.message ? err.message : String(err),
                remediation: REMEDIATION.codeTool,
            });
            return;
        }
        if (isToolError(res)) {
            record(rec, PREFLIGHT_CHECK_CODE, OUTCOME_TOOL_UNAVAILABLE, {
                cause: toolErrorText(res),
                remediation: REMEDIATION.codeTool,
            });
            return;
        }
        const text = resultText(res);
        const parsed = parseToolJson(res);
        if (parsed === null && !text) {
            record(rec, PREFLIGHT_CHECK_CODE, OUTCOME_TOOL_UNAVAILABLE, {
                cause: 'the code tool returned no response body',
                remediation: REMEDIATION.codeTool,
            });
            return;
        }
        if (looksLikeEmptyIndex(parsed, text)) {
            // INFORMATIONAL. The tool answered, which is all this check asserts.
            // An absent or empty index is the normal state right after (a).
            record(rec, PREFLIGHT_CHECK_CODE, OUTCOME_INDEX_NOT_READY);
            log(`${PREFLIGHT_LOG_PREFIX} member '${rec.member}': the code tool answered; its index is not built yet (this is normal right after the index launch).`);
            return;
        }
        record(rec, PREFLIGHT_CHECK_CODE, OUTCOME_OK);
    }

    return {
        /** The structured per-member records, in member order. */
        records() {
            return members.map((m) => records.get(m)).filter(Boolean);
        },
        recordOf(member) {
            return records.get(member) || null;
        },
        /** Every warning raised this run, across all members. */
        warnings() {
            return this.records().flatMap((r) => r.warnings);
        },
        async runAll() {
            if (members.length === 0) return [];

            // (a) FIRST, and NOT awaited. Every member's indexer launch is
            // issued up front so it overlaps the checks below; nothing here
            // ever waits for indexing.
            const launches = new Map();
            for (const member of members) {
                records.set(member, {
                    member,
                    repoPath: null,
                    remoteUrl: null,
                    mcpScope: null,
                    kbEntryCount: 0,
                    checks: {},
                    warnings: [],
                });
                launches.set(member, issueIndexLaunch(member));
            }

            // (b) the existing per-member priming path. Best-effort by its own
            // contract: it never throws a sprint down.
            if (kbPriming && typeof kbPriming.primeAll === 'function') {
                try {
                    await kbPriming.primeAll();
                } catch (err) {
                    log(`${PREFLIGHT_LOG_PREFIX} the knowledge priming pass failed (non-fatal; every member is reported below): ${err.message}`);
                }
            }

            for (const member of members) {
                const rec = records.get(member);
                rec.repoPath = typeof kbPriming?.folderOf === 'function' ? kbPriming.folderOf(member) : null;
                rec.remoteUrl = typeof kbPriming?.remoteUrlOf === 'function' ? kbPriming.remoteUrlOf(member) : null;
                rec.mcpScope = typeof kbPriming?.mcpScopeOf === 'function' ? kbPriming.mcpScopeOf(member) : null;
                recordKbCheck(rec);
                // eslint-disable-next-line no-await-in-loop
                await recordCodeCheck(rec);
            }

            // (a) settled LAST, bounded. An unsettled dispatch is recorded as
            // started: the launch was issued, and nothing more is ever claimed.
            const PENDING = Symbol('launch-pending');
            await Promise.all(members.map(async (member) => {
                const rec = records.get(member);
                const outcome = await raceSettle(launches.get(member), launchSettleMs, PENDING);
                if (outcome === PENDING) {
                    record(rec, PREFLIGHT_CHECK_INDEX, OUTCOME_ANALYZE_STARTED, {
                        detail: 'the launch dispatch was issued and had not reported back when sprint setup moved on; the indexer is never awaited',
                    });
                    return;
                }
                if (outcome && outcome.ok) {
                    record(rec, PREFLIGHT_CHECK_INDEX, OUTCOME_ANALYZE_STARTED, {
                        detail: 'the indexer was launched detached; this is not a claim that the index is current',
                    });
                    return;
                }
                record(rec, PREFLIGHT_CHECK_INDEX, OUTCOME_ANALYZE_NOT_STARTED, {
                    cause: (outcome && outcome.error) ? String(outcome.error) : 'the launch command reported a failure',
                    remediation: REMEDIATION.indexLaunch,
                });
            }));

            const all = this.records();
            const warningCount = all.reduce((n, r) => n + r.warnings.length, 0);
            log(`${PREFLIGHT_LOG_PREFIX} checked ${all.length} member(s); ${warningCount} warning(s). The sprint continues regardless.`);
            if (typeof publishState === 'function') {
                try {
                    publishState(PREFLIGHT_STATE_NAMESPACE, { members: all });
                } catch (err) {
                    log(`${PREFLIGHT_LOG_PREFIX} could not publish the preflight records (non-fatal): ${err.message}`);
                }
            }
            return all;
        },
    };
}
