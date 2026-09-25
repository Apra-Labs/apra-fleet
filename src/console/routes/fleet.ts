/**
 * Fleet console routes (apra-fleet-v6t7.2.1, extended by apra-fleet-9h9j.1.1).
 *
 * GET /api/fleet/members is the Members screen's data source. Alongside it
 * this table now carries one route per client API method the shell pages
 * need (18 of them), so the console UI never has to speak MCP.
 *
 * Later sprints add their endpoints by appending to the table below (or by
 * adding their own module next to this one and one line to ROUTE_MODULES in
 * ../server.ts); they do not edit the seam's dispatch. THIS sprint takes the
 * first option deliberately: the auth/registry/proxy sprint owns
 * ../server.ts this wave, so a second route module (which would need a
 * ROUTE_MODULES line) is not available to us.
 *
 * Handlers read through ../local-api.js (in-process tool handlers), never by
 * calling the server's own HTTP surface.
 *
 * CONVENTIONS -- read before adding a route here.
 *
 *  - METHOD. Every 9h9j route is POST with a JSON body, including the read-
 *    only ones. The body is exactly the client option shape from
 *    packages/apra-fleet-client/src/client/api.mjs, so one parse-and-validate
 *    helper covers all 18 identically and the UI never has to encode a
 *    nested option object into a query string. (GET /api/fleet/members
 *    predates this and is left exactly as it was.)
 *
 *  - VALIDATION. Each route validates the body with the TOOL's own exported
 *    zod schema before the handler is called, so the console can never drift
 *    from what the tool actually accepts. A zod failure is a 400 naming the
 *    offending field(s). Routes that identify a member additionally require
 *    one of member_id/member_name: both are optional in the shared
 *    memberIdentifier schema, so zod alone would let a member-less body
 *    through to the handler and turn a caller mistake into a 200.
 *
 *  - ERROR MAPPING. A tool "fails" when its result carries isError (at the
 *    top level or on structuredContent) or structuredContent.ok === false;
 *    that maps to 422 carrying the tool's own error text. A THROWN error
 *    maps to 400 with the thrown message -- the route catches it itself
 *    rather than letting ../server.ts's catch-all turn it into a 500. A tool
 *    that merely returns a prose failure string (resolveMember's "Member not
 *    found ...") is NOT sniffed into a 4xx: it is a 200 whose body carries
 *    that text, exactly as the MCP surface reports it.
 *
 *  - SECRETS. No response body may contain a secret VALUE. The credential
 *    routes therefore build their responses from an explicit whitelist
 *    (name / scope / network policy / members / expiry) instead of passing
 *    the tool payload through, and credential_store_set is always called
 *    with return_url true so the route answers {url, expiresAt} immediately
 *    instead of blocking on an interactive prompt.
 */
import type http from 'node:http';
import { z } from 'zod';

import type { ConsoleRoute } from '../server.js';
import * as api from '../local-api.js';
import { getMembersJson } from '../local-api.js';

import { memberDetailSchema } from '../../tools/member-detail.js';
import { registerMemberSchema } from '../../tools/register-member.js';
import { updateMemberSchema } from '../../tools/update-member.js';
import { removeMemberSchema } from '../../tools/remove-member.js';
import { setupSSHKeySchema } from '../../tools/setup-ssh-key.js';
import { provisionAuthSchema } from '../../tools/provision-auth.js';
import { provisionVcsAuthSchema } from '../../tools/provision-vcs-auth.js';
import { revokeVcsAuthSchema } from '../../tools/revoke-vcs-auth.js';
import { composePermissionsSchema } from '../../tools/compose-permissions.js';
import { updateAgentCliSchema } from '../../tools/update-agent-cli.js';
import { credentialStoreSetSchema } from '../../tools/credential-store-set.js';
import { credentialStoreListSchema } from '../../tools/credential-store-list.js';
import { credentialStoreUpdateSchema } from '../../tools/credential-store-update.js';
import { credentialStoreDeleteSchema } from '../../tools/credential-store-delete.js';
import { setupGitAppSchema } from '../../tools/setup-git-app.js';
import { fleetStatusSchema } from '../../tools/check-status.js';
import { versionSchema } from '../../tools/version.js';
import { executeCommandSchema } from '../../tools/execute-command.js';

// ---------------------------------------------------------------------------
// Request/response plumbing
// ---------------------------------------------------------------------------

