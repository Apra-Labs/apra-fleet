import { SqliteProvider } from './sqlite-provider.js';
import type { MemoryProvider } from './types.js';

/**
 * Narrows a project KB provider to SqliteProvider, for call sites that use
 * SqliteProvider-only capabilities not part of the MemoryProvider interface
 * (list, feedback, freshnessSweep, reconcilePrefilter, resolveContradiction,
 * hasEntry, the DirectiveProvider methods, and capture's second CaptureOpts
 * argument).
 *
 * Accepts MemoryProvider (not SqliteProvider) on purpose: KbProviders.project is
 * SqliteProvider today, but a later task widens it to MemoryProvider so an
 * HttpKbProvider can be selected. This helper already compiles and behaves
 * identically against today's narrower type, so callers can adopt it ahead of
 * that widening without breaking anything, and once the widening lands every
 * SqliteProvider-only call site routes through here instead of failing to compile.
 *
 * @param provider the project KB provider to narrow
 * @param callerLabel short label identifying the call site, surfaced in the
 *   thrown error message (e.g. the tool name)
 * @throws Error naming callerLabel when provider is not a SqliteProvider --
 *   never returns a null/undefined sentinel
 */
export function requireSqliteProject(provider: MemoryProvider, callerLabel: string): SqliteProvider {
  if (provider instanceof SqliteProvider) {
    return provider;
  }
  throw new Error(
    `${callerLabel}: this operation is not supported when the KB is backed by a remote HTTP provider`,
  );
}
