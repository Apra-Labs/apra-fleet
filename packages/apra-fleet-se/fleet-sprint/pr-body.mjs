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
import { formatSetAsideItems, formatWaitedLine } from './set-aside.mjs';

/** Opening token of the hidden run-history block. Versioned so a future
 *  format change can tell its own blocks from this one. */
export const RUN_HISTORY_MARKER = 'fleet-sprint:run-history v1';

/** Total runs (current + previous) kept in the history block. */
export const RUN_HISTORY_MAX_ENTRIES = 8;

/** Marker appended to the reviewer-notes section when only a prefix of the
 *  notes fits the description: the rest is returned to the caller as
 *  `overflow` (buildSprintPrBody), never dropped. */
export const NOTES_CONTINUED_MARKER = '*[... reviewer notes continue past the description limit -- see the end of this description ...]*';

/** Opening token of the hidden marker every engine-posted overflow comment
 *  starts with. Versioned like RUN_HISTORY_MARKER. */
export const OVERFLOW_COMMENT_MARKER = 'fleet-sprint:pr-overflow v1';

/** Most overflow comments one publish posts. Past it the last comment states
 *  how many characters were not posted; the full notes are in the run log. */
export const OVERFLOW_MAX_COMMENTS = 20;

/** Body an earlier run's surplus overflow comment is emptied to when it
 *  cannot be deleted; a later run reuses it before posting a new one. */
export const OVERFLOW_SUPERSEDED_COMMENT = `<!-- ${OVERFLOW_COMMENT_MARKER} superseded -->\n*(superseded by a later sprint run)*`;

const OVERFLOW_CHUNK_RE = /^<!-- fleet-sprint:pr-overflow v1 (\d+)\/(\d+) -->\r?\n\*\*Reviewer notes, continued \(\d+ of \d+\)\*\*\r?\n([\s\S]*)$/;
const OVERFLOW_SUPERSEDED_RE = /^<!-- fleet-sprint:pr-overflow v1 superseded -->/;

/** The engine-written header of overflow comment `index` of `total`. */
function overflowCommentHeader(index, total) {
    return `<!-- ${OVERFLOW_COMMENT_MARKER} ${index}/${total} -->\n**Reviewer notes, continued (${index} of ${total})**\n`;
}

/** The description's closing pointer line when the overflow is posted. */
export function overflowPointer(count) {
    return `Reviewer notes continued in ${count} comment(s) below.`;
}

/** The description's closing pointer line when the overflow could not be
 *  posted as PR comments; with `posted` of `total` comments already on the
 *  PR (a partial failure) it says how many were posted. */
export function overflowFailedPointer(chars, posted = 0, total = 0) {
    if (posted > 0 && total > posted) {
        return `Reviewer notes continued: ${chars} characters did not fit this description; ${posted} of ${total} overflow comment(s) were posted and ${total - posted} could not be -- the rest of the notes are in the sprint run log.`;
    }
    return `Reviewer notes continued: ${chars} characters did not fit this description and could not be posted as PR comments -- the full notes are in the sprint run log.`;
}

const OVERFLOW_POINTER_RE = /^Reviewer notes continued(?: in \d+ comment\(s\) below\.|: \d+ characters did not fit)/m;

/** Whether `body` (a PR description) carries an overflow pointer line, i.e.
 *  the run that wrote it posted (or tried to post) overflow comments. */
export function bodyHasOverflowPointer(body) {
    return OVERFLOW_POINTER_RE.test(String(body ?? ''));
}

/**
 * Reads an engine overflow comment back: { index, total, text } for a chunk
 * (`text` is the chunk's notes text, including the ceiling notice on a last
 * comment cut by OVERFLOW_MAX_COMMENTS), { superseded: true } for an emptied
 * stub, null for any other comment.
 * @param {unknown} body
 */
export function parseOverflowComment(body) {
    const s = String(body ?? '');
    if (OVERFLOW_SUPERSEDED_RE.test(s)) return { superseded: true };
    const m = OVERFLOW_CHUNK_RE.exec(s);
    if (!m) return null;
    return { index: Number(m[1]), total: Number(m[2]), text: m[3].replace(/\r\n?/g, '\n') };
}

