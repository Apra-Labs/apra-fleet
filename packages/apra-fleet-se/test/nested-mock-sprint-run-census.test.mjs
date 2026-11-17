import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { skipStringLiteral, balancedCallRange } from './helpers/balanced-call-scanner.mjs';

// =============================================================================
// apra-fleet-j918.3.3 -- CENSUS: exactly ONE nested full mock-sprint run exists
// in this package, and it is phase3-dispatch-engine-completeness.test.mjs.
//
// THE COST THIS GUARDS. The mock-sprint files are the most expensive thing in
// the suite. `npm test` already runs them once directly (the package's own
// test glob). Every additional gate that spawns a nested `node --test` child
// over the SAME set runs them again, in full, inside that one `npm test`. At
// its worst this package paid for three passes: the direct one, phase1's
// section (4), and phase3's section (7) -- with a fourth, phase4's meta-check,
// asserting ABOUT phase1's copy rather than running its own. phase1's was
// deleted as a strictly weaker duplicate of phase3's (which caps the nested
// child's concurrency, sandboxes its TMPDIR, and derives a backend-aware
// budget), and phase4's meta-check went with it.
//
// WHY A COMMITTED GUARD RATHER THAN A ONE-OFF GREP. A deletion is a fact about
// one commit; this is a fact that has to keep holding. Re-adding a second pass
// costs minutes of every future `npm test` while looking, in review, like a
// perfectly reasonable "make this gate stand on its own" change -- which is
// how the package got to three passes in the first place. The census makes the
// second pass fail loudly at the moment it is added, naming both sites.
//
// WHAT THIS IS NOT. It does not assert that phase3's run is CORRECT (phase3
// asserts its own file count, its child's real pass count, and its sandbox
// hygiene), and it does not forbid nested spawns generally -- the golden-
// transcript pair is deliberately spawned by two gates and is out of scope
// here. It counts nested runs over the mock-sprint SET, nothing else.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = __dirname;
const SE_DIR = path.join(__dirname, '..');
const EXPECTED_SURVIVOR = 'phase3-dispatch-engine-completeness.test.mjs';

/**
 * Strips line and block comments while preserving string and template-literal
 * contents verbatim, and reports where those preserved strings ended up.
 *
 * Both halves matter here. These gate files carry long prose headers that name
 * the mock-sprint suite and quote spawn arg lists (this file included), so a
 * census over raw text would report phantom spawn sites forever. And the
 * quoted arg lists inside STRING literals -- including the ones this file's
 * own scanner-falsification case constructs -- are not calls either, so the
 * returned ranges let the scanner ignore any callee name that lives inside a
 * string. A regex-only comment stripper would additionally corrupt any string
 * containing '//', which this package's sources do have.
 *
 * @returns {{ code: string, stringRanges: Array<[number, number]> }}
 */
function stripComments(src) {
    let out = '';
    const stringRanges = [];
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (ch === '"' || ch === "'" || ch === '`') {
            const end = skipStringLiteral(src, i, ch);
            stringRanges.push([out.length, out.length + (end - i)]);
            out += src.slice(i, end + 1);
            i = end;
            continue;
        }
        if (ch === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            out += '\n';
            continue;
        }
        if (ch === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            i = end === -1 ? src.length : end + 1;
            out += ' ';
            continue;
        }
        out += ch;
    }
    return { code: out, stringRanges };
}

/** Every .mjs file under test/, recursively, excluding fixtures/ (data, not code). */
function allTestSources(dir = TEST_DIR, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'fixtures' || entry.name === 'node_modules') continue;
            allTestSources(full, acc);
        } else if (entry.name.endsWith('.mjs')) {
            acc.push(full);
        }
    }
    return acc;
}

