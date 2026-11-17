// apra-fleet-oomh.18: pins the BEHAVIOUR of scripts/check-ascii-only.mjs (added
// by apra-fleet-oomh.16), so the ratchet guarantee survives later edits
// instead of rotting into decoration. tests/ascii-only-gate.test.ts already
// covers "the repo as it stands passes" (assertion A below) as the root
// npm-test wiring proof; this file covers the remaining behavioural
// contract -- B through F -- with isolated fixtures.
//
// Fixtures are built from NUMERIC BYTE LITERALS (Buffer.from([...])), never
// literal non-ASCII characters, so this test file itself stays ASCII-only and
// passes the very gate it exercises -- the same technique
// packages/apra-fleet-se/apra-pm/test/install-binary-asset-copy.test.mjs uses
// for its binary fixture.

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    REPO_ROOT,
    runCheck,
    scanFile,
    evaluate,
    isBinaryFile,
} from '../scripts/check-ascii-only.mjs';

const tmpDirs: string[] = [];
function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ascii-gate-test-'));
    tmpDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tmpDirs.length) {
        const dir = tmpDirs.pop();
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
});

// U+2229 INTERSECTION, encoded as raw UTF-8 bytes (0xE2 0x88 0xA9) so no
// literal non-ASCII character appears in this source file.
const INTERSECTION_UTF8 = Buffer.from([0xe2, 0x88, 0xa9]);
const NEWLINE = Buffer.from('\n', 'ascii');

/** Builds a text fixture: `prefixLines` clean ASCII lines, then one line with
 * `violationCount` copies of INTERSECTION_UTF8 back-to-back. */
function buildFixtureBuffer(prefixLines: number, violationCount: number): Buffer {
    const parts: Buffer[] = [];
    for (let i = 0; i < prefixLines; i += 1) {
        parts.push(Buffer.from(`clean ascii line ${i}`, 'ascii'), NEWLINE);
    }
    const violLine: Buffer[] = [Buffer.from('x=', 'ascii')];
    for (let i = 0; i < violationCount; i += 1) violLine.push(INTERSECTION_UTF8);
    parts.push(Buffer.concat(violLine), NEWLINE);
    return Buffer.concat(parts);
}