/**
 * Splits description overflow into ordered PR comment bodies, each at most
 * `commentMaxLength` characters: an engine header (hidden marker with the
 * chunk index, plus a visible "continued (i of N)" line) and the next piece
 * of the overflow, cut at a line break when one is close. The pieces
 * concatenate back to `overflow` exactly. At most `maxComments` comments: the
 * last one then ends with a notice naming how many characters were not
 * posted. Returns { comments, notPosted }; no comments when `overflow` is
 * empty or the limit cannot carry a useful piece.
 * @param {string} overflow
 * @param {{ commentMaxLength: number, maxComments?: number }} opts
 * @returns {{ comments: string[], notPosted: number }}
 */
export function buildOverflowComments(overflow, { commentMaxLength, maxComments = OVERFLOW_MAX_COMMENTS } = {}) {
    const text = String(overflow ?? '');
    if (!text) return { comments: [], notPosted: 0 };
    const room = Math.floor(commentMaxLength) - overflowCommentHeader(99, 99).length;
    if (!Number.isFinite(room) || room < SECTION_MIN_LENGTH || !(maxComments >= 1)) return { comments: [], notPosted: text.length };
    const notice = (n) => `\n\n*[... ${n} characters of reviewer notes not posted: the ${maxComments}-comment limit was reached -- the full notes are in the sprint run log ...]*`;
    const pieces = [];
    let rest = text;
    let notPosted = 0;
    while (rest) {
        if (pieces.length === maxComments - 1 && rest.length > room) {
            const lastRoom = room - notice(text.length).length;
            const cut = lastRoom > 0 ? notesCutIndex(rest, lastRoom) : 0;
            notPosted = rest.length - cut;
            pieces.push(rest.slice(0, cut) + notice(notPosted));
            break;
        }
        const cut = Math.max(1, notesCutIndex(rest, room));
        pieces.push(rest.slice(0, cut));
        rest = rest.slice(cut);
    }
    return { comments: pieces.map((p, i) => overflowCommentHeader(i + 1, pieces.length) + p), notPosted };
}

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

/**
 * Where to cut `text` so its first part is at most `max` characters: the
 * index of a line break (the second part then starts with that '\n'), one
 * outside an open code fence when possible and reasonably close to `max`;
 * a hard cut at `max` when no line break qualifies. The two parts always
 * concatenate back to `text` exactly.
 * @param {string} text
 * @param {number} max
 * @returns {number} the length of the first part (0..text.length)
 */