/** Hard ceiling on a console request body. Bigger than any real option
 *  shape (the largest is register_member) and small enough that a runaway
 *  client cannot buffer the server to death. */
const MAX_BODY_BYTES = 1_000_000;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { ...JSON_HEADERS });
  res.end(JSON.stringify(payload));
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** Collect the request body as a string. An empty body reads as '' and is
 *  treated as {} by parseBody, so a POST with no body fails validation on
 *  the fields it is actually missing rather than on "no body". */
function readBody(req: http.IncomingMessage): Promise<string> {
  // Tests may hand us a bare {url, method} stub for a route that takes no
  // meaningful input; treat a non-stream request as an empty body.
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

type ParsedBody = { ok: true; value: unknown } | { ok: false; error: string };

function parseBody(raw: string): ParsedBody {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (err) {
    return { ok: false, error: `invalid JSON body: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 'friendly_name: Required; work_folder: Required' -- every message names
 *  the field it is about, which is what the 400 contract promises. */
function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : '(body)';
      return `${field}: ${issue.message}`;
    })
    .join('; ');
}

// ---------------------------------------------------------------------------
// Tool result interpretation -- ONE predicate, ONE text extractor
// ---------------------------------------------------------------------------

interface ToolResultShape {
  text?: unknown;
  content?: unknown;
  isError?: unknown;
  structuredContent?: Record<string, unknown>;
  [key: string]: unknown;
}

function asObject(result: unknown): ToolResultShape | null {
  return result !== null && typeof result === 'object' ? (result as ToolResultShape) : null;
}

/** True when the tool reported a failure in a machine-readable way:
 *  isError at the top level (the MCP content-result shape), isError on
 *  structuredContent (execute_command's preflight failure), or
 *  structuredContent.ok === false (provision_llm_auth / provision_vcs_auth). */
export function isToolFailure(result: unknown): boolean {
  const obj = asObject(result);
  if (!obj) return false;
  if (obj.isError === true) return true;
  const structured = obj.structuredContent;
  if (structured && typeof structured === 'object') {
    if ((structured as { isError?: unknown }).isError === true) return true;
    if ((structured as { ok?: unknown }).ok === false) return true;
  }
  return false;
}

/** The human-readable text of a tool result, wherever the tool put it. */
export function toolText(result: unknown): string {
  if (typeof result === 'string') return result;
  const obj = asObject(result);
  if (!obj) return '';
  if (typeof obj.text === 'string') return obj.text;
  if (Array.isArray(obj.content)) {
    for (const item of obj.content) {
      const entry = asObject(item);
      if (entry && typeof entry.text === 'string') return entry.text;
    }
  }
  const structured = obj.structuredContent;
  if (structured && typeof structured === 'object') {
    const s = structured as { stderr?: unknown; reason?: unknown };
    if (typeof s.stderr === 'string' && s.stderr.length > 0) return s.stderr;
    if (typeof s.reason === 'string' && s.reason.length > 0) return s.reason;
  }
  return '';
}

/** Default success envelope: prose in `text`, machine-readable half (when
 *  the tool has one) in `structuredContent`. */
function sendToolResult(res: http.ServerResponse, result: unknown): void {
  if (typeof result === 'string') {
    sendJson(res, 200, { text: result });
    return;
  }
  const obj = asObject(result);
  if (!obj) {
    sendJson(res, 200, { text: '' });
    return;
  }
  const payload: Record<string, unknown> = { text: toolText(result) };
  if (obj.structuredContent !== undefined) payload.structuredContent = obj.structuredContent;
  sendJson(res, 200, payload);
}

/** For tools whose payload IS json (member_detail/fleet_status with
 *  format json): write it through unparsed, exactly as GET
 *  /api/fleet/members does. A non-json payload (format compact, or a stub
 *  returning prose) falls back to the default envelope. */
function sendJsonPayload(res: http.ServerResponse, result: unknown): void {
  if (typeof result === 'string') {
    try {
      JSON.parse(result);
      res.writeHead(200, { ...JSON_HEADERS });
      res.end(result);
      return;
    } catch {
      // not json -- fall through
    }
  }
  sendToolResult(res, result);
}

// ---------------------------------------------------------------------------
// Route construction
// ---------------------------------------------------------------------------

interface RouteSpec<S extends z.ZodTypeAny> {
  /** Path under /api/fleet/. */
  path: string;
  /** The tool's own zod schema (optionally narrowed for the console). */
  schema: S;
  /** Require one of member_id/member_name -- see the VALIDATION note above. */
  requireMember?: boolean;
  /** Call the local-api adapter. */
  call: (input: z.infer<S>) => Promise<unknown>;
  /** Shape a successful result. Defaults to the text/structuredContent envelope. */
  respond?: (res: http.ServerResponse, result: unknown, input: z.infer<S>) => void;
}

function postRoute<S extends z.ZodTypeAny>(spec: RouteSpec<S>): ConsoleRoute {
  return {
    method: 'POST',
    path: spec.path,
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
        sendError(res, 400, parsed.error);
        return;
      }

      const validated = spec.schema.safeParse(parsed.value);
      if (!validated.success) {
        sendError(res, 400, `invalid request body: ${zodMessage(validated.error)}`);
        return;
      }
      const input = validated.data as z.infer<S> & { member_id?: string; member_name?: string };

      if (spec.requireMember && !input.member_id && !input.member_name) {
        sendError(res, 400, 'invalid request body: member_id or member_name is required');
        return;
      }

      let result: unknown;
      try {
        result = await spec.call(input);
      } catch (err) {
        // A thrown tool error is a 4xx carrying the thrown message, not the
        // seam's generic 500.
        sendError(res, 400, err instanceof Error ? err.message : String(err));
        return;
      }

      if (isToolFailure(result)) {
        sendError(res, 422, toolText(result) || 'tool reported an error');
        return;
      }

      if (spec.respond) spec.respond(res, result, input);
      else sendToolResult(res, result);
    },
  };
}

// ---------------------------------------------------------------------------
// Credential responses -- explicit whitelists, never a payload passthrough
// ---------------------------------------------------------------------------

/** The only credential fields that may ever reach a response body. */
function whitelistCredentialEntry(entry: unknown): Record<string, unknown> {
  const obj = asObject(entry) ?? {};
  return {
    name: typeof obj.name === 'string' ? obj.name : '',
    scope: typeof obj.scope === 'string' ? obj.scope : undefined,
    network_policy: typeof obj.network_policy === 'string' ? obj.network_policy : undefined,
    members: typeof obj.members === 'string' ? obj.members : undefined,
    expiry: typeof obj.expiry === 'string' ? obj.expiry : undefined,
    created_at: typeof obj.created_at === 'string' ? obj.created_at : undefined,
  };
}

// ---------------------------------------------------------------------------
// Console-specific schema narrowings
// ---------------------------------------------------------------------------

/** The console always wants the structured payload, so json is the default
 *  here where the tool itself defaults to compact. */
const consoleMemberDetailSchema = memberDetailSchema.extend({
  format: z.enum(['compact', 'json']).default('json'),
});

const consoleFleetStatusSchema = fleetStatusSchema.extend({
  format: z.enum(['compact', 'json']).default('json'),
});

/** return_url is decided by the route, not the caller: the console can never
 *  block on an interactive terminal prompt, so the flag is not accepted as
 *  input at all and is pinned to true on the way in. */
const consoleCredentialStoreSetSchema = credentialStoreSetSchema.omit({ return_url: true });

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

export const fleetRoutes: ConsoleRoute[] = [
  {
    method: 'GET',
    path: '/api/fleet/members',
    handler: async (_req, res) => {
      const body = await getMembersJson();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    },
  },

  postRoute({
    path: '/api/fleet/member-detail',
    schema: consoleMemberDetailSchema,
    requireMember: true,
    call: (input) => api.runMemberDetail(input),
    respond: (res, result) => sendJsonPayload(res, result),
  }),

  postRoute({
    path: '/api/fleet/register-member',
    schema: registerMemberSchema,
    call: (input) => api.runRegisterMember(input),
  }),

  postRoute({
    path: '/api/fleet/update-member',
    schema: updateMemberSchema,
    requireMember: true,
    call: (input) => api.runUpdateMember(input),
  }),

  postRoute({
    path: '/api/fleet/remove-member',
    schema: removeMemberSchema,
    requireMember: true,
    call: (input) => api.runRemoveMember(input),
  }),

  postRoute({
    path: '/api/fleet/setup-ssh-key',
    schema: setupSSHKeySchema,
    requireMember: true,
    call: (input) => api.runSetupSshKey(input),
  }),

  postRoute({
    path: '/api/fleet/provision-llm-auth',
    schema: provisionAuthSchema,
    requireMember: true,
    call: (input) => api.runProvisionLlmAuth(input),
  }),

  postRoute({
    path: '/api/fleet/provision-vcs-auth',
    schema: provisionVcsAuthSchema,
    requireMember: true,
    call: (input) => api.runProvisionVcsAuth(input),
  }),

  postRoute({
    path: '/api/fleet/revoke-vcs-auth',
    schema: revokeVcsAuthSchema,
    requireMember: true,
    call: (input) => api.runRevokeVcsAuth(input),
  }),

  postRoute({
    path: '/api/fleet/compose-permissions',
    schema: composePermissionsSchema,
    requireMember: true,
    call: (input) => api.runComposePermissions(input),
  }),

  // update_llm_cli deliberately does NOT requireMember: omitting the member
  // is how the client asks for "every online member at once".
  postRoute({
    path: '/api/fleet/update-llm-cli',
    schema: updateAgentCliSchema,
    call: (input) => api.runUpdateLlmCli(input),
  }),

  postRoute({
    path: '/api/fleet/credential-store-set',
    schema: consoleCredentialStoreSetSchema,
    call: (input) => api.runCredentialStoreSet({ ...input, return_url: true }),
    respond: (res, result) => {
      const structured = asObject(result)?.structuredContent;
      const url = structured && typeof structured === 'object' ? (structured as { url?: unknown }).url : undefined;
      const expiresAt =
        structured && typeof structured === 'object' ? (structured as { expiresAt?: unknown }).expiresAt : undefined;
      if (typeof url !== 'string') {
        // The tool answered with the blocking/plain-text path. Its prose is
        // NOT echoed -- a credential route never passes a payload through.
        sendError(res, 422, 'credential_store_set did not return a collection URL');
        return;
      }
      sendJson(res, 200, { url, expiresAt: typeof expiresAt === 'string' ? expiresAt : undefined });
    },
  }),

  postRoute({
    path: '/api/fleet/credential-store-list',
    schema: credentialStoreListSchema,
    call: () => api.runCredentialStoreList(),
    respond: (res, result) => {
      let entries: unknown;
      try {
        entries = JSON.parse(typeof result === 'string' ? result : toolText(result));
      } catch {
        sendError(res, 422, 'credential_store_list returned an unparseable payload');
        return;
      }
      if (!Array.isArray(entries)) {
        sendError(res, 422, 'credential_store_list returned an unparseable payload');
        return;
      }
      sendJson(res, 200, { credentials: entries.map(whitelistCredentialEntry) });
    },
  }),

  postRoute({
    path: '/api/fleet/credential-store-update',
    schema: credentialStoreUpdateSchema,
    call: (input) => api.runCredentialStoreUpdate(input),
    // The tool reports the outcome only as prose (with the new metadata
    // embedded in it). A credential route does not echo a tool payload, and
    // it does not sniff prose for success either, so the response is the
    // whitelisted metadata the caller asked us to set. The UI confirms by
    // re-reading credential-store-list.
    respond: (res, _result, input) =>
      sendJson(res, 200, {
        name: input.name,
        members: input.members,
        ttl_seconds: input.ttl_seconds,
        network_policy: input.network_policy,
      }),
  }),

  postRoute({
    path: '/api/fleet/credential-store-delete',
    schema: credentialStoreDeleteSchema,
    call: (input) => api.runCredentialStoreDelete(input),
    // Same rule as update: name only, no tool prose. Deleting a name that
    // was not there is a 200 (DELETE is idempotent).
    respond: (res, _result, input) => sendJson(res, 200, { name: input.name }),
  }),

  postRoute({
    path: '/api/fleet/setup-git-app',
    schema: setupGitAppSchema,
    call: (input) => api.runSetupGitApp(input),
  }),

  postRoute({
    path: '/api/fleet/status',
    schema: consoleFleetStatusSchema,
    call: (input) => api.runFleetStatus(input),
    respond: (res, result) => sendJsonPayload(res, result),
  }),

  postRoute({
    path: '/api/fleet/version',
    schema: versionSchema,
    call: () => api.runVersion(),
  }),

  postRoute({
    path: '/api/fleet/execute-command',
    schema: executeCommandSchema,
    requireMember: true,
    call: (input) => api.runExecuteCommand(input),
  }),
];
