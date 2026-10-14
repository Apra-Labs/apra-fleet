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
 */
export const KB_ROLE_HINT_SOURCES = Object.freeze({
    planner: ['goals', 'beadTitles'],
    'plan-reviewer': ['goals', 'beadTitles'],
    doer: ['beadTitles', 'laneFiles'],
    reviewer: ['beadTitles', 'diffFiles'],
    deployer: ['deployTargets', 'testFiles'],
    'integ-test-runner': ['deployTargets', 'testFiles'],
    'regression-test-runner': ['deployTargets', 'testFiles'],
    harvester: ['diffFiles', 'closedBeadTitles'],
});

/** Context fields whose values are file paths (-> hint_modules + basename terms) vs prose. */
const FILE_FIELDS = new Set(['laneFiles', 'diffFiles', 'testFiles', 'deployTargets']);

/**
 * Build the KB read hints for one role's dispatch.
 *
 * @param {string} role
 * @param {{
 *   goals?: string[]|string, beadTitles?: Array<string|{title?: string}>,
 *   closedBeadTitles?: Array<string|{title?: string}>,
 *   laneFiles?: string[], diffFiles?: string[], deployTargets?: string[], testFiles?: string[],
 *   beadIds?: string[],
 * }} [ctx]
 * @returns {{ role: string, terms: string[], hintSymbols: string[], hintModules: string[] }}
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
    const terms = cleanQueryTerms([...prose, ...fileTerms], { knownIds });
    return { role, terms, hintSymbols, hintModules };
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
