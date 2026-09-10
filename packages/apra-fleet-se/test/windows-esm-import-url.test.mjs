import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBalancedCall } from '../fleet-sprint/dispatch-safety-guard.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEST_DIR = __dirname;
const SELF_BASENAME = path.basename(__filename);

// =============================================================================
// apra-fleet-3swo.36.2 -- Windows ESM dynamic-import guard.
//
// PR 469 Windows-only CI regression (apra-fleet-3swo.36): a raw absolute
// filesystem path handed straight to the default ESM loader's dynamic
// import() works on POSIX but throws on win32 (ERR_UNSUPPORTED_ESM_URL_SCHEME,
// received protocol 'c:') because Node parses the path's drive letter as a
// URL scheme. The sibling impl task (apra-fleet-3swo.36.1) fixed the six
// call sites this reproduced on -- phase0-seams-facade.test.mjs (140, 147,
// 156) and phase1-leaf-facade-completeness.test.mjs (236, 242, 258) -- by
// wrapping the sandbox path in pathToFileURL(...).href before every dynamic
// import(). This test locks that invariant in so it cannot silently
// regress from any OTHER test file, and so a reintroduced raw-path call
// site is caught on non-Windows CI legs instead of surfacing only on
// windows-latest, which is exactly how the original regression passed two
// green non-Windows legs and shipped.
//
// findRawPathDynamicImportSpecifiers() factors the detection into a
// predicate over source TEXT: it never imports or executes a scanned
// module, so it cannot itself trip the Windows loader or run sprint code.
// It is exercised both against the real test/*.test.mjs tree and against
// inline fixture strings below, so the guard is proven non-vacuous (it can
// actually fail) rather than trusted on faith.
// =============================================================================

/**
 * True if `col` (0-based index into `lineText`) sits inside a same-line
 * '...', "...", or `...` literal that opened earlier on the SAME line --
 * i.e. an odd count of unescaped quote/backtick characters of the
 * currently-open type precede it. Backticks ARE tracked here (unlike
 * fleet-sprint/dispatch-safety-guard.mjs's isInsideSameLineString, which
 * deliberately skips them for its own command()/agent() invariant): this
 * guard's own false-positive case is prose like the literal text
 * "`unresolved import(s) found`" inside an assertion-message template
 * literal, which is common across this test suite's failure messages.
 */
function isInsideSameLineQuotedText(lineText, col) {
    let quote = null;
    for (let i = 0; i < col; i++) {
        const ch = lineText[i];
        if (ch === '\\') { i++; continue; }
        if (quote) {
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch;
        }
    }
    return quote !== null;
}

/** A full-line JSDoc/line-comment body, e.g. `// ...` or a `*` continuation line. */
function isCommentLine(lineText) {
    const t = lineText.trim();
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
}

/**
 * Returns the expression text inside the FIRST `${...}` interpolation of a
 * template literal's inner text (i.e. `inner` with the surrounding
 * backticks already stripped, starting exactly at `${`), respecting nested
 * `{`/`}` so an interpolation containing an object literal is not cut
 * short.
 */
function extractFirstInterpolationExpr(inner) {
    let depth = 0;
    let i = 2; // past the leading '${'
    for (; i < inner.length; i++) {
        const c = inner[i];
        if (c === '{') depth++;
        else if (c === '}') {
            if (depth === 0) return inner.slice(2, i);
            depth--;
        }
    }
    return inner.slice(2);
}

/**
 * True if `expr` is a file-URL-safe way to name an import specifier:
 * it flows through pathToFileURL(...) or ends in .href. A bare identifier
 * that is neither is resolved one level back to its nearest preceding
 * `const`/`let`/`var` declaration in the same file (the common
 * "build the URL once, import(theVariable) later" shape), and THAT
 * expression is checked instead.
 */
