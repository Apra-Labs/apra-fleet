import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// apra-fleet-j918.8.14: source-level guard for the three real-time test
// hazards apra-fleet-j918.8.13 fixed (serve-wiring-integration.test.mjs's
// poll ceiling, installed-supervisor.test.mjs's real 10s sleep, and
// slow-lane-log-persistence.test.mjs's four fixed-duration race fallbacks).
// A grep run once at fix time proves nothing about tomorrow: this test
// re-derives the same check from source on every run, so a regression
// (someone reintroducing a bare, un-cancelable `setTimeout(resolve, 900)`
// guess instead of an event/condition wait) turns this test red instead of
// silently reappearing.
//
// What counts as a hazard: a `setTimeout(callback, N)` call where N is a
// LITERAL number >= HAZARD_THRESHOLD_MS and the call's return value is NOT
// assigned to a variable. An assigned timer (`const timer = setTimeout(...)`)
// is a legitimate, cancelable fallback ceiling as long as it is paired with
// a `clearTimeout` somewhere in the same file (checked separately below) --
// the historical hazard was always a bare, fire-and-forget sleep with no way
// to short-circuit it early. A non-literal delay (an identifier like `ms`,
// `intervalMs`, `timeoutMs`) is a parameterized wait reviewed at its own call
// sites, not something this static scan can classify, so it is skipped.
const HAZARD_THRESHOLD_MS = 500; // the smallest of the four fixed hazards this bead fixed (500ms and 2000ms)

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Blanks out `//` line comments and `/* ... *\/` block comments (JSDoc
 * included), replacing each comment character with a space (newlines are
 * kept as-is so line numbers computed from the result still line up with
 * the original source). Without this, a doc comment merely DESCRIBING the
 * historical hazard (e.g. "a bare setTimeout(..., 10000) keeps the event
 * loop alive") would itself look like a hazard to a naive scanner -- exactly
 * the false positive installed-supervisor.test.mjs's own fix-description
 * comment triggers. String/template literal contents are left untouched
 * (skipped over, not scanned as comments) so a literal containing `//`
 * inside a string is not mistaken for a comment start.
 */
function stripComments(source) {
    let out = '';
    let i = 0;
    const n = source.length;
    while (i < n) {
        const two = source.slice(i, i + 2);
        if (two === '//') {
            while (i < n && source[i] !== '\n') { out += ' '; i++; }
            continue;
        }
        if (two === '/*') {
            out += '  ';
            i += 2;
            while (i < n && source.slice(i, i + 2) !== '*/') {
                out += source[i] === '\n' ? '\n' : ' ';
                i++;
            }
            out += '  ';
            i += 2;
            continue;
        }
        const ch = source[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            const quote = ch;
            out += ch;
            i++;
            while (i < n && source[i] !== quote) {
                if (source[i] === '\\' && i + 1 < n) { out += source[i] + source[i + 1]; i += 2; continue; }
                out += source[i];
                i++;
            }
            if (i < n) { out += source[i]; i++; }
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

const GUARDED_FILES = [
    'serve-wiring-integration.test.mjs',
    'installed-supervisor.test.mjs',
    'slow-lane-log-persistence.test.mjs',
];

/**
 * Finds the full, balanced argument-list text of the setTimeout(...) call
 * whose opening paren sits at `openParenIdx`.
 */
function extractBalancedArgs(source, openParenIdx) {
    let depth = 0;
    for (let i = openParenIdx; i < source.length; i++) {
        const ch = source[i];
        if (ch === '(') depth++;
        else if (ch === ')') {
            depth--;
            if (depth === 0) return source.slice(openParenIdx + 1, i);
        }
    }
    throw new Error(`unbalanced parens scanning setTimeout( call starting at index ${openParenIdx}`);
}

/** Splits an argument-list string on top-level commas only (ignores commas nested inside (), [], {}). */
function splitTopLevelArgs(argsText) {
    const args = [];
    let depth = 0;
    let current = '';
    for (const ch of argsText) {
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        if (ch === ')' || ch === ']' || ch === '}') depth--;
        if (ch === ',' && depth === 0) {
            args.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    if (current.trim() !== '') args.push(current);
    return args.map((s) => s.trim());
}

/**
 * Scans `source` for every setTimeout(...) call and returns the ones that
 * look like the historical bare-sleep hazard: not assigned to a variable,
 * with a literal numeric delay >= HAZARD_THRESHOLD_MS.
 */
function findBareLongSleeps(source) {
    const violations = [];
    const callRe = /setTimeout\s*\(/g;
    let m;
    while ((m = callRe.exec(source)) !== null) {
        const callStart = m.index;
        const openParenIdx = callRe.lastIndex - 1;
        const argsText = extractBalancedArgs(source, openParenIdx);
        const args = splitTopLevelArgs(argsText);
        if (args.length < 2) continue; // setTimeout always takes (callback, delay, ...)
        const delayArg = args[1];
        if (!/^[0-9][0-9_]*$/.test(delayArg)) continue; // not a literal number -- parameterized, skip
        const delayMs = Number(delayArg.replace(/_/g, ''));
        if (delayMs < HAZARD_THRESHOLD_MS) continue; // short poll tick, not a hazard

        const precedingText = source.slice(Math.max(0, callStart - 80), callStart);
        const assignedToVariable = /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*$/.test(precedingText);
        if (!assignedToVariable) {
            const lineNumber = source.slice(0, callStart).split('\n').length;
            violations.push({ delayMs, lineNumber, snippet: source.slice(callStart, callStart + 60).replace(/\s+/g, ' ') });
        }
    }
    return violations;
}

describe('timing-hazard guard: no bare, un-cancelable multi-hundred-ms sleep in the three apra-fleet-j918.8.13 files', () => {
    for (const fileName of GUARDED_FILES) {
        test(`${fileName} contains no bare setTimeout(callback, >=${HAZARD_THRESHOLD_MS}ms) sleep`, () => {
            const filePath = path.join(__dirname, fileName);
            const source = stripComments(fs.readFileSync(filePath, 'utf8'));
            const violations = findBareLongSleeps(source);
            assert.deepEqual(
                violations,
                [],
                `${fileName} contains a bare, un-cancelable setTimeout(...) sleep of >= ${HAZARD_THRESHOLD_MS}ms -- ` +
                `this is the exact hazard shape apra-fleet-j918.8.13 removed (a fixed-duration guess instead of an ` +
                `event/condition wait). Replace it with an event-driven wait (see waitForExit()/waitForChildSettled() ` +
                `in installed-supervisor.test.mjs / slow-lane-log-persistence.test.mjs) or a condition-poll helper. ` +
                `Violations: ${JSON.stringify(violations)}`,
            );
        });
    }

    test('falsification: the guard is not vacuous -- it flags the exact historical hazard shape when reintroduced', () => {
        const reintroduced = `
async function example(child) {
    // the exact historical shape this guard exists to catch
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    await new Promise((resolve) => {
        setTimeout(resolve, 2000); // Timeout after 2s
    });
}
`;
        const violations = findBareLongSleeps(reintroduced);
        assert.equal(violations.length, 2, `expected the scanner to flag both reintroduced bare sleeps, got: ${JSON.stringify(violations)}`);
        assert.deepEqual(violations.map((v) => v.delayMs).sort((a, b) => a - b), [500, 2000]);
    });

    test('falsification: an assigned, cancelable fallback timer (the correct pattern) is NOT flagged', () => {
        const correctPattern = `
function waitForExit(child, timeoutMs) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => { resolve(); }, 10000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
}
`;
        const violations = findBareLongSleeps(correctPattern);
        assert.deepEqual(violations, [], `an assigned, clearTimeout-paired fallback ceiling must not be flagged, got: ${JSON.stringify(violations)}`);
    });

    test('every assigned setTimeout(...) fallback timer in the three guarded files is paired with a clearTimeout call in the same file', () => {
        // A cancelable timer that is assigned but never actually cleared
        // anywhere degrades back to a de facto bare sleep -- this closes
        // that loophole in the assignment-based exemption above.
        for (const fileName of GUARDED_FILES) {
            const filePath = path.join(__dirname, fileName);
            const source = stripComments(fs.readFileSync(filePath, 'utf8'));
            const assignedTimerNames = [...source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*setTimeout\s*\(/g)].map((m) => m[1]);
            for (const name of assignedTimerNames) {
                const clearRe = new RegExp(`clearTimeout\\s*\\(\\s*${name}\\s*\\)`);
                assert.ok(clearRe.test(source), `${fileName} assigns a setTimeout(...) result to '${name}' but never clearTimeout(${name})s it -- this degrades to an uncancelable sleep`);
            }
        }
    });
});
