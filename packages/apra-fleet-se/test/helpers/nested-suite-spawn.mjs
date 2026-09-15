// =============================================================================
// apra-fleet-3swo.53: shared nested-suite spawn-result handling, extracted out
// of phase1-leaf-facade-completeness.test.mjs and phase3-dispatch-engine-
// completeness.test.mjs. Both files spawn nested `node --test` children via
// execFileSync and need to turn the resulting spawnSync error (or lack
// thereof) into either a pass or a diagnosable failure that distinguishes an
// OUTER budget expiring (ETIMEDOUT) from an INNER child failure (non-zero
// exit) -- the distinction apra-fleet-80q3 exists because losing it once
// already caused a real inner failure to be misread as "the budget fix did
// not hold".
//
// Before this extraction, MAX_NESTED_SUITE_FAILURE_EXCERPT_CHARS and
// excerptChildOutput were byte-identical copies in both files (apra-fleet-
// 3swo.49 ported them from phase1 to phase3), and handleNestedSuiteSpawnResult
// differed only in cosmetic ways (quote style, whether the ETIMEDOUT
// remediation sentence named PHASE1_ or PHASE3_NESTED_SUITE_TIMEOUT_MS, and
// whether the budget source arrived as a parameter -- phase3's backend-aware
// resolveNestedSuiteTimeoutBudget() -- or was computed ad hoc from the env
// inside the function -- phase1's pre-refactor shape). Both files' tests then
// asserted the SAME marker strings ('did NOT expire', 'child stdout (tail):',
// 'truncated') and split on the same markers to isolate a "wrapper prefix",
// so a wording change made in one copy could silently desynchronize the
// other file's contract while leaving both suites green. This module is the
// single source of truth those two copies now both import.
// =============================================================================

/** Length cap on how much of a failing child's stdout/stderr is quoted into
 * the wrapped non-timeout error message, so a multi-megabyte nested suite
 * failure cannot flood the outer test report. The original, uncapped output
 * is still reachable via the thrown error's `.cause`. */
export const MAX_NESTED_SUITE_FAILURE_EXCERPT_CHARS = 4000;

/**
 * Returns a length-capped tail excerpt of a (possibly huge, possibly
 * undefined) child stdout/stderr string, annotated when truncated.
 */
export function excerptChildOutput(text) {
    if (!text) return '(empty)';
    if (text.length <= MAX_NESTED_SUITE_FAILURE_EXCERPT_CHARS) return text;
    return (
        `...[truncated, showing last ${MAX_NESTED_SUITE_FAILURE_EXCERPT_CHARS} of ${text.length} chars]...\n` +
        text.slice(-MAX_NESTED_SUITE_FAILURE_EXCERPT_CHARS)
    );
}

/** Hard caps on the failing-TAP-entry section appended to the wrapped message.
 * Both callers' own suites pin the whole message under 20_000 chars, so this
 * section is bounded independently of the (already capped) stdout/stderr
 * tails: at most MAX_FAILING_TAP_ENTRIES entries, each at most
 * MAX_FAILING_TAP_ENTRY_CHARS long. */
export const MAX_FAILING_TAP_ENTRIES = 5;
export const MAX_FAILING_TAP_ENTRY_CHARS = 2000;
export const MAX_FAILING_TAP_ENTRY_LINES = 200;

/**
 * Pulls the `not ok N - <name>` TAP entries -- and the indented YAML block
 * node:test attaches to each (location/failureType/error/stack) -- out of a
 * nested child's stdout.
 *
 * Why this exists: excerptChildOutput() above quotes a POSITIONAL tail. When
 * a nested `node --test` batch runs the whole mock-sprint suite, its stdout is
 * ~1.6MB and the one failing entry is almost never in the last 4000 chars, so
 * the wrapped message reliably showed the tail of some unrelated PASSING test
 * while the actual `not ok` -- present in the very same string -- was
 * discarded. That is not hypothetical: the Windows CI failure this was written
 * for reported "showing last 4000 of 1621552 chars" and named no failing test,
 * twice, which is why the failure class went undiagnosed across two runs. The
 * positional tail is still quoted (it carries the child's TAP summary counts,
 * which is real signal); this adds the entries that actually failed.
 *
 * Deliberately a string scan, not a TAP parser: the input is arbitrary,
 * possibly truncated child output that also carries interleaved
 * `# [Workflow Log]` diagnostics, so anything that could throw on malformed
 * input would turn a diagnosable failure back into an opaque one. Unparseable
 * input simply yields zero entries and the caller says so.
 *
 * @param {string|undefined} text - the child's stdout
 * @param {{ maxEntries?: number, maxCharsPerEntry?: number }} [opts]
 * @returns {{ total: number, entries: string[] }} `total` counts every `not ok`
 *   found (so a reader knows when the quoted list was capped); `entries` holds
 *   the first `maxEntries` of them, each individually length-capped.
 */
