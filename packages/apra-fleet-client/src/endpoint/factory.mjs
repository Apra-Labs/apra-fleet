/**
 * makeEndpointApi(config): assemble a complete FleetApi over a plain HTTP
 * model endpoint, from injected config alone.
 *
 * This is the single entry point the package exposes under the './endpoint'
 * subpath. It wires together the three pieces the sibling tasks in this
 * streak built independently:
 *   - the shape adapter (openai-shape.mjs or anthropic-shape.mjs) for
 *     executePrompt, chosen by `config.provider`;
 *   - the memberless method semantics (memberless.mjs) for executeCommand
 *     and getMemberModelPricing.
 * Nothing here reads process.env: config is the caller's only input, per the
 * package-wide contract documented in http.mjs (the first consumer is an
 * Azure Function whose config layer is a deliberate single source of truth
 * with no fallbacks).
 *
 * The returned object is exactly the three-method surface FleetWorkflow
 * calls on `fleetApi` (executePrompt, executeCommand,
 * getMemberModelPricing) -- see packages/apra-fleet-workflow/src/workflow/index.mjs
 * -- so `new FleetWorkflow(makeEndpointApi(config))` works with no adapter
 * layer in between.
 */

import { createOpenAiTransport } from './openai-shape.mjs';
import { createAnthropicTransport } from './anthropic-shape.mjs';
import { createMemberlessMethods } from './memberless.mjs';

/** Provider id -> shape adapter factory. */
const PROVIDERS = Object.freeze({
    openai: createOpenAiTransport,
    anthropic: createAnthropicTransport
});

/**
 * @typedef {object} EndpointApiConfig
 * @property {'openai'|'anthropic'} provider - which shape adapter to use.
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {string} model
 * @property {import('./memberless.mjs').EndpointModelPrice} [pricing]
 * @property {...*} rest - any other field the chosen shape adapter accepts
 *   (e.g. `pattern`, `maxTokens`, `headers`, `system`, `anthropicVersion`,
 *   `fetch`) is passed through untouched.
 */

/**
 * @param {EndpointApiConfig} config
 * @returns {{executePrompt: Function, executeCommand: Function, getMemberModelPricing: Function}}
 * @throws {TypeError} when `config.provider` is not a recognized shape, or
 *   when the chosen shape adapter rejects the rest of config (e.g. a missing
 *   baseUrl/apiKey/model).
 */
export function makeEndpointApi(config = {}) {
    const createTransport = PROVIDERS[config.provider];
    if (typeof createTransport !== 'function') {
        throw new TypeError(
            `[Endpoint Transport] config.provider must be one of ${Object.keys(PROVIDERS).join(', ')}, ` +
            `got ${JSON.stringify(config.provider)}.`
        );
    }

    const { executePrompt } = createTransport(config);
    const { executeCommand, getMemberModelPricing } = createMemberlessMethods(config);

    return { executePrompt, executeCommand, getMemberModelPricing };
}
