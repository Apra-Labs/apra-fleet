// Tests that every throw crossing a module boundary is a BridgeError.
//
// A single defect recurred in five modules across four waves: throws that
// bypass the BridgeError taxonomy and land in exitCodeFor's exit-1 catch-all,
// indistinguishable from an unrecognised crash. This test is the durable guard.
//
// WHY THIS WAS REWRITTEN
// ----------------------
// The first version of this guard matched a per-line regex for
// `throw new (Error|TypeError)(`. It was green while a live violation sat in
// the tree -- src/spool.mjs re-throws a raw `fs` error (EACCES/EPERM) straight
// out of the module, and the guard could not see it. A guard that reads as
// protection and provides none is worse than no guard, so the detector was
// rebuilt around three changes:
//
// 1. ALLOWLIST, NOT DENYLIST. Anything other than `throw new BridgeError(` is
//    a violation. The old denylist of two constructor names rotted the moment
//    someone reached for RangeError; inverting the test means it cannot rot.
// 2. BARE RE-THROWS ARE THROWS. `throw err;` is the most common real
//    violation. It is only safe when the statement is guarded by an
//    `instanceof BridgeError` check, which is recognised explicitly.
// 3. STATEMENT-SCOPED, NOT LINE-SCOPED. Throws are extracted as whole
//    statements from a comment- and string-blanked copy of the source, so a
//    throw spanning several lines is seen exactly like a one-liner.
//
// Rule: every throw in src/**/*.mjs must be either:
// 1. A BridgeError -- `throw new BridgeError(...)`, `throw someBridgeErrorFactory(...)`,
//    or a re-throw guarded by `instanceof BridgeError` (correct), or
// 2. An internal sentinel (caught by an enclosing handler, never crosses a
//    module boundary), listed in ALLOWED_RAW_THROWS with a reason.
//
// KNOWN BLIND SPOTS (stated, not papered over):
// - An error thrown by a CALLEE cannot be seen statically. A helper that
//   throws a raw Error and is called across a module boundary is invisible
//   here. Out of scope by design.
// - A factory call (`throw makeX()`) is accepted only when a same-file
//   definition of that name is found and a `new BridgeError(` appears within
//   the text window following it. A factory defined in another module, or one
//   whose BridgeError construction sits beyond the window, is reported as a
//   violation rather than silently accepted -- it fails loud, not open.
// - Dynamic throws (`throw errors[k]`, `throw await f()`) are classified as
//   violations; that is deliberate, they are unreviewable statically.
// - The comment/string blanker uses the usual prev-significant-character
//   heuristic to tell a regex literal from division. A pathological case
//   could mis-blank; it would surface as a spurious violation, never as a
//   missed one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const srcRoot = join(__dirname, '..', 'src');

/**
 * Allowlist of internal sentinels that are caught by an enclosing handler
 * and never cross a module boundary. Format:
 * {
 *   file:      POSIX-style path relative to src/ (see toPosix() -- entries are
 *              always written with forward slashes, on every platform),
 *   throwText: the whole throw STATEMENT, whitespace-collapsed,
 *   context:   the trimmed source line the statement starts on; this is what
 *              distinguishes two textually identical sentinels in one file,
 *   reason:    why it is safe.
 * }
 */
const ALLOWED_RAW_THROWS = [
  {
    file: 'supervisor-client.mjs',
    throwText: "throw new TypeError('fetch resolved to undefined');",
    context: "if (!res) throw new TypeError('fetch resolved to undefined');",
    reason: "Internal sentinel in request()'s own try/catch, converted to BridgeError(SUPERVISOR_UNAVAILABLE) before propagating",
  },
  {
    file: 'supervisor-client.mjs',
    throwText: "throw new TypeError('fetch resolved to undefined');",
    context: "if (!retryRes) throw new TypeError('fetch resolved to undefined');",
    reason: "Internal sentinel in request()'s own try/catch, converted to BridgeError(SUPERVISOR_UNAVAILABLE) before propagating",
  },
];

