// =============================================================================
// Per-role, per-dispatch KB relevance hints (parent bug apra-fleet-b4g.19).
//
// The injected KNOWLEDGE BANK block is only useful when it is about what the
// role is about to do. Each role has its own hint SOURCES:
//
//   planner, plan-reviewer          sprint goals + in-scope bead titles
//   doer                            bead titles + the files its lane touches
//   reviewer (per-round and final)  bead titles + the files in the diff
//   deployer, integ/regression      deploy targets + the test files in scope
//   test runners
//   harvester                       the sprint's diff files + closed bead titles
//
// roleHints() turns those sources into the three things the KB reads accept:
// free-text query terms (kb_query), hint_symbols and hint_modules
// (kb_session_prime). Stopwords and tracker-id tokens (bead ids) are removed
// from the free text: they match nothing useful and only add ranking noise.
//
// Pure functions, no I/O.
// =============================================================================

/** Common English words that carry no retrieval signal in a title or goal. */
export const KB_STOPWORDS = Object.freeze(new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do', 'does', 'for',
    'from', 'has', 'have', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'no', 'not', 'of', 'on',
    'or', 'so', 'such', 'that', 'the', 'their', 'then', 'there', 'these', 'this', 'to', 'was',
    'were', 'when', 'where', 'which', 'while', 'who', 'will', 'with', 'without', 'you', 'your',
    'all', 'any', 'each', 'every', 'per', 'via', 'also', 'only', 'than', 'too', 'very', 'must',
    'should', 'never', 'always', 'after', 'before', 'both', 'new', 'one', 'two',
]));

// A tracker id is a project prefix, a short alphanumeric key that contains a
// digit, and optionally dotted numeric child suffixes: apra-fleet-b4g.18.3,
// bd-12, PROJ-123. A plain hyphenated word (kb-maintainer, per-role) has no
// digit in its last segment and is NOT a tracker id.
const TRACKER_ID_RE = /^(?:[a-z][a-z0-9]*-)+(?=[a-z0-9]*\d)[a-z0-9]{2,6}(?:\.\d+)*$/i;
// A bare dotted-numeric child of a known id ("19.3") is also tracker residue.
const DOTTED_NUMERIC_RE = /^\d+(?:\.\d+)+$/;

// A priority-tier token ('P1', 'P1/P2/P3') is sprint scope metadata, not a topic.
const PRIORITY_TIER_RE = /^P\d+(?:\/P\d+)*$/i;

/** True for a priority-tier goal token such as 'P2' or 'P1/P2/P3'. */
export function isPriorityTierToken(token) {
    return typeof token === 'string' && PRIORITY_TIER_RE.test(token.trim());
}

/**
 * @param {string} token
 * @param {Set<string>|string[]} [knownIds] bead ids the caller already holds
 * @returns {boolean}
 */
export function isTrackerIdToken(token, knownIds) {
    if (typeof token !== 'string') return false;
    const t = token.trim();
    if (!t) return false;
    const known = knownIds instanceof Set ? knownIds : new Set(Array.isArray(knownIds) ? knownIds : []);
    if (known.has(t)) return true;
    return TRACKER_ID_RE.test(t) || DOTTED_NUMERIC_RE.test(t);
}

/** Split prose into candidate tokens, keeping identifiers, paths and hyphenated ids whole. */
function tokenize(text) {
    return String(text).split(/[\s,;:()[\]{}"'`<>!?=+*|]+/).map((t) => t.replace(/^[.\-/]+|[.\-]+$/g, '')).filter(Boolean);
}

/**
 * Query terms from free text: stopwords and tracker-id tokens removed,
 * lower-case duplicates collapsed, order preserved.
 *
 * @param {Array<string|null|undefined>} texts
 * @param {{ knownIds?: Set<string>|string[] }} [opts]
 * @returns {string[]}
 */
export function cleanQueryTerms(texts, opts = {}) {
    const out = [];
    const seen = new Set();
    for (const text of Array.isArray(texts) ? texts : []) {
        if (typeof text !== 'string') continue;
        for (const tok of tokenize(text)) {
            const low = tok.toLowerCase();
            if (low.length < 2 || KB_STOPWORDS.has(low)) continue;
            if (isTrackerIdToken(tok, opts.knownIds) || isPriorityTierToken(tok)) continue;
            if (seen.has(low)) continue;
            seen.add(low);
            out.push(tok);
        }
    }
    return out;
}

/** True for a token that looks like a code symbol (camelCase, snake_case or dotted/qualified). */
function looksLikeSymbol(tok) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(tok)
        && (/[a-z][A-Z]/.test(tok) || tok.includes('_') || /^[A-Z][a-z]+[A-Z]/.test(tok));
}

const asStrings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : []);
const titlesOf = (beads) => (Array.isArray(beads) ? beads : [])
    .map((b) => (typeof b === 'string' ? b : b && typeof b.title === 'string' ? b.title : null))
    .filter((t) => typeof t === 'string' && t.trim());

