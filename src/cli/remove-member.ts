/**
 * `apra-fleet remove-member --id <uuid>`: the shell-drivable inverse of
 * `apra-fleet register-member`. The orchestrator runs it ON a member's own
 * install (src/services/member-fleet-install.ts) to drop the member's
 * self-registration when remove_member removes that member from the fleet.
 *
 * Does not fork the removal logic: it calls the shared `removeMember` function
 * the remove_member MCP tool uses. An id that is not registered is a success
 * (exit 0, E-NOT-REGISTERED on stdout) so the operation is idempotent.
 */
import { removeMember } from '../tools/remove-member.js';
import { getAgent } from '../services/registry.js';

const USAGE = `apra-fleet remove-member -- remove a member registration from this install

Usage:
  apra-fleet remove-member --id <uuid> [--force]

  --id <uuid>    Member id to remove (an id that is not registered is a no-op success)
  --force        Remove even if the member is currently busy
  --help, -h     Show this help`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Marker printed when the id was not registered (idempotent no-op). */
export const NOT_REGISTERED_CODE = 'E-NOT-REGISTERED';

export async function runRemoveMember(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  let id: string | undefined;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--force') force = true;
    else if (a === '--id') id = args[++i];
    else if (a.startsWith('--id=')) id = a.slice('--id='.length);
    else {
      console.error(`Error: Unknown or unexpected argument "${a}". Run 'apra-fleet remove-member --help'.`);
      process.exitCode = 1;
      return;
    }
  }
  if (!id || !UUID_RE.test(id)) {
    console.error(`Error: --id <uuid> is required (got "${id ?? ''}").`);
    process.exitCode = 1;
    return;
  }
  if (!getAgent(id)) {
    console.log(`${NOT_REGISTERED_CODE}: member ${id} is not registered on this install; nothing to remove.`);
    return;
  }
  const result = await removeMember({ member_id: id, force });
  if (/has been removed/.test(result)) {
    console.log(result);
  } else {
    console.error(result);
    process.exitCode = 1;
  }
}
