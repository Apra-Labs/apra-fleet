// Sprint pull-request title/body builder for the Publish PR step and the
// [ABORTED] PR path (abort.mjs). Pure: no I/O, no clock reads unless the
// caller omits `now`.
//
// WHY THIS EXISTS. The PR body used to embed the final reviewer's notes
// through sanitizePrText() (sprint-report.mjs), a single-line shell-argument
// sanitizer that maps every newline to a space and collapses all whitespace
// -- so a reviewer's paragraphs and bullet list reached the PR as one
// unreadable paragraph. The body never needed that: every provider's
// create/update-pull-request builder JSON-encodes the body (newlines become
// the two characters `\n`) and quotes the JSON per member shell
// (vcs-providers/shell-helpers.mjs shQuoteJson), so a multi-line body is
// already transport-safe. What untrusted text DOES still need is
// markdown/transport hygiene, which sanitizePrMarkdown() below provides while
// keeping line structure.
//
// RUN HISTORY. Each sprint end rewrites the PR title/body with its own
// verdict; earlier runs are carried forward compactly in a hidden,
// engine-written HTML comment block (RUN_HISTORY_MARKER) that the next run
// parses back. A body without the block (a PR created before this format, or
// hand-edited) simply starts a fresh history.
//
// ASCII only.

import { PR_DESCRIPTION_MAX_LENGTH } from './vcs-module.mjs';

/** Opening token of the hidden run-history block. Versioned so a future
 *  format change can tell its own blocks from this one. */
export const RUN_HISTORY_MARKER = 'fleet-sprint:run-history v1';

/** Total runs (current + previous) kept in the history block. */
export const RUN_HISTORY_MAX_ENTRIES = 8;

/** Upper bound on the reviewer-notes section before the whole-body budget
 *  (PR_DESCRIPTION_MAX_LENGTH) is even considered. */
export const PR_NOTES_MAX_LENGTH = 2000;

const VERDICTS = new Set(['PASS', 'FAIL', 'ABORTED']);
const RUN_ID_UNSAFE_RE = /[^A-Za-z0-9._:/-]/g;
const RUN_ID_MAX = 64;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}Z)?$/;
const HUMAN_REVIEW_LINE = 'Do NOT auto-merge -- see pm skill R12; a human must review and merge this PR.';

// Common typographic code points LLM text carries, mapped to ASCII so the
// body stays ASCII end to end (PowerShell 5.1 argv and some REST stacks do
// not round-trip arbitrary UTF-8 reliably). Anything else non-ASCII becomes
// '?'.
const ASCII_MAP = new Map([
    [0x2018, "'"], [0x2019, "'"], [0x201A, "'"], [0x201B, "'"],
    [0x201C, '"'], [0x201D, '"'], [0x201E, '"'], [0x201F, '"'],
    [0x2010, '-'], [0x2011, '-'], [0x2012, '-'], [0x2013, '-'], [0x2014, '--'], [0x2015, '--'],
    [0x2026, '...'], [0x2022, '-'], [0x00B7, '-'], [0x00A0, ' '], [0x2009, ' '], [0x202F, ' '],
    [0x2192, '->'], [0x2190, '<-'], [0x21D2, '=>'], [0x2264, '<='], [0x2265, '>='], [0x2260, '!='],
    [0x2713, '[OK]'], [0x2714, '[OK]'], [0x2705, '[OK]'], [0x2717, '[X]'], [0x2718, '[X]'], [0x274C, '[X]'],
    [0x00D7, 'x'],
].map(([cp, ascii]) => [String.fromCodePoint(cp), ascii]));

/**
 * Makes untrusted (LLM-authored) text safe to place inside the PR body while
 * PRESERVING its paragraphs, bullet lists and line breaks:
 *   - CRLF/CR -> LF; tabs -> two spaces; other control characters dropped;
 *   - non-ASCII mapped to ASCII (see ASCII_MAP) or '?';
 *   - '<' -> '&lt;' so no raw HTML, HTML comment (which could swallow the rest
 *     of the body or forge the run-history block) or autolink passes through;
 *   - '{{' / '}}' broken apart: the server-side credential handoff substitutes
 *     '{{...}}' placeholders anywhere in the dispatched command, so a note
 *     must never be able to spell one;
 *   - ATX headings ('# x') and setext '===' underlines escaped so the notes
 *     cannot outrank the body's own section headings;
 *   - runs of 3+ blank lines collapsed to one blank line.
 * Code fences are balanced separately (closeOpenFences) AFTER any truncation.
 * @param {unknown} text
 * @returns {string}
 */