/**
 * Which context fields feed each role's hints. Roles not listed here have no
 * hint sources (ci-watcher): they get no query terms and so no KB lookup.
 *
 * beadDescriptions / beadAcceptance / diffHunks / changedSymbols are the rich
 * sources: they also drive the per-bead and per-file `situations` the query
 * fan-out consumes (a role with none of them gets no situations and keeps the
 * single joined-terms query).
 */
export const KB_ROLE_HINT_SOURCES = Object.freeze({
    planner: ['goals', 'beadTitles'],
    'plan-reviewer': ['goals', 'beadTitles'],
    doer: ['beadTitles', 'beadDescriptions', 'beadAcceptance', 'laneFiles'],
    reviewer: ['beadTitles', 'beadDescriptions', 'beadAcceptance', 'diffFiles', 'diffHunks', 'changedSymbols'],
    deployer: ['deployTargets', 'testFiles'],
    'integ-test-runner': ['deployTargets', 'testFiles'],
    'regression-test-runner': ['deployTargets', 'testFiles'],
    harvester: ['diffFiles', 'closedBeadTitles', 'changedSymbols'],
});

/** Context fields whose values are file paths (-> hint_modules + basename terms) vs prose. */
const FILE_FIELDS = new Set(['laneFiles', 'diffFiles', 'testFiles', 'deployTargets']);

/** Caps keeping a hint (and so a kb_query) bounded. */
export const KB_HINT_LIMITS = Object.freeze({
    /** Diff hunk text considered at all; the rest is dropped before parsing. */
    maxHunkChars: 20000,
    /** error_text sent to the KB for a bounced bead. */
    maxErrorTextChars: 2000,
    /** Prose per bead situation (title + description + acceptance, each trimmed). */
    maxDescriptionChars: 300,
    maxAcceptanceChars: 200,
    maxTerms: 40,
    maxFilesPerSituation: 5,
    maxSymbolsPerSituation: 5,
    maxFileSituations: 12,
});

/** Strip tracker ids (bead ids) from prose, keeping everything else. */
export function stripTrackerIds(text, knownIds) {
    if (typeof text !== 'string') return '';
    let out = text;
    const known = knownIds instanceof Set ? knownIds : new Set(Array.isArray(knownIds) ? knownIds : []);
    for (const id of known) if (id) out = out.split(id).join('');
    out = out.replace(/[^\s,;:()[\]{}"'`<>]+/g, (tok) => {
        const bare = tok.replace(/^[.\-/]+|[.\-]+$/g, '');
        return bare && (isTrackerIdToken(bare, known) || isPriorityTierToken(bare)) ? '' : tok;
    });
    return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/** Prose cleaned of tracker ids, whitespace-collapsed and cut to `max` chars. */
function cleanProse(text, knownIds, max) {
    const t = stripTrackerIds(String(text ?? ''), knownIds).replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max).trim() : t;
}

/** The error text a KB lookup may carry: ids stripped, bounded. */
export function boundedErrorText(text, knownIds) {
    if (typeof text !== 'string') return '';
    const t = stripTrackerIds(text, knownIds).trim();
    return t.length > KB_HINT_LIMITS.maxErrorTextChars ? t.slice(0, KB_HINT_LIMITS.maxErrorTextChars) : t;
}

const DECL_RE = /\b(?:function\*?|class|const|let|var|def|fn|func|interface|type|enum|struct|trait)\s+([A-Za-z_$][\w$]*)/g;
const METHOD_RE = /^\s*(?:export\s+)?(?:public\s+|private\s+|protected\s+|static\s+)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^={]+)?\{\s*$/;
const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'with']);

function symbolsOfLine(line) {
    const out = [];
    for (const m of line.matchAll(DECL_RE)) out.push(m[1]);
    const meth = METHOD_RE.exec(line);
    if (meth && !NOT_METHOD.has(meth[1])) out.push(meth[1]);
    return out;
}

/**
 * Per-file changed symbols from unified-diff text: declaration names on added
 * or removed lines, plus the function context git prints after a hunk's
 * second @@. A cheap regex, not a parser; the text is size-capped first.
 *
 * @param {string} hunks
 * @returns {Array<{ file: string, symbols: string[] }>}
 */