// Anything that starts a child process, plus this package's own nested-suite
// wrapper. A new spawn helper that matched none of these would slip past the
// census -- which is why assertion (1) also pins that the census still FINDS
// the one site it already knows about: if this list stops matching phase3's
// call, the census reports zero sites and fails just as loudly as it would on
// a second one.
const SPAWN_CALLEE = /\b(?:execFileSync|execFile|execSync|exec|spawnSync|spawn|forkSync|fork|runNestedSuite)\s*\(/g;

// The argument text must show BOTH that a `node --test` child is being
// launched AND that the mock-sprint file set is what it is pointed at. Four
// spellings of "the mock-sprint set" are recognised: the readdir prefix filter
// phase3 uses, a literal path or glob under test/, any identifier carrying the
// suite name (e.g. `...mockSprintFiles.map(...)`), and the suite label itself.
const LAUNCHES_NODE_TEST = /['"`]--test['"`]/;
const NAMES_MOCK_SPRINT_SET = [
    /startsWith\(\s*['"`]mock-sprint-/,
    /['"`][^'"`]*\btest[/\\]mock-sprint-/,
    /\bmock[_-]?sprint\w*/i,
];

// A spawn does not have to name the suite in its own argument list: the file
// set is just as often built one statement earlier and passed in by variable
// (`const files = readdirSync(...).filter(n => n.startsWith('mock-sprint-'))`
// ... `execFileSync(node, ['--test', ...files])`). One hop of resolution --
// which bindings in this file are assigned from an expression that expands the
// mock-sprint set -- is what makes the census see that form too. Without it the
// scanner would only recognise the shape phase3 happens to use today, and (1)
// would stay green through exactly the regression it exists to catch.
const MOCK_SPRINT_BOUND_NAME = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]*)/g;

function bindingsNamingMockSprintSet(code) {
    const names = new Set();
    MOCK_SPRINT_BOUND_NAME.lastIndex = 0;
    let m;
    while ((m = MOCK_SPRINT_BOUND_NAME.exec(code)) !== null) {
        if (NAMES_MOCK_SPRINT_SET.some((re) => re.test(m[2]))) names.add(m[1]);
    }
    return names;
}

/**
 * Returns every call site in `file` that spawns a nested `node --test` child
 * over the mock-sprint file set, as { file, line, snippet }.
 */
function findNestedMockSprintSpawnSites(file) {
    const { code, stringRanges } = stripComments(fs.readFileSync(file, 'utf8'));
    const insideString = (idx) => stringRanges.some(([s, e]) => idx > s && idx < e);
    const mockSprintBindings = bindingsNamingMockSprintSet(code);
    const sites = [];
    SPAWN_CALLEE.lastIndex = 0;
    let m;
    while ((m = SPAWN_CALLEE.exec(code)) !== null) {
        if (insideString(m.index)) continue;
        const openParen = m.index + m[0].length - 1;
        const [start, end] = balancedCallRange(code, openParen);
        const args = code.slice(start, end + 1);
        if (!LAUNCHES_NODE_TEST.test(args)) continue;
        const namesSetDirectly = NAMES_MOCK_SPRINT_SET.some((re) => re.test(args));
        const namesSetByBinding = [...mockSprintBindings].some((n) => new RegExp(`\\b${n}\\b`).test(args));
        if (!namesSetDirectly && !namesSetByBinding) continue;
        sites.push({
            file: path.relative(SE_DIR, file),
            line: code.slice(0, m.index).split('\n').length,
            snippet: args.replace(/\s+/g, ' ').slice(0, 200),
        });
    }
    return sites;
}

/** Writes `contents` to a throwaway .mjs in its own temp dir and scans it. */
function scanSyntheticSource(contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-sprint-census-probe-'));
    try {
        const file = path.join(dir, 'probe.mjs');
        fs.writeFileSync(file, contents);
        return findNestedMockSprintSpawnSites(file);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe('census: exactly one nested full mock-sprint run remains in this package', () => {
    test('(1) exactly one nested mock-sprint spawn site exists, and it is phase3', () => {
        const sites = allTestSources().flatMap(findNestedMockSprintSpawnSites);
        const described = sites.map((s) => `${s.file}:${s.line} -> ${s.snippet}`).join('\n  ');

        assert.equal(
            sites.length,
            1,
            `expected EXACTLY ONE nested mock-sprint spawn site under test/, found ${sites.length}:\n  ${described}\n` +
            'More than one means a single `npm test` runs the whole mock-sprint suite over again on top of the ' +
            'direct pass the package glob already does. Fewer than one means the surviving run was deleted (or its ' +
            'call shape drifted past this scanner) and nothing spawns the suite nested at all.',
        );
        assert.equal(
            path.basename(sites[0].file),
            EXPECTED_SURVIVOR,
            `the surviving nested mock-sprint run must live in ${EXPECTED_SURVIVOR} -- the copy that caps its ` +
            'child\'s concurrency, sandboxes its TMPDIR and derives a backend-aware budget. Found it at ' +
            `${sites[0].file}:${sites[0].line} instead.`,
        );
    });

    test('(1b) the scanner is not vacuous: it sees the known site and a differently-written second one, and ignores prose', () => {
        // Without this, (1) could hold for the wrong reason. A scanner that
        // matched nothing at all would report 0 and be caught by (1) -- but a
        // scanner that only matched phase3's exact present-day formatting
        // would keep reporting 1 while a second run written any other way went
        // uncounted, and (1) would stay green through the very regression it
        // exists to catch. Both directions are exercised here against source
        // text synthesized in a temp dir, so proving the census can see a
        // second run costs neither a committed second run nor a repo artifact.
        const phase3 = path.join(TEST_DIR, EXPECTED_SURVIVOR);
        assert.equal(
            findNestedMockSprintSpawnSites(phase3).length,
            1,
            `the scanner must find the known surviving site inside ${EXPECTED_SURVIVOR}`,
        );

        const viaReaddirFilter = scanSyntheticSource([
            "import { execFileSync } from 'node:child_process';",
            "const files = fs.readdirSync('test').filter((n) => n.startsWith('mock-sprint-'));",
            "execFileSync(process.execPath, ['--test', ...files], { cwd: '.' });",
            '',
        ].join('\n'));
        assert.equal(viaReaddirFilter.length, 1, 'a readdir-filtered second nested mock-sprint spawn must be counted');

        const viaLiteralPaths = scanSyntheticSource([
            "import { spawnSync } from 'node:child_process';",
            "spawnSync(process.execPath, ['--test', 'test/mock-sprint-happy-path.test.mjs'], { cwd: '.' });",
            '',
        ].join('\n'));
        assert.equal(viaLiteralPaths.length, 1, 'a literal-path second nested mock-sprint spawn must be counted');

        const commentedOut = scanSyntheticSource([
            '// This file used to do:',
            "//   execFileSync(node, ['--test', ...mockSprintFiles]);",
            '/* and also',
            "   runNestedSuite(SUITE, ['--test', 'test/mock-sprint-a.test.mjs']); */",
            'export const nothing = true;',
            '',
        ].join('\n'));
        assert.deepEqual(commentedOut, [], 'commented-out spawn text must not be counted as a live spawn site');

        const quotedInAString = scanSyntheticSource([
            "export const doc = \"execFileSync(node, ['--test', 'test/mock-sprint-a.test.mjs'])\";",
            '',
        ].join('\n'));
        assert.deepEqual(quotedInAString, [], 'a spawn quoted inside a string literal must not be counted');
    });

    test('(2) phase4 carries no source-text meta-check about phase1 and the mock-sprint suite', () => {
        const phase4 = path.join(TEST_DIR, 'phase4-move-only-completeness.test.mjs');
        const { code } = stripComments(fs.readFileSync(phase4, 'utf8'));
        assert.ok(
            !/phase1-leaf-facade-completeness/.test(code),
            'phase4 must not reference phase1-leaf-facade-completeness.test.mjs in executable code. Asserting ABOUT ' +
            "another gate's source text is how a fourth mock-sprint pass was kept nominally 'covered' without " +
            'running anything -- and such a check goes silently vacuous the moment that other file is reformatted.',
        );
        assert.ok(
            !/readFileSync\s*\(\s*PHASE1\b/.test(code),
            "phase4 must not read the phase1 gate's source text",
        );
        // phase4 legitimately reads the mock-sprint-happy-path.jsonl FIXTURE;
        // what it must not do is spawn the suite or assert about who spawns it.
        assert.deepEqual(
            findNestedMockSprintSpawnSites(phase4),
            [],
            'phase4 must not spawn the mock-sprint suite either',
        );
    });
});
