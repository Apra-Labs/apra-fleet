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

// The visible header line was "Reviewer notes, continued" before other
// sections could overflow too; both read back so a relaunch still upserts an
// earlier run's comments.
const OVERFLOW_CHUNK_RE = /^<!-- fleet-sprint:pr-overflow v1 (\d+)\/(\d+) -->\r?\n\*\*(?:Reviewer notes|Sprint text), continued \(\d+ of \d+\)\*\*\r?\n([\s\S]*)$/;
const OVERFLOW_SUPERSEDED_RE = /^<!-- fleet-sprint:pr-overflow v1 superseded -->/;

/** The engine-written header of overflow comment `index` of `total`. */
function overflowCommentHeader(index, total) {
    return `<!-- ${OVERFLOW_COMMENT_MARKER} ${index}/${total} -->\n**Sprint text, continued (${index} of ${total})**\n`;
}

const POINTER_LEAD = 'Sprint text that did not fit this description continues in';

/** The description's closing pointer line when the overflow is posted and
 *  the comments' links are not known (yet). */
export function overflowPointer(count) {
    return `${POINTER_LEAD} ${count} PR comment(s) below.`;
}

/**
 * The description's closing pointer line with a markdown link to each
 * overflow comment (`urls`, one per comment, in order); when that is longer
 * than `max`, a link to the first comment plus the count. null when a needed
 * link is missing or even the short form is longer than `max`.
 * @param {Array<string|null>} urls
 * @param {number} [max]
 * @returns {string|null}
 */
export function overflowLinkedPointer(urls, max = Infinity) {
    const list = Array.isArray(urls) ? urls : [];
    const n = list.length;
    if (n === 0 || !list[0]) return null;
    if (list.every(Boolean)) {
        const all = `${POINTER_LEAD} ${n} PR comment(s): ${list.map((u, i) => `[comment ${i + 1}](${u})`).join(', ')}.`;
        if (all.length <= max) return all;
    }
    const short = n === 1
        ? `${POINTER_LEAD} [a PR comment](${list[0]}).`
        : `${POINTER_LEAD} ${n} PR comment(s), starting at [comment 1 of ${n}](${list[0]}).`;
    return short.length <= max ? short : null;
}

/** What a section that did not fit the description shows there, under its
 *  heading; the section itself is in the overflow comments. */
export const OVERFLOW_SECTION_STUB = '*(in the PR comments named at the end)*';

/** Characters the description keeps free for the pointer line whenever
 *  anything overflows, so the linked form (written once the comment links
 *  are known) still fits the provider limit. */
export const OVERFLOW_POINTER_RESERVE = 260;

/** The description's closing pointer line when the overflow could not be
 *  posted as PR comments; with `posted` of `total` comments already on the
 *  PR (a partial failure) it says how many were posted. */
export function overflowFailedPointer(chars, posted = 0, total = 0) {
    if (posted > 0 && total > posted) {
        return `Sprint text continued: ${chars} characters did not fit this description; ${posted} of ${total} overflow comment(s) were posted and ${total - posted} could not be -- the rest is in the sprint run log.`;
    }
    return `Sprint text continued: ${chars} characters did not fit this description and could not be posted as PR comments -- the full text is in the sprint run log.`;
}

// Current pointer forms plus the "Reviewer notes continued ..." ones earlier
// runs wrote, so a relaunch still knows to clean their comments up.
const OVERFLOW_POINTER_RE = /^(?:Reviewer notes continued(?: in \d+ comment\(s\) below\.|: \d+ characters did not fit)|Sprint text that did not fit this description continues in |Sprint text continued: \d+ characters did not fit)/m;

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
 *  older `Auto-sprint [<VERDICT>]: <branch>` form; an existing PR is found by
 *  head branch, and isFleetPrTitle() recognises both forms as fleet-written. */
export function buildSprintPrTitle({ verdict, branch }) {
    return `fleet-sprint [${verdict}]: ${branch}`;
}

const FLEET_TITLE_RE = /^(?:fleet-sprint|Auto-sprint) \[[A-Z]+\]: /;

/** Whether `title` is one fleet wrote (the `fleet-sprint [<VERDICT>]: ` prefix,
 *  or the older `Auto-sprint [<VERDICT>]: ` one). */
export function isFleetPrTitle(title) {
    return FLEET_TITLE_RE.test(String(title ?? ''));
}

/**
 * The title an update of an existing PR sends: `fleetTitle` when the PR's
 * current title is fleet-written (or empty), otherwise the current title
 * unchanged -- fleet never writes any title, [ABORTED] included, over a
 * human-written one (the verdict is in the description's fleet block).
 * @param {unknown} existingTitle
 * @param {string} fleetTitle
 * @returns {string}
 */
export function sprintPrTitleFor(existingTitle, fleetTitle) {
    const current = String(existingTitle ?? '');
    return !current.trim() || isFleetPrTitle(current) ? fleetTitle : current;
}