export function extractFailingTapEntries(text, opts = {}) {
    const maxEntries = opts.maxEntries ?? MAX_FAILING_TAP_ENTRIES;
    const maxCharsPerEntry = opts.maxCharsPerEntry ?? MAX_FAILING_TAP_ENTRY_CHARS;
    if (!text) return { total: 0, entries: [] };

    const lines = String(text).split('\n');
    const entries = [];
    let total = 0;

    for (let i = 0; i < lines.length; i += 1) {
        // A TAP failure line, at any nesting depth: node indents subtests.
        const header = /^(\s*)not ok \d+ - /.exec(lines[i]);
        if (!header) continue;
        total += 1;
        if (entries.length >= maxEntries) continue;

        const indent = header[1];
        const block = [lines[i]];
        // Absorb the YAML diagnostic block that follows: every line of it is
        // indented STRICTLY deeper than the `not ok` line itself, and it ends
        // at the `...` terminator. Stop at the first line that is not deeper
        // (the next TAP entry, a bare `# ...` comment, or EOF) so a missing /
        // truncated terminator can never run away to the end of a 1.6MB string.
        // MAX_FAILING_TAP_ENTRY_LINES is a second, independent bound: blank
        // lines are absorbed (a YAML block may contain them), and the
        // per-entry CHARACTER cap is only applied after joining, so a stream
        // of blank lines would otherwise be walked to the end before being
        // trimmed. A real node:test diagnostic block is a few dozen lines.
        const stopAt = Math.min(lines.length, i + 1 + MAX_FAILING_TAP_ENTRY_LINES);
        for (let j = i + 1; j < stopAt; j += 1) {
            const line = lines[j];
            if (line.length > 0 && !line.startsWith(`${indent} `)) break;
            block.push(line);
            if (line.trim() === '...') break;
        }

        let entry = block.join('\n');
        if (entry.length > maxCharsPerEntry) {
            entry = `${entry.slice(0, maxCharsPerEntry)}\n${indent}...[entry truncated at ${maxCharsPerEntry} chars]...`;
        }
        entries.push(entry);
    }

    return { total, entries };
}

/**
 * Renders extractFailingTapEntries() output as the message section appended by
 * handleNestedSuiteSpawnResult(). Always returns a self-describing string --
 * "none found" is itself a diagnosis (the child died without node:test ever
 * recording a failure, e.g. a module-load crash), not an empty gap.
 */
function describeFailingTapEntries(text) {
    const { total, entries } = extractFailingTapEntries(text);
    if (total === 0) {
        return (
            'child failing TAP entries: none found -- the child exited non-zero without emitting a ' +
            "'not ok' line, so node:test never recorded a test failure (suspect a module-load crash, " +
            'a process-level exit, or output lost before it was captured).'
        );
    }
    const shown = entries.length;
    const header = shown === total
        ? `child failing TAP entries (${total} found):`
        : `child failing TAP entries (${total} found, showing the first ${shown}):`;
    return `${header}\n${entries.join('\n')}`;
}