export function parseDiffHunks(hunks) {
    if (typeof hunks !== 'string' || !hunks) return [];
    const text = hunks.length > KB_HINT_LIMITS.maxHunkChars ? hunks.slice(0, KB_HINT_LIMITS.maxHunkChars) : hunks;
    const files = [];
    let cur = null;
    const fileOf = (name) => {
        let f = files.find((x) => x.file === name);
        if (!f) { f = { file: name, symbols: [] }; files.push(f); }
        return f;
    };
    for (const line of text.split('\n')) {
        const plus = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
        if (plus) { cur = plus[1] === '/dev/null' ? null : fileOf(plus[1].trim()); continue; }
        const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
        if (git) { cur = fileOf(git[2].trim()); continue; }
        if (/^--- /.test(line)) continue;
        if (!cur) cur = fileOf('(unknown)');
        const add = (name) => { if (name && !cur.symbols.includes(name)) cur.symbols.push(name); };
        const hh = /^@@[^@]*@@\s*(.*)$/.exec(line);
        if (hh) { for (const n of symbolsOfLine(hh[1])) add(n); continue; }
        if (line.startsWith('+') || line.startsWith('-')) for (const n of symbolsOfLine(line.slice(1))) add(n);
    }
    return files.filter((f) => f.file !== '(unknown)' || f.symbols.length > 0);
}

const nth = (arr, i) => (Array.isArray(arr) && typeof arr[i] === 'string' ? arr[i] : '');
const beadField = (b, k) => (b && typeof b === 'object' && typeof b[k] === 'string' ? b[k] : '');

/**
 * Build the KB read hints for one role's dispatch.
 *
 * beadTitles / beadDescriptions / beadAcceptance / beadErrorTexts are PARALLEL
 * arrays (index i is one bead); a beadTitles element may instead be a bead
 * object whose description / acceptance_criteria are read directly.
 * beadErrorTexts[i] is the failure text of a bounced bead (reviewer findings);
 * it is bounded and has tracker ids stripped. A first-time dispatch has none.
 *
 * @param {string} role
 * @param {{
 *   goals?: string[]|string, beadTitles?: Array<string|{title?: string}>,
 *   beadDescriptions?: string[], beadAcceptance?: string[], beadErrorTexts?: Array<string|null>,
 *   closedBeadTitles?: Array<string|{title?: string}>,
 *   laneFiles?: string[], diffFiles?: string[], deployTargets?: string[], testFiles?: string[],
 *   diffHunks?: string, changedSymbols?: string[],
 *   beadIds?: string[],
 * }} [ctx]
 * @returns {{ role: string, terms: string[], hintSymbols: string[], hintModules: string[],
 *   situations: Array<{ kind: 'bead'|'file', situation: string, files: string[], symbols: string[], errorText?: string }> }}
 */