// ---------------------------------------------------------------------------
// The fleet block
// ---------------------------------------------------------------------------
//
// Fleet owns only the part of a PR description between PR_BLOCK_START and
// PR_BLOCK_END (verdict header, merge assessment, notes, sections, run
// history). On an update the new block replaces the old one in place and the
// text outside it is kept byte-for-byte. A description with no block is
// either:
//   - empty, or an older fleet layout written before the markers existed
//     (verdict header + run-history block, or the plain-text "Automated
//     sprint ..." body before that): fully fleet-owned, replaced whole;
//   - anything else (a human-written PR): every character is kept and the
//     block is APPENDED after it, separated by a blank line.
// Text outside the block is never cut to fit the provider limit: when it
// leaves too little room, the block is a compact one (verdict, overflow
// pointer, run history), and when not even that fits the description is
// left as it is (see buildOutsideBoundResult).

/** Versioned token of the fleet block markers. */
export const PR_BLOCK_MARKER = 'fleet-sprint:pr-block v1';
/** Opening line of the fleet block. */
export const PR_BLOCK_START = `<!-- ${PR_BLOCK_MARKER} -->`;
/** Closing line of the fleet block. */
export const PR_BLOCK_END = `<!-- /${PR_BLOCK_MARKER} -->`;

const LEGACY_FLEET_BODY_RE = /^\s*## Sprint verdict: [A-Z]+\r?\n/;
const RUN_HISTORY_OPEN_RE = /<!-- fleet-sprint:run-history v1\r?\n/;
// The plain-text body fleet wrote before the markdown format ("Automated
// sprint (goal: ...)." / "Automated sprint ABORTED.").
const PRE_FORMAT_FLEET_BODY_RE = /^Automated sprint\b/;

/**
 * Finds the fleet block in `body`: { before, block, after } (the three
 * concatenate back to `body`), or null when it carries no complete block.
 * The last opening marker that is followed by a closing one is taken, so a
 * stray opening marker left above the block never captures human text.
 * @param {unknown} body
 */
export function locateFleetBlock(body) {
    const text = String(body ?? '');
    let from = text.length;
    while (from >= 0) {
        const s = text.lastIndexOf(PR_BLOCK_START, from);
        if (s < 0) return null;
        const e = text.indexOf(PR_BLOCK_END, s + PR_BLOCK_START.length);
        if (e >= 0) {
            const end = e + PR_BLOCK_END.length;
            return { before: text.slice(0, s), block: text.slice(s, end), after: text.slice(end) };
        }
        from = s - 1;
    }
    return null;
}

/**
 * How a new fleet block goes into `previousBody`: { before, after, own }.
 * The new description is before + block + after; `own` is the earlier
 * fleet-owned text (run history and overflow pointer are read from it).
 * @param {unknown} previousBody
 */
