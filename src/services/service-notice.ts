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

/** `shown`: the text was already printed to a console, so the next service verb does not repeat it. */
export function writeServiceNotice(text: string, file = SERVICE_NOTICE_PATH, now = new Date(), shown = false): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const n: ServiceNoticeFile = { createdAt: now.toISOString(), text, ...(shown ? { shownAt: now.toISOString() } : {}) };
    fs.writeFileSync(file, JSON.stringify(n, null, 2));
  } catch { /* best-effort: never fail registration on the notice */ }
}

/**
 * Like writeServiceNotice, but never discards guidance that is still pending:
 * when an unshown notice exists, `text` is appended to it (so the next verb
 * prints both once). A `shown` text (already printed inline) is not added to a
 * pending notice, since the user has seen it; a duplicate text is not repeated.
 */
export function appendServiceNotice(text: string, file = SERVICE_NOTICE_PATH, now = new Date(), shown = false): void {
  const existing = readNotice(file);
  if (!existing || existing.shownAt) { writeServiceNotice(text, file, now, shown); return; }
  if (shown || existing.text.includes(text)) return;
  try {
    fs.writeFileSync(file, JSON.stringify({ ...existing, text: `${existing.text}\n${text}` }, null, 2));
  } catch { /* best-effort */ }
}

export function clearServiceNotice(file = SERVICE_NOTICE_PATH): void {
  try { fs.unlinkSync(file); } catch { /* absent */ }
}

/** Remove the pending notice only when its text contains `marker` (an obsolete refusal). */
export function clearServiceNoticeContaining(marker: string, file = SERVICE_NOTICE_PATH): void {
  if (readNotice(file)?.text.includes(marker)) clearServiceNotice(file);
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
