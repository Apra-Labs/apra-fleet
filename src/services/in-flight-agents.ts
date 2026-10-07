// In-flight agent dispatches tracked across prompt executions.
// Shared between execute_prompt and services needing awareness of the
// currently executing agent (e.g. kb-self session resolution fallback).

export const inFlightAgents = new Set<string>();