export function fleetBlockPlacement(previousBody) {
    const prev = String(previousBody ?? '');
    const loc = locateFleetBlock(prev);
    if (loc) return { before: loc.before, after: loc.after, own: loc.block };
    if (!prev.trim() || (LEGACY_FLEET_BODY_RE.test(prev) && RUN_HISTORY_OPEN_RE.test(prev)) || PRE_FORMAT_FLEET_BODY_RE.test(prev)) {
        return { before: '', after: '', own: prev };
    }
    // A human-written description: kept whole, the block appended below it.
    const sep = prev.endsWith('\n\n') ? '' : (prev.endsWith('\n') ? '\n' : '\n\n');
    return { before: prev + sep, after: '', own: '' };
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

/** Ends the Merge assessment section when only its first lines fit the
 *  description; the whole assessment is in the overflow comments. */
export const MERGE_ASSESSMENT_CONTINUED_MARKER = '*[... the full merge assessment is in the PR comments named at the end ...]*';

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
    previousRuns: 85,
    // [ABORTED] PR sections on the run's work (abort.mjs buildAbortWorkSections).
    abortStillOpen: 94,
    abortClosedWork: 93,
    abortLastReview: 92,
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

/** Max ids the no-verdict line names before "+K more (run log)" (none is dropped silently). */
export const KB_NO_VERDICT_MAX_IDS = 40;

/** Max maintainers the "could not be read" line names. */
const KB_UNREADABLE_MAX_NAMES = 3;

/**
 * The "KB changes on merge" section for buildSprintPrBody's `sections` hook,
 * from kbWork.kbChangesOnMerge() (this run's verdicts plus the withdrawn
 * tombstones the branch carries over its base). Registered right after the
 * merge assessment. Lines: the withdrawals header and one line per id
 * (clipped title and note; ids only when no title) -- a tombstone carried
 * from an earlier run on this branch is listed there too, labelled as
 * carried; a "could not be read" line when a maintainer's branch bible could
 * not be read; a "Demotion not recorded (N)" line for demotions
 * kb_bible_commit did not admit; the "**No verdict (N):** ..." line (ids
 * past KB_NO_VERDICT_MAX_IDS, or past what the budget allows, become "+K
 * more (run log)"); a counts line. Under budget pressure the section
 * degrades step by step, keeping every id as long as the ids alone fit: the
 * per-id lines become one ids-only line, the counts line drops the refused
 * detail, and only then do the id lists end early with "+K more (run log)"
 * -- the withdrawn ids first, the no-verdict ids last. The header's counts
 * and the "could not be read" line stay in every form. Returns null when
 * there is nothing to report.
 * @param {object|null} report
 * @returns {{ id: string, priority: number, heading: string, text: string, placement: string, fit: Function, hardClip: Function }|null}
 */
export function buildKbChangesSection(report) {
    if (!report) return null;
    const clip = (t, n) => { const x = inline(t); return x.length > n ? `${x.slice(0, n - 3)}...` : x; };
    const id8 = (id) => String(id).slice(0, 8);
    const carried = (report.carried || []).map((c) => ({ ...c, carried: true }));
    const withdrawn = [...(report.withdrawn || []), ...carried];
    const notRecorded = report.notRecorded || [];
    const noVerdict = report.noVerdict || [];
    const refused = report.refused || [];
    const unreadable = report.unreadable || [];
    const notPushed = new Set(report.notPushed || []);
    if (withdrawn.length === 0 && notRecorded.length === 0 && noVerdict.length === 0
        && !(report.kept || report.restored) && refused.length === 0 && unreadable.length === 0) return null;
    const carriedLabel = (w) => {
        if (w.restoreNotPushed) return ' (carried from an earlier run; held this run; restore not in a pushed bible commit)';
        return w.kept
            ? ' (carried from an earlier run; held this run, but the restore is not on the branch)'
            : ' (carried from an earlier run, not re-checked)';
    };
    const lineOf = (w) => {
        const t = w.title ? ` "${clip(w.title, 50)}"` : '';
        const n = w.note ? ` -- ${clip(w.note, 100)}` : '';
        return `- ${id8(w.id)}${t}${n}${notPushed.has(w.id) ? ' (not in a pushed bible commit)' : ''}${w.carried ? carriedLabel(w) : ''}`;
    };
    const carriedUnchecked = carried.filter((c) => !c.kept).length;
    const carriedKept = carried.length - carriedUnchecked;
    const carriedHead = (carriedUnchecked > 0 ? `; ${carriedUnchecked} carried from an earlier run, not re-checked` : '')
        + (carriedKept > 0 ? `; ${carriedKept} carried from an earlier run, held but not restored` : '');
    const unreadableLine = unreadable.length > 0
        ? `**Branch tombstones could not be read** (${clip(unreadable.slice(0, KB_UNREADABLE_MAX_NAMES).map((u) => [u.member, u.repo].filter(Boolean).join(': ') || 'the KB report failed').join('; '), 160)}${unreadable.length > KB_UNREADABLE_MAX_NAMES ? `; +${unreadable.length - KB_UNREADABLE_MAX_NAMES} more` : ''}) -- a withdrawal an earlier run committed to this branch is not listed here and still applies on merge (run log).`
        : '';
    // The first k of `ids` (rendered by `show`), then "+K more (run log)" for the rest.
    const idList = (ids, k, show = id8) => {
        const shown = ids.slice(0, k).map(show);
        if (k < ids.length) shown.push(`+${ids.length - k} more (run log)`);
        return shown.join(', ');
    };
    const withdrawnId = (w) => `${id8(w.id)}${notPushed.has(w.id) ? ' (not in a pushed bible commit)' : ''}${w.carried ? ' (carried)' : ''}`;
    const noVerdictCap = Math.min(noVerdict.length, KB_NO_VERDICT_MAX_IDS);
    const refusedPart = refused.length > 0
        ? `; refused: ${refused.length} (${clip(refused.map((r) => `${id8(r.id)} ${r.reason}`).join('; '), 120)}; run log)`
        : '';
    const countsFull = `Re-checked and kept: ${report.kept || 0}; restored: ${report.restored || 0}${refusedPart || '; refused: 0 (run log)'}`;
    const countsShort = `Re-checked and kept: ${report.kept || 0}; restored: ${report.restored || 0}; refused: ${refused.length} (run log)`;
    // detail: per-id lines shown; wIds / rIds / nvIds: ids shown on the
    // withdrawn (after the detail lines), not-recorded and no-verdict lines.
    const build = ({ detail, wIds, rIds, nvIds, fullCounts }) => {
        const parts = [];
        if (withdrawn.length > 0) {
            parts.push(`Merging withdraws ${withdrawn.length} CONFIRMED KB claim(s)${carriedHead} (tombstones in .fleet/kb-canonical.json):`);
            for (const w of withdrawn.slice(0, detail)) parts.push(lineOf(w));
            const rest = withdrawn.slice(detail);
            if (rest.length > 0) parts.push(`- ${idList(rest, wIds, withdrawnId)}`);
        }
        if (unreadableLine) parts.push(unreadableLine);
        if (notRecorded.length > 0) {
            parts.push(`**Demotion not recorded (${notRecorded.length}):** ${idList(notRecorded.map((w) => w.id), rIds)} -- the maintainer's kb_bible_commit did not admit it; still CONFIRMED after merge (run log).`);
        }
        if (noVerdict.length > 0) {
            parts.push(`**No verdict (${noVerdict.length}):** ${idList(noVerdict, nvIds)} -- still CONFIRMED, not re-checked at HEAD.`);
        }
        parts.push(fullCounts ? countsFull : countsShort);
        return parts.join('\n');
    };
    // Every form, richest first; the last is the floor.
    function* forms() {
        const W = withdrawn.length;
        const all = { wIds: W, rIds: notRecorded.length, nvIds: noVerdictCap };
        for (let n = W; n >= 0; n--) yield build({ ...all, detail: n, fullCounts: true });
        yield build({ ...all, detail: 0, fullCounts: false });
        for (let k = W - 1; k >= 0; k--) yield build({ ...all, detail: 0, wIds: k, fullCounts: false });
        for (let k = notRecorded.length - 1; k >= 0; k--) yield build({ ...all, detail: 0, wIds: 0, rIds: k, fullCounts: false });
        for (let k = noVerdictCap - 1; k >= 0; k--) yield build({ detail: 0, wIds: 0, rIds: 0, nvIds: k, fullCounts: false });
    }
    const fitTo = (_text, max) => {
        let last = '';
        for (const t of forms()) {
            if (t.length <= max) return t;
            last = t;
        }
        return last;
    };
    const full = forms().next().value;
    return {
        id: 'kb-changes',
        priority: 98,
        heading: 'KB changes on merge',
        text: full,
        placement: 'after-merge-assessment',
        fit: fitTo,
        hardClip: fitTo,
    };
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
 * With `uncapped` neither the field caps nor the section cap apply: the
 * form an overflow PR comment carries, so nothing is lost there. With
 * `sectionCap: false` only the field caps apply: the PR body's own budget
 * decides whether the section fits (and moves it to the overflow comments
 * whole when it does not), so it is never truncated to fit.
 * @param {unknown} assessment
 * @param {string[]} [incomplete]
 * @param {{ uncapped?: boolean, sectionCap?: boolean }} [opts]
 * @returns {string}
 */
export function renderMergeAssessment(assessment, incomplete = [], { uncapped = false, sectionCap = true } = {}) {
    const cap = (text) => (uncapped || !sectionCap ? text : clipSectionText(text, MERGE_ASSESSMENT_MAX_LENGTH));
    const missing = Array.isArray(incomplete) ? incomplete.filter((f) => typeof f === 'string' && f) : [];
    const note = missing.length > 0
        ? `_assessment incomplete: ${inline(missing.join(', '))}_`
        : '';
    const isObj = assessment && typeof assessment === 'object' && !Array.isArray(assessment);
    if (!isObj) return note ? cap(note) : '';
    const rec = PR_MERGE_RECOMMENDATIONS.includes(assessment.recommendation) ? assessment.recommendation : null;
    const field = (k) => {
        const v = assessment[k];
        const s = typeof v === 'string' ? (uncapped ? inline(v) : clipInline(v, MERGE_ASSESSMENT_FIELD_MAX_LENGTH)) : '';
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
    return cap(lines.join('\n'));
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
 * A FAIL (any non-PASS) verdict must never carry a `merge` recommendation:
 * replaces it with `do_not_merge`. The verdict is never changed, and
 * `merge_after_proof` / `do_not_merge` are left alone.
 * @param {object | undefined | null} verdictResult
 * @returns {{ result: object | undefined | null, changed: boolean }}
 */
export function normalizeRecommendationForVerdict(verdictResult) {
    if (!verdictResult || typeof verdictResult !== 'object') return { result: verdictResult, changed: false };
    const ma = verdictResult.merge_assessment;
    if (verdictResult.verdict === 'PASS' || !ma || typeof ma !== 'object' || ma.recommendation !== 'merge') {
        return { result: verdictResult, changed: false };
    }
    return { result: { ...verdictResult, merge_assessment: { ...ma, recommendation: 'do_not_merge' } }, changed: true };
}

/**
 * Builds the sprint PR body as markdown.
 *
 * The description starts with the sprint verdict, then the merge
 * assessment, then the remaining sections. Every variable section (merge
 * assessment, reviewer notes, set-aside, waited, details, cost, and any
 * caller-registered `sections`) draws on one budget -- `maxLength` -- through
 * fitSectionsToBudget, by priority; the verdict header, human-review line and
 * run-history marker block are the fixed frame and are never clipped. Nothing
 * is truncated away: the part of the reviewer notes that does not fit is
 * returned as `overflow`, and any other section that does not fit in full
 * moves whole to the overflow comments.
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
 * @param {string} [opts.previousBody] the existing PR's body. Fleet owns only
 *   its marked block (PR_BLOCK_START..PR_BLOCK_END, see fleetBlockPlacement):
 *   the new block replaces the old one in place, text outside it is kept
 *   byte-for-byte, and a human-written body with no block keeps all its text
 *   with the block appended. Run history is carried forward from the old
 *   block.
 * @param {number} [opts.maxLength] the description limit of the provider the
 *   PR is raised on (its descriptor's descriptionMaxLength, see
 *   vcs-module.mjs getProviderTextLimits); PR_DESCRIPTION_MAX_LENGTH when
 *   omitted. The fleet block's budget is this limit minus the length of the
 *   text outside the block; under a budget smaller than the frame the
 *   visible "Previous runs" list goes first, then the oldest hidden history
 *   entries
 * @param {number} [opts.commentMaxLength] the same provider's PR comment
 *   limit (commentMaxLength); the overflow is split into comments within it
 * @returns {{ body: string, overflow: string, overflowText: string,
 *   overflowSections: Array<{ id: string, heading: string }>, notes: string, comments: string[],
 *   notPosted: number, failedBody: string|null, failedBodyFor: (posted: number) => string|null,
 *   linkedBodyFor: (urls: Array<string|null>) => string|null, previousHadOverflow: boolean }}
 *   `body` is the whole description (the fleet block among the text outside
 *   it; <= maxLength whenever the frame fits the block budget); `notes` the full sanitized
 *   notes; `overflow` the part of `notes` the description could not carry
 *   ('' when it all fits) -- the section in `body` holds exactly
 *   notes.slice(0, notes.length - overflow.length), so nothing is ever
 *   silently dropped. Every other section that does not fit the description
 *   in full is never truncated either: it shows OVERFLOW_SECTION_STUB under
 *   its heading and is carried whole (`overflowSections` names them).
 *   `overflowText` is everything the comments carry: the notes overflow
 *   first, then each such section under its heading. `comments` is
 *   overflowText as ordered PR comment bodies (buildOverflowComments;
 *   `notPosted` characters past its ceiling), and `body` then ends with the
 *   plain pointer (overflowPointer); `linkedBodyFor(urls)` is the same
 *   description whose pointer links to the posted comments, sent once their
 *   links are known; `failedBody` points at the run log instead, for when
 *   the comments cannot be posted (null with no overflow).
 *   `previousHadOverflow` says whether `previousBody` pointed at overflow
 *   comments (so a relaunch knows to clean them up).
 */
// One-line pointer to the sprint analysis. Never the analysis text itself
// (provider description limits): the full analysis lives in the run record and
// is read from the supervisor's GET /api/sprints/<id> `analysis` field.
export const ANALYSIS_POINTER_LINE = '- **Analysis:** kept in the run record (supervisor `GET /api/sprints/<id>`, `analysis`).';

export function buildSprintPrBody({
    verdict, goal, branch, baseBranch, runId, now = new Date(),
    notes, notesHeading = 'Reviewer notes', mergeAssessment, mergeAssessmentIncomplete, sections = [],
    details = [], setAside = [], waited = [], costAnalysis = '', previousBody = '',
    maxLength = PR_DESCRIPTION_MAX_LENGTH, commentMaxLength = PR_DESCRIPTION_MAX_LENGTH,
}) {
    const v = VERDICTS.has(verdict) ? verdict : 'FAIL';
    const run = normalizeRunId(runId);
    const stamp = runStamp(now);
    // Fleet writes only its own block; text outside it is kept byte-for-byte
    // and its length comes off the description budget.
    const placement = fleetBlockPlacement(previousBody);
    const blockMax = Math.max(0, maxLength - placement.before.length - placement.after.length);
    const history = [{ run, date: stamp, verdict: v }];
    for (const e of parseRunHistory(placement.own)) {
        if (history.length >= RUN_HISTORY_MAX_ENTRIES) break;
        history.push(e);
    }
    const previous = history.slice(1);
    // Hidden history entries written; only lowered when even the frame does
    // not fit the budget (a long description outside the fleet block).
    let historyKeep = history.length;

    const headTop = [
        `## Sprint verdict: ${v}`,
        '',
        goal ? `- **Goal:** ${inline(goal)}` : null,
        `- **Branch:** ${codeSpan(inline(branch))}${baseBranch ? ` -> ${codeSpan(inline(baseBranch))}` : ''}`,
        `- **Run:** ${codeSpan(run)} (${stamp})`,
        ANALYSIS_POINTER_LINE,
        '',
    ].filter((l) => l !== null);

    // The overflow pointer line, when set, is the description's last visible
    // line, just above the hidden run-history block.
    let pointer = '';
    const footer = (previousRuns) => [
        '---',
        '',
        HUMAN_REVIEW_LINE,
        previousRuns ? '\n### Previous runs\n' : null,
        previousRuns || null,
        pointer ? '' : null,
        pointer || null,
        '',
        `<!-- ${RUN_HISTORY_MARKER}`,
        JSON.stringify(history.slice(0, historyKeep)),
        '-->',
    ].filter((l) => l !== null);

    // Internal section ids are prefixed so a caller-registered id can never
    // collide with (and silently replace) a built-in section.
    const extras = (sections || []).map((s, i) => ({
        id: `extra:${String(s && s.id != null ? s.id : i)}`,
        heading: inline(s && s.heading) || 'Notes',
        priority: Number.isFinite(s && s.priority) ? s.priority : SECTION_PRIORITY.extra,
        text: closeOpenFences(sanitizePrMarkdown(s && s.text)),
        placement: s && s.placement === 'after-merge-assessment' ? 'after-merge-assessment' : 'tail',
        fit: s && typeof s.fit === 'function' ? s.fit : undefined,
        hardClip: s && typeof s.hardClip === 'function' ? s.hardClip : undefined,
        omitted: s && typeof s.omitted === 'string' ? s.omitted : undefined,
    }));

    const render = (t) => {
        const head = [...headTop];
        if (t['merge-assessment']) head.push('### Merge assessment', '', t['merge-assessment'], '');
        for (const e of extras) if (e.placement === 'after-merge-assessment' && t[e.id]) head.push(`### ${e.heading}`, '', t[e.id], '');
        head.push(`### ${notesHeading}`, '');
        const extraBlocks = extras.filter((e) => e.placement !== 'after-merge-assessment' && t[e.id]).map((e) => `\n\n### ${e.heading}\n\n${t[e.id]}`).join('');
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
            ...footer(t['previous-runs']),
        ].filter((l) => l !== null).join('\n');
        // Blank lines around the notes keep them their own block: notes ending
        // in a paragraph directly above '---' would otherwise turn into a heading.
        return `${PR_BLOCK_START}\n${head.join('\n')}\n${t.notes}${extraBlocks}\n${tail}\n${PR_BLOCK_END}`;
    };
    // The whole description: the fleet block in its place among the text
    // outside it.
    const describe = (t) => `${placement.before}${render(t)}${placement.after}`;

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
    const costText = sanitizePrMarkdown(costAnalysis);
    const maFull = renderMergeAssessment(mergeAssessment, mergeAssessmentIncomplete, { uncapped: true });
    const maFieldCapped = renderMergeAssessment(mergeAssessment, mergeAssessmentIncomplete, { sectionCap: false });
    // Set before fitting: whether the whole description fits with every
    // section in full, in which case nothing is capped.
    let everythingFits = false;
    const fitMergeAssessment = (available) => {
        const max = everythingFits ? available : Math.min(available, MERGE_ASSESSMENT_MAX_LENGTH);
        if (maFull.length <= max) return maFull;
        if (maFieldCapped.length <= max) return maFieldCapped;
        const marker = `\n\n${MERGE_ASSESSMENT_CONTINUED_MARKER}`;
        const room = max - marker.length;
        if (room < SECTION_MIN_LENGTH) return '';
        let cut = maFieldCapped.slice(0, room);
        const nl = cut.lastIndexOf('\n');
        if (nl > 0) cut = cut.slice(0, nl);
        return `${cut.replace(/\s+$/, '')}${marker}`;
    };
    const costFenceOf = (c) => '`'.repeat(Math.max(3, ...(c.match(/`+/g) || []).map((r) => r.length + 1)));
    const notesSection = {
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
    };
    // Every other variable section. `order` is where it sits in the
    // description (and so in the overflow comments); `comment` is the text an
    // overflow comment carries when the section does not fit the description
    // in full -- the whole section, never a truncated one.
    const others = [
        {
            id: 'merge-assessment', priority: SECTION_PRIORITY.mergeAssessment, heading: 'Merge assessment', order: 0,
            text: maFull,
            fullText: maFull,
            // In full when it fits (and within MERGE_ASSESSMENT_MAX_LENGTH, so
            // it never crowds out the rest); otherwise the field-capped form,
            // cut at a line with a marker, while the overflow comments carry
            // it whole.
            fit: (_text, available) => fitMergeAssessment(available),
            hardClip: (_text, max) => fitMergeAssessment(max),
        },
        ...extras.map((e) => ({
            id: e.id, priority: e.priority, heading: e.heading, order: e.placement === 'after-merge-assessment' ? 1 : 3,
            text: e.text, fit: e.fit, hardClip: e.hardClip, omitted: e.omitted,
        })),
        { id: 'set-aside', priority: SECTION_PRIORITY.setAside, heading: 'Set aside this run', order: 4, text: formatSetAsideItems(setAside).map((d) => `- ${inline(d)}`).join('\n') },
        { id: 'waited', priority: SECTION_PRIORITY.waited, heading: 'Waited this run', order: 5, text: waitedLine ? inline(waitedLine) : '' },
        { id: 'details', priority: SECTION_PRIORITY.details, heading: 'Details', order: 6, text: (details || []).filter(Boolean).map((d) => `- ${inline(d)}`).join('\n') },
        {
            id: 'cost', priority: SECTION_PRIORITY.cost, heading: 'Cost', order: 7, text: costText,
            comment: costText ? `${costFenceOf(costText)}\n${costText}\n${costFenceOf(costText)}` : '',
        },
        {
            id: 'previous-runs',
            priority: SECTION_PRIORITY.previousRuns,
            heading: 'Previous runs',
            order: 8,
            text: previous.map((e) => `- ${codeSpan(e.run)} (${e.date}): ${e.verdict}`).join('\n'),
            // All or nothing in the description.
            hardClip: () => '',
        },
    ].map((s, index) => {
        // The form a section takes with no budget limit: a section with its
        // own fit hook may render its full text differently from `text`.
        const full = s.fullText ?? (s.text && s.fit ? s.fit(s.text, Number.POSITIVE_INFINITY) : s.text);
        return { ...s, index, full, comment: s.comment || full };
    });
    // Sections that do not fit the description in full: each is replaced by a
    // one-line stub there and carried whole by the overflow comments.
    const moved = new Set();
    // The waited line renders with no heading, so its stub names it.
    const stubFor = (s) => (s.id === 'waited' ? `${s.heading}: ${OVERFLOW_SECTION_STUB}` : OVERFLOW_SECTION_STUB);
    const sectionsNow = () => {
        const list = others.map((s) => (moved.has(s.id)
            ? { id: s.id, priority: s.priority, text: stubFor(s), hardClip: () => '' }
            : s));
        // List order matters for priority ties: merge assessment, notes,
        // extras, then the engine tail.
        return [list[0], notesSection, ...list.slice(1)];
    };
    const fit = () => fitSectionsToBudget({ maxLength: blockMax, render, sections: sectionsNow() });
    // Last resort when the frame alone is over the budget: drop the oldest
    // hidden history entries (the current run always stays).
    const fitBlock = () => {
        let r = fit();
        while (r.body.length > blockMax && historyKeep > 1) {
            historyKeep--;
            r = fit();
        }
        return r;
    };
    // A section with its own fit hook may answer a shorter form of itself
    // (e.g. ids only): that form stays in the description and the full one
    // also goes to the overflow comments. Any other section that does not fit
    // in full is moved.
    const abridged = (s, t) => Boolean(s.fit && t[s.id] && t[s.id] !== s.full);
    // Fits, then moves the highest-priority section that did not fit in full
    // to the overflow, one at a time (moving one frees room for the rest),
    // until every section left in the description is whole or abridged.
    let texts;
    const settle = () => {
        for (;;) {
            ({ texts } = fitBlock());
            const next = others
                .filter((s) => s.text && !moved.has(s.id) && texts[s.id] !== s.full && !abridged(s, texts))
                .sort((a, b) => (b.priority - a.priority) || (a.index - b.index))[0];
            if (!next) return;
            moved.add(next.id);
        }
    };
    const overflowOf = (t) => cleanNotes.slice(cleanNotes ? (notesUsed.get(t.notes) ?? 0) : 0);
    everythingFits = render({
        ...Object.fromEntries(others.map((s) => [s.id, s.full])),
        notes: notesSection.text,
    }).length <= blockMax;
    settle();
    // The room the pointer line may take: the linked form, or the longest
    // run-log form.
    const pointerReserve = Math.max(OVERFLOW_POINTER_RESERVE, overflowFailedPointer(9999999, 9999, 99999).length);
    if (overflowOf(texts) || moved.size || others.some((s) => abridged(s, texts))) {
        // Re-fit with the pointer room reserved, so whichever pointer the
        // description ends up with still fits maxLength.
        pointer = 'x'.repeat(pointerReserve);
        settle();
    }
    // The text outside the fleet block leaves too little room for even the
    // frame: fleet never cuts that text (the provider backstop would), so it
    // writes a COMPACT block -- verdict line, pointer, hidden run history --
    // and carries everything else whole in the overflow comments. When not
    // even the compact block fits, the description is left as it is (an
    // earlier fleet block is only removed, when the rest then fits) and the
    // overflow comments carry the whole fleet text.
    if (describe(texts).length > maxLength) {
        return buildOutsideBoundResult({
            v, headTop, history, placement, previousBody, maxLength, commentMaxLength,
            pointerReserve, notesHeading, cleanNotes,
            sectionsText: others
                .filter((s) => s.text)
                .sort((a, b) => (a.order - b.order) || (a.index - b.index))
                .map((s) => ({ id: s.id, heading: s.heading, comment: s.comment })),
        });
    }
    const overflow = overflowOf(texts);
    const movedSections = others
        .filter((s) => moved.has(s.id) || abridged(s, texts))
        .sort((a, b) => (a.order - b.order) || (a.index - b.index));
    // The overflow comments carry the notes' continuation first (it follows
    // the description's notes prefix directly), then each moved section whole
    // under its own heading (an abridged one: its full form, marked so).
    const overflowText = [
        overflow,
        ...movedSections.map((s) => `### ${s.heading}${moved.has(s.id) ? '' : ' (in full)'}\n\n${s.comment}`),
    ].filter(Boolean).join('\n\n');
    let comments = [];
    let notPosted = 0;
    let failedBody = null;
    pointer = '';
    if (overflowText) {
        ({ comments, notPosted } = buildOverflowComments(overflowText, { commentMaxLength: commentMaxLength || PR_DESCRIPTION_MAX_LENGTH }));
        pointer = overflowFailedPointer(overflowText.length);
        failedBody = describe(texts);
        if (comments.length) pointer = overflowPointer(comments.length);
    }
    const body = describe(texts);
    // Renders the description with `p` as the pointer line.
    const withPointer = (p) => {
        const kept = pointer;
        pointer = p;
        try { return describe(texts); } finally { pointer = kept; }
    };
    return {
        body,
        overflow,
        overflowText,
        overflowSections: movedSections.map((s) => ({ id: s.id, heading: s.heading })),
        notes: cleanNotes,
        comments,
        notPosted,
        failedBody,
        // The failed-post description when `posted` of the comments did make it
        // onto the PR (a partial failure); the plain failedBody when none did.
        failedBodyFor: (posted) => {
            if (!failedBody || !(posted > 0) || posted >= comments.length) return failedBody;
            return withPointer(overflowFailedPointer(overflowText.length, posted, comments.length));
        },
        // The description whose pointer line links to the posted comments
        // (`urls`, one per comment, in order); null when there are no
        // comments or the links cannot be rendered within the limit.
        linkedBodyFor: (urls) => {
            if (!comments.length || !Array.isArray(urls) || urls.length !== comments.length) return null;
            const p = overflowLinkedPointer(urls, pointerReserve);
            if (!p) return null;
            const linked = withPointer(p);
            return linked.length <= Math.max(maxLength, body.length) ? linked : null;
        },
        previousHadOverflow: bodyHasOverflowPointer(placement.own),
        compact: false,
        descriptionUnchanged: false,
    };
}

/**
 * buildSprintPrBody's result when the text outside the fleet block leaves
 * too little room for the block's frame (a long human description on a
 * provider with a small description limit). Fleet never cuts text outside
 * its block, so:
 *   - when a COMPACT block (verdict line, overflow pointer, hidden run
 *     history) fits beside that text, the description carries it and the
 *     overflow comments carry everything else whole: the sprint head (goal,
 *     branch, run), the notes and every section (`compact: true`);
 *   - otherwise the description is left as it is (`descriptionUnchanged:
 *     true`; an earlier fleet block is removed instead when the text outside
 *     it then fits), and the overflow comments carry the whole fleet text.
 * Same result shape as buildSprintPrBody.
 */
function buildOutsideBoundResult({
    v, headTop, history, placement, previousBody, maxLength, commentMaxLength,
    pointerReserve, notesHeading, cleanNotes, sectionsText,
}) {
    const overflowText = [
        headTop.join('\n').trim(),
        `### ${notesHeading}\n\n${cleanNotes || '*No notes were provided.*'}`,
        ...sectionsText.map((s) => `### ${s.heading}\n\n${s.comment}`),
        HUMAN_REVIEW_LINE,
    ].join('\n\n');
    const { comments, notPosted } = buildOverflowComments(overflowText, { commentMaxLength: commentMaxLength || PR_DESCRIPTION_MAX_LENGTH });
    const block = (keep, p) => [
        PR_BLOCK_START,
        `## Sprint verdict: ${v}`,
        '',
        p,
        '',
        `<!-- ${RUN_HISTORY_MARKER}`,
        JSON.stringify(history.slice(0, keep)),
        '-->',
        PR_BLOCK_END,
    ].join('\n');
    const describe = (keep, p) => `${placement.before}${block(keep, p)}${placement.after}`;
    let keep = history.length;
    const reserve = 'x'.repeat(pointerReserve);
    while (keep > 1 && describe(keep, reserve).length > maxLength) keep--;
    const shared = {
        overflow: cleanNotes,
        overflowText,
        overflowSections: sectionsText.map((s) => ({ id: s.id, heading: s.heading })),
        notes: cleanNotes,
        comments,
        notPosted,
        previousHadOverflow: bodyHasOverflowPointer(placement.own),
    };
    if (describe(keep, reserve).length <= maxLength) {
        const failedBody = describe(keep, overflowFailedPointer(overflowText.length));
        const body = comments.length ? describe(keep, overflowPointer(comments.length)) : failedBody;
        return {
            ...shared,
            body,
            failedBody,
            failedBodyFor: (posted) => {
                if (!(posted > 0) || posted >= comments.length) return failedBody;
                return describe(keep, overflowFailedPointer(overflowText.length, posted, comments.length));
            },
            linkedBodyFor: (urls) => {
                if (!comments.length || !Array.isArray(urls) || urls.length !== comments.length) return null;
                const p = overflowLinkedPointer(urls, pointerReserve);
                if (!p) return null;
                const linked = describe(keep, p);
                return linked.length <= maxLength ? linked : null;
            },
            compact: true,
            descriptionUnchanged: false,
        };
    }
    const prev = String(previousBody ?? '');
    const loc = locateFleetBlock(prev);
    const withoutBlock = loc ? `${loc.before}${loc.after}` : null;
    const removeBlock = withoutBlock !== null && withoutBlock.length <= maxLength;
    return {
        ...shared,
        body: removeBlock ? withoutBlock : prev,
        failedBody: null,
        failedBodyFor: () => null,
        linkedBodyFor: () => null,
        compact: false,
        descriptionUnchanged: !removeBlock,
    };
}
