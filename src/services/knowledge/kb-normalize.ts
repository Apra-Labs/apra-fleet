// KB identifier normalizer (design D2a). Identifiers are normalized at INDEX
// time and query text goes through the SAME pipeline, so a query for a split,
// stemmed or path-segment form finds an entry written with the compound form:
//
//   getMemberSplitRead              -> getmembersplitread get member split read
//   HTTPKbProvider                  -> httpkbprovider http kb provid(er)
//   get_member_split / kb-self      -> getmembersplit get member split / kbself kb self
//   src/services/knowledge/kb-self.ts -> src servic knowledg kbself kb self ts
//
// Pipeline (shared by normalizeForIndex and normalizeQueryTerms):
//   1. NFKC-normalize, then split the text into segments on anything that is
//      not a Unicode letter, mark or digit, '_' or '-' (so paths split on '/',
//      '\' and '.', and prose punctuation drops out);
//   2. split each segment on '_' / '-' runs; an ASCII-only piece is then split
//      on camelCase, PascalCase and acronym-run boundaries, while a piece
//      holding any non-ASCII letter (Gruesse with an umlaut, Japanese text) is
//      kept whole, lowercased -- case splitting is only meaningful for ASCII
//      identifiers, and the FTS5 unicode61 tokenizer folds the rest the same
//      way at index and query time;
//   3. lowercase, then stem every part with a dependency-free Porter stemmer;
//   4. when a segment split into more than one part, ALSO keep the original
//      identifier (lowercased, separators removed) so an exact identifier
//      query still matches it as one token.
//
// Every emitted token is lowercase letters/marks/digits only ([a-z0-9]+ for
// ASCII input), so the output is safe to store in an FTS5 column and, via
// orJoinFtsTerms (the ONE sanitization point -- each
// token is still quoted there), safe to feed to FTS5 MATCH. Pure, synchronous,
// no I/O.

import { orJoinFtsTerms } from './audn.js';

/**
 * Bumped whenever the token stream this module emits changes, so an index
 * built by an older normalizer is detected and rebuilt (kb index metadata).
 */
export const KB_NORMALIZER_VERSION = 2;

const SEGMENT_SPLIT = /[^\p{L}\p{M}\p{N}_-]+/u;
const ASCII_PIECE = /^[\x00-\x7F]*$/;
const SEPARATOR_SPLIT = /[_-]+/;
// Acronym run followed by a capitalized word (HTTP|Kb), a capitalized or
// lowercase word with trailing digits, a bare upper run, or a digit run.
const CASE_PARTS = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+[0-9]*|[A-Z]+[0-9]*|[0-9]+/g;

/** Split one identifier-like segment into its lowercase parts (unstemmed). */
export function splitIdentifier(segment: string): string[] {
  const parts: string[] = [];
  for (const piece of segment.split(SEPARATOR_SPLIT)) {
    if (!piece) continue;
    if (!ASCII_PIECE.test(piece)) {
      parts.push(piece.toLowerCase());
      continue;
    }
    const caseParts = piece.match(CASE_PARTS);
    if (!caseParts) continue;
    for (const p of caseParts) parts.push(p.toLowerCase());
  }
  return parts;
}

/**
 * Tokens for one segment: the stemmed parts, preceded by the compact original
 * identifier when the segment is compound. Order is stable; duplicates within
 * a segment are kept out.
 */