function isFileUrlSafe(expr, src, importIdx) {
    const trimmed = expr.trim();
    if (trimmed.includes('pathToFileURL') || /\.href\s*$/.test(trimmed)) return true;

    const identMatch = trimmed.match(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
    if (identMatch) {
        const ident = identMatch[0];
        const declRe = new RegExp(`\\b(?:const|let|var)\\s+${ident}\\s*=([\\s\\S]*?);`, 'g');
        let dm;
        let lastRhs = null;
        while ((dm = declRe.exec(src)) !== null) {
            if (dm.index < importIdx) lastRhs = dm[1];
        }
        if (lastRhs !== null) {
            return lastRhs.includes('pathToFileURL') || /\.href\s*$/.test(lastRhs.trim());
        }
    }
    return false;
}

/**
 * True if a dynamic import()'s specifier argument text (the raw text
 * between its call's parens, already trimmed) is Windows-safe:
 *
 *   - a plain '...'/"..." string literal (relative OR bare, e.g.
 *     '../fleet-sprint/contracts.mjs' or 'node:fs') is ALWAYS safe -- both
 *     are resolved by the ESM loader identically on every platform.
 *   - a template literal that begins with LITERAL text before any `${`
 *     (e.g. `` `../fleet-sprint/contracts.mjs?cache=${Date.now()}` ``) is
 *     safe -- its leading segment is a real relative/bare specifier, not a
 *     raw absolute path.
 *   - anything else -- a template literal that opens straight into an
 *     interpolation (`` `${...}` ``), or a bare expression/identifier with
 *     no quotes at all -- must resolve through pathToFileURL()/.href to be
 *     safe (see isFileUrlSafe above).
 */
function isSafeSpecifier(argText, src, importIdx) {
    if (/^'(?:[^'\\]|\\.)*'$/.test(argText) || /^"(?:[^"\\]|\\.)*"$/.test(argText)) return true;

    if (argText.startsWith('`') && argText.endsWith('`')) {
        const inner = argText.slice(1, -1);
        if (inner.indexOf('${') !== 0) return true; // literal text precedes any interpolation
        const expr = extractFirstInterpolationExpr(inner);
        return isFileUrlSafe(expr, src, importIdx);
    }

    return isFileUrlSafe(argText, src, importIdx);
}

/**
 * Scans `src` for dynamic `import(...)` call sites and returns
 * `{ line, specifier }` for every one whose specifier is not Windows-safe
 * per isSafeSpecifier() above. `line` is 1-based. Never imports or
 * evaluates any part of `src` -- source-text scan only.
 */
