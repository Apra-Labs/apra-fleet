import type { EmailMessage } from './provider.js';

/**
 * Guards for values spliced into SMTP commands or MIME headers.
 * Shared by send_email validation and the SMTP provider so the two layers
 * cannot drift.
 */

export function assertHeaderSafe(field: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Invalid ${field}: must not contain CR/LF characters.`);
  }
}

/** Extra restriction for values placed inside quoted MIME parameters. */
export function assertQuotedParamSafe(field: string, value: string): void {
  assertHeaderSafe(field, value);
  if (/["\\]/.test(value)) {
    throw new Error(`Invalid ${field}: must not contain quotes or backslashes.`);
  }
}

export function headerError(field: string, value: string): string | undefined {
  try {
    assertHeaderSafe(field, value);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Cap on body + html + attachment payload (base64 bytes) held in memory. */
export const MAX_EMAIL_PAYLOAD_BYTES = 10 * 1024 * 1024;

export function emailPayloadBytes(msg: Pick<EmailMessage, 'body' | 'html' | 'attachments'>): number {
  let n = Buffer.byteLength(msg.body, 'utf8') + Buffer.byteLength(msg.html ?? '', 'utf8');
  for (const att of msg.attachments ?? []) {
    n += Buffer.byteLength(att.content.replace(/\s+/g, ''), 'utf8');
  }
  return n;
}

export function assertPayloadSize(msg: Pick<EmailMessage, 'body' | 'html' | 'attachments'>): void {
  const bytes = emailPayloadBytes(msg);
  if (bytes > MAX_EMAIL_PAYLOAD_BYTES) {
    throw new Error(
      `Email payload is ${bytes} bytes; maximum is ${MAX_EMAIL_PAYLOAD_BYTES} bytes.`,
    );
  }
}
