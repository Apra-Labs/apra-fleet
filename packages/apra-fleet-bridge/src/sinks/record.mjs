// Shared record stamping and serialization for all sinks.
// Redacts, stamps with `receivedAt`, and serializes to a single JSONL line.
// This is imported by both jsonl-file.mjs and append-blob.mjs to ensure
// byte-identical output: if the stamping logic ever changes, all sinks
// change with it (no silent divergence).

/**
 * Stamp and serialize one record for JSONL output.
 * Redacts the record, wraps it with a `receivedAt` timestamp, and
 * serializes to a single JSON line (newline-terminated).
 *
 * @param {any} record - the record to stamp and serialize.
 * @param {(record: any) => any} redact - injected; strips secrets from the record.
 *   Contracted to return a redacted record (not necessarily a plain object).
 * @param {{ now: () => string|number }} clock - injected; `now()` returns the timestamp.
 * @returns {string} one JSON line, newline-terminated.
 */
export function stampAndSerialize(record, redact, clock) {
  const safe = redact(record);
  // `redact` is contracted to return a redacted record, not necessarily
  // guaranteed to be a plain object (a caller's fake could hand back
  // anything) -- wrap non-object results under `data` so this always
  // produces one well-formed JSON object per line either way.
  const payload = (safe && typeof safe === 'object' && !Array.isArray(safe))
    ? { receivedAt: clock.now(), ...safe }
    : { receivedAt: clock.now(), data: safe };
  return `${JSON.stringify(payload)}\n`;
}
