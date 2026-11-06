import { z } from 'zod';
import { collectOobApiKey } from '../services/auth-socket.js';
import { decryptPassword } from '../utils/crypto.js';
import { credentialSetValue, isLiveSecret, secretBoundBy } from '../services/credential-store.js';
import { logLine } from '../utils/log-helpers.js';

/** A caller still passing the removed `confirm` policy is told so, not given a bare enum error. */
export const networkPolicySchema = z.enum(['allow', 'deny'], {
  errorMap: (_issue, ctx) => ({
    message: ctx.data === 'confirm'
      ? 'network_policy confirm was removed. Use allow or deny.'
      : ctx.defaultError,
  }),
});

export const credentialStoreSetSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).describe('Credential name (alphanumeric, underscores, hyphens, max 64 chars)'),
  prompt: z.string().describe('Prompt to display to the user when collecting the secret'),
  persist: z.boolean().optional().describe('true = encrypt it and keep it across server restarts, false = hold it in memory for this server session only. Omitted: a new name is persistent, an existing secret keeps its tier.'),
  network_policy: networkPolicySchema.optional().describe(
    'Network egress policy: "allow" = always proceed, "deny" = block network commands. Omitted: a new name gets "allow", an existing secret keeps its policy.'
  ),
  members: z.string().optional().describe(
    'Comma-separated list of member friendly names allowed to use this credential, or "*" for all members. Omitted: a new name gets "*", an existing secret keeps its members.'
  ),
  ttl_seconds: z.number().positive().optional().describe(
    'Time-to-live in seconds. If set, the credential expires after this many seconds and is automatically purged. Omitted: a new name does not expire, an existing secret keeps an unexpired expiry, and a value replacing an expired one does not expire.'
  ),
});

export type CredentialStoreSetInput = z.infer<typeof credentialStoreSetSchema>;

export async function credentialStoreSet(input: CredentialStoreSetInput): Promise<string> {
  if (isLiveSecret(input.name)) {
    return `[FAIL] '${input.name}' is a live secret and cannot be set through this tool. Replace or remove it from the CLI: apra-fleet secret --set / --delete ${input.name}.`;
  }
  // Refused before asking for a value; credentialSet holds the same rule.
  const consumers = input.persist === false ? secretBoundBy(input.name) : [];
  if (consumers.length > 0) {
    return `[FAIL] '${input.name}' is in use by: ${consumers.join(', ')}, so it cannot have a session value. Use persist: true, or apra-fleet secret --set ${input.name} --persist.`;
  }
  const result = await collectOobApiKey(input.name, 'credential_store_set', { prompt: input.prompt });

  if (result.fallback) return result.fallback;
  if (!result.password) return `❌ No secret received for ${input.name}. Please try again.`;

  const plaintext = decryptPassword(result.password);
  const allowedMembers: string[] | '*' | undefined = input.members === undefined || input.members === '*'
    ? input.members as '*' | undefined
    : input.members.split(',').map(s => s.trim()).filter(Boolean);
  const meta = credentialSetValue(input.name, plaintext, {
    persist: input.persist,
    network_policy: input.network_policy,
    allowedMembers,
    ttl_seconds: input.ttl_seconds,
  });
  logLine('credential_store_set', `name=${input.name} persist=${meta.scope === 'persistent'}`);
  return `✓ ${meta.name} stored [${meta.scope}]. Use {{secret.${meta.name}}} in commands.`;
}
