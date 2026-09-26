// apra-fleet-i9ag.3.2: coverage for mount-prefix.mjs -- the per-request
// resolution of the console proxy's mount-path header into either a usable
// app-path prefix or '' (serve-direct), and the mountHref() helper every
// emitted app-path on the supervisor's pages is built through.
//
// The header is UNTRUSTED NETWORK INPUT (see that module's doc comment): its
// value is interpolated verbatim into href="..." attributes and into
// single-quoted JS string literals inside the page's inline <script> blocks, so
// the hostile-value table below is the security boundary, not a nicety. Every
// rejected value must resolve to '' -- never a partially-sanitized survivor.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    MOUNT_PATH_HEADER,
    sanitizeMountPrefix,
    resolveMountPrefix,
    mountHref,
} from '../src/supervisor/mount-prefix.mjs';

describe('mount-prefix -- MOUNT_PATH_HEADER', () => {
    test('is the exact wire name src/console/proxy.ts sets (the cross-package contract)', () => {
        // Asserted literally on purpose: this string IS the contract with the
        // console's /ext/<id> proxy (apra-fleet-i9ag.3.1), which exports the
        // same constant on its side. A silent rename here degrades the embedded
        // dashboard to serve-direct paths with no error anywhere.
        assert.equal(MOUNT_PATH_HEADER, 'x-apra-fleet-mount-path');
        assert.equal(MOUNT_PATH_HEADER, MOUNT_PATH_HEADER.toLowerCase());
    });
});

describe('mount-prefix -- sanitizeMountPrefix() accepts only safe mount paths', () => {
    test('a plain single-segment mount path passes through verbatim', () => {
        assert.equal(sanitizeMountPrefix('/ext/se'), '/ext/se');
        assert.equal(sanitizeMountPrefix('/ext'), '/ext');
        assert.equal(sanitizeMountPrefix('/ext/se-2'), '/ext/se-2');
        assert.equal(sanitizeMountPrefix('/ext/a.b_c~d'), '/ext/a.b_c~d');
        assert.equal(sanitizeMountPrefix('/ext/se%20x'), '/ext/se%20x');
    });

    test('exactly one trailing slash is normalised away (so mountHref never doubles it)', () => {
        assert.equal(sanitizeMountPrefix('/ext/se/'), '/ext/se');
        assert.equal(sanitizeMountPrefix('/ext/'), '/ext');
    });

    test("'/' alone carries no mount information -> '' (the serve-direct case)", () => {
        assert.equal(sanitizeMountPrefix('/'), '');
    });
});

describe('mount-prefix -- sanitizeMountPrefix() fails closed on hostile/malformed input', () => {
    // Every entry here must yield '' -- i.e. the page renders exactly as it
    // does with no header at all. Grouped as one table so a new rejection rule
    // is one line, and so the acceptance criterion's named hostile values
    // ('..', '../x', '//evil.example', 'http://evil.example', '', missing) are
    // all visibly present.
    const REJECTED = [
        ['missing (undefined)', undefined],
        ['null', null],
        ['empty string', ''],
        ['non-string (number)', 42],
        ['non-string (object)', { toString: () => '/ext/se' }],
        ['bare dot-dot', '..'],
        ['relative traversal', '../x'],
        ['rooted traversal', '/../x'],
        ['traversal mid-path', '/ext/../admin'],
        ['single dot segment', '/ext/./se'],
        ['trailing dot-dot', '/ext/..'],
        ['percent-encoded traversal', '/ext/%2e%2e/admin'],
        ['percent-encoded traversal (upper case)', '/ext/%2E%2E'],
        ['protocol-relative host', '//evil.example'],
        ['protocol-relative host with path', '//evil.example/ext/se'],
        ['absolute http url', 'http://evil.example'],
        ['absolute https url', 'https://evil.example/ext/se'],
        ['javascript scheme', 'javascript:alert(1)'],
        ['relative path', 'ext/se'],
        ['empty inner segment', '/ext//se'],
        ['query string', '/ext/se?x=1'],
        ['fragment', '/ext/se#x'],
        ['leading whitespace', ' /ext/se'],
        ['trailing whitespace', '/ext/se '],
        ['embedded newline', '/ext/se\nX-Injected: 1'],
        ['single quote (JS literal break-out)', "/ext/se'+alert(1)+'"],
        ['double quote (attribute break-out)', '/ext/se" onload="alert(1)'],
        ['angle bracket (tag break-out)', '/ext/se</script>'],
        ['backslash (browser reads as slash)', '\\\\evil.example'],
        ['rooted backslash', '/ext\\se'],
        ['colon/authority smuggling', '/ext:80/se'],
    ];

    for (const [label, value] of REJECTED) {
        test(`${label} -> '' (serve direct)`, () => {
            assert.equal(sanitizeMountPrefix(value), '');
        });
    }
});

