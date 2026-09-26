import { z } from 'zod';
import { getDoltPushMutex, DEFAULT_WAIT_MS, MAX_WAIT_MS } from '../services/sprint-coordination.js';

/**
 * Fleet-server-hosted global dolt push mutex (apra-fleet-f34.2).
 *
 * The same coordination the apra-fleet-se supervisor exposes over HTTP
 * (`/api/dolt-push-mutex/...`), hosted here on the fleet MCP server so the
 * STANDALONE CLI launch path -- which has no supervisor to reach, but always
 * connects to the shared fleet HTTP singleton -- can still serialize its
 * cross-sprint `bd dolt push` calls.
 *
 * `acquire` is TICKETED rather than long-polling, because an MCP call cannot
 * block indefinitely: the caller gets a ticket immediately (or a grant, if the
 * mutex was free within the bounded wait) and re-polls that ticket. The waiter
 * stays enqueued between polls, so FIFO fairness is preserved exactly as in the
 * supervisor implementation. `pid` should be the caller's real process id: it
 * is what lets a crashed holder be reclaimed before its lease expires.
 *
 * Every action returns a JSON string (callers parse it).
 */
export const doltPushMutexSchema = z.object({
  action: z.enum(['acquire', 'poll', 'release', 'renew', 'cancel', 'status']).describe(
    '"acquire" enqueues this sprint for the mutex and waits up to wait_ms; returns {granted, ticket, token?}. '
    + '"poll" re-checks an outstanding ticket WITHOUT losing its FIFO position. '
    + '"release" frees the mutex (token-guarded, idempotent). '
    + '"renew" extends the current holder\'s lease. '
    + '"cancel" drops an outstanding ticket (or releases it if already granted). '
    + '"status" returns a snapshot of the holder and waiter queue.'
  ),
  sprint_id: z.string().min(1).optional().describe('Opaque sprint identity acquiring the mutex. Required for "acquire".'),
  ticket: z.string().min(1).optional().describe('Ticket returned by "acquire". Required for "poll" and "cancel".'),
  token: z.string().min(1).optional().describe('Grant token returned once granted. Required for "release" and "renew".'),
  pid: z.number().int().optional().describe('Caller process id, so a crashed holder is reclaimed via a dead-pid probe instead of waiting out the full lease.'),
  wait_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional().describe(`How long this single call may block waiting for a grant (default ${DEFAULT_WAIT_MS} ms, max ${MAX_WAIT_MS} ms).`),
});

export type DoltPushMutexInput = z.infer<typeof doltPushMutexSchema>;

export async function doltPushMutex(input: DoltPushMutexInput): Promise<string> {
  const coord = getDoltPushMutex();

  if (input.action === 'acquire') {
    if (!input.sprint_id) return JSON.stringify({ error: 'sprint_id is required for action "acquire"' });
    const res = await coord.acquire(input.sprint_id, { pid: input.pid ?? null, waitMs: input.wait_ms });
    if (res.error) return JSON.stringify({ granted: false, ticket: res.ticket, error: res.error });
    return JSON.stringify({
      granted: res.granted,
      ticket: res.ticket,
      token: res.grant?.token ?? null,
      expiresAt: res.grant?.expiresAt ?? null,
      sprintId: input.sprint_id,
    });
  }

  if (input.action === 'poll') {
    if (!input.ticket) return JSON.stringify({ error: 'ticket is required for action "poll"' });
    const res = await coord.poll(input.ticket, { waitMs: input.wait_ms });
    if (!res.known) return JSON.stringify({ granted: false, ticket: input.ticket, error: 'unknown ticket' });
    if (res.error) return JSON.stringify({ granted: false, ticket: input.ticket, error: res.error });
    return JSON.stringify({
      granted: res.granted,
      ticket: input.ticket,
      token: res.grant?.token ?? null,
      expiresAt: res.grant?.expiresAt ?? null,
    });
  }

  if (input.action === 'release') {
    if (!input.token) return JSON.stringify({ error: 'token is required for action "release"' });
    return JSON.stringify({ released: coord.release(input.token) });
  }

  if (input.action === 'renew') {
    if (!input.token) return JSON.stringify({ error: 'token is required for action "renew"' });
    const renewed = coord.mutex.renew(input.token);
    return JSON.stringify(renewed ? { renewed: true, expiresAt: renewed.expiresAt } : { renewed: false });
  }

  if (input.action === 'cancel') {
    if (!input.ticket) return JSON.stringify({ error: 'ticket is required for action "cancel"' });
    return JSON.stringify(coord.cancel(input.ticket));
  }

  return JSON.stringify(coord.mutex.status());
}