export function roleHints(role, ctx = {}) {
    const fields = KB_ROLE_HINT_SOURCES[role] || [];
    const knownIds = new Set(asStrings(ctx.beadIds));
    const prose = [];
    const files = [];
    for (const f of fields) {
        if (FILE_FIELDS.has(f)) { files.push(...asStrings(ctx[f])); continue; }
        if (f === 'goals') prose.push(...asStrings(typeof ctx.goals === 'string' ? [ctx.goals] : ctx.goals));
        else if (f === 'beadTitles' || f === 'closedBeadTitles') prose.push(...titlesOf(ctx[f]));
        else if (f === 'beadDescriptions') prose.push(...asStrings(ctx.beadDescriptions), ...(Array.isArray(ctx.beadTitles) ? ctx.beadTitles : []).map((b) => beadField(b, 'description')).filter(Boolean));
        else if (f === 'beadAcceptance') prose.push(...asStrings(ctx.beadAcceptance), ...(Array.isArray(ctx.beadTitles) ? ctx.beadTitles : []).map((b) => beadField(b, 'acceptance_criteria')).filter(Boolean));
    }
    // Changed symbols: given directly and/or read off the diff hunks.
    const hunkFiles = fields.includes('diffHunks') || fields.includes('changedSymbols') ? parseDiffHunks(ctx.diffHunks) : [];
    const changedSymbols = [];
    if (fields.includes('changedSymbols')) {
        for (const s of [...asStrings(ctx.changedSymbols), ...hunkFiles.flatMap((h) => h.symbols)]) {
            if (!changedSymbols.includes(s)) changedSymbols.push(s);
        }
    }
    const hintModules = [];
    const fileTerms = [];
    for (const raw of files) {
        const p = raw.replace(/\\/g, '/').replace(/^\.\//, '');
        if (!p) continue;
        if (!hintModules.includes(p)) hintModules.push(p);
        const base = p.split('/').pop().replace(/\.[A-Za-z0-9]+$/, '');
        if (base) fileTerms.push(base);
    }
    const hintSymbols = [];
    for (const text of prose) {
        for (const tok of tokenize(text)) {
            if (looksLikeSymbol(tok) && !hintSymbols.includes(tok)) hintSymbols.push(tok);
        }
    }
    for (const s of changedSymbols) if (!hintSymbols.includes(s)) hintSymbols.push(s);
    const terms = cleanQueryTerms([...prose, ...fileTerms, ...changedSymbols], { knownIds }).slice(0, KB_HINT_LIMITS.maxTerms);

    // Situations: one per bead, one per file -- only for a role with a rich
    // source (description / acceptance / hunks / lane files). Harvester, planners
    // and runners keep the single joined-terms query.
    const rich = fields.some((f) => f === 'beadDescriptions' || f === 'beadAcceptance' || f === 'diffHunks' || f === 'laneFiles');
    const situations = [];
    if (rich) {
        const beads = Array.isArray(ctx.beadTitles) ? ctx.beadTitles : [];
        const allChanged = changedSymbols;
        beads.forEach((b, i) => {
            const title = typeof b === 'string' ? b : beadField(b, 'title');
            const desc = nth(ctx.beadDescriptions, i) || beadField(b, 'description');
            const acc = nth(ctx.beadAcceptance, i) || beadField(b, 'acceptance_criteria');
            if (!title.trim() && !desc.trim()) return;
            const bfiles = pathsFromText([desc, acc, beadField(b, 'notes')]).slice(0, KB_HINT_LIMITS.maxFilesPerSituation);
            const bsyms = [];
            for (const tok of [...tokenize(desc), ...tokenize(acc)]) {
                if (looksLikeSymbol(tok) && !isTrackerIdToken(tok, knownIds) && !bsyms.includes(tok)) bsyms.push(tok);
            }
            for (const s of allChanged) if (!bsyms.includes(s)) bsyms.push(s);
            const parts = [cleanProse(title, knownIds, 160)];
            const d = cleanProse(desc, knownIds, KB_HINT_LIMITS.maxDescriptionChars);
            const a = cleanProse(acc, knownIds, KB_HINT_LIMITS.maxAcceptanceChars);
            let situation = `about to work on: ${parts[0]}`;
            if (bsyms.length > 0 || bfiles.length > 0) {
                situation = `about to change ${bsyms.slice(0, 3).join(', ') || 'code'}${bfiles.length ? ` in ${bfiles.slice(0, 2).join(', ')}` : ''}, which ${parts[0]}`;
            }
            if (d) situation += `. ${d}`;
            if (a) situation += `. Done when: ${a}`;
            const errorText = boundedErrorText(nth(ctx.beadErrorTexts, i), knownIds);
            situations.push({
                kind: 'bead',
                situation,
                files: bfiles,
                symbols: bsyms.slice(0, KB_HINT_LIMITS.maxSymbolsPerSituation),
                ...(errorText ? { errorText } : {}),
            });
        });
        const fileSyms = new Map(hunkFiles.map((h) => [h.file, h.symbols]));
        const fileList = [...new Set([...hintModules, ...hunkFiles.map((h) => h.file).filter((f) => f !== '(unknown)')])];
        for (const f of fileList.slice(0, KB_HINT_LIMITS.maxFileSituations)) {
            const syms = (fileSyms.get(f) || []).slice(0, KB_HINT_LIMITS.maxSymbolsPerSituation);
            situations.push({
                kind: 'file',
                situation: `about to change ${syms.slice(0, 3).join(', ') || 'code'} in ${f}`,
                files: [f],
                symbols: syms,
            });
        }
    }
    return { role, terms, hintSymbols, hintModules, situations };
}

const PATH_RE = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,6}|\b[A-Za-z0-9_-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|py|go|rs|sh|yml|yaml)\b/g;

/**
 * File-looking paths named in free text (a bead description's "Expected files"
 * list, a deploy.md target). Used where the engine holds prose but no diff.
 *
 * @param {Array<string|null|undefined>} texts
 * @returns {string[]}
 */
export function pathsFromText(texts) {
    const out = [];
    for (const text of Array.isArray(texts) ? texts : []) {
        if (typeof text !== 'string') continue;
        for (const m of text.match(PATH_RE) || []) {
            const p = m.replace(/^\.\//, '');
            if (!out.includes(p)) out.push(p);
        }
    }
    return out;
}
