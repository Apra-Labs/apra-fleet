import { z } from 'zod';
import { collectOobApiKey, decryptPassword, credentialSet } from 'blindfold';
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
});

export type CredentialStoreSetInput = z.infer<typeof credentialStoreSetSchema>;

export async function credentialStoreSet(input: CredentialStoreSetInput): Promise<string> {
  const result = await collectOobApiKey(input.name, 'credential_store_set', { prompt: input.prompt });

  if (result.fallback) return result.fallback;
  if (!result.password) return `❌ No secret received for ${input.name}. Please try again.`;

  const plaintext = decryptPassword(result.password);
  const allowedMembers: string[] | '*' = input.members === '*'
    ? '*'
    : input.members.split(',').map(s => s.trim()).filter(Boolean);
  const meta = credentialSet(input.name, plaintext, input.persist, input.network_policy, allowedMembers, input.ttl_seconds);
  logLine('credential_store_set', `name=${input.name} persist=${input.persist}`);
  return `✓ ${meta.name} stored [${meta.scope}]. Use {{secure.${meta.name}}} in commands.`;
}
