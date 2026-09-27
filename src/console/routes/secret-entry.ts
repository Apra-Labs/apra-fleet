/**
 * Secret-entry console routes (apra-fleet-i9ag.11.4).
 *
 * Serves the one-time secret-entry API under the console origin, so the
 * entry page (src/services/secret-entry.ts's console-relative
 * /ui/#/secret-entry/<token> path) works wherever /ui works -- LAN, an SSH
 * tunnel on the console port, or a remote install -- not just a browser on
 * the server's own loopback.
 *
 * These are /api paths, so apiNamespace() in ../server.ts derives
 * '/api/secret-entry' from the paths below and requiresConsoleGuard covers
 * BOTH routes automatically -- no second guard list, no ../server.ts guard
 * edit. The browser already holds the apra_console_token cookie (set on
 * every GET /ui), so a same-origin POST from the shell page authenticates
 * with no new credential, and a cross-site POST carries no cookie and is
 * 401ed by the guard before this module ever sees the request.
 *
 * SECRETS: the submitted value must never appear in a response body, an
 * error message, or a log line -- see src/console/routes/fleet.ts's header
 * for the console-wide rule this mirrors. Only metadata (name, prompt) ever
 * leaves getSecretEntryPrompt's result; submitSecretEntry's value argument
 * is never echoed back or logged here.
 */
import type http from 'node:http';
import { z } from 'zod';

import type { ConsoleRoute } from '../server.js';
import { getSecretEntryPrompt, submitSecretEntry } from '../../services/secret-entry.js';
import { logLine } from '../../utils/log-helpers.js';

/** Hard ceiling on a console request body for this module. A secret value is
 *  never expected to be large; this is generous headroom while still small
 *  enough that a runaway client cannot buffer the server to death. */
const MAX_BODY_BYTES = 65_536;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { ...JSON_HEADERS });
  res.end(JSON.stringify(payload));
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** Collect the request body as a string, mirroring ../routes/fleet.ts's
 *  readBody: an empty body reads as '' (treated as {} by parseBody), and a
 *  test double lacking .on is treated as an empty body too. */
function readBody(req: http.IncomingMessage): Promise<string> {
  if (typeof (req as { on?: unknown }).on !== 'function') return Promise.resolve('');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer | string) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err: Error) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

type ParsedBody = { ok: true; value: unknown } | { ok: false };

/** Unlike ../routes/fleet.ts's parseBody, a JSON parse failure here is not
 *  reported back to the caller -- it is folded into `ok: false` so the two
 *  call sites below can each decide how to answer it (prompt: the same 404
 *  as an unknown token, per the "one indistinguishable answer" rule in the
 *  module doc comment above; submit: a 400, per its documented contract). */
function parseBody(raw: string): ParsedBody {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

function fieldOf(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[key];
}

const TOKEN_SCHEMA = z.string().regex(/^[0-9a-f]{64}$/, 'must be a 64-character hex string');
const submitSchema = z.object({
  token: TOKEN_SCHEMA,
  value: z.string().min(1, 'must be a non-empty string'),
});

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : '(body)';
      return `${field}: ${issue.message}`;
    })
    .join('; ');
}

export const secretEntryRoutes: ConsoleRoute[] = [
  {
    method: 'POST',
    path: '/api/secret-entry/prompt',
    handler: async (req, res) => {
      let raw: string;
      try {
        raw = await readBody(req);
      } catch {
        // Never distinguish a body-read failure from an unknown token --
        // see the module doc comment's "one indistinguishable answer" rule.
        sendError(res, 404, 'not found');
        return;
      }

      const parsed = parseBody(raw);
      // A malformed/absent token is handled identically to an unknown one:
      // getSecretEntryPrompt's own shape check (via findToken) already
      // treats any non-64-hex string as "not found", so there is no
      // separate 400 path here to leak format information to a caller.
      const token = parsed.ok ? fieldOf(parsed.value, 'token') : undefined;
      const prompt = getSecretEntryPrompt(typeof token === 'string' ? token : '');
      if (!prompt) {
        sendError(res, 404, 'not found');
        return;
      }
      sendJson(res, 200, prompt);
    },
  },

  {
    method: 'POST',
    path: '/api/secret-entry/submit',
    handler: async (req, res) => {
      let raw: string;
      try {
        raw = await readBody(req);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err));
        return;
      }

      const parsed = parseBody(raw);
      if (!parsed.ok) {
        sendError(res, 400, 'invalid JSON body');
        return;
      }

      const validated = submitSchema.safeParse(parsed.value);
      if (!validated.success) {
        sendError(res, 400, `invalid request body: ${zodMessage(validated.error)}`);
        return;
      }

      const { token, value } = validated.data;
      const result = submitSecretEntry(token, value);
      // Metadata only -- never the token, never the value.
      logLine('secret_entry', `submit token=<redacted> ok=${result.status === 'ok'}`);

      if (result.status === 'ok') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (result.status === 'not_found') {
        sendError(res, 404, 'not found');
        return;
      }
      sendError(res, 422, result.error);
    },
  },
];
