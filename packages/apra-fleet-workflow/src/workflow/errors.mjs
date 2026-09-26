/**
 * Typed error taxonomy for FleetWorkflow's agent()/command() calls.
 *
 * Background: docs/structured-errors-proposal.md lays out two options for the
 * apra-fleet MCP server to report failures in a structured way (JSON-RPC
 * error responses, or a standardized {isError, code, message, data} payload).
 * Both require server-side changes that are out of scope here (external repo,
 * apra-fleet.exe). This module is the CLIENT/WORKFLOW-side half of that
 * contract: it gives every failure path in src/workflow/index.mjs a single,
 * typed shape so callers never have to guess between `null`, a bare `Error`,
 * or a normal-looking string that secretly means failure.
 *
 * When the server eventually ships Option 1 or Option 2, the JSON-RPC
 * rejection path in McpClient.handleMessage (packages/apra-fleet-client/src
 * /client/client.mjs) should be mapped through this same classifier so the
 * same error classes are raised regardless of which failure signal the
 * server used to report the problem.
 */

/**
 * Base class for all typed workflow errors.
 *
 * @property {string} code - Machine-readable error code, compatible with the
 *   `code` field proposed in structured-errors-proposal.md Option 2 (e.g.
 *   MEMBER_NOT_FOUND, AGENT_OUTPUT_INVALID, COMMAND_FAILED, TRANSPORT_ERROR).
 * @property {object} [details] - Additional structured context about the
 *   failure (e.g. raw output text, validation errors, the original payload).
 */
export class WorkflowError extends Error {
    /**
     * @param {string} message
     * @param {{ code: string, details?: object, cause?: unknown }} opts
     */
    constructor(message, { code, details, cause } = {}) {
        super(message, cause !== undefined ? { cause } : undefined);
        this.name = this.constructor.name;
        this.code = code || 'WORKFLOW_ERROR';
        this.details = details;
    }
}

/**
 * Thrown when the target fleet member could not be found. Today this is
 * detected via a string-sniff on the response text (see the stopgap note in
 * src/workflow/index.mjs); once the server ships structured errors this will
 * be classified from the JSON-RPC error / isError payload directly.
 */
export class MemberNotFoundError extends WorkflowError {
    constructor(message, opts = {}) {
        super(message, { code: 'MEMBER_NOT_FOUND', ...opts });
    }
}

/**
 * Thrown when agent() cannot produce usable output: empty content from the
 * server, unparseable JSON when a schema was requested, or JSON that fails
 * schema validation.
 */
export class AgentOutputError extends WorkflowError {
    constructor(message, opts = {}) {
        super(message, { code: 'AGENT_OUTPUT_INVALID', ...opts });
    }
}

/**
 * Thrown when execute_prompt's dispatch itself failed (member busy, transport
 * exception, non-zero CLI exit) BEFORE any real LLM content was produced --
 * as opposed to AgentOutputError, which means the LLM responded but the
 * response was empty/unparseable/schema-invalid. Distinguishing these two
 * matters because a dispatch failure is not a schema problem: retrying it
 * through the bounded schema-repair loop (which re-asks the SAME broken
 * prompt with "here's why your JSON was invalid" framing) wastes repair
 * attempts on a failure class repair can never fix, and produces a
 * misleading "LLM failed to return parseable JSON" message for what was
 * actually a busy-member rejection or a transport-level exception.
 * Classified today via structuredContent.isError/reason on execute_prompt's
 * response (see src/tools/execute-prompt.ts); never retried via schema
 * repair (see the `attempt === 0` short-circuit in agent()).
 */
export class AgentDispatchError extends WorkflowError {
    constructor(message, opts = {}) {
        super(message, { code: 'AGENT_DISPATCH_FAILED', ...opts });
    }
}

/**
 * Thrown when command() receives an `isError: true` result from the fleet
 * API.
 */
export class CommandError extends WorkflowError {
    constructor(message, opts = {}) {
        super(message, { code: 'COMMAND_FAILED', ...opts });
    }
}

/**
 * Thrown when the underlying transport/JSON-RPC call itself rejects (network
 * failure, MCP transport error, etc.), as opposed to a well-formed response
 * that merely describes a failure. The original error is preserved on
 * `.cause`.
 */
export class FleetTransportError extends WorkflowError {
    constructor(message, opts = {}) {
        super(message, { code: 'TRANSPORT_ERROR', ...opts });
    }
}

/**
 * Thrown by agent()/command() before dispatch when the workflow's `budget`
 * has been configured with a `total` and the already-spent amount has
 * reached or exceeded it (`budget.remaining() <= 0`). Cost is only known
 * (and therefore only ever debited) for activities where the fleet result
 * reported real token usage -- see the usage/cost handling in
 * src/workflow/index.mjs and apra-fleet-unw.4.
 */
export class BudgetExceededError extends WorkflowError {
    constructor(message, opts = {}) {
        super(message, { code: 'BUDGET_EXCEEDED', ...opts });
    }
}

/**
 * Thrown when a run is cooperatively cancelled via
 * `FleetWorkflow.requestStop()` (apra-fleet-unw.10, viewer `/stop` handler).
 *
 * `requestStop()` aborts a per-run `AbortController` whose `signal` is
 * threaded into every in-flight and future `agent()`/`command()` call for
 * that run (via the apra-fleet-unw.5 client-side signal plumbing). The
 * underlying rejection surfaces at the transport layer as a client-side
 * `AbortError` (`.code === 'ABORTED'`, packages/apra-fleet-client/src/client
 * /errors.mjs); `agent()`/`command()` recognize that code and re-wrap it as
 * this typed `CancelledError` instead of a generic `FleetTransportError`, so
 * callers/tests can distinguish "the user asked to stop" from "the network
 * broke".
 *
 * NOTE: this is client-side/local cancellation only. A remote fleet member
 * that already accepted a job may keep running to completion even after the
 * workflow run itself unwinds as cancelled -- true server-side cancellation
 * would require changes to the external apra-fleet MCP server and is out of
 * scope here.
 */
export class CancelledError extends WorkflowError {
    constructor(message, opts = {}) {
        super(message, { code: 'CANCELLED', ...opts });
    }
}
