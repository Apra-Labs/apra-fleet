/**
 * In-process wait-for-response correlation (apra-fleet-2xs.8), used by
 * execute_prompt's interactive routing path: a msgid is minted by
 * send_message when pushing a prompt to a connected member's live session,
 * and the caller awaits the member's later respond_to_message() call
 * carrying the same msgid as `reply_to`. Purely in-memory -- this only ever
 * correlates within a single apra-fleet.exe process (tier-2-local, per
 * docs/cloud-fleet-architecture.md section 6 and apra-fleet-2xs.8's own
 * scope note: mode selection and this wait are local to the machine
 * running apra-fleet.exe, never caller/hub-side state).
 */

interface PendingEntry {
  resolve: (content: string) => void;
  reject: (err: Error) => void;
}

const pending = new Map<string, PendingEntry>();

/** Registers a wait for a reply to `msgid`, rejecting after `timeoutMs` if none arrives. */
export function registerPending(msgid: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(msgid);
      reject(new Error(`Timed out waiting for response after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    pending.set(msgid, {
      resolve: (content: string) => {
        clearTimeout(timer);
        pending.delete(msgid);
        resolve(content);
      },
      reject: (err: Error) => {
        clearTimeout(timer);
        pending.delete(msgid);
        reject(err);
      },
    });
  });
}

/**
 * Delivers a reply for `msgid`. Returns false if there is no matching
 * pending wait (already timed out, already resolved, or an unrecognized/
 * stale id) -- the caller (respond_to_message) surfaces this as a clear
 * "nothing was waiting" result rather than silently succeeding.
 */
export function resolvePending(msgid: string, content: string): boolean {
  const entry = pending.get(msgid);
  if (!entry) return false;
  entry.resolve(content);
  return true;
}

/** Test-only: clears all pending waits without resolving/rejecting them. */
export function __clearAllPending(): void {
  pending.clear();
}
