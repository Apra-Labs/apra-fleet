// The code_* pre-flight's self-heal seam: start a background index build for a
// repo whose gitnexus index is missing or was left interrupted mid-write.
//
// Its own tiny module (not inlined into code-intelligence-readiness.ts) so the
// test setup can replace exactly this one side effect -- spawning a real
// `npx gitnexus analyze` -- for every test file, while each file remains free
// to mock or spread the reindex module itself.
import { scheduleReindex, type ScheduleReindexOutcome } from './code-intelligence-reindex.js';

export type { ScheduleReindexOutcome } from './code-intelligence-reindex.js';

/**
 * Ask for a background reindex of `repo` (config- and cooldown-gated, single
 * flight per repo). Never throws.
 */
export function scheduleIndexBuild(repo: string): ScheduleReindexOutcome {
  try {
    return scheduleReindex(repo);
  } catch (err) {
    return { started: false, reason: 'spawn-failed', detail: err instanceof Error ? err.message : String(err) };
  }
}
