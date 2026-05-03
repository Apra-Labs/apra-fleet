import { serverVersion } from '../version.js';

interface UpdateInfo {
  latest: string;
  installed: string;
}

let cachedUpdate: UpdateInfo | null = null;

/** Parse "vX.Y.Z" or "vX.Y.Z_hash" into [major, minor, patch]. Returns null on parse failure. */
export function parseVersion(v: string): [number, number, number] | null {
  const clean = v.replace(/^v/, '').split('_')[0];
  const parts = clean.split('.').map(Number);
  if (parts.length !== 3 || parts.some(n => isNaN(n))) return null;
  return parts as [number, number, number];
}

export function isNewer(candidate: string, current: string): boolean {
  const c = parseVersion(candidate);
  const i = parseVersion(current);
  if (!c || !i) return false;
  if (c[0] !== i[0]) return c[0] > i[0];
  if (c[1] !== i[1]) return c[1] > i[1];
  return c[2] > i[2];
}

/** Fire-and-forget: fetch latest release from GitHub and cache if newer. Never throws. */
export async function checkForUpdate(): Promise<void> {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 5000);
    let res: Response;
    try {
      res = await fetch('https://api.github.com/repos/Apra-Labs/apra-fleet/releases/latest', {
        signal: controller.signal,
        headers: { 'User-Agent': `apra-fleet/${serverVersion}` },
      });
    } finally {
      clearTimeout(tid);
    }

    if (!res.ok) return;

    const data = await res.json() as { tag_name?: string };
    const tagName = data.tag_name;
    if (!tagName || /-(alpha|beta|rc)\b/i.test(tagName)) return;

    const installed = serverVersion.split('_')[0];
    if (isNewer(tagName, installed)) {
      const latest = tagName.startsWith('v') ? tagName : `v${tagName}`;
      cachedUpdate = { latest, installed };
    }
  } catch {
    // Network failure is silent
  }
}

/** Returns a one-line update notice if a newer release is available, null otherwise. */
export function getUpdateNotice(): string | null {
  if (!cachedUpdate) return null;
  const { latest, installed } = cachedUpdate;
  return `ℹ️ apra-fleet ${latest} is available (installed: ${installed}). Run \`apra-fleet update\` to update.`;
}

/** Inject a cached update directly (test helper). */
export function _setUpdateCache(update: UpdateInfo | null): void {
  cachedUpdate = update;
}
