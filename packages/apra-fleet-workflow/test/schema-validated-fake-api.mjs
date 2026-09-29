// apra-fleet-j918.8.11: a `fleetApi` test double for `new FleetWorkflow(fleetApi)`
// that is DERIVED FROM the real MCP tool schemas in src/tools/* instead of
// hand-copied. `new FleetWorkflow({})` (a literally empty object) lets
// FleetWorkflow's payload-building code drift arbitrarily far from what the
// live `execute_prompt`/`execute_command`/`get_member_model_pricing` tools
// actually accept, because nothing in this package's tests ever calls a real
// method on the fake -- there is nothing there to fail. This module fixes
// that: every method here re-validates its incoming payload against the
// SAME zod schema the real tool enforces, so a rename, a newly-required
// field, or a dropped field in src/tools/* makes a wired-up test fail loudly
// instead of silently continuing to pass against a stale shape.
//
// SOURCE OF TRUTH: the schemas are imported from the repo's own build output
// (dist/tools/*.js), not re-declared here -- a hand-copied schema would drift
// the exact same way the empty object does, which would just reproduce the
// defect in a new form. This requires `npm run build` (a full `tsc`, not
// just `npm run build:contract`) to have run before these tests execute --
// true in CI (the "Build" step runs before "Run tests") and for any local
// `npm test --workspace=@apralabs/apra-fleet-workflow`
// run after a normal `npm run build`. See packages/apra-fleet-se/test/
// fyc3-se-package-json-shipped.test.mjs for the same dist/-import pattern
// already used elsewhere in this repo.
//
// LOUD FAILURE ON TOOL RENAME/SIGNATURE DRIFT: the imports below run at
// module load time. If a tool file moves, or an exported schema is renamed,
// the `import()` (or the self-check right after it) throws immediately --
// every test in a file that imports this module fails with a clear message
// naming exactly what went missing, rather than quietly exercising a stale
// fake.

import { executePromptSchema } from '../../../dist/tools/execute-prompt.js';
import { executeCommandSchema } from '../../../dist/tools/execute-command.js';
import { getMemberModelPricingSchema } from '../../../dist/tools/get-member-model-pricing.js';

/**
 * Fails loudly (at import time of this module) if a schema is missing or is
 * no longer a zod schema -- e.g. the tool that used to export it was renamed
 * or restructured. Complements the module-load import above: import()
 * itself only throws for a moved FILE or a renamed EXPORT; this also catches
 * an export that still exists under the same name but is no longer a real
 * zod schema (e.g. replaced by a plain object during a refactor).
 * @param {string} toolName
 * @param {unknown} schema
 */
function assertRealZodSchema(toolName, schema) {
    if (!schema || typeof schema.parse !== 'function' || typeof schema.safeParse !== 'function') {
        throw new Error(
            `[schema-validated-fake-api] "${toolName}" schema is missing or is not a zod schema anymore -- ` +
            `the tool it backs was likely renamed or restructured in src/tools/*. Update this fake to match.`
        );
    }
}

assertRealZodSchema('execute_prompt', executePromptSchema);
assertRealZodSchema('execute_command', executeCommandSchema);
assertRealZodSchema('get_member_model_pricing', getMemberModelPricingSchema);

/**
 * Validates `payload` against `schema` the same way it would actually be
 * validated on the wire: MCP tool calls are JSON-RPC, so a JSON.stringify/
 * JSON.parse round trip happens between "the object FleetWorkflow built" and
 * "the object the server's zod schema sees" -- which drops any key whose
 * value is `undefined` (e.g. FleetWorkflow's payload objects always include
 * caller-omitted optional fields as explicit `key: undefined`, which a
 * `.strict()` schema would otherwise reject as an unrecognized key even
 * though it would never actually reach the server that way).
 * @param {string} toolName
 * @param {import('zod').ZodTypeAny} schema
 * @param {Record<string, any>} payload
 */
function validateAgainstSchema(toolName, schema, payload) {
    const overTheWire = JSON.parse(JSON.stringify(payload ?? {}));
    const result = schema.safeParse(overTheWire);
    if (!result.success) {
        throw new Error(
            `[schema-validated-fake-api] payload sent to "${toolName}" no longer matches its real tool schema ` +
            `(src/tools/*):\n${result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}\n` +
            `Payload was: ${JSON.stringify(overTheWire, null, 2)}`
        );
    }
    return result.data;
}

/**
 * Creates a `fleetApi`-shaped fake for `new FleetWorkflow(fakeApi)` whose
 * methods validate every call against the real MCP tool schemas before
 * returning a canned (but shape-accurate) response. Use this in any test
 * whose `FleetWorkflow` instance actually reaches `agent()`/`command()`/
 * pricing lookups; plain `{}` remains fine for tests that only exercise
 * schema-agnostic primitives (`sequential`/`pipeline`/`parallel`/`transform`/
 * `createContext`), since those never touch `fleetApi` at all.
 *
 * @param {{
 *   executePrompt?: (validatedPayload: object) => any,
 *   executeCommand?: (validatedPayload: object) => any,
 *   getMemberModelPricing?: (validatedPayload: object) => any,
 * }} [overrides] Per-method canned-response builders. Each receives the
 *   schema-validated payload and returns the raw callTool()-shaped result
 *   FleetWorkflow expects back (mirroring ApraFleet's real methods in
 *   packages/apra-fleet-client/src/client/api.mjs, which also just return
 *   the raw callTool() result unchanged).
 */
export function createSchemaValidatedFakeApi(overrides = {}) {
    const calls = { executePrompt: [], executeCommand: [], getMemberModelPricing: [] };

    return {
        calls,

        /** @param {import('../../apra-fleet-client/src/client/api.mjs').ExecutePromptOptions} options */
        async executePrompt(options) {
            // Mirrors ApraFleet.executePrompt (packages/apra-fleet-client/src/client/api.mjs):
            // timeoutMs/signal are client-side-only and never sent to the tool.
            const { timeoutMs, signal, ...payload } = options ?? {};
            const validated = validateAgainstSchema('execute_prompt', executePromptSchema, payload);
            calls.executePrompt.push(validated);
            if (overrides.executePrompt) return overrides.executePrompt(validated);
            return {
                content: [{ type: 'text', text: `[RESULT] Response from fake-member:\n\nfake response` }],
                structuredContent: {
                    response: 'fake response',
                    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                },
            };
        },

        /** @param {import('../../apra-fleet-client/src/client/api.mjs').ExecuteCommandOptions} options */
        async executeCommand(options) {
            const { timeoutMs, signal, ...payload } = options ?? {};
            const validated = validateAgainstSchema('execute_command', executeCommandSchema, payload);
            calls.executeCommand.push(validated);
            if (overrides.executeCommand) return overrides.executeCommand(validated);
            return {
                content: [{ type: 'text', text: 'fake command output' }],
                isError: false,
            };
        },

        /** @param {{ member_id?: string, member_name?: string }} options */
        async getMemberModelPricing(options) {
            const validated = validateAgainstSchema('get_member_model_pricing', getMemberModelPricingSchema, options ?? {});
            calls.getMemberModelPricing.push(validated);
            if (overrides.getMemberModelPricing) return overrides.getMemberModelPricing(validated);
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        member_id: validated.member_id ?? null,
                        member_name: validated.member_name ?? null,
                        llm_provider: 'claude',
                        pricing: null,
                    }),
                }],
            };
        },
    };
}
