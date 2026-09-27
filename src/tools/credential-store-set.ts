import { z } from 'zod';
import { collectOobApiKey } from '../services/auth-socket.js';
import { decryptPassword } from '../utils/crypto.js';
import { credentialSet } from '../services/credential-store.js';
import { logLine } from '../utils/log-helpers.js';
import { resolveConsoleBaseUrl, joinConsoleUrl } from '../paths.js';

export const credentialStoreSetSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).describe('Credential name (alphanumeric, underscores, hyphens, max 64 chars)'),
  prompt: z.string().describe('Prompt to display to the user when collecting the secret'),
  persist: z.boolean().default(false).describe('If true, encrypt and persist the credential across server restarts'),
  network_policy: z.enum(['allow', 'confirm', 'deny']).default('confirm').describe(
    'Network egress policy: "allow" = always proceed, "confirm" = prompt before network commands, "deny" = block network commands'
  ),
  members: z.string().default('*').describe(
    'Comma-separated list of member friendly names allowed to use this credential, or "*" for all members (default: "*")'
  ),
  ttl_seconds: z.number().positive().optional().describe(
    'Time-to-live in seconds. If set, the credential expires after this many seconds and is automatically purged.'
  ),
  return_url: z.boolean().default(false).describe(
    'Return the out-of-band collection URL immediately in structuredContent ({url, expiresAt}) instead of ' +
    'waiting for the user to submit it. Automatically used whenever the server has no TTY attached (a ' +
    'headless/service context cannot block on a human at a terminal); pass true explicitly to opt in even ' +
    'when a TTY is available. The secret is still encrypted and stored the moment the user submits the form ' +
    '-- no follow-up tool call is needed.'
  ),
});

export type CredentialStoreSetInput = z.infer<typeof credentialStoreSetSchema>;

/** structuredContent shape when return_url collection is used (apra-fleet-972p.2.1, F3).
 *  `url` is console-relative when this process serves the console (the console
 *  route -- src/console/routes/fleet.ts -- reads this and hands it to the
 *  browser, which resolves it against its own origin), or an absolute loopback
 *  URL under stdio transport, where no console is hosted. `absoluteUrl` (apra-fleet-i9ag.11.9) is the same path resolved
 *  against the operator-declared or bound console origin, for callers that
 *  want the rendered link without doing that resolution themselves. */
export interface CredentialStoreSetUrlResult {
  url: string;
  expiresAt: string;
  absoluteUrl: string;
  [key: string]: unknown;
}

export interface CredentialStoreSetToolResult {
  text: string;
  structuredContent: CredentialStoreSetUrlResult;
}

function parseAllowedMembers(members: string): string[] | '*' {
  return members === '*' ? '*' : members.split(',').map(s => s.trim()).filter(Boolean);
}

export async function credentialStoreSet(input: CredentialStoreSetInput): Promise<string | CredentialStoreSetToolResult> {
  // apra-fleet-972p.2.1 (F3, DQ-7): a headless/service caller (no TTY) cannot
  // block on a human sitting at a terminal, so it gets the out-of-band URL
  // back immediately instead -- same automatic trigger stdin.isTTY already
  // gates elsewhere in this codebase. `return_url: true` opts into the same
  // path even from an interactive terminal.
  const useReturnUrl = input.return_url === true || !process.stdin.isTTY;

  if (useReturnUrl) {
    // Resolve the printable origin BEFORE doing anything else: a malformed
    // APRA_FLEET_CONSOLE_BASE_URL is an operator config error that should
    // fail loudly and immediately, not after a secret-entry registration
    // that nobody will ever be able to open.
    const baseUrlResult = resolveConsoleBaseUrl();
    if (!baseUrlResult.ok) {
      return `[FAIL] ${baseUrlResult.error}`;
    }

    const result = await collectOobApiKey(input.name, 'credential_store_set', {
      prompt: input.prompt,
      returnUrl: true,
      // The browser flow (auth-web.ts) is unchanged: this callback is wired
      // straight into its POST handler, so the secret is stored the instant
      // the user submits the form -- never routed through the
      // pendingRequests/waitForPassword machinery the blocking path below
      // uses (there is no waiter to resolve; the tool call already returned).
      onOobSubmit: (value: string) => {
        try {
          const allowedMembers = parseAllowedMembers(input.members);
          credentialSet(input.name, value, input.persist, input.network_policy, allowedMembers, input.ttl_seconds);
          logLine('credential_store_set', `name=${input.name} persist=${input.persist} via=oob_url`);
          return { ok: true };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? 'Failed to store credential' };
        }
      },
    });

    if (result.url && result.expiresAt) {
      // joinConsoleUrl() rather than `new URL(relative, base)` or a naked
      // string concat: when the console is hosted, result.url is a
      // console-relative path (src/services/secret-entry.ts), and a plain
      // URL-constructor resolve would silently drop any sub-path segment of
      // baseUrlResult.baseUrl (a reverse-proxy mount, e.g. '/fleet') since a
      // root-relative path replaces the base's whole path per RFC 3986/WHATWG.
      // joinConsoleUrl() preserves that sub-path, and returns an already
      // absolute url (the stdio-transport loopback page) as-is
      // (apra-fleet-i9ag.11.18).
      const absoluteUrl = joinConsoleUrl(baseUrlResult.baseUrl, result.url);
      // Under stdio transport no console is hosted in this process, so
      // result.url is already an absolute loopback URL (auth-web.ts) and
      // there is no console origin to point the operator at.
      const isAbsolute = /^https?:\/\//i.test(result.url);
      const originHint = isAbsolute
        ? ''
        : `If the console is reached on a different host or port (a LAN address, an SSH tunnel, or a reverse ` +
          `proxy), the same page is at ${result.url} on that origin instead. Set APRA_FLEET_CONSOLE_BASE_URL ` +
          `to change the origin printed above.\n\n`;
      return {
        text: `Open this URL to provide the secret for "${input.name}" (expires ${result.expiresAt}):\n${absoluteUrl}\n\n` +
          originHint +
          `The secret is encrypted and stored automatically once the form is submitted -- no further tool call is needed.`,
        structuredContent: { url: result.url, expiresAt: result.expiresAt, absoluteUrl },
      };
    }
    return result.fallback ?? `[FAIL] Could not start out-of-band credential entry for ${input.name}.`;
  }

  const result = await collectOobApiKey(input.name, 'credential_store_set', { prompt: input.prompt });

  if (result.fallback) return result.fallback;
  if (!result.password) return `[FAIL] No secret received for ${input.name}. Please try again.`;

  const plaintext = decryptPassword(result.password);
  const allowedMembers = parseAllowedMembers(input.members);
  const meta = credentialSet(input.name, plaintext, input.persist, input.network_policy, allowedMembers, input.ttl_seconds);
  logLine('credential_store_set', `name=${input.name} persist=${input.persist}`);
  return `[OK] ${meta.name} stored [${meta.scope}]. Use {{secret.${meta.name}}} in commands.`;
}
