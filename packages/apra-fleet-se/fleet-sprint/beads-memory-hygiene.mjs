// =============================================================================
// Beads memory hygiene: remove token-usage memories from the beads DB at
// sprint start, before any dispatch.
//
// `bd prime` injects EVERY stored memory into EVERY agent session. A member
// running stale role prompts can write per-dispatch token-usage records as
// memories (`<label> [role] <model> tokens: input=<N> output=<N>`); left in
// the shared DB they grow without bound and bloat every session's context.
// This module is the engine-side defence: it lists the memories once on the
// backlog member and forgets
//   - every value that matches TOKEN_MEMORY_RE (anchored to the WHOLE value),
//   - every key in RETIRED_MEMORY_KEYS (exact key, value ignored),
// then pushes the beads DB once through the injected pushBeads().
//
// Deliberate policy:
//   - a NEAR-MISS (a value that mentions `tokens: input=` but does not match
//     the anchored rule) is warned about, never deleted;
//   - a key outside SAFE_MEMORY_KEY_RE is skipped and warned about, never
//     interpolated into a command;
//   - no cap on the number of forgets;
//   - the sweep NEVER throws: list/parse/forget/push failures are warnings
//     and the sprint continues.
//
// Every command() call here names its member explicitly (dispatch-safety
// guard) and is issued failSoft + silent, like the other read-only probes in
// this package. pushBeads is injected so this module never imports the sync
// modules itself.
// =============================================================================

const LABEL = 'beads-hygiene';
export const BEADS_HYGIENE_WARNING_PREFIX = '[beads-hygiene] WARNING: ';

/** A whole memory value that is a token-usage record: label [+ role] + model, then real numbers. */
export const TOKEN_MEMORY_RE = /^\s*(?:\S+\s+){0,2}\S+\s+tokens:\s*input=~?\d[\d,]*\s+output=~?\d[\d,]*\s*$/i;

/** Keys forgotten by exact name regardless of value. */
export const RETIRED_MEMORY_KEYS = Object.freeze(['token-estimates-json']);

/** Keys are interpolated bare into a forget command; anything else is skipped. */
export const SAFE_MEMORY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const NEAR_MISS_RE = /tokens:\s*input=/i;
const MAX_LISTED_KEYS = 20;

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {'token'|'retired'|'near-miss'|'keep'}
 */
export function classifyMemory(key, value) {
    if (RETIRED_MEMORY_KEYS.includes(key)) return 'retired';
    if (typeof value !== 'string') return 'keep';
    if (TOKEN_MEMORY_RE.test(value)) return 'token';
    if (NEAR_MISS_RE.test(value)) return 'near-miss';
    return 'keep';
}

function outputOf(res) {
    if (res && typeof res === 'object') return typeof res.output === 'string' ? res.output : '';
    return typeof res === 'string' ? res : '';
}

function failureOf(res) {
    if (res && typeof res === 'object' && res.ok === false) return String(res.error || 'command failed');
    return null;
}

function errText(err) {
    return err && err.message ? err.message : String(err);
}

function summarize(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return '(no output)';
    return t.length > 200 ? `${t.slice(0, 200)}...` : t;
}

function listKeys(keys) {
    if (keys.length <= MAX_LISTED_KEYS) return keys.join(', ');
    return `${keys.slice(0, MAX_LISTED_KEYS).join(', ')} (+${keys.length - MAX_LISTED_KEYS} more)`;
}

// `bd memories --json` answers a flat { key: value } object; non-string
// values (e.g. a schema_version field) are not memories.
function parseMemories(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return {};
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('expected a JSON object of key -> value');
    }
    return parsed;
}

/**
 * Lists the member's memories, forgets token-usage records and retired keys,
 * pushes once when anything was forgotten, and logs one WARNING line
 * summarizing it all. Never throws.
 *
 * @param {{ command: Function, log?: Function, member: string, pushBeads?: Function }} opts
 * @returns {Promise<{ removed: string[], nearMisses: string[], skipped: string[], failed: string[], warnings: string[], pushed: boolean }>}
 */
