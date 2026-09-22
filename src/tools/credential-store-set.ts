import { z } from 'zod';
import { collectOobApiKey } from '../services/auth-socket.js';
import { decryptPassword } from '../utils/crypto.js';
import { credentialSet } from '../services/credential-store.js';
import { logLine } from '../utils/log-helpers.js';

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

/** structuredContent shape when return_url collection is used (apra-fleet-972p.2.1, F3). */
export interface CredentialStoreSetUrlResult {
  url: string;
  expiresAt: string;
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
      return {
        text: `🔗 Open this URL to provide the secret for "${input.name}" (expires ${result.expiresAt}):\n${result.url}\n\n` +
          `The secret is encrypted and stored automatically once the form is submitted -- no further tool call is needed.`,
        structuredContent: { url: result.url, expiresAt: result.expiresAt },
      };
    }
    return result.fallback ?? `❌ Could not start out-of-band credential entry for ${input.name}.`;
  }

  const result = await collectOobApiKey(input.name, 'credential_store_set', { prompt: input.prompt });

  if (result.fallback) return result.fallback;
  if (!result.password) return `❌ No secret received for ${input.name}. Please try again.`;

  const plaintext = decryptPassword(result.password);
  const allowedMembers = parseAllowedMembers(input.members);
  const meta = credentialSet(input.name, plaintext, input.persist, input.network_policy, allowedMembers, input.ttl_seconds);
  logLine('credential_store_set', `name=${input.name} persist=${input.persist}`);
  return `✓ ${meta.name} stored [${meta.scope}]. Use {{secret.${meta.name}}} in commands.`;
}
