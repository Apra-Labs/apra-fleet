import { z } from 'zod';
import { getChildIdAllocator } from '../services/sprint-coordination.js';

/**
 * Fleet-server-hosted global child-id allocator (apra-fleet-f34.2).
 *
 * The same coordination the apra-fleet-se supervisor exposes over HTTP
 * (`/api/child-id-allocator/...`), hosted here on the fleet MCP server so the
 * STANDALONE CLI launch path -- which has no supervisor to reach -- can still
 * mint globally-distinct child ids under a shared parent bead. Without it, two
 * sprints each running `bd create --parent X` in their OWN dolt clone derive the
 * SAME next child id and their pushes hard-conflict.
 *
 * `allocate` RESERVES an id under a lease + the caller's pid and returns a
 * token; the caller `confirm`s after `bd create --id <childId>` succeeds, or
 * `release`s if it failed (the seq then returns to a free pool for reuse). A
 * caller that dies mid-create has its reservation reclaimed via lease expiry or
 * a dead-pid probe, so an abandoned reservation is a reusable hole, never a
 * permanent gap.
 *
 * Every action returns a JSON string (callers parse it).
 */
export const childIdAllocatorSchema = z.object({
  action: z.enum(['allocate', 'confirm', 'release', 'status']).describe(
    '"allocate" reserves and returns the next child id under parent_id. '
    + '"confirm" durably commits a reservation after the create succeeded. '
    + '"release" returns an unused reservation\'s id to the free pool. '
    + '"status" returns a per-parent snapshot.'
  ),
  parent_id: z.string().min(1).optional().describe('Parent bead id children hang under. Required for "allocate".'),
  token: z.string().min(1).optional().describe('Reservation token returned by "allocate". Required for "confirm" and "release".'),
  sprint_id: z.string().min(1).optional().describe('Opaque sprint identity, for introspection/logging.'),
  pid: z.number().int().optional().describe('Caller process id, so an abandoned reservation is reclaimed via a dead-pid probe instead of waiting out the full lease.'),
  floor: z.number().int().min(0).optional().describe('Count of children the parent ALREADY has. On first touch of a parent the counter is seeded above this, so a pre-existing child id is never re-minted.'),
});

export type ChildIdAllocatorInput = z.infer<typeof childIdAllocatorSchema>;

export async function childIdAllocator(input: ChildIdAllocatorInput): Promise<string> {
  const allocator = await getChildIdAllocator();

  if (input.action === 'allocate') {
    if (!input.parent_id) return JSON.stringify({ error: 'parent_id is required for action "allocate"' });
    try {
      const grant = await allocator.allocate(input.parent_id, {
        pid: input.pid ?? null,
        sprintId: input.sprint_id,
        floor: input.floor,
      });
      return JSON.stringify({ status: 'allocated', ...grant });
    } catch (err: any) {
      return JSON.stringify({ error: `allocate failed: ${err?.message ?? String(err)}` });
    }
  }

  if (input.action === 'confirm') {
    if (!input.token) return JSON.stringify({ error: 'token is required for action "confirm"' });
    return JSON.stringify({ confirmed: await allocator.confirm(input.token) });
  }

  if (input.action === 'release') {
    if (!input.token) return JSON.stringify({ error: 'token is required for action "release"' });
    return JSON.stringify({ released: await allocator.release(input.token) });
  }

  return JSON.stringify(allocator.status());
}
