import { test, describe } from 'node:test';
import assert from 'node:assert';

import { objectLiteralFor } from './helpers/dispatch-pin-scanner.mjs';

// =============================================================================
// apra-fleet-3swo.6.18 -- objectLiteralFor() (test/helpers/dispatch-pin-
// scanner.mjs) walks brace depth from a `const NAME = { ... }` declaration to
// find that literal's real closing brace. Until commit bbe9f346 it skipped
// string literals but not COMMENTS, so an apostrophe inside a prose comment
// (e.g. "the member's tier") opened a phantom string that swallowed real code
// -- including the literal's own closing brace -- and desynced the walk. That
// was silent for months: on the pre-fix tree the desync happened to still
// recover the right keys for FIXED_ROLE_TIER by luck, and only turned visibly
// red once an unrelated extraction elsewhere in this codebase shifted
// comment-apostrophe parity.
//
// This file pins the FIX -- objectLiteralFor's `//` and `/* */` comment-skip
// branches -- against SYNTHESIZED source strings only, never against any
// real module's source text, so the property holds regardless of the
// current shape of the tree. objectLiteralFor takes a plain `src` string,
// so nothing here touches the filesystem: no temp directory, no fixture
// file, nothing left behind by running this suite.
// =============================================================================

describe('objectLiteralFor: comment-blindness fix (apra-fleet-3swo.6.18)', () => {
    test('(1) a line comment containing an apostrophe does not desync the walk', () => {
        const src = `
const FIXED_ROLE_TIER = {
    doer: 'standard', // the member's tier pin
    reviewer: 'premium',
};
const AFTER_LITERAL = 'sentinel-should-not-appear';
`;
        const result = objectLiteralFor(src, 'FIXED_ROLE_TIER');
        assert.notStrictEqual(result, null, 'must not be null -- a comment apostrophe must not hide the real closing brace');
        assert.ok(result.startsWith('{') && result.endsWith('}'), 'must return exactly the braced literal text');
        assert.ok(result.includes("doer: 'standard'"), 'must retain the entry declared before the comment');
        assert.ok(result.includes("reviewer: 'premium'"), 'must retain the entry declared after the comment');
        assert.ok(!result.includes('AFTER_LITERAL') && !result.includes('sentinel-should-not-appear'),
            'must stop at the literal\'s own closing brace, not run past it into later source');
    });

    test('(2) a block comment containing an apostrophe does not desync the walk', () => {
        const src = `
const ROLE_TABLE = {
    /* the reviewer's default tier */
    reviewer: 'standard',
    doer: 'premium',
};
const AFTER_LITERAL = 'sentinel-should-not-appear';
`;
        const result = objectLiteralFor(src, 'ROLE_TABLE');
        assert.notStrictEqual(result, null, 'must not be null -- a block-comment apostrophe must not hide the real closing brace');
        assert.ok(result.startsWith('{') && result.endsWith('}'), 'must return exactly the braced literal text');
        assert.ok(result.includes("reviewer: 'standard'"), 'must retain the entry declared after the block comment');
        assert.ok(result.includes("doer: 'premium'"), 'must retain the entry declared after that');
        assert.ok(!result.includes('AFTER_LITERAL') && !result.includes('sentinel-should-not-appear'),
            'must stop at the literal\'s own closing brace, not run past it into later source');
    });

    test('(3) a closing brace that appears only inside a comment does not terminate the literal early', () => {
        const src = `
const ROLE_TABLE = {
    // note: this is not a closing brace: }
    reviewer: 'standard',
    doer: 'premium',
};
`;
        const result = objectLiteralFor(src, 'ROLE_TABLE');
        assert.notStrictEqual(result, null, 'must not be null');
        // If the '}' inside the comment were mistaken for the literal's real
        // closing brace, the returned text would end right after that comment
        // and never contain the entries declared below it.
        assert.ok(result.includes("reviewer: 'standard'"),
            'the entry after the comment-only brace must still be inside the returned literal');
        assert.ok(result.includes("doer: 'premium'"),
            'the entry after the comment-only brace must still be inside the returned literal');
        assert.ok(result.endsWith('}'),
            'the returned text itself is the object literal (braces only), not the trailing statement semicolon');
    });

    test('(4) a real apostrophe inside a string VALUE is still handled as a string, not a comment', () => {
        // The escaped apostrophe below produces the literal two-character
        // sequence \' in the analyzed source -- a genuine single-quoted
        // string containing an apostrophe, e.g. label: 'member\'s own tier'.
        const src = `
const ROLE_TABLE = {
    label: 'member\\'s own tier',
    reviewer: 'standard',
};
const AFTER_LITERAL = 'sentinel-should-not-appear';
`;
        const result = objectLiteralFor(src, 'ROLE_TABLE');
        assert.notStrictEqual(result, null, 'must not be null -- an apostrophe inside a real string value must not derail the walk');
        assert.ok(result.startsWith('{') && result.endsWith('}'), 'must return exactly the braced literal text');
        assert.ok(result.includes("member\\'s own tier"), 'the string value with its escaped apostrophe must be preserved verbatim');
        assert.ok(result.includes("reviewer: 'standard'"), 'must retain the entry declared after the string value');
        assert.ok(!result.includes('AFTER_LITERAL') && !result.includes('sentinel-should-not-appear'),
            'must stop at the literal\'s own closing brace, not run past it into later source');
    });
});