/**
 * Pure helper: turns a spawnSync error (or lack thereof) into either a pass
 * (returns void) or throws with a descriptive message.
 *
 * Node distinguishes a timeout from a genuine non-zero-exit failure at the
 * error-object level (verified directly, both by standalone repro and by the
 * adversarial case in each caller's own test suite): a timed-out spawnSync
 * sets `error.code === 'ETIMEDOUT'` with `error.status === null`, while a
 * plain non-zero exit leaves `code` undefined and sets `error.status` to the
 * exit code. Classification below is by `error.code` alone, never by
 * sniffing `error.message` -- a real timeout's message ('spawnSync ...
 * ETIMEDOUT') and a real failure's message ('Command failed: ...') never mix
 * in practice, but nothing about the shape of an Error object prevents a
 * caller from constructing that combination, so the classification itself
 * must not depend on message text.
 *
 * apra-fleet-80q3.1 (phase1) / apra-fleet-3swo.49 (phase3 port): an inner
 * child failure (non-timeout) used to be re-thrown BARE in both files, which
 * made it textually indistinguishable from the outer budget itself expiring
 * once the raw "spawnSync ... ETIMEDOUT"-shaped text reached a report. The
 * two cases are now textually distinguishable: the ETIMEDOUT branch always
 * names the budget and its source; the non-timeout branch instead names the
 * outer suite label, states explicitly that the outer budget did NOT expire,
 * and quotes the child's exit status plus a length-capped tail of its
 * stdout/stderr. The original spawn error (with its full, uncapped
 * stdout/stderr) is preserved as `.cause` on the thrown error, so no
 * information is lost -- only what reaches the message text is bounded.
 *
 * The tail alone was NOT enough to identify the failing inner test, despite an
 * earlier version of this comment claiming it was: excerptChildOutput() quotes
 * a POSITIONAL tail, and a nested batch over the whole mock-sprint suite emits
 * ~1.6MB of TAP plus interleaved workflow logs, so the failing entry is almost
 * never inside the last 4000 chars. A real Windows CI failure reported
 * "showing last 4000 of 1621552 chars", quoted a PASSING test's output, and
 * named no failing test -- twice, leaving the failure class undiagnosed both
 * times. The non-timeout branch therefore also appends the child's actual
 * `not ok` entries (see extractFailingTapEntries above), which is what makes
 * the failing inner test identifiable from the wrapped message alone.
 *
 * @param {string} suiteLabel - name of the nested suite (e.g., 'golden-transcript')
 * @param {Error|null} spawnError - error from execFileSync (or null on success)
 * @param {number} budgetMs - timeout budget in milliseconds
 * @param {string} budgetSource - human-readable description of where budgetMs came from
 * @param {string} envVarName - name of the env var a reader should raise if this run is genuinely this slow (e.g. 'PHASE1_NESTED_SUITE_TIMEOUT_MS')
 * @param {string} [extraTimeoutGuidance] - gate-specific sentence appended after the shared remediation sentence in the ETIMEDOUT message (e.g. phase1's bd+dolt-latency pointer). Omitted entirely when empty.
 * @throws {Error} if spawnError is truthy (wrapped ETIMEDOUT, or wrapped inner failure with cause)
 */
export function handleNestedSuiteSpawnResult(suiteLabel, spawnError, budgetMs, budgetSource, envVarName, extraTimeoutGuidance = '') {
    if (!spawnError) {
        // Success case: no error, nothing to throw
        return;
    }
    if (spawnError.code === 'ETIMEDOUT') {
        throw new Error(
            `nested suite '${suiteLabel}' exceeded its ${budgetMs}ms budget, from ${budgetSource}. ` +
            `Raise ${envVarName} if this run is genuinely this slow here.` +
            (extraTimeoutGuidance ? ` ${extraTimeoutGuidance}` : '')
        );
    }
    // Non-timeout failure: the failure is INSIDE the nested child, not the
    // outer budget expiring. Wrap it so that fact is stated explicitly,
    // keeping the original error reachable as `cause`.
    const status = spawnError.status === undefined || spawnError.status === null ? 'unknown' : spawnError.status;
    throw new Error(
        `nested suite '${suiteLabel}' failed, but its outer budget of ${budgetMs}ms (from ${budgetSource}) did NOT ` +
        `expire -- the failure is inside the nested child itself, not this gate's own timeout. child exit status: ` +
        `${status}. ` +
        `child stdout (tail):\n${excerptChildOutput(spawnError.stdout)}\n` +
        `child stderr (tail):\n${excerptChildOutput(spawnError.stderr)}\n` +
        // Appended AFTER the tails, never before: both callers split the
        // message on 'child stdout (tail):' and assert the WRAPPER PREFIX
        // never contains 'timed out'/'exceeded its'. A quoted test NAME can
        // legitimately contain those words (several in this repo do), so this
        // section must stay on the child-output side of that split marker.
        `${describeFailingTapEntries(spawnError.stdout)}`,
        { cause: spawnError },
    );
}
