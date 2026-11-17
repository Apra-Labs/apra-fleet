/**
 * The two FleetApi methods that are NOT executePrompt, answered honestly for
 * a transport that has no member behind it.
 *
 * The engine calls exactly three methods on the object handed to
 * new FleetWorkflow(fleetApi): executePrompt, executeCommand and
 * getMemberModelPricing. Only the first has an obvious meaning over an HTTP
 * endpoint. This module decides the other two rather than leaving stubs that
 * lie about what happened.
 *
 * executeCommand -- REFUSES. There is no machine here to run a shell on: no
 * SSH, no member, no work folder. Returning {exit_code: 0} (or an empty
 * stdout) would let a workflow believe a command ran, so this rejects with a
 * typed CommandError naming the limitation. CommandError is from the engine's
 * OWN taxonomy, which matters: FleetWorkflow.command() re-raises an
 * `instanceof WorkflowError` untouched and wraps anything else in a generic
 * FleetTransportError, so a look-alike error class of our own would surface
 * as a transport failure and blame the network for a capability that simply
 * does not exist.
 *
 * getMemberModelPricing -- PRICES FROM INJECTED CONFIG, OR SAYS IT CANNOT.
 * The decision, and why:
 *
 *   The engine asks this method for a member's cheap/standard/premium tiers
 *   resolved to concrete models and real prices. There is no member here, and
 *   -- more decisively -- there is no tier resolution either: the shape
 *   adapters send exactly the one model in config on every dispatch, whatever
 *   tier keyword the engine passes. So a per-tier price TABLE would encode a
 *   resolution this transport does not perform. What the operator can
 *   honestly know is the price of the single model they configured, so that
 *   is what config carries -- one {promptPrice, completionPrice} pair -- and
 *   it is reported for all three tiers because all three genuinely bill at
 *   that one model's rate.
 *
 *   Absent that config, this does NOT fall back to a guess. It returns the
 *   explicit unpriced signal the engine already understands: a payload with
 *   an `error` and no `pricing`, which _getMemberPricing() turns into `null`,
 *   warns about once per member, and then prices through the pricing.mjs
 *   tier-band fallback (which itself returns null, not a default price, for a
 *   model it does not list). Both halves of the choice are the same
 *   principle: report a real price when one was supplied, and say so plainly
 *   when one was not -- never fabricate one.
 *
 * The return shape mirrors the get_member_model_pricing MCP tool exactly --
 * a JSON string in content[0].text -- because that is what the engine parses.
 */

import { CommandError } from '../errors/workflow-errors.mjs';

/**
 * @typedef {object} EndpointModelPrice
 * @property {number} promptPrice - USD per 1M prompt tokens.
 * @property {number} completionPrice - USD per 1M completion tokens.
 */

/**
 * @typedef {object} MemberlessConfig
 * @property {EndpointModelPrice} [pricing] - price of the one configured
 *   model. Omit it to signal unpriced.
 * @property {string} [model] - the configured model id, reported alongside
 *   the price for the caller's benefit.
 */

/**
 * Build the memberless half of a FleetApi: executeCommand and
 * getMemberModelPricing.
 *
 * @param {MemberlessConfig} config
 * @returns {{executeCommand: (payload?: object) => Promise<never>,
 *   getMemberModelPricing: (options?: object) => Promise<{content: Array<{type: string, text: string}>}>}}
 */
export function createMemberlessMethods(config = {}) {
    const pricing = normalizePricingConfig(config.pricing);
    const model = typeof config.model === 'string' && config.model !== '' ? config.model : null;

    async function executeCommand(payload = {}) {
        const command = typeof payload.command === 'string' ? payload.command : '';
        throw new CommandError(
            '[Endpoint Transport] this transport cannot execute commands: it talks to an HTTP model endpoint, ' +
            'so there is no member, no shell and no work folder to run one on. ' +
            'Use an MCP-backed fleet transport for command execution.' +
            (command ? ` (refused command: ${command.slice(0, 200)})` : ''),
            { details: { reason: 'command_execution_unsupported', command: command || undefined } }
        );
    }

    async function getMemberModelPricing() {
        if (!pricing) {
            return jsonResult({
                error: '[Endpoint Transport] no per-model pricing was configured for this endpoint transport ' +
                    '(pass config.pricing as {promptPrice, completionPrice} per 1M tokens to price dispatches for real).'
            });
        }
        // Every tier bills at the one configured model's rate, because every
        // dispatch uses that one model -- see the module header.
        const entry = { model, promptPrice: pricing.promptPrice, completionPrice: pricing.completionPrice };
        return jsonResult({
            member_id: null,
            member_name: null,
            llm_provider: 'endpoint',
            pricing: { cheap: entry, standard: entry, premium: entry }
        });
    }

    return { executeCommand, getMemberModelPricing };
}

function normalizePricingConfig(pricing) {
    if (pricing === undefined || pricing === null) return null;
    const { promptPrice, completionPrice } = pricing;
    // Malformed pricing is a wiring bug, and silently degrading it to
    // "unpriced" would hide a cost table the operator believed was in force.
    if (!isPrice(promptPrice) || !isPrice(completionPrice)) {
        throw new TypeError(
            '[Endpoint Transport] config.pricing must be {promptPrice, completionPrice} as non-negative finite ' +
            `numbers (USD per 1M tokens), got ${JSON.stringify(pricing)}. Omit config.pricing entirely to report ` +
            'this endpoint as unpriced.'
        );
    }
    return { promptPrice, completionPrice };
}

function isPrice(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function jsonResult(payload) {
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}
