import { z } from 'zod';
import { collectOobApiKey, type OobLaunchFn } from '../../auth-socket.js';
import { decryptPassword } from '../../crypto.js';
import { credentialSet } from '../../credential-store.js';
import { getLogger } from '../../config.js';

export const credentialSetSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).describe('Credential name (alphanumeric, underscores, hyphens, max 64 chars)'),
  prompt: z.string().describe('Prompt to display to the user when collecting the secret'),
  persist: z.boolean().default(false).describe('If true, encrypt and persist the credential across server restarts'),
  network_policy: z.enum(['allow', 'confirm', 'deny']).default('confirm').describe(
    'Network egress policy: "allow" = always proceed, "confirm" = prompt before network commands, "deny" = block network commands'
  ),
  members: z.string().default('*').describe(
    'Comma-separated list of member names allowed to use this credential, or "*" for all (default: "*")'
  ),
  ttl_seconds: z.number().positive().optional().describe(
    'Time-to-live in seconds. If set, the credential expires after this many seconds and is automatically purged.'
  ),
});

export type CredentialSetInput = z.infer<typeof credentialSetSchema>;

export async function credentialSetHandler(input: CredentialSetInput, _launchFn?: OobLaunchFn): Promise<string> {
  const result = await collectOobApiKey(input.name, 'credential_store_set', { prompt: input.prompt, launchFn: _launchFn });

  if (result.fallback) return result.fallback;
  if (!result.password) return `Failed: no secret received for ${input.name}. Please try again.`;

  const plaintext = decryptPassword(result.password);
  const allowedMembers: string[] | '*' = input.members === '*'
    ? '*'
    : input.members.split(',').map(s => s.trim()).filter(Boolean);
  const meta = credentialSet(input.name, plaintext, input.persist, input.network_policy, allowedMembers, input.ttl_seconds);
  getLogger().info('credential_set', `name=${input.name} persist=${input.persist}`);
  return `Stored: ${meta.name} [${meta.scope}]. Use {{secure.${meta.name}}} in tool parameters.`;
}