function segmentTokens(segment: string): string[] {
  const parts = splitIdentifier(segment);
  if (parts.length === 0) return [];
  const out: string[] = [];
  if (parts.length > 1) out.push(parts.join(''));
  for (const p of parts) {
    const s = stem(p);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** Normalized token list for arbitrary text (index or query side). */
export function normalizeTokens(text: string): string[] {
  const out: string[] = [];
  for (const segment of text.normalize('NFKC').split(SEGMENT_SPLIT)) {
    if (!segment) continue;
    out.push(...segmentTokens(segment));
  }
  return out;
}

/**
 * Index-side normalization: the space-joined token stream for `text`.
 * Store this (not the raw text) in the keyword index.
 */
export function normalizeForIndex(text: string): string {
  return normalizeTokens(text).join(' ');
}

/**
 * Query-side normalization of free text: every distinct normalized token,
 * OR-joined through orJoinFtsTerms (each token quoted), ready for FTS5
 * MATCH. Empty string when nothing usable remains.
 */
export function normalizeQueryTerms(text: string): string {
  return orJoinFtsTerms(Array.from(new Set(normalizeTokens(text))));
}

/**
 * Query-side normalization of DISCRETE terms (e.g. symbols, file paths): the
 * tokens of one term stay together (AND within a term, as ftsSafeTerm does)
 * and terms are OR-joined. Because the index holds both the compact
 * identifier and its parts, a term matches every entry naming it.
 */
export function normalizeQueryTermList(terms: string[]): string {
  return orJoinFtsTerms(
    terms.map(t => Array.from(new Set(normalizeTokens(t))).join(' ')).filter(t => t.length > 0)
  );
}

// ---------------------------------------------------------------------------
// Porter stemmer (M.F. Porter, 1980), dependency-free. Input is a lowercase
// [a-z0-9] token; tokens shorter than 3 chars or containing digits are
// returned unchanged.
// ---------------------------------------------------------------------------

function isConsonant(w: string, i: number): boolean {
  const c = w[i];
  if (c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u') return false;
  if (c === 'y') return i === 0 ? true : !isConsonant(w, i - 1);
  return true;
}

/** Porter's m(): the number of VC sequences in w[0..end). */
function measure(w: string, end: number): number {
  let n = 0;
  let i = 0;
  while (i < end && isConsonant(w, i)) i++;
  while (i < end) {
    while (i < end && !isConsonant(w, i)) i++;
    if (i >= end) break;
    n++;
    while (i < end && isConsonant(w, i)) i++;
  }
  return n;
}

function hasVowel(w: string, end: number): boolean {
  for (let i = 0; i < end; i++) if (!isConsonant(w, i)) return true;
  return false;
}

function endsDoubleConsonant(w: string): boolean {
  const n = w.length;
  return n >= 2 && w[n - 1] === w[n - 2] && isConsonant(w, n - 1);
}

/** *o: stem ends cvc where the final c is not w, x or y. */
function endsCvc(w: string, end: number): boolean {
  if (end < 3) return false;
  if (!isConsonant(w, end - 1) || isConsonant(w, end - 2) || !isConsonant(w, end - 3)) return false;
  const c = w[end - 1];
  return c !== 'w' && c !== 'x' && c !== 'y';
}

function replaceSuffix(w: string, suffix: string, repl: string, minMeasure: number): string | null {
  if (!w.endsWith(suffix)) return null;
  const stemLen = w.length - suffix.length;
  if (measure(w, stemLen) > minMeasure) return w.slice(0, stemLen) + repl;
  return w;
}

const STEP2: Array<[string, string]> = [
  ['ational', 'ate'], ['tional', 'tion'], ['enci', 'ence'], ['anci', 'ance'],
  ['izer', 'ize'], ['bli', 'ble'], ['alli', 'al'], ['entli', 'ent'], ['eli', 'e'],
  ['ousli', 'ous'], ['ization', 'ize'], ['ation', 'ate'], ['ator', 'ate'],
  ['alism', 'al'], ['iveness', 'ive'], ['fulness', 'ful'], ['ousness', 'ous'],
  ['aliti', 'al'], ['iviti', 'ive'], ['biliti', 'ble'], ['logi', 'log'],
];
const STEP3: Array<[string, string]> = [
  ['icate', 'ic'], ['ative', ''], ['alize', 'al'], ['iciti', 'ic'],
  ['ical', 'ic'], ['ful', ''], ['ness', ''],
];
const STEP4 = [
  'al', 'ance', 'ence', 'er', 'ic', 'able', 'ible', 'ant', 'ement', 'ment',
  'ent', 'ion', 'ou', 'ism', 'ate', 'iti', 'ous', 'ive', 'ize',
];

function applyList(w: string, list: Array<[string, string]>, minMeasure: number): string {
  // Porter matches the LONGEST suffix in the list.
  let best: [string, string] | null = null;
  for (const pair of list) {
    if (w.endsWith(pair[0]) && (!best || pair[0].length > best[0].length)) best = pair;
  }
  if (!best) return w;
  return replaceSuffix(w, best[0], best[1], minMeasure) ?? w;
}

/** Porter stem of one lowercase token. */
export function stem(word: string): string {
  if (word.length < 3 || /[^a-z]/.test(word)) return word;
  let w = word;

  // Step 1a
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies')) w = w.slice(0, -2);
  else if (w.endsWith('ss')) { /* keep */ }
  else if (w.endsWith('s')) w = w.slice(0, -1);

  // Step 1b
  let step1bExtra = false;
  if (w.endsWith('eed')) {
    if (measure(w, w.length - 3) > 0) w = w.slice(0, -1);
  } else if (w.endsWith('ed') && hasVowel(w, w.length - 2)) {
    w = w.slice(0, -2);
    step1bExtra = true;
  } else if (w.endsWith('ing') && hasVowel(w, w.length - 3)) {
    w = w.slice(0, -3);
    step1bExtra = true;
  }
  if (step1bExtra) {
    if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) {
      w += 'e';
    } else if (endsDoubleConsonant(w) && !/[lsz]$/.test(w)) {
      w = w.slice(0, -1);
    } else if (measure(w, w.length) === 1 && endsCvc(w, w.length)) {
      w += 'e';
    }
  }

  // Step 1c
  if (w.endsWith('y') && hasVowel(w, w.length - 1)) w = w.slice(0, -1) + 'i';

  // Steps 2 and 3 (m > 0)
  w = applyList(w, STEP2, 0);
  w = applyList(w, STEP3, 0);

  // Step 4 (m > 1)
  let best4: string | null = null;
  for (const s of STEP4) {
    if (w.endsWith(s) && (!best4 || s.length > best4.length)) best4 = s;
  }
  if (best4) {
    const stemLen = w.length - best4.length;
    if (measure(w, stemLen) > 1) {
      if (best4 === 'ion') {
        const prev = w[stemLen - 1];
        if (prev === 's' || prev === 't') w = w.slice(0, stemLen);
      } else {
        w = w.slice(0, stemLen);
      }
    }
  }

  // Step 5a
  if (w.endsWith('e')) {
    const m = measure(w, w.length - 1);
    if (m > 1 || (m === 1 && !endsCvc(w, w.length - 1))) w = w.slice(0, -1);
  }
  // Step 5b
  if (measure(w, w.length) > 1 && endsDoubleConsonant(w) && w.endsWith('l')) w = w.slice(0, -1);

  return w;
}
