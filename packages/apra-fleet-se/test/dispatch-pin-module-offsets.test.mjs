import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import {
    moduleSetSource,
    moduleSetSourceWithOffsets,
    resolveModuleLocation,
    formatSiteLocations,
    findCallSites,
} from './helpers/dispatch-pin-scanner.mjs';

// =============================================================================
// apra-fleet-3swo.28 -- dispatch-pin-scanner.mjs's moduleSetSource() joins
// several fleet-sprint modules into one scannable string (see that file's
// header), so every site.line the pin tests derive from it is an offset into
// the CONCATENATION, not a line in any real file. Before this bead, every pin
// failure message hard-coded a 'runner.js:' label, which was only correct
// because runner.js happens to be DISPATCH_LADDER_MODULES[0] today.
//
// This file pins moduleSetSourceWithOffsets()/resolveModuleLocation()/
// formatSiteLocations() -- the machinery that resolves a concatenation-
// relative line back to the real {file, line} it came from -- against
// SYNTHESIZED two-file fixtures, so the resolver's correctness does not
// depend on runner.js's current shape.
// =============================================================================

describe('dispatch-pin-scanner module offsets', () => {
    const tempDirs = [];
    after(() => {
        for (const dir of tempDirs) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    /** Writes `contents` to a temp file and returns its absolute path. */
    function writeTempModule(name, contents) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-pin-offsets-'));
        tempDirs.push(dir);
        const file = path.join(dir, name);
        fs.writeFileSync(file, contents);
        return file;
    }

    test('a line in the FIRST file of a two-file set resolves to that file, same line as today', () => {
        const fileA = writeTempModule('module-a.mjs', 'const a = 1;\nfunction findMeInA() {}\nconst z = 3;\n');
        const fileB = writeTempModule('module-b.mjs', 'const b = 1;\nfunction findMeInB() {}\n');

        const { source, offsets } = moduleSetSourceWithOffsets([fileA, fileB]);
        const sites = findCallSites(source, 'findMeInA');
        assert.strictEqual(sites.length, 1, 'sanity: exactly one call site for findMeInA in the synthesized source');

        // findMeInA is declared on line 2 of module-a.mjs. It is not itself a
        // call (it's a function declaration), so instead assert directly that
        // the concatenation's line 2 (module A's own line 2, since A is
        // first) resolves to {file: 'module-a.mjs', line: 2} -- unchanged
        // from what a naive "it's always runner.js" label would have reported
        // for the first module.
        const resolved = resolveModuleLocation(offsets, 2);
        assert.deepStrictEqual(resolved, { file: 'module-a.mjs', line: 2 });
    });

    test('a line in the SECOND file resolves to that file, with a line number relative to ITS OWN start', () => {
        const fileA = writeTempModule('module-a.mjs', 'const a = 1;\nconst a2 = 2;\nconst a3 = 3;\n');
        const fileB = writeTempModule('module-b.mjs', 'const b = 1;\nfunction findMeInB() {}\n');

        const { offsets } = moduleSetSourceWithOffsets([fileA, fileB]);
        // module-a.mjs is 3 real lines plus the trailing-newline phantom line
        // (4 total per .split('\n').length), so module-b.mjs starts at
        // concatenation line 5. Its own line 2 (findMeInB) is therefore
        // concatenation line 6.
        const resolved = resolveModuleLocation(offsets, 6);
        assert.deepStrictEqual(
            resolved,
            { file: 'module-b.mjs', line: 2 },
            'a concatenation-relative line inside the second module must resolve to that module with a line number ' +
            'relative to its own start, not to the concatenation as a whole.'
        );
    });

    test('FALSIFIABILITY: reversing the module order changes which file a given site resolves to', () => {
        const fileA = writeTempModule('module-a.mjs', 'const a = 1;\nfunction sharedAnchor() {}\n');
        const fileB = writeTempModule('module-b.mjs', 'const b = 1;\nconst b2 = 2;\nfunction sharedAnchor() {}\n');

        const forward = moduleSetSourceWithOffsets([fileA, fileB]);
        const forwardSites = findCallSites(forward.source, 'sharedAnchor', { excludeDeclaration: false });
        // sharedAnchor is declared, not called, in both files -- use the
        // declaration lines directly via offsets instead, matching this
        // suite's other assertions: module-a's declaration is its own line 2
        // (concatenation line 2, since A is first); module-b's declaration is
        // its own line 3.
        const forwardModuleALine2 = resolveModuleLocation(forward.offsets, 2);
        assert.deepStrictEqual(forwardModuleALine2, { file: 'module-a.mjs', line: 2 });

        const reversed = moduleSetSourceWithOffsets([fileB, fileA]);
        // With order reversed, concatenation line 2 now falls inside
        // module-b.mjs (which is now first), not module-a.mjs.
        const reversedLine2 = resolveModuleLocation(reversed.offsets, 2);
        assert.deepStrictEqual(
            reversedLine2,
            { file: 'module-b.mjs', line: 2 },
            'reversing DISPATCH_LADDER_MODULES order must change the reported file for a given concatenation-relative line.'
        );
        assert.notStrictEqual(
            forwardModuleALine2.file,
            reversedLine2.file,
            'the resolved file for the same concatenation-relative line must differ once module order is reversed.'
        );
    });

    test('formatSiteLocations() formats a mixed-file site list as file:line pairs', () => {
        const fileA = writeTempModule('module-a.mjs', 'const a = 1;\nconst a2 = 2;\n');
        const fileB = writeTempModule('module-b.mjs', 'const b = 1;\nconst b2 = 2;\n');
        const { offsets } = moduleSetSourceWithOffsets([fileA, fileB]);
        // module-a.mjs contributes 3 lines (2 real + trailing-newline
        // phantom), so module-b.mjs starts at concatenation line 4.
        const formatted = formatSiteLocations(offsets, [{ line: 1 }, { line: 4 }]);
        assert.strictEqual(formatted, 'module-a.mjs:1, module-b.mjs:1');
    });

    test('moduleSetSource() (no offsets) is unchanged: same concatenated text as moduleSetSourceWithOffsets().source', () => {
        const fileA = writeTempModule('module-a.mjs', 'const a = 1;\n');
        const fileB = writeTempModule('module-b.mjs', 'const b = 1;\n');
        assert.strictEqual(moduleSetSource([fileA, fileB]), moduleSetSourceWithOffsets([fileA, fileB]).source);
    });
});
