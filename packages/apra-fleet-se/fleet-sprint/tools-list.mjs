// =============================================================================
// Tolerant JSON / tools-list reading (apra-fleet-0hn1).
//
// A member's tools/list answer reaches the engine in several shapes: the MCP
// client's own { tools:[...] }, a bare array, a JSON-RPC envelope
// { jsonrpc, id, result:{ tools } }, an MCP content wrapper whose
// content[].text carries one of those as a JSON string, and -- on a remote
// member -- the text output of a CLI call, which can be pretty-printed over
// many lines and surrounded by log lines. A reader that only accepted one of
// these (single-line JSON, content[0].text only) failed to parse a valid
// answer, and the caller then skipped the bible import.
//
// This module is the one reader every caller shares:
//   - lastJsonValue(text, { arrays })  the last top-level JSON object (or
//                                      array) embedded anywhere in text;
//   - toolsOfAnswer(answer)            the tool list out of any shape above,
//                                      or null when there is none;
//   - readToolsList(listTools, member, { log, prefix, memberName })
//                                      call listTools, retry ONCE on an
//                                      unparseable answer, and log a WARN
//                                      naming the member and the first 200
//                                      chars of the raw answer when the retry
//                                      fails too.
// =============================================================================

import { resultText } from './mcp-result.mjs';

/** How many chars of an unparseable raw answer a WARN quotes. */
export const RAW_ANSWER_WARN_CHARS = 200;

/** MemberCallError code a remote call uses for unparseable output. */
const E_REMOTE_PARSE = 'E-REMOTE-PARSE';

/**
 * End index (exclusive) of the balanced JSON value starting at `start`
 * ('{' or '['), string- and escape-aware; -1 when it never closes.
 */
function balancedEnd(text, start) {
    const stack = [];
    let inString = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inString) {
            if (c === '\\') { i++; continue; }
            if (c === '"') inString = false;
            continue;
        }
        if (c === '"') { inString = true; continue; }
        if (c === '{' || c === '[') { stack.push(c === '{' ? '}' : ']'); continue; }
        if (c === '}' || c === ']') {
            if (stack.pop() !== c) return -1;
            if (stack.length === 0) return i + 1;
        }
    }
    return -1;
}

/**
 * The LAST top-level JSON object embedded in `text` (an array too when
 * `arrays` is set), wherever it sits: a single line, pretty-printed over
 * many lines, or between non-JSON log lines. Null when there is none.
 * @param {string} text
 * @param {{ arrays?: boolean }} [opts]
 */
export function lastJsonValue(text, opts = {}) {
    const s = String(text ?? '');
    const arrays = opts.arrays === true;
    const trimmed = s.trim();
    if (trimmed) {
        // The common case: the whole text is the JSON value.
        try {
            const v = JSON.parse(trimmed);
            if (v && typeof v === 'object' && (arrays || !Array.isArray(v))) return v;
        } catch { /* scan below */ }
    }
    let found = null;
    let i = 0;
    while (i < s.length) {
        const c = s[i];
        if (c === '{' || (arrays && c === '[')) {
            const end = balancedEnd(s, i);
            if (end > 0) {
                try {
                    found = JSON.parse(s.slice(i, end));
                    i = end;
                    continue;
                } catch { /* not JSON: keep scanning inside it */ }
            }
        }
        i++;
    }
    return found;
}

/**
 * The tool list out of a tools/list answer, or null when it carries none.
 * Accepts a bare array, { tools }, a JSON-RPC envelope { result: { tools } },
 * an MCP content wrapper (any content[].text holding one of those, display
 * banners skipped), and text (pretty-printed, or with log lines around it).
 * @param {any} answer
 * @param {number} [depth]
 * @returns {any[]|null}
 */
export function toolsOfAnswer(answer, depth = 0) {
    if (depth > 4 || answer === null || answer === undefined) return null;
    if (Array.isArray(answer)) return answer;
    if (typeof answer === 'string') {
        const v = lastJsonValue(answer, { arrays: true });
        return v === null ? null : toolsOfAnswer(v, depth + 1);
    }
    if (typeof answer !== 'object') return null;
    if (Array.isArray(answer.tools)) return answer.tools;
    if (answer.result && typeof answer.result === 'object') {
        const inner = toolsOfAnswer(answer.result, depth + 1);
        if (inner) return inner;
    }
    if (Array.isArray(answer.content)) {
        const first = resultText(answer);
        const fromFirst = first ? toolsOfAnswer(first, depth + 1) : null;
        if (fromFirst) return fromFirst;
        for (const entry of answer.content) {
            if (entry && typeof entry.text === 'string') {
                const t = toolsOfAnswer(entry.text, depth + 1);
                if (t) return t;
            }
        }
    }
    return null;
}

/** The raw answer as text (a remote parse error carries the raw output). */
export function rawAnswerText(answer) {
    if (typeof answer === 'string') return answer;
    if (answer === undefined) return 'undefined';
    try { return JSON.stringify(answer); } catch { return String(answer); }
}

function isParseError(err) {
    return !!err && err.code === E_REMOTE_PARSE;
}

/**
 * Call `listTools(member)` and read its tool list. A genuinely unparseable
 * answer (no tool list in it, or a remote E-REMOTE-PARSE) is retried exactly
 * once; when the retry is unparseable too a WARN naming the member and the
 * first RAW_ANSWER_WARN_CHARS chars of the raw answer is logged. Any other
 * failure is not retried.
 *
 * @returns {Promise<{ tools: any[] } | { error: Error } | { unparseable: true, raw: string }>}
 */
export async function readToolsList(listTools, member, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const prefix = opts.prefix || '[tools-list]';
    const name = opts.memberName || (member && (member.name || member.id)) || 'unknown';
    let raw = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
        let answer;
        try {
            answer = await listTools(member);
        } catch (err) {
            if (!isParseError(err)) return { error: err };
            raw = err.details && typeof err.details.raw === 'string' ? err.details.raw : String(err.message || '');
            continue;
        }
        const tools = toolsOfAnswer(answer);
        if (tools) return { tools };
        raw = rawAnswerText(answer);
    }
    log(`${prefix} WARN tools/list answer from member '${name}' could not be parsed (after one retry); raw answer (first ${RAW_ANSWER_WARN_CHARS} chars): ${raw.slice(0, RAW_ANSWER_WARN_CHARS)}`);
    return { unparseable: true, raw };
}
