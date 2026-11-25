// Line-preserving, parser-driven comment stripper for shipped JavaScript.
//
// Used at pack time by scripts/pack-stripped.mjs on a STAGED COPY of the
// package; never run on repo files in place. Shipped files keep their exact
// line numbers (stack traces still map to the repo source); column positions
// may shift.
//
// Comment ranges come from the TypeScript PARSER-built tree: every token of
// ts.createSourceFile(...) is visited and its leading/trailing comment ranges
// are collected. A bare ts.createScanner is deliberately not used -- without
// parser-driven re-scans it cannot tell a regex literal from division or a
// template-literal close brace from a block brace. No regex runs over source
// text to find comments.
//
// Blanking rules:
//   - single-line block comment -> ONE space (so `let/**/x` stays two tokens);
//   - `//` comment -> removed up to (not including) the line terminator;
//   - multi-line block comment -> only its original line terminators remain
//     (CRLF included), preserving line numbers and ASI behaviour;
//   - whitespace directly before a removed comment that ends its line is
//     trimmed; no other whitespace or code byte changes.
// Kept: the shebang, legal comments (block comments starting `/*!` or
// containing @license / @preserve / @copyright), and KEEP_COMMENT_PATTERNS.

import ts from 'typescript';

// src/cli/install.ts reads these two markers out of the shipped
// dist/workflows/auto-sprint.js at install time to write cost.js, so stripping
// them would change runtime behaviour. Anchored at the start of the comment
// text so ordinary prose that merely mentions a marker is still stripped.
export const KEEP_COMMENT_PATTERNS = [
  /^\/\/\s*PURE_FUNCTIONS_BEGIN\b/,
  /^\/\/\s*PURE_FUNCTIONS_END\b/,
];

const LEGAL_RE = /@license|@preserve|@copyright/;

// ECMAScript LineTerminator: LF, CR, LINE SEPARATOR (U+2028), PARAGRAPH
// SEPARATOR (U+2029). Built with fromCharCode so this file stays ASCII.
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const LINE_SPLIT_RE = new RegExp('\r\n|[\r\n' + LS + PS + ']');

function isLineTerminatorChar(ch) {
  return ch === '\n' || ch === '\r' || ch === LS || ch === PS;
}

/**
 * Number of lines in `s` as ECMAScript counts them (CRLF is one terminator).
 * Shared by the pack script and the tests so they agree with the stripper.
 * @param {string} s
 * @returns {number}
 */
export function countLines(s) {
  return s.split(LINE_SPLIT_RE).length;
}

function shouldKeep(text, range) {
  const body = text.slice(range.pos, range.end);
  if (range.pos === 0 && body.startsWith('#!')) return true;
  if (range.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
    if (body.startsWith('/*!') || LEGAL_RE.test(body)) return true;
  }
  return KEEP_COMMENT_PATTERNS.some((re) => re.test(body));
}

function collectCommentRanges(sf, text) {
  const byPos = new Map();
  const add = (ranges) => {
    if (!ranges) return;
    for (const r of ranges) byPos.set(r.pos, r);
  };
  const stack = [sf];
  while (stack.length) {
    const node = stack.pop();
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) continue;
    const children = node.getChildren(sf);
    if (children.length === 0) {
      // A token: comments in its leading trivia, and same-line trailing ones.
      add(ts.getLeadingCommentRanges(text, node.getFullStart()));
      add(ts.getTrailingCommentRanges(text, node.end));
    } else {
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
  }
  return [...byPos.values()].sort((a, b) => a.pos - b.pos);
}

/**
 * @param {string} sourceText
 * @param {{ fileName?: string }} [opts]
 * @returns {string}
 */
export function stripComments(sourceText, opts = {}) {
  const fileName = opts.fileName ?? 'input.js';
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const ranges = collectCommentRanges(sf, sourceText);

  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    if (shouldKeep(sourceText, range)) continue;
    const body = sourceText.slice(range.pos, range.end);
    out += sourceText.slice(cursor, range.pos);
    cursor = range.end;

    let replacement;
    if (range.kind === ts.SyntaxKind.SingleLineCommentTrivia) {
      replacement = '';
    } else {
      let terminators = '';
      for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === '\r' && body[i + 1] === '\n') {
          terminators += '\r\n';
          i++;
        } else if (isLineTerminatorChar(ch)) {
          terminators += ch;
        }
      }
      replacement = terminators === '' ? ' ' : terminators;
    }

    // Does the comment end its line (only blanks until a terminator / EOF)?
    let j = range.end;
    while (j < sourceText.length && (sourceText[j] === ' ' || sourceText[j] === '\t')) j++;
    const endsLine = j >= sourceText.length || isLineTerminatorChar(sourceText[j]);
    if (endsLine) {
      if (replacement === ' ') replacement = '';
      // Trim blanks left in front of the removed comment. Only trailing
      // whitespace of the already-emitted text is touched, never code.
      let k = out.length;
      while (k > 0 && (out[k - 1] === ' ' || out[k - 1] === '\t')) k--;
      if (k !== out.length) out = out.slice(0, k);
    }
    out += replacement;
  }
  out += sourceText.slice(cursor);
  return out;
}
