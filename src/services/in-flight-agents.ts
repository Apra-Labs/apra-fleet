// In-flight agent dispatches tracked across prompt executions.
// Shared between execute_prompt, stop_prompt, and tools checking agent busy state.

export const inFlightAgents = new Set<string>();
