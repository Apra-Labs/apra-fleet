/**
 * Pending service notice: guidance install could not show to the user.
 * `apra-fleet update` runs install detached with stdio ignored, so a message
 * printed by service registration (e.g. a legacy Windows task that could not
 * be replaced) never reaches anyone. Registration persists it here; the next
 * service verb (status/start/stop/restart/update) prints it once, and
 * registration clears it once the current service definition is in place.
 */
import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../paths.js';

export const SERVICE_NOTICE_PATH = path.join(FLEET_DIR, 'service-notice.json');

interface ServiceNoticeFile {
  createdAt: string;
  text: string;
  shownAt?: string;
}

export function writeServiceNotice(text: string, file = SERVICE_NOTICE_PATH, now = new Date()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ createdAt: now.toISOString(), text } satisfies ServiceNoticeFile, null, 2));
  } catch { /* best-effort: never fail registration on the notice */ }
}

export function clearServiceNotice(file = SERVICE_NOTICE_PATH): void {
  try { fs.unlinkSync(file); } catch { /* absent */ }
}

function readNotice(file: string): ServiceNoticeFile | null {
  try {
    const n = JSON.parse(fs.readFileSync(file, 'utf8')) as ServiceNoticeFile;
    return typeof n?.text === 'string' && n.text ? n : null;
  } catch {
    return null;
  }
}

/**
 * The notice text if it has not been shown yet, marking it shown (the file
 * stays until registration clears it). Null when there is nothing new.
 */
export function takePendingServiceNotice(file = SERVICE_NOTICE_PATH, now = new Date()): string | null {
  const n = readNotice(file);
  if (!n || n.shownAt) return null;
  try { fs.writeFileSync(file, JSON.stringify({ ...n, shownAt: now.toISOString() }, null, 2)); } catch { /* shown again next time */ }
  return n.text;
}

/** Print a pending notice once, on stderr (stdout of service verbs may be parsed). */
export function showPendingServiceNotice(file = SERVICE_NOTICE_PATH): void {
  const text = takePendingServiceNotice(file);
  if (text) console.error(`Note from the last apra-fleet install:\n${text}\n`);
}