export async function sweepTokenMemories({ command, log = () => {}, member, pushBeads }) {
    const result = { removed: [], nearMisses: [], skipped: [], failed: [], warnings: [], pushed: false };
    const warnLine = (text) => {
        result.warnings.push(text);
        log(`${BEADS_HYGIENE_WARNING_PREFIX}${text}`);
    };
    try {
        if (typeof command !== 'function' || typeof member !== 'string' || !member) {
            warnLine('memory sweep skipped: no command function or member was supplied.');
            return result;
        }

        let res;
        try {
            res = await command('bd memories --json', { member_name: member, silent: true, failSoft: true, label: LABEL });
        } catch (err) {
            res = { ok: false, output: '', error: errText(err) };
        }
        const listFailure = failureOf(res);
        if (listFailure !== null) {
            warnLine(`could not list beads memories on '${member}' (${summarize(listFailure)}); memory sweep skipped, the sprint continues.`);
            return result;
        }
        let memories;
        try {
            memories = parseMemories(outputOf(res));
        } catch (err) {
            warnLine(`could not parse the beads memory list on '${member}' (${summarize(errText(err))}); memory sweep skipped, the sprint continues.`);
            return result;
        }

        const toForget = [];
        for (const [key, value] of Object.entries(memories)) {
            const kind = classifyMemory(key, value);
            if (kind === 'keep') continue;
            if (kind === 'near-miss') {
                result.nearMisses.push(key);
                continue;
            }
            if (!SAFE_MEMORY_KEY_RE.test(key)) {
                result.skipped.push(key);
                continue;
            }
            toForget.push(key);
        }

        for (const key of toForget) {
            let fres;
            try {
                fres = await command(`bd forget ${key}`, { member_name: member, silent: true, failSoft: true, label: LABEL });
            } catch (err) {
                fres = { ok: false, output: '', error: errText(err) };
            }
            if (failureOf(fres) !== null) result.failed.push(key);
            else result.removed.push(key);
        }

        let pushError = null;
        if (result.removed.length > 0 && typeof pushBeads === 'function') {
            try {
                // The real push (gitSync.syncBeadsAfter) is non-fatal: it
                // returns a structured outcome { ok, degraded, degradedKind,
                // detail } instead of throwing, so inspect it. A non-object
                // return is treated as success.
                const outcome = await pushBeads();
                if (outcome && typeof outcome === 'object' && (outcome.degraded || outcome.ok === false)) {
                    pushError = [outcome.degradedKind, outcome.detail ?? outcome.kind].filter(Boolean).map(String).join(': ') || 'push degraded';
                } else {
                    result.pushed = true;
                }
            } catch (err) {
                pushError = errText(err);
            }
        }

        if (result.removed.length || result.nearMisses.length || result.skipped.length || result.failed.length || pushError) {
            const parts = [];
            if (result.removed.length) {
                parts.push(`removed ${result.removed.length} token-usage memor${result.removed.length === 1 ? 'y' : 'ies'} from the beads DB: ${listKeys(result.removed)}`);
            }
            if (result.failed.length) parts.push(`could not forget ${result.failed.length}: ${listKeys(result.failed)}`);
            if (pushError) parts.push(`the beads push after the sweep failed (${summarize(pushError)}); the next beads push retries it`);
            if (result.nearMisses.length) {
                parts.push(`left ${result.nearMisses.length} memor${result.nearMisses.length === 1 ? 'y' : 'ies'} that mention token usage but do not match the rule (not deleted, review by hand): ${listKeys(result.nearMisses)}`);
            }
            if (result.skipped.length) {
                parts.push(`skipped ${result.skipped.length} matching memor${result.skipped.length === 1 ? 'y' : 'ies'} with an unsafe key (remove by hand): ${listKeys(result.skipped.map((k) => JSON.stringify(k)))}`);
            }
            parts.push('a member may be running stale role prompts that store token usage as beads memories');
            warnLine(`${parts.join('; ')}.`);
        } else {
            log('[beads-hygiene] no token-usage memories in the beads DB.');
        }
    } catch (err) {
        // Belt and braces: the sweep must never abort a sprint.
        warnLine(`memory sweep failed unexpectedly (${summarize(errText(err))}); the sprint continues.`);
    }
    return result;
}
