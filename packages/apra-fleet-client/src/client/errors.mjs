/**
 * Minimal typed error shape for the transport/client layer.
 *
 * NOTE (apra-fleet-unw.5): packages/apra-fleet-workflow/src/workflow/errors.mjs
 * already defines a `WorkflowError` taxonomy (MEMBER_NOT_FOUND,
 * AGENT_OUTPUT_INVALID, COMMAND_FAILED, TRANSPORT_ERROR, ...), but
 * apra-fleet-client is a lower-level package that apra-fleet-workflow
 * *depends on* (see packages/apra-fleet-workflow/package.json), so
 * client.mjs cannot import from the workflow package without introducing a
 * circular dependency. This module defines a small, compatible error shape
 * (`message`, `.code`, `.details`, `.cause`) for use at the MCP
 * request/transport layer. When the two taxonomies are reconciled, consider
 * hoisting a shared base error class into a package both can depend on (e.g.
 * a `@apralabs/apra-fleet-errors` package), or having the workflow layer's
 * `FleetTransportError` classifier recognize `.code === 'TIMEOUT'` /
 * `.code === 'ABORTED'` from this module and re-wrap accordingly.
 */
export class ClientError extends Error {
    /**
     * @param {string} message
     * @param {{ code: string, details?: object, cause?: unknown }} opts
     */
    constructor(message, { code, details, cause } = {}) {
        super(message, cause !== undefined ? { cause } : undefined);
        this.name = this.constructor.name;
        this.code = code || 'CLIENT_ERROR';
        this.details = details;
    }
}

/**
 * Thrown by McpClient.request() when no JSON-RPC response arrives within the
 * configured (or default) timeout window.
 */
export class TimeoutError extends ClientError {
    constructor(message, opts = {}) {
        super(message, { code: 'TIMEOUT', ...opts });
    }
}

/**
 * Thrown by McpClient.request() when the caller-supplied AbortSignal fires
 * before a response arrives.
 */
export class AbortError extends ClientError {
    constructor(message, opts = {}) {
        super(message, { code: 'ABORTED', ...opts });
    }
}

/**
 * Thrown (as the rejection for every in-flight request) when the underlying
 * transport closes -- deliberate stop(), or the persistent SSE stream dying
 * past its reconnect budget. Previously a bare `new Error('Transport
 * closed')`, indistinguishable downstream from any other failure; typed so
 * callers can classify it as a connectivity event (retryable at their
 * discretion) rather than a request-level failure.
 *
 * CONVENTION (2026-07-19 stabilization): when execute_prompt /
 * execute_command surface a NEW kind of failure that downstream code needs
 * to branch on, add a typed error class HERE (transport/request-level
 * failures) or a `reason` code on the workflow layer's AgentDispatchError
 * (dispatch-level failures reported via structuredContent.isError, e.g.
 * 'busy', 'empty_response', 'max_turns_exhausted') -- never a bare Error
 * with only a message string to sniff.
 */
export class TransportClosedError extends ClientError {
    constructor(message, opts = {}) {
        super(message, { code: 'TRANSPORT_CLOSED', ...opts });
    }
}
