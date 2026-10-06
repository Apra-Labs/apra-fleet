// Usage telemetry recorder (P8, design D8). Lives entirely on its own --
// imported ONLY by the shared tool-handler layer in src/index.ts (design D8:
// "recording happens in the shared tool-handler layer, NOT inside
// GitNexusProvider -- provider stays a pure proxy"). Do not import this from
// code-intelligence-gitnexus.ts.
import { appendFile, mkdir, rename, stat } from 'fs/promises';
import { join } from 'path';
import { FLEET_DIR } from '../paths.js';

// FLEET_DIR is ~/.apra-fleet/data unless APRA_FLEET_DATA_DIR redirects it, so
// a sandboxed server (or test) never writes the real usage log.
const USAGE_DIR = join(FLEET_DIR, 'code-intelligence');

export const USAGE_LOG_PATH = join(USAGE_DIR, 'usage.jsonl');
export const ROTATED_USAGE_LOG_PATH = join(USAGE_DIR, 'usage.jsonl.1');

// Rotation threshold (design D8): 5 MB. Simple, lossy-by-design -- one
// rotated file is kept, older history is discarded.
export const MAX_USAGE_LOG_BYTES = 5 * 1024 * 1024;

interface UsageRecord {
  ts: string;
  tool: string;
  target: string;
  repo: string | null;
  // Present only on rows from a member session (omitted, never null-filled, for
  // FULL sessions and for every row written before attribution existed).
  memberId?: string;
  sessionId?: string;
}

/** Who made the call; both fields are absent for a non-member session. */
export interface UsageAttribution {
  memberId?: string;
  sessionId?: string;
}

// If usage.jsonl exceeds the size threshold, rename it to usage.jsonl.1
// (overwriting any existing .1 -- fs.rename replaces an existing destination
// on both POSIX and Windows) so the next append starts a fresh file. Absent
// or unreadable file -> nothing to rotate, fall through to a fresh append.
async function rotateIfNeeded(): Promise<void> {
  try {
    const info = await stat(USAGE_LOG_PATH);
    if (info.size > MAX_USAGE_LOG_BYTES) {
      await rename(USAGE_LOG_PATH, ROTATED_USAGE_LOG_PATH);
    }
  } catch {
    // Missing file (ENOENT) or any other stat failure -- treat as "nothing to
    // rotate" and let the append below create/extend the file.
  }
}

async function writeUsageLine(record: UsageRecord): Promise<void> {
  await mkdir(USAGE_DIR, { recursive: true });
  await rotateIfNeeded();
  await appendFile(USAGE_LOG_PATH, JSON.stringify(record) + '\n', 'utf8');
}

// Record one usage event. Fire-and-forget: the write happens asynchronously
// in the background and this function never returns a promise the caller
// must await. A telemetry failure (disk full, permission denied, whatever)
// must NEVER surface to the caller or block a tool call (design D8) -- every
// failure path, sync or async, is swallowed here.
export function recordUsage(tool: string, target: string, repo: string | null, who: UsageAttribution = {}): void {
  try {
    const record: UsageRecord = { ts: new Date().toISOString(), tool, target, repo };
    // Attribute only member-session calls; a session id on its own (FULL
    // session) keeps today's row shape.
    if (who.memberId) {
      record.memberId = who.memberId;
      if (who.sessionId) record.sessionId = who.sessionId;
    }
    void writeUsageLine(record).catch(() => {
      // Swallow -- see function comment above.
    });
  } catch {
    // Swallow any synchronous throw too (e.g. an unexpected argument shape).
  }
}
