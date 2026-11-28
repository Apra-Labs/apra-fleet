/**
 * `apra-fleet fleet-se-check`: read-only. Runs the SAME detection the install
 * guard (E-FLEET-SE-RUNNING) uses and prints tagged lines, so a caller (the
 * replace-full pre-check, run with the staged binary on a member host) sees a
 * supervisor or sprint exactly as the guard that would later refuse sees it,
 * including supervisors too old to write a heartbeat. Always exits 0; the tag
 * lines carry the answer.
 *
 *   FLEET_SE_CHECK ok
 *   FLEET_SE supervisor pid=<pid> port=<port>
 *   FLEET_SE sprint pid=<pid> [id=<sprintId>] [unverified lock=<lock file>]
 *
 * lock= is last on the line: the path runs to the end of the line (it may hold spaces).
 */
import { detectRunningFleetSe } from './fleet-se-guard.js';

export async function runFleetSeCheck(): Promise<void> {
  let found: Awaited<ReturnType<typeof detectRunningFleetSe>>;
  try {
    found = await detectRunningFleetSe();
  } catch (err) {
    console.log(`FLEET_SE_CHECK error ${(err as Error).message}`);
    return;
  }
  console.log('FLEET_SE_CHECK ok');
  if (found.supervisor) console.log(`FLEET_SE supervisor pid=${found.supervisor.pid} port=${found.supervisor.port}`);
  for (const s of found.sprints) console.log(`FLEET_SE sprint pid=${s.pid}${s.sprintId ? ` id=${s.sprintId}` : ''}${s.unverified ? ` unverified lock=${s.lockFile ?? ''}` : ''}`);
  for (const w of found.warnings ?? []) console.log(`FLEET_SE warning ${w}`);
}