export function sanitizePrMarkdown(text) {
    let s = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '  ');
    let out = '';
    for (const ch of s) {
        const code = ch.codePointAt(0);
        if (ch === '\n') out += ch;
        else if (code < 0x20 || code === 0x7f) continue;
        else if (code < 0x7f) out += ch;
        else out += ASCII_MAP.has(ch) ? ASCII_MAP.get(ch) : '?';
    }
    s = out.replace(/</g, '&lt;');
    while (/\{\{|\}\}/.test(s)) s = s.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');
    s = s.split('\n').map((line) => line
        .replace(/[ ]+$/, '')
        .replace(/^( {0,3})(#{1,6})(?=\s|$)/, (_m, indent, marks) => indent + '\\' + marks)
        .replace(/^( {0,3})(=+)$/, (_m, indent, marks) => indent + '\\' + marks))
        .join('\n');
    return s.replace(/\n{3,}/g, '\n\n').trim();
}

/** Appends a closing fence when `text` leaves a ``` / ~~~ code fence open, so
 *  untrusted notes can never swallow the sections that follow them. */
export function closeOpenFences(text) {
    let open = null;
    for (const line of String(text).split('\n')) {
        const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (!m) continue;
        if (!open) {
            open = m[1];
        } else if (m[1][0] === open[0] && m[1].length >= open.length && /^ {0,3}(`{3,}|~{3,})\s*$/.test(line)) {
            open = null;
        }
    }
    return open ? `${text}\n${open}` : text;
}

/** Caps already-sanitized notes at `max` characters, cutting at a line
 *  boundary when one is reasonably close, with a visible marker. */
export function capNotes(text, max) {
    const total = text.length;
    if (total <= max) return closeOpenFences(text);
    let cut = text.slice(0, Math.max(0, max));
    const nl = cut.lastIndexOf('\n');
    if (nl > max * 0.5) cut = cut.slice(0, nl);
    cut = closeOpenFences(cut.replace(/\s+$/, ''));
    return `${cut}\n\n*[... reviewer notes truncated: ${cut.length} of ${total} characters shown ...]*`;
}

/** Normalizes a run id to the history-safe charset. */
export function normalizeRunId(runId) {
    const v = String(runId ?? '').trim().replace(RUN_ID_UNSAFE_RE, '-').slice(0, RUN_ID_MAX);
    return v || 'unnamed-run';
}

/** UTC minute stamp, e.g. 2026-10-01T09:30Z. */
export function runStamp(now = new Date()) {
    return `${now.toISOString().slice(0, 16)}Z`;
}

/**
 * Reads the run-history block back out of an existing PR body. Returns [] for
 * a body with no block, a malformed block, or no valid entries -- never
 * throws. Every entry is re-validated (the body is editable by anyone with
 * PR write access), so only well-formed { run, date, verdict } survive.
 * @param {unknown} body
 * @returns {Array<{ run: string, date: string, verdict: string }>}
 */
export function parseRunHistory(body) {
    const text = String(body ?? '');
    // \r?\n: a body saved from a web editor (GitHub's PR edit box) comes back
    // with CRLF line endings; that must not silently reset the history.
    const re = /<!-- fleet-sprint:run-history v1\r?\n([\s\S]*?)\r?\n-->/g;
    let last = null;
    for (const m of text.matchAll(re)) last = m[1];
    if (last === null) return [];
    let parsed;
    try {
        parsed = JSON.parse(last);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    const out = [];
    for (const e of parsed) {
        if (!e || typeof e !== 'object') continue;
        const run = typeof e.run === 'string' ? normalizeRunId(e.run) : null;
        const date = typeof e.date === 'string' && DATE_RE.test(e.date) ? e.date : null;
        const verdict = typeof e.verdict === 'string' && VERDICTS.has(e.verdict) ? e.verdict : null;
        if (run && date && verdict) out.push({ run, date, verdict });
        if (out.length >= RUN_HISTORY_MAX_ENTRIES) break;
    }
    return out;
}

/** `Auto-sprint [<VERDICT>]: <branch>` -- the format integration gates key on. */
export function buildSprintPrTitle({ verdict, branch }) {
    return `Auto-sprint [${verdict}]: ${branch}`;
}

/** Markdown inline code span. Only ever applied to engine-validated tokens
 *  (branch names, normalized run ids), which cannot contain a backtick. */
function codeSpan(text) {
    // shell-guard-allow: markdown inline-code backticks in PR body text (JSON-encoded into a curl -d payload by the VCS builders), never a command string evaluated by a shell.
    return '`' + text + '`';
}

function inline(text) {
    return sanitizePrMarkdown(text).replace(/\s*\n\s*/g, ' ');
}

/**
 * Builds the sprint PR body as markdown.
 *
 * @param {object} opts
 * @param {'PASS'|'FAIL'|'ABORTED'} opts.verdict
 * @param {string} [opts.goal]
 * @param {string} opts.branch
 * @param {string} [opts.baseBranch]
 * @param {string} [opts.runId]
 * @param {Date} [opts.now]
 * @param {string} [opts.notes] untrusted free text (reviewer notes / abort detail)
 * @param {string} [opts.notesHeading]
 * @param {string[]} [opts.details] engine-authored detail lines, rendered as list items
 * @param {string} [opts.previousBody] the existing PR's body, for history carry-forward
 * @param {number} [opts.maxLength]
 * @returns {string}
 */
export function buildSprintPrBody({
    verdict, goal, branch, baseBranch, runId, now = new Date(),
    notes, notesHeading = 'Reviewer notes', details = [], previousBody = '',
    maxLength = PR_DESCRIPTION_MAX_LENGTH,
}) {
    const v = VERDICTS.has(verdict) ? verdict : 'FAIL';
    const run = normalizeRunId(runId);
    const stamp = runStamp(now);
    const history = [{ run, date: stamp, verdict: v }];
    for (const e of parseRunHistory(previousBody)) {
        if (history.length >= RUN_HISTORY_MAX_ENTRIES) break;
        history.push(e);
    }
    const previous = history.slice(1);

    const head = [
        `## Sprint verdict: ${v}`,
        '',
        goal ? `- **Goal:** ${inline(goal)}` : null,
        `- **Branch:** ${codeSpan(inline(branch))}${baseBranch ? ` -> ${codeSpan(inline(baseBranch))}` : ''}`,
        `- **Run:** ${codeSpan(run)} (${stamp})`,
        '',
        `### ${notesHeading}`,
        '',
    ].filter((l) => l !== null).join('\n');

    const detailLines = (details || []).filter(Boolean).map((d) => `- ${inline(d)}`);
    const tail = [
        '',
        detailLines.length ? '### Details\n' : null,
        detailLines.length ? detailLines.join('\n') : null,
        detailLines.length ? '' : null,
        '---',
        '',
        HUMAN_REVIEW_LINE,
        previous.length ? '\n### Previous runs\n' : null,
        previous.length ? previous.map((e) => `- ${codeSpan(e.run)} (${e.date}): ${e.verdict}`).join('\n') : null,
        '',
        `<!-- ${RUN_HISTORY_MARKER}`,
        JSON.stringify(history),
        '-->',
    ].filter((l) => l !== null).join('\n');

    const cleanNotes = sanitizePrMarkdown(notes);
    const budget = Math.min(PR_NOTES_MAX_LENGTH, maxLength - head.length - tail.length - 120);
    const notesBlock = cleanNotes ? capNotes(cleanNotes, Math.max(200, budget)) : '*No notes were provided.*';
    // Blank lines around the notes keep them their own block: notes ending in
    // a paragraph directly above '---' would otherwise turn into a heading.
    return `${head}\n${notesBlock}\n${tail}`;
}
