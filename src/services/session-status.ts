// Parses the member-side fleetProcessCheck probe output (see OsCommands.fleetProcessCheck).
//
// The probe prints exactly one of: `idle`, `other-busy`, or `fleet-busy <pid>`.
// Older probes printed a bare `fleet-busy`; the pid is then absent.

export interface FleetProcessCheckResult {
  state: 'idle' | 'fleet-busy' | 'other-busy';
  /** The matched fleet-launched process id (fleet-busy only, when reported). */
  pid?: number;
}

export function parseFleetProcessCheck(stdout: string): FleetProcessCheckResult {
  const out = stdout.trim().toLowerCase();
  const m = /fleet-busy(?:\s+(\d+))?/.exec(out);
  if (m) return m[1] ? { state: 'fleet-busy', pid: Number(m[1]) } : { state: 'fleet-busy' };
  if (out.includes('other-busy')) return { state: 'other-busy' };
  return { state: 'idle' };
}