describe('mount-prefix -- resolveMountPrefix()', () => {
    test('reads the header off a Node-style request object', () => {
        assert.equal(resolveMountPrefix({ headers: { [MOUNT_PATH_HEADER]: '/ext/se' } }), '/ext/se');
    });

    test('also accepts a bare headers bag (callers may pass either)', () => {
        assert.equal(resolveMountPrefix({ [MOUNT_PATH_HEADER]: '/ext/se' }), '/ext/se');
    });

    test('header name matching is case-insensitive (non-Node callers may not lower-case)', () => {
        assert.equal(resolveMountPrefix({ headers: { 'X-Apra-Fleet-Mount-Path': '/ext/se' } }), '/ext/se');
    });

    test("no header, no headers object, null, non-object -> '' (serve direct)", () => {
        assert.equal(resolveMountPrefix({ headers: {} }), '');
        assert.equal(resolveMountPrefix({}), '');
        assert.equal(resolveMountPrefix(null), '');
        assert.equal(resolveMountPrefix(undefined), '');
        assert.equal(resolveMountPrefix('/ext/se'), '');
    });

    test("a repeated header (array value) is ambiguous provenance -> ''", () => {
        assert.equal(resolveMountPrefix({ headers: { [MOUNT_PATH_HEADER]: ['/ext/se', '/ext/evil'] } }), '');
    });

    test('a hostile header value is rejected through the same fail-closed path', () => {
        assert.equal(resolveMountPrefix({ headers: { [MOUNT_PATH_HEADER]: '//evil.example' } }), '');
        assert.equal(resolveMountPrefix({ headers: { [MOUNT_PATH_HEADER]: '../x' } }), '');
        assert.equal(resolveMountPrefix({ headers: { [MOUNT_PATH_HEADER]: 'http://evil.example' } }), '');
    });
});

describe('mount-prefix -- mountHref()', () => {
    test("no prefix leaves an app-path byte-identical (the direct-open case must not regress)", () => {
        for (const path of ['/state', '/events', '/api/sprints', '/sprints/s-1/live', '/supervisor/log']) {
            assert.equal(mountHref('', path), path);
            assert.equal(mountHref(undefined, path), path);
            assert.equal(mountHref(null, path), path);
        }
    });

    test('a prefix is applied exactly once, with no doubled or missing slash', () => {
        assert.equal(mountHref('/ext/se', '/state'), '/ext/se/state');
        assert.equal(mountHref('/ext/se', '/sprints/s-1/live'), '/ext/se/sprints/s-1/live');
        assert.equal(mountHref('/ext/se', '/api/reservations/'), '/ext/se/api/reservations/');
    });

    test('an already-prefixed path is never prefixed twice', () => {
        assert.equal(mountHref('/ext/se', '/ext/se/state'), '/ext/se/state');
        assert.equal(mountHref('/ext/se', '/ext/se'), '/ext/se');
        // Not a prefix MATCH, only a string-prefix coincidence: '/ext/seat'
        // is a different mount point's path, so it must still be prefixed.
        assert.equal(mountHref('/ext/se', '/ext/seat'), '/ext/se/ext/seat');
    });

    test('a non-absolute path is returned untouched (it never resolved against the root)', () => {
        assert.equal(mountHref('/ext/se', 'relative/path'), 'relative/path');
        assert.equal(mountHref('/ext/se', '#anchor'), '#anchor');
        assert.equal(mountHref('/ext/se', 'https://example.com/x'), 'https://example.com/x');
        assert.equal(mountHref('/ext/se', ''), '');
        assert.equal(mountHref('/ext/se', undefined), '');
    });

    test('is ES5-only source, so it survives being shipped to the browser via .toString()', () => {
        // dashboard.mjs embeds mountHref.toString() into the live-refresh page
        // script, where renderSprintSection() calls it. A `const`/arrow/
        // template-literal rewrite would still pass every assertion above while
        // breaking nothing in Node -- and the embedded copy must stay readable
        // by the oldest browser the console supports, so pin the shape.
        const source = mountHref.toString();
        assert.match(source, /^function mountHref\(mountPrefix, appPath\)/);
        assert.doesNotMatch(source, /=>|`|\bconst\b|\blet\b/);
    });
});