describe('ascii-only gate behaviour (apra-fleet-oomh.18)', () => {
    // A. CLEAN TREE -- shares the same invariant tests/ascii-only-gate.test.ts
    // wires into root npm test; included here so this file documents the full
    // A-F contract in one place, per apra-fleet-oomh.18's own acceptance list.
    it('A. CLEAN TREE: the repository as it stands (baseline applied) exits ok', async () => {
        const result = await runCheck();
        expect(result.ok).toBe(true);
    });

    // B. NEW VIOLATION IN A CLEAN FILE
    it('B. a non-ASCII character in a file with no baseline entry fails and names file/line/column/codepoint', () => {
        const dir = makeTmpDir();
        const abs = path.join(dir, 'clean-file.ts');
        // 2 clean lines, then a 3rd line "x=<INTERSECTION>" -- violation at line 3, column 3.
        fs.writeFileSync(abs, buildFixtureBuffer(2, 1));

        const result = scanFile(abs, 'clean-file.ts');
        expect(result.binary).toBe(false);
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0]).toMatchObject({ line: 3, column: 3, codePoint: 0x2229 });

        const evalResult = evaluate([result], {});
        expect(evalResult.ok).toBe(false);
        expect(evalResult.findings).toHaveLength(1);
        expect(evalResult.findings[0]).toMatchObject({ kind: 'new-file', file: 'clean-file.ts', count: 1 });
    });

    // C. RATCHET -- a baselined file with ONE MORE violation than recorded fails.
    // REVERT PROOF (apra-fleet-oomh.18 acceptance #2): temporarily deleting the
    // `violations.length > baselineCount` branch in evaluate() (scripts/check-
    // ascii-only.mjs) and re-running this test in isolation produced:
    //   FAIL  tests/ascii-only-gate-behaviour.test.ts > ... > C. RATCHET ...
    //   AssertionError: expected true to be false // Object.is equality
    //     - Expected: false
    //     + Received: true
    //  at tests/ascii-only-gate-behaviour.test.ts:XX:XX (evalResult.ok assertion)
    // confirming this assertion actually exercises the ratchet branch rather
    // than passing vacuously. The branch was restored immediately after.
    it('C. RATCHET: a baselined file with one more violation than its recorded count fails', () => {
        const dir = makeTmpDir();
        const abs = path.join(dir, 'baselined-file.sh');
        // Baseline says this file has 2 violations; the fixture has 3.
        fs.writeFileSync(abs, buildFixtureBuffer(0, 3));

        const result = scanFile(abs, 'baselined-file.sh');
        expect(result.violations).toHaveLength(3);

        const evalResult = evaluate([result], { 'baselined-file.sh': 2 });
        expect(evalResult.ok).toBe(false);
        expect(evalResult.findings).toHaveLength(1);
        expect(evalResult.findings[0]).toMatchObject({
            kind: 'ratchet',
            file: 'baselined-file.sh',
            count: 3,
            baseline: 2,
        });
    });

    // D. BASELINE SHRINK -- a baselined file with FEWER violations than its
    // recorded count is reported, not silently accepted (the baseline must be
    // updated to match, so it can never go silently stale).
    it('D. BASELINE SHRINK: a baselined file with fewer violations than recorded is reported', () => {
        const dir = makeTmpDir();
        const abs = path.join(dir, 'shrunk-file.sh');
        // Baseline says this file has 3 violations; the fixture now has only 1.
        fs.writeFileSync(abs, buildFixtureBuffer(0, 1));

        const result = scanFile(abs, 'shrunk-file.sh');
        expect(result.violations).toHaveLength(1);

        const evalResult = evaluate([result], { 'shrunk-file.sh': 3 });
        expect(evalResult.ok).toBe(false);
        expect(evalResult.findings).toHaveLength(1);
        expect(evalResult.findings[0]).toMatchObject({ kind: 'shrink', file: 'shrunk-file.sh', count: 1, baseline: 3 });

        // A file that drops to ZERO violations is also reported (not silently
        // dropped from the baseline).
        const cleanedResult = { rel: 'shrunk-file.sh', binary: false, violations: [] };
        const evalCleaned = evaluate([cleanedResult], { 'shrunk-file.sh': 3 });
        expect(evalCleaned.ok).toBe(false);
        expect(evalCleaned.findings[0]).toMatchObject({ kind: 'shrink', file: 'shrunk-file.sh', count: 0, baseline: 3 });
    });

    // E. BINARY EXCLUSION -- drives the checker's REAL content-based exclusion
    // filter (a NUL byte in the first 8000 bytes), not a hardcoded extension
    // list: a fixture with a text-like name but binary content is still
    // excluded.
    it('E. a tracked-binary-like fixture (non-ASCII bytes plus a NUL byte) is excluded via the real filter, not by extension', () => {
        const dir = makeTmpDir();
        // A .txt extension deliberately, to prove exclusion is content-based:
        // 0x89 0x50 0x4e 0x47 (PNG-ish), then the INTERSECTION UTF-8 bytes,
        // then a NUL byte.
        const abs = path.join(dir, 'looks-like-text.txt');
        fs.writeFileSync(abs, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), INTERSECTION_UTF8, Buffer.from([0x00])]));

        expect(isBinaryFile(abs)).toBe(true);

        const result = scanFile(abs, 'looks-like-text.txt');
        expect(result.binary).toBe(true);
        expect(result.violations).toHaveLength(0);

        const evalResult = evaluate([result], {});
        expect(evalResult.ok).toBe(true);
    });

    // F. SELF-CHECK -- the checker script and its baseline file are themselves
    // ASCII-only (explicit-files mode applies no baseline, so any non-ASCII
    // byte in either file would fail this).
    it('F. the checker script and its baseline file pass their own ASCII-only check', async () => {
        const result = await runCheck({
            repoRoot: REPO_ROOT,
            files: ['scripts/check-ascii-only.mjs', 'scripts/ascii-baseline.mjs'],
        });
        expect(result.ok, JSON.stringify(result.findings)).toBe(true);
    });
});