export function notesCutIndex(text, max) {
    const src = String(text ?? '');
    if (src.length <= max) return src.length;
    const limit = Math.max(0, Math.floor(max));
    if (limit === 0) return 0;
    let best = -1;
    let bestOutside = -1;
    let open = null;
    let pos = 0;
    for (const line of src.split('\n')) {
        const end = pos + line.length;
        if (end > limit) break;
        const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (m) {
            if (!open) open = m[1];
            else if (m[1][0] === open[0] && m[1].length >= open.length && /^ {0,3}(`{3,}|~{3,})\s*$/.test(line)) open = null;
        }
        if (end < src.length) {
            best = end;
            if (!open) bestOutside = end;
        }
        pos = end + 1;
    }
    if (bestOutside > limit * 0.5) return bestOutside;
    if (best > limit * 0.5) return best;
    return limit;
}

/**
 * The longest prefix of sanitized notes that fits `max` characters as a
 * description section: the prefix (code fences closed) plus
 * NOTES_CONTINUED_MARKER, or the whole notes when they fit. Returns
 * { text, used } -- `used` is how many characters of `notes` the section
 * carries (the rest is overflow); { text: '', used: 0 } when no useful prefix
 * fits.
 * @param {string} notes
 * @param {number} max
 */
export function fitNotesPrefix(notes, max) {
    const full = closeOpenFences(notes);
    if (full.length <= max) return { text: full, used: notes.length };
    const suffix = `\n\n${NOTES_CONTINUED_MARKER}`;
    let room = max - suffix.length;
    while (room >= SECTION_MIN_LENGTH) {
        const used = notesCutIndex(notes, room);
        const text = `${closeOpenFences(notes.slice(0, used))}${suffix}`;
        if (text.length <= max && used > 0) return { text, used };
        room -= Math.max(1, text.length - max);
    }
    return { text: '', used: 0 };
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

/** `fleet-sprint [<VERDICT>]: <branch>`. PRs opened before the rename carry the
 *  older `Auto-sprint [<VERDICT>]: <branch>` form; nothing in-repo matches on the
 *  title (an existing PR is found by head branch), so both forms coexist safely. */
export function buildSprintPrTitle({ verdict, branch }) {
    return `fleet-sprint [${verdict}]: ${branch}`;
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

// ---------------------------------------------------------------------------
// Shared section budget
// ---------------------------------------------------------------------------
//
// Every engine-written PR-body section draws on ONE length budget: the
// maxLength the caller passes in (PR_DESCRIPTION_MAX_LENGTH by default). A
// section is { id, priority, text } plus optional fit/hardClip/omitted hooks;
// higher priority keeps its text longer. The fixed frame -- verdict header,
// human-review line and the hidden run-history marker block -- is never a
// section, so no clipping can ever cut the marker.

/** Characters below which a clipped section is dropped instead of kept as a
 *  stub (a heading plus a truncation marker carries no information). */
export const SECTION_MIN_LENGTH = 40;

/** Upper bound on the Merge assessment section before the whole-body budget
 *  is even considered, and on each of its fields. */
export const MERGE_ASSESSMENT_MAX_LENGTH = 1500;
export const MERGE_ASSESSMENT_FIELD_MAX_LENGTH = 400;

/** Default priorities. Engine-authored tail sections outrank the reviewer
 *  notes (as they always have: the notes budget is what is left after them);
 *  a caller-registered section defaults below the notes. */
export const SECTION_PRIORITY = Object.freeze({
    mergeAssessment: 100,
    setAside: 95,
    waited: 95,
    details: 95,
    cost: 90,
    notes: 80,
    extra: 50,
});

/**
 * Clips `text` to at most `max` characters, at a line boundary when one is
 * reasonably close, keeps code fences balanced and appends a visible marker.
 * The result (marker included) never exceeds `max`; '' when even the marker
 * does not fit.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function clipSectionText(text, max) {
    const src = String(text ?? '');
    if (src.length <= max) return src;
    const marker = `\n\n*[... truncated to fit the description limit: ${src.length} characters in full ...]*`;
    const room = max - marker.length;
    if (room <= 0) return '';
    let cut = src.slice(0, room);
    const nl = cut.lastIndexOf('\n');
    if (nl > room * 0.5) cut = cut.slice(0, nl);
    cut = cut.replace(/\s+$/, '');
    let fenced = closeOpenFences(cut);
    while (fenced.length > room && cut.length > 0) {
        cut = cut.slice(0, Math.max(0, cut.length - (fenced.length - room))).replace(/\s+$/, '');
        fenced = closeOpenFences(cut);
    }
    return fenced.length > room ? '' : fenced + marker;
}

/**
 * Fits an ordered list of sections into one length budget.
 *
 * Pass 1 hands out the budget by descending priority (ties keep list order):
 * each section gets what is left after the higher-priority ones, with every
 * lower-priority section still empty, through its own `fit(text, available)`
 * hook when it has one (available = maxLength minus the body rendered with
 * this section empty) or a hard clip otherwise. Pass 2 is the guarantee: while
 * the rendered body is still over maxLength, the lowest-priority non-empty
 * section is hard-clipped by the overflow, or replaced by its `omitted` text /
 * dropped once it is too small to carry anything. Only `render`'s fixed frame
 * can then exceed maxLength (a maxLength smaller than the frame itself).
 *
 * @param {object} opts
 * @param {Array<{ id: string, priority: number, text: string,
 *   fit?: (text: string, available: number) => string,
 *   hardClip?: (text: string, max: number) => string,
 *   omitted?: string }>} opts.sections ordered sections; ids must be unique
 * @param {(texts: Record<string, string>) => string} opts.render builds the
 *   whole body from each section's current text ('' = section absent)
 * @param {number} opts.maxLength the budget, passed in by the caller
 * @returns {{ body: string, texts: Record<string, string>, clipped: string[] }}
 */
export function fitSectionsToBudget({ sections, render, maxLength }) {
    const list = (sections || []).map((s, index) => ({ ...s, index, text: String(s.text ?? '') }));
    const ids = new Set();
    for (const s of list) {
        if (ids.has(s.id)) throw new Error(`fitSectionsToBudget: duplicate section id '${s.id}'`);
        ids.add(s.id);
    }
    const texts = Object.fromEntries(list.map((s) => [s.id, '']));
    const clipped = new Set();
    const hardClip = (s, max) => (s.hardClip ? s.hardClip(s.text, max) : clipSectionText(s.text, max));
    const byPriorityDesc = [...list].sort((a, b) => (b.priority - a.priority) || (a.index - b.index));
    for (const s of byPriorityDesc) {
        if (!s.text) continue;
        texts[s.id] = '';
        const base = render(texts).length;
        const available = maxLength - base;
        let out;
        if (s.fit) {
            out = s.fit(s.text, available);
        } else {
            texts[s.id] = s.text;
            const overhead = render(texts).length - base - s.text.length;
            out = s.text.length + overhead <= available ? s.text : hardClip(s, available - overhead);
        }
        if (out !== s.text) clipped.add(s.id);
        texts[s.id] = out;
    }
    let body = render(texts);
    const exhausted = new Set();
    const byPriorityAsc = [...list].sort((a, b) => (a.priority - b.priority) || (b.index - a.index));
    while (body.length > maxLength) {
        const victim = byPriorityAsc.find((s) => texts[s.id] && !exhausted.has(s.id));
        if (!victim) break;
        const current = texts[victim.id];
        const target = current.length - (body.length - maxLength);
        let next = target >= SECTION_MIN_LENGTH ? hardClip(victim, target) : '';
        if (!next || next.length >= current.length) {
            next = victim.omitted && victim.omitted.length < current.length ? victim.omitted : '';
            exhausted.add(victim.id);
        }
        texts[victim.id] = next;
        clipped.add(victim.id);
        body = render(texts);
    }
    return { body, texts, clipped: [...clipped] };
}

/** merge_assessment.recommendation values the section renders as a code span.
 *  Kept local so this module stays pure (contracts.mjs reads schema files at
 *  load); pinned equal to contracts.mjs MERGE_RECOMMENDATIONS by test. */
export const PR_MERGE_RECOMMENDATIONS = Object.freeze(['merge', 'merge_after_proof', 'do_not_merge']);

/** merge_assessment field -> PR label, in render order (recommendation and
 *  reason share the first line). */
export const MERGE_ASSESSMENT_LABELS = Object.freeze({
    value: 'Value',
    risk: 'Risk',
    default_path_changes: 'Default-path changes',
    blast_radius: 'Blast radius',
    upgrade_impact: 'Upgrade impact',
    proof: 'Proof',
});

function clipInline(text, max) {
    const s = inline(text);
    return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 24)).replace(/\s+$/, '')} [... truncated ...]`;
}

/**
 * Renders a final verdict's merge_assessment as the body of the Merge
 * assessment section (no heading), sanitized and capped at
 * MERGE_ASSESSMENT_MAX_LENGTH. '' when `assessment` is not an object.
 * @param {unknown} assessment
 * @returns {string}
 */
export function renderMergeAssessment(assessment, incomplete = []) {
    const missing = Array.isArray(incomplete) ? incomplete.filter((f) => typeof f === 'string' && f) : [];
    const note = missing.length > 0
        ? `_assessment incomplete: ${inline(missing.join(', '))}_`
        : '';
    const isObj = assessment && typeof assessment === 'object' && !Array.isArray(assessment);
    if (!isObj) return note ? clipSectionText(note, MERGE_ASSESSMENT_MAX_LENGTH) : '';
    const rec = PR_MERGE_RECOMMENDATIONS.includes(assessment.recommendation) ? assessment.recommendation : null;
    const field = (k) => {
        const v = assessment[k];
        const s = typeof v === 'string' ? clipInline(v, MERGE_ASSESSMENT_FIELD_MAX_LENGTH) : '';
        return s || '(not given)';
    };
    // A complete assessment renders exactly as before. An incomplete one
    // renders only its valid fields, then the note naming what was dropped.
    const given = (k) => typeof assessment[k] === 'string' && assessment[k].trim() !== '';
    const lines = missing.length === 0
        ? [
            `- **Recommendation:** ${rec ? codeSpan(rec) : '(not given)'} -- ${field('reason')}`,
            ...Object.entries(MERGE_ASSESSMENT_LABELS).map(([k, label]) => `- **${label}:** ${field(k)}`),
        ]
        : [
            ...(rec || given('reason')
                ? [`- **Recommendation:** ${rec ? codeSpan(rec) : '(not given)'} -- ${field('reason')}`]
                : []),
            ...Object.entries(MERGE_ASSESSMENT_LABELS).filter(([k]) => given(k)).map(([k, label]) => `- **${label}:** ${field(k)}`),
            note,
        ];
    return clipSectionText(lines.join('\n'), MERGE_ASSESSMENT_MAX_LENGTH);
}

/**
 * Normalizes an LLM-authored merge_assessment BEFORE anything validates or
 * renders it: keeps the valid fields, drops invalid and unknown ones, and
 * names every field that was missing, invalid or unknown in `dropped`. The
 * assessment is advisory for humans, so a malformed one must never change
 * the sprint verdict.
 * @param {unknown} raw
 * @returns {{ assessment: object | undefined, dropped: string[] }}
 */
export function normalizeMergeAssessment(raw) {
    if (raw === undefined || raw === null) return { assessment: undefined, dropped: [] };
    const fields = [...Object.keys(MERGE_ASSESSMENT_LABELS), 'recommendation', 'reason'];
    if (typeof raw !== 'object' || Array.isArray(raw)) return { assessment: undefined, dropped: fields };
    const assessment = {};
    const dropped = [];
    for (const k of fields) {
        const v = raw[k];
        const ok = k === 'recommendation'
            ? PR_MERGE_RECOMMENDATIONS.includes(v)
            : typeof v === 'string' && v.trim() !== '';
        if (ok) assessment[k] = v; else dropped.push(k);
    }
    for (const k of Object.keys(raw)) {
        if (!fields.includes(k)) dropped.push(k);
    }
    return { assessment: Object.keys(assessment).length > 0 ? assessment : undefined, dropped };
}

/**
 * Builds the sprint PR body as markdown.
 *
 * The description starts with the sprint verdict, then the merge
 * assessment, then the remaining sections. Every variable section (merge
 * assessment, reviewer notes, set-aside, waited, details, cost, and any
 * caller-registered `sections`) draws on one budget -- `maxLength` -- through
 * fitSectionsToBudget, by priority; the verdict header, human-review line and
 * run-history marker block are the fixed frame and are never clipped. The
 * reviewer notes are never truncated away: the part that does not fit is
 * returned as `overflow`.
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
 * @param {object} [opts.mergeAssessment] the final verdict's merge_assessment
 *   (untrusted); rendered as a Merge assessment section above the notes,
 *   omitted when absent
 * @param {string[]} [opts.mergeAssessmentIncomplete] field names
 *   normalizeMergeAssessment dropped (missing, invalid or unknown); rendered
 *   as an "assessment incomplete" note
 * @param {Array<{ id: string, priority?: number, heading: string, text: string }>} [opts.sections]
 *   extra caller-registered sections (untrusted text, sanitized here),
 *   rendered in order after the notes; priority defaults to
 *   SECTION_PRIORITY.extra
 * @param {string[]} [opts.details] engine-authored detail lines, rendered as list items
 * @param {object[]} [opts.setAside] the run's set-aside records (./set-aside.mjs
 *   collectSetAsideEntries), rendered as a "Set aside this run" section; the
 *   section is omitted when empty
 * @param {object[]} [opts.waited] the run's wait records (./set-aside.mjs
 *   collectWaitEntries), rendered as one "Waited this run" line after the
 *   set-aside section; omitted when empty
 * @param {string} [opts.costAnalysis] engine-computed cost block, rendered in a fenced Cost section
 * @param {string} [opts.previousBody] the existing PR's body, for history carry-forward
 * @param {number} [opts.maxLength] the description limit of the provider the
 *   PR is raised on (its descriptor's descriptionMaxLength, see
 *   vcs-module.mjs getProviderTextLimits); PR_DESCRIPTION_MAX_LENGTH when
 *   omitted
 * @param {number} [opts.commentMaxLength] the same provider's PR comment
 *   limit (commentMaxLength); the overflow is split into comments within it
 * @returns {{ body: string, overflow: string, notes: string, comments: string[],
 *   notPosted: number, failedBody: string|null, failedBodyFor: (posted: number) => string|null,
 *   previousHadOverflow: boolean }}
 *   `body` is the description (<= maxLength); `notes` the full sanitized
 *   notes; `overflow` the part of `notes` the description could not carry
 *   ('' when it all fits) -- the section in `body` holds exactly
 *   notes.slice(0, notes.length - overflow.length), so nothing is ever
 *   silently dropped. `comments` is the overflow as ordered PR comment bodies
 *   (buildOverflowComments; `notPosted` characters past its ceiling), and
 *   `body` then ends with "Reviewer notes continued in N comment(s) below.";
 *   `failedBody` is the same description pointing at the run log instead,
 *   for when the comments cannot be posted (null with no overflow).
 *   `previousHadOverflow` says whether `previousBody` pointed at overflow
 *   comments (so a relaunch knows to clean them up).
 */
export function buildSprintPrBody({
    verdict, goal, branch, baseBranch, runId, now = new Date(),
    notes, notesHeading = 'Reviewer notes', mergeAssessment, mergeAssessmentIncomplete, sections = [],
    details = [], setAside = [], waited = [], costAnalysis = '', previousBody = '',
    maxLength = PR_DESCRIPTION_MAX_LENGTH, commentMaxLength = PR_DESCRIPTION_MAX_LENGTH,
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

    const headTop = [
        `## Sprint verdict: ${v}`,
        '',
        goal ? `- **Goal:** ${inline(goal)}` : null,
        `- **Branch:** ${codeSpan(inline(branch))}${baseBranch ? ` -> ${codeSpan(inline(baseBranch))}` : ''}`,
        `- **Run:** ${codeSpan(run)} (${stamp})`,
        '',
    ].filter((l) => l !== null);

    // The overflow pointer line, when set, is the description's last visible
    // line, just above the hidden run-history block.
    let pointer = '';
    const footer = () => [
        '---',
        '',
        HUMAN_REVIEW_LINE,
        previous.length ? '\n### Previous runs\n' : null,
        previous.length ? previous.map((e) => `- ${codeSpan(e.run)} (${e.date}): ${e.verdict}`).join('\n') : null,
        pointer ? '' : null,
        pointer || null,
        '',
        `<!-- ${RUN_HISTORY_MARKER}`,
        JSON.stringify(history),
        '-->',
    ].filter((l) => l !== null);

    // Internal section ids are prefixed so a caller-registered id can never
    // collide with (and silently replace) a built-in section.
    const extras = (sections || []).map((s, i) => ({
        id: `extra:${String(s && s.id != null ? s.id : i)}`,
        heading: inline(s && s.heading) || 'Notes',
        priority: Number.isFinite(s && s.priority) ? s.priority : SECTION_PRIORITY.extra,
        text: closeOpenFences(sanitizePrMarkdown(s && s.text)),
    }));

    const render = (t) => {
        const head = [...headTop];
        if (t['merge-assessment']) head.push('### Merge assessment', '', t['merge-assessment'], '');
        head.push(`### ${notesHeading}`, '');
        const extraBlocks = extras.filter((e) => t[e.id]).map((e) => `\n\n### ${e.heading}\n\n${t[e.id]}`).join('');
        const cost = t.cost;
        // The cost block replaces the per-sprint CHANGELOG entry the harvester
        // used to write (a shared prepend-only file that conflicted on every merge).
        const costFence = cost ? '`'.repeat(Math.max(3, ...(cost.match(/`+/g) || []).map((r) => r.length + 1))) : '';
        const tail = [
            '',
            t['set-aside'] ? '### Set aside this run\n' : null,
            t['set-aside'] || null,
            t['set-aside'] ? '' : null,
            t.waited ? `${t.waited}\n` : null,
            t.details ? '### Details\n' : null,
            t.details || null,
            t.details ? '' : null,
            cost ? `### Cost\n\n${costFence}\n${cost}\n${costFence}\n` : null,
            ...footer(),
        ].filter((l) => l !== null).join('\n');
        // Blank lines around the notes keep them their own block: notes ending
        // in a paragraph directly above '---' would otherwise turn into a heading.
        return `${head.join('\n')}\n${t.notes}${extraBlocks}\n${tail}`;
    };

    const cleanNotes = sanitizePrMarkdown(notes);
    const waitedLine = formatWaitedLine(waited);
    // How many characters of cleanNotes each candidate notes text carries,
    // so the overflow can be read back after the budget pass.
    const notesUsed = new Map();
    const notesWithin = (max) => {
        const r = fitNotesPrefix(cleanNotes, max);
        if (r.text) notesUsed.set(r.text, r.used);
        return r.text;
    };
    const notesOmitted = '*[... reviewer notes continue past the description limit -- see the end of this description ...]*';
    const fit = () => fitSectionsToBudget({
        maxLength,
        render,
        sections: [
            { id: 'merge-assessment', priority: SECTION_PRIORITY.mergeAssessment, text: renderMergeAssessment(mergeAssessment, mergeAssessmentIncomplete) },
            {
                id: 'notes',
                priority: SECTION_PRIORITY.notes,
                // Always present: no notes renders a placeholder, never an empty section.
                text: cleanNotes || '*No notes were provided.*',
                // `available` is maxLength minus the body with the notes empty.
                // The notes take every character the budget leaves them; what
                // does not fit is NOT truncated away but returned as overflow.
                fit: (text, available) => (cleanNotes ? (notesWithin(available) || notesOmitted) : text),
                hardClip: (_text, max) => (cleanNotes ? notesWithin(max) : ''),
                omitted: cleanNotes ? notesOmitted : undefined,
            },
            ...extras.map((e) => ({ id: e.id, priority: e.priority, text: e.text })),
            { id: 'set-aside', priority: SECTION_PRIORITY.setAside, text: formatSetAsideItems(setAside).map((d) => `- ${inline(d)}`).join('\n') },
            { id: 'waited', priority: SECTION_PRIORITY.waited, text: waitedLine ? inline(waitedLine) : '' },
            { id: 'details', priority: SECTION_PRIORITY.details, text: (details || []).filter(Boolean).map((d) => `- ${inline(d)}`).join('\n') },
            { id: 'cost', priority: SECTION_PRIORITY.cost, text: sanitizePrMarkdown(costAnalysis) },
        ],
    });
    const overflowOf = (t) => cleanNotes.slice(cleanNotes ? (notesUsed.get(t.notes) ?? 0) : 0);
    let { texts } = fit();
    let overflow = overflowOf(texts);
    let comments = [];
    let notPosted = 0;
    let failedBody = null;
    if (overflow) {
        // Re-fit with the longest pointer line reserved, so whichever pointer
        // the description ends up with still fits maxLength.
        pointer = overflowFailedPointer(cleanNotes.length, 9999, 99999);
        ({ texts } = fit());
        overflow = overflowOf(texts);
        ({ comments, notPosted } = buildOverflowComments(overflow, { commentMaxLength: commentMaxLength || PR_DESCRIPTION_MAX_LENGTH }));
        pointer = overflowFailedPointer(overflow.length);
        failedBody = render(texts);
        if (comments.length) pointer = overflowPointer(comments.length);
    }
    return {
        body: render(texts),
        overflow,
        notes: cleanNotes,
        comments,
        notPosted,
        failedBody,
        // The failed-post description when `posted` of the comments did make it
        // onto the PR (a partial failure); the plain failedBody when none did.
        failedBodyFor: (posted) => {
            if (!failedBody || !(posted > 0) || posted >= comments.length) return failedBody;
            const kept = pointer;
            pointer = overflowFailedPointer(overflow.length, posted, comments.length);
            try { return render(texts); } finally { pointer = kept; }
        },
        previousHadOverflow: bodyHasOverflowPointer(previousBody),
    };
}
