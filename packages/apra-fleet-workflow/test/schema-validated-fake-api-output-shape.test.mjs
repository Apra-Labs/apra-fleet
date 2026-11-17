import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// apra-fleet-j918.8.12: schema-validated-fake-api.mjs (apra-fleet-j918.8.11)
// validates every INPUT payload FleetWorkflow builds against the real
// execute_prompt/execute_command zod schemas imported from dist/tools/*.js --
// a rename, a newly-required field, or a dropped input field makes a wired
// test fail loudly (see apra-fleet-workflow.test.mjs's
// "FleetWorkflow.agent()/command() against a schema-validated fleetApi").
//
// That mechanism has NO reach over the OUTPUT side: execute_prompt has no
// zod schema for its RESPONSE shape (only its input), so the fake's canned
// executePrompt() response -- a hand-typed literal, `structuredContent: {
// response: 'fake response', ... }` -- is not derived from anything and
// cannot notice a real rename. Verified directly (falsification performed by
// hand for this bead, not committed): renaming src/tools/execute-prompt.ts's
// real output field from `response` to `response_renamed` and rebuilding
// left every apra-fleet-workflow test green (317/317) -- FleetWorkflow's own
// reading code (src/workflow/index.mjs's `hasStructuredResponse` check)
// silently DEGRADES to a text-scraping fallback for a server response that
// lacks `structuredContent.response` (a deliberate backward-compat path for
// pre-upgrade servers), so neither side ever throws; the fake's own
// independently-hardcoded 'fake response' text made the degraded path
// produce the identical, uninformative-of-drift correct answer.
//
// This test closes that gap the way the input side is closed: not with a
// zod schema (none exists for the output), but by pinning the exact field
// NAME the real handler emits against dist/tools/execute-prompt.js's own
// compiled source text, and asserting the fake's canned response uses that
// SAME name. A real rename that slips through review breaks EITHER this
// test (if a build ran) or the loud-failure-on-tool-restructure checks
// already in schema-validated-fake-api.mjs, closing the residual exposure
// apra-fleet-j918.8.12's mutation (d) found.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_EXECUTE_PROMPT = path.join(__dirname, '../../../dist/tools/execute-prompt.js');
const FAKE_API = path.join(__dirname, 'schema-validated-fake-api.mjs');

/**
 * Finds the top-level field name execute_prompt's real handler uses to carry
 * the LLM's clean reply text in its structuredContent -- the same value
 * src/workflow/index.mjs's `hasStructuredResponse`/`structured.response`
 * check reads. Anchored on the `parsed.result` value (the one thing that
 * cannot itself be renamed away without breaking execute-prompt.ts's own
 * internal logic), not a hardcoded field-name literal, so a rename of the
 * FIELD is exactly what this regex is built to catch.
 */
function findRealResponseFieldName(distSource) {
    // Anchored on `structuredContent: { <field>: parsed.result,` specifically
    // -- execute-prompt.ts also passes `parsed.result` as a DIFFERENT named
    // argument (session_transcript) to an unrelated kb-harvest call earlier
    // in the file, which a bare `/(\w+):\s*parsed\.result,/` match picks up
    // first (it appears earlier in source order) instead of the actual
    // tool-response field this pin cares about.
    const m = /structuredContent:\s*\{\s*(\w+):\s*parsed\.result,/.exec(distSource);
    if (!m) {
        throw new Error(
            "could not find a 'structuredContent: { <field>: parsed.result,' assignment in " +
            'dist/tools/execute-prompt.js -- either the response-building code moved/changed shape, ' +
            'or the dist/ build is stale (run npm run build at the repo root first). Either way, ' +
            'this pin needs a human to re-anchor it.',
        );
    }
    return m[1];
}

describe('schema-validated-fake-api output-shape pin (apra-fleet-j918.8.12)', () => {
    test('the real execute_prompt response field name is still "response"', () => {
        const distSource = fs.readFileSync(DIST_EXECUTE_PROMPT, 'utf8');
        const fieldName = findRealResponseFieldName(distSource);
        assert.equal(
            fieldName,
            'response',
            'src/tools/execute-prompt.ts renamed the structuredContent field FleetWorkflow reads as ' +
            "structured.response (src/workflow/index.mjs's hasStructuredResponse check) -- update BOTH " +
            'that reader and this pin together, not just one side.',
        );
    });

    test("schema-validated-fake-api.mjs's canned executePrompt response uses the SAME field name the real handler emits", () => {
        const distSource = fs.readFileSync(DIST_EXECUTE_PROMPT, 'utf8');
        const realFieldName = findRealResponseFieldName(distSource);
        const fakeSource = fs.readFileSync(FAKE_API, 'utf8');
        const fakeFieldRe = new RegExp(`structuredContent:\\s*\\{\\s*${realFieldName}:`);
        assert.ok(
            fakeFieldRe.test(fakeSource),
            `schema-validated-fake-api.mjs's canned executePrompt() response must carry its reply text under ` +
            `structuredContent.${realFieldName} to match what the real execute_prompt handler emits -- got a fake ` +
            `whose canned response no longer names that field, which would let a real rename go silently ` +
            `unnoticed by every wired agent()/command() test.`,
        );
    });

    test('falsification: this pin is not vacuous -- it goes red against a real dist/ rename', (t) => {
        const distSource = fs.readFileSync(DIST_EXECUTE_PROMPT, 'utf8');
        const mutated = distSource.replace(
            /structuredContent:\s*\{\s*(\w+):\s*parsed\.result,/,
            'structuredContent: { response_renamed: parsed.result,',
        );
        // Sanity: the replace actually changed something (otherwise this
        // falsification would trivially "pass" by comparing identical text).
        assert.notEqual(mutated, distSource, 'expected the mutation to actually change the dist source text');
        assert.throws(
            () => {
                const fieldName = findRealResponseFieldName(mutated);
                assert.equal(fieldName, 'response');
            },
            /response_renamed/,
            'a renamed response field must make the pin fail with the renamed name visible in the assertion, not silently pass',
        );
    });
});
