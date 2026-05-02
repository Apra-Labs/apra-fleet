import { serverVersion } from '../version.js';

interface UpdateInfo {
  latest: string;
  installed: string;
}

let cachedUpdate: UpdateInfo | null = null;

/** Parse "vX.Y.Z[.W...]" or "vX.Y.Z_hash" into a number array (≥3 parts). Returns null on parse failure. */
function parseVersion(v: string): number[] | null {
  const clean = v.replace(/^v/, '').split('_')[0];
  const parts = clean.split('.').map(Number);
  if (parts.length < 3 || parts.some(n => isNaN(n))) return null;
  return parts;
}

function isNewer(candidate: string, current: string): boolean {
  const c = parseVersion(candidate);
  const i = parseVersion(current);
  if (!c || !i) return false;
  const len = Math.max(c.length, i.length);
  for (let k = 0; k < len; k++) {
    const cv = c[k] ?? 0;
    const iv = i[k] ?? 0;
    if (cv !== iv) return cv > iv;
  }
  return false;
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

/** CLI command: check for updates and print result, then exit. */
export async function runUpdateCheck(): Promise<void> {
  const installed = serverVersion.split('_')[0];
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

    if (!res.ok) {
      console.log('Could not check for updates. Visit https://github.com/Apra-Labs/apra-fleet/releases');
      process.exit(0);
    }

    const data = await res.json() as { tag_name?: string };
    const tagName = data.tag_name;
    if (!tagName) {
      console.log('Could not check for updates. Visit https://github.com/Apra-Labs/apra-fleet/releases');
      process.exit(0);
    }

    if (/-(alpha|beta|rc)\b/i.test(tagName)) {
      console.log(`apra-fleet ${installed} is up to date.`);
      process.exit(0);
    }

    const latest = tagName.startsWith('v') ? tagName : `v${tagName}`;
    if (isNewer(tagName, installed)) {
      console.log(`apra-fleet ${latest} is available (installed: ${installed}).\nDownload: https://github.com/Apra-Labs/apra-fleet/releases/tag/${latest}`);
    } else {
      console.log(`apra-fleet ${installed} is up to date.`);
    }
  } catch {
    console.log('Could not check for updates. Visit https://github.com/Apra-Labs/apra-fleet/releases');
  }
  process.exit(0);
}

/** Returns a one-line update notice if a newer release is available, null otherwise. */
export function getUpdateNotice(): string | null {
  if (!cachedUpdate) return null;
  const { latest, installed } = cachedUpdate;
  return `ℹ️ apra-fleet ${latest} is available (installed: ${installed}). Run \`/pm deploy apra-fleet\` to update.`;
}

/** Inject a cached update directly (test helper). */
export function _setUpdateCache(update: UpdateInfo | null): void {
  cachedUpdate = update;
}

/** Expose isNewer for unit tests. */
export { isNewer as _isNewer };