/**
 * Allowlist entries are compared against path.relative() output, which uses
 * backslashes on Windows. Normalising both sides to forward slashes means a
 * future NESTED entry ('adapters/index.mjs') matches on every platform rather
 * than mysteriously never matching on one of them.
 * @param {string} p
 * @returns {string}
 */
function toPosix(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Recursively walk src/ and collect all .mjs files.
 * @param {string} dir
 * @returns {string[]} array of absolute paths
 */
function walkFiles(dir) {
  const files = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      files.push(fullPath);
    }
  }
  return files;
}

const REGEX_PRECEDERS = new Set(['return', 'throw', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await']);

/**
 * Return a copy of `src` with comment bodies and string/template literal
 * bodies replaced by spaces, preserving length and every newline so that
 * offsets and line numbers still map onto the original text. Identifiers and
 * punctuation are untouched, so the result can be pattern-matched and
 * brace-counted without a quote or a `//` inside a message derailing it.
 * Template-literal `${...}` holes are left as live code, because a throw can
 * legitimately nest a call inside one.
 * @param {string} src
 * @returns {string}
 */
function blankNonCode(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  let prevSignificant = '';
  let prevWord = '';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const j = end === -1 ? src.length : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') j++;
        j++;
      }
      blank(i + 1, Math.min(j, src.length));
      i = Math.min(j + 1, src.length);
      prevSignificant = c;
      prevWord = '';
      continue;
    }
    if (c === '`') {
      // Enter a template literal: blank the literal chunks, keep ${...} code.
      let j = i + 1;
      let chunkStart = j;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') { blank(chunkStart, j); j++; break; }
        if (src[j] === '$' && src[j + 1] === '{') {
          blank(chunkStart, j);
          // Skip to the matching close brace, honouring nesting.
          let depth = 0;
          let k = j + 1;
          for (; k < src.length; k++) {
            if (src[k] === '{') depth++;
            else if (src[k] === '}') { depth--; if (depth === 0) break; }
          }
          j = k + 1;
          chunkStart = j;
          continue;
        }
        j++;
      }
      if (j > src.length) j = src.length;
      i = j;
      prevSignificant = '`';
      prevWord = '';
      continue;
    }
    if (c === '/') {
      // Regex literal vs division: decide from the previous significant token.
      const isRegex =
        prevSignificant === '' ||
        '(,=:[!&|?{};+-*%~^<>'.includes(prevSignificant) ||
        REGEX_PRECEDERS.has(prevWord);
      if (isRegex) {
        let j = i + 1;
        let inClass = false;
        while (j < src.length && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) break;
          j++;
        }
        blank(i + 1, Math.min(j, src.length));
        i = Math.min(j + 1, src.length);
        prevSignificant = '/';
        prevWord = '';
        continue;
      }
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      prevWord = src.slice(i, j);
      prevSignificant = src[j - 1];
      i = j;
      continue;
    }
    prevSignificant = c;
    prevWord = '';
    i++;
  }
  return out.join('');
}

/**
 * Collapse all whitespace runs to single spaces so a throw spread over three
 * lines compares equal to the same throw written on one.
 * @param {string} s
 * @returns {string}
 */