export function findRawPathDynamicImportSpecifiers(src) {
    const lines = src.split('\n');
    const lineStarts = [];
    let offset = 0;
    for (const l of lines) {
        lineStarts.push(offset);
        offset += l.length + 1; // +1 for the '\n' stripped by split()
    }
    function lineNumberForIndex(idx) {
        let ln = 0;
        for (let i = 0; i < lineStarts.length; i++) {
            if (lineStarts[i] > idx) break;
            ln = i;
        }
        return ln + 1;
    }

    // Matches `import(` NOT preceded by a `.` or word character (so
    // `dynamicImport(` or `.import(` are never mistaken for the keyword).
    const callRe = /(?<![.\w])import\s*\(/g;
    const offending = [];
    let m;
    while ((m = callRe.exec(src)) !== null) {
        const openParenIdx = m.index + m[0].length - 1; // index of the '(' itself
        const line = lineNumberForIndex(m.index);
        const lineText = lines[line - 1] || '';
        if (isCommentLine(lineText)) continue;
        const col = m.index - lineStarts[line - 1];
        if (isInsideSameLineQuotedText(lineText, col)) continue;

        const callText = extractBalancedCall(src, openParenIdx); // "(...)" inclusive
        const argText = callText.slice(1, -1).trim();
        if (isSafeSpecifier(argText, src, m.index)) continue;

        offending.push({ line, specifier: argText });
    }
    return offending;
}

describe('Windows ESM dynamic-import guard: no test/*.test.mjs hands the loader a raw filesystem path (apra-fleet-3swo.36.2)', () => {
    test('no test/*.test.mjs file dynamically imports a raw filesystem-path specifier', () => {
        const files = fs.readdirSync(TEST_DIR)
            .filter((f) => f.endsWith('.test.mjs'))
            // Exclude this guard's own file: several of its inline fixture
            // strings below deliberately contain the exact offending shape
            // this guard flags (that is the point of the falsification
            // tests) -- scanning this file against itself would flag its
            // own test DATA, not a real call site, which is not the
            // production test tree this guard exists to protect.
            .filter((f) => f !== SELF_BASENAME);

        const offending = [];
        for (const f of files) {
            const filePath = path.join(TEST_DIR, f);
            const src = fs.readFileSync(filePath, 'utf8');
            for (const v of findRawPathDynamicImportSpecifiers(src)) {
                offending.push({ file: f, ...v });
            }
        }

        assert.deepStrictEqual(
            offending,
            [],
            `Found ${offending.length} dynamic import() call site(s) with a raw filesystem-path specifier ` +
            '(fails on Windows: ERR_UNSUPPORTED_ESM_URL_SCHEME, received protocol c:). Wrap the path in ' +
            'pathToFileURL(path).href before the dynamic import:\n' +
            offending.map((o) => `  ${o.file}:${o.line} -> ${o.specifier}`).join('\n')
        );
    });

    test('flags an inline fixture with a raw-path dynamic import (the pre-fix shape, proves the guard is non-vacuous)', () => {
        const fixtureSrc = [
            'async function loadSandboxModule(sandboxRunnerPath) {',
            '    return await import(`${sandboxRunnerPath}?facade-sanity=${Date.now()}-${Math.random()}`);',
            '}',
        ].join('\n');
        const offending = findRawPathDynamicImportSpecifiers(fixtureSrc);
        assert.strictEqual(offending.length, 1, `expected exactly one violation, got: ${JSON.stringify(offending)}`);
        assert.strictEqual(offending[0].line, 2, `expected the violation on line 2, got: ${JSON.stringify(offending[0])}`);
        assert.ok(
            offending[0].specifier.includes('sandboxRunnerPath'),
            `violation must name the offending specifier text, got: ${JSON.stringify(offending[0])}`
        );
    });

    test('does not flag a relative-specifier dynamic import (false-positive boundary)', () => {
        const src = "const m = await import('../fleet-sprint/contracts.mjs');";
        assert.deepStrictEqual(findRawPathDynamicImportSpecifiers(src), []);
    });

    test('does not flag a node: builtin dynamic import (false-positive boundary)', () => {
        const src = "const m = await import('node:fs');";
        assert.deepStrictEqual(findRawPathDynamicImportSpecifiers(src), []);
    });

    test('does not flag a dynamic import whose specifier is wrapped in pathToFileURL().href (the fixed shape)', () => {
        const src = 'const m = await import(`${pathToFileURL(sandboxRunnerPath).href}?facade-sanity=${Date.now()}`);';
        assert.deepStrictEqual(findRawPathDynamicImportSpecifiers(src), []);
    });

    test('does not flag a dynamic import of a bare identifier that resolves back to a pathToFileURL().href declaration', () => {
        const src = [
            "const backlogUrl = `${pathToFileURL(path.join(supervisorDir, 'backlog.mjs')).href}?cache=${cacheBust}`;",
            'const backlogMod = await import(backlogUrl);',
        ].join('\n');
        assert.deepStrictEqual(findRawPathDynamicImportSpecifiers(src), []);
    });

    test('does not flag prose mentioning import(...) inside comments or same-line string/template literals', () => {
        const src = [
            "// see `import('...')` with a string literal, not a raw path",
            "assert.deepEqual(problems, [], `unresolved import(s) found:\\n${problems.join('\\n')}`);",
            "assert.ok(true, 'relative/absolute import(s) do not resolve to a file inside the installed tree');",
        ].join('\n');
        assert.deepStrictEqual(findRawPathDynamicImportSpecifiers(src), []);
    });
});
