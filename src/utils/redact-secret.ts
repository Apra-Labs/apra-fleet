/**
 * Exact-value redaction of a live secret in command output (vcs_credential_exec,
 * `apra-fleet operator-auth exec`).
 */
import { StringDecoder } from 'node:string_decoder';

/** Marker that replaces a VCS token in redacted output. */
export const TOKEN_REDACTION = '[REDACTED:vcs_token]';

/** Replace every occurrence of `secret` in `output`, and report how many. */
export function redactSecret(output: string, secret: string, marker: string): { text: string; count: number } {
  if (!secret) return { text: output, count: 0 };
  const parts = output.split(secret);
  return { text: parts.join(marker), count: parts.length - 1 };
}

/** Length of the longest suffix of `text` that is a proper prefix of `secret`. */
function partialMatchTail(text: string, secret: string): number {
  for (let n = Math.min(text.length, secret.length - 1); n > 0; n--) {
    if (secret.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}

/**
 * Streaming form of redactSecret: chunks go to `write` as soon as they cannot
 * be part of `secret`; only a tail that could still begin the secret (split
 * across chunks) is held back until the next chunk or end(). Chunks are
 * decoded as UTF-8 without splitting a multi-byte character.
 */
export function createStreamRedactor(secret: string, marker: string, write: (s: string) => void): {
  push(chunk: Buffer | string): void;
  end(): void;
} {
  const decoder = new StringDecoder('utf8');
  let held = '';
  const flush = (final: boolean) => {
    let text = redactSecret(held, secret, marker).text;
    const keep = final || !secret ? 0 : partialMatchTail(text, secret);
    held = keep > 0 ? text.slice(text.length - keep) : '';
    text = keep > 0 ? text.slice(0, text.length - keep) : text;
    if (text) write(text);
  };
  return {
    push(chunk) {
      held += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      flush(false);
    },
    end() {
      held += decoder.end();
      flush(true);
    },
  };
}