function normalise(s) {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Extract every throw STATEMENT in a file, spanning lines as needed.
 * Scans the blanked copy so `throw` inside a comment or a string is ignored,
 * then slices the ORIGINAL text for reporting.
 * @param {string} src
 * @returns {Array<{ line: number, statement: string, code: string, contextLine: string, guarded: boolean }>}
 */
function extractThrows(src) {
  const blanked = blankNonCode(src);
  const lines = src.split('\n');
  const found = [];
  const re = /\bthrow\b/g;
  let m;
  while ((m = re.exec(blanked)) !== null) {
    const start = m.index;
    const before = blanked[start - 1];
    if (before !== undefined && /[A-Za-z0-9_$.@]/.test(before)) continue;

    // Walk forward to the end of the statement: a `;` at depth 0, a newline
    // at depth 0 (ASI), or a closing brace at depth 0.
    let depth = 0;
    let j = start + 5;
    for (; j < blanked.length; j++) {
      const ch = blanked[j];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break;
        depth--;
      } else if (depth === 0 && ch === ';') { j++; break; }
      else if (depth === 0 && ch === '\n') {
        // Only ASI-terminate once an expression has actually begun.
        if (normalise(blanked.slice(start + 5, j)) !== '') break;
      }
    }
    const lineNo = src.slice(0, start).split('\n').length;
    found.push({
      line: lineNo,
      statement: normalise(src.slice(start, j)),
      code: normalise(blanked.slice(start, j)),
      contextLine: (lines[lineNo - 1] ?? '').trim(),
      // A re-throw is legitimate when the enclosing statement has already
      // established the value IS a BridgeError. Look at the text preceding
      // the throw on its own line plus the two lines above it -- that covers
      // `if (err instanceof BridgeError) throw err;` and its multi-line form.
      guarded: /instanceof\s+BridgeError/.test(
        lines.slice(Math.max(0, lineNo - 3), lineNo - 1).join('\n') +
          '\n' +
          (lines[lineNo - 1] ?? '').slice(0, start - (src.lastIndexOf('\n', start - 1) + 1)),
      ),
    });
  }
  return found;
}

/**
 * True when `name` is defined in this file and a `new BridgeError(` appears
 * in the text shortly after its definition -- i.e. it is a BridgeError
 * factory. Deliberately conservative: an unrecognised name is reported, never
 * waved through.
 * @param {string} src
 * @param {string} name
 * @returns {boolean}
 */
