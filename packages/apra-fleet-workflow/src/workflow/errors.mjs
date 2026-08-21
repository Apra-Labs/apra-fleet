/**
 * Typed error taxonomy for FleetWorkflow's agent()/command() calls.
 *
 * The class definitions moved to
 * packages/apra-fleet-client/src/errors/workflow-errors.mjs (exported as
 * '@apralabs/apra-fleet-client/errors'); that file carries the full rationale
 * for each class and for the move. This module stays as the workflow-side
 * name so existing imports (src/workflow/index.mjs, which also re-exports
 * these from the package entry point) keep working.
 *
 * Re-export, not re-declaration: callers on both sides of the move compare
 * against the SAME class objects, so `instanceof WorkflowError` still holds
 * for an error raised by a transport in the client package.
 */
export {
    WorkflowError,
    MemberNotFoundError,
    AgentOutputError,
    AgentDispatchError,
    CommandError,
    FleetTransportError,
    BudgetExceededError,
    CancelledError
} from '@apralabs/apra-fleet-client/errors';
