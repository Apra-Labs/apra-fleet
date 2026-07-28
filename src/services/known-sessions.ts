/**
 * Per-member ledger of session ids this server process has successfully
 * dispatched to (apra-fleet-eft.78.1).
 *
 * An explicit session-id resume (execute_prompt `resume: "<id>"`) asserts that
 * the prompt depends on THAT session's prior context. Honoring it blindly would
 * let an unknown/expired id silently start a fresh, blank session and run a
 * context-dependent delta prompt with no context -- meaningless at best,
 * destructively wrong at worst. This ledger is the resumability oracle: an id
 * the server has actually issued (returned from a prior successful dispatch) is
 * known/resumable; anything else is rejected as a TERMINAL `session_not_found`
 * BEFORE any LLM is spawned, so the caller can rebuild context and re-dispatch
 * fresh deliberately.
 *
 * Scoped by member id: a session id issued for one member is never treated as
 * resumable for another. Populated only on a SUCCESSFUL dispatch (a failed
 * dispatch never marks its id resumable).
 */
const knownByMember = new Map<string, Set<string>>();

/** Record a session id the server successfully dispatched to for a member.
 *  No-op when sessionId is undefined (a provider that never returns one). */
export function recordKnownSession(memberId: string, sessionId: string | undefined): void {
  if (!sessionId) return;
  let set = knownByMember.get(memberId);
  if (!set) {
    set = new Set<string>();
    knownByMember.set(memberId, set);
  }
  set.add(sessionId);
}

/** Whether the server has previously issued this session id for this member. */
export function isKnownSession(memberId: string, sessionId: string): boolean {
  return knownByMember.get(memberId)?.has(sessionId) ?? false;
}

/** Test-only: clear the entire known-session ledger. */
export function _resetKnownSessions(): void {
  knownByMember.clear();
}