const FACTORY_WINDOW = 1500;
function isBridgeErrorFactory(src, name) {
  const defs = [
    new RegExp(`function\\s+${name}\\s*\\(`),
    new RegExp(`(?:const|let|var)\\s+${name}\\s*=`),
  ];
  for (const def of defs) {
    const hit = def.exec(src);
    if (hit) {
      const window = src.slice(hit.index, hit.index + FACTORY_WINDOW);
      if (/new\s+BridgeError\s*\(/.test(window)) return true;
    }
  }
  return false;
}

/**
 * Decide whether one throw statement honours the rule.
 * @param {string} src whole file, for factory resolution
 * @param {{ code: string, guarded: boolean }} t
 * @returns {null | string} null when compliant, else the reason it is not
 */
function violationReason(src, t) {
  // Strip the leading `throw` keyword to get the thrown expression.
  const expr = t.code.replace(/^throw\s*/, '').replace(/;$/, '').trim();

  if (/^new\s+BridgeError\s*\(/.test(expr)) return null;

  const ctor = /^new\s+([A-Za-z0-9_$.]+)\s*\(/.exec(expr);
  if (ctor) return `constructs ${ctor[1]}, not BridgeError`;

  // Bare re-throw of a binding: `throw err;`
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(expr)) {
    if (t.guarded) return null;
    return `bare re-throw of '${expr}' with no 'instanceof BridgeError' guard -- a foreign error (e.g. a raw fs EACCES) escapes the BridgeError taxonomy and collapses to exit 1`;
  }

  // Factory call: `throw unmappedError(status, text);`
  const call = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(expr);
  if (call) {
    if (isBridgeErrorFactory(src, call[1])) return null;
    return `throws the result of ${call[1]}(), which this file does not visibly construct as a BridgeError`;
  }

  return `throws a non-BridgeError expression (${expr})`;
}

test('error-rule: every throw crossing a module boundary is a BridgeError', () => {
  const files = walkFiles(srcRoot);
  const violations = [];

  for (const filePath of files) {
    const src = readFileSync(filePath, 'utf8');
    const relPath = toPosix(relative(srcRoot, filePath));

    for (const t of extractThrows(src)) {
      const reason = violationReason(src, t);
      if (reason === null) continue;

      const isAllowed = ALLOWED_RAW_THROWS.some(
        (entry) =>
          toPosix(entry.file) === relPath &&
          entry.throwText === t.statement &&
          entry.context === t.contextLine,
      );
      if (isAllowed) continue;

      violations.push({ file: relPath, line: t.line, text: t.statement, reason });
    }
  }

  if (violations.length > 0) {
    const messages = violations.map(
      (v) =>
        `${v.file}:${v.line}\n` +
        `  ${v.text}\n` +
        `  WHY: ${v.reason}\n` +
        `  RULE: every throw crossing a module boundary must be a BridgeError.\n` +
        `  If this is a dependency injection failure, use CONFIG_MISSING.\n` +
        `  If this is a malformed caller value, use CONFIG_INVALID.\n` +
        `  If this re-throws a caught error, either wrap it in a BridgeError (keeping\n` +
        `    the original as details.cause) or guard it with 'instanceof BridgeError'.\n` +
        `  If this is an internal sentinel caught by an enclosing handler, add it to\n` +
        `    ALLOWED_RAW_THROWS with file, throwText, context and a reason.`,
    );
    assert.fail(`Found ${violations.length} throw(s) that bypass BridgeError:\n\n${messages.join('\n\n')}`);
  }
});

test('error-rule: allowlist entries must still exist in source', () => {
  for (const entry of ALLOWED_RAW_THROWS) {
    const filePath = join(srcRoot, ...toPosix(entry.file).split('/'));
    const src = readFileSync(filePath, 'utf8');
    const found = extractThrows(src).some(
      (t) => t.statement === entry.throwText && t.contextLine === entry.context,
    );

    assert.ok(
      found,
      `Allowlist entry for ${entry.file} ("${entry.context}") no longer exists in source. ` +
        `Remove the stale allowlist entry and verify it was intentionally refactored.`,
    );
  }
});

// The detector itself is guarded: if these stop failing, the guard above has
// silently stopped guarding. Each case is one of the classes the old per-line
// regex could not see.
test('error-rule: detector catches each violation class', () => {
  const cases = [
    {
      name: 'bare re-throw',
      src: 'try { f(); } catch (err) {\n  throw err;\n}\n',
    },
    {
      name: 'non-enumerated built-in subclass',
      src: "throw new RangeError('out of range');\n",
    },
    {
      name: 'multi-line throw',
      src: "throw new Error(\n  'msg'\n);\n",
    },
    {
      name: 'thrown object literal',
      src: "throw { code: 'NOPE' };\n",
    },
    {
      name: 'unresolvable factory call',
      src: 'throw makeSomethingElse(1);\n',
    },
  ];
  for (const c of cases) {
    const found = extractThrows(c.src);
    assert.equal(found.length, 1, `${c.name}: expected exactly one throw statement`);
    assert.notEqual(
      violationReason(c.src, found[0]),
      null,
      `${c.name}: detector failed to flag it -- the guard is no longer guarding`,
    );
  }

  // ...and does NOT flag the compliant forms, so it stays usable.
  const ok = [
    "throw new BridgeError(BRIDGE_ERROR_CODES.USAGE, 'x');",
    'try { f(); } catch (err) {\n  if (err instanceof BridgeError) throw err;\n}\n',
    "function mk() { return new BridgeError(BRIDGE_ERROR_CODES.USAGE, 'x'); }\nthrow mk();\n",
    "// throw new Error('in a comment');\nthrow new BridgeError(BRIDGE_ERROR_CODES.USAGE, 'x');\n",
  ];
  for (const src of ok) {
    for (const t of extractThrows(src)) {
      assert.equal(violationReason(src, t), null, `false positive on: ${normalise(src)}`);
    }
  }
});
